/* =====================================================================
 * 21 · SETUP SCREEN LOGIC
 * ===================================================================== */
let pendingMode = 'pve';

function refreshSetup() {
  const mode = pendingMode;
  const isPve = mode === 'pve';
  const isAivai = mode === 'aivai';
  const isPvp = mode === 'pvp';
  const side = $('#selSide').value === 'b' ? 'b' : 'w';

  $('#setupTitle').textContent = isPve ? '人机对弈' : isAivai ? '双 API 擂台' : '本地双人';
  $('#difficultyRow').style.display = isPve ? '' : 'none';
  $('#sideRow').style.display = isPve ? '' : 'none';
  $('#narratorRow').style.display = isPvp ? 'block' : 'none';
  $('#aivaiOpts').style.display = isAivai ? '' : 'none';
  const clockRow = document.getElementById('clockRow');
  if (clockRow) clockRow.style.display = isPvp ? 'none' : '';
  const aot = document.getElementById('aivaiOptsTitle'); if (aot) aot.style.display = isAivai ? '' : 'none';
  const pL = document.getElementById('paramsL'), pR = document.getElementById('paramsR');
  if (pL) pL.classList.toggle('hidden', !isAivai);
  if (pR) pR.classList.toggle('hidden', !isAivai);
  const dRow = document.getElementById('delayRowPve'); if (dRow) dRow.style.display = isAivai ? 'none' : '';
  const tRow = document.getElementById('tempRowPve'); if (tRow) tRow.style.display = isAivai ? 'none' : '';

  // 角色区：永远左右各一个，PVE 时按执子标注「你 / 对手」
  $('#setupRightPanel').style.display = isPvp ? 'none' : '';
  $('#setupCols').style.gridTemplateColumns = isPvp ? '1fr' : '';

  const yx = side === 'w';
  if (isPve) {
    $('#leftTitle').textContent = (yx ? '你的角色 · WHITE（先手）' : 'AI 对手 · WHITE（先手）');
    $('#rightTitle').textContent = (yx ? 'AI 对手 · BLACK（后手）' : '你的角色 · BLACK（后手）');
    $('#apiRowL').style.display = yx ? 'none' : '';
    $('#apiRowR').style.display = yx ? '' : 'none';
    $('#leftHint').innerHTML = yx
      ? '你执白先手。右侧是 AI 对手：<b>Stockfish 引擎</b>按难度算棋，可给它配 API 只生成台词（不填就用内置台词库）。'
      : '你执黑后手，棋盘自动翻转。左侧是 AI 对手：<b>Stockfish 引擎</b>按难度算棋，可给它配 API 只生成台词。';
    $('#setupWarn').textContent = '引擎已内联，断网也能下；API 只影响台词，不影响棋力。';
  } else if (isAivai) {
    $('#leftTitle').textContent = 'WHITE SIDE · 白方';
    $('#rightTitle').textContent = 'BLACK SIDE · 黑方';
    $('#apiRowL').style.display = '';
    $('#apiRowR').style.display = '';
    $('#leftHint').textContent = '白方：模型自己决定走法 + 台词，非法步自动兜底。';
    $('#rightHint').textContent = '黑方：独立配置，可与白方完全不同厂商。';
    $('#setupWarn').textContent = '两边都留空也能跑：会退化为引擎对战 + 内置台词。';
  } else {
    $('#leftTitle').textContent = 'LOCAL PVP · 白方 / 黑方';
    $('#rightTitle').textContent = 'BLACK SIDE';
    $('#leftHint').textContent = '两人轮流在同一设备落子。可选解说角色与解说 API，每步生成一句点评。';
    $('#setupWarn').textContent = '';
  }
}

function buildPlayersFromSetup() {
  const mode = pendingMode;
  const getChar = (sel) => Store.char($(sel).value) || Store.chars[0];
  const getApi = (sel) => Store.api($(sel).value);
  const L = { char: getChar('#selCharL'), api: null, kind: 'human', human: false };
  const R = { char: getChar('#selCharR'), api: null, kind: 'human', human: false };
  const human = { w: false, b: false };

  if (mode === 'pve') {
    // L = 白方, R = 黑方；玩家执 side，另一侧由引擎驱动 + 可选 API 出台词
    const side = $('#selSide').value === 'b' ? 'b' : 'w';
    const mine = side === 'w' ? L : R;
    const enemy = side === 'w' ? R : L;
    mine.kind = 'human'; mine.human = true;
    enemy.kind = 'engine'; enemy.api = getApi(side === 'w' ? '#selApiR' : '#selApiL');
    human[side] = true;
    L.color = 'w'; R.color = 'b';
  } else if (mode === 'aivai') {
    L.kind = 'api'; R.kind = 'api';
    L.api = getApi('#selApiL'); R.api = getApi('#selApiR');
  } else {
    L.kind = 'human'; R.kind = 'human';
    human.w = true; human.b = true;
  }
  return { players: { w: L, b: R }, human };
}

/* =====================================================================
 * 21b · 棋盘朝向 —— 「玩家1永远在下」
 *
 * 规则（唯一真源，棋盘与评估条都从这里取）：
 *   把「玩家1」执的颜色放到屏幕下方。
 *
 *   模式      玩家1是谁                     朝向
 *   --------  -----------------------------  ---------------------------
 *   PVE       人类玩家                      执白→白在下；执黑→黑在下
 *   PVP       白方（先手，本地双人约定）      白在下
 *   AI vs AI  没有人类，按观众默认           白在下
 *
 * 为什么要立成规则：
 *   早先只有「PVE 执黑时翻一下」，其它情况全靠一个**持久化**的
 *   settings.boardFlip。后果是手动点一次「翻转」就写进 localStorage，
 *   下一局执白也被翻过来 —— 临时动作污染了默认视角（已复现）。
 *   现在朝向由规则算，手动翻转只是**本局临时覆盖**，开局即清空。
 * ===================================================================== */

