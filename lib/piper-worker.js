/* Dedicated (classic) worker: Piper TTS inference, off the offscreen document's main thread.
 *   phonemizer: vendor/piper-wasm (piper-phonemize + espeak-ng compiled to WASM)
 *   inference : vendor/onnxruntime-web (single-threaded WASM backend; no SharedArrayBuffer/COOP needed)
 *   voice     : vi_VN-vais1000-medium, loaded from Cache Storage (lib/piper-store.js)
 * Requests: {id, op:'status'|'init'|'download'|'synth'|'clear', ...}  Replies: {id, ok, ...} or {ev:'progress'}.
 * No network access except the model download (Hugging Face URLs fixed in lib/piper-text.js). */
'use strict';
importScripts('piper-text.js', 'piper-store.js', '../vendor/piper-wasm/piper_phonemize.js');

const P = self.YVD.piperText;
const STORE = self.YVD.piperStore;
const ROOT = new URL('../', self.location.href).href;

let ort = null;
let session = null;
let config = null;
let loading = null;
let phonemizer = null;
let pmLine = null; // resolver of the phonemizer's current call
let dlAbort = null;

function reply(id, obj) {
  self.postMessage(Object.assign({ id: id }, obj));
}

async function ensureOrt() {
  if (ort) return ort;
  const m = await import('../vendor/onnxruntime-web/ort.wasm.min.mjs');
  ort = m.default && m.default.InferenceSession ? m.default : m;
  ort.env.wasm.numThreads = 1; // extension pages are not cross-origin isolated
  ort.env.wasm.proxy = false;
  ort.env.wasm.wasmPaths = ROOT + 'vendor/onnxruntime-web/';
  return ort;
}

async function ensureSession() {
  if (session) return;
  if (!loading) {
    loading = (async () => {
      const o = await ensureOrt();
      const loaded = await STORE.load(); // throws 'not-downloaded'
      config = loaded.config;
      session = await o.InferenceSession.create(new Uint8Array(loaded.model), { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
    })().catch((e) => {
      loading = null;
      throw e;
    });
  }
  await loading;
}

async function ensurePhonemizer() {
  if (phonemizer) return phonemizer;
  phonemizer = await self.createPiperPhonemize({
    print: (line) => {
      if (pmLine) pmLine.line(line);
    },
    printErr: (line) => {
      if (pmLine) pmLine.err(line);
    },
    locateFile: (name) => ROOT + 'vendor/piper-wasm/' + name
  });
  return phonemizer;
}

// text -> phoneme ids (array of numbers) using espeak-ng "vi" voice
async function phonemize(text) {
  const pm = await ensurePhonemizer();
  const voice = (config && config.espeak && config.espeak.voice) || 'vi';
  return new Promise((resolve, reject) => {
    let done = false;
    pmLine = {
      line: (l) => {
        if (done) return;
        try {
          const ids = JSON.parse(l).phoneme_ids;
          if (!Array.isArray(ids)) throw new Error('no phoneme_ids');
          done = true;
          resolve(ids);
        } catch (e) {
          /* not the JSON line: ignore */
        }
      },
      err: () => {}
    };
    try {
      pm.callMain(['-l', voice, '--input', JSON.stringify([{ text: text }]), '--espeak_data', '/espeak-ng-data']);
    } catch (e) {
      if (!done) {
        done = true;
        reject(e);
      }
    }
    if (!done) {
      done = true;
      reject(new Error('phonemizer produced no output'));
    }
  }).finally(() => {
    pmLine = null;
  });
}

async function synthChunk(text) {
  const ids = await phonemize(P.withEndPunct(text));
  const n = ids.length;
  const inf = (config && config.inference) || {};
  const feeds = {
    input: new ort.Tensor('int64', BigInt64Array.from(ids, (x) => BigInt(x)), [1, n]),
    input_lengths: new ort.Tensor('int64', BigInt64Array.from([BigInt(n)]), [1]),
    scales: new ort.Tensor('float32', Float32Array.from([inf.noise_scale != null ? inf.noise_scale : 0.667, (inf.length_scale != null ? inf.length_scale : 1) * P.PACE, inf.noise_w != null ? inf.noise_w : 0.8]), [3])
  };
  if (config && config.speaker_id_map && Object.keys(config.speaker_id_map).length) feeds.sid = new ort.Tensor('int64', BigInt64Array.from([0n]), [1]);
  const out = await session.run(feeds);
  const t = out.output || out[Object.keys(out)[0]];
  return new Float32Array(t.data);
}

async function synth(text) {
  await ensureSession();
  const rate = (config && config.audio && config.audio.sample_rate) || 22050;
  // keep the slow fade of the last syllable (tail threshold 0.002, 120 ms) + 150 ms silence for the time-stretcher
  const pcm = P.padEnd(P.trimSilence(await synthChunk(text), rate, 0.01, 0.04, 0.002, 0.12), rate, 0.15);
  if (!pcm.length) throw new Error('empty audio');
  const wav = P.pcmToWav(pcm, rate);
  return { wav: wav, sampleRate: rate, seconds: pcm.length / rate };
}

// ---- job queue: speak (prio 0) before prefetch (prio 1); 'clear' drops what has not started ----
const queue = [];
let busy = false;
async function pump() {
  if (busy) return;
  busy = true;
  try {
    while (queue.length) {
      queue.sort((a, b) => a.prio - b.prio || a.seq - b.seq);
      const j = queue.shift();
      try {
        const t0 = Date.now();
        const r = await synth(j.text);
        reply(j.id, { ok: true, wav: r.wav, sampleRate: r.sampleRate, seconds: r.seconds, ms: Date.now() - t0 });
      } catch (e) {
        reply(j.id, { ok: false, error: String((e && e.message) || e) });
      }
    }
  } finally {
    busy = false;
  }
}
let seq = 0;

self.onmessage = async (ev) => {
  const m = ev.data || {};
  try {
    switch (m.op) {
      case 'status':
        reply(m.id, { ok: true, ready: await STORE.isReady(), loaded: !!session });
        break;
      case 'init':
        await ensureSession();
        reply(m.id, { ok: true, loaded: true });
        break;
      case 'download': {
        if (dlAbort) return reply(m.id, { ok: true, already: true });
        dlAbort = new AbortController();
        try {
          await STORE.download({
            signal: dlAbort.signal,
            onProgress: (loaded, total) => self.postMessage({ ev: 'progress', loaded: loaded, total: total })
          });
          reply(m.id, { ok: true });
        } finally {
          dlAbort = null;
        }
        break;
      }
      case 'abortDownload':
        if (dlAbort) dlAbort.abort();
        reply(m.id, { ok: true });
        break;
      case 'synth':
        queue.push({ id: m.id, text: String(m.text || ''), prio: m.prio || 0, seq: seq++ });
        pump();
        break;
      case 'clear': {
        const dropped = queue.splice(0, queue.length);
        dropped.forEach((j) => reply(j.id, { ok: false, error: 'cancelled' }));
        reply(m.id, { ok: true, dropped: dropped.length });
        break;
      }
      default:
        reply(m.id, { ok: false, error: 'unknown op' });
    }
  } catch (e) {
    reply(m.id, { ok: false, error: String((e && e.message) || e) });
  }
};
