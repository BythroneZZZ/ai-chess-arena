/* =====================================================================
 * 12d · REVIEW —— 终局复盘（P2）
 *
 * 输入：一条棋谱记录（moves[] 带 fen，每步都是「走完之后」的局面）。
 * 输出：逐手失误标注 + 关键转折点 + 准确率 + 关键片段列表。
 *
 * 依赖 P1：全程走 Analysis.evaluate()（第二 Worker），绝不碰主 Engine，
 * 因此复盘可以在一局结束后、用户还想再摆一盘时并行进行。
 *
 * 判据（全部以白方视角厘兵 cp 为基准）：
 *   loss = 该步走子方视角的评估损失
 *     白方走：loss = cp[前] − cp[后]
 *     黑方走：loss = cp[后] − cp[前]
 *   ≥ 300  blunder ?? ；≥ 150  mistake ? ；≥ 70  inaccuracy ?!
 *
 * 精度：把 loss 截断在 1000 以内再做平均，避免「一步送杀」把整盘拉成 0。
 * 准确率用 acl → 100·exp(−acl/300)，只是本项目内部可比的启发式，
 * 不与 Lichess 的 Accuracy 数值对齐（算法不同，别拿来对比）。
 * ===================================================================== */
const REVIEW_TAGS = {
  blunder: { key: 'blunder', label: '??', cn: '严重失误', color: '#ff4d6d', min: 300 },
  mistake: { key: 'mistake', label: '?', cn: '失误', color: '#ff9f2e', min: 150 },
  inaccuracy: { key: 'inaccuracy', label: '?!', cn: '不够精确', color: '#ffcc4d', min: 70 },
  good: { key: 'good', label: '', cn: '正常', color: '#63e6a0', min: 0 },
  /* 拿不到评估的局面。**绝不能落到 good** ——
   * 曾经 `before != null && after != null` 不成立时 tag 保持默认 good，
   * 结果「g4 送杀」因为那一步评估返回 null 被判成「正常」，
   * 而覆盖率 4/5=80% 刚好躲过阈值检查，产出一份看着正常、实则漏判的复盘。
   * 空值就是空值，必须显示成「未评估」并计入 incomplete。 */
  unknown: { key: 'unknown', label: '—', cn: '未评估', color: '#7d74a6', min: -1 }
};

const REVIEW_CP_CAP = 1200;      // 送杀分不参与平均，避免整盘准确率被抹成 0
const REVIEW_LOSS_CAP = 1000;    // 单步 loss 上限
const REVIEW_DEPTH = 16;         // 深度上限（实际由超时截断）
const REVIEW_MS = 900;           // 每步评估时间预算
/* 缓存复用的最低深度。
 *
 * 曾经是 8，实测踩坑：live 评估跑 480ms 能到 depth 9，正好过线被直接复用，
 * 但同一局面 depth 9 与 depth 11 的 cp 差可达 126（中局 227 vs 101），
 * 而 ?! 阈值只有 70 —— 等于用实时评估的精度去做复盘判级。
 * 提到 12：低于它的缓存一律重算，宁可多花时间也不要判错。 */
const REVIEW_MIN_DEPTH = 12;

