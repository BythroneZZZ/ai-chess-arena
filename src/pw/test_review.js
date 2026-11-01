/* P2 · 复盘报告验收
 *
 * 断言：
 *   1. build() 是纯函数：给定 cps 序列，失误分级 / 准确率 / 转折点算法正确
 *   2. 真实棋谱能被逐手评估并标注（用一串明显的坏棋制造 ??）
 *   3. 结果写回棋谱（rec.review + 每步 tag），落 localStorage
 *   4. 回放页能渲染报告、点条目跳步、步进时同步当前步标注
 *   5. 复盘走的是 Analysis（第二 Worker），全程不碰主 Engine
 *   6. 取消复盘不残留 job
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

/* 一盘故意下得很差的棋：白方 f3/g4 自毁，黑方 Qh4# —— 用来制造 ?? 级失误 */
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
  await p.setViewport({ width: 1440, height: 900 });
  await p.goto(FILE, { waitUntil: 'domcontentloaded' });
  await sleep(2600);

  console.log('\n=== 1. 分级算法（纯函数） ===');
  const pure = await p.evaluate(() => {
    const rec = {
      id: 'r1', moves: [
        { color: 'w', san: 'e4', fen: 'f1' },
        { color: 'b', san: 'e5', fen: 'f2' },
        { color: 'w', san: 'Qh5', fen: 'f3' },
        { color: 'b', san: 'Nc6', fen: 'f4' },
        { color: 'w', san: 'Qxf7', fen: 'f5' },
        { color: 'b', san: 'Kxf7', fen: 'f6' }
      ]
    };
    // 白方视角 cp：前四步平静，第 5 步白方弃后送子（10 → −600）
    const cps = [0, 20, 15, 10, 10, -600, -650];
    const pos = Review.positionsOf(rec).map((x, i) => Object.assign({}, x, { fen: 'pos' + i }));
    const r = Review.build(rec, pos, cps);
    return {
      moves: r.moves.map(m => ({ san: m.san, loss: m.loss, tag: m.tag })),
      counts: r.counts,
      accuracy: r.accuracy,
      turn: r.turn,
      turnDelta: r.turnDelta,
      keyMoments: r.keyMoments,
      aclW: r.aclW, aclB: r.aclB
    };
  });
  console.log('    ' + pure.moves.map(m => `${m.san}:${m.loss}(${m.tag})`).join(' '));
  ck('正常步 loss = 0', pure.moves[0].loss === 0 && pure.moves[0].tag === 'good');
  ck('白方送子判为严重失误', pure.moves[4].tag === 'blunder', 'loss=' + pure.moves[4].loss);
  ck('黑方吃回不算失误（己方视角）', pure.moves[5].tag === 'good', 'loss=' + pure.moves[5].loss);
  ck('失误计数正确', pure.counts.blunder === 1, JSON.stringify(pure.counts));
  ck('转折点定位在送子那步', pure.turn === 5, 'ply=' + pure.turn);
  ck('关键片段含该步', pure.keyMoments.includes(5), JSON.stringify(pure.keyMoments));
  ck('准确率在 0~100', pure.accuracy >= 0 && pure.accuracy <= 100, pure.accuracy + '%');
  ck('两侧均损分开统计', pure.aclW > pure.aclB, `W=${pure.aclW} B=${pure.aclB}`);

  console.log('\n=== 2. 分级阈值边界 ===');
  const edges = await p.evaluate(() => {
    const mk = (lossW) => {
      const rec = { id: 'x', moves: [{ color: 'w', san: 'a3', fen: 'f' }] };
      const pos = [{ ply: 0, fen: 'a' }, { ply: 1, fen: 'b' }];
      return Review.build(rec, pos, [0, -lossW]).moves[0].tag;
    };
    return {
      t69: mk(69), t70: mk(70), t149: mk(149), t150: mk(150), t299: mk(299), t300: mk(300), big: mk(5000)
    };
  });
  ck('69cp → good', edges.t69 === 'good');
  ck('70cp → inaccuracy', edges.t70 === 'inaccuracy');
  ck('150cp → mistake', edges.t150 === 'mistake');
  ck('300cp → blunder', edges.t300 === 'blunder');
  ck('超大损失被判为 blunder', edges.big === 'blunder');

  console.log('\n=== 2b. 缺评估不得静默判 good（g4 漏判回归） ===');
  const missing = await p.evaluate(() => {
    // 4 步：f3 e5 g4 Qh4#；故意把第 3 步之后（g4 造成杀棋）的评估设为 null
    const c = new Chess();
    const script = ['f3', 'e5', 'g4', 'Qh4#'];
    const moves = [];
    for (const san of script) {
      const mv = c.move(san);
      moves.push({ color: mv.color, san: mv.san, uci: mv.from + mv.to, fen: c.fen() });
    }
    const rec = { id: 'm', moves };
    const pos = Review.positionsOf(rec);
    // 5 个局面（ply 0~4）：前两步正常，g4 之后（ply 3、4）缺评估 —— 与实测偶发丢分同形
    const cps = [0, 30, 20, null, null];
    const r = Review.build(rec, pos, cps);
    return {
      tags: r.moves.map(m => m.san + ':' + m.tag),
      incomplete: r.incomplete,
      incompleteCount: r.incompleteCount,
      keyMoments: r.keyMoments
    };
  });
  console.log('    ' + missing.tags.join(' '));
  ck('缺评估的步标为 unknown 而非 good',
    missing.tags.filter(t => /:(unknown)$/.test(t)).length === 2, missing.tags.join(' '));
  ck('incomplete 记录缺失步号',
    missing.incomplete.join(',') === '3,4', missing.incomplete.join(','));
  ck('incompleteCount 与之一致', missing.incompleteCount === 2);
  ck('unknown 不进关键失误列表',
    !missing.keyMoments.some(p => [3, 4].includes(p)), missing.keyMoments.join(','));

  console.log('\n=== 3. 真实棋谱复盘 ===');
  const real = await p.evaluate(async () => {
    // 用 chess.js 构造一盘：白方送后 + 送车，最后被杀
    const c = new Chess();
    const script = ['f3', 'e5', 'g4', 'Qh4#'];
    const moves = [];
    for (const san of script) {
      const mv = c.move(san);
      moves.push({ color: mv.color, san: mv.san, uci: mv.from + mv.to + (mv.promotion || ''), fen: c.fen(), thought: '', source: 'test' });
    }
    const rec = {
      id: 'rec_test_review', date: new Date().toISOString(), mode: 'pve',
      result: 'checkmate', winner: 'b',
      white: { charId: Store.chars[0].id, name: '白', api: '测试' },
      black: { charId: Store.chars[1].id, name: '黑', api: '测试' },
      moves, pgn: c.pgn(), duration: 3
    };
    Store.records.unshift(rec);
    Store.saveRecords();
    const usedMain = [];
    const origBest = Engine.bestMove.bind(Engine);
    Engine.bestMove = (...a) => { usedMain.push('bestMove'); return origBest(...a); };
    const t0 = performance.now();
    const res = await Review.start(rec, { onProgress: () => { } });
    Engine.bestMove = origBest;
    return {
      ok: !!res,
      ms: Math.round(performance.now() - t0),
      n: res ? res.moves.length : 0,
      tags: res ? res.moves.map(m => m.san + ':' + m.tag) : [],
      counts: res ? res.counts : null,
      accuracy: res ? res.accuracy : null,
      usedMain,
      recHasReview: !!rec.review,
      moveTagged: rec.moves.map(m => m.tag),
      persisted: !!(JSON.parse(localStorage.getItem('aca.v1.records') || '[]')[0] || {}).review
    };
  });
  console.log('    ' + real.tags.join(' '));
  ck('复盘完成', real.ok === true, real.ms + 'ms / ' + real.n + ' 步');
  ck('f3+g4 被判为失误', real.tags.some(t => /blunder|mistake/.test(t)), real.tags.join(' '));
  ck('复盘不调用主引擎 bestMove', real.usedMain.length === 0, real.usedMain.join(','));
  ck('结果写回记录', real.recHasReview === true);
  ck('每步带上标注', real.moveTagged.every(t => typeof t === 'string'), real.moveTagged.join(','));
  ck('已落 localStorage', real.persisted === true);

  console.log('\n=== 4. 回放页渲染 ===');
  const ui = await p.evaluate(async () => {
    const rec = Store.records[0];
    Replay.open(rec);
    await new Promise(r => setTimeout(r, 400));
    const panel = document.getElementById('reviewPanel');
    const rows = [...document.querySelectorAll('#reviewList .rv-row')];
    const acc = document.getElementById('reviewAcc').textContent;
    const summary = document.getElementById('reviewSummary').textContent;
    const turn = document.getElementById('reviewTurn').textContent;
    // 点第一条关键失误 → 跳到该步
    let jumped = null;
    if (rows.length) {
      rows[0].click();
      await new Promise(r => setTimeout(r, 200));
      jumped = UI.replayIdx;
    }
    // 步进同步标注
    Replay.goto(0);
    const at0 = document.getElementById('reviewNow').textContent;
    Replay.goto(1);
    const at1 = { txt: document.getElementById('reviewNow').textContent, cls: document.getElementById('reviewNow').className };
    return {
      hasPanel: !!panel, rows: rows.length, acc, summary, turn, jumped, at0, at1,
      cls: rows.length ? rows[0].className : ''
    };
  });
  ck('复盘面板存在', ui.hasPanel === true);
  ck('关键失误列表非空', ui.rows > 0, ui.rows + ' 条');
  ck('准确率已显示', /%$/.test(ui.acc), ui.acc);
  ck('摘要含失误计数', /失误|准确/.test(ui.summary), ui.summary.replace(/\s+/g, ' ').slice(0, 40));
  ck('转折点行已填', ui.turn.length > 0, ui.turn.slice(0, 40));
  ck('点条目跳到该步', ui.jumped >= 1, 'idx=' + ui.jumped);
  ck('开局步标注为开局', /开局/.test(ui.at0), ui.at0);
  ck('步进时同步当前步标注', ui.at1.txt.length > 0, ui.at1.txt);
  ck('行上有分级样式', /rv-row (blunder|mistake|inaccuracy)/.test(ui.cls), ui.cls);

  await p.screenshot({ path: path.join(SHOT, 'p2-review-replay.png') });

  console.log('\n=== 5. 复盘结果存进棋谱（刷新后仍在） ===');
  await p.reload({ waitUntil: 'domcontentloaded' });
  await sleep(2200);
  const persist = await p.evaluate(() => {
    const rec = Store.records.find(r => r.id === 'rec_test_review');
    return { found: !!rec, hasReview: !!(rec && rec.review), acc: rec && rec.review ? rec.review.accuracy : null };
  });
  ck('刷新后棋谱仍在', persist.found === true);
  ck('刷新后复盘数据仍在', persist.hasReview === true, 'acc=' + persist.acc);

  console.log('\n=== 6. 取消复盘不残留 ===');
  const cancel = await p.evaluate(async () => {
    Analysis.cancelAll('pre');
    const rec = Store.records.find(r => r.id === 'rec_test_review');
    const promise = Review.start(rec, { onProgress: () => { } });
    await new Promise(r => setTimeout(r, 350));
    const running = Review.running;
    Review.cancel();
    const res = await Promise.race([promise, new Promise(r => setTimeout(() => r('timeout'), 3000))]);
    await new Promise(r => setTimeout(r, 300));
    return { running, res, snap: Analysis.snapshot() };
  });
  ck('复盘启动后处于运行态', cancel.running === true);
  ck('取消后 Promise 结算为 null', cancel.res === null, String(cancel.res));
  ck('取消后分析队列清空', cancel.snap.queue === 0 && cancel.snap.busy === false, JSON.stringify(cancel.snap));

  console.log('\n=== 7. 空棋谱/异常输入 ===');
  const empty = await p.evaluate(async () => {
    const a = await Review.start(null);
    const b = await Review.start({ id: 'x', moves: [] });
    const c = Review.build({ moves: [] }, [{ fen: 'a' }], [0]);
    return { a, b, accuracy: c.accuracy, counts: c.counts };
  });
  ck('空输入返回 null', empty.a === null && empty.b === null);
  ck('零步棋不炸', empty.accuracy === null && empty.counts.blunder === 0);

  console.log('\n=== 8. 终局面板入口 ===');
  const entry = await p.evaluate(() => ({
    btn: !!document.getElementById('resReview'),
    bar: !!document.getElementById('reviewBarRes'),
    fill: !!document.getElementById('reviewBarResFill'),
    rpBar: !!document.getElementById('reviewBar'),
    txt: (document.getElementById('reviewBtnText') || {}).textContent
  }));
  ck('结果页有复盘按钮', entry.btn === true, entry.txt);
  ck('结果页进度条独立存在', entry.bar === true && entry.fill === true);
  ck('回放页进度条独立存在', entry.rpBar === true);

  // 进度回调必须同时驱动两个条，且按钮文案回落到「复盘」
  const prog = await p.evaluate(() => {
    ReviewUI.setProgress(3, 10);
    const mid = {
      resFill: document.getElementById('reviewBarResFill').style.width,
      rpFill: document.getElementById('reviewBarFill').style.width,
      resOn: document.getElementById('reviewBarRes').classList.contains('on'),
      txt: document.getElementById('reviewBtnText').textContent
    };
    ReviewUI.setProgress(10, 10);
    const done = {
      resOn: document.getElementById('reviewBarRes').classList.contains('on'),
      txt: document.getElementById('reviewBtnText').textContent,
      disabled: document.getElementById('resReview').disabled
    };
    return { mid, done };
  });
  ck('进度同时驱动两个条', prog.mid.resFill === '30%' && prog.mid.rpFill === '30%',
    prog.mid.resFill + ' / ' + prog.mid.rpFill);
  ck('进度文案带百分比', prog.mid.txt === '复盘 30%', prog.mid.txt);
  ck('完成后按钮复原可点', prog.done.txt === '复盘' && prog.done.disabled === false,
    prog.done.txt + ' disabled=' + prog.done.disabled);

  /* 关键回归：存谱 / 复盘的记录归属必须绑在「当前这一局」上。
   * 曾经的 bug：window.__lastSavedId 跨局不清空，新一局点「复盘」
   * 复盘的是上一盘的棋。 */
  console.log('\n=== 8b. 存谱与复盘的记录归属 ===');
  const ownership = await p.evaluate(async () => {
    Store.records = []; Store.saveRecords();

    // 第一局
    Game.chess = new Chess();
    Game.chess.move('f3'); Game.chess.move('e5');
    Game.moves = [{ color: 'w', san: 'f3', uci: 'f2f3', fen: Game.chess.fen(), thought: '', source: 'test' }];
    Game.savedRecordId = null;
    document.getElementById('resSave').click();
    const id1 = Game.savedRecordId;
    const count1 = Store.records.length;

    // 再点一次存谱：不得产生第二条
    document.getElementById('resSave').click();
    const count2 = Store.records.length;

    // 第二局（新局，不存谱）
    Game.newChess();
    const cleared = Game.savedRecordId === null;
    Game.chess.move('e4');
    Game.moves = [{ color: 'w', san: 'e4', uci: 'e2e4', fen: Game.chess.fen(), thought: '', source: 'test' }];

    // 此时点「复盘」，应当为这一局新建记录，而不是复用上一局
    document.getElementById('resReview').click();
    await new Promise(r => setTimeout(r, 250));
    const id2 = Game.savedRecordId;
    const rec2 = Store.records.find((x) => x.id === id2);
    return {
      id1, count1, count2, cleared, id2,
      sameId: id1 === id2,
      rec2San: rec2 ? rec2.moves.map((m) => m.san).join(',') : null,
      rec1San: (Store.records.find((x) => x.id === id1) || { moves: [] }).moves.map((m) => m.san).join(','),
      total: Store.records.length
    };
  });
  ck('新局清空 savedRecordId', ownership.cleared === true);
  ck('重复存谱不产生副本', ownership.count1 === 1 && ownership.count2 === 1,
    ownership.count1 + ' → ' + ownership.count2);
  ck('新局复盘不复用上一局记录', ownership.sameId === false, 'id1=' + ownership.id1 + ' id2=' + ownership.id2);
  ck('复盘取到的是本局棋步', ownership.rec2San === 'e4', '本局=' + ownership.rec2San + ' 上一局=' + ownership.rec1San);
  ck('两局各自独立入库', ownership.total === 2, '共 ' + ownership.total + ' 条');

  console.log('\n=== 9. 错误 / 资源 ===');
  console.log(errs.length ? errs.slice(0, 6).join('\n') : '(无)');
  ck('无 404 / JS 运行时错误', errs.length === 0);

  console.log('\n RESULT: ' + (fails ? fails + ' FAILED' : 'ALL PASS'));
  await b.close();
  process.exit(fails ? 1 : 0);
})();
