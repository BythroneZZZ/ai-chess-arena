/* 棋钟（Clock）+ 难度预算联动 验收 */
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

  console.log('\n=== 1. 不限时：时钟隐藏且不计时 ===');
  const off = await p.evaluate(async () => {
    Game.start(Object.assign({}, {mode:'pvp', players:{w:{char:Store.chars[0]},b:{char:Store.chars[1]}}, human:{w:true,b:true}, difficulty:2, delayMs:0, temp:0.9, auto:true, maxMoves:60}, {clockPreset:'unlimited'}));
    await new Promise(r => setTimeout(r, 800));
    const out = {
      enabled: Clock.enabled,
      hiddenL: document.getElementById('clockL').classList.contains('hidden'),
      hiddenR: document.getElementById('clockR').classList.contains('hidden'),
      timer: !!Clock.timer
    };
    Game.abort();
    await new Promise(r => setTimeout(r, 150));
    return out;
  });
  ck('未启用', off.enabled === false);
  ck('两端时钟隐藏', off.hiddenL && off.hiddenR);
  ck('无 interval 残留', off.timer === false);

  console.log('\n=== 2. 3+2 开局计时 ===');
  const on = await p.evaluate(async () => {
    Game.start(Object.assign({}, {mode:'pvp', players:{w:{char:Store.chars[0]},b:{char:Store.chars[1]}}, human:{w:true,b:true}, difficulty:2, delayMs:0, temp:0.9, auto:true, maxMoves:60}, {clockPreset:'blitz3'}));
    await new Promise(r => setTimeout(r, 900));   // 等开局 420ms 动画 + 首回合
    const before = Clock.remaining.w;
    await new Promise(r => setTimeout(r, 1000));
    const after = Clock.remaining.w;
    const out = {
      enabled: Clock.enabled,
      main: Clock.main, inc: Clock.inc,
      running: Clock.running,
      text: document.getElementById('clockL').textContent,
      active: document.getElementById('clockL').classList.contains('active'),
      decreased: before - after
    };
    return out;
  });
  ck('已启用', on.enabled === true);
  ck('初始 3 分钟 / 增量 2 秒', on.main === 180000 && on.inc === 2000, on.main + '/' + on.inc);
  ck('白方开始走表', on.running === 'w');
  ck('时钟高亮', on.active === true, on.text);
  ck('时间在减少', on.decreased > 700, on.decreased + 'ms');

  console.log('\n=== 3. 落子加增量并交棒 ===');
  const mv = await p.evaluate(async () => {
    Game.onSquareClick('e2');
    await new Promise(r => setTimeout(r, 80));
    Game.onSquareClick('e4');
    await new Promise(r => setTimeout(r, 700));
    return { running: Clock.running, w: Clock.remaining.w, b: Clock.remaining.b };
  });
  ck('交棒给黑方', mv.running === 'b');
  ck('白方获得增量', mv.w > 180000 - 1500 + 2000 - 100, 'w=' + Math.round(mv.w));
  ck('黑方开始计', mv.b < 180000, 'b=' + Math.round(mv.b));

  console.log('\n=== 4. 暂停冻结 / 恢复续走 ===');
  const pz = await p.evaluate(async () => {
    Game.setPaused(true);
    const a = Clock.remaining.b;
    await new Promise(r => setTimeout(r, 800));
    const bVal = Clock.remaining.b;
    Game.setPaused(false);
    await new Promise(r => setTimeout(r, 500));
    return { frozen: Math.abs(bVal - a) < 60, resumed: Clock.running === 'b' };
  });
  ck('暂停时冻结', pz.frozen === true);
  ck('恢复后续走', pz.resumed === true);

  console.log('\n=== 5. 超时判负 ===');
  const flag = await p.evaluate(async () => {
    Clock.remaining.b = 300;
    await new Promise(r => setTimeout(r, 1500));
    const out = {
      overlay: document.getElementById('resultOverlay').classList.contains('on'),
      title: document.getElementById('resTitle').textContent,
      sub: document.getElementById('resSub').textContent,
      running: Game.running,
      timer: !!Clock.timer,
      clockRunning: Clock.running
    };
    return out;
  });
  ck('结果面板弹出', flag.overlay === true);
  ck('白方胜 / 超时判负', flag.title === '白方胜利' && /超时/.test(flag.sub), flag.title + ' | ' + flag.sub);
  ck('对局已停', flag.running === false);
  ck('时钟已停', flag.timer === false && flag.clockRunning === null);

  console.log('\n=== 6. 重开一局：时钟正确重置 ===');
  const reset = await p.evaluate(async () => {
    Game.start(Object.assign({}, {mode:'pvp', players:{w:{char:Store.chars[0]},b:{char:Store.chars[1]}}, human:{w:true,b:true}, difficulty:2, delayMs:0, temp:0.9, auto:true, maxMoves:60}, {clockPreset:'blitz5'}));
    await new Promise(r => setTimeout(r, 900));
    const out = { main: Clock.main, w: Clock.remaining.w, running: Clock.running, timers: !!Clock.timer };
    Game.abort();
    await new Promise(r => setTimeout(r, 150));
    return out;
  });
  ck('按新预设重置', reset.main === 300000 && reset.w > 299000, Math.round(reset.w) + '');
  ck('重新开始计时', reset.running === 'w' && reset.timers === true);

  console.log('\n=== 7. 难度预算受余时约束 ===');
  const budget = await p.evaluate(() => {
    Clock.enabled = true;
    const probe = (left, diff) => {
      Clock.remaining = { w: left, b: left };
      return engineBudgetFor(DIFF[diff], 'w');
    };
    const rows = [
      { left: 180000, diff: 4, want: 30000 },
      { left: 60000, diff: 4, want: 16800 },
      { left: 30000, diff: 4, want: 8400 },
      { left: 8000, diff: 4, want: 2240 },
      { left: 180000, diff: 1, want: 2000 },
      { left: 60000, diff: 2, want: 6000 }
    ].map(r => ({ left: r.left, diff: r.diff, got: probe(r.left, r.diff), want: r.want }));
    // 极端：余时 1s 时预算不得超过余时
    const extreme = { left: 1000, got: probe(1000, 4) };
    Clock.enabled = false;
    return { rows, extreme };
  });
  budget.rows.forEach(r => ck(`余 ${r.left}ms 难度${r.diff} → ${r.want}ms`, Math.abs(r.got - r.want) <= 50, r.got + 'ms'));
  ck('预算绝不超过余时', budget.extreme.got <= 1000, budget.extreme.got + 'ms');

  console.log('\n=== 8. 难度越高思考越久 ===');
  const byDiff = await p.evaluate(() => {
    Clock.enabled = true;
    Clock.remaining = { w: 600000, b: 600000 };  // 余时充足，不受 cap 约束
    const out = [1, 2, 3, 4].map(d => engineBudgetFor(DIFF[d], 'w'));
    Clock.enabled = false;
    return out;
  });
  ck('预算随难度递增', byDiff[0] < byDiff[1] && byDiff[1] < byDiff[2] && byDiff[2] < byDiff[3], byDiff.join(' < '));

  console.log('\n=== 9. AI 长考计入自己的钟 ===');
  const aiClock = await p.evaluate(async () => {
    pendingMode = 'pve'; refreshSetup(); UI.go('setup');
    document.getElementById('selSide').value = 'w';
    document.getElementById('selDiff').value = '2';
    document.getElementById('selClock').value = 'blitz5';
    document.getElementById('rngDelay').value = '0';
    startMatch();
    await new Promise(r => setTimeout(r, 800));
    const wStart = Clock.remaining.w;
    Game.onSquareClick('e2');
    await new Promise(r => setTimeout(r, 80));
    Game.onSquareClick('e4');
    // 等 AI 走完
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 200));
      if (Game.moves.length >= 2) break;
    }
    const out = {
      moves: Game.moves.length,
      wUsed: Math.round(wStart - Clock.remaining.w),
      blackLeft: Math.round(Clock.remaining.b)
    };
    Game.abort();
    return out;
  });
  ck('AI 已落子', aiClock.moves >= 2, JSON.stringify(aiClock));
  ck('AI 思考消耗的是 AI 的钟', aiClock.blackLeft < 300000, '黑方剩余 ' + aiClock.blackLeft);

  console.log('\n=== 10. 页面错误 ===');
  console.log(errs.length ? errs.join('\n') : '(无)');
  ck('无运行时错误', errs.length === 0);

  await p.screenshot({ path: path.join(SHOT, '80-clock.png') });
  console.log('\n RESULT: ' + (fails ? fails + ' FAILED' : 'ALL PASS'));
  await b.close();
  process.exit(fails ? 1 : 0);
})();
