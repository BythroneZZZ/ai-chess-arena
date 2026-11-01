/* =====================================================================
 * 12 · STOCKFISH ENGINE  (inline asm.js build → blob worker, no network)
 *
 * 显式状态机：
 *   idle ──bestMove()──▶ queued ──flush()──▶ searching ──bestmove──▶ idle
 *     ▲                                        │
 *     └──────────── cancelAll() / error ───────┘
 *
 * 不变量：
 *   1. 每个 job 的 Promise 必然在「收到 bestmove / 超时 / 取消 / 出错」之一时结算。
 *   2. busy 只在「当前 job 结算」时复位，且只有 flush 能把它置 true。
 *   3. cancelAll() 后 queue 为空、busy 为 false，迟到的 bestmove 被丢弃。
 * ===================================================================== */
const ENGINE_URL = './assets/vendor/stockfish.js';

/* =====================================================================
 * 引擎源码：全项目共享一次拉取
 *
 * 为什么需要这个：
 *   Engine 与 Analysis 各要一个 Worker 实例（要并行算，不能共用一个），
 *   但**源码只需拉一次**。原先两边各 fetch 一次，实测两次都走网络
 *   （python http.server 不发 Cache-Control，fromCache:false），
 *   等于白下载 1.5MB，还让同一份 1.5MB 字符串在内存里存两份。
 *
 * 约定：
 *   · 只缓存 Promise，失败时清空（允许重试）
 *   · Blob URL 不复用 —— 两个 Worker 各自 createObjectURL，
 *     复用同一个 URL 会让 terminate 一个时影响另一个的加载
 * ===================================================================== */
let _sfSrcPromise = null;
function engineSource() {
  if (_sfSrcPromise) return _sfSrcPromise;
  _sfSrcPromise = (async () => {
    /* 优先取内联常量（file:// 双击即玩模式由 build.py 注入），
     * 取不到再回退 fetch（HTTP 模式行为不变）。 */
    const inline = (typeof window !== 'undefined' && window.__SF_SRC) ? window.__SF_SRC : null;
    if (inline) return inline;
    const r = await fetch(ENGINE_URL);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.text();
  })().catch((e) => { _sfSrcPromise = null; throw e; });
  return _sfSrcPromise;
}

