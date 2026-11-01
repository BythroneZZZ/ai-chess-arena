# AI CHESS ARENA · 精简 GDD

> 单文件 HTML5 国际象棋对战游戏 —— 棋盘是舞台，AI 是角色，棋步是剧情。
> 交付物：`index.html`（双击即玩，零构建、零网络依赖）
>
> **v2.0 架构**：多文件（需本地服务器，双击 `run.bat` 启动）
> **文件**：`index.html` · `css/main.css` · `js/*.js`(17) · `assets/` · `GDD.md` · `CONTEXT.md` · `THIRD_PARTY_NOTICES.md`

---

## 1. 核心循环

```
选模式 → 配角色/API → 开局演出 → [每回合: 算棋 → 像素移动 → 打字机台词 → 局势结算]
                                                    ↑                          ↓
                                                    └──────── 循环 ────────────┘
                                          → 终局演出(胜负/总结) → 存棋谱 → 回放 / 重新解说
```

一回合的完整演出节拍（每步约 2.5~4 秒，可用「思考延迟」调节）：

| 节拍 | 内容 | 时长 |
|---|---|---|
| 1 | 思考指示（气泡显示"思考中"+ 跳动的橙色点） | 引擎/API 实际耗时 |
| 2 | 棋子逐格位移（55ms/格，不插值平滑） | 0.1~0.4s |
| 3 | 吃子 → 像素爆散粒子 + `+1` 浮字 + 对方表情变化 | 0.3s |
| 4 | 停顿 | 0.12s |
| 5 | 台词气泡弹出（逐字打字机，16~34ms/字） | 0.5~1.6s |
| 6 | 将军 → 棋盘抖动 + 全屏红闪 + 双方 shock 表情 | 1.6s |

---

## 2. 角色创建流程

```
角色工坊 ──▶ [新建角色]
              │
              ├─ 角色名（≤18 字）
              ├─ 风格标签 1~3 个（或"完全自定义"）
              │    ├ 15 个内置标签：傲娇/冷静/可爱/健谈/幽默/嘉豪/冷酷/御姐/毒舌/温柔/中二/慵懒/严谨/热血/瑟琴
              │    └ 每个标签 = 一段「性格展开」+ 分场景台词池（start/move/capture/check/win/lose）
              ├─ 棋风倾向：进攻 / 均衡 / 防守
              ├─ 自定义人格描述（可选，追加进 Prompt）
              ├─ 口头禅（1~2 句，用 / 分隔）
              ├─ 像素立绘：🎲 随机生成（种子化）/ 🖼 上传图片（自动缩成 32×32 像素）
              └─ System Prompt：按上列字段自动拼接 → 可继续手改
                                   │
                                   └─「⟳ 按标签重生成」可回滚到自动版本
```

**Prompt 拼接结构**（`genPrompt()`）：

```
你是一个下国际象棋的AI角色。
【角色名】    ← name
【说话风格】  ← tags.join('、') 或"完全自定义"
【性格详细定义】← 每个标签的 expand 文案拼接；"嘉豪"有专属长模板；再追加 custom
【口头禅】    ← catch 或标签自带的 catch 池
【棋风倾向】  ← style + 对应描述
+ 固定 JSON 协议：{"move":"e2e4","thought":"…"}  /  {"thought":"…"}
+ 三条硬规则：thought≤40字、move 必须来自合法着法列表、只输出 JSON
```

四个预设（首次启动即写入 localStorage，id 稳定）：

| 角色 | 标签 | 棋风 | 口头禅 |
|---|---|---|---|
| 炎之棋士 | 热血 + 中二 | 进攻 | 冲！这盘我要打穿你！ / 命运由我自己写！ |
| 冰霜参谋 | 冷静 + 严谨 | 防守 | 按计划执行。 / 评估：+0.4。 |
| 甜心骑士 | 可爱 + 健谈 | 均衡 | 小兵兵冲呀～ / 诶嘿，这步我练过！ |
| 嘉豪 | 嘉豪 | 进攻 | 九折水平？ / 还得练！ |

---

## 3. 三种模式流程

### 3.1 人机对弈（PVE）

```
设置页
 ├ 选「玩家执子」白/黑（执黑自动翻转棋盘）
 ├ 左/右面板自动标注「你的角色 / AI 对手」
 ├ 难度 1~4（深度 6 / 13 / 18 / 30，movetime 0.7/1.4/2.4/4.2s）
 ├ 思考延迟 0~3000ms（拟人化停顿）
 └ AI 侧可选 API（只出台词，不参与算棋）
        │
        ▼
   Stockfish(内联 asm.js, blob worker) 算 bestmove
        │
        ├─ 有 API → 二次请求：「引擎已决定走 X，请用你的语气点评」→ {"thought":...}
        └─ 无 API → 按难度取内置台词池（入门偏自嘲，地狱偏嘲讽）
        │
        ▼
   执行棋步 + 演出
```

难度对台词的影响：入门档 50% 概率直接说自嘲台词；地狱档全部走"冷酷/嘲讽"池。

### 3.2 双 API 擂台（AI vs AI）

```
左方: 角色A + API配置A + temperature_A + max_tokens_A + 思考延迟_A
右方: 角色B + API配置B + temperature_B + max_tokens_B + 思考延迟_B
        │
        ▼
  for each turn:
      构建 Prompt = SystemPrompt(角色) + UserPrompt(FEN + 最近6步 + 是否被将 + 对手上一句 + 合法着法列表)
      POST → 解析 JSON → 严格校验 UCI（必须在 chess.js 的 legal moves 里）
        ├ 合法 → 执行 + 台词
        ├ 非法/解析失败 → 重试 1 次（追加纠错提示）
        │     └ 仍失败 → "API 未给出可用着法 · 已本地兜底" → 引擎低深度算一步 + 角色台词池
        └ 超时 15s → 同上兜底
      自动播放（可关 → 单步模式，按「▶ 下一步」推进）
      任意一方随时可「🎮 接管」→ 转为人类操作
```

### 3.3 本地双人（PVP）

```
同一设备轮流落子（human.w = human.b = true）
  ├ 可选解说角色 + 解说 API
  └ 每步后异步请求一句点评 → 右上角 toast「🎙 名字：…」（不阻塞棋局）
```

---

## 4. API 配置流程

```
API 配置页
 ├ 新建配置
 │   ├ 名称（"我的GPT" / "Claude账号2" …）
 │   ├ 请求格式：OpenAI 兼容 / Anthropic / 自定义
 │   ├ Base URL
 │   ├ API Key（password 输入，仅存 localStorage）
 │   ├ Model Name（任意字符串，不校验白名单）
 │   └ [自定义] 请求体模板（{{system}} {{user}} {{model}} {{temperature}} {{max_tokens}}）+ 响应路径
 ├ 📡 测试连接 → 发一条 24 token 的问候，回显耗时与响应前缀
 └ 💾 保存（可存多组，随时在下拉里切换）
```

端点拼接规则：

| 格式 | 实际 URL | 鉴权头 | 响应取值 |
|---|---|---|---|
| OpenAI 兼容 | `{base}/chat/completions` | `Authorization: Bearer {key}` | `choices[0].message.content` |
| Anthropic | `{base}/v1/messages`（base 已含 /v1 或 /messages 时自动去重） | `x-api-key` + `anthropic-version` + `anthropic-dangerous-direct-browser-access` | `content[].text` 拼接 |
| 自定义 | `{base}` | `Authorization: Bearer {key}` | 按用户填的路径（支持 `a.0.b`） |

`max_tokens` 硬上限：请求侧 clamp 到 ≤200，实际传 ≤80（规格要求 ≤80，保留少量余量给 JSON 包裹）。

---

## 5. 像素 UI 布局

### 5.1 桌面（≥1000px）

```
┌──────────────────────────────────────────────────────────────────┐
│ [◀离场] PVE·人机        [🔊音效][🎵BGM][♟棋子][⟲翻转][🏳认输]   │
├──────────────┬──────────────────────────────┬───────────────────┤
│  立绘 150²   │                              │   立绘 150²       │
│  角色名      │        Canvas 棋盘           │   角色名          │
│  标签        │        (最大 640²，8×8)      │   标签            │
│  气势条      │   像素边框 + 金角 + 内发光    │   气势条          │
│  台词气泡    │                              │   台词气泡        │
│  [接管按钮]  │  [WHITE TO MOVE] [状态] ●●●  │   [接管按钮]      │
├──────────────┴──────────────────────────────┴───────────────────┤
│ MOVES │ 1.e4  Nc6  2.Nf3 …（横向滚动）              │ [⏸]        │
└──────────────────────────────────────────────────────────────────┘
```

### 5.2 移动端（≤1000px）

侧栏折叠为横向条：`[头像56²] 角色名 / 气势条 / 台词气泡` 三行堆叠在棋盘上下，棋盘按 `min(屏宽-58, 屏高×0.62)` 取整到 8 的倍数。

### 5.3 像素规范

- **字体**：`Press Start 2P`（英文/数字，base64 内联）+ `Fusion Pixel 12px`（中文，base64 内联，约 945KB）
- **棋盘**：8×8 Canvas，浅格 `#c2b9e4` / 深格 `#4d4477`（对比度 3.4:1，保证深色棋子可辨），格子自带 6px 间隔的抖动纹理点阵
- **棋子**：16×16 点阵 mask → 运行时上色（描边 + 左上受光 + 右下阴影 + 近边缘压暗），按**整数倍**放大到格子尺寸
- **立绘**：32×32 逻辑网格程序化生成（6 种发型 × 3 种眼型 × 5 种配件 × 8 套配色），整数倍放大
- **面板**：`border: 3px solid #07060d` + `box-shadow: inset 0 0 0 3px` + `6px 6px 0` 的硬阴影，四角金色铆钉
- **按钮**：三段式渐变 + 内嵌亮边 + `0 4px 0` 底部厚边，`:active` 时下沉 4px
- **扫描线 / 暗角**：`body::after`（repeating-linear-gradient）+ `body::before`（inset box-shadow）

### 5.4 音效表

| 事件 | 参数化音色 | 特征 |
|---|---|---|
| 移动 | `zzfx(0.35, .03, 620, 0, .012, .05, 2, 1.2, -80)` | 锯齿短促下滑"咔" |
| 吃子 | `zzfx(0.5, .1, 180, 0, .05, .14, 4, 1.4, -60, …, noise=.5)` | 噪声+低频"砰" |
| 将军 | `zzfx(0.42, .02, 840, …, pitchJump 300)` | 方波上跳警报 |
| 点击/选中 | 720Hz / 980Hz 方波 40ms | 复古确认音 |
| 胜利 | C-E-G-C 四音上行琶音 | 小段旋律 |
| 失败 | C-Ab-Eb-C 下行 | 低沉旋律 |
| BGM | Web Audio 双振荡器音序器，102BPM，bass(triangle)+lead(square)+噪声 hat | 循环 8 小节 |

---

## 6. 兜底策略矩阵

