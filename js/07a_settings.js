/* =====================================================================
 * 20 · SETTINGS — 演出节奏 / 无障碍 / 安全策略
 * ===================================================================== */
const Settings = {
  pace() {
    const p = Store.settings.pace;
    return p === 'fast' || p === 'skip' ? p : 'full';
  },
  setPace(p) {
    Store.settings.pace = p;
    Store.saveSettings();
    this.applyBody();
    UI.toast(p === 'skip' ? '演出：仅棋步' : p === 'fast' ? '演出：快速' : '演出：完整');
    Sound.click();
  },
  cyclePace() {
    const order = ['full', 'fast', 'skip'];
    const i = order.indexOf(this.pace());
    this.setPace(order[(i + 1) % order.length]);
  },
  reducedMotion() {
    return !!Store.settings.reducedMotion || this.systemReducedMotion();
  },
  systemReducedMotion() {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; }
  },
  highContrast() { return !!Store.settings.highContrast; },
  /* 评估条开关：默认开。关掉时连第二 Worker 都不建（省一份 1.5MB 内存） */
  evalOn() { return Store.settings.evalBar !== false; },
  toggleEval() {
    Store.settings.evalBar = !this.evalOn();
    Store.saveSettings();
    if (!this.evalOn()) {
      if (typeof Analysis !== 'undefined') {
        Analysis.cancelAll('evalOff');
        /* 真正释放 Worker：早先只停任务不发 terminate，文案却说「已释放」，
         * 用户以为省了内存其实没有。这里做到底。 */
        Analysis.release();
      }
    }
    if (typeof EvalBar !== 'undefined') EvalBar.setVisible(this.evalOn());
    /* 重新打开：Worker 已被 release() 释放，得重建并重新挂回调，
     * 否则评估条再也不会更新（onScore 在 release 里被清掉了）。 */
    if (this.evalOn() && typeof Analysis !== 'undefined') {
      Analysis.onScore = (res) => { if (Run.isLive(Run.token())) EvalBar.apply(res); };
      Analysis.ensure().then((ok) => {
        if (ok && typeof Game !== 'undefined') Game.analyzePosition(Run.token());
      });
    }
    const btn = document.getElementById('btnEval');
    if (btn) btn.textContent = this.evalOn() ? '评估 ON' : '评估 OFF';
    UI.toast(this.evalOn() ? '评估条：开（第二 Worker 已启动）' : '评估条：关（分析 Worker 已释放）');
    Sound.click();
  },
  toggleContrast() {
    Store.settings.highContrast = !Store.settings.highContrast;
    Store.saveSettings();
    this.applyBody();
    UI.toast(Store.settings.highContrast ? '高对比模式：开' : '高对比模式：关');
    Sound.click();
  },
  applyBody() {
    document.body.classList.toggle('reduced-motion', this.reducedMotion());
    document.body.classList.toggle('high-contrast', this.highContrast());
    const lp = document.getElementById('paceLabel');
    if (lp) lp.textContent = this.pace() === 'skip' ? '演出 OFF' : this.pace() === 'fast' ? '演出 FAST' : '演出 FULL';
    const ep = document.getElementById('btnEval');
    if (ep) ep.textContent = this.evalOn() ? '评估 ON' : '评估 OFF';
    if (typeof EvalBar !== 'undefined') EvalBar.setVisible(this.evalOn());
  }
};

/* =====================================================================
 * 21 · A11Y — 焦点圈、Escape、棋盘文本摘要
 * ===================================================================== */
const A11y = {
  lastFocus: null,
  rememberFocus() { this.lastFocus = document.activeElement; },
  restoreFocus() {
    if (this.lastFocus && this.lastFocus.focus) { try { this.lastFocus.focus(); } catch (e) { } }
    this.lastFocus = null;
  },
  openModal(el) {
    this.lastFocus = document.activeElement;
    el.classList.add('on');
    el.setAttribute('aria-hidden', 'false');
    const first = el.querySelector('input,select,textarea,button');
    if (first) setTimeout(() => first.focus(), 30);
    document.addEventListener('keydown', this.trap);
  },
  closeModal(el) {
    el.classList.remove('on');
    el.setAttribute('aria-hidden', 'true');
    document.removeEventListener('keydown', this.trap);
    if (this.lastFocus && this.lastFocus.focus) { try { this.lastFocus.focus(); } catch (e) { } }
    this.lastFocus = null;
  },
  trap(e) {
    if (e.key !== 'Escape') return;
    const open = [...document.querySelectorAll('.modal-bg.on, #resultOverlay.on')];
    if (!open.length) return;
    e.preventDefault();
    const top = open[open.length - 1];
    if (top.id === 'resultOverlay') { $('#resHome').click(); return; }
    if (top.id === 'confirmModal') { $('#confirmNo').click(); return; }
    if (top.id === 'charModal') { $('#btnCharCancel').click(); return; }
    top.classList.remove('on');
    document.removeEventListener('keydown', A11y.trap);
  },
  /* 棋盘文本摘要：屏幕阅读器 / 纯键盘用户可读的局面描述。
   * 参数可选：回放页要描述它自己的局面，不能读 Game.chess。 */
  describe(chess, view) {
    if (!chess) return '棋盘尚未初始化';
    const c = chess;
    const turn = c.turn() === 'w' ? '白方' : '黑方';
    const inCheck = c.in_check() ? '，正被将军' : '';
    const hist = c.history({ verbose: true });
    const last = hist.length ? hist[hist.length - 1] : null;
    const parts = [];
    parts.push(`轮到${turn}走子${inCheck}。`);
    if (last) parts.push(`上一步：${last.color === 'w' ? '白' : '黑'}方 ${last.san}。`);
    const board = c.board();
    const byColor = { w: [], b: [] };
    const nameMap = { p: '兵', n: '马', b: '象', r: '车', q: '后', k: '王' };
    for (let r = 0; r < 8; r++) for (let f = 0; f < 8; f++) {
      const p = board[r][f];
      if (!p) continue;
      byColor[p.color].push(`${nameMap[p.type]}${String.fromCharCode(97 + f)}${8 - r}`);
    }
    parts.push(`白方：${byColor.w.join('、') || '无子'}。`);
    parts.push(`黑方：${byColor.b.join('、') || '无子'}。`);
    if (c.in_check()) {
      const k = Game.findKingOn ? Game.findKingOn(c, c.turn()) : null;
      if (k) parts.push(`被将的王在 ${k}。`);
    }
    return parts.join('');
  },

  /* 刷新 aria-live 摘要。
   *
   * 曾经只在 boot() 调一次 —— 屏幕阅读器永远听到初始局面。
   * 现在每个改变局面的动作（落子 / 悔棋 / 回放步进）都调它。
   * 内容不变时直接跳过，避免重复播报。
   *
   * targetId 默认 battle 的 #boardA11y；回放页要传 'replayA11y'，
   * 因为 battle 屏是 display:none，其 live region 不会被朗读。 */
  updateBoardLabel(chess, view, targetId) {
    const el = document.getElementById(targetId || 'boardA11y');
    const c = chess || Game.chess;
    if (!el || !c) return;
    const text = this.describe(c, view || Game.view);
    if (el.textContent === text) return;
    el.textContent = text;
  }
};
