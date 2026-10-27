// Plain Node tests: node tests/run.js
const assert = require('assert');
const path = require('path');
const C = require(path.join('..', 'content', 'captions.js'));
const T = require(path.join('..', 'lib', 'translators.js'));
const D = require(path.join('..', 'content', 'dubber.js'));
const S = require(path.join('..', 'lib', 'settings.js'));
const G = require(path.join('..', 'lib', 'gtts.js'));
const PV = require(path.join('..', 'lib', 'providers.js'));
const PT = require(path.join('..', 'lib', 'piper-text.js'));
const LT = require(path.join('..', 'lib', 'local-translate.js'));
const SEN = require(path.join('..', 'lib', 'sentences.js'));
const LTR = require(path.join('..', 'content', 'livetr.js'));
const fs = require('fs');

let passed = 0;
const pendingTests = [];
function test(name, fn) {
  const ok = () => {
    passed++;
    console.log('ok   - ' + name);
  };
  const bad = (e) => {
    console.error('FAIL - ' + name + '\n' + (e && e.stack));
    process.exitCode = 1;
  };
  try {
    const r = fn();
    if (r && typeof r.then === 'function') pendingTests.push(r.then(ok, bad)); // async test
    else ok();
  } catch (e) {
    bad(e);
  }
}

test('parseJson3 drops empty/newline events and converts to seconds', () => {
  const ev = C.parseJson3({
    events: [
      { tStartMs: 0, dDurationMs: 1000 },
      { tStartMs: 500, dDurationMs: 1500, segs: [{ utf8: 'Hello ' }, { utf8: 'world' }] },
      { tStartMs: 2000, dDurationMs: 100, segs: [{ utf8: '\n' }] },
      { tStartMs: 2500, segs: [{ utf8: 'No dur' }] }
    ]
  });
  assert.deepStrictEqual(ev[0], { start: 0.5, end: 2, text: 'Hello world' });
  assert.strictEqual(ev.length, 2);
  assert.strictEqual(ev[1].text, 'No dur');
  assert.deepStrictEqual(C.parseJson3('not json'), []);
});

test('parseXml supports <text> with entities and <p t d> format', () => {
  const x = '<transcript><text start="1.5" dur="2">It&amp;#39;s &quot;ok&quot;</text><text start="4" dur="1">  </text></transcript>';
  const ev = C.parseXml(x);
  assert.strictEqual(ev.length, 1);
  assert.strictEqual(ev[0].text, 'It\'s "ok"');
  assert.strictEqual(ev[0].start, 1.5);
  assert.strictEqual(ev[0].end, 3.5);
  const p = C.parseXml('<timedtext><body><p t="1000" d="2000"><s>Hi</s><s> there</s></p></body></timedtext>');
  assert.deepStrictEqual(p[0], { start: 1, end: 3, text: 'Hi there' });
  assert.strictEqual(C.parseCaptions('<text start="0" dur="1">a</text>').length, 1);
  assert.strictEqual(C.parseCaptions('{"events":[{"tStartMs":0,"dDurationMs":1,"segs":[{"utf8":"a"}]}]}').length, 1);
  assert.deepStrictEqual(C.parseCaptions(''), []);
});

test('mergeEvents ends at sentence end', () => {
  const m = C.mergeEvents([
    { start: 0, end: 1, text: 'Hello there' },
    { start: 1, end: 2, text: 'my friend.' },
    { start: 2, end: 3, text: 'Next one' },
    { start: 3, end: 4, text: 'here?' }
  ]);
  assert.strictEqual(m.length, 2);
  assert.strictEqual(m[0].text, 'Hello there my friend.');
  assert.deepStrictEqual([m[0].start, m[0].end], [0, 2]);
  assert.strictEqual(m[1].text, 'Next one here?');
});

test('mergeEvents splits on gap, duration and length', () => {
  const gap = C.mergeEvents([
    { start: 0, end: 1, text: 'a' },
    { start: 2.5, end: 3, text: 'b' }
  ]);
  assert.strictEqual(gap.length, 2);
  const long = [];
  for (let i = 0; i < 10; i++) long.push({ start: i, end: i + 1, text: 'w' + i });
  const dur = C.mergeEvents(long);
  assert.ok(dur.length >= 2);
  assert.ok(dur.every((s) => s.end - s.start <= 8));
  const chars = C.mergeEvents([
    { start: 0, end: 1, text: 'x'.repeat(100) },
    { start: 1, end: 2, text: 'y'.repeat(100) },
    { start: 2, end: 3, text: 'z' }
  ]);
  assert.strictEqual(chars.length, 2);
});

test('mergeEvents dedupes rolling captions and fixes overlaps', () => {
  const m = C.mergeEvents([
    { start: 0, end: 2, text: 'we are' },
    { start: 1, end: 3, text: 'we are going' },
    { start: 1.5, end: 3.5, text: 'we are going' },
    { start: 2, end: 4, text: 'home.' },
    { start: 3.5, end: 5, text: 'Again.' }
  ]);
  assert.strictEqual(m[0].text, 'we are going home.');
  assert.ok(m[0].end <= m[1].start);
});

test('findSegmentIndex binary search', () => {
  const segs = [
    { start: 1, end: 2 },
    { start: 3, end: 5 },
    { start: 5, end: 6 },
    { start: 8, end: 9 }
  ];
  assert.strictEqual(C.findSegmentIndex(segs, 0.5), -1);
  assert.strictEqual(C.findSegmentIndex(segs, 1), 0);
  assert.strictEqual(C.findSegmentIndex(segs, 2), -1);
  assert.strictEqual(C.findSegmentIndex(segs, 4.9), 1);
  assert.strictEqual(C.findSegmentIndex(segs, 5), 2);
  assert.strictEqual(C.findSegmentIndex(segs, 8.5), 3);
  assert.strictEqual(C.findSegmentIndex(segs, 100), -1);
  assert.strictEqual(C.findSegmentIndex([], 1), -1);
});

test('chooseTrack prefers en manual, then en asr', () => {
  const tr = [
    { languageCode: 'fr' },
    { languageCode: 'en', kind: 'asr' },
    { languageCode: 'en' }
  ];
  assert.strictEqual(C.chooseTrack(tr), tr[2]);
  assert.strictEqual(C.chooseTrack([tr[0], tr[1]]), tr[1]);
  assert.strictEqual(C.chooseTrack([]), null);
});

test('withParam / getParam', () => {
  const u = C.withParam('https://www.youtube.com/api/timedtext?v=abc&fmt=srv3', 'fmt', 'json3');
  assert.strictEqual(C.getParam(u, 'fmt'), 'json3');
  assert.strictEqual(C.getParam(u, 'v'), 'abc');
});

test('buildBatches respects max size and covers all texts', () => {
  const texts = [];
  for (let i = 0; i < 50; i++) texts.push('sentence number ' + i + ' ' + 'x'.repeat(80));
  const b = T.buildBatches(texts, 500);
  assert.ok(b.length > 1);
  assert.strictEqual(b[0].from, 0);
  assert.strictEqual(b[b.length - 1].to, 50);
  for (let i = 1; i < b.length; i++) assert.strictEqual(b[i].from, b[i - 1].to);
  b.forEach((x) => {
    assert.ok(x.q.length <= 500);
    assert.strictEqual(x.q.split('\n').length, x.to - x.from);
  });
  const nl = T.buildBatches(['a\nb', 'c'], 100);
  assert.strictEqual(nl[0].q, 'a b\nc');
  assert.deepStrictEqual(T.buildBatches([], 100), []);
});

test('google response parse + splitBatch', () => {
  const data = [[['Xin chào\n', 'Hello\n'], ['thế giới', 'world']], null, 'en'];
  const joined = T.parseGoogleResponse(data);
  assert.strictEqual(joined, 'Xin chào\nthế giới');
  assert.deepStrictEqual(T.splitBatch(joined, 2), ['Xin chào', 'thế giới']);
  assert.strictEqual(T.splitBatch(joined, 3), null);
  assert.deepStrictEqual(T.splitBatch('a\nb\n', 2), ['a', 'b']);
  assert.strictEqual(T.parseGoogleResponse(null), '');
});

test('parseClaudeArray validates length and type', () => {
  assert.deepStrictEqual(T.parseClaudeArray('Here: ["a"," b "]', 2), ['a', 'b']);
  assert.strictEqual(T.parseClaudeArray('["a"]', 2), null);
  assert.strictEqual(T.parseClaudeArray('[1,2]', 2), null);
  assert.strictEqual(T.parseClaudeArray('nope', 1), null);
});

const vi100 = 'x'.repeat(100); // 6.5s of speech at 1x with the seed 0.065 s/char
const near = (a, b) => Math.abs(a - b) < 1e-9;

