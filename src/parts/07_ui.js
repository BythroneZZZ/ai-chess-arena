/* =====================================================================
 * 16 · UI LAYER
 * ===================================================================== */
const UI = {
  currentScreen: 'home',
  replayData: null,
  replayIdx: 0,
  replayView: null,
  replayTimer: null,
  commenting: false,

  go(name) {
    $$('.screen').forEach((s) => s.classList.remove('on'));
    const el = document.getElementById('screen-' + name);
    if (el) el.classList.add('on');
    this.currentScreen = name;
    Sound.click();
    if (name === 'records') this.renderRecords();
    if (name === 'characters') { this.renderCharGrid(); this.renderTagGallery(); }
    if (name === 'api') {
      this.renderApiList();
      this.renderTrustedHosts();
      // 进页面时同步「记住密钥」状态与提示，避免显示与实际不符
      const chk = document.getElementById('chkRememberKeys');
      if (chk) chk.checked = Secret.remember();
      ApiEditor.refreshKeyStore();
    }
    if (name === 'setup') refreshSetup();
  },

  toast(msg, kind) {
    const box = $('#toasts');
    const el = document.createElement('div');
    el.className = 'toast ' + (kind || '');
    el.textContent = msg;
    box.appendChild(el);
    setTimeout(() => { el.style.transition = 'opacity .3s'; el.style.opacity = '0'; setTimeout(() => el.remove(), 320); }, 2600);
  },

  /* ---------- battle screen ---------- */
  syncPlayers() {
    const W = Game.players.w, B = Game.players.b;
    const set = (side, pl) => {
      const ch = pl.char;
      $('#name' + side).textContent = ch.name;
      $('#tags' + side).textContent = (ch.tags || []).join(' · ') || '自定义';
      $('#who' + side).textContent = ch.name;
      this.setPortrait(side, 'idle');
      const tk = document.getElementById('takeover' + side);
      if (tk) {
        const isHuman = Game.human[side === 'L' ? 'w' : 'b'];
        tk.style.display = isHuman ? 'none' : 'flex';
        const btn = tk.querySelector('button');
        if (btn) btn.textContent = '接管' + (side === 'L' ? '白' : '黑') + '方';
      }
    };
    set('L', W); set('R', B);
    $('#battleModeLabel').textContent = Game.mode === 'pve' ? 'PVE · 人机' : Game.mode === 'aivai' ? 'AI vs AI · 擂台' : 'PVP · 本地双人';
  },

  setPortrait(side, expr) {
    const pl = Game.players[side === 'L' ? 'w' : 'b'];
    const cv = document.getElementById('portrait' + side);
    if (!cv || !pl || !pl.char) return;
    this._expr = this._expr || {};
    this._expr[side] = expr || 'idle';
    renderAvatarTo(cv, pl.char, this._expr[side]);
  },

  setMorale(color, val, instant) {
    const side = color === 'w' ? 'L' : 'R';
    const bar = document.getElementById('morale' + side);
    const num = document.getElementById('morale' + side + 'Num');
    if (bar) bar.style.width = val + '%';
    if (num) num.textContent = Math.round(val);
  },

  setTurn() {
    if (!Game.chess) return;
    const t = Game.chess.turn();
    const pill = $('#turnPill');
    pill.textContent = t === 'w' ? 'WHITE TO MOVE' : 'BLACK TO MOVE';
    pill.className = 'turn-pill ' + t;
  },

  setStatus(text) { const el = $('#statusText'); if (el) el.textContent = text; },

  /* 开局名（有则显示 ECO + 名称，无则清空） */
  setOpening(info) {
    const el = document.getElementById('openingName');
    if (!el) return;
    if (!info || !info.name) { el.textContent = ''; el.removeAttribute('title'); return; }
    el.innerHTML = '<span class="eco">' + esc(info.eco || '') + '</span>' + esc(info.name);
    el.title = (info.eco ? info.eco + ' · ' : '') + info.name;
  },

  /* 在棋盘上画一个提示箭头（from -> to） */
  showHintArrow(view, move) {
    this.clearHintArrow();
    if (!view || !move) return;
    const a = view.sqCenter(move.from), b = view.sqCenter(move.to);
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const size = Math.max(10, view.sq * 0.34);
    const el = document.createElement('div');
    el.className = 'hint-arrow';
    el.id = 'hintArrow';
    el.style.left = (a.x - size / 2) + 'px';
    el.style.top = (a.y - size / 2) + 'px';
    el.style.width = (len + size) + 'px';
    el.style.height = size + 'px';
    el.style.borderTop = (size / 2) + 'px solid transparent';
    el.style.borderBottom = (size / 2) + 'px solid transparent';
    el.style.borderLeft = size + 'px solid rgba(77,225,255,.85)';
    el.style.transformOrigin = (size / 2) + 'px ' + (size / 2) + 'px';
    el.style.transform = 'rotate(' + ang + 'rad)';
    el.style.opacity = '0.75';
    const frame = document.getElementById('boardFrame');
    if (frame) frame.appendChild(el);
    this._hintTimer = setTimeout(() => this.clearHintArrow(), 2600);
  },

  clearHintArrow() {
    clearTimeout(this._hintTimer);
    const el = document.getElementById('hintArrow');
    if (el) el.remove();
  },

  /* 撤销：保留文案，只打标 */
  markUndone(count) {
    const items = [...document.querySelectorAll('#moveLog .mv')];
    for (let i = items.length - 1; i >= 0 && count > 0; i--, count--) {
      items[i].classList.add('undone');
      items[i].title = '这步已撤销（台词保留）';
    }
    const box = $('#moveLog');
    if (box && !items.length) box.innerHTML = '<span class="log-empty">— 未落子 —</span>';
  },

  /* 控制按钮可用性：只在轮到人类、且对局进行中可用 */
  updateControlState() {
    const canUse = typeof UndoDraw !== 'undefined' && UndoDraw.canUse && UndoDraw.canUse();
    ['#btnUndo', '#btnDraw'].forEach((sel) => {
      const b = $(sel);
      if (!b) return;
      const unsupported = Game.mode === 'aivai';
      b.disabled = !canUse || unsupported;
      b.title = unsupported ? '擂台观战模式不支持' : (canUse ? '' : '等对手走完这一步');
    });
  },

  clearLog() {
    const box = $('#moveLog');
    box.innerHTML = '<span class="log-empty">— 未落子 —</span>';
  },

  addLog(rec) {
    const box = $('#moveLog');
    const empty = box.querySelector('.log-empty');
    if (empty) empty.remove();
    const el = document.createElement('span');
    const no = Math.floor((Game.moves.length + 1) / 2);
    const isW = rec.color === 'w';
    el.className = 'mv ' + (isW ? 'w' : 'b') + (rec.cap ? ' cap' : '') + (rec.check ? ' chk' : '');
    el.textContent = (isW ? no + '.' : '') + rec.san;
    box.appendChild(el);
    box.scrollLeft = box.scrollWidth;
    this.updateControlState();
  },

  showTakeover() {
    ['L', 'R'].forEach((side) => {
      const color = side === 'L' ? 'w' : 'b';
      const tk = document.getElementById('takeover' + side);
      if (!tk) return;
      tk.style.display = (Game.human[color] || Game.takenOver[color]) ? 'none' : 'flex';
    });
  },

  setBubbleInstant(side, who, text) {
    const bubble = document.getElementById('bubble' + side);
    const el = document.getElementById('bubble' + side + 'Text');
    if (!bubble || !el) return;
    bubble.classList.remove('think');
    bubble.classList.remove('pop'); void bubble.offsetWidth; bubble.classList.add('pop');
    const whoEl = document.getElementById('who' + side);
    if (whoEl) whoEl.textContent = who || '';
    el.textContent = String(text || '');
  },

  /**
   * 打字机。rate: 1 = 正常, 4 = 快速；token 变化时立即中止。
   */
  async typeBubble(color, text, maxWait, rate) {
    const side = color === 'w' ? 'L' : 'R';
    const el = document.getElementById('bubble' + side + 'Text');
    const bubble = document.getElementById('bubble' + side);
    bubble.classList.remove('think');
    el.textContent = '';
    const s = String(text || '');
    const token = Run.token();
    const scale = rate || 1;
    const speed = Math.max(2, Math.round(clamp(1400 / Math.max(6, s.length), 9, 34) / scale));
    const caret = document.createElement('span');
    caret.className = 'caret';
    el.appendChild(caret);
    for (let i = 0; i < s.length; i++) {
      if (Game.aborted || !Run.isLive(token)) { caret.remove(); return; }
      caret.before(document.createTextNode(s[i]));
      if (i % 3 === 0 && scale === 1) Sound.bubble();
      await runSleep(speed, token);
    }
    caret.remove();
  },

  showResult({ title, sub, quotes, winner }) {
    $('#resTitle').textContent = title;
    $('#resSub').textContent = sub;
    $('#resTag').textContent = window.GAME_MODE_LABEL || 'MATCH OVER';
    $('#resQuoteLName').textContent = Game.players.w.char.name;
    $('#resQuoteRName').textContent = Game.players.b.char.name;
    $('#resQuoteL').textContent = quotes.w || '…';
    $('#resQuoteR').textContent = quotes.b || '…';
    $('#resultOverlay').classList.add('on');
    Sound.click();
  },

  /* ---------- character grid ---------- */
  renderCharGrid() {
    const grid = $('#charGrid');
    grid.innerHTML = '';
    Store.chars.forEach((c) => {
      const card = document.createElement('div');
      card.className = 'char-card';
      const cv = document.createElement('canvas');
      cv.width = 32; cv.height = 32; cv.className = 'ava';
      card.appendChild(cv);
      renderAvatarTo(cv, c);
      const meta = document.createElement('div');
      meta.className = 'meta';
      const firstCatch = (c.catch || '').split('/')[0].trim();
      meta.innerHTML = `<div class="nm">${esc(c.name)}</div>
        <div class="tg">${esc((c.tags || []).join(' · ') || '完全自定义')}</div>
        <div class="tg" style="color:#8b7fc0">棋风 ${esc(c.style)}</div>
        <div class="quote">${firstCatch ? '「' + esc(firstCatch) + '」' : '（未设口头禅）'}</div>`;
      card.appendChild(meta);
      const del = document.createElement('button');
      del.className = 'del'; del.textContent = '×';
      del.onclick = (e) => {
        e.stopPropagation();
        if (Store.chars.length <= 1) return this.toast('至少保留一个角色', 'bad');
        confirmBox('删除角色', `确定删除「${c.name}」吗？`, () => {
          Store.chars = Store.chars.filter((x) => x.id !== c.id);
          Store.saveChars(); this.renderCharGrid(); this.toast('已删除');
        });
      };
      card.appendChild(del);
      card.onclick = () => CharEditor.open(c);
      grid.appendChild(card);
    });
  },

  renderTagGallery() {
    const box = $('#tagGallery');
    if (!box) return;
    box.innerHTML = '';
    TAG_LIST.forEach((name) => {
      const el = document.createElement('span');
      el.className = 'chip';
      el.textContent = name;
      el.style.borderColor = 'transparent';
      el.style.boxShadow = 'inset 0 0 0 2px ' + (TAGS[name].color || '#4f4385');
      el.style.color = TAGS[name].color || '#ece8ff';
      el.title = TAGS[name].expand;
      box.appendChild(el);
    });
  },

  renderTrustedHosts() {
    const box = $('#trustedList');
    if (!box) return;
    const list = EndpointGuard.trustedList();
    box.innerHTML = '';
    if (!list.length) {
      box.innerHTML = '<div class="hint">还没有已信任的地址。首次发送密钥时会询问你。</div>';
      return;
    }
    list.forEach((origin) => {
      const row = document.createElement('div');
      row.className = 'list-row';
      row.style.cursor = 'default';
      row.innerHTML = `<span class="dot ok"></span><div class="grow"><div class="nm" style="font-size:12px">${esc(origin)}</div></div>`;
      const btn = document.createElement('button');
      btn.className = 'px-btn danger small';
      btn.textContent = '撤销';
      btn.onclick = () => {
        EndpointGuard.revoke(origin);
        this.renderTrustedHosts();
        UI.toast('已撤销：' + origin, 'good');
      };
      row.appendChild(btn);
      box.appendChild(row);
    });
  },

  /* ---------- api list ---------- */
  renderApiList() {
    const list = $('#apiList');
    list.innerHTML = '';
    if (!Store.apis.length) {
      list.innerHTML = '<div class="hint">还没有配置。点右上角“新建配置”。</div>';
    }
    Store.apis.forEach((a) => {
      const row = document.createElement('div');
      row.className = 'list-row' + (ApiEditor.current && ApiEditor.current.id === a.id ? ' sel' : '');
      row.innerHTML = `<span class="dot ok"></span><div class="grow"><div class="nm">${esc(a.name)}</div><div class="sub">${esc(a.fmt)} · ${esc(a.model || '未填模型')} · ${esc((a.base || '').slice(0, 42))}</div></div>`;
      row.onclick = () => ApiEditor.open(a);
      list.appendChild(row);
    });
  }
};

