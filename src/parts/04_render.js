/* =====================================================================
 * 08 · PIXEL SPRITES (16×16 mask → 自动描边 + 立体光影)
 * ===================================================================== */
const MASK = {
  p: [
    '................',
    '................',
    '.....####.......',
    '....######......',
    '....######......',
    '....######......',
    '.....####.......',
    '......##........',
    '.....####.......',
    '....######......',
    '...########.....',
    '..##########....',
    '.############...',
    '.############...',
    '................',
    '................',
  ],
  r: [
    '................',
    '................',
    '..##..##..##....',
    '..##..##..##....',
    '..############..',
    '..############..',
    '...##########...',
    '....########....',
    '....########....',
    '....########....',
    '...##########...',
    '...##########...',
    '..############..',
    '.##############.',
    '.##############.',
    '................',
  ],
  n: [
    '................',
    '................',
    '.........##.....',
    '........####....',
    '.......#####....',
    '......######....',
    '.....#######....',
    '....########....',
    '....##########..',
    '....##########..',
    '.....#########..',
    '......########..',
    '.....#########..',
    '....##########..',
    '....############',
    '....############',
  ],
  b: [
    '................',
    '.......#........',
    '......###.......',
    '......###.......',
    '.....#####......',
    '......###.......',
    '.....#####......',
    '....#######.....',
    '....#######.....',
    '....#######.....',
    '.....#####......',
    '...#########....',
    '...#########....',
    '..###########...',
    '..###########...',
    '................',
  ],
  q: [
    '................',
    '..#..#..#..#....',
    '..#..#..#..#....',
    '..############..',
    '...##########...',
    '....########....',
    '....########....',
    '....########....',
    '...##########...',
    '...##########...',
    '..############..',
    '.##############.',
    '.##############.',
    '................',
    '................',
    '................',
  ],
  k: [
    '.......##.......',
    '.......##.......',
    '......####......',
    '....########....',
    '...##########...',
    '...##########...',
    '....########....',
    '....########....',
    '...##########...',
    '...##########...',
    '..############..',
    '.##############.',
    '.##############.',
    '................',
    '................',
    '................',
  ],
};

const PIECE_PAL = {
  w: { out: '#181030', hi: '#ffffff', mid: '#fdfbff', lo: '#c9bcf2' },
  b: { out: '#040209', hi: '#8b79cf', mid: '#4b3d84', lo: '#241c47' }
};

const spriteCache = new Map();

function buildSprite(type, color) {
  const rows = MASK[type] || MASK.p;
  const N = 16;
  const on = (x, y) => x >= 0 && x < N && y >= 0 && y < N && rows[y] && (rows[y][x] === '#' || rows[y][x] === '1');
  const pal = PIECE_PAL[color];
  const cv = document.createElement('canvas');
  cv.width = N; cv.height = N;
  const g = cv.getContext('2d');
  g.imageSmoothingEnabled = false;

  let minX = N, maxX = -1, minY = N, maxY = -1;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (on(x, y)) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }

  const shade = (hex, amt) => {
    const n = parseInt(hex.slice(1), 16);
    const r = clamp(((n >> 16) & 255) + amt, 0, 255) | 0;
    const gg = clamp(((n >> 8) & 255) + amt, 0, 255) | 0;
    const b = clamp((n & 255) + amt, 0, 255) | 0;
    return '#' + ((1 << 24) + (r << 16) + (gg << 8) + b).toString(16).slice(1);
  };

  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      if (!on(x, y)) continue;
      const edge = !on(x - 1, y) || !on(x + 1, y) || !on(x, y - 1) || !on(x, y + 1);
      let col;
      if (edge) col = pal.out;
      else {
        const rel = (y - minY) / Math.max(1, maxY - minY);
        const left = x < (minX + maxX) / 2;
        // 左下、右下内部再压一层暗色，制造圆柱体积
        const nearEdge = !on(x - 2, y) || !on(x + 2, y) || !on(x, y + 2);
        if (rel < 0.3 && left) col = pal.hi;
        else if (rel < 0.55 && left) col = pal.mid;
        else if (rel > 0.82) col = shade(pal.lo, -18);
        else if (rel > 0.6) col = pal.lo;
        else if (left) col = pal.hi;
        else col = pal.mid;
        if (nearEdge && rel > 0.4) col = shade(col, -22);
        if (!left && rel > 0.35 && rel < 0.62) col = shade(pal.mid, -14);
      }
      g.fillStyle = col;
      g.fillRect(x, y, 1, 1);
    }
  }
  return { cv, bbox: { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 } };
}