const Review = {
  token: 0,
  running: false,
  interrupted: false,
  progress: 0,
  total: 0,
  currentRec: null,
  last: null,             // 最近一次结果（UI 用）

  tagFor(loss) {
    if (loss >= REVIEW_TAGS.blunder.min) return REVIEW_TAGS.blunder;
    if (loss >= REVIEW_TAGS.mistake.min) return REVIEW_TAGS.mistake;
    if (loss >= REVIEW_TAGS.inaccuracy.min) return REVIEW_TAGS.inaccuracy;
    return REVIEW_TAGS.good;
  },

  /* 白方视角 cp（把 mate 折算成远大于任何正常局面的分值） */
  cpOf(res) {
    if (!res || !res.score) return null;
    const v = Analysis.whiteCp(res.score, res.turn);
    if (v == null) return null;
    /* mate 折算出来是 ±9990 左右，经 clamp 后全部压成 ±1200，
     * 于是「必死」与「大优 12 分」在统计上等值 —— 这是有意的：
     * 失误判级只看差值，送杀与送 12 分都该算 ??。
     * 但要注意 clamp 之后 mate 的正负号仍然保留，不能写成 abs。 */
    return clamp(v, -REVIEW_CP_CAP, REVIEW_CP_CAP);
  },

  /* 走完 n 步之后的所有局面（含初始局面） */
  positionsOf(rec) {
    const list = [{ ply: 0, fen: null, san: '开局', color: null }];
    (rec.moves || []).forEach((m, i) => {
      list.push({ ply: i + 1, fen: m.fen, san: m.san, uci: m.uci, color: m.color });
    });
    if (list[0].fen == null) {
      // 初始局面从第一步的前置推导：用空棋盘 FEN（所有棋谱都从这里开始）
      list[0].fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    }
    return list;
  },

  /**
   * 逐手分析。返回 Promise<结果对象>；被 cancel() 时返回 null。
   * @param {object} rec   棋谱记录
   * @param {object} opt   { onProgress(done,total) }
   */
  async start(rec, opt = {}) {
    if (!rec || !rec.moves || !rec.moves.length) return null;
    const myToken = ++this.token;
    this.running = true;
    this.interrupted = false;
    this.progress = 0;
    this.currentRec = rec;
    this.total = rec.moves.length + 1;
    /* 立刻给出反馈。
     *
     * 从点下「复盘」到第一条评估回来，中间要经过：
     * 引擎 init（可能首次加载 1.5MB）→ isready→readyok 握手 → 静默期 260ms → 首个 go。
     * 实测这段空窗 300~600ms，界面上什么都不动，像是没点中。
     * 所以在任何 await 之前先把进度条点亮、按钮切到「准备中…」。 */
    ReviewUI.setBusy('准备中…');
    ReviewUI.setProgress(0, this.total);

    const emit = (done, total) => {
      this.progress = done;
      this.total = total;
      if (opt.onProgress) { try { opt.onProgress(done, total); } catch (e) { /* 忽略 */ } }
      ReviewUI.setProgress(done, total);
    };

    try {
      const ready = await Analysis.init();
      if (myToken !== this.token) return null;
      if (!ready) { this.running = false; ReviewUI.fail('评估引擎不可用'); return null; }

      const pos = this.positionsOf(rec);
      const cps = new Array(pos.length).fill(null);
      let complete = 0;

      for (let i = 0; i < pos.length; i++) {
        if (myToken !== this.token) { this.running = false; return null; }
        let res = await Analysis.evaluate(pos[i].fen, {
          kind: 'review', depth: REVIEW_DEPTH, timeout: REVIEW_MS, minDepth: REVIEW_MIN_DEPTH
        });
        /* 单点重试：评估偶发返回 null（watchdog 超时 / stop 残影 / 被 live 评估抢占）。
         * 曾经不重试，null 一路流到 build() 被当成 good —— 「g4 送杀」因此漏判。
         * 补一次更宽的预算（×2），仍失败才算 incomplete。 */
        if ((!res || !res.score) && myToken === this.token && !this.interrupted) {
          res = await Analysis.evaluate(pos[i].fen, {
            kind: 'review', depth: REVIEW_DEPTH, timeout: REVIEW_MS * 2, minDepth: REVIEW_MIN_DEPTH
          });
        }
        /* 这里多一层判空：中途被 gameOver / 新局 cancelAll 时，
         * evaluate 会拿回 null（job 被结算为 null）。若不检查就继续，
         * 会得到一份「大部分 loss 为 null」的残缺报告并写进棋谱。 */
        if (myToken !== this.token || this.interrupted) { this.running = false; return null; }
        cps[i] = this.cpOf(res);
        if (cps[i] != null) complete++;
        emit(i + 1, pos.length);
      }

      /* 覆盖率兜底分两档处理。
       *
       * 旧逻辑是 `complete < pos.length * 0.8`：4/5 = 80% 刚好过关，
       * 而缺的那一个往往正是**关键局面**（g4 送杀后的必死局面），
       * 于是最重要的那步判成 good，报告却「正常」写入棋谱 —— 复盘彻底失效。
       *
       * 现在：缺评估的步一律标 unknown（见 build()），永不冒充 good；
       * 只剩「大面积缺评估」（过半）才判定引擎侧出了故障、拒绝出报告，
       * 免得棋谱里留一份几乎没有数据的空壳。少数几步缺失照常出报告，
       * 但摘要里会显式提示有几步未评估。 */
      if (complete * 2 < pos.length) {
        this.running = false;
        const miss = [];
        cps.forEach((v, i) => { if (v == null) miss.push(i === 0 ? '开局' : ('第' + i + '步后')); });
        ReviewUI.fail('复盘失败（仅 ' + complete + '/' + pos.length + ' 个局面评估成功，缺：' + miss.join('、') + '），未写入棋谱');
        return null;
      }

      const result = this.build(rec, pos, cps);
      this.running = false;
      this.last = result;
      this.attach(rec, result);
      return result;
    } catch (e) {
      this.running = false;
      console.warn('[review]', (e && e.message) || e);
      ReviewUI.fail('复盘中断：' + ((e && e.message) || e));
      return null;
    }
  },

  /* 纯函数：由 cps 序列算出全部标注，便于单测 */
  build(rec, pos, cps) {
    const moves = [];
    let aclSum = 0, aclCount = 0;
    let swing = { idx: -1, delta: 0 };
    let bestGain = { idx: -1, gain: 0 };
    const incompleteMoves = [];         // 因缺评估而无法判级的步（ply 列表）

    for (let i = 0; i < rec.moves.length; i++) {
      const m = rec.moves[i];
      const before = cps[i];
      const after = cps[i + 1];
      let loss = null;
      let tag = REVIEW_TAGS.unknown;      // 缺评估 → unknown，绝不默认 good
      if (before != null && after != null) {
        const sign = m.color === 'w' ? 1 : -1;
        loss = Math.round(sign * (before - after));
        if (loss < 0) loss = 0;
        if (loss > REVIEW_LOSS_CAP) loss = REVIEW_LOSS_CAP;
        tag = this.tagFor(loss);
        aclSum += loss; aclCount++;
        // 转折点：全局最大摆幅（谁走都会动的差值）
        const delta = Math.abs(after - before);
        if (delta > swing.delta) swing = { idx: i, delta, color: m.color };
        // 最佳一手：对走子方收益最大
        const gain = sign * (after - before);
        if (gain > bestGain.gain) bestGain = { idx: i, gain };
      } else {
        incompleteMoves.push(i + 1);
      }
      moves.push({
        ply: i + 1,
        color: m.color,
        san: m.san,
        cpBefore: before,
        cpAfter: after,
        loss,
        tag: tag.key,
        label: tag.label,
        cn: tag.cn
      });
    }

    const counts = { blunder: 0, mistake: 0, inaccuracy: 0 };
    moves.forEach((m) => { if (counts[m.tag] != null) counts[m.tag]++; });
    const wMoves = moves.filter((m) => m.color === 'w');
    const bMoves = moves.filter((m) => m.color === 'b');
    const sideAcl = (arr) => {
      const v = arr.filter((m) => m.loss != null);
      if (!v.length) return null;
      return Math.round(v.reduce((s, m) => s + m.loss, 0) / v.length);
    };
    const acl = aclCount ? aclSum / aclCount : null;
    const accuracy = acl == null ? null : clamp(Math.round(100 * Math.exp(-acl / 300)), 0, 100);

    const keyMoments = moves
      .filter((m) => m.tag === 'blunder' || m.tag === 'mistake')
      .sort((a, b) => (b.loss || 0) - (a.loss || 0))
      .slice(0, 6)
      .map((m) => m.ply);

    return {
      v: 1,
      at: nowISO(),
      depth: 'auto',
      budgetMs: REVIEW_MS,
      moves,
      counts,
      acl: acl == null ? null : Math.round(acl),
      aclW: sideAcl(wMoves),
      aclB: sideAcl(bMoves),
      accuracy,
      turn: swing.idx >= 0 ? swing.idx + 1 : null,
      turnDelta: swing.idx >= 0 ? Math.round(swing.delta) : 0,
      best: bestGain.idx >= 0 ? bestGain.idx + 1 : null,
      bestGain: bestGain.idx >= 0 ? Math.round(bestGain.gain) : 0,
      keyMoments,
      /* 缺评估的步一定要暴露出来，UI 要能提示「这几步没评估，判级不可信」。
       * 静默当成 good 是之前漏判 g4 送杀的真正原因。 */
      incomplete: incompleteMoves,
      incompleteCount: incompleteMoves.length
    };
  },

  /* 写回棋谱记录并落盘（回放时可直接展示） */
  attach(rec, result) {
    if (!rec || !result) return;
    rec.review = result;
    (rec.moves || []).forEach((m, i) => {
      const r = result.moves[i];
      if (!r) return;
      m.loss = r.loss;
      m.tag = r.tag;
    });
    const i = Store.records.findIndex((x) => x.id === rec.id);
    if (i >= 0) { Store.records[i] = rec; Store.saveRecords(); }
  },

  cancel(why) {
    this.token++;
    this.interrupted = true;
    this.running = false;
    ReviewUI.setProgress(0, 0);
    if (why) Debug.log('[review] cancelled:', why);
  },

  /* 取某条记录的复盘结果（没有就是 null） */
  of(rec) { return rec && rec.review ? rec.review : null; },

  /* 给 UI/测试用的摘要文本 */
  summary(rec) {
    const r = this.of(rec);
    if (!r) return '未复盘';
    const c = r.counts || {};
    return `准确率 ${r.accuracy == null ? '—' : r.accuracy + '%'} · 失误 ${c.blunder || 0} / 小错 ${c.mistake || 0} / 不精确 ${c.inaccuracy || 0}`;
  }
};

