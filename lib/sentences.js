/* Sentence stabilisation for live captions (pure; used by content/meet.js and tests).
 *
 * Google Meet shows each speaker turn as one block of text that grows word by word, whose most recent words
 * are REWRITTEN as the recogniser changes its mind ("... problem. We." -> "... problem. Can we schedule ...?"),
 * and whose old text scrolls out of the FRONT. A tracker turns the successive full-text snapshots of ONE block
 * into FINAL sentences, each emitted exactly once:
 *
 *   - a sentence is final when it ends with . ? ! and enough text follows it that a rewrite can no longer
 *     reach it (>= lookaheadWords words after it), or when the block has not changed for idleMs (end of turn);
 *   - a sentence of fewer than minWords words (e.g. "We.") is merged into the next one instead of being
 *     emitted alone (unless the turn ended);
 *   - already-emitted sentences are recognised in later snapshots (also when they were trimmed at the front or
 *     lightly rewritten) and are never emitted again;
 *   - everything not final is the INTERIM tail.
 *
 * Time is injected (`now` in ms), so the logic is deterministic. */
(function (root) {
  'use strict';
  const YVD = (root.YVD = root.YVD || {});

  const ABBREV = /^(mr|mrs|ms|dr|prof|sr|jr|vs|etc|e\.g|i\.e|inc|ltd|approx)$/i;

  // 'Hello,  World!' -> 'hello world' (letters, digits and apostrophes only)
  function norm(s) {
    return String(s == null ? '' : s)
      .toLowerCase()
      .replace(/[’‘]/g, "'")
      .replace(/[^\p{L}\p{N}\s']/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function words(s) {
    const n = norm(s);
    return n ? n.split(' ') : [];
  }

  function wordCount(s) {
    return words(s).length;
  }

  // Split a caption text into sentences: [{ text, done }]. `done` = ends with . ? ! … (the last piece may be an
  // unterminated tail). Abbreviations ("Dr.", "e.g.") and decimals ("3.5") do not end a sentence.
  function splitSentences(text) {
    const s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
    const out = [];
    if (!s) return out;
    const re = /[.?!…]+["'”’)\]]*(?=\s|$)/g;
    let from = 0;
    let m;
    while ((m = re.exec(s))) {
      const end = m.index + m[0].length;
      const piece = s.slice(from, end).trim();
      const lastWord = piece.replace(/[.?!…"'”’)\]]+$/, '').split(' ').pop();
      if (m[0] === '.' && end < s.length && ABBREV.test(lastWord)) continue; // "Dr. Smith"
      if (piece) out.push({ text: piece, done: true });
      from = end;
    }
    const rest = s.slice(from).trim();
    if (rest) out.push({ text: rest, done: false });
    return out;
  }

  // Longest common subsequence length of two word arrays.
  function lcs(a, b) {
    let prev = new Array(b.length + 1).fill(0);
    for (let i = 1; i <= a.length; i++) {
      const cur = [0];
      for (let j = 1; j <= b.length; j++) cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
      prev = cur;
    }
    return prev[b.length];
  }

  // Same sentence (normalised), allowing a light rewrite (>= 80% of the words of the longer one in common).
  function sameSentence(na, nb) {
    if (na === nb) return true;
    if (!na || !nb) return false;
    const a = na.split(' ');
    const b = nb.split(' ');
    if (Math.min(a.length, b.length) < 4) return false;
    return lcs(a, b) / Math.max(a.length, b.length) >= 0.8;
  }

  // Comparison form: contractions expanded ("my name's nolan" -> "my name is nolan"), so Meet rewriting one
  // spelling into the other does not look like a new sentence.
  function canon(n) {
    return n
      .replace(/\b(\w+)'s\b/g, '$1 is')
      .replace(/\b(\w+)n't\b/g, '$1 not')
      .replace(/\b(\w+)'re\b/g, '$1 are')
      .replace(/\b(\w+)'m\b/g, '$1 am')
      .replace(/\b(\w+)'ll\b/g, '$1 will')
      .replace(/\b(\w+)'ve\b/g, '$1 have')
      .replace(/\b(\w+)'d\b/g, '$1 would');
  }

  // Same words after expanding contractions ("my name's nolan" == "my name is nolan").
  function eqSentence(na, nb) {
    return !!na && !!nb && (na === nb || canon(na) === canon(nb));
  }

  const NEG = /\b(not|no|never|nothing|nobody|none|cannot)\b/;
  // eqSentence, or a light rewrite (sameSentence) that does not add or drop a negation
  // ("I think we can" vs "I don't think we can" are different sentences).
  function likeSentence(na, nb) {
    if (eqSentence(na, nb)) return true;
    if (!sameSentence(na, nb)) return false;
    return NEG.test(canon(na)) === NEG.test(canon(nb));
  }

  // `frag` is a strict word-boundary suffix of `full` (text scrolled out of the front of a sentence).
  function isSuffixFragment(frag, full) {
    return frag.length > 0 && frag.length < full.length && full.endsWith(' ' + frag);
  }

  const RECENT = 8; // how far back the rewrite fallbacks look (emitted sentences)
  const DEFAULTS = { idleMs: 1500, tailIdleMs: 3000, minWords: 2, lookaheadWords: 2, tailMinWords: 3, keep: 40 };

  function createTracker(options) {
    const o = Object.assign({}, DEFAULTS, options || {});
    let emitted = []; // normalised sentences already emitted, oldest first (bounded)
    let known = []; // recently seen sentence texts (to restore a sentence trimmed at the front)
    let lastText = '';
    let lastChange = 0;

    function remember(list) {
      list.forEach(function (s) {
        const n = norm(s.text);
        if (!n) return;
        for (let i = 0; i < known.length; i++) if (norm(known[i]) === n) return;
        known.push(s.text);
      });
      while (known.length > o.keep * 2) known.shift();
    }

    // Index of the first sentence of `sents` that has not been emitted yet. Exact matches (after expanding
    // contractions) win over light rewrites, so a NEW sentence that resembles the last one ("Can you hear me
    // now?" after "Can you hear me?") is not mistaken for it.
    function alignStart(sents) {
      if (!emitted.length) return 0;
      const n = sents.length;
      const norms = sents.map(function (s) {
        return norm(s.text);
      });
      const passes = [eqSentence, likeSentence];
      for (let p = 0; p < passes.length; p++) {
        const same = passes[p];
        for (let back = 0; back < Math.min(3, emitted.length); back++) {
          const e = emitted[emitted.length - 1 - back];
          const prevE = emitted[emitted.length - 2 - back];
          for (let j = n - 1; j >= 0; j--) {
            if (!same(norms[j], e) && !(j === 0 && isSuffixFragment(norms[j], e))) continue;
            if (back === 0 && prevE !== undefined && j > 0 && !likeSentence(norms[j - 1], prevE)) continue; // sequence check
            return j + 1;
          }
        }
      }
      // Meet rewrote all of the most recent ones (short ones like "De." / "Really?" often change): continue
      // after the right-most sentence equal to one emitted a little earlier, rather than re-reading the turn
      for (let j = n - 1; j >= 0; j--) {
        for (let k = emitted.length - 1; k >= Math.max(0, emitted.length - RECENT); k--) if (eqSentence(norms[j], emitted[k])) return j + 1;
      }
      return 0; // nothing recognised (everything scrolled away, or a different block): all are new
    }

    // A finished sentence equal to one emitted shortly before (Meet re-showing it after a rewrite)
    function emittedBefore(n) {
      for (let k = emitted.length - 1; k >= Math.max(0, emitted.length - RECENT); k--) if (eqSentence(n, emitted[k])) return true;
      return false;
    }

    function evaluate(now) {
      const idleFor = now - lastChange;
      const idleSent = idleFor >= o.idleMs;
      const idleTail = idleFor >= o.tailIdleMs;
      const sents = splitSentences(lastText);
      // text scrolled out of the front can leave a fragment of a sentence we saw in full: restore it
      if (sents.length) {
        const f = norm(sents[0].text);
        for (let i = known.length - 1; i >= 0; i--) {
          if (isSuffixFragment(f, norm(known[i]))) {
            sents[0].text = known[i];
            break;
          }
        }
      }
      remember(sents);
      const start = alignStart(sents);
      const cand = sents.slice(start);
      const finals = [];
      let i = 0;
      while (i < cand.length) {
        // a finished sentence that is a (rewritten) copy of one already emitted in this turn: skip it
        const ni = norm(cand[i].text);
        if (cand[i].done && wordCount(cand[i].text) >= o.minWords && emittedBefore(ni)) {
          emitted.push(ni); // keeps the sequence check of the next pass aligned
          i++;
          continue;
        }
        let text = cand[i].text;
        let done = cand[i].done;
        let j = i;
        const parts = [cand[i]];
        // merge too-short sentences ("We.") into the next one
        while (wordCount(text) < o.minWords && j + 1 < cand.length) {
          j++;
          parts.push(cand[j]);
          text += ' ' + cand[j].text;
          done = cand[j].done;
        }
        let ok;
        if (done) {
          const after = cand.slice(j + 1).reduce(function (n, s) {
            return n + wordCount(s.text);
          }, 0);
          ok = after >= o.lookaheadWords || idleSent;
          if (ok && wordCount(text) < o.minWords && !idleSent) ok = false; // a lone short sentence waits for more
        } else {
          ok = idleTail && wordCount(text) >= o.tailMinWords; // unpunctuated end of a turn
        }
        if (!ok) break;
        finals.push({ text: text });
        parts.forEach(function (p) {
          emitted.push(norm(p.text));
        });
        i = j + 1;
      }
      while (emitted.length > o.keep) emitted.shift();
      const interim = cand
        .slice(i)
        .map(function (s) {
          return s.text;
        })
        .join(' ');
      return { finals: finals, interim: interim };
    }

    return {
      // New full-text snapshot of the block -> { finals: [{text}], interim: string }
      update: function (text, now) {
        text = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
        if (text !== lastText) {
          lastText = text;
          lastChange = now;
        }
        return evaluate(now);
      },
      // Call periodically without a new snapshot: flushes the end of a turn after idleMs.
      tick: function (now) {
        return evaluate(now);
      },
      reset: function () {
        emitted = [];
        known = [];
        lastText = '';
        lastChange = 0;
      },
      get text() {
        return lastText;
      }
    };
  }

  const api = { norm: norm, wordCount: wordCount, splitSentences: splitSentences, sameSentence: sameSentence, likeSentence: likeSentence, eqSentence: eqSentence, createTracker: createTracker, DEFAULTS: DEFAULTS };
  YVD.sentences = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
