/* Helpers shared by the popup and the VieNeu guide page: voice list + labels and the status text for each state of
 * the optional local VieNeu voice (state comes from background: op 'status'). Pure, no DOM. */
(function (root) {
  'use strict';
  const YVD = (root.YVD = root.YVD || {});

  // The 11 presets of the model; the real list (with descriptions) comes from the program's hello once it runs.
  const FALLBACK_VOICES = [
    { name: 'Trúc Ly', description: 'Nữ · Bắc · Phong cách tự nhiên' },
    { name: 'Mai Anh', description: 'Nữ · Bắc · Phong cách tin tức' },
    { name: 'Xuân Tiên', description: 'Nữ · Bắc · Phong cách tin tức' },
    { name: 'Mỹ Duyên', description: 'Nữ · Bắc · Phong cách đọc truyện' },
    { name: 'Ái Hân', description: 'Nữ · Nam · Phong cách tin tức' },
    { name: 'Minh Quân', description: 'Nam · Bắc · Phong cách tự nhiên' },
    { name: 'Mạnh Dũng', description: 'Nam · Bắc · Phong cách tự nhiên' },
    { name: 'Hữu Quân', description: 'Nam · Bắc · Phong cách tin tức' },
    { name: 'Đức Trí', description: 'Nam · Bắc · Phong cách đọc truyện' },
    { name: 'Anh Khôi', description: 'Nam · Bắc · Phong cách kể chuyện' },
    { name: 'Adam', description: 'Nam · Nam · Giọng đọc tự nhiên' }
  ];

  // "Trúc Ly (Nữ, miền Bắc)" from the description "Nữ · Bắc · Phong cách tự nhiên" (gender · region · style).
  function voiceLabel(v) {
    const parts = String(v.description || '')
      .split('·')
      .map(function (x) {
        return x.trim();
      })
      .filter(Boolean);
    const gender = parts[0] || (v.gender === 'male' ? 'Nam' : v.gender === 'female' ? 'Nữ' : '');
    const region = parts[1] ? 'miền ' + parts[1] : '';
    const info = [gender, region].filter(Boolean).join(', ');
    return info ? v.name + ' (' + info + ')' : v.name;
  }

  // Voices to offer: the program's list when it sent one, else the static one.
  function voiceList(fromHost) {
    return Array.isArray(fromHost) && fromHost.length ? fromHost : FALLBACK_VOICES;
  }

  // -> { text, level: 'ok' | 'wait' | 'bad' | '', pct, guide, download } for a status reply { state, progress, error }
  function describe(r) {
    const st = (r && r.state) || '';
    const pct = Math.max(0, Math.min(100, Math.round(((r && r.progress) || 0) * 100)));
    switch (st) {
      case 'ready':
        return { text: 'VieNeu: sẵn sàng ✓', level: 'ok', pct: 100, guide: false, download: false };
      case 'idle': // installed and fine; the program loads the model only when dubbing starts
        return { text: 'VieNeu: sẵn sàng ✓ (tự bật khi lồng tiếng)', level: 'ok', pct: 100, guide: false, download: false };
      case 'low-memory':
        return { text: 'VieNeu: máy đang thiếu RAM, tạm dùng Google', level: 'bad', pct: 0, guide: false, download: false };
      case 'too-slow':
        return { text: 'VieNeu: máy hơi yếu cho VieNeu, tạm dùng Google', level: 'bad', pct: 0, guide: false, download: false };
      case 'loading':
        return { text: 'VieNeu: đang khởi động…', level: 'wait', pct: 0, guide: false, download: false };
      case 'downloading':
        return { text: 'VieNeu: đang tải mô hình ' + pct + '%', level: 'wait', pct: pct, guide: false, download: false };
      case 'missing':
        return { text: 'VieNeu: chưa tải mô hình', level: 'bad', pct: 0, guide: true, download: true };
      case 'error':
        return { text: 'VieNeu: lỗi: ' + String((r && r.error) || 'không rõ nguyên nhân'), level: 'bad', pct: 0, guide: true, download: false };
      case 'not-installed':
        return { text: 'VieNeu: chưa cài', level: 'bad', pct: 0, guide: true, download: false };
      default:
        return { text: 'VieNeu: đang kiểm tra…', level: 'wait', pct: 0, guide: false, download: false };
    }
  }

  YVD.vieneu = { FALLBACK_VOICES: FALLBACK_VOICES, voiceLabel: voiceLabel, voiceList: voiceList, describe: describe };
  if (typeof module !== 'undefined' && module.exports) module.exports = YVD.vieneu;
})(typeof window !== 'undefined' ? window : globalThis);
