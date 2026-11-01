/* =====================================================================
 * 22 · OPENINGS — 开局库（ECO 3606 位置）
 *
 * 数据：data/openings.json
 *   { v, families[], segments[], pos: { "<FEN前4段>": [eco, famIdx, segIds[], nextUci] } }
 *
 * 设计要点：
 *   1. 按 FEN 前 3 段索引（棋盘+走子方+易位权），忽略吃过路兵/半回合/回合数。
 *      这样同一局面无论从哪条路径到达都能命中。
 *      ⚠️ 吃过路兵那段**不能**计入 key —— 详见 keyOf() 的注释。
 *   2. 懒加载：首次查询或开局提示时才 fetch，不拖慢首屏。
 *   3. 每个位置给出 nextUci —— 这是「该开局下已被收录的下一手」，用于提示功能。
 *   4. 名称按 family + segments 池化，还原时拼接，361 KB 装下 3606 条。
 * ===================================================================== */
const Openings = {
  data: null,
  loading: null,
  failed: false,
  URL: './data/openings.json',
  /* 当前对局的命名识别：最多缓存每条路径的局面名 */
  _lastName: null,

  async load() {
    if (this.data) return this.data;
    if (this.loading) return this.loading;
    this.loading = (async () => {
      try {
        /* 优先取内联常量（file:// 模式由 build.py 注入 window.OPENINGS_BOOK），
         * 取不到再 fetch —— HTTP 模式行为不变。 */
        const inlineBook = (typeof window !== 'undefined' && window.OPENINGS_BOOK)
          ? window.OPENINGS_BOOK : null;
        let json;
        if (inlineBook) {
          json = inlineBook;
        } else {
          const res = await fetch(this.URL, { cache: 'force-cache' });
          if (!res.ok) throw new Error('HTTP ' + res.status);
          json = await res.json();
        }
        if (!json || json.v !== 1 || !json.pos) throw new Error('数据格式不符');
        this.data = json;
        this._byFen = this._index(json);
        return json;
      } catch (e) {
        this.failed = true;
        console.warn('[openings] 加载失败，开局库不可用：', e.message || e);
        return null;
      } finally {
        this.loading = null;
      }
    })();
    return this.loading;
  },

  ready() { return !!this.data; },

  /* chess.js 的 fen() -> 索引键：只取前 3 段（棋盘 + 走子方 + 易位权）
   *
   * 为什么第 4 段（吃过路兵）必须丢掉：
   *   那段只是「上一步是不是双步兵」的临时标记，同一棋盘局面在 ECO 里是同一条。
   *   而原始数据的 3606 条里，只有 5 条带 ep 值，其余 3601 条都是 '-'。
   *   一旦把 ep 计入 key，chess.js 在双步兵之后给出的 'c6' / 'e6' / 'e3' / 'd6'
   *   就永远匹配不上 '-'，结果是——
   *       1.e4（王兵开局）、1.e4 c5（西西里）、1.e4 e5、1.e4 d5（斯堪的纳维亚）
   *   这些最常见的开局**全部查不到**，开局名要等到 2.Nf3 之后（ep 归位）才肯显示。
   *   实测：开局识别功能因此基本失效，界面长期停在「开局阶段」。
   */
  keyOf(fen) {
    return String(fen || '').split(' ').slice(0, 3).join(' ');
  },

  /* 建索引：把原始 4 段键归一化成 3 段。
   *
   * 归一化会让两条原始键撞车（如 '... w KQkq e6' 与 '... w KQkq -' 指向同一局面）。
   * 实测只有 1 组冲突，且两条的名称不同，所以分两趟建：
   *   第一趟只收 ep 为 '-' 的规范条目，第二趟补空（带 ep 的不覆盖规范的）。 */
  _index(json) {
    const entries = Object.entries(json.pos);
    const m = new Map();
    for (const [k, v] of entries) {
      if (k.split(' ')[3] === '-') m.set(this.keyOf(k), v);
    }
    for (const [k, v] of entries) {
      const k3 = this.keyOf(k);
      if (!m.has(k3)) m.set(k3, v);
    }
    return m;
  },

  nameOf(entry) {
    if (!entry) return null;
    const fam = this.data.families[entry[1]] || '';
    const segs = (entry[2] || []).map((i) => this.data.segments[i]).filter(Boolean);
    return segs.length ? fam + ': ' + segs.join(', ') : fam;
  },

  /* 查询某个 FEN 对应的开局信息 */
  lookup(fen) {
    if (!this.data) return null;
    const entry = this._byFen.get(this.keyOf(fen));
    if (!entry) return null;
    return {
      eco: entry[0] || '',
      name: this.nameOf(entry) || '',
      nextUci: entry[3] || null
    };
  },

  /* 当前对局的开局名。
   *
   * 关键认知：ECO 库索引的是「走出该步之后的局面」，且只收录有名字的局面。
   * e4 之后的局面本身没有命名（它是 Sicilian / Ruy Lopez 等的共同父节点），
   * 所以要沿历史回退，取「最近一次命中的命名局面」。
   */
  current(chess) {
    if (!this.data || !chess) return null;
    const hist = chess.history({ verbose: true });
    if (!hist.length) return null;

    // 1) 回放历史，取最近一次命中的命名局面
    const replayer = new Chess();
    let lastHit = null;
    for (const m of hist) {
      replayer.move({ from: m.from, to: m.to, promotion: m.promotion });
      const info = this.lookup(replayer.fen());
      if (info && info.name) lastHit = info;
    }
    if (lastHit) return lastHit;

    // 2) 整条路径都无命名（如 1.e4 d5 之后）：
    //    不猜测。一个局面可能通向几十个开局，猜错比不显示更糟。
    //    显示「开局阶段」即可，等到命中命名局面再更新。
    return { eco: '', name: '开局阶段', pending: true };
  },

  /* 该局面下的「开局库建议着法」。
   *
   * 数据里的 moves 是「该局面的全部合法着法」（按 UCI 字母序），不是推荐着法，
   * 也无法直接区分主线与冷门。因此这里用两层启发式：
   *
   *   1. 命中质量：走完这一步后，该局面在库中是否有命名。
   *   2. 谱系广度：从该局面能继续到达多少命名子局面（BFS 两层深度）。
   *      主线着法的后续分支远多于冷门着法 —— 例如 1.e4 之后有上百条命名线，
   *      而 1.Nh3 之后只有 Amar Opening 寥寥几条。
   *
   * 二者加权：广度优先，其次名字短（越短越靠近体系根）。
   */
  suggest(chess) {
    if (!this.data || !chess) return null;
    const legal = chess.moves({ verbose: true });
    if (!legal.length) return null;

    const base = this.lookup(chess.fen());
    const baseFam = base && base.name ? this.familyOf(base.name) : null;
    const ply = chess.history().length;

    let best = null;
    for (const mv of legal) {
      const c = new Chess(chess.fen());
      let moved;
      try { moved = c.move({ from: mv.from, to: mv.to, promotion: mv.promotion }); }
      catch (e) { continue; }
      if (!moved) continue;

      const info = this.lookup(c.fen());
      if (!info || !info.name) continue;

      const fam = this.familyOf(info.name);
      const sameFamily = baseFam ? fam === baseFam : true;
      const spread = this.spread(c, 2);
      const nameLen = info.name.length;

      // 权重：同体系 ≫ 谱系广度 ≫ 名字短（越短越靠近根）
      const score = (sameFamily ? 1e7 : 0) + spread * 1000 - nameLen;
      if (!best || score > best.score) {
        best = { score, move: mv, opening: info, sameFamily, spread };
      }
    }
    if (!best) return null;
    return { move: best.move, opening: best.opening, sameFamily: best.sameFamily, spread: best.spread };
  },

  /* 从某局面出发，限定深度内可达的命名局面数（衡量该线的主流程程度） */
  spread(chess, depth) {
    if (!this.data || depth <= 0) return 0;
    let count = 0;
    let frontier = [chess];
    const seen = new Set();
    for (let d = 0; d < depth; d++) {
      const next = [];
      for (const node of frontier) {
        let moves;
        try { moves = node.moves({ verbose: true }); } catch (e) { continue; }
        // 每层最多展开 40 个子节点，避免开局阶段全量爆炸
        for (const mv of moves.slice(0, 40)) {
          const c = new Chess(node.fen());
          try { if (!c.move({ from: mv.from, to: mv.to, promotion: mv.promotion })) continue; }
          catch (e) { continue; }
          const k = this.keyOf(c.fen());
          if (seen.has(k)) continue;
          seen.add(k);
          if (this._byFen.has(k)) count++;
          next.push(c);
        }
      }
      frontier = next.slice(0, 60);
      if (!frontier.length) break;
    }
    return count;
  },

  /* 轻量前探：只看一步，选出谱系最广的命名子局面所属体系。
   *
   * 单看名字长度会选错（1.e4 之后 "Owen Defense" 比 "Sicilian Defense" 短，
   * 但前者是冷门）。改用 spread（该子局面能到达多少命名局面）作为主判据。
   */
  quickGuess(chess) {
    if (!this.data || !chess) return null;
    let moves;
    try { moves = chess.moves({ verbose: true }); } catch (e) { return null; }

    // 开局前几步分支极多，只取有希望的候选（能到达命名局面者）
    const cands = [];
    for (const mv of moves) {
      const c = new Chess(chess.fen());
      let moved;
      try { moved = c.move({ from: mv.from, to: mv.to, promotion: mv.promotion }); }
      catch (e) { continue; }
      if (!moved) continue;
      const info = this.lookup(c.fen());
      if (!info || !info.name) continue;
      cands.push({ c, name: info.name });
    }
    if (!cands.length) return null;

    // 候选太多时先按名字长度截断（短名 ≈ 体系根，更可能在主线上）
    cands.sort((a, b) => a.name.length - b.name.length);
    const top = cands.slice(0, 6);

    let best = null;
    for (const cd of top) {
      const s = this.spread(cd.c, 2);
      const score = s * 1000 - cd.name.length;
      if (!best || score > best.score) best = { score, name: cd.name, spread: s };
    }
    return best ? best.name : null;
  },

  /* "Ruy Lopez: Morphy Defense" -> "Ruy Lopez" */
  familyOf(name) {
    if (!name) return '';
    const i = name.indexOf(':');
    return i >= 0 ? name.slice(0, i) : name;
  },

  /* 已记录的开局长度（用于判断是否还在「开局阶段」） */
  plyOf(chess) {
    return chess && chess.history ? chess.history().length : 0;
  }
};
