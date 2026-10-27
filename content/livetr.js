/* Live translation of single lines (Google Meet captions). Same providers and failover as the YouTube pipeline:
 *   provider 'auto' / 'local' : on-device Chrome Translator first (when its model is installed), Google as backup
 *   provider 'google' / 'youtube' : Google first, on-device as backup
 *   provider 'claude'         : Claude (falls back to Google in the background), on-device as backup
 * YVD.providers.createRouter tracks failures: 2 consecutive failures park a provider for 60 s and the line is
 * retried with the next one, so translation never stops. Results go through a small in-memory LRU. */
(function (root) {
  'use strict';
  const YVD = (root.YVD = root.YVD || {});

  const CACHE_MAX = 200;
  const REPROBE_MS = 30000; // while the on-device model is not installed, look again (the popup may install it)

  // deps: { PV, send(msg)->Promise, localtr: {probe(src,tgt), translate(info,text)}, now?, onNotice?(text) }
  function createLiveTranslator(deps) {
    const PV = deps.PV;
    const now = deps.now || Date.now;
    const notice = deps.onNotice || function () {};
    let provider = 'auto';
    let srcLang = 'en';
    let info = null;
    let router = null;
    let probedAt = 0;
    let probing = null;
    const cache = new Map(); // text -> vi
    const context = []; // previous source lines (for Claude)

    function reset() {
      info = null;
      router = null;
      probedAt = 0;
      probing = null;
    }

    function configure(p, lang) {
      const changed = p !== provider || (lang || srcLang) !== srcLang;
      provider = p || 'auto';
      srcLang = lang || srcLang;
      if (changed) reset();
    }

    function localOk() {
      return !!(info && info.where && info.availability === 'available');
    }

    // (Re)build the provider chain from the on-device availability.
    async function ensureReady() {
      if (router && (localOk() || now() - probedAt < REPROBE_MS)) return;
      if (probing) return probing;
      probing = (async function () {
        try {
          info = await deps.localtr.probe(PV.localSource(srcLang), PV.TARGET);
        } catch (e) {
          info = null;
        }
        probedAt = now();
        const chain = PV.resolveChain(provider, localOk());
        // keep the failure memory of providers that stay in the chain
        const old = router;
        router = PV.createRouter(chain, { threshold: 2, cooldown: 60000, now: now });
        if (old && old.chain.join() === chain.join()) router = old;
        probing = null;
      })();
      return probing;
    }

    function remember(text, vi) {
      cache.delete(text);
      cache.set(text, vi);
      while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    }

    async function runProvider(prov, text) {
      if (prov === 'local') {
        try {
          const t = await deps.localtr.translate(info, text);
          return t ? { vi: t } : { fail: true };
        } catch (e) {
          return { fail: true, permanent: /not-available|NotAllowed|NotSupported/i.test(String((e && e.message) || e)) };
        }
      }
      const r = await deps.send({ type: 'translate', provider: prov, texts: [text], context: context.slice(-3), site: 'meet' });
      if (!r || !r.ok || !Array.isArray(r.result) || !r.result[0] || (r.failed && r.failed.length)) return { fail: true };
      return { vi: r.result[0] };
    }

    // -> { vi, provider } or null when every provider failed for this line
    async function translate(text) {
      text = String(text == null ? '' : text).trim();
      if (!text) return null;
      if (!/[\p{L}\p{N}]/u.test(text)) return { vi: text, provider: 'none' }; // symbols only
      if (cache.has(text)) return { vi: cache.get(text), provider: 'cache' };
      await ensureReady();
      const rt = router; // configure() may replace/clear `router` while a provider is awaited
      if (!rt) return null;
      const tried = {};
      for (let n = 0; n < rt.chain.length * 2; n++) {
        const prov = rt.pick();
        if (tried[prov] >= 2) break;
        tried[prov] = (tried[prov] || 0) + 1;
        const res = await runProvider(prov, text);
        if (res.vi) {
          rt.ok(prov, 1);
          remember(text, res.vi);
          context.push(text);
          if (context.length > 6) context.shift();
          return { vi: res.vi, provider: prov };
        }
        const wentDown = rt.fail(prov, !!res.permanent);
        if (wentDown) {
          const next = rt.pick();
          if (next !== prov) notice(prov === 'local' ? 'SubDub: dịch trên máy lỗi, chuyển sang Google' : 'SubDub: Google dịch bị chặn, chuyển sang dịch trên máy');
        }
      }
      return null;
    }

    // Quick draft of a still-growing line: on-device translator only (fast, unlimited), never Google.
    async function translateInterim(text) {
      text = String(text == null ? '' : text).trim();
      if (!text || !/[\p{L}\p{N}]/u.test(text)) return null;
      if (cache.has(text)) return cache.get(text);
      await ensureReady();
      const rt = router;
      if (!rt || !localOk() || rt.isDown('local') || !rt.chain.includes('local')) return null;
      try {
        return (await deps.localtr.translate(info, text)) || null;
      } catch (e) {
        return null;
      }
    }

    return {
      configure: configure,
      translate: translate,
      translateInterim: translateInterim,
      reset: reset,
      state: function () {
        return { provider: provider, local: info ? { where: info.where, availability: info.availability } : null, counts: router ? router.counts() : null };
      }
    };
  }

  YVD.liveTranslate = { create: createLiveTranslator };
  if (typeof module !== 'undefined' && module.exports) module.exports = YVD.liveTranslate;
})(typeof window !== 'undefined' ? window : globalThis);
