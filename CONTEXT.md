# AI CHESS ARENA · 上下文交接卡（v2.0 多文件架构）

> 后续会话读这一份即可接手。设计决策见 `GDD.md`，许可见 `THIRD_PARTY_NOTICES.md`。

---

## 一、这是什么

像素风国际象棋，AI 角色擂台战。棋盘是舞台，AI 是角色，棋步是剧情。

- **运行方式**：双击 `run.bat`（HTTP 模式）或直接双击 **`offline.html`**（完全离线，无需服务器）
- **当前版本**：v2.11.0
- **架构**：多文件 2B（HTTP） + 单文件内联产物（offline.html）

---

## 二、两种运行方式，以及为什么会有两份外壳

v2.10 起有两条路径，来自同一套 `src/parts` 分片：

| 方式 | 入口 | 引擎 / 开局库来源 |
|---|---|---|
| HTTP（开发、联机、调试） | `run.bat` → `index.html` | `fetch()` 懒加载 |
| file:// 双击即玩（分发、离线） | 直接双击 `offline.html` | 内联常量 `window.__SF_SRC` / `window.OPENINGS_BOOK` |

### 旧的「必须用服务器」结论只对 fetch 成立

早期这里写的是「`file://` 页面受同源策略约束，读不了任何本地资源，必须通过 HTTP 访问」。
**这句话只对 `fetch` 成立。** 实测（无头 Chrome，无特殊启动参数）：

```
fetch 相对路径        → Failed to fetch
fetch file:// 绝对   → Failed to fetch
XHR 同步             → 拒绝
ESM / new Worker(相对路径) → 被拦
经典 <script src>    → ✅ 可用（同目录相对路径也认）
内联脚本 → Blob Worker → ✅ 可用
CSS 外链 woff2 字体  → ✅ 加载成功
localStorage         → ✅ 可用（但有坑，见本节末尾）
```

被拦的只有 `fetch` / XHR / ESM / `new Worker(相对路径)` 这四类。
所以把引擎源码与开局库生成成普通 JS 文件（挂 `window.__SF_SRC`、`window.OPENINGS_BOOK`），
`file://` 下就能正常加载 —— 这就是 `offline.html` 的原理。

⚠️ 注意：不能用 `<script src="stockfish.js">` 直接把引擎加载进主线程，
它需要作为独立 Worker 运行，加载进主线程会污染全局作用域。
正确做法是取到源码文本 → `Blob` → `new Worker(blobURL)`。

### 为什么不合并成一份外壳

内联资源共约 1.9MB。合并会让 HTTP 用户每次首屏都多解析这 1.9MB，
而文件模式下 fetch 又必然失败。两份外壳由 `build_shell(offline=?)` 生成，
产物差异只有两个 `<script>` 标签（且内联脚本必须排在逻辑分片之前，
因为 `engineSource()` 初始化时就要读全局量）。

### ⚠️ file:// 下的 localStorage 是共享的

Chrome 把所有 `file://` 文档视为同一个 opaque origin，
**localStorage 在所有本地 HTML 之间共享** —— 任何本地 html 都能读到本项目存的东西。
因此 API Key 默认写 `sessionStorage`（关标签页即失效），
用户在设置里显式勾选「记住密钥」才落 localStorage。

---

## 三、目录结构

