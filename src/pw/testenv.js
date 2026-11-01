/* 测试公共工具：Chrome 路径解析 + 服务器地址
 *
 * 原先 27 处硬编码 `C:/Program Files/Google/Chrome/Application/chrome.exe`，
 * 换机器 / 装在不同盘 / Linux CI 上全部失效。
 * 这里按优先级解析，任何一处命中即可：
 *   1. 环境变量 CHROME_PATH
 *   2. 各平台常见安装位置
 *   3. puppeteer-core 自带的下载缓存
 * 全都没命中时抛出可操作的错误，而不是让 27 个套件各自报 ERR_CONNECTION。
 */
const fs = require('fs');
const path = require('path');

const CANDIDATES = [
  // Windows
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe') : null,
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  // macOS
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  // Linux
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium'
];

let _cached = null;

function chromePath() {
  if (_cached) return _cached;
  const fromEnv = process.env.CHROME_PATH;
  if (fromEnv && fs.existsSync(fromEnv)) { _cached = fromEnv; return _cached; }
  for (const c of CANDIDATES) {
    if (c && fs.existsSync(c)) { _cached = c; return _cached; }
  }
  // puppeteer-core 自带缓存（若用户用 npx puppeteer browsers install chrome）
  try {
    const pptr = require('puppeteer-core');
    if (pptr.executablePath) {
      const p2 = pptr.executablePath();
      if (p2 && fs.existsSync(p2)) { _cached = p2; return _cached; }
    }
  } catch (e) { /* 没装或版本不支持，忽略 */ }
  throw new Error(
    '找不到 Chrome/Chromium。请设置环境变量 CHROME_PATH 指向可执行文件，' +
    '例如：set CHROME_PATH=C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  );
}

const BASE_URL = process.env.ARENA_BASE_URL || 'http://localhost:8765';

const SHOT_DIR = (() => {
  const d = process.env.ARENA_SHOT_DIR || path.join(require('os').tmpdir(), 'chess-arena-shots');
  try { fs.mkdirSync(d, { recursive: true }); } catch (e) { }
  return d;
})();

/* 统一的启动参数：no-sandbox 是 CI 容器里必需的 */
function launchArgs(extra) {
  return ['--no-sandbox', '--disable-dev-shm-usage'].concat(extra || []);
}

module.exports = { chromePath, BASE_URL, SHOT_DIR, launchArgs };
