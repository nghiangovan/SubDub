/* Settings helper: defaults + chrome.storage.sync get/set/onChanged. Classic script, shares window.YVD. */
(function (root) {
  'use strict';
  const YVD = (root.YVD = root.YVD || {});

  const DEFAULTS = {
    enabled: true,
    mode: 'both', // 'subtitle' | 'dub' | 'both'
    showOriginal: true,
    provider: 'auto', // 'auto' (google, local as backup) | 'local' | 'google' | 'youtube' | 'claude'
    claudeModel: 'claude-haiku-4-5',
    fontSize: 22,
    subBgOpacity: 0.75, // YouTube subtitle background opacity (0 = transparent, 1 = solid black)
    ttsEngine: 'auto', // 'auto' (system vi voice, else google, offline piper as backup) | 'google' | 'piper' | 'system'
    ttsVoice: '',
    ttsRate: 1.1,
    duckLevel: 0.15,
    dubVolume: 1, // loudness of the dubbing voice (0-1), independent of duckLevel
    ttsMaxRate: 2.0,
    dubMaxSpeed: 2.0,
    concise: true, // concise Vietnamese within a char budget (claude provider only)
    // per-site switches (the master `enabled` switch turns everything off)
    siteYoutube: true,
    siteMeet: true,
    // Google Meet
    meetShowOriginal: true, // original English line (top, full size) above the Vietnamese one
    meetSkipSelf: true, // do not dub the local user's own lines ("You" / "Bạn")
    meetAutoCC: true // press Meet's CC button once when joining a call
  };
  const MODES = ['subtitle', 'dub', 'both'];
  const PROVIDERS = ['auto', 'local', 'google', 'youtube', 'claude'];
  const ENGINES = ['auto', 'google', 'piper', 'system'];

  function num(v, def, min, max) {
    const n = typeof v === 'number' ? v : parseFloat(v);
    if (!isFinite(n)) return def;
    return Math.min(max, Math.max(min, n));
  }

  // Pure: dubbing volume after a +/- step (default 0.1), clamped to 0-1 and rounded to 2 decimals (no float drift).
  // Pure: the best Vietnamese speechSynthesis voice. Order: the user's pick > Microsoft "Natural" voices
  // (HoaiMy/NamMinh, only exposed by Microsoft Edge, free, need network) > Google > other online > local.
  function bestVoice(list, wanted) {
    const vi = (list || []).filter(function (v) { return /^vi/i.test(v.lang || ''); });
    if (!vi.length) return null;
    if (wanted) {
      const m = vi.find(function (v) { return v.voiceURI === wanted || v.name === wanted; });
      if (m) return m;
    }
    const score = function (v) {
      const n = v.name || '';
      return /natural/i.test(n) ? 3 : /google/i.test(n) ? 2 : v.localService === false || /online/i.test(n) ? 1 : 0;
    };
    return vi.reduce(function (a, v) { return score(v) > score(a) ? v : a; });
  }
  function isNaturalVoice(v) {
    return !!v && /natural/i.test(v.name || '');
  }

  function stepVolume(current, delta) {
    const cur = num(current, DEFAULTS.dubVolume, 0, 1);
    const d = typeof delta === 'number' && isFinite(delta) ? delta : 0.1;
    return Math.round(Math.min(1, Math.max(0, cur + d)) * 100) / 100;
  }

  function normalize(raw) {
    const r = Object.assign({}, DEFAULTS, raw || {});
    return {
      enabled: !!r.enabled,
      mode: MODES.indexOf(r.mode) >= 0 ? r.mode : DEFAULTS.mode,
      showOriginal: !!r.showOriginal,
      provider: PROVIDERS.indexOf(r.provider) >= 0 ? r.provider : DEFAULTS.provider,
      claudeModel: String(r.claudeModel || DEFAULTS.claudeModel),
      fontSize: num(r.fontSize, DEFAULTS.fontSize, 12, 64),
      subBgOpacity: num(r.subBgOpacity, DEFAULTS.subBgOpacity, 0, 1),
      ttsEngine: ENGINES.indexOf(r.ttsEngine) >= 0 ? r.ttsEngine : DEFAULTS.ttsEngine,
      ttsVoice: String(r.ttsVoice || ''),
      ttsRate: num(r.ttsRate, DEFAULTS.ttsRate, 0.5, 2),
      duckLevel: num(r.duckLevel, DEFAULTS.duckLevel, 0, 1),
      dubVolume: num(r.dubVolume, DEFAULTS.dubVolume, 0, 1),
      ttsMaxRate: num(r.ttsMaxRate, DEFAULTS.ttsMaxRate, 1, 3),
      dubMaxSpeed: num(r.dubMaxSpeed, DEFAULTS.dubMaxSpeed, 1, 4),
      concise: r.concise === undefined ? DEFAULTS.concise : !!r.concise,
      siteYoutube: r.siteYoutube === undefined ? DEFAULTS.siteYoutube : !!r.siteYoutube,
      siteMeet: r.siteMeet === undefined ? DEFAULTS.siteMeet : !!r.siteMeet,
      meetShowOriginal: r.meetShowOriginal === undefined ? DEFAULTS.meetShowOriginal : !!r.meetShowOriginal,
      meetSkipSelf: r.meetSkipSelf === undefined ? DEFAULTS.meetSkipSelf : !!r.meetSkipSelf,
      meetAutoCC: r.meetAutoCC === undefined ? DEFAULTS.meetAutoCC : !!r.meetAutoCC
    };
  }

  // False when the extension was reloaded/removed and this script is orphaned.
  function alive() {
    try {
      return !!(root.chrome && root.chrome.runtime && root.chrome.runtime.id);
    } catch (e) {
      return false;
    }
  }

  function get() {
    return new Promise(function (resolve) {
      if (!alive()) return resolve(normalize({}));
      try {
        root.chrome.storage.sync.get(null, function (items) {
          void root.chrome.runtime.lastError;
          resolve(normalize(items));
        });
      } catch (e) {
        resolve(normalize({}));
      }
    });
  }

  function set(patch) {
    return new Promise(function (resolve) {
      if (!alive()) return resolve();
      try {
        root.chrome.storage.sync.set(patch, function () {
          void root.chrome.runtime.lastError;
          resolve();
        });
      } catch (e) {
        resolve();
      }
    });
  }

  // cb(newSettings, changedKeys)
  function onChanged(cb) {
    if (!alive()) return;
    root.chrome.storage.onChanged.addListener(function (changes, area) {
      if (area !== 'sync' || !alive()) return;
      const keys = Object.keys(changes).filter(function (k) {
        return k in DEFAULTS;
      });
      if (!keys.length) return;
      get().then(function (s) {
        cb(s, keys);
      });
    });
  }

  // API key lives in storage.local only (never sync, never logged).
  function getApiKey() {
    return new Promise(function (resolve) {
      if (!alive()) return resolve('');
      try {
        root.chrome.storage.local.get('claudeApiKey', function (o) {
          void root.chrome.runtime.lastError;
          resolve((o && o.claudeApiKey) || '');
        });
      } catch (e) {
        resolve('');
      }
    });
  }

  function setApiKey(key) {
    return new Promise(function (resolve) {
      if (!alive()) return resolve();
      try {
        root.chrome.storage.local.set({ claudeApiKey: String(key || '').trim() }, function () {
          void root.chrome.runtime.lastError;
          resolve();
        });
      } catch (e) {
        resolve();
      }
    });
  }

  YVD.settings = { DEFAULTS: DEFAULTS, normalize: normalize, stepVolume: stepVolume, bestVoice: bestVoice, isNaturalVoice: isNaturalVoice, alive: alive, get: get, set: set, onChanged: onChanged, getApiKey: getApiKey, setApiKey: setApiKey };
  if (typeof module !== 'undefined' && module.exports) module.exports = YVD.settings;
})(typeof window !== 'undefined' ? window : globalThis);
