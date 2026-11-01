/* 交付形态与性能专项验收（v2.6 交付改造的四项：引擎共享 / 双击即玩 / 密钥分层 / 渲染）
 *
 * 断言分四块：
 *   1. P0-2 引擎源码只拉一次（两个 Worker 共用一份）
 *   2. P0-1 offline.html 在 file:// 下能完整对局
 *   3. P0-3 API Key 默认落 sessionStorage，勾选「记住」才持久化
 *   4. P1-1 渲染：底纹离屏缓存 + 空闲停表 + 动画仍能完成
 *
 * 第 4 块的重点是「优化不能破坏功能」：
 * 引入空闲停表时踩过一次 —— 动画推进依赖 draw()，loop 停了动画就永远完不成，
 * await animateMove() 的 applyMove 会永久挂起（棋盘看着动了但 moves 没记录）。
 */
const puppeteer = require('puppeteer-core');
const { chromePath } = require('./testenv');
const path = require('path');
const os = require('os');
const fs = require('fs');
const SHOT = process.env.ARENA_SHOT_DIR || path.join(os.tmpdir(), 'chess-arena-shots');
try { fs.mkdirSync(SHOT, { recursive: true }); } catch (e) { }
const BASE = process.env.ARENA_BASE_URL || 'http://localhost:8765';
const FILE = BASE + '/index.html';
const ROOT = path.resolve(__dirname, '..', '..');
const OFFLINE = 'file:///' + path.join(ROOT, 'offline.html').replace(/\\/g, '/');
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

  /* ================= 1. 引擎源码共享 ================= */
  console.log('\n=== 1. P0-2 引擎源码只拉一次 ===');
  const p = await b.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push(e.message));
  const sfReqs = [];
  p.on('response', r => {
    if (/stockfish\.js/.test(r.url())) {
      sfReqs.push({ cache: r.fromCache ? r.fromCache() : false, len: r.headers()['content-length'] });
    }
  });
  await p.setViewport({ width: 1440, height: 900 });
  await p.goto(FILE, { waitUntil: 'domcontentloaded' });
  await sleep(3200);
  ck('页面加载后 Stockfish 只请求 1 次', sfReqs.length === 1,
    sfReqs.length + ' 次 ' + JSON.stringify(sfReqs));
  const shared = await p.evaluate(() => ({
    engineReady: Engine.ready,
    analysisReady: Analysis.ready,
    distinctWorkers: Engine.worker !== Analysis.worker,
    cachedSrc: typeof _sfSrcPromise !== 'undefined' && !!_sfSrcPromise
  }));
  ck('两个 Worker 都就绪', shared.engineReady && shared.analysisReady);
  ck('Worker 实例是各自独立的', shared.distinctWorkers === true);
  ck('源码 Promise 已缓存', shared.cachedSrc === true);

  /* ================= 2. offline.html ================= */
  console.log('\n=== 2. P0-1 offline.html（file:// 双击即玩） ===');
  ck('offline.html 已生成', fs.existsSync(path.join(ROOT, 'offline.html')));
  ck('内联引擎产物已生成', fs.existsSync(path.join(ROOT, 'assets/vendor/stockfish.inline.js')));
  ck('内联开局库产物已生成', fs.existsSync(path.join(ROOT, 'data/openings.inline.js')));

  const of = await b.newPage();
  const ofErrs = [];
  of.on('pageerror', e => ofErrs.push(e.message));
  const ofFailed = [];
  of.on('requestfailed', r => ofFailed.push(r.url().split('/').slice(-1)[0]));
  await of.setViewport({ width: 1200, height: 900 });
  await of.goto(OFFLINE, { waitUntil: 'domcontentloaded' });
  await sleep(4200);
  const offState = await of.evaluate(() => ({
    engine: Engine.ready, engineFailed: Engine.failed,
    analysis: Analysis.ready,
    hasSrc: !!window.__SF_SRC, hasBook: !!window.OPENINGS_BOOK
  }));
  ck('file:// 下主引擎就绪', offState.engine === true && offState.engineFailed === false);
  ck('file:// 下分析引擎就绪', offState.analysis === true);
  ck('内联全局量已注入', offState.hasSrc && offState.hasBook);
  ck('无资源加载失败', ofFailed.length === 0, ofFailed.slice(0, 4).join(','));

  const offPlay = await of.evaluate(async () => {
    pendingMode = 'pve'; refreshSetup(); UI.go('setup');
    document.getElementById('selSide').value = 'w';
    document.getElementById('selDiff').value = '1';
    document.getElementById('rngDelay').value = '0';
    startMatch();
    for (let i = 0; i < 100; i++) {
      await new Promise(r => setTimeout(r, 150));
      if (Game.pendingHuman && Game.pendingHuman.color === 'w' && !Game.busy) break;
    }
    Game.onSquareClick('e2');
    await new Promise(r => setTimeout(r, 150));
    Game.onSquareClick('e4');
    for (let i = 0; i < 150; i++) {
      await new Promise(r => setTimeout(r, 200));
      if (Game.moves.length >= 2 && !Game.busy) break;
    }
    return {
      moves: Game.moves.map(m => m.color + ':' + m.san),
      eval: EvalBar.text,
      logCount: document.querySelectorAll('#moveLog .mv').length
    };
  });
  ck('file:// 下能完整对局（双方各走一步）', offPlay.moves.length >= 2, offPlay.moves.join(' '));
  ck('file:// 下评估条出数', /\d/.test(offPlay.eval), offPlay.eval);
  ck('file:// 下棋步日志同步', offPlay.logCount === offPlay.moves.length,
    offPlay.logCount + ' vs ' + offPlay.moves.length);
  ck('file:// 下无 JS 运行时错误', ofErrs.length === 0, ofErrs.slice(0, 3).join('|'));
  await of.screenshot({ path: path.join(SHOT, 'c-offline-file.png') });
  await of.close();

  /* ================= 3. API Key 分层存储 ================= */
  console.log('\n=== 3. P0-3 密钥分层存储 ===');
  const sec = await p.evaluate(async () => {
    const out = {};
    Secret.setRemember(false);
    out.defaultRemember = Secret.remember();

    // 造一条配置
    Store.apis = [];
    UI.go('api'); ApiEditor.newConfig();
    document.querySelector('#apiName').value = '密钥测试';
    document.querySelector('#apiBase').value = 'https://x/v1';
    document.querySelector('#apiModel').value = 'm';
    document.querySelector('#apiKey').value = 'sk-test-abc';
    ApiEditor.save();
    const id = Store.apis[0].id;
    out.id = id;
    out.sessionOnly = sessionStorage.getItem('aca.v1.secret.key.' + id) === 'sk-test-abc';
    out.notInLocal = localStorage.getItem('aca.v1.secret.key.' + id) === null;
    out.apisPayloadClean = !(localStorage.getItem('aca.v1.apis') || '').includes('sk-test-abc');
    out.hydratedOk = Store.hydrateApis()[0].key === 'sk-test-abc';

    // 勾选记住 → 迁到 localStorage
    Secret.setRemember(true);
    out.afterRemember = {
      local: localStorage.getItem('aca.v1.secret.key.' + id),
      session: sessionStorage.getItem('aca.v1.secret.key.' + id)
    };
    // 取消 → 回到 sessionStorage
    Secret.setRemember(false);
    out.afterUncheck = {
      local: localStorage.getItem('aca.v1.secret.key.' + id),
      session: sessionStorage.getItem('aca.v1.secret.key.' + id)
    };
    // 清空全部
    ApiEditor.clearAllKeys();
    await new Promise(r => setTimeout(r, 150));
    const yes = document.getElementById('confirmYes');
    if (yes) yes.click();
    await new Promise(r => setTimeout(r, 250));
    out.afterClear = {
      local: localStorage.getItem('aca.v1.secret.key.' + id),
      session: sessionStorage.getItem('aca.v1.secret.key.' + id)
    };
    return out;
  });
  ck('默认不记住密钥', sec.defaultRemember === false);
  ck('密钥默认只进 sessionStorage', sec.sessionOnly === true && sec.notInLocal === true);
  ck('apis 主体里不含明文密钥', sec.apisPayloadClean === true);
  ck('读出时能补回密钥', sec.hydratedOk === true);
  ck('勾选记住后迁入 localStorage',
    sec.afterRemember.local === 'sk-test-abc' && sec.afterRemember.session === null,
    JSON.stringify(sec.afterRemember));
  ck('取消记住后回到 sessionStorage',
    sec.afterUncheck.session === 'sk-test-abc' && sec.afterUncheck.local === null,
    JSON.stringify(sec.afterUncheck));
  ck('清空全部会清两层',
    sec.afterClear.local === null && sec.afterClear.session === null);

  /* ================= 4. 渲染性能与功能完整性 ================= */
  console.log('\n=== 4. P1-1 渲染优化 ===');
  const perf = await p.evaluate(async () => {
    pendingMode = 'pve'; refreshSetup(); UI.go('setup');
    document.getElementById('selSide').value = 'w';
    document.getElementById('selDiff').value = '1';
    document.getElementById('rngDelay').value = '0';
    startMatch();
    await new Promise(r => setTimeout(r, 1600));
    const v = Game.view;

    // 底纹缓存
    const hasCache = !!v._boardCache && v._boardCache.width === v.size;
    // 单次 draw 耗时
    const N = 60;
    const t0 = performance.now();
    for (let i = 0; i < N; i++) { v.dirty = true; v.draw(); }
    const perDraw = (performance.now() - t0) / N;

    // 空闲停表：静置 1.2s 后 loop 应已停
    v.dirty = false;
    await new Promise(r => setTimeout(r, 1200));
    const idle = { loopRunning: v._loopRunning, dirty: v.dirty };

    // invalidate 能唤醒
    v.invalidate();
    await new Promise(r => setTimeout(r, 120));
    const woke = v._loopRunning;

    // 动画仍能完成（关键回归：停表不能卡住 applyMove）
    const before = Game.moves.length;
    v.animateMove('e7', 'e5', null, {});
    const animDone = await Promise.race([
      new Promise(r => setTimeout(() => r('timeout'), 2500)),
      (async () => { while (v.anims.length) await new Promise(r => setTimeout(r, 40)); return 'done'; })()
    ]);
    return {
      hasCache, perDraw: +perDraw.toFixed(3), idle, woke, animDone,
      boardSize: v.size, movesBefore: before
    };
  });
  ck('棋盘底纹已离屏缓存', perf.hasCache === true, perf.boardSize + 'px');
  ck('单次 draw < 1ms', perf.perDraw < 1, perf.perDraw + 'ms');
  ck('空闲后 rAF 已停表', perf.idle.loopRunning === false, 'dirty=' + perf.idle.dirty);
  ck('invalidate 能唤醒循环', perf.woke === true);
  ck('停表后动画仍能完成', perf.animDone === 'done', perf.animDone);

  /* 真实走子必须被记录（早先停表导致的 bug 就在这里暴露） */
  const realMove = await p.evaluate(async () => {
    const v = Game.view;
    v.dirty = false;
    await new Promise(r => setTimeout(r, 1200));     // 确保处于停表状态
    const loopWasStopped = v._loopRunning === false;
    const before = Game.moves.length;
    Game.onSquareClick('d2');
    await new Promise(r => setTimeout(r, 120));
    Game.onSquareClick('d4');
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 150));
      if (Game.moves.length > before) break;
    }
    return { loopWasStopped, before, after: Game.moves.length, last: Game.moves[Game.moves.length - 1] && Game.moves[Game.moves.length - 1].san };
  });
  ck('走子前确实处于停表状态', realMove.loopWasStopped === true);
  ck('停表状态下走子仍被记录', realMove.after > realMove.before,
    realMove.before + ' → ' + realMove.after + ' (' + realMove.last + ')');

  await p.screenshot({ path: path.join(SHOT, 'c-perf.png') });

  /* ================= 5. 错误 ================= */
  console.log('\n=== 5. 错误 / 资源 ===');
  console.log(errs.length ? errs.slice(0, 5).join('\n') : '(无)');
  ck('HTTP 页面无 JS 运行时错误', errs.length === 0);

  console.log('\n RESULT: ' + (fails ? fails + ' FAILED' : 'ALL PASS'));
  await b.close();
  process.exit(fails ? 1 : 0);
})();