/* =====================================================================
 * 12e · REVIEW UI —— 复盘面板（结果页 + 回放页共用一套渲染）
 * ===================================================================== */
const ReviewUI = {
  /* 两个进度条：结果页（reviewBarRes）与回放页（reviewBar）。id 必须分开，
   * 否则 getElementById 只会拿到 DOM 里靠前的那个，另一个永远不更新。 */
  bars() {
    const list = [];
    const a = document.getElementById('reviewBar');
    const b = document.getElementById('reviewBarRes');
    if (a) list.push(a);
    if (b) list.push(b);
    return list;
  },

  /* 阶段文案：把「引擎准备 → 逐手分析 → 完成」三态显式化。
   * 只在 progress 为 0 时用，避免覆盖百分比。 */
  setBusy(text) {
    const txt = document.getElementById('reviewBtnText');
    if (txt) txt.textContent = text || '准备中…';
    this.bars().forEach((bar) => bar.classList.add('on'));
    const btn = document.getElementById('resReview');
    if (btn) btn.disabled = true;
  },

  setProgress(done, total) {
    const pct = total ? Math.round((done / total) * 100) : 0;
    const active = total > 0 && done < total;
    this.bars().forEach((bar) => {
      bar.classList.toggle('on', active);
      const fill = bar.querySelector('.review-bar-fill');
      if (fill) fill.style.width = pct + '%';
    });
    const txt = document.getElementById('reviewBtnText');
    /* done === 0 时保持「准备中…」，不要立刻变成「复盘 0%」——
     * 0% 看起来像没开始，准备中才传达「在做事」。 */
    if (txt) {
      if (total > 0 && done === 0) txt.textContent = '准备中…';
      else txt.textContent = active ? `复盘 ${pct}%` : '复盘';
    }
    const btn = document.getElementById('resReview');
    if (btn && total) btn.disabled = active;
  },

  fail(msg) {
    this.setProgress(0, 0);
    const btn = document.getElementById('resReview');
    if (btn) btn.disabled = false;
    if (typeof UI !== 'undefined') UI.toast(msg, 'bad');
  },
  /* 一行一步：用于回放页的关键片段 */
  line(m) {
    const cp = m.cpAfter == null ? '—' : (m.cpAfter / 100).toFixed(1);
    const sign = m.color === 'w' ? '' : '...';
    const n = Math.ceil(m.ply / 2);
    return `${n}.${sign}${m.san}`;
  },

  render(rec) {
    const r = Review.of(rec);
    const box = document.getElementById('reviewPanel');
    if (!box) return;
    const summaryEl = document.getElementById('reviewSummary');
    const listEl = document.getElementById('reviewList');
    const accEl = document.getElementById('reviewAcc');
    if (!r) {
      if (summaryEl) summaryEl.textContent = '这盘还没有复盘数据。';
      if (listEl) listEl.innerHTML = '';
      if (accEl) accEl.textContent = '—';
      return;
    }
    if (accEl) accEl.textContent = r.accuracy == null ? '—' : r.accuracy + '%';
    if (summaryEl) {
      const c = r.counts || {};
      summaryEl.innerHTML =
        `<span class="rv-blunder">?? 严重失误 ${c.blunder || 0}</span> · ` +
        `<span class="rv-mistake">? 失误 ${c.mistake || 0}</span> · ` +
        `<span class="rv-inacc">?! 不精确 ${c.inaccuracy || 0}</span>` +
        `<br><span style="color:#7d74a6">均损 ${r.acl == null ? '—' : r.acl + 'cp'} · ` +
        `白 ${r.aclW == null ? '—' : r.aclW} / 黑 ${r.aclB == null ? '—' : r.aclB}</span>` +
        /* 有未评估步必须显式警告：这些步的判级是空的，报告不能假装完整。 */
        (r.incompleteCount ? `<br><span style="color:#ff9f2e">注意：${r.incompleteCount} 步未评估（第 ${r.incomplete.join('、')} 步），判级不可信</span>` : '');
    }
    const infoEl = document.getElementById('reviewTurn');
    if (infoEl) {
      if (r.turn) {
        const m = r.moves[r.turn - 1];
        /* line() 返回里含 m.san —— 它来自 PGN 导入，是可注入的文本。
         * 这里用 innerHTML 拼高亮标签，所以必须对内容单独转义。 */
        infoEl.innerHTML = `<b style="color:#ffcc4d">转折点 ${esc(this.line(m))}</b>（摆幅 ${r.turnDelta}cp）` +
          (r.best ? ` · 最佳一手 ${esc(this.line(r.moves[r.best - 1]))}（+${r.bestGain}cp）` : '');
      } else {
        infoEl.textContent = '没有明显的转折点。';
      }
    }
    if (!listEl) return;
    listEl.innerHTML = '';
    const rows = (r.keyMoments || []).map((ply) => r.moves[ply - 1]).filter(Boolean);
    if (!rows.length) {
      listEl.innerHTML = '<div class="hint">全局没有出现 ? 或 ?? 级别的失误。</div>';
      return;
    }
    rows.forEach((m) => {
      const el = document.createElement('div');
      el.className = 'rv-row ' + m.tag;
      el.innerHTML = `<span class="rv-tag">${esc(m.label)}</span>` +
        `<span class="rv-mv">${esc(this.line(m))}</span>` +
        `<span class="rv-loss">${m.loss == null ? '未评估' : '-' + m.loss + 'cp'}</span>`;
      el.title = m.cn + '：' +
        (m.cpBefore == null ? '—' : (m.cpBefore / 100).toFixed(1)) + ' → ' +
        (m.cpAfter == null ? '—' : (m.cpAfter / 100).toFixed(1));
      el.onclick = () => {
        if (typeof Replay === 'object' && UI.replayData) { Replay.goto(m.ply); Sound.click(); }
      };
      listEl.appendChild(el);
    });
  },

  /* 在回放步进时同步「当前步」标注 */
  markCurrent(rec) {
    const r = Review.of(rec);
    const el = document.getElementById('reviewNow');
    if (!el) return;
    if (!r) { el.textContent = ''; return; }
    const i = UI.replayIdx;
    if (i <= 0) { el.textContent = '开局局面'; el.className = 'rv-now'; return; }
    const m = r.moves[i - 1];
    if (!m) { el.textContent = ''; return; }
    el.className = 'rv-now ' + m.tag;
    if (m.tag === 'unknown') {
      el.textContent = '这步未评估（判级不可用）';
    } else if (m.tag === 'good') {
      el.textContent = `这步正常（${m.loss == null ? '—' : '-' + m.loss + 'cp'}）`;
    } else {
      el.textContent = `${m.label} ${m.cn} · 损失 ${m.loss}cp`;
    }
  }
};