const Engine = {
  worker: null,
  ready: false,
  failed: false,
  busy: false,
  queue: [],
  current: null,        // 正在搜索的 job（= queue[0] 的引用）
  initPromise: null,
  epoch: 0,             // 每次 cancelAll 自增，用于丢弃迟到消息
  _drainTimer: null,

  init() {
    if (this.initPromise) return this.initPromise;
    this.initPromise = new Promise(async (resolve) => {
      const done = (ok) => {
        if (this._initDone) return;
        this._initDone = true;
        resolve(ok);
      };
      try {
        // 引擎源码由本地服务器提供（assets/vendor/stockfish.js），转 Blob Worker 启动。
        // file:// 下 fetch 会被同源策略拦死 —— 因此支持 build.py 注入的内联常量。
        const src = await engineSource();
        if (!src || src.length < 1000) throw new Error('engine source empty');
        const url = URL.createObjectURL(new Blob([src], { type: 'application/javascript' }));
        /* 记下 Blob URL，terminate 时一并 revoke。
         * Worker 构造完成后 URL 就可以释放（Worker 已持有源码副本），
         * 但保守起见留到 terminate —— 自愈重启一次本该回收 ~1.5MB，
         * 早先从不 revoke，重建几次就是几 MB 常驻。 */
        this._blobUrl = url;

        const w = new Worker(url);
        w.onmessage = (e) => {
          const d = typeof e.data === 'string' ? e.data : (e.data && e.data.data) || '';
          if (d) this.onLine(d);
        };
        w.onerror = (e) => {
          console.warn('[engine] worker error', e && (e.message || e));
          this.onFatal('worker error');
          done(false);
        };
        w.onmessageerror = () => {
          console.warn('[engine] message error');
          this.onFatal('message error');
        };
        this.worker = w;
        w.postMessage('uci');

        const t0 = Date.now();
        const wait = setInterval(() => {
          if (this.ready) { clearInterval(wait); done(true); }
          else if (this.failed) { clearInterval(wait); done(false); }
          else if (Date.now() - t0 > 12000) {
            clearInterval(wait);
            console.warn('[engine] init timeout');
            this.onFatal('init timeout');
            done(false);
          }
        }, 80);
      } catch (err) {
        console.warn('[engine init]', err);
        this.failed = true;
        done(false);
      }
    });
    return this.initPromise;
  },

  /* Worker 级别故障：所有等待中的 job 必须立刻结算为 null */
  onFatal(reason) {
    this.failed = true;
    this.ready = false;
    this._fatalReason = reason;
    this.drain('engine:' + reason);
  },

  /* 结算并清空所有 job，复位 busy */
  drain(reason) {
    clearTimeout(this._drainTimer);
    this._drainTimer = null;
    // stop 的收尾 bestmove 会在几十毫秒内到达；给引擎 260ms 静默期
    if (reason !== 'restart') this._quietUntil = performance.now() + 260;
    const jobs = this.queue.splice(0, this.queue.length);
    const cur = this.current;
    this.current = null;
    this.busy = false;
    this.epoch++;
    const all = cur && !jobs.includes(cur) ? [cur, ...jobs] : jobs;
    for (const job of all) {
      if (job.done) continue;
      job.done = true;
      clearTimeout(job.timer);
      clearTimeout(job.graceTimer);
      try { job.resolve(null); } catch (e) { /* 忽略 */ }
      Debug.log('[engine] job settled by', reason, job.fen.slice(0, 24));
    }
  },

  onLine(line) {
    if (line === 'uciok') {
      this.ready = true;
      this.failed = false;
      // 注意：不要设置 Threads / Threads>1。该 asm.js 构建在 setoption Threads 后会静默停止输出，
      // 表现为每次 go 都只能靠超时兜底。Hash 是安全的。
      this.send('setoption name Hash value 16');
      this.flush();
      return;
    }

    if (line.startsWith('bestmove')) {
      const mv = line.split(/\s+/)[1];
      const job = this.current || this.queue[0] || null;
      if (!job) return;                 // 迟到的消息，已无对应 job → 丢弃
      if (job.epoch !== this.epoch) {   // 属于已被取消的旧代次
        Debug.log('[engine] stale bestmove ignored');
        return;
      }
      if (this.queue[0] === job) this.queue.shift();
      this.current = null;
      this.busy = false;
      this.complete(job, mv && mv !== '(none)' ? mv : null);
      this.flush();
      return;
    }

    if (this.current && /score (cp|mate)/.test(line)) {
      const m = line.match(/score (cp|mate) (-?\d+)/);
      if (m) this.current.lastScore = { type: m[1], value: parseInt(m[2], 10) };
    }
  },

  complete(job, value) {
    if (job.done) return;
    job.done = true;
    clearTimeout(job.timer);
    clearTimeout(job.graceTimer);
    try { job.resolve(value); } catch (e) { /* 忽略 */ }
  },

  send(cmd) {
    if (!this.worker) return false;
    try { this.worker.postMessage(cmd); return true; }
    catch (e) { this.onFatal('postMessage failed'); return false; }
  },

  /* stop 之后引擎仍会执行一次 bestmove 收尾；此窗口内不要发新 go，否则会被立刻停掉 */
  _quietUntil: 0,
  isQuiet() { return performance.now() < this._quietUntil; },

  flush() {
    if (this.busy || !this.queue.length) return;
    if (!this.ready) return;             // 未就绪：等 uciok 后再 flush
    if (this.isQuiet()) {                // 静默期内延后 60ms 再试
      clearTimeout(this._drainTimer);
      this._drainTimer = setTimeout(() => { this._drainTimer = null; this.flush(); }, 60);
      return;
    }
    const job = this.queue[0];
    this.busy = true;
    this.current = job;
    job.epoch = this.epoch;
    const ok1 = this.send('position fen ' + job.fen);
    const ok2 = this.send(job.cmd);
    if (!ok1 || !ok2) { this.current = null; this.busy = false; this.complete(job, null); return; }

    job.timer = setTimeout(() => this.abortJob(job, 'timeout'), job.timeout);
  },

  /* 让引擎停手；若它不回应，宽限期后强制结算 */
  abortJob(job, reason) {
    if (job.done) return;
    this.send('stop');
    clearTimeout(job.graceTimer);
    job.graceTimer = setTimeout(() => {
      if (job.done) return;
      if (this.current === job) { this.current = null; this.busy = false; }
      const i = this.queue.indexOf(job);
      if (i >= 0) this.queue.splice(i, 1);
      Debug.log('[engine] force settle (' + reason + ')');
      this.complete(job, null);
      this.flush();
    }, 420);
  },

  bestMove(fen, depth, timeoutMs) {
    return new Promise((resolve) => {
      const job = {
        fen, cmd: `go depth ${depth}`,
        timeout: timeoutMs || 4000,
        resolve, done: false, epoch: this.epoch, lastScore: null
      };
      if (this.failed && !this.worker) { resolve(null); return; }
      if (!this.ready) {
        this.init().then((ok) => {
          if (!ok) { this.complete(job, null); return; }
          this.queue.push(job);
          this.flush();
        });
        return;
      }
      this.queue.push(job);
      this.flush();
    });
  },

  score() { return this.current ? this.current.lastScore : null; },

  /* 取消一切：队列清空、当前 job 结算、迟到消息作废 */
  stopAll() {
    if (!this.busy && !this.queue.length) {
      this.epoch++;                   // 仍然推进代次，丢弃可能的迟到 bestmove
      return;
    }
    this.send('stop');
    this.drain('stopAll');
  },

  /* 释放 Worker 的 Blob URL（重建 / 遗弃时调） */
  revokeBlob() {
    if (this._blobUrl) {
      try { URL.revokeObjectURL(this._blobUrl); } catch (e) { /* 忽略 */ }
      this._blobUrl = null;
    }
  },

  /* 彻底重建 worker（用于崩溃恢复） */
  async restart() {
    this.drain('restart');
    try { if (this.worker) this.worker.terminate(); } catch (e) { /* 忽略 */ }
    this.revokeBlob();
    this.worker = null;
    this.ready = false;
    this.failed = false;
    this.initPromise = null;
    this._initDone = false;
    this._quietUntil = 0;
    return this.init();
  }
};