function getSprite(type, color) {
  const key = type + color;
  if (spriteCache.has(key)) return spriteCache.get(key);
  const s = buildSprite(type, color);
  spriteCache.set(key, s);
  return s;
}

/* =====================================================================
 * 09 · PROCEDURAL PIXEL AVATAR  (32×32 logical grid)
 * ===================================================================== */
const AVA_PALETTES = [
  { hair: '#ff5c7a', hair2: '#c9335a', skin: '#ffd9b5', skin2: '#e0a97f', cloth: '#3b2f74', cloth2: '#241d4d', eye: '#1b1430', acc: '#ffcc4d', trim: '#8b7de0' },
  { hair: '#4de1ff', hair2: '#1f9dc4', skin: '#f7d2ae', skin2: '#d4a37c', cloth: '#1d4f6b', cloth2: '#123246', eye: '#0f2430', acc: '#c8f6ff', trim: '#61c8e6' },
  { hair: '#b07bff', hair2: '#7b48cc', skin: '#f0c8a4', skin2: '#cc9a72', cloth: '#3d2560', cloth2: '#26163f', eye: '#1a1030', acc: '#e0c7ff', trim: '#9b6ee8' },
  { hair: '#ffcc4d', hair2: '#d19b1c', skin: '#ffe3c4', skin2: '#dcb188', cloth: '#5c3a12', cloth2: '#3a2308', eye: '#241705', acc: '#fff3c4', trim: '#c48f38' },
  { hair: '#63e6a0', hair2: '#2ba36c', skin: '#e2b991', skin2: '#bb8f66', cloth: '#12492f', cloth2: '#0a2d1d', eye: '#0d241a', acc: '#c7ffe6', trim: '#3fbf85' },
  { hair: '#ece8ff', hair2: '#b6aede', skin: '#f9dfc8', skin2: '#d6b294', cloth: '#2c2a52', cloth2: '#1b1936', eye: '#1a1730', acc: '#9ad7ff', trim: '#7f8fc4' },
  { hair: '#ff8ad8', hair2: '#d152a4', skin: '#ffd6c6', skin2: '#e0a894', cloth: '#5c1f4a', cloth2: '#3a1030', eye: '#2a1020', acc: '#ffd6f2', trim: '#c25da0' },
  { hair: '#8fa3c8', hair2: '#5c6d92', skin: '#eed0b3', skin2: '#c7a184', cloth: '#22253c', cloth2: '#14162a', eye: '#12162a', acc: '#a9bde0', trim: '#6b7ea6' }
];

function avatarParams(seed, over = {}) {
  const rnd = mulberry32(seed || 1);
  const pal = AVA_PALETTES[(rnd() * AVA_PALETTES.length) | 0];
  return Object.assign({
    pal,
    hairStyle: (rnd() * 6) | 0,      // 0 short 1 long 2 spiky 3 bob 4 helmet 5 ponytail
    brow: (rnd() * 3) | 0,           // 0 normal 1 angry 2 soft
    eyes: (rnd() * 3) | 0,           // 0 round 1 sharp 2 wide
    accessory: (rnd() * 5) | 0,      // 0 none 1 glasses 2 headband 3 crown 4 scarf
    mouth: (rnd() * 3) | 0,
    faceWidth: 9 + ((rnd() * 2) | 0),
    blush: rnd() > 0.5,
    scar: rnd() > 0.85
  }, over);
}

