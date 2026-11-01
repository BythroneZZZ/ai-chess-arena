/* 320px 五页面专项验收
 *
 * 目标不是「能塞下」，而是「手指点得准 + 首屏看得到关键内容」：
 *   1. 零横向溢出（document.scrollWidth ≤ innerWidth）
 *   2. 所有可点击元素 ≥ 32×32（触控底线）
 *   3. 关键内容在首屏可见（回放页的棋盘不能被挤到屏幕外）
 *   4. 文字不被裁到不可读（字号不低于 10px）
 *   5. 桌面端不受这些窄屏规则影响
 *
 * 覆盖页面：home / setup / characters / api / records / replay
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

/* 在页面里跑一次体检：溢出 / 过小控件 / 首屏可见性 */
const AUDIT = () => {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const de = document.documentElement;

  // 横向溢出
  const overflowX = de.scrollWidth - vw;

  // 越过视口右/左边界且可见的元素
  const out = [];
  document.querySelectorAll('body *').forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return;
    if (r.right > vw + 1 || r.left < -1) {
      out.push({
        tag: el.tagName, id: el.id || '',
        cls: String(el.className || '').slice(0, 24),
        left: Math.round(r.left), right: Math.round(r.right)
      });
    }
  });

  // 过小的可点击元素
  const small = [];
  document.querySelectorAll('button, .px-btn, select, a[href], .chip, canvas[tabindex], input[type=checkbox]').forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return;
    if (r.height < 32 || r.width < 32) {
      /* 例外：复选框本体天然小，但只要它被包在足够高的 label/row 里，
       * 整行都是热区（点文字也能切换），实际命中面积已达标。 */
      if (el.type === 'checkbox') {
        const host = el.closest('label, .row');
        if (host) {
          const hr = host.getBoundingClientRect();
          if (hr.height >= 44 && hr.width >= 44) return;
        }
      }
      small.push({
        tag: el.tagName, id: el.id || '',
        txt: (el.textContent || '').trim().slice(0, 10),
        w: Math.round(r.width), h: Math.round(r.height)
      });
    }
  });

  // 字号过小的可见文本
  const tiny = [];
  document.querySelectorAll('.screen.on *').forEach((el) => {
    if (!el.textContent || !el.textContent.trim()) return;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    const fs2 = parseFloat(getComputedStyle(el).fontSize);
    if (fs2 && fs2 < 10) tiny.push({ tag: el.tagName, id: el.id || '', fs: fs2 });
  });

  return {
    vw, vh, overflowX,
    outCount: out.length, out: out.slice(0, 6),
    smallCount: small.length, small: small.slice(0, 8),
    tinyCount: tiny.length, tiny: tiny.slice(0, 5),
    screen: [...document.querySelectorAll('.screen.on')].map((x) => x.id)[0] || null
  };
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
  await p.setViewport({ width: 320, height: 720, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await p.goto(FILE, { waitUntil: 'domcontentloaded' });
  await sleep(2400);

  // 先造数据：一条棋谱记录，供 records / replay 使用
  await p.evaluate(() => {
    const c = new Chess();
    const mv = ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6'];
    const moves = [];
    for (const san of mv) {
      const m = c.move(san);
      moves.push({ color: m.color, san: m.san, uci: m.from + m.to, fen: c.fen(), thought: '一句台词', source: 'test' });
    }
    Store.records.unshift({
      id: 'rec320', date: new Date().toISOString(), mode: 'pve',
      result: 'checkmate', winner: 'w',
      white: { charId: Store.chars[0].id, name: '白方角色', api: '测试API' },
      black: { charId: Store.chars[1].id, name: '黑方角色', api: '测试API' },
      moves, pgn: c.pgn(), duration: 12
    });
    Store.saveRecords();
  });

  const PAGES = [
    { id: 'screen-home', name: '首页', go: () => { UI.go('home'); } },
    { id: 'screen-setup', name: '设置', go: () => { pendingMode = 'pve'; refreshSetup(); UI.go('setup'); } },
    { id: 'screen-characters', name: '角色工坊', go: () => { UI.go('characters'); } },
    { id: 'screen-api', name: 'API 配置', go: () => { UI.go('api'); } },
    { id: 'screen-records', name: '棋谱库', go: () => { UI.go('records'); } }
  ];

  for (const pg of PAGES) {
    console.log('\n=== ' + pg.name + ' (320px) ===');
    await p.evaluate(pg.go);
    await sleep(500);
    const a = await p.evaluate(AUDIT);
    ck(pg.name + ' 页面激活', a.screen === pg.id, a.screen);
    ck(pg.name + ' 无横向溢出', a.overflowX <= 1, 'overflow=' + a.overflowX);
    ck(pg.name + ' 无越界元素', a.outCount === 0,
      a.outCount ? JSON.stringify(a.out.slice(0, 3)) : '');
    ck(pg.name + ' 触控目标 ≥32px', a.smallCount === 0,
      a.smallCount ? JSON.stringify(a.small.slice(0, 4)) : '');
    ck(pg.name + ' 无不可读小字(<10px)', a.tinyCount === 0,
      a.tinyCount ? JSON.stringify(a.tiny.slice(0, 3)) : '');
    await p.screenshot({ path: path.join(SHOT, 'p320-' + pg.id.replace('screen-', '') + '.png') });
  }

  /* ---------- 回放页：额外要求「棋盘首屏可见」 ---------- */
  console.log('\n=== 回放 (320px) ===');
  await p.evaluate(() => Replay.open(Store.records[0]));
  await sleep(900);
  /* 注意：AUDIT 必须作为参数传进 evaluate，不能在模板串里 `toString()`
   * 再执行 —— 那样会在 Node 侧先求值，拼出来的源码容易带错。 */
  const rp = await p.evaluate((auditFn) => {
    const audit = eval('(' + auditFn + ')')();
    const cv = document.getElementById('replayCanvas');
    const r = cv.getBoundingClientRect();
    const frame = document.getElementById('boardFrameR').getBoundingClientRect();
    const col = document.querySelector('.replay-wrap .board-col');
    return Object.assign(audit, {
      boardW: Math.round(r.width),
      boardTop: Math.round(frame.top),
      boardBottom: Math.round(frame.bottom),
      viewSize: UI.replayView && UI.replayView.size,
      colOrder: getComputedStyle(col).order,
      // 棋盘必须整体落在首屏内，不能被信息栏挤到下面
      boardInFirstScreen: frame.top >= 0 && frame.bottom <= window.innerHeight,
      frameRight: Math.round(frame.right)
    });
  }, AUDIT.toString());
  ck('回放页面激活', rp.screen === 'screen-replay', rp.screen);
  ck('回放无横向溢出', rp.overflowX <= 1, 'overflow=' + rp.overflowX);
  ck('回放无越界元素', rp.outCount === 0,
    rp.outCount ? JSON.stringify(rp.out.slice(0, 3)) : '');
  ck('回放触控目标 ≥32px', rp.smallCount === 0,
    rp.smallCount ? JSON.stringify(rp.small.slice(0, 4)) : '');
  ck('回放棋盘按视口缩放', rp.boardW <= rp.vw && rp.viewSize < 480,
    'canvas=' + rp.boardW + ' view=' + rp.viewSize + ' vw=' + rp.vw);
  ck('回放棋盘在首屏内', rp.boardInFirstScreen === true,
    'top=' + rp.boardTop + ' bottom=' + rp.boardBottom + ' vh=' + rp.vh);
  ck('回放棋盘排在信息栏之前', rp.colOrder === '0', 'order=' + rp.colOrder);
  await p.screenshot({ path: path.join(SHOT, 'p320-replay.png') });

  /* ---------- 战斗页：已有覆盖，这里只做回归确认 ---------- */
  console.log('\n=== 战斗页回归 (320px) ===');
  await p.evaluate(() => {
    pendingMode = 'pve'; refreshSetup(); UI.go('setup');
    document.getElementById('selSide').value = 'w';
    document.getElementById('selDiff').value = '1';
    document.getElementById('rngDelay').value = '0';
    startMatch();
  });
  await sleep(2600);
  const bt = await p.evaluate((auditFn) => {
    const audit = eval('(' + auditFn + ')')();
    const bv = document.getElementById('boardCanvas').getBoundingClientRect();
    const ev = document.getElementById('evalCol').getBoundingClientRect();
    return Object.assign(audit, {
      boardW: Math.round(bv.width),
      evalRight: Math.round(ev.right)
    });
  }, AUDIT.toString());
  ck('战斗页无横向溢出', bt.overflowX <= 1, 'overflow=' + bt.overflowX);
  ck('战斗页触控目标 ≥32px', bt.smallCount === 0,
    bt.smallCount ? JSON.stringify(bt.small.slice(0, 4)) : '');
  ck('评估条未越界', bt.evalRight <= bt.vw, bt.evalRight + ' / ' + bt.vw);
  await p.evaluate(() => Game.abort());

  /* ---------- 桌面端不受影响 ---------- */
  console.log('\n=== 桌面端回归 ===');
  const d = await b.newPage();
  await d.setViewport({ width: 1440, height: 900 });
  await d.goto(FILE, { waitUntil: 'domcontentloaded' });
  await sleep(2200);
  await d.evaluate(() => UI.go('characters'));
  await sleep(400);
  const desk = await d.evaluate(() => {
    const ava = document.querySelector('.char-card .ava');
    const del = document.querySelector('.char-card .del');
    const btn = document.querySelector('#btnNewChar');
    const g = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; };
    return {
      ava: g(ava), del: g(del), btn: g(btn),
      overflow: document.documentElement.scrollWidth - window.innerWidth
    };
  });
  ck('桌面头像仍为 64px', desk.ava && desk.ava.w === 64, JSON.stringify(desk.ava));
  ck('桌面按钮未被压扁', desk.btn && desk.btn.h >= 28, JSON.stringify(desk.btn));
  ck('桌面无横向溢出', desk.overflow <= 1, 'overflow=' + desk.overflow);
  await d.screenshot({ path: path.join(SHOT, 'p320-desktop-characters.png') });

  console.log('\n=== 错误 / 资源 ===');
  console.log(errs.length ? errs.slice(0, 6).join('\n') : '(无)');
  ck('无 404 / JS 运行时错误', errs.length === 0);

  console.log('\n RESULT: ' + (fails ? fails + ' FAILED' : 'ALL PASS'));
  await b.close();
  process.exit(fails ? 1 : 0);
})();