| 故障 | 检测点 | 处理 |
|---|---|---|
| API 超时（>15s） | AbortController | 重试 1 次 → 仍失败则引擎低深度算 + 角色台词池 + toast 提示 |
| 返回非法 UCI | `normalizeUci()` 比对 legal moves | 重试 1 次（附纠错提示）→ 引擎兜底 |
| 返回非 JSON | `parseModelJSON()`（剥 ```json、截取首尾大括号、正则兜底） | 同「非法 UCI」 |
| 网络断开 / 无 API | `pl.api == null` | 静默切纯本地：引擎走棋 + `LOCAL_LINES` 或 `TAGS[*].lines` 台词 |
| 引擎加载失败 | 12s 超时 / worker onerror | `randomLegalMove()`，`charTaggedLine()` 出台词 |
| 引擎思考超时 | 每步 800ms 余量 + `stop` | 接受当前 bestmove，无则随机合法步 |
| 玩家点击非法格 | 选中态校验 | 静默取消选中 |

校验优先级（严格）：**当前 FEN 的 legal moves 列表**为唯一真源，`move.from + move.to (+promotion)` 必须命中；升变未指定时默认后。

---

## 7. 数据与存储

`localStorage` 前缀 `aca.v1.`：

| key | 内容 |
|---|---|
| `chars` | 角色数组（含 prompt / ava dataURL / seed / tags） |
| `apis` | API 配置数组（含 key 明文，仅本机） |
| `records` | 棋谱数组（≤40 条，含每步 san/uci/fen/thought/source） |

| `settings` | 音效开关、BGM、棋子样式、棋盘翻转、演出节奏 `pace`、`reducedMotion`、`highContrast`、`trustedHosts`（已确认端点，最多 30 条）、`clockPreset`（默认时限） |

---

## 8. 技术约束落地

| 约束 | 实现 |
|---|---|
| Vanilla JS ES6+ | 无框架，单 `<script>` |
| Canvas 棋盘 + DOM overlay | `BoardView` 类（Canvas）+ 气泡/面板（DOM） |
| chess.js | v0.10.3，**内联**（47KB），非 CDN —— 保证离线 |
| Stockfish WASM | v10（Emscripten 编译，asm.js 单文件 1.58MB）内联进 `<script type="text/plain">`，运行时转 Blob Worker —— 真正的「双击即玩」，不依赖 CDN 与 CORS |
| ZzFX | 单函数内联（等效参数序），零依赖 |
| 单文件 | 3.08MB，5423 行，双击可跑 |
| 无构建 | 无 npm/webpack/vite |
| 无 TypeScript | 纯 JS |


---

## 9. 交付说明

### 9.1 文件清单（v2.8 现状，两产物）

> 早期（v1.x）是单文件全内联，v2.0 起改为多文件 + 构建；下表以当前仓库为准。

**运行产物**

| 路径 | 说明 |
|---|---|
| `index.html` | HTTP/服务器托管用（`run.bat` 启动），引擎走 fetch |
| `offline.html` | 双击即玩，额外挂 `stockfish.inline.js` + `openings.inline.js` |
| `css/main.css` | 样式，字体相对 `../assets/fonts` 引用 |
| `js/*.js` | 17 个构建产物分片，与 `src/parts` 逐字节同步 |
| `assets/fonts/` | `ps2p.woff2`、`fusion-pixel-subset.woff2`（子集）、`fusion-pixel-12px-zh.woff2`（子集源） |
| `assets/vendor/` | `chess.js`、`stockfish.js`（上游原件）、`stockfish.inline.js`（生成） |
| `data/` | `openings.json`、`openings.inline.js`（生成） |
| `run.bat` / `package.json` | 启动脚本 / npm 脚本 |

**源码与工具**

| 路径 | 说明 |
|---|---|
| `src/build.py` | 组装 + `--check` 校验 + `--serve` 开发服务器（仅标准库） |
| `src/parts/` | 源码分片 17 个 `.js` + `01_head.html` + `02_body.html` |
| `src/subset_font.py` | 中文像素字体子集化 |
| `src/fonts/` | 上游字体原始文件：`fusion/`（`zh_hans` + `zh_hant` + `OFL.txt`）、`ps2p.woff2` |
| `src/pw/` | 15 套 Puppeteer 测试 + `run-tests.js` 总入口 + `testenv.js` |

**文档**

`GDD.md`（本文）、`CONTEXT.md`（会话上下文与坑表）、`THIRD_PARTY_NOTICES.md`（第三方许可）。

维护区（`src/`、`assets/`、`data/`）都可从源码重建；两份 HTML 是最终交付物。

### 9.2 为什么把 Stockfish 内联

原规格允许 Stockfish 从 CDN 加载，但 `file://` 双击打开时 Worker + CDN + CORS 三重约束很容易直接失败，而人机模式是核心玩法。因此把 1.58 MB 的 asm.js 构建写进 `<script type="text/plain">`，启动时转成 Blob URL 交给 `Worker`：

```js
const blob = new Blob([document.getElementById('sf-src').textContent], {type:'application/javascript'});
const worker = new Worker(URL.createObjectURL(blob));
worker.postMessage('uci');            // → uciok → ready
worker.postMessage('position fen ' + fen);
worker.postMessage('go depth ' + depth);
// → bestmove e7e6
```

实测（Chrome，离线模式）：引擎启动 <200ms，depth 12 约 2.4s，depth 18 约 8s；网络面板全程 0 请求。

### 9.3 已知边界

- **API Key 明文存 localStorage**。这是「纯前端 + 完全开放接入」的必然结果，页面上已明确提示。
- **浏览器直连第三方 API 需要对方允许 CORS**。OpenAI / Anthropic / 多数自建代理可用；部分厂商会拦，此时用兼容代理。Anthropic 额外带 `anthropic-dangerous-direct-browser-access: true`。
- **人机「地狱」档**在低端机上单步可能到 10s+（depth 30 + movetime 4.2s 上限）；思考期间状态栏会显示「长考中…」，可按暂停。
- **AI vs AI 双方都不填 API** 时自动退化为「引擎对引擎 + 内置台词」，不会卡死。
- 棋谱最多保留 40 条，超出从尾部丢弃（localStorage 5MB 限制下的保守值）。


---

## 10. v1.1 稳定性改造（对应外部评估报告）

外部评估指出 4 项 P0/P1 问题，逐条复现后确认 3 项成立、1 项的后果被低估，并额外发现 1 个隐藏的引擎缺陷。

### 10.1 修复清单

| # | 问题 | 复现证据 | 修复 |
|---|---|---|---|
| P0 | 中止引擎思考后 `busy` 永久卡住 | `stopAll` 后 `busy=true, queue=0`，job Promise 永不结算 | `Engine` 重写为显式状态机，`drain()` 统一结算所有 job |
| P0+ | **`setoption name Threads value 1` 让引擎静默停止输出** | 单独测试：不设 → `bestmove` 正常；设了 → 再无任何输出 | 移除该 option，只保留安全的 `Hash` |
| P1 | 旧对局异步写回新对局 | 旧局 `thought` 出现在新局棋步里 | `Run` 代次中心 + 每个 `await` 后 `Run.isLive(token)` |
| P1 | API 请求无法随离场取消 | 离场后请求继续挂 15s | `AbortController` 登记到 `Run`，`abort()` 统一取消 |
| P1 | Worker 出错时队列 job 永不完成 | `onerror` 后 `settled=TIMEOUT` | `onFatal()` → `drain()`，并支持 `restart()` |
| — | 深度预算与实测不符 | depth 13 实测 3.6s，预算 2.2s → 每次都超时兜底 | 按实测重标定为 6/10/14/20 层，预算 2/6/14/30s |

### 10.2 Engine 状态机

```
idle ──bestMove()──▶ queued ──flush()──▶ searching ──bestmove──▶ idle
  ▲                                        │
  └──────── cancelAll() / onFatal() ───────┘
```

三条不变量：

1. 每个 job 的 Promise 必然在「收到 bestmove / 超时 / 取消 / 出错」之一结算。
2. `busy` 只在当前 job 结算时复位，只有 `flush()` 能置 true。
3. `cancelAll()` 后 `queue` 为空、`busy` 为 false，迟到的 `bestmove` 被 epoch 丢弃。

`stop` 之后引擎会补发一次收尾 `bestmove`；若立刻发新 `go` 会被它打断，因此引入 260ms **静默期**（`_quietUntil`）后再放行新搜索。

### 10.3 代次隔离

```js
Run.kill();                    // 作废上一局：取消全部请求 + 订阅
const token = Run.token();     // 本局身份证
...
const res = await something();
if (!Run.isLive(token)) return;   // 每次 await 之后都要检查
```

`runSleep()` 是可被取消的 sleep —— 离场时立即返回，不让旧链继续拖时间。

### 10.4 统一 ApiContract

| 项 | 值 | 说明 |
|---|---|---|
| `MAX_TOKENS_UI` | 256 | 输入框上限 |
| `MAX_TOKENS_REQ` | 200 | 请求侧统一 clamp（文档曾写 80、UI 写 256、代码写 512，现已收敛） |
| 温度 | clamp [0, 1.5] | Anthropic 再收窄到 [0, 1] |
| 超时 | 15s | 可覆盖 |
| 台词清洗 | `cleanThought()` | 去换行/控制字符、剥包裹引号、≤60 字 |

错误分类：`abort / auth / notfound / ratelimit / server / network / timeout / parse / other`，每类给出可操作的中文提示（本地服务与远程 CORS 分别提示）。

### 10.5 演出节奏

三档：**完整 FULL / 快速 FAST / 仅棋步 OFF**（按钮或 `P` 键循环）。

| 档位 | 打字机 | 停顿 |
|---|---|---|
| FULL | 逐字（实测 1000ms/句） | 正常 |
| FAST | 4 倍速（实测 275ms/句） | 压缩 |
| OFF | 整句瞬时 | 最短 |

### 10.6 无障碍

- 所有弹窗 `role="dialog" aria-modal="true"`，打开时保存/恢复焦点，`Escape` 关闭
- 棋盘 `role="img"` + `aria-describedby` 指向实时文本摘要（轮次、上一步、双方子力清单、被将的王位）
- `prefers-reduced-motion` 自动生效，也可手动开关
- 高对比模式（加粗边框、提亮文字）
- 棋盘 `tabindex=0`，按钮/输入统一 `:focus-visible` 金色描边

### 10.7 安全

- **端点准入（EndpointGuard）** —— 见下节
- **清空此密钥** / **清空全部密钥** / **导出（脱敏）** —— 导出内容不含 `key` 字段
- 保存前校验：URL 协议、模型名非空、自定义模板必须能解析为 JSON 且必须有响应路径
- 页面底部与 API 页明确说明明文存储的风险

#### 端点准入机制

威胁模型：`localStorage` 里的 `base` 可被任何本页脚本、浏览器扩展或导入的配置改掉。
若不拦截，下一次开局就会把 API Key 明文发给攻击者域名。

```
请求前 → 取 URL 的 origin（协议+主机+端口）
        ├ 已信任（本会话 或 持久化白名单）→ 放行
        └ 未知 → 暂停请求，弹确认
                  ├ 取消     → 抛 AbortError，请求绝不下发，走本地兜底
                  ├ 仅本次   → 只进内存 Set，刷新即失效
                  └ 始终允许 → 写入 settings.trustedHosts（上限 30 条）
```

三个设计要点：

1. **判定放在请求前，不是保存时**。端点可能在保存后被改动，且三种格式的 URL 拼接规则不同（OpenAI 加 `/chat/completions`、Anthropic 可能加 `/v1/messages`、自定义直接拼）。
2. **并发串行化**。AI vs AI 时两方可能同时请求，确认框必须排队，否则 DOM 的 onclick 会被后一个 resolve 覆盖，导致前一个请求悬空。
3. **拒绝不阻断对局**。取消 = AbortError → 走既有引擎/随机兜底，只是这一句台词降级。

API 页提供**受信任端点**列表，可随时撤销单个地址。

### 10.8 工程化

```
npm run build    # python src/build.py      组装单文件
npm run check    # 分片自检（Node 语法 + 契约 + 代次要素）
npm test         # node src/pw/run-tests.js —— 六套件汇总，缺依赖会自动安装
```

六个套件：

| 套件 | 覆盖 |
|---|---|
| 功能回归 | 启动、角色、Prompt、UCI、JSON、PVE、将军、棋谱、回放、API 编辑器、持久化、移动端 |
| 运行时语义 | 引擎取消/崩溃恢复、代次隔离、演出节奏、台词清洗、错误分类、配置校验、无障碍 |
| 生命周期死锁 | 多 job 取消、Worker 崩溃 drain、快速重启 |
| 端点准入 | 拦截、仅本次、始终允许、撤销、三格式、可访问性、对局内拒绝不卡死 |
| 棋钟 | 开关、计时、增量、交棒、暂停冻结、超时判负、重置、预算联动、难度递增、AI 计时归属 |
| 悔棋与提和 | 词库匹配、确认框、取消不改局面、撤 1 手/2 手、日志保留、台词清空、可重复、观战禁用 |

`src/build.py` 现在会在打包前：
- 用 `node --check` 做真实语法检查（能正确处理正则与模板字面量）
- 检查顶层 `const/let/class` 重复声明
- 断言契约常量与代次隔离要素存在（防止回归时被删掉）

测试脚本全部改为**相对路径**，截图输出到 `%TEMP%\chess-arena-shots`，`npm test` 用退出码汇报。

### 10.9 PGN 导入

棋谱页新增「导入 PGN」：剥离标签/注释/变着/NAG/结果标记后逐着法用 chess.js 校验，任一步非法即整体拒绝并报出**具体第几步、哪个 token**。导入后进入同一套回放与「换角色重新解说」流程。

---

## 11. v1.3 棋钟（P1）

### 11.1 语义

采用 **Fischer 增量**：每走完一步立刻获得固定增量，不累积、不封顶。

一条硬规则：**AI 的思考时间计入它自己的钟**。这保证了「地狱」难度不是免费的——
它真的会消耗自己的时间储备，玩家有理由选择快棋来压制它。

### 11.2 预设

| 键 | 主时 | 增量 | 标签 |
|---|---|---|---|
| `unlimited` | — | — | 不限时（默认） |
| `blitz3` | 3 分 | +2s | 3+2 闪电 |
| `blitz5` | 5 分 | 0 | 5+0 快棋 |
| `rapid10` | 10 分 | +5s | 10+5 快棋 |
| `classic15` | 15 分 | +10s | 15+10 经典 |

### 11.3 难度 × 时限：预算联动

这是本版最关键的设计。引擎预算不再只看难度，而是：

```js
budget = clamp(min(难度基础预算, 余时 × 0.28), floor, 难度基础预算)
floor  = min(1200ms, 余时 × 0.5)
```

含义：**最多用掉 28% 的剩余时间思考**，但不少于 1.2 秒（太短来不及出好着法），
且下限绝不超过剩余时间的一半（否则会出现「预算比余时还长」的荒谬情况）。

实测联动效果（地狱档，基础预算 30s）：

| 剩余时间 | 实际预算 | 占余时 |
|---|---|---|
| 180s | 30s | 16.7% |
| 120s | 30s | 25.0% |
| 60s | 16.8s | 28.0% |
| 30s | 8.4s | 28.0% |
| 8s | 2.24s | 28.0% |
| 3s | 1.2s | 40.0%（触及下限） |
| 1s | 0.5s | 50.0%（下限被余时压住） |

四档难度在余时充足时的预算：`2s → 6s → 14s → 30s`，严格递增。

### 11.4 生命周期契约

| 事件 | 时钟行为 |
|---|---|
| 开局 | `Clock.start(preset, onFlag)`，清掉旧 interval |
| 进入回合 | `Clock.beginTurn(color)` 记录 `lastTickAt` |
| 落子 | `Clock.endTurn(color)` 结算耗时 → 发放增量 → 交棒 |
| 暂停 / 单步 | `Clock.pause()` 冻结，保留 `pausedSide`，恢复时续走 |
| 认输 / 离场 / 终局 | `Clock.stop()` 彻底停表 |
| 超时 | `onFlag` 记录胜方 → `abort({keepToken:true})` → 自行 `finish()` |

**踩坑记录**：超时回调最初直接调用 `abort()`，而 `abort()` 内部会 `Run.kill()` 推进代次，
导致 `loop()` 里的 `finish()` 因 `Run.isLive(token)` 失败而被跳过——结果面板永远不弹出。
修法是给 `abort()` 加 `keepToken` 选项：超时路径自己收尾，不走通用代次推进。

### 11.5 精度与性能

- `setInterval(100ms)` + `performance.now()` 结算差值，不用「每次 tick 减 100」，
  避免 interval 漂移导致计时不准
- 低于 20 秒时显示到 0.1 秒，并触发红色脉冲警示
- 时钟只在有 `running` 侧时扣时，暂停/结束时绝不空转

---

## 12. v1.4 悔棋与提和（P2）

### 12.1 核心交互

两个操作都**先确认再执行**，且确认框里由“对手”说一句符合人设的话。

```
点「悔棋」/「提和」
   → 弹出确认框（对手头像 + 打字机台词 + 取消/确认）
        ├ 取消 → 局面完全不变
        └ 确认 → 立即执行
```

这解决了「AI 已经想好的台词怎么办」的设计问题，答案由你定：
**撤销后保留台词，但不重放**。

### 12.2 人设反应词库

`REACT_LINES` 覆盖全部 16 个标签（15 内置 + `_default`），按 `undo` / `draw` 两类分场景。

| 标签 | 悔棋反应（示例） |
|---|---|
| 嘉豪 | 「什么？悔棋？九折水平还敢悔棋？……行，让你一次。」 |
| 冷酷 | 「悔棋。记录在案。撤。」 |
| 热血 | 「什、什么？悔棋？！这也太不热血了！……行，重来就重来！」 |
| 傲娇 | 「什、什么？悔棋？你也太不要脸了……行吧，就这一次。」 |
| 温柔 | 「没关系，悔棋吧，我们慢慢来。」 |

提和反应带一处特殊处理：为满足「点确认即生效」，拒绝倾向的语气会带一个让步尾巴，
读起来是嘴硬心软，而不是逻辑矛盾：

> 嘉豪：「懦弱之举我决不姑息！……不过既然你开口了，算和，反正我也下腻了。」

匹配规则：取角色 `tags` 中命中的标签池并集，随机抽一句。无标签走 `_default`。

### 12.3 悔棋语义

| 模式 | 撤回步数 | 结果 |
|---|---|---|
| PVE | 2 手 | 回到玩家回合 |
| PVP | 1 手 | 交给对方 |
| AI vs AI | — | 按钮禁用（观战不该被干预） |

执行细节：

- **日志保留**：被撤的条目加 `.undone` 类（划掉 + `↺`），文字不删
- **台词缓存清空**：`Game.lastThought = {w:'', b:''}`，防止已撤销的台词继续被当成「对手上一句」喂给模型
- **不重放**：撤销只改棋盘与日志标记，不重新播放任何演出
- **重新挂起**：`resumeAfterUndo()` 释放并重建 `pendingHuman`，保证后续能继续落子

### 12.4 提和语义

确认后进入 `agreement` 结果，文案「双方同意和棋 · DRAW AGREED」。
走与超时判负一致的收尾路径：`abort({keepToken:true})` → 自行 `finish()`。

### 12.5 可用性判定

```js
canUse():
  - 对局进行中、未中断
  - AI vs AI → false
  - PVE → 轮到人类 且 不在 busy 态
  - PVP → 恒 true
```

按钮随状态禁用并给出 `title` 说明。快捷键 `Ctrl/Cmd+Z` 触发悔棋。

**踩坑记录**：`canUse()` 最初要求「必须有 `pendingHuman`」。但 AI 落子后会先走完演出
（约 600ms）才重建 `pendingHuman`，这个窗口内按钮是灰的，体验上像「点了没反应」。
改为「轮的turn 是你就行，只要不在 busy 态」。

---

## 13. 剩余项（随版本推进，此表必须同步）

> 这一节曾被漏更两次：v2.1/v2.2 做完开局库与棋力分析后表格仍写着「属于第三阶段」，
> 下个会话照着表会重做一遍。**每次关掉一项就改这里**，不要只改正文。

| 项 | 状态 | 说明 |
|---|---|---|
| 开局库 | ✅ v2.1 | ECO 3606 局面，见 §16 |
| 提示着法 | ✅ v2.1 | 开局库优先 + 引擎兜底，见 §16.4 |
| 棋力分析 / 评估条 | ✅ v2.2 | 第二 Worker，见 §17 |
| 复盘报告 | ✅ v2.2 | 失误分级 / 转折点 / 存谱，见 §18 |
| 无障碍摘要自动刷新 | ✅ v2.2.1 | 见 §18.8 |
| 存谱 / 复盘记录归属 | ✅ v2.2.1 | 见 §18.8 |
| 键盘完整走子 | ✅ v2.3 | WCAG 2.1.1 达标，见 §19 |
| 320px 全页面专项 | ✅ v2.5 | 六页零溢出、触控 ≥32px、字号 ≥10px，见 §21 |
| Elo / 连胜 / 角色成长 | ⛔ 不做 | 纯堆量，用户明确降优先级 |
| 后端代理 / 桌面封装 | ⛔ 不做 | 改交付形态，需单独决策 |


---

## 14. v2.0 多文件架构迁移（2B）

### 14.1 为什么必须迁移

单文件方案在 v1.4 已达 3.02 MB，其中 Stockfish 占 1.54 MB、字体占 0.94 MB。
继续叠加功能（开局库、棋力分析）会持续膨胀，且单文件无法做模块化、无法懒加载。

### 14.2 关键实测：file:// 不可行

决定方案前先用无头 Chrome 实测（**不加任何放宽参数**，模拟用户双击）：

| 方式 | 结果 |
|---|---|
| `fetch('data.json')` 相对路径 | `Failed to fetch` |
| `fetch('file:///.../data.json')` 绝对 | `Failed to fetch` |
| `XMLHttpRequest` 同步 | 拒绝 |

加上 `--allow-file-access-from-files` 后全部成功——但用户双击时没有这个参数。

**结论**：拆分后必须走 HTTP。因此选定 2B + `run.bat` 封装。

### 14.3 最终结构

```
index.html      29 KB   外壳 + 13 个 <script src>
css/main.css    30 KB   全部样式
js/*.js        195 KB   13 个逻辑模块
assets/fonts   935 KB   两套像素字体（woff2，不再 base64）
assets/vendor   1589 KB chess.js + stockfish.js
src/parts/              源分片（唯一真源）
```

`js/` 是 `src/parts/` 的同步副本，由 `build.py` 生成。

### 14.4 三个技术决策

**1. 用 `<script src>` 而非 ES Module。**
项目依赖「顺序加载的全局对象图」（`Store` → `API` → `Game` → `UI`），
改成 `import` 需要重写全部 13 个文件的导出/导入，收益不足以抵消风险。
且 `import` 在 file:// 下同样受限，本就需要服务器，没有额外好处。

**2. Stockfish 必须用 fetch，不能用 `<script>`。**
它要作为独立 Worker 运行，不能污染主线程全局作用域。
`fetch` → `Blob` → `URL.createObjectURL` → `new Worker()`。

**3. 字体改为外链，不再 base64。**
CSS 里 `url(../assets/fonts/...)`，相对 `css/` 目录解析。
`build.py` 会断言路径正确、且不再含 `data:font`。

### 14.5 测试基础设施适配

- 所有测试的 `FILE` 从 `file://` 改为 `http://localhost:8765/index.html`
- 去掉 `--allow-file-access-from-files` 启动参数（不再需要）
- `run-tests.js` 自动检测服务器：不在运行就用 `python -m http.server` 拉起，测试结束自动关闭
- `npm test` 冷启动（无 node_modules、无服务器）可一条命令跑通

### 14.6 构建脚本重写

`src/build.py` 现在做四件事：

1. 断言必需资源存在（css、两套字体、两个 vendor）
2. 用 `node --check` 做真实语法检查（13 个分片合并后）
3. 检测顶层重复声明、契约常量、代次隔离要素、端点准入要素、预算函数
4. 断言 `index.html` 引用了全部 13 个模块、CSS 字体路径正确且无 base64

### 14.7 踩坑

**改错了文件**：迁移时我直接改了 `js/06_engine.js`，结果 `npm run build`
从 `src/parts/` 同步时把改动覆盖回去，导致引擎加载失败。
**规则：永远改 `src/parts/`，然后 build。**

### 14.8 使用方式变化

| | v1.4 | v2.0 |
|---|---|---|
| 启动 | 双击 `index.html` | 双击 `run.bat` |
| 依赖 | 无 | 需 Python 3（`run.bat` 检测并提示） |
| 离线 | 是 | 是（本地服务器不出网） |
| 体积 | 3.02 MB 单文件 | 11.07 MB 目录 |

---

## 15. 待做

| 项 | 说明 |
|---|---|
| ~~开局库~~ | ✅ v2.1 完成（§16） |
| ~~提示着法~~ | ✅ v2.1 完成（§16.4） |
| ~~棋力分析~~ | ✅ v2.2 完成（§17） |
| ~~复盘报告~~ | ✅ v2.2 完成（§18） |
| Elo / 连胜 / 角色成长 | 纯堆量，优先级低 |
| 后端代理 / 桌面封装 | 改交付形态，需单独决策 |


---

## 16. v2.1 开局库与提示着法（P3/P4）

### 16.1 数据来源与压缩

原始数据：`chess-openings` npm 包的 `eco.js`（2.9 MB，3606 个局面，ECO 编号 + 名称 + 合法着法表）。

压缩链路：

| 步骤 | 体积 | 说明 |
|---|---|---|
| 原始 `eco.js` | 2.9 MB | JS 对象字面量，键是完整 FEN |
| 转 JSON | 1.27 MB | 去掉 JS 包装 |
| 池化名称 | 443 KB | 名称去重池（3131 条） |
| 拆分家族/变例 | **361 KB** | `family` + `segments` 两级池 |

最终格式：

```json
{
  "v": 1,
  "families": ["Ruy Lopez", "Sicilian Defense", ...],
  "segments": ["Morphy Defense", "Najdorf Variation", ...],
  "pos": {
    "r1bqkbnr/pppp1ppp/2n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R b KQkq -": ["C60", 0, [], "e8e7"]
  }
}
```

键是 FEN 前 4 段（棋盘 + 走子 + 易位 + 吃过路），忽略回合数，同一局面无论从哪条路径到达都能命中。

### 16.2 数据语义的两个反直觉点

**① 库索引的是「走完该步之后的局面」，不是「能走该步的局面」。**

实测：走完 `1.e4` 查不到（e4 之后的局面本身没有命名），走完 `1.Nf3` 能查到（King's Knight Opening）。

原因：ECO 只收录**有名字**的局面。e4 之后是 Sicilian / French / Caro-Kann 等的共同父节点，它自己没有名字。

**② 每条记录的 `moves` 是该局面的全部合法着法（30 个，按 UCI 字母序），不是推荐着法。**

所以不能直接拿 `moves[0]` 当建议。我给 `nextUci` 字段做过这种错误假设，结果提示返回 `Ke7` 这种垃圾着法。

### 16.3 开局名解析

```js
current(chess):
  回放整条历史 → 记录最近一次命中的命名局面
  若无任何命中 → 返回「开局阶段」（不猜测）
```

早期版本会「前探一步猜可能进入哪个开局」，实测不可靠：
`1.e4` 之后可能通往几十个开局，猜中一个（如 Owen Defense）反而误导。
改为不猜，只显示确定信息。

### 16.4 提示着法算法

开局库本身不带着法质量信息，因此用**谱系广度**作为主线判据：

```
对每个合法着法：
  走完后是否有命名？
  该子局面在 2 层深度内能到达多少命名局面（spread）？
  该名字是否与当前体系同族？

score = (同族 ? 1e7 : 0) + spread × 1000 − 名字长度
```

实测效果：

| 局面 | 建议 | 进入的开局 | 评价 |
|---|---|---|---|
| 意大利（黑方） | `Bc5` | Giuoco Piano | ✅ 主线 |
| 西班牙（黑方） | `Nf6` | Berlin Defense | ✅ 主线 |
| 西西里（白方） | `Nf3` | Sicilian Defense | ✅ 标准 |
| 初始局面 | `Nf3` | Zukertort | ⚠️ 合理但非最主流（e4 更常见） |

**为什么「名字越短越主线」**：意大利局面下 `Bc5` 对应「Italian Game: Giuoco Piano」（26 字符），
`h6` 对应「Italian Game: Anti-Fried Liver Defense」（38 字符）——后者是著名的劣着。
变例名越长，说明越偏离体系根。

### 16.5 降级路径

```
点「提示」
  ├ 开局库有建议 → 画箭头 + toast「建议 Bc5 — C60 · Ruy Lopez」
  └ 开局库无此局面 → 引擎短搜索（depth 8, 3s）→ 箭头 +「引擎建议：O-O」
```

开局库只覆盖前 ~10-15 回合，超出后自动切引擎，用户无感知。

### 16.6 踩坑

| 坑 | 现象 | 结论 |
|---|---|---|
| `index.shell.html` 与 head/body 不同步 | 新加的按钮在构建后消失 | 废弃独立 shell 模板，改由 `build.py` 从 `01_head.html` + `02_body.html` 组装 |
| 构建顺序 | `--check` 在同步前跑，新增模块被误报缺失 | `main()` 改为先 `sync()` 再 `check()` |
| 名字取最长 | 提示给出 `h6` 等劣着 | 改为最短名 + spread 加权 |
| `current()` 猜开局 | 显示 "Owen Defense" 等错误猜测 | 删除猜测，只显示确定信息 |
| 悔棋后开局名不刷新 | 数据未加载时 `ready()` 为 false 跳过 | 改为 `.load().then()` 链式刷新 |

### 16.7 体积

| 项 | 体积 |
|---|---|
| `data/openings.json` | 361 KB |
| `js/08b_openings.js` | 3.1 KB |
| 加载耗时（本地） | 14 ms |

体量已不再是约束（用户明确「不拘泥文件大小」），当前压缩是顺手做的，仍有优化空间（如 gzip 后约 90 KB）。

---

## 17. v2.2 棋力分析 · 评估条（P1）

### 17.1 决策：第二个 Worker（方案 A）

需求是「实时显示局面评估」。唯一的技术岔路是跟 AI 走子的主搜索抢不抢 Worker。

| | 方案 A · 第二个 Worker（采纳） | 方案 B · 复用主 Worker |
|---|---|---|
| 走子时评估 | 照常推进 | 卡住 |
| 实现复杂度 | 一个独立状态机（可复用 Engine 的纪律） | 要引入 job 优先级 + 让位协议 |
| 内存代价 | 多一份 ~1.5 MB 引擎源码 + Hash 32 MB 上限 | 省下这份 |
| 可信度 | 评估不被主搜索的 depth/budget 污染 | 两边互相污染 `info` 流 |

用户明确「不用拘泥文件大小，优先最佳效果」→ 采纳 A。

**实测证据**（`test_eval.js` 第 3 组）：主引擎跑 `go depth 20`（4s 超时截断）期间发起评估，
评估 1.5s 内返回分数，且主搜索仍处于 busy、最终仍给出着法。若共用一个 Worker，这两个数不可能同时成立。

### 17.2 Analysis 状态机

刻意与 `Engine`（§10.2）保持同一套收尾纪律，但有两点不同：

```
idle ──live()/evaluate()──▶ queued ──flush()──▶ searching ──bestmove──▶ idle
                               ▲                   │
                               └── stop / timeout ──┘（用最后一次 info score 结算）
```

**不同点 ①：允许「部分结果结算」。**
主引擎超时必须返回 `null`（宁可让 Game 走随机兜底，也不能给一个半成品着法）。
评估相反：`stop` 时手上有几分就用几分——实时评估要的就是这个语义。

**不同点 ②：抢占是常态，不是异常。**
走一步棋只会产生一个新局面，所以 live 队列**只允许存在一个** live job；
新局面到来时先撤掉旧的（`abortJob(..., 'supersede')`），再排新的。
review job 则插队到队首，并抢占正在跑的 live job（复盘优先）。

### 17.3 视角折算 —— 唯一容易搞错的地方

引擎的 `info score cp/mate` 是**走子方视角**。同一个 `+80`：
- 轮到白方 → 白优 0.8
- 轮到黑方 → 黑优 0.8 → 对白方是 −0.8

所以全部对外接口（`EvalBar`、`Review`）统一用「白方视角厘兵」：

```js
whiteCp(score, turn) = score.value * (turn === 'w' ? 1 : -1)   // cp
// mate 折算：cp = ±(10000 − n×10)，保证 mate 永远压过任何 cp
```

**坑**：`turn` 必须取**该 FEN 自己的**走子方，不能取「全局当前轮到谁」。
复盘时逐手回放，每一手的 `turn` 都不同，用全局值会让黑方每一步的失误符号全部反掉。

### 17.4 评估条视觉

不能用系统控件（全局约束）。做法是 canvas 22×N（窄屏 16×N），N = 棋盘实测边长：

- 白方份额 = `1 / (1 + 10^(−cp/400))`，即标准 logistic；mate 直接给 0 或 1
- 白区 `#c2b9e4` + `#ece8ff` 4px 抖动网格；黑区 `#1a1430` + `#241c47` 抖动
- 分界线：金色 2px 硬线 + 1px 暗金，"无渐变、无圆角"
- 刻度：25/50/75% 各 1px 硬线；中线右侧 3px 紫色小方块标均势
- 数字牌：等宽像素字体，白优金色 / 黑优青色
- 翻转棋盘时 `EvalBar.flipped` 跟着翻，白方份额永远贴自己那半边

**性能**：`apply()` 有 70ms 节流（`requestAnimationFrame` 合并），
因为 asm.js 引擎在 480ms 预算里能吐几十行 `info`，直连会让 canvas 每帧重画。
需要「立刻生效」的场合（尺寸变化、开关、测试断言）走 `applyNow()` 跳过节流。

### 17.5 AI 长考期间的双通道

分析 Worker 跑 480ms 就被截断、然后有 260ms 静默期；恰好 AI 长考（达 30s）时评估条会显得"冻住"。
因此 `computeEngineMove()` 里挂了一个 220ms 轮询，直接读 **主** 引擎的 `Engine.score()`
（主引擎此刻正在搜**就是**这个局面，分数比分析的更准更新）。

两条通道都归一到同一个 `EvalBar.apply()`，互不打架：
主搜索结束即清掉轮询，分析 Worker 接着接管。

### 17.6 生命周期契约

| 事件 | 动作 |
|---|---|
| `boot()` | `EvalBar.init()`；`evalBar !== false` 时预热 `Analysis.init()` |
| `Game.start()` | `EvalBar.reset()` → `syncToBoard(view)` → 排一次初始局面评估 |
| 每步落子后 | `Game.analyzePosition(token)`，`Run.isLive` 已校验 |
| AI 长考 | 220ms 轮询 `Engine.score()`，结束清理 |
| `Game.abort()` | `Analysis.cancelAll()`（**必须**：分析 Worker 与主搜索独立，不主动停会一直搜下去） |
| 关闭开关 | `cancelAll()` + 隐藏评估条；Worker 保留但不再收活（再次打开不重复加载 1.5MB） |
| 引擎崩溃 | `Analysis.restart()` 独立重建，不影响主搜索 |

### 17.7 踩坑

| 坑 | 现象 | 结论 |
|---|---|---|
| 评估与主搜索共用 Worker | AI 思考时评估条不动 | 必须第二 Worker（§17.1） |
| 用 `Engine.score()` 当实时评估 | 无 AI 对局（PVP / 人类回合）永远是 null | 主通道走 Analysis，`Engine.score()` 只做长考补充 |
| 忘记折算走子方视角 | 黑方回合条子朝错方向 | 统一 `whiteCp(score, turn)` |
| `turn` 取全局 | 复盘里黑方失误符号全反 | `turn` 必须来自该 FEN |
| 不节流直连 info | canvas 每帧重画、CPU 飙 | 70ms 节流 + `applyNow()` 逃生口 |
| 进对局后评估条尺寸不变 | 高度 480 ≠ 棋盘 664 | `Game.start()` 里 `EvalBar.syncToBoard(view)`（不是 `resize()`，它只认传入值） |
| 关开关只隐藏不取消 | 后台还在跑搜索 | `Settings.toggleEval()` 先 `cancelAll()` |
| 两个页面用同一个 `id` | 结果页进度条永不更新 | 结果页 `reviewBarRes`、回放页 `reviewBar`，`ReviewUI.bars()` 一起驱动 |

### 17.8 预算与开销

| 项 | 值 |
|---|---|
| live 评估 | `go depth 24` + 480ms 超时截断（实际到 depth 11~16） |
| review 评估 | `go depth 14` + 1400ms（实际 700~1200ms/步） |
| 第二 Worker 内存 | 源码 ~1.5 MB（Blob）+ Hash 上限 32 MB |
| 缓存 | 700 条 FEN → 评估结果（Map，FIFO 淘汰） |
| 评估条重绘 | ~0.05 ms/次（22×664 像素填充） |

---

## 18. v2.2 复盘报告（P2）

### 18.1 失误判据

以白方视角 cp 为唯一基准，逐手算**走子方视角的损失**：

```
loss(白方走) = cp[走前] − cp[走后]
loss(黑方走) = cp[走后] − cp[走前]
```

| 档位 | 阈值 | 标记 | 颜色 |
|---|---|---|---|
| 严重失误 | ≥ 300 cp | `??` | `#ff4d6d` |
| 失误 | ≥ 150 cp | `?` | `#ff9f2e` |
| 不够精确 | ≥ 70 cp | `?!` | `#ffcc4d` |
| 正常 | < 70 cp | — | `#63e6a0` |

阈值取自通行分级（Lichess/Chess.com 的 ?!/?/?? 分界量级一致），**但准确率不同源**：

```
acl      = mean(clamp(loss, 0, 1000))        // 单步损失截断
accuracy = round(100 × exp(−acl/300))
```

这是本项目内部可比的启发式，**不与 Lichess 的 Accuracy 数值对齐**（其算法含胜负概率模型）。GDD 里写清楚，
免得以后有人拿两个数字对比然后以为出错。

三处额外截断，都是"别让一步送杀毁掉整盘统计"：
- 单步 loss 截断到 1000（否则一步送后能吃满几万分）
- cp 序列本身截断到 ±1200（送杀局面 cp 会爆到 10000+）
- 平均只在有数据的步上算（首步无"走前"评估时跳过）

### 18.2 关键点提取

| 字段 | 定义 |
|---|---|
| `turn`（转折点） | `max(|cp[后] − cp[前]|)` 的那一手；Δ 越大越致命 |
| `best`（最佳一手） | 走子方视角收益最大的一手 |
| `keyMoments` | 所有 `?` / `??` 按 loss 降序取前 6 手的 ply 列表 |

转折点用**绝对值摆幅**而不是 loss，是因为 loss 只算失误方，而"这盘从哪开始变天"是双边概念。

### 18.3 数据流

```
终局面板「复盘」 ─┐
                 ├─▶ Review.start(rec)
回放页「复盘此局」┘        │
                          ├─ Analysis.init()（第二 Worker，绝不碰主 Engine）
                          ├─ positionsOf(rec)     // 初始局面 + 每步 fen
                          ├─ for each: Analysis.evaluate(fen, {kind:'review'})
                          │      └─ 缓存命中（depth ≥ minDepth）直接复用
                          ├─ build(rec, pos, cps) // 纯函数，可单测
                          └─ attach(rec, result)  // 写回 rec.review + 每步 tag + 落盘
```

`build()` 刻意做成纯函数（输入 rec / pos / cps 序列，输出报告对象），
这样分级算法、转折点、准确率全部可以在浏览器里用构造数据验证，不需要真实引擎（见 `test_review.js` 第 1、2 组）。

### 18.4 持久化

复盘结果存进棋谱记录本身：`rec.review = {...}`，同时把 `loss/tag` 摊到 `rec.moves[i]` 上。
好处：回放页打开就有报告，不必重算；坏处：`localStorage` 体积翻倍。

体积核算：120 步的棋谱，`review` 约 120 × 60 字节 ≈ 7 KB，
加上原有的 `moves[]`（含 FEN + 台词）约 30 KB，仍在 `saveRecords()` 的 40 条上限内可用。

### 18.5 UI

**回放页**（`#reviewPanel`）：
- 对局信息多一行「复盘 77%」
- 「当前步」下方一行 `rv-now`：`? 失误 · 损失 248cp`，颜色随档位
- 报告卡：三档计数 + 双侧均损 + 转折点 + 最佳一手 + 可点击的关键片段列表
- 点片段 → `Replay.goto(ply)`；`Replay.goto()` 尾部调 `ReviewUI.markCurrent()` 保持同步

**终局面板**：`复盘` 按钮 + 一条宽进度条（`reviewBarRes`），文案从「复盘」变「复盘 30%」再变回「复盘」。
点「复盘」时若棋谱还没存，先自动存一条（`window.__lastSavedId` 复用，重复点不会重复存谱）。

### 18.6 踩坑

| 坑 | 现象 | 结论 |
|---|---|---|
| 复盘用主 Worker | 复盘时真想再下一盘就互相打断 | 全程 `Analysis.evaluate()`，测试里直接断言 `Engine.bestMove` 未被调用 |
| `rec.moves[i].fen` 语义 | 误当"走之前" | 它是**走完之后**的局面；`positionsOf()` 需自己补初始局面 |
| 黑方损失符号 | 黑方送子被判成"好棋" | 按 `m.color` 定符号，不是按 `turn` |
| 缓存门槛太松 | live 的部分结果（depth 11）被 review 复用，跨步不一致 | `evaluate({minDepth})` 卡门槛，不够深就重算 |
| 单步送杀污染统计 | 准确率被抹成 0% | loss 截断 1000、cp 截断 ±1200 |
| 两个 `id="reviewBar"` | 结果页进度条不动 | 拆成 `reviewBarRes` / `reviewBar`，`bars()` 批量更新 |
| 复盘中途离场 | Promise 永挂 | `Review.cancel()` 推进 `token`，`start()` 每个 await 后校验 |

### 18.7 实测数据

| 场景 | 步数 | 耗时 | 结果 |
|---|---|---|---|
| 愚人杀（1.f3 e5 2.g4 Qh4#） | 4 | 6~7 s | f3 `?`、g4 `??`、准确率 31~70%（视引擎版本深度而定） |
| 单步评估（depth 14 / 1.4s） | — | 0.7~1.2 s | — |
| 缓存命中率（对局中已评估过的局面） | — | 接近 0 ms | 走完就评估，复盘直接复用 |

注意：极短棋谱（4 步）的准确率波动大，因为分母只有 4。这是启发式的固有性质，不是 bug。

---

## 18.8 v2.2.1 两处缺陷修复（无障碍摘要 / 存谱归属）

这两条不是新功能，是核对「待做清单」时撞出来的既有 bug。都是「状态没跟着生命周期走」。

### 18.8.1 无障碍摘要永远停在初始局面

**现象**（实测）：

```
初始局面   → 轮到白方走子。白方：兵a2、兵b2、兵c2...
Nxe5 之后  → 轮到白方走子。白方：兵a2、兵b2、兵c2...   ← 完全相同
```

**成因**：`A11y.updateBoardLabel()` 全项目只在 `boot()` 调用一次。
棋盘是 canvas，没有可读 DOM，`#boardA11y` 这个 `aria-live` 区域是屏幕阅读器**唯一**的信息来源，
所以读屏用户听到的是永远的开局。

**修法**：把刷新挂到每个改变局面的出口，而不是依赖调用方记得调。

| 调用点 | 覆盖场景 |
|---|---|
| `Game.applyMove()` 写完 `view.setPosition()` 之后 | 人类落子 / AI 落子 / 接管 |
| `UndoDraw.performUndo()` | 悔棋（否则读屏还停在"吃过子之后"） |
| `Replay.goto()` | 回放逐步 / 复盘跳步 |
| `boot()` | 首屏 |

**副产物：回放页需要自己的 live region。**
`#boardA11y` 挂在 `#screen-battle` 里，而该屏在回放时是 `display:none` ——
`display:none` 子树里的 live region 不会被朗读。因此给回放页加了独立的 `#replayA11y`，
`updateBoardLabel(chess, view, targetId)` 现在接受第三个参数指定目标。

`describe()` 同时去掉对 `Game.chess` 的隐式依赖（改为参数传入），
否则回放页描述的还是主棋盘的局面前。

**去重**：内容不变时直接 return，避免动画帧内重复写入触发重复播报。

### 18.8.2 存谱 / 复盘会串到上一局

**现象**（实测）：

```
第一局 存谱 → __lastSavedId = rec_xxx (f3)
开局第二局（不清空）→ 点「复盘」→ 复用了 rec_xxx，复盘的是上一盘的棋
```

**成因**：本局已落盘记录的 id 存在 `window.__lastSavedId` 上，只在存谱时写入、
**从不在 `Game.newChess()` 里清空**。跨局残留。

**修法**：
1. 归属下沉到 `Game.savedRecordId`，`newChess()` 里置 `null`。状态跟着对局对象走，随新局自然复位。
2. 抽出 `saveCurrentGame()` 作为唯一的存谱入口，幂等：已有 id 且记录仍在库里就直接复用，
   因此「存棋谱」连点两次不会产生两条棋谱。
3. 「存谱」与「复盘」共用这个入口 —— 复盘不再自己拼一遍落盘逻辑。

**保留的行为**：同一局里先「存谱」再「复盘」，复用同一条记录（不会多一份），
但复盘结果写回的是**这一局**的记录。

### 18.8.3 回归用例

| 套件 | 新增断言 |
|---|---|
| `test_phase2.js` §9 | 摘要随落子自动更新（不手动调用）；写入实际着法 `Nxe5`；子力数 4→3；悔棋后自动更新；回放页 live region 存在且与 battle 分离 |
| `test_review.js` §8b | 新局清空 `savedRecordId`；重复存谱 1→1；新局复盘不复用上一局 id；复盘取到本局棋步 `e4` 而非上一局 `f3`；两局各自独立入库 |

### 18.8.4 踩坑

| 坑 | 现象 | 结论 |
|---|---|---|
| live region 放在隐藏屏里 | 回放时读屏毫无反应 | `display:none` 子树里的 live region 不播报，每屏要各自一份 |
| `describe()` 读全局 `Game.chess` | 回放页描述的是主棋盘 | 局面必须由参数传入 |
| 每帧都写 live region | 部分读屏重复播报同一句 | 内容不变就跳过写入 |
| 用 `window.*` 存对局状态 | 跨局串味（本 bug） | 状态归 `Game`，在 `newChess()` 复位 |
| 存谱按钮不幂等 | 连点出多条相同棋谱 | `saveCurrentGame()` 先查 `savedRecordId` 是否仍在库 |

---

## 19. v2.3 键盘完整走子（P3 · WCAG 2.1.1）

### 19.1 缺口是什么

棋盘是 canvas，没有可读 DOM。此前它已有 `tabindex="0"`、`:focus-visible` 金色焦点圈、`#boardA11y` 文本摘要，
看起来"无障碍做了"，但实际按方向键什么也不会发生 —— **纯键盘用户根本下不了棋**。
WCAG 2.1.1（Keyboard）是 A 级硬项，这不是"体验优化"，是达标问题。

### 19.2 设计原则（三条都不能破）

**① 不改落子逻辑。**
所有键盘动作最终都调 `Game.onSquareClick(sq)` —— 与鼠标点的是同一个入口。
如果键盘另写一条落子路径，迟早会出现"键盘能走、鼠标不能走"的合法着法分歧，
而这种分歧极难测出来（鼠标路径的测试不会覆盖键盘分支）。

**② 光标 ≠ 选中。**
`view.cursor` 是纯展示层状态，选中仍由 `Game.selectSq` / `view.selected` 唯一持有。
键盘层只做"把光标移到某格"和"对该格触发点击"，不碰对局状态机。

**③ 坐标按屏幕方向走。**
玩家看到的是翻转后的棋盘，`→` 必须往**屏幕**右走。所以方向键要按 `view.flipped` 反算：

```js
sqFromScreen(col, row) {
  let f = col, r = 7 - row;
  if (flipped) { f = 7 - f; r = 7 - r; }
  return 'abcdefgh'[f] + (r + 1);
}
```

漏了这一步的现象：执黑（棋盘翻转）时按 ↑，光标朝屏幕下方跑。实测用例见 `test_keyboard.js` §3。

### 19.3 键位

| 键 | 行为 |
|---|---|
| ↑↓←→ | 移动光标（按屏幕方向），撞边不动也不报错 |
| Home / End | 跳到当前屏幕行的行首 / 行尾 |
| Enter / Space | 选中己方子 → 移到合法目标 → 落子；再按取消 |
| Esc | 取消选中（不退出棋盘焦点） |
| Tab | 正常离开（不劫持） |

光标入场默认落在**走子方的王**上（`Game.findKingOn`），因为那是每回合必看的位置。
找不到（残局异常）退回 e1/e8。

### 19.4 与全局快捷键的冲突

战局页原本有全局快捷键：`Space` = 暂停、`→` = 单步。这两个键与棋盘操作直接冲突。

处理是两层的：

1. `BoardKeys.onKey` 里 `preventDefault()` + `stopPropagation()` —— 事件不再冒泡到 document
2. 全局 handler 里加 `if (e.target.id === 'boardCanvas') return;` —— 双保险，
   防止某条路径没拦住时顺带触发暂停

**保留的行为**：焦点不在棋盘上时，`Space` 仍然是暂停；失焦会自动收起光标（`blur` 监听）。

### 19.5 播报

键盘光标不播报的话，读屏用户只知道"焦点在棋盘上"，不知道在哪个格。

`describeSquare(sq)` 输出三类信息：

```
e2，白兵，可走 2 处（含 1 处可吃子）。            ← 己方子
e4，可落子。已选 e2，2 个合法目标，回车落子。      ← 选中后的合法目标
a3，空格。回车选中。                              ← 空地
```

写入 `#boardA11y`（`aria-live="polite"`），**90ms 节流**：连按方向键时只播报落点，
否则读屏会把中间经过的每一格都念一遍，等念完用户早就迷路了。

### 19.6 光标视觉

金色虚线框 + 四角加粗，与既有三态区分开：

| 视觉 | 含义 |
|---|---|
| 青色实线框 + 虚线角 | 已选中的棋子（`view.selected`） |
| 金色脉冲虚线框 | 键盘光标（`view.cursor`） |
| 黄点 / 红框 | 合法目标（`view.legal`） |
| 白色微光框 | 鼠标 hover |

虚线用整数像素节拍（`dash = 4`）手绘，不用 `setLineDash` —— 后者在小尺寸下会产生抗锯齿，
破坏像素风格。

### 19.7 输入方式互斥

| 事件 | 动作 |
|---|---|
| `canvas.focus` | 进入键盘导航，光标落到王位 |
| `canvas.blur` | 收起光标（避免与鼠标 hover 打架） |
| `canvas.mousedown` | 收起光标（两套输入不混用） |
| `Game.newChess()` | 清光标；若焦点仍在棋盘上则重新落到王位 |

### 19.8 测试策略（踩过的坑）

键盘测试最大的陷阱是**测试自己在改对局状态**。第一版把 `pendingHuman` 换成手写的
`{ color: 'w', resolve(){} }`，结果 `activate()` 落子后没人接，后续断言全错位。

最终策略是**分两类用例**：

| 类型 | 做法 | 覆盖 |
|---|---|---|
| 真实对局 | `freshMatch()`：`abort()` → `startMatch()` → 轮询等到 `pendingHuman.color === 'w' && !busy` | 落子等价性（§6）、Space 不暂停（§10） |
| 冻结静态 | `freeze()`：`Game.abort()` + `running = false`，只留 `chess` / `view` | 光标移动（§3–5）、非法步（§7）、Esc（§8）、播报（§9） |

冻结态下 `onSquareClick` 会因 `running = false` 直接返回，所以凡是需要"选中态"的断言
都直接构造 `Game.selectSq` / `view.selected` / `view.legal`，不依赖点击路径。

### 19.9 踩坑

| 坑 | 现象 | 结论 |
|---|---|---|
| 键盘另写落子路径 | 与鼠标的合法着法不一致 | 一律走 `Game.onSquareClick` |
| 方向键不按 `flipped` 反算 | 执黑时上下颠倒 | `sqFromScreen` 先反算再取格名 |
| 未 `stopPropagation` | 按方向键同时触发「单步」 | 棋盘内 `preventDefault + stopPropagation`，全局再加 `target.id` 守卫 |
| 未处理 blur | 鼠标点完键盘光标还亮着 | blur + mousedown 都收起光标 |
| 每次移动都播报 | 读屏念一串中间格 | 90ms 节流，只播报落点 |
| 测试替换 `pendingHuman` | 落子后无人接，状态错位 | 分「真实对局」与「冻结静态」两类用例 |
| `setLineDash` 画虚线 | 小尺寸下糊 | 手绘整数像素节拍 |

---

## 20. v2.4 评估子系统缺陷排查（八个 bug）

一次针对性排查（不预设结论，先写探测脚本实测）挖出 8 处问题，其中 3 处会产生**用户可见的错误结果**。

### 20.1 缺陷清单

| # | 缺陷 | 现象 | 严重度 |
|---|---|---|---|
| 1 | 悔棋后评估条不刷新 | 棋盘已回到开局，分数还停在悔棋前 | **高**（用户以为悔棋没生效） |
| 2 | 复盘复用 live 的浅缓存 | depth 9 与 depth 11 差 126cp，`?!` 阈值才 70 → 判级失真 | **高**（错误报告） |
| 3 | 残留 `info` 污染新 job | 送杀局面读出 `+1.0`（其实是上一局的分数） | **高**（错误报告） |
| 4 | `live()` 过滤队列不结算 | 被丢掉的 job Promise 永久挂起 | 中（潜在泄漏） |
| 5 | `finish()` 不停分析 Worker | 正常终局后引擎在后台持续搜索 | 中（白耗 CPU/内存） |
| 6 | 复盘不随对局中止 | 开新局后旧复盘仍在跑，写回旧棋谱 | 中 |
| 7 | `evaluate()` 空结果 | 偶发拿不到评估（85 次里 2~4 次） | 中（报告缺格） |
| 8 | `toggleEval` 文案不实 | 提示「已释放 Worker」，实际只停了任务 | 低 |

### 20.2 #3 的排查过程（最值得记）

**现象**：`test_eval` 第 2 组偶发失败 —— 送杀局面 `6k1/5ppp/8/8/8/8/5PPP/4R1K1 w` 应报 `#1`，却报 `+1.0`。

**第一步排除**：单独重算该局面 15 次（timeout 400~1500ms）全部正确 → 不是「深度不够算不出 mate」。

**第二步定位**：抓这一路的原始引擎输出，拿到决定性证据：

```
info depth 10 ... score cp 89 ...     ← 上一个局面的分数
info depth 11 ... score cp 98 ...     ← 上一个局面的分数
readyok                                ← 我的 isready 应答，夹在中间
bestmove f2f3                          ← 上一个局面的收尾
```

新局面的 `go` 一行输出都没有，而 `current` 已经指向新 job —— 于是 `cp 98` 被当成了它的分数。

**根因有两层**：
1. `readyok` 与旧搜索的输出**交错**到达，不能当作「干净的边界」
2. `onLine` 的 score 分支不校验这条 `info` 属于哪个 job

**修法（三层防御，全部保留）**：
- `flush` 在静默期后发 `isready` 并**干等 `readyok`** 才放行（早期版本是发完就带着超时继续，等于没等）
- job 增加 `receiving` 标记，`go` 发出后才开接收窗口
- **depth 单调性**：正常搜索 depth 不减，`depth` 倒退的行判为旧搜索残余直接丢弃

第三层是关键 —— 实测前两层做到 80 次里仍漏 1 次，加上 depth 单调后 80/80、63/63 全过。

### 20.3 #7 的自愈机制

**现象**：连续评估时偶发返回空（`ms≈2580`、`infos` 只有 1~2 条、无 `bestmove`）。

**根因**：该 asm.js 构建在 `stop` 来得太密时会进入半死状态 —— 后续 `go` 只吐一两行就不再输出。**重启 Worker 后同一局面立刻能算**（实测验证）。

**修法**：`evaluate()` 拿到 review 空结果时重启 Worker 并重算一次，统计记 `stuck` / `recovered`。

```
[analysis] empty result → restarting worker (stuck #2)
```

**必须注意的陷阱**：`restart()` 内部也调 `settleAll()`，而 `settleAll()` 会推进取消序号。
第一版用「比 epoch」判断是否被取消，结果自愈把自己的重启误判成外部取消，直接返回 null —— 表现为「重启了但永远拿不到分」。

改为显式 `_cancelSeq`：`settleAll` 递增它，`restart()` 退出时**还原**它。

### 20.4 #1 / #2 / #5 / #6 的修法

| 缺陷 | 修法 |
|---|---|
| #1 悔棋不刷新 | `performUndo()` 末尾调 `Game.analyzePosition()` —— 它不经过 `applyMove`，得自己触发 |
| #2 浅缓存 | `REVIEW_MIN_DEPTH` 8 → 12。低于门槛一律重算 |
| #5 终局不停 | `finish()` 里也 `cancelAll()`。之前只有 `abort()` 停，正常将死走的是 `loop → finish` |
| #6 复盘不中止 | `Game.start()` / `Game.abort()` 都调 `Review.cancel()`；另加覆盖率兜底：评估完成率 <80% 时不写报告 |

### 20.5 #8 的语义修正

`toggleEval()` 原本文案说「已释放分析 Worker」，实际只 `cancelAll()` 停任务。现在真调 `Analysis.release()`（terminate + 清缓存 + 清回调），并新增 `ensure()` 支持惰性重建。

重新打开时必须**重新挂 `onScore`**（`release()` 清掉了它），否则评估条再也不会更新 —— 这个坑在实测中确认过。

### 20.6 性能副产物

排 #3 时顺带发现：`finish()` 无条件设 260ms 静默期，**自然跑完也被罚站**。

| 场景 | 改前 | 改后 |
|---|---|---|
| 自然完成（引擎自己出 bestmove） | +260ms | +0 |
| 被 stop 后 | +260ms | +260ms（不变） |
| 已出过分再被 stop | +340ms 宽限 +260ms | 立即结算（不等宽限） |

复盘 17 步从 22s 降到约 18s，长棋谱更明显。

### 20.7 排查方法论

这轮没有一上来读代码猜，而是**先写探测脚本打真实行为**：

1. 六个探测方向（缓存复用、迟到消息、悔棋刷新、终局停止、耗时构成、开关语义）
2. 每条都拿到可复现的数字，不采信「看起来应该没问题」
3. 修完用 A/B 对照验证（`noWait` vs `withWait`、`fails` 计数）
4. 压力复测：单次通过不算数，跑 3~5 轮看成功率

**教训**：`test_eval` 原先的「取消后 evaluate 结算为 null」断言过严 —— 取消到达时引擎可能已吐出一条 info，此时按设计用「部分结果」结算。断言应校验「必定结算」而非「必定为 null」。

### 20.8 新增测试（test_eval 第 10~12 组）

| 组 | 覆盖 |
|---|---|
| 10 连续评估稳定性 | 11 个连续局面零空结果；`stuck === recovered`；每步 <2600ms |
| 11 引擎卡死后自愈 | 注入一次空结果 → 自动重启并拿到分数；统计计数正确 |
| 12 取消不误触自愈 | 取消前有 job 在算；取消必定结算；`stuck` 不增加；引擎仍就绪 |

测试期间踩到的隔离问题：第 8 组 `toggleEval` 会 release Worker，导致第 9 组「取消时有 job 在跑」必假 —— 加 `await Analysis.ensure()` 复位。

---

## 21. v2.5 320px 五页面专项（P4）

### 21.1 先量再改

没有先读 CSS 猜哪里会坏，而是写了个体检脚本，在 320×720（DSR 2、移动端模拟）下逐页扫：

- 横向溢出（`document.scrollWidth - innerWidth`）
- 越界元素（`getBoundingClientRect` 超出视口左右）
- 触控目标（所有 `button / .px-btn / select / .chip / canvas[tabindex]` 是否 ≥32×32）
- 字号（可见文本是否 <10px）

**首轮结果**：

| 页面 | 溢出 | 越界元素 | 过小控件 |
|---|---|---|---|
| home | 0 | 0 | 0 |
| setup | 0 | 0 | 0 |
| characters | 0 | 0 | **19** |
| api | 0 | 0 | 0 |
| records | 0 | 0 | 1 |
| **replay** | **0** | **44** | 2 |

`replay` 的 `overflowX` 是 0 但**有 44 个元素越界** —— 这个组合说明内容整体被挤到了左边（`left:-96`），页面级滚动条被 `overflow` 吃掉了，实际是横向塌陷。光看 `overflowX` 会漏掉它。

### 21.2 回放页的两个独立缺陷

**① 棋盘尺寸永远 480，不跟随视口**

`UI.replayView` 在 `Replay.open()` 里首次 `new BoardView(canvas)` 时用的是构造函数默认值 `size = 480`。
`fitBoard()` 只在 `boot()` 和 `window resize` 时跑 —— 回放页是**之后才打开**的，没有任何人再调它。

修法：抽出 `Replay.boardSize()`，按视口与容器实测宽度算，`open()` 时立即调一次：

```js
boardSize() {
  const vw = window.innerWidth;
  const screenPad = vw <= 1000 ? 16 : 32;     // .screen 左右内边距
  const frameChrome = 32;                      // #boardFrameR padding 12×2 + border 4×2
  const avail = vw <= 900
    ? vw - screenPad - frameChrome
    : Math.min(wrap.clientWidth - 320 - 16, 760) - frameChrome;
  let s = clamp(avail, 200, 720);
  s = Math.min(s, Math.floor(window.innerHeight * 0.8));   // 纵向只作上限
  return Math.floor(s / 8) * 8;                             // 整数倍缩放
}
```

**纵向约束不能写成 `innerHeight - 210`。** 第一版这么写，720 高的屏上算出 510，
结果反而比宽度允许的 272 还大 —— 白占空间。改成 `innerHeight * 0.8` 只做上限，
页面本来就能滚，棋盘不该被压小。

**② 棋盘被挤到信息栏后面（最坑的一个）**

尺寸修好后截图，**棋盘整个不见了**。量出来在 `y = 846`，而屏幕只有 720。

根因：回放页复用了战斗页的 `.board-col` 类名，而战斗页在 `@media(max-width:1000px)` 里有
`.board-col{order:2}`（用来把棋盘排在两个立绘**中间**）。回放页是单列布局，`order:2`
就把它推到信息栏后面去了。

```css
/* 回放页显式复位 */
.replay-wrap .board-col{order:0}
.replay-wrap .replay-side{order:0}
```

**教训**：复用类名时，只看到了它给的「布局」，没看到它在媒体查询里的「排序语义」。
这类 bug 截图能一眼看出，但纯断言 `overflowX` 查不出来。

### 21.3 触控目标：19 个不达标的

`characters` 页最严重，19 个控件不足 32px：

| 元素 | 原尺寸 | 说明 |
|---|---|---|
| `.char-card .del`（删除） | **10×12** | 手指根本点不到 |
| `.chip`（风格标签） | 45×29 | 高度差 3px |
| `#btnPause` | 28×33 | 方形图标键，横向被压窄 |
| `#rpFirst/#rpPrev/#rpNext/#rpLast` | 30×33 | 步进按钮 |