/* =====================================================================
 * 17 · CONFIRM BOX
 * ===================================================================== */
let confirmCb = null;
function confirmBox(title, text, cb) {
  $('#confirmTitle').textContent = title;
  $('#confirmText').textContent = text;
  confirmCb = cb;
  A11y.openModal($('#confirmModal'));
}
$('#confirmNo').onclick = () => { A11y.closeModal($('#confirmModal')); confirmCb = null; };
$('#confirmYes').onclick = () => { A11y.closeModal($('#confirmModal')); const cb = confirmCb; confirmCb = null; if (cb) cb(); };

/* =====================================================================
 * 18 · CHARACTER EDITOR
 * ===================================================================== */
const CharEditor = {
  draft: null,
  tags: [],
  renderTagLegend() {
    const box = $('#tagLegend');
    box.innerHTML = '';
    TAG_LIST.forEach((t) => {
      const el = document.createElement('span');
      el.className = 'chip' + (this.tags.includes(t) ? ' on' : '');
      el.textContent = t;
      if (TAGS[t].color) el.style.borderColor = 'transparent';
      el.onclick = () => {
        if (this.tags.includes(t)) this.tags = this.tags.filter((x) => x !== t);
        else {
          if (this.tags.length >= 3) { UI.toast('最多选 3 个标签', 'bad'); return; }
          this.tags.push(t);
        }
        this.renderTagLegend();
        this.autoPrompt();
        Sound.click();
      };
      box.appendChild(el);
    });
    const custom = document.createElement('span');
    custom.className = 'chip' + (this.tags.length === 0 ? ' on' : '');
    custom.textContent = '完全自定义';
    custom.onclick = () => { this.tags = []; this.renderTagLegend(); this.autoPrompt(); Sound.click(); };
    box.appendChild(custom);
  },

  drawPreview(expr) {
    const cv = $('#charAvaCanvas');
    if (this.draft.ava) {
      const ctx = cv.getContext('2d');
      const img = new Image();
      img.onload = () => { ctx.imageSmoothingEnabled = false; ctx.clearRect(0, 0, 32, 32); ctx.drawImage(img, 0, 0, 32, 32); };
      img.src = this.draft.ava;
      return;
    }
    drawAvatar(cv.getContext('2d'), this.draft, { expr: expr || 'idle' });
  },

  open(c) {
    this.draft = JSON.parse(JSON.stringify(c));
    this.draft.isNew = false;
    this.tags = (this.draft.tags || []).slice();
    $('#charModalTitle').textContent = '编辑角色 · ' + c.name;
    $('#charName').value = c.name || '';
    $('#charStyle').value = c.style || '均衡';
    $('#charCustom').value = c.custom || '';
    $('#charCatch').value = c.catch || '';
    $('#charPrompt').value = c.prompt || genPrompt(c);
    $('#btnCharDelete').style.display = 'inline-block';
    $('#promptLockHint').textContent = '生成后仍可手改，改动会保存。';
    this.renderTagLegend();
    this.drawPreview();
    A11y.openModal($('#charModal'));
    Sound.click();
  },

  createNew() {
    this.draft = blankChar({ name: '新角色' });
    this.draft.isNew = true;
    this.tags = ['热血'];
    $('#charModalTitle').textContent = '新建角色';
    $('#charName').value = '';
    $('#charStyle').value = '均衡';
    $('#charCustom').value = '';
    $('#charCatch').value = '';
    $('#btnCharDelete').style.display = 'none';
    this.renderTagLegend();
    this.draft.tags = this.tags;
    $('#charPrompt').value = genPrompt(this.draft);
    this.drawPreview();
    A11y.openModal($('#charModal'));
  },

  syncDraftFromForm() {
    this.draft.name = $('#charName').value.trim() || '无名棋手';
    this.draft.tags = this.tags.slice();
    this.draft.style = $('#charStyle').value;
    this.draft.custom = $('#charCustom').value.trim();
    this.draft.catch = $('#charCatch').value.trim();
    this.draft.prompt = $('#charPrompt').value;
  },

  autoPrompt() {
    if (!this.draft) return;
    const snapshot = {
      name: $('#charName').value.trim() || '无名棋手',
      tags: this.tags.slice(),
      style: $('#charStyle').value,
      custom: $('#charCustom').value.trim(),
      catch: $('#charCatch').value.trim()
    };
    $('#charPrompt').value = genPrompt(snapshot);
  },

  save() {
    this.syncDraftFromForm();
    if (!this.tags.length && !this.draft.custom) {
      UI.toast('请选择至少一个风格标签，或写自定义人格', 'bad');
      return;
    }
    Store.upsertChar(this.draft);
    UI.toast('角色已保存：' + this.draft.name, 'good');
    A11y.closeModal($('#charModal'));
    UI.renderCharGrid();
    refreshCharSelects();
  },

  del() {
    if (Store.chars.length <= 1) { UI.toast('至少保留一个角色', 'bad'); return; }
    confirmBox('删除角色', `确定删除「${this.draft.name}」吗？`, () => {
      Store.chars = Store.chars.filter((x) => x.id !== this.draft.id);
      Store.saveChars();
      A11y.closeModal($('#charModal'));
      UI.renderCharGrid(); refreshCharSelects();
    });
  },

  upload(file) {
    const img = new Image();
    const fr = new FileReader();
    fr.onload = () => {
      img.onload = () => {
        const cv = document.createElement('canvas');
        cv.width = 32; cv.height = 32;
        const g = cv.getContext('2d');
        g.imageSmoothingEnabled = false;
        // 居中裁切
        const s = Math.min(img.width, img.height);
        g.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, 32, 32);
        this.draft.ava = cv.toDataURL('image/png');
        this.drawPreview();
        UI.toast('头像已像素化 32×32', 'good');
      };
      img.src = fr.result;
    };
    fr.readAsDataURL(file);
  }
};