/* 玩家1执什么颜色 */
function playerOneColor(mode, side) {
  if (mode === 'pve') return side === 'b' ? 'b' : 'w';
  // PVP 与 AI vs AI：白方（先手）在下
  return 'w';
}

/* 该不该翻转（true = 黑在下）。overrides 是本局临时覆盖。 */
function autoFlipFor(mode, side, overrides) {
  if (overrides) return !!overrides;
  return playerOneColor(mode, side) === 'b';
}

/* =====================================================================
 * 22 · MATCH START
 * ===================================================================== */
async function startMatch() {
  const mode = pendingMode;
  const { players, human } = buildPlayersFromSetup();

  if (mode === 'aivai' && !players.w.api && !players.b.api) {
    UI.toast('两边都没有 API：将退化为引擎对战 + 内置台词', '');
  }

  UI.go('battle');
  const diff = parseInt($('#selDiff').value, 10) || 2;
  const cfg = {
    mode,
    players,
    human,
    difficulty: diff,
    delayMs: parseInt($('#rngDelay').value, 10) || 0,
    temp: parseFloat($('#rngTemp').value) || 0.9,
    auto: $('#chkAuto').checked,
    maxMoves: parseInt($('#inpMaxMoves').value, 10) || 120,
    clockPreset: $('#selClock') ? $('#selClock').value : 'unlimited',
    opt: {
      w: {
        temperature: parseFloat($('#rngTempL').value),
        maxTokens: parseInt($('#inpMaxTokL').value, 10) || 80,
        delay: parseInt($('#inpDelayL').value, 10) || 0
      },
      b: {
        temperature: parseFloat($('#rngTempR').value),
        maxTokens: parseInt($('#inpMaxTokR').value, 10) || 80,
        delay: parseInt($('#inpDelayR').value, 10) || 0
      }
    },
    narrator: mode === 'pvp' ? Store.char($('#selNarrator').value) : null,
    narratorApi: mode === 'pvp' ? Store.api($('#selNarrApi').value) : null
  };
  window.GAME_MODE_LABEL = mode === 'pve' ? 'PVE MATCH' : mode === 'aivai' ? 'AI VS AI EXHIBITION' : 'LOCAL PVP';

  /* 朝向由规则决定：玩家1执的颜色在下方。
   * 手动翻转只是本局覆盖（Game.flipOverride），新局清空 —— 不再持久化。 */
  const side = $('#selSide') ? ($('#selSide').value === 'b' ? 'b' : 'w') : 'w';
  Game.flipOverride = null;
  const flip = autoFlipFor(mode, side, Game.flipOverride);
  if (Game.view) { Game.view.setFlipped(flip); }
  if (typeof EvalBar !== 'undefined') { EvalBar.flipped = flip; EvalBar.draw(); }

  $('#resultOverlay').classList.remove('on');
  Engine.init();

  Game.start(cfg);
}

/* =====================================================================
 * 22b · PGN IMPORT
 * ===================================================================== */