统一在 `@media(max-width:380px)` 里抬到 32/34px，并给方形键（`II`）设 `min-width`。

**为什么取 32 而不是 44**：WCAG 2.5.5（AAA）要求 44×44，2.5.8（AA）只要求 24×24 且允许间距补偿。
本项目是像素风、信息密度优先，取 32 作为折中 —— 比 AA 严、比 AAA 松，且实测拇指可点。

### 21.4 9px 字号：一个 CSS 优先级陷阱

体检报出 9px 文本：`.mode-card .ico`（模式卡角标）、`.kbd`。

**第一次修失败**：在 380px 媒体查询里写 `.mode-card .ico{font-size:10px}`，不生效。

原因：`.mode-card .ico` 的原始定义在文件**更靠后**（约 493 行），同优先级下后写者胜 ——
媒体查询的「位置优势」只在同优先级内有效。

改成 `#app .mode-card .ico{...}` 提高特异性才压过。同理 `.kbd` 也是。

**另一个坑**：`#lblDelay` 等元素带**内联** `style="font-size:9px"`，
内联样式优先级高于任何选择器，媒体查询再怎么写都没用。只能删掉内联写法，
把尺寸交给 CSS 管（`02_body.html` 里 5 处）。

### 21.5 三断点验证

改完必须确认没伤到宽屏：

