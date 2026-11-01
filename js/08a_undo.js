/* =====================================================================
 * 23 · REACTIONS — 对手对「悔棋 / 提和」的性格化反应
 *
 * 设计：确认框里由「对手」说一句符合人设的话，玩家确认后才真正执行。
 *   - undo：对方被要求悔棋时的反应（错愕、嘲讽、或爽快答应）
 *   - draw：被提议和棋时的反应。为满足「点确认即生效」，
 *          拒绝倾向的语气也会带一个「让步」尾巴，读起来是嘴硬心软。
 * 未命中的标签回落到 _default。
 * ===================================================================== */
const REACT_LINES = {
  '傲娇': {
    undo: [
      '什、什么？悔棋？你也太不要脸了……行吧，就这一次。',
      '诶？！刚才那步不算？我、我又没说不可以。'
    ],
    draw: ['和棋？哼，你是怕输吧……行吧，给你个台阶。']
  },
  '冷静': {
    undo: [
      '悔棋会改变局面评估。你确定我就执行。',
      '这步的代价我还没收完。既然你要求，撤回。'
    ],
    draw: ['局面评估接近均势，和棋可以接受。']
  },
  '可爱': {
    undo: [
      '诶诶？要悔棋吗？那我也要重来一次哦～',
      '呜，刚才那步我很努力的……好吧好吧。'
    ],
    draw: ['和棋呀……好吧好吧，我们下次再玩～']
  },
  '健谈': {
    undo: [
      '等一下，悔棋之前我们得先聊聊刚才那步你为什么这么走。……行，撤吧。',
      '悔棋没问题，不过你知道悔棋会损失什么吗？算了，先撤。'
    ],
    draw: ['和棋也行，不过我正准备跟你讲讲我的中局计划呢。']
  },
  '幽默': {
    undo: [
      '悔棋？行，就当刚才是手抖。',
      '这步撤回，我也可以假装没看见。'
    ],
    draw: ['和棋？可以啊。反正我也没打算赢得太明显。']
  },
  '嘉豪': {
    undo: [
      '什么？悔棋？九折水平还敢悔棋？……行，让你一次。',
      '你刚才不该这么走的——现在想撤回？算了，看你可怜。'
    ],
    draw: ['懦弱之举我决不姑息！……不过既然你开口了，算和，反正我也下腻了。']
  },
  '冷酷': {
    undo: [
      '悔棋。记录在案。撤。',
      '撤一步。你还是会输。'
    ],
    draw: ['和。没意见。']
  },
  '御姐': {
    undo: [
      '悔棋呀？小弟弟，姐姐可以让你一次。',
      '哦？要重来？那姐姐就再陪你走一遍。'
    ],
    draw: ['和棋？也行，姐姐不跟小朋友计较。']
  },
  '毒舌': {
    undo: [
      '悔棋？你这步本来就走得稀烂，撤回也还是一样烂。',
      '哦，终于承认那步是闭着眼睛走的了？撤吧。'
    ],
    draw: ['和棋？这盘你也好意思提？……行吧，懒得再虐你。']
  },
  '温柔': {
    undo: [
      '没关系，悔棋吧，我们慢慢来。',
      '这一步确实有点难，重来一次也没关系。'
    ],
    draw: ['和棋也很好呀，这盘我们下得都很认真。']
  },
  '中二': {
    undo: [
      '时间的齿轮被逆转了……你竟敢挑战因果？好吧，吾准了。',
      '这一步将被从命运中抹去，代价由你承担。'
    ],
    draw: ['止战之约？……也罢，吾认可你的觉悟。']
  },
  '慵懒': {
    undo: ['悔棋啊……行吧，反正我也懒得算。', '嗯……撤就撤吧。'],
    draw: ['和棋？好，省事。']
  },
  '严谨': {
    undo: [
      '悔棋会破坏对局连续性。你确认，我就执行。',
      '如果你需要，我可以同意这次撤回。'
    ],
    draw: ['当前子力与结构接近均势，接受和棋。']
  },
  '热血': {
    undo: [
      '什、什么？悔棋？！这也太不热血了！……行，重来就重来！',
      '悔棋？来啊，重来我照样打穿你！'
    ],
    draw: ['什么？和棋？我还没打过瘾！……行，给你个面子。']
  },
  '瑟琴': {
    undo: [
      '悔棋呀？可以哦，不过你要答应我一件事。……先撤吧。',
      '想重来？那就要看你怎么求我了。'
    ],
    draw: ['和棋？这么快就想结束……好吧，下次别急着走。']
  },
  _default: {
    undo: ['悔棋？行吧，撤回去。', '确定要收回这一步？'],
    draw: ['和棋？可以。']
  }
};