test('requiredRate / calcRate at 1x, 1.5x, 1.75x, 2x', () => {
  // 100 chars in a 10s segment: 6.5s needed
  assert.ok(near(D.requiredRate(vi100, 10, 1, 0.065), 0.65));
  assert.ok(near(D.requiredRate(vi100, 10, 1.5, 0.065), 0.975));
  assert.ok(near(D.requiredRate(vi100, 10, 1.75, 0.065), 1.1375));
  assert.ok(near(D.requiredRate(vi100, 10, 2, 0.065), 1.3));
  // base rate is the floor
  assert.strictEqual(D.calcRate(vi100, 10, 1.1, 1, 0.065, 2), 1.1);
  assert.ok(near(D.calcRate(vi100, 10, 1.1, 2, 0.065, 2), 1.3));
  // 100 chars in 4s: 6.5s of speech -> needs 1.625x at 1x, 2.4375x at 1.5x (capped), etc.
  assert.ok(near(D.calcRate(vi100, 4, 1, 1, 0.065, 2), 1.625));
  assert.strictEqual(D.calcRate(vi100, 4, 1, 1.5, 0.065, 2), 2);
  assert.ok(near(D.calcRate(vi100, 4, 1, 1.5, 0.065, 3), 2.4375));
  assert.strictEqual(D.calcRate(vi100, 0, 1, 1, 0.065, 2), 2); // zero duration -> max
  assert.strictEqual(D.calcRate('', 4, 1, 1, 0.065, 2), 1);
});

test('planSpeech: fits without overflow at 1x, 1.5x, 1.75x', () => {
  const cue = { start: 0, end: 8, vi: vi100 }; // 6.5s speech
  const p1 = D.planSpeech({ cue, nextCue: null, baseRate: 1, maxRate: 2, playbackRate: 1, spc: 0.065 });
  assert.strictEqual(p1.overflow, false);
  assert.ok(near(p1.rate, 1));
  const p15 = D.planSpeech({ cue, nextCue: null, baseRate: 1, maxRate: 2, playbackRate: 1.5, spc: 0.065 });
  assert.strictEqual(p15.overflow, false); // need 1.2188
  assert.ok(near(p15.rate, 6.5 / (8 / 1.5)));
  const p175 = D.planSpeech({ cue, nextCue: null, baseRate: 1, maxRate: 2, playbackRate: 1.75, spc: 0.065 });
  assert.strictEqual(p175.overflow, false); // need 1.4219
  assert.ok(near(p175.rate, 6.5 / (8 / 1.75)));
  const p2 = D.planSpeech({ cue, nextCue: null, baseRate: 1, maxRate: 2, playbackRate: 2, spc: 0.065 });
  assert.ok(near(p2.rate, 1.625));
  assert.strictEqual(p2.overflow, false);
});

test('planSpeech: overflow -> max rate, merge only when it lowers the need', () => {
  // 100 chars in 3s at 2x: avail 1.5s, need 4.33 > max 2
  const cue = { start: 0, end: 3, vi: vi100 };
  const none = D.planSpeech({ cue, nextCue: null, baseRate: 1, maxRate: 2, playbackRate: 2, spc: 0.065 });
  assert.strictEqual(none.overflow, true);
  assert.strictEqual(none.rate, 2);
  assert.strictEqual(none.merged, false);
  // next cue adjacent, short text, long duration -> merge lowers need
  const next = { start: 3.1, end: 9, vi: 'xin chao' };
  const m = D.planSpeech({ cue, nextCue: next, baseRate: 1, maxRate: 2, playbackRate: 2, spc: 0.065 });
  assert.strictEqual(m.merged, true);
  assert.strictEqual(m.end, 9);
  assert.ok(m.need < none.need);
  assert.ok(m.text.endsWith('xin chao'));
  // next cue too far away -> no merge
  const far = D.planSpeech({ cue, nextCue: { start: 4, end: 9, vi: 'xin chao' }, baseRate: 1, maxRate: 2, playbackRate: 2, spc: 0.065 });
  assert.strictEqual(far.merged, false);
  // next cue adjacent but huge text -> merging would not lower the need
  const big = D.planSpeech({ cue, nextCue: { start: 3, end: 3.5, vi: 'y'.repeat(300) }, baseRate: 1, maxRate: 2, playbackRate: 2, spc: 0.065 });
  assert.strictEqual(big.merged, false);
  // no merge when there is no overflow
  const fit = D.planSpeech({ cue: { start: 0, end: 10, vi: vi100 }, nextCue: next, baseRate: 1, maxRate: 2, playbackRate: 1, spc: 0.065 });
  assert.strictEqual(fit.merged, false);
});

test('shouldCancelCurrent: >1.0s wall-time behind', () => {
  assert.strictEqual(D.shouldCancelCurrent(10.5, 10, 1), false);
  assert.strictEqual(D.shouldCancelCurrent(11.2, 10, 1), true);
  // at 2x, 1.5 video-seconds late is only 0.75 wall seconds
  assert.strictEqual(D.shouldCancelCurrent(11.5, 10, 2), false);
  assert.strictEqual(D.shouldCancelCurrent(12.5, 10, 1.75), true);
  assert.strictEqual(D.shouldCancelCurrent(9, 10, 1), false);
});

test('updateSpc calibrates with EMA and ignores junk', () => {
  // 100 chars spoken in 5s at rate 1.25 -> 0.0625 s/char at rate 1
  const v = D.updateSpc(0.065, 100, 5, 1.25, 0.5);
  assert.ok(near(v, 0.065 * 0.5 + (5 * 1.25 / 100) * 0.5));
  assert.strictEqual(D.updateSpc(0.065, 3, 5, 1), 0.065); // too short
  assert.strictEqual(D.updateSpc(0.065, 100, 0.1, 1), 0.065); // too quick to be real
  assert.strictEqual(D.updateSpc(undefined, 100, 0.1, 1), D.DEFAULT_SPC);
  let x = 0.065;
  for (let i = 0; i < 30; i++) x = D.updateSpc(x, 100, 4, 1); // true 0.04
  assert.ok(Math.abs(x - 0.04) < 0.001);
});

test('charBudget at 1.5x and dubAllowed', () => {
  // 6s segment at 1.5x -> 4s wall -> 4/0.065 = 61 chars
  assert.strictEqual(D.charBudget(0, 6, 1.5, 0.065), 61);
  assert.strictEqual(D.charBudget(0, 0.2, 1.5, 0.065), 12); // floor
  assert.strictEqual(D.dubAllowed(1, 2), true);
  assert.strictEqual(D.dubAllowed(1.75, 2), true);
  assert.strictEqual(D.dubAllowed(2, 2), true);
  assert.strictEqual(D.dubAllowed(2.25, 2), false);
});

test('settings.normalize clamps and defaults', () => {
  const n = S.normalize({ mode: 'bogus', fontSize: 999, duckLevel: -1, provider: 'claude' });
  assert.strictEqual(n.mode, 'both');
  assert.strictEqual(n.fontSize, 64);
  assert.strictEqual(n.duckLevel, 0);
  assert.strictEqual(n.provider, 'claude');
  assert.strictEqual(S.normalize().enabled, true);
  assert.strictEqual(S.normalize().ttsMaxRate, 2);
  assert.strictEqual(S.normalize().dubMaxSpeed, 2);
  assert.strictEqual(S.normalize().concise, true);
  assert.strictEqual(S.normalize({ ttsMaxRate: 9 }).ttsMaxRate, 3);
});

test('gtts.chunkText: short text is a single chunk', () => {
  assert.deepStrictEqual(G.chunkText('  Xin   chào  '), ['Xin chào']);
  assert.deepStrictEqual(G.chunkText(''), []);
});

test('gtts.chunkText: chunks <= 200, no word split, diacritics preserved', () => {
  const sent = 'Hôm nay chúng ta sẽ tìm hiểu về cách lồng tiếng tự động cho video trên YouTube, rất thú vị đấy';
  const long = (sent + '. ').repeat(12) + 'Đường dài ngựa chạy đến đâu, người ta đều ngưỡng mộ';
  const chunks = G.chunkText(long);
  assert.ok(chunks.length > 1);
  chunks.forEach((c) => assert.ok(c.length <= 200 && c.length > 0, 'len ' + c.length));
  assert.strictEqual(chunks.join(' '), long.replace(/\s+/g, ' ').trim());
  const words = new Set(long.split(/\s+/));
  chunks.join(' ').split(' ').forEach((w) => assert.ok(words.has(w), 'split word: ' + w));
  assert.ok(chunks[0].endsWith('.'), 'prefers sentence boundary');
});

test('gtts.chunkText: no punctuation falls back to spaces; comma preferred over space', () => {
  const noPunct = 'ăn quả nhớ kẻ trồng cây '.repeat(30).trim();
  const c1 = G.chunkText(noPunct);
  c1.forEach((c) => assert.ok(c.length <= 200));
  assert.strictEqual(c1.join(' '), noPunct);
  const withComma = 'a'.repeat(120) + ', ' + 'b'.repeat(100);
  const c2 = G.chunkText(withComma);
  assert.strictEqual(c2.length, 2);
  assert.ok(c2[0].endsWith(','));
});

