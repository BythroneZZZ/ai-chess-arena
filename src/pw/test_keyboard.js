/* P3 · 键盘完整走子验收（WCAG 2.1.1）
 *
 * 断言分四层：
 *   1. 光标模型：方向键按「屏幕方向」走，翻转棋盘后不反向
 *   2. 落子等价：键盘走出的着法与鼠标走出的完全一致（同一入口）
 *   3. 不劫持：弹窗/输入框/离开棋盘焦点时键盘不抢键；Space 不再触发暂停
 *   4. 播报：每次移动更新 aria-live，内容含格子/子力/合法目标
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

const press = async (p, key, times = 1) => {
  for (let i = 0; i < times; i++) { await p.keyboard.press(key); await sleep(40); }
};

/* 开一局全新的人机对局，并等到「轮到人类白方」。
 * 测试必须等到真实主循环挂起后才操作，否则 activate() 落到旧局面上。 */
async function freshMatch(p) {
  await p.evaluate(() => {
    Game.abort();
    Run.kill();
    Engine.stopAll();
    Analysis.cancelAll('test');
    pendingMode = 'pve'; refreshSetup(); UI.go('setup');
    document.getElementById('selSide').value = 'w';
    document.getElementById('selDiff').value = '1';
    document.getElementById('rngDelay').value = '0';
    startMatch();
  });
  for (let i = 0; i < 60; i++) {
    await sleep(150);
    const ready = await p.evaluate(() =>
      !!(Game.pendingHuman && Game.pendingHuman.color === 'w' && !Game.busy && Game.running));
    if (ready) return true;
  }
  return false;
}

/* 冻结对局：只留棋盘与 view，供纯展示层断言（播报、光标、选中态）。
 * 不冻的话 activate() 会真的落子，主循环接着应招，后续断言全错位。 */