/* =====================================================================
 * 19 · API EDITOR
 * ===================================================================== */
const ApiEditor = {
  current: null,
  open(a) {
    this.current = a ? JSON.parse(JSON.stringify(a)) : blankApi();
    $('#apiName').value = this.current.name || '';
    $('#apiFmt').value = this.current.fmt || 'openai';
    $('#apiBase').value = this.current.base || '';
    $('#apiKey').value = this.current.key || '';
    $('#apiModel').value = this.current.model || '';
    $('#apiCustomBody').value = this.current.customBody || '{"model":"{{model}}","messages":[{"role":"system","content":"{{system}}"},{"role":"user","content":"{{user}}"}]}';
    $('#apiCustomPath').value = this.current.customPath || 'choices.0.message.content';
    this.syncCustomVis();
    $('#apiTestOut').textContent = '';
    UI.renderApiList();
  },
  newConfig() { this.open(null); $('#apiName').focus(); },
  syncCustomVis() {
    $('#customWrap').classList.toggle('hidden', $('#apiFmt').value !== 'custom');
  },
  collect() {
    return Object.assign({}, this.current, {
      id: this.current.id,
      name: $('#apiName').value.trim() || '未命名配置',
      fmt: $('#apiFmt').value,
      base: $('#apiBase').value.trim(),
      key: $('#apiKey').value.trim(),
      model: $('#apiModel').value.trim(),
      customBody: $('#apiCustomBody').value,
      customPath: $('#apiCustomPath').value.trim()
    });
  },
  save() {
    const a = this.collect();
    const errs = validateApiConfig(a);
    if (errs.length) {
      UI.toast(errs[0], 'bad');
      const out = $('#apiTestOut');
      if (out) { out.className = 'err'; out.textContent = '× ' + errs.join('；'); }
      return;
    }
    Store.upsertApi(a);
    this.current = a;
    /* 密钥可能因隐私模式/配额满写不进去 —— 必须让用户知道，
     * 否则下次打开发现 Key 没了，会以为程序有 bug。 */
    const failed = Store._lastSaveFailure;
    if (failed && failed.length) {
      UI.toast('配置已保存，但密钥未能写入存储（' + failed[0] + '）· 本次会话仍可用', 'bad');
    } else {
      UI.toast('配置已保存：' + a.name, 'good');
    }
    UI.renderApiList();
    refreshApiSelects();
  },
  del() {
    if (!this.current || !Store.apis.find((x) => x.id === this.current.id)) { UI.toast('这条配置还没保存', ''); return; }
    confirmBox('删除配置', `确定删除「${this.current.name}」吗？`, () => {
      Store.apis = Store.apis.filter((x) => x.id !== this.current.id);
      Store.saveApis();
      this.current = null;
      UI.renderApiList(); refreshApiSelects();
      $('#apiName').value = ''; $('#apiBase').value = ''; $('#apiKey').value = ''; $('#apiModel').value = '';
    });
  },
  async test() {
    const a = this.collect();
    const errs = validateApiConfig(a);
    const out = $('#apiTestOut');
    if (errs.length) { out.className = 'err'; out.textContent = '× ' + errs.join('；'); UI.toast(errs[0], 'bad'); return; }
    out.className = 'hint'; out.textContent = '正在连接…';
    const btn = $('#btnTestApi');
    btn.disabled = true;
    try {
      const r = await API.test(a);
      out.className = 'ok';
      out.textContent = `· 连通 ${r.ms}ms · 返回：${r.text || '(空)'}`;
      UI.toast('连接成功', 'good');
    } catch (e) {
      const info = classifyApiError(e, a);
      out.className = 'err';
      out.textContent = '× ' + info.text + '\n' + String(e.message || '').slice(0, 160);
      UI.toast('连接失败 · ' + info.text, 'bad');
    } finally { btn.disabled = false; }
  },

  /* 清空当前配置的密钥（保留其他字段） */
  clearKey() {
    if (!this.current) return;
    this.current.key = '';
    $('#apiKey').value = '';
    const saved = Store.apis.find((x) => x.id === this.current.id);
    if (saved) { saved.key = ''; Store.saveApis(); }
    Secret.del('key.' + this.current.id);
    UI.toast('已清空该配置的密钥', 'good');
  },

  /* 清空全部密钥 */
  clearAllKeys() {
    confirmBox('清空全部密钥', '所有配置中的 API Key 都会被删除（其他字段保留）。', () => {
      Store.apis.forEach((a) => { a.key = ''; Secret.del('key.' + a.id); });
      Store.saveApis();
      $('#apiKey').value = '';
      if (this.current) this.current.key = '';
      UI.toast('已清空 ' + Store.apis.length + ' 组配置的密钥', 'good');
    });
  },

  /* 切换「记住密钥」后刷新提示文案 —— 让用户随时能看到当前生效的层级 */
  refreshKeyStore() {
    const hint = document.getElementById('rememberKeysHint');
    if (!hint) return;
    const persisted = Secret.remember();
    const n = Store.apis.filter((a) => a.key).length;
    hint.textContent = persisted
      ? `已保存到本机（${n} 组密钥，重开浏览器仍有效）`
      : `仅当前标签页有效（${n} 组密钥，关闭即失效）`;
    hint.style.color = persisted ? '#ff9f2e' : '#7d74a6';
  },

  /* 脱敏导出：不含密钥 */
  exportSafe() {
    const safe = Store.apis.map((a) => ({
      name: a.name, fmt: a.fmt, base: a.base, model: a.model,
      customBody: a.customBody, customPath: a.customPath
    }));
    if (!safe.length) { UI.toast('没有可导出的配置', 'bad'); return; }
    const payload = {
      version: 1,
      exportedAt: nowISO(),
      note: 'API 密钥未包含在导出内容中，导入后需重新填写。',
      apis: safe,
      chars: Store.chars.map((c) => ({ name: c.name, tags: c.tags, style: c.style, catch: c.catch, custom: c.custom, prompt: c.prompt, seed: c.seed }))
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'chess-arena-config-safe.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    UI.toast('已导出脱敏配置（' + safe.length + ' 组 API / ' + payload.chars.length + ' 个角色）', 'good');
  }
};

function blankApi() {
  return { id: uid('api'), name: '新配置', fmt: 'openai', base: '', key: '', model: '', customBody: '', customPath: 'choices.0.message.content' };
}

/* =====================================================================
 * 20 · SELECT POPULATION
 * ===================================================================== */
function refreshCharSelects() {
  const opts = Store.chars.map((c) => `<option value="${c.id}">${esc(c.name)}${c.tags.length ? ' · ' + esc(c.tags.join('/')) : ''}</option>`).join('');
  ['#selCharL', '#selCharR', '#selNarrator', '#rpChar'].forEach((sel) => {
    const el = $(sel);
    if (!el) return;
    const prev = el.value;
    el.innerHTML = (sel === '#selNarrator' ? '<option value="">（无解说）</option>' : '') + opts;
    if (prev && [...el.options].some((o) => o.value === prev)) el.value = prev;
  });
}

function refreshApiSelects() {
  const opts = Store.apis.map((a) => `<option value="${a.id}">${esc(a.name)} · ${esc(a.model || '?')}</option>`).join('');
  ['#selApiL', '#selApiR', '#rpApi', '#selNarrApi'].forEach((sel) => {
    const el = $(sel);
    if (!el) return;
    const prev = el.value;
    el.innerHTML = '<option value="">（纯本地 / 无 API）</option>' + opts;
    if (prev && [...el.options].some((o) => o.value === prev)) el.value = prev;
  });
}