| 断点 | `.mode-card .ico` | 溢出 |
|---|---|---|
| 1440px | 9px（原样） | 0 |
| 390px | 9px（原样） | 0 |
| 320px | 10px（生效） | 0 |

### 21.6 验收套件 `test_narrow320.js`

六页 × 五项指标，外加桌面回归：

```
每页：页面激活 / 无横向溢出 / 无越界元素 / 触控 ≥32px / 无 <10px 小字
回放：棋盘按视口缩放 / 棋盘在首屏内 / 棋盘排在信息栏之前
战斗：无溢出 / 触控达标 / 评估条未越界
桌面：头像仍 64px / 按钮未被压扁 / 无溢出
```

**写测试时踩的坑**：把审计函数用 `${AUDIT.toString()}` 插进模板串再 `evaluate`，
会在 Node 侧先求值，拼出的源码容易带错。正确做法是作为参数传：

```js
await p.evaluate((auditFn) => {
  const audit = eval('(' + auditFn + ')')();
  ...
}, AUDIT.toString());
```

### 21.7 踩坑汇总

| 坑 | 现象 | 结论 |
|---|---|---|
| 只看 `overflowX` | 回放页报 0 溢出，实际 44 个元素越界（横向塌陷） | 必须同时查 `getBoundingClientRect` 越界 |
| `BoardView` 默认 480 | 回放棋盘不跟随视口 | 首次创建后立刻按视口 resize |
| 纵向约束用 `innerHeight-210` | 棋盘被算小 510→272 反而浪费 | 高度只作上限，宽度为主 |
| 复用 `.board-col` | `order:2` 把棋盘推到信息栏后，整屏不可见 | 复用类名要复查它在各断点的语义 |
| 媒体查询压不过后置规则 | 9px 改不动 | 提高选择器特异性（`#app` 前缀） |
| 内联 `font-size:9px` | 媒体查询完全无效 | 删内联，交给 CSS |
| 触控按钮只改 padding | `II` 这类方形键宽度仍不足 | 加 `min-width`，不能只靠 padding |

