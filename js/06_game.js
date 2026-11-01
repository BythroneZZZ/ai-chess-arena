/* 难度参数
 * 深度按实测校准：该 asm.js 构建在浏览器里约 1.1s/深度单位（中局）。
 * budget 是「允许引擎思考多久」，超时后用当前最好着法；不设 budget 会把
 * 高层搜索截成随机兜底，反而更弱。
 */
const DIFF = {
  1: { depth: 6, budget: 2000, label: '入门', quipTag: 'rookie' },
  2: { depth: 10, budget: 6000, label: '普通', quipTag: 'normal' },
  3: { depth: 14, budget: 14000, label: '高手', quipTag: 'expert' },
  4: { depth: 20, budget: 30000, label: '地狱', quipTag: 'hell' }
};

/* 计算本回合引擎可用预算：
 *   base        = 难度预算
 *   clockCap    = 剩余时间 × 0.28（永不用超过 28% 的余时去思考，留出应手余地）
 *   绝对下限    = 1.2s（太短会让引擎来不及给好着法，反而不公平）
 * 无棋钟时只受 base 限制。
 */
function engineBudgetFor(diff, color) {
  const base = (diff && diff.budget) || 6000;
  if (!Clock.enabled) return base;

  const left = Clock.remainingOf(color);
  if (left <= 0) return 0;

  // 目标：用不超过余时的 28% 思考
  const cap = Math.floor(left * 0.28);
  // 但引擎太短会来不及给出好着法；下限取 1.2s，且绝不超过「剩余时间的一半」
  // ——否则会出现「预算比余时还长」的荒谬情况，AI 反而必超时。
  const floor = Math.min(1200, Math.floor(left * 0.5));
  return clamp(Math.min(base, cap), floor, base);
}

/* =====================================================================
 * 13 · LOCAL LINE LIBRARY (兜底台词)
 * ===================================================================== */
const LOCAL_LINES = {
  think: ['……'],
  move: {
    1: ['这步我不太确定，试试看吧。', '嗯……先这样，走一步看一步。', '不知道这步好不好，就当练手了。', '哎呀，好像有点问题，算了。'],
    2: ['这步还算合理。', '稳住，先占住中心。', '按常规思路走。', '局面还行，不用急。'],
    3: ['这一步很关键，你最好想清楚。', '压力给你了。', '这条线我算过了。', '你的应对不多。'],
    4: ['绝望是必然的。', '你每一步都在我的预判里。', '结束了，只是你还不知道。', '看着就好，别挣扎。']
  },
  capture: {
    1: ['吃掉啦？运气不错。', '咦，这就吃到了？'],
    2: ['交换对我有利。', '这个子我收下了。'],
    3: ['你的防线已经没了。', '子力差摆在这里。'],
    4: ['你连子都保不住。', '这就是你的水平。']
  },
  check: {
    1: ['将军……我真的走出这一步了？', '诶，好像将到你了？'],
    2: ['将军，注意应法。', '这下一将，节奏在我这边。'],
    3: ['将军。你只有两条路，都很难受。', '王的处境，你自己看。'],
    4: ['将军。倒数第二步了。', '别躲了，躲到哪都是死。']
  },
  win: ['赢了！', '这盘我拿下了。', '结果已定。', '承让。'],
  lose: ['输了……有点意外。', '这盘是我失误了。', '你下得不错。', '再来一局。'],
  apiFail: ['……（信号好像断了，我先凭感觉走）', '（咦？我的话筒好像没声了）', '（算了，先落子）'],
  invalid: ['（这个步法好像走不了，我换个）', '（等等，这步不合法……）']
};

function localLine(kind, difficulty) {
  const d = clamp(difficulty || 2, 1, 4);
  const arr = LOCAL_LINES[kind];
  if (!arr) return '……';
  if (typeof arr === 'object' && !Array.isArray(arr)) return pick(arr[d] || arr[2] || ['……']);
  return pick(arr);
}

/* 用角色标签生成一句兜底台词 */
function charTaggedLine(char, kind) {
  const tags = (char.tags || []).filter((t) => TAGS[t]);
  const pools = tags.map((t) => TAGS[t].lines && TAGS[t].lines[kind]).filter(Boolean);
  if (pools.length) return pick(pick(pools));
  return localLine(kind, 2);
}

/* =====================================================================
 * 14 · GAME CONTROLLER
 * ===================================================================== */
