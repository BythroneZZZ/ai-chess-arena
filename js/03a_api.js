/* =====================================================================
 * 07 · API CLIENT  (OpenAI 兼容 / Anthropic / 自定义)
 *
 * 统一契约 ApiContract：
 *   - max_tokens：对话框上限 256，请求侧统一 clamp 到 ≤200
 *   - temperature：clamp 到 [0, 1.5]；Anthropic 再收窄到 [0, 1]
 *   - timeout：默认 15s，可覆盖
 *   - 每次请求都登记 AbortController 到 Run，离场即取消
 *   - 错误分类：abort / timeout / network / cors / http / parse / shape
 * ===================================================================== */

const ApiContract = {
  MAX_TOKENS_UI: 256,
  MAX_TOKENS_REQ: 200,
  DEFAULT_TIMEOUT: 15000,
  clampTokens(v) {
    const n = parseInt(v, 10);
    if (!Number.isFinite(n)) return 80;
    return clamp(n, 8, this.MAX_TOKENS_REQ);
  },
  clampTemp(v) {
    const n = parseFloat(v);
    if (!Number.isFinite(n)) return 0.9;
    return Math.round(clamp(n, 0, 1.5) * 100) / 100;
  },
  /* 台词清洗：去掉换行、控制字符、首尾引号，按字数硬截断 */
  cleanThought(text, maxChars = 60) {
    let s = String(text == null ? '' : text);
    s = s.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');
    s = s.replace(/\s+/g, ' ').trim();
    s = s.replace(/^["'“”‘’《》「」]+|["'“”‘’《》「」]+$/g, '').trim();
    if (maxChars && s.length > maxChars) s = s.slice(0, maxChars).trim() + '…';
    return s;
  },
  /* 允许用户看到、但不污染游戏的台词长度 */
  THOUGHT_MAX: 60
};

/* 错误分类，附带可操作建议 */
function classifyApiError(e, cfg) {
  const msg = String((e && e.message) || e || '');
  if (Run.isAbortError(e)) return { kind: 'abort', text: '已取消' };
  if (/HTTP 401|HTTP 403/.test(msg)) return { kind: 'auth', text: '鉴权失败（Key 无效或无权限）' };
  if (/HTTP 404/.test(msg)) return { kind: 'notfound', text: '端点或模型名不存在' };
  if (/HTTP 429/.test(msg)) return { kind: 'ratelimit', text: '触发限流，稍后再试或降低频率' };
  if (/HTTP 5\d\d/.test(msg)) return { kind: 'server', text: '服务端错误' };
  if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) {
    return {
      kind: 'network',
      text: cfg && /^https?:\/\/(127\.0\.0\.1|localhost)/i.test(cfg.base || '')
        ? '连不上本地服务（确认已启动、端口正确、且允许跨域）'
        : '网络不可达，或对方未开启 CORS（可用自建代理）'
    };
  }
  /* 超时判定要覆盖三种来源：
   *   1. fetchJSON 自己抛的中文 '请求超时'（err.name = 'TimeoutError'）
   *   2. 浏览器原生的 'The operation was aborted' / TimeoutError
   *   3. 中文界面的 '操作超时'
   * 早先只写了英文正则，中文消息一律落到 'other'，
   * 于是超时被当成未知错误，UI 提示与重试判定都不对。 */
  if (
    (e && e.name === 'TimeoutError') ||
    /timed out|timeout|超时|aborted|中断/i.test(msg)
  ) return { kind: 'timeout', text: '请求超时（15s）' };
  if (/不是 JSON|JSON/.test(msg)) return { kind: 'parse', text: '响应不是合法 JSON' };
  return { kind: 'other', text: msg.slice(0, 120) || '未知错误' };
}

function joinEndpoint(base, suffix) {
  const b = (base || '').trim().replace(/\/+$/, '');
  if (!b) throw new Error('Base URL 为空');
  if (suffix && b.endsWith(suffix)) return b;
  return b + (suffix || '');
}

/* URL 合法性校验（保存配置时用） */
function validateApiConfig(cfg) {
  const errs = [];
  if (!cfg.name || !cfg.name.trim()) errs.push('配置名称不能为空');
  const base = (cfg.base || '').trim();
  if (!base) errs.push('Base URL 不能为空');
  else if (!/^https?:\/\/[^\s]+$/i.test(base)) errs.push('Base URL 必须是 http(s):// 开头的完整地址');
  if (!cfg.model || !cfg.model.trim()) errs.push('Model Name 不能为空');
  if (cfg.fmt === 'custom') {
    if (!cfg.customPath || !cfg.customPath.trim()) errs.push('自定义格式需要填写响应路径');
    try { JSON.parse(cfg.customBody || '{}'); } catch (e) { errs.push('自定义请求体模板不是合法 JSON'); }
  }
  return errs;
}

async function fetchJSON(url, opts, timeout, ctrl) {
  // 密钥外发前的端点准入（未确认则抛 AbortError，绝不发请求）
  if (!opts || !opts.__skipGuard) {
    await EndpointGuard.ensure(url, { cfgName: opts && opts.__cfgName });
  }
  const controller = ctrl || new AbortController();
  const release = Run.track(controller);
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; try { controller.abort(); } catch (e) { } }, timeout);
  try {
    const res = await fetch(url, Object.assign({}, opts, { signal: controller.signal }));
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status} · ${text.slice(0, 220)}`);
    try { return JSON.parse(text); } catch (e) { throw new Error('响应不是 JSON：' + text.slice(0, 160)); }
  } catch (e) {
    if (timedOut) { const err = new Error('请求超时'); err.name = 'TimeoutError'; throw err; }
    throw e;
  } finally {
    clearTimeout(timer);
    release();
  }
}

function pickPath(obj, path) {
  if (!path) return null;
  const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  let cur = obj;
  for (const p of parts) { if (cur == null) return null; cur = cur[p]; }
  return cur;
}

const API = {
  /**
   * @param {object} cfg   API 配置
   * @param {string} system
   * @param {string} user
   * @param {object} opt   { temperature, maxTokens, timeout }
   */
  async chat(cfg, system, user, opt = {}) {
    if (!cfg) throw new Error('没有选择 API 配置');
    if (!cfg.base) throw new Error('Base URL 为空');
    const temperature = ApiContract.clampTemp(opt.temperature ?? 0.9);
    const maxTokens = ApiContract.clampTokens(opt.maxTokens ?? 80);
    const timeout = clamp(parseInt(opt.timeout, 10) || ApiContract.DEFAULT_TIMEOUT, 1000, 60000);
    const fmt = cfg.fmt || 'openai';

    if (fmt === 'openai') {
      const url = joinEndpoint(cfg.base, '/chat/completions');
      const body = {
        model: cfg.model,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        temperature, max_tokens: maxTokens, stream: false
      };
      const data = await this._req(url, {
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (cfg.key || '') },
        body: JSON.stringify(body)
      }, timeout, cfg.name);
      const txt = data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text;
      if (txt == null) throw new Error('响应里找不到 choices[0].message.content');
      return String(txt);
    }

    if (fmt === 'anthropic') {
      const b = (cfg.base || '').replace(/\/+$/, '');
      const url = b.endsWith('/messages') ? b : (b.endsWith('/v1') ? b + '/messages' : b + '/v1/messages');
      const body = {
        model: cfg.model, system,
        max_tokens: maxTokens,
        temperature: clamp(temperature, 0, 1),
        messages: [{ role: 'user', content: user }]
      };
      const data = await this._req(url, {
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': cfg.key || '',
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true'
        },
        body: JSON.stringify(body)
      }, timeout, cfg.name);
      const arr = data?.content;
      const txt = Array.isArray(arr) ? arr.filter((x) => x && x.type === 'text').map((x) => x.text).join('') : null;
      if (!txt) throw new Error('响应里找不到 content[].text');
      return txt;
    }

    /* 自定义：占位符先做 JSON 转义，再校验整体 JSON */
    const tpl = cfg.customBody || '{"model":"{{model}}","messages":[{"role":"system","content":"{{system}}"},{"role":"user","content":"{{user}}"}]}';
    const esc = (v) => JSON.stringify(String(v == null ? '' : v)).slice(1, -1);
    const fill = (s) => s
      .replace(/\{\{system\}\}/g, esc(system))
      .replace(/\{\{user\}\}/g, esc(user))
      .replace(/\{\{model\}\}/g, esc(cfg.model || ''))
      .replace(/\{\{temperature\}\}/g, String(temperature))
      .replace(/\{\{max_tokens\}\}/g, String(maxTokens));
    let bodyText;
    try {
      bodyText = fill(tpl);
      JSON.parse(bodyText);
    } catch (e) {
      throw new Error('自定义模板生成的不是合法 JSON（检查占位符是否在引号内）：' + e.message);
    }
    const data = await this._req(joinEndpoint(cfg.base, ''), {
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (cfg.key || '') },
      body: bodyText
    }, timeout, cfg.name);
    const path = cfg.customPath || 'choices.0.message.content';
    let val = pickPath(data, path);
    if (val == null) val = data?.choices?.[0]?.message?.content ?? data?.content?.[0]?.text ?? data?.reply;
    if (val == null) throw new Error('自定义路径 ' + path + ' 取不到内容');
    return typeof val === 'string' ? val : JSON.stringify(val);
  },

  _req(url, init, timeout, cfgName) {
    return fetchJSON(url, Object.assign({ method: 'POST' }, init, { __cfgName: cfgName }), timeout);
  },

  async test(cfg) {
    const t0 = performance.now();
    const out = await this.chat(cfg, '你是连通性测试机器人，只回复两个字。', '回复：接通', { maxTokens: 24, temperature: 0.2, timeout: 15000 });
    return { ms: Math.round(performance.now() - t0), text: out.trim().slice(0, 80) };
  }
};

/* 从模型输出里抠出 {move, thought} */
function parseModelJSON(text) {
  let s = String(text || '').trim();
  s = s.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const tryParse = (t) => { try { return JSON.parse(t); } catch (e) { return null; } };
  let obj = tryParse(s);
  if (!obj) {
    const a = s.indexOf('{'), b = s.lastIndexOf('}');
    if (a >= 0 && b > a) obj = tryParse(s.slice(a, b + 1));
  }
  if (!obj || typeof obj !== 'object') {
    const mv = s.match(/"move"\s*:\s*"([^"]+)"/) || s.match(/\b([a-h][1-8][a-h][1-8][qrbn]?)\b/);
    const th = s.match(/"thought"\s*:\s*"([^"]*)"/);
    if (mv || th) return { move: mv ? mv[1] : undefined, thought: th ? th[1] : undefined, _loose: true };
    return null;
  }
  return { move: obj.move, thought: obj.thought ?? obj.text ?? obj.thinking, _loose: false };
}

/* 文本 → 合法 UCI（严格校验） */
function normalizeUci(chess, raw) {
  if (!raw) return null;
  let s = String(raw).trim().toLowerCase().replace(/[^a-h1-8qrbn]/g, '');
  if (s.length < 4) return null;
  const legal = chess.moves({ verbose: true });
  const f = s.slice(0, 2), t = s.slice(2, 4), promo = s[4] || null;
  let cands = legal.filter((m) => m.from === f && m.to === t);
  if (!cands.length) return null;
  if (cands.length === 1) return cands[0];
  if (promo) {
    const exact = cands.find((m) => m.promotion === promo);
    if (exact) return exact;
  }
  return cands.find((m) => m.promotion === 'q') || cands[0];
}