```
chess-arena/
├── run.bat                  双击启动（python -m http.server 8765 + 打开浏览器）
├── index.html               HTTP 模式外壳：head + body + 17 个 script 标签
├── offline.html             file:// 双击即玩（多挂两个内联数据脚本）
├── css/main.css             全部样式（字体走 ../assets/fonts）
├── js/                      17 个逻辑模块（顺序即依赖）
│   ├── 03_core.js           工具、存储、标签库、角色、Prompt 生成器
│   ├── 03a_api.js           ApiContract、错误分类、API 客户端
│   ├── 04_render.js         像素精灵、程序化立绘、音效/BGM
│   ├── 05_run.js            Run 代次中心
│   ├── 05_board.js          Canvas 棋盘（含键盘光标绘制）
│   ├── 06_engine.js         Stockfish 状态机（主搜索）
│   ├── 06b_analysis.js      Analysis 第二 Worker + EvalBar 评估条
│   ├── 06c_boardkeys.js     BoardKeys 键盘走子（方向键/回车/Esc + 播报）
│   ├── 06a_endpoint.js      EndpointGuard 端点准入
│   ├── 06_game.js           对局控制器
│   ├── 07a_settings.js      演出节奏、无障碍、评估开关
│   ├── 07b_clock.js         棋钟
│   ├── 07_ui.js             UI 层
│   ├── 08_wire.js           事件接线、PGN 导入、回放
│   ├── 08a_undo.js          悔棋/提和 + 反应词库
│   ├── 08b_openings.js      开局库查询 + 提示着法
│   └── 08c_review.js        复盘引擎 + 报告 UI
├── data/openings.json       开局库（3606 局面，361 KB）
├── data/openings.inline.js  同上（生成物，file:// 用）
├── assets/
│   ├── fonts/               ps2p.woff2 (12 KB)、fusion-pixel-subset.woff2 (133 KB)
│   └── vendor/              chess.js (46 KB)、stockfish.js (1543 KB)、stockfish.inline.js (生成)
├── src/
│   ├── build.py             校验 + 同步 js/ 与两份 HTML + 生成内联产物
│   ├── subset_font.py       中文字体子集化（923 KB → 133 KB）
│   ├── parts/               17 个源分片（唯一真源）+ 01_head.html / 02_body.html
│   ├── fonts/               上游字体原件：fusion/（zh_hans + zh_hant + OFL）、ps2p.woff2
│   └── pw/                  15 套测试 + run-tests.js + testenv.js
├── package.json
├── LICENSE                  GPL-3.0 全文（含内联 Stockfish 的 GPL v3 要求）
├── README.md                对外介绍 / 快速开始 / 开发说明
├── docs/screenshots/        README 截图
├── GDD.md                   设计决策（含 §22 v2.6 落地记录与复核结论）
├── CONTEXT.md               本文件
├── EVALUATION.md            v2.10.0 实测评估与迭代记录
└── THIRD_PARTY_NOTICES.md
```

**重要**：`js/*.js` 是 `src/parts/*.js` 的**同步副本**。改代码要改 `src/parts/`，
然后 `npm run build` 同步。直接改 `js/` 会被覆盖。

---

## 四、常用命令

```
npm start          # 校验 + 启动服务器（8765）
npm run serve      # 仅启动服务器
npm run build      # 校验 + 同步 js/ 与 index.html
npm run check      # 仅校验（不写文件）
npm test           # 十五套件汇总（自动装依赖、自动起服务器、结束自动关）
npm run subset-font # 重新生成中文字体子集（改了文案后跑）
```

浏览器打开：`http://localhost:8765/index.html`

---

## 五、模块加载顺序（顺序即依赖）

```
03_core → 03a_api → 04_render → 05_run → 05_board → 06_engine → 06b_analysis
→ 06c_boardkeys → 06a_endpoint → 06_game → 07a_settings → 07b_clock → 07_ui
→ 08_wire → 08a_undo → 08b_openings → 08c_review
```

采用经典 `<script>` 而非 ES Module 的原因：项目依赖「全局对象图 + 顺序加载」，
且 `import` 在 file:// 下同样受限。改成模块会牵动全部 17 个文件，收益不足。

注意 `06b_analysis.js` / `06c_boardkeys.js` 都排在 `06_game.js` 前面：
`Game.start()` 直接调 `Analysis` / `EvalBar`，`Game.newChess()` 直接调 `BoardKeys`。

---

## 六、全局对象（新代码必须复用）