const Reactions = {
  /* 取一句符合该角色人设的反应台词 */
  line(char, kind) {
    if (!char) return pick(REACT_LINES._default[kind] || REACT_LINES._default.undo);
    const tags = (char.tags || []).filter((t) => REACT_LINES[t] && REACT_LINES[t][kind]);
    if (tags.length) {
      const pool = tags.flatMap((t) => REACT_LINES[t][kind]);
      return pick(pool);
    }
    // 无标签时尝试用口头禅兜底，但没有就回默认
    return pick(REACT_LINES._default[kind] || REACT_LINES._default.undo);
  }
};

/* =====================================================================
 * 24 · UNDO / DRAW — 悔棋与提和
 *
 * 与对局模型的契约：
 *   1. 只在「轮到人类操作」时可用（PVE），PVP 双方都可随时触发。
 *   2. 悔棋后棋步仍留在日志里，标记为已撤销；台词保留，不重播。
 *   3. 悔棋必须让回合重新回到人类手上；PVE 撤 2 手，PVP 撤 1 手。
 *   4. 提和成功进入 agreement 结果，走与超时一致的收尾路径。
 * ===================================================================== */
const UndoDraw = {
  busy: false,
  token: 0,

  humanColor() {
    if (Game.human.w) return 'w';
    if (Game.human.b) return 'b';
    return null;
  },

  /* 谁在「回应」这次请求：PVE 是 AI 方，PVP 无（纯确认） */
  responder() {
    if (!Game.players) return null;
    const h = this.humanColor();
    if (!h) return null;                     // AI vs AI：不适用
    const c = h === 'w' ? 'b' : 'w';
    return { color: c, char: Game.players[c] && Game.players[c].char };
  },

  canUse() {
    if (!Game.running || Game.aborted) return false;
    if (Game.mode === 'aivai') return false;
    if (Game.mode === 'pvp') return true;
    // PVE：轮到你即可（不必等 pendingHuman 建立——AI 收尾演出期间也该允许悔棋，
    // 只要不是 AI 正在算棋的忙碌态）
    if (Game.busy) return false;
    const h = this.humanColor();
    return !!h && Game.chess && Game.chess.turn() === h;
  },

  /* ---------- 悔棋 ---------- */
  async requestUndo() {
    if (this.busy) return;
    if (!this.canUse()) {
      UI.toast(Game.mode === 'aivai' ? '擂台观战模式不支持悔棋' : '等对手走完这一步再悔棋', 'bad');
      return;
    }
    if (!Game.chess.history().length) { UI.toast('还没有棋步可以撤销', 'bad'); return; }

    const responder = this.responder();
    this.busy = true;
    const ok = await this.confirm({
      kind: 'undo',
      title: '悔棋',
      char: responder && responder.char,
      line: responder ? Reactions.line(responder.char, 'undo') : '确定要悔棋吗？',
      hint: '撤销后这一步会从棋盘移除，但台词保留在记录里。',
      confirmLabel: '悔棋'
    });
    this.busy = false;
    if (!ok) return;

    const removed = this.performUndo();
    if (!removed) { UI.toast('没有可撤销的棋步', 'bad'); return; }
    UI.toast('已悔棋 ' + removed + ' 步', 'good');
    Sound.select();
  },

  performUndo() {
    if (!Game.chess) return 0;
    // 释放当前等待（如果有），随后由主循环重新挂起
    if (Game.pendingHuman) {
      try { Game.pendingHuman.resolve(null); } catch (e) { }
      Game.pendingHuman = null;
    }
    const h = this.humanColor();
    const maxPlies = Game.mode === 'pvp' ? 1 : 2;
    let removed = 0;

    while (removed < maxPlies && Game.chess.history().length > 0) {
      Game.chess.undo();
      Game.moves.pop();
      removed++;
      if (Game.mode === 'pvp') break;
      // PVE：撤到轮到人类为止
      if (h && Game.chess.turn() === h) break;
    }
    if (!removed) return 0;

    // 棋盘重绘
    const v = Game.view;
    if (v) {
      v.pieces = [];
      v.setPosition(Game.chess);
      const hist = Game.chess.history({ verbose: true });
      const last = hist.length ? hist[hist.length - 1] : null;
      v.lastMove = last ? { from: last.from, to: last.to } : null;
      v.checkSq = Game.chess.in_check() ? Game.findKing(Game.chess.turn()) : null;
      v.selected = null;
      v.legal = [];
      v.particles = [];
      v.anims = [];
    }
    Game.selectSq = null;

    // 日志打标：保留文字，只标记为已撤销
    UI.markUndone(removed);

    // 台词一并回退（撤销后不重放，也不让旧台词继续被当成「对手上一句」）
    Game.lastThought = { w: '', b: '' };

    UI.setTurn();
    UI.setStatus('已悔棋');
    UI.updateControlState();
    UI.clearHintArrow();
    A11y.updateBoardLabel(Game.chess, Game.view);
    /* 局面倒回去了，评估条必须跟着回 —— 否则停在「悔棋前」的分数，
     * 用户会以为悔棋没生效。performUndo 不经过 applyMove，得自己触发。 */
    if (typeof Game.analyzePosition === 'function') Game.analyzePosition(Run.token());
    if (typeof Openings !== 'undefined') {
      if (Openings.ready()) UI.setOpening(Openings.current(Game.chess));
      else Openings.load().then(() => {
        if (Game.chess) UI.setOpening(Openings.current(Game.chess));
      });
    }

    // 让主循环重新等待玩家落子（悔棋后必然轮到人类）
    Game.resumeAfterUndo(h);
    return removed;
  },

  /* ---------- 提和 ---------- */
  async requestDraw() {
    if (this.busy) return;
    if (!this.canUse()) {
      UI.toast(Game.mode === 'aivai' ? '擂台观战模式不支持提和' : '等对手走完这一步再提和', 'bad');
      return;
    }
    const responder = this.responder();
    this.busy = true;
    const ok = await this.confirm({
      kind: 'draw',
      title: '提议和棋',
      char: responder && responder.char,
      line: responder ? Reactions.line(responder.char, 'draw') : '确定提议和棋吗？',
      hint: '确认后本局立即以和棋结束。',
      confirmLabel: '提和'
    });
    this.busy = false;
    if (!ok) return;

    await this.performDraw();
  },

  async performDraw() {
    if (!Game.chess || !Game.running) return;
    Game.agreedDraw = true;
    Clock.stop();
    UI.setStatus('双方同意和棋');
    Sound.click();
    // 与超时判负同一收尾路径：不推进代次，自己 finish
    Game.abort({ keepToken: true });
    try { await Game.finish(); } catch (e) { console.warn('[draw finish]', e); }
  },

  /* ---------- 确认框 ---------- */
  confirm(opts) {
    return new Promise((resolve) => {
      const bg = document.getElementById('caModal');
      if (!bg) { resolve(false); return; }

      const myToken = ++this.token;
      const cvs = document.getElementById('caPortrait');
      const nameEl = document.getElementById('caName');
      const titleEl = document.getElementById('caTitle');
      const lineEl = document.getElementById('caLine');
      const hintEl = document.getElementById('caHint');
      const okBtn = document.getElementById('caConfirm');
      const noBtn = document.getElementById('caCancel');

      const hasChar = !!opts.char && cvs;
      if (cvs) {
        cvs.style.display = hasChar ? '' : 'none';
        if (hasChar) renderAvatarTo(cvs, opts.char, 'idle');
      }
      nameEl.textContent = hasChar ? (opts.char.name || '对手') : '本地双人';
      titleEl.textContent = opts.title || '确认';
      hintEl.textContent = opts.hint || '';
      okBtn.textContent = opts.confirmLabel || '确定';
      lineEl.textContent = '';

      let settled = false;
      const prevFocus = document.activeElement;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        document.removeEventListener('keydown', onKey, true);
        bg.classList.remove('on');
        bg.setAttribute('aria-hidden', 'true');
        okBtn.onclick = null;
        noBtn.onclick = null;
        if (prevFocus && prevFocus.focus) { try { prevFocus.focus(); } catch (e) { } }
        resolve(result);
      };
      const onKey = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
      };
      okBtn.onclick = () => finish(true);
      noBtn.onclick = () => finish(false);

      bg.classList.add('on');
      bg.setAttribute('aria-hidden', 'false');
      document.addEventListener('keydown', onKey, true);
      setTimeout(() => { try { okBtn.focus(); } catch (e) { } }, 30);
      Sound.click();

      // 打字机（不阻塞确认按钮）
      (async () => {
        const s = String(opts.line || '');
        const caret = document.createElement('span');
        caret.className = 'caret';
        lineEl.textContent = '';
        lineEl.appendChild(caret);
        for (let i = 0; i < s.length; i++) {
          if (myToken !== this.token) return;
          if (!bg.classList.contains('on')) return;
          caret.before(document.createTextNode(s[i]));
          if (i % 3 === 0) Sound.bubble();
          await new Promise((r) => setTimeout(r, 26));
        }
        caret.remove();
      })();
    });
  }
};
