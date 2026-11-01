/* =====================================================================
 * 24 · CLOCK — 棋钟（Fischer 增量）
 *
 * 与异步模型的契约：
 *   1. 只有「轮到走子的一方」的钟在走，AI 思考时间计入它自己的钟。
 *   2. 每走完一步，该方立刻获得增量（Fischer 规则）。
 *   3. 暂停 / 单步 / 离场 / 终局都必须停表，绝不留下运行的 interval。
 *   4. 超时回调只记录胜方并走 Game 的 abort 路径，不在这里直接改局面。
 * ===================================================================== */
const Clock = {
  enabled: false,
  main: 0,
  inc: 0,
  remaining: { w: 0, b: 0 },
  running: null,        // 'w' | 'b' | null
  lastTickAt: 0,
  timer: null,
  pausedSide: null,
  onFlag: null,

  PRESETS: {
    unlimited: { main: 0, inc: 0, label: '不限时' },
    blitz3: { main: 3 * 60000, inc: 2000, label: '3+2 闪电' },
    blitz5: { main: 5 * 60000, inc: 0, label: '5+0 快棋' },
    rapid10: { main: 10 * 60000, inc: 5000, label: '10+5 快棋' },
    classic15: { main: 15 * 60000, inc: 10000, label: '15+10 经典' }
  },

  setPreset(key) {
    const p = this.PRESETS[key] || this.PRESETS.unlimited;
    Store.settings.clockPreset = key;
    Store.saveSettings();
    return p;
  },

  /* 开局初始化。onFlag(colorThatRanOut) 由 Game 提供 */
  start(presetKey, onFlag) {
    const p = this.PRESETS[presetKey] || this.PRESETS.unlimited;
    this.main = p.main;
    this.inc = p.inc;
    this.enabled = p.main > 0;
    this.remaining = { w: p.main, b: p.main };
    this.running = null;
    this.pausedSide = null;
    this.lastTickAt = 0;
    this.onFlag = onFlag || null;
    this.render();
    this.stopTimer();
    if (!this.enabled) return;
    this.startTimer();
  },

  startTimer() {
    this.stopTimer();
    this.timer = setInterval(() => this.tick(), 100);
  },

  stopTimer() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  },

  /* 轮到 color 走子 */
  beginTurn(color) {
    if (!this.enabled) return;
    this.running = color;
    this.pausedSide = null;
    this.lastTickAt = performance.now();
    this.render();
  },

  /* 该方走完子：加增量并停表 */
  endTurn(color) {
    if (!this.enabled) return;
    if (this.running === color) {
      this.settle();                   // 先结算本段耗时
      this.running = null;
      if (this.remaining[color] > 0) this.remaining[color] += this.inc;
      this.render();
    }
  },

  /* 结算自上次 tick 以来的耗时 */
  settle() {
    if (!this.running) return;
    const now = performance.now();
    const delta = now - this.lastTickAt;
    this.lastTickAt = now;
    if (delta > 0) {
      const c = this.running;
      this.remaining[c] = Math.max(0, this.remaining[c] - delta);
    }
  },

  tick() {
    if (!this.enabled || !this.running) return;
    this.settle();
    const c = this.running;
    this.render();
    if (this.remaining[c] <= 0) {
      this.running = null;
      this.stopTimer();
      this.render();
      if (this.onFlag) this.onFlag(c);
    }
  },

  /* 暂停：保留是哪一方，恢复时续上 */
  pause() {
    if (!this.enabled || !this.running) return;
    this.settle();
    this.pausedSide = this.running;
    this.running = null;
    this.render();
  },

  resume() {
    if (!this.enabled || this.running || !this.pausedSide) return;
    this.running = this.pausedSide;
    this.pausedSide = null;
    this.lastTickAt = performance.now();
    this.render();
  },

  /* 终局 / 离场：彻底停表 */
  stop() {
    this.running = null;
    this.pausedSide = null;
    this.stopTimer();
  },

  remainingOf(color) {
    if (!this.enabled) return Infinity;
    return Math.max(0, this.remaining[color] || 0);
  },

  isLow(color) {
    return this.enabled && this.remainingOf(color) <= 20000;
  },

  format(ms) {
    if (!this.enabled) return '—';
    const total = Math.max(0, ms);
    const m = Math.floor(total / 60000);
    const s = Math.floor((total % 60000) / 1000);
    const tenth = Math.floor((total % 1000) / 100);
    if (total < 20000) return `${m}:${String(s).padStart(2, '0')}.${tenth}`;
    return `${m}:${String(s).padStart(2, '0')}`;
  },

  render() {
    ['L', 'R'].forEach((side) => {
      const color = side === 'L' ? 'w' : 'b';
      const el = document.getElementById('clock' + side);
      if (!el) return;
      if (!this.enabled) { el.classList.add('hidden'); return; }
      el.classList.remove('hidden');
      el.textContent = this.format(this.remaining[color]);
      const active = this.running === color;
      el.classList.toggle('active', active);
      el.classList.toggle('low', this.isLow(color));
    });
  }
};
