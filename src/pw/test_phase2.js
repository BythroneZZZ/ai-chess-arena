/* 第二阶段新增能力的验收：取消语义 / 节奏 / 无障碍 / 密钥安全 / 契约一致性 */
const puppeteer = require('puppeteer-core');
const { chromePath } = require('./testenv');
const path = require('path');
const os = require('os');
const fs = require('fs');
const SHOT = process.env.ARENA_SHOT_DIR || path.join(os.tmpdir(), 'chess-arena-shots');
try { fs.mkdirSync(SHOT, { recursive: true }); } catch (e) {}
const BASE = process.env.ARENA_BASE_URL || 'http://localhost:8765';
const FILE = BASE + '/index.html';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));



let fails = 0;
const check = (name, cond, extra) => {
  if (cond) console.log('  OK  ' + name + (extra ? ' | ' + extra : ''));
  else { fails++; console.log('  FAIL ' + name + (extra ? ' | ' + extra : '')); }
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

  console.log('\n=== 1. 引擎取消语义 ===');
  const engine = await p.evaluate(async () => {
    const fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    const ps = [Engine.bestMove(fen, 20, 3000), Engine.bestMove(fen, 20, 3000), Engine.bestMove(fen, 20, 3000)];
    await new Promise(r => setTimeout(r, 300));
    const mid = { busy: Engine.busy, queue: Engine.queue.length };
    Engine.stopAll();
    const settled = await Promise.race([
      Promise.allSettled(ps).then(() => 'settled'),
      new Promise(r => setTimeout(() => r('timeout'), 2500))
    ]);
    // 取消后必须能立刻接受新任务
    const after = await Engine.bestMove(fen, 8, 3000);
    return { mid, settled, after, state: { busy: Engine.busy, queue: Engine.queue.length } };
  });
  check('取消后所有 Promise 结算', engine.settled === 'settled', JSON.stringify(engine.mid));
  check('取消后 busy 复位', engine.state.busy === false);
  check('取消后引擎仍可用', typeof engine.after === 'string' && engine.after.length >= 4, engine.after);

  console.log('\n=== 2. Worker 崩溃恢复 ===');
  const crash = await p.evaluate(async () => {
    const fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    const pr = Engine.bestMove(fen, 20, 4000);
    await new Promise(r => setTimeout(r, 150));
    Engine.worker.onerror({ message: 'simulated' });
    const settled = await Promise.race([
      pr.then(v => 'resolved:' + v), new Promise(r => setTimeout(() => r('timeout'), 2500))
    ]);
    const drained = { busy: Engine.busy, queue: Engine.queue.length };
    const ok = await Engine.restart();
    const mv = await Engine.bestMove(fen, 8, 3000);
    return { settled, drained, restarted: ok, mv };
  });
  check('崩溃时 job 立即结算', crash.settled.startsWith('resolved'), crash.settled);
  check('崩溃后队列已清空', crash.drained.busy === false && crash.drained.queue === 0);
  check('restart 后引擎恢复', crash.mv && crash.mv.length >= 4, crash.mv);

  console.log('\n=== 3. 取消后迟到消息不污染 ===');
  const stale = await p.evaluate(async () => {
    const before = Engine.epoch;
    Engine.stopAll();
    const after = Engine.epoch;
    // 手动喂一条 bestmove，应被丢弃（无 current）
    const queueBefore = Engine.queue.length;
    Engine.onLine('bestmove e2e4');
    return { before, after, queueBefore, queueAfter: Engine.queue.length, busy: Engine.busy };
  });
  check('stopAll 推进代次', stale.after > stale.before, stale.before + '→' + stale.after);
  check('空队列收到迟到 bestmove 不崩', stale.busy === false && stale.queueAfter === 0);

  console.log('\n=== 4. 演出节奏 ===');
  const pace = await p.evaluate(() => {
    const r = [];
    ['full', 'fast', 'skip'].forEach(x => { Settings.setPace(x); r.push(Settings.pace()); });
    Settings.setPace('full');
    return r;
  });
  check('三档切换', pace.join(',') === 'full,fast,skip', pace.join(','));

  // 节奏影响的是「台词演出」：直接基准测试打字机
  const timing = await p.evaluate(async () => {
    const bench = async (paceMode) => {
      Settings.setPace(paceMode);
      Game.aborted = false;
      const t0 = performance.now();
      await UI.typeBubble('w', '这是一句用来测量打字机速度的标准测试台词长度大约四十个字', 0, paceMode === 'fast' ? 4 : 1);
      return Math.round(performance.now() - t0);
    };
    const full = await bench('full');
    const fast = await bench('fast');
    Settings.setPace('full');
    return { full, fast };
  });
  check('快速档打字机明显更快', timing.fast < timing.full * 0.6, `full=${timing.full}ms fast=${timing.fast}ms`);

  // skip 模式：气泡应一次性出现（无逐字）
  const skipMode = await p.evaluate(async () => {
    Settings.setPace('skip');
    const side = 'L';   // setBubbleInstant 用 L/R 侧标识
    const who = Game.players && Game.players.w ? Game.players.w.char.name : 'x';
    const t0 = performance.now();
    UI.setBubbleInstant(side, who, '整句立刻显示');
    const ms = performance.now() - t0;
    const node = document.getElementById('bubble' + side + 'Text');
    const txt = node ? node.textContent : null;
    Settings.setPace('full');
    return { ms: Math.round(ms), txt };
  });
  check('skip 模式即时显示', skipMode.txt === '整句立刻显示' && skipMode.ms < 60, skipMode.ms + 'ms');

  console.log('\n=== 5. 台词清洗 ===');
  const clean = await p.evaluate(() => ({
    newlines: ApiContract.cleanThought('第一行\n第二行\r\n第三行'),
    ctrl: ApiContract.cleanThought('带\u0000控制\u0007字符'),
    quotes: ApiContract.cleanThought('"被引号包裹"'),
    long: ApiContract.cleanThought('长'.repeat(200), 40),
    tokens: [ApiContract.clampTokens(9999), ApiContract.clampTokens(-5), ApiContract.clampTokens('abc')],
    temps: [ApiContract.clampTemp(5), ApiContract.clampTemp(-1), ApiContract.clampTemp('x')]
  }));
  check('去除换行', !clean.newlines.includes('\n'), clean.newlines);
  check('去除控制字符', !/[\u0000-\u0008]/.test(clean.ctrl), clean.ctrl);
  check('剥离包裹引号', clean.quotes === '被引号包裹', clean.quotes);
  check('超长截断', clean.long.length <= 41, clean.long.length + ' 字');
  check('token 夹紧', clean.tokens[0] === 200 && clean.tokens[1] === 8 && clean.tokens[2] === 80, clean.tokens.join('/'));
  check('温度夹紧', clean.temps[0] === 1.5 && clean.temps[1] === 0 && clean.temps[2] === 0.9, clean.temps.join('/'));

  console.log('\n=== 6. 错误分类 ===');
  const cls = await p.evaluate(() => {
    const mk = (m) => new Error(m);
    const cfg = { base: 'http://127.0.0.1:11434/v1' };
    return {
      auth: classifyApiError(mk('HTTP 401 · bad key'), cfg).kind,
      notfound: classifyApiError(mk('HTTP 404'), cfg).kind,
      rate: classifyApiError(mk('HTTP 429'), cfg).kind,
      local: classifyApiError(mk('Failed to fetch'), cfg).text,
      remote: classifyApiError(mk('Failed to fetch'), { base: 'https://api.x.com' }).text,
      parse: classifyApiError(mk('响应不是 JSON：abc'), cfg).kind
    };
  });
  check('401 → auth', cls.auth === 'auth');
  check('404 → notfound', cls.notfound === 'notfound');
  check('429 → ratelimit', cls.rate === 'ratelimit');
  check('本地服务错误可操作', clsd(cls.local), cls.local);
  check('远端 CORS 提示', /CORS/.test(cls.remote), cls.remote);
  function clsd(s) { return /本地/.test(s); }

  console.log('\n=== 7. 配置校验 ===');
  const val = await p.evaluate(() => ({
    empty: validateApiConfig({ name: '', base: '', model: '' }).length,
    badUrl: validateApiConfig({ name: 'a', base: 'ftp://x', model: 'm' }).length,
    ok: validateApiConfig({ name: 'a', base: 'https://x/v1', model: 'm' }).length,
    customNoPath: validateApiConfig({ name: 'a', base: 'https://x/v1', model: 'm', fmt: 'custom', customPath: '' }).length,
    customBadBody: validateApiConfig({ name: 'a', base: 'https://x/v1', model: 'm', fmt: 'custom', customPath: 'x.y', customBody: '{bad' }).length
  }));
  check('空配置报错', val.empty === 3, val.empty + ' 项');
  check('非法协议被拒', val.badUrl === 1);
  check('合法配置通过', val.ok === 0);
  check('自定义缺路径报错', val.customNoPath === 1);
  check('自定义坏 JSON 报错', val.customBadBody === 1);

  console.log('\n=== 8. 密钥安全 ===');
  const sec = await p.evaluate(() => {
    UI.go('api'); ApiEditor.newConfig();
    const set = (id, v) => { const e = document.querySelector(id); e.value = v; if (e.dispatchEvent) e.dispatchEvent(new Event('change', { bubbles: true })); };
    set('#apiName', '安全测试'); set('#apiBase', 'https://x/v1'); set('#apiModel', 'm'); set('#apiKey', 'sk-super-secret');
    ApiEditor.save();
    const stored = Store.apis[0].key;
    ApiEditor.clearKey();
    const afterClear = Store.apis[0].key;
    return { stored, afterClear, savedOk: Store.apis.length === 1 };
  });
  check('密钥可保存', sec.stored === 'sk-super-secret');
  check('单条清空生效', sec.afterClear === '');

  console.log('\n=== 9. 无障碍 ===');
  const a11y = await p.evaluate(() => {
    UI.go('characters');
    const btn = document.getElementById('btnNewChar');
    btn.click();
    const modal = document.getElementById('charModal');
    const opened = { on: modal.classList.contains('on'), role: modal.getAttribute('role'), hidden: modal.getAttribute('aria-hidden') };
    const focused = document.activeElement && document.activeElement.tagName;
    return { opened, focused, hasDialog: modal.getAttribute('role') === 'dialog', boardLabel: document.getElementById('boardA11y') ? 'yes' : 'no' };
  });
  check('角色弹窗 role=dialog', a11y.hasDialog);
  check('aria-hidden 正确切换', a11y.opened.hidden === 'false', a11y.opened.hidden);
  check('打开后自动聚焦', /INPUT|SELECT|TEXTAREA|BUTTON/.test(a11y.focused || ''), a11y.focused);
  check('棋盘文本摘要存在', a11y.boardLabel === 'yes');

  // Escape 关闭
  await p.keyboard.press('Escape');
  await sleep(200);
  const esc = await p.evaluate(() => ({
    on: document.getElementById('charModal').classList.contains('on'),
    hidden: document.getElementById('charModal').getAttribute('aria-hidden')
  }));
  check('Escape 关闭弹窗', esc.on === false && esc.hidden === 'true');

  const desc = await p.evaluate(() => {
    Game.chess = new Chess();
    A11y.updateBoardLabel();
    const t = document.getElementById('boardA11y').textContent;
    Game.chess.move('e4');
    A11y.updateBoardLabel();
    return { first: t.slice(0, 40), second: document.getElementById('boardA11y').textContent.slice(0, 60) };
  });
  check('摘要含轮次', /轮到白方走子/.test(desc.first), desc.first);
  check('摘要随局面更新', /上一步/.test(desc.second), desc.second);

  /* 关键回归：摘要必须由「落子」自动驱动，而不是靠调用方手动 updateBoardLabel。
   * 曾经的 bug：全项目只在 boot() 调一次，读屏永远听到初始局面。 */
  const auto1 = await p.evaluate(async () => {
    // 1.e4 e5 2.Nf3 Nc6 3.Nxe5 —— 白方马停在 e5，等黑方 Nxe5 吃掉它
    const c = new Chess();
    ['e4', 'e5', 'Nf3', 'Nc6', 'Nxe5'].forEach((m) => c.move(m));
    Game.chess = new Chess(c.fen());
    Game.moves = [];
    Game.view.pieces = []; Game.view.setPosition(Game.chess);
    A11y.updateBoardLabel(Game.chess, Game.view);
    const before = document.getElementById('boardA11y').textContent;
    const horsesBefore = (before.match(/马/g) || []).length;

    await Game.applyMove('b', { uci: 'c6e5', thought: '', source: 'test' }, Run.token());
    await new Promise(r => setTimeout(r, 120));

    const after = document.getElementById('boardA11y').textContent;
    const horsesAfter = (after.match(/马/g) || []).length;
    return {
      before, after, horsesBefore, horsesAfter,
      changed: before !== after,
      // 黑方骑士吃 e5 → SAN 为 Nxe5
      mentionsCapture: /上一步：黑方 Nxe5/.test(after),
      horseGone: horsesAfter === horsesBefore - 1
    };
  });
  check('落子后摘要自动更新（无需手动调用）', auto1.changed === true,
    'before≠after = ' + auto1.changed);
  check('摘要写入实际着法', auto1.mentionsCapture === true, auto1.after.slice(0, 46));
  check('摘要里的子力反映吃子结果', auto1.horseGone === true,
    '马 ' + auto1.horsesBefore + ' → ' + auto1.horsesAfter);

  /* 悔棋也要刷新：否则读屏听到的还是"吃过马之后"的局面 */
  const auto2 = await p.evaluate(async () => {
    const afterMove = document.getElementById('boardA11y').textContent;
    Game.pendingHuman = { color: 'w', resolve: () => { } };
    const removed = UndoDraw.performUndo();
    await new Promise(r => setTimeout(r, 120));
    const afterUndo = document.getElementById('boardA11y').textContent;
    return { removed, afterMove, afterUndo, changed: afterMove !== afterUndo };
  });
  check('悔棋后摘要自动更新', auto2.removed > 0 && auto2.changed === true,
    'removed=' + auto2.removed);

  /* 回放页有自己的 live region（battle 屏 display:none，其 live region 不会被朗读） */
  const auto3 = await p.evaluate(async () => {
    const el = document.getElementById('replayA11y');
    if (!el) return { missing: true };
    const c = new Chess();
    c.move('e4'); c.move('e5');
    A11y.updateBoardLabel(c, UI.replayView, 'replayA11y');
    const t1 = el.textContent;
    c.move('Nf3');
    A11y.updateBoardLabel(c, UI.replayView, 'replayA11y');
    const t2 = el.textContent;
    return { has: true, t1: t1.slice(0, 26), t2: t2.slice(0, 40), changed: t1 !== t2 };
  });
  check('回放页有独立 live region', auto3.has === true);
  check('回放页摘要与 battle 分离且会更新', auto3.changed === true, auto3.t2);

  console.log('\n=== 10. 减少动态 / 高对比 ===');
  const rm = await p.evaluate(() => {
    Store.settings.reducedMotion = true; Settings.applyBody();
    const a = document.body.classList.contains('reduced-motion');
    Store.settings.highContrast = true; Settings.applyBody();
    const c = document.body.classList.contains('high-contrast');
    Store.settings.reducedMotion = false; Store.settings.highContrast = false; Settings.applyBody();
    return { a, c };
  });
  check('reduced-motion 类生效', rm.a === true);
  check('high-contrast 类生效', rm.c === true);

  console.log('\n=== 11. 离场取消在途请求 ===');
  const cancel = await p.evaluate(async () => {
    let aborted = 0;
    window.fetch = (url, init) => new Promise((resolve, reject) => {
      const sig = init && init.signal;
      if (sig) sig.addEventListener('abort', () => { aborted++; reject(new DOMException('aborted', 'AbortError')); });
      // 永不主动 resolve
    });
    Store.apis.push({ id: 'api_c', name: 'hang', fmt: 'openai', base: 'https://x/v1', key: 'k', model: 'm' });
    refreshApiSelects();
    EndpointGuard.trust('https://x');   // 端点准入会拦新域名，测试里预先信任
    pendingMode = 'aivai'; refreshSetup(); UI.go('setup');
    document.getElementById('selApiL').value = 'api_c';
    document.getElementById('selApiR').value = 'api_c';
    startMatch();
    await new Promise(r => setTimeout(r, 700));
    const inflight = Run.ctrls.size;
    Game.abort();
    await new Promise(r => setTimeout(r, 200));
    return { inflight, aborted, remaining: Run.ctrls.size };
  });
  check('请求已登记', cancel.inflight >= 1, 'in-flight=' + cancel.inflight);
  check('abort 触发 AbortController', cancel.aborted >= 1, 'aborted=' + cancel.aborted);
  check('登记表已清空', cancel.remaining === 0);

  console.log('\n=== 12. 页面错误 ===');
  console.log(errs.length ? errs.join('\n') : '(无)');
  check('无 JS 运行时错误', errs.length === 0);

  await p.screenshot({ path: path.join(SHOT, '60-phase2.png') });
  console.log('\n================  RESULT: ' + (fails === 0 ? 'ALL PASS' : fails + ' FAILED') + '  ================');
  await b.close();
  process.exit(fails ? 1 : 0);
})();
