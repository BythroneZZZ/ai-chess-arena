/* =====================================================================
 * 12b · ANALYSIS ENGINE —— 第二 Stockfish Worker（方案 A）
 *
 * 为什么单独一个 Worker：
 *   主搜索（Engine）被 AI 走子独占。若把评估插进同一个 Worker，AI 思考时
 *   评估会卡住，或者插空的 `go` 会把主搜索打断。用户明确「不拘泥体积，
 *   优先最佳效果」，因此开第二份引擎，代价是多 ~1.5MB 源码 → Blob Worker。
 *
 * 不变量（与 Engine 完全一致的收尾纪律）：
 *   1. 每个 job 的 Promise 必在「bestmove / 超时 / 抢占 / 出错」之一结算。
 *   2. `stop` 之后有 260ms 静默期（_quietUntil），期内不发新 `go`，
 *      否则新搜索会被上一次的收尾 bestmove 立刻打断。
 *   3. 评估允许「部分结果结算」：被 stop 时用最后一次 `info score` 结算，
 *      这正是实时评估想要的语义（半分结果也比没有强）。
 *   4. live job 可被新的 live job 抢占；review job 抢占 live job（复盘优先）。
 *   5. 绝不 setoption Threads —— 该 asm.js 构建设了 Threads 会静默停止输出。
 * ===================================================================== */
const ANALYSIS_URL = (typeof ENGINE_URL === 'string') ? ENGINE_URL : './assets/vendor/stockfish.js';

/* live：够快才叫「实时」。用大 depth + 超时截断，拿部分解。 */
const ANALYSIS_LIVE_DEPTH = 24;
const ANALYSIS_LIVE_MS = 480;
/* review：逐手分析，慢一点无所谓，但要跨步一致。 */
const ANALYSIS_REVIEW_DEPTH = 14;
const ANALYSIS_REVIEW_MS = 1400;
/* stop 后的静默期（与 Engine 同值，见 06_engine.js） */
const ANALYSIS_QUIET_MS = 260;
/* stop 之后等引擎收尾的宽限。已出过分时根本不用等（直接结算），
 * 这个值只服务「一条 info 都没吐」的异常路径。 */
const ANALYSIS_GRACE_MS = 200;
/* 缓存上限：一局 120 手 → 121 个局面，留足余量 */
const ANALYSIS_CACHE_MAX = 700;

