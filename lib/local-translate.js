/* On-device translation with Chrome's built-in Translator API (Chrome 138+, desktop).
 * Shared by offscreen.js (primary), content/localtr.js (fallback) and popup.js (one-time model download).
 * `getT` returns the Translator constructor of the current global (or undefined when not exposed). */
(function (root) {
  'use strict';
  const YVD = (root.YVD = root.YVD || {});

  const defaultGetT = function () {
    return typeof root.Translator !== 'undefined' ? root.Translator : undefined;
  };

  const errMsg = function (e) {
    return String((e && (e.name ? e.name + ': ' : '') + (e.message || e)) || e);
  };

  // Split an over-long string into pieces (sentence ends, then spaces) of at most `max` chars.
  function splitLong(text, max) {
    const out = [];
    let rem = String(text).trim();
    while (rem.length > max) {
      const win = rem.slice(0, max + 1);
      let cut = Math.max(win.lastIndexOf('. '), win.lastIndexOf('? '), win.lastIndexOf('! ')) + 1;
      if (cut < max * 0.3) cut = win.lastIndexOf(' ');
      if (cut < 1) cut = max;
      out.push(rem.slice(0, cut).trim());
      rem = rem.slice(cut).trim();
    }
    if (rem) out.push(rem);
    return out;
  }

  function createEngine(getT) {
    const get = getT || defaultGetT;
    const cache = new Map(); // "en>vi" -> Promise<Translator>

    // -> { exposed: bool, availability: 'unavailable'|'downloadable'|'downloading'|'available'|'unsupported' }
    async function probe(source, target) {
      const T = get();
      if (!T || typeof T.availability !== 'function' || typeof T.create !== 'function') return { exposed: false, availability: 'unsupported' };
      try {
        const av = await T.availability({ sourceLanguage: source, targetLanguage: target });
        return { exposed: true, availability: String(av) };
      } catch (e) {
        return { exposed: true, availability: 'unavailable', error: errMsg(e) };
      }
    }

    // create() without a user gesture only works when the model is already installed, so gate on 'available'.
    function translator(source, target) {
      const key = source + '>' + target;
      let p = cache.get(key);
      if (p) return p;
      p = (async function () {
        const pr = await probe(source, target);
        if (pr.availability !== 'available') throw new Error('not-available:' + pr.availability);
        return get().create({ sourceLanguage: source, targetLanguage: target });
      })();
      cache.set(key, p);
      p.catch(function () {
        if (cache.get(key) === p) cache.delete(key); // never cache failures
      });
      return p;
    }

    async function one(t, text) {
      try {
        return String(await t.translate(text)).replace(/\s*[\r\n]+\s*/g, ' ').trim();
      } catch (e) {
        if (text.length > 300) {
          const parts = splitLong(text, 300);
          const outs = [];
          for (let i = 0; i < parts.length; i++) outs.push(String(await t.translate(parts[i])).trim());
          return outs.join(' ').trim();
        }
        throw e;
      }
    }

    // texts: string[] -> string[] (same length, '' for blank input). Throws on any failure.
    async function translate(source, target, texts) {
      const t = await translator(source, target);
      const out = [];
      for (let i = 0; i < texts.length; i++) {
        const s = String(texts[i] == null ? '' : texts[i]).trim();
        out.push(s ? await one(t, s) : '');
      }
      return out;
    }

    function reset() {
      cache.forEach(function (p) {
        p.then(function (t) {
          try {
            t.destroy && t.destroy();
          } catch (e) {}
        }, function () {});
      });
      cache.clear();
    }

    return { probe: probe, translate: translate, reset: reset };
  }

  // Popup only (needs a user gesture when the model is not installed yet): downloads/installs the model for
  // source->target. onProgress(fraction 0..1). Resolves with the availability afterwards.
  async function downloadPair(T, source, target, onProgress) {
    if (!T || typeof T.create !== 'function') throw new Error('unsupported');
    const tr = await T.create({
      sourceLanguage: source,
      targetLanguage: target,
      monitor: function (m) {
        m.addEventListener('downloadprogress', function (e) {
          const f = e.total && e.total > 1 ? e.loaded / e.total : e.loaded;
          if (onProgress) onProgress(Math.max(0, Math.min(1, Number(f) || 0)));
        });
      }
    });
    try {
      await tr.translate('Hello'); // forces the model to finish loading
    } catch (e) {}
    try {
      tr.destroy && tr.destroy();
    } catch (e) {}
    return T.availability({ sourceLanguage: source, targetLanguage: target });
  }

  const api = { createEngine: createEngine, downloadPair: downloadPair, splitLong: splitLong };
  YVD.localTranslate = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : typeof self !== 'undefined' ? self : globalThis);