| 对象 | 职责 |
|---|---|
| `Run` | 代次中心。`kill()` 作废整局，`token()` 取身份证，`runSleep(ms,token)` 可取消等待 |
| `Engine` | Stockfish 状态机，`bestMove()` 必结算；`ENGINE_URL` 指向 vendor |
| `Analysis` | **第二** Stockfish Worker，专做评估；`live()` 实时、`evaluate()` 复盘、`cancelAll()` 兜底 |
| `EvalBar` | 像素评估条（canvas），白方视角；`apply()` 节流 / `applyNow()` 立即 |
| `Review` | 复盘引擎：`start()` 逐手评估、`build()` 纯函数分级、`attach()` 写回棋谱 |
| `ReviewUI` | 复盘面板渲染（终局面板 + 回放页共用） |
| `BoardKeys` | 键盘走子：光标移动 / 选中落子 / 播报。**一律走 `Game.onSquareClick`** |

**Analysis 的可靠性机制**（详见 GDD §20）：`receiving` 接收窗口、`depth` 单调过滤、
`isready→readyok` 硬同步、空结果自动 `restart()` 自愈、`_cancelSeq` 区分「被取消」与「引擎卡死」。
| `Game` | 对局控制器，每个 `await` 后必须 `Run.isLive(token)` |
| `ApiContract` | token/温度/超时/台词清洗的唯一真源 |
| `EndpointGuard` | 密钥外发前的端点准入 |
| `Clock` | 棋钟（Fischer 增量） |
| `UndoDraw` | 悔棋 / 提和 |
| `Reactions` | 对手对悔棋/提和的性格化反应 |
| `Settings` / `A11y` | 演出节奏、无障碍 |
| `Store` | localStorage（前缀 `aca.v1.`） |

关键常量：`MAX_TOKENS_UI:256` / `MAX_TOKENS_REQ:200` / `DEFAULT_TIMEOUT:15000` / `THOUGHT_MAX:60`
难度：`6层/2s`、`10层/6s`、`14层/14s`、`20层/30s`
评估：live `depth24/480ms` · review `depth14/1400ms` · 静默期 260ms · 缓存 700 条
失误阈值：`?? ≥300cp` · `? ≥150cp` · `?! ≥70cp`

---

## 七、已完成

| 版本 | 内容 |
|---|---|
| 初版 | 三模式、角色工坊、API 配置、回放、像素美术、芯片音乐 |
| v1.1 | 引擎状态机重写、runId 代次隔离、API 可取消、统一 ApiContract、演出三档、无障碍、构建自检、许可证 |
| v1.2 | 端点准入（EndpointGuard）、`npm test` 依赖自愈 |
| v1.3 | 棋钟 + 难度/余时联动的思考预算 |
| v1.4 | 悔棋与提和（人设化确认台词） |
| **v2.0** | **多文件架构迁移（2B）、run.bat、测试自动起服务器、构建脚本改写** |
| v2.1 | 开局库（ECO 3606）+ 提示着法 |
| **v2.2** | **棋力分析（第二 Worker + 像素评估条）、复盘报告（失误分级/转折点/存谱）** |
| v2.2.1 | 修：无障碍摘要自动刷新（含回放页独立 live region）、存谱/复盘记录归属 |
| **v2.3** | **键盘完整走子（WCAG 2.1.1）：光标导航 / 回车落子 / ARIA 播报** |
| v2.4 | 修：评估子系统 8 处缺陷（残留 info 污染 / 浅缓存 / 悔棋不刷新 / 终局不停 / 空结果自愈等） |
| **v2.5** | **320px 六页面专项：回放棋盘自适应 + 触控目标 ≥32px + 字号 ≥10px** |
| **v2.6** | **按外部实测评估报告落地：offline.html 双击即玩、引擎源码共享、密钥分层、渲染 -93%、字体 -86%**（复核与落地全过程见 GDD §22） |
| **v2.7** | **修 4 个 H 级交互 bug（按钮置灰/回放冻结/翻转半翻/resize 吞步）+ 12 项静态审查项** |
| **v2.8** | **棋盘朝向规则「玩家1永远在下」+ 手动翻转降级为本局临时覆盖（修跨局泄漏）** |
| v2.9 | 仓库清理：删死代码/重复 vendor/字体变体（-5.2 MB），修 test_ui_final 孤儿、test_interaction 采样竞态 |
| **v2.10** | **复盘判级缺陷：评估空值被静默判成 good → unknown + 单点重试 + 覆盖率规则重写** |
| **v2.11** | **合并外部副本的 P0 修复：ECO 开局库键多算 FEN 第 4 段（吃过路兵）→ 1.e4 / 1.e4 c5 等主流开局全查不到**（详见 GDD §27） |