const Analysis = {
  worker: null,
  ready: false,
  failed: false,
  failedReason: '',
  initPromise: null,
  current: null,          // 正在搜索的 job
  queue: [],
  epoch: 0,
  _quietUntil: 0,
  _synced: true,      // true=已同步或无需同步；false=待 isready；null=正在等 readyok
  _timer: null,
  _liveTimer: null,
  _lastLiveFen: null,
  cache: new Map(),
  onScore: null,          // (result) => void，live 过程中的流式回调
  stats: { done: 0, cancelled: 0, live: 0 },

  /* 评估开关：关闭时整条链路静默（不建 Worker、不排队） */
  enabled() {
    try { return typeof Settings === 'undefined' ? true : Settings.evalOn(); }
    catch (e) { return true; }
  },

  init() {
    if (this.initPromise) return this.initPromise;
    this.initPromise = new Promise(async (resolve) => {
      let settled = false;
      const done = (ok) => { if (settled) return; settled = true; resolve(ok); };
      try {
        /* 复用主引擎那份源码（engineSource 内部缓存 Promise）。
         * 两个 Worker 实例必须各自 createObjectURL，见 06_engine.js 注释。 */
        const src = await engineSource();
        if (!src || src.length < 1000) throw new Error('analysis source empty');
        const url = URL.createObjectURL(new Blob([src], { type: 'application/javascript' }));
        /* 记下以便 terminate 时 revoke（自愈重建一次约 1.5MB，早先从不回收） */
        this._blobUrl = url;
        const w = new Worker(url);
        w.onmessage = (e) => {
          const d = typeof e.data === 'string' ? e.data : (e.data && e.data.data) || '';
          if (d) this.onLine(d);
        };
        w.onerror = (e) => {
          console.warn('[analysis] worker error', e && (e.message || e));
          this.fail('worker error');
          done(false);
        };
        this.worker = w;
        w.postMessage('uci');
        const t0 = Date.now();
        const wait = setInterval(() => {
          if (this.ready) { clearInterval(wait); done(true); }
          else if (this.failed) { clearInterval(wait); done(false); }
          else if (Date.now() - t0 > 12000) {
            clearInterval(wait);
            console.warn('[analysis] init timeout');
            this.fail('init timeout');
            done(false);
          }
        }, 80);
      } catch (err) {
        console.warn('[analysis init]', (err && err.message) || err);
        this.failed = true;
        this.failedReason = 'load';
        done(false);
      }
    });
    return this.initPromise;
  },

  fail(reason) {
    this.failed = true;
    this.ready = false;
    this.failedReason = reason;
    this.settleAll('analysis:' + reason);
  },

  /* 结算并清空全部 job，复位状态 */
  settleAll(reason) {
    clearTimeout(this._timer);
    this._timer = null;
    this._quietUntil = performance.now() + ANALYSIS_QUIET_MS;
    this._cancelSeq = (this._cancelSeq || 0) + 1;   // 取消信号：evaluate 靠它区分「被取消」与「引擎卡死」
    const jobs = this.queue.splice(0, this.queue.length);
    const cur = this.current;
    this.current = null;
    this.epoch++;
    const all = cur && !jobs.includes(cur) ? [cur, ...jobs] : jobs;
    for (const job of all) {
      if (job.done) continue;
      job.done = true;
      clearTimeout(job.timer);
      clearTimeout(job.graceTimer);
      clearTimeout(job.watchdog);
      this.stats.cancelled++;
      try { job.resolve(job.score ? this.resultOf(job, job.score) : null); } catch (e) { /* 忽略 */ }
    }
    Debug.log('[analysis] settled by', reason);
  },

  send(cmd) {
    if (!this.worker) return false;
    try { this.worker.postMessage(cmd); return true; }
    catch (e) { this.fail('postMessage failed'); return false; }
  },

  turnOf(fen) {
    const p = String(fen || '').split(' ');
    return p[1] === 'b' ? 'b' : 'w';
  },

  /* score 是「走子方视角」，统一折算成白方视角的厘兵分 */
  whiteCp(score, turn) {
    if (!score) return null;
    const sign = turn === 'w' ? 1 : -1;
    if (score.type === 'mate') {
      const n = Math.min(Math.abs(score.value), 60);
      const cp = 10000 - n * 10;
      return (score.value > 0 ? cp : -cp) * sign;
    }
    return score.value * sign;
  },

  label(res) {
    if (!res || !res.score) return '—';
    if (res.score.type === 'mate') {
      const n = Math.abs(res.score.value);
      const whiteMate = res.score.value * (res.turn === 'w' ? 1 : -1);
      return (whiteMate > 0 ? '#' : '-#') + n;
    }
    const cp = this.whiteCp(res.score, res.turn);
    const v = cp / 100;
    return (v > 0 ? '+' : '') + v.toFixed(1);
  },

  resultOf(job, score) {
    return {
      fen: job.fen,
      turn: job.turn,
      kind: job.kind,
      score: score || null,
      depth: job.depth || 0,
      best: job.best || null
    };
  },

  remember(fen, res) {
    if (!fen || !res) return;
    this.cache.set(fen, res);
    if (this.cache.size > ANALYSIS_CACHE_MAX) {
      const first = this.cache.keys().next();
      if (!first.done) this.cache.delete(first.value);
    }
  },

  onLine(line) {
    if (line === 'readyok') {
      /* isready 的应答：引擎已处理完此前发出的命令。
       *
       * 但这**不等于管道已排空** —— 实测顺序经常是：
       *     info depth 11 ... score cp 98     ← 上一个 job 的残留
       *     readyok                            ← 我们的握手应答
       *     bestmove f2f3                      ← 上一个 job 的收尾，还在路上
       * 此刻立刻发 go，新搜索的 info 会排在这条 bestmove 之后，
       * 结果 bestmove 被当成本 job 的结束信号（而它一分未得）。
       *
       * 对策：readyok 后再让管道静默一小段，然后才放行。
       * 80ms 是实测值：小于它偶发吞搜索，大于它纯浪费。 */
      this._synced = true;
      clearTimeout(this._timer);
      this._timer = setTimeout(() => {
        this._timer = null;
        this.flush();
      }, 80);
      return;
    }
    if (line === 'uciok') {
      this.ready = true;
      this.failed = false;
      // 只设 Hash。绝不设 Threads（会让该构建静默停止输出）。
      this.send('setoption name Hash value 32');
      this.flush();
      return;
    }

    if (line.startsWith('bestmove')) {
      const job = this.current;
      if (!job) return;                       // 迟到的收尾消息 → 丢弃
      /* 这条 bestmove 未必属于当前 job。
       *
       * 引擎被 stop 后会补发一条收尾 bestmove；如果它恰好落在下一个 job 的
       * go 之后才被处理，就会被当成本 job 的结果 —— 表现为「耗时 0ms、
       * 一条 info 都没有、返回空值」，而后台真正的搜索还在跑。
       *
       * 判据：本 job 至少吐过一条 score 才认这条 bestmove。
       * 没吐过说明这条属于上一个（已死的）搜索，直接忽略，等自己的结果。 */
      if (!job.score) return;
      const mv = line.split(/\s+/)[1];
      if (mv && mv !== '(none)') job.best = job.best || mv;
      this.finish(job, job.score);
      return;
    }

    const job = this.current;
    if (!job) return;

    const m = line.match(/score (cp|mate) (-?\d+)/);
    if (m) {
      /* score 只认「本 job 发 go 之后」的。
       *
       * 实测踩坑：上一个 job 的 info 可能与 isready 的 readyok 交错到达，
       * 顺序是 `score cp 98（上一局）→ readyok → bestmove f2f3（上一局）`。
       * 若此时 current 已经指向新 job，那条旧 score 就会成为新 job 的分数 ——
       * 表现为「送杀局面读出 +1.0 这种无意义的分数」。
       * 时间戳闸门挡不住（旧行可能晚到），所以用「是否已经 readyok 放行」
       * 这个逻辑边界来判定：go 发出之后才开的接收窗口。 */
      if (!job.receiving) return;
      /* 还要挡住「上一个 job 的 depth 计数」污染。
       *
       * 残留行有个稳定特征：它的 depth 是**旧搜索的**，通常比本 job 已经
       * 收到的最大 depth 还小。正常搜索里 depth 单调不减，所以「depth 倒退」
       * 基本可以断定是上一局的残余。
       * 首个 score 不设限（job.depth 为 0），之后要求 depth ≥ 已记录值。 */
      const dNow = line.match(/\bdepth (\d+)/);
      const depthNow = dNow ? parseInt(dNow[1], 10) : 0;
      if (job.depth && depthNow && depthNow < job.depth) return;
      job.score = { type: m[1], value: parseInt(m[2], 10) };
      clearTimeout(job.watchdog);       // 已经出分，哨兵使命结束
      if (depthNow) job.depth = depthNow;
      const pv = line.match(/\bpv (\S+)/);
      if (pv) job.best = pv[1];
      if (job.kind === 'live' && this.onScore) {
        try { this.onScore(this.resultOf(job, job.score)); } catch (e) { /* 忽略 */ }
      }
    }
  },

  isQuiet() { return performance.now() < this._quietUntil; },

  finish(job, score) {
    if (!job || job.done) return;
    job.done = true;
    clearTimeout(job.timer);
    clearTimeout(job.graceTimer);
    clearTimeout(job.watchdog);
    if (this.current === job) this.current = null;
    const i = this.queue.indexOf(job);
    if (i >= 0) this.queue.splice(i, 1);
    /* 静默期只在「被 stop 之后」需要：那时引擎还会吐一条收尾 bestmove，
     * 期内发新 go 会被那条 bestmove 误当成新 job 的结果。
     *
     * 自然跑完（引擎自己出了 bestmove）不需要静默 —— 引擎已经空闲。
     * 早期版本无条件设静默，实测每步多付 ~170ms（174ms → 344ms），
     * 120 步的复盘白等 20 秒。
     *
     * 另外：已出过分再被 stop 的情况，收尾 bestmove 会紧跟最后一条 info。
     * 缩到 160ms 实测仍有 6/85 漏（见 probe_stress），改回满额静默 ——
     * 正确性优先于这几十毫秒，复盘慢一点无所谓。 */
    if (job.stopped) {
      this._quietUntil = performance.now() + ANALYSIS_QUIET_MS;
      this._synced = false;          // 静默期过后还要 isready 确认一次
    } else {
      this._quietUntil = 0;
    }
    this.stats.done++;
    if (score) {
      const res = this.resultOf(job, score);
      this.remember(job.fen, res);
      try { job.resolve(res); } catch (e) { /* 忽略 */ }
    } else {
      try { job.resolve(null); } catch (e) { /* 忽略 */ }
    }
    this.flush();
  },

  flush() {
    if (this.busyGuard()) return;
    if (!this.ready) return;
    if (!this.queue.some((j) => j && !j.done)) return;
    /* 静默期：上一个 job 是被 stop 掉的，引擎还会补发一条 bestmove。
     * 此刻发新 go，那条补发的消息可能被当成本 job 的结果。 */
    if (this.isQuiet()) {
      clearTimeout(this._timer);
      this._timer = setTimeout(() => { this._timer = null; this.flush(); }, 40);
      return;
    }
    /* isready 同步点：静默期只是「大概等了够久」，isready→readyok 才是
     * 「引擎确实处理完了此前全部命令」的硬保证。
     *
     * 关键细节（实测踩过）：不能在 readyok 之前就把 go 发出去。
     * 早先的写法是 send('isready') 后设个超时继续 flush，结果出现
     * 「readyok 与上一条 bestmove 一起到达、新 go 被吞掉」的竞争 ——
     * 表现为复盘的某个局面返回了**上一个局面的分数**（例如送杀局面
     * 读出 +1.0）。现在只发 isready，然后**干等 readyok**，
     * 由 onLine('readyok') 触发真正的 flush。 */
    if (this._synced === false) {
      this._synced = null;                       // 等待中，避免重复发
      this._syncSentAt = performance.now();
      this.send('isready');
      clearTimeout(this._timer);
      this._timer = setTimeout(() => {
        this._timer = null;
        /* readyok 没来也不能永远卡住：超时就当同步成功往下走，
         * 后面还有 watchdog 与 bestmove 归属校验兜底。 */
        if (this._synced === null) this._synced = true;
        this.flush();
      }, 600);
      return;
    }
    /* 兜底：_synced 处于 null（等 readyok）时上面的分支会一路 return，
     * 所有 job 全积压在队列 —— 表现为 busy=false 但 queue>0，
     * 从外部看就是「没有 job 在跑」，实际是握手卡住了。
     * （测试里正是这么暴露的：连发两个 job，300ms 后 busy 仍为 false。）
     * 加一道时间闸：等超过 800ms 还没 readyok，强制放行一次。 */
    if (this._synced === null) {
      const waited = performance.now() - (this._syncSentAt || 0);
      if (waited < 800) return;
      this._synced = true;
      Debug.log('[analysis] readyok timeout after', Math.round(waited), 'ms → force proceed');
    }
    /* 取出队首时要跳过「已结算但仍留在队列里」的僵尸 job。
     *
     * 它们来自 settleAll / abortJob 之后的竞态：job.done 已经是 true，
     * 但 splice 没跑到。若直接 shift 当活 job 用，会立刻收到上一条 bestmove
     * 并拿 null 去 resolve，表现是「耗时 0ms、没有任何 info、结果为空」。 */
    let job = null;
    while (this.queue.length) {
      const head = this.queue.shift();
      if (!head || head.done) continue;
      job = head;
      break;
    }
    if (!job) return;
    this.current = job;
    job.epoch = this.epoch;
    job.startedAt = performance.now();
    const ok1 = this.send('position fen ' + job.fen);
    const ok2 = this.send(job.cmd);
    if (!ok1 || !ok2) { this.current = null; this.finish(job, null); return; }
    /* 接收窗口从 go 发出这一刻开启。
     * onLine 里的 score 分支要求 job.receiving 为真，用来挡掉
     * 「上一个 job 的 info 迟到」这种污染（见 onLine 注释）。 */
    job.receiving = true;
    job.timer = setTimeout(() => this.abortJob(job, 'timeout'), job.timeout);
    /* 启动哨兵：go 已发出但引擎一行 info 都没吐。
     *
     * 实测根因：上一个 job 被 stop 后，那条 stop 有时落在新 job 的 go **之后**
     * 才被引擎处理，于是新搜索刚起步就被立刻打断，整个 job 一条 info 都没有、
     * 也不会有 bestmove，最后只能靠宽限硬结算 → 复盘出现「拿不到评估」的空洞。
     *
     * 对策：发 go 后 120ms 内若连一条 score 都没有，判定为撞上 stop 残影。
     * 注意这里**不重排队列**（早先 unshift 重发会把队列顺序搅乱，
     * 反而让多个 job 同时命中同一条 bestmove）。改为原地重发同一条命令，
     * 且只重试一次。 */
    clearTimeout(job.watchdog);
    job.watchdog = setTimeout(() => {
      if (job.done || this.current !== job) return;
      if (job.score) return;                       // 已正常出分
      if (job.retried) {
        Debug.log('[analysis] no output after retry; letting timeout settle');
        return;
      }
      job.retried = true;
      Debug.log('[analysis] no info after 120ms → resend in place');
      this.send('stop');                           // 先确保引擎停手
      setTimeout(() => {
        if (job.done || this.current !== job) return;
        this.send('position fen ' + job.fen);
        this.send(job.cmd);
        clearTimeout(job.timer);
        job.timer = setTimeout(() => this.abortJob(job, 'timeout'), job.timeout);
      }, ANALYSIS_QUIET_MS);
    }, 120);
  },

  busyGuard() { return !!this.current; },

  /* 抢占：让引擎停手，用最后一次 info 结算（部分结果） */
  abortJob(job, reason) {
    if (!job || job.done) return;
    job.stopping = true;
    job.stopped = true;          // 是 stop 触发的收尾，finish 时要进静默期
    clearTimeout(job.watchdog);
    /* 已经出过分就没什么好等的：stop 之后引擎即使补发 bestmove，
     * 我们手上的 score 也已经够用。直接结算，省掉一整段宽限。
     *
     * 只有在「一条 info 都没吐」时才需要等 —— 那种情况下引擎可能正在
     * 深算、或在处理上一条 stop，给它一点时间。 */
    if (job.score) {
      this.finish(job, job.score);
      return;
    }
    this.send('stop');
    clearTimeout(job.graceTimer);
    job.graceTimer = setTimeout(() => {
      if (job.done) return;
      if (this.current === job) this.current = null;
      Debug.log('[analysis] force settle (' + (reason || 'preempt') + ')');
      this.finish(job, job.score);
    }, ANALYSIS_GRACE_MS);
  },

  /* 底层排队：review 插队到最前，live 排到末尾 */
  request(fen, kind, depth, timeout) {
    return new Promise((resolve) => {
      const job = {
        fen, kind, cmd: 'go depth ' + depth, timeout,
        resolve, done: false, score: null, best: null, depth: 0,
        turn: this.turnOf(fen), epoch: this.epoch
      };
      const start = () => {
        if (job.done) return;
        if (kind === 'review') {
          this.queue.unshift(job);
          // 复盘优先：正在跑的 live 让位（部分结果已足够画条）
          if (this.current && this.current.kind === 'live') this.abortJob(this.current, 'preempt');
        } else {
          this.queue.push(job);
        }
        this.flush();
      };
      if (this.failed && !this.worker) { job.done = true; resolve(null); return; }
      if (!this.ready) {
        this.init().then((ok) => { if (!ok) { job.done = true; resolve(null); return; } start(); });
        return;
      }
      start();
    });
  },

  /* 实时评估：合并请求，只保留最新局面 */
  live(fen) {
    if (!fen || this.failed || !this.enabled()) return;
    if (this._lastLiveFen === fen && this.current && this.current.fen === fen) return;

    const cached = this.cache.get(fen);
    if (cached && this.onScore) { try { this.onScore(cached); } catch (e) { /* 忽略 */ } }

    this._lastLiveFen = fen;
    /* 队列里的旧 live 任务必须「结算后丢弃」，不能直接 filter 掉。
     *
     * 直接过滤会让那几个 job 的 Promise 永远不 resolve ——
     * 拿着它们的调用方（以及 Review 的 await）就永久挂住。
     * 实测：两个 live 排队后再 live(新局面)，第二个再也回不来。 */
    const stale = this.queue.filter((j) => j.kind === 'live' && j.fen !== fen);
    if (stale.length) {
      this.queue = this.queue.filter((j) => !stale.includes(j));
      for (const j of stale) {
        if (j.done) continue;
        j.done = true;
        clearTimeout(j.timer);
        clearTimeout(j.graceTimer);
        this.stats.cancelled++;
        try { j.resolve(j.score ? this.resultOf(j, j.score) : null); } catch (e) { /* 忽略 */ }
      }
    }
    if (this.current && this.current.kind === 'live' && this.current.fen !== fen) {
      this.abortJob(this.current, 'supersede');
    }
    clearTimeout(this._liveTimer);
    this._liveTimer = setTimeout(() => {
      this._liveTimer = null;
      this.stats.live++;
      this.request(fen, 'live', ANALYSIS_LIVE_DEPTH, ANALYSIS_LIVE_MS);
    }, 110);
  },

  /* 取一次评估（复盘用）。足够深的缓存直接复用，避免重复搜索。
   * 注意：live 阶段只跑 480ms，缓存往往只有 depth 12~16 的部分结果；
   * 复盘要求一致性，所以用 minDepth 卡缓存门槛，不够深就重算。
   *
   * 自带一次引擎自愈：该 asm.js 构建在「stop 来得太密」时会进入半死状态
   * （后续 go 只吐 1~2 条 info 就不再输出，重启才恢复）。
   * 实测 85 次里出现 2~4 次；重启后同一局面立刻能算。 */
  async evaluate(fen, opt) {
    const o = opt || {};
    const depth = o.depth || ANALYSIS_REVIEW_DEPTH;
    const timeout = o.timeout || ANALYSIS_REVIEW_MS;
    const minDepth = o.minDepth || Math.max(4, depth - 2);
    if (!o.fresh) {
      const c = this.cache.get(fen);
      if (c && c.score && c.depth >= minDepth) return c;
    }
    const kind = o.kind || 'review';
    /* 用一个显式的取消信号判断，而不是比 epoch ——
     * restart() 自己也会推进 epoch，拿 epoch 比会把「自愈中」误判成「已取消」。 */
    this._cancelSeq = this._cancelSeq || 0;
    const cancelSeq0 = this._cancelSeq;
    let res = await this.request(fen, kind, depth, timeout);

    /* 半死状态判定与自愈。
     * 只对 review 做 —— live 掉了无所谓（下一次局面还会再来），
     * 而 review 掉一格就会让整份报告的准确率失真。
     *
     * 关键前提：**被取消不是卡死**。cancelAll / settleAll 都会递增 _cancelSeq，
     * 此时 request 拿回 null 属于正常语义，绝不能触发重启重算 ——
     * 那会让已经该结束的 Promise 永远挂着（调用方 await 不到结果）。 */
    if (kind === 'review' && (!res || !res.score) && this._cancelSeq === cancelSeq0) {
      this.stats.stuck = (this.stats.stuck || 0) + 1;
      Debug.log('[analysis] empty result → restarting worker (stuck #' + this.stats.stuck + ')');
      await this.restart();
      if (this._cancelSeq !== cancelSeq0) return null;   // 自愈期间又被取消
      res = await this.request(fen, kind, depth, timeout);
      if (res && res.score) this.stats.recovered = (this.stats.recovered || 0) + 1;
    }
    return res;
  },

  /* 对局离场 / 新局：清掉一切在途评估 */
  cancelAll(reason) {
    clearTimeout(this._liveTimer);
    this._liveTimer = null;
    this._lastLiveFen = null;
    if (this.current) this.send('stop');
    this.settleAll(reason || 'cancelAll');
  },

  /* 释放 Worker 的 Blob URL */
  revokeBlob() {
    if (this._blobUrl) {
      try { URL.revokeObjectURL(this._blobUrl); } catch (e) { /* 忽略 */ }
      this._blobUrl = null;
    }
  },

  async restart() {
    /* restart() 内部也会走 settleAll（推进 _cancelSeq）。但 restart 是
     * 「自愈」的一部分，不是「调用方撤销」—— 所以退出时要把序号还原，
     * 否则 evaluate 里的自愈逻辑会把自己的重启误判成外部取消。 */
    const seq = this._cancelSeq || 0;
    this.settleAll('restart');
    this._cancelSeq = seq;
    try { if (this.worker) this.worker.terminate(); } catch (e) { /* 忽略 */ }
    this.revokeBlob();
    this.worker = null;
    this.ready = false;
    this.failed = false;
    this.failedReason = '';
    this.initPromise = null;
    this._quietUntil = 0;
    this._synced = true;
    return this.init();
  },

  /* 彻底释放 Worker（关掉评估开关时用）。
   * 与 restart() 的区别：不重新初始化，下次真正需要时由 ensure() 惰性建。 */
  release() {
    this.settleAll('release');
    try { if (this.worker) this.worker.terminate(); } catch (e) { /* 忽略 */ }
    this.revokeBlob();
    this.worker = null;
    this.ready = false;
    this.failed = false;
    this.failedReason = '';
    this.initPromise = null;
    this.cache.clear();
    this._quietUntil = 0;
    this.onScore = null;
  },

  /* 惰性拿引擎：关过开关再打开时，首次调用要能自动重建 */
  ensure() {
    if (this.ready) return Promise.resolve(true);
    if (this.worker && this.initPromise) return this.initPromise;
    return this.init();
  },

  /* 测试 / 调试用：当前状态快照 */
  snapshot() {
    return {
      ready: this.ready, failed: this.failed, busy: !!this.current,
      queue: this.queue.length, epoch: this.epoch,
      stats: Object.assign({}, this.stats), cache: this.cache.size
    };
  }
};

