/* 端点准入（EndpointGuard）专项验收 */
const puppeteer = require('puppeteer-core');
const { chromePath } = require('./testenv');
const path = require('path');
const os = require('os');
const fs = require('fs');
const SHOT = process.env.ARENA_SHOT_DIR || path.join(os.tmpdir(), 'chess-arena-shots');
try { fs.mkdirSync(SHOT, { recursive: true }); } catch (e) { }
const BASE = process.env.ARENA_BASE_URL || 'http://localhost:8765';
const FILE = BASE + '/index.html';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let fails = 0;
const ck = (n, c, e) => {
  if (c) console.log('  OK  ' + n + (e ? ' | ' + e : ''));
  else { fails++; console.log('  FAIL ' + n + (e ? ' | ' + e : '')); }
};

(async () => {
  const b = await puppeteer.launch({
    executablePath: chromePath(),
    headless: 'new',
    args: ['--no-sandbox']
  });
  const p = await b.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push(e.message));
  await p.setViewport({ width: 1440, height: 900 });
  await p.goto(FILE, { waitUntil: 'domcontentloaded' });
  await sleep(2000);

  // 干净的信任状态 + 可控 fetch
  await p.evaluate(() => {
    Store.settings.trustedHosts = [];
    Store.saveSettings();
    EndpointGuard._session = new Set();
    window.__calls = [];
    window.fetch = async (url, init) => {
      window.__calls.push(String(url));
      return new Response(JSON.stringify({
        choices: [{ message: { content: '{"thought":"ok"}' } }]
      }), { status: 200 });
    };
    Store.apis = [{ id: 'api_ep', name: '端点测试', fmt: 'openai', base: 'https://evil-example.test/v1', key: 'sk-secret', model: 'm' }];
    Store.saveApis();
    refreshApiSelects();
  });

  console.log('\n=== 1. 未知端点必须拦截 ===');
  const blocked = await p.evaluate(async () => {
    const api = Store.apis[0];
    const pr = API.chat(api, 'sys', 'user', { maxTokens: 40 }).then(
      () => 'RESOLVED', (e) => 'REJECTED:' + e.name
    );
    await new Promise(r => setTimeout(r, 400));
    const mid = {
      modalOn: document.getElementById('endpointModal').classList.contains('on'),
      originShown: document.getElementById('epOrigin').textContent,
      fetchCalls: window.__calls.length
    };
    // 取消
    document.getElementById('epCancel').click();
    const outcome = await pr;
    return { mid, outcome, fetchAfter: window.__calls.length };
  });
  ck('弹窗出现', blocked.mid.modalOn === true);
  ck('显示目标 origin', blocked.mid.originShown === 'https://evil-example.test', blocked.mid.originShown);
  ck('请求未下发', blocked.mid.fetchCalls === 0, 'fetch=' + blocked.mid.fetchCalls);
  ck('取消后以 AbortError 拒绝', blocked.outcome === 'REJECTED:AbortError', blocked.outcome);
  ck('取消后仍无请求', blocked.fetchAfter === 0);

  console.log('\n=== 2. 「仅本次」放行但不持久化 ===');
  const once = await p.evaluate(async () => {
    window.__calls = [];
    const api = Store.apis[0];
    const pr = API.chat(api, 'sys', 'user', { maxTokens: 40 }).then(() => 'OK', e => 'ERR:' + e.name);
    await new Promise(r => setTimeout(r, 300));
    document.getElementById('epOnce').click();
    const r = await pr;
    const persisted = (Store.settings.trustedHosts || []).slice();
    const ls = JSON.parse(localStorage.getItem('aca.v1.settings') || '{}');
    return { r, persisted, lsHosts: ls.trustedHosts || [], fetch: window.__calls.length };
  });
  ck('请求放行', once.r === 'OK', once.r);
  ck('已发出一次请求', once.fetch === 1, once.fetch);
  ck('未写入 localStorage', once.lsHosts.length === 0, JSON.stringify(once.lsHosts));
  ck('仅本会话记住', once.persisted.length === 0 && once.fetch === 1);

  console.log('\n=== 3. 会话内再次请求不再弹窗 ===');
  const again = await p.evaluate(async () => {
    window.__calls = [];
    const api = Store.apis[0];
    const pr = API.chat(api, 'sys', 'user', { maxTokens: 40 }).then(() => 'OK', e => 'ERR:' + e.name);
    await new Promise(r => setTimeout(r, 250));
    const modal = document.getElementById('endpointModal').classList.contains('on');
    return { r: await pr, modal };
  });
  ck('直接放行', again.r === 'OK' && again.modal === false);

  console.log('\n=== 4. 「始终允许」写入持久化 ===');
  const always = await p.evaluate(async () => {
    EndpointGuard._session = new Set();
    Store.settings.trustedHosts = [];
    Store.saveSettings();
    window.__calls = [];
    const api = Store.apis[0];
    const pr = API.chat(api, 'sys', 'user', { maxTokens: 40 }).then(() => 'OK', e => 'ERR:' + e.name);
    await new Promise(r => setTimeout(r, 300));
    document.getElementById('epAlways').click();
    const r = await pr;
    const ls = JSON.parse(localStorage.getItem('aca.v1.settings') || '{}');
    return { r, lsHosts: ls.trustedHosts || [], fetch: window.__calls.length };
  });
  ck('请求放行', always.r === 'OK');
  ck('已写入 localStorage', always.lsHosts.includes('https://evil-example.test'), JSON.stringify(always.lsHosts));

  console.log('\n=== 5. 撤销后重新拦截 ===');
  const revoked = await p.evaluate(async () => {
    UI.go('api');
    const rows = document.querySelectorAll('#trustedList .px-btn');
    const had = rows.length;
    if (rows.length) rows[0].click();
    window.__calls = [];
    EndpointGuard._session = new Set();
    const api = Store.apis[0];
    const pr = API.chat(api, 'sys', 'user', { maxTokens: 40 }).then(() => 'OK', e => 'ERR:' + e.name);
    await new Promise(r => setTimeout(r, 350));
    const modal = document.getElementById('endpointModal').classList.contains('on');
    document.getElementById('epCancel').click();
    return { had, modal, outcome: await pr, fetch: window.__calls.length };
  });
  ck('撤销按钮存在', revoked.had >= 1, 'rows=' + revoked.had);
  ck('撤销后再次弹窗', revoked.modal === true);
  ck('撤销后请求被拦', revoked.outcome === 'ERR:AbortError' && revoked.fetch === 0);

  console.log('\n=== 6. 三种格式都过守卫 ===');
  const fmts = await p.evaluate(async () => {
    // 该用例自带 mock：必须同时兼容 openai 与 anthropic 的响应结构
    window.fetch = async () => new Response(JSON.stringify({
      choices: [{ message: { content: '{"thought":"ok"}' } }],
      content: [{ type: 'text', text: '{"thought":"ok"}' }]
    }), { status: 200 });
    const out = [];
    for (const fmt of ['openai', 'anthropic', 'custom']) {
      EndpointGuard._session = new Set();
      Store.settings.trustedHosts = [];
      Store.saveSettings();
      window.__calls = [];
      const api = { id: 'a_' + fmt, name: fmt, fmt, base: 'https://fmt-' + fmt + '.test/v1', key: 'k', model: 'm', customBody: '{"model":"{{model}}","messages":[{"role":"user","content":"{{user}}"}]}', customPath: 'choices.0.message.content' };
      const pr = API.chat(api, 's', 'u', { maxTokens: 40 }).then(() => 'OK', e => 'ERR:' + e.name);
      // 轮询等待弹窗就绪，避免与上一轮收尾竞态
      let modal = false;
      for (let i = 0; i < 40; i++) {
        await new Promise(r => setTimeout(r, 50));
        modal = document.getElementById('endpointModal').classList.contains('on');
        if (modal) break;
      }
      const shown = document.getElementById('epOrigin').textContent;
      document.getElementById('epOnce').click();
      const r = await pr;
      await new Promise(r2 => setTimeout(r2, 150));
      out.push({ fmt, modal, shown, r, fetch: window.__calls.length });
    }
    return out;
  });
  fmts.forEach(f => ck('格式 ' + f.fmt + ' 被拦截后放行', f.modal === true && f.r === 'OK', f.shown));

  console.log('\n=== 7. 弹窗可访问性 ===');
  const a11y = await p.evaluate(async () => {
    EndpointGuard._session = new Set();
    Store.settings.trustedHosts = [];
    Store.saveSettings();
    const api = Store.apis[0];
    const pr = API.chat(api, 's', 'u', { maxTokens: 40 }).catch(e => e.name);
    await new Promise(r => setTimeout(r, 300));
    const m = document.getElementById('endpointModal');
    return { role: m.getAttribute('role'), modal: m.getAttribute('aria-modal'), hidden: m.getAttribute('aria-hidden'), pr };
  });
  ck('role=dialog', a11y.role === 'dialog');
  ck('aria-modal=true', a11y.modal === 'true');
  ck('打开时 aria-hidden=false', a11y.hidden === 'false');

  await p.keyboard.press('Escape');
  await sleep(300);
  const esc = await p.evaluate(() => ({
    on: document.getElementById('endpointModal').classList.contains('on'),
    hidden: document.getElementById('endpointModal').getAttribute('aria-hidden')
  }));
  ck('Escape 取消', esc.on === false && esc.hidden === 'true');

  console.log('\n=== 8. 对局中拒绝不会卡死 ===');
  const inGame = await p.evaluate(async () => {
    EndpointGuard._session = new Set();
    Store.settings.trustedHosts = [];
    Store.saveSettings();
    Store.apis = [{ id: 'api_g', name: 'g', fmt: 'openai', base: 'https://blocked.test/v1', key: 'k', model: 'm' }];
    Store.saveApis();
    refreshApiSelects();
    window.fetch = async () => { throw new Error('should not be called'); };

    pendingMode = 'aivai'; refreshSetup(); UI.go('setup');
    document.getElementById('selApiL').value = 'api_g';
    document.getElementById('selApiR').value = 'api_g';
    document.getElementById('inpMaxMoves').value = '40';
    Settings.setPace('skip');
    startMatch();
    await new Promise(r => setTimeout(r, 500));
    // 连续取消两次（两方各一次）
    // 双方都会请求，弹窗会依次出现多次；持续拒绝直到没有任何待决确认
    for (let i = 0; i < 15; i++) {
      const modalOn = document.getElementById('endpointModal').classList.contains('on');
      if (modalOn) {
        const btn = document.getElementById('epCancel');
        if (btn) btn.click();
      }
      await new Promise(r => setTimeout(r, 450));
      const stillPending = !!EndpointGuard.pending || (EndpointGuard._queue || []).length > 0;
      const stillModal = document.getElementById('endpointModal').classList.contains('on');
      if (!stillPending && !stillModal) break;
    }
    const playState = {
      moves: Game.moves.length,
      running: Game.running,
      status: document.getElementById('statusText').textContent
    };
    // 离场：必须把任何待决确认一起收掉，不能留下悬空弹窗
    Game.abort();
    await new Promise(r => setTimeout(r, 600));
    const leftoverModal = document.getElementById('endpointModal').classList.contains('on');
    const leftoverPending = !!EndpointGuard.pending;
    Settings.setPace('full');
    return Object.assign(playState, { modalOn: leftoverModal, pending: leftoverPending, queue: (EndpointGuard._queue || []).length });
  });
  ck('对局未卡死', inGame.running === true || inGame.moves > 0, JSON.stringify(inGame));
  ck('弹窗已关闭', inGame.modalOn === false);

  console.log('\n=== 9. 页面错误 ===');
  console.log(errs.length ? errs.join('\n') : '(无)');
  ck('无运行时错误', errs.length === 0);

  await p.screenshot({ path: path.join(SHOT, '70-endpoint.png') });
  console.log('\n RESULT: ' + (fails ? fails + ' FAILED' : 'ALL PASS'));
  await b.close();
  process.exit(fails ? 1 : 0);
})();
