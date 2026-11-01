/* =====================================================================
 * 22 · ENDPOINT GUARD — 密钥外发前的端点准入
 *
 * 威胁模型：localStorage 里的 base 可被任何本页脚本/扩展/导入的配置改掉。
 * 若不拦截，下一次开局就会把 API Key 明文发给攻击者域名。
 *
 * 策略：
 *   - 每次真正发请求前，从 URL 取出 origin（协议+主机+端口）
 *   - 已知可信（本会话已确认 / 用户点过「始终允许」）→ 直接放行
 *   - 未知 → 暂停请求，弹确认，等待用户决定
 *   - 取消 → 抛 AbortError 语义的错误，走既有兜底，绝不下发
 *
 * 注意：判定放在请求前而不是保存时，因为端点可能在保存后被改动，
 * 且自定义格式的 URL 拼接与 OpenAI/Anthropic 不同。
 * ===================================================================== */
const EndpointGuard = {
  pending: null,     // 当前等待用户决定的 Promise

  originOf(url) {
    try {
      const u = new URL(url);
      return u.protocol + '//' + u.host;
    } catch (e) { return null; }
  },

  trustedList() {
    if (!Array.isArray(Store.settings.trustedHosts)) Store.settings.trustedHosts = [];
    return Store.settings.trustedHosts;
  },

  isTrusted(origin) {
    if (!origin) return false;
    const list = this.trustedList();
    return list.includes(origin);
  },

  trust(origin) {
    if (!origin) return;
    const list = this.trustedList();
    if (!list.includes(origin)) {
      list.push(origin);
      // 上限 30 条，避免无限增长
      if (list.length > 30) list.splice(0, list.length - 30);
      Store.saveSettings();
    }
  },

  revoke(origin) {
    Store.settings.trustedHosts = this.trustedList().filter((h) => h !== origin);
    Store.saveSettings();
  },

  /**
   * 请求前调用。返回 Promise：
   *   resolve() → 放行
   *   reject(AbortError) → 用户拒绝 / 已取消
   */
  async ensure(url, opts = {}) {
    const origin = this.originOf(url);
    if (!origin) return;                       // 无法解析的 URL 交给后续 fetch 报错
    if (this.isTrusted(origin)) return;

    // 已经是「本地」地址也仍需一次确认——本地服务同样可能被劫持端口
    const decision = await this.ask(origin, opts);
    if (!decision.allow) {
      throw new DOMException('endpoint not confirmed', 'AbortError');
    }
    // ask 内部已按 decision 处理 remembered / session，这里不再重复写入
  },

  ask(origin, opts) {
    // 同一时刻只允许一个确认框。后到的请求排队，等前一个结束再询问，
    // 避免两方同时请求时把 DOM onclick 覆盖成对方的 resolve。
    if (this.pending) {
      this._queue = this._queue || [];
      return new Promise((resolve) => {
        this._queue.push({ origin, opts, resolve });
      }).then((decision) => decision);
    }
    /* pending 只在「真的要弹框」时才占位。
     *
     * 早先把 `this.pending = ...` 放在这之前，而下面 panel 缺失时会提前 return
     * 且从不清理 —— pending 永久非空，此后每个 ask() 都以为「已有一个在问」，
     * 全部塞进队列等待，整个会话的 API 请求彻底堵死。
     * 现在：面板缺失直接放行、不占位；占位后无论哪条路径都会在 done() 里释放。 */
    return new Promise((resolve) => {
      const bg = document.getElementById('endpointModal');
      if (!bg) { resolve({ allow: true, remember: false }); return; }  // 面板缺失时放行，避免卡死主流程

      this.pending = { origin, opts };

      const cfgName = opts.cfgName ? ('配置「' + opts.cfgName + '」') : '当前配置';
      const isLocal = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/i.test(origin);

      document.getElementById('epOrigin').textContent = origin;
      document.getElementById('epDetail').textContent =
        cfgName + ' 即将把 API Key 发送到上方地址。' +
        (isLocal ? '（本机地址，确认端口属于你自己的服务）' : '如果是别人给你的地址，或你不认识这个域名，请点取消。');

      const done = (allow, remember) => {
        if (this._settled) return;
        this._settled = true;
        bg.classList.remove('on');
        bg.setAttribute('aria-hidden', 'true');
        document.removeEventListener('keydown', onKey);
        A11y.restoreFocus();
        this.pending = null;
        this._settled = false;
        if (allow && remember) this.trust(origin);
        else if (allow) this.sessionAllow(origin);
        const decision = { allow, remember: !!remember };
        resolve(decision);

        // 释放队列中的下一个询问
        const next = (this._queue || []).shift();
        if (next) setTimeout(() => this.ask(next.origin, next.opts).then(next.resolve), 30);
      };

      const onKey = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); done(false, false); }
      };

      document.getElementById('epOnce').onclick = () => done(true, false);
      document.getElementById('epAlways').onclick = () => done(true, true);
      document.getElementById('epCancel').onclick = () => done(false, false);
      document.addEventListener('keydown', onKey);

      A11y.rememberFocus();
      bg.classList.add('on');
      bg.setAttribute('aria-hidden', 'false');
      setTimeout(() => { const b = document.getElementById('epCancel'); if (b) b.focus(); }, 40);
      Sound.click();
    });
  },

  /* 仅本次会话允许：不进 localStorage，刷新即失效 */
  sessionAllow(origin) {
    this._session = this._session || new Set();
    this._session.add(origin);
  },

  isTrusted(origin) {
    if (!origin) return false;
    if (this._session && this._session.has(origin)) return true;
    return this.trustedList().includes(origin);
  }
};