test('gtts.chunkText: single overlong word is hard-cut at the limit', () => {
  const c = G.chunkText('x'.repeat(450));
  assert.deepStrictEqual(c.map((x) => x.length), [200, 200, 50]);
});

test('gtts.buildUrl encodes text and uses the tw-ob endpoint', () => {
  const u = G.buildUrl('Xin chào & bạn?');
  assert.ok(u.startsWith('https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=vi&q='));
  assert.strictEqual(decodeURIComponent(u.split('&q=')[1]), 'Xin chào & bạn?');
});

test('resolveEngine: auto / system / google selection and fallbacks (no piper)', () => {
  // auto: Google first; a plain installed voice (Windows "An") is the instant fallback when Google is down
  assert.strictEqual(D.resolveEngine('auto', true, false), 'google');
  assert.strictEqual(D.resolveEngine('auto', true, true), 'system');
  assert.strictEqual(D.resolveEngine('auto', false, false), 'google');
  assert.strictEqual(D.resolveEngine('auto', false, true), 'chrome');
  // a Natural (Edge) voice beats Google
  assert.strictEqual(D.resolveEngine('auto', true, false, false, true), 'system');
  assert.strictEqual(D.resolveEngine('system', true, false), 'system');
  assert.strictEqual(D.resolveEngine('system', false, false), 'chrome');
  assert.strictEqual(D.resolveEngine('google', true, false), 'google');
  assert.strictEqual(D.resolveEngine('google', true, true), 'system');
  assert.strictEqual(D.resolveEngine('google', false, true), 'chrome');
  assert.strictEqual(D.resolveEngine(undefined, false, false), 'google');
});

test('resolveEngine: piper takes over instantly when Google is down (and only then, unless chosen)', () => {
  // auto, no system voice: google normally, piper for the whole cooldown once Google failed
  assert.strictEqual(D.resolveEngine('auto', false, false, true), 'google');
  assert.strictEqual(D.resolveEngine('auto', false, true, true), 'piper');
  assert.strictEqual(D.resolveEngine('auto', true, true, true), 'system'); // installed voice before Piper
  assert.strictEqual(D.resolveEngine('google', false, true, true), 'piper');
  // piper not downloaded: chrome.tts as before
  assert.strictEqual(D.resolveEngine('auto', false, true, false), 'chrome');
  assert.strictEqual(D.resolveEngine('google', false, true, false), 'chrome');
  // a system voice always wins in auto
  assert.strictEqual(D.resolveEngine('auto', true, true, true), 'system');
  // explicit piper
  assert.strictEqual(D.resolveEngine('piper', false, false, true), 'piper');
  assert.strictEqual(D.resolveEngine('piper', true, false, true), 'piper');
  assert.strictEqual(D.resolveEngine('piper', false, false, false), 'google'); // not downloaded yet: Google meanwhile
  assert.strictEqual(D.resolveEngine('piper', false, true, false), 'chrome');
  // explicit system without a vi voice: offline voice if present
  assert.strictEqual(D.resolveEngine('system', false, false, true), 'piper');
  assert.strictEqual(D.resolveEngine('system', true, false, true), 'system');
});

test('Google cooldown: 60s on piper, then Google is retried', () => {
  assert.strictEqual(D.GOOGLE_COOLDOWN, 60000);
  const t0 = 1000000;
  const until = D.cooldownEnd(t0, D.GOOGLE_COOLDOWN);
  assert.strictEqual(until, t0 + 60000);
  const engineAt = (now) => D.resolveEngine('auto', false, D.googleIsDown(until, now), true);
  assert.strictEqual(engineAt(t0), 'piper');
  assert.strictEqual(engineAt(t0 + 59999), 'piper');
  assert.strictEqual(engineAt(t0 + 60000), 'google'); // cooldown over: retry Google
  assert.strictEqual(D.googleIsDown(0, t0), false);
});

test('settings.normalize ttsEngine', () => {
  assert.strictEqual(S.normalize({}).ttsEngine, 'auto');
  assert.strictEqual(S.normalize({ ttsEngine: 'google' }).ttsEngine, 'google');
  assert.strictEqual(S.normalize({ ttsEngine: 'piper' }).ttsEngine, 'piper');
  assert.strictEqual(S.normalize({ ttsEngine: 'system' }).ttsEngine, 'system');
  assert.strictEqual(S.normalize({ ttsEngine: 'nope' }).ttsEngine, 'auto');
});

test('settings.normalize provider: default auto, local accepted', () => {
  assert.strictEqual(S.normalize({}).provider, 'auto');
  ['auto', 'local', 'google', 'youtube', 'claude'].forEach((p) => assert.strictEqual(S.normalize({ provider: p }).provider, p));
  assert.strictEqual(S.normalize({ provider: 'bing' }).provider, 'auto');
});

test('settings.normalize dubVolume: default, clamp, garbage', () => {
  assert.strictEqual(S.normalize({}).dubVolume, 1);
  assert.strictEqual(S.normalize({ dubVolume: 0.7 }).dubVolume, 0.7);
  assert.strictEqual(S.normalize({ dubVolume: 0 }).dubVolume, 0);
  assert.strictEqual(S.normalize({ dubVolume: 5 }).dubVolume, 1);
  assert.strictEqual(S.normalize({ dubVolume: -2 }).dubVolume, 0);
  assert.strictEqual(S.normalize({ dubVolume: '0.4' }).dubVolume, 0.4);
  assert.strictEqual(S.normalize({ dubVolume: 'abc' }).dubVolume, 1);
  assert.strictEqual(S.normalize({ dubVolume: null }).dubVolume, 1);
  assert.strictEqual(S.normalize({ dubVolume: NaN }).dubVolume, 1);
  assert.strictEqual(S.normalize({ duckLevel: 0.3 }).dubVolume, 1); // independent of duckLevel
});

test('settings.bestVoice: Edge Natural voices win, user pick respected, non-Vietnamese ignored', () => {
  const an = { name: 'Microsoft An - Vietnamese (Vietnam)', lang: 'vi-VN', voiceURI: 'an', localService: true };
  const hm = { name: 'Microsoft HoaiMy Online (Natural) - Vietnamese (Vietnam)', lang: 'vi-VN', voiceURI: 'hm', localService: false };
  const nm = { name: 'Microsoft NamMinh Online (Natural) - Vietnamese (Vietnam)', lang: 'vi-VN', voiceURI: 'nm', localService: false };
  const en = { name: 'Microsoft Aria Online (Natural) - English (United States)', lang: 'en-US', voiceURI: 'aria', localService: false };
  assert.strictEqual(S.bestVoice([an, en, hm, nm], ''), hm);
  assert.strictEqual(S.bestVoice([an, hm, nm], 'nm'), nm);
  assert.strictEqual(S.bestVoice([an, hm], 'gone'), hm);
  assert.strictEqual(S.bestVoice([an, en], ''), an);
  assert.strictEqual(S.bestVoice([en], ''), null);
  assert.strictEqual(S.bestVoice([], ''), null);
  assert.ok(S.isNaturalVoice(hm) && !S.isNaturalVoice(an));
});

test('settings.stepVolume: +/-10% steps, clamped, no float drift', () => {
  assert.strictEqual(S.stepVolume(0.5, 0.1), 0.6);
  assert.strictEqual(S.stepVolume(0.7, -0.1), 0.6);
  assert.strictEqual(S.stepVolume(0.3, 0.1), 0.4); // 0.30000000000000004 pitfall
  assert.strictEqual(S.stepVolume(0.9, 0.1), 1);
  assert.strictEqual(S.stepVolume(1, 0.1), 1);
  assert.strictEqual(S.stepVolume(0.05, -0.1), 0);
  assert.strictEqual(S.stepVolume(0, -0.1), 0);
  assert.strictEqual(S.stepVolume(undefined, -0.1), 0.9); // default 1.0
  assert.strictEqual(S.stepVolume('abc', -0.1), 0.9);
  assert.strictEqual(S.stepVolume(7, -0.1), 0.9); // out-of-range input clamped first
  let v = 1;
  for (let i = 0; i < 10; i++) v = S.stepVolume(v, -0.1);
  assert.strictEqual(v, 0);
  for (let i = 0; i < 10; i++) v = S.stepVolume(v, 0.1);
  assert.strictEqual(v, 1);
});


// ---------- on-device translation: language mapping, provider resolution, failure switching ----------
test('normalizeLang maps caption track codes to Translator API tags', () => {
  assert.strictEqual(PV.normalizeLang('en-US'), 'en');
  assert.strictEqual(PV.normalizeLang('en'), 'en');
  assert.strictEqual(PV.normalizeLang('EN-gb'), 'en');
  assert.strictEqual(PV.normalizeLang('pt_BR'), 'pt');
  assert.strictEqual(PV.normalizeLang('ja'), 'ja');
  assert.strictEqual(PV.normalizeLang('zh-TW'), 'zh-Hant');
  assert.strictEqual(PV.normalizeLang('zh-Hant'), 'zh-Hant');
  assert.strictEqual(PV.normalizeLang('zh-CN'), 'zh');
  assert.strictEqual(PV.normalizeLang('zh-Hans'), 'zh');
  assert.strictEqual(PV.normalizeLang('iw'), 'he');
  assert.strictEqual(PV.normalizeLang('in'), 'id');
  assert.strictEqual(PV.normalizeLang('fil'), 'tl');
  assert.strictEqual(PV.normalizeLang(''), null);
  assert.strictEqual(PV.normalizeLang(null), null);
  assert.strictEqual(PV.normalizeLang('a.en'), null);
  assert.strictEqual(PV.normalizeLang('123'), null);
});

