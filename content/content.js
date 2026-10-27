/* Orchestrator (ISOLATED world): caption acquisition, translation, sync loop, SPA navigation. */
(function () {
  'use strict';
  const YVD = window.YVD;
  const C = YVD.captions;
  const O = YVD.overlay;
  const D = YVD.dubber;
  const S = YVD.settings;
  const PV = YVD.providers;
  if (window.__YVD_CONTENT__) return;
  window.__YVD_CONTENT__ = true;

  let settings = S.normalize({});
  let session = null;
  let tokenSeq = 0;
  let video = null;
  let lastIdx = -2;
  let skipSpeakUntilNext = false;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const alive = () => S.alive();

  function send(msg) {
    return new Promise((res) => {
      if (!alive()) return res({ ok: false, error: 'context' });
      try {
        chrome.runtime.sendMessage(msg, (r) => {
          void chrome.runtime.lastError;
          res(r || { ok: false });
        });
      } catch (e) {
        res({ ok: false });
      }
    });
  }

  function cmd(type, extra) {
    window.postMessage(Object.assign({ source: 'YVD-CMD', type }, extra || {}), '*');
  }

  async function waitFor(pred, ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (pred()) return true;
      await sleep(150);
    }
    return pred();
  }

  function getVideoId() {
    try {
      const u = new URL(location.href);
      return u.pathname === '/watch' ? u.searchParams.get('v') : null;
    } catch (e) {
      return null;
    }
  }

  // master switch AND the per-site switch for YouTube
  const siteOn = (st) => !!(st.enabled && st.siteYoutube);
  const wantsSubs = () => settings.mode !== 'dub';
  const wantsDub = () => settings.mode !== 'subtitle';

  // ---------- messages from MAIN world ----------
  window.addEventListener('message', (ev) => {
    if (ev.source !== window || !ev.data || ev.data.source !== 'YVD' || !session) return;
    const d = ev.data;
    if (d.type === 'tracks') {
      // early player responses can list no captions yet; never downgrade a non-empty list to empty
      const list = d.tracks || [];
      if (d.videoId === session.videoId && (list.length || !session.tracks)) session.tracks = list;
    } else if (d.type === 'timedtext') {
      const vid = C.getParam(d.url, 'v');
      if (vid && vid !== session.videoId) return;
      const events = C.parseCaptions(d.body);
      if (!events.length) return;
      if (C.getParam(d.url, 'tlang')) {
        session.capturedTr = { events, tlang: C.getParam(d.url, 'tlang') };
      } else if (!session.source) {
        session.source = { events, lang: C.getParam(d.url, 'lang') || '' };
      }
    }
  });

  // ---------- video / player ----------
  function ensureVideo() {
    const player = document.getElementById('movie_player');
    if (player) O.attach(player);
    const v = document.querySelector('video.html5-main-video') || document.querySelector('#movie_player video');
    if (v && v !== video) {
      if (video) unbindVideo(video);
      video = v;
      bindVideo(video);
      D.attach(video);
    }
    return video;
  }

  function bindVideo(v) {
    v.addEventListener('seeking', onSeeking);
    v.addEventListener('seeked', onSeeked);
    v.addEventListener('pause', onPause);
    v.addEventListener('play', onPlay);
    v.addEventListener('ratechange', onRateChange);
    v.addEventListener('timeupdate', tick);
    startFrameLoop();
  }
  function unbindVideo(v) {
    v.removeEventListener('seeking', onSeeking);
    v.removeEventListener('seeked', onSeeked);
    v.removeEventListener('pause', onPause);
    v.removeEventListener('play', onPlay);
    v.removeEventListener('ratechange', onRateChange);
    v.removeEventListener('timeupdate', tick);
  }

  let frameLoopOn = false;
  function startFrameLoop() {
    if (frameLoopOn) return;
    frameLoopOn = true;
    const loop = () => {
      if (!alive()) return;
      tick();
      if (video && typeof video.requestVideoFrameCallback === 'function') video.requestVideoFrameCallback(loop);
    };
    if (video && typeof video.requestVideoFrameCallback === 'function') video.requestVideoFrameCallback(loop);
  }
  // safety net (paused video, no frame callbacks, replaced elements)
  setInterval(() => {
    if (!alive()) return;
    ensureVideo();
    tick();
  }, 250);

  function onSeeking() {
    D.cancel();
    lastIdx = -2;
    skipSpeakUntilNext = true; // landing mid-segment: wait for the next one
  }
  function onSeeked() {
    tick();
  }
  let speedPaused = false;
  function onRateChange() {
    // recompute immediately: re-evaluate dub eligibility, restart the current segment's budget
    D.cancel();
    lastIdx = -2;
    refreshDubActive();
    tick();
  }
  function onPause() {
    D.pause();
  }
  function onPlay() {
    D.resume();
    tick();
  }

  // ---------- sync loop ----------
  function isAd() {
    const p = document.getElementById('movie_player');
    return !!(p && p.classList.contains('ad-showing'));
  }

  function tick() {
    if (!session || !video || !alive()) return;
    if (!O.isAttached()) ensureVideo();
    if (isAd()) {
      O.setHidden(true);
      D.pause();
      return;
    }
    O.setHidden(false);
    const cues = session.cues;
    if (!cues.length) return;
    const t = video.currentTime;
    const idx = C.findSegmentIndex(cues, t);
    if (idx === lastIdx) return;
    lastIdx = idx;
    if (idx < 0) {
      O.clear();
      return;
    }
    const cue = cues[idx];
    if (wantsSubs()) O.setCue(cue, settings);
    if (skipSpeakUntilNext) {
      if (t - cue.start > 1.5) {
        skipSpeakUntilNext = false;
        D.resetLast();
        return;
      }
      skipSpeakUntilNext = false;
    }
    if (wantsDub() && !video.paused && D.isActive()) D.speakCue(cue, cues[idx + 1], cues[idx + 2]);
  }

  // ---------- pipeline ----------
  function applyActiveClass(on) {
    document.documentElement.classList.toggle('yvd-active', !!on);
  }

  function refreshDubActive() {
    const base = siteOn(settings) && wantsDub() && !!session && session.cues.length > 0;
    const rate = video ? video.playbackRate : 1;
    const ok = D.dubAllowed(rate, settings.dubMaxSpeed);
    if (base && !ok) {
      if (!speedPaused) O.status('Lồng tiếng tạm tắt ở tốc độ > ' + settings.dubMaxSpeed + 'x', 4000);
      speedPaused = true;
    } else {
      speedPaused = false;
    }
    D.setActive(base && ok);
  }

  function stopSession() {
    if (session) session.dead = true;
    session = null;
    lastIdx = -2;
    O.clear();
    O.status('');
    D.setActive(false);
  }

  function cacheKeyFor(provider) {
    return provider === 'claude' && settings.concise ? 'claude-concise' : provider;
  }
  function cacheCandidates(provider) {
    if (provider === 'auto' || provider === 'local') return ['local', 'google'];
    return [cacheKeyFor(provider)];
  }

  async function startSession() {
    stopSession();
    const videoId = getVideoId();
    if (!siteOn(settings) || !videoId) {
      applyActiveClass(false);
      return;
    }
    applyActiveClass(true);
    const s = (session = {
      token: ++tokenSeq,
      videoId,
      provider: settings.provider,
      // cache keys to look up (a cache hit skips translation); 'auto'/'local' may have been stored by either engine
      cacheLookup: cacheCandidates(settings.provider),
      cacheProvider: cacheKeyFor(settings.provider),
      srcLang: null,
      localInfo: null,
      cues: [],
      tracks: null,
      source: null,
      capturedTr: null,
      dead: false
    });
    ensureVideo();
    O.applySettings(settings);
    D.configure(settings, (m) => O.status(m, 4000));
    O.status('SubDub: đang tải phụ đề…', 0);

    for (const key of s.cacheLookup) {
      const cached = await send({ type: 'getCache', provider: key, videoId });
      if (s.dead) return;
      if (cached.ok && cached.segments && cached.segments.length) {
        s.cues = cached.segments;
        refreshDubActive();
        O.status('SubDub: đã tải bản dịch từ bộ nhớ đệm', 2500);
        return;
      }
    }

    try {
      const source = await acquireSource(s);
      if (s.dead) return;
      if (!source) {
        O.status('SubDub: không tìm thấy phụ đề', 5000);
        return;
      }
      const srcSegs = C.mergeEvents(source.events);
      if (!srcSegs.length) {
        O.status('SubDub: không tìm thấy phụ đề', 5000);
        return;
      }
      if (/^vi/i.test(source.lang || '')) {
        s.cues = srcSegs.map((x) => ({ start: x.start, end: x.end, text: x.text, vi: x.text }));
        refreshDubActive();
        O.status('SubDub: video đã có phụ đề tiếng Việt', 3000);
        return;
      }
      if (s.provider === 'youtube') {
        const ok = await useYouTubeTranslation(s, source, srcSegs);
        if (s.dead) return;
        if (ok) return;
        O.status('SubDub: YouTube không có bản dịch, dùng Google', 3000);
        s.provider = 'google';
        s.cacheProvider = 'google';
      }
      s.srcLang = PV.localSource(source.lang);
      await translateAll(s, srcSegs);
    } catch (e) {
      if (!s.dead) O.status('SubDub: lỗi khi xử lý phụ đề', 5000);
    }
  }

  async function fetchEvents(url) {
    try {
      const res = await fetch(url, { credentials: 'include' });
      if (!res.ok) return [];
      return C.parseCaptions(await res.text());
    } catch (e) {
      return [];
    }
  }

  async function acquireSource(s) {
    // 1) wait for the track list (and any captured timedtext)
    // (an empty list may just mean the player isn't ready yet, so keep asking)
    for (let i = 0; i < 20 && !(s.tracks && s.tracks.length) && !s.source && !s.dead; i++) {
      if (i % 2 === 0) cmd('requestTracks');
      await sleep(500);
    }
    if (s.dead) return null;
    if (!(s.tracks && s.tracks.length) && !s.source) {
      await waitFor(() => s.source || s.dead, 1000);
      return s.source;
    }
    // 2) primary: player's own request
    await waitFor(() => s.source || s.dead, 3000);
    if (s.source) return withTrack(s, s.source);
    if (s.dead) return null;
    // 3) fallback fetch of the chosen track
    const track = C.chooseTrack(s.tracks);
    if (track && track.baseUrl) {
      const events = await fetchEvents(C.withParam(track.baseUrl, 'fmt', 'json3'));
      if (s.dead) return null;
      if (events.length) return { events, lang: track.languageCode, track };
    }
    // 4) ask the player to enable captions so it issues the request itself
    cmd('enableCaptions', { languageCode: track && track.languageCode });
    await waitFor(() => s.source || s.dead, 6000);
    return s.source ? withTrack(s, s.source) : null;
  }

  function withTrack(s, src) {
    if (!src.track && s.tracks) {
      src.track =
        s.tracks.find((t) => t.languageCode === src.lang && t.kind !== 'asr') ||
        s.tracks.find((t) => t.languageCode === src.lang) ||
        C.chooseTrack(s.tracks);
    }
    if (!src.lang && src.track) src.lang = src.track.languageCode;
    return src;
  }

  async function useYouTubeTranslation(s, source, srcSegs) {
    let events = s.capturedTr && s.capturedTr.tlang === 'vi' ? s.capturedTr.events : [];
    const track = source.track;
    if (!events.length && track && track.baseUrl && track.isTranslatable !== false) {
      let url = C.withParam(track.baseUrl, 'fmt', 'json3');
      url = C.withParam(url, 'tlang', 'vi');
      events = await fetchEvents(url);
    }
    if (s.dead || !events.length) return false;
    const viSegs = C.mergeEvents(events);
    s.cues = viSegs.map((v) => {
      const i = C.findSegmentIndex(srcSegs, (v.start + v.end) / 2);
      return { start: v.start, end: v.end, text: i >= 0 ? srcSegs[i].text : '', vi: v.text };
    });
    finishSession(s);
    return true;
  }

  function finishSession(s) {
    refreshDubActive();
    lastIdx = -2;
    O.status('SubDub: đã dịch xong', 2000);
    if (s.cues.every((c) => c.vi)) {
      send({ type: 'setCache', provider: s.cacheProvider, videoId: s.videoId, segments: s.cues });
    }
  }

  // Translate every cue. Units: one segment for the on-device Translator (concurrency 3), a batch of 40 (Claude: 60)
  // lines for Google/Claude (concurrency 2). Work starts at the current playback position. A provider that fails
  // is parked for 60 s and its units are retried with the next one (google <-> local), so translation never stops.
  async function translateAll(s, srcSegs) {
    s.cues = srcSegs.map((x) => ({ start: x.start, end: x.end, text: x.text, vi: null }));
    refreshDubActive();

    // 1) on-device availability for this language pair (offscreen document -> content script -> none)
    let info = null;
    if (s.srcLang) {
      info = await YVD.localtr.probe(s.srcLang, PV.TARGET);
      if (s.dead) return;
    }
    s.localInfo = info;
    const localOk = !!(info && info.where && info.availability === 'available');
    if (!localOk && (s.provider === 'local' || s.provider === 'auto') && info && info.where && /^(downloadable|downloading)$/.test(info.availability)) {
      O.status('SubDub: chưa tải bộ dịch offline, tạm dùng Google (tải trong popup)', 5000);
    }
    const router = PV.createRouter(PV.resolveChain(s.provider, localOk), { threshold: 2, cooldown: 60000 });
    s.router = router;

    const total = s.cues.length;
    const pending = PV.progressiveOrder(s.cues, video ? video.currentTime : 0);
    const attempts = new Array(total).fill(0);
    const MAX_ATTEMPTS = 4;
    const SIZE = { local: 1, google: 40, claude: 60 };
    const CAP = { local: 3, google: 2, claude: 2 };
    const inflight = { local: 0, google: 0, claude: 0 };
    let done = 0;
    let fellBack = 0; // lines Claude could not do (no key / error): Google text, so never cached as claude
    let failedFinal = 0;
    let lastPct = -1;
    let announced = false;

    let quietUntil = 0; // keep a provider-switch notice visible instead of overwriting it with the progress pill
    const progress = () => {
      const pct = Math.round(((done + failedFinal) / total) * 100);
      if (pct !== lastPct && Date.now() >= quietUntil) {
        lastPct = pct;
        O.status('SubDub: đang dịch ' + pct + '%', 0);
      }
    };

    // -> { ok: Map(idx -> text), failed: idx[], permanent?: bool }
    const runUnit = async (prov, idxs) => {
      const ok = new Map();
      if (prov === 'local') {
        const src = s.cues[idxs[0]].text;
        if (!/[\p{L}\p{N}]/u.test(src)) {
          ok.set(idxs[0], src); // music notes / symbols only: nothing to translate
          return { ok, failed: [] };
        }
        try {
          const t = await YVD.localtr.translate(info, src);
          if (t) ok.set(idxs[0], t);
          return { ok, failed: t ? [] : idxs.slice() };
        } catch (e) {
          const permanent = /not-available|NotAllowed|NotSupported/i.test(String((e && e.message) || e));
          return { ok, failed: idxs.slice(), permanent };
        }
      }
      const texts = idxs.map((i) => s.cues[i].text);
      const first = idxs[0];
      const context = s.cues.slice(Math.max(0, first - 3), first).map((c) => c.text);
      const msg = { type: 'translate', provider: prov, texts, context, videoId: s.videoId };
      if (prov === 'claude' && settings.concise) {
        const spc = D.getSpc ? D.getSpc() : D.DEFAULT_SPC;
        msg.budgets = idxs.map((i) => D.charBudget(s.cues[i].start, s.cues[i].end, 1.5, spc));
      }
      const r = await send(msg);
      if (!r.ok || !Array.isArray(r.result) || r.result.length !== texts.length) return { ok, failed: idxs.slice() };
      const bad = new Set(r.failed || []);
      const failed = [];
      idxs.forEach((idx, k) => {
        if (r.result[k] && !bad.has(k)) ok.set(idx, r.result[k]);
        else if (s.cues[idx].text.trim()) failed.push(idx);
      });
      return { ok, failed, fallback: !!r.fallback };
    };

    const worker = async () => {
      while (!s.dead && pending.length) {
        const prov = router.pick();
        const wait = router.waitMs();
        if (wait > 0 && isFinite(wait)) {
          if (!announced) {
            announced = true;
            O.status('SubDub: dịch tạm bị chặn, thử lại sau ' + Math.ceil(wait / 1000) + ' giây…', 4000);
          }
          await sleep(Math.min(wait, 2000));
          continue;
        }
        if (inflight[prov] >= (CAP[prov] || 2)) {
          await sleep(40);
          continue;
        }
        const idxs = pending.splice(0, SIZE[prov] || 40);
        inflight[prov]++;
        let res;
        try {
          res = await runUnit(prov, idxs);
        } finally {
          inflight[prov]--;
        }
        if (s.dead) return;
        if (res.fallback) fellBack += res.ok.size;
        res.ok.forEach((text, idx) => {
          s.cues[idx].vi = text;
          done++;
          if (lastIdx === idx) lastIdx = -2; // refresh the displayed cue
        });
        if (res.ok.size) router.ok(prov, res.ok.size);
        if (res.failed.length) {
          const wentDown = router.fail(prov, !!res.permanent);
          if (wentDown) {
            const next = router.pick();
            if (next !== prov) {
              O.status(prov === 'local' ? 'SubDub: dịch trên máy lỗi, chuyển sang Google' : 'SubDub: Google dịch bị chặn, chuyển sang dịch trên máy', 5000);
              quietUntil = Date.now() + 4000;
            }
          }
          const retry = [];
          res.failed.forEach((idx) => {
            if (++attempts[idx] >= MAX_ATTEMPTS) failedFinal++;
            else retry.push(idx);
          });
          pending.unshift.apply(pending, retry);
        }
        progress();
      }
    };

    const n = localOk ? 3 : 2;
    await Promise.all(Array.from({ length: n }, worker));
    if (s.dead) return;
    s.cacheProvider = fellBack ? 'google' : cacheKeyFor(router.dominant());
    if (failedFinal) O.status('SubDub: một số đoạn dịch lỗi', 5000);
    else finishSession(s);
  }

  // ---------- navigation ----------
  let navTimer = null;
  function onNavFinish() {
    clearTimeout(navTimer);
    navTimer = setTimeout(() => {
      const id = getVideoId();
      if (session && session.videoId === id) return;
      startSession();
    }, 100);
  }
  window.addEventListener('yt-navigate-start', () => {
    clearTimeout(navTimer);
    stopSession();
  });
  window.addEventListener('yt-navigate-finish', onNavFinish);
  window.addEventListener('popstate', onNavFinish);

  // ---------- keyboard: Alt+Shift+Up/Down = dubbing voice volume +/-10% ----------
  function isTypingTarget(el) {
    if (!el || el.nodeType !== 1) return false;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
  }
  window.addEventListener(
    'keydown',
    (ev) => {
      if (!alive() || !ev.altKey || !ev.shiftKey || ev.ctrlKey || ev.metaKey) return;
      if (ev.key !== 'ArrowUp' && ev.key !== 'ArrowDown') return;
      const t = ev.composedPath && ev.composedPath()[0];
      if (isTypingTarget(ev.target) || isTypingTarget(t) || isTypingTarget(document.activeElement)) return;
      ev.preventDefault();
      ev.stopPropagation();
      const v = S.stepVolume(settings.dubVolume, ev.key === 'ArrowUp' ? 0.1 : -0.1);
      settings = Object.assign({}, settings, { dubVolume: v });
      D.configure(settings);
      S.set({ dubVolume: v }); // popup slider follows via storage.onChanged
      O.status('SubDub: giọng lồng tiếng ' + Math.round(v * 100) + '%', 1500);
    },
    true
  );

  // ---------- popup queries ----------
  try {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg || msg.type !== 'yvdState') return false;
      const info = session && session.localInfo;
      sendResponse({
        ok: true,
        videoId: session ? session.videoId : null,
        srcLang: session ? session.srcLang : null,
        provider: session ? session.provider : settings.provider,
        local: info ? { where: info.where, availability: info.availability } : null,
        counts: session && session.router ? session.router.counts() : null
      });
      return false;
    });
  } catch (e) {}

  // ---------- settings ----------
  S.onChanged((ns, changed) => {
    const old = settings;
    settings = ns;
    if (!siteOn(ns)) {
      stopSession();
      applyActiveClass(false);
      return;
    }
    if (!siteOn(old) || changed.includes('provider') || (ns.provider === 'claude' && changed.includes('concise'))) {
      startSession();
      return;
    }
    O.applySettings(ns);
    D.configure(ns);
    refreshDubActive();
    lastIdx = -2;
    if (!wantsDub()) D.cancel();
    tick();
  });

  S.get().then((s) => {
    settings = s;
    O.applySettings(s);
    startSession();
  });
})();
