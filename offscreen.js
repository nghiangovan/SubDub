/* Offscreen document (extension origin, immune to YouTube's page CSP). It hosts:
 *   - Google Translate TTS fetch + playback         (engine 'google')
 *   - Piper TTS (offline, in lib/piper-worker.js)    (engine 'piper')
 *   - Chrome's on-device Translator API              (trProbe / trTranslate)
 * Messages (from background, {target:'offscreen'}):
 *   speak | prefetch | pause | resume | cancel | setVolume   (+ engine:'google'|'piper')
 *   piperStatus | piperDownload | piperAbort | piperWarm | trProbe | trTranslate  (trProbe/trTranslate: sourceLang, targetLang, texts) */
(function () {
  'use strict';
  const YVD = window.YVD;
  const G = YVD.gtts;
  const P = YVD.piperText;
  const STORE = YVD.piperStore;
  const CACHE_MAX = 60;
  const FETCH_TIMEOUT = 8000;

  // ---- LRU cache of audio blobs: key = engine|voice|text -> Promise<Blob> ----
  const cache = new Map();
  function lru(key, make) {
    let p = cache.get(key);
    if (p) {
      cache.delete(key); // refresh LRU position
      cache.set(key, p);
      return p;
    }
    if (!make) return Promise.reject(new Error('not cached'));
    p = make();
    cache.set(key, p);
    p.catch(() => {
      if (cache.get(key) === p) cache.delete(key); // never cache failures
    });
    while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    return p;
  }

  // ---- Google Translate TTS ----
  // Circuit breaker: after BREAK_AFTER consecutive fetch failures (HTTP error / 8 s timeout, even for lines that
  // were superseded meanwhile) uncached Google requests fail at once, so the dubber learns about the outage and
  // switches to Piper instead of cancelling every slow line before its failure arrives. A clear block (HTTP 429, or
  // a redirect to Google's "unusual traffic" /sorry page) trips it at once. Each trip in a row waits longer
  // (1, 5, then 15 min) so a rate-limited IP gets quiet time to recover; one success resets the ladder.
  const BREAK_AFTER = 2;
  const BREAK_STEPS = [60000, 300000, 900000];
  let gFails = 0;
  let gTrips = 0;
  let gDownUntil = 0;
  function tripGoogle() {
    gDownUntil = Date.now() + BREAK_STEPS[Math.min(gTrips, BREAK_STEPS.length - 1)];
    gTrips++;
    gFails = 0;
  }
  // At most 2 requests in flight (bursts are what trigger the block); spoken lines go before prefetches.
  const G_MAX_ACTIVE = 2;
  const gQueue = [];
  let gActive = 0;
  let gSeq = 0;
  function gPump() {
    while (gActive < G_MAX_ACTIVE && gQueue.length) {
      gQueue.sort((a, b) => a.prio - b.prio || a.seq - b.seq);
      const job = gQueue.shift();
      if (Date.now() < gDownUntil) {
        job.rej(new Error('google-down'));
        continue;
      }
      gActive++;
      fetchGoogleNow(job.text).then(job.res, job.rej).finally(() => {
        gActive--;
        gPump();
      });
    }
  }
  function fetchGoogle(text, prio) {
    return new Promise((res, rej) => {
      gQueue.push({ text, prio: prio || 0, seq: gSeq++, res, rej });
      gPump();
    });
  }
  function fetchGoogleNow(text) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT);
    // redirect:'manual': the /sorry captcha page shows up as an opaque redirect instead of a CORS error
    return fetch(G.buildUrl(text, 'vi'), { signal: ctl.signal, redirect: 'manual' })
      .then((r) => {
        if (r.type === 'opaqueredirect' || r.status === 429) {
          const e = new Error('google-blocked');
          e.blocked = true;
          throw e;
        }
        if (!r.ok) throw new Error('http ' + r.status);
        return r.blob();
      })
      .then((b) => {
        if (!b || b.size < 100) throw new Error('empty audio');
        gFails = 0;
        gTrips = 0;
        gDownUntil = 0;
        return b;
      })
      .catch((e) => {
        if ((e && e.blocked) || ++gFails >= BREAK_AFTER) tripGoogle();
        throw e;
      })
      .finally(() => clearTimeout(timer));
  }

  // Persistent cache of Google audio (Cache Storage, survives restarts): a re-watched video or a repeated line
  // costs no request at all. Oldest entries are dropped beyond DISK_MAX (~20 KB each).
  const DISK_CACHE = 'yvd-gtts-v1';
  const DISK_MAX = 2000;
  let diskPuts = 0;
  const diskKey = (text) => 'https://yvd.cache/gtts/vi/' + encodeURIComponent(text);
  async function diskGet(text) {
    try {
      const c = await caches.open(DISK_CACHE);
      const r = await c.match(diskKey(text));
      return r ? await r.blob() : null;
    } catch (e) {
      return null;
    }
  }
  async function diskPut(text, blob) {
    try {
      const c = await caches.open(DISK_CACHE);
      await c.put(diskKey(text), new Response(blob, { headers: { 'content-type': blob.type || 'audio/mpeg' } }));
      if (++diskPuts % 50 === 1) {
        const keys = await c.keys(); // insertion order: oldest first
        for (let i = 0; i < keys.length - DISK_MAX; i++) await c.delete(keys[i]);
      }
    } catch (e) {}
  }
  const googleBlob = (text, prio) => {
    const key = 'google|vi|' + text;
    if (cache.has(key)) return lru(key);
    return lru(key, async () => {
      const hit = await diskGet(text);
      if (hit && hit.size >= 100) return hit;
      if (Date.now() < gDownUntil) throw new Error('google-down');
      const b = await fetchGoogle(text, prio);
      diskPut(text, b);
      return b;
    });
  };
  // when Google is resting, tell the dubber until when (so it does not re-announce the fallback every minute)
  const googleRetryAt = () => (Date.now() < gDownUntil ? gDownUntil : 0);
  const googleChunks = (text) => G.chunkText(text);

  // ---- Piper (worker bridge) ----
  let pw = null;
  let pid = 0;
  const pend = new Map(); // id -> {res, rej}
  const dl = { state: 'idle', loaded: 0, total: P.MODEL_BYTES, error: '' }; // download progress for the popup

  function resetWorker(err) {
    const w = pw;
    pw = null;
    if (w) {
      try {
        w.terminate();
      } catch (e) {}
    }
    pend.forEach((p) => p.rej(new Error(err || 'piper worker stopped')));
    pend.clear();
  }
  function worker() {
    if (pw) return pw;
    pw = new Worker('lib/piper-worker.js');
    pw.onmessage = (e) => {
      const m = e.data || {};
      if (m.ev === 'progress') {
        dl.loaded = m.loaded;
        dl.total = m.total || dl.total;
        return;
      }
      const p = pend.get(m.id);
      if (!p) return;
      pend.delete(m.id);
      p.res(m);
    };
    pw.onerror = (e) => resetWorker('piper worker error: ' + ((e && e.message) || 'unknown'));
    return pw;
  }
  function pcall(op, extra) {
    return new Promise((res, rej) => {
      const id = ++pid;
      pend.set(id, { res, rej });
      try {
        worker().postMessage(Object.assign({ id, op }, extra || {}));
      } catch (e) {
        pend.delete(id);
        rej(e);
      }
    });
  }
  function piperSynth(text, prio) {
    return pcall('synth', { text, prio }).then((r) => {
      if (!r.ok) throw new Error(r.error || 'piper error');
      return new Blob([r.wav], { type: 'audio/wav' });
    });
  }
  const piperBlob = (text, prio) => lru('piper|' + P.VOICE_ID + '|' + text, () => piperSynth(text, prio));

  async function piperStatus() {
    const ready = await STORE.isReady();
    if (ready && dl.state !== 'downloading') dl.state = 'ready';
    return { ok: true, ready, state: dl.state, loaded: dl.loaded, total: dl.total, error: dl.error };
  }

  function piperDownload() {
    if (dl.state === 'downloading') return { ok: true, already: true };
    dl.state = 'downloading';
    dl.loaded = 0;
    dl.total = P.MODEL_BYTES;
    dl.error = '';
    pcall('download').then(
      (r) => {
        if (r.ok) {
          dl.state = 'ready';
          dl.loaded = dl.total;
          // offscreen documents only have chrome.runtime: ask the service worker to record readiness
          try {
            chrome.runtime.sendMessage({ type: 'piperReadyChanged', ready: true }, () => void chrome.runtime.lastError);
          } catch (e) {}
        } else {
          dl.state = 'error';
          dl.error = r.error || 'download failed';
        }
      },
      (e) => {
        dl.state = 'error';
        dl.error = String((e && e.message) || e);
      }
    );
    return { ok: true, started: true };
  }

  // ---- on-device translation (Translator API) ----
  const engine = YVD.localTranslate.createEngine(() => (typeof self.Translator !== 'undefined' ? self.Translator : undefined));

  // ---- playback ----
  let seq = 0;
  let volume = 1; // dubbing voice loudness 0-1 (set per speak message, updated live by setVolume)
  const clampVol = (v) => Math.min(1, Math.max(0, Number.isFinite(Number(v)) ? Number(v) : 1));
  let cur = null; // { token, audio, paused, dirty, finish }

  function stopCurrent(reason) {
    const c = cur;
    cur = null;
    if (!c) return;
    c.cancelled = true;
    try {
      if (c.audio) {
        c.audio.onended = c.audio.onerror = c.audio.onplaying = null;
        c.audio.pause();
        c.audio.removeAttribute('src');
        c.audio.load();
      }
    } catch (e) {}
    if (c.url) URL.revokeObjectURL(c.url);
    c.finish({ ok: true, cancelled: true, reason: reason || 'cancel' });
  }

  function playChunk(c, blob, rate) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      c.url = url;
      const a = new Audio();
      c.audio = a;
      a.preservesPitch = true;
      a.volume = volume;
      a.mozPreservesPitch = a.webkitPreservesPitch = true;
      a.defaultPlaybackRate = rate;
      a.playbackRate = rate;
      let t0 = 0;
      a.onplaying = () => {
        if (!t0) {
          t0 = performance.now();
          if (!c.startMs) c.startMs = Date.now();
        }
      };
      a.onended = () => {
        URL.revokeObjectURL(url);
        c.url = null;
        if (c.audio === a) c.audio = null; // finished: a later resume must not replay it
        resolve(t0 ? (performance.now() - t0) / 1000 : 0);
      };
      a.onerror = () => {
        URL.revokeObjectURL(url);
        c.url = null;
        reject(new Error('audio error'));
      };
      a.src = url;
      a.playbackRate = rate; // some builds reset it when src is set
      if (c.paused) return; // paused while this chunk was loading: attached, the 'resume' op calls play()
      const p = a.play();
      // a pause() racing with play() rejects it with AbortError: not an engine failure, resume plays again
      if (p && p.catch) p.catch((e) => (c.dirty && e && e.name === 'AbortError') || c.cancelled ? undefined : reject(e));
    });
  }

  function speak(msg) {
    stopCurrent('replaced');
    const token = ++seq;
    const rate = Math.min(4, Math.max(0.5, Number(msg.rate) || 1));
    if (msg.volume != null) volume = clampVol(msg.volume);
    const isPiper = msg.engine === 'piper';
    return new Promise(async (resolve) => {
      const c = {
        token: token,
        audio: null,
        url: null,
        paused: false,
        dirty: false, // pause/resume happened: timing unusable
        cancelled: false,
        startMs: 0,
        finish: (r) => {
          c.finish = () => {};
          resolve(r);
        }
      };
      cur = c;
      if (isPiper && !(await STORE.isReady())) {
        if (cur === c) cur = null;
        return c.finish({ ok: false, error: 'piper-not-ready' });
      }
      if (c.cancelled) return;
      const chunks = isPiper ? P.toChunks(msg.text) : googleChunks(msg.text);
      if (!chunks.length) return c.finish({ ok: true, playSec: 0, chars: 0 });
      const blobs = chunks.map((t) => (isPiper ? piperBlob(t, 0) : googleBlob(t, 0))); // request all chunks, play in order
      blobs.forEach((b) => b.catch(() => {}));
      try {
        let playSec = 0;
        for (let i = 0; i < blobs.length; i++) {
          const blob = await blobs[i];
          if (c.cancelled) return;
          playSec += await playChunk(c, blob, rate);
          if (c.cancelled) return;
        }
        if (cur === c) cur = null;
        c.finish({
          ok: true,
          startMs: c.startMs,
          endMs: Date.now(),
          playSec: c.dirty ? null : playSec,
          dirty: c.dirty,
          chars: msg.text.length
        });
      } catch (e) {
        if (c.cancelled) return;
        if (cur === c) cur = null;
        if (c.url) URL.revokeObjectURL(c.url);
        c.finish({ ok: false, error: String((e && e.message) || e), retryAt: isPiper ? 0 : googleRetryAt() });
      }
    });
  }

  function prefetch(msg) {
    const isPiper = msg.engine === 'piper';
    (msg.texts || []).forEach((t) => {
      if (isPiper) P.toChunks(t).forEach((ch) => piperBlob(ch, 1).catch(() => {}));
      else if (Date.now() >= gDownUntil) googleChunks(t).forEach((ch) => googleBlob(ch, 1).catch(() => {}));
    });
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || !msg || msg.target !== 'offscreen') return false;
    const fail = (e) => sendResponse({ ok: false, error: String((e && e.message) || e) });
    switch (msg.op) {
      case 'speak':
        speak(msg).then(sendResponse, fail);
        return true;
      case 'prefetch':
        prefetch(msg);
        sendResponse({ ok: true });
        return false;
      case 'pause':
        if (cur) {
          // also while the first chunk is still being fetched/synthesised (no audio element yet)
          cur.dirty = true;
          cur.paused = true;
          if (cur.audio) cur.audio.pause();
        }
        sendResponse({ ok: true });
        return false;
      case 'resume':
        if (cur && cur.paused) {
          cur.paused = false;
          if (cur.audio) cur.audio.play().catch(() => {});
        }
        sendResponse({ ok: true });
        return false;
      case 'setVolume':
        volume = clampVol(msg.volume);
        if (cur && cur.audio) cur.audio.volume = volume;
        sendResponse({ ok: true });
        return false;
      case 'cancel':
        stopCurrent('cancel');
        if (pw) pcall('clear').catch(() => {}); // drop queued (not yet started) Piper jobs
        sendResponse({ ok: true });
        return false;
      case 'piperStatus':
        piperStatus().then(sendResponse, fail);
        return true;
      case 'piperDownload':
        sendResponse(piperDownload());
        return false;
      case 'piperAbort':
        if (pw) pcall('abortDownload').catch(() => {});
        sendResponse({ ok: true });
        return false;
      case 'piperWarm':
        STORE.isReady()
          .then((ready) => (ready ? pcall('init') : { ok: false, error: 'piper-not-ready' }))
          .then(sendResponse, fail);
        return true;
      case 'trProbe':
        engine.probe(msg.sourceLang, msg.targetLang).then((r) => sendResponse(Object.assign({ ok: true }, r)), fail);
        return true;
      case 'trTranslate':
        engine.translate(msg.sourceLang, msg.targetLang, msg.texts || []).then((result) => sendResponse({ ok: true, result }), fail);
        return true;
      default:
        sendResponse({ ok: false });
        return false;
    }
  });
})();
