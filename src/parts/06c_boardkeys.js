/* =====================================================================
 * 26 · KEYBOARD BOARD NAVIGATION —— 纯键盘走子
 *
 * 缺口背景：canvas 原本有 tabindex + 焦点圈，但方向键选不了格，
 * 纯键盘用户完全下不了棋（WCAG 2.1.1 Keyboard 不达标）。
 *
 * 设计原则：
 *   1. **不改落子逻辑**。所有动作最终都转成 Game.onSquareClick(sq)，
 *      与鼠标点同一入口 —— 否则会出现「键盘能走、鼠标不能走」的合法着法分歧。
 *   2. **不改 Game 的状态机**。光标是纯展示层状态（view.cursor），
 *      不等于选中格；选中仍由 Game.selectSq / view.selected 唯一持有。
 *   3. **坐标按屏幕方向走**。玩家看到的是翻转后的棋盘，
 *      「→」必须往屏幕右走，因此方向键要按 view.flipped 反算。
 *   4. **每次移动都播报**。棋盘是 canvas，光标不播报的话读屏什么也不知道。
 *
 * 键位：
 *   ↑↓←→        移动光标（翻转棋盘时自动按屏幕方向）
 *   Home / End   行首 / 行尾（屏幕行）
 *   Enter / Space 选中 / 落子 / 取消选中
 *   Esc          取消选中（不退出棋盘焦点）
 *   Tab          正常离开棋盘（不劫持）
 * ===================================================================== */
