(function () {
  'use strict';
  const S = window.YVD.settings;
  const $ = (id) => document.getElementById(id);

  function flash(text) {
    $('msg').textContent = text;
    setTimeout(() => ($('msg').textContent = ''), 2000);
  }

  function fillVoices(current) {
    const sel = $('ttsVoice');
    const voices = (window.speechSynthesis ? speechSynthesis.getVoices() : []).filter((v) => /^vi/i.test(v.lang));
    // natural (Edge) voices first: they are the best free Vietnamese voices
    voices.sort((a, b) => S.isNaturalVoice(b) - S.isNaturalVoice(a));
    const best = S.bestVoice(voices, '');
    sel.textContent = '';
    const auto = document.createElement('option');
    auto.value = '';
    auto.textContent = best ? 'Tự động: ' + shortName(best) : 'Tự động';
    sel.appendChild(auto);
    voices.forEach((v) => {
      const o = document.createElement('option');
      o.value = v.voiceURI;
      o.textContent = shortName(v) + (S.isNaturalVoice(v) ? ' ★ tự nhiên' : '');
      sel.appendChild(o);
    });
    sel.value = voices.some((v) => v.voiceURI === current) ? current : '';
    hasVoices = voices.length > 0;
    hasNatural = voices.some(S.isNaturalVoice);
    updateEngineUi();
  }

  let hasVoices = false;
  let hasNatural = false;
  // "Microsoft HoaiMy Online (Natural) - Vietnamese (Vietnam)" -> "HoaiMy (nữ)"
  const GENDER = { hoaimy: 'nữ', namminh: 'nam', an: 'nữ' };
  function shortName(v) {
    const n = v.name || '';
    const m = n.match(/^Microsoft\s+(\S+)/i);
    if (!m) return n;
    const g = GENDER[m[1].toLowerCase()];
    return m[1] + (g ? ' (' + g + ')' : '');
  }
  function updateEngineUi() {
    const eng = $('ttsEngine').value;
    $('voiceBox').hidden = !(eng === 'auto' || eng === 'system');
    let hint = '';
    if (eng === 'google') hint = 'Google Translate TTS: không chính thức, có thể bị giới hạn tần suất; nếu bị chặn sẽ chuyển sang giọng offline (nếu đã tải).';
    else if (eng === 'piper') hint = 'Giọng Piper tiếng Việt chạy hoàn toàn trên máy: không cần mạng, không giới hạn. Cần tải 1 lần.';
    else if (eng === 'system' && !hasVoices) hint = 'Không tìm thấy giọng tiếng Việt trên hệ thống: dùng giọng offline (nếu đã tải) hoặc chrome.tts.';
    else if (eng === 'auto' && !hasVoices) hint = 'Máy chưa có giọng tiếng Việt: dùng Google Translate, tự chuyển sang giọng offline khi Google lỗi. Mẹo: cài giọng tiếng Việt của Windows (Settings → Time & language → Speech → Add voices) để có giọng dự phòng tức thì, không cần tải.';
    else if (eng === 'auto' && hasVoices && !hasNatural) hint = 'Đọc bằng Google Translate. Khi Google tạm chặn sẽ chuyển ngay sang giọng có sẵn của máy (ô trên), không cần tải gì. Chọn "Giọng hệ thống" nếu muốn luôn dùng giọng của máy.';
    else if ((eng === 'auto' || eng === 'system') && hasNatural) hint = 'Đang dùng giọng Microsoft Natural của Edge (HoaiMy/NamMinh): tự nhiên, miễn phí, cần mạng. Chọn giọng khác ở ô trên nếu muốn.';
    $('voiceHint').textContent = hint;
  }

  // ---------- on-device translator (Chrome Translator API) ----------
  const T = typeof Translator !== 'undefined' ? Translator : undefined;
  let trPairs = []; // [{lang, av}]
  async function refreshTranslator() {
    let tabLang = null;
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab && tab.id != null) {
        const st = await new Promise((res) => chrome.tabs.sendMessage(tab.id, { type: 'yvdState' }, (r) => {
          void chrome.runtime.lastError;
          res(r);
        }));
        if (st && st.srcLang) tabLang = st.srcLang;
      }
    } catch (e) {}
    const langs = ['en'];
    if (tabLang && langs.indexOf(tabLang) < 0) langs.push(tabLang);
    if (!T) {
      trPairs = [];
      $('trStatus').textContent = 'Chrome này không có Translator API (cần Chrome 138+ trên máy tính): sẽ dùng Google Dịch.';
      $('trStatus').className = 'hint';
      $('trBox').hidden = true;
      return;
    }
    trPairs = [];
    for (const lang of langs) {
      let av = 'unavailable';
      try {
        av = await T.availability({ sourceLanguage: lang, targetLanguage: 'vi' });
      } catch (e) {}
      trPairs.push({ lang, av });
    }
    const label = (p) => p.lang + '→vi';
    const need = trPairs.filter((p) => p.av === 'downloadable' || p.av === 'downloading');
    const ok = trPairs.filter((p) => p.av === 'available');
    const bad = trPairs.filter((p) => p.av === 'unavailable');
    const parts = [];
    if (ok.length) parts.push('Sẵn sàng (offline): ' + ok.map(label).join(', '));
    if (need.length) parts.push((need.some((p) => p.av === 'downloading') ? 'Đang tải: ' : 'Chưa tải: ') + need.map(label).join(', '));
    if (bad.length) parts.push('Chrome không hỗ trợ: ' + bad.map(label).join(', '));
    $('trStatus').textContent = 'Bộ dịch trên máy — ' + parts.join(' · ');
    $('trStatus').className = need.length ? 'hint' : 'hint ok';
    $('trBox').hidden = need.length === 0;
    $('trDownload').disabled = trBusy;
  }

  let trBusy = false;
  function downloadTranslator() {
    const todo = trPairs.filter((p) => p.av === 'downloadable' || p.av === 'downloading');
    if (!T || !todo.length || trBusy) return;
    trBusy = true;
    $('trDownload').disabled = true;
    $('trProgress').hidden = false;
    $('trProgress').value = 0;
    const frac = todo.map(() => 0);
    // all create() calls start inside the click handler (the user gesture is only valid for a few seconds)
    Promise.all(
      todo.map((p, i) =>
        window.YVD.localTranslate.downloadPair(T, p.lang, 'vi', (f) => {
          frac[i] = f;
          $('trProgress').value = Math.round((frac.reduce((a, b) => a + b, 0) / frac.length) * 100);
        })
      )
    )
      .then(() => flash('Đã tải bộ dịch offline'))
      .catch((e) => {
        $('trStatus').textContent = 'Không tải được bộ dịch: ' + String((e && e.message) || e);
      })
      .finally(() => {
        trBusy = false;
        $('trProgress').hidden = true;
        refreshTranslator();
      });
  }

  // ---------- offline voice (Piper) ----------
  let piperTimer = null;
  const mb = (n) => (n / 1048576).toFixed(0);
  function renderPiper(r) {
    const st = $('piperStatus');
    const btn = $('piperDownload');
    const bar = $('piperProgress');
    st.className = 'hint';
    if (!r) {
      st.textContent = 'Giọng offline: không đọc được trạng thái.';
      return;
    }
    if (r.ready) {
      st.textContent = 'Giọng offline (Piper): đã tải, sẵn sàng dùng không cần mạng.';
      st.className = 'hint ok';
      $('piperBox').hidden = true;
      bar.hidden = true;
      return;
    }
    $('piperBox').hidden = false;
    if (r.state === 'downloading') {
      const pct = r.total ? Math.min(100, Math.round((r.loaded / r.total) * 100)) : 0;
      st.textContent = 'Đang tải giọng offline: ' + mb(r.loaded) + ' / ' + mb(r.total) + ' MB (' + pct + '%). Có thể đóng popup, việc tải vẫn tiếp tục.';
      bar.hidden = false;
      bar.value = pct;
      btn.disabled = true;
    } else {
      st.textContent = r.state === 'error' ? 'Tải giọng offline lỗi (' + r.error + '). Bấm để thử lại.' : 'Giọng offline (Piper): chưa tải.';
      bar.hidden = true;
      btn.disabled = false;
    }
  }
  function pollPiper() {
    clearTimeout(piperTimer);
    chrome.runtime.sendMessage({ type: 'piper', op: 'status' }, (r) => {
      void chrome.runtime.lastError;
      renderPiper(r && r.ok ? r : null);
      if (r && r.ok && !r.ready && r.state === 'downloading') piperTimer = setTimeout(pollPiper, 500);
    });
  }
  function downloadPiper() {
    $('piperDownload').disabled = true;
    chrome.runtime.sendMessage({ type: 'piper', op: 'download' }, () => {
      void chrome.runtime.lastError;
      pollPiper();
    });
  }

  function showValues(s) {
    $('ttsRateVal').textContent = s.ttsRate.toFixed(2) + 'x';
    $('dubVolumeVal').textContent = Math.round(s.dubVolume * 100) + '%';
    $('duckLevelVal').textContent = Math.round(s.duckLevel * 100) + '%';
    $('fontSizeVal').textContent = s.fontSize + 'px';
    $('subBgOpacityVal').textContent = Math.round(s.subBgOpacity * 100) + '%';
    $('ttsMaxRateVal').textContent = s.ttsMaxRate.toFixed(1) + 'x';
    $('dubMaxSpeedVal').textContent = s.dubMaxSpeed + 'x';
  }

  async function init() {
    const s = await S.get();
    $('enabled').checked = s.enabled;
    document.querySelectorAll('input[name="mode"]').forEach((r) => (r.checked = r.value === s.mode));
    $('showOriginal').checked = s.showOriginal;
    $('siteYoutube').checked = s.siteYoutube;
    $('siteMeet').checked = s.siteMeet;
    $('meetAutoCC').checked = s.meetAutoCC;
    $('meetShowOriginal').checked = s.meetShowOriginal;
    $('meetSkipSelf').checked = s.meetSkipSelf;
    $('provider').value = s.provider;
    $('ttsEngine').value = s.ttsEngine;
    $('claudeModel').value = s.claudeModel;
    $('ttsRate').value = s.ttsRate;
    $('duckLevel').value = s.duckLevel;
    $('dubVolume').value = s.dubVolume;
    $('fontSize').value = s.fontSize;
    $('subBgOpacity').value = s.subBgOpacity;
    $('ttsMaxRate').value = s.ttsMaxRate;
    $('dubMaxSpeed').value = s.dubMaxSpeed;
    $('concise').checked = s.concise;
    $('claudeBox').hidden = s.provider !== 'claude';
    showValues(s);
    $('trDownload').addEventListener('click', downloadTranslator);
    $('piperDownload').addEventListener('click', downloadPiper);
    refreshTranslator();
    pollPiper();
    fillVoices(s.ttsVoice);
    if (window.speechSynthesis) speechSynthesis.addEventListener('voiceschanged', () => fillVoices($('ttsVoice').value || s.ttsVoice));
    if (await S.getApiKey()) $('claudeKey').placeholder = 'Đã lưu (nhập để thay)';

    $('enabled').addEventListener('change', (e) => S.set({ enabled: e.target.checked }));
    document.querySelectorAll('input[name="mode"]').forEach((r) => r.addEventListener('change', () => r.checked && S.set({ mode: r.value })));
    $('showOriginal').addEventListener('change', (e) => S.set({ showOriginal: e.target.checked }));
    $('siteYoutube').addEventListener('change', (e) => S.set({ siteYoutube: e.target.checked }));
    $('siteMeet').addEventListener('change', (e) => S.set({ siteMeet: e.target.checked }));
    $('meetAutoCC').addEventListener('change', (e) => S.set({ meetAutoCC: e.target.checked }));
    $('meetShowOriginal').addEventListener('change', (e) => S.set({ meetShowOriginal: e.target.checked }));
    $('meetSkipSelf').addEventListener('change', (e) => S.set({ meetSkipSelf: e.target.checked }));
    $('meetResetPos').addEventListener('click', () => {
      chrome.storage.local.remove('meetPanel', () => {
        void chrome.runtime.lastError;
        flash('Đã đặt lại vị trí bảng');
      });
    });
    $('ytResetPos').addEventListener('click', () => {
      chrome.storage.local.remove('ytOverlayPos', () => {
        void chrome.runtime.lastError;
        flash('Đã đặt lại vị trí phụ đề');
      });
    });
    $('provider').addEventListener('change', (e) => {
      $('claudeBox').hidden = e.target.value !== 'claude';
      S.set({ provider: e.target.value });
    });
    $('claudeModel').addEventListener('change', (e) => S.set({ claudeModel: e.target.value.trim() || S.DEFAULTS.claudeModel }));
    $('claudeKey').addEventListener('change', async (e) => {
      await S.setApiKey(e.target.value);
      e.target.value = '';
      e.target.placeholder = 'Đã lưu (nhập để thay)';
      flash('Đã lưu khoá API');
    });
    $('concise').addEventListener('change', (e) => S.set({ concise: e.target.checked }));
    $('ttsEngine').addEventListener('change', (e) => {
      updateEngineUi();
      S.set({ ttsEngine: e.target.value });
    });
    $('ttsVoice').addEventListener('change', (e) => S.set({ ttsVoice: e.target.value }));
    // Sliders: the label follows the drag live; storage.sync (quota 120 writes/min) is written once per gesture
    // ('change' on release/key step) with a 300 ms debounce on 'input' as the live-ish path while dragging.
    [['ttsRate', 'ttsRate'], ['duckLevel', 'duckLevel'], ['dubVolume', 'dubVolume'], ['fontSize', 'fontSize'], ['subBgOpacity', 'subBgOpacity'], ['ttsMaxRate', 'ttsMaxRate'], ['dubMaxSpeed', 'dubMaxSpeed']].forEach(([id, key]) => {
      let timer = null;
      $(id).addEventListener('input', (e) => {
        const v = parseFloat(e.target.value);
        showValues(Object.assign({}, S.normalize({}), { ttsRate: parseFloat($('ttsRate').value), duckLevel: parseFloat($('duckLevel').value), dubVolume: parseFloat($('dubVolume').value), fontSize: parseFloat($('fontSize').value), subBgOpacity: parseFloat($('subBgOpacity').value), ttsMaxRate: parseFloat($('ttsMaxRate').value), dubMaxSpeed: parseFloat($('dubMaxSpeed').value) }));
        clearTimeout(timer);
        timer = setTimeout(() => S.set({ [key]: v }), 300);
      });
      $(id).addEventListener('change', (e) => {
        clearTimeout(timer);
        S.set({ [key]: parseFloat(e.target.value) });
      });
    });
    // keep the slider in sync when the volume is changed by the keyboard shortcut on the YouTube page
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync' || !changes.dubVolume) return;
      const v = S.normalize({ dubVolume: changes.dubVolume.newValue }).dubVolume;
      if (parseFloat($('dubVolume').value) !== v) $('dubVolume').value = v;
      $('dubVolumeVal').textContent = Math.round(v * 100) + '%';
    });
    $('clearCache').addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'clearCache' }, () => {
        void chrome.runtime.lastError;
        flash('Đã xoá cache');
      });
    });
  }
  init();
})();