const PgnImport = {
  parse(text) {
    const raw = String(text || '').trim();
    if (!raw) throw new Error('PGN 为空');

    // 去掉走法编号、注释、变着、NAG、结果标记
    let body = raw
      .replace(/\{[^}]*\}/g, ' ')            // {注释}
      .replace(/;[^\n]*/g, ' ')              // ; 行注释
      .replace(/\([^)]*\)/g, ' ')            // (变着)
      .replace(/\$\d+/g, ' ')                // NAG
      .replace(/\[(?!)/g, ' ')               // 占位，保持结构
      .replace(/\[[^\]]*\]/g, ' ')          // [标签]
      .replace(/\d+\.(\.\.)?/g, ' ')        // 1. / 1...
      .replace(/\*|1-0|0-1|1\/2-1\/2/g, ' ') // 结果
      .replace(/[?!]+/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    const tokens = body ? body.split(' ').filter(Boolean) : [];
    if (!tokens.length) throw new Error('没有找到任何着法');

    const chess = new Chess();
    const moves = [];
    for (const san of tokens) {
      let mv;
      try { mv = chess.move(san); } catch (e) { mv = null; }
      if (!mv) throw new Error(`第 ${moves.length + 1} 步无法解析：「${san}」`);
      moves.push({
        color: mv.color,
        san: mv.san,
        uci: mv.from + mv.to + (mv.promotion || ''),
        fen: chess.fen(),
        thought: '',
        source: 'import',
        cap: !!mv.captured,
        check: /[+#]/.test(mv.san)
      });
    }

    const headers = {};
    for (const m of raw.matchAll(/\[(\w+)\s+"([^"]*)"\]/g)) headers[m[1]] = m[2];

    let result = 'maxmoves', winner = null;
    if (chess.in_checkmate()) { winner = chess.turn() === 'w' ? 'b' : 'w'; result = 'checkmate'; }
    else if (chess.in_stalemate()) result = 'stalemate';
    else if (chess.insufficient_material()) result = 'material';
    else if (chess.in_threefold_repetition()) result = 'repetition';
    else if (chess.in_draw()) result = 'draw';

    return {
      id: uid('rec'),
      date: nowISO(),
      mode: 'import',
      result, winner,
      white: { charId: Store.chars[0].id, name: headers.White || '白方', api: '导入' },
      black: { charId: (Store.chars[1] || Store.chars[0]).id, name: headers.Black || '黑方', api: '导入' },
      moves,
      pgn: chess.pgn(),
      duration: 0
    };
  },

  open() {
    $('#pgnBox').classList.remove('hidden');
    $('#pgnImportMsg').textContent = '';
    $('#pgnInput').focus();
  },
  close() { $('#pgnBox').classList.add('hidden'); },

  commit() {
    const msg = $('#pgnImportMsg');
    try {
      const rec = this.parse($('#pgnInput').value);
      Store.records.unshift(rec);
      Store.saveRecords();
      msg.className = 'hint ok';
      msg.textContent = `· 已导入 ${rec.moves.length} 步`;
      this.close();
      UI.renderRecords();
      UI.toast('PGN 导入成功', 'good');
    } catch (e) {
      msg.className = 'hint err';
      msg.textContent = '× ' + (e && e.message ? e.message : '解析失败');
    }
  }
};

/* =====================================================================
 * 23 · REPLAY
 * ===================================================================== */
const Replay = {
  /* 回放棋盘边长：按视口与容器实测宽度算，向下取整到 8 的倍数。
   * BoardView 要求整数倍缩放，否则像素棋子会发虚。 */
  boardSize() {
    const vw = window.innerWidth;
    const screenPad = vw <= 1000 ? 16 : 32;   // .screen 左右内边距
    const frameChrome = 32;                    // #boardFrameR padding 12×2 + border 4×2
    const wrap = document.querySelector('.replay-wrap');
    const avail = vw <= 900
      ? vw - screenPad - frameChrome
      : Math.min((wrap ? wrap.clientWidth : vw) - 320 - 16, 760) - frameChrome;
    let s = clamp(avail, 200, 720);
    /* 纵向只作上限，且给足余量：单列布局下棋盘中上方有 topbar，
     * 下方是步进按钮。用 innerHeight-210 会在 720 高的屏上算出 510，
     * 反而比宽度允许的 272 还小 —— 棋盘不该被压小，页面本来就能滚。 */
    s = Math.min(s, Math.floor(window.innerHeight * 0.8));
    s = Math.max(200, s);
    return Math.floor(s / 8) * 8;
  },

  /* 棋盘容器宽度会随屏幕方向/滚动条变化，每次进回放都重算一次 */
  fitBoard() {
    if (UI.replayView) UI.replayView.resize(this.boardSize());
  },

  open(rec) {
    UI.replayData = rec;
    UI.replayIdx = 0;
    UI.go('replay');
    $('#rpWhite').textContent = rec.white.name + ' (' + rec.white.api + ')';
    $('#rpBlack').textContent = rec.black.name + ' (' + rec.black.api + ')';
    const rt = { checkmate: '将死', stalemate: '逼和', material: '子力不足', repetition: '重复', draw: '和棋', maxmoves: '步数上限', aborted: '中止' };
    $('#rpResult').textContent = (rec.winner ? (rec.winner === 'w' ? '白胜 · ' : '黑胜 · ') : '') + (rt[rec.result] || rec.result);
    $('#rpCount').textContent = rec.moves.length;
    $('#rpMode').textContent = rec.mode === 'pve' ? '人机' : rec.mode === 'aivai' ? 'AI vs AI' : '本地双人';
    if (!UI.replayView) {
      UI.replayView = new BoardView($('#replayCanvas'), { pieceMode: Store.settings.pieceMode, flipped: false });
    }
    /* 首次创建时 BoardView 用的是默认 480，必须立刻按当前视口改掉。
     * 320px 屏上不这么做就会横向溢出 96px（曾经的实际 bug）。 */
    this.fitBoard();
    UI.replayView.charMap = { w: Store.char(rec.white.charId), b: Store.char(rec.black.charId) };
    this.goto(0);
    refreshCharSelects();
    $('#rpChar').value = rec.white.charId;
    // 复盘数据：有就渲染，没有就给「复盘此局」留入口
    if (typeof ReviewUI !== 'undefined') {
      ReviewUI.render(rec);
      const accEl = document.getElementById('reviewAcc');
      if (accEl) accEl.textContent = rec.review && rec.review.accuracy != null ? rec.review.accuracy + '%' : '—';
    }
  },
  goto(i) {
    const rec = UI.replayData; if (!rec) return;
    i = clamp(i, 0, rec.moves.length);
    UI.replayIdx = i;
    const c = new Chess();
    for (let k = 0; k < i; k++) {
      const m = rec.moves[k];
      try { c.move({ from: m.uci.slice(0, 2), to: m.uci.slice(2, 4), promotion: m.uci[4] || undefined }); } catch (e) { }
    }
    const v = UI.replayView;
    v.pieces = [];
    v.setPosition(c);
    if (i > 0) {
      const mv = rec.moves[i - 1];
      v.lastMove = { from: mv.uci.slice(0, 2), to: mv.uci.slice(2, 4) };
      v.checkSq = c.in_check() ? Game.findKingOn(c, c.turn()) : null;
      /* 注意：mv.source 与 rec.white.api / rec.black.api 都是**用户可控**的
     * （配置名自由输入、PGN 导入可带任意头信息）。这里原先直接拼进 innerHTML，
     * 导入一份构造过的棋谱就能在回放页执行注入脚本。
     * 统一走 esc()；只有自己写死的字面量才允许不转义。 */
    const srcLabel = mv.source
      ? String(mv.source)
      : (mv.color === 'w' ? (rec.white.api || '本地') : (rec.black.api || '本地'));
    $('#rpMoveInfo').innerHTML = `<b style="color:#ffcc4d">${esc(mv.san)}</b> · ${mv.color === 'w' ? '白' : '黑'}方 · ${esc(mv.uci)}<br><span style="color:#6f668f">${mv.cap ? '吃子 ' : ''}${mv.check ? '将军' : ''} · 来源 ${esc(srcLabel)}</span>`;
    } else {
      v.lastMove = null; v.checkSq = null;
      $('#rpMoveInfo').textContent = '开局局面';
    }
    $('#rpIdx').textContent = i + ' / ' + rec.moves.length;
    const cur = i > 0 ? rec.moves[i - 1] : null;
    $('#rpThought').textContent = cur && cur.thought ? (rec.moves[i - 1].color === 'w' ? rec.white.name : rec.black.name) + '：' + cur.thought : (cur ? '（这步没有台词记录）' : '点 ▶ 或 ⏭ 逐步查看。');
    // 复盘标注同步（无复盘数据时自动清空）
    if (typeof ReviewUI !== 'undefined') ReviewUI.markCurrent(rec);
    // 回放页的读屏摘要：描述回放棋盘，写进回放自己的 live region
    if (typeof A11y !== 'undefined') A11y.updateBoardLabel(c, v, 'replayA11y');
  },
  play() {
    if (UI.replayTimer) { clearInterval(UI.replayTimer); UI.replayTimer = null; return; }
    UI.replayTimer = setInterval(() => {
      const rec = UI.replayData;
      if (!rec || UI.replayIdx >= rec.moves.length) { clearInterval(UI.replayTimer); UI.replayTimer = null; return; }
      this.goto(UI.replayIdx + 1);
      Sound.move();
    }, 900);
  },
  async commentate() {
    const rec = UI.replayData;
    const ch = Store.char($('#rpChar').value);
    const api = Store.api($('#rpApi').value);
    if (!rec) return;
    if (!api) { UI.toast('先选择一组 API 配置', 'bad'); return; }
    UI.commenting = true;
    UI.toast('开始重新解说…', 'good');
    for (let i = 1; i <= rec.moves.length; i++) {
      if (!UI.commenting) break;
      this.goto(i);
      const mv = rec.moves[i - 1];
      try {
        const out = await API.chat(api, (ch.prompt || genPrompt(ch)) + '\n本次只生成解说台词，不要返回 move。',
          `局面 FEN：${mv.fen}\n刚走的一步：${mv.san}（${mv.color === 'w' ? '白' : '黑'}方）\n请用一句 30 字以内的话点评这步棋，返回 {"thought":"..."}。`,
          { temperature: 0.95, maxTokens: 70, timeout: 15000 });
        const obj = parseModelJSON(out);
        if (obj && obj.thought) {
          $('#rpThought').textContent = ch.name + '：' + obj.thought;
        }
      } catch (e) {
        $('#rpThought').textContent = ch.name + '：…（网络断了，先看棋）';
      }
      await sleep(1200);
    }
    UI.commenting = false;
  }
};

Game.findKingOn = function (c, color) {
  const b = c.board();
  for (let r = 0; r < 8; r++) for (let f = 0; f < 8; f++) {
    const p = b[r][f];
    if (p && p.type === 'k' && p.color === color) return String.fromCharCode(97 + f) + (8 - r);
  }
  return null;
};

/* =====================================================================
 * 24 · RECORDS
 * ===================================================================== */
UI.renderRecords = function () {
  const grid = $('#recGrid');
  grid.innerHTML = '';
  if (!Store.records.length) {
    grid.innerHTML = '<div class="hint">还没有保存的棋谱。对局结束后点「存棋谱」。</div>';
    return;
  }
  Store.records.forEach((r) => {
    const el = document.createElement('div');
    el.className = 'char-card';
    el.style.flexDirection = 'column';
    const d = new Date(r.date);
    const rt = { checkmate: '将死', stalemate: '逼和', material: '子力不足', repetition: '重复', draw: '和棋', maxmoves: '步数上限', aborted: '中止' };
    el.innerHTML = `<div class="nm" style="font-size:13px">${esc(r.white.name)} <span style="color:#7d74a6">vs</span> ${esc(r.black.name)}</div>
      <div class="tg">${r.moves.length} 步 · ${esc(rt[r.result] || r.result)}${r.winner ? ' · ' + (r.winner === 'w' ? '白胜' : '黑胜') : ''}</div>
      <div class="tg" style="color:#6f668f">${d.toLocaleString('zh-CN')} · ${r.mode === 'pve' ? '人机' : r.mode === 'aivai' ? 'AI vs AI' : '本地双人'}</div>`;
    const del = document.createElement('button');
    del.className = 'del'; del.textContent = '×';
    del.onclick = (e) => {
      e.stopPropagation();
      confirmBox('删除棋谱', '确定删除这条记录？', () => {
        Store.records = Store.records.filter((x) => x.id !== r.id);
        Store.saveRecords(); UI.renderRecords();
      });
    };
    el.appendChild(del);
    el.onclick = () => Replay.open(r);
    grid.appendChild(el);
  });
};

/* =====================================================================
 * 25 · WIRING
 * ===================================================================== */
function wire() {
  // nav
  $$('[data-go]').forEach((el) => {
    el.addEventListener('click', () => {
      const go = el.dataset.go;
      if (go === 'setup') { pendingMode = el.dataset.mode || 'pve'; refreshSetup(); }
      UI.go(go);
    });
  });
  $$('.mode-card').forEach((el) => el.addEventListener('click', () => Sound.click()));

  // char editor
  $('#btnNewChar').onclick = () => CharEditor.createNew();
  $('#btnRestorePresets').onclick = () => confirmBox('恢复示例角色', '会覆盖当前全部角色，继续？', () => {
    Store.restorePresets(); UI.renderCharGrid(); refreshCharSelects(); UI.toast('已恢复 4 个示例角色', 'good');
  });
  $('#btnCharSave').onclick = () => CharEditor.save();
  $('#btnCharCancel').onclick = () => A11y.closeModal($('#charModal'));
  $('#btnCharDelete').onclick = () => CharEditor.del();
  $('#btnRegenPrompt').onclick = () => { CharEditor.autoPrompt(); UI.toast('已按标签重生成 Prompt'); };
  $('#charName').oninput = () => { CharEditor.draft.name = $('#charName').value; };
  $('#charStyle').onchange = () => CharEditor.autoPrompt();
  $('#charCustom').oninput = () => CharEditor.autoPrompt();
  $('#charCatch').oninput = () => CharEditor.autoPrompt();
  $('#btnRerollAva').onclick = () => { CharEditor.draft.seed = (Math.random() * 1e9) | 0; CharEditor.draft.ava = null; CharEditor.drawPreview(); Sound.click(); };
  $('#btnUploadAva').onclick = () => $('#fileAva').click();
  $('#fileAva').onchange = (e) => { const f = e.target.files[0]; if (f) CharEditor.upload(f); e.target.value = ''; };

  // api
  $('#btnNewApi').onclick = () => ApiEditor.newConfig();
  $('#btnSaveApi').onclick = () => ApiEditor.save();
  $('#btnTestApi').onclick = () => ApiEditor.test();
  $('#btnDelApi').onclick = () => ApiEditor.del();
  $('#apiFmt').onchange = () => ApiEditor.syncCustomVis();
  $('#btnClearKey').onclick = () => ApiEditor.clearKey();
  $('#btnClearAllKeys').onclick = () => ApiEditor.clearAllKeys();
  $('#btnExportSafe').onclick = () => ApiEditor.exportSafe();

  /* 「记住密钥」开关：默认关（只在当前标签页存活）。
   * 勾上才写 localStorage —— file:// 下所有本地网页共用存储，不能默认开。 */
  const chkRemember = $('#chkRememberKeys');
  if (chkRemember) {
    chkRemember.checked = Secret.remember();
    chkRemember.onchange = () => {
      Secret.setRemember(chkRemember.checked);
      ApiEditor.refreshKeyStore();
      UI.toast(chkRemember.checked
        ? '今后密钥会保存到本机（重开浏览器仍有效）'
        : '密钥只在当前标签页有效，关闭即失效', chkRemember.checked ? '' : 'good');
    };
  }

  // setup
  $('#btnStartMatch').onclick = () => startMatch();
  $('#btnFlipSides').onclick = () => {
    const a = $('#selCharL').value, b = $('#selCharR').value;
    $('#selCharL').value = b; $('#selCharR').value = a;
    const c = $('#selApiL').value, d = $('#selApiR').value;
    $('#selApiL').value = d; $('#selApiR').value = c;
    Sound.click();
  };
  $('#selSide').onchange = () => { refreshSetup(); Sound.click(); };
  const clk = $('#selClock');
  if (clk) {
    clk.value = Store.settings.clockPreset || 'unlimited';
    clk.onchange = () => { Clock.setPreset(clk.value); Sound.click(); };
  }
  $('#rngDelay').oninput = () => { $('#lblDelay').textContent = $('#rngDelay').value + 'ms'; };
  $('#rngTemp').oninput = () => { $('#lblTemp').textContent = parseFloat($('#rngTemp').value).toFixed(2); };
  $('#rngTempR').oninput = () => { $('#lblTempR').textContent = parseFloat($('#rngTempR').value).toFixed(2); };
  $('#rngTempL').oninput = () => { $('#lblTempL').textContent = parseFloat($('#rngTempL').value).toFixed(2); };
  $('#btnSetupChars').onclick = () => UI.go('characters');
  $('#btnSetupApi').onclick = () => UI.go('api');

  // battle
  $('#btnPause').onclick = () => {
    if (Game.paused) { Game.setPaused(false); $('#btnPause').textContent = 'II'; }
    else { Game.setPaused(true); $('#btnPause').textContent = '>'; }
    Sound.click();
  };
  $('#btnNext').onclick = () => { Game.nextStep(); $('#btnPause').textContent = 'II'; Sound.click(); };
  $('#btnHint').onclick = () => requestHint();
  $('#btnUndo').onclick = () => UndoDraw.requestUndo();
  $('#btnDraw').onclick = () => UndoDraw.requestDraw();
  $('#btnResign').onclick = () => confirmBox('认输', '确定结束本局？', () => {
    A11y.closeModal($('#resultOverlay'));
    Game.resign().catch((e) => console.warn('[resign]', e));
  });
  $('[data-act="abort"]').onclick = () => confirmBox('离开对局', '当前对局不会保存，确定离开？', () => {
    Game.abort(); Clock.stop(); $('#resultOverlay').classList.remove('on'); UI.go('home');
  });
  /* 翻转：本局临时覆盖，不写进 settings。
   *
   * 早先直接翻转并持久化 settings.boardFlip —— 点一次就永久改默认视角，
   * 下一局执白也被翻过来（已复现）。默认视角应由「玩家1在下方」规则决定，
   * 手动翻转只服务于「这一局我想从另一边看」。
   * 再点一次取消覆盖，回到规则算出的默认朝向。 */
  $('#btnFlipBoard').onclick = () => {
    const mode = Game.mode;
    const side = $('#selSide') ? ($('#selSide').value === 'b' ? 'b' : 'w') : 'w';
    const def = autoFlipFor(mode, side, null);        // 规则默认值
    const cur = Game.view ? !!Game.view.flipped : def;
    const next = !cur;
    // 翻回默认值时清掉覆盖，否则记下覆盖
    Game.flipOverride = (next === def) ? null : next;
    if (Game.view) { Game.view.setFlipped(next); }
    if (typeof EvalBar !== 'undefined') { EvalBar.flipped = next; EvalBar.draw(); }
    UI.toast(next === def ? '棋盘：默认视角' : '棋盘：已翻转（仅本局）', '');
    Sound.click();
  };
  const btnEval = $('#btnEval');
  if (btnEval) btnEval.onclick = () => Settings.toggleEval();
  $('#btnTogglePieces').onclick = () => {
    Store.settings.pieceMode = Store.settings.pieceMode === 'classic' ? 'avatar' : 'classic';
    Store.saveSettings();
    if (Game.view) Game.view.pieceMode = Store.settings.pieceMode;
    if (UI.replayView) UI.replayView.pieceMode = Store.settings.pieceMode;
    UI.toast(Store.settings.pieceMode === 'avatar' ? '角色头像棋子' : '经典像素棋子');
  };
  $('#btnPace').onclick = () => Settings.cyclePace();
  $('#btnPaceRp').onclick = () => Settings.cyclePace();
  $('#btnContrast').onclick = () => Settings.toggleContrast();
  $('#btnToggleSound').onclick = () => {
    Store.settings.sound = !Store.settings.sound;
    Sound.on = Store.settings.sound; Store.saveSettings();
    $('#btnToggleSound').textContent = Sound.on ? '音效 ON' : '音效 OFF';
    if (Sound.on) Sound.click();
  };
  $('#btnToggleBgm').onclick = () => {
    Store.settings.bgm = !Store.settings.bgm;
    Store.saveSettings();
    if (Store.settings.bgm) BGM.start(); else BGM.stop();
    $('#btnToggleBgm').textContent = Store.settings.bgm ? 'BGM ON' : 'BGM OFF';
  };
  $$('[data-takeover]').forEach((btn) => {
    btn.onclick = () => {
      const color = btn.dataset.takeover;
      Game.takenOver[color] = true;
      Game.human[color] = true;
      Engine.stopAll();
      UI.showTakeover();
      const t = Game.chess ? Game.chess.turn() : null;
      if (Game.busy || (t === color && Game.running)) {
        UI.toast('已接管' + (color === 'w' ? '白' : '黑') + '方 · 眼下这步 AI 会先走完');
      } else {
        UI.toast('已接管' + (color === 'w' ? '白' : '黑') + '方，轮到你落子');
      }
      // 若 AI 正在算，尽快让出回合
      if (!Game.pendingHuman) Game.abortCurrentTurn = true;
      Sound.click();
    };
  });

  // result
  $('#resHome').onclick = () => { A11y.closeModal($('#resultOverlay')); UI.go('home'); };
  $('#resRematch').onclick = () => { A11y.closeModal($('#resultOverlay')); Game.start({
    mode: Game.mode, players: Game.players, human: Game.human,
    difficulty: Game.difficulty, delayMs: Game.delayMs, temp: Game.temp,
    auto: Game.auto, maxMoves: Game.maxMoves, narrator: Game.narrator, narratorApi: Game.narratorApi,
    clockPreset: Game.clockPreset || 'unlimited'
  }); };
  /* ---------- 存谱（幂等） ----------
   * 终局面板的「存棋谱」与「复盘」共用这里：
   * Game.savedRecordId 记本局已落盘的那条记录，重复点击不会产生多份棋谱。
   * 曾经用 window.__lastSavedId，跨越新局不清空 → 复盘会拿到上一盘的棋。 */
  function saveCurrentGame() {
    if (!Game.moves.length) return null;
    if (Game.savedRecordId) {
      const existed = Store.records.find((x) => x.id === Game.savedRecordId);
      if (existed) return existed;
    }
    const snap = Game.snapshot();
    Store.records.unshift(snap);
    Store.saveRecords();
    Game.savedRecordId = snap.id;
    return snap;
  }

  $('#resSave').onclick = () => {
    if (!Game.moves.length) { UI.toast('没有可保存的棋步', 'bad'); return; }
    const already = !!Game.savedRecordId;
    const snap = saveCurrentGame();
    UI.toast(already ? '这盘棋谱已在库里' : '棋谱已保存', 'good');
    $('#resSave').disabled = true;
    setTimeout(() => { $('#resSave').disabled = false; }, 1200);
    return snap;
  };

  /* ---------- 复盘（P2） ---------- */
  async function runReview(rec, btn) {
    if (!rec || !rec.moves || !rec.moves.length) { UI.toast('这盘还没有棋步', 'bad'); return; }
    if (Review.running) { Review.cancel(); UI.toast('复盘已停止', ''); return; }
    const label = btn ? btn.textContent : '';
    if (btn) btn.disabled = true;
    UI.toast('开始复盘：' + rec.moves.length + ' 步', '');
    const res = await Review.start(rec, {
      onProgress: (d, t) => { if (btn) btn.textContent = '复盘 ' + Math.round(d / t * 100) + '%'; }
    });
    if (btn) { btn.disabled = false; btn.textContent = label || '复盘'; }
    if (!res) { UI.toast('复盘未完成', 'bad'); return; }
    UI.toast('复盘完成 · ' + Review.summary(rec), 'good');
    ReviewUI.render(rec);
    if (UI.currentScreen === 'replay' && UI.replayData && UI.replayData.id === rec.id) {
      ReviewUI.markCurrent(rec);
    }
  }

  $('#resReview').onclick = async () => {
    // 复盘需要一条稳定 id 的棋谱记录；没有就当场存一条（本局重复点不会重复存）
    if (!Game.moves.length) { UI.toast('没有可复盘的棋步', 'bad'); return; }
    const fresh = !Game.savedRecordId;
    const rec = saveCurrentGame();
    if (!rec) { UI.toast('棋谱保存失败', 'bad'); return; }
    if (fresh) UI.toast('已自动存谱，正在复盘', '');
    await runReview(rec, $('#resReview'));
  };

  $('#rpReview').onclick = () => runReview(UI.replayData, $('#rpReview'));

  // replay
  $('#rpFirst').onclick = () => { Replay.goto(0); Sound.click(); };
  $('#rpPrev').onclick = () => { Replay.goto(UI.replayIdx - 1); Sound.click(); };
  $('#rpNext').onclick = () => { Replay.goto(UI.replayIdx + 1); Sound.click(); };
  $('#rpLast').onclick = () => { Replay.goto(UI.replayData ? UI.replayData.moves.length : 0); Sound.click(); };
  $('#rpPlay').onclick = () => Replay.play();
  $('#rpDoComment').onclick = () => Replay.commentate();
  $('#rpStopComment').onclick = () => { UI.commenting = false; UI.toast('解说已停止'); };
  $('#rpExport').onclick = () => {
    if (!UI.replayData) return;
    const blob = new Blob([UI.replayData.pgn || ''], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `chess-${UI.replayData.id}.pgn`;
    a.click();
    UI.toast('PGN 已导出');
  };
  $('#btnImportPgn').onclick = () => PgnImport.open();
  $('#btnCancelImport').onclick = () => PgnImport.close();
  $('#btnDoImport').onclick = () => PgnImport.commit();
  $('#btnClearRecords').onclick = () => confirmBox('清空棋谱', '全部对局记录将被删除。', () => {
    Store.records = []; Store.saveRecords(); UI.renderRecords();
  });

  /* 提示着法：优先开局库，其次引擎短搜索 */
  async function requestHint() {
    if (!Game.running || Game.aborted) { UI.toast('对局未开始', 'bad'); return; }
    if (Game.mode === 'aivai') { UI.toast('观战模式不支持提示', 'bad'); return; }
    const humanColor = UndoDraw.humanColor();
    if (Game.mode === 'pve' && Game.chess.turn() !== humanColor) {
      UI.toast('还没轮到你', 'bad'); return;
    }
    const btn = $('#btnHint');
    if (btn.disabled) return;
    btn.disabled = true;

    try {
      await Openings.load();
      const book = Openings.suggest(Game.chess);
      if (book) {
        UI.showHintArrow(Game.view, book.move);
        const label = book.opening && book.opening.name
          ? book.opening.name
          : '开局库';
        const eco = book.opening && book.opening.eco ? book.opening.eco + ' · ' : '';
        UI.toast('建议 ' + book.move.san + ' — ' + eco + label, 'good');
        return;
      }
      // 超出开局库：让引擎短算一步
      if (!Engine.ready) { UI.toast('引擎未就绪', 'bad'); return; }
      UI.toast('开局库无此局面，正在计算…', '');
      const uci = await Engine.bestMove(Game.chess.fen(), 8, 3000);
      if (!uci) { UI.toast('没有可用建议', 'bad'); return; }
      const mv = Game.chess.moves({ verbose: true }).find((m) => (m.from + m.to + (m.promotion || '')) === uci);
      if (mv) {
        UI.showHintArrow(Game.view, mv);
        UI.toast('引擎建议：' + mv.san, 'good');
      } else {
        UI.toast('没有可用建议', 'bad');
      }
    } catch (e) {
      if (!Run.isAbortError(e)) UI.toast('提示失败：' + (e.message || e), 'bad');
    } finally {
      btn.disabled = false;
    }
  }

  // keyboard
  document.addEventListener('keydown', (e) => {
    if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
    // 棋盘上有键盘光标时，方向键/空格/回车归棋盘（BoardKeys 已 stopPropagation，
    // 这里是双保险：某条路径没拦住也不该顺带触发暂停或单步）
    const onBoard = e.target && e.target.id === 'boardCanvas';
    if (e.key === 'Escape') return;                 // 由 A11y.trap 处理
    if (UI.currentScreen === 'battle') {
      if (onBoard) return;
      if (e.code === 'Space') { e.preventDefault(); $('#btnPause').click(); return; }
      if (e.key === 'ArrowRight') { Game.nextStep(); return; }
      if (e.key === 'p' || e.key === 'P') { Settings.cyclePace(); return; }
      if ((e.key === 'z' || e.key === 'Z') && (e.ctrlKey || e.metaKey)) {
        e.preventDefault(); UndoDraw.requestUndo(); return;
      }
    }
    if (UI.currentScreen === 'replay') {
      if (e.key === 'ArrowRight') Replay.goto(UI.replayIdx + 1);
      if (e.key === 'ArrowLeft') Replay.goto(UI.replayIdx - 1);
      if (e.code === 'Space') { e.preventDefault(); Replay.play(); }
    }
  });
}

/* =====================================================================
 * 26 · BOOT
 * ===================================================================== */
function boot() {
  Store.load();
  Sound.on = Store.settings.sound !== false;
  refreshCharSelects();
  refreshApiSelects();
  if (Store.chars.length > 1) {
    $('#selCharR').value = Store.chars[3] ? Store.chars[3].id : Store.chars[Store.chars.length - 1].id;
    $('#selCharL').value = Store.chars[0].id;
    $('#selNarrator').value = Store.chars[1] ? Store.chars[1].id : Store.chars[0].id;
  }
  if (Store.apis.length) { $('#selApiL').value = Store.apis[0].id; $('#selApiR').value = Store.apis[Store.apis.length - 1].id; }

  /* 首屏棋盘按「白在下」的默认朝向初始化。
   * 真正的朝向在 startMatch 时由 autoFlipFor 决定；这里只是预览。 */
  const view = new BoardView($('#boardCanvas'), {
    pieceMode: Store.settings.pieceMode,
    flipped: false
  });
  Game.chess = new Chess();
  view.pieces = [];
  view.setPosition(Game.chess);
  Game.view = view;
  Game.bindBoard(view);
  // 键盘走子：复用 onSquareClick 入口，不改落子逻辑
  if (typeof BoardKeys !== 'undefined') BoardKeys.attach(view);

  // 响应式棋盘尺寸
  /* 宽度预算明细（窄屏必须逐项算，否则 320px 会溢出 1~4px）：
   *   vw
   *   − 屏幕左右内边距（≤1000px 时 .screen 是 padding:10px 8px → 16）
   *   − 棋盘外框 chrome（#boardFrame padding 12×2 + border 4×2 = 32）
   *   − 棋盘与评估条的 gap
   *   − 评估条连同自身边框的宽度（EvalBar.outerW）
   * 剩下的才是 canvas 边长，向下取整到 8 的倍数。 */
  const fitBoard = () => {
    const screen = document.getElementById('screen-battle');
    if (!screen) return;
    const vw = window.innerWidth;
    const narrow = vw <= 1000;
    const evalW = (typeof EvalBar !== 'undefined' && EvalBar.visible) ? EvalBar.outerW() : 0;
    const gap = vw <= 380 ? 3 : 6;
    const screenPad = narrow ? 16 : 0;
    const frameChrome = 32;

    let size;
    if (narrow) {
      const avail = vw - screenPad - frameChrome - (evalW ? gap + evalW : 0);
      size = clamp(avail, 200, 560);
      size = Math.min(size, Math.floor(window.innerHeight * 0.58));
    } else {
      const availW = Math.min(vw - 520, 780) - (evalW ? gap + evalW : 0);
      const availH = window.innerHeight - 230;
      size = clamp(Math.min(availW, availH), 320, 720);
    }
    size = Math.floor(size / 8) * 8;
    view.resize(size);
    view.setPosition(Game.chess || new Chess());
    if (typeof EvalBar !== 'undefined') {
      EvalBar.flipped = view.flipped;
      EvalBar.resize(size);
      EvalBar.draw();
    }
    if (UI.replayView) UI.replayView.resize(window.__replayBoardSize());
  };

  /* 回放棋盘的边长：按容器实测宽度算，不靠猜。
   *
   * 曾经的 bug：UI.replayView 在 Replay.open() 里首次 new BoardView 时
   * 用的是默认 480，而 fitBoard() 只在 boot 与 window resize 时跑 ——
   * 于是 320px 屏上回放棋盘永远 480px，横向溢出 96px。
   * 现在 open() 与 resize 都走同一个算法（Replay.boardSize）。 */
  window.__replayBoardSize = () => (typeof Replay !== 'undefined' && Replay.boardSize
    ? Replay.boardSize() : 240);
  view._syncFn = () => { view.setPosition(Game.chess || new Chess()); };
  window.addEventListener('resize', fitBoard);
  setTimeout(fitBoard, 60);

  // 预置视觉状态
  Game.players = { w: { char: Store.chars[0], api: null }, b: { char: Store.chars[Math.min(1, Store.chars.length - 1)], api: null } };
  $('#nameL').textContent = Game.players.w.char.name;
  $('#nameR').textContent = Game.players.b.char.name;

  $('#btnToggleSound').textContent = Sound.on ? '音效 ON' : '音效 OFF';
  $('#btnToggleBgm').textContent = Store.settings.bgm ? 'BGM ON' : 'BGM OFF';

  wire();
  Settings.applyBody();
  A11y.updateBoardLabel();
  refreshSetup();
  Engine.init();
  // 评估条：初始化画布 + 预热第二 Worker（开关关闭时不建，省一份引擎内存）
  if (typeof EvalBar !== 'undefined') {
    EvalBar.init();
    EvalBar.flipped = false;      // 首屏预览：白在下（真正朝向由 startMatch 决定）
  }
  if (typeof Analysis !== 'undefined' && Settings.evalOn()) {
    Analysis.onScore = (res) => { if (Run.isLive(Run.token())) EvalBar.apply(res); };
    Analysis.init();
  }
  UI.renderCharGrid();

  // 首次交互解锁音频
  const unlock = () => { Sound.ensure(); document.removeEventListener('pointerdown', unlock); };
  document.addEventListener('pointerdown', unlock);

  console.log('%c AI CHESS ARENA ready ', 'background:#6b5fae;color:#fff');
}

document.addEventListener('DOMContentLoaded', boot);
