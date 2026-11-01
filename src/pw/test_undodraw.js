/* 悔棋 / 提和 验收 */
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
  await sleep(2200);

  console.log('\n=== 1. 反应词库：按标签匹配 ===');
  const lib = await p.evaluate(() => {
    const pickMany = (tags, kind, n = 12) => {
      const seen = new Set();
      for (let i = 0; i < n; i++) seen.add(Reactions.line({ tags, name: 'x' }, kind));
      return [...seen];
    };
    const jhDraw = pickMany(['嘉豪'], 'draw');
    const jhUndo = pickMany(['嘉豪'], 'undo');
    const cold = pickMany(['冷酷'], 'undo');
    const hot = pickMany(['热血'], 'undo');
    const none = Reactions.line({ tags: [], name: 'x' }, 'undo');
    return { jhDraw, jhUndo, cold, hot, none, tags: Object.keys(REACT_LINES).length };
  });
  ck('覆盖标签数 ≥ 16', lib.tags >= 16, lib.tags + ' 组（含 _default）');
  ck('嘉豪提和含「懦弱」', lib.jhDraw.some(s => /懦弱/.test(s)), lib.jhDraw[0]);
  ck('嘉豪悔棋含「九折」或「不该」', lib.jhUndo.some(s => /九折|不该/.test(s)), lib.jhUndo[0]);
  ck('冷酷台词短促', lib.cold.every(s => s.length < 30), lib.cold[0]);
  ck('热血台词含感叹', lib.hot.some(s => /[！!]/.test(s)), lib.hot[0]);
  ck('无标签有默认兜底', typeof lib.none === 'string' && lib.none.length > 0, lib.none);

  console.log('\n=== 2. 悔棋：确认框 ===');
  const modal = await p.evaluate(async () => {
    Game.start({mode:'pvp', players:{w:{char:Store.chars[0]},b:{char:Store.chars[3]}}, human:{w:true,b:true}, difficulty:2, delayMs:0, temp:0.9, auto:true, maxMoves:60, clockPreset:'unlimited'});
    await new Promise(r => setTimeout(r, 700));
    Game.onSquareClick('e2'); await new Promise(r => setTimeout(r, 60)); Game.onSquareClick('e4');
    await new Promise(r => setTimeout(r, 600));
    Game.onSquareClick('e7'); await new Promise(r => setTimeout(r, 60)); Game.onSquareClick('e5');
    await new Promise(r => setTimeout(r, 600));
    const before = { moves: Game.moves.length, turn: Game.chess.turn() };

    UndoDraw.requestUndo();
    await new Promise(r => setTimeout(r, 600));
    const m = document.getElementById('caModal');
    const out = {
      before,
      on: m.classList.contains('on'),
      role: m.getAttribute('role'),
      title: document.getElementById('caTitle').textContent,
      name: document.getElementById('caName').textContent,
      line: document.getElementById('caLine').textContent,
      btn: document.getElementById('caConfirm').textContent
    };
    return out;
  });
  ck('确认框弹出', modal.on === true);
  ck('role=dialog', modal.role === 'dialog');
  ck('标题为「悔棋」', modal.title === '悔棋', modal.title);
  ck('显示对手角色名', modal.name === '嘉豪', modal.name);
  ck('有性格化台词', modal.line.length > 4, modal.line.slice(0, 24));

  console.log('\n=== 3. 取消：局面不变 ===');
  const cancel = await p.evaluate(async () => {
    document.getElementById('caCancel').click();
    await new Promise(r => setTimeout(r, 500));
    return {
      moves: Game.moves.length,
      turn: Game.chess.turn(),
      modalOn: document.getElementById('caModal').classList.contains('on')
    };
  });
  ck('棋步未变', cancel.moves === 2, cancel.moves + '');
  ck('轮次未变', cancel.turn === 'w', cancel.turn);
  ck('弹窗已关', cancel.modalOn === false);

  console.log('\n=== 4. 确认：撤 1 步且保留台词 ===');
  const undo = await p.evaluate(async () => {
    // 先给两步都塞入台词，模拟 AI 说过话
    Game.moves.forEach((m, i) => { m.thought = '测试台词' + i; });
    const items0 = document.querySelectorAll('#moveLog .mv');
    const htmlBefore = items0[items0.length - 1] ? items0[items0.length - 1].outerHTML : '';

    UndoDraw.requestUndo();
    await new Promise(r => setTimeout(r, 500));
    document.getElementById('caConfirm').click();
    await new Promise(r => setTimeout(r, 900));
    const items = document.querySelectorAll('#moveLog .mv');
    return {
      moves: Game.moves.length,
      turn: Game.chess.turn(),
      logTotal: items.length,
      undone: document.querySelectorAll('#moveLog .mv.undone').length,
      lastHtml: items[items.length - 1] ? items[items.length - 1].outerHTML : '',
      thoughtCleared: Game.lastThought.w === '' && Game.lastThought.b === '',
      pending: !!Game.pendingHuman
    };
  });
  ck('撤掉 1 步（PVP）', undo.moves === 1, undo.moves + '');
  ck('轮次回到黑方', undo.turn === 'b', undo.turn);
  ck('日志条目保留', undo.logTotal === 2, undo.logTotal + '');
  ck('被撤步已标记', undo.undone === 1, undo.undone + '');
  ck('被撤条目文字没被清空', undo.lastHtml.replace(/<[^>]*>/g, '').trim().length > 0, undo.lastHtml.slice(0, 70));
  ck('台词缓存已重置（不重放）', undo.thoughtCleared === true);

  console.log('\n=== 5. PVE：撤 2 步回到玩家 ===');
  const pveUndo = await p.evaluate(async () => {
    Game.abort();
    await new Promise(r => setTimeout(r, 200));
    pendingMode = 'pve'; refreshSetup(); UI.go('setup');
    document.getElementById('selSide').value = 'w';
    document.getElementById('selDiff').value = '1';
    document.getElementById('selClock').value = 'unlimited';
    document.getElementById('rngDelay').value = '0';
    startMatch();
    await new Promise(r => setTimeout(r, 800));
    Game.moves.forEach((m) => { m.thought = 'PVE台词'; });
    Game.onSquareClick('e2'); await new Promise(r => setTimeout(r, 60)); Game.onSquareClick('e4');
    for (let i = 0; i < 80; i++) {
      await new Promise(r => setTimeout(r, 200));
      if (Game.moves.length >= 2 && Game.pendingHuman) break;
    }
    const before = { moves: Game.moves.length, turn: Game.chess.turn(), pending: !!Game.pendingHuman };
    UndoDraw.requestUndo();
    await new Promise(r => setTimeout(r, 500));
    document.getElementById('caConfirm').click();
    await new Promise(r => setTimeout(r, 800));
    const out = {
      before,
      moves: Game.moves.length,
      turn: Game.chess.turn(),
      pending: !!Game.pendingHuman,
      thoughtsReset: Game.lastThought.w === '' && Game.lastThought.b === ''
    };
    Game.abort();
    return out;
  });
  ck('PVE 撤到玩家回合', pveUndo.turn === 'w' && pveUndo.pending === true, JSON.stringify({ t: pveUndo.turn, p: pveUndo.pending }));
  ck('撤掉 2 手', pveUndo.moves === 0, pveUndo.moves + '');
  ck('双方台词缓存一并清空', pveUndo.thoughtsReset === true);

  console.log('\n=== 5b. 悔棋后可继续对局（回归） ===');
  const resume = await p.evaluate(async () => {
    Game.abort();
    await new Promise(r => setTimeout(r, 250));
    pendingMode = 'pve'; refreshSetup(); UI.go('setup');
    document.getElementById('selSide').value = 'w';
    document.getElementById('selDiff').value = '1';
    document.getElementById('selClock').value = 'unlimited';
    document.getElementById('rngDelay').value = '0';
    startMatch();
    await new Promise(r => setTimeout(r, 900));

    const waitHuman = async () => {
      for (let i = 0; i < 100; i++) {
        await new Promise(r => setTimeout(r, 150));
        if (Game.pendingHuman && !Game.busy) return true;
      }
      return false;
    };

    Game.onSquareClick('e2'); await new Promise(r => setTimeout(r, 60)); Game.onSquareClick('e4');
    await waitHuman();
    const afterFirst = Game.moves.length;

    // 悔棋 1
    UndoDraw.requestUndo();
    await new Promise(r => setTimeout(r, 600));
    document.getElementById('caConfirm').click();
    const back1 = await waitHuman();

    // 继续下
    Game.onSquareClick('d2'); await new Promise(r => setTimeout(r, 60)); Game.onSquareClick('d4');
    await waitHuman();
    const afterSecond = Game.moves.length;

    // 悔棋 2（验证可重复）
    UndoDraw.requestUndo();
    await new Promise(r => setTimeout(r, 800));
    const secondModal = document.getElementById('caModal').classList.contains('on');
    if (secondModal) document.getElementById('caConfirm').click();
    const back2 = await waitHuman();

    const out = { afterFirst, back1, afterSecond, secondModal, back2, moves: Game.moves.length, turn: Game.chess.turn() };
    Game.abort();
    return out;
  });
  ck('悔棋后重新可下子', resume.back1 === true && resume.afterSecond >= 2, JSON.stringify(resume));
  ck('第二次悔棋弹窗正常', resume.secondModal === true);
  ck('可重复悔棋', resume.back2 === true && resume.moves === 0, 'moves=' + resume.moves);

  console.log('\n=== 6. 提和：确认后和棋 ===');
  const draw = await p.evaluate(async () => {
    Game.abort();
    await new Promise(r => setTimeout(r, 200));
    Game.start({mode:'pvp', players:{w:{char:Store.chars[0]},b:{char:Store.chars[3]}}, human:{w:true,b:true}, difficulty:2, delayMs:0, temp:0.9, auto:true, maxMoves:60, clockPreset:'unlimited'});
    await new Promise(r => setTimeout(r, 700));
    Game.onSquareClick('d2'); await new Promise(r => setTimeout(r, 60)); Game.onSquareClick('d4');
    await new Promise(r => setTimeout(r, 600));

    UndoDraw.requestDraw();
    await new Promise(r => setTimeout(r, 600));
    const m = {
      on: document.getElementById('caModal').classList.contains('on'),
      title: document.getElementById('caTitle').textContent,
      line: document.getElementById('caLine').textContent,
      btn: document.getElementById('caConfirm').textContent
    };
    document.getElementById('caConfirm').click();
    await new Promise(r => setTimeout(r, 1600));
    return {
      m,
      overlay: document.getElementById('resultOverlay').classList.contains('on'),
      title: document.getElementById('resTitle').textContent,
      sub: document.getElementById('resSub').textContent,
      running: Game.running,
      resultType: Game.result && Game.result.type
    };
  });
  ck('提和弹窗出现', draw.m.on === true);
  ck('标题为「提议和棋」', draw.m.title === '提议和棋', draw.m.title);
  ck('嘉豪台词含「懦弱」', /懦弱/.test(draw.m.line), draw.m.line.slice(0, 30));
  ck('结果面板弹出', draw.overlay === true);
  ck('判定为和棋', draw.title === '平局' && /DRAW AGREED/.test(draw.sub), draw.sub);
  ck('对局已停', draw.running === false && draw.resultType === 'agreement');

  console.log('\n=== 7. AI vs AI 禁用 ===');
  const disabled = await p.evaluate(async () => {
    Game.start({mode:'aivai', players:{w:{char:Store.chars[0],kind:'api',api:null},b:{char:Store.chars[1],kind:'api',api:null}},
      human:{w:false,b:false}, difficulty:2, delayMs:0, temp:0.9, auto:true, maxMoves:40, clockPreset:'unlimited'});
    await new Promise(r => setTimeout(r, 500));
    UI.updateControlState();
    const out = {
      undoDisabled: document.getElementById('btnUndo').disabled,
      drawDisabled: document.getElementById('btnDraw').disabled,
      canUse: UndoDraw.canUse()
    };
    Game.abort();
    return out;
  });
  ck('观战模式按钮禁用', disabled.undoDisabled === true && disabled.drawDisabled === true);
  ck('canUse 为 false', disabled.canUse === false);

  console.log('\n=== 8. 无棋步时悔棋被拒 ===');
  const empty = await p.evaluate(async () => {
    Game.abort();
    await new Promise(r => setTimeout(r, 200));
    Game.start({mode:'pvp', players:{w:{char:Store.chars[0]},b:{char:Store.chars[3]}}, human:{w:true,b:true}, difficulty:2, delayMs:0, temp:0.9, auto:true, maxMoves:60, clockPreset:'unlimited'});
    await new Promise(r => setTimeout(r, 700));
    const before = Game.moves.length;
    UndoDraw.requestUndo();
    await new Promise(r => setTimeout(r, 400));
    const out = {
      before,
      modalOn: document.getElementById('caModal').classList.contains('on')
    };
    Game.abort();
    return out;
  });
  ck('没有棋步时不弹确认框', empty.modalOn === false, 'moves=' + empty.before);

  console.log('\n=== 9. 页面错误 ===');
  console.log(errs.length ? errs.join('\n') : '(无)');
  ck('无运行时错误', errs.length === 0);

  console.log('\n RESULT: ' + (fails ? fails + ' FAILED' : 'ALL PASS'));
  await b.close();
  process.exit(fails ? 1 : 0);
})();
