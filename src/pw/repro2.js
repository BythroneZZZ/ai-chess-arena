/* 更激进的复现：队列多 job、Worker 错误、快速重启 */
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


(async () => {
  const b = await puppeteer.launch({
    executablePath: chromePath(),
    headless: 'new',
    args: ['--no-sandbox']
  });

  // ---------- A. 队列里有多个 job 时 abort ----------
  console.log('=== A. 多 job 排队时中止 ===');
  let p = await b.newPage();
  await p.goto(FILE, { waitUntil: 'domcontentloaded' });
  await sleep(2200);
  const A = await p.evaluate(async () => {
    // 直接压 3 个 job，不等结果
    const fens = [
      'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1',
      'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2'
    ];
    const promises = fens.map(f => Engine.bestMove(f, 18, 3000));
    await new Promise(r => setTimeout(r, 400));
    const mid = { busy: Engine.busy, queue: Engine.queue.length };
    Engine.stopAll();
    const afterStop = { busy: Engine.busy, queue: Engine.queue.length };
    const settled = await Promise.race([
      Promise.allSettled(promises).then(() => 'all-settled'),
      new Promise(r => setTimeout(() => r('TIMEOUT-3s'), 3000))
    ]);
    await new Promise(r => setTimeout(r, 900));
    return { mid, afterStop, settled, after1s: { busy: Engine.busy, queue: Engine.queue.length } };
  });
  console.log(JSON.stringify(A, null, 1));
  console.log(A.settled === 'TIMEOUT-3s' ? '>>> job Promise 未结算：泄漏确认' : '>>> 所有 Promise 已结算');

  // ---------- B. Worker 崩溃后队列是否被 drain ----------
  console.log('\n=== B. Worker 出错后的队列 ===');
  const B = await p.evaluate(async () => {
    // 强行让 worker 抛错
    const w = Engine.worker;
    const prom = Engine.bestMove('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', 20, 4000);
    await new Promise(r => setTimeout(r, 150));
    const before = { busy: Engine.busy, queue: Engine.queue.length };
    if (w && w.onerror) w.onerror({ message: 'simulated crash' });
    const settled = await Promise.race([
      prom.then(v => 'resolved:' + v).catch(e => 'rejected:' + e.message),
      new Promise(r => setTimeout(() => r('TIMEOUT-3s'), 3000))
    ]);
    return { before, settled, after: { busy: Engine.busy, queue: Engine.queue.length, ready: Engine.ready } };
  });
  console.log(JSON.stringify(B, null, 1));
  console.log(B.settled === 'TIMEOUT-3s' ? '>>> Worker 出错后 job 永久挂起：确认' : '>>> job 有结果');

  // ---------- C. 快速 开始→认输→再来一局 循环 ----------
  console.log('\n=== C. 快速重启循环 x5 ===');
  const p2 = await b.newPage();
  await p2.goto(FILE, { waitUntil: 'domcontentloaded' });
  await sleep(2000);
  for (let i = 0; i < 5; i++) {
    await p2.evaluate(() => {
      pendingMode = 'pve'; refreshSetup(); UI.go('setup');
      document.getElementById('rngDelay').value = '0';
      document.getElementById('selDiff').value = '4';
      startMatch();
    });
    await sleep(180);
    await p2.evaluate(() => { Game.abort(); });
    await sleep(80);
  }
  await p2.evaluate(() => {
    document.getElementById('selDiff').value = '2';
    startMatch();
  });
  await sleep(6000);
  const C = await p2.evaluate(() => ({
    moves: Game.moves.length, busy: Engine.busy, queue: Engine.queue.length,
    status: document.getElementById('statusText').textContent, running: Game.running
  }));
  console.log(JSON.stringify(C));
  // 注意：PVE 玩家执白时会停住等人类落子，moves===0 是正常状态，不是死锁。
  // 真正的死锁判据是「引擎 busy 卡死」或「状态栏永远停在 AI 思考中」。
  const stuck = C.busy === true || /AI 思考中|引擎思考中/.test(C.status);
  console.log(stuck ? '>>> 快速重启后引擎卡死：确认' : '>>> 无引擎卡死，最终对局状态正常（等待人类落子）');

  await b.close();
})();
