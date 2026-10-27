/* Translation provider selection (pure; used by content.js and tests).
 *  - normalizeLang: caption-track languageCode ('en-US') -> Translator API language tag ('en')
 *  - resolveChain:  user setting + availability -> ordered list of providers to try
 *  - createRouter:  tracks failures/cooldowns so translation switches provider mid-way and never stops */
(function (root) {
  'use strict';
  const YVD = (root.YVD = root.YVD || {});

  const TARGET = 'vi';
  const ALIASES = {
    iw: 'he',
    in: 'id',
    ji: 'yi',
    jw: 'jv',
    nb: 'no',
    nn: 'no',
    fil: 'tl',
    'zh-cn': 'zh',
    'zh-sg': 'zh',
    'zh-hans': 'zh',
    'zh-tw': 'zh-Hant',
    'zh-hk': 'zh-Hant',
    'zh-mo': 'zh-Hant',
    'zh-hant': 'zh-Hant'
  };

  // 'en-US' -> 'en', 'pt_BR' -> 'pt', 'zh-TW' -> 'zh-Hant', 'iw' -> 'he'; null when not a usable language code.
  function normalizeLang(code) {
    const s = String(code == null ? '' : code).trim().replace(/_/g, '-').toLowerCase();
    if (!s) return null;
    if (ALIASES[s]) return ALIASES[s];
    const base = s.split('-')[0];
    if (!/^[a-z]{2,3}$/.test(base)) return null;
    return ALIASES[base] || base;
  }

  // Source language for the Translator API, or null when it cannot/should not be used (unknown, or already Vietnamese).
  function localSource(code) {
    const l = normalizeLang(code);
    return !l || l === TARGET ? null : l;
  }

  // Which providers to try, in order. `localOk`: Translator availability is 'available' for this language pair.
  //   auto   : google first, local (when installed) as backup
  //   local  : local first (google only when the pair is unsupported / not installed / failing)
  //   google : google first, local as backup when installed
  //   claude : claude (it falls back to google internally), local as backup
  function resolveChain(setting, localOk) {
    switch (setting) {
      case 'local':
        return localOk ? ['local', 'google'] : ['google'];
      case 'claude':
        return localOk ? ['claude', 'local'] : ['claude'];
      case 'auto':
      case 'google':
      case 'youtube': // YouTube translation is attempted separately; its fallback is google
      default:
        return localOk ? ['google', 'local'] : ['google'];
    }
  }

  // Failure tracking. After `threshold` consecutive failures a provider is "down" for `cooldown` ms (or forever
  // when permanent). pick() returns the first healthy provider in chain order; if all are down, the one that
  // recovers first (so the caller keeps trying instead of stopping).
  function createRouter(chain, opts) {
    const o = Object.assign({ threshold: 2, cooldown: 60000, now: Date.now }, opts || {});
    const list = chain.slice();
    const st = {};
    list.forEach(function (p) {
      st[p] = { fails: 0, downUntil: 0, count: 0 };
    });
    const isDown = function (p) {
      return st[p].downUntil > o.now();
    };
    return {
      chain: list,
      isDown: isDown,
      pick: function () {
        for (let i = 0; i < list.length; i++) if (!isDown(list[i])) return list[i];
        return list.reduce(function (a, b) {
          return st[b].downUntil < st[a].downUntil ? b : a;
        });
      },
      allDown: function () {
        return list.every(isDown);
      },
      // ms until some provider is usable again (0 when one is usable now)
      waitMs: function () {
        if (!this.allDown()) return 0;
        const soon = Math.min.apply(null, list.map(function (p) { return st[p].downUntil; }));
        return isFinite(soon) ? Math.max(0, soon - o.now()) : Infinity;
      },
      fail: function (p, permanent) {
        const s = st[p];
        if (!s) return false;
        s.fails++;
        if (permanent || s.fails >= o.threshold) {
          s.downUntil = permanent ? Infinity : o.now() + o.cooldown;
          s.fails = 0;
          return true; // just went down
        }
        return false;
      },
      ok: function (p, n) {
        if (!st[p]) return;
        st[p].fails = 0;
        st[p].count += n > 0 ? n : 1;
      },
      // provider that produced the most translated segments (for the cache key)
      dominant: function () {
        return list.reduce(function (a, b) {
          return st[b].count > st[a].count ? b : a;
        });
      },
      counts: function () {
        const r = {};
        list.forEach(function (p) {
          r[p] = st[p].count;
        });
        return r;
      }
    };
  }

  // Order in which cue indices are translated: the cue at/after the playback position first, then onwards,
  // then the earlier ones (so the part about to be watched is ready first).
  function progressiveOrder(cues, t) {
    const n = cues.length;
    let start = 0;
    for (let i = 0; i < n; i++) {
      if (cues[i].end >= t) {
        start = i;
        break;
      }
      start = i + 1;
    }
    if (start >= n) start = 0;
    const out = [];
    for (let i = 0; i < n; i++) out.push((start + i) % n);
    return out;
  }

  const api = {
    TARGET: TARGET,
    normalizeLang: normalizeLang,
    localSource: localSource,
    resolveChain: resolveChain,
    createRouter: createRouter,
    progressiveOrder: progressiveOrder
  };
  YVD.providers = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