const freeze = (p) => p.evaluate(() => {
  Game.abort();
  Run.kill();
  Game.running = false;
  Game.busy = false;
  Game.pendingHuman = null;
  Game.chess = new Chess();
  Game.moves = [];
  Game.selectSq = null;
  Game.view.flipped = false;
  Game.view.pieces = [];
  Game.view.setPosition(Game.chess);
  Game.view.selected = null;
  Game.view.legal = [];
  BoardKeys.active = true;
  BoardKeys.view = Game.view;
});

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

  console.log('\n=== 1. 棋盘可获得焦点 ===');
  const focus = await p.evaluate(() => {
    const cv = document.getElementById('boardCanvas');
    return { tabindex: cv.getAttribute('tabindex'), tag: cv.tagName, hasHandler: typeof BoardKeys === 'object' };
  });
  ck('canvas 有 tabindex', focus.tabindex === '0');
  ck('键盘层已挂载', focus.hasHandler === true);

  // 进入对局（等到轮到人类白方）
  const ready = await freshMatch(p);
  ck('人机对局已就绪，轮到人类', ready === true);

  console.log('\n=== 2. 聚焦后出现光标 ===');
  await p.evaluate(() => document.getElementById('boardCanvas').focus());
  await sleep(200);
  const cur = await p.evaluate(() => ({
    active: BoardKeys.active,
    cursor: Game.view.cursor,
    isKing: Game.view.cursor === Game.findKing('w')
  }));
  ck('焦点进入后激活键盘导航', cur.active === true);
  ck('光标落在己方王上', cur.isKing === true, cur.cursor);

  console.log('\n=== 3. 方向键按屏幕方向移动 ===');
  await freeze(p);                      // 纯光标逻辑，先停掉主循环
  const moveTest = await p.evaluate(async () => {
    // 白方未翻转：光标 e1 → 向上应是 e2
    Game.view.flipped = false;
    Game.view.cursor = 'e1';
    BoardKeys.active = true;
    BoardKeys.move(0, -1);                       // 屏幕向上
    const up = Game.view.cursor;
    BoardKeys.move(1, 0);                        // 屏幕向右
    const right = Game.view.cursor;
    BoardKeys.move(0, 1);                        // 屏幕向下
    const down = Game.view.cursor;
    BoardKeys.move(-1, 0);                       // 屏幕向左
    const left = Game.view.cursor;
    return { up, right, down, left };
  });
  ck('向上 → e2（白方在下）', moveTest.up === 'e2', moveTest.up);
  ck('向右 → f2', moveTest.right === 'f2', moveTest.right);
  ck('向下 → f1', moveTest.down === 'f1', moveTest.down);
  ck('向左 → e1', moveTest.left === 'e1', moveTest.left);

  const flippedTest = await p.evaluate(async () => {
    Game.view.flipped = true;
    Game.view.cursor = 'e1';
    BoardKeys.active = true;
    BoardKeys.move(0, -1);                       // 翻转后屏幕向上 = 棋盘向下
    const up = Game.view.cursor;
    Game.view.cursor = 'd4';
    BoardKeys.move(1, 0);                        // 翻转后屏幕向右 = 棋盘向左
    const right = Game.view.cursor;
    Game.view.flipped = false;
    return { up, right };
  });
  ck('翻转后向上 → 沿棋盘向下（e1 无下方，停在 e1）', flippedTest.up === 'e1', flippedTest.up);
  ck('翻转后向右 → 棋盘向左（d4 → c4）', flippedTest.right === 'c4', flippedTest.right);

  console.log('\n=== 4. 撞边不越界 ===');
  const edge = await p.evaluate(() => {
    Game.view.flipped = false;
    Game.view.cursor = 'a1';
    BoardKeys.active = true;
    BoardKeys.move(-1, 0); BoardKeys.move(0, 1);
    const corner = Game.view.cursor;
    Game.view.cursor = 'h8';
    BoardKeys.move(1, 0); BoardKeys.move(0, -1);
    return { corner, far: Game.view.cursor };
  });
  ck('左下角不越界', edge.corner === 'a1', edge.corner);
  ck('右上角不越界', edge.far === 'h8', edge.far);

  console.log('\n=== 5. Home / End 行首行尾 ===');
  const homeEnd = await p.evaluate(() => {
    Game.view.flipped = false;
    Game.view.cursor = 'd4';
    BoardKeys.active = true;
    BoardKeys.jumpHome();
    const home = Game.view.cursor;
    BoardKeys.jumpEnd();
    return { home, end: Game.view.cursor };
  });
  ck('Home → a4', homeEnd.home === 'a4', homeEnd.home);
  ck('End → h4', homeEnd.end === 'h4', homeEnd.end);

  console.log('\n=== 6. 键盘与鼠标走出完全相同的着法 ===');
  // 这一组要真实主循环配合 —— 上面几组把对局冻住了，这里重开一局
  const ready2 = await freshMatch(p);
  ck('重开对局，轮到人类', ready2 === true);
  const same = await p.evaluate(async () => {
    // 用真实对局状态：pendingHuman 由主循环持有，不能替换
    Game.view.flipped = false;
    Game.selectSq = null; Game.view.selected = null; Game.view.legal = [];
    BoardKeys.active = true;
    await new Promise(r => setTimeout(r, 150));   // 让过一次事件循环，状态稳定

    Game.view.cursor = 'e2';
    BoardKeys.activate();                    // 选中 e2
    const sel = { sq: Game.selectSq, legal: (Game.view.legal || []).length };

    Game.view.cursor = 'e4';
    BoardKeys.activate();                    // 落子 e4 → 交给主循环 applyMove
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 100));
      if (Game.moves.length) break;
    }
    return {
      sel,
      fen: Game.chess.fen(),
      moves: Game.moves.length,
      san: Game.moves[0] && Game.moves[0].san,
      cursor: Game.view.cursor
    };
  });
  ck('回车选中己方棋子', same.sel.sq === 'e2' && same.sel.legal >= 1, same.sel.sq + ' / ' + same.sel.legal + ' 目标');
  ck('回车落子成功', same.moves === 1 && same.san === 'e4', same.san + ' ' + same.fen.slice(0, 24));
  ck('走的是标准开局局面', same.fen.startsWith('rnbqkbnr/pppppppp/8/8/4P3'), same.fen.slice(0, 30));

  console.log('\n=== 7. 键盘不能走非法步 ===');
  await freeze(p);
  const illegal = await p.evaluate(async () => {
    // 冻结局面：轮到白方，但光标放到黑方棋子 a5 上试选
    Game.view.cursor = 'a7';
    BoardKeys.active = true;
    BoardKeys.activate();                    // 黑子，白方回合 → 不该被选中
    const selAfter = Game.selectSq;
    Game.view.cursor = 'a5';
    BoardKeys.activate();                    // 非法目标
    await new Promise(r => setTimeout(r, 200));
    return { after: Game.moves.length, selAfter, turn: Game.chess.turn() };
  });
  ck('非本方回合不产生选中（黑子）', illegal.selAfter === null, 'sel=' + illegal.selAfter + ' turn=' + illegal.turn);
  ck('非法目标不落子', illegal.after === 0, 'moves=' + illegal.after);

  console.log('\n=== 8. Esc 取消选中 ===');
  const esc = await p.evaluate(async () => {
    // 冻结态下 onSquareClick 不工作，直接构造「已选中 d2」的状态，
    // 验证 cancel() 能否把三处状态一起清干净
    Game.view.cursor = 'd2';
    Game.view.selected = 'd2';
    Game.selectSq = 'd2';
    Game.view.legal = Game.chess.moves({ square: 'd2', verbose: true });
    BoardKeys.active = true;
    const selected = Game.selectSq;
    const legalBefore = Game.view.legal.length;
    BoardKeys.cancel();
    return {
      selected, legalBefore,
      after: Game.selectSq,
      viewSel: Game.view.selected,
      legal: (Game.view.legal || []).length
    };
  });
  ck('选中态已建立', esc.selected === 'd2' && esc.legalBefore > 0,
    esc.selected + ' / ' + esc.legalBefore + ' 目标');
  ck('Esc 清空选中与合法提示',
    esc.after === null && esc.viewSel === null && esc.legal === 0,
    'selectSq=' + esc.after + ' view.selected=' + esc.viewSel + ' legal=' + esc.legal);

  console.log('\n=== 9. 播报内容 ===');
  await freeze(p);
  const announce = await p.evaluate(async () => {
    Game.view.flipped = false;
    Game.view.selected = null; Game.view.legal = []; Game.selectSq = null;
    Game.view.cursor = 'e2';
    BoardKeys.active = true;
    BoardKeys.announce();
    await new Promise(r => setTimeout(r, 220));
    const onPawn = document.getElementById('boardA11y').textContent;

    // 未选中时移到空格：只报「空格」
    Game.view.cursor = 'e5';
    BoardKeys.announce();
    await new Promise(r => setTimeout(r, 220));
    const onEmpty = document.getElementById('boardA11y').textContent;

    // 选中 e2 后再移到 e4：此时 e4 是合法目标，应提示「可落子」
    // 冻结状态下 onSquareClick 会因 running=false 直接返回，故直接构造选中态
    Game.selectSq = 'e2';
    Game.view.selected = 'e2';
    Game.view.legal = Game.chess.moves({ square: 'e2', verbose: true });
    Game.view.cursor = 'e4';
    BoardKeys.announce();
    await new Promise(r => setTimeout(r, 220));
    const onTarget = document.getElementById('boardA11y').textContent;

    Game.view.cursor = 'e2';
    BoardKeys.announce();
    await new Promise(r => setTimeout(r, 220));
    const onSelected = document.getElementById('boardA11y').textContent;
    return { onPawn, onEmpty, onTarget, onSelected };
  });
  ck('播报含格子与子力', /e2/.test(announce.onPawn) && /白兵/.test(announce.onPawn), announce.onPawn.slice(0, 40));
  ck('播报含可走步数', /可走/.test(announce.onPawn), announce.onPawn.slice(0, 46));
  ck('未选中时空格只报空格', /e5/.test(announce.onEmpty) && /空格/.test(announce.onEmpty),
    announce.onEmpty.slice(0, 36));
  ck('选中后空格提示可落子', /e4/.test(announce.onTarget) && /可落子/.test(announce.onTarget),
    announce.onTarget.slice(0, 42));
  ck('选中后播报合法目标数', /已选 e2/.test(announce.onSelected) && /合法目标/.test(announce.onSelected),
    announce.onSelected.slice(0, 44));

  console.log('\n=== 10. 不劫持：Space 不再触发暂停 ===');
  // 这一组要真实对局（Space 走子依赖 running / pendingHuman），重开一局
  const ready3 = await freshMatch(p);
  ck('重开对局供 Space 测试', ready3 === true);
  await p.evaluate(() => {
    Game.paused = false;
    Game.view.flipped = false;
    Game.view.cursor = 'a2';
    Game.view.selected = null; Game.view.legal = []; Game.selectSq = null;
    BoardKeys.active = true;
    document.getElementById('btnPause').textContent = 'II';
  });
  await p.evaluate(() => document.getElementById('boardCanvas').focus());
  await sleep(150);
  await press(p, 'Space');
  await sleep(250);
  const afterSpace = await p.evaluate(() => ({
    paused: Game.paused,
    pauseLabel: document.getElementById('btnPause').textContent,
    selected: Game.selectSq,
    cursor: Game.view.cursor
  }));
  ck('棋盘聚焦时 Space 不暂停', afterSpace.paused === false, 'paused=' + afterSpace.paused);
  ck('棋盘聚焦时 Space 用于选中', afterSpace.selected === 'a2', 'sel=' + afterSpace.selected);

  // 焦点离开棋盘后 Space 仍能暂停（老行为保留）
  const spaceGlobal = await p.evaluate(async () => {
    Game.paused = false;
    document.getElementById('boardCanvas').blur();
    document.body.focus();
    return { cursorGone: Game.view.cursor === null };
  });
  await sleep(100);
  await p.keyboard.press('Space');
  await sleep(200);
  const afterGlobal = await p.evaluate(() => ({ paused: Game.paused }));
  ck('失焦后光标收起', spaceGlobal.cursorGone === true);
  ck('非棋盘焦点时 Space 仍暂停', afterGlobal.paused === true, 'paused=' + afterGlobal.paused);
  await p.evaluate(() => { Game.setPaused(false); document.getElementById('btnPause').textContent = 'II'; });

  console.log('\n=== 11. 弹窗打开时不劫持方向键 ===');
  const modalGuard = await p.evaluate(async () => {
    Game.view.cursor = 'd4';
    BoardKeys.active = true;
    document.getElementById('boardCanvas').focus();
    A11y.openModal(document.getElementById('confirmModal'));
    const ev = new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true });
    document.getElementById('boardCanvas').dispatchEvent(ev);
    const cursorAfter = Game.view.cursor;
    A11y.closeModal(document.getElementById('confirmModal'));
    return { cursorAfter, prevented: ev.defaultPrevented };
  });
  ck('弹窗打开时光标不动', modalGuard.cursorAfter === 'd4', modalGuard.cursorAfter);

  console.log('\n=== 12. 鼠标点击后收起键盘光标 ===');
  const mixed = await p.evaluate(async () => {
    document.getElementById('boardCanvas').focus();
    BoardKeys.active = true;
    Game.view.cursor = 'd4';
    const cv = document.getElementById('boardCanvas');
    cv.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    return { active: BoardKeys.active, cursor: Game.view.cursor };
  });
  ck('鼠标按下后清掉键盘光标', mixed.active === false && mixed.cursor === null,
    'active=' + mixed.active + ' cursor=' + mixed.cursor);

  console.log('\n=== 13. 新局复位光标 ===');
  const reset = await p.evaluate(() => {
    BoardKeys.active = true;
    Game.view.cursor = 'h8';
    Game.newChess();
    return { cursor: Game.view.cursor, active: BoardKeys.active };
  });
  ck('新局光标清空或回到王位', reset.cursor === null || reset.cursor === 'e1', reset.cursor);

  console.log('\n=== 14. 提示文案存在 ===');
  const hint = await p.evaluate(() => {
    const el = document.querySelector('.kbd-hint');
    return { exists: !!el, text: el ? el.textContent : '', visible: el ? getComputedStyle(el).display !== 'none' : false };
  });
  ck('棋盘下有键盘提示', hint.exists === true && /方向键/.test(hint.text), hint.text.slice(0, 30));
  ck('宽屏下提示可见', hint.visible === true);

  console.log('\n=== 15. 错误 / 资源 ===');
  console.log(errs.length ? errs.slice(0, 8).join('\n') : '(无)');
  ck('无 404 / JS 运行时错误', errs.length === 0);

  await p.screenshot({ path: path.join(SHOT, 'p3-keyboard.png') });

  console.log('\n RESULT: ' + (fails ? fails + ' FAILED' : 'ALL PASS'));
  await b.close();
  process.exit(fails ? 1 : 0);
})();
