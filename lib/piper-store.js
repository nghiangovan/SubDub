/* Piper voice storage: download the .onnx model + .onnx.json once, verify, keep in Cache Storage
 * (extension origin, shared by the service worker, offscreen document, its worker and the popup).
 * Works in window and worker scopes (needs caches, fetch, crypto.subtle). */
(function (root) {
  'use strict';
  const YVD = (root.YVD = root.YVD || {});
  const P = YVD.piperText || (typeof require === 'function' ? require('./piper-text.js') : null);

  async function openCache() {
    return root.caches.open(P.CACHE_NAME);
  }

  // True only when both files are stored (the model is written last, only after verification).
  async function isReady() {
    try {
      const c = await openCache();
      const [m, j] = await Promise.all([c.match(P.MODEL_URL), c.match(P.CONFIG_URL)]);
      return !!(m && j);
    } catch (e) {
      return false;
    }
  }

  // -> { model: ArrayBuffer, config: object }; throws Error('not-downloaded') when missing.
  async function load() {
    const c = await openCache();
    const [m, j] = await Promise.all([c.match(P.MODEL_URL), c.match(P.CONFIG_URL)]);
    if (!m || !j) throw new Error('not-downloaded');
    const [model, config] = await Promise.all([m.arrayBuffer(), j.json()]);
    return { model: model, config: config };
  }

  async function remove() {
    try {
      await root.caches.delete(P.CACHE_NAME);
    } catch (e) {}
  }

  // Stream a URL into one Uint8Array, reporting (loaded, total).
  async function fetchBytes(url, expected, onProgress, signal) {
    const res = await root.fetch(url, { signal: signal, credentials: 'omit', cache: 'no-store' });
    if (!res.ok) throw new Error('http ' + res.status);
    const total = Number(res.headers.get('content-length')) || expected || 0;
    if (!res.body || !res.body.getReader) {
      const all = new Uint8Array(await res.arrayBuffer());
      if (onProgress) onProgress(all.length, all.length);
      return all;
    }
    const reader = res.body.getReader();
    let buf = total > 0 ? new Uint8Array(total) : null;
    const parts = [];
    let loaded = 0;
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      const v = r.value;
      if (buf && loaded + v.length <= buf.length) buf.set(v, loaded);
      else {
        if (buf) {
          parts.push(buf.subarray(0, loaded)); // server sent more than announced: fall back to parts
          buf = null;
        }
        parts.push(v);
      }
      loaded += v.length;
      if (onProgress) onProgress(loaded, total || loaded);
    }
    if (buf) return loaded === buf.length ? buf : buf.subarray(0, loaded);
    const out = new Uint8Array(loaded);
    let o = 0;
    parts.forEach(function (p) {
      out.set(p, o);
      o += p.length;
    });
    return out;
  }

  const sleep = function (ms) {
    return new Promise(function (r) {
      setTimeout(r, ms);
    });
  };

  // Downloads + verifies + stores the voice. opts: { onProgress(loaded,total), signal }.
  // Throws Error('size' | 'checksum' | 'http NNN' | network error).
  async function download(opts) {
    opts = opts || {};
    if (await isReady()) return true;
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const cfgBytes = await fetchBytes(P.CONFIG_URL, 0, null, opts.signal);
        JSON.parse(new TextDecoder().decode(cfgBytes)); // must be valid JSON
        const bytes = await fetchBytes(P.MODEL_URL, P.MODEL_BYTES, opts.onProgress, opts.signal);
        const hex = P.toHex(await root.crypto.subtle.digest('SHA-256', bytes));
        const bad = P.checkModel(bytes.length, hex);
        if (bad) throw new Error(bad);
        const c = await openCache();
        await c.put(P.CONFIG_URL, new Response(cfgBytes, { headers: { 'content-type': 'application/json' } }));
        await c.put(P.MODEL_URL, new Response(bytes, { headers: { 'content-type': 'application/octet-stream' } }));
        return true;
      } catch (e) {
        lastErr = e;
        const msg = String((e && e.message) || e);
        if (e && e.name === 'AbortError') throw e;
        if (msg === 'size' || msg === 'checksum' || /^http 4/.test(msg)) break; // retrying will not help
        await sleep(1500 * (attempt + 1));
      }
    }
    throw lastErr || new Error('download failed');
  }

  const api = { isReady: isReady, load: load, remove: remove, download: download };
  YVD.piperStore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : typeof self !== 'undefined' ? self : globalThis);
