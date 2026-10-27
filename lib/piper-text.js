/* Piper TTS pure helpers (shared by lib/piper-worker.js, offscreen.js, background.js and tests):
 * model constants, Vietnamese text normalisation, sentence chunking, PCM -> WAV, silence trimming. */
(function (root) {
  'use strict';
  const YVD = (root.YVD = root.YVD || {});

  // The voice is DATA (not code): downloaded once from the rhasspy/piper-voices repo on Hugging Face and
  // stored in Cache Storage. Size + SHA-256 (from the repo's x-linked-etag) are verified after download.
  const VOICE_ID = 'vi_VN-vais1000-medium';
  const BASE = 'https://huggingface.co/rhasspy/piper-voices/resolve/main/vi/vi_VN/vais1000/medium/';
  const MODEL_URL = BASE + VOICE_ID + '.onnx';
  const CONFIG_URL = BASE + VOICE_ID + '.onnx.json';
  const MODEL_BYTES = 63201294;
  const MODEL_SHA256 = 'ec7c89e2c85f4d1edc24b6120c18aaf1bda614f06b511567eb9c7c0de15e2dab';
  const CACHE_NAME = 'yvd-piper-v1';
  const CHUNK_MAX = 180; // characters per synthesis chunk (keeps latency per chunk low)

  // ---- text normalisation (light, Vietnamese oriented) ----
  const SYMBOLS = [
    [/(\d)\s*%/g, '$1 phần trăm'],
    [/%/g, ' phần trăm '],
    [/\$\s*(\d[\d.,]*)/g, '$1 đô la'],
    [/(\d[\d.,]*)\s*\$/g, '$1 đô la'],
    [/€\s*(\d[\d.,]*)/g, '$1 ơ rô'],
    [/(\d)\s*°\s*C\b/g, '$1 độ C'],
    [/(\d)\s*°/g, '$1 độ'],
    [/&/g, ' và '],
    [/\+/g, ' cộng '],
    [/(\s)=(\s)/g, '$1bằng$2'],
    [/@/g, ' a còng ']
  ];

  function normalizeText(text) {
    let s = String(text == null ? '' : text);
    try {
      s = s.normalize('NFC');
    } catch (e) {}
    s = s.replace(/https?:\/\/\S+/gi, ' '); // bare URLs are not worth reading out
    s = s.replace(/\[[^\]\n]{0,40}\]/g, ' '); // [Âm nhạc] / [Music] style cues
    s = s.replace(/[♪♫♬♩]+/g, ' ');
    s = s.replace(/\p{Extended_Pictographic}/gu, ' ');
    s = s.replace(/\b\d{1,3}(?:,\d{3})+\b/g, function (m) {
      return m.replace(/,/g, ''); // 1,000,000 -> 1000000 (read as a number)
    });
    for (let i = 0; i < SYMBOLS.length; i++) s = s.replace(SYMBOLS[i][0], SYMBOLS[i][1]);
    s = s.replace(/[“”„«»"]/g, ' ').replace(/[‘’‚`´]/g, "'");
    s = s.replace(/\s*[–—―]\s*/g, ', ');
    s = s.replace(/…/g, '...');
    s = s.replace(/[*_#~^|\\<>{}]/g, ' ');
    s = s.replace(/\s+/g, ' ').trim();
    return s;
  }

  // A chunk is worth synthesising only when it holds at least one letter or digit.
  function isSpeakable(s) {
    return /[\p{L}\p{N}]/u.test(String(s || ''));
  }

  // Normalise then split into chunks <= max chars (sentence ends > commas > spaces). `chunker` defaults to
  // YVD.gtts.chunkText (lib/gtts.js), which must be loaded.
  function toChunks(text, max, chunker) {
    const chunk = chunker || (root.YVD && root.YVD.gtts && root.YVD.gtts.chunkText) || (typeof require === 'function' ? require('./gtts.js').chunkText : null);
    const norm = normalizeText(text);
    if (!norm) return [];
    return chunk(norm, max > 0 ? max : CHUNK_MAX).filter(isSpeakable);
  }

  // ---- audio ----
  // Float32 mono PCM in [-1,1] -> 16-bit little-endian WAV (ArrayBuffer).
  function pcmToWav(pcm, sampleRate) {
    const n = pcm.length;
    const buf = new ArrayBuffer(44 + n * 2);
    const v = new DataView(buf);
    const wr = function (o, s) {
      for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
    };
    wr(0, 'RIFF');
    v.setUint32(4, 36 + n * 2, true);
    wr(8, 'WAVE');
    wr(12, 'fmt ');
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true); // PCM
    v.setUint16(22, 1, true); // mono
    v.setUint32(24, sampleRate, true);
    v.setUint32(28, sampleRate * 2, true);
    v.setUint16(32, 2, true);
    v.setUint16(34, 16, true);
    wr(36, 'data');
    v.setUint32(40, n * 2, true);
    let p = 44;
    for (let i = 0; i < n; i++, p += 2) {
      const x = pcm[i];
      v.setInt16(p, x >= 1 ? 32767 : x <= -1 ? -32768 : Math.round(x * 32767), true);
    }
    return buf;
  }

  // Cut leading/trailing near-silence (keeping `padSec` on each side) so cues start/end on time. The end may use a
  // lower threshold / longer pad (`tailThreshold`, `tailPadSec`): Vietnamese syllables fade out slowly and a
  // hard cut at the start threshold clips the last sound ("cụt").
  function trimSilence(pcm, sampleRate, threshold, padSec, tailThreshold, tailPadSec) {
    const th = threshold > 0 ? threshold : 0.01;
    const tth = tailThreshold > 0 ? tailThreshold : th;
    const pad = Math.round((padSec >= 0 ? padSec : 0.04) * sampleRate);
    const tpad = tailPadSec >= 0 ? Math.round(tailPadSec * sampleRate) : pad;
    let a = 0;
    let b = pcm.length;
    while (a < b && Math.abs(pcm[a]) < th) a++;
    if (a >= b) return pcm.subarray ? pcm.subarray(0, 0) : pcm.slice(0, 0); // all silence
    while (b > a && Math.abs(pcm[b - 1]) < tth) b--;
    a = Math.max(0, a - pad);
    b = Math.min(pcm.length, b + tpad);
    return pcm.subarray ? pcm.subarray(a, b) : pcm.slice(a, b);
  }

  // Append `sec` of silence. Chrome's pitch-preserving time-stretch (playbackRate != 1) can swallow the last
  // few tens of ms of a clip; a short silent tail makes that loss inaudible.
  function padEnd(pcm, sampleRate, sec) {
    const n = Math.max(0, Math.round((sec > 0 ? sec : 0) * sampleRate));
    if (!n) return pcm;
    const out = new Float32Array(pcm.length + n);
    out.set(pcm, 0);
    return out;
  }

  // The voice model ends a phrase cleanly only after closing punctuation; without it the last syllable is cut short.
  function withEndPunct(s) {
    const t = String(s || '').trim();
    return !t || /[.!?…;:,]$/.test(t) ? t : t + '.';
  }

  function concatPcm(list) {
    let total = 0;
    list.forEach(function (x) {
      total += x.length;
    });
    const out = new Float32Array(total);
    let o = 0;
    list.forEach(function (x) {
      out.set(x, o);
      o += x.length;
    });
    return out;
  }

  function toHex(buf) {
    const u = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < u.length; i++) s += (u[i] < 16 ? '0' : '') + u[i].toString(16);
    return s;
  }

  // Integrity check of a downloaded model: returns '' when fine, otherwise a short error code.
  function checkModel(byteLength, sha256Hex) {
    if (byteLength !== MODEL_BYTES) return 'size';
    if (String(sha256Hex || '').toLowerCase() !== MODEL_SHA256) return 'checksum';
    return '';
  }

  const api = {
    VOICE_ID: VOICE_ID,
    MODEL_URL: MODEL_URL,
    CONFIG_URL: CONFIG_URL,
    MODEL_BYTES: MODEL_BYTES,
    MODEL_SHA256: MODEL_SHA256,
    CACHE_NAME: CACHE_NAME,
    CHUNK_MAX: CHUNK_MAX,
    normalizeText: normalizeText,
    isSpeakable: isSpeakable,
    toChunks: toChunks,
    pcmToWav: pcmToWav,
    trimSilence: trimSilence,
    padEnd: padEnd,
    withEndPunct: withEndPunct,
    concatPcm: concatPcm,
    toHex: toHex,
    checkModel: checkModel
  };
  YVD.piperText = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : typeof self !== 'undefined' ? self : globalThis);