---

## 八、待做

**清单已清空。** 全部既定项完成：

| 项 | 版本 |
|---|---|
| P3 开局库 | ✅ v2.1 |
| P4 提示着法 / 棋力分析 | ✅ v2.2 |
| P2 复盘报告 | ✅ v2.2 |
| 无障碍摘要自动刷新 | ✅ v2.2.1 |
| 存谱 / 复盘记录归属 | ✅ v2.2.1 |
| 键盘完整走子（WCAG 2.1.1） | ✅ v2.3 |
| 评估子系统 8 处缺陷 | ✅ v2.4 |
| ECO 开局库 ep 键（P0） | ✅ v2.11 |
| 320px 六页面专项 | ✅ v2.5 |
| Elo / 成长 | ⛔ 不做（纯堆量） |
| 后端代理 / 桌面封装 | ⛔ 不做（改交付形态，需单独决策） |

---

## 九、必须知道的坑

| 坑 | 现象 | 结论 |
|---|---|---|
| **直接改 `js/`** | 改动被 `npm run build` 覆盖 | **永远改 `src/parts/`** |
| `setoption name Threads value 1` | 引擎永不返回 bestmove | 绝不设置 Threads，只设 Hash |
| `stop` 后的收尾 bestmove | 立刻发新 `go` 会被打断 | 需 260ms 静默期 `_quietUntil` |
| 取消后 `busy` 卡死 | 后续 `flush()` 直接 return | 必须 `drain()` 统一结算所有 job |
| 旧局写回新局 | 旧台词出现在新棋局 | 每处 `await` 后 `Run.isLive(token)` |
| 端点确认并发 | 两方同时请求时 onclick 被覆盖 | `ask()` 必须排队串行 |
| 「仅本次」写入 localStorage | 安全语义错误 | `trust()` 只由「始终允许」调用 |
| 超时判负后无结果面板 | `abort()` 的 `Run.kill()` 推进代次 | 用 `abort({keepToken:true})` 自行收尾 |
| 引擎预算下限反噬 | 余时 1s 时预算 1200ms > 余时 | `floor = min(1200, 余时×0.5)` |
| `canUse()` 要求 pendingHuman | AI 收尾 600ms 窗口内按钮是灰的 | 改为「轮到你 + 非 busy」 |
| `file://` 下用 `fetch` 取引擎源码 | Failed to fetch，引擎起不来 | 不必走 HTTP：经典 `<script src>` 在 file:// 下可用，Worker 源码改取内联常量 |
| 独立 shell 模板 | 新 UI 构建后消失 | `build.py` 从 head+body 组装 |
| ECO 库按 FEN 前 4 段建键 | `1.e4` / `1.e4 c5` / `1.e4 d5` 全查不到，界面长期停在「开局阶段」 | 第 4 段（吃过路兵）必须丢掉，只取前 3 段 |
| ECO 库键语义 | `moves[0]` 是垃圾着法 | 库索引「走后局面」；`moves` 是全部合法着法 |
| **归一键撞车** | 3 段键会让 `... e6` 与 `... -` 两个原始键指向同一局面 | `_index()` 必须**分两趟**：先只收 ep 为 `-` 的规范条目，再补空；一次性 set 会被带 ep 的覆盖 |
| 合并分叉副本 | 「哪边文件更新就整目录覆盖」会丢元数据 | 逐文件比哈希 + 逐项判「改进还是回退」，按能力集合合并（见 GDD §27.7） |
| 测试断言记录 bug 行为 | 旧断言断言「开局阶段 + pending===true」 | 修复后必须同步改断言，否则测试在保护错误行为 |
| emoji 在像素字体下变方块 | 按钮乱码 | 全改文本标签（PVE / AI·AI / CHARA） |
| 括号平衡启发式检查 | 正则字面量误判 | 用 `node --check` |
| Canvas 小尺寸像素模糊 | 棋子边缘发虚 | 按整数倍缩放（`Math.floor`） |
| 棋盘对比不足 | 深色棋子看不清 | 浅 `#c2b9e4` / 深 `#4d4477` |
| **评估与主搜索共用 Worker** | AI 思考时评估条冻住 | 必须第二 Worker（`06b_analysis.js`） |
| **`info score` 是走子方视角** | 黑方回合条子朝反方向 | 统一 `whiteCp(score, turn)`，`turn` 取自该 FEN |
| **`Engine.score()` 不能当实时评估** | PvP / 人类回合永远是 null | 主通道 `Analysis.live()`，长考时才读 `Engine.score()` |
| **分析 Worker 不随 abort 停** | 终局后后台还在搜 | `Game.abort()` 里 `Analysis.cancelAll()` |
| **`rec.moves[i].fen` 是走完之后** | 复盘把"走前"取错一步 | `positionsOf()` 自己补初始局面 |
| **黑方损失符号** | 黑方送子被判成好棋 | 按 `m.color` 定符号，不用 `turn` |
| **同一 `id` 用在两处 DOM** | 结果页进度条永不更新 | `reviewBarRes` / `reviewBar` 分开，`bars()` 批量刷 |
| **评估条尺寸不随对局更新** | 进对局后高度停在 480 | `Game.start()` 调 `EvalBar.syncToBoard(view)` |
| **live region 放在隐藏屏里** | 回放时读屏毫无反应 | `display:none` 子树里的 live region 不播报，每屏要各自一份（`#boardA11y` / `#replayA11y`） |
| **`window.*` 存对局状态** | 跨局串味（复盘复盘到上一局） | 状态归 `Game`，在 `newChess()` 复位 |
| **无障碍摘要只更新一次** | 读屏永远听到初始局面 | 每个改局面的出口都要调 `A11y.updateBoardLabel`：applyMove / performUndo / Replay.goto |
| **存谱按钮不幂等** | 连点出多条相同棋谱 | `saveCurrentGame()` 先查 `savedRecordId` 是否仍在库 |
| **键盘另写落子路径** | 与鼠标的合法着法不一致 | 一律走 `Game.onSquareClick` |
| **方向键不按 `flipped` 反算** | 执黑（翻转）时上下颠倒 | `BoardKeys.sqFromScreen` 先反算再取格名 |
| **棋盘内按键不 `stopPropagation`** | 按 → 同时触发「单步」 | 棋盘内拦截 + 全局 handler 加 `target.id` 守卫 |
| **鼠标点完光标还亮着** | 两套输入视觉打架 | `blur` 与 `mousedown` 都收起光标 |
| **每移动一格都播报** | 读屏念一串中间格 | 90ms 节流，只播报落点 |
| **`info score` 与 `readyok` 交错** | 送杀局面读出上一局的 `+1.0` | `receiving` 开窗 + **depth 单调性**过滤旧行（见 GDD §20.2） |
| **`isready` 发完就往下走** | 等于没等，残留行照样污染 | 必须干等 `readyok` 才放行 `go` |
| **复盘复用 live 浅缓存** | depth 9 vs 11 差 126cp，判级失真 | `REVIEW_MIN_DEPTH = 12`，低于门槛重算 |
| **`restart()` 推进取消序号** | 自愈把自己的重启误判成取消，永远拿不到分 | `restart()` 退出时还原 `_cancelSeq` |
| **无障碍摘要只更新一次** | 读屏永远听到初始局面 | 每个改局面的出口都要调（含 `performUndo`） |
| **只看 `overflowX`** | 回放页报 0 溢出，实际 44 元素越界（横向塌陷） | 必须同时查 `getBoundingClientRect` 越界 |
| **`BoardView` 默认 480** | 回放棋盘不跟随视口 | 首次创建后立刻 `Replay.fitBoard()` |
| **复用 `.board-col` 类名** | 战斗页的 `order:2` 把回放棋盘推到信息栏后，整屏不可见 | 复用类名要复查它在各断点的语义 |
| **媒体查询压不过后置同优先级规则** | 9px 改不动 | 提高特异性（`#app` 前缀） |
| **内联 `font-size:9px`** | 媒体查询完全失效 | 删内联，交给 CSS 管 |
| **签名兜底只比棋子数量** | 白兵 e2→e4 数量不变，回放画面不动 | 位置变化必须显式 `invalidate()` |
| **resize 里清 `anims`** | 动画 Promise 永不 resolve，applyMove 挂起、busy 卡死 | 先调 `onDone` 结算再清队列 |
| **测试自己调 `updateControlState()`** | 接线缺失被掩盖，永久置灰也全绿 | 断言前不补状态；必须测「该亮时亮」 |
| **默认朝向和手动翻转共用持久字段** | 点一次翻转，以后每局都被翻 | 默认由规则算（`autoFlipFor`），手动是 `Game.flipOverride`（本局临时） |
| **用 `flipped` 标志验证朝向** | 标志对≠棋子坐标对（2.7 就栽在这） | 断言用棋子实际屏幕 y 坐标 |
| **评估返回 null 被当 good** | 复盘把送杀步判成好棋（偶发，约每 3 次 1 次） | `build()` 缺值必须落 `unknown`，不能留默认 `good`；`cpOf` 判空 |
| **`m.loss \|\| 0` 展示** | `null` 变 `-0cp`，错报告看不出异样 | 数字展示显式判 `null`，别用 `\|\|` 兜 0 |
| **覆盖率阈值当质量门** | `80%` 恰好放过「只缺关键那一步」 | 过半缺才拒出报告；少数缺照出但摘要必须警示 |
| **界面文案写 emoji / ⚠** | `npm run check` 报字体缺字 U+26A0 | 子集只含 GB2312 一级 + ASCII，一律用中文文字 |

---

## 十、工作方式

1. **先复现再修**。外部结论要写脚本验证，不直接采信。
2. **改 `src/parts/` → `npm run build` → `npm test`**。
3. **不用「人天」估工**，直接做。
4. 新增模块必须同步 `src/build.py` 的 `JS_PARTS` 与 `js/`。
5. `npm run check` 的断言不要为了让其通过而删除。
6. 测试失败时，先怀疑测试自己的等待时序，再怀疑产品。

---

## 十一、验证标准

```
npm run check    # 资源存在、Node 语法、重复声明、契约要素、路径正确性
npm test         # 十五套件全 PASS
```
- 无 JS 运行时错误
- 无 404 资源
- 390px / 320px 响应式已验收

---

## 十二、视觉约束（不可妥协）

- 棋盘 Canvas 渲染，棋子/立绘程序化生成（无外部图片素材）
- 像素整数倍放大，`image-rendering: pixelated`
- 面板：3px 硬边框 + inset 亮边 + 6px 硬阴影 + 四角金色铆钉
- 字体：中文 Fusion Pixel，英文/数字 Press Start 2P
- 音效：Web Audio 合成，无音频文件


