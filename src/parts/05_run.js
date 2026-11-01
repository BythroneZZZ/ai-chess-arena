/* =====================================================================
 * 21 · RUN CONTEXT — 代次隔离与取消中心
 *
 * 每个对局有唯一 runId。所有异步链在 await 之后用 isLive(token) 校验，
 * 旧代次的返回一律丢弃，绝不写入新对局。
 * 所有网络请求的 AbortController 都登记在这里，abort 时统一取消。
 * ===================================================================== */
const Run = {
  id: 0,
  ctrls: new Set(),
  listening: new Set(),      // 需要随 abort 一起停止的功能（回放解说等）

  next() {
    this.id++;
    return this.id;
  },

  token() { return this.id; },

  isLive(token) { return token === this.id; },

  /* 注册一个可取消请求；返回 release，供 finally 清理 */
  track(ctrl) {
    this.ctrls.add(ctrl);
    return () => this.ctrls.delete(ctrl);
  },

  register(fn) { this.listening.add(fn); return () => this.listening.delete(fn); },

  /* 作废当前代次：取消全部请求与订阅 */
  kill() {
    this.id++;
    for (const c of this.ctrls) { try { c.abort(new DOMException('run cancelled', 'AbortError')); } catch (e) { try { c.abort(); } catch (e2) { } } }
    this.ctrls.clear();
    for (const fn of [...this.listening]) {
      try { fn(); } catch (e) { /* 忽略 */ }
    }
    this.listening.clear();
  },

  /* 判断是否「被取消」。
   *
   * 早先用 /aborted|abort/i 宽匹配 message —— 只要错误文本里出现 abort
   * 就当成取消，导致真实错误被静默吞掉（比如服务端返回
   * "request aborted by upstream"），用户看不到任何提示、也不重试。
   *
   * 现在只认三个明确信号：
   *   1. DOMException 名 AbortError
   *   2. 旧版 IE/Edge 的数字码 20
   *   3. 我们自己 Run.kill() 抛的那句话（run cancelled） */
  isAbortError(e) {
    if (!e) return false;
    if (e.name === 'AbortError') return true;
    if (e.code === 20) return true;
    const msg = String(e.message || '');
    return /^run cancelled$/i.test(msg.trim());
  }
};

/* 可被 Run 取消的 sleep：abort 后立即返回，避免长等待拖住旧链 */
function runSleep(ms, token) {
  return new Promise((resolve) => {
    if (token !== undefined && !Run.isLive(token)) { resolve(); return; }
    const ctrl = new AbortController();
    const release = Run.track(ctrl);
    const timer = setTimeout(() => { release(); resolve(); }, ms);
    ctrl.signal.addEventListener('abort', () => {
      clearTimeout(timer);
      release();
      resolve();
    }, { once: true });
  });
}
