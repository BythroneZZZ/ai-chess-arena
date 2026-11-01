/* 开局库 + 提示着法 验收 */
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
  p.on('response', r => { if (r.status() >= 400) errs.push('404:' + r.url().split('/').pop()); });
  await p.setViewport({ width: 1440, height: 900 });
  await p.goto(FILE, { waitUntil: 'domcontentloaded' });
  await sleep(2200);

  console.log('\n=== 1. 数据加载 ===');
  const load = await p.evaluate(async () => {
    const t0 = performance.now();
    const d = await Openings.load();
    return {
      ok: !!d,
      ms: Math.round(performance.now() - t0),
      positions: d ? Object.keys(d.pos).length : 0,
      families: d ? d.families.length : 0,
      segments: d ? d.segments.length : 0,
      failed: Openings.failed
    };
  });
  ck('加载成功', load.ok === true && load.failed === false, load.ms + 'ms');
  ck('局面数 > 3000', load.positions > 3000, load.positions + ' 个');
  ck('名称池化生效', load.families > 100 && load.segments > 1000, load.families + ' 家族 / ' + load.segments + ' 段');

  console.log('\n=== 2. 开局识别 ===');
  const names = await p.evaluate(() => {
    const scenes = [
      ['Ruy Lopez', ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5']],
      ['Italian', ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4']],
      ['Sicilian 主线', ['e4', 'c5', 'Nf3', 'd6', 'd4', 'cxd4', 'Nxd4', 'Nf6', 'Nc3', 'a6']],
      ['Queen\'s Gambit', ['d4', 'd5', 'c4', 'e6', 'Nc3', 'Nf6']],
      ['French', ['e4', 'e6', 'd4', 'd5']]
    ];
    return scenes.map(([label, moves]) => {
      const c = new Chess();
      for (const m of moves) c.move(m);
      const info = Openings.current(c);
      return { label, eco: info ? info.eco : '', name: info ? info.name : '(空)' };
    });
  });
  names.forEach(n => {
    console.log('    ' + n.label + ' → ' + (n.eco ? '[' + n.eco + '] ' : '') + n.name);
  });
  ck('西班牙识别', /Ruy Lopez/.test(names[0].name) && names[0].eco.startsWith('C'), names[0].eco);
  ck('意大利识别', /Italian/.test(names[1].name), names[1].eco);
  ck('西西里识别', /Sicilian/.test(names[2].name), names[2].eco);
  ck('后翼弃兵识别', /Queen/.test(names[3].name), names[3].eco);
  ck('法兰西识别', /French/.test(names[4].name), names[4].eco);

  console.log('\n=== 3. 开局阶段不瞎猜 ===');
  const early = await p.evaluate(() => {
    const c = new Chess();
    c.move('e4');
    const info = Openings.current(c);
    return { name: info ? info.name : null, pending: info ? !!info.pending : false };
  });
  ck('初始阶段显示「开局阶段」', early.name === '开局阶段' && early.pending === true, early.name);

  console.log('\n=== 4. 提示着法质量 ===');
  const hints = await p.evaluate(() => {
    const scenes = [
      ['意大利黑方', ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4'], 'Bc5'],
      ['西班牙黑方', ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5'], 'Nf6'],
      ['西西里白方', ['e4', 'c5'], 'Nf3']
    ];
    return scenes.map(([label, moves, expect]) => {
      const c = new Chess();
      for (const m of moves) c.move(m);
      const s = Openings.suggest(c);
      return { label, san: s ? s.move.san : null, expect, opens: s ? s.opening.name : null };
    });
  });
  hints.forEach(h => console.log('    ' + h.label + ' → ' + h.san + '（进入 ' + h.opens + '）'));
  ck('意大利建议 Bc5', hints[0].san === 'Bc5', hints[0].san);
  ck('西班牙建议 Nf6', hints[1].san === 'Nf6', hints[1].san);
  ck('西西里建议 Nf3', hints[2].san === 'Nf3', hints[2].san);

  console.log('\n=== 5. 建议着法合法 ===');
  const legal = await p.evaluate(() => {
    const c = new Chess();
    ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4'].forEach(m => c.move(m));
    const s = Openings.suggest(c);
    const ok = c.moves({ verbose: true }).some(m => m.from === s.move.from && m.to === s.move.to);
    return { from: s.move.from, to: s.move.to, legal: ok };
  });
  ck('建议可执行', legal.legal === true, legal.from + '→' + legal.to);

  console.log('\n=== 6. UI 集成 ===');
  const ui = await p.evaluate(async () => {
    pendingMode = 'pve'; refreshSetup(); UI.go('setup');
    document.getElementById('selSide').value = 'w';
    document.getElementById('selDiff').value = '1';
    document.getElementById('selClock').value = 'unlimited';
    document.getElementById('rngDelay').value = '0';
    startMatch();
    await new Promise(r => setTimeout(r, 900));
    const el = document.getElementById('openingName');
    return { exists: !!el, btnHint: !!document.getElementById('btnHint') };
  });
  ck('开局名元素存在', ui.exists === true);
  ck('提示按钮存在', ui.btnHint === true);

  const hintFlow = await p.evaluate(async () => {
    // 走到意大利开局
    const play = async (from, to) => {
      Game.onSquareClick(from);
      await new Promise(r => setTimeout(r, 80));
      Game.onSquareClick(to);
      for (let i = 0; i < 60; i++) {
        await new Promise(r => setTimeout(r, 150));
        if (Game.pendingHuman && !Game.busy) break;
      }
    };
    await play('e2', 'e4');
    await play('g1', 'f3');
    await play('f1', 'c4');
    const shown = document.getElementById('openingName').textContent;

    document.getElementById('btnHint').click();
    await new Promise(r => setTimeout(r, 1800));
    return {
      shown,
      arrow: !!document.getElementById('hintArrow'),
      toasts: [...document.querySelectorAll('.toast')].map(t => t.textContent)
    };
  });
  ck('UI 显示开局名', hintFlow.shown.length > 0, hintFlow.shown);
  ck('提示箭头已绘制', hintFlow.arrow === true);
  ck('提示有文字反馈', hintFlow.toasts.some(t => /建议/.test(t)), (hintFlow.toasts[0] || '').slice(0, 40));

  console.log('\n=== 7. 悔棋后开局名同步 ===');
  const undoName = await p.evaluate(async () => {
    const before = document.getElementById('openingName').textContent;
    UndoDraw.requestUndo();
    await new Promise(r => setTimeout(r, 500));
    document.getElementById('caConfirm').click();
    await new Promise(r => setTimeout(r, 900));
    // 正确性判据：UI 显示必须等于「当前局面」的计算值
    const expected = Openings.current(Game.chess);
    const expectName = expected ? expected.name : '';
    const el = document.getElementById('openingName').textContent;
    return { before, after: el, expectName, match: el.replace(/^[A-E]\d\d/, '') === expectName };
  });
  ck('悔棋后开局名与局面一致', undoName.match === true,
    '显示=' + (undoName.after || '空') + ' 期望=' + (undoName.expectName || '空'));

  console.log('\n=== 8. 离线降级 ===');
  const degrade = await p.evaluate(async () => {
    // 模拟数据加载失败
    const saved = Openings.data;
    Openings.data = null; Openings.failed = true;
    const c = new Chess(); c.move('e4');
    const r1 = Openings.current(c);
    const r2 = Openings.suggest(c);
    Openings.data = saved; Openings.failed = false;
    return { current: r1, suggest: r2 };
  });
  ck('无数据时不抛错', degrade.current === null && degrade.suggest === null);

  console.log('\n=== 9. 资源与错误 ===');
  console.log(errs.length ? errs.join('\n') : '(无)');
  ck('无 404 / 运行时错误', errs.length === 0);

  await p.screenshot({ path: path.join(SHOT, 'b0-openings.png') });
  console.log('\n RESULT: ' + (fails ? fails + ' FAILED' : 'ALL PASS'));
  await b.close();
  process.exit(fails ? 1 : 0);
})();