/* =====================================================================
 * 12c · EVAL BAR —— 像素评估条
 *
 * 视觉约束：不用系统控件、不用圆角/渐变。用 canvas 画 4px 抖动网格，
 * 上半黑方、下半白方，分界线用金色 2px 硬线。宽度按 16/22 两档整数。
 * ===================================================================== */
const EvalBar = {
  cv: null,
  ctx: null,
  w: 22,
  h: 480,
  cp: 0,          // 白方视角厘兵
  mate: 0,        // >0 白方将死对方，<0 反之
  text: '0.0',
  depth: 0,
  lastAt: 0,
  pendingRes: null,
  _raf: null,
  visible: true,
  flipped: false, // 与棋盘方向一致：翻转时白方在上
  thinking: false, // AI 长考期间，用主 Worker 的 info score 顶一下

  init() {
    if (this.cv) return;
    this.cv = document.getElementById('evalCanvas');
    if (!this.cv) return;
    this.ctx = this.cv.getContext('2d');
    this.w = this.cv.width || 22;
    this.h = this.cv.height || 480;
    const col = document.getElementById('evalCol');
    this.visible = !(col && col.classList.contains('off'));
    this.draw();
  },

  /* 评估条在棋盘旁占的横向空间（canvas + padding + border），
   * fitBoard() 必须用同一个数算棋盘尺寸，否则窄屏会差几像素顶出去。
   *   宽 ≤380：canvas 12 + padding 2×2 + border 3×2 = 22
   *   宽 ≤520：canvas 16 + padding 2×3 + border 3×2 = 28
   *   其他  ：canvas 22 + padding 2×4 + border 3×2 = 36 */
  canvasW() {
    const vw = (typeof window !== 'undefined' && window.innerWidth) || 1024;
    if (vw <= 380) return 12;
    if (vw <= 520) return 16;
    return 22;
  },

  /* 连同边框在内占用的宽度，棋盘布局用 */
  outerW() {
    const vw = (typeof window !== 'undefined' && window.innerWidth) || 1024;
    const pad = vw <= 380 ? 2 : vw <= 520 ? 3 : 4;
    return this.canvasW() + pad * 2 + 6;
  },

  /* 棋盘尺寸变化时同步：宽度在窄屏收窄，高度永远跟随棋盘 */
  resize(boardSize) {
    if (!this.cv) this.init();
    if (!this.cv) return;
    const w = this.canvasW();
    const h = clamp(Math.round(boardSize || 480), 120, 900);
    if (w === this.w && h === this.h) { this.draw(); return; }
    this.w = w; this.h = h;
    this.cv.width = w;
    this.cv.height = h;
    this.cv.style.width = w + 'px';
    this.cv.style.height = h + 'px';
    this.draw();
  },

  /* 按当前棋盘实测尺寸对齐（进对局、窗格缩放、复位后都走这里） */
  syncToBoard(view) {
    if (!view) return;
    this.flipped = !!view.flipped;
    this.resize(view.size);
  },

  setVisible(on) {
    this.visible = !!on;
    const col = document.getElementById('evalCol');
    if (col) col.classList.toggle('off', !this.visible);
    if (this.visible) { this.resize(this.h); this.syncLabel(); }
  },

  /* 白方份额：0 = 全黑，1 = 全白 */
  ratio() {
    if (this.mate) return this.mate > 0 ? 1 : 0;
    const cp = clamp(this.cp, -1500, 1500);
    return 1 / (1 + Math.pow(10, -cp / 400));
  },

  apply(res) {
    if (!res || !res.score) return;
    if (!this.visible) return;
    this.pendingRes = res;
    const now = performance.now();
    if (now - this.lastAt < 70) {
      if (!this._raf) {
        this._raf = requestAnimationFrame(() => { this._raf = null; this.commit(); });
      }
      return;
    }
    this.commit();
  },

  /* 跳过节流立即生效：尺寸变化、开关切换、测试断言都用它，
   * 避免「数据已到但画面还差一帧」的读旧值问题。 */
  applyNow(res) {
    if (!res || !res.score) return;
    this.pendingRes = res;
    if (this._raf) { cancelAnimationFrame(this._raf); this._raf = null; }
    this.lastAt = 0;
    this.commit();
  },

  commit() {
    const res = this.pendingRes;
    if (!res) return;
    this.lastAt = performance.now();
    this.cp = Analysis.whiteCp(res.score, res.turn);
    this.mate = res.score.type === 'mate' ? res.score.value * (res.turn === 'w' ? 1 : -1) : 0;
    this.depth = res.depth || 0;
    this.text = Analysis.label(res);
    this.draw();
    this.syncLabel();
  },

  syncLabel() {
    const num = document.getElementById('evalNum');
    const inline = document.getElementById('evalInline');
    const up = this.cp > 0;
    const down = this.cp < 0;
    [num, inline].forEach((el) => {
      if (!el) return;
      el.textContent = this.text;
      el.classList.toggle('down', down);
      el.classList.toggle('up', up);
    });
    if (this.cv) {
      this.cv.setAttribute('aria-label',
        '局面评估 ' + this.text + '（正数白方占优，负数黑方占优，' + (this.depth ? '深度 ' + this.depth : '计算中') + '）');
    }
    const wrap = document.getElementById('evalCol');
    if (wrap) wrap.setAttribute('title', '局面评估 ' + this.text);
  },

  reset() {
    this.cp = 0; this.mate = 0; this.text = '0.0'; this.depth = 0;
    this.pendingRes = null;
    this.lastAt = 0;
    if (this._raf) { cancelAnimationFrame(this._raf); this._raf = null; }
    this.draw();
    this.syncLabel();
  },

  draw() {
    const g = this.ctx;
    if (!g) return;
    const W = this.w, H = this.h;
    g.imageSmoothingEnabled = false;
    g.clearRect(0, 0, W, H);

    const x0 = 3, y0 = 3;
    const iw = W - 6, ih = H - 6;
    if (iw <= 0 || ih <= 0) return;

    g.fillStyle = '#07060d';
    g.fillRect(0, 0, W, H);

    const whiteH = Math.round(ih * this.ratio());

    /* 白方份额贴棋盘方向：默认白在下，翻转后白在上 */
    const whiteTop = this.flipped;
    const wy = whiteTop ? y0 : y0 + (ih - whiteH);
    const by = whiteTop ? y0 + whiteH : y0;
    const bh = ih - whiteH;

    /* 黑方区域：深紫 + 4px 棋盘格抖动 */
    if (bh > 0) {
      g.fillStyle = '#1a1430';
      g.fillRect(x0, by, iw, bh);
      g.fillStyle = '#241c47';
      for (let y = by; y < by + bh; y += 4) {
        for (let x = x0 + (((y - by) / 4) % 2 ? 0 : 2); x < x0 + iw; x += 4) {
          g.fillRect(x, y, 2, 2);
        }
      }
    }

    /* 白方区域：亮紫 + 网格高光 */
    if (whiteH > 0) {
      g.fillStyle = '#c2b9e4';
      g.fillRect(x0, wy, iw, whiteH);
      g.fillStyle = '#ece8ff';
      for (let y = wy; y < wy + whiteH; y += 4) {
        for (let x = x0 + (((y - wy) / 4) % 2 ? 2 : 0); x < x0 + iw; x += 4) {
          g.fillRect(x, y, 2, 1);
        }
      }
    }

    /* 分界线：金色 2px 硬线（无渐变） */
    g.fillStyle = '#ffcc4d';
    const lineY = clamp(whiteTop ? wy + whiteH - 1 : wy - 1, y0, y0 + ih - 2);
    g.fillRect(x0, lineY, iw, 2);
    g.fillStyle = '#7a5f1e';
    g.fillRect(x0, lineY + 2, iw, 1);

    /* 刻度：25% / 50% / 75%，1px 硬线 */
    g.fillStyle = 'rgba(7,6,13,.55)';
    [0.25, 0.5, 0.75].forEach((k) => {
      const y = Math.round(y0 + ih * k);
      g.fillRect(x0 + iw - 5, y, 5, 1);
    });

    /* 中线（均势）标记：外侧小三角 */
    const midY = Math.round(y0 + ih / 2);
    g.fillStyle = '#8b7de0';
    g.fillRect(x0 + iw - 3, midY - 2, 3, 5);

    /* 边框外阴影：右下 1px 硬阴影，延用 panel 语言 */
    g.fillStyle = 'rgba(0,0,0,.55)';
    g.fillRect(1, H - 1, W - 1, 1);
    g.fillRect(W - 1, 1, 1, H - 1);
  }
};
