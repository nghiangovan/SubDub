/* On-device translation client (ISOLATED world content script).
 * Where does Chrome's Translator API run?  Decided at runtime by probing:
 *   1) offscreen document (extension origin; shared by every YouTube tab, survives tab throttling)  -> where:'offscreen'
 *   2) this content script's own window (YouTube tab)                                               -> where:'content'
 *   3) neither exposes it                                                                           -> where:null
 * Only 'available' (model already installed) is used here; installing needs a user gesture (popup button). */
(function () {
  'use strict';
  const YVD = window.YVD;
  const engine = YVD.localTranslate.createEngine(); // uses window.Translator of this tab

  function send(msg) {
    return new Promise((res) => {
      if (!YVD.settings.alive()) return res({ ok: false, error: 'context' });
      try {
        chrome.runtime.sendMessage(msg, (r) => {
          void chrome.runtime.lastError;
          res(r || { ok: false, error: 'no response' });
        });
      } catch (e) {
        res({ ok: false, error: 'send failed' });
      }
    });
  }

  const withTimeout = (p, ms, fallback) => Promise.race([p, new Promise((r) => setTimeout(() => r(fallback), ms))]);

  // source: normalised language tag ('en'); -> { where, availability, source, target }
  async function probe(source, target) {
    target = target || 'vi';
    const none = { where: null, availability: 'unsupported', source, target };
    if (!source) return none;
    const off = await withTimeout(send({ type: 'localTr', op: 'probe', source, target }), 6000, { ok: false });
    if (off && off.ok && off.exposed) return { where: 'offscreen', availability: off.availability, source, target };
    const here = await engine.probe(source, target);
    if (here.exposed) return { where: 'content', availability: here.availability, source, target };
    return none;
  }

  // -> translated string; throws Error (message 'not-available:…' means the model is not installed)
  async function translate(info, text) {
    if (!info || !info.where) throw new Error('not-available:unsupported');
    if (info.where === 'offscreen') {
      const r = await send({ type: 'localTr', op: 'translate', source: info.source, target: info.target, texts: [text] });
      if (!r.ok || !Array.isArray(r.result)) throw new Error(r.error || 'local translate failed');
      return r.result[0] || '';
    }
    return (await engine.translate(info.source, info.target, [text]))[0] || '';
  }

  YVD.localtr = { probe: probe, translate: translate };
})();
