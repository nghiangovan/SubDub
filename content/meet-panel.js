/* Floating caption panel for Google Meet (ISOLATED world): bottom-centre, draggable, resizable, collapsible.
 * Each line: speaker (blue), ORIGINAL English line on top at full size, Vietnamese below at 0.85em in light blue
 * (same look as the YouTube overlay's .yvd-bilingual). History drawer with copy / download as .txt.
 * Pure DOM: it never touches Meet's own elements. */
(function (root) {
  'use strict';
  const YVD = (root.YVD = root.YVD || {});

  const MAX_SHOWN = 300; // lines kept in the panel list (scroll up to read older ones; History has all)
  const MAX_HISTORY = 20000; // whole-meeting transcript kept for History / export (a few MB at most)
  const NEAR_BOTTOM = 40; // px: within this of the bottom counts as "following the newest line"
  const STORE_KEY = 'meetPanel'; // chrome.storage.local: { left, top, width, height, collapsed }

  let panel = null;
  let listEl = null;
  let hintEl = null;
  let statusEl = null;
  let histEl = null;
  let histListEl = null;
  let jumpEl = null;
  let collapseBtn = null;
  let statusTimer = null;
  let saveTimer = null;
  let opts = { fontSize: 22, showOriginal: true };
  let pos = {}; // saved geometry
  const lines = []; // full history: { id, t, speaker, en, vi, pending, failed }
  let interim = null; // { speaker, en, vi }

  const alive = () => !!(YVD.settings && YVD.settings.alive && YVD.settings.alive());

  function storageGet() {
    return new Promise(function (res) {
      if (!alive()) return res({});
      try {
        root.chrome.storage.local.get(STORE_KEY, function (o) {
          void root.chrome.runtime.lastError;
          res((o && o[STORE_KEY]) || {});
        });
      } catch (e) {
        res({});
      }
    });
  }
  function storageSet(v) {
    if (!alive()) return;
    try {
      if (v) root.chrome.storage.local.set({ [STORE_KEY]: v }, function () { void root.chrome.runtime.lastError; });
      else root.chrome.storage.local.remove(STORE_KEY, function () { void root.chrome.runtime.lastError; });
    } catch (e) {}
  }
  function saveSoon() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      storageSet(pos);
    }, 300);
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function btn(label, title, onClick) {
    const b = el('button', 'yvd-m-btn', label);
    b.type = 'button';
    b.title = title;
    b.addEventListener('click', function (ev) {
      ev.stopPropagation();
      onClick(ev);
    });
    b.addEventListener('pointerdown', function (ev) {
      ev.stopPropagation(); // not a drag start
    });
    return b;
  }

  function build() {
    panel = el('div');
    panel.id = 'yvd-meet-panel';

    const head = el('div', 'yvd-m-head');
    head.appendChild(el('span', 'yvd-m-title', 'SubDub · Phụ đề Meet'));
    statusEl = el('span', 'yvd-m-status');
    head.appendChild(statusEl);
    const spacer = el('span', 'yvd-m-spacer');
    head.appendChild(spacer);
    head.appendChild(btn('Lịch sử', 'Xem toàn bộ cuộc họp', toggleHistory));
    collapseBtn = btn('–', 'Thu gọn / mở rộng', toggleCollapse);
    head.appendChild(collapseBtn);
    panel.appendChild(head);

    const body = el('div', 'yvd-m-body');
    hintEl = el('div', 'yvd-m-hint');
    hintEl.hidden = true;
    listEl = el('div', 'yvd-m-list');
    body.appendChild(hintEl);
    body.appendChild(listEl);
    jumpEl = btn('↓ Mới nhất', 'Xuống câu mới nhất', function () {
      listEl.scrollTop = listEl.scrollHeight;
      jumpEl.hidden = true;
    });
    jumpEl.classList.add('yvd-m-jump');
    jumpEl.hidden = true;
    body.appendChild(jumpEl);
    listEl.addEventListener('scroll', function () {
      if (atBottom(listEl)) jumpEl.hidden = true;
    });
    panel.appendChild(body);

    histEl = el('div', 'yvd-m-hist');
    histEl.hidden = true;
    const bar = el('div', 'yvd-m-histbar');
    bar.appendChild(btn('Sao chép', 'Sao chép toàn bộ bản ghi', copyHistory));
    bar.appendChild(btn('Tải .txt', 'Tải bản ghi về máy', downloadHistory));
    bar.appendChild(btn('Đóng', 'Đóng lịch sử', toggleHistory));
    histEl.appendChild(bar);
    histListEl = el('div', 'yvd-m-histlist');
    histEl.appendChild(histListEl);
    panel.appendChild(histEl);

    enableDrag(head);
    ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'].forEach(function (dir) {
      const g = el('div', 'yvd-m-grip yvd-m-grip-' + dir);
      enableResize(g, dir);
      panel.appendChild(g);
    });
  }

  // ---- resize from any edge or corner ----
  const MIN_W = 260;
  const MIN_H = 60;
  function enableResize(grip, dir) {
    grip.addEventListener('pointerdown', function (ev) {
      if (ev.button !== 0) return;
      ev.preventDefault();
      ev.stopPropagation();
      const r = panel.getBoundingClientRect();
      place(r.left, r.top); // pin to left/top so every edge can move independently
      const sx = ev.clientX;
      const sy = ev.clientY;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const maxH = vh * 0.9;
      try {
        grip.setPointerCapture(ev.pointerId);
      } catch (e) {}
      const move = function (e) {
        const dx = e.clientX - sx;
        const dy = e.clientY - sy;
        let left = r.left;
        let top = r.top;
        let w = r.width;
        let h = r.height;
        if (dir.indexOf('e') >= 0) w = Math.min(Math.max(MIN_W, r.width + dx), vw - r.left);
        if (dir.indexOf('w') >= 0) {
          w = Math.min(Math.max(MIN_W, r.width - dx), r.right);
          left = r.right - w;
        }
        if (dir.indexOf('s') >= 0) h = Math.min(Math.max(MIN_H, r.height + dy), maxH, vh - r.top);
        if (dir.indexOf('n') >= 0) {
          h = Math.min(Math.max(MIN_H, r.height - dy), maxH, r.bottom);
          top = r.bottom - h;
        }
        place(left, top);
        panel.style.width = Math.round(w) + 'px';
        panel.style.height = Math.round(h) + 'px';
      };
      const up = function () {
        grip.removeEventListener('pointermove', move);
        grip.removeEventListener('pointerup', up);
        grip.removeEventListener('pointercancel', up);
        const rr = panel.getBoundingClientRect();
        pos.left = Math.round(rr.left);
        pos.top = Math.round(rr.top);
        pos.width = Math.round(rr.width);
        pos.height = Math.round(rr.height);
        panel.dataset.userSized = '1';
        saveSoon();
      };
      grip.addEventListener('pointermove', move);
      grip.addEventListener('pointerup', up);
      grip.addEventListener('pointercancel', up);
    });
  }

  // ---- drag ----
  function enableDrag(handle) {
    handle.addEventListener('pointerdown', function (ev) {
      if (ev.button !== 0) return;
      const r = panel.getBoundingClientRect();
      const dx = ev.clientX - r.left;
      const dy = ev.clientY - r.top;
      try {
        handle.setPointerCapture(ev.pointerId);
      } catch (e) {}
      const move = function (e) {
        const w = panel.offsetWidth;
        const h = panel.offsetHeight;
        const left = Math.min(Math.max(0, e.clientX - dx), Math.max(0, window.innerWidth - Math.min(w, 80)));
        const top = Math.min(Math.max(0, e.clientY - dy), Math.max(0, window.innerHeight - Math.min(h, 40)));
        place(left, top);
      };
      const up = function () {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        handle.removeEventListener('pointercancel', up);
        const rr = panel.getBoundingClientRect();
        pos.left = Math.round(rr.left);
        pos.top = Math.round(rr.top);
        saveSoon();
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
      handle.addEventListener('pointercancel', up);
      ev.preventDefault();
    });
  }

  function place(left, top) {
    panel.classList.add('yvd-m-placed');
    panel.style.left = left + 'px';
    panel.style.top = top + 'px';
    panel.style.bottom = 'auto';
  }

  function applyGeometry() {
    if (!panel) return;
    panel.classList.remove('yvd-m-placed');
    panel.style.left = panel.style.top = panel.style.bottom = '';
    panel.style.width = panel.style.height = '';
    panel.dataset.userSized = '';
    if (typeof pos.left === 'number' && typeof pos.top === 'number') {
      place(Math.min(Math.max(0, pos.left), Math.max(0, window.innerWidth - 120)), Math.min(Math.max(0, pos.top), Math.max(0, window.innerHeight - 60)));
    }
    if (typeof pos.width === 'number') panel.style.width = Math.min(pos.width, window.innerWidth - 8) + 'px';
    if (typeof pos.height === 'number') panel.style.height = Math.min(pos.height, window.innerHeight - 8) + 'px';
    if (pos.width || pos.height) panel.dataset.userSized = '1';
    setCollapsed(!!pos.collapsed, true);
  }

  function setCollapsed(c, silent) {
    panel.classList.toggle('yvd-m-collapsed', !!c);
    collapseBtn.textContent = c ? '+' : '–';
    pos.collapsed = !!c;
    if (!silent) saveSoon();
  }
  function toggleCollapse() {
    setCollapsed(!panel.classList.contains('yvd-m-collapsed'));
  }
  function toggleHistory() {
    histEl.hidden = !histEl.hidden;
    if (!histEl.hidden) renderHistory();
  }

  // ---- history export ----
  const pad = (n) => (n < 10 ? '0' : '') + n;
  const clock = (t) => {
    const d = new Date(t);
    return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  };
  function historyText() {
    return lines
      .map(function (l) {
        return '[' + clock(l.t) + '] ' + (l.speaker || '?') + '\nEN: ' + l.en + '\nVI: ' + (l.vi || '') + '\n';
      })
      .join('\n');
  }
  function copyHistory() {
    copyText(historyText(), 'Đã sao chép bản ghi');
  }
  function copyText(text, msg) {
    const done = () => status(msg || 'Đã sao chép', 2000);
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, () => legacyCopy(text, done));
        return;
      }
    } catch (e) {}
    legacyCopy(text, done);
  }
  function legacyCopy(text, done) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      done();
    } catch (e) {
      status('Không sao chép được', 2500);
    }
    ta.remove();
  }
  function downloadHistory() {
    const blob = new Blob(['﻿' + historyText()], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const d = new Date();
    a.href = url;
    a.download = 'meet-' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes()) + '.txt';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  // ---- rendering ----
  function copyLine(tag, cls, text, what) {
    const e = el(tag, cls + ' yvd-m-copy', text);
    e.title = 'Bấm để sao chép ' + what;
    e.addEventListener('pointerdown', function (ev) {
      if (ev.button !== 0) return;
      ev.stopPropagation();
      copyText(text, 'Đã sao chép ' + what);
      e.classList.add('yvd-m-copied');
    });
    return e;
  }

  function entry(l, cls) {
    const e = el('div', 'yvd-m-entry' + (cls ? ' ' + cls : ''));
    if (l.speaker) e.appendChild(el('div', 'yvd-m-spk', l.speaker));
    const showEn = opts.showOriginal || !l.vi;
    const bilingual = showEn && !!l.vi;
    if (showEn) e.appendChild(copyLine('div', 'yvd-m-en', l.en, 'câu gốc'));
    if (l.vi) e.appendChild(copyLine('div', 'yvd-m-vi' + (bilingual ? ' yvd-m-bi' : ''), l.vi, 'bản dịch'));
    else if (l.pending) e.appendChild(el('div', 'yvd-m-vi yvd-m-wait', '…'));
    else if (l.failed) e.appendChild(el('div', 'yvd-m-vi yvd-m-wait', '(chưa dịch được)'));
    return e;
  }

  const atBottom = (box) => box.scrollHeight - box.scrollTop - box.clientHeight < NEAR_BOTTOM;

  // ---- incremental rendering ----
  // Lines are appended / patched in place (never the whole list), so a long meeting stays cheap, a text
  // selection or the "copied" highlight survives new captions, and scrolling is never interrupted.
  const shownEls = new Map(); // line id -> entry element in the panel list
  const histEls = new Map(); // line id -> row element in the history drawer
  let interimEl = null;
  let interimKey = '';
  let idleEl = null;

  // Run a DOM change on a scrollable box: keep following the newest line when the reader was at the bottom,
  // otherwise keep the text they are reading still. -> true when the reader is scrolled up
  function keepScroll(box, change) {
    const follow = atBottom(box);
    const top = box.scrollTop;
    const removed = change() || 0; // px removed above the viewport
    box.scrollTop = follow ? box.scrollHeight : Math.max(0, top - removed);
    return !follow;
  }

  // Remove the oldest elements of `map` beyond `max`; -> how far the remaining content moved up (px, margins
  // included), measured on the first element that stays
  function trimFront(map, max) {
    if (map.size <= max) return 0;
    const drop = [];
    const it = map.keys();
    while (map.size - drop.length > max) drop.push(it.next().value);
    const anchor = map.get(it.next().value);
    const y0 = anchor ? anchor.offsetTop : 0;
    drop.forEach(function (k) {
      map.get(k).remove();
      map.delete(k);
    });
    return anchor ? y0 - anchor.offsetTop : 0;
  }

  function lineById(id) {
    for (let i = lines.length - 1; i >= 0; i--) if (lines[i].id === id) return lines[i];
    return null;
  }

  function historyRow(l) {
    const row = el('div', 'yvd-m-hrow');
    row.appendChild(el('div', 'yvd-m-hmeta', '[' + clock(l.t) + '] ' + (l.speaker || '?')));
    row.appendChild(copyLine('div', 'yvd-m-hen', l.en, 'câu gốc'));
    if (l.vi) row.appendChild(copyLine('div', 'yvd-m-hvi', l.vi, 'bản dịch'));
    return row;
  }

  function updateIdle() {
    const show = !shownEls.size && !interimEl && hintEl.hidden;
    if (show && !idleEl) idleEl = listEl.appendChild(el('div', 'yvd-m-idle', 'Đang chờ phụ đề của cuộc họp…'));
    if (!show && idleEl) {
      idleEl.remove();
      idleEl = null;
    }
  }

  // Full rebuild: on mount and when a display option changes (show original on/off)
  function render() {
    if (!panel) return;
    keepScroll(listEl, function () {
      listEl.textContent = '';
      shownEls.clear();
      interimEl = idleEl = null;
      interimKey = '';
      lines.slice(-MAX_SHOWN).forEach(function (l) {
        const e = entry(l);
        shownEls.set(l.id, e);
        listEl.appendChild(e);
      });
      renderInterim();
      updateIdle();
    });
    if (!histEl.hidden) renderHistory();
  }

  function renderHistory() {
    keepScroll(histListEl, function () {
      histListEl.textContent = '';
      histEls.clear();
      lines.forEach(function (l) {
        const row = historyRow(l);
        histEls.set(l.id, row);
        histListEl.appendChild(row);
      });
    });
  }

  function renderInterim() {
    const key = interim ? interim.speaker + '|' + interim.en + '|' + (interim.vi || '') : '';
    if (key === interimKey && (!interim || interimEl)) return;
    interimKey = key;
    const next = interim ? entry(interim, 'yvd-m-interim') : null;
    if (interimEl && next) interimEl.replaceWith(next);
    else if (interimEl) interimEl.remove();
    else if (next) listEl.appendChild(next);
    interimEl = next;
  }

  function appendLine(l) {
    if (!panel) return;
    const held = keepScroll(listEl, function () {
      const e = entry(l);
      shownEls.set(l.id, e);
      listEl.insertBefore(e, interimEl || idleEl);
      updateIdle();
      return trimFront(shownEls, MAX_SHOWN);
    });
    if (held) jumpEl.hidden = false;
    if (!histEl.hidden) {
      keepScroll(histListEl, function () {
        const row = historyRow(l);
        histEls.set(l.id, row);
        histListEl.appendChild(row);
        return trimFront(histEls, lines.length);
      });
    }
  }

  function patchLine(l) {
    if (!panel) return;
    const e = shownEls.get(l.id);
    if (e) {
      keepScroll(listEl, function () {
        const ne = entry(l);
        e.replaceWith(ne);
        shownEls.set(l.id, ne);
      });
    }
    const r = histEls.get(l.id);
    if (r && !histEl.hidden) {
      keepScroll(histListEl, function () {
        const nr = historyRow(l);
        r.replaceWith(nr);
        histEls.set(l.id, nr);
      });
    }
  }

  function applyFont() {
    if (panel) panel.style.fontSize = Math.round(opts.fontSize * 0.8) + 'px';
  }

  // ---- public ----
  function mount() {
    if (!panel) build();
    if (!panel.isConnected) document.documentElement.appendChild(panel);
    applyFont();
    if (!panel.dataset.geo) {
      panel.dataset.geo = '1';
      storageGet().then(function (v) {
        pos = v || {};
        applyGeometry();
      });
    }
    render();
  }

  function unmount() {
    if (panel && panel.parentNode) panel.parentNode.removeChild(panel);
  }

  function applySettings(s) {
    const showOriginal = !!s.meetShowOriginal;
    const changed = showOriginal !== opts.showOriginal;
    opts = { fontSize: s.fontSize, showOriginal: showOriginal };
    applyFont();
    if (changed) render();
  }

  function setHint(text) {
    if (!hintEl) return;
    text = text || '';
    if (hintEl.textContent === text && hintEl.hidden === !text) return; // called every poll: no-op unless changed
    hintEl.textContent = text;
    hintEl.hidden = !text;
    updateIdle();
  }

  function status(text, ms) {
    if (!statusEl) return;
    statusEl.textContent = text || '';
    statusEl.classList.toggle('yvd-m-show', !!text);
    clearTimeout(statusTimer);
    if (text && ms !== 0) {
      statusTimer = setTimeout(function () {
        statusEl.classList.remove('yvd-m-show');
      }, ms || 3500);
    }
  }

  function addLine(l) {
    const line = Object.assign({ t: Date.now() }, l);
    lines.push(line);
    if (lines.length > MAX_HISTORY) lines.shift();
    appendLine(line);
  }
  function updateLine(id, patch) {
    const l = lineById(id);
    if (!l) return;
    Object.assign(l, patch);
    patchLine(l);
  }
  function setInterim(v) {
    interim = v && v.en ? v : null;
    if (!panel) return;
    keepScroll(listEl, function () {
      renderInterim();
      updateIdle();
    });
  }

  function resetPosition() {
    pos = {};
    applyGeometry();
  }

  // the popup's "reset panel position" button removes the stored geometry
  try {
    if (alive()) {
      root.chrome.storage.onChanged.addListener(function (ch, area) {
        if (area === 'local' && ch[STORE_KEY] && ch[STORE_KEY].newValue === undefined) resetPosition();
      });
    }
  } catch (e) {}
  window.addEventListener('resize', function () {
    if (panel && typeof pos.left === 'number') applyGeometry();
  });

  YVD.meetPanel = {
    mount: mount,
    unmount: unmount,
    applySettings: applySettings,
    setHint: setHint,
    status: status,
    addLine: addLine,
    updateLine: updateLine,
    setInterim: setInterim,
    resetPosition: resetPosition,
    historyText: historyText,
    get lines() {
      return lines;
    },
    get element() {
      return panel;
    }
  };
})(window);