const BoardKeys = {
  view: null,
  active: false,          // 是否已进入键盘导航（光标可见）
  _announceTimer: null,

  /* 屏幕坐标（0..7, 0..7，左上为 0,0）↔ 棋盘坐标 */
  sqFromScreen(col, row) {
    const v = this.view;
    if (!v) return null;
    let f = col, r = 7 - row;
    if (v.flipped) { f = 7 - f; r = 7 - r; }
    if (f < 0 || f > 7 || r < 0 || r > 7) return null;
    return String.fromCharCode(97 + f) + (r + 1);
  },

  screenOf(sq) {
    const v = this.view;
    if (!v || !sq) return { col: 0, row: 0 };
    const { f, r } = v.fileRank(sq);
    const col = v.flipped ? 7 - f : f;
    const row = v.flipped ? r : 7 - r;
    return { col, row };
  },

  /* 默认光标位：轮到走子方的王；找不到（残局异常）退回 e1/e8 */
  homeSquare() {
    const chess = Game.chess;
    if (!chess) return 'e1';
    const turn = chess.turn();
    const k = Game.findKingOn ? Game.findKingOn(chess, turn) : null;
    return k || (turn === 'w' ? 'e1' : 'e8');
  },

  attach(view) {
    this.view = view;
    const cv = view.cv;
    if (!cv) return;
    cv.addEventListener('keydown', (e) => this.onKey(e));
    cv.addEventListener('focus', () => {
      if (!this.active) this.enter();
    });
    cv.addEventListener('blur', () => {
      // 失焦时收起光标，避免与鼠标 hover 打架
      this.active = false;
      if (this.view) this.view.cursor = null;
    });
    // 鼠标点击后清掉键盘光标：两套输入不混用
    cv.addEventListener('mousedown', () => {
      this.active = false;
      if (this.view) this.view.cursor = null;
    });
  },

  enter() {
    const v = this.view;
    if (!v) return;
    this.active = true;
    if (!v.cursor) v.cursor = this.homeSquare();
    this.syncSelectHint();
    this.announce();
  },

  leave() {
    this.active = false;
    if (this.view) this.view.cursor = null;
  },

  /* 光标落在自己的棋子上时，顺带把 view.selected 同步过去，
   * 这样合法着法的小圆点会跟着光标提示 —— 不改变 Game.selectSq 的语义，
   * 只是复用 onSquareClick 的选中路径。 */
  syncSelectHint() {
    const v = this.view;
    if (!v || !v.cursor || !Game.chess) return;
    const turn = Game.chess.turn();
    const piece = Game.chess.get(v.cursor);
    // 只有「轮到这一方 + 该格有己方子」才顺手选中，否则清掉误选
    if (piece && piece.color === turn && Game.canHumanAct(turn)) {
      if (Game.selectSq !== v.cursor) {
        Game.selectSq = v.cursor;
        v.selected = v.cursor;
        v.legal = Game.chess.moves({ square: v.cursor, verbose: true });
        Sound.select();
      }
    } else if (Game.selectSq && Game.selectSq !== v.cursor) {
      // 光标移开：保留已有的选中，不粗暴清空（那会让键盘走子两步操作失效）
    }
  },

  move(dCol, dRow) {
    const v = this.view;
    if (!v) return;
    if (!this.active || !v.cursor) { this.enter(); return; }
    const cur = this.screenOf(v.cursor);
    const col = clamp(cur.col + dCol, 0, 7);
    const row = clamp(cur.row + dRow, 0, 7);
    if (col === cur.col && row === cur.row) return;    // 撞边不开腔
    const sq = this.sqFromScreen(col, row);
    if (!sq) return;
    v.cursor = sq;
    this.syncSelectHint();
    Sound.click();
    this.announce();
  },

  jumpHome() {
    const v = this.view;
    if (!v || !this.active || !v.cursor) { this.enter(); return; }
    const cur = this.screenOf(v.cursor);
    const sq = this.sqFromScreen(0, cur.row);
    if (sq) { v.cursor = sq; this.syncSelectHint(); Sound.click(); this.announce(); }
  },

  jumpEnd() {
    const v = this.view;
    if (!v || !this.active || !v.cursor) { this.enter(); return; }
    const cur = this.screenOf(v.cursor);
    const sq = this.sqFromScreen(7, cur.row);
    if (sq) { v.cursor = sq; this.syncSelectHint(); Sound.click(); this.announce(); }
  },

  /* Enter / Space：走与鼠标点击完全相同的入口 */
  activate() {
    const v = this.view;
    if (!v) return;
    if (!this.active || !v.cursor) { this.enter(); return; }
    const sq = v.cursor;
    Game.onSquareClick(sq);
    this.announce();
    // 落子后棋盘局面已变，光标停在原地即可（下一步由此处继续）
  },

  cancel() {
    if (Game.selectSq) {
      Game.selectSq = null;
      if (this.view) { this.view.selected = null; this.view.legal = []; }
      Sound.click();
      this.announce();
    }
  },

  onKey(e) {
    if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
    // 弹窗打开时不劫持方向键
    if (document.querySelector('.modal-bg.on, #resultOverlay.on')) return;

    const handled = () => { e.preventDefault(); e.stopPropagation(); };

    const arrows = {
      ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0]
    };
    if (arrows[e.key]) {
      handled();                       // 同时挡住全局的「→ = 单步」
      const [dc, dr] = arrows[e.key];
      this.move(dc, dr);
      return;
    }
    if (e.key === 'Home') { handled(); this.jumpHome(); return; }
    if (e.key === 'End') { handled(); this.jumpEnd(); return; }
    if (e.key === 'Enter' || e.key === ' ' || e.code === 'Space') {
      // Space 在战局页原本是「暂停」，但焦点在棋盘上时应优先走子
      handled();
      this.activate();
      return;
    }
    if (e.key === 'Escape') {
      handled();
      this.cancel();
      return;
    }
  },

  /* ---------- 播报 ---------- */
  describeSquare(sq) {
    const chess = Game.chess;
    if (!sq) return '';
    if (!chess) return sq;
    const piece = chess.get(sq);
    const nameMap = { p: '兵', n: '马', b: '象', r: '车', q: '后', k: '王' };
    if (!piece) {
      const isTarget = (this.view && this.view.legal || []).some((m) => m.to === sq);
      return sq + (isTarget ? '，可落子' : '，空格');
    }
    const owner = piece.color === 'w' ? '白' : '黑';
    let text = `${sq}，${owner}${nameMap[piece.type] || piece.type}`;
    // 光标下这颗子是否可动：只有轮到的一方能动
    if (piece.color === chess.turn()) {
      const verbs = chess.moves({ square: sq, verbose: true });
      if (verbs.length) {
        text += `，可走 ${verbs.length} 处`;
        const caps = verbs.filter((m) => m.captured || (m.flags || '').includes('e'));
        if (caps.length) text += `（含 ${caps.length} 处可吃子）`;
      } else {
        text += '，无合法着法';
      }
    }
    return text;
  },

  announce() {
    if (!this.active || !this.view || !this.view.cursor) return;
    const el = document.getElementById('boardA11y');
    if (!el) return;
    clearTimeout(this._announceTimer);
    // 节流：连按方向键时只播报落点，避免读屏排队念一堆中间位置
    this._announceTimer = setTimeout(() => {
      const sq = this.view && this.view.cursor;
      if (!sq) return;
      const base = this.describeSquare(sq);
      const selected = Game.selectSq
        ? `已选 ${Game.selectSq}，${(this.view.legal || []).length} 个合法目标，回车落子。`
        : '回车选中。';
      const text = '键盘 ' + base + '。' + selected;
      if (el.textContent !== text) el.textContent = text;
    }, 90);
  }
};