---

## 22. v2.6 按外部实测评估报告落地（交付形态 / 性能 / 安全）

当时的依据是一份独立实测评估报告（对象 v2.5.0，原文件已移除，其结论已完整吸收进本节）。
**我没有直接照单执行**，而是先把它的代码事实与实测结论逐条复核，再按落地顺序做。下面记录复核结果、实际改动、以及与该报告的偏差。

### 22.1 复核：哪些属实，哪些需要修正

| 报告主张 | 复核结论 |
|---|---|
| 3 处 `fetch` 构成 `file://` 阻碍 | ✅ 属实（`06_engine.js:38`、`06b_analysis.js:64`、`08b_openings.js:27`） |
| Stockfish 被下载两次 | ✅ 属实，实测两次 `fromCache:false`、各 1579948 字节 |
| `dirty` 从未被读取 | ✅ 属实，只在 5 处赋值，`_loop()` 无条件重绘 |
| 首页文案「真离线」与实现不符 | ✅ 属实（`02_body.html:52`） |
| API Key 存 localStorage | ✅ 属实，且混在 `apis` 整体里强制持久化 |
| Stockfish 源码含 `$&` | ✅ 属实（`"$&" in src == True`），JS 侧 `replace` 会踩替换模式 |
| `file://` 下能否跑 | ⚠️ **必须区分测试条件**：带 `--allow-file-access-from-files` 时 fetch 也能过，结论会失真。**不带特权参数**重测：`engineReady:false, engineFailed:true`，两个引擎都起不来 —— 文档的表格是对的 |