test('localSource: null for unknown or already-Vietnamese tracks', () => {
  assert.strictEqual(PV.localSource('en-US'), 'en');
  assert.strictEqual(PV.localSource('vi'), null);
  assert.strictEqual(PV.localSource('vi-VN'), null);
  assert.strictEqual(PV.localSource(''), null);
  assert.strictEqual(PV.localSource(undefined), null);
});

test('resolveChain: auto = google with local backup; local = local first; google/claude keep a local backup', () => {
  assert.deepStrictEqual(PV.resolveChain('auto', true), ['google', 'local']);
  assert.deepStrictEqual(PV.resolveChain('auto', false), ['google']);
  assert.deepStrictEqual(PV.resolveChain('local', true), ['local', 'google']);
  assert.deepStrictEqual(PV.resolveChain('local', false), ['google']); // unsupported / not installed pair -> google
  assert.deepStrictEqual(PV.resolveChain('google', true), ['google', 'local']);
  assert.deepStrictEqual(PV.resolveChain('google', false), ['google']);
  assert.deepStrictEqual(PV.resolveChain('claude', true), ['claude', 'local']);
  assert.deepStrictEqual(PV.resolveChain('claude', false), ['claude']);
  assert.deepStrictEqual(PV.resolveChain('youtube', true), ['google', 'local']);
  assert.deepStrictEqual(PV.resolveChain(undefined, false), ['google']);
});

test('router: google failure switches the remaining work to local, and back after the cooldown', () => {
  let now = 1000;
  const r = PV.createRouter(['google', 'local'], { threshold: 2, cooldown: 60000, now: () => now });
  assert.strictEqual(r.pick(), 'google');
  assert.strictEqual(r.fail('google'), false); // 1st failure: not yet
  assert.strictEqual(r.pick(), 'google');
  assert.strictEqual(r.fail('google'), true); // 2nd: parked
  assert.strictEqual(r.pick(), 'local');
  assert.strictEqual(r.isDown('google'), true);
  assert.strictEqual(r.allDown(), false);
  now += 59999;
  assert.strictEqual(r.pick(), 'local');
  now += 1;
  assert.strictEqual(r.pick(), 'google'); // cooldown over
});

test('router: local failure falls back to google (local-first order), success resets the failure count', () => {
  let now = 0;
  const r = PV.createRouter(PV.resolveChain('local', true), { threshold: 2, now: () => now });
  assert.strictEqual(r.pick(), 'local');
  r.fail('local');
  r.ok('local', 5); // a success in between resets the streak
  r.fail('local');
  assert.strictEqual(r.pick(), 'local');
  r.fail('local');
  assert.strictEqual(r.pick(), 'google');
  assert.deepStrictEqual(r.counts(), { local: 5, google: 0 });
  r.ok('google', 7);
  assert.strictEqual(r.dominant(), 'google');
});

test('router: permanent failure, all-down picks the soonest-recovering provider and reports the wait', () => {
  let now = 0;
  const r = PV.createRouter(['google', 'local'], { threshold: 1, cooldown: 1000, now: () => now });
  r.fail('local', true);
  assert.strictEqual(r.isDown('local'), true);
  now = 1e12;
  assert.strictEqual(r.isDown('local'), true); // never recovers
  assert.strictEqual(r.pick(), 'google');
  now = 5;
  const q = PV.createRouter(['google', 'local'], { threshold: 1, cooldown: 1000, now: () => now });
  q.fail('google');
  now = 105;
  q.fail('local');
  assert.strictEqual(q.allDown(), true);
  assert.strictEqual(q.pick(), 'google'); // google recovers first (at 1005)
  assert.strictEqual(q.waitMs(), 900);
  now = 1006;
  assert.strictEqual(q.waitMs(), 0);
  assert.strictEqual(q.allDown(), false);
  const only = PV.createRouter(['google'], { threshold: 1, now: () => 0 });
  only.fail('google', true);
  assert.strictEqual(only.pick(), 'google'); // nothing else to try: keep going, never throw
  assert.strictEqual(only.waitMs(), Infinity);
});

test('progressiveOrder: current position first, then onwards, then earlier cues', () => {
  const cues = [0, 1, 2, 3, 4].map((i) => ({ start: i * 10, end: i * 10 + 9 }));
  assert.deepStrictEqual(PV.progressiveOrder(cues, 0), [0, 1, 2, 3, 4]);
  assert.deepStrictEqual(PV.progressiveOrder(cues, 25), [2, 3, 4, 0, 1]);
  assert.deepStrictEqual(PV.progressiveOrder(cues, 35), [3, 4, 0, 1, 2]);
  assert.deepStrictEqual(PV.progressiveOrder(cues, 39.5), [4, 0, 1, 2, 3]); // cue 3 already ended
  assert.deepStrictEqual(PV.progressiveOrder(cues, 500), [0, 1, 2, 3, 4]); // past the end: from the start
  assert.deepStrictEqual(PV.progressiveOrder([], 3), []);
});

test('translators.missingIdx flags empty translations of non-empty sources', () => {
  assert.deepStrictEqual(T.missingIdx(['a', ' ', 'c'], ['x', '', '']), [2]);
  assert.deepStrictEqual(T.missingIdx(['a', 'b'], ['x', 'y']), []);
  assert.deepStrictEqual(T.missingIdx(['a', 'b'], ['', '']), [0, 1]);
});

test('local-translate engine: gated on availability, per-string, never caches failures', async () => {
  const calls = { create: 0, translate: 0 };
  let av = 'downloadable';
  const FakeT = {
    availability: async (o) => (o.sourceLanguage === 'xx' ? 'unavailable' : av),
    create: async () => {
      calls.create++;
      return { translate: async (t) => { calls.translate++; return 'vi:' + t; }, destroy() {} };
    }
  };
  const eng = LT.createEngine(() => FakeT);
  assert.deepStrictEqual(await eng.probe('en', 'vi'), { exposed: true, availability: 'downloadable' });
  await assert.rejects(eng.translate('en', 'vi', ['hi']), /not-available:downloadable/);
  assert.strictEqual(calls.create, 0); // never calls create() without the model (it would need a user gesture)
  av = 'available';
  assert.deepStrictEqual(await eng.translate('en', 'vi', ['hi', '  ', 'there']), ['vi:hi', '', 'vi:there']);
  await eng.translate('en', 'vi', ['again']);
  assert.strictEqual(calls.create, 1); // translator instance reused
  assert.strictEqual((await eng.probe('xx', 'vi')).availability, 'unavailable');
  const none = LT.createEngine(() => undefined);
  assert.deepStrictEqual(await none.probe('en', 'vi'), { exposed: false, availability: 'unsupported' });
  await assert.rejects(none.translate('en', 'vi', ['x']));
});

test('local-translate: downloadPair reports progress fractions and needs create()', async () => {
  const seen = [];
  const listeners = {};
  const FakeT = {
    availability: async () => 'available',
    create: async (o) => {
      o.monitor({ addEventListener: (n, f) => (listeners[n] = f) });
      listeners.downloadprogress({ loaded: 0.5, total: 1 });
      listeners.downloadprogress({ loaded: 50, total: 100 });
      return { translate: async () => 'x', destroy() {} };
    }
  };
  const av = await LT.downloadPair(FakeT, 'en', 'vi', (f) => seen.push(f));
  assert.strictEqual(av, 'available');
  assert.deepStrictEqual(seen, [0.5, 0.5]);
  await assert.rejects(LT.downloadPair(undefined, 'en', 'vi'));
  assert.deepStrictEqual(LT.splitLong('a'.repeat(10), 4), ['aaaa', 'aaaa', 'aa']);
});

// ---------- Piper TTS helpers ----------
test('piper constants point only at the rhasspy Hugging Face voice', () => {
  assert.ok(PT.MODEL_URL.startsWith('https://huggingface.co/rhasspy/piper-voices/resolve/main/vi/vi_VN/vais1000/medium/'));
  assert.ok(PT.MODEL_URL.endsWith('vi_VN-vais1000-medium.onnx'));
  assert.strictEqual(PT.CONFIG_URL, PT.MODEL_URL + '.json');
  assert.strictEqual(PT.MODEL_SHA256.length, 64);
  assert.strictEqual(PT.checkModel(PT.MODEL_BYTES, PT.MODEL_SHA256), '');
  assert.strictEqual(PT.checkModel(PT.MODEL_BYTES - 1, PT.MODEL_SHA256), 'size');
  assert.strictEqual(PT.checkModel(PT.MODEL_BYTES, 'ab'.repeat(32)), 'checksum');
});

