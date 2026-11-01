/* 交互回归护栏（对应第三方报告里的 4 个 P0/H 级 bug）
 *
 * 这组测试的设计原则，正是之前测试体系失明的原因：
 *
 *   1. **既断言禁用态，也断言启用态**
 *      旧测试只验证「不该点的时候是灰的」，从不验证「该点的时候是亮的」，
 *      所以按钮永久置灰也能全绿。
 *
 *   2. **不手动补状态**
 *      旧测试在断言前自己调 updateControlState()，把「接线缺失」擦掉了。
 *      这里只做用户会做的动作（点、等、缩放），状态必须由产品代码自己走到位。
 *
 *   3. **覆盖慢交互场景**
 *      回放步进间隔 >1 秒、落子动画期间 resize、AI 长考后立刻操作 ——
 *      这些「慢」路径是空闲停表优化最容易出事的区间。
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

/* 开一局 PVE 并等到轮到人类 */
const startPve = async (p) => {
  await p.evaluate(() => {
    pendingMode = 'pve'; refreshSetup(); UI.go('setup');
    document.getElementById('selSide').value = 'w';
    document.getElementById('selDiff').value = '1';
    document.getElementById('rngDelay').value = '0';
    startMatch();
  });
  for (let i = 0; i < 100; i++) {
    await sleep(150);
    const ok = await p.evaluate(() =>
      !!(Game.pendingHuman && Game.pendingHuman.color === 'w' && !Game.busy && Game.running));
    if (ok) return true;
  }
  return false;
};

