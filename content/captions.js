/* Caption parsing, segment merging, segment lookup, track selection. Pure functions are exported for Node tests. */
(function (root) {
  'use strict';
  const YVD = (root.YVD = root.YVD || {});

  function decodeEntities(s) {
    const once = function (t) {
      return t
        .replace(/&#x([0-9a-f]+);/gi, function (m, h) {
          return String.fromCodePoint(parseInt(h, 16));
        })
        .replace(/&#(\d+);/g, function (m, d) {
          return String.fromCodePoint(parseInt(d, 10));
        })
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&');
    };
    // YouTube XML is frequently double-encoded (&amp;#39;)
    return once(once(s));
  }

  function cleanText(s) {
    return String(s).replace(/\s+/g, ' ').trim();
  }

  // json3: { events: [{ tStartMs, dDurationMs, segs: [{utf8}] }] } -> [{start,end,text}] (seconds)
  function parseJson3(input) {
    let data = input;
    if (typeof input === 'string') {
      try {
        data = JSON.parse(input);
      } catch (e) {
        return [];
      }
    }
    const evs = data && Array.isArray(data.events) ? data.events : [];
    const out = [];
    for (let i = 0; i < evs.length; i++) {
      const e = evs[i];
      if (!e || !Array.isArray(e.segs)) continue;
      const text = cleanText(
        e.segs
          .map(function (s) {
            return s && s.utf8 ? s.utf8 : '';
          })
          .join('')
      );
      if (!text) continue;
      const start = (e.tStartMs || 0) / 1000;
      let dur = e.dDurationMs != null ? e.dDurationMs / 1000 : 0;
      if (!(dur > 0)) dur = 2;
      out.push({ start: start, end: start + dur, text: text });
    }
    return out;
  }

  // XML: <text start="1.2" dur="3">..</text>  or format3 <p t="1200" d="3000"><s>..</s></p>
  function parseXml(xml) {
    const out = [];
    let m;
    const reText = /<text\b([^>]*)>([\s\S]*?)<\/text>/g;
    while ((m = reText.exec(xml))) {
      const st = /\bstart="([\d.]+)"/.exec(m[1]);
      if (!st) continue;
      const du = /\bdur="([\d.]+)"/.exec(m[1]);
      const text = cleanText(decodeEntities(m[2].replace(/<[^>]+>/g, '')));
      if (!text) continue;
      const start = parseFloat(st[1]);
      const dur = du ? parseFloat(du[1]) : 2;
      out.push({ start: start, end: start + (dur > 0 ? dur : 2), text: text });
    }
    if (out.length) return out;
    const reP = /<p\b([^>]*)>([\s\S]*?)<\/p>/g;
    while ((m = reP.exec(xml))) {
      const t = /\bt="(\d+)"/.exec(m[1]);
      if (!t) continue;
      const d = /\bd="(\d+)"/.exec(m[1]);
      const text = cleanText(decodeEntities(m[2].replace(/<[^>]+>/g, '')));
      if (!text) continue;
      const start = parseInt(t[1], 10) / 1000;
      const dur = d ? parseInt(d[1], 10) / 1000 : 2;
      out.push({ start: start, end: start + (dur > 0 ? dur : 2), text: text });
    }
    return out;
  }

  // Auto-detect json3 vs XML.
  function parseCaptions(body) {
    if (!body) return [];
    const s = String(body).trim();
    if (!s) return [];
    if (s[0] === '{') return parseJson3(s);
    if (s[0] === '<') return parseXml(s);
    return [];
  }

  const SENTENCE_END = /[.?!…。？！]["'”’)\]]*$/;

  function mergeEvents(events, opts) {
    const o = Object.assign({ maxGap: 1.2, maxDur: 7, maxChars: 180 }, opts || {});
    const segs = [];
    let cur = null;
    let prevText = null;
    const push = function () {
      if (cur) segs.push(cur);
      cur = null;
      prevText = null;
    };
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      if (cur && e.start - cur.end > o.maxGap) push();
      if (!cur) {
        cur = { start: e.start, end: e.end, text: e.text };
        prevText = e.text;
      } else if (e.text === prevText) {
        cur.end = Math.max(cur.end, e.end); // exact duplicate (rolling captions)
      } else if (prevText && e.text.indexOf(prevText) === 0) {
        // new event extends the previous one: replace instead of appending
        cur.text = cur.text.slice(0, cur.text.length - prevText.length) + e.text;
        cur.end = Math.max(cur.end, e.end);
        prevText = e.text;
      } else {
        cur.text += ' ' + e.text;
        cur.end = Math.max(cur.end, e.end);
        prevText = e.text;
      }
      if (SENTENCE_END.test(cur.text) || cur.end - cur.start > o.maxDur || cur.text.length > o.maxChars) push();
    }
    push();
    // trim overlaps so segments are monotonic
    for (let i = 0; i < segs.length - 1; i++) {
      if (segs[i].end > segs[i + 1].start) segs[i].end = Math.max(segs[i].start + 0.3, segs[i + 1].start);
    }
    return segs;
  }

  // Index of the segment containing time t, or -1. Segments sorted by start.
  function findSegmentIndex(segs, t) {
    let lo = 0;
    let hi = segs.length - 1;
    let idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (segs[mid].start <= t) {
        idx = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    if (idx >= 0 && t < segs[idx].end) return idx;
    return -1;
  }

  // Prefer en manual > en asr > other manual > first.
  function chooseTrack(tracks) {
    if (!tracks || !tracks.length) return null;
    const isAsr = function (t) {
      return t.kind === 'asr';
    };
    const isEn = function (t) {
      return /^en/i.test(t.languageCode || '');
    };
    return (
      tracks.find(function (t) {
        return isEn(t) && !isAsr(t);
      }) ||
      tracks.find(function (t) {
        return isEn(t) && isAsr(t);
      }) ||
      tracks.find(function (t) {
        return !isAsr(t);
      }) ||
      tracks[0]
    );
  }

  function withParam(url, key, value) {
    const u = new URL(url, 'https://www.youtube.com/');
    u.searchParams.set(key, value);
    return u.toString();
  }

  function getParam(url, key) {
    try {
      return new URL(url, 'https://www.youtube.com/').searchParams.get(key);
    } catch (e) {
      return null;
    }
  }

  YVD.captions = {
    decodeEntities: decodeEntities,
    parseJson3: parseJson3,
    parseXml: parseXml,
    parseCaptions: parseCaptions,
    mergeEvents: mergeEvents,
    findSegmentIndex: findSegmentIndex,
    chooseTrack: chooseTrack,
    withParam: withParam,
    getParam: getParam
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = YVD.captions;
})(typeof window !== 'undefined' ? window : globalThis);