**结论：该报告的技术判断基本准确，可以直接作为行动依据。**

### 22.2 P0-2 引擎源码只拉一次

`06_engine.js` 新增 `engineSource()`，缓存 Promise（失败时清空以便重试）：

```js
let _sfSrcPromise = null;
function engineSource() {
  if (_sfSrcPromise) return _sfSrcPromise;
  _sfSrcPromise = (async () => {
    const inline = window.__SF_SRC || null;
    if (inline) return inline;                 // file:// 内联模式
    const r = await fetch(ENGINE_URL);         // HTTP 模式
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.text();
  })().catch((e) => { _sfSrcPromise = null; throw e; });
  return _sfSrcPromise;
}
```

`Analysis.init()` 改为复用同一个函数。**Blob URL 不复用** —— 两个 Worker 各自 `createObjectURL`，否则 terminate 一个会影响另一个。

实测：`stockfish.js` 请求数 **2 → 1**。

### 22.3 P0-1 双击即玩：做成两份产物

该报告建议「生成内联 JS + 普通 `<script src>`」，采纳。但**没有合并成一份 HTML**：

| 产物 | 用途 | 特点 |
|---|---|---|
| `index.html` | HTTP / 服务器托管 | 引擎走 fetch，首屏轻 |
| `offline.html` | 双击即玩 | 多挂两个内联数据脚本 |

理由：内联让 index 多背 1.9MB，HTTP 用户每次首屏都要解析；而文件模式下 fetch 必然失败。两份来自同一套分片，产物差异只有两个 `<script>` 标签。

`build.py` 生成：
- `assets/vendor/stockfish.inline.js` → `window.__SF_SRC`
- `data/openings.inline.js` → `window.OPENINGS_BOOK`

**避开了该报告警告的 `$&` 坑**：本项目在 Python 侧用 `json.dumps` 转义，天然安全（不是 `str.replace` 替换串）。若哪天改用 Node 生成，必须写 `replace(needle, () => str)`。

`check()` 增加了三项断言：offline.html 存在、引用全部分片、**内联脚本必须排在 `js/` 分片之前**（`engineSource` 初始化时就要读全局量）。

实测 `file://` 下：主引擎 ✅、分析引擎 ✅、完整对局 `e4 → d5` ✅、评估条出数 ✅、日志同步 ✅、零错误。

### 22.4 P0-3 密钥分层（该报告从 P2 提到 P0 伴生项，采纳）

新增 `Secret` 层，与普通数据 `LS` 分开：

| 状态 | 存储位置 |
|---|---|
| 默认 | `sessionStorage`（关标签页失效） |
| 勾选「记住密钥」 | `localStorage` |

关键设计：`saveApis()` 把 `key` 字段**从 apis 主体里摘掉**，单独存 `aca.v1.secret.key.<id>`。这样 `localStorage['aca.v1.apis']` 里不含明文。

`migrate()` 支持双向迁移。**第一版只写了「取消」方向**，导致勾上后旧密钥仍留在会话层，用户重开浏览器发现密钥没了 —— 已修成两个方向都处理。

实测 7 条断言全过：默认不记住 / 只进 session / apis 主体无明文 / 读出补回 / 勾选迁入 local / 取消回到 session / 清空清两层。

### 22.5 P1-1 渲染：底纹离屏 + 空闲停表

| 改动 | 效果 |
|---|---|
| 棋盘底纹预渲染到离屏 canvas | `draw()` 从 2.85–3.57ms → **0.19ms** |
| `dirty` 真正生效 + 连续 40 帧无事则停 rAF | 空闲时 CPU 归零 |

**这里踩了一个真实的坑，差点把走子功能搞坏：**

动画的推进（包括 `onDone` 里的 `resolve`）发生在 `draw()` 内部，而 `draw()` 只在 rAF 里跑。loop 一旦停表，`await animateMove()` 就永远不 resolve —— 表现是**棋盘看着动了，但 `Game.moves` 里没有这一步**（因为 `applyMove` 卡在 await 上）。

第一次探测到的是 `moves: []` 但 FEN 已经是 `4P3`，非常迷惑。

修法：`animateMove` / `spawnBurst` / `addFloater` / `flashSquares` 四个入口都调 `invalidate()`，保证 rAF 在跑。另外用「状态签名」兜底 —— `Game`/`BoardKeys`/回放都在直接给 `view.selected`、`lastMove` 等字段赋值，逐个加 `invalidate()` 容易漏，`_sig()` 比对能兜住。

测试里专门加了这条回归：「走子前确实处于停表状态」+「停表状态下走子仍被记录」。

### 22.6 P1-2 字体子集化（923KB → 131KB，省 86%）

新增 `src/subset_font.py`：

- 扫描**源码**里所有非 ASCII 字符（1299 个）
- 并入 **GB2312 一级汉字 3755 个**（按区位码规律枚举，无需外部词表）
- 合计 3926 字 → 131KB

为什么不能只按源码扫：角色台词由用户自由输入，AI 返回的台词也是运行时的 —— 只扫源码会漏，用户一输入未收录的字就看到豆腐块。GB2312 一级覆盖日常中文 99%+。

`--check` 模式验证覆盖，但**只检查「会渲染的字符」**：

第一版把注释也算进去，报出 8 个缺字（`≤ ≥ − ≈ ≫ ✓ ✕`）。查下去发现**源字体本来就没有这些字形**
（Fusion Pixel 不含数学符号区）。也就是说不是子集化丢的，而是项目一直在用系统字体回退显示它们。

处理分两半：
1. **实际渲染的**（删除键 `✕`、连接状态 `✓/✗`、复盘损失 `−`）换成字体支持的等价字符
   （`×` `·` `-`），保持像素风一致；
2. **仅注释里的**（`≤ ≥ ≈ ≫`）不管 —— 不渲染，报缺字是假警报。
所以 `scan_chars(include_comments=False)` 专用于校验。

`build.py` 的 `check()` 里也挂了这项：改了 UI 文案却忘了重跑 `subset-font` 时，构建会直接报
「字体子集缺 N 个字」并给出码位，不会等用户看到豆腐块才发现。

### 22.7 顺带清理（对应该报告「次要问题」）

| # | 项 | 处理 |
|---|---|---|
| 1 | `build.py` 硬编码 node 绝对路径 | 改为 `_find_node()`：PATH → `NODE_BIN`/`DSH_NODE` → 常见位置；找不到时**明确报「未执行」**而不是静默跳过 |
| 2 | 27 处硬编码 Chrome 路径 | 新增 `src/pw/testenv.js`，`CHROME_PATH` 环境变量 → 各平台常见位置 → puppeteer 缓存 |
| 3 | `src/pw/` 混杂临时脚本 | 先归入 `src/pw/legacy/`；后经全树引用检查确认零引用，于清理轮整体删除 |
| 4 | 内部日志常开 | 新增 `Debug.log()`，默认关；`?debug=1` 或 `localStorage['aca.debug']='1'` 开启。warn/error 不受影响 |

### 22.8 未做的项及理由

| 报告项 | 状态 | 理由 |
|---|---|---|
| P1-3 ESM + esbuild 迁移 | 未做 | 需引入构建链（node_modules、打包产物），会改变「零依赖、双击即玩」的交付特征。当前 17 分片 + build.py 已能满足，收益不足以抵消交付复杂度 |
| P1-4 抽 `UciWorker` 基类 | 未做 | 约 400 行重复确实存在，但两者抢占策略/结算语义差异不小（Engine 必结算 null、Analysis 要部分结果）。重构风险高于当前收益，且已有 12 套测试覆盖，暂不动 |
| 次要 9：复盘多 Worker 并行 | 未做 | 每个 Worker 多 1.5MB 源码 + 32MB Hash；且本轮已把每步耗时从 ~1334ms 降到 ~900ms，串行 120 手约 108s，可接受 |
| 次要 11：换 WASM Stockfish | 未做 | 改动最大、收益最高，属于独立决策项（要换引擎产物 + 重新校准难度预算） |
| 次要 5：拆 `Game` 967 行 | 未做 | 纯重构，无功能收益 |
| 次要 10：全量数据导出/导入 | 未做 | 新功能而非优化项 |

### 22.9 交付形态决策（回应该报告 §4 P1-2 的提醒）

该报告提醒「两条交付路径的优化集不同，先决定主打哪条」。本项目**两条都保留**：

- 主打分发/单机玩 → `offline.html`
- 主打网站托管 → `index.html`

因此两类优化都做了（内联 + 子集化 + 共享源码），但没有做 gzip/brotli —— 那需要服务端配置，超出「纯静态交付」范围。

### 22.10 新增测试 `test_delivery.js`

四块 26 条断言：

```
1. 引擎源码只拉一次（请求数 / Worker 独立性 / Promise 缓存）
2. offline.html 在 file:// 下可用（产物存在 / 双引擎就绪 / 完整对局 / 无失败请求）
3. 密钥分层（7 条，见 §22.4）
4. 渲染优化（底纹缓存 / draw<1ms / 空闲停表 / invalidate 唤醒 / 动画完成 / 停表下走子仍记录）
```

### 22.11 踩坑

| 坑 | 现象 | 结论 |
|---|---|---|
| 用 `--allow-file-access-from-files` 测 file:// | fetch 居然能过，结论完全失真 | 测 `file://` 限制**绝不能带特权参数** |
| `json.dumps` vs JS `replace` | 后者遇 `$&` 会静默注入匹配串 | Python 侧生成天然安全；Node 侧必须传函数 |
| 空闲停表 + 动画 | 棋盘动了但 `moves` 没记录（await 永久挂起） | 所有 `anims` 入口必须 `invalidate()` |
| 内联脚本位置 | 放 `js/` 之后就取不到全局量 | `engineSource` 在 init 时读，内联必须在前 |
| `migrate()` 单向 | 勾「记住」后密钥仍只在会话层 | 两个方向都要搬 |
| 直接改 `js/` 验证 | 被 `build.py` 覆盖，白干 | 永远改 `src/parts/` |
| 字体子集校验把注释算进去 | 报 8 个「缺字」，其实是源字体没有数学符号 | 校验只看渲染字符（剔除注释） |
| 用源字体没有的符号 | `✓ ✗ ✕ −` 走系统回退，字体风格不一致 | 换成字体支持的 `· × -` |

---

## 23. v2.7 交互回归修复（第三方报告的 4 个 H 级 bug）

第三方报告指出的 4 个高危 bug，**其中 3 个是我上一轮「空闲停表」优化引入的**。全部活体复现后修复。

### 23.1 复现结果（先证伪再动手）

| # | 报告主张 | 复现数据 | 判定 |
|---|---|---|---|
| 1 | 悔棋/提和 AI 走完永久置灰 | `canUse:true, busy:false` 但 `disabled:true`；手动刷新后解禁 | ✅ 成立 |
| 2 | 回放慢速步进画面冻结 | 连续 3 次步进 canvas 像素签名完全相同，`loopRunning:false` | ✅ 成立 |
| 3 | 翻转只翻标签不翻棋子 | `a2` 应在 (622,124)，实际停在 (42,540)，差 580px | ✅ 成立 |
| 4 | 动画中 resize 吞掉棋步 | FEN 已 `4P3`，但 `moves:0`、`busy:true` 永久卡住 | ✅ 成立 |

### 23.2 逐项修复

**#1 按钮刷新缺失**

