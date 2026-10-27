/* Subtitle overlay + status pill inside #movie_player. The lines can be dragged to a new spot (saved per browser
   in chrome.storage.local 'ytOverlayPos' as fractions of the player, so it survives fullscreen/resizes);
   double-click puts them back at the default bottom-centre position. */
(function (root) {
  'use strict';
  const YVD = (root.YVD = root.YVD || {});

  let player = null;
  let box = null;
  let viEl = null;
  let srcEl = null;
  let statusEl = null;
  let statusTimer = null;
  let fontSize = 22;
  let visible = true; // false in dub-only mode
  let resizeObs = null;
  let bgOpacity = 0.75;
  let pos = null; // { x: centre as fraction of player width, y: bottom edge as fraction of player height } | null = default
  const POS_KEY = 'ytOverlayPos';
  let posListening = false;

  function build() {
    box = document.createElement('div');
    box.id = 'yvd-overlay';
    const r1 = document.createElement('div');
    r1.className = 'yvd-row';
    viEl = document.createElement('span');
    viEl.className = 'yvd-line yvd-vi';
    r1.appendChild(viEl);
    const r2 = document.createElement('div');
    r2.className = 'yvd-row';
    srcEl = document.createElement('span');
    srcEl.className = 'yvd-line yvd-src';
    r2.appendChild(srcEl);
    // original line on top, translation below
    box.appendChild(r2);
    box.appendChild(r1);
    statusEl = document.createElement('div');
    statusEl.id = 'yvd-status';
    hideLines();
    enableDrag();
    applyBg();
    loadPos();
  }

  function clamp(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v));
  }

  function applyPos() {
    if (!box) return;
    box.style.left = pos ? pos.x * 100 + '%' : '';
    box.style.bottom = pos ? (1 - pos.y) * 100 + '%' : '';
  }

  function storage() {
    try {
      return root.chrome && root.chrome.runtime && root.chrome.runtime.id ? root.chrome.storage.local : null;
    } catch (e) {
      return null; // extension reloaded: this content script is orphaned
    }
  }

  function validPos(v) {
    return v && isFinite(v.x) && isFinite(v.y) ? { x: clamp(v.x, 0, 1), y: clamp(v.y, 0, 1) } : null;
  }

  function loadPos() {
    const st = storage();
    if (!st) return;
    st.get(POS_KEY, function (o) {
      void root.chrome.runtime.lastError;
      pos = validPos(o && o[POS_KEY]);
      applyPos();
    });
    if (posListening) return;
    posListening = true;
    root.chrome.storage.onChanged.addListener(function (ch, area) {
      if (area !== 'local' || !ch[POS_KEY]) return;
      pos = validPos(ch[POS_KEY].newValue);
      applyPos();
    });
  }

  function savePos() {
    const st = storage();
    if (!st) return;
    if (pos) st.set({ [POS_KEY]: pos }, function () { void root.chrome.runtime.lastError; });
    else st.remove(POS_KEY, function () { void root.chrome.runtime.lastError; });
  }

  function enableDrag() {
    // keep clicks on the subtitles from pausing (click) or going fullscreen (dblclick) in YouTube's player
    ['click', 'mousedown', 'mouseup', 'pointerup', 'touchstart'].forEach(function (t) {
      box.addEventListener(t, function (e) { e.stopPropagation(); });
    });
    box.addEventListener('dblclick', function (e) {
      e.stopPropagation();
      e.preventDefault();
      pos = null;
      applyPos();
      savePos();
    });
    box.addEventListener('pointerdown', function (e) {
      if (e.button !== 0 || !player) return;
      e.stopPropagation();
      e.preventDefault();
      const pr = player.getBoundingClientRect();
      const br = box.getBoundingClientRect();
      if (!pr.width || !pr.height) return;
      const sx = e.clientX;
      const sy = e.clientY;
      const x0 = (br.left + br.width / 2 - pr.left) / pr.width;
      const y0 = (br.bottom - pr.top) / pr.height;
      const minY = Math.min(1, br.height / pr.height);
      const halfW = Math.min(0.5, br.width / 2 / pr.width); // keep the whole box inside the player
      let moved = false;
      function move(ev) {
        const dx = ev.clientX - sx;
        const dy = ev.clientY - sy;
        if (!moved && Math.abs(dx) + Math.abs(dy) < 4) return; // a plain click, not a drag
        if (!moved) box.classList.add('yvd-dragging');
        moved = true;
        pos = { x: clamp(x0 + dx / pr.width, halfW, 1 - halfW), y: clamp(y0 + dy / pr.height, minY, 1) };
        applyPos();
      }
      function up() {
        document.removeEventListener('pointermove', move, true);
        document.removeEventListener('pointerup', up, true);
        document.removeEventListener('pointercancel', up, true);
        box.classList.remove('yvd-dragging');
        if (moved) savePos();
      }
      document.addEventListener('pointermove', move, true);
      document.addEventListener('pointerup', up, true);
      document.addEventListener('pointercancel', up, true);
    });
    box.title = 'Kéo để di chuyển phụ đề · nhấp đúp để đưa về chỗ cũ';
  }

  function applyBg() {
    if (box) box.style.setProperty('--yvd-bg', String(bgOpacity));
  }

  function hideLines() {
    viEl.textContent = '';
    srcEl.textContent = '';
    viEl.style.display = 'none';
    srcEl.style.display = 'none';
  }

  function applySize() {
    if (!box || !player) return;
    const h = player.clientHeight || 540;
    const full = !!document.fullscreenElement;
    const scale = full ? Math.min(2.5, Math.max(1, h / 540)) : 1;
    box.style.fontSize = Math.round(fontSize * scale) + 'px';
  }

  function attach(p) {
    if (!p) return;
    if (!box) build();
    if (player !== p) {
      if (resizeObs) resizeObs.disconnect();
      player = p;
      if (typeof ResizeObserver !== 'undefined') {
        resizeObs = new ResizeObserver(applySize);
        resizeObs.observe(p);
      }
    }
    if (box.parentNode !== p) p.appendChild(box);
    if (statusEl.parentNode !== p) p.appendChild(statusEl);
    applySize();
  }

  function setCue(cue, opts) {
    if (!box) return;
    if (!cue || !visible) return hideLines();
    const vi = cue.vi || '';
    const src = opts && opts.showOriginal ? cue.text || '' : !vi ? cue.text || '' : '';
    viEl.textContent = vi;
    srcEl.textContent = src;
    viEl.style.display = vi ? '' : 'none';
    srcEl.style.display = src ? '' : 'none';
    box.classList.toggle('yvd-bilingual', !!(vi && src));
  }

  function clear() {
    if (box) hideLines();
  }

  function status(text, autohideMs) {
    if (!statusEl) return;
    statusEl.textContent = text || '';
    statusEl.classList.toggle('yvd-show', !!text);
    clearTimeout(statusTimer);
    if (text && autohideMs !== 0) {
      statusTimer = setTimeout(function () {
        statusEl.classList.remove('yvd-show');
      }, autohideMs || 3000);
    }
  }

  function applySettings(s) {
    fontSize = s.fontSize;
    if (isFinite(s.subBgOpacity)) bgOpacity = s.subBgOpacity;
    applyBg();
    visible = s.mode !== 'dub';
    if (!visible) clear();
    applySize();
  }

  function setHidden(hidden) {
    if (box) box.style.display = hidden ? 'none' : '';
  }

  function destroy() {
    if (resizeObs) resizeObs.disconnect();
    if (box && box.parentNode) box.parentNode.removeChild(box);
    if (statusEl && statusEl.parentNode) statusEl.parentNode.removeChild(statusEl);
    box = statusEl = player = null;
  }

  function isAttached() {
    return !!(box && box.isConnected);
  }

  YVD.overlay = { attach: attach, setCue: setCue, clear: clear, status: status, applySettings: applySettings, setHidden: setHidden, destroy: destroy, isAttached: isAttached, applySize: applySize };
})(window);
