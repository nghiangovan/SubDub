/* Service worker: translation requests (avoids page CORS), translation cache, chrome.tts fallback,
 * the bridge to the offscreen document (Google TTS / Piper TTS / on-device Translator) and the native-messaging
 * bridge to the optional local VieNeu voice (only a service worker can call connectNative). */
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
          justification: 'Phát giọng đọc tiếng Việt (Google TTS, Piper offline chạy trong Worker hoặc giọng VieNeu cục bộ) và dịch trên máy bằng Translator API khi lồng tiếng video YouTube.'
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
      const engine = msg.engine === 'piper' || msg.engine === 'vieneu' ? msg.engine : 'google';
      const r = await toOffscreen({ op, engine, text: msg.text, voice: msg.voice, rate: msg.rate, texts: msg.texts, volume: msg.volume }, true);
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

  // ---- VieNeu (optional local voice): native-messaging bridge to the program Chrome starts ('com.subdub.vieneu') ----
  // The program loads the model (~0.6 GB RAM) only while dubbing: it is connected lazily, asked to load the model
  // ('warm') or given a line, and dropped after VN_IDLE_MS without either. A mere status check (popup / guide page)
  // never loads the model and its connection is dropped VN_STATUS_MS after it was opened.
  // storage.local 'vieneuState' mirrors the state so every tab/popup can react.
  const VN_HOST = 'com.subdub.vieneu';
  const VN_IDLE_MS = 2 * 60 * 1000;
  const VN_STATUS_MS = 30 * 1000;
  const VN_HELLO_MS = 10000; // the program answers hello at once; it never does when it hangs
  const VN_READY_MS = 30000; // a synth request waits this long for the model to finish loading
  const VN_SYNTH_MS = 90000;
  const vn = {
    port: null,
    info: { state: '', progress: 0, voices: [], defaultVoice: '', steps: 0, error: '' },
    nextId: 0,
    pend: new Map(), // request id -> { parts, got, total, res }
    hello: null, // { promise, done } of the current connection
    waiters: [], // { states, res } waiting for a state
    idle: null,
    rehello: null, // resolves a pending 'recheck' when the program answers hello
    busy: false // a synth/warm request came in on this connection (so a status check does not shorten the idle timer)
  };
  function vnSet(patch) {
    const before = vn.info.state;
    Object.assign(vn.info, patch);
    if (vn.info.state !== before) local.set({ vieneuState: vn.info.state }).catch(() => {});
    vn.waiters = vn.waiters.filter((w) => {
      if (w.states.indexOf(vn.info.state) < 0) return true;
      w.res(true);
      return false;
    });
  }
  function vnFailAll(error) {
    const all = Array.from(vn.pend.values());
    vn.pend.clear();
    all.forEach((p) => p.res({ ok: false, error }));
  }
  // kind 'work' (synth / warm): keep the program for VN_IDLE_MS from now. kind 'status': only arms the short timer
  // when none is running (never extended, so a popup left open cannot keep the program alive).
  function vnTouch(kind) {
    if (kind !== 'work') {
      if (vn.idle) return;
      vn.idle = setTimeout(() => vnDrop('idle'), VN_STATUS_MS);
      return;
    }
    clearTimeout(vn.idle);
    vn.busy = true;
    vn.idle = setTimeout(() => vnDrop('idle'), VN_IDLE_MS);
  }
  function vnDrop(why) {
    clearTimeout(vn.idle);
    vn.idle = null;
    vn.busy = false;
    const p = vn.port;
    vn.port = null;
    // the model is gone with the program: installed and fine, but not loaded ('idle')
    if (p && (vn.info.state === 'ready' || vn.info.state === 'loading')) vnSet({ state: 'idle' });
    if (p) {
      try {
        p.disconnect();
      } catch (e) {}
    }
    vnFailAll('vieneu-' + why);
    if (vn.hello) vn.hello.done();
  }
  function vnOnMessage(m) {
    if (!m || typeof m !== 'object') return;
    if (m.type === 'hello' || m.type === 'status') {
      vnSet({
        state: String(m.state || vn.info.state),
        progress: typeof m.progress === 'number' ? m.progress : vn.info.progress,
        error: String(m.error || '')
      });
      if (m.type === 'hello') {
        if (Array.isArray(m.voices)) vn.info.voices = m.voices;
        if (m.defaultVoice) vn.info.defaultVoice = String(m.defaultVoice);
        if (m.steps) vn.info.steps = m.steps;
        if (vn.hello) {
          vn.hello.got = true;
          vn.hello.done();
        }
        if (vn.rehello) vn.rehello();
      }
    } else if (m.type === 'audio') {
      const p = vn.pend.get(m.id);
      if (!p) return;
      p.parts[m.part | 0] = String(m.b64 || '');
      p.got++;
      if (p.got >= m.parts) {
        vn.pend.delete(m.id);
        p.res({ ok: true, b64: p.parts.join(''), sr: m.sr, dur: m.dur });
      }
    } else if (m.type === 'error') {
      const p = vn.pend.get(m.id);
      if (!p) return;
      vn.pend.delete(m.id);
      // (the program also announces these with a status message; this makes the state right before that arrives)
      if (m.error === 'low-memory' || m.error === 'too-slow') vnSet({ state: m.error });
      p.res({ ok: false, error: String(m.error || 'vieneu error'), cancelled: m.error === 'cancelled' });
    }
  }
  function vnOnDisconnect(port) {
    let err = '';
    try {
      err = (chrome.runtime.lastError && chrome.runtime.lastError.message) || '';
    } catch (e) {}
    if (vn.port !== port) return; // dropped by us
    vn.port = null;
    clearTimeout(vn.idle);
    vn.idle = null;
    const wasBusy = vn.busy;
    vn.busy = false;
    if (/not found/i.test(err)) vnSet({ state: 'not-installed', error: '' });
    else if (!wasBusy && vn.info.state !== 'error' && vn.info.state !== '') vnSet({ state: 'idle', error: '' }); // it left by itself after a quiet while: by design
    else vnSet({ state: 'error', error: err || 'Chương trình giọng VieNeu đã dừng' });
    vnFailAll(vn.info.state === 'not-installed' ? 'not-installed' : 'vieneu-disconnected');
    if (vn.hello) vn.hello.done();
  }
  function vnConnect() {
    if (vn.port) return;
    let done;
    const promise = new Promise((res) => {
      done = res;
    });
    const h = (vn.hello = { promise, done, got: false });
    const timer = setTimeout(() => {
      if (vn.hello === h && !h.got && vn.port) vnSet({ state: 'error', error: 'Chương trình giọng VieNeu không phản hồi' });
      done();
    }, VN_HELLO_MS);
    promise.then(() => clearTimeout(timer));
    let port;
    try {
      port = chrome.runtime.connectNative(VN_HOST);
    } catch (e) {
      // (older Chrome throws for an unregistered host instead of calling onDisconnect)
      vnSet({ state: /not found/i.test(String((e && e.message) || e)) ? 'not-installed' : 'error', error: String((e && e.message) || e) });
      done();
      return;
    }
    vn.port = port;
    port.onMessage.addListener(vnOnMessage);
    port.onDisconnect.addListener(() => vnOnDisconnect(port));
    try {
      port.postMessage({ type: 'hello' });
    } catch (e) {}
  }
  function vnSend(m) {
    if (!vn.port) return false;
    try {
      vn.port.postMessage(m);
      return true;
    } catch (e) {
      return false;
    }
  }
  async function vnEnsure() {
    if (!vn.port) vnConnect();
    if (vn.hello) await vn.hello.promise;
  }
  function vnStatus() {
    const i = vn.info;
    return { ok: true, state: i.state || 'not-installed', progress: i.progress, voices: i.voices, defaultVoice: i.defaultVoice, steps: i.steps, error: i.error };
  }
  function vnWaitState(states, ms) {
    if (states.indexOf(vn.info.state) >= 0) return Promise.resolve(true);
    return new Promise((res) => {
      const w = { states, res };
      vn.waiters.push(w);
      setTimeout(() => {
        const i = vn.waiters.indexOf(w);
        if (i >= 0) vn.waiters.splice(i, 1);
        res(false);
      }, ms);
    });
  }
  function vnSynth(msg) {
    const text = String(msg.text || '').trim();
    if (!text) return Promise.resolve({ ok: false, error: 'empty text' });
    return vnEnsure().then(async () => {
      if (!vn.port) return { ok: false, error: vn.info.state === 'not-installed' ? 'not-installed' : vn.info.error || 'vieneu-disconnected' };
      vnTouch('work');
      // 'idle': the program loads the model for the first line. A model that is loading is worth waiting for;
      // missing / downloading / low-memory / too-slow / error are not
      if (vn.info.state === 'loading') await vnWaitState(['ready', 'idle', 'error', 'missing', 'low-memory', 'too-slow'], VN_READY_MS);
      if (vn.info.state !== 'ready' && vn.info.state !== 'idle') return { ok: false, error: 'vieneu-' + (vn.info.state || 'unavailable') };
      return new Promise((res) => {
        const id = 'r' + ++vn.nextId;
        const timer = setTimeout(() => {
          if (vn.pend.delete(id)) {
            vnSend({ type: 'cancel', ids: [id] });
            res({ ok: false, error: 'timeout' });
          }
        }, VN_SYNTH_MS);
        vn.pend.set(id, { parts: [], got: 0, res: (r) => (clearTimeout(timer), res(r)) });
        if (!vnSend({ type: 'speak', id, text, voice: String(msg.voice || ''), prio: msg.prio ? 1 : 0 })) {
          vn.pend.delete(id);
          clearTimeout(timer);
          res({ ok: false, error: 'vieneu-disconnected' });
        }
      });
    });
  }
  async function vieneu(msg) {
    const op = msg.op;
    if (op === 'synth') return vnSynth(msg);
    if (op === 'cancel') {
      if (vn.port) vnSend({ type: 'cancel' }); // the program drops its queued prefetches
      return { ok: true };
    }
    if (op === 'recheck') {
      // (low-memory / too-slow are re-evaluated by a fresh program)
      if (vn.port && vn.info.state !== 'error' && vn.info.state !== 'low-memory' && vn.info.state !== 'too-slow') {
        // alive: just refresh what we know (no model reload); the program answers at once
        await new Promise((res) => {
          const t = setTimeout(res, 2000);
          vn.rehello = () => (clearTimeout(t), res());
          if (!vnSend({ type: 'hello' })) res();
        });
        vn.rehello = null;
      } else {
        vnDrop('recheck'); // dead end ("not-installed", crashed, error): connect from scratch
        vn.info.state = '';
        await vnEnsure();
      }
      vnTouch('status');
      return vnStatus();
    }
    if (op === 'warm') {
      // dubbing has started: load the model now so the first line is not delayed (never from a mere status check)
      const dead = !vn.port && (vn.info.state === 'not-installed' || vn.info.state === 'error');
      if (!dead) {
        await vnEnsure();
        if (vn.port && (vn.info.state === 'idle' || vn.info.state === 'ready' || vn.info.state === 'loading')) {
          vnSend({ type: 'warm' });
          vnTouch('work');
        }
      }
      return vnStatus();
    }
    if (op === 'status' || op === 'download') {
      // a known dead end (not installed / crashed) is only retried by 'recheck', so polling does not respawn the program
      const dead = !vn.port && (vn.info.state === 'not-installed' || vn.info.state === 'error');
      if (!dead) {
        await vnEnsure();
        if (vn.port) vnTouch(op === 'download' ? 'work' : 'status');
      }
      if (op === 'download' && vn.port) vnSend({ type: 'download' });
      return vnStatus();
    }
    return { ok: false, error: 'unknown op' };
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
      case 'vieneu':
        try {
          return await vieneu(msg);
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