const Game = {
  mode: 'pve',
  chess: null,
  view: null,
  players: { w: null, b: null },   // {char, api, engine, human, name}
  human: { w: false, b: false },
  takenOver: { w: false, b: false },
  difficulty: 2,
  delayMs: 700,
  temp: 0.9,
  opt: { w: { temperature: 0.9, maxTokens: 80, delay: 900 }, b: { temperature: 1.0, maxTokens: 80, delay: 900 } },
  auto: true,
  maxMoves: 120,
  narrator: null,
  narratorApi: null,

  moves: [],
  running: false,
  aborted: false,
  paused: false,
  stepMode: false,
  pauseResolve: null,
  pendingHuman: null,
  promoResolver: null,
  selectSq: null,
  busy: false,
  result: null,
  startedAt: 0,
  lastThought: { w: '', b: '' },
  morale: { w: 50, b: 50 },
  bubbleTokens: { w: 0, b: 0 },
  /* 本局已落盘的棋谱 id。
   * 曾经放在 window.__lastSavedId 上且从不清空 —— 上一局的 id 会带到新的一局，
   * 用户点「复盘」拿到的是上一盘的棋。现在归 Game，newChess() 时清空。 */
  savedRecordId: null,
  /* 本局的手动翻转覆盖（null = 用规则算出的默认朝向）。
   * 不持久化：新局清空，避免「点过一次翻转，以后每局都被翻」。
   * 规则见 08_wire.js · 21b 棋盘朝向。 */
  flipOverride: null,

  /* ---------------- init / reset ---------------- */
  newChess() {
    this.chess = new Chess();
    this.moves = [];
    this.result = null;
    this.aborted = false;
    this.paused = false;
    this.stepMode = false;
    this.busy = false;
    this.pendingHuman = null;
    this.selectSq = null;
    this.morale = { w: 50, b: 50 };
    this.lastThought = { w: '', b: '' };
    this.savedRecordId = null;          // 新局：忘掉上一局的棋谱 id
    this.flipOverride = null;           // 新局：回到规则算出的默认朝向
    // 键盘光标复位到走子方的王，避免停在上一局的格子上
    if (typeof BoardKeys !== 'undefined') {
      BoardKeys.active = false;
      if (this.view) {
        this.view.cursor = null;
        if (BoardKeys.view === this.view && document.activeElement === this.view.cv) {
          BoardKeys.active = true;
          this.view.cursor = BoardKeys.homeSquare();
        }
      }
    }
    this.startedAt = Date.now();
    if (this.view) {
      this.view.pieces = [];
      this.view.selected = null;
      this.view.legal = [];
      this.view.lastMove = null;
      this.view.checkSq = null;
      this.view.particles = [];
      this.view.hl = [];
      this.view.anims = [];
      this.view.setPosition(this.chess);
    }
  },

  /* ---------------- board events ---------------- */
  bindBoard(view) {
    this.view = view;
    const cv = view.cv;
    cv.addEventListener('click', (ev) => {
      const r = cv.getBoundingClientRect();
      const x = (ev.clientX - r.left) * (view.size / r.width);
      const y = (ev.clientY - r.top) * (view.size / r.height);
      const sq = view.fromXY(x, y);
      if (sq) this.onSquareClick(sq);
    });
    cv.addEventListener('mousemove', (ev) => {
      const r = cv.getBoundingClientRect();
      const x = (ev.clientX - r.left) * (view.size / r.width);
      const y = (ev.clientY - r.top) * (view.size / r.height);
      view.hoverSq = view.fromXY(x, y);
    });
    cv.addEventListener('mouseleave', () => { view.hoverSq = null; });
  },

  canHumanAct(color) {
    if (!this.pendingHuman) return false;
    if (this.pendingHuman.color !== color) return false;
    return this.human[color] || this.takenOver[color];
  },

  onSquareClick(sq) {
    if (!this.chess || !this.running) return;
    const turn = this.chess.turn();
    if (!this.canHumanAct(turn)) return;
    const p = this.chess.get(sq);
    if (this.selectSq) {
      if (sq === this.selectSq) { this.selectSq = null; this.view.selected = null; this.view.legal = []; Sound.click(); return; }
      const target = this.view.legal.find((m) => m.to === sq);
      if (target) { this.commitHumanMove(this.selectSq, sq); return; }
    }
    if (p && p.color === turn) {
      this.selectSq = sq;
      this.view.selected = sq;
      const legal = this.chess.moves({ square: sq, verbose: true });
      this.view.legal = legal;
      Sound.select();
      // 单击即走：若只有一个合法走法且非升变/吃子歧义，仍要求再点（更可控）
    } else {
      this.selectSq = null; this.view.selected = null; this.view.legal = [];
    }
  },

  async commitHumanMove(from, to) {
    const options = this.chess.moves({ square: from, verbose: true }).filter((m) => m.to === to);
    if (!options.length) return;
    let promo = null;
    if (options.length > 1 && options.some((m) => m.promotion)) {
      promo = await this.askPromotion(this.chess.turn());
      if (!promo) { this.selectSq = null; this.view.selected = null; this.view.legal = []; return; }
    } else if (options[0].promotion) promo = options[0].promotion;
    this.selectSq = null; this.view.selected = null; this.view.legal = [];
    const r = this.pendingHuman && this.pendingHuman.resolve;
    if (r) { this.pendingHuman = null; r({ uci: from + to + (promo || ''), thought: null, human: true }); }
  },

  askPromotion(color) {
    return new Promise((resolve) => {
      const box = $('#promoOverlay'), inner = $('#promoBox');
      inner.innerHTML = '';
      ['q', 'r', 'b', 'n'].forEach((t) => {
        const c = document.createElement('canvas');
        c.width = 64; c.height = 64;
        const g = c.getContext('2d');
        g.imageSmoothingEnabled = false;
        g.fillStyle = color === 'w' ? '#c2b9e4' : '#4d4477';
        g.fillRect(0, 0, 64, 64);
        const spr = getSprite(t, color);
        const h = 56, w = h * (spr.bbox.w / spr.bbox.h);
        g.drawImage(spr.cv, spr.bbox.x, spr.bbox.y, spr.bbox.w, spr.bbox.h, (64 - w) / 2, 50 - h, w, h);
        c.onclick = () => { box.classList.remove('on'); resolve(t); };
        inner.appendChild(c);
      });
      box.classList.add('on');
      this.promoResolver = resolve;
    });
  },

  /* ---------------- main loop ---------------- */
  async start(config) {
    // 作废上一局的全部异步任务（API 请求 / 打字机 / 引擎）
    Run.kill();
    Engine.stopAll();
    /* 上一局的复盘必须停：它占着分析 Worker，和新局的实时评估抢同一份资源，
     * 而且它写回的是旧棋谱，跟当前对局无关。 */
    if (typeof Review !== 'undefined' && Review.running) Review.cancel('newGame');
    /* 评估开关关着的话，把分析 Worker 真正释放掉。
     *
     * 只 cancelAll() 是「不接新活」，Worker 本身还活着 —— asm.js 实例几十 MB。
     * 上一局开过评估、这一局关着，那份内存就一直闲置到标签页关闭。
     * release() 是幂等的，没建过就什么都不做。 */
    if (typeof Analysis !== 'undefined' && typeof Settings !== 'undefined' && !Settings.evalOn()) {
      try { Analysis.release(); } catch (e) { /* 忽略 */ }
    }
    const token = Run.token();

    this.mode = config.mode;
    this.players = config.players;
    this.human = config.human;
    this.takenOver = { w: false, b: false };
    this.difficulty = config.difficulty;
    this.delayMs = config.delayMs;
    this.temp = config.temp;
    this.opt = config.opt || this.opt;
    this.auto = config.auto !== false;
    this.stepMode = !this.auto;
    this.maxMoves = config.maxMoves;
    this.narrator = config.narrator || null;
    this.narratorApi = config.narratorApi || null;
    this.clockPreset = config.clockPreset || 'unlimited';
    this.flagWinner = null;
    this.agreedDraw = false;
    this.newChess();
    this.running = true;
    this.busy = false;

    // 棋钟：超时即判负，走与控制台一致的 abort 路径
    // 开局库：准备好后立即显示当前开局（初始局面 = 开局名称列表的根）
    Openings.load().then(() => {
      if (!Run.isLive(token)) return;
      UI.setOpening(Openings.current(this.chess));
    });

    // 评估条：新局从 0.0 起，并把第二 Worker 预热（与主搜索并行初始化）
    EvalBar.reset();
    // 进对局时按棋盘实测尺寸重排（窗口大小/棋盘 resize 都会改 size）
    EvalBar.syncToBoard(this.view);
    EvalBar.setVisible(Settings.evalOn());
    if (Settings.evalOn()) {
      /* 捕获开局时的 token 再比 —— 原先写 Run.isLive(Run.token()) 是自取自比，
       * 永远为真，上一局的评估结果会画进新局的评估条。 */
      Analysis.onScore = (res) => {
        if (!Run.isLive(token) || this.aborted) return;
        EvalBar.apply(res);
      };
      Analysis.init();
      this.analyzePosition(token);
    }

    Clock.stop();
    Clock.start(this.clockPreset, (colorRanOut) => {
      if (this.aborted) return;
      const winner = colorRanOut === 'w' ? 'b' : 'w';
      Debug.log('[clock] flag fell:', colorRanOut, '→ winner', winner);
      this.flagWinner = winner;
      Sound.lose();
      UI.setStatus((colorRanOut === 'w' ? '白' : '黑') + '方超时');
      // abort() 会让 runId 失效，loop 里的 finish 不会再执行，
      // 所以这里必须自己收尾（不能用会推进代次的通用路径）。
      this.abort({ keepToken: true });
      this.finish().catch((e) => console.warn('[finish after flag]', e));
    });

    UI.syncPlayers();
    UI.clearLog();
    UI.setMorale('w', 50, true);
    UI.setMorale('b', 50, true);
    UI.setTurn();
    UI.setStatus('开局');
    this.setBubble('w', 'think', '', '准备好了吗？');
    this.setBubble('b', 'think', '', '随时开始。');
    Sound.start();
    UI.showTakeover();
    await runSleep(420, token);
    if (!Run.isLive(token)) return;
    try {
      await this.loop(token);
    } catch (e) {
      if (!Run.isAbortError(e)) console.warn('[loop]', e);
    }
    if (!this.aborted && Run.isLive(token)) await this.finish(token);
  },

  async resign() {
    if (!this.chess || !this.running) return;
    Clock.stop();
    const loser = this.chess.turn();
    this.resignWinner = loser === 'w' ? 'b' : 'w';
    this.abort();
    await this.finish();
  },

  abort(opts) {
    const keepToken = !!(opts && opts.keepToken);
    this.aborted = true;
    this.running = false;
    this.paused = false;
    if (this.pendingHuman) { try { this.pendingHuman.resolve(null); } catch (e) { } this.pendingHuman = null; }
    if (this.pauseResolve) { try { this.pauseResolve(); } catch (e) { } this.pauseResolve = null; }
    if (this.promoResolver) { try { this.promoResolver(null); } catch (e) { } this.promoResolver = null; }
    const box = document.getElementById('promoOverlay');
    if (box) box.classList.remove('on');
    // 引擎 + 全部在途请求 + 所有订阅型任务
    Clock.stop();
    Engine.stopAll();
    // 分析 Worker 与主搜索完全独立：也必须在这里停，否则终局后它还在搜
    if (typeof Analysis !== 'undefined') Analysis.cancelAll('gameAbort');
    /* 复盘同理：离场 / 认输 / 判负时如果复盘还在跑，它会继续占 Worker，
     * 而且会往棋谱写一份被打断的报告。 */
    if (typeof Review !== 'undefined' && Review.running) Review.cancel('gameAbort');
    EvalBar.thinking = false;
    if (!keepToken) Run.kill();
    Thinking.stop();
    if (this.view) { this.view.anims = []; this.view.particles = []; }
  },

  async loop(token) {
    while (!this.aborted && Run.isLive(token)) {
      await this.gate(token);
      if (this.aborted || !Run.isLive(token)) break;
      if (this.moves.length >= this.maxMoves) { this.result = { type: 'maxmoves' }; break; }
      if (this.chess.game_over()) break;
      const turn = this.chess.turn();
      await this.doTurn(turn, token);
      if (!Run.isLive(token)) break;
      if (this.stepMode) this.paused = true;
      UI.setTurn();
    }
  },

  /* 悔棋之后：如果主循环已退出，重新挂起本局等待玩家 */
  resumeAfterUndo(humanColor) {
    if (!this.running || this.aborted) return;
    if (this.pendingHuman) return;              // 已在等待
    if (!humanColor) return;
    if (this.chess.turn() !== humanColor) return;
    const token = Run.token();
    // 重启一个轻量循环：只处理人类回合（悔棋只会发生在人类回合）
    (async () => {
      try {
        while (Run.isLive(token) && !this.aborted && this.chess.turn() === humanColor) {
          await this.gate(token);
          if (!Run.isLive(token) || this.aborted) return;
          if (this.chess.turn() !== humanColor) return;
          await this.doTurn(this.chess.turn(), token);
          if (!Run.isLive(token) || this.aborted) return;
          return;                                // doTurn 内部已落子，交回主循环
        }
      } catch (e) {
        if (!Run.isAbortError(e)) console.warn('[resumeAfterUndo]', e);
      }
    })();
  },

  async gate(token) {
    if (this.paused) {
      Clock.pause();
      while (this.paused && !this.aborted && Run.isLive(token)) {
        UI.setStatus('已暂停');
        await new Promise((r) => { this.pauseResolve = r; });
        if (!Run.isLive(token)) return;
      }
    }
    this.pauseResolve = null;
  },

  setPaused(p) {
    this.paused = p;
    if (p) Clock.pause(); else if (this.running) Clock.resume();
    if (!p && this.pauseResolve) { const r = this.pauseResolve; this.pauseResolve = null; r(); }
    UI.setStatus(p ? '已暂停' : '继续');
  },

  nextStep() {
    this.paused = false;
    if (this.pauseResolve) { const r = this.pauseResolve; this.pauseResolve = null; r(); }
  },

  async doTurn(color, token) {
    this.turnStart = performance.now();
    this._longThink = false;
    const pl = this.players[color];
    const humanControlled = this.human[color] || this.takenOver[color];
    Thinking.start(color);
    Clock.beginTurn(color);

    let payload = null;
    try {
      if (humanControlled) {
        UI.setStatus('轮到你落子（' + (color === 'w' ? '白' : '黑') + '）');
        payload = await this.waitHuman(color);
        if (this.aborted || !Run.isLive(token) || !payload) { Thinking.stop(); return; }
      } else if (pl.kind === 'engine') {
        payload = await this.computeEngineMove(color, token);
      } else {
        payload = await this.computeApiMove(color, token);
      }
    } catch (e) {
      if (!Run.isAbortError(e)) console.warn('[turn]', e);
      Thinking.stop();
      return;
    }
    Thinking.stop();
    if (this.aborted || !Run.isLive(token)) return;
    if (!payload || !payload.uci) { Clock.endTurn(color); return; }

    Clock.endTurn(color);
    await this.applyMove(color, payload, token);
  },

  waitHuman(color) {
    return new Promise((resolve) => {
      this.pendingHuman = { color, resolve };
      /* 真正「轮到人类」的时刻 —— 再审一遍按钮状态。
       * applyMove 末尾那次刷新足够，但单步模式 / 悔棋恢复等路径
       * 会重新建立 pendingHuman 而不经过 applyMove，这里兜住。 */
      UI.updateControlState();
    });
  },

  async computeEngineMove(color, token) {
    this._longThink = false;
    const d = DIFF[this.difficulty] || DIFF[2];
    const fen = this.chess.fen();
    UI.setStatus('引擎思考中…');
    const t0 = performance.now();

    let uci = null;
    const want = this.delayMs + rand(180, 620);
    // 长考反馈：2.2s 提示一次，之后每 3s 刷新计时，让等待可预期
    let thinkTicks = 0;
    const budget = engineBudgetFor(d, color);
    const longThinkAt = setInterval(() => {
      if (!Run.isLive(token) || this.aborted) { clearInterval(longThinkAt); return; }
      thinkTicks++;
      if (thinkTicks === 1) {
        this._longThink = true;
        this.flashExpr(color, 'shock', 1600);
        const side = color === 'w' ? 'L' : 'R';
        const el = document.getElementById('bubble' + side + 'Text');
        if (el) el.textContent = '（这一步想得有点久…）';
      }
      const secs = ((performance.now() - t0) / 1000).toFixed(0);
      UI.setStatus('长考中 ' + secs + 's / 上限 ' + (budget / 1000).toFixed(0) + 's');
    }, 2200);

    /* 主搜索期间用它的 info score 顶住评估条：
     * 分析 Worker 这 480ms 也许还在上一次局面上，但主引擎正好在搜本局面，
     * 拿它的分数更准也更即时。注意 Engine.score() 是「走子方视角」。 */
    EvalBar.thinking = true;
    const scorePoll = setInterval(() => {
      if (!Run.isLive(token) || this.aborted) { clearInterval(scorePoll); return; }
      const s = Engine.score();
      if (!s) return;
      const turn = this.chess.turn();
      EvalBar.apply({ kind: 'live', turn, score: s, depth: 0, fen: this.chess.fen() });
    }, 220);
    try {
      uci = await Engine.bestMove(fen, d.depth, budget);
    } finally {
      clearInterval(longThinkAt);
      clearInterval(scorePoll);
      EvalBar.thinking = false;
    }

    // 引擎故障 → 自动重建一次，本回合用随机合法步兜底
    if (!uci && !this.aborted && Run.isLive(token)) {
      if (Engine.failed) {
        console.warn('[game] engine failed, attempting restart');
        UI.toast('引擎异常 · 已切随机合法步兜底', 'bad');
        Engine.restart().catch(() => { });
      }
    }

    if (this.aborted || !Run.isLive(token)) return null;
    if (this.takenOver[color]) return null;

    if (!uci) {
      const legal = this.chess.moves({ verbose: true });
      if (!legal.length) return null;
      const m = pick(legal);
      uci = m.from + m.to + (m.promotion || '');
    }

    const elapsed = performance.now() - t0;
    if (elapsed < want) await runSleep(want - elapsed, token);
    if (this.aborted || !Run.isLive(token)) return null;

    // 让角色 API 生成台词（只台词）
    let thought = null;
    const pl = this.players[color];
    if (pl.api && pl.char) {
      try {
        thought = await this.apiThoughtOnly(color, uci, token);
      } catch (e) {
        if (Run.isAbortError(e)) return null;
        thought = null;
      }
    }
    if (this.aborted || !Run.isLive(token)) return null;
    const san = this.peekSan(uci);
    if (!thought) thought = this.localThoughtFor(color, san);
    return { uci, thought: ApiContract.cleanThought(thought, ApiContract.THOUGHT_MAX), source: 'engine' };
  },

  peekSan(uci) {
    const c = new Chess(this.chess.fen());
    try { const m = c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || undefined }); return m ? m.san : uci; } catch (e) { return uci; }
  },

  /* 局面变化后请求一次实时评估（第二 Worker，绝不阻塞主搜索） */
  analyzePosition(token) {
    if (!this.chess) return;
    if (this.aborted) return;
    if (token !== undefined && !Run.isLive(token)) return;
    if (typeof Analysis === 'undefined' || !Settings.evalOn()) return;
    Analysis.live(this.chess.fen());
  },

  localThoughtFor(color, san) {
    const pl = this.players[color];
    const d = this.difficulty;
    let kind = 'move';
    if (san && san.includes('#')) kind = 'check';
    else if (san && san.includes('+')) kind = 'check';
    else if (san && san.includes('x')) kind = 'capture';
    const tagged = pl.char ? charTaggedLine(pl.char, kind) : null;
    const fallback = localLine(kind, d);
    // 难度影响台词倾向：入门更多自嘲
    if (d === 1 && Math.random() < 0.5) return fallback;
    return tagged || fallback;
  },

  async apiThoughtOnly(color, uci, token) {
    const pl = this.players[color];
    const fen = this.chess.fen();
    const legal = this.chess.moves({ verbose: true }).map((m) => m.from + m.to + (m.promotion || ''));
    const san = this.peekSan(uci);
    const user = `当前局面 FEN：${fen}
你执${color === 'w' ? '白' : '黑'}。系统引擎已经决定走：${uci}（记谱 ${san}）。
合法着法列表：${legal.join(', ')}
对手上一句：${this.lastThought[color === 'w' ? 'b' : 'w'] || '（无）'}
请只用一句符合你人格的话点评自己这步棋（可以自嘲、得意、嘲讽对手），返回 {"thought":"..."}。`;
    const sys = (pl.char.prompt || genPrompt(pl.char)) + '\n\n注意：本次只生成台词，不要返回 move。';
    const out = await this.callApiWithRetry(pl.api, sys, user, 1, color);
    if (!Run.isLive(token)) return null;
    const obj = parseModelJSON(out);
    const th = obj && (obj.thought || obj.move);
    return th ? ApiContract.cleanThought(th, ApiContract.THOUGHT_MAX) : null;
  },

  async computeApiMove(color, token) {
    this._longThink = false;
    const pl = this.players[color];
    const legal = this.chess.moves({ verbose: true });
    if (!legal.length) return null;
    const legalUci = legal.map((m) => m.from + m.to + (m.promotion || ''));
    const fen = this.chess.fen();
    const user = this.buildMovePrompt(color, fen, legalUci);

    UI.setStatus('AI 思考中…');
    let thought = null, uci = null, usedApi = false;
    if (pl.api) {
      usedApi = true;
      /* 重试策略：**只有格式纠错重试，网络失败不重试**。
       *
       * 早先外层 2 次 × callApiWithRetry 内层 2 次 = 最坏 4 次请求，
       * 每次 15s 超时 —— 单步棋能把界面卡住 60 秒，还连弹 4 个错误 toast。
       * 现在内层传 0（不重试网络），外层第 2 次只在「模型返回了内容但
       * 解析不出一手合法棋」时才发 —— 那是提示词问题，重试有意义。 */
      for (let attempt = 0; attempt < 2 && !uci; attempt++) {
        let out = null;
        try {
          out = await this.callApiWithRetry(
            pl.api,
            pl.char.prompt || genPrompt(pl.char),
            attempt === 0 ? user : user + '\n上一次的回应无法使用，请严格只返回 JSON，move 必须来自合法着法列表。',
            0,                                   // 内层不重试：避免与本次循环叠加
            color,
            { retryNetwork: false }
          );
        } catch (e) {
          out = null;
          /* 网络/鉴权类是硬失败，再试一次同样是 15s 白等 */
          if (!Run.isAbortError(e)) break;
        }
        if (this.aborted || !Run.isLive(token)) return null;
        if (out) {
          const obj = parseModelJSON(out);
          if (obj) {
            thought = obj.thought ? ApiContract.cleanThought(obj.thought, ApiContract.THOUGHT_MAX) : null;
            const mv = normalizeUci(this.chess, obj.move);
            if (mv) uci = mv.from + mv.to + (mv.promotion || '');
          }
        }
        if (!uci && attempt === 0) await runSleep(300, token);
      }
    }

    if (this.aborted || !Run.isLive(token)) return null;

    if (!uci) {
      // 兜底：引擎或随机
      const d = DIFF[Math.min(2, this.difficulty)] || DIFF[2];
      let eng = null;
      if (Engine.ready && !Engine.failed) eng = await Engine.bestMove(fen, Math.min(8, d.depth), 3000);
      if (this.aborted || !Run.isLive(token)) return null;
      if (eng) uci = eng;
      else { const m = pick(legal); uci = m.from + m.to + (m.promotion || ''); }
      if (!thought) {
        thought = usedApi
          ? (charTaggedLine(pl.char, 'invalid') + ' ' + charTaggedLine(pl.char, 'move'))
          : charTaggedLine(pl.char, 'move');
      }
      const reason = this._lastApiFail && this._lastApiFail.kind;
      const label = !usedApi ? '纯本地模式'
        : reason === 'abort' ? '已拒绝该端点 · 本步本地兜底'
          : reason === 'auth' ? '鉴权失败 · 本步本地兜底'
            : reason === 'network' ? '连不上 API · 本步本地兜底'
              : 'API 未给出可用着法 · 已本地兜底';
      UI.toast(label, usedApi ? 'bad' : '');
    }

    if (this.takenOver[color]) return null;
    const elapsed = performance.now() - this.turnStart;
    const want = Math.max(this.delayMs, (this.opt[color] && this.opt[color].delay) || 0);
    if (elapsed < want) await runSleep(want - elapsed, token);
    if (this.aborted || !Run.isLive(token)) return null;
    return { uci, thought: ApiContract.cleanThought(thought, ApiContract.THOUGHT_MAX), source: usedApi ? 'api' : 'local' };
  },

  buildMovePrompt(color, fen, legalUci) {
    const history = this.chess.history({ verbose: true }).slice(-6).map((m) => m.san).join(' ');
    const theirLine = this.lastThought[color === 'w' ? 'b' : 'w'];
    return `当前局面 FEN：${fen}
你执${color === 'w' ? '白' : '黑'}，轮到你走。
最近着法：${history || '（开局）'}
你被将军吗：${this.chess.in_check() ? '是' : '否'}
对手刚刚说：${theirLine || '（无）'}
合法着法（必须从中选一个，UCI 格式）：${legalUci.join(', ')}

只返回 JSON：{"move":"e2e4","thought":"一句话内心想法"}。thought 不超过 40 个汉字，必须符合你的人设。`;
  },

  /**
   * 调 API，带可选重试。
   * @param {number} retries 网络层重试次数（默认 1）。调用方若自己还有循环，
   *                         务必传 0，否则会乘性放大等待时间。
   * @param {string} color   'w' | 'b'
   * @param {object} opts    { retryNetwork:boolean }
   */
  async callApiWithRetry(cfg, system, user, retries = 1, color, opts) {
    const o2 = opts || {};
    let lastErr = null;
    const o = (color && this.opt[color]) || { temperature: this.temp, maxTokens: 80 };
    /* 网络/鉴权/限流这类错误，重试通常只是再等一个超时 ——
     * 调用方明确说「不要重试网络」时直接一次到底。 */
    const retryable = (e) => {
      if (o2.retryNetwork === false) return false;
      const kind = classifyApiError(e, cfg).kind;
      return kind === 'network' || kind === 'server' || kind === 'timeout';
    };
    for (let i = 0; i <= retries; i++) {
      try {
        this._lastApiFail = null;
        return await API.chat(cfg, system, user, {
          temperature: ApiContract.clampTemp(o.temperature),
          maxTokens: ApiContract.clampTokens(o.maxTokens || 80),
          timeout: ApiContract.DEFAULT_TIMEOUT
        });
      } catch (e) {
        lastErr = e;
        if (this.aborted || Run.isAbortError(e)) break;   // 离场：立即放弃，不重试
        if (!retryable(e)) break;                          // 不可重试类错误，别白等
        await runSleep(400, Run.token());
        if (this.aborted) break;
      }
    }
    const info = classifyApiError(lastErr, cfg);
    this._lastApiFail = info;
    if (this.aborted || Run.isAbortError(lastErr)) throw lastErr || new Error('cancelled');
    UI.toast('API 失败 · ' + info.text, 'bad');
    throw lastErr || new Error('API failed');
  },

  /* ---------------- apply move + show ---------------- */
  async applyMove(color, payload, token) {
    this.busy = true;
    const from = payload.uci.slice(0, 2), to = payload.uci.slice(2, 4), promo = payload.uci[4] || undefined;
    let mv;
    try {
      mv = this.chess.move({ from, to, promotion: promo });
    } catch (e) { mv = null; }
    if (!mv) {
      // 双保险：换一个合法步
      const legal = this.chess.moves({ verbose: true });
      if (!legal.length) { this.busy = false; return; }
      const alt = pick(legal);
      mv = this.chess.move({ from: alt.from, to: alt.to, promotion: alt.promotion });
      payload.thought = charTaggedLine(this.players[color].char, 'invalid');
    }

    const fenAfter = this.chess.fen();
    const isCap = !!mv.captured;
    const isCheck = this.chess.in_check();
    const isMate = this.chess.in_checkmate();

    // 棋子动画
    let capSq = null;
    if (isCap) capSq = mv.flags.includes('e') ? (to[0] + from[1]) : to;
    const meta = { castle: null, promotion: mv.promotion || null };
    if (mv.flags.includes('k')) { meta.castle = true; meta.rookFrom = 'h' + (color === 'w' ? '1' : '8'); meta.rookTo = 'f' + (color === 'w' ? '1' : '8'); }
    if (mv.flags.includes('q')) { meta.castle = true; meta.rookFrom = 'a' + (color === 'w' ? '1' : '8'); meta.rookTo = 'd' + (color === 'w' ? '1' : '8'); }

    if (isCap) {
      Sound.capture();
      this.view.addFloater(this.view.sqCenter(to).x - 8, this.view.sqCenter(to).y - 14, '+1', '#ffcc4d');
      this.flashExpr(color, 'win', 900);
      this.flashExpr(color === 'w' ? 'b' : 'w', 'sad', 700);
    } else Sound.move();

    await this.view.animateMove(from, to, capSq, meta);
    if (this.aborted || (token !== undefined && !Run.isLive(token))) { this.busy = false; return; }
    this.view.setPosition(this.chess);
    this.view.lastMove = { from, to };
    this.view.checkSq = isCheck ? this.findKing(this.chess.turn()) : null;
    if (Openings.ready()) UI.setOpening(Openings.current(this.chess));
    // 屏幕阅读器摘要必须跟着局面走（曾经只在 boot 更新一次）
    A11y.updateBoardLabel(this.chess, this.view);

    // 记录
    const rec = {
      color, san: mv.san, uci: from + to + (mv.promotion || ''),
      fen: fenAfter, thought: payload.thought || '', source: payload.source || 'human',
      cap: isCap, check: isCheck
    };
    this.moves.push(rec);
    UI.addLog(rec);
    this.lastThought[color] = payload.thought || '';

    // 局面已变 → 刷新实时评估（异步，不等它）
    this.analyzePosition(token);

    // 气势
    const gain = (isCap ? 8 : 4) + (isCheck ? 6 : 0) + (isMate ? 14 : 0);
    this.morale[color] = clamp(this.morale[color] + gain, 0, 100);
    this.morale[color === 'w' ? 'b' : 'w'] = clamp(this.morale[color === 'w' ? 'b' : 'w'] - Math.round(gain * 0.55), 0, 100);
    UI.setMorale('w', this.morale.w);
    UI.setMorale('b', this.morale.b);

    if (this.aborted || (token !== undefined && !Run.isLive(token))) { this.busy = false; return; }

    // 台词演出（受「演出节奏」控制）
    const who = color === 'w' ? 'L' : 'R';
    const pace = Settings.pace();          // full | fast | skip
    const text = payload.thought || (payload.human ? '' : '……');
    if (pace === 'skip') {
      UI.setBubbleInstant(who, this.players[color].char.name, payload.human ? ('（落子 ' + mv.san + '）') : text);
    } else if (text) {
      this.setBubble(color, 'say', this.players[color].char.name, text);
      Sound.bubble();
      await UI.typeBubble(color, text, 0, pace === 'fast' ? 4 : 1);
    } else if (payload.human) {
      const t2 = '（落子 ' + mv.san + '）';
      this.setBubble(color, 'say', this.players[color].char.name, t2);
      const el = document.getElementById('bubble' + who + 'Text');
      if (el) el.textContent = t2;
      await runSleep(pace === 'fast' ? 40 : 140, token);
    }
    if (this.aborted || (token !== undefined && !Run.isLive(token))) { this.busy = false; return; }

    if (isCheck) {
      Sound.check();
      this.view.shakeFrame();
      $('#checkFlash').classList.add('on');
      setTimeout(() => $('#checkFlash').classList.remove('on'), 1600);
      UI.setStatus('将军！');
      this.view.flashSquares([this.view.checkSq], '#ff4d6d');
      if (this.players[color].char) this.setPortraitExpr(color, 'shock');
      const oppColor = color === 'w' ? 'b' : 'w';
      setTimeout(() => this.setPortraitExpr(oppColor, 'shock'), 240);
    }
    if (isMate) {
      setTimeout(() => { Sound.win(); this.setPortraitExpr(color, 'win'); this.setPortraitExpr(color === 'w' ? 'b' : 'w', 'sad'); }, 120);
    }

    // PVP 解说
    if (this.mode === 'pvp' && this.narrator) {
      this.runNarrator(rec).catch(() => { });
    }

    this.busy = false;
    UI.setTurn();
    /* 控制按钮必须在这里再刷一次。
     *
     * UI.addLog() 里也会调 updateControlState()，但它发生在 busy=true 期间
     * （busy 到本行才清），所以那一次算出来的永远是「禁用」。
     * 此后 waitHuman() / setTurn() 都不碰按钮状态 —— 结果就是 AI 走完一步后
     * 悔棋/提和永久置灰，直到用户碰巧触发别的事件。
     * 实测：canUse() 已为 true、busy 已为 false，按钮却仍是 disabled。 */
    UI.updateControlState();
    if (typeof Openings !== 'undefined') {
      if (Openings.ready()) UI.setOpening(Openings.current(this.chess));
      else Openings.load().then(() => { if (this.chess) UI.setOpening(Openings.current(this.chess)); });
    }
  },

  findKing(color) {
    const b = this.chess.board();
    for (let r = 0; r < 8; r++) for (let f = 0; f < 8; f++) {
      const p = b[r][f];
      if (p && p.type === 'k' && p.color === color) return String.fromCharCode(97 + f) + (8 - r);
    }
    return null;
  },

  async runNarrator(rec) {
    if (!this.narrator || !this.narratorApi) return;
    const token = Run.token();
    const user = `局面 FEN：${rec.fen}
刚走的一步：${rec.san}（${rec.color === 'w' ? '白' : '黑'}方）
请以解说员身份，用一句 30 字以内的话点评这步棋，返回 {"thought":"..."}。`;
    try {
      const out = await API.chat(this.narratorApi, (this.narrator.prompt || genPrompt(this.narrator)) + '\n本次只生成解说台词，不要返回 move。', user, {
        temperature: 0.95, maxTokens: 70, timeout: ApiContract.DEFAULT_TIMEOUT
      });
      if (!Run.isLive(token)) return;
      const obj = parseModelJSON(out);
      const th = obj && obj.thought ? ApiContract.cleanThought(obj.thought, 50) : null;
      if (th) UI.toast('解说 · ' + this.narrator.name + '：' + th, 'good');
    } catch (e) {
      if (!Run.isAbortError(e)) Debug.log('[narrator]', (e && e.message) || e);
    }
  },

  setPortraitExpr(color, expr) {
    const key = color === 'w' ? 'L' : 'R';
    UI.setPortrait(key, expr);
    const el = document.getElementById(key === 'L' ? 'sideLWrap' : 'sideRWrap');
    if (!el) return;
    el.classList.remove('win', 'lose', 'shake');
    if (expr === 'win') el.classList.add('win');
    else if (expr === 'sad') el.classList.add('lose');
    else if (expr === 'shock') {
      el.classList.add('shake');
      setTimeout(() => el.classList.remove('shake'), 900);
    }
  },

  flashExpr(color, expr, ms) {
    const key = color === 'w' ? 'L' : 'R';
    UI.setPortrait(key, expr);
    this._exprTimers = this._exprTimers || {};
    clearTimeout(this._exprTimers[key]);
    this._exprTimers[key] = setTimeout(() => {
      if (!this.running) return;
      UI.setPortrait(key, 'idle');
    }, ms || 800);
  },

  setBubble(color, kind, who, text) {
    const key = color === 'w' ? 'L' : 'R';
    const bubble = document.getElementById('bubble' + key);
    if (!bubble) return;
    bubble.classList.toggle('think', kind === 'think');
    document.getElementById('who' + key).textContent = who || '';
    bubble.classList.remove('pop'); void bubble.offsetWidth; bubble.classList.add('pop');
    /* text 曾经是个死参数：取到之后直接 return，什么也不做 ——
     * 于是开局那两句「准备好了吗？」「随时开始。」从来没显示过。
     * 现在真正写进气泡；传 undefined 时保持原样（调用方只更新 who / 样式）。 */
    if (text !== undefined && text !== null) {
      const el = document.getElementById('bubble' + key + 'Text');
      if (el) el.textContent = String(text);
    }
  },

  /* ---------------- finish ---------------- */
  async finish(token) {
    this.running = false;
    Thinking.stop();
    const c = this.chess;
    Clock.stop();
    /* 终局：分析 Worker 与主搜索独立，必须在这里也停一次。
     * 只有 abort() 停是不够的 —— 正常走完（将死 / 和棋 / 步数上限）
     * 走的是 loop → finish 这条路，不经过 abort，评估会一直在后台跑。 */
    if (typeof Analysis !== 'undefined') Analysis.cancelAll('gameOver');
    EvalBar.thinking = false;
    let result, winner = null;
    if (this.agreedDraw) { result = { type: 'agreement' }; this.agreedDraw = false; }
    else if (this.flagWinner) { winner = this.flagWinner; result = { type: 'timeout', winner }; this.flagWinner = null; }
    else if (this.resignWinner) { winner = this.resignWinner; result = { type: 'resign', winner }; this.resignWinner = null; }
    else if (c.in_checkmate()) { winner = c.turn() === 'w' ? 'b' : 'w'; result = { type: 'checkmate', winner }; }
    else if (c.in_stalemate()) result = { type: 'stalemate' };
    else if (c.insufficient_material()) result = { type: 'material' };
    else if (c.in_threefold_repetition()) result = { type: 'repetition' };
    else if (c.in_draw()) result = { type: 'draw' };
    else result = { type: 'maxmoves' };
    if (this.result && this.result.type === 'maxmoves') result = { type: 'maxmoves' };
    this.result = result;

    const title = winner ? (winner === 'w' ? '白方胜利' : '黑方胜利') : '平局';
    const subMap = {
      checkmate: '将死 · CHECKMATE', stalemate: '逼和 · STALEMATE', material: '子力不足 · INSUFFICIENT MATERIAL',
      repetition: '三次重复 · REPETITION', draw: '和棋 · DRAW', maxmoves: '达到步数上限 · MAX MOVES',
      resign: '对手认输 · RESIGN', timeout: '超时判负 · TIME OUT',
      agreement: '双方同意和棋 · DRAW AGREED'
    };
    if (winner) { Sound.win(); this.setPortraitExpr(winner, 'win'); this.setPortraitExpr(winner === 'w' ? 'b' : 'w', 'sad'); }
    else { Sound.lose(); this.setPortraitExpr('w', 'sad'); this.setPortraitExpr('b', 'sad'); }

    await runSleep(Settings.pace() === 'skip' ? 120 : 500, token);
    if (token !== undefined && !Run.isLive(token)) return;

    // 台词总结
    const quotes = { w: null, b: null };
    const pgn = c.pgn();
    for (const color of ['w', 'b']) {
      const pl = this.players[color];
      const won = winner === color;
      const fallback = result.type === 'agreement' ? '和棋，就这样吧。'
        : (result.type === 'checkmate' || result.type === 'timeout' || result.type === 'resign')
        ? (won ? charTaggedLine(pl.char, 'win') : charTaggedLine(pl.char, 'lose'))
        : '这盘就这样吧。';
      quotes[color] = fallback;
      if (pl.api && Settings.pace() !== 'skip') {
        try {
          const user = `最终局面：${c.fen()}
结果：${title}（${subMap[result.type]}）
完整棋谱 PGN：
${pgn}
请用一句符合你人格的赛后总结（30 字内），返回 {"thought":"..."}。`;
          const out = await API.chat(pl.api, (pl.char.prompt || genPrompt(pl.char)) + '\n本次只生成赛后总结，不要返回 move。', user, {
            temperature: this.temp, maxTokens: 80, timeout: ApiContract.DEFAULT_TIMEOUT
          });
          if (token !== undefined && !Run.isLive(token)) return;
          const obj = parseModelJSON(out);
          if (obj && obj.thought) quotes[color] = ApiContract.cleanThought(obj.thought, ApiContract.THOUGHT_MAX);
        } catch (e) {
          if (Run.isAbortError(e)) return;
        }
      }
    }
    if (token !== undefined && !Run.isLive(token)) return;
    UI.showResult({ title, sub: subMap[result.type] || result.type, quotes, winner });
  },

  snapshot() {
    return {
      id: uid('rec'),
      date: nowISO(),
      mode: this.mode,
      result: this.result ? this.result.type : 'aborted',
      winner: this.result ? this.result.winner || null : null,
      white: { charId: this.players.w.char.id, name: this.players.w.char.name, api: this.players.w.api ? this.players.w.api.name : '本地' },
      black: { charId: this.players.b.char.id, name: this.players.b.char.name, api: this.players.b.api ? this.players.b.api.name : '本地' },
      moves: this.moves.filter((m) => m && m.uci).map((m) => ({ color: m.color, san: m.san, uci: m.uci, fen: m.fen, thought: m.thought, source: m.source, cap: m.cap, check: m.check })),
      pgn: this.chess.pgn(),
      clock: Clock.enabled ? { preset: this.clockPreset, main: Clock.main, inc: Clock.inc, left: { w: Math.round(Clock.remaining.w), b: Math.round(Clock.remaining.b) } } : null,
      duration: Math.round((Date.now() - this.startedAt) / 1000)
    };
  }
};

/* =====================================================================
 * 15 · THINKING INDICATOR
 * ===================================================================== */
const Thinking = {
  start(color) {
    const d = $('#thinkDots'); if (d) d.style.display = 'inline-block';
    this.color = color;
    const side = color === 'w' ? 'L' : 'R';
    const b = document.getElementById('bubble' + side);
    if (b) { b.classList.add('think'); document.getElementById('who' + side).textContent = '…'; }
    const t = document.getElementById('bubble' + side + 'Text');
    if (t) t.textContent = '思考中';
  },
  stop() { const d = $('#thinkDots'); if (d) d.style.display = 'none'; }
};