/* 在 ctx 上按 32×32 逻辑坐标绘制（整数放大，像素不糊） */
function drawAvatar(ctx, char, opts = {}) {
  const S = 32;
  const scale = opts.scale || 1;
  const expr = opts.expr || 'idle';
  const p = avatarParams(char.seed || hash32(char.name || 'x'), char.avaParams || {});
  const pal = p.pal;

  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.setTransform(scale, 0, 0, scale, opts.ox || 0, opts.oy || 0);
  const P = (x, y, w, h, c) => { ctx.fillStyle = c; ctx.fillRect(x, y, w, h); };

  // ================= 背景 =================
  P(0, 0, S, S, '#151027');
  for (let x = 0; x < S; x += 4) P(x, 0, 2, S, '#1c1533');
  P(0, 23, S, 9, '#0f0b1c');
  // 光环（不溢出画面）
  ctx.globalAlpha = 0.10;
  for (let r = 12; r > 7; r--) {
    ctx.fillStyle = pal.trim;
    ctx.beginPath(); ctx.arc(16, 14, r, 0, Math.PI * 2); ctx.fill();
  }
  ctx.globalAlpha = 1;

  // ================= 肩膀 =================
  P(4, 26, 24, 6, pal.cloth);
  P(4, 26, 24, 1, '#ffffff1f');
  P(4, 30, 24, 2, pal.cloth2);
  // 衣领
  P(11, 25, 10, 2, pal.trim);
  P(12, 27, 8, 4, pal.cloth2);
  P(14, 26, 4, 1, pal.skin2);
  // 肩章
  P(6, 27, 2, 2, pal.acc); P(24, 27, 2, 2, pal.acc);

  // ================= 脖子 =================
  P(14, 21, 4, 5, pal.skin2);
  P(14, 21, 4, 1, '#00000026');

  // ================= 脸 =================
  const fw = p.faceWidth;          // 9~10
  const fx = 16 - (fw >> 1);       // 12
  const fy = 8;
  P(fx, fy, fw, 13, pal.skin);                 // 8..20
  P(fx, fy, fw, 1, '#ffffff30');               // 额头高光
  P(fx, fy + 12, fw, 1, pal.skin2);            // 下巴阴影
  // 脸颊两侧
  P(fx - 1, fy + 5, 1, 5, pal.skin);
  P(fx + fw, fy + 5, 1, 5, pal.skin);
  P(fx - 1, fy + 4, 1, 1, pal.skin2);
  P(fx + fw, fy + 4, 1, 1, pal.skin2);

  // ================= 头发 =================
  const hs = p.hairStyle;
  const hy = 6;                     // 发际线
  if (hs === 0) {                   // 短发
    P(fx - 1, hy, fw + 2, 3, pal.hair);
    P(fx - 1, hy, fw + 2, 1, '#ffffff33');
    P(fx - 2, hy + 2, 2, 5, pal.hair);
    P(fx + fw, hy + 2, 2, 5, pal.hair);
    P(fx - 1, hy + 2, 3, 1, pal.hair2);
  } else if (hs === 1) {            // 长发
    P(fx - 1, hy - 1, fw + 2, 4, pal.hair);
    P(fx - 1, hy - 1, fw + 2, 1, '#ffffff33');
    P(fx - 3, hy + 2, 3, 14, pal.hair);
    P(fx + fw, hy + 2, 3, 14, pal.hair);
    P(fx - 3, hy + 2, 1, 14, pal.hair2);
    P(fx + fw + 2, hy + 2, 1, 14, pal.hair2);
    P(fx - 1, hy + 3, 2, 2, pal.hair);
    P(fx + fw - 1, hy + 3, 2, 2, pal.hair);
  } else if (hs === 2) {            // 刺猬
    P(fx - 1, hy, fw + 2, 4, pal.hair);
    for (let i = 0; i < 5; i++) P(fx - 1 + i * 3, hy - 3 + (i % 2), 2, 4, pal.hair);
    P(fx - 2, hy + 3, 2, 4, pal.hair);
    P(fx + fw, hy + 3, 2, 4, pal.hair);
    P(fx, hy + 3, fw, 1, pal.hair2);
  } else if (hs === 3) {            // 波波头
    P(fx - 2, hy - 1, fw + 4, 5, pal.hair);
    P(fx - 2, hy - 1, fw + 4, 1, '#ffffff33');
    P(fx - 2, hy + 4, 2, 8, pal.hair);
    P(fx + fw, hy + 4, 2, 8, pal.hair);
    P(fx - 2, hy + 11, 2, 1, pal.hair2);
    P(fx + fw, hy + 11, 2, 1, pal.hair2);
  } else if (hs === 4) {            // 头盔
    P(fx - 2, hy - 2, fw + 4, 6, pal.acc);
    P(fx - 2, hy - 2, fw + 4, 1, '#ffffff4d');
    P(fx - 2, hy + 3, fw + 4, 1, pal.hair2);
    P(15, 2, 3, 3, pal.acc); P(13, 4, 7, 1, pal.acc);
  } else {                          // 马尾
    P(fx - 1, hy, fw + 2, 4, pal.hair);
    P(fx - 1, hy, fw + 2, 1, '#ffffff33');
    P(fx + fw + 1, hy + 1, 2, 4, pal.hair);
    P(fx + fw + 2, hy + 4, 2, 8, pal.hair);
    P(fx - 2, hy + 3, 1, 3, pal.hair);
  }

  // ================= 眉眼 =================
  const ey = 12;                    // 眼睛上沿
  const ex1 = fx + 2, ex2 = fx + fw - 4;
  const browC = '#00000030';
  const angry = (p.brow === 1 || expr === 'angry' || expr === 'shock');
  if (angry) { P(ex1, ey - 2, 3, 1, browC); P(ex1 + 1, ey - 3, 2, 1, browC); P(ex2, ey - 2, 3, 1, browC); P(ex2, ey - 3, 2, 1, browC); }
  else if (p.brow === 2 || expr === 'sad') { P(ex1, ey - 3, 3, 1, browC); P(ex2, ey - 3, 3, 1, browC); }
  else { P(ex1, ey - 2, 3, 1, browC); P(ex2, ey - 2, 3, 1, browC); }

  if (expr === 'sad') {
    // 闭眼 + 泪光
    P(ex1, ey + 1, 3, 1, pal.eye); P(ex2, ey + 1, 3, 1, pal.eye);
    P(ex1 + 2, ey + 2, 1, 2, '#7fd8ff'); P(ex2 + 2, ey + 2, 1, 1, '#7fd8ff');
  } else if (expr === 'win') {
    // ^ ^ 笑眼
    P(ex1 + 1, ey, 1, 1, pal.eye); P(ex1, ey + 1, 1, 1, pal.eye); P(ex1 + 2, ey + 1, 1, 1, pal.eye);
    P(ex2 + 1, ey, 1, 1, pal.eye); P(ex2, ey + 1, 1, 1, pal.eye); P(ex2 + 2, ey + 1, 1, 1, pal.eye);
  } else if (expr === 'shock') {
    P(ex1 - 1, ey, 4, 4, '#ffffff');
    P(ex2 - 1, ey, 4, 4, '#ffffff');
    P(ex1, ey + 1, 2, 2, pal.eye); P(ex2, ey + 1, 2, 2, pal.eye);
    P(ex1, ey + 1, 1, 1, '#ffffff'); P(ex2, ey + 1, 1, 1, '#ffffff');
  } else if (p.eyes === 1) {
    // 锐利：上挑
    P(ex1, ey + 1, 2, 1, pal.eye); P(ex1 + 2, ey, 1, 1, pal.eye);
    P(ex2 + 1, ey + 1, 2, 1, pal.eye); P(ex2, ey, 1, 1, pal.eye);
  } else if (p.eyes === 2) {
    // 大眼：眼白 + 瞳
    P(ex1, ey, 3, 3, '#ffffff'); P(ex2, ey, 3, 3, '#ffffff');
    P(ex1 + 1, ey, 2, 2, pal.eye); P(ex2, ey, 2, 2, pal.eye);
    P(ex1 + 1, ey, 1, 1, '#ffffff'); P(ex2, ey, 1, 1, '#ffffff');
  } else {
    // 标准：眼白包住 1px 瞳 + 高光
    P(ex1, ey + 1, 3, 2, '#ffffff');
    P(ex2, ey + 1, 3, 2, '#ffffff');
    P(ex1 + 1, ey + 1, 1, 2, pal.eye);
    P(ex2 + 1, ey + 1, 1, 2, pal.eye);
    P(ex1 + 1, ey + 1, 1, 1, '#ffffffcc');
  }

  // 腮红
  if (p.blush || expr === 'win') { P(ex1 - 1, ey + 4, 3, 1, '#ff7f9e55'); P(ex2, ey + 4, 3, 1, '#ff7f9e55'); }
  if (p.scar) { P(ex1 + 6, ey - 1, 1, 5, '#0000002b'); }

  // ================= 鼻 / 嘴 =================
  P(17, 16, 1, 1, '#00000016');
  const my = 18, mx = 16;
  const lip = '#8d3d4c';
  if (expr === 'win') { P(mx - 1, my, 3, 2, lip); P(mx - 1, my, 3, 1, '#ffffff44'); }
  else if (expr === 'sad') { P(mx - 1, my + 1, 2, 1, lip); P(mx - 2, my + 1, 1, 1, lip); }
  else if (expr === 'shock') { P(mx - 1, my, 2, 2, lip); }
  else if (p.mouth === 0) P(mx - 1, my, 2, 1, lip);
  else if (p.mouth === 1) P(mx - 1, my, 3, 1, lip);
  else { P(mx, my, 1, 1, lip); P(mx - 1, my + 1, 2, 1, '#00000016'); }

  // ================= 配件 =================
  if (p.accessory === 1) {
    P(ex1 - 2, ey, 5, 1, '#dfe6ff'); P(ex2 - 1, ey, 5, 1, '#dfe6ff');
    P(ex1 - 1, ey + 1, 3, 3, '#ffffff1c'); P(ex2, ey + 1, 3, 3, '#ffffff1c');
    P(ex1 + 2, ey + 1, 2, 1, '#dfe6ff');
    P(ex1 - 2, ey, 1, 1, '#ffffff');
  } else if (p.accessory === 2) {
    P(fx - 2, ey - 3, fw + 4, 2, pal.trim);
    P(fx - 2, ey - 3, fw + 4, 1, '#ffffff55');
    P(fx + fw + 1, ey - 2, 2, 5, pal.trim);
  } else if (p.accessory === 3) {
    P(fx, 3, fw, 2, '#ffcc4d');
    P(fx, 3, fw, 1, '#fff0b0');
    P(fx + 1, 1, 2, 2, '#ffcc4d'); P(fx + fw - 3, 1, 2, 2, '#ffcc4d');
    P(15, 0, 2, 3, '#fff0b0');
  } else if (p.accessory === 4) {
    P(fx - 2, 21, fw + 4, 2, pal.trim);
    P(fx - 2, 21, fw + 4, 1, '#ffffff45');
  }

  // 画面描边
  P(0, 0, S, 1, '#00000044'); P(0, S - 1, S, 1, '#00000066');
  P(0, 0, 1, S, '#00000044'); P(S - 1, 0, 1, S, '#00000044');

  ctx.restore();
}