`UI.addLog()` 是唯一刷新点，但它必然发生在 `busy=true` 期间（busy 到 `applyMove` 末尾才清），算出来永远是「禁用」。之后 `waitHuman()` / `setTurn()` 都不碰按钮。

修法：`applyMove` 结尾 `busy=false` 之后补 `UI.updateControlState()`；另在 `waitHuman()` 建立时也刷一次（单步模式、悔棋恢复这些路径不经过 applyMove）。

**#2 渲染唤醒协议**

空表优化后 rAF 会停，而 `setPosition()` 只置 `dirty=true` —— 全库零外部 `invalidate()` 调用，dirty 和签名兜底都没人消费。

关键发现：签名兜底也不够用。`_sig()` 只比对棋子**数量**，同一兵种位置变化检测不到 —— 回放里「白兵从 e2 到 e4」数量不变，签名不变，依然不重绘。

修法：`setPosition` 末尾无条件 `invalidate()`；`resize` 也补上。

**#3 翻转**

`Game.view.flipped = x` 只改标志，而棋子的 `p.x/p.y` 是 `setPosition` 时按旧坐标系缓存的。新增 `setFlipped()` 统一入口：改标志 + 按新坐标系重摆所有棋子 + 唤醒渲染。两处赋值点（开局、按钮）都改走它。

**#4 resize 清 anims**

`this.anims = []` 直接丢弃在飞动画，而动画 Promise 在 `onDone` 里 resolve —— 被移除就永远不 resolve，`await animateMove()` 的 `applyMove` 永久挂起。

修法：resize 时**先结算**（调每个动画的 `onDone`，让它落到终点并 resolve），再清队列、重排棋子。注意不能在外面重复设置坐标 —— `onDone` 已包含易位同步与升变逻辑，重复调用会让升变的 `spawnBurst` 跑两次。

### 23.3 静态审查项的处置

| 报告项 | 处理 |
|---|---|
| XSS：`mv.source` / `white.api` 未转义进 innerHTML | ✅ 修复（两处，`08_wire.js` + `08c_review.js` 的 `line()`），并加注入测试 |
| `EndpointGuard` panel 缺失时 pending 泄漏 | ✅ 修复：pending 只在「真要弹框」时占位 |
| Worker Blob URL 从不 revoke | ✅ 修复：新增 `revokeBlob()`，restart/release 时调用 |
| 新局不 `Analysis.release()` | ✅ 修复：开局时若评估开关关着，主动释放 |
| API 双层重试放大（4×15s） | ✅ 修复：外层循环传 `retries:0`，并让不可重试类错误直接 break |
| `saveApis` 忽略 `Secret.set` 失败 | ✅ 修复：收集失败项，UI 明确提示「密钥未能写入」 |
| `Analysis.onScore` 恒真守卫 | ✅ 修复：捕获开局 token 再比 |
| `setBubble` 的 text 是死参数 | ✅ 修复：真正写入气泡（开局台词终于显示） |
| `classifyApiError` timeout 正则匹配不到中文 | ✅ 修复：补 `TimeoutError` 名字与中文「超时」 |
| `isAbortError` 宽匹配误吞真实错误 | ✅ 修复：只认 AbortError / code 20 / `run cancelled` |
| `build.py` 缺文件时 traceback | ✅ 修复：`read_text` 前先判存在，进错误清单 |
| `--check` 不校验 js/ 同步 | ✅ 修复：逐字节比对，并检查 offline.html 是否比源分片旧 |
| `resumeAfterUndo` 与主循环并发 | ⚠️ 未改（见 §23.5） |
| 其他低危（Esc 嵌套弹窗、光标残影、O(n²) 重放） | ⚠️ 未改（收益小、风险在别处） |

### 23.4 测试体系的三个系统性缺口（报告的核心洞察）

报告说得很准：旧测试对最严重的 4 个 bug **全部失明**，原因是——

1. **手动补状态掩盖接线缺失**：`test_undodraw.js` 在断言前自己调 `updateControlState()`，把「产品没刷新」这件事擦掉了
2. **只断言禁用态，不断言启用态**：「不该点的时候是灰的」永远成立，即使它永远灰着
3. **无慢交互场景**：回放步进都 <1s、不在动画期间 resize

新增 `test_interaction.js` 针对这三点重写：

| 组 | 断言 |
|---|---|
| 1 | **启用态**：AI 走完后按钮必须亮（不手动刷新）；AI 思考时禁用的反向断言（busy 太快则跳过，不制造假失败）；回到人类回合必须重新亮 |
| 2 | 慢速步进 1.4s 间隔 × 3 次，相邻 canvas 像素签名必须不同；跳回前面也要重绘 |
| 3 | 翻转后棋子坐标误差 <2px，翻回来仍对齐 |
| 4 | 动画中 resize 后棋步仍记录、busy 复位、队列清空、后续仍可落子 |
| 5 | 开局气泡有文本 |
| 6 | 注入脚本不执行、原始标签不渲染、危险文本被转义 |

### 23.5 未修的项及权衡

**`resumeAfterUndo` 与主循环并发**：报告说得对——它另起一条 async 链调 `doTurn`，与主循环共用单槽 `pendingHuman`，理论上会互相覆盖。

但改它属于**重构游戏主循环**：需要把「等待人类落子」从两处合成一处状态机。当前 13 套测试（含悔棋专套件）全绿，说明实际触发条件比理论窄。在缺少稳定复现的情况下重写主循环，风险大于收益。**记录在案，等有真实复现再做。**

其余低危项（嵌套弹窗 Esc、光标残影、回放 O(n²)、终局总结串行）同理：影响面小、改动点分散，优先级低于已修的 H 级项。

### 23.6 附带修掉的一个既有隐患：readyok 之后管道未排空

修 #1~#4 时全量测试偶发红，断言是「将死局面识别为 mate」，返回的却是 `+1.0`
（初始局面的分数）。抓到原始行流：

```
info depth 11 ... score cp 98     ← 上一个 job 的残留
readyok                            ← 握手应答
bestmove f2f3                      ← 上一个 job 的收尾，还在管道里
```

**`readyok` 只保证「已处理完此前发出的命令」，不保证「输出已排空」。**
此刻立刻发 `go`，新搜索的 info 会排在那条 `bestmove` 之后 ——
结果 `bestmove` 被当成本 job 的结束信号，而它一分未得，只能拿残留分结算。

修法：`readyok` 之后再让管道静默 80ms 才放行 `go`。
实测 30 轮 MATCH 全部正确（此前偶发失败）。

这是 §20.2 那个问题的**同族变体**：那次是「残留 info 污染分数」，
这次是「残留 bestmove 提前结束搜索」。同一类竞态的两种表现。

### 23.7 测试稳定性的两处修正

| 问题 | 原因 | 修法 |
|---|---|---|
| `test_eval` 偶发 `busy=false queue=2` | 断言固定等 300ms，而「入队→真正开搜」要过静默期 + isready 握手 + 队列取出，可能到 1s | 改为轮询「job 真的开始跑」，最多 3s |
| `test_eval` 整套超时 | 加了稳定性压测后单套件跑满 180s | 超时提到 300s |

### 23.8 踩坑

| 坑 | 现象 | 结论 |
|---|---|---|
| 签名兜底只比数量 | 白兵 e2→e4 数量不变，画面不动 | 位置变化必须靠显式 `invalidate()` |
| 在 resize 里直接清 `anims` | 动画 Promise 永不 resolve，applyMove 挂起 | 先结算 `onDone` 再清队列 |
| 在外层重复设置动画终点 | 升变 `spawnBurst` 跑两次 | `onDone` 已含落地逻辑，只调它 |
| 测试自己调 `updateControlState()` | 接线缺失被掩盖，全绿 | 断言前不补状态，让产品代码自己走到位 |
| 只测禁用态 | 永久置灰也能通过 | 必须同时断言「该亮时亮」 |
| `isAbortError` 宽匹配 | `"request aborted by upstream"` 被当取消吞掉 | 只认明确信号 |
| `readyok` 后立刻发 `go` | 上一个 job 的 bestmove 还在管道，新搜索被提前结束 | 握手后再静默 80ms |
| 测试固定等待后断言异步状态 | `busy=false queue=2` 偶发红 | 改为轮询目标条件 + 上限 |

---

## 24. v2.8 棋盘朝向规则：「玩家1永远在下方」

### 24.1 需求与评估

用户提出：**永远以玩家1视角为主** —— 玩家1执白则白在下，执黑则黑在下。

评估：方向正确，PVE 下其实已经是现状（执黑会自动翻转）。但现行实现有两个漏洞，所以在把它立成规则前先探测确认。

### 24.2 探测出的两个真缺陷

**缺陷 1：手动翻转会泄漏到下一局**

```
第一局 执白 → 手动点「翻转」→ 棋盘翻了
        同时写入 settings.boardFlip = true（持久化！）
第二局 执白 → 开局仍是 flipped: true   ← 默认视角被污染
```

根因：`boardFlip` 既是"默认朝向"又是"手动翻转状态"，混在一个持久字段里。

**缺陷 2：PVP 与 AI vs AI 的朝向全靠上一个泄漏值**

去掉泄漏后再测，两种模式都是 `flipped:false`（白在下）—— 但这是**碰巧**对，
因为代码里只有 `mode === 'pve'` 一条判断，其它模式默认 false，没有任何规则约束。

### 24.3 规则化

新增唯一真源（`08_wire.js · 21b`）：

| 模式 | 玩家1是谁 | 朝向 |
|---|---|---|
| PVE | 人类玩家 | 执白→白在下；执黑→黑在下 |
| PVP | 白方（先手，本地双人约定） | 白在下 |
| AI vs AI | 没有人类，按观众默认 | 白在下 |

```js
function playerOneColor(mode, side) {
  if (mode === 'pve') return side === 'b' ? 'b' : 'w';
  return 'w';       // PVP / AI vs AI：先手在下方
}
function autoFlipFor(mode, side, override) {
  if (override != null) return !!override;   // 本局临时覆盖优先
  return playerOneColor(mode, side) === 'b';
}
```

### 24.4 手动翻转降级为「本局临时覆盖」

| | 改前 | 改后 |
|---|---|---|
| 存储位置 | `settings.boardFlip`（localStorage，永久） | `Game.flipOverride`（内存，开局清空） |
| 生命周期 | 跨会话、跨局 | 仅本局 |
| 再点一次 | 又翻回去并再次写盘 | 清掉覆盖，回到规则默认 |
| 提示 | 无 | toast「棋盘：默认视角 / 已翻转（仅本局）」 |

`settings.boardFlip` 保留字段但标注废弃（兼容老存档），读取处已全部移除。

### 24.5 验证

四种情形的实际朝向，用**白王/黑王的屏幕 y 坐标**判定（不看标志位，避免自证）：

| 模式 | 白在下 | 黑在下 | 评估条同向 | 规则值 |
|---|---|---|---|---|
| PVE 执白 | ✅ | — | ✅ | `w` |
| PVE 执黑 | — | ✅ | ✅ | `b` |
| PVP | ✅ | — | ✅ | `w` |
| AI vs AI | ✅ | — | ✅ | `w` |

翻转按钮：`override: null → true → null`，`settings.boardFlip` 全程 `false`。
泄漏测试：第一局翻过，第二局 `flipped:false`、`override:null`、白王在下。

### 24.6 新增测试 `test_flip.js`

8 组 24 条断言：

```
1 PVE 执白      白王在下 / 黑王在上 / 未翻转 / 评估条同向
2 PVE 执黑      黑王在下 / 白王在上 / 已翻转 / 评估条同向
3 PVP           白王在下 / 未翻转
4 AI vs AI      白王在下 / 未翻转
5 手动翻转      不写持久设置 / 评估条跟随 / 再点回默认
6 泄漏回归      第二局回默认朝向 / 覆盖已清空 / 白王在下
7 坐标重算      翻转后棋子误差 <2px（回归 2.7 的 bug）
8 错误          无 JS 运行时错误
```

### 24.7 踩坑

| 坑 | 现象 | 结论 |
|---|---|---|
| 把默认朝向和手动翻转存同一个字段 | 点一次翻转，以后每局都被翻 | 默认由规则算，手动是临时覆盖 |
| 只判断 `mode === 'pve'` | PVP/AIvsAI 的朝向无规则约束，靠默认 false 碰巧对 | 朝向必须显式对每种模式定义 |
| 用 `flipped` 标志验证朝向 | 标志对了不代表棋子坐标对了（2.7 就栽在这） | 断言用棋子的实际屏幕坐标 |
| 评估条独立记 `flipped` | 棋盘翻了评估条没翻 | 同一处设置两边，且都进测试 |

---

## 25. v2.9 仓库清理（删除过时/无引用内容）

### 25.1 原则

只删「**零引用 + 可重建或纯历史**」的东西。判定顺序：

1. 全树 grep 引用（排除 `node_modules`、排除文件自身定义行）
2. 对疑似核心资产做**哈希比对**，确认是否与在用文件重复
3. 删除前打印 `GetFullPath` 绝对路径 + 体积，确认落在项目根内
4. 删完 `npm run build`，逐文件比对产物哈希 —— **产物零变化**才算安全
5. `npm run check` + `npm test` 全绿

### 25.2 删除清单（7 项，约 1.73 MB）

| 路径 | 体积 | 判定依据 |
|---|---|---|
| `src/__pycache__/` | 10.8 KB | Python 字节码缓存，随时重生成 |
| `src/zzfx.js` | 10.1 KB | 零引用。音效早已内联进 `src/parts/04_render.js`（`zzfx()` 函数 + `ZzFX-style micro synth` 注释），此文件是早期独立版残留 |
| `src/stockfish.js` | 1.58 MB | 与 `assets/vendor/stockfish.js` **哈希完全相同**（`723FDA70…`），build 只读后者 |
| `src/chess.js` | 47.6 KB | 与 `assets/vendor/chess.js` **哈希完全相同**（`1A6803B7…`） |
| `src/parts/index.shell.html` | 29.6 KB | 早期独立 shell 模板，`build.py:264` 明确记录「已废弃」，构建改由 `01_head.html` + `02_body.html` 组装 |
| `work/`（4 个脚本） | 5.8 KB | `diagnose.js`/`filetest.js`/`trace.js`/`trace2.js`，一次性排查脚本，零引用 |
| `src/pw/legacy/`（13 个脚本） | 22.0 KB | `dbg_*`/`repro`/`test9`/`find404` 等历史调试脚本，零引用（唯一「命中」出现在 `build.py` 的文档注释里） |

### 25.3 字体瘦身（4.53 MB）

`src/fonts/fusion/` 原有 7 个语言变体，`subset_font.py` 的 `CANDIDATES` 只用到
`zh_hans`（首选）与 `zh_hant`（兜底）。删除未被任何脚本/样式引用的：

`ja` / `ko` / `latin` / `zh_hk` / `zh_tw`（各约 0.93 MB，合计 **4.53 MB**）。

删后 `python src/subset_font.py --check` 仍报「缺字 0 个」—— 证明简体文案的全部字形都来自 zh_hans。
同时删掉 `subset_font.py` 里定义后从未使用的 `SRC_FONT` 常量，并把注释改为「简体优先、繁体兜底」。

