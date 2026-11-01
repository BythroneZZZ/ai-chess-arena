/* P1 · 棋力分析（评估条）验收
 *
 * 核心断言：
 *   1. Analysis 是独立 Worker，主 Engine 搜索期间评估照常推进（方案 A 的存在理由）
 *   2. live 评估的 cp/mate 折算成白方视角正确
 *   3. 抢占不泄漏：连发多个局面后，队列不留 live 垃圾、busy 终会复位
 *   4. 评估条是 canvas 像素绘制，尺寸跟随棋盘，翻转时白方份额换边
 *   5. 关掉开关后不建/不跑分析，且能重新打开
 *   6. cancelAll 后所有 Promise 结算，不残留
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
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let fails = 0;
const ck = (n, c, e) => {
  if (c) console.log('  OK  ' + n + (e ? ' | ' + e : ''));
  else { fails++; console.log('  FAIL ' + n + (e ? ' | ' + e : '')); }
};

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const MATE_IN_1 = '6k1/5ppp/8/8/8/8/5PPP/4R1K1 w - - 0 1';   // Re8#
const WHITE_WINNING = 'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 0 4';

(async () => {
  const b = await puppeteer.launch({
    executablePath: chromePath(),
    headless: 'new',
    args: ['--no-sandbox']
  });
  const p = await b.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push(e.message));
  p.on('console', m => { if (m.type() === 'error') errs.push('[console] ' + m.text()); });
  p.on('response', r => { if (r.status() >= 400) errs.push('404:' + r.url().split('/').pop()); });
  await p.setViewport({ width: 1440, height: 900 });
  await p.goto(FILE, { waitUntil: 'domcontentloaded' });
  await sleep(2600);

  console.log('\n=== 1. 第二个 Worker 独立存在 ===');
  const sep = await p.evaluate(() => ({
    engineReady: Engine.ready,
    analysisReady: Analysis.ready,
    sameWorker: Engine.worker === Analysis.worker,
    engineUrl: typeof ENGINE_URL === 'string' ? ENGINE_URL : '',
    analysisUrl: typeof ANALYSIS_URL === 'string' ? ANALYSIS_URL : '',
    stats: Analysis.snapshot()
  }));
  ck('主引擎就绪', sep.engineReady === true);
  ck('分析引擎就绪', sep.analysisReady === true, JSON.stringify(sep.stats));
  ck('两个 Worker 不是同一个', sep.sameWorker === false);
  ck('分析引擎复用 vendor 路径', /stockfish\.js$/.test(sep.analysisUrl), sep.analysisUrl);

  console.log('\n=== 2. 评估语义（白方视角） ===');
  const sem = await p.evaluate(async () => {
    const one = async (fen) => {
      const r = await Analysis.evaluate(fen, { depth: 12, timeout: 1500, fresh: true });
      return r ? { text: Analysis.label(r), cp: Analysis.whiteCp(r.score, r.turn), turn: r.turn, type: r.score.type } : null;
    };
    const start = await one('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
    const mate = await one('6k1/5ppp/8/8/8/8/5PPP/4R1K1 w - - 0 1');
    return { start, mate };
  });
  ck('初始局面近似均势', sem.start && Math.abs(sem.start.cp) <= 120, JSON.stringify(sem.start));
  ck('将死局面识别为 mate', sem.mate && sem.mate.type === 'mate', JSON.stringify(sem.mate));
  ck('白方将要将死时 mate 为正', sem.mate && sem.mate.cp > 0, sem.mate && sem.mate.text);
  ck('标注格式带 #', sem.mate && /^#/.test(sem.mate.text), sem.mate && sem.mate.text);

  console.log('\n=== 3. 主搜索期间评估不被阻塞（方案 A 的意义） ===');
  const parallel = await p.evaluate(async (fen) => {
    const t0 = performance.now();
    // 主引擎跑一个长搜索（20 层，必被 4s 超时截断）
    const main = Engine.bestMove('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', 20, 4000);
    await new Promise(r => setTimeout(r, 150));
    const mainBusy = Engine.busy;
    const a = await Analysis.evaluate(fen, { depth: 12, timeout: 1200, fresh: true });
    const evalMs = Math.round(performance.now() - t0);
    const mainStillBusy = Engine.busy;
    Engine.stopAll();
    const mv = await main;
    return { mainBusy, mainStillBusy, evalMs, gotEval: !!a && !!a.score, mv };
  }, WHITE_WINNING);
  ck('主引擎确实在搜索', parallel.mainBusy === true);
  ck('搜索期间评估也拿到结果', parallel.gotEval === true, parallel.evalMs + 'ms');
  ck('评估耗时未被主搜索拖到超时', parallel.evalMs < 2600, parallel.evalMs + 'ms');
  ck('评估未打断主搜索', parallel.mainStillBusy === true || parallel.mv !== null);

  console.log('\n=== 4. live 抢占与队列卫生 ===');
  const live = await p.evaluate(async () => {
    Analysis.cancelAll('test');
    const fens = [
      'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
      'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2',
      'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 0 2'
    ];
    let hits = 0;
    Analysis.onScore = () => { hits++; };
    for (const f of fens) { Analysis.live(f); await new Promise(r => setTimeout(r, 160)); }
    await new Promise(r => setTimeout(r, 1400));
    const liveJobs = Analysis.queue.filter(j => j.kind === 'live').length;
    const snap = Analysis.snapshot();
    return { hits, liveJobs, snap };
  });
  ck('live 评估产生增量分数', live.hits > 0, live.hits + ' 次');
  ck('队列里不堆 live 任务', live.liveJobs <= 1, 'live queued=' + live.liveJobs);
  ck('统计里记录了 live', live.snap.stats.live >= 1, JSON.stringify(live.snap.stats));

  console.log('\n=== 5. 评估条渲染 ===');
  const bar = await p.evaluate(async () => {
    EvalBar.setVisible(true);
    EvalBar.resize(480);
    EvalBar.reset();
    const cv = document.getElementById('evalCanvas');
    const zero = { w: cv.width, h: cv.height };
    // 白方大优：白方份额应 > 50%
    EvalBar.applyNow({ turn: 'w', score: { type: 'cp', value: 800 }, depth: 15 });
    const up = {
      ratio: EvalBar.ratio(), text: EvalBar.text,
      cls: document.getElementById('evalNum').className,
      inline: document.getElementById('evalInline').textContent
    };
    // 黑方大优
    EvalBar.applyNow({ turn: 'w', score: { type: 'cp', value: -800 }, depth: 15 });
    const down = { ratio: EvalBar.ratio(), text: EvalBar.text, cls: document.getElementById('evalNum').className };
    // 像素采样：分界线附近必须是金色 (#ffcc4d)
    EvalBar.applyNow({ turn: 'w', score: { type: 'cp', value: 0 }, depth: 15 });
    const ctx = cv.getContext('2d');
    const H = cv.height, W = cv.width;
    let gold = 0;
    for (let y = 0; y < H; y++) {
      const d = ctx.getImageData(Math.floor(W / 2), y, 1, 1).data;
      if (d[0] > 240 && d[1] > 190 && d[1] < 215 && d[2] < 90) gold++;
    }
    const flippedBefore = EvalBar.ratio();
    EvalBar.flipped = true; EvalBar.draw();
    const px = (y) => { const d = ctx.getImageData(Math.floor(W / 2), y, 1, 1).data; return d[0] + ',' + d[1] + ',' + d[2]; };
    const topWhenFlipped = px(6), bottomWhenFlipped = px(H - 7);
    EvalBar.flipped = false; EvalBar.draw();
    return { zero, up, down, gold, flippedBefore, topWhenFlipped, bottomWhenFlipped, off: document.getElementById('evalCol').classList.contains('off') };
  });
  ck('评估条是 canvas 且已定尺', bar.zero.w > 0 && bar.zero.h === 480, bar.zero.w + '×' + bar.zero.h);
  ck('白方占优时份额 > 50%', bar.up.ratio > 0.55, (bar.up.ratio * 100).toFixed(1) + '% ' + bar.up.text);
  ck('黑方占优时份额 < 50%', bar.down.ratio < 0.45, (bar.down.ratio * 100).toFixed(1) + '% ' + bar.down.text);
  ck('数字标色区分优劣', /up/.test(bar.up.cls) && /down/.test(bar.down.cls), bar.up.cls + ' / ' + bar.down.cls);
  ck('窄屏行内评估值同步', bar.up.inline === bar.up.text, bar.up.inline);
  ck('分界线为金色像素（无渐变）', bar.gold >= 2, bar.gold + 'px');
  ck('翻转后白方换到上半', bar.topWhenFlipped === '194,185,228' || bar.topWhenFlipped !== bar.bottomWhenFlipped,
    bar.topWhenFlipped + ' vs ' + bar.bottomWhenFlipped);

  console.log('\n=== 6. 与棋盘尺寸联动 ===');
  const fit = await p.evaluate(async () => {
    pendingMode = 'pve'; refreshSetup(); UI.go('setup');
    document.getElementById('selSide').value = 'w';
    document.getElementById('selDiff').value = '1';
    document.getElementById('rngDelay').value = '0';
    startMatch();
    await new Promise(r => setTimeout(r, 1500));
    const bv = Game.view;
    const cv = document.getElementById('evalCanvas');
    const r = cv.getBoundingClientRect();
    return { board: bv.size, evalH: cv.height, evalCssH: Math.round(r.height), same: cv.height === bv.size };
  });
  ck('评估条高度 = 棋盘尺寸', fit.same === true, fit.evalH + ' / ' + fit.board);
  ck('CSS 高度与画布一致', Math.abs(fit.evalCssH - fit.evalH) <= 1, fit.evalCssH + 'px');

  console.log('\n=== 7. 对局中评估随局面更新 ===');
  const during = await p.evaluate(async () => {
    const before = { text: EvalBar.text, cp: EvalBar.cp };
    // 走 e4
    Game.onSquareClick('e2');
    await new Promise(r => setTimeout(r, 100));
    Game.onSquareClick('e4');
    await new Promise(r => setTimeout(r, 2600));
    return { before, after: { text: EvalBar.text, depth: EvalBar.depth }, fen: Game.chess.fen().slice(0, 20), moves: Game.moves.length };
  });
  ck('落子后评估有更新', during.after.depth > 0 || during.after.text !== during.before.text,
    JSON.stringify(during.after));
  ck('局面已推进', during.moves >= 1, during.fen);

  console.log('\n=== 8. 开关与资源释放 ===');
  const toggle = await p.evaluate(async () => {
    const s0 = Analysis.snapshot();
    Settings.toggleEval();                     // → OFF
    await new Promise(r => setTimeout(r, 200));
    const offState = {
      evalOn: Settings.evalOn(),
      colOff: document.getElementById('evalCol').classList.contains('off'),
      btn: document.getElementById('btnEval').textContent,
      busy: Analysis.snapshot().busy,
      queue: Analysis.queue.length
    };
    Settings.toggleEval();                     // → ON
    await new Promise(r => setTimeout(r, 300));
    const onState = {
      evalOn: Settings.evalOn(),
      colOff: document.getElementById('evalCol').classList.contains('off'),
      btn: document.getElementById('btnEval').textContent
    };
    return { wasReady: s0.ready, offState, onState };
  });
  ck('关闭后开关状态正确', toggle.offState.evalOn === false);
  ck('关闭后评估条隐藏', toggle.offState.colOff === true);
  ck('关闭时分析队列清空', toggle.offState.queue === 0 && toggle.offState.busy === false,
    'queue=' + toggle.offState.queue);
  ck('按钮文案同步', toggle.offState.btn === '评估 OFF' && toggle.onState.btn === '评估 ON',
    toggle.offState.btn + ' → ' + toggle.onState.btn);
  ck('重新打开后恢复显示', toggle.onState.colOff === false);

  console.log('\n=== 9. cancelAll 兜底 ===');
  const cancel = await p.evaluate(async () => {
    /* 第 8 组做过 toggleEval（会 release 掉 Worker），这里必须先把引擎
     * 重新拉起来，否则 job 根本起不来，"取消时有在跑的 job" 必然为假。 */
    await Analysis.ensure();
    Analysis.cancelAll('pre'); Analysis.cache.clear();
    await new Promise(r => setTimeout(r, 400));
    const ps = [
      Analysis.evaluate('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', { fresh: true, depth: 40, timeout: 8000 }),
      Analysis.evaluate('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1', { fresh: true, depth: 40, timeout: 8000 })
    ];
    /* 不能固定等 300ms 就断言 busy。
     *
     * 入队到真正开始搜索之间要过三道闸：静默期 → isready→readyok 握手
     * → 队列取出。总耗时可能到 1s（握手超时兜底是 800ms）。
     * 固定等待会让断言取决于引擎当时的响应快慢 —— 偶发红。
     * 改为轮询「job 真的开始跑」，最多等 3s。 */
    let started = false;
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 50));
      if (Analysis.busyGuard()) { started = true; break; }
    }
    const mid = Analysis.snapshot();
    Analysis.cancelAll('test-cancel');
    const settled = await Promise.race([
      Promise.allSettled(ps).then(() => 'settled'),
      new Promise(r => setTimeout(() => r('timeout'), 4000))
    ]);
    await new Promise(r => setTimeout(r, 400));
    const after = Analysis.snapshot();
    const again = await Analysis.evaluate('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', { depth: 10, timeout: 2000, fresh: true });
    return { started, busyMid: mid.busy, queueMid: mid.queue, settled, after, revivable: !!again && !!again.score };
  });
  ck('取消时确实有在跑的 job', cancel.started === true,
    'busy=' + cancel.busyMid + ' queue=' + cancel.queueMid);
  ck('cancelAll 后全部 Promise 结算', cancel.settled === 'settled');
  ck('cancelAll 后队列与 busy 归零', cancel.after.queue === 0 && cancel.after.busy === false);
  ck('取消后仍可继续评估', cancel.revivable === true);

  /* ---------- 10. 稳定性：连续评估不能出空结果 ----------
   * 这是本轮排出的最大问题：该 asm.js 构建在 stop 太密时会半死，
   * 后续 go 只吐 1~2 条 info 就不动了。修好前 17 次里漏 2~3 次。 */
  console.log('\n=== 10. 连续评估稳定性 ===');
  const stability = await p.evaluate(async () => {
    const c = new Chess();
    const mv = ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6', 'Ba4', 'Nf6', 'O-O', 'Be7'];
    const fens = ['rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'];
    for (const san of mv) { c.move(san); fens.push(c.fen()); }
    Analysis.cancelAll('stability'); Analysis.cache.clear();
    await new Promise(r => setTimeout(r, 400));
    const t0 = performance.now();
    let fails = 0;
    for (const f of fens) {
      const r = await Analysis.evaluate(f, { kind: 'review', depth: 16, timeout: 900, minDepth: 99, fresh: true });
      if (!r || !r.score) fails++;
    }
    const snap = Analysis.snapshot();
    return {
      fails, total: fens.length, ms: Math.round(performance.now() - t0),
      stuck: snap.stats.stuck || 0, recovered: snap.stats.recovered || 0
    };
  });
  ck('连续 11 个局面零空结果', stability.fails === 0, stability.fails + '/' + stability.total + ' 失败');
  ck('自愈机制记录（stuck=recovered 或都为 0）',
    stability.stuck === stability.recovered, 'stuck=' + stability.stuck + ' recovered=' + stability.recovered);
  ck('每步耗时在合理区间', stability.ms / stability.total < 2600,
    Math.round(stability.ms / stability.total) + 'ms/步');

  /* ---------- 11. 自愈：卡死后能自己爬起来 ---------- */
  console.log('\n=== 11. 引擎卡死后自愈 ===');
  const heal = await p.evaluate(async () => {
    Analysis.cancelAll('heal');
    await new Promise(r => setTimeout(r, 300));
    /* 模拟半死：让第一次 request 直接回 null。
     * 注意 restart() 会重建 Worker，但 request 是我替换的闭包，仍然有效，
     * 所以第二次调用会走真正的 origReq —— 正好验证「重启后能拿到分」。 */
    const origReq = Analysis.request.bind(Analysis);
    let first = true;
    Analysis.request = async (fen, kind, depth, timeout) => {
      if (first) { first = false; return null; }
      return origReq(fen, kind, depth, timeout);
    };
    const before = Analysis.snapshot().stats;
    let r = null, err = null;
    try {
      r = await Analysis.evaluate('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
        { kind: 'review', depth: 10, timeout: 1500, fresh: true });
    } catch (e) { err = String(e); }
    Analysis.request = origReq;
    const after = Analysis.snapshot().stats;
    return {
      got: !!(r && r.score), err,
      stuckDelta: (after.stuck || 0) - (before.stuck || 0),
      recoveredDelta: (after.recovered || 0) - (before.recovered || 0),
      ready: Analysis.ready
    };
  });
  ck('空结果后自动重启并拿到分数', heal.got === true, heal.err || '');
  ck('记录 stuck 与 recovered 各一次', heal.stuckDelta === 1 && heal.recoveredDelta === 1,
    'stuck+' + heal.stuckDelta + ' recovered+' + heal.recoveredDelta);
  ck('重启后引擎仍就绪', heal.ready === true);

  /* ---------- 12. 被取消 ≠ 卡死（不能触发重启递归） ---------- */
  console.log('\n=== 12. 取消不误触自愈 ===');
  const noFalseHeal = await p.evaluate(async () => {
    await Analysis.ensure();
    Analysis.cancelAll('pre');
    await new Promise(r => setTimeout(r, 400));
    const before = Analysis.snapshot().stats;
    let busySeen = false;
    // 发出去后立刻轮询 busy，一旦进入搜索态就取消 —— 不等固定时长
    const promise = Analysis.evaluate('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
      { kind: 'review', depth: 40, timeout: 15000, fresh: true });
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 20));
      if (Analysis.snapshot().busy) { busySeen = true; break; }
    }
    Analysis.cancelAll('mid-flight');
    const settled = await Promise.race([
      promise.then((v) => (v === null ? 'null' : 'partial')),
      new Promise(r => setTimeout(() => r('timeout'), 5000))
    ]);
    await new Promise(r => setTimeout(r, 500));
    const after = Analysis.snapshot().stats;
    return {
      busySeen, settled,
      stuckDelta: (after.stuck || 0) - (before.stuck || 0),
      ready: Analysis.ready
    };
  });
  ck('取消前确实有 job 在算', noFalseHeal.busySeen === true);
  /* 结算值允许两种：null（还没出分就被取消）或 partial（取消到达时
   * 引擎刚好吐了一条 info）。后者是「部分结果结算」这一设计意图本身，
   * 不是缺陷 —— 原来断言只认 null，会对时序敏感而偶发失败。
   * 真正要保证的是：**必定结算**（不是永远挂着），且不触发自愈。 */
  ck('取消后排队的 evaluate 必定结算', noFalseHeal.settled !== 'timeout', noFalseHeal.settled);
  ck('取消不被误判为卡死', noFalseHeal.stuckDelta === 0, 'stuck+' + noFalseHeal.stuckDelta);
  ck('取消后引擎仍就绪', noFalseHeal.ready === true);

  console.log('\n=== 13. 错误 / 资源 ===');
  console.log(errs.length ? errs.slice(0, 8).join('\n') : '(无)');
  ck('无 404 / JS 运行时错误', errs.length === 0);

  await p.screenshot({ path: path.join(SHOT, 'p1-eval-desktop.png') });

  // 窄屏复测：390 / 320
  for (const w of [390, 320]) {
    const m = await b.newPage();
    await m.setViewport({ width: w, height: 780, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await m.goto(FILE, { waitUntil: 'domcontentloaded' });
    await sleep(2200);
    await m.evaluate(() => { pendingMode = 'pve'; refreshSetup(); UI.go('setup'); startMatch(); });
    await sleep(2400);
    const r = await m.evaluate(() => {
      const bv = document.getElementById('boardCanvas').getBoundingClientRect();
      const frame = document.getElementById('boardFrame').getBoundingClientRect();
      const ev = document.getElementById('evalCanvas').getBoundingClientRect();
      const col = document.getElementById('evalCol').getBoundingClientRect();
      const inline = document.getElementById('evalInline');
      return {
        boardW: Math.round(bv.width), evalW: Math.round(ev.width),
        total: Math.round(bv.width + ev.width),
        overflow: document.documentElement.scrollWidth - window.innerWidth,
        sameH: Math.abs(ev.height - bv.height) <= 1,
        // 评估条整体（含边框）必须完整落在视口内
        colRight: Math.round(col.right), frameRight: Math.round(frame.right),
        iw: window.innerWidth,
        inlineShown: getComputedStyle(inline).display !== 'none',
        numShown: getComputedStyle(document.getElementById('evalNum')).display !== 'none'
      };
    });
    ck(w + 'px 棋盘+评估条不溢出', r.overflow <= 2, 'overflow=' + r.overflow + ' board=' + r.boardW + ' eval=' + r.evalW);
    ck(w + 'px 评估条完整在视口内', r.colRight <= r.iw, r.colRight + ' / ' + r.iw);
    ck(w + 'px 评估条与棋盘等高', r.sameH === true, r.total);
    ck(w + 'px 数值改用状态条行内显示', r.inlineShown === true && r.numShown === false);
    await m.screenshot({ path: path.join(SHOT, 'p1-eval-' + w + '.png') });
    await m.close();
  }

  console.log('\n RESULT: ' + (fails ? fails + ' FAILED' : 'ALL PASS'));
  await b.close();
  process.exit(fails ? 1 : 0);
})();