function renderAvatarTo(canvas, char, expr) {
  const ctx = canvas.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  // 整数倍放大，保持像素锐利
  const scale = Math.max(1, Math.floor(Math.min(canvas.width, canvas.height) / 32));
  const ox = Math.floor((canvas.width - 32 * scale) / 2);
  const oy = Math.floor((canvas.height - 32 * scale) / 2);
  ctx.fillStyle = '#100c1e';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (char.ava) {
    const img = new Image();
    img.onload = () => {
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    };
    img.src = char.ava;
    return;
  }
  drawAvatar(ctx, char, { expr, scale, ox, oy });
}

/* =====================================================================
 * 10 · AUDIO: ZzFX-style micro synth (inline, zero dependency) + chiptune BGM
 * ===================================================================== */
const Sound = {
  on: true,
  ctx: null,
  master: null,
  ensure() {
    if (!this.ctx) {
      try {
        this.ctx = new (window.AudioContext || window.webkitAudioContext)();
        this.master = this.ctx.createGain();
        this.master.gain.value = 0.5;
        this.master.connect(this.ctx.destination);
      } catch (e) { this.on = false; }
    }
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  },
  /* ZzFX-compatible parameter order, single function, sample-accurate envelope */
  zzfx(volume = 1, randomness = 0.05, frequency = 220, attack = 0, sustain = 0, release = 0.1,
    shape = 0, shapeCurve = 1, slide = 0, deltaSlide = 0, pitchJump = 0, pitchJumpTime = 0,
    repeatTime = 0, noise = 0, modulation = 0, bitCrush = 0, delay = 0, sustainVolume = 1,
    decay = 0, tremolo = 0) {
    if (!this.on) return;
    const ac = this.ensure(); if (!ac) return;
    const sr = ac.sampleRate;
    const P2 = Math.PI * 2;
    let f0 = frequency * (1 + randomness * 2 * Math.random() - randomness) * P2 / sr;
    const slideStep = slide * 500 * P2 / sr / sr;
    const dSlideStep = deltaSlide * 500 * P2 / (sr * sr * sr);
    const modStep = modulation * P2 / sr;
    let modOff = 0, jumpCount = 0;
    const atk = Math.max(1, attack * sr), dec = decay * sr, sus = sustain * sr, rel = Math.max(1, release * sr);
    const total = Math.min(Math.floor(atk + dec + sus + rel + delay * sr) || Math.floor(0.2 * sr), sr * 3);
    const buf = ac.createBuffer(1, total, sr);
    const data = buf.getChannelData(0);
    let phase = 0;
    for (let i = 0; i < total; i++) {
      let s;
      if (shape === 0) s = Math.sin(phase);
      else if (shape === 1) s = 1 - 4 * Math.abs(Math.round(phase / P2) - phase / P2);
      else if (shape === 2) s = 1 - (2 * phase / P2 % 2 + 2) % 2;
      else if (shape === 3) s = Math.max(Math.min(Math.tan(phase), 1), -1);
      else if (shape === 4) s = Math.sin(phase * phase * phase);
      else s = ((phase / P2 % 1) < shapeCurve / 2 ? 1 : -1);
      s = Math.sign(s) * Math.pow(Math.abs(s), shapeCurve);
      let env;
      if (i < atk) env = i / atk;
      else if (i < atk + dec) env = 1 - ((i - atk) / (dec || 1)) * (1 - sustainVolume);
      else if (i < atk + dec + sus) env = sustainVolume;
      else if (i < total) env = Math.max(0, (total - i) / rel) * sustainVolume;
      else env = 0;
      if (tremolo && repeatTime) env *= 1 - tremolo + tremolo * Math.sin(P2 * i / (repeatTime * sr));
      s *= env;
      if (noise) s += noise * (Math.random() * 2 - 1) * env;
      if (bitCrush > 0) s = Math.round(s * (1 / bitCrush)) / (1 / bitCrush);
      data[i] = s * volume * 0.5;
      phase += f0;
      f0 += slideStep + dSlideStep;
      if (modulation) phase += Math.cos(modStep * modOff++) * modulation;
      if (pitchJump && ++jumpCount > pitchJumpTime * sr) { f0 += pitchJump * P2 / sr; jumpCount = 0; }
    }
    const src = ac.createBufferSource(); src.buffer = buf;
    const g = ac.createGain(); g.gain.value = 1;
    src.connect(g).connect(this.master);
    src.start();
  },
  move() { this.zzfx(0.35, 0.03, 620, 0, 0.012, 0.05, 2, 1.2, -80); },
  capture() { this.zzfx(0.5, 0.1, 180, 0, 0.05, 0.14, 4, 1.4, -60, 0, 0, 0, 0, 0.5); },
  check() { this.zzfx(0.42, 0.02, 840, 0, 0.04, 0.16, 5, 0.9, 0, 0, 300, 0.08, 0.1); },
  click() { this.zzfx(0.24, 0.02, 720, 0, 0.008, 0.04, 5, 1); },
  select() { this.zzfx(0.2, 0.02, 980, 0, 0.008, 0.035, 5, 1, 140); },
  win() { [0, 4, 7, 12].forEach((n, i) => setTimeout(() => this.zzfx(0.34, 0.01, 440 * Math.pow(2, n / 12), 0, 0.05, 0.18, 5, 1), i * 105)); },
  lose() { [0, -3, -7, -12].forEach((n, i) => setTimeout(() => this.zzfx(0.3, 0.01, 440 * Math.pow(2, n / 12), 0, 0.07, 0.22, 1, 1), i * 125)); },
  bubble() { this.zzfx(0.07, 0.03, 1300, 0, 0.004, 0.02, 5, 1); },
  start() { [0, 5, 7, 12, 16].forEach((n, i) => setTimeout(() => this.zzfx(0.36, 0.01, 330 * Math.pow(2, n / 12), 0, 0.035, 0.16, 2, 1.1), i * 85)); }
};