### 25.4 顺手补上的一处漏网

`src/pw/test_ui_final.js`（PGN 导入 UI 流程，22 条断言）一直是**孤儿**：

- 不在 `run-tests.js` 的 `SUITES` 里，`npm test` 从不跑它
- 文件里用了 `chromePath()` 却没 `require('./testenv')` —— 一旦单独运行必然 `ReferenceError`

修法：补 `const { chromePath } = require('./testenv');`，并把它注册为第 15 套件。
**验证方式**：先在未注册状态下单跑一次确认全 PASS，再入册，避免把坏测试塞进 CI。

### 25.5 验证

```
npm run check      → OK（17 模块，产物齐全）
npm run build      → 产物逐文件哈希比对：零变化（证明删的都是真死代码）
subset_font --check→ 缺字 0 个
npm test           → 15 套件全 PASS
```

目录体积：源码区 `src/` 39.45 MB → **34.9 MB**（主要是字体与重复 vendor）。

### 25.6 踩坑

| 坑 | 现象 | 结论 |
|---|---|---|
| 拿「文件名像源码」当依据 | `src/stockfish.js`、`src/chess.js` 看着像真源，实为 vendor 的重复拷贝 | 先哈希比对，再决定 |
| 只 grep 文件名不看上下文 | `index.shell.html` 在 `build.py` 有「命中」，但那条是「已废弃」的注释 | 命中要看是代码还是注释 |
| 删完不重建就宣布完成 | 可能删掉运行期仍被读取的文件（如字体源） | 重建 + 哈希比对是唯一硬证据 |
| 孤儿测试长期不跑 | 真坏了也没人知道（`test_ui_final.js` 缺 import 且未注册） | 清理时顺手把孤儿测试修好并入册 |
### 25.7 顺带修掉一个长期潜伏的测试竞态

解决清理轮之前就存在的「偶发 1 个套件失败」：`test_interaction.js` 第 4 组
（落子动画期间 resize）在 3 连跑中大约每 3 次挂 1 次，失败断言恒为
`busy 已复位（没卡死）` 与 `动画队列已清空`。

根因不在产品代码，在**测试的采样时机**：

```js
for (...) { if (Game.moves.length > before) break; }   // 一 push 就跳出
await new Promise(r => setTimeout(r, 300));            // 固定窗口
return { busy: Game.busy, anims: v.anims.length, ... } // 此刻断言
```

`moves.push()` 发生在 `applyMove()` 的中段（`06_game.js:793`），后面还有台词打字机
`await UI.typeBubble(...)`、将军演出等；而本用例是 PVE 执白、难度 1、延迟 0 ——
人类那步刚落地，AI 黑方**立刻开始自己那一步**，`busy` 又变 true、`anims` 又有值。
于是固定 300ms 窗口正好落在 AI 走子中途，断言必然随机失败。

修法：把「固定等待」换成「轮询到静默点」再断言 ——

```js
let settled = false;
for (let i = 0; i < 100; i++) {
  await new Promise(r => setTimeout(r, 150));
  if (!Game.busy && v.anims.length === 0 && Game.moves.length > before) { settled = true; break; }
}
```

断言随之改成三条，语义更准：`落子后回到静默点（没卡死）` / `静默时 busy 已复位` /
`静默时动画队列已清空`，并输出收敛耗时。连跑 3 次全绿。

教训：**断言「过一会儿没卡死」，不能用一个固定时长去赌，必须显式等到安静状态再采样**；
固定时长窗口在「下一步会自动开始」的流程里天然有竞态。

---

## 26. v2.10 复盘判级缺陷：评估空值被静默当成 good

### 26.1 症状

`npm test` 连跑 3 次，第 1 次挂 `复盘报告`，第 2、3 次全绿 —— 典型的「偶发」。
失败断言恒为这一组：

```
FAIL  f3+g4 被判为失误 | f3:inaccuracy e5:good g4:good Qh4#:good
FAIL  关键失误列表非空 | 0 条
FAIL  点条目跳到该步 | idx=null
FAIL  行上有分级样式
```

注意 `Qh4#:good`：这盘棋是 `1.f3 e5 2.g4 Qh4#`，g4 送将死，Qh4# 是将死
—— 两步都判成 good，说明**判级整条链没有生效**，不是阈值偏了。

### 26.2 根因

顺序读 `Review.start()` 的实现即可定位，问题在 `Analysis.evaluate()` 的返回值：

| 层 | 行为 |
|---|---|
| `06b_analysis.js` | `evaluate()` 在 watchdog 超时 / `stop` 残影 / 被 live 评估抢占时返回 `null` |
| `08c_review.js` `cpOf(res)` | `!res || !res.score` → 返回 `null` |
| `08c_review.js` `build()` | `before/after` 任一为 `null` 时，**`tag` 保持初始值 `good`**，`loss` 记 `null` |
| `ReviewUI.render` | `-${m.loss || 0}cp` 把 `null` 显示成 `-0cp`，看起来完全正常 |

于是「引擎没给出评估」被伪装成「这步下得很好」，且报告照常写入棋谱与
`localStorage`。偶发性来自 26.2 第一行 —— 评估本身偶发返回空（评估子系统
早已有单点 ~2% 的空返回率，v2.4 章节记录过）。

**这是产品缺陷，不是测试竞态。** 测试只是恰好抽到了空返回。

### 26.3 修法（四层，缺一层都还会复发）

1. **默认值改成 unknown**：`REVIEW_TAGS` 新增 `unknown`（`—` / 未评估 / `#7d74a6`），
   `build()` 里 `let tag = REVIEW_TAGS.unknown`，只有 `before`、`after` 都非空才
   计算 loss 并判级。
2. **显式记账**：`build()` 收集 `incomplete: [ply...]` 与 `incompleteCount`，
   随报告一起返回、随棋谱一起落盘。
3. **单点重试**：`start()` 里某局面拿到 `null` 时，用 `timeout = REVIEW_MS * 2`
   补算一次；仍失败才计入 incomplete。这一条把「偶发空返回」压到几乎为零。
4. **覆盖率规则重写**：旧规则 `complete < pos.length * 0.8` 是**帮凶** ——
   4 个局面缺 1 个正好 80%，恰好放过「缺的那一个是关键局面」的情况。
   新规则：过半缺评估才拒绝出报告（`complete * 2 < pos.length`），
   少数缺评估照常出报告，但摘要里必须打印「注意：N 步未评估，判级不可信」。

### 26.4 UI 配套

- 行内损失：`m.loss == null ? '未评估' : '-' + m.loss + 'cp'`（不再出现 `-0cp`）
- 行 title：`cpBefore/cpAfter` 为 `null` 时显示 `—`
- 摘要多一行橙色警示：`注意：N 步未评估（第 x、y 步），判级不可信`
- 回放步进标注：`unknown` 步显示「这步未评估（判级不可用）」
- CSS 补 `.rv-row.unknown` / `.rv-now.unknown`（灰紫 + 降透明度，与 good 的绿明确区分）

### 26.5 回归测试

`test_review.js` 新增第 2b 组「缺评估不得静默判 good」：
构造一盘 `f3 e5 g4 Qh4#`，只给前 3 个局面评估（后 2 个为 `null`），断言

```
OK  缺评估的步标为 unknown 而非 good | f3:good e5:good g4:unknown Qh4#:unknown
OK  incomplete 记录缺失步号 | 3,4
OK  incompleteCount 与之一致
OK  unknown 不进关键失误列表
```

这组断言纯函数执行，不依赖引擎，能把 26.2 那条链永久钉死。

### 26.6 踩坑

| 坑 | 现象 | 结论 |
|---|---|---|
| 把偶发失败当测试竞态 | 3 连跑挂 1 次，第 2 次就绿 | 先看失败断言的内容是否可能来自产品缺陷；「值不对」比「时序不对」更值得先查 |
| `m.loss || 0` 这类写法 | `null` 被静默转成 `0` | 展示层用 `??`/显式判 `null`，别用 `||` 兜数字 |
| 覆盖率当质量门 | 80% 阈值恰好放行最坏情况 | 阈值门只能挡「整体崩」，不能替代「逐项标注未知」 |
| 界面文案想用 `⚠` 做警示 | 像素字体里 emoji 渲染成方块（同 §13 坑表「emoji 在像素字体下变方块」） | 子集字体只含 GB2312 一级 + ASCII，警示文案一律写中文「注意：」 |

---

## 27. v2.11 合并外部副本：ECO 开局库 en-passant 键（P0 真缺陷）

### 27.1 起因

用户在 `E:\临时解压\chess-arena` 有一个副本，说「相比工作路径有更新」。逐文件 SHA256 比对后：两树各 89 个文件（排除 `node_modules` / `__pycache__` / `.git`），**8 个内容不同 + 1 个 E 独有**（`EVALUATION.md` v2.10.0 版），其余哈希全同。

结论：**E 不是超集，是分叉副本**——多 1 个真 P0 修复，但同时回退了 3 个元数据文件（`package.json` 缺 license/repository/keywords、`.gitignore` 只有 10 行、`CONTEXT.md` 目录树缺 LICENSE/README/docs 三行）。作者拿的是我补 GitHub 元数据之前的版本。

### 27.2 缺陷：`keyOf()` 多算了 FEN 第 4 段

```js
/* 修复前（v2.0 ~ v2.10） */
keyOf(fen) { return String(fen || '').split(' ').slice(0, 4).join(' '); }
this._byFen = new Map(Object.entries(json.pos));   // 原样用 4 段键
```

FEN 第 4 段是**吃过路兵标记**，只是「上一步是不是双步兵」的临时标记，同一棋盘局面在 ECO 里是同一条。而 `data/openings.json` 的 3606 条里：

| 第 4 段取值 | 条数 |
|---|---|
| `-` | 3592 |
| `f6` | 4 |
| `e6` | 3 |
| `b6` | 2 |
| `e3` / `c3` / `g3` / `h3` | 各 1 |

非 `-` 共 14 条。于是 `1.e4`（chess.js 给出 `... w KQkq e3`，因为 e2e4 是双步兵）永远匹配不上 `... w KQkq -`。

**实测（两边逻辑直接跑同一份 `data/openings.json`）**：

| 输入 | 修复前 | 修复后 |
|---|---|---|
| `e4` | null | King's Pawn Game |
| `e4 c5` | null | Sicilian Defense |
| `e4 e5` | null | King's Pawn Game |
| `e4 d5` | null | Scandinavian Defense |
| `d4` | null | Queen's Pawn Game |
| `c4` | null | English Opening |
| `Nf3` | Zukertort Opening | Zukertort Opening |

只有「非双步兵开局」（如 `1.Nf3`）碰巧正确。⇒ **最主流的一批开局全部查不到，界面长期停在「开局阶段」**；`suggest()` 的提示质量同受影响。

### 27.3 修法：3 段键 + 两趟归一化索引

```js
keyOf(fen) { return String(fen || '').split(' ').slice(0, 3).join(' '); }

_index(json) {
  const entries = Object.entries(json.pos);
  const m = new Map();
  // 第一趟：只收 ep 为 '-' 的规范条目
  for (const [k, v] of entries) if (k.split(' ')[3] === '-') m.set(this.keyOf(k), v);
  // 第二趟：补空（带 ep 的不得覆盖规范的）
  for (const [k, v] of entries) { const k3 = this.keyOf(k); if (!m.has(k3)) m.set(k3, v); }
  return m;
}
```

归一化会让两条原始键撞车（`... w KQkq e6` 与 `... w KQkq -` 指向同一局面）。实测只有 1 组冲突且名称不同，所以**必须分两趟**：第一趟只收规范条目，第二趟才补空。若一次性 `set`，带 ep 的条目可能覆盖掉规范条目，等于换了个方式出错。

### 27.4 配套改动（均采纳 E 版）

1. `src/pw/test_openings.js` 第 3 节断言按新语义重写：`1.e4` → `/King's Pawn/`、`1.e4 c5` → `/Sicilian/`、部分收录时回退到最近命名局面。旧断言 `early.name === '开局阶段' && early.pending === true` 记录的是 bug 行为，删除。
2. `src/build.py` `check()` 新增防回归：`assets/fonts` 下存在**未被 `css/main.css` 引用的 woff2** 即报错。背景：曾有 945KB 完整字库与 `src/fonts` 源文件 MD5 相同、长期躺在分发目录。
3. `src/subset_font.py`：删掉指向已删副本 `assets/fonts/fusion-pixel-12px-zh.woff2` 的第三个候选源（CANDIDATES 只剩 `src/fonts/fusion/` 下 zh_hans / zh_hant 两个）。
4. `CONTEXT.md` §二重写为「两种运行方式，以及为什么会有两份外壳」，补 `file://` 下的真实可用矩阵。
5. `package.json` `_note` 改为双模式说明（license/repository/keywords 保持我的版本）。
6. 新增 `EVALUATION.md`（v2.10.0 版，148 行）——**注意与 v2.6 时删掉的 v2.5.0 旧报告不是同一份**，这份是新的外部评估。

### 27.5 `file://` 可用性矩阵（CONTEXT §二 实测结论）

| 能力 | `file://` 下 |
|---|---|
| `fetch` 相对路径 / `file://` 绝对 | Failed to fetch |
| XHR 同步 | 拒绝 |
| ESM / `new Worker(相对路径)` | 被拦 |
| 经典 `<script src>` | 可用（同目录相对路径也认） |
| 内联脚本 → Blob Worker | 可用 |
| CSS 外链 woff2 | 加载成功 |
| localStorage | 可用（但所有 `file://` 文档共享同一个 opaque origin） |

⇒ 早期「`file://` 读不了任何本地资源」的结论**只对 `fetch` 成立**，这才是 `offline.html` 可行的原理。

### 27.6 流程：保留副本 → 执行 → 测试 → 删副本

用户要求「保留副本并执行，测试无bug后删除副本」。执行顺序：

1. `robocopy /E` 备份到 `chess-arena.backup-20261101-090052`（排除 `node_modules`/`__pycache__`/`.git`），89 文件 / 9.23 MB，路径写入 `$env:TEMP\chess-arena-backup-path.txt`。
2. 复制 E 的 6 个文件 + 删死字体，同时保住 D 的 3 处元数据。
3. `npm run build`（同步 `js/`）+ `npm run check`（OK 17 模块）。
4. `npm test` 全量 15 套件 → 全 PASS。
5. 全绿后才删备份目录。

### 27.7 踩坑

| 坑 | 现象 | 结论 |
|---|---|---|
| 只看「哪边更新/文件更多」 | E 有 1 个真修复，但回退了 3 个元数据文件 | 分叉副本要逐文件比哈希，并逐项判断「这是改进还是回退」，不能整目录覆盖 |
| 只改 `src/parts` 就以为完事 | `js/` 是构建产物 | `npm run build` 必须跑；`offline.html` 通过 `<script src="./js/08b_openings.js">` 外部引用，不内联该模块，所以只有一份 `keyOf` |
| 用「最新覆盖最旧」合并 | `package.json` 会丢 license/repository | 合并以「能力集合」为准：新修复进来，元数据保住 |
| 测试断言记录 bug 行为 | 旧断言断言「开局阶段 + pending」 | 修复后必须同步改断言，否则测试在保护错误行为 |
