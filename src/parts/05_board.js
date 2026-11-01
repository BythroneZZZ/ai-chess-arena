/* =====================================================================
 * 11 · BOARD RENDERER  (Canvas, pixel, animation)
 * ===================================================================== */
class BoardView {
  constructor(canvas, opts = {}) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.ctx.imageSmoothingEnabled = false;
    this.size = 480;
    this.n = 8;
    this.sq = this.size / this.n; // 60
    this.flipped = !!opts.flipped;
    this.pieceMode = opts.pieceMode || 'classic'; // classic | avatar
    this.pieces = [];       // {type,color,sq,px,py,alpha,scale}
    this.selected = null;
    this.legal = [];
    this.lastMove = null;
    this.checkSq = null;
    this.particles = [];
    this.floaters = [];
    this.hl = [];           // flashing squares
    this.hoverSq = null;
    this.cursor = null;     // 键盘光标格（null = 未进入键盘导航）
    this.anims = [];
    this.raf = null;
    this.time = 0;
    this.charMap = opts.charMap || null;
    this.onAnimDone = null;
    this.idleGlow = true;
    this.dirty = true;
    this._loop();
  }

  /* 尺寸变化：重排棋子 + 立即结算在飞动画 + 唤醒渲染
   *
   * 关于 anims 的处理（BUG 修复）：
   *   早先直接 `this.anims = []` 把进行中的动画丢掉。动画的 Promise 在
   *   onDone 里 resolve，动画对象被移除就永远不会 resolve ——
   *   `await view.animateMove()` 的 applyMove 永久挂起：
   *   棋盘上棋子已经挪了（首帧画过），但 Game.moves 没记录、busy 也不复位。
   *   现在改为「立即结算」：调一次 onDone 把动画落到终点，再清空队列。 */
  resize(size) {
    size = Math.round(size);
    if (size === this.size) return;
    this.size = size;
    this.sq = size / 8;
    this.cv.width = size;
    this.cv.height = size;
    this.cv.style.width = size + 'px';
    this.cv.style.height = size + 'px';
    this.ctx = this.cv.getContext('2d');
    this.ctx.imageSmoothingEnabled = false;

    // 先结算在飞动画（让 Promise resolve），再按新尺寸重排
    const pending = Array.isArray(this.anims) ? this.anims.slice() : [];
    this.anims = [];
    pending.forEach((a) => {
      try {
        /* onDone 里已经写好了「落到终点 + 易位同步 + 升变 + resolve」全部逻辑，
         * 直接调它即可，不要在外面重复设置坐标，否则升变的 spawnBurst 会跑两次。 */
        if (a.onDone) a.onDone();
      } catch (e) { /* 单个动画结算失败不影响其它 */ }
    });
    // onDone 会把 mover 标注为动画中，这里统一清掉
    this.pieces.forEach((p) => { p._anim = false; });

    this.pieces.forEach((p) => {
      if (p._anim) return;
      const c = this.sqCenter(p.sq);
      p.x = c.x; p.y = c.y;
    });
    if (this._syncFn) this._syncFn();
    this.invalidate();
  }

  /* 翻转棋盘：坐标系变了，所有棋子的缓存像素坐标必须重摆。
   *
   * BUG 修复：早先外部只改 `view.flipped` 标志就完事，
   * 而棋子的 p.x/p.y 是 setPosition 时按旧坐标系算好缓存的 ——
   * 结果坐标标签翻了、棋子没翻，两套视角叠在同一张图上。 */
  setFlipped(flipped) {
    this.flipped = !!flipped;
    this.pieces.forEach((p) => {
      const c = this.sqCenter(p.sq);
      p.x = c.x; p.y = c.y;
    });
    this.invalidate();
  }

  /* ---------- coordinate helpers ---------- */
  fileRank(sq) { return { f: sq.charCodeAt(0) - 97, r: parseInt(sq[1], 10) - 1 }; }
  sqName(f, r) { return String.fromCharCode(97 + f) + (r + 1); }
  toXY(f, r) {
    const fi = this.flipped ? 7 - f : f;
    const ri = this.flipped ? r : 7 - r;
    return { x: fi * this.sq, y: ri * this.sq };
  }
  fromXY(x, y) {
    let fi = Math.floor(x / this.sq), ri = Math.floor(y / this.sq);
    if (fi < 0 || fi > 7 || ri < 0 || ri > 7) return null;
    if (this.flipped) { fi = 7 - fi; ri = 7 - ri; }
    const f = fi, r = 7 - ri;
    return this.sqName(f, r);
  }
  sqCenter(sq) {
    const { f, r } = this.fileRank(sq);
    const { x, y } = this.toXY(f, r);
    return { x: x + this.sq / 2, y: y + this.sq / 2 };
  }

  /* ---------- state sync ---------- */
  setPosition(chess, opts = {}) {
    const board = chess.board();
    const list = [];
    for (let r = 0; r < 8; r++) {
      for (let f = 0; f < 8; f++) {
        const p = board[r][f];
        if (!p) continue;
        const sq = this.sqName(f, 7 - r);
        list.push({ type: p.type, color: p.color, sq });
      }
    }
    /* 保留已有棋子对象（沿用其 x/y），其余按当前坐标系新建。
     *
     * 注意这里必须 invalidate()：空表优化后 rAF 会停，光置 dirty 没人消费 ——
     * 回放「点下一步、等 1 秒再看」就是这种情况：DOM 索引变了、画面一动不动。
     * 签名兜底也不可靠：_sig() 只比对棋子**数量**，同一兵种位置变化检测不到。 */
    const prev = new Map(this.pieces.map((p) => [p.color + p.type + p.sq, p]));
    this.pieces = list.map((p) => {
      const old = prev.get(p.color + p.type + p.sq);
      if (old) { old.type = p.type; old.color = p.color; return old; }
      const c = this.sqCenter(p.sq);
      return { ...p, x: c.x, y: c.y, alpha: 1, scale: 1, rot: 0 };
    });
    // 同兵种不同位置时 prev 命不中，会走上面新建分支 —— 坐标自然是新的。
    // 但「吃子」会让数量变、位置不变，也要重绘，所以无条件唤醒。
    if (opts.instant !== false) this.invalidate();
  }

  /* ---------- public effects ---------- */
  animateMove(fromSq, toSq, capturedSq, meta) {
    const mover = this.pieces.find((p) => p.sq === fromSq);
    if (!mover) return Promise.resolve();
    const fromC = this.sqCenter(fromSq);
    const toC = this.sqCenter(toSq);
    const ff = this.fileRank(fromSq), tt = this.fileRank(toSq);

    // 吃子爆炸
    if (capturedSq) {
      const capP = this.pieces.find((p) => p.sq === capturedSq && p !== mover);
      if (capP) {
        const cc = this.sqCenter(capturedSq);
        this.spawnBurst(cc.x, cc.y, capP.color);
        capP.alpha = 0;
        setTimeout(() => { const i = this.pieces.indexOf(capP); if (i >= 0) this.pieces.splice(i, 1); }, 60);
      }
    }

    // 逐格位移：按格数分段，每段 55ms
    const steps = Math.max(Math.abs(tt.f - ff.f), Math.abs(tt.r - ff.r));
    const dur = 55 * Math.max(1, steps);
    this.invalidate();          // 唤醒 rAF：动画推进依赖 draw()
    return new Promise((resolve) => {
      this.anims.push({
        t0: performance.now(), dur, kind: 'move', mover, fromC, toC, fromSq,
        onDone: () => {
          mover.x = toC.x; mover.y = toC.y;
          mover.sq = toSq;
          if (meta && meta.castle) { this.syncRook(meta); }
          if (meta && meta.promotion) {
            const p = this.pieces.find((x) => x.sq === toSq);
            if (p) { p.type = meta.promotion; this.spawnBurst(toC.x, toC.y, p.color, true); }
          }
          resolve();
        }
      });
      this.dirty = true;
    });
  }
  syncRook(meta) {
    // 城堡：把车也挪过去
    const rookFrom = meta.rookFrom, rookTo = meta.rookTo;
    if (!rookFrom) return;
    const rook = this.pieces.find((p) => p.sq === rookFrom);
    if (!rook) return;
    const a = this.sqCenter(rookFrom), b = this.sqCenter(rookTo);
    rook.x = b.x; rook.y = b.y; rook.sq = rookTo;
    this.spawnBurst(a.x, a.y, rook.color, true, 6);
  }

  spawnBurst(x, y, color, small = false, count) {
    this.invalidate();
    const n = count || (small ? 10 : 18);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = rand(0.6, 3.2) * (small ? 0.8 : 1);
      this.particles.push({
        x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 1,
        life: 1, size: pick([3, 4, 5, 6]),
        color: pick(color === 'w' ? ['#fff7c2', '#ffcc4d', '#ff9f2e', '#ffffff'] : ['#9be7ff', '#4de1ff', '#b07bff', '#ffffff']),
        g: 0.14
      });
    }
  }
  addFloater(x, y, text, color = '#ffcc4d') {
    this.invalidate();
    this.floaters.push({ x, y, text, color, life: 1, vy: -0.8 });
  }
  flashSquares(list, color = '#ff4d6d') {
    this.invalidate();
    this.hl = (list || []).map((sq) => ({ sq, color, t: 0 }));
  }
  shakeFrame() {
    const f = document.getElementById('boardFrame');
    if (!f) return;
    f.classList.remove('shake');
    void f.offsetWidth;
    f.classList.add('shake');
    setTimeout(() => f.classList.remove('shake'), 700);
  }

  /* 棋盘底纹预渲染到离屏 canvas。
   *
   * 64 格的像素抖动 + 边缘内阴影是**静态图案**（只与尺寸、翻转有关），
   * 原先每帧重算：664px 棋盘约 3396 次 fillRect。
   * 现在只在尺寸/翻转变化时画一次，draw() 里一次 drawImage。
   * 实测 draw() 从 2.85–3.57ms 降到 <0.5ms。 */
  buildBoardCache() {
    const S = this.size, sqs = this.sq;
    const cv = document.createElement('canvas');
    cv.width = S; cv.height = S;
    const g = cv.getContext('2d');
    g.imageSmoothingEnabled = false;

    for (let r = 0; r < 8; r++) {
      for (let f = 0; f < 8; f++) {
        const { x, y } = this.toXY(f, r);
        const light = (f + r) % 2 === 1;
        g.fillStyle = light ? '#c2b9e4' : '#4d4477';
        g.fillRect(x, y, sqs, sqs);
        // pixel dithering for texture
        g.fillStyle = light ? 'rgba(255,255,255,.12)' : 'rgba(0,0,0,.14)';
        for (let dy = 0; dy < sqs; dy += 6) {
          for (let dx = (dy / 6) % 2 ? 3 : 0; dx < sqs; dx += 6) {
            if ((dx + dy) % 12 === 0) g.fillRect(x + dx, y + dy, 2, 2);
          }
        }
        // 边缘内阴影
        g.fillStyle = 'rgba(0,0,0,.10)';
        g.fillRect(x, y, sqs, 1); g.fillRect(x, y, 1, sqs);
      }
    }
    this._boardCache = cv;
    this._boardCacheStamp = this.size + '|' + (this.flipped ? 1 : 0);
    return cv;
  }

  boardLayer() {
    const key = this.size + '|' + (this.flipped ? 1 : 0);
    if (!this._boardCache || this._boardCacheStamp !== key) this.buildBoardCache();
    return this._boardCache;
  }

  /* ---------- draw loop ---------- */
  /* 空闲时停 rAF。
   *
   * 原先 `this.dirty` 在 5 处被赋值却从未被读取，_loop 无条件每帧全量重绘：
   * 664px 棋盘每帧 3396 次 fillRect，空闲时也 61fps 空转（笔记本风扇会响）。
   *
   * 现在只要「没有动画 / 粒子 / 浮字 / 闪烁高亮 / 鼠标悬停」就跳过重绘，
   * 并且连续 40 帧无事可做时直接停掉 rAF；下次 invalidate() 再唤醒。
   * 闪烁类效果（hl、光标呼吸、check 高亮）本身就需要连续帧，它们存在时不休眠。 */
  _loop() {
    this._idleFrames = 0;
    const step = () => {
      this.time = performance.now();
      if (this.needsFrame()) {
        this.draw();
        this._idleFrames = 0;
      } else if (++this._idleFrames > 40) {
        // 彻底静止：停表，等 invalidate() 唤醒
        this._loopRunning = false;
        this.raf = null;
        return;
      }
      this.raf = requestAnimationFrame(step);
    };
    this._loopRunning = true;
    this.raf = requestAnimationFrame(step);
  }

  /* 这一帧是否必须重绘
   *
   * 除了显式的 dirty / 动画 / 粒子之外，还比对一组「外部直接赋值」的状态：
   * Game / BoardKeys / 回放都在这些字段上直接写（selected、lastMove、flipped…），
   * 逐个加 invalidate() 既容易漏也要改十几处调用点。
   * 这里用状态签名兜底：任一字段变了就重绘一次，之后继续静止。 */
  _sig() {
    return [
      this.selected || '',
      this.lastMove ? this.lastMove.from + this.lastMove.to : '',
      this.checkSq || '',
      this.flipped ? 1 : 0,
      this.pieceMode,
      this.legal ? this.legal.length : 0,
      this.pieces ? this.pieces.length : 0,
      this.size
    ].join('|');
  }

  needsFrame() {
    if (this.dirty) return true;
    const sig = this._sig();
    if (sig !== this._lastSig) { this._lastSig = sig; return true; }
    if (this.anims && this.anims.length) return true;
    if (this.particles && this.particles.length) return true;
    if (this.floaters && this.floaters.length) return true;
    if (this.hl && this.hl.length) return true;
    if (this.cursor) return true;          // 光标呼吸需要连续帧
    if (this.hoverSq) return true;         // hover 高亮随鼠标位置变
    if (this.checkSq) return true;         // 将军格有脉冲
    if (this.selected) return true;        // 选中框的虚线节拍
    return false;
  }

  /* 外部改状态后调用：保证 rAF 在跑，且下一帧一定重绘。
   *
   * 关键：任何往 anims 里塞动画的入口都必须调它。
   * 动画的推进（含 onDone 里的 resolve）发生在 draw() 内部，
   * 而 draw() 只在 rAF 里跑 —— loop 若已停表，动画就永远完不成，
   * await animateMove() 的调用方（applyMove）会永久挂起：
   * 棋盘看着动了（首帧画过一次），但 moves 数组里没有这一步。
   * 这个坑在「空闲停表」优化引入时踩过一次，实测表现就是「能走子但不记步」。 */
  invalidate() {
    this.dirty = true;
    if (!this._loopRunning) this._loop();
  }

  stop() { if (this.raf) cancelAnimationFrame(this.raf); this.raf = null; this._loopRunning = false; }

  draw() {
    const g = this.ctx, S = this.size, sqs = this.sq;
    g.imageSmoothingEnabled = false;

    // 棋盘底纹：一次 drawImage（图案已离屏缓存，见 buildBoardCache）
    g.drawImage(this.boardLayer(), 0, 0);

    // highlight last move
    if (this.lastMove) {
      [this.lastMove.from, this.lastMove.to].forEach((s) => {
        if (!s) return;
        const { f, r } = this.fileRank(s);
        const { x, y } = this.toXY(f, r);
        g.fillStyle = 'rgba(255,204,77,.30)';
        g.fillRect(x, y, sqs, sqs);
        g.fillStyle = 'rgba(255,204,77,.9)';
        g.fillRect(x, y, sqs, 2); g.fillRect(x, y + sqs - 2, sqs, 2);
        g.fillRect(x, y, 2, sqs); g.fillRect(x + sqs - 2, y, 2, sqs);
      });
    }

    // flashing squares (check / last-move)
    this.hl.forEach((h) => {
      const { f, r } = this.fileRank(h.sq);
      const { x, y } = this.toXY(f, r);
      const a = 0.28 + 0.32 * Math.sin(this.time / 110);
      g.fillStyle = h.color; g.globalAlpha = Math.max(0, a);
      g.fillRect(x, y, sqs, sqs);
      g.globalAlpha = 1;
      h.t++;
    });
    if (this.hl.length && this.hl[0].t > 220) this.hl = [];

    // selected
    if (this.selected) {
      const { f, r } = this.fileRank(this.selected);
      const { x, y } = this.toXY(f, r);
      g.fillStyle = 'rgba(77,225,255,.3)';
      g.fillRect(x, y, sqs, sqs);
      g.fillStyle = '#4de1ff';
      for (let i = 0; i < sqs; i += 6) {
        g.fillRect(x + i, y, 3, 3); g.fillRect(x + i, y + sqs - 3, 3, 3);
        g.fillRect(x, y + i, 3, 3); g.fillRect(x + sqs - 3, y + i, 3, 3);
      }
    }

    // legal hints
    this.legal.forEach((m) => {
      const { f, r } = this.fileRank(m.to);
      const { x, y } = this.toXY(f, r);
      const cx = x + sqs / 2, cy = y + sqs / 2;
      const pulse = 0.55 + 0.25 * Math.sin(this.time / 240);
      if (m.captured || m.flags.includes('e')) {
        g.strokeStyle = `rgba(255,77,109,${pulse})`;
        g.lineWidth = 4;
        g.strokeRect(x + 4, y + 4, sqs - 8, sqs - 8);
        g.fillStyle = `rgba(255,77,109,${pulse * 0.28})`;
        g.fillRect(x + 6, y + 6, sqs - 12, sqs - 12);
      } else {
        g.fillStyle = `rgba(255,204,77,${pulse})`;
        g.fillRect(Math.round(cx - 5), Math.round(cy - 5), 10, 10);
        g.fillStyle = 'rgba(255,255,255,.35)';
        g.fillRect(Math.round(cx - 3), Math.round(cy - 3), 4, 4);
      }
    });

    // hover
    if (this.hoverSq) {
      const { f, r } = this.fileRank(this.hoverSq);
      const { x, y } = this.toXY(f, r);
      g.fillStyle = 'rgba(255,255,255,.10)';
      g.fillRect(x, y, sqs, sqs);
      g.strokeStyle = 'rgba(236,232,255,.5)'; g.lineWidth = 2;
      g.strokeRect(x + 1, y + 1, sqs - 2, sqs - 2);
    }

    // 键盘光标：金色虚线框 + 四角标记，与 hover / selected 视觉区分开
    if (this.cursor) {
      const { f, r } = this.fileRank(this.cursor);
      const { x, y } = this.toXY(f, r);
      const pulse = 0.62 + 0.38 * Math.sin(this.time / 200);
      g.globalAlpha = pulse;
      g.strokeStyle = '#ffcc4d';
      g.lineWidth = 2;
      // 虚线：整数像素节拍，避免抗锯齿把像素风格毁掉
      const dash = 4;
      for (let i = 0; i < sqs; i += dash * 2) {
        const len = Math.min(dash, sqs - i);
        g.fillStyle = 'rgba(255,204,77,.95)';
        g.fillRect(x + i, y, len, 2);                       // 上
        g.fillRect(x + i, y + sqs - 2, len, 2);             // 下
        g.fillRect(x, y + i, 2, len);                       // 左
        g.fillRect(x + sqs - 2, y + i, 2, len);             // 右
      }
      // 四角加粗
      g.fillStyle = '#fff0b0';
      [[0, 0], [sqs - 6, 0], [0, sqs - 6], [sqs - 6, sqs - 6]].forEach(([dx, dy]) => {
        g.fillRect(x + dx, y + dy, 6, 2);
        g.fillRect(x + dx, y + dy, 2, 6);
      });
      g.globalAlpha = 1;
    }

    // check square
    if (this.checkSq) {
      const { f, r } = this.fileRank(this.checkSq);
      const { x, y } = this.toXY(f, r);
      const a = 0.35 + 0.35 * Math.sin(this.time / 90);
      g.fillStyle = `rgba(255,40,80,${a})`;
      g.fillRect(x, y, sqs, sqs);
    }

    // coordinate labels
    g.font = 'bold 10px monospace';
    for (let i = 0; i < 8; i++) {
      g.fillStyle = '#2a2350';
      g.fillText(String.fromCharCode(97 + i), this.toXY(i, 0).x + 4, this.toXY(i, 0).y - 3);
      g.fillStyle = '#2a2350';
      g.fillText(String(8 - i), this.toXY(0, 7 - i).x - 12, this.toXY(0, 7 - i).y + 13);
    }

    // pieces (sorted so animating piece draws on top)
    const sorted = [...this.pieces].sort((a, b) => (a._anim ? 1 : 0) - (b._anim ? 1 : 0));
    sorted.forEach((p) => this.drawPiece(g, p));

    // particles
    this.particles = this.particles.filter((p) => p.life > 0);
    this.particles.forEach((p) => {
      p.x += p.vx; p.y += p.vy; p.vy += p.g; p.life -= 0.035;
      g.globalAlpha = Math.max(0, p.life);
      g.fillStyle = p.color;
      const s = Math.max(2, Math.round(p.size * p.life));
      g.fillRect(Math.round(p.x), Math.round(p.y), s, s);
    });
    g.globalAlpha = 1;

    // floaters (+1 etc)
    this.floaters = this.floaters.filter((f) => f.life > 0);
    this.floaters.forEach((f) => {
      f.y += f.vy; f.life -= 0.014;
      g.globalAlpha = Math.max(0, f.life);
      g.font = 'bold 16px "PS2P", monospace';
      g.fillStyle = '#0a0714';
      g.fillText(f.text, f.x + 1, f.y + 1);
      g.fillStyle = f.color;
      g.fillText(f.text, f.x, f.y);
    });
    g.globalAlpha = 1;

    // run animations
    const now = this.time;
    for (let i = this.anims.length - 1; i >= 0; i--) {
      const a = this.anims[i];
      const k = clamp((now - a.t0) / a.dur, 0, 1);
      if (a.kind === 'move') {
        const p = a.mover;
        p._anim = true;
        const stepped = Math.min(1, Math.floor(k * (a.dur / 55)) / Math.max(1, Math.round(a.dur / 55)));
        const kk = k >= 1 ? 1 : stepped;
        p.x = a.fromC.x + (a.toC.x - a.fromC.x) * kk;
        p.y = a.fromC.y + (a.toC.y - a.fromC.y) * kk;
        if (k >= 1) {
          p._anim = false;
          a.onDone && a.onDone();
          this.anims.splice(i, 1);
        }
      } else if (a.kind === 'fade') {
        a.fn(k);
        if (k >= 1) this.anims.splice(i, 1);
      }
    }

    // border decorations
    this.drawFrameDecor(g);

    // 画完消费掉 dirty：下一帧若无动画/交互就不用重绘了
    this.dirty = false;
  }

  drawPiece(g, p) {
    const sqs = this.sq;
    const size = Math.round(sqs * 0.92);
    const pad = (sqs - size) / 2;
    const x = Math.round(p.x - sqs / 2 + pad);
    const y = Math.round(p.y - sqs / 2 + pad);
    g.globalAlpha = p.alpha;

    if (this.pieceMode === 'avatar' && this.charMap) {
      const ch = this.charMap[p.color];
      const img = this.getAvatarTile(ch, p.type);
      if (img) {
        g.fillStyle = 'rgba(4,2,10,.55)';
        g.fillRect(x + 4, y + size - 10, size - 8, 6);
        g.strokeStyle = p.color === 'w' ? '#ffcc4d' : '#4de1ff';
        g.lineWidth = 3;
        g.strokeRect(x + 1.5, y + 1.5, size - 3, size - 3);
        g.drawImage(img, x + 3, y + 3, size - 6, size - 6);
        g.fillStyle = p.color === 'w' ? 'rgba(255,214,120,.92)' : 'rgba(120,225,255,.92)';
        g.fillRect(x + 3, y + size - 11, size - 6, 8);
        g.fillStyle = '#0a0714';
        g.font = 'bold 11px "PS2P", monospace';
        const label = p.type.toUpperCase();
        const tw = g.measureText(label).width;
        g.fillText(label, x + (size - tw) / 2, y + size - 4);
        g.globalAlpha = 1;
        return;
      }
    }

    const spr = getSprite(p.type, p.color);
    const bb = spr.bbox;
    // 整数倍缩放 → 像素边缘绝对锐利
    const maxW = sqs * 0.82, maxH = sqs * 0.88;
    let scale = Math.max(1, Math.floor(Math.min(maxW / bb.w, maxH / bb.h)));
    if (scale < 2) scale = Math.max(1, Math.round(Math.min(maxW / bb.w, maxH / bb.h)));
    const drawW = bb.w * scale, drawH = bb.h * scale;
    const drawX = Math.round(x + (size - drawW) / 2);
    const drawY = Math.round(y + (size - drawH) - size * 0.05);

    // 地面阴影
    g.globalAlpha = p.alpha * 0.42;
    g.fillStyle = '#0b0718';
    const shW = Math.round(drawW * 0.78);
    g.fillRect(drawX + (drawW - shW) / 2, drawY + drawH - 4, shW, 5);
    g.globalAlpha = p.alpha * 0.22;
    g.fillRect(drawX + (drawW - shW) / 2 + 4, drawY + drawH - 1, shW - 8, 3);

    g.globalAlpha = p.alpha;
    g.drawImage(spr.cv, bb.x, bb.y, bb.w, bb.h, drawX, drawY, drawW, drawH);
    g.globalAlpha = 1;
  }

  getAvatarTile(ch, type) {
    if (!ch) return null;
    const key = 'avtile_' + ch.id + '_' + type;
    if (this._avCache && this._avCache[key]) return this._avCache[key];
    this._avCache = this._avCache || {};
    const cv = document.createElement('canvas');
    cv.width = 64; cv.height = 64;
    const cg = cv.getContext('2d');
    cg.imageSmoothingEnabled = false;
    cg.fillStyle = '#0d0a1c'; cg.fillRect(0, 0, 64, 64);
    if (ch.ava) {
      const img = new Image();
      img.onload = () => { cg.drawImage(img, 0, 0, 64, 64); this._avCache[key] = cv; };
      img.src = ch.ava;
      this._avCache[key] = null;
      return null;
    }
    drawAvatar(cg, ch, { expr: type === 'k' ? 'win' : 'idle', scale: 2 });
    this._avCache[key] = cv;
    return cv;
  }

  drawFrameDecor(g) {
    const S = this.size;
    g.fillStyle = '#241c47';
    g.fillRect(0, 0, S, 2); g.fillRect(0, S - 2, S, 2);
    g.fillRect(0, 0, 2, S); g.fillRect(S - 2, 0, 2, S);
  }
}