test('piper normalizeText: symbols, numbers, cues, whitespace', () => {
  assert.strictEqual(PT.normalizeText('  Tăng   50%  '), 'Tăng 50 phần trăm');
  assert.strictEqual(PT.normalizeText('Giá $20 và 1,000,000 người'), 'Giá 20 đô la và 1000000 người');
  assert.strictEqual(PT.normalizeText('Anh & em'), 'Anh và em');
  assert.strictEqual(PT.normalizeText('[Âm nhạc] Xin chào ♪'), 'Xin chào');
  assert.strictEqual(PT.normalizeText('Xem https://example.com/x?y=1 nhé'), 'Xem nhé');
  assert.strictEqual(PT.normalizeText('“Chào” — bạn…'), 'Chào, bạn...');
  assert.strictEqual(PT.normalizeText('25°C'), '25 độ C');
  assert.strictEqual(PT.normalizeText(null), '');
  assert.strictEqual(PT.normalizeText('Vie\u0323\u0302t'), 'Vi\u1ec7t'); // NFC
});

test('piper toChunks: normalised, <= max, non-speakable chunks dropped', () => {
  assert.deepStrictEqual(PT.toChunks('Xin chào.'), ['Xin chào.']);
  assert.deepStrictEqual(PT.toChunks('...'), []);
  assert.deepStrictEqual(PT.toChunks('   '), []);
  const long = Array.from({ length: 30 }, (_, i) => 'Câu số ' + i + ' khá dài.').join(' ');
  const ch = PT.toChunks(long, 100);
  assert.ok(ch.length > 3);
  assert.ok(ch.every((c) => c.length <= 100));
  assert.strictEqual(ch.join(' ').replace(/\s+/g, ' '), long);
  assert.strictEqual(PT.isSpeakable('?!'), false);
  assert.strictEqual(PT.isSpeakable('a'), true);
  assert.strictEqual(PT.isSpeakable('2024'), true);
});

test('piper pcmToWav writes a valid 16-bit mono header and clamps samples', () => {
  const wav = PT.pcmToWav(new Float32Array([0, 0.5, -0.5, 1.5, -1.5]), 22050);
  const v = new DataView(wav);
  const tag = (o) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
  assert.strictEqual(wav.byteLength, 44 + 10);
  assert.strictEqual(tag(0), 'RIFF');
  assert.strictEqual(tag(8), 'WAVE');
  assert.strictEqual(tag(36), 'data');
  assert.strictEqual(v.getUint32(4, true), 36 + 10);
  assert.strictEqual(v.getUint16(22, true), 1);
  assert.strictEqual(v.getUint32(24, true), 22050);
  assert.strictEqual(v.getUint32(28, true), 44100);
  assert.strictEqual(v.getUint32(40, true), 10);
  assert.strictEqual(v.getInt16(46, true), 16384);
  assert.strictEqual(v.getInt16(50, true), 32767);
  assert.strictEqual(v.getInt16(52, true), -32768);
});

test('piper tail: fading end kept with a low tail threshold, silence padded, closing punctuation added', () => {
  const sr = 1000;
  const pcm = new Float32Array(1000);
  for (let i = 100; i < 600; i++) pcm[i] = 0.5; // loud part
  for (let i = 600; i < 800; i++) pcm[i] = 0.005; // quiet fade-out (below 0.01, above 0.002)
  const old = PT.trimSilence(pcm, sr, 0.01, 0.04);
  assert.strictEqual(old.length, 580); // start pad 40 + body 500 + end pad 40: the fade is lost
  const kept = PT.trimSilence(pcm, sr, 0.01, 0.04, 0.002, 0.12);
  assert.strictEqual(kept.length, 40 + 700 + 120); // the fade (200) survives, then 120 ms pad
  const padded = PT.padEnd(kept, sr, 0.15);
  assert.strictEqual(padded.length, kept.length + 150);
  assert.strictEqual(padded[padded.length - 1], 0);
  assert.strictEqual(padded[100], kept[100]);
  assert.strictEqual(PT.withEndPunct('Xin chào'), 'Xin chào.');
  assert.strictEqual(PT.withEndPunct('Xin chào?'), 'Xin chào?');
  assert.strictEqual(PT.withEndPunct('  '), '');
});

test('piper trimSilence keeps a small pad and handles all-silence', () => {
  const sr = 1000;
  const pcm = new Float32Array(1000);
  for (let i = 400; i < 600; i++) pcm[i] = 0.5;
  const t = PT.trimSilence(pcm, sr, 0.01, 0.04); // pad = 40 samples
  assert.strictEqual(t.length, 200 + 80);
  assert.strictEqual(PT.trimSilence(new Float32Array(500), sr).length, 0);
  assert.strictEqual(PT.trimSilence(new Float32Array([0.5, 0.5]), sr).length, 2);
  assert.strictEqual(PT.concatPcm([new Float32Array([1, 2]), new Float32Array([3])]).join(','), '1,2,3');
  assert.strictEqual(PT.toHex(new Uint8Array([0, 15, 255]).buffer), '000fff');
});


// ---------- Google Meet: sentence stabilisation ----------
const MEET_FX = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'meet-captions.json'), 'utf8'));

// Feed snapshots (300 ms apart) to a tracker, then let the turn end (idle); returns every emitted final in order.
function runTracker(snapshots, opts) {
  const t = SEN.createTracker(opts);
  const out = [];
  let now = 1000;
  snapshots.forEach((s) => {
    now += 300;
    t.update(s, now).finals.forEach((f) => out.push(f.text));
  });
  now += 5000;
  t.tick(now).finals.forEach((f) => out.push(f.text));
  return out;
}

test('sentences: fixture emits the expected finals once, and never "We." (rewritten to "Can we schedule ...")', () => {
  const t = SEN.createTracker();
  const perStep = [];
  let now = 0;
  MEET_FX.snapshots.forEach((s) => {
    now += 300;
    perStep.push(t.update(s, now).finals.map((f) => f.text));
  });
  const all = perStep.flat();
  // "We." is in snapshots 1-4 but is rewritten in snapshot 5: it must not have been emitted at any step
  assert.ok(MEET_FX.snapshots[3].includes(' We. I will share'));
  MEET_FX.neverFinal.forEach((bad) => assert.ok(!all.includes(bad), bad + ' was emitted'));
  assert.ok(!all.some((x) => /^We\b/.test(x) && x.length < 12));
  now += 1600;
  t.tick(now).finals.forEach((f) => all.push(f.text)); // end of the turn flushes the last sentence
  assert.deepStrictEqual(all, MEET_FX.expectedFinals);
  assert.strictEqual(new Set(all).size, all.length, 'a sentence was emitted twice');
  assert.deepStrictEqual(t.tick(now + 10000).finals, [], 'ticking again must not re-emit');
  // step by step: the rewrite of "We." happens at snapshot 5, "Can we schedule ..." appears only there
  assert.deepStrictEqual(perStep[0].slice(-1), ['Your phone number.']);
  assert.deepStrictEqual(perStep[1], ['Performance problem.']);
  assert.deepStrictEqual(perStep[2].concat(perStep[3]), []);
  assert.deepStrictEqual(perStep[4], ['Can we schedule the next call on Thursday afternoon?']);
});

test('sentences: word-by-word growth with rewrites emits each sentence once', () => {
  const full = MEET_FX.snapshots[4];
  const base = MEET_FX.snapshots[0].replace(/ We\.$/, '');
  const snaps = [];
  const bw = base.split(' ');
  for (let i = 1; i <= bw.length; i++) snaps.push(bw.slice(0, i).join(' '));
  // the recogniser first hears "We." / "We. I will" and then rewrites it
  ['We.', 'We. I', 'We. I will.', 'We. I will share'].forEach((x) => snaps.push(base + ' ' + x));
  const tail = full.slice(base.length).trim().split(' ');
  for (let i = 1; i <= tail.length; i++) snaps.push(base + ' ' + tail.slice(0, i).join(' '));
  const out = runTracker(snaps);
  assert.deepStrictEqual(out, MEET_FX.expectedFinals);
});

test('sentences: text scrolling off the front does not re-emit emitted sentences', () => {
  const full = MEET_FX.snapshots[4];
  const w = full.split(' ');
  const snaps = [];
  for (let i = 1; i <= w.length; i++) {
    const upto = w.slice(0, i);
    snaps.push(upto.slice(Math.max(0, upto.length - 18)).join(' ')); // window of the newest 18 words
  }
  const out = runTracker(snaps);
  assert.strictEqual(new Set(out.map(SEN.norm)).size, out.length, 'duplicates: ' + JSON.stringify(out));
  // the window starts mid-sentence only after those sentences were already final
  assert.ok(out.includes('Hello, everyone!'));
  assert.ok(out.includes('Can we schedule the next call on Thursday afternoon?'));
  assert.ok(out.includes('I will share the updated report with the whole team before that.'));
  assert.ok(!out.some((x) => /^(timeline\.|me\.|schedule because)/i.test(x)), 'a trimmed fragment was emitted: ' + JSON.stringify(out));
  // scrolled snapshots of the finished text: already-emitted sentences stay silent
  const t = SEN.createTracker();
  const first = t.update(MEET_FX.snapshots[4], 1000).finals.length;
  assert.ok(first >= 6);
  const trimmed = MEET_FX.snapshots[4].split(' ').slice(12).join(' ');
  assert.deepStrictEqual(t.update(trimmed, 1300).finals, []);
  assert.deepStrictEqual(t.update(trimmed + ' Thanks a lot for joining today.', 1600).finals.map((f) => f.text), ['I will share the updated report with the whole team before that.']);
});

