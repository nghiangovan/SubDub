/* Google Translate TTS helpers (pure, shared by offscreen.js, dubber and tests). */
(function (root) {
  'use strict';
  const YVD = (root.YVD = root.YVD || {});

  const MAX_CHARS = 200;
  const ENDPOINT = 'https://translate.google.com/translate_tts';

  function buildUrl(text, lang) {
    return ENDPOINT + '?ie=UTF-8&client=tw-ob&tl=' + encodeURIComponent(lang || 'vi') + '&q=' + encodeURIComponent(text);
  }

  // Split `text` into chunks <= max chars. Prefers sentence ends, then commas/semicolons/colons, then
  // spaces; never splits inside a word unless a single word is longer than max (hard cut).
  function chunkText(text, max) {
    max = max > 0 ? max : MAX_CHARS;
    let rem = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
    const out = [];
    const minPunct = Math.floor(max * 0.3);
    while (rem.length > max) {
      const win = rem.slice(0, max + 1);
      let cut = 0;
      const tries = [
        [/[.!?…]+["'”’)\]]*(?=\s)/g, 'end', minPunct],
        [/[,;:](?=\s)/g, 'end', minPunct],
        [/\s/g, 'start', 1]
      ];
      for (let i = 0; i < tries.length && !cut; i++) {
        const re = tries[i][0];
        let m;
        let best = 0;
        while ((m = re.exec(win))) {
          const c = tries[i][1] === 'end' ? m.index + m[0].length : m.index;
          if (c <= max && c >= tries[i][2]) best = c;
        }
        cut = best;
      }
      if (!cut) {
        cut = max; // a single word longer than max: hard cut (avoid splitting a surrogate pair)
        const code = rem.charCodeAt(cut - 1);
        if (code >= 0xd800 && code <= 0xdbff) cut--;
      }
      out.push(rem.slice(0, cut).trim());
      rem = rem.slice(cut).trim();
    }
    if (rem) out.push(rem);
    return out.filter(Boolean);
  }

  const api = { MAX_CHARS: MAX_CHARS, ENDPOINT: ENDPOINT, buildUrl: buildUrl, chunkText: chunkText };
  YVD.gtts = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