(async () => {
  const b = await puppeteer.launch({
    executablePath: chromePath(),
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });

  /* ================= BUG 1：悔棋/提和按钮的启用态 ================= */
  console.log('\n=== 1. AI 走完后悔棋/提和必须可用 ===');
  const p1 = await b.newPage();
  const errs = [];
  p1.on('pageerror', e => errs.push(e.message));
  await p1.setViewport({ width: 1440, height: 900 });
  await p1.goto(FILE, { waitUntil: 'domcontentloaded' });
  await sleep(2600);

  ck('对局就绪', await startPve(p1) === true);

  // 走一步，等 AI 应招 + 演出收尾
  await p1.evaluate(() => { Game.onSquareClick('e2'); });
  await sleep(150);
  await p1.evaluate(() => { Game.onSquareClick('e4'); });
  for (let i = 0; i < 150; i++) {
    await sleep(200);
    const done = await p1.evaluate(() => Game.moves.length >= 2 && !Game.busy);
    if (done) break;
  }
  await sleep(800);   // 演出/打字机收尾

  const btn = await p1.evaluate(() => ({
    moves: Game.moves.length,
    busy: Game.busy,
    canUse: UndoDraw.canUse(),
    undoDisabled: document.getElementById('btnUndo').disabled,
    drawDisabled: document.getElementById('btnDraw').disabled,
    pending: Game.pendingHuman && Game.pendingHuman.color
  }));
  ck('AI 已经应招', btn.moves >= 2, 'moves=' + btn.moves);
  ck('此时 canUse() 为真', btn.canUse === true);
  /* 核心断言：产品代码自己必须把按钮点亮，不靠测试补状态 */
  ck('悔棋按钮已启用（不手动刷新）', btn.undoDisabled === false, 'disabled=' + btn.undoDisabled);
  ck('提和按钮已启用（不手动刷新）', btn.drawDisabled === false, 'disabled=' + btn.drawDisabled);

  /* 反向：AI 思考期间应当禁用 */
  const during = await p1.evaluate(async () => {
    // 让 AI 开始思考
    Game.onSquareClick('d2');
    await new Promise(r => setTimeout(r, 120));
    Game.onSquareClick('d4');
    await new Promise(r => setTimeout(r, 400));
    return {
      busy: Game.busy,
      undoDisabled: document.getElementById('btnUndo').disabled
    };
  });
  /* 只在确实处于 busy 时断言禁用，避免时序抖动造成假失败 */
  if (during.busy) {
    ck('AI 思考期间悔棋按钮禁用', during.undoDisabled === true);
  } else {
    console.log('  --  AI 思考太快，跳过禁用态断言（busy 已结束）');
  }

  /* 等待回到人类回合后，必须重新亮起 */
  for (let i = 0; i < 150; i++) {
    await sleep(200);
    const ok = await p1.evaluate(() => !Game.busy && Game.pendingHuman && Game.pendingHuman.color === 'w');
    if (ok) break;
  }
  await sleep(600);
  const back = await p1.evaluate(() => ({
    undoDisabled: document.getElementById('btnUndo').disabled,
    canUse: UndoDraw.canUse()
  }));
  ck('回到人类回合后按钮重新启用', back.undoDisabled === false && back.canUse === true,
    'disabled=' + back.undoDisabled + ' canUse=' + back.canUse);

  /* ================= BUG 2：回放慢速步进不能冻结 ================= */
  console.log('\n=== 2. 回放慢速步进画面必须跟随 ===');
  const p2 = await b.newPage();
  p2.on('pageerror', e => errs.push(e.message));
  await p2.setViewport({ width: 1440, height: 900 });
  await p2.goto(FILE, { waitUntil: 'domcontentloaded' });
  await sleep(2400);

  const replay = await p2.evaluate(async () => {
    const c = new Chess();
    const mv = ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5'];
    const moves = [];
    for (const s of mv) {
      const m = c.move(s);
      moves.push({ color: m.color, san: m.san, uci: m.from + m.to, fen: c.fen(), thought: 't', source: 't' });
    }
    Store.records.unshift({
      id: 'rc', date: new Date().toISOString(), mode: 'pve', result: 'draw', winner: null,
      white: { charId: Store.chars[0].id, name: '白', api: 'A' },
      black: { charId: Store.chars[1].id, name: '黑', api: 'A' },
      moves, pgn: c.pgn(), duration: 1
    });
    Store.saveRecords();
    Replay.open(Store.records[0]);
    await new Promise(r => setTimeout(r, 700));

    const v = UI.replayView;
    const shot = () => v.cv.toDataURL();
    const sigs = [shot()];
    // 慢速步进：间隔 1.4s，足以让空闲优化把 rAF 停掉
    for (let k = 1; k <= 3; k++) {
      Replay.goto(k);
      await new Promise(r => setTimeout(r, 1400));
      sigs.push(shot());
    }
    // 相邻帧必须不同（画面真的在变）
    let changed = 0;
    for (let i = 1; i < sigs.length; i++) if (sigs[i] !== sigs[i - 1]) changed++;
    return { frames: sigs.length, changed, loopRunning: v._loopRunning };
  });
  ck('三次步进画面都变了', replay.changed === 3,
    replay.changed + '/' + (replay.frames - 1) + ' 帧变化');

  /* 悔棋路径同样依赖唤醒协议 */
  const undoRedraw = await p2.evaluate(async () => {
    const v = UI.replayView;
    Replay.open(Store.records[0]);
    await new Promise(r => setTimeout(r, 500));
    Replay.goto(4);
    await new Promise(r => setTimeout(r, 1300));
    const before = v.cv.toDataURL();
    Replay.goto(1);
    await new Promise(r => setTimeout(r, 1300));
    return { changed: v.cv.toDataURL() !== before };
  });
  ck('回放跳回前面画面会重绘', undoRedraw.changed === true);

  /* ================= BUG 3：翻转必须棋子与标签一起翻 ================= */
  console.log('\n=== 3. 翻转棋盘棋子要跟着翻 ===');
  const p3 = await b.newPage();
  p3.on('pageerror', e => errs.push(e.message));
  await p3.setViewport({ width: 1440, height: 900 });
  await p3.goto(FILE, { waitUntil: 'domcontentloaded' });
  await sleep(2400);
  await startPve(p3);

  const flip = await p3.evaluate(async () => {
    const v = Game.view;
    const sq = 'a2';
    const before = v.sqCenter(sq);
    document.getElementById('btnFlipBoard').click();
    await new Promise(r => setTimeout(r, 400));
    const after = v.sqCenter(sq);
    const piece = v.pieces.find(x => x.sq === sq);
    const err = piece ? Math.hypot(piece.x - after.x, piece.y - after.y) : 999;
    // 再翻回来
    document.getElementById('btnFlipBoard').click();
    await new Promise(r => setTimeout(r, 300));
    const pieceBack = v.pieces.find(x => x.sq === sq);
    const back = v.sqCenter(sq);
    const errBack = pieceBack ? Math.hypot(pieceBack.x - back.x, pieceBack.y - back.y) : 999;
    return {
      flipped: v.flipped,
      movedPx: Math.round(Math.hypot(after.x - before.x, after.y - before.y)),
      err: Math.round(err), errBack: Math.round(errBack)
    };
  });
  ck('翻转确实改变了坐标系', flip.movedPx > 100, '位移 ' + flip.movedPx + 'px');
  ck('翻转后棋子落在新坐标（误差 <2px）', flip.err < 2, '误差 ' + flip.err + 'px');
  ck('再翻回来仍对齐', flip.errBack < 2, '误差 ' + flip.errBack + 'px');

  /* ================= BUG 4：动画期间 resize 不能吞步 ================= */
  console.log('\n=== 4. 落子动画期间缩放窗口不能丢棋步 ===');
  const p4 = await b.newPage();
  p4.on('pageerror', e => errs.push(e.message));
  await p4.setViewport({ width: 1440, height: 900 });
  await p4.goto(FILE, { waitUntil: 'domcontentloaded' });
  await sleep(2400);
  await startPve(p4);

  const resizeMid = await p4.evaluate(async () => {
    const v = Game.view;
    const before = Game.moves.length;
    Game.onSquareClick('e2');
    await new Promise(r => setTimeout(r, 120));
    Game.onSquareClick('e4');
    // 动画进行中改尺寸（模拟用户缩放窗口）
    await new Promise(r => setTimeout(r, 60));
    window.dispatchEvent(new Event('resize'));
    v.resize(560);
    for (let i = 0; i < 80; i++) {
      await new Promise(r => setTimeout(r, 150));
      if (Game.moves.length > before) break;
    }
    const movedAt = Date.now();
    /* 这里不能固定等 300ms 就断言 busy/anims。
     * moves.push 一发生循环就跳出，而此时 AI（黑方）可能已经开始自己那一步，
     * 于是 300ms 后恰好落在 AI 走子中途 —— busy=true、annims>0，断言随机失败。
     * 正确做法：轮询到「静默点」（非 busy 且动画队列空），再断言是否卡死。 */
    let settled = false;
    for (let i = 0; i < 100; i++) {
      await new Promise(r => setTimeout(r, 150));
      if (!Game.busy && v.anims.length === 0 && Game.moves.length > before) { settled = true; break; }
    }
    return {
      before, after: Game.moves.length,
      san: Game.moves[Game.moves.length - 1] && Game.moves[Game.moves.length - 1].san,
      busy: Game.busy, anims: v.anims.length, size: v.size,
      settled, settleMs: Date.now() - movedAt
    };
  });
  ck('resize 后这一步仍被记录', resizeMid.after > resizeMid.before,
    resizeMid.before + ' → ' + resizeMid.after + ' (' + resizeMid.san + ')');
  ck('落子后回到静默点（没卡死）', resizeMid.settled === true, resizeMid.settleMs + 'ms 内收敛');
  ck('静默时 busy 已复位', resizeMid.busy === false);
  ck('静默时动画队列已清空', resizeMid.anims === 0);
  ck('尺寸已按新值生效', resizeMid.size === 560, resizeMid.size + 'px');

  // 卡死后再走一步验证棋局没坏
  for (let i = 0; i < 100; i++) {
    await sleep(200);
    const ok = await p4.evaluate(() => !Game.busy && Game.pendingHuman && Game.pendingHuman.color === 'w');
    if (ok) break;
  }
  const stillPlayable = await p4.evaluate(async () => {
    const before = Game.moves.length;
    Game.onSquareClick('g1');
    await new Promise(r => setTimeout(r, 120));
    Game.onSquareClick('f3');
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 150));
      if (Game.moves.length > before) break;
    }
    return { before, after: Game.moves.length };
  });
  ck('后续棋步仍可正常落子', stillPlayable.after > stillPlayable.before,
    stillPlayable.before + ' → ' + stillPlayable.after);

  /* ================= 5. 起始气泡台词 ================= */
  console.log('\n=== 5. 开局气泡台词要显示 ===');
  const bubble = await p3.evaluate(() => ({
    left: document.getElementById('bubbleLText').textContent,
    right: document.getElementById('bubbleRText').textContent
  }));
  /* setBubble 的 text 曾是死参数，两句开场白从不出现 */
  ck('左侧气泡有文本', (bubble.left || '').trim().length > 0, JSON.stringify(bubble.left));
  ck('右侧气泡有文本', (bubble.right || '').trim().length > 0, JSON.stringify(bubble.right));

  /* ================= 6. 回放/棋谱页的 XSS 防护 =================
   * 来源字段（mv.source）与配置名（white.api / black.api）都是用户可控：
   * 前者来自 PGN 导入，后者是自由输入的配置名称。
   * 它们被拼进 innerHTML —— 导入一份构造过的棋谱即可执行注入脚本。 */
  console.log('\n=== 6. 用户可控文本不得注入 ===');
  const p5 = await b.newPage();
  const dialogs = [];
  p5.on('dialog', async (d) => { dialogs.push(d.message()); await d.dismiss(); });
  p5.on('pageerror', e => errs.push('[xss] ' + e.message));
  await p5.setViewport({ width: 1440, height: 900 });
  await p5.goto(FILE, { waitUntil: 'domcontentloaded' });
  await sleep(2400);

  const xss = await p5.evaluate(async () => {
    const c = new Chess();
    c.move('e4'); c.move('e5');
    const moves = [
      { color: 'w', san: 'e4', uci: 'e2e4', fen: c.fen(), thought: 't',
        source: '<img src=x onerror=window.__X1=1>' },
      { color: 'b', san: 'e5', uci: 'e7e5', fen: c.fen(), thought: 't', source: 't' }
    ];
    Store.records.unshift({
      id: 'xss', date: new Date().toISOString(), mode: 'pve', result: 'draw', winner: null,
      white: { charId: Store.chars[0].id, name: '<img src=x onerror=window.__X2=1>', api: '<b onmouseover=window.__X3=1>EVIL</b>' },
      black: { charId: Store.chars[1].id, name: '黑', api: 'A' },
      moves, pgn: c.pgn(), duration: 1
    });
    Store.saveRecords();
    Replay.open(Store.records[0]);
    await new Promise(r => setTimeout(r, 800));
    Replay.goto(1);
    await new Promise(r => setTimeout(r, 900));
    const info = document.getElementById('rpMoveInfo').innerHTML;
    UI.go('records');
    await new Promise(r => setTimeout(r, 600));
    const grid = document.getElementById('recGrid').innerHTML;
    return {
      ran: !!(window.__X1 || window.__X2 || window.__X3),
      rawImgInInfo: /<img/i.test(info),
      rawImgInGrid: /<img/i.test(grid),
      escaped: /&lt;img/i.test(info)
    };
  });
  ck('注入脚本未执行', xss.ran === false);
  ck('回放信息栏未渲染原始标签', xss.rawImgInInfo === false);
  ck('棋谱列表未渲染原始标签', xss.rawImgInGrid === false);
  ck('危险文本被转义显示', xss.escaped === true);
  ck('未弹出 alert 类对话框', dialogs.length === 0);

  /* ================= 7. 错误 ================= */
  console.log('\n=== 7. 错误 / 资源 ===');
  console.log(errs.length ? errs.slice(0, 5).join('\n') : '(无)');
  ck('无 JS 运行时错误', errs.length === 0);

  await p3.screenshot({ path: path.join(SHOT, 'r-interaction.png') });

  console.log('\n RESULT: ' + (fails ? fails + ' FAILED' : 'ALL PASS'));
  await b.close();
  process.exit(fails ? 1 : 0);
})();