test('sentences: short sentences merge into the next, lone short ones wait for the end of the turn', () => {
  assert.deepStrictEqual(runTracker(['Okay.', 'Okay. Let us start the meeting now.', 'Okay. Let us start the meeting now. Yes.']), ['Okay. Let us start the meeting now.', 'Yes.']);
  const t = SEN.createTracker();
  assert.deepStrictEqual(t.update('Thanks.', 1000).finals, []);
  assert.deepStrictEqual(t.tick(1800).finals, []);
  assert.deepStrictEqual(t.tick(2600).finals.map((f) => f.text), ['Thanks.']);
});

test('sentences: Meet rewriting the last few short sentences does not replay the whole turn (real call 2026-10-27)', () => {
  const t = SEN.createTracker();
  const out = [];
  let now = 1000;
  const feed = (text) => {
    now += 400;
    t.update(text, now).finals.forEach((f) => out.push(f.text));
  };
  const flush = () => {
    now += 2000;
    t.tick(now).finals.forEach((f) => out.push(f.text));
  };
  feed('Hello, everyone. My name is Nolan. Can you hear me? This is free.');
  flush();
  feed('Hello, everyone. My name is Nolan. Can you hear me? This is free. No, no, no, don\'t touch it. De. Really? Hi and beautiful!');
  flush();
  // Meet re-punctuates the tail AND rewrites "My name is" -> "My name's": the last 3 emitted are all gone
  feed('Hello, everyone. My name\'s Nolan. Can you hear me? This is free. No, no, no, don\'t touch it. Delete really. Hi, and beautiful. Application is very slow.');
  flush();
  const count = (x) => out.filter((o) => SEN.norm(o) === SEN.norm(x)).length;
  assert.strictEqual(count('Hello, everyone.'), 1, out.join(' | '));
  assert.strictEqual(count('This is free.'), 1, out.join(' | '));
  assert.ok(!out.some((o) => /name's Nolan/.test(o)), 'contraction rewrite is the same sentence: ' + out.join(' | '));
  assert.strictEqual(count('Application is very slow.'), 1, out.join(' | '));
  assert.ok(SEN.likeSentence(SEN.norm("My name's Nolan."), SEN.norm('My name is Nolan.')));
  assert.ok(!SEN.likeSentence(SEN.norm('Yes.'), SEN.norm('No.')));
});

test('sentences: new sentences that resemble earlier ones are not dropped (negation, "now", repeats)', () => {
  const wordByWord = (c) => {
    const t = SEN.createTracker();
    const out = [];
    let now = 0;
    const w = c.split(' ');
    for (let i = 1; i <= w.length; i++) {
      now += 250;
      t.update(w.slice(0, i).join(' '), now).finals.forEach((f) => out.push(f.text));
    }
    t.tick(now + 5000).finals.forEach((f) => out.push(f.text));
    return out;
  };
  assert.deepStrictEqual(wordByWord("I think we can ship on Friday. I don't think we can ship on Friday. Let me check the plan again."), [
    'I think we can ship on Friday.', "I don't think we can ship on Friday.", 'Let me check the plan again.']);
  assert.deepStrictEqual(wordByWord('The budget is approved for this year. The budget is not approved for next year. That is all for now.'), [
    'The budget is approved for this year.', 'The budget is not approved for next year.', 'That is all for now.']);
  assert.deepStrictEqual(wordByWord('Can you hear me? Okay. Can you hear me now? Great, let us start.'), ['Can you hear me?', 'Okay. Can you hear me now?', 'Great, let us start.']);
  assert.deepStrictEqual(wordByWord('Is it working? No, wait. Is it working now? Yes.'), ['Is it working?', 'No, wait.', 'Is it working now?', 'Yes.']);
  assert.ok(!SEN.likeSentence(SEN.norm('I think we can ship on Friday.'), SEN.norm("I don't think we can ship on Friday.")));
});

test('sentences: a reused tracker (Meet re-rendered the block) continues instead of re-reading', () => {
  const t = SEN.createTracker();
  const first = t.update('Good morning team. We have three items today. First is the budget.', 1000).finals.map((f) => f.text);
  assert.deepStrictEqual(first, ['Good morning team.', 'We have three items today.']);
  t.tick(5000);
  // same speaker, new element: Meet renders the whole turn again plus a new sentence
  const again = t.update('Good morning team. We have three items today. First is the budget. Second is hiring.', 6000);
  t.tick(9000).finals.forEach((f) => again.finals.push(f));
  assert.deepStrictEqual(again.finals.map((f) => f.text), ['Second is hiring.']);
});

test('sentences: unpunctuated end of a turn is flushed after a longer pause; fragments are not', () => {
  const t = SEN.createTracker();
  assert.deepStrictEqual(t.update('Good morning. we are about to start the', 1000).finals.map((f) => f.text), ['Good morning.']);
  assert.deepStrictEqual(t.tick(2600).finals, []); // 1.6 s: an unfinished sentence keeps waiting
  assert.deepStrictEqual(t.tick(3500).finals, []);
  assert.deepStrictEqual(t.tick(4200).finals.map((f) => f.text), ['we are about to start the']);
  assert.deepStrictEqual(t.tick(9000).finals, []);
  assert.strictEqual(runTracker(['Hello there']).join('|'), ''); // too short and unfinished
});

test('sentences: speakers are independent; abbreviations and decimals do not split', () => {
  const a = SEN.createTracker();
  const b = SEN.createTracker();
  const ra = a.update('Dr. Smith said the value is 3.5 percent. Is that right?', 1000);
  const rb = b.update('Yes it is. We checked it twice yesterday.', 1050);
  assert.deepStrictEqual(ra.finals.map((f) => f.text), ['Dr. Smith said the value is 3.5 percent.']);
  assert.strictEqual(ra.interim, 'Is that right?');
  assert.deepStrictEqual(rb.finals.map((f) => f.text), ['Yes it is.']);
  assert.deepStrictEqual(SEN.splitSentences('One two. Three four five?  Six').map((x) => [x.text, x.done]), [['One two.', true], ['Three four five?', true], ['Six', false]]);
  assert.deepStrictEqual(SEN.splitSentences('   '), []);
  assert.ok(SEN.sameSentence(SEN.norm('We are a little bit behind the schedule.'), SEN.norm('We are little bit behind the schedule!')));
  assert.ok(!SEN.sameSentence('good morning', 'good evening'));
});

// ---------- Google Meet: live dubbing queue + live translation ----------
test('dubber live: queue keeps the 2 newest waiting lines and drops stale ones; rate rises with the backlog', () => {
  const q = [1, 2, 3, 4].map((n) => ({ text: 'l' + n, t: 1000 + n }));
  const r = D.trimLiveQueue(q, 2, 2000, 15000);
  assert.deepStrictEqual(r.queue.map((x) => x.text), ['l3', 'l4']);
  assert.deepStrictEqual(r.dropped.map((x) => x.text), ['l1', 'l2']);
  const stale = D.trimLiveQueue([{ text: 'old', t: 0 }, { text: 'new', t: 19000 }], 2, 20000, 15000);
  assert.deepStrictEqual(stale.queue.map((x) => x.text), ['new']);
  assert.strictEqual(D.liveRate(1.1, 0, 2), 1.1);
  assert.ok(D.liveRate(1.1, 2, 2) > D.liveRate(1.1, 1, 2));
  assert.strictEqual(D.liveRate(1.1, 9, 2), 2);
  assert.strictEqual(D.LIVE_MAX_WAITING, 2);
});

test('live translator: on-device first, Google fallback with automatic switching, LRU cache', async () => {
  const calls = [];
  let localFails = false;
  const deps = {
    PV,
    now: () => 1000,
    send: async (msg) => {
      calls.push('google:' + msg.texts[0] + ':' + msg.site);
      return { ok: true, result: ['G:' + msg.texts[0]], failed: [] };
    },
    localtr: {
      probe: async () => ({ where: 'offscreen', availability: 'available', source: 'en', target: 'vi' }),
      translate: async (info, text) => {
        calls.push('local:' + text);
        if (localFails) throw new Error('boom');
        return 'L:' + text;
      }
    },
    onNotice: (m) => calls.push('notice:' + m)
  };
  const lt = LTR.create(deps);
  lt.configure('local', 'en');
  assert.deepStrictEqual(await lt.translate('Hello team.'), { vi: 'L:Hello team.', provider: 'local' });
  assert.strictEqual((await lt.translate('Hello team.')).provider, 'cache');
  assert.strictEqual(await lt.translateInterim('Hello team'), 'L:Hello team');
  localFails = true;
  // two consecutive failures park the on-device translator for 60 s; this line is retried with Google at once
  const r1 = await lt.translate('Second line here.');
  assert.deepStrictEqual(r1, { vi: 'G:Second line here.', provider: 'google' });
  assert.ok(calls.some((c) => /^notice:.*Google/.test(c)));
  assert.ok(calls.includes('google:Second line here.:meet'));
  const n = calls.length;
  assert.strictEqual((await lt.translate('Third line here.')).provider, 'google');
  assert.ok(!calls.slice(n).some((c) => c.startsWith('local:')), 'parked provider must not be tried again');
  assert.strictEqual(await lt.translateInterim('anything'), null); // interim drafts never use Google
  assert.deepStrictEqual(await lt.translate('♪ ♪'), { vi: '♪ ♪', provider: 'none' });
  // no on-device model: Google only
  const lt2 = LTR.create(Object.assign({}, deps, { localtr: { probe: async () => ({ where: null, availability: 'unsupported' }), translate: async () => '' } }));
  lt2.configure('auto', 'en');
  assert.strictEqual((await lt2.translate('Hi all.')).provider, 'google');
  // everything failing returns null instead of throwing
  const lt3 = LTR.create(Object.assign({}, deps, { send: async () => ({ ok: false }), localtr: { probe: async () => ({ where: null }), translate: async () => '' } }));
  lt3.configure('google', 'en');
  assert.strictEqual(await lt3.translate('Hi all.'), null);
});

test('live translator auto: Google first, on-device takes over when Google is blocked; drafts stay on-device', async () => {
  let googleOk = true;
  const calls = [];
  const lt = LTR.create({
    PV,
    now: () => 1000,
    send: async (msg) => {
      calls.push('google');
      return googleOk ? { ok: true, result: ['G:' + msg.texts[0]], failed: [] } : { ok: false, error: 'http 429' };
    },
    localtr: { probe: async () => ({ where: 'offscreen', availability: 'available', source: 'en', target: 'vi' }), translate: async (info, t) => (calls.push('local'), 'L:' + t) },
    onNotice: () => {}
  });
  lt.configure('auto', 'en');
  assert.deepStrictEqual(await lt.translate('One.'), { vi: 'G:One.', provider: 'google' });
  assert.ok(!calls.includes('local'));
  assert.strictEqual(await lt.translateInterim('One more'), 'L:One more'); // drafts: on-device, never Google
  googleOk = false;
  assert.deepStrictEqual(await lt.translate('Two.'), { vi: 'L:Two.', provider: 'local' });
});

test('settings: per-site and Meet options default on, normalise to booleans', () => {
  const d = S.normalize({});
  assert.deepStrictEqual([d.siteYoutube, d.siteMeet, d.meetShowOriginal, d.meetSkipSelf], [true, true, true, true]);
  const o = S.normalize({ siteMeet: 0, siteYoutube: false, meetShowOriginal: false, meetSkipSelf: '' });
  assert.deepStrictEqual([o.siteYoutube, o.siteMeet, o.meetShowOriginal, o.meetSkipSelf], [false, false, false, false]);
  assert.strictEqual(d.mode, 'both');
});

test('manifest: Google Meet content script, panel CSS (original on top, Vietnamese 0.85em #9ecbff)', () => {
  const root = path.join(__dirname, '..');
  const m = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  const meet = m.content_scripts.find((c) => c.matches.includes('https://meet.google.com/*'));
  assert.ok(meet, 'no meet content script');
  ['lib/settings.js', 'lib/providers.js', 'lib/local-translate.js', 'lib/sentences.js', 'content/dubber.js', 'content/localtr.js', 'content/livetr.js', 'content/meet-panel.js', 'content/meet.js'].forEach((f) => assert.ok(meet.js.includes(f), f));
  assert.ok(meet.js.indexOf('content/meet.js') === meet.js.length - 1, 'meet.js must load last');
  assert.deepStrictEqual(meet.css, ['content/meet.css']);
  assert.ok(!meet.world, 'ISOLATED world is enough');
  const css = fs.readFileSync(path.join(root, 'content', 'meet.css'), 'utf8');
  assert.ok(/\.yvd-m-vi\.yvd-m-bi\s*\{[^}]*font-size:\s*0\.85em[^}]*color:\s*#9ecbff/.test(css));
  const js = fs.readFileSync(path.join(root, 'content', 'meet-panel.js'), 'utf8');
  assert.ok(js.indexOf("'yvd-m-en'") < js.indexOf("'yvd-m-vi'"), 'English line must be rendered above the Vietnamese one');
  // Meet code touches exactly one Meet control: the CC button, inside the opt-in auto-CC routine
  const src = fs.readFileSync(path.join(root, 'content', 'meet.js'), 'utf8');
  assert.ok(!/dispatchEvent\(/.test(src), 'meet.js must not dispatch events on Meet');
  const clicks = src.match(/\.click\(/g) || [];
  assert.strictEqual(clicks.length, 1, 'only the auto-CC routine may click');
  const auto = src.slice(src.indexOf('function maybeAutoCC'), src.indexOf('function maybeAutoCC') + 1500);
  assert.ok(/settings\.meetAutoCC/.test(auto) && /b\.click\(\)/.test(auto) && /captionButton\(\)/.test(auto), 'the click is the opt-in CC button');
});

// ---------- manifest / packaging ----------
test('manifest: MV3, wasm CSP, HF + hf.co host permissions, every referenced file exists', () => {
  const root = path.join(__dirname, '..');
  const m = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  assert.strictEqual(m.manifest_version, 3);
  assert.strictEqual(m.content_security_policy.extension_pages, "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'");
  ['https://huggingface.co/*', 'https://*.hf.co/*'].forEach((h) => assert.ok(m.host_permissions.includes(h), h));
  assert.ok(m.permissions.includes('offscreen'));
  const files = [m.background.service_worker, m.action.default_popup];
  m.content_scripts.forEach((cs) => files.push(...(cs.js || []), ...(cs.css || [])));
  Object.values(m.icons).forEach((f) => files.push(f));
  files.forEach((f) => assert.ok(fs.existsSync(path.join(root, f)), 'missing ' + f));
  // vendored runtime used by lib/piper-worker.js
  ['vendor/onnxruntime-web/ort.wasm.min.mjs', 'vendor/onnxruntime-web/ort-wasm-simd-threaded.mjs', 'vendor/onnxruntime-web/ort-wasm-simd-threaded.wasm', 'vendor/onnxruntime-web/LICENSE', 'vendor/piper-wasm/piper_phonemize.js', 'vendor/piper-wasm/piper_phonemize.wasm', 'vendor/piper-wasm/piper_phonemize.data', 'vendor/piper-wasm/LICENSE-piper-phonemize-MIT', 'vendor/piper-wasm/LICENSE-espeak-ng-GPL-3.0', 'lib/piper-worker.js', 'offscreen.html', 'offscreen.js'].forEach((f) => assert.ok(fs.existsSync(path.join(root, f)), 'missing ' + f));
});

test('no remote scripts: html pages load only local scripts', () => {
  const root = path.join(__dirname, '..');
  ['offscreen.html', 'popup/popup.html'].forEach((f) => {
    const html = fs.readFileSync(path.join(root, f), 'utf8');
    const srcs = [...html.matchAll(/<script[^>]*\bsrc="([^"]+)"/g)].map((x) => x[1]);
    assert.ok(srcs.length > 0);
    srcs.forEach((s) => assert.ok(!/^(https?:)?\/\//.test(s), f + ' loads remote script ' + s));
    assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/.test(html), f + ' has an inline script');
  });
});

// ---------- review fixes (Y1-Y7, M7) ----------
let fetchChain = Promise.resolve(); // async tests run concurrently: serialise the global fetch swap
const withFetch = (impl, fn) => {
  const run = fetchChain.then(async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = impl;
    try {
      return await fn();
    } finally {
      globalThis.fetch = orig;
    }
  });
  fetchChain = run.catch(() => {});
  return run;
};
const gRes = (text) => ({ ok: true, status: 200, json: async () => [[[text, '']]] });

test('Y1 translateGoogle: HTTP 429 fails the whole batch fast (<=2 requests), no per-line retries', async () => {
  let calls = 0;
  const r = await withFetch(
    async () => {
      calls++;
      return { ok: false, status: 429 };
    },
    () => T.translate({ provider: 'google', texts: ['a one', 'b two', 'c three'] })
  );
  assert.deepStrictEqual(r.result, ['', '', '']);
  assert.deepStrictEqual(r.failed, [0, 1, 2]);
  assert.ok(calls <= 2, 'requests: ' + calls);
});

test('Y1 translateGoogle: line-count mismatch still falls back per line; request-size 4xx too, stopping at the first error', async () => {
  let calls = 0;
  const mism = await withFetch(
    async (url) => {
      calls++;
      const q = decodeURIComponent(String(url).split('&q=')[1]);
      return gRes(q.includes('\n') ? 'gop chung' : 'vi:' + q); // batch comes back as one line
    },
    () => T.translate({ provider: 'google', texts: ['a', 'b', 'c'] })
  );
  assert.deepStrictEqual(mism.result, ['vi:a', 'vi:b', 'vi:c']);
  assert.strictEqual(calls, 4);
  calls = 0;
  const big = await withFetch(
    async () => {
      calls++;
      return { ok: false, status: 414 };
    },
    () => T.translate({ provider: 'google', texts: ['a', 'b', 'c'] })
  );
  assert.deepStrictEqual(big.failed, [0, 1, 2]);
  assert.strictEqual(calls, 2); // the batch + the first line, then stop
});

test('Y6 translate(claude) without key / on error returns fallback:true (Google text must not be cached as claude)', async () => {
  const r = await withFetch(
    async () => gRes('xin chao'),
    () => T.translate({ provider: 'claude', texts: ['hello'], apiKey: '' })
  );
  assert.strictEqual(r.fallback, true);
  assert.deepStrictEqual(r.result, ['xin chao']);
  const g = await withFetch(
    async () => gRes('xin chao'),
    () => T.translate({ provider: 'google', texts: ['hello'] })
  );
  assert.ok(!g.fallback);
});

test('Y2 planSpeech: budget runs from max(cue.start, now); late start raises the rate, tiny remainder skips', () => {
  const cue = { start: 10, end: 14, vi: 'x'.repeat(100) }; // 100 chars * 0.05 spc = 5 s at rate 1
  const base = { cue, baseRate: 1, maxRate: 3, playbackRate: 1, spc: 0.05 };
  const onTime = D.planSpeech(base);
  assert.ok(Math.abs(onTime.need - 5 / 4) < 1e-9);
  assert.strictEqual(D.planSpeech(Object.assign({}, base, { now: 10.0 })).need, onTime.need);
  assert.strictEqual(D.planSpeech(Object.assign({}, base, { now: 9 })).need, onTime.need); // before start: unchanged
  const late = D.planSpeech(Object.assign({}, base, { now: 12 })); // 2 s left
  assert.ok(Math.abs(late.need - 2.5) < 1e-9 && late.rate === 2.5 && !late.skip);
  const rate2 = D.planSpeech(Object.assign({}, base, { now: 12, playbackRate: 2 })); // 2 video-s = 1 wall-s
  assert.ok(Math.abs(rate2.need - 5) < 1e-9);
  assert.strictEqual(D.planSpeech(Object.assign({}, base, { now: 13.8 })).skip, true); // 0.2 s left
  assert.strictEqual(D.planSpeech(Object.assign({}, base, { now: 13.8, playbackRate: 0.5 })).skip, undefined); // 0.4 wall-s left
  // merge budget also starts at `now`
  const nx = { start: 14.1, end: 18, vi: 'y'.repeat(20) };
  const m = D.planSpeech(Object.assign({}, base, { nextCue: nx, now: 12, maxRate: 2 }));
  assert.ok(m.merged && Math.abs(m.need - (121 * 0.05) / 6) < 1e-9);
});

test('Y5 playedSeconds: unusable when paused mid-way (dirty / playSec null), never falls back to wall time', () => {
  assert.strictEqual(D.playedSeconds({ ok: true, playSec: 2.5 }), 2.5);
  assert.strictEqual(D.playedSeconds({ ok: true, playSec: null, startMs: 1000, endMs: 9000 }), null);
  assert.strictEqual(D.playedSeconds({ ok: true, playSec: 2.5, dirty: true }), null);
  assert.strictEqual(D.playedSeconds({ ok: true, playSec: 0 }), null);
  assert.strictEqual(D.playedSeconds(null), null);
});

// offscreen.js under a fake DOM (vm): playback pause handling + Google circuit breaker
function loadOffscreen() {
  const vm = require('vm');
  const listeners = [];
  const audios = [];
  class FakeAudio {
    constructor() {
      this.calls = [];
      this.playRejects = [];
      audios.push(this);
    }
    play() {
      this.calls.push('play');
      return new Promise((res, rej) => this.playRejects.push(rej));
    }
    pause() {
      this.calls.push('pause');
    }
    removeAttribute() {}
    load() {}
  }
  const fetches = [];
  const sb = {
    chrome: { runtime: { id: 'x', onMessage: { addListener: (f) => listeners.push(f) } } },
    Audio: FakeAudio,
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
    Blob: function Blob() {},
    AbortController,
    setTimeout,
    clearTimeout,
    performance,
    Date,
    Worker: function () {},
    fetch: (url) =>
      new Promise((res, rej) => {
        fetches.push({ url, res: () => res({ ok: true, blob: async () => ({ size: 500 }) }), rej });
      })
  };
  sb.window = sb;
  sb.self = sb;
  sb.YVD = { gtts: G, piperText: PT, piperStore: { isReady: async () => false }, localTranslate: { createEngine: () => ({}) } };
  vm.createContext(sb);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'offscreen.js'), 'utf8'), sb);
  const call = (msg) => new Promise((res) => listeners[0](Object.assign({ target: 'offscreen' }, msg), { id: 'x' }, res));
  const tick = () => new Promise((r) => setImmediate(r));
  return { call, tick, audios, fetches };
}

test('Y3 offscreen: pause during the first chunk fetch holds playback until resume; AbortError from pause is not a failure', async () => {
  const o = loadOffscreen();
  const sp = o.call({ op: 'speak', engine: 'google', text: 'xin chao cac ban', rate: 1 });
  await o.tick();
  await o.call({ op: 'pause' }); // while the Google fetch is still pending
  o.fetches[0].res();
  await o.tick();
  await o.tick();
  assert.strictEqual(o.audios.length, 1);
  assert.deepStrictEqual(o.audios[0].calls, [], 'must not play while paused');
  await o.call({ op: 'resume' });
  assert.deepStrictEqual(o.audios[0].calls, ['play']);
  o.audios[0].playRejects[0]({ name: 'AbortError' }); // a racing pause()/play() pair rejects the earlier play()
  await o.tick();
  o.audios[0].onplaying();
  o.audios[0].onended();
  const r = await sp;
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.playSec, null); // paused mid-way: timing unusable
  assert.strictEqual(r.dirty, true);
});

