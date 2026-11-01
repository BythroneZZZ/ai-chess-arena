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
const logs = [];
let fails = 0;
const check = (name, cond, extra) => {
  if (cond) console.log('  OK  ' + name + (extra ? ' | ' + extra : ''));
  else { fails++; console.log('  FAIL ' + name + (extra ? ' | ' + extra : '')); }
};

(async () => {
  const b = await puppeteer.launch({
    executablePath: chromePath(),
    headless: 'new',
    args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required']
  });
  const p = await b.newPage();
  p.on('pageerror', e => logs.push('[pageerror] ' + e.message));
  p.on('console', m => { if (m.type() === 'error') logs.push('[console.error] ' + m.text()); });
  await p.setViewport({ width: 1440, height: 900 });
  await p.goto(FILE, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(1600);

  const clickSq = async (sq) => {
    const box = await p.evaluate((sq) => {
      const v = Game.view; const c = v.sqCenter(sq); const r = v.cv.getBoundingClientRect();
      return { x: r.left + c.x * (r.width / v.size), y: r.top + c.y * (r.height / v.size) };
    }, sq);
    await p.mouse.click(box.x, box.y);
  };

  console.log('\n=== A. 启动 / 数据 ===');
  const A = await p.evaluate(() => ({
    chars: Store.chars.length,
    names: Store.chars.map(c => c.name),
    presetIds: Store.chars.map(c => c.id.slice(0, 4)),
    engineReady: Engine.ready,
    fen: Game.chess.fen(),
    pieceCount: Game.view.pieces.length,
    hasFonts: [...document.styleSheets].some(s => { try { return [...s.cssRules].some(r => r.cssText.includes('assets/fonts')); } catch (e) { return false; } }),
    fontsLoaded: document.fonts ? [...document.fonts].filter(f => f.status === 'loaded').length : 0,
    engineUrl: typeof ENGINE_URL === 'string' ? ENGINE_URL : '',
    isSplit: !document.getElementById('sf-src'),
    sfReachable: null
  }));
  check('4 个预设角色', A.chars === 4, A.names.join('/'));
  check('引擎已就绪', A.engineReady === true);
  check('初始 32 子', A.pieceCount === 32);
  check('字体文件已外链', A.hasFonts === true);
  check('字体已加载', A.fontsLoaded >= 1, A.fontsLoaded + ' 个');
  check('已拆分为多文件', A.isSplit === true, 'index.html 不再内联引擎');
  check('引擎路径正确', /stockfish\.js$/.test(A.engineUrl || ''), A.engineUrl);

  console.log('\n=== B. Prompt 生成器 ===');
  const B = await p.evaluate(() => {
    const jh = Store.chars.find(c => c.name === '嘉豪');
    const custom = genPrompt({ name: '测试', tags: ['傲娇', '毒舌'], style: '防守', catch: '', custom: '其实很怕输' });
    const none = genPrompt({ name: '裸角色', tags: [], style: '均衡', catch: '', custom: '' });
    return {
      jh: jh.prompt,
      hasJiahaoBlock: jh.prompt.includes('嘉豪') && jh.prompt.includes('九折水平'),
      multi: custom,
      agg: none,
      catchFromTags: charCatchList({ tags: ['傲娇'], catch: '' }),
      catchOwn: charCatchList({ tags: ['傲娇'], catch: '甲 / 乙' })
    };
  });
  check('嘉豪人格块注入', B.hasJiahaoBlock === true);
  check('多标签展开', B.multi.includes('傲娇') && B.multi.includes('毒舌') && B.multi.includes('其实很怕输'));
  check('进攻/防守描述', B.multi.includes('稳固结构'));
  check('无标签兜底', B.agg.includes('按下方自定义描述扮演'));
  check('口头禅取自标签', B.catchFromTags.length > 0, JSON.stringify(B.catchFromTags));
  check('自定义口头禅优先', B.catchOwn.join(',') === '甲,乙');

  console.log('\n=== C. 走法校验 ===');
  const C = await p.evaluate(() => {
    Game.chess = new Chess();
    const cases = [
      ['e2e4', true], ['z9z9', false], ['e2e5', false], ['E2E4', true],
      ['  e2e4  ', true], ['e7e8q', false], ['0000', false], ['', false], [null, false],
      ['e2e4q', true]  // 非升变步带多余字符 -> 仍应解析到 e2e4
    ];
    return cases.map(([raw, want]) => {
      const mv = normalizeUci(Game.chess, raw);
      return { raw: String(raw), want, got: mv ? mv.from + mv.to + (mv.promotion || '') : null, pass: (!!mv) === want };
    });
  });
  C.forEach(c => check('UCI ' + JSON.stringify(c.raw), c.pass, '→' + c.got));

  console.log('\n=== D. JSON 解析鲁棒性 ===');
  const D = await p.evaluate(() => {
    const t = [
      '{"move":"e2e4","thought":"好"}',
      '```json\n{"move":"e2e4","thought":"好"}\n```',
      '好的，我走：{"move":"e2e4","thought":"好"} 完事',
      'move: e2e4, thought: 好',
      '{"thought":"只有台词"}',
      '完全不是 JSON',
      '{"move":"e2e4"}'
    ].map(s => { const o = parseModelJSON(s); return { s: s.slice(0, 30), move: o && o.move, thought: o && o.thought }; });
    return t;
  });
  D.forEach((d, i) => check('parse#' + i, i === 5 ? (d.move == null && d.thought == null) : (d.move === 'e2e4' || d.thought === '只有台词' || d.thought === '好'), JSON.stringify(d)));

  console.log('\n=== E. PVE 全流程 ===');
  await p.evaluate(() => {
    pendingMode = 'pve'; refreshSetup(); UI.go('setup');
    document.getElementById('selSide').value = 'w';
    document.getElementById('selDiff').value = '2';
    document.getElementById('rngDelay').value = '0';
    document.getElementById('lblDelay').textContent = '0ms';
    startMatch();
  });
  await sleep(1800);
  const E0 = await p.evaluate(() => ({ pending: Game.pendingHuman && Game.pendingHuman.color, status: document.getElementById('statusText').textContent }));
  check('等待人类白方', E0.pending === 'w', E0.status);

  // 走 3 步
  for (const [a, c] of [['e2', 'e4'], ['g1', 'f3'], ['f1', 'c4']]) {
    await p.evaluate(() => { });
    for (let i = 0; i < 40; i++) { const ok = await p.evaluate(() => Game.pendingHuman); if (ok) break; await sleep(200); }
    await clickSq(a); await sleep(120); await clickSq(c); await sleep(2200);
  }
  const E1 = await p.evaluate(() => ({
    moves: Game.moves.map(m => m.color + ':' + m.san + ':' + m.source),
    morale: Game.morale,
    turn: Game.chess.turn(),
    bubbles: [document.getElementById('bubbleLText').textContent, document.getElementById('bubbleRText').textContent],
    logItems: document.querySelectorAll('#moveLog .mv').length
  }));
  check('人类 + 引擎交替落子', E1.moves.length >= 5 && E1.moves.filter(m=>m.includes('human')).length === 3, E1.moves.join(' '));
  check('气势条变化', E1.morale.w !== 50 || E1.morale.b !== 50, JSON.stringify(E1.morale));
  check('日志与步数一致', E1.logItems === E1.moves.length);

  // 非法点击
  const before = await p.evaluate(() => Game.moves.length);
  await clickSq('e7'); // 黑子，不是白方回合
  await sleep(300);
  const after = await p.evaluate(() => ({ n: Game.moves.length, sel: Game.view.selected }));
  check('非己方棋子不选中', after.sel === null && after.n === before);

  console.log('\n=== F. 将军演出 ===');
  await p.evaluate(() => { window.__keepMoves = Game.moves.slice(); window.__keepFen = Game.chess.fen(); });
  const F = await p.evaluate(() => {
    // 构造一个将军局面
    Game.chess = new Chess('rnbqkbnr/pppp1ppp/8/4p3/6P1/5P2/PPPPP2P/RNBQKBNR b KQkq - 0 3');
    Game.moves = [];
    Game.abort();
    const mv = Game.chess.move({ from: 'd8', to: 'h4' });
    Game.view.pieces = []; Game.view.setPosition(Game.chess);
    Game.view.checkSq = Game.findKing(Game.chess.turn());
    Game.view.flashSquares(['e1'], '#ff4d6d');
    document.getElementById('checkFlash').classList.add('on');
    Game.setPortraitExpr('w', 'shock');
    return { san: mv.san, check: Game.chess.in_check(), mate: Game.chess.in_checkmate() };
  });
  check('学者将死成立', F.check === true && F.mate === true, F.san);
  await sleep(300);
  await p.screenshot({ path: path.join(SHOT, '30-mate.png') });
  await sleep(1500);

  console.log('\n=== G. 终局与棋谱 ===');
  await p.evaluate(() => { Game.UI = UI; });
  const G = await p.evaluate(async () => {
    Game.moves = window.__keepMoves || [];
    Game.abort();
    await Game.finish();
    return {
      overlay: document.getElementById('resultOverlay').classList.contains('on'),
      title: document.getElementById('resTitle').textContent,
      sub: document.getElementById('resSub').textContent
    };
  });
  check('终局面板弹出', G.overlay === true, G.title + ' / ' + G.sub);
  await sleep(400);
  await p.evaluate(() => document.getElementById('resSave').click());
  await sleep(600);
  const G2 = await p.evaluate(() => {
    const r = Store.records[0];
    return { n: Store.records.length, moves: r.moves.length, hasFen: !!r.moves[0].fen, pgn: r.pgn.slice(0, 24), w: r.white.name, b: r.black.name };
  });
  check('棋谱已存', G2.n === 1 && G2.moves > 0, 'moves=' + G2.moves + ' pgn=' + G2.pgn);

  console.log('\n=== H. 回放 ===');
  const H = await p.evaluate(() => {
    document.getElementById('resHome').click();
    UI.go('records');
    Replay.open(Store.records[0]);
    const n = UI.replayData.moves.length;
    Replay.goto(n);
    const c1 = new Chess(UI.replayData.moves[n - 1].fen);
    const last = UI.replayData.moves[n - 1];
    const c2 = new Chess(last.fen);
    const v = UI.replayView;
    const counts = { c: v.pieces.length, u: c2.board().flat().filter(Boolean).length };
    Replay.goto(0);
    const p0 = v.pieces.length;
    Replay.goto(n);
    return { n, fenMatch: counts.c === counts.u, p0, info: document.getElementById('rpMoveInfo').textContent.slice(0, 40), idx: document.getElementById('rpIdx').textContent };
  });
  check('回放首尾状态', H.p0 === 32 && H.fenMatch === true, 'idx=' + H.idx);
  await p.screenshot({ path: path.join(SHOT, '31-replay-final.png') });

  console.log('\n=== I. API 编辑器 ===');
  const I = await p.evaluate(() => {
    UI.go('api'); ApiEditor.newConfig();
    const set = (id, v) => { const el = document.querySelector(id); el.value = v; if (el.dispatchEvent) el.dispatchEvent(new Event('change', { bubbles: true })); };
    set('#apiName', 'Anthropic 测试'); set('#apiFmt', 'anthropic'); set('#apiBase', 'https://api.anthropic.com'); set('#apiKey', 'sk-ant'); set('#apiModel', 'claude-3-5-sonnet-20241022');
    ApiEditor.save();
    const saved = Store.apis[0];
    const ep = (base, suf) => joinEndpoint(base, suf);
    const b1 = ep('https://api.openai.com/v1', '/chat/completions');
    const b2 = ep('https://x.com/v1/', '/chat/completions');
    const b3 = ep('https://x.com/v1/chat/completions', '/chat/completions');
    return {
      n: Store.apis.length, fmt: saved.fmt, model: saved.model,
      customHidden: document.getElementById('customWrap').classList.contains('hidden'),
      b1, b2, b3,
      ls: localStorage.getItem('aca.v1.apis') ? localStorage.getItem('aca.v1.apis').length : 0
    };
  });
  check('保存 Anthropic 配置', I.n === 1 && I.fmt === 'anthropic', I.model);
  check('自定义区默认隐藏', I.customHidden === true);
  check('端点拼接', I.b1.endsWith('/v1/chat/completions') && I.b2.endsWith('/v1/chat/completions') && I.b3.endsWith('/v1/chat/completions'), I.b1 + ' | ' + I.b3);
  check('API 落盘', I.ls > 20);

  console.log('\n=== J. 刷新持久化 ===');
  await p.reload({ waitUntil: 'domcontentloaded' });
  await sleep(1800);
  const J = await p.evaluate(() => ({ chars: Store.chars.length, apis: Store.apis.length, records: Store.records.length, charIdsStable: Store.chars.every(c => c.id) }));
  check('刷新后数据保留', J.chars === 4 && J.apis === 1 && J.records === 1, JSON.stringify(J));

  console.log('\n=== K. 移动端 ===');
  const m = await b.newPage();
  m.on('pageerror', e => logs.push('[mobile] ' + e.message));
  await m.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await m.goto(FILE, { waitUntil: 'domcontentloaded' });
  await sleep(1600);
  await m.evaluate(() => { pendingMode = 'pve'; refreshSetup(); UI.go('setup'); startMatch(); });
  await sleep(2200);
  const K = await m.evaluate(() => {
    const cv = document.getElementById('boardCanvas');
    const r = cv.getBoundingClientRect();
    return {
      boardW: Math.round(r.width), vw: window.innerWidth,
      overflowX: document.documentElement.scrollWidth > window.innerWidth + 2,
      screen: [...document.querySelectorAll('.screen.on')].map(x => x.id)[0],
      overflow: document.documentElement.scrollWidth - window.innerWidth
    };
  });
  check('移动端棋盘适配', K.boardW <= K.vw && K.boardW > 250, K.boardW + '/' + K.vw);
  check('无横向溢出', K.overflow <= 2, 'overflow=' + K.overflow);
  await m.screenshot({ path: path.join(SHOT, '32-mobile-final.png') });

  console.log('\n=== L. 错误日志 ===');
  console.log(logs.length ? logs.join('\n') : '(无 JS 错误)');
  check('无 JS 运行时错误', logs.filter(l => l.includes('pageerror')).length === 0);

  console.log('\n================  RESULT: ' + (fails === 0 ? 'ALL PASS' : fails + ' FAILED') + '  ================');
  await b.close();
  process.exit(fails ? 1 : 0);
})();
