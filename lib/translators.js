/* Translation providers (used by background.js via importScripts). Pure helpers exported for Node tests. */
(function (root) {
  'use strict';
  const YVD = (root.YVD = root.YVD || {});

  const sleep = function (ms) {
    return new Promise(function (r) {
      setTimeout(r, ms);
    });
  };
  const oneLine = function (s) {
    return String(s).replace(/\s*[\r\n]+\s*/g, ' ').trim();
  };

  // Split texts into contiguous batches joined with '\n', each <= maxChars (a single oversize text is truncated).
  function buildBatches(texts, maxChars) {
    const max = maxChars || 2000;
    const batches = [];
    let from = 0;
    let lines = [];
    let size = 0;
    const flush = function (to) {
      if (lines.length) batches.push({ from: from, to: to, q: lines.join('\n') });
      lines = [];
      size = 0;
      from = to;
    };
    for (let i = 0; i < texts.length; i++) {
      let t = oneLine(texts[i]);
      if (t.length > max) t = t.slice(0, max);
      const add = t.length + (lines.length ? 1 : 0);
      if (lines.length && size + add > max) flush(i);
      lines.push(t);
      size += t.length + (lines.length > 1 ? 1 : 0);
    }
    flush(texts.length);
    return batches;
  }

  // Concatenate the translated chunks of a gtx response: data[0][i][0]
  function parseGoogleResponse(data) {
    if (!data || !Array.isArray(data[0])) return '';
    return data[0]
      .map(function (c) {
        return c && typeof c[0] === 'string' ? c[0] : '';
      })
      .join('');
  }

  // Split translated text back into `count` lines; null on mismatch.
  function splitBatch(joined, count) {
    const lines = String(joined).split('\n');
    if (lines.length === count + 1 && lines[lines.length - 1].trim() === '') lines.pop();
    if (lines.length !== count) return null;
    return lines.map(function (l) {
      return l.trim();
    });
  }

  // Extract a JSON string array of length n from a model reply; null if invalid.
  function parseClaudeArray(text, n) {
    const s = String(text || '');
    const a = s.indexOf('[');
    const b = s.lastIndexOf(']');
    if (a < 0 || b <= a) return null;
    try {
      const arr = JSON.parse(s.slice(a, b + 1));
      if (!Array.isArray(arr) || arr.length !== n) return null;
      if (!arr.every(function (x) { return typeof x === 'string'; })) return null;
      return arr.map(function (x) {
        return x.trim();
      });
    } catch (e) {
      return null;
    }
  }

  function createLimiter(max) {
    let active = 0;
    const queue = [];
    const next = function () {
      if (active >= max || !queue.length) return;
      active++;
      const job = queue.shift();
      job.fn().then(job.res, job.rej).finally(function () {
        active--;
        next();
      });
    };
    return function (fn) {
      return new Promise(function (res, rej) {
        queue.push({ fn: fn, res: res, rej: rej });
        next();
      });
    };
  }

  const limit = createLimiter(3);

  async function fetchRetry(url, init, tries) {
    let lastStatus = 0;
    for (let i = 0; i < (tries || 4); i++) {
      const res = await fetch(url, init);
      if (res.ok) return res;
      lastStatus = res.status;
      if (res.status !== 429 && res.status < 500) break;
      await sleep(800 * Math.pow(2, i) + Math.random() * 300);
    }
    const err = new Error('HTTP ' + lastStatus);
    err.status = lastStatus;
    throw err;
  }

  // A 4xx other than 429 (e.g. 400/413/414 for an over-long batch URL) may still work with smaller requests.
  const isSizeError = function (e) {
    return !!(e && e.status >= 400 && e.status < 500 && e.status !== 429 && e.status !== 408);
  };

  async function googleRequest(q) {
    const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=vi&dt=t&q=' + encodeURIComponent(q);
    return limit(async function () {
      const res = await fetchRetry(url, {}, 2); // fail fast: the caller's router handles cooldown/failover
      return parseGoogleResponse(await res.json());
    });
  }

  async function translateGoogle(texts) {
    const out = new Array(texts.length).fill('');
    // GET request: keep the encoded query well under URL length limits
    const batches = buildBatches(texts, 2000);
    await Promise.all(
      batches.map(async function (b) {
        const count = b.to - b.from;
        let joined = null;
        try {
          joined = await googleRequest(b.q);
        } catch (e) {
          // 429/5xx/network: fail the whole batch fast (left empty -> 'failed') so the router can cool down / fail over
          if (!isSizeError(e)) return;
        }
        let lines = joined == null ? null : splitBatch(joined, count);
        if (!lines) {
          // line count mismatch (or a request-size error): per-segment fallback; stop after the first request error
          lines = [];
          let broken = false;
          for (let i = b.from; i < b.to; i++) {
            let t = '';
            if (!broken) {
              try {
                t = (await googleRequest(oneLine(texts[i]))).replace(/\n/g, ' ').trim();
              } catch (e) {
                broken = true;
              }
            }
            lines.push(t);
          }
        }
        for (let i = 0; i < count; i++) out[b.from + i] = lines[i];
      })
    );
    return out;
  }

  const CLAUDE_SYSTEM =
    'Bạn là dịch giả phụ đề. Dịch các dòng phụ đề tiếng nguồn sang tiếng Việt tự nhiên, dễ nghe khi đọc thành tiếng. ' +
    'Giữ nguyên ý, ngắn gọn, không giải thích. Đầu vào là JSON {"context":[...],"lines":[...]}; "context" chỉ để tham khảo, KHÔNG dịch. ' +
    'Chỉ trả về một mảng JSON các chuỗi tiếng Việt, đúng bằng số phần tử của "lines", cùng thứ tự, không thêm gì khác.';

  const CONCISE_NOTE =
    ' Bản dịch sẽ được đọc thành tiếng khớp thời gian video: mỗi dòng có giới hạn ký tự tương ứng trong "maxChars" (cùng chỉ số). ' +
    'Hãy dịch ngắn gọn, văn nói tự nhiên, lược bớt từ thừa nhưng giữ ý chính, và KHÔNG vượt quá giới hạn đó.';

  async function claudeOnce(lines, context, apiKey, model, budgets) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: model || 'claude-haiku-4-5',
        max_tokens: 8192,
        temperature: 0.2,
        system: budgets ? CLAUDE_SYSTEM + CONCISE_NOTE : CLAUDE_SYSTEM,
        messages: [{ role: 'user', content: JSON.stringify(budgets ? { context: context || [], lines: lines, maxChars: budgets } : { context: context || [], lines: lines }) }]
      })
    });
    if (!res.ok) throw new Error('Claude API HTTP ' + res.status); // never include request headers/body
    const data = await res.json();
    const text = (data.content || [])
      .map(function (b) {
        return b && b.type === 'text' ? b.text : '';
      })
      .join('');
    return parseClaudeArray(text, lines.length);
  }

  // Returns { result: string[], note?: string, fallback?: true }. Falls back to google when Claude fails/mismatches.
  async function translateClaude(texts, context, apiKey, model, budgets) {
    if (!apiKey) {
      return { result: await translateGoogle(texts), note: 'Chưa có API key Claude, dùng Google', fallback: true };
    }
    const lines = texts.map(oneLine);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const arr = await claudeOnce(lines, context, apiKey, model, budgets);
        if (arr) return { result: arr };
      } catch (e) {
        if (/HTTP (401|403|400)/.test(String(e && e.message))) break; // retrying will not help
      }
    }
    return { result: await translateGoogle(texts), note: 'Claude lỗi, dùng Google cho đoạn này', fallback: true };
  }

  // Indices whose translation is empty although the source text is not (provider failed for them).
  function missingIdx(texts, out) {
    const miss = [];
    for (let i = 0; i < texts.length; i++) if (oneLine(texts[i]) && !(out[i] && String(out[i]).trim())) miss.push(i);
    return miss;
  }

  // Returns { result: string[], note?: string, fallback?: true, failed: number[] } ('failed' = indices that could not be translated).
  async function translate(req) {
    const texts = req.texts || [];
    if (!texts.length) return { result: [], failed: [] };
    let r;
    if (req.provider === 'claude') r = await translateClaude(texts, req.context, req.apiKey, req.model, req.budgets);
    else r = { result: await translateGoogle(texts) };
    r.failed = missingIdx(texts, r.result);
    return r;
  }

  YVD.translators = {
    buildBatches: buildBatches,
    parseGoogleResponse: parseGoogleResponse,
    splitBatch: splitBatch,
    parseClaudeArray: parseClaudeArray,
    translate: translate,
    missingIdx: missingIdx,
    translateGoogle: translateGoogle
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = YVD.translators;
})(typeof window !== 'undefined' ? window : globalThis);