test('Y3 offscreen: pause while playing, then AbortError from the interrupted play() does not fail the speak', async () => {
  const o = loadOffscreen();
  const sp = o.call({ op: 'speak', engine: 'google', text: 'tam biet', rate: 1 });
  await o.tick();
  o.fetches[0].res();
  await o.tick();
  await o.tick();
  assert.deepStrictEqual(o.audios[0].calls, ['play']);
  await o.call({ op: 'pause' });
  o.audios[0].playRejects[0]({ name: 'AbortError' });
  await o.tick();
  await o.call({ op: 'resume' });
  o.audios[0].onended();
  assert.strictEqual((await sp).ok, true);
});

test('Y4 offscreen: consecutive Google fetch failures (even of superseded lines) open a breaker; uncached requests then fail fast', async () => {
  const o = loadOffscreen();
  const s1 = o.call({ op: 'speak', engine: 'google', text: 'mot', rate: 1 });
  await o.tick();
  const s2 = o.call({ op: 'speak', engine: 'google', text: 'hai', rate: 1 }); // supersedes s1 (cancelled)
  await o.tick();
  assert.strictEqual((await s1).cancelled, true);
  assert.strictEqual(o.fetches.length, 2);
  o.fetches[0].rej(new Error('timeout')); // the superseded line's fetch fails late
  o.fetches[1].rej(new Error('timeout'));
  const r2 = await s2;
  assert.strictEqual(r2.ok, false);
  const r3 = await o.call({ op: 'speak', engine: 'google', text: 'ba', rate: 1 });
  assert.strictEqual(r3.ok, false);
  assert.strictEqual(r3.error, 'google-down');
  assert.strictEqual(o.fetches.length, 2, 'no new request while the breaker is open');
});

test('Y4 offscreen: one failure does not open the breaker; a success resets the count', async () => {
  const o = loadOffscreen();
  const s1 = o.call({ op: 'speak', engine: 'google', text: 'mot', rate: 1 });
  await o.tick();
  o.fetches[0].rej(new Error('http 503'));
  assert.strictEqual((await s1).ok, false);
  const s2 = o.call({ op: 'speak', engine: 'google', text: 'hai', rate: 1 });
  await o.tick();
  assert.strictEqual(o.fetches.length, 2); // retried, not short-circuited
  o.fetches[1].res();
  await o.tick();
  await o.tick();
  o.audios[0].onended();
  assert.strictEqual((await s2).ok, true);
});

Promise.all(pendingTests).then(() => console.log('\n' + passed + ' tests passed' + (process.exitCode ? ' (with failures)' : '')));