/* ---- chiptune BGM sequencer ---- */
const BGM = {
  playing: false, timer: null, step: 0,
  bass: [45, 45, 48, 45, 43, 43, 41, 43],
  lead: [69, 72, 76, 72, 74, 72, 69, 67, 69, 72, 76, 79, 77, 76, 72, 69],
  bpm: 102,
  start() {
    if (this.playing) return;
    if (!Sound.ensure()) return;
    this.playing = true; this.step = 0;
    const spb = 60 / this.bpm / 2;
    const tick = () => {
      if (!this.playing) return;
      const ac = Sound.ensure(); if (!ac) return;
      const now = ac.currentTime + 0.03;
      const s = this.step;
      this.note(this.bass[s % this.bass.length], now, spb * 1.7, 'triangle', 0.13);
      if (s % 2 === 0) this.note(this.lead[(s >> 1) % this.lead.length], now, spb * 0.85, 'square', 0.045);
      if (s % 4 === 2) this.noiseHit(now, 0.026);
      this.step++;
      this.timer = setTimeout(tick, spb * 1000);
    };
    tick();
  },
  note(midi, when, dur, type, vol) {
    const ac = Sound.ctx; if (!ac) return;
    const o = ac.createOscillator(), g = ac.createGain();
    o.type = type; o.frequency.value = 440 * Math.pow(2, (midi - 69) / 12);
    g.gain.setValueAtTime(0.0001, when);
    g.gain.linearRampToValueAtTime(vol, when + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    o.connect(g).connect(Sound.master);
    o.start(when); o.stop(when + dur + 0.02);
  },
  noiseHit(when, dur) {
    const ac = Sound.ctx; if (!ac) return;
    const len = Math.floor(ac.sampleRate * dur);
    const buf = ac.createBuffer(1, len, ac.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3) * 0.4;
    const src = ac.createBufferSource(); src.buffer = buf;
    const g = ac.createGain(); g.gain.value = 0.05;
    src.connect(g).connect(Sound.master); src.start(when);
  },
  stop() { this.playing = false; if (this.timer) clearTimeout(this.timer); this.timer = null; },
  toggle() { if (this.playing) { this.stop(); return false; } this.start(); return true; }
};
