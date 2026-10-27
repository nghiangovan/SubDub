/* Service worker: translation requests (avoids page CORS), translation cache, chrome.tts fallback,
 * and the bridge to the offscreen document (Google TTS / Piper TTS / on-device Translator). */
importScripts('lib/settings.js', 'lib/translators.js', 'lib/piper-text.js', 'lib/piper-store.js');

const YVD_BG = (function () {
  const MAX_VIDEOS = 50;
  const INDEX_KEY = 'tr:index';
  let chain = Promise.resolve(); // serialise cache writes

  const local = {
    get: (keys) => new Promise((res) => chrome.storage.local.get(keys, (o) => res(o || {}))),
    set: (obj) => new Promise((res) => chrome.storage.local.set(obj, () => res())),
    remove: (keys) => new Promise((res) => chrome.storage.local.remove(keys, () => res()))
  };

  async function getCache(provider, videoId) {
    const key = `tr:${provider}:${videoId}`;
    const o = await local.get(key);
    return o[key] && Array.isArray(o[key].segments) ? o[key].segments : null;
  }

  function setCache(provider, videoId, segments) {
    chain = chain.then(async () => {
      const key = `tr:${provider}:${videoId}`;
      const idx = ((await local.get(INDEX_KEY))[INDEX_KEY] || []).filter((k) => k !== key);
      idx.push(key);
      const evict = idx.length > MAX_VIDEOS ? idx.splice(0, idx.length - MAX_VIDEOS) : [];
      if (evict.length) await local.remove(evict);
      await local.set({ [key]: { segments, ts: Date.now() }, [INDEX_KEY]: idx });
    });
    return chain;
  }

  function clearCache() {
    chain = chain.then(async () => {
      const idx = (await local.get(INDEX_KEY))[INDEX_KEY] || [];
      await local.remove(idx.concat([INDEX_KEY]));
    });
    return chain;
  }

  // ---- Google TTS: audio is played in an offscreen document ----
  let creating = null;
  async function hasOffscreen() {
    if (chrome.runtime.getContexts) {
      const ctx = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
      return ctx.length > 0;
    }
    const url = chrome.runtime.getURL('offscreen.html');
    return (await self.clients.matchAll()).some((c) => c.url === url);
  }
  async function ensureOffscreen() {
    if (await hasOffscreen()) return;
    if (!creating) {
      creating = chrome.offscreen
        .createDocument({
          url: 'offscreen.html',
          // AUDIO_PLAYBACK alone would close the document after 30 s without audio; WORKERS is genuine (Piper
          // inference runs in a Worker) and keeps long downloads / on-device translation alive.
          reasons: ['AUDIO_PLAYBACK', 'WORKERS'],
          justification: 'Phát giọng đọc tiếng Việt (Google TTS hoặc Piper offline, chạy trong Worker) và dịch trên máy bằng Translator API khi lồng tiếng video YouTube.'
        })
        .catch(async (e) => {
          if (!(await hasOffscreen())) throw e; // "only one offscreen document" race: fine
        })
        .finally(() => {
          creating = null;
        });
    }
    await creating;
  }
  async function toOffscreen(payload, retry) {
    try {
      return await chrome.runtime.sendMessage(Object.assign({}, payload, { target: 'offscreen' })); // target last: it routes the message
    } catch (e) {
      if (retry) {
        await new Promise((r) => setTimeout(r, 150));
        return toOffscreen(payload, false);
      }
      throw e;
    }
  }
  async function gtts(msg) {
    const op = msg.op;
    if (op === 'speak' || op === 'prefetch') {
      await ensureOffscreen();
      const r = await toOffscreen({ op, engine: msg.engine === 'piper' ? 'piper' : 'google', text: msg.text, rate: msg.rate, texts: msg.texts, volume: msg.volume }, true);
      return r || { ok: false, error: 'no response' };
    }
    // pause / resume / cancel / setVolume: only if the document already exists
    if (!(await hasOffscreen())) return { ok: true };
    return (await toOffscreen({ op, volume: msg.volume }, false)) || { ok: true };
  }

  // storage.local 'piperReady' lets every tab's dubber learn (storage.onChanged) when the offline voice appears
  async function setPiperFlag(ready) {
    try {
      const cur = (await local.get('piperReady')).piperReady;
      if (!!cur !== !!ready) await local.set({ piperReady: !!ready });
    } catch (e) {}
  }

  // ---- Piper (offline voice): same speak/prefetch/pause/... ops as gtts, plus status/download/warm ----
  async function piper(msg) {
    const op = msg.op;
    if (op === 'status') {
      const ready = await YVD.piperStore.isReady();
      await setPiperFlag(ready);
      let dl = { state: ready ? 'ready' : 'idle', loaded: 0, total: YVD.piperText.MODEL_BYTES, error: '' };
      if (await hasOffscreen()) {
        try {
          const r = await toOffscreen({ op: 'piperStatus' }, false);
          if (r && r.ok) dl = { state: r.state, loaded: r.loaded, total: r.total, error: r.error };
        } catch (e) {}
      }
      return { ok: true, ready: ready, state: dl.state, loaded: dl.loaded, total: dl.total, error: dl.error };
    }
    if (op === 'download' || op === 'warm' || op === 'speak' || op === 'prefetch') {
      await ensureOffscreen();
      const name = { download: 'piperDownload', warm: 'piperWarm' }[op] || op;
      const r = await toOffscreen({ op: name, engine: 'piper', text: msg.text, rate: msg.rate, texts: msg.texts, volume: msg.volume }, true);
      return r || { ok: false, error: 'no response' };
    }
    if (op === 'abort') {
      if (!(await hasOffscreen())) return { ok: true };
      return (await toOffscreen({ op: 'piperAbort' }, false)) || { ok: true };
    }
    return gtts(msg); // pause / resume / cancel / setVolume are engine-agnostic
  }

  // ---- on-device translation: runs in the offscreen document (Translator API) ----
  async function localTr(msg) {
    await ensureOffscreen();
    const op = msg.op === 'probe' ? 'trProbe' : 'trTranslate';
    // (language fields must not be called 'target': that key routes the message to the offscreen document)
    const r = await toOffscreen({ op, sourceLang: msg.source, targetLang: msg.target, texts: msg.texts }, true);
    return r || { ok: false, error: 'no response' };
  }

  async function handle(msg) {
    switch (msg && msg.type) {
      case 'gtts':
        try {
          return await gtts(msg);
        } catch (e) {
          return { ok: false, error: String((e && e.message) || e) };
        }
      case 'piperReadyChanged':
        await setPiperFlag(!!msg.ready);
        return { ok: true };
      case 'piper':
        try {
          return await piper(msg);
        } catch (e) {
          return { ok: false, error: String((e && e.message) || e) };
        }
      case 'localTr':
        try {
          return await localTr(msg);
        } catch (e) {
          return { ok: false, error: String((e && e.message) || e) };
        }
      case 'translate': {
        let apiKey = '';
        let model = '';
        if (msg.provider === 'claude') {
          apiKey = await YVD.settings.getApiKey();
          model = (await YVD.settings.get()).claudeModel;
        }
        const r = await YVD.translators.translate({
          provider: msg.provider,
          texts: msg.texts,
          context: msg.context,
          budgets: msg.budgets,
          apiKey,
          model
        });
        return { ok: true, result: r.result, note: r.note, failed: r.failed || [], fallback: !!r.fallback };
      }
      case 'getCache': {
        const segments = await getCache(msg.provider, msg.videoId);
        return { ok: true, segments };
      }
      case 'setCache':
        await setCache(msg.provider, msg.videoId, msg.segments);
        return { ok: true };
      case 'clearCache':
        await clearCache();
        return { ok: true };
      case 'ttsStop':
        try {
          chrome.tts.stop();
        } catch (e) {}
        return { ok: true };
      case 'tts':
        return new Promise((resolve) => {
          try {
            chrome.tts.speak(msg.text, {
              lang: 'vi-VN',
              rate: msg.rate || 1,
              volume: Math.min(1, Math.max(0, Number.isFinite(Number(msg.volume)) ? Number(msg.volume) : 1)),
              onEvent: (ev) => {
                if (['end', 'error', 'interrupted', 'cancelled'].includes(ev.type)) resolve({ ok: true, event: ev.type });
              }
            });
          } catch (e) {
            resolve({ ok: false });
          }
        });
      default:
        return { ok: false, error: 'unknown message' };
    }
  }
  return { handle };
})();

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || (msg && msg.target === 'offscreen')) return false;
  YVD_BG.handle(msg).then(sendResponse, (e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
  return true;
});
