/* VieNeu guide page: live status box (same background ops as the popup: status / recheck / download). */
(function () {
  'use strict';
  const S = window.YVD.settings;
  const V = window.YVD.vieneu;
  const $ = (id) => document.getElementById(id);
  let timer = null;

  function render(r) {
    const d = V.describe(r);
    const el = $('vnStatus');
    el.textContent = d.text;
    el.className = 'status-line' + (d.level === 'ok' ? ' ok' : '');
    $('vnProgress').hidden = !(r && r.state === 'downloading');
    $('vnProgress').value = d.pct;
    $('vnDownload').hidden = !d.download;
    $('vnDownload').disabled = false;
    $('vnUse').hidden = d.level !== 'ok';
  }

  // Until the program is found, ask again from scratch every few seconds, so the box turns green by itself
  // as soon as the installer finishes.
  function poll(op) {
    clearTimeout(timer);
    chrome.runtime.sendMessage({ type: 'vieneu', op: op || 'status' }, (r) => {
      void chrome.runtime.lastError;
      const ok = r && r.ok;
      render(ok ? r : { state: 'error', error: 'không kết nối được với nền của tiện ích' });
      const st = ok ? r.state : 'error';
      const next = st === 'ready' ? ['status', 5000] : st === 'loading' || st === 'downloading' || !st ? ['status', 700] : ['recheck', 4000];
      timer = setTimeout(() => poll(next[0]), next[1]);
    });
  }

  $('vnRecheck').addEventListener('click', () => {
    $('vnStatus').textContent = 'VieNeu: đang kiểm tra…';
    poll('recheck');
  });
  $('vnDownload').addEventListener('click', () => {
    $('vnDownload').disabled = true;
    chrome.runtime.sendMessage({ type: 'vieneu', op: 'download' }, () => {
      void chrome.runtime.lastError;
      poll('status');
    });
  });
  $('vnUse').addEventListener('click', async () => {
    await S.set({ ttsEngine: 'vieneu' });
    $('vnUse').hidden = true;
    $('vnUseNote').hidden = false;
  });
  poll('recheck');
})();
