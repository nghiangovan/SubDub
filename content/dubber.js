/* Vietnamese dubbing: speechSynthesis (system vi voice), Google Translate TTS, offline Piper or the optional local
 * VieNeu program (all three play in the offscreen document, via background); chrome.tts only as last resort.
 * Plus original-audio ducking. */
(function (root) {
  'use strict';
  const YVD = (root.YVD = root.YVD || {});

  const clamp = function (v, lo, hi) {
    return Math.min(hi, Math.max(lo, v));
  };

  const DEFAULT_SPC = 0.065; // seconds per char at rate 1 (seed before calibration)
  const MAX_LATE = 1.0; // wall seconds an utterance may lag before it is dropped

  // Estimated seconds to speak `text` at TTS rate `rate`.
  function estSeconds(text, spc, rate) {
    return (String(text || '').length * (spc > 0 ? spc : DEFAULT_SPC)) / (rate > 0 ? rate : 1);
  }

  // TTS rate needed to fit `text` in a segment of `segDur` video-seconds played at `playbackRate`.
  function requiredRate(text, segDur, playbackRate, spc) {
    const pr = playbackRate > 0 ? playbackRate : 1;
    const avail = segDur / pr; // wall time available
    if (!(avail > 0)) return Infinity;
    return estSeconds(text, spc, 1) / avail;
  }

  // Final TTS rate: never below the user's base rate, never above maxRate.
  function calcRate(text, segDur, baseRate, playbackRate, spc, maxRate) {
    const base = baseRate > 0 ? baseRate : 1;
    const max = Math.max(maxRate > 0 ? maxRate : 2.0, base);
    const need = requiredRate(text, segDur, playbackRate, spc);
    return clamp(Math.max(base, isFinite(need) ? need : max), 0.5, Math.min(max, 4));
  }

  // Decide what to say for `cue`. If it cannot fit even at maxRate and the next cue follows within
  // 0.3s, merge the next cue only when that lowers the required rate. Otherwise speak at maxRate.
  // `now` (video time, optional): the budget runs from max(cue.start, now), so a line that starts late (pending cue,
  // restart after ratechange, late translation, landing mid-cue) is planned for the time that is really left; when
  // less than MIN_REMAIN wall seconds remain the line is skipped ({ skip: true }).
  const MIN_REMAIN = 0.3;
  function planSpeech(o) {
    const cue = o.cue;
    const base = o.baseRate > 0 ? o.baseRate : 1;
    const max = Math.max(o.maxRate > 0 ? o.maxRate : 2.0, base);
    const pr = o.playbackRate > 0 ? o.playbackRate : 1;
    const from = o.now != null && isFinite(o.now) ? Math.max(cue.start, o.now) : cue.start;
    if (from > cue.start && (cue.end - from) / pr < MIN_REMAIN) {
      return { skip: true, text: cue.vi, end: cue.end, merged: false, need: Infinity, overflow: true, rate: clamp(base, 0.5, Math.min(max, 4)) };
    }
    const need = requiredRate(cue.vi, cue.end - from, o.playbackRate, o.spc);
    let plan = { text: cue.vi, end: cue.end, merged: false, need: need, overflow: need > max };
    const nx = o.nextCue;
    if (need > max && nx && nx.vi && nx.start - cue.end <= 0.3) {
      const text = cue.vi + ' ' + nx.vi;
      const mNeed = requiredRate(text, nx.end - from, o.playbackRate, o.spc);
      if (mNeed < need) plan = { text: text, end: nx.end, merged: true, need: mNeed, overflow: mNeed > max };
    }
    plan.rate = clamp(Math.max(base, isFinite(plan.need) ? plan.need : max), 0.5, Math.min(max, 4));
    return plan;
  }

  // Is the current utterance so far behind (wall seconds) that it should be cancelled?
  function shouldCancelCurrent(videoTime, speakingEnd, playbackRate, threshold) {
    const pr = playbackRate > 0 ? playbackRate : 1;
    return (videoTime - speakingEnd) / pr > (threshold == null ? MAX_LATE : threshold);
  }

  // EMA of measured seconds-per-char (normalised to rate 1). Ignores unusable measurements.
  function updateSpc(prev, chars, elapsedWall, rate, alpha) {
    const p = prev > 0 ? prev : DEFAULT_SPC;
    if (chars < 8 || !(elapsedWall >= 0.3) || elapsedWall > 40 || !(rate > 0)) return p;
    const measured = clamp((elapsedWall * rate) / chars, 0.02, 0.2);
    const a = alpha > 0 ? alpha : 0.3;
    return p * (1 - a) + measured * a;
  }

  // Seconds of audio playback reported by the offscreen document; null when unusable (the line was paused/resumed
  // mid-way, so wall time includes the pause) and must not feed the seconds-per-char calibration.
  function playedSeconds(r) {
    if (!r || r.dirty || r.playSec == null) return null;
    return r.playSec > 0 ? r.playSec : null;
  }

  // Per-segment character budget for concise translation at a reference playback speed.
  function charBudget(start, end, speed, spc) {
    const avail = (end - start) / (speed > 0 ? speed : 1);
    return Math.max(12, Math.floor(avail / (spc > 0 ? spc : DEFAULT_SPC)));
  }

  // Dubbing is only attempted up to dubMaxSpeed.
  function dubAllowed(playbackRate, dubMaxSpeed) {
    return !(playbackRate > (dubMaxSpeed > 0 ? dubMaxSpeed : 2.0) + 1e-6);
  }

  // Which engine speaks: 'system' (speechSynthesis vi voice), 'google' (translate_tts), 'piper' (offline, offscreen),
  // 'vieneu' (optional local program, offscreen) or 'chrome' (chrome.tts, last resort).
  //   setting: 'auto' | 'google' | 'piper' | 'system' | 'vieneu'
  //   hasVi: a vi* speechSynthesis voice exists; googleDown: Google TTS failed within the cooldown;
  //   piperReady: the Piper voice is downloaded.
  // Any Google failure falls back to Piper at once (when downloaded) and stays on it for the cooldown.
  // natural: the system voice is a Microsoft "Natural" one (Edge), better than Google. A plain installed voice
  // (Windows "Microsoft An") sounds worse than Google, so in auto it is the instant offline fallback instead.
  // vieneuReady: the local program is ready and not in its failure cooldown. Only the explicit 'vieneu' setting
  // uses it ('auto' never does); when it is not ready the line goes to Google, then the usual fallback.
  function resolveEngine(setting, hasVi, googleDown, piperReady, natural, vieneuReady) {
    const offline = piperReady ? 'piper' : 'chrome';
    const fallback = hasVi ? 'system' : offline;
    if (setting === 'vieneu' && vieneuReady) return 'vieneu';
    if (setting === 'system') return hasVi ? 'system' : offline;
    if (setting === 'piper') return piperReady ? 'piper' : googleDown ? 'chrome' : 'google'; // not downloaded yet: Google meanwhile
    if (setting === 'google') return googleDown ? fallback : 'google';
    if (hasVi && natural) return 'system'; // auto
    return googleDown ? fallback : 'google';
  }

  const GOOGLE_COOLDOWN = 60000; // after a Google TTS failure, stay on the fallback this long (ms)
  const VIENEU_COOLDOWN = 60000; // same for the local VieNeu program
  const googleIsDown = function (until, now) {
    return (now == null ? Date.now() : now) < until;
  };
  const cooldownEnd = function (now, ms) {
    return (now == null ? Date.now() : now) + (ms > 0 ? ms : GOOGLE_COOLDOWN);
  };

  // ---- live mode (Google Meet): no video, no timeline. Lines arrive as people speak; freshness wins. ----
  const LIVE_MAX_WAITING = 2; // at most this many lines wait behind the one being spoken (oldest dropped first)
  const LIVE_MAX_AGE = 15000; // a waiting line older than this (ms) is stale and skipped

  // Queue after adding a line: drops stale lines, then the oldest beyond maxWaiting. Items: { text, t }.
  // -> { queue, dropped }
  function trimLiveQueue(queue, maxWaiting, now, maxAge) {
    const max = maxWaiting >= 0 ? maxWaiting : LIVE_MAX_WAITING;
    const age = maxAge > 0 ? maxAge : LIVE_MAX_AGE;
    const t = now == null ? Date.now() : now;
    const dropped = [];
    let q = [];
    queue.forEach(function (it) {
      if (t - it.t > age) dropped.push(it);
      else q.push(it);
    });
    while (q.length > max) dropped.push(q.shift());
    return { queue: q, dropped: dropped };
  }

  // TTS rate for a live line: the user's base rate, raised 25% per waiting line to catch up, capped at maxRate.
  function liveRate(baseRate, waiting, maxRate) {
    const base = baseRate > 0 ? baseRate : 1;
    const max = Math.max(maxRate > 0 ? maxRate : 2.0, base);
    return clamp(base * (1 + 0.25 * (waiting > 0 ? waiting : 0)), 0.5, Math.min(max, 4));
  }

  const api = {
    trimLiveQueue: trimLiveQueue,
    liveRate: liveRate,
    LIVE_MAX_WAITING: LIVE_MAX_WAITING,
    LIVE_MAX_AGE: LIVE_MAX_AGE,
    resolveEngine: resolveEngine,
    googleIsDown: googleIsDown,
    cooldownEnd: cooldownEnd,
    GOOGLE_COOLDOWN: GOOGLE_COOLDOWN,
    VIENEU_COOLDOWN: VIENEU_COOLDOWN,
    DEFAULT_SPC: DEFAULT_SPC,
    estSeconds: estSeconds,
    requiredRate: requiredRate,
    calcRate: calcRate,
    planSpeech: planSpeech,
    shouldCancelCurrent: shouldCancelCurrent,
    updateSpc: updateSpc,
    playedSeconds: playedSeconds,
    charBudget: charBudget,
    dubAllowed: dubAllowed
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window === 'undefined' || !root.speechSynthesis) {
    YVD.dubber = api;
    return;
  }

  const synth = root.speechSynthesis;
  let video = null;
  let cfg = { ttsEngine: 'auto', ttsVoice: '', vieneuVoice: 'Trúc Ly', ttsRate: 1.1, duckLevel: 0.15, ttsMaxRate: 2.0, dubVolume: 1 };
  const spcByVoice = {};
  let voiceKey = 'default';
  let active = false;
  let voices = [];
  let usingFallback = false;
  let usingOffscreen = false; // current utterance plays in the offscreen document (google, piper or vieneu)
  let googleDownUntil = 0; // after a Google TTS failure, use piper (or chrome.tts) until this time
  let announcedGoogle = false;
  let vieneuState = ''; // storage.local 'vieneuState' (background): 'ready' | 'loading' | 'not-installed' | ... | ''
  let vieneuDownUntil = 0; // after a VieNeu line failed, use Google (then the fallback) until this time
  let announcedVieneu = false;
  let hintedVieneu = false; // the "install VieNeu" hint is appended to a Google-blocked status once per page
  let lastVieneuCheck = 0;
  let piperReady = false; // the offline voice is downloaded (storage.local 'piperReady' + background status)
  let piperAutoTried = false;
  let duckSuppressed = false; // engine produced no audio: keep the original volume
  const prefetched = [];
  let onStatus = function () {};

  let curId = 0; // token for the current utterance
  let speaking = false;
  let speakingCue = null;
  let pending = null; // single slot: only the newest waiting cue, never a queue
  let lastCue = null;
  let keepAlive = null;
  let liveMode = false; // lines come from speakLive() (Google Meet) instead of speakCue()
  let liveQueue = [];

  // ducking state
  let baseVolume = null;
  let lastSetVolume = null;

  function loadVoices() {
    voices = synth.getVoices().filter(function (v) {
      return /^vi/i.test(v.lang || '');
    });
  }
  loadVoices();
  if (synth.addEventListener) synth.addEventListener('voiceschanged', loadVoices);

  // An online system voice (Edge "Natural") that failed to start is skipped for a while, so Google/Piper take over.
  let onlineVoiceDownUntil = 0;
  const ONLINE_VOICE_COOLDOWN = 60000;
  function pickVoice() {
    if (!voices.length) loadVoices();
    const list = Date.now() < onlineVoiceDownUntil ? voices.filter(function (v) { return v.localService !== false; }) : voices;
    return YVD.settings.bestVoice(list, cfg.ttsVoice);
  }

  function sendBg(msg) {
    return new Promise(function (res) {
      if (!YVD.settings || !YVD.settings.alive()) return res(null);
      try {
        root.chrome.runtime.sendMessage(msg, function (r) {
          void root.chrome.runtime.lastError;
          res(r || null);
        });
      } catch (e) {
        res(null);
      }
    });
  }

  // storage.local 'vieneuState' is kept up to date by background; read it once when dubbing starts (then onChanged).
  function loadVieneuState() {
    try {
      if (!YVD.settings || !YVD.settings.alive()) return;
      root.chrome.storage.local.get('vieneuState', function (o) {
        void root.chrome.runtime.lastError;
        vieneuState = (o && o.vieneuState) || '';
        if (cfg.ttsEngine === 'vieneu') refreshVieneu(true);
      });
    } catch (e) {}
  }

  let piperWarmed = false;
  function refreshPiperReady() {
    sendBg({ type: 'piper', op: 'status' }).then(function (r) {
      if (!r) return;
      piperReady = !!r.ready;
      if (piperReady) warmPiper();
    });
  }
  // Load the Piper session ahead of time so the switch from Google is instant (skipped when a system voice speaks).
  function warmPiper() {
    if (!active || !piperReady || piperWarmed || cfg.ttsEngine === 'system') return;
    if (cfg.ttsEngine === 'auto' && pickVoice()) return;
    piperWarmed = true;
    sendBg({ type: 'piper', op: 'warm' });
  }
  try {
    if (YVD.settings && YVD.settings.alive()) {
      root.chrome.storage.onChanged.addListener(function (ch, area) {
        if (area !== 'local') return;
        if (ch.vieneuState) {
          vieneuState = ch.vieneuState.newValue || '';
          if (vieneuState === 'ready') announcedVieneu = false; // (a failure cooldown still has to run out)
        }
        if (!ch.piperReady) return;
        piperReady = !!ch.piperReady.newValue;
        if (piperReady) warmPiper();
      });
    }
  } catch (e) {}

  function getSpc() {
    return spcByVoice[voiceKey] || DEFAULT_SPC;
  }

  // ---- VieNeu (optional local program, reached through background's native-messaging bridge) ----
  // 'idle' is fine: the program is installed and loads the model on the first line (or on the 'warm' request).
  // 'loading' / 'low-memory' / 'too-slow' / not installed / error: Google speaks meanwhile.
  const vieneuOk = function () {
    return (vieneuState === 'ready' || vieneuState === 'idle') && !googleIsDown(vieneuDownUntil);
  };
  // The engine for the next line (one place for every call site).
  function pickEngine(voice) {
    return resolveEngine(cfg.ttsEngine, !!voice, googleIsDown(googleDownUntil), piperReady, YVD.settings.isNaturalVoice(voice), vieneuOk());
  }
  function engineKey(engine, voice) {
    return engine === 'system' ? voice.name : engine === 'vieneu' ? 'vieneu:' + cfg.vieneuVoice : engine === 'google' ? 'google' : engine === 'piper' ? 'piper' : 'fallback';
  }
  // Learn the current state (and wake the connection so the model is loaded before the first line). Throttled;
  // a "not installed"/"error" state is re-checked from scratch, so installing while a video plays is noticed.
  function refreshVieneu(force) {
    const now = Date.now();
    const weak = vieneuState === 'low-memory' || vieneuState === 'too-slow'; // (a fresh program re-evaluates it: not too often)
    if (!force && now - lastVieneuCheck < (weak ? 60000 : 15000)) return;
    lastVieneuCheck = now;
    const recheck = vieneuState === 'not-installed' || vieneuState === 'error' || weak;
    sendBg({ type: 'vieneu', op: recheck ? 'recheck' : 'status' }).then(function (r) {
      if (r && r.state) vieneuState = r.state;
    });
  }
  // Ask the program to load the model: dubbing is really happening (a line is about to be spoken). Throttled; it
  // doubles as the keep-alive while a video plays. Never done from a mere status check.
  let lastWarm = 0;
  function warmVieneu() {
    if (cfg.ttsEngine !== 'vieneu' || !active) return;
    const now = Date.now();
    if (now - lastWarm < 45000 || !(vieneuState === 'idle' || vieneuState === 'ready' || vieneuState === '')) return;
    lastWarm = now;
    sendBg({ type: 'vieneu', op: 'warm' }).then(function (r) {
      if (r && r.state) vieneuState = r.state;
    });
  }
  // The explicit VieNeu setting could not use VieNeu for this line: say so once and keep checking in the background.
  function noteVieneuFallback() {
    if (cfg.ttsEngine !== 'vieneu') return;
    if (vieneuState === 'loading') return; // the model is starting: Google covers the first lines without a status pill
    refreshVieneu(false);
    if (announcedVieneu) return;
    announcedVieneu = true;
    const other = googleIsDown(googleDownUntil) ? 'giọng dự phòng' : 'Google';
    if (vieneuState === 'low-memory') onStatus('SubDub: máy đang thiếu RAM, tạm dùng ' + other);
    else if (vieneuState === 'too-slow') onStatus('SubDub: máy hơi yếu cho VieNeu, tạm dùng ' + other);
    else onStatus('SubDub: giọng VieNeu chưa sẵn sàng, tạm dùng ' + other);
  }
  // r: the failed reply; the program says why when the machine is the problem (low-memory / too-slow)
  function vieneuFailed(r) {
    vieneuDownUntil = cooldownEnd(Date.now(), VIENEU_COOLDOWN);
    if (r && (r.error === 'low-memory' || r.error === 'too-slow')) vieneuState = r.error;
    else refreshVieneu(true); // find out why (crashed? stopped?) so the popup state is right
    noteVieneuFallback();
  }
  // One-off hint appended to the "Google blocked" status for people who have not set VieNeu up.
  function vieneuHint() {
    if (hintedVieneu || cfg.ttsEngine === 'vieneu') return '';
    hintedVieneu = true;
    return vieneuState === 'ready' ? ' · chọn giọng VieNeu trong popup để không bị chặn' : ' · cài giọng VieNeu để không bị chặn';
  }

  // Live mode only: nothing but finish(id) clears `speaking`, so a lost end event (speechSynthesis onend never fires)
  // would silence the rest of the call. The watchdog ends a line that overran its estimated duration (x2 + 5 s).
  let watchdog = null;
  let curUtter = null; // keep a reference: an utterance that is garbage-collected mid-speech never fires onend
  function clearWatchdog() {
    clearTimeout(watchdog);
    watchdog = null;
  }
  function armWatchdog(id, plan) {
    clearWatchdog();
    const ms = (estSeconds(plan.text, getSpc(), plan.rate) * 2 + 5) * 1000;
    watchdog = setTimeout(function () {
      watchdog = null;
      if (id !== curId || !speaking) return;
      try {
        synth.cancel();
      } catch (e) {}
      if (usingFallback) sendBg({ type: 'ttsStop' });
      if (usingOffscreen) sendBg({ type: 'gtts', op: 'cancel' });
      finish(id);
    }, ms);
  }

  function finish(id) {
    if (id !== curId) return;
    clearWatchdog();
    curUtter = null;
    speaking = false;
    speakingCue = null;
    if (liveMode) return liveNext();
    const p = pending;
    pending = null;
    if (p && video && p.cue.end > video.currentTime && !video.paused) startUtterance(p.cue, p.next);
  }

  function speakCue(cue, nextCue, nextCue2) {
    if (!active || !cue || !cue.vi) return;
    warmVieneu();
    speakCueInner(cue, nextCue);
    prefetchAhead([nextCue, nextCue2]);
  }

  // Warm the offscreen cache with the upcoming cues' audio (Google fetch, Piper or VieNeu synthesis).
  function prefetchAhead(cues) {
    const voice = pickVoice();
    const engine = pickEngine(voice);
    if (engine !== 'google' && engine !== 'piper' && engine !== 'vieneu') return;
    const texts = [];
    cues.forEach(function (c) {
      const key = engine + '|' + (engine === 'vieneu' ? cfg.vieneuVoice + '|' : '') + (c && c.vi);
      if (!c || !c.vi || prefetched.indexOf(key) >= 0) return;
      prefetched.push(key);
      texts.push(c.vi);
    });
    while (prefetched.length > 40) prefetched.shift();
    if (!texts.length) return;
    if (engine === 'piper') sendBg({ type: 'piper', op: 'prefetch', texts: texts });
    else if (engine === 'vieneu') sendBg({ type: 'gtts', op: 'prefetch', texts: texts, engine: 'vieneu', voice: cfg.vieneuVoice });
    else sendBg({ type: 'gtts', op: 'prefetch', texts: texts, engine: 'google' });
  }

  function speakCueInner(cue, nextCue) {
    if (lastCue === cue) return;
    if (speaking) {
      if (shouldCancelCurrent(video ? video.currentTime : 0, speakingCue.end, video ? video.playbackRate : 1)) {
        cancel(true);
      } else {
        pending = { cue: cue, next: nextCue }; // replaces any older pending cue
        lastCue = cue;
        return;
      }
    }
    lastCue = cue;
    startUtterance(cue, nextCue);
  }

  function startUtterance(cue, nextCue) {
    const id = ++curId;
    const voice = pickVoice();
    const engine = pickEngine(voice);
    if (engine !== 'vieneu') noteVieneuFallback();
    voiceKey = engineKey(engine, voice);
    const plan = planSpeech({
      cue: cue,
      nextCue: nextCue,
      baseRate: cfg.ttsRate,
      maxRate: cfg.ttsMaxRate,
      playbackRate: video ? video.playbackRate : 1,
      now: video ? video.currentTime : undefined,
      spc: getSpc()
    });
    if (plan.skip) return; // started so late that (almost) nothing of the cue is left
    if (plan.merged) lastCue = nextCue; // the next cue is already covered by this utterance
    speaking = true;
    speakingCue = { start: cue.start, end: plan.end };
    usingOffscreen = engine === 'google' || engine === 'piper' || engine === 'vieneu';
    dispatch(engine, voice, plan, id);
  }

  // Speak plan.text with the chosen engine; calls finish(id) when done (shared by video cues and live lines).
  function dispatch(engine, voice, plan, id) {
    if (engine === 'system') {
      usingFallback = false;
      const u = new SpeechSynthesisUtterance(plan.text);
      curUtter = u;
      u.voice = voice;
      u.lang = voice.lang;
      u.rate = plan.rate;
      u.volume = cfg.dubVolume;
      let t0 = 0;
      u.onstart = function () {
        t0 = performance.now();
        if (id === curId) setSuppressed(false);
      };
      u.onend = function () {
        if (id === curId && t0) {
          spcByVoice[voiceKey] = updateSpc(getSpc(), plan.text.length, (performance.now() - t0) / 1000, plan.rate);
        }
        finish(id);
      };
      u.onerror = function (ev) {
        const why = ev && ev.error;
        if (id === curId && !t0 && why !== 'canceled' && why !== 'interrupted') {
          setSuppressed(true); // never spoke
          if (voice && voice.localService === false) {
            onlineVoiceDownUntil = Date.now() + ONLINE_VOICE_COOLDOWN;
            onStatus('SubDub: giọng ' + voice.name + ' lỗi (mạng?), tạm dùng giọng khác');
          }
        }
        finish(id);
      };
      synth.speak(u);
    } else if (engine === 'google') {
      usingFallback = false;
      setSuppressed(false); // (re)duck optimistically; undone on failure
      if (cfg.ttsEngine === 'auto' && !announcedGoogle) {
        announcedGoogle = true;
        onStatus('SubDub: dùng giọng Google Translate (tiếng Việt)');
      }
      if (cfg.ttsEngine === 'piper' && !piperReady) maybeAutoDownload();
      sendBg({ type: 'gtts', op: 'speak', engine: 'google', text: plan.text, rate: plan.rate, volume: cfg.dubVolume }).then(function (r) {
        if (id !== curId) {
          if (r && r.ok === false && !r.cancelled) googleFailed(r); // a real failure that beat the cancel: do not lose it
          return; // cancelled/superseded
        }
        if (!r || !r.ok) {
          googleFailed(r);
          // instant switch for this very line, no silence gap: installed system voice, else Piper, else chrome.tts
          if (voice) {
            voiceKey = voice.name;
            usingOffscreen = false;
            dispatch('system', voice, plan, id);
          } else if (piperReady) speakPiper(plan, id);
          else speakChrome(plan, id);
          return;
        }
        if (!r.cancelled) {
          const el = playedSeconds(r);
          if (el > 0) spcByVoice.google = updateSpc(spcByVoice.google || DEFAULT_SPC, plan.text.length, el, plan.rate);
        }
        finish(id);
      });
    } else if (engine === 'vieneu') {
      speakVieneu(voice, plan, id);
    } else if (engine === 'piper') {
      speakPiper(plan, id);
    } else {
      speakChrome(plan, id);
    }
  }

  // Optional local voice (VieNeu, whole line in one request). A failed line goes at once to what would speak without
  // VieNeu (Google, else the system voice / Piper / chrome.tts), and VieNeu rests for the cooldown.
  function speakVieneu(voice, plan, id) {
    usingFallback = false;
    usingOffscreen = true;
    setSuppressed(false); // (re)duck optimistically; undone by the fallback if nothing can speak
    const key = voiceKey;
    sendBg({ type: 'gtts', op: 'speak', engine: 'vieneu', voice: cfg.vieneuVoice, text: plan.text, rate: plan.rate, volume: cfg.dubVolume }).then(function (r) {
      if (id !== curId) {
        if (r && r.ok === false && !r.cancelled) vieneuFailed(r); // a real failure that beat the cancel: do not lose it
        return;
      }
      if (!r || !r.ok) {
        vieneuFailed(r);
        const eng = pickEngine(voice); // VieNeu is in its cooldown now
        voiceKey = engineKey(eng, voice);
        usingOffscreen = eng === 'google' || eng === 'piper';
        dispatch(eng, voice, plan, id);
        return;
      }
      if (!r.cancelled) {
        const el = playedSeconds(r);
        if (el > 0) spcByVoice[key] = updateSpc(spcByVoice[key] || DEFAULT_SPC, plan.text.length, el, plan.rate);
      }
      finish(id);
    });
  }

  // Live line (Google Meet): queue it, speak when the previous one ends. Freshness first: stale lines and the
  // oldest ones beyond LIVE_MAX_WAITING are dropped; the rate rises while lines are waiting.
  function speakLive(text) {
    text = String(text == null ? '' : text).trim();
    if (!active || !text) return;
    liveMode = true;
    warmVieneu();
    liveQueue.push({ text: text, t: Date.now() });
    liveQueue = trimLiveQueue(liveQueue, LIVE_MAX_WAITING, Date.now(), LIVE_MAX_AGE).queue;
    if (!speaking) liveNext();
    else prefetchAhead([{ vi: text }]);
  }

  function liveNext() {
    liveQueue = trimLiveQueue(liveQueue, LIVE_MAX_WAITING, Date.now(), LIVE_MAX_AGE).queue;
    const item = liveQueue.shift();
    if (!item || !active) return;
    const id = ++curId;
    const voice = pickVoice();
    const engine = pickEngine(voice);
    if (engine !== 'vieneu') noteVieneuFallback();
    voiceKey = engineKey(engine, voice);
    const plan = { text: item.text, rate: liveRate(cfg.ttsRate, liveQueue.length, cfg.ttsMaxRate), end: 0, merged: false };
    speaking = true;
    speakingCue = { start: 0, end: 0 };
    usingOffscreen = engine === 'google' || engine === 'piper' || engine === 'vieneu';
    dispatch(engine, voice, plan, id);
    armWatchdog(id, plan);
  }

  // Offline voice (Piper in the offscreen document). Falls back to chrome.tts only when it cannot speak.
  function speakPiper(plan, id) {
    usingFallback = false;
    usingOffscreen = true;
    setSuppressed(false); // piper is producing audio: stay ducked, no un-duck needed
    sendBg({ type: 'piper', op: 'speak', text: plan.text, rate: plan.rate, volume: cfg.dubVolume }).then(function (r) {
      if (id !== curId) return;
      if (!r || !r.ok) {
        if (r && r.error === 'piper-not-ready') piperReady = false;
        speakChrome(plan, id);
        return;
      }
      if (!r.cancelled) {
        const el = playedSeconds(r);
        if (el > 0) spcByVoice.piper = updateSpc(spcByVoice.piper || DEFAULT_SPC, plan.text.length, el, plan.rate);
      }
      finish(id);
    });
  }

  // Explicit 'piper' engine but the voice is not there yet: fetch it once (Google speaks in the meantime).
  function maybeAutoDownload() {
    if (piperAutoTried) return;
    piperAutoTried = true;
    onStatus('SubDub: đang tải giọng offline (63MB, 1 lần), trong lúc đó dùng Google');
    sendBg({ type: 'piper', op: 'download' });
    let polls = 0;
    const timer = setInterval(function () {
      // background.status records readiness in storage.local (picked up by the onChanged listener)
      if (piperReady || ++polls > 200) return clearInterval(timer);
      sendBg({ type: 'piper', op: 'status' }).then(function (r) {
        if (r && r.state === 'error') clearInterval(timer);
      });
    }, 3000);
  }

  // r.retryAt: when the offscreen breaker lets Google requests through again (1/5/15 min ladder)
  function googleFailed(r) {
    const wasDown = googleIsDown(googleDownUntil);
    googleDownUntil = Math.max(cooldownEnd(Date.now(), GOOGLE_COOLDOWN), (r && r.retryAt) || 0);
    if (wasDown) return; // already on the fallback: no repeated status pill
    const sysVoice = pickVoice();
    if (sysVoice) {
      onStatus('SubDub: Google tạm chặn, đang dùng giọng ' + sysVoice.name.replace(/^Microsoft\s+/i, '').replace(/\s+-.*$/, '') + ' của máy' + vieneuHint()); // no un-duck
      return;
    }
    if (piperReady) {
      onStatus('SubDub: Google tạm chặn, đang dùng giọng offline' + vieneuHint()); // piper takes over: no un-duck
      return;
    }
    setSuppressed(true);
    if (liveMode) {
      onStatus('SubDub: Google TTS lỗi (mạng hoặc bị giới hạn). Mở popup, bấm "Tải giọng offline" để nghe liên tục');
      return;
    }
    onStatus('SubDub: Google TTS lỗi (mạng hoặc bị giới hạn), đã trả lại âm lượng video gốc. Mở popup, bấm "Tải giọng offline" để nghe liên tục');
  }

  // Last resort. Reliability is unknown (may be silent), so never keep the original video ducked for it.
  function speakChrome(plan, id) {
    usingOffscreen = false;
    setSuppressed(true);
    if (!usingFallback) {
      usingFallback = true;
      if (!googleIsDown(googleDownUntil)) onStatus('SubDub: không có giọng tiếng Việt, dùng chrome.tts (chọn Google Translate trong popup)');
    }
    sendBg({ type: 'tts', text: plan.text, rate: plan.rate, volume: cfg.dubVolume }).then(function () {
      finish(id);
    });
  }

  function cancel(keepLast) {
    curId++;
    clearWatchdog();
    curUtter = null;
    speaking = false;
    speakingCue = null;
    pending = null;
    liveQueue = [];
    if (!keepLast) lastCue = null;
    try {
      synth.cancel();
    } catch (e) {}
    prefetched.length = 0; // the offscreen document drops queued Piper jobs on cancel
    if (usingFallback) sendBg({ type: 'ttsStop' });
    if (usingOffscreen) sendBg({ type: 'gtts', op: 'cancel' });
  }

  function pause() {
    try {
      synth.pause();
    } catch (e) {}
    if (usingOffscreen && speaking) sendBg({ type: 'gtts', op: 'pause' });
  }
  function resume() {
    try {
      synth.resume();
    } catch (e) {}
    if (usingOffscreen && speaking) sendBg({ type: 'gtts', op: 'resume' });
  }

  // ---- ducking ----
  function setSuppressed(v) {
    v = !!v;
    if (v === duckSuppressed) return;
    duckSuppressed = v;
    if (v) unduck();
    else if (active) duck();
  }
  function duck() {
    if (!video || duckSuppressed) return;
    if (baseVolume == null) baseVolume = video.volume;
    lastSetVolume = clamp(baseVolume * cfg.duckLevel, 0, 1);
    video.volume = lastSetVolume;
  }
  function unduck() {
    if (video && baseVolume != null) video.volume = baseVolume;
    baseVolume = null;
    lastSetVolume = null;
  }
  function onVolumeChange() {
    if (!active || !video || baseVolume == null || lastSetVolume == null) return;
    if (Math.abs(video.volume - lastSetVolume) > 0.001) {
      // user changed volume manually: treat it as the new base
      const d = cfg.duckLevel > 0 ? cfg.duckLevel : 1;
      baseVolume = clamp(video.volume / d, 0, 1);
      duck();
    }
  }

  function attach(v) {
    if (video === v) return;
    if (video) {
      video.removeEventListener('volumechange', onVolumeChange);
      if (active) unduck();
    }
    video = v;
    if (video) {
      video.addEventListener('volumechange', onVolumeChange);
      if (active) duck();
    }
  }

  function setActive(on) {
    on = !!on;
    if (on === active) return;
    active = on;
    duckSuppressed = false; // (googleDownUntil is kept: the cooldown must survive consecutive videos)
    if (on) {
      piperWarmed = false;
      refreshPiperReady();
      loadVieneuState();
      duck();
      clearInterval(keepAlive);
      keepAlive = setInterval(function () {
        // Chrome stops long utterances after ~15s; nudge it.
        if (speaking && synth.speaking && (liveMode || (video && !video.paused))) {
          synth.pause();
          synth.resume();
        }
      }, 10000);
    } else {
      clearInterval(keepAlive);
      cancel();
      unduck();
    }
  }

  function configure(s, statusCb) {
    if (cfg.ttsEngine !== s.ttsEngine) {
      googleDownUntil = 0;
      vieneuDownUntil = 0;
      lastWarm = 0;
      announcedVieneu = false;
      announcedGoogle = false;
      duckSuppressed = false;
      piperWarmed = false;
      if (active) cancel(false);
    }
    const oldVol = cfg.dubVolume;
    const engChanged = cfg.ttsEngine !== s.ttsEngine;
    cfg = { ttsEngine: s.ttsEngine, ttsVoice: s.ttsVoice, vieneuVoice: s.vieneuVoice || 'Trúc Ly', ttsRate: s.ttsRate, duckLevel: s.duckLevel, ttsMaxRate: s.ttsMaxRate, dubVolume: s.dubVolume };
    // live: change the Google/Piper audio that is playing right now (speechSynthesis/chrome.tts apply from the next line)
    if (active && usingOffscreen && cfg.dubVolume !== oldVol) sendBg({ type: 'gtts', op: 'setVolume', volume: cfg.dubVolume });
    if (statusCb) onStatus = statusCb;
    if (active) {
      duck();
      warmPiper();
      if (engChanged && cfg.ttsEngine === 'vieneu') refreshVieneu(true);
    }
  }

  function isActive() {
    return active;
  }

  YVD.dubber = Object.assign(api, {
    attach: attach,
    setActive: setActive,
    configure: configure,
    speakCue: speakCue,
    speakLive: speakLive,
    getSpc: getSpc,
    cancel: function () {
      cancel(false);
    },
    resetLast: function () {
      lastCue = null;
    },
    pause: pause,
    resume: resume,
    isActive: isActive,
    hasVietVoice: function () {
      loadVoices();
      return voices.length > 0;
    }
  });
})(typeof window !== 'undefined' ? window : globalThis);
