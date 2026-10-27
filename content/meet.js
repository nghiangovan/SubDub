/* Google Meet orchestrator (ISOLATED world). Reads Meet's captions; the only thing it ever touches in Meet's UI is the
 * CC button, pressed ONCE per call when the opt-in setting meetAutoCC is on (turning CC off by hand is respected). On
 * Workspace calls with speech translation the bar has a "captions / translation" button instead, which opens a menu
 * (Turn on captions | Translate speech); then it opens that menu and picks "Turn on captions", nothing else.
 *   1. finds Meet's live-caption container ([role=region] "Captions", localised labels, heuristic fallback)
 *   2. parses speaker blocks (avatar img + name + text) and feeds each block's snapshots to lib/sentences.js
 *   3. every FINAL English sentence is translated once (content/livetr.js: on-device Translator first, Google
 *      fallback, automatic switching) and shown in the panel (content/meet-panel.js); optionally dubbed
 *      (content/dubber.js live queue: freshness first, no ducking of Meet's audio). */
(function () {
  'use strict';
  const YVD = window.YVD;
  const S = YVD.settings;
  const SEN = YVD.sentences;
  const P = YVD.meetPanel;
  const D = YVD.dubber;
  if (window.__YVD_MEET__) return;
  window.__YVD_MEET__ = true;

  const SRC_LANG = 'en'; // Meet's "Meeting language" must be English (see README)
  const HINT = 'Bật CC (phím c) và chọn Meeting language = English';
  const SCAN_THROTTLE = 150; // ms
  const TICK_MS = 400;
  const TRANSLATE_TIMEOUT = 10000;
  const INTERIM_DEBOUNCE = 700;

  // Localised aria-labels of the caption region (lower case, matched as substring)
  const REGION_LABELS = ['captions', 'phụ đề', 'subtítulos', 'subtitulos', 'sous-titres', 'untertitel', 'sottotitoli', 'legendas', 'legenda', 'ondertitels', 'napisy', 'altyazı', 'субтитры', 'субтитри', '字幕', '자막', 'คำบรรยาย', 'teks'];
  const CC_WORD = /(captions?|phụ đề|subtítulos|sous-titres|untertitel|sottotitoli|legendas?|ondertitels|napisy|altyazı|субтитр|字幕|자막)/i;
  const CC_ON = /(turn off|tắt|desactivar|désactiver|ausschalten|disattiva|desativar|uitschakelen|wyłącz|kapat|выключить|关闭|끄기)/i;
  const CC_OFF = /(turn on|bật|activar|activer|einschalten|attiva|ativar|inschakelen|włącz|aç|включить|开启|켜기)/i;
  const TR_WORD = /(translat|dịch|traduc|übersetz|tradu|vertal|tłumacz|çevir|перев|翻译|翻譯|翻訳|번역)/i;
  const SELF_NAMES = ['you', 'bạn', 'usted', 'vous', 'você', 'jij', 'вы', '你', 'あなた', '당신']; // no 'tú'/'tu'/'sen'/'du': real first names

  let settings = S.normalize({});
  let container = null;
  let contObs = null;
  let scanTimer = null;
  let bodyTimer = null;
  let panelOn = false;
  let seq = 0;
  let blockSeq = 0;
  let dubChain = Promise.resolve();
  let interimTimer = null;
  let interimPending = ''; // interim text the debounce timer is waiting to translate
  const active = new Map(); // block key (avatar img or element) -> state
  const recent = new Map(); // dedupe of re-appearing sentences: speaker|text -> time

  const alive = () => S.alive();
  const siteOn = () => !!(settings.enabled && settings.siteMeet);
  const wantsSubs = () => settings.mode !== 'dub';
  const wantsDub = () => settings.mode !== 'subtitle';

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

  const LT = YVD.liveTranslate.create({
    PV: YVD.providers,
    send: send,
    localtr: YVD.localtr,
    onNotice: (m) => P.status(m, 5000)
  });

  // ---------- caption container ----------
  function labelMatches(label) {
    const l = String(label || '').toLowerCase().trim();
    return !!l && REGION_LABELS.some((x) => l === x || l.indexOf(x) >= 0);
  }

  // The CC on/off toggle. Meet has other caption buttons too ("Open caption settings", "Jump to most recent
  // captions"), so prefer the one whose label says turn on / turn off (or that carries aria-pressed).
  function captionButton() {
    const btns = document.querySelectorAll('button[aria-label], [role="button"][aria-label]');
    let loose = null;
    for (let i = 0; i < btns.length; i++) {
      const b = btns[i];
      if (b.closest('#yvd-meet-panel')) continue;
      const label = b.getAttribute('aria-label') || '';
      if (!CC_WORD.test(label)) continue;
      if (b.hasAttribute('aria-pressed') || CC_ON.test(label) || CC_OFF.test(label)) return b;
      if (!loose && !isMenuOpener(b) && !TR_WORD.test(label)) loose = b;
    }
    return loose;
  }

  // Workspace calls with speech translation: one bar button opens a menu with "Turn on captions" and "Translate
  // speech", so CC is two clicks away. The opener says captions and/or translation but not turn on/off.
  function isMenuOpener(b) {
    return b.hasAttribute('aria-haspopup') || b.hasAttribute('aria-expanded');
  }
  function ccMenuButton() {
    const btns = document.querySelectorAll('button[aria-label], [role="button"][aria-label]');
    let loose = null;
    for (let i = 0; i < btns.length; i++) {
      const b = btns[i];
      if (b.closest('#yvd-meet-panel')) continue;
      const label = b.getAttribute('aria-label') || '';
      if (!TR_WORD.test(label) && !CC_WORD.test(label)) continue;
      if (b.hasAttribute('aria-pressed') || CC_ON.test(label) || CC_OFF.test(label)) continue;
      if (isMenuOpener(b)) return b;
      if (!loose && TR_WORD.test(label)) loose = b;
    }
    return loose;
  }
  // The caption item inside that menu (it may be labelled by its text only)
  function menuCaptionItem(opener) {
    const items = document.querySelectorAll('button, [role="button"], [role="menuitem"], [role="menuitemcheckbox"], [role="switch"]');
    for (let i = 0; i < items.length; i++) {
      const b = items[i];
      if (b === opener || b.closest('#yvd-meet-panel')) continue;
      const label = b.getAttribute('aria-label') || b.innerText || '';
      if (CC_WORD.test(label) && (CC_OFF.test(label) || CC_ON.test(label))) return b;
    }
    return null;
  }
  function itemLabel(b) {
    return b.getAttribute('aria-label') || b.innerText || '';
  }
  // pressing the opener again closes it (only while it is still open)
  function closeMenu(opener) {
    const expanded = opener.getAttribute('aria-expanded');
    const item = menuCaptionItem(opener);
    if (expanded === 'true' || (expanded === null && item && item.offsetParent !== null)) opener.click();
  }
  // Open the menu, wait for it, press "Turn on captions" only if it says turn ON, then close the menu again.
  function turnOnViaMenu() {
    const opener = ccMenuButton();
    if (!opener) return;
    autoCC.busy = true;
    opener.click();
    let n = 0;
    const timer = setInterval(() => {
      const item = menuCaptionItem(opener);
      if (!item && ++n < 12) return; // the menu animates in
      clearInterval(timer);
      autoCC.busy = false;
      if (!item) return;
      const label = itemLabel(item);
      if (CC_ON.test(label)) {
        autoCC.done = true; // captions are already on: leave them
      } else if (CC_OFF.test(label)) {
        item.click();
        P.status('SubDub: đã tự bật phụ đề (CC) của Meet', 4000);
      }
      setTimeout(() => closeMenu(opener), 300);
    }, 150);
  }

  // ---------- auto CC (opt-in) ----------
  // Press Meet's CC button once per call: only after the button has been in the "off" state for a moment (the call
  // UI has settled), at most 3 attempts. Once captions have been on, never touch it again in this call, so a user
  // who turns CC off by hand keeps it off. Leaving the call (no caption button any more) re-arms it.
  const AUTO_CC_SETTLE = 2000;
  const AUTO_CC_RETRY = 2500;
  const autoCC = { done: false, busy: false, tries: 0, offSince: 0, lastTry: 0, meeting: '' };
  function maybeAutoCC(cc) {
    const now = Date.now();
    if (autoCC.meeting !== location.pathname) {
      // a different meeting (Meet is a single-page app): arm again
      Object.assign(autoCC, { done: false, busy: false, tries: 0, offSince: 0, lastTry: 0, meeting: location.pathname });
    }
    if (cc === 'none') {
      autoCC.offSince = 0;
      return;
    }
    if (cc === 'on') {
      autoCC.done = true;
      return;
    }
    if (autoCC.busy) return;
    if (autoCC.done || (cc !== 'off' && cc !== 'menu') || !settings.meetAutoCC || !siteOn()) {
      autoCC.offSince = 0;
      return;
    }
    if (!autoCC.offSince) autoCC.offSince = now;
    if (now - autoCC.offSince < AUTO_CC_SETTLE || now - autoCC.lastTry < AUTO_CC_RETRY) return;
    if (autoCC.tries >= 3) {
      autoCC.done = true; // give up quietly; the panel keeps showing the "turn on CC" hint
      return;
    }
    if (cc === 'menu') {
      autoCC.tries++;
      autoCC.lastTry = now;
      turnOnViaMenu();
      return;
    }
    const b = captionButton();
    if (!b) return;
    autoCC.tries++;
    autoCC.lastTry = now;
    b.click();
    P.status('SubDub: đã tự bật phụ đề (CC) của Meet', 4000);
  }

  // 'on' | 'off' | 'unknown' | 'menu' (CC is inside the captions/translation menu) | 'none' (not in a call)
  function ccState() {
    const b = captionButton();
    if (!b) return ccMenuButton() ? 'menu' : 'none';
    const pressed = b.getAttribute('aria-pressed');
    if (pressed === 'true') return 'on';
    if (pressed === 'false') return 'off';
    const label = b.getAttribute('aria-label') || '';
    if (CC_ON.test(label)) return 'on';
    if (CC_OFF.test(label)) return 'off';
    return 'unknown';
  }

  function findContainer() {
    const regions = document.querySelectorAll('[role="region"]');
    for (let i = 0; i < regions.length; i++) {
      if (labelMatches(regions[i].getAttribute('aria-label'))) return regions[i];
    }
    // heuristic: an unlabelled/unknown-language region that holds avatar images with text, while CC is on
    if (ccState() === 'on') {
      for (let i = 0; i < regions.length; i++) {
        const r = regions[i];
        if (r.closest('#yvd-meet-panel')) continue;
        if (r.querySelector('img') && (r.textContent || '').trim().length > 0) return r;
      }
    }
    return null;
  }

  // ---------- speaker blocks ----------
  // One block per speaker turn: the top-most ancestor of an avatar <img> that contains no other avatar.
  function findBlocks(c) {
    const imgs = c.querySelectorAll('img');
    const out = [];
    const seen = new Set();
    imgs.forEach((img) => {
      let b = img;
      while (b.parentElement && b.parentElement !== c && b.parentElement.querySelectorAll('img').length === 1) b = b.parentElement;
      if (b === img) b = img.parentElement || img;
      if (!seen.has(b)) {
        seen.add(b);
        out.push({ key: img, el: b, img: img });
      }
    });
    if (!out.length) {
      // no avatars: treat the children of the first branching level as blocks
      let host = c;
      while (host.children.length === 1) host = host.children[0];
      Array.from(host.children).forEach((ch) => {
        if (textOf(ch)) out.push({ key: ch, el: ch, img: null });
      });
    }
    return out;
  }

  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

  // Visible caption text only: Meet puts its own controls inside the caption region (e.g. the
  // "Jump to bottom" button with an `arrow_downward` icon ligature) — never read those as speech.
  const SKIP_SEL = 'button, [role="button"], [aria-hidden="true"], i, svg, img';
  function textOf(el) {
    if (!el || el.matches(SKIP_SEL)) return '';
    const copy = el.cloneNode(true);
    copy.querySelectorAll(SKIP_SEL).forEach((x) => x.remove());
    return clean(copy.textContent);
  }

  // -> { name, text }
  function parseBlock(blk) {
    const root = blk.el;
    const leaves = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let n;
    while ((n = walker.nextNode())) {
      if (n.children.length === 0 && !n.closest(SKIP_SEL) && clean(n.textContent)) leaves.push(clean(n.textContent));
    }
    const all = textOf(root);
    const alt = blk.img ? clean(blk.img.getAttribute('alt')) : '';
    let name = '';
    let text = all;
    if (leaves.length >= 2 && leaves[0].split(' ').length <= 6) {
      name = leaves[0];
      text = all.indexOf(name) === 0 ? clean(all.slice(name.length)) : clean(leaves.slice(1).join(' '));
    } else if (leaves.length === 1 && alt && leaves[0] !== alt && alt.split(' ').length <= 6) {
      name = alt;
    }
    return { name: name || alt, text };
  }

  const isSelf = (name) => SELF_NAMES.indexOf(clean(name).toLowerCase().replace(/\s*\(.*\)\s*$/, '')) >= 0;

  // ---------- finals ----------
  function onFinal(st, text) {
    const speaker = st.speaker || '';
    const key = SEN.norm(speaker) + '|' + SEN.norm(text);
    const t = Date.now();
    // a block that was re-created by Meet can replay old sentences: skip long ones already handled recently
    if (SEN.wordCount(text) >= 4 && recent.has(key) && t - recent.get(key) < 90000) return;
    recent.set(key, t);
    if (recent.size > 300) recent.delete(recent.keys().next().value);

    const id = ++seq;
    P.addLine({ id, speaker, en: text, vi: '', pending: true });
    const tr = LT.translate(text).catch(() => null);
    const job = Promise.race([tr, new Promise((r) => setTimeout(() => r(null), TRANSLATE_TIMEOUT))]);
    job.then((r) => {
      if (r && r.vi) P.updateLine(id, { vi: r.vi, pending: false });
      else {
        P.updateLine(id, { pending: false, failed: true });
        P.status('SubDub: không dịch được câu này', 3000);
        // too late to dub, but still show it when it does arrive
        tr.then((late) => {
          if (late && late.vi) P.updateLine(id, { vi: late.vi, failed: false });
        });
      }
    });
    // dub in arrival order; a slow translation only delays (never reorders) the lines behind it
    dubChain = dubChain
      .then(() => job)
      .then((r) => {
        if (r && r.vi && siteOn() && wantsDub() && !(settings.meetSkipSelf && isSelf(speaker))) D.speakLive(r.vi);
      })
      .catch(() => {});
  }

  function handle(st, res) {
    res.finals.forEach((f) => onFinal(st, f.text));
    st.interim = res.interim || '';
  }

  // ---------- scanning ----------
  function scan() {
    scanTimer = null;
    if (!siteOn() || !container || !container.isConnected || !alive()) return;
    const now = Date.now();
    const blocks = findBlocks(container).map((blk) => ({ blk: blk, info: parseBlock(blk) }));
    const keys = new Set(blocks.map((b) => b.blk.key));
    // states whose block is gone from the page (end of a turn, or Meet re-rendered it)
    const vanished = [];
    Array.from(active.keys()).forEach((k) => {
      if (keys.has(k)) return;
      vanished.push(active.get(k));
      active.delete(k);
    });
    blocks.forEach(({ blk, info }) => {
      let st = active.get(blk.key);
      if (!st) {
        // Meet re-rendered this speaker's block (new avatar/element, same text): continue with the old state so
        // the turn is not read again from its start
        st = takeState(vanished, info.name, info.text, now) || takeState(retired, info.name, info.text, now);
        if (!st) st = { tracker: SEN.createTracker(), speaker: '', interim: '', changedAt: now, id: ++blockSeq };
        active.set(blk.key, st);
      }
      if (info.name) st.speaker = info.name;
      if (info.text !== st.tracker.text) st.changedAt = now;
      handle(st, st.tracker.update(info.text, now));
    });
    // blocks Meet really removed: flush whatever is left of them, keep the state a while in case it comes back
    vanished.forEach((st) => retire(st, now));
    refreshInterim();
  }

  // ---------- re-rendered blocks ----------
  const RETIRE_MS = 60000;
  const retired = []; // { st, t } states of blocks that left the page recently, newest last
  function retire(st, now) {
    handle(st, st.tracker.tick(now + 1e9));
    st.interim = '';
    retired.push({ st: st, t: now });
    while (retired.length > 12) retired.shift();
  }
  // `text` begins with a run of the old block's text (Meet re-rendered the same turn), not a new turn that only
  // starts alike ("This is item one…" / "This is item two…"): the first 8 words must all appear in order
  function continues(st, text) {
    const old = SEN.norm(st.tracker.text);
    const head = SEN.norm(text).split(' ').slice(0, 8).join(' ');
    return !!old && !!head && (' ' + old + ' ').indexOf(' ' + head + ' ') >= 0;
  }

  // Most recent state of the same speaker from `list` (vanished states or retired entries) that `text`
  // continues, removed from it.
  function takeState(list, name, text, now) {
    const who = SEN.norm(name);
    if (!who) return null;
    for (let i = list.length - 1; i >= 0; i--) {
      const it = list[i];
      const st = it.st || it;
      if (it.t && now - it.t > RETIRE_MS) continue;
      if (SEN.norm(st.speaker) === who && continues(st, text)) {
        list.splice(i, 1);
        return st;
      }
    }
    return null;
  }

  function scheduleScan() {
    if (!scanTimer) scanTimer = setTimeout(scan, SCAN_THROTTLE);
  }

  function refreshInterim() {
    let best = null;
    active.forEach((st) => {
      if (st.interim && (!best || st.changedAt >= best.changedAt)) best = st;
    });
    if (!best) {
      clearTimeout(interimTimer);
      interimPending = '';
      P.setInterim(null);
      return;
    }
    const en = best.interim;
    P.setInterim({ speaker: best.speaker, en: en, vi: best.interimVi && best.interimEn === en ? best.interimVi : '' });
    // draft translation of the growing tail: on-device translator only, debounced. Called every tick, so only
    // (re)start the timer when the text changed — otherwise it would never fire while someone keeps talking.
    if (best.interimEn === en || interimPending === en) return;
    clearTimeout(interimTimer);
    interimPending = en;
    interimTimer = setTimeout(async () => {
      interimPending = '';
      const vi = await LT.translateInterim(en);
      if (!vi || best.interim !== en) return;
      best.interimEn = en;
      best.interimVi = vi;
      P.setInterim({ speaker: best.speaker, en: en, vi: vi });
    }, INTERIM_DEBOUNCE);
  }

  function attach(c) {
    detach();
    container = c;
    contObs = new MutationObserver(scheduleScan);
    contObs.observe(c, { childList: true, characterData: true, subtree: true });
    scan();
  }

  function detach() {
    if (contObs) contObs.disconnect();
    contObs = null;
    if (container) {
      // Meet replaced the whole caption region: keep the states so the new region's blocks continue them
      const now = Date.now();
      active.forEach((st) => retire(st, now));
      active.clear();
      P.setInterim(null);
    }
    container = null;
  }

  // ---------- container / CC state ----------
  function ensureContainer() {
    bodyTimer = null;
    if (!alive()) return;
    if (!siteOn()) {
      if (container) detach();
      setPanel(false);
      return;
    }
    if (container && !container.isConnected) detach();
    if (!container) {
      const c = findContainer();
      if (c) attach(c);
    }
    updateHint();
  }

  function setPanel(on) {
    if (on === panelOn) return;
    panelOn = on;
    if (on) P.mount();
    else P.unmount();
  }

  function updateHint() {
    const cc = container ? 'on' : ccState();
    maybeAutoCC(cc);
    const inCall = !!container || cc !== 'none';
    let hint = null;
    if (!container && (cc === 'off' || cc === 'unknown' || cc === 'menu')) hint = HINT;
    // dub-only mode hides the panel, except when it has something to tell
    const show = inCall && (wantsSubs() || !!hint);
    setPanel(show);
    if (show) P.setHint(hint);
  }

  function tickIdle() {
    if (!alive() || !siteOn()) return;
    const now = Date.now();
    active.forEach((st) => handle(st, st.tracker.tick(now)));
    if (active.size) refreshInterim();
  }

  // ---------- settings ----------
  function applySettings(ns) {
    settings = ns;
    LT.configure(ns.provider === 'youtube' ? 'google' : ns.provider, SRC_LANG);
    P.applySettings(ns);
    D.configure(ns, (m) => P.status(m, 5000));
    D.setActive(siteOn() && wantsDub());
    if (!wantsDub()) D.cancel();
    ensureContainer();
  }

  S.onChanged((ns) => applySettings(ns));
  S.get().then((s) => {
    applySettings(s);
    ensureContainer();
  });

  const bodyObs = new MutationObserver(() => {
    if (!bodyTimer) bodyTimer = setTimeout(ensureContainer, 500);
  });
  bodyObs.observe(document.body || document.documentElement, { childList: true, subtree: true });
  const tickTimer = setInterval(tickIdle, TICK_MS);
  const pollTimer = setInterval(() => {
    if (alive()) ensureContainer();
    else shutdown();
  }, 1500);

  // The extension was reloaded or removed: this copy of the script can no longer translate or speak.
  // Stop observing Meet and remove the stale panel (the new version starts after the page is reloaded).
  function shutdown() {
    bodyObs.disconnect();
    if (contObs) contObs.disconnect();
    clearInterval(tickTimer);
    clearInterval(pollTimer);
    clearTimeout(bodyTimer);
    clearTimeout(scanTimer);
    clearTimeout(interimTimer);
    P.unmount();
  }
})();
