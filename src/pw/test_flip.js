/* 棋盘朝向规则验收：「玩家1永远在下方」
 *
 * 规则（08_wire.js · 21b）：
 *   PVE       人类玩家 → 执白则白在下，执黑则黑在下
 *   PVP       白方（先手）在下
 *   AI vs AI  白方（观众默认）在下
 *
 * 这组测试盯三件事：
 *   1. 四种情形的实际朝向（用白王/黑王的屏幕 y 坐标判定，不看标志位）
 *   2. 评估条必须与棋盘同向
 *   3. 手动翻转是**本局临时**动作，不得写进持久设置、不得泄漏到下一局
 *      （这是旧实现的真 bug：点一次翻转，以后每局都被翻）
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

(async () => {
  const b = await puppeteer.launch({
    executablePath: chromePath(),
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });
  const p = await b.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push(e.message));
  await p.setViewport({ width: 1440, height: 900 });
  await p.goto(FILE, { waitUntil: 'domcontentloaded' });
  await sleep(2400);

  /* 开一局并读出「谁在下方」—— 用棋子实际屏幕坐标判定，不信任 flipped 标志 */
  const probe = async (mode, side, setup) => {
    await p.evaluate((cfg) => {
      Game.abort();
      if (cfg.reset) { Store.settings.boardFlip = false; Store.saveSettings(); }
      pendingMode = cfg.mode; refreshSetup(); UI.go('setup');
      if (cfg.side) document.getElementById('selSide').value = cfg.side;
      startMatch();
    }, { mode, side, reset: !setup });
    await sleep(1400);
    return await p.evaluate((cfg) => {
      const v = Game.view;
      const wk = v.pieces.find(x => x.type === 'k' && x.color === 'w');
      const bk = v.pieces.find(x => x.type === 'k' && x.color === 'b');
      return {
        flipped: v.flipped,
        whiteOnBottom: wk ? wk.y > v.size / 2 : null,
        blackOnBottom: bk ? bk.y > v.size / 2 : null,
        evalFlipped: typeof EvalBar !== 'undefined' ? !!EvalBar.flipped : null,
        ruleColor: playerOneColor(cfg.mode, cfg.side || undefined),
        override: Game.flipOverride
      };
    }, { mode, side });
  };

  console.log('\n=== 1. PVE 执白：白方（玩家1）在下 ===');
  const pw = await probe('pve', 'w');
  ck('白王在下半', pw.whiteOnBottom === true);
  ck('黑王在上半', pw.blackOnBottom === false);
  ck('未翻转', pw.flipped === false);
  ck('评估条与棋盘同向', pw.evalFlipped === false);

  console.log('\n=== 2. PVE 执黑：黑方（玩家1）在下 ===');
  const pb = await probe('pve', 'b');
  ck('黑王在下半', pb.blackOnBottom === true);
  ck('白王在上半', pb.whiteOnBottom === false);
  ck('已翻转', pb.flipped === true);
  ck('评估条与棋盘同向', pb.evalFlipped === true);

  console.log('\n=== 3. PVP：白方（先手）在下 ===');
  const pv = await probe('pvp', null);
  ck('白王在下半', pv.whiteOnBottom === true);
  ck('未翻转', pv.flipped === false);

  console.log('\n=== 4. AI vs AI：白方（默认）在下 ===');
  const ai = await probe('aivai', null);
  ck('白王在下半', ai.whiteOnBottom === true);
  ck('未翻转', ai.flipped === false);

  console.log('\n=== 5. 手动翻转：本局临时，不污染持久设置 ===');
  const tog = await p.evaluate(async () => {
    Game.abort();
    Store.settings.boardFlip = false; Store.saveSettings();
    pendingMode = 'pve'; refreshSetup(); UI.go('setup');
    document.getElementById('selSide').value = 'w';
    startMatch();
    await new Promise(r => setTimeout(r, 1300));
    const s0 = { flipped: Game.view.flipped, override: Game.flipOverride };
    document.getElementById('btnFlipBoard').click();
    await new Promise(r => setTimeout(r, 300));
    const s1 = {
      flipped: Game.view.flipped, override: Game.flipOverride,
      persisted: Store.settings.boardFlip,
      evalFlipped: !!EvalBar.flipped
    };
    document.getElementById('btnFlipBoard').click();
    await new Promise(r => setTimeout(r, 300));
    const s2 = { flipped: Game.view.flipped, override: Game.flipOverride };
    return { s0, s1, s2 };
  });
  ck('初始为默认朝向', tog.s0.flipped === false && tog.s0.override === null);
  ck('点击后翻转生效', tog.s1.flipped === true && tog.s1.override === true);
  ck('翻转不写持久设置', tog.s1.persisted === false, 'boardFlip=' + tog.s1.persisted);
  ck('评估条跟随翻转', tog.s1.evalFlipped === true);
  ck('再点回到默认（清掉覆盖）', tog.s2.flipped === false && tog.s2.override === null);

  console.log('\n=== 6. 翻转不泄漏到下一局（旧实现的 bug） ===');
  const leak = await p.evaluate(async () => {
    Game.abort();
    Store.settings.boardFlip = false; Store.saveSettings();
    // 第一局：手动翻转
    pendingMode = 'pve'; refreshSetup(); UI.go('setup');
    document.getElementById('selSide').value = 'w';
    startMatch();
    await new Promise(r => setTimeout(r, 1300));
    document.getElementById('btnFlipBoard').click();
    await new Promise(r => setTimeout(r, 300));
    const r1flipped = Game.view.flipped;
    // 第二局：仍然执白
    Game.abort();
    pendingMode = 'pve'; refreshSetup(); UI.go('setup');
    document.getElementById('selSide').value = 'w';
    startMatch();
    await new Promise(r => setTimeout(r, 1300));
    const r2 = {
      flipped: Game.view.flipped,
      override: Game.flipOverride,
      whiteOnBottom: (() => {
        const wk = Game.view.pieces.find(x => x.type === 'k' && x.color === 'w');
        return wk ? wk.y > Game.view.size / 2 : null;
      })()
    };
    return { r1flipped, r2 };
  });
  ck('第一局确实被翻转过', leak.r1flipped === true);
  ck('第二局回到默认朝向', leak.r2.flipped === false, 'flipped=' + leak.r2.flipped);
  ck('第二局覆盖已清空', leak.r2.override === null);
  ck('第二局白王在下', leak.r2.whiteOnBottom === true);

  console.log('\n=== 7. 翻转后棋子坐标必须重算（回归 2.7 的 bug） ===');
  const coords = await p.evaluate(async () => {
    Game.abort();
    pendingMode = 'pve'; refreshSetup(); UI.go('setup');
    document.getElementById('selSide').value = 'w';
    startMatch();
    await new Promise(r => setTimeout(r, 1300));
    const v = Game.view;
    const before = v.sqCenter('a2');
    document.getElementById('btnFlipBoard').click();
    await new Promise(r => setTimeout(r, 400));
    const after = v.sqCenter('a2');
    const piece = v.pieces.find(x => x.sq === 'a2');
    return {
      movedPx: Math.round(Math.hypot(after.x - before.x, after.y - before.y)),
      errPx: piece ? Math.round(Math.hypot(piece.x - after.x, piece.y - after.y)) : 999
    };
  });
  ck('翻转确实移动了坐标系', coords.movedPx > 100, coords.movedPx + 'px');
  ck('棋子坐标同步重算', coords.errPx < 2, '误差 ' + coords.errPx + 'px');

  console.log('\n=== 8. 错误 ===');
  console.log(errs.length ? errs.slice(0, 4).join('\n') : '(无)');
  ck('无 JS 运行时错误', errs.length === 0);

  await p.screenshot({ path: path.join(SHOT, 'flip-rule.png') });

  console.log('\n RESULT: ' + (fails ? fails + ' FAILED' : 'ALL PASS'));
  await b.close();
  process.exit(fails ? 1 : 0);
})();
