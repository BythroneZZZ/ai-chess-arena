/**
 * 测试总入口 —— 相对路径、临时截图目录、退出码即结果。
 * 用法：node src/pw/run-tests.js
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HERE = __dirname;

/* 依赖自愈：缺 puppeteer-core 时自动安装一次，避免 npm test 直接失败 */
function ensureDeps() {
  const mod = path.join(HERE, 'node_modules', 'puppeteer-core', 'package.json');
  if (fs.existsSync(mod)) return true;
  console.log('缺少 puppeteer-core，正在安装…');
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const r = spawnSync(npm, ['i', 'puppeteer-core@23', '--silent', '--no-audit', '--no-fund'], {
    cwd: HERE, stdio: 'inherit', shell: process.platform === 'win32'
  });
  return r.status === 0 && fs.existsSync(mod);
}

if (!ensureDeps()) {
  console.error('依赖安装失败。请手动执行：cd src/pw && npm i puppeteer-core@23');
  process.exit(1);
}

/* 拆分架构需要本地服务器；未运行时自动拉起一个（8765），结束后关闭 */
const http = require('http');
const { spawn } = require('child_process');
const ROOT = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.ARENA_PORT || 8765);

function pingServer() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/index.html', timeout: 1500 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

let serverProc = null;
async function ensureServer() {
  if (await pingServer()) return false;              // 已在运行
  const py = process.platform === 'win32' ? 'python' : 'python3';
  serverProc = spawn(py, ['-m', 'http.server', String(PORT)], { cwd: ROOT, stdio: 'ignore' });
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 150));
    if (await pingServer()) return true;
  }
  throw new Error('本地服务器启动失败（端口 ' + PORT + '）。请手动执行 npm run serve');
}

function stopServer() {
  if (serverProc) { try { serverProc.kill(); } catch (e) {} serverProc = null; }
}

process.on('exit', stopServer);
process.on('SIGINT', () => { stopServer(); process.exit(130); });
const SUITES = [
  { name: '功能回归', file: 'test_all.js', timeout: 180000 },
  { name: '运行时语义', file: 'test_phase2.js', timeout: 120000 },
  { name: '生命周期死锁', file: 'repro2.js', timeout: 90000 },
  { name: '端点准入', file: 'test_endpoint.js', timeout: 120000 },
  { name: '棋钟', file: 'test_clock.js', timeout: 120000 },
  { name: '悔棋与提和', file: 'test_undodraw.js', timeout: 150000 },
  { name: '开局库', file: 'test_openings.js', timeout: 120000 },
  { name: '棋力分析（评估条）', file: 'test_eval.js', timeout: 300000 },
  { name: '复盘报告', file: 'test_review.js', timeout: 180000 },
  { name: '键盘完整走子', file: 'test_keyboard.js', timeout: 180000 },
  { name: '320px 五页面', file: 'test_narrow320.js', timeout: 180000 },
  { name: '交付形态与性能', file: 'test_delivery.js', timeout: 240000 },
  { name: '交互回归（按钮/回放/翻转/resize）', file: 'test_interaction.js', timeout: 300000 },
  { name: 'PGN 导入 UI 流程', file: 'test_ui_final.js', timeout: 180000 },
  { name: '棋盘朝向规则', file: 'test_flip.js', timeout: 180000 }
];

let failed = 0;
const results = [];

(async () => {
let started = false;
try {
  started = await ensureServer();
  if (started) console.log('已自动启动本地服务器 :' + PORT);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}

for (const s of SUITES) {
  const file = path.join(HERE, s.file);
  if (!fs.existsSync(file)) {
    console.log(`SKIP ${s.name}（缺少 ${s.file}）`);
    continue;
  }
  process.stdout.write(`\n──── ${s.name} ────\n`);
  const r = spawnSync(process.execPath, [file], {
    cwd: HERE,
    stdio: 'inherit',
    timeout: s.timeout,
    env: Object.assign({}, process.env, {
      ARENA_SHOT_DIR: process.env.ARENA_SHOT_DIR || path.join(os.tmpdir(), 'chess-arena-shots'),
      ARENA_BASE_URL: process.env.ARENA_BASE_URL || ('http://localhost:' + PORT)
    })
  });
  const ok = r.status === 0;
  if (!ok) failed++;
  results.push({ name: s.name, ok, code: r.status, signal: r.signal });
}

console.log('\n══════════ 汇总 ══════════');
for (const r of results) {
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.signal ? ' (' + r.signal + ')' : ''}`);
}
console.log(failed === 0 ? '\n全部通过' : `\n${failed} 个套件失败`);
if (started) stopServer();
process.exit(failed ? 1 : 0);
})();
