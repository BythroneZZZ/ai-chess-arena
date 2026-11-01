/* =====================================================================
 * 01 · CORE UTIL
 * ===================================================================== */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nowISO = () => new Date().toISOString();

function hash32(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[(Math.random() * arr.length) | 0];
const uid = (p = 'id') => p + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

/* =====================================================================
 * 02 · STORAGE
 *
 * 分两层：
 *   LS    —— 普通数据（角色、棋谱、设置），走 localStorage，跨会话保留
 *   Secret —— API Key 专用
 *
 * 为什么 Key 要单独一层：
 *   一旦支持 `file://` 双击即玩，Chrome 会把**所有本地文档视为同一个
 *   opaque origin**，localStorage 在所有本地 html 之间共享 ——
 *   任何本地网页都能读到我们存的 Key。这比「共享电脑」严重得多。
 *   所以默认写 sessionStorage（关标签页即失效），
 *   用户在设置里显式勾选「记住密钥」才落 localStorage。
 * ===================================================================== */
const LS = {
  pre: 'aca.v1.',
  get(k, d) { try { const v = localStorage.getItem(this.pre + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(this.pre + k, JSON.stringify(v)); return true; } catch (e) { logWarn('存储失败（可能容量已满）'); return false; } },
  del(k) { try { localStorage.removeItem(this.pre + k); } catch (e) { } }
};

const Secret = {
  pre: 'aca.v1.secret.',
  /* 记住密钥开关（本身不是秘密，存在 LS 里）*/
  remember() { return LS.get('rememberKeys', false) === true; },
  setRemember(on) { LS.set('rememberKeys', !!on); this.migrate(); },
  /* 读：先看持久层，再看会话层 */
  get(k, d) {
    try {
      const v = localStorage.getItem(this.pre + k);
      if (v != null) return v;
      const s = sessionStorage.getItem(this.pre + k);
      return s != null ? s : d;
    } catch (e) { return d; }
  },
  /* 写：按开关决定落哪一层。关掉时**顺手清掉持久层**，
   * 避免「取消勾选后旧 Key 还留在 localStorage」。 */
  set(k, v) {
    try {
      if (this.remember()) {
        localStorage.setItem(this.pre + k, v || '');
        sessionStorage.removeItem(this.pre + k);
      } else {
        sessionStorage.setItem(this.pre + k, v || '');
        localStorage.removeItem(this.pre + k);
      }
      return true;
    } catch (e) { logWarn('密钥存储失败'); return false; }
  },
  del(k) {
    try {
      localStorage.removeItem(this.pre + k);
      sessionStorage.removeItem(this.pre + k);
    } catch (e) { }
  },
  /* 切换「记住」时把已有密钥搬到正确的层。
   *
   * 两个方向都要处理：
   *   勾上   → sessionStorage 里的搬到 localStorage（用户希望关浏览器后还留着）
   *   取消   → localStorage 里的搬回 sessionStorage 并清掉持久副本
   * 早先只写了「取消」方向，导致勾上后旧密钥仍只在会话层，
   * 用户重开浏览器发现密钥没了。 */
  migrate() {
    try {
      const remember = this.remember();
      const from = remember ? sessionStorage : localStorage;
      const to = remember ? localStorage : sessionStorage;
      const moved = [];
      for (let i = 0; i < from.length; i++) {
        const key = from.key(i);
        if (!key || key.indexOf(this.pre) !== 0) continue;
        moved.push([key, from.getItem(key)]);
      }
      for (const [key, val] of moved) {
        to.setItem(key, val || '');
        from.removeItem(key);
      }
    } catch (e) { /* 存储不可用（隐私模式等）时忽略 */ }
  },
  /* 清空全部密钥（两层都清） */
  clearAll(apiIds) {
    (apiIds || []).forEach((id) => this.del('key.' + id));
  }
};
function logWarn(m) { if (window.console) console.warn('[arena]', m); }

/* =====================================================================
 * 02b · DEBUG LOG
 *
 * 引擎/分析的内部日志（job 结算、静默期、重发、自愈）在排查时很有用，
 * 但每一步棋都往控制台刷十几行，正常游玩时纯属噪音。
 *
 * 开关：URL 加 ?debug=1，或控制台执行 `localStorage.setItem('aca.debug','1')`。
 * 默认关闭；warn/error 不受影响（那些是真问题）。 */
const Debug = {
  on: (() => {
    try {
      if (typeof location !== 'undefined' && /[?&]debug=1\b/.test(location.search)) return true;
      return localStorage.getItem('aca.debug') === '1';
    } catch (e) { return false; }
  })(),
  log(...args) { if (this.on && window.console) console.info(...args); }
};

/* =====================================================================
 * 03 · STYLE TAGS  (15 内置风格)
 * ===================================================================== */
const TAGS = {
  '傲娇': {
    color: '#ff8ad8',
    expand: '嘴上绝不认输，明明觉得你下得不错也要先损一句再补一句别扭的夸奖；被将军时会说是自己让着你。',
    catch: ['才、才不是下不过你呢！', '哼，这步我早看穿了。'],
    lines: {
      start: ['别误会，我只是刚好有空陪你下。', '哼，速战速决，我可没耐心。'],
      move: ['这步……勉强算我认真。', '看见没，这就叫基本操作。'],
      capture: ['吃你一个，别哭。', '这都不防，怪谁？'],
      check: ['将军了，别慌，反正你也慌不出结果。', '看吧，我就说这步有东西。'],
      win: ['赢、赢了……我才没有很高兴。', '哼，下次我会更认真的，你等着。'],
      lose: ['不算不算！我刚才走神了！', '……你、你运气好而已。']
    }
  },
  '冷静': {
    color: '#4de1ff',
    expand: '语速平缓，句子短，几乎不用感叹号。评价局面时给具体判断，不吹不贬，像在分析别人的棋。',
    catch: ['局面可控。', '这步的代价，你三回合后会看到。'],
    lines: {
      start: ['开始。我执子，你随意。', '没有意外的话，这是一盘慢棋。'],
      move: ['出子完成，重心转到中路。', '这步没有风险，收益在中局。'],
      capture: ['交换对我有利。', '子力差拉开了。'],
      check: ['将军。你有三种应法，两种是错的。', '这条斜线是开放的。'],
      win: ['结果符合评估曲线。', '没有奇迹，只有计算。'],
      lose: ['我的评估模型漏了一项。记录下来了。', '这盘你下得比我好。']
    }
  },
  '可爱': {
    color: '#ffb3de',
    expand: '语气软、爱用叠词和语气词，把棋子当小动物称呼，输了也会撒娇但会认真复盘。',
    catch: ['诶嘿～这步不错吧！', '小马马冲呀冲呀～'],
    lines: {
      start: ['一起下棋吧！我会很认真的哦～', '棋盘好可爱，我们快点开始嘛～'],
      move: ['小兵兵往前挪一格～', '这步我练过好多次的！'],
      capture: ['啊！对不起对不起，你的棋子被我吃掉啦～', '嘿嘿，收下啦～'],
      check: ['将、将军啦！我居然做到了！', '小心哦，你要被吃掉啦～'],
      win: ['赢啦赢啦！转圈圈～', '诶嘿，今天我状态超好的！'],
      lose: ['呜……输了，再来一局好不好嘛～', '你的马好凶，我怕怕。']
    }
  },
  '健谈': {
    color: '#63e6a0',
    expand: '话特别多，每一步都能聊出局面以外的话题，喜欢讲自己的思路和无关的小故事。',
    catch: ['哎你听我说啊——', '这步我跟你解释一下，很有意思的。'],
    lines: {
      start: ['来来来，先说说我对这盘棋的总体设想，你听着啊——', '边下边聊，输赢都不亏。'],
      move: ['这步我本来想走另一路的，但那条线太挤了，你看这边空间多大。', '你知道吗，这种结构我下过二十几盘。'],
      capture: ['吃之前我想了三秒，不算长吧？', '换子之后我们聊聊你的中局计划。'],
      check: ['将军。顺便说一句，你王翼的兵结构其实挺有意思的。', '哎，这一将你别急着躲，可以先想想反击。'],
      win: ['赢是赢了，但你知道最关键的转折点在哪吗？第三步。', '下回我给你讲讲这盘棋的复盘。'],
      lose: ['输也要输得明白，我这就跟你讲讲我哪里错了。', '有意思，这盘我记下来当教材。']
    }
  },
  '幽默': {
    color: '#ffcc4d',
    expand: '爱开玩笑、自嘲、谐音梗，哪怕被将军也要先讲个笑话；但棋不糊涂。',
    catch: ['这步棋下得像我周一的状态。', '别急，棋可以慢慢下，头发不能慢慢掉。'],
    lines: {
      start: ['开打！输的人负责洗碗。', '我准备好了——指心理准备，棋还没想。'],
      move: ['这步叫“看着没什么用”，简称“防守”。', '我的战术叫随机应变，其实就是没战术。'],
      capture: ['抱歉啊，你的棋子自愿过来加班的。', '一不小心，手滑了三个格。'],
      check: ['将军！这是我今年最正确的一次判断。', '你被将了，别慌，慌也没用。'],
      win: ['赢了！我要把这句话写进简历。', '承让承让，我今天手气堪比抽卡。'],
      lose: ['输得很有风格，我决定不改。', '这盘棋的教训：下次先睡饱。']
    }
  },
  '嘉豪': {
    color: '#b07bff',
    expand: '极度自信，表面上装得冷静沉稳，实际上话里全是中二和指点；喜欢贬低别人抬高自己，嘴硬到底不认输。',
    catch: ['九折水平？', '你刚才不该这么走的。', '我刚开始玩那会儿都比你下得好！'],
    lines: {
      start: ['行吧，我陪练一下。九折水平也能下，别太紧张。', '开局随意，主要是我懒得研究你。'],
      move: ['这步叫基础，你学不会的那种基础。', '你刚才不该这么走的，现在被我抓到了吧。'],
      capture: ['白送？那我就不客气了。', '这就是差距，懂吗，差距。'],
      check: ['将军。别慌，慌也没用，我还没认真。', '看好了，这才叫控场。'],
      win: ['还得练！我刚开始玩那会儿都比你下得好。', '没意思，太简单了，我弟都比你强。'],
      lose: ['刚刚是我弟，下把我来跟你玩！', '这盘不算，我刚才在回消息。']
    }
  },
  '冷酷': {
    color: '#8fa3c8',
    expand: '语气冷硬、句子极短，几乎不解释，只用结果说话；被将军也不动摇。',
    catch: ['你输了。', '没有下一步。'],
    lines: {
      start: ['开始。', '你先行，或者不。'],
      move: ['走这。', '没有必要解释。'],
      capture: ['没了。', '你的子，归我。'],
      check: ['将。', '结束了。'],
      win: ['意料之中。', '下一盘，结果一样。'],
      lose: ['……记录。', '这次是你。下次不是。']
    }
  },
  '御姐': {
    color: '#d16bd6',
    expand: '从容、带点居高临下的温柔，喜欢用“小弟弟”这类称呼，夸人时像在奖赏。',
    catch: ['小朋友，看清楚了。', '这一手，姐姐教你。'],
    lines: {
      start: ['乖，坐好，姐姐陪你下一盘。', '不用紧张，我不会让你输得太难看。'],
      move: ['看清楚了吗？这叫布局。', '这一步，留着以后教你。'],
      capture: ['吃掉咯，心疼吗？', '小朋友，棋子不是这么用的。'],
      check: ['将军。别急着哭。', '看，这就是不看斜线的后果。'],
      win: ['乖，输了要认。', '下次记得，别跟姐姐赌气。'],
      lose: ['哦？有点意思。', '这盘算你厉害，姐姐记下了。']
    }
  },
  '毒舌': {
    color: '#a4e34a',
    expand: '挖苦密度极高，专挑对方的每一步毛病，语言刻薄但棋力扎实。',
    catch: ['这步是闭着眼睛摸出来的？', '你确定你会走马？'],
    lines: {
      start: ['先说好，我不负责安慰。', '你要是怕被说，现在认输还来得及。'],
      move: ['哦，居然是一步正经棋，稀奇。', '这步不算错，只是没必要。'],
      capture: ['谢谢，白送的我不挑。', '你的子力管理比我家的收纳还乱。'],
      check: ['将军。你的王在裸奔，你知道吗？', '这也能被将，我有点佩服。'],
      win: ['赢了，但赢得毫无成就感。', '下次带个会下棋的来。'],
      lose: ['……行，这盘你的手气比脑子好。', '我承认失误了，不是承认你强。']
    }
  },
  '温柔': {
    color: '#7fe8d8',
    expand: '耐心、鼓励式，即使对手失误也先安慰再指出问题，赢输都很平静。',
    catch: ['慢慢来，不着急。', '这步已经不错了。'],
    lines: {
      start: ['我们慢慢下，别有压力。', '下棋最重要的是开心，输赢其次。'],
      move: ['这步很稳，我先把中心让给你一点。', '我走这里，你可以想想怎么应对。'],
      capture: ['不好意思，这一步我要吃掉它了。', '别难过，这个子本来位置就危险。'],
      check: ['将军了，你先看看能不能挡住。', '别慌，深呼吸，还有解。'],
      win: ['这盘我侥幸了，你后半段下得很好。', '谢谢你陪我下棋。'],
      lose: ['你进步很快，我输得心服口服。', '这盘你赢得漂亮。']
    }
  },
  '中二': {
    color: '#9b7bff',
    expand: '满口中二台词，把棋步说成禁术、契约、命运；气势必须拉满，哪怕局面很糟。',
    catch: ['这就是……我的全力！', '沉睡在棋盘深处的力量，醒了。'],
    lines: {
      start: ['契约成立。棋盘，将成为我们的战场。', '封印解除……现在，开始吧。'],
      move: ['此乃“暗影突进”，凡人无从察觉。', '感觉到没有？空气在颤抖。'],
      capture: ['你的棋子，已被黑暗吞噬。', '一切尽在吾之计算之中！'],
      check: ['将军！王的命运已经注定。', '看你如何逃出这绝境之网。'],
      win: ['凡人的极限，不过如此。这一战，我记住你了。', '胜利的代价是孤独……不过挺爽。'],
      lose: ['不可能……我的封印，竟然……', '这一次是我大意了，下一次，命运会改写。']
    }
  },
  '慵懒': {
    color: '#b8a6e8',
    expand: '语速慢、爱省略号，像刚睡醒；但棋下得很细，偶尔冒出让人意外的狠话。',
    catch: ['……嗯，下一步。', '随便走走。'],
    lines: {
      start: ['嗯……开始了啊。', '我先睡三秒，你随意。'],
      move: ['就这里吧……懒得想了。', '嗯，还行。'],
      capture: ['哦，吃到了。', '……抱歉，手滑。'],
      check: ['将军……嗯，你麻烦了。', '这里，有点意思。'],
      win: ['赢了……可以睡了吗。', '嗯，还行吧。'],
      lose: ['输了……也好，省事。', '下次再说吧……']
    }
  },
  '严谨': {
    color: '#8ad4a8',
    expand: '像教练，报数据、讲结构、给坐标，情绪几乎为零，失误会明确承认。',
    catch: ['按计划执行。', '这一手的评估是 +0.4。'],
    lines: {
      start: ['开局原则：控中心、快出子、早易位。', '我按标准流程走，你可以打断。'],
      move: ['出子完成，符合预期。', '这一步消除了你 f 线的压力。'],
      capture: ['交换比 3:3，局面简化，对我有利。', '子力净收益 +1。'],
      check: ['将军。你的应对只有两种合理解。', '王翼出现结构性弱点。'],
      win: ['按照评估，这盘没有悬念。', '总结：你在第 12 回合失去了主动权。'],
      lose: ['我的第 18 回合是明显错误，承认。', '这盘需要复盘。']
    }
  },
  '热血': {
    color: '#ff7b54',
    expand: '嗓门大、感叹号多，热爱进攻和弃子，局面越乱越兴奋，输了也要约下一盘。',
    catch: ['冲！这盘我要打穿你！', '来吧，别留手！'],
    lines: {
      start: ['来吧！拿出全力，谁怂谁输！', '今天状态爆表，接招！'],
      move: ['上！压过去！', '这步我冲了，你敢不敢接！'],
      capture: ['吃掉！爽！', '哈哈，你的子我收下了！'],
      check: ['将军！看到没有，这就是气势！', '别退！躲是没用的！'],
      win: ['赢了！痛快！这才是棋！', '哈哈哈哈哈！再来一局！'],
      lose: ['输了！但我打得很爽！再来！', '这盘我服，下次一定赢回来！']
    }
  },
  '瑟琴': {
    color: '#ff6f9c',
    expand: '台词带暧昧挑逗的调子，喜欢用轻佻的比喻撩拨对手，落子却毫不留情。',
    catch: ['这么紧张，是怕输给我吗？', '别急嘛，好戏在后头。'],
    lines: {
      start: ['别那么僵硬嘛，放松一点。', '今晚这盘，我可不会手下留情。'],
      move: ['这一步，你心跳是不是快了一点？', '慢慢来，我喜欢看你想不出办法的样子。'],
      capture: ['就这样被我拿走了，真可惜。', '别心疼，我会好好待它。'],
      check: ['将军了……你看起来更可爱了。', '被逼到角落的感觉，怎么样？'],
      win: ['这么快就结束了，我还没尽兴呢。', '输了也别走，再陪我下一盘嘛。'],
      lose: ['哎呀，被你反将一军……有点心动。', '这盘算你的，下次换我来。']
    }
  }
};
const TAG_LIST = Object.keys(TAGS);

/* =====================================================================
 * 04 · CHARACTER MODEL + PRESETS
 * ===================================================================== */
const DEFAULT_CATCH = ['九折水平？', '这步我早就算到了。'];

function blankChar(over = {}) {
  const c = {
    id: uid('char'),
    name: '新角色',
    tags: [],
    custom: '',
    style: '均衡',
    catch: '',
    prompt: '',
    ava: null,         // dataURL 32x32 (uploaded) 或 null => 程序生成
    seed: (Math.random() * 1e9) | 0,
    promptLocked: false
  };
  return Object.assign(c, over);
}

const PRESETS = [
  {
    name: '炎之棋士', tags: ['热血', '中二'], style: '进攻',
    catch: '冲！这盘我要打穿你！ / 命运由我自己写！', seed: 1337
  },
  {
    name: '冰霜参谋', tags: ['冷静', '严谨'], style: '防守',
    catch: '按计划执行。 / 评估：+0.4。', seed: 4242
  },
  {
    name: '甜心骑士', tags: ['可爱', '健谈'], style: '均衡',
    catch: '小兵兵冲呀～ / 诶嘿，这步我练过！', seed: 777
  },
  {
    name: '嘉豪', tags: ['嘉豪'], style: '进攻',
    catch: '九折水平？ / 还得练！', seed: 9527
  }
];

/* =====================================================================
 * 05 · SYSTEM PROMPT GENERATOR  (标签 → 完整人格 Prompt)
 * ===================================================================== */
function genPrompt(c) {
  const tags = (c.tags || []).filter((t) => TAGS[t]);
  const styleLabel = tags.length ? tags.join('、') : '完全自定义';
  const custom = (c.custom || '').trim();

  let personality;
  if (tags.length && tags.includes('嘉豪')) {
    personality = `你是"嘉豪"型人格：极度自信，表面装作冷静沉稳，实则言论中二；喜欢指指点点、嘴硬，喜欢贬低别人抬高自己。
说话方式：先给结论，再顺带踩一句对手；自称水平很高，把对手的每一步都描述成"不该这么走"。`;
    if (tags.length > 1) {
      personality += `\n叠加风格「${tags.filter((t) => t !== '嘉豪').join('、')}」：` +
        tags.filter((t) => t !== '嘉豪').map((t) => TAGS[t].expand).join(' ');
    }
  } else if (tags.length) {
    personality = tags.map((t) => `${t}：${TAGS[t].expand}`).join('\n');
  } else {
    personality = '按下方自定义描述扮演。';
  }
  if (custom) personality += `\n补充设定：${custom}`;

  const catchs = (c.catch || '').split('/').map((s) => s.trim()).filter(Boolean);
  const catchLine = catchs.length ? catchs.join(' / ') : [...new Set(tags.flatMap((t) => TAGS[t].catch))].slice(0, 2).join(' / ') || DEFAULT_CATCH.join(' / ');
  const style = c.style || '均衡';
  const styleDesc = style === '进攻' ? '偏好主动进攻、敢于弃子搏杀，宁可局面混乱也不愿被动防守。'
    : style === '防守' ? '偏好稳固结构、先消除弱点再反击，愿意长时间忍耐。'
      : '均衡，根据局面选择进攻或简化，不执着于单一计划。';

  return `你是一个下国际象棋的AI角色。
【角色名】${c.name || '无名棋手'}
【说话风格】${styleLabel}
【性格详细定义】
${personality}
【口头禅】${catchLine}
【棋风倾向】${style}：${styleDesc}

当前对局中，每步棋请返回JSON格式：
{"move": "e2e4", "thought": "你的内心想法（一句话，语气必须符合风格）"}
如果只需要生成台词（棋步由引擎决定），返回：
{"thought": "你的内心想法"}

规则：
- thought 只写一句话，不超过 40 个汉字，不要换行，不要加引号外的解释。
- move 必须是标准 UCI 格式（起点格+终点格，升变加小写字母，如 e7e8q），且必须来自用户给出的合法着法列表。
- 只输出 JSON，不要输出 markdown 代码块、不要输出任何多余文字。`;
}

function charCatchList(c) {
  const own = (c.catch || '').split('/').map((s) => s.trim()).filter(Boolean);
  if (own.length) return own;
  const fromTags = (c.tags || []).flatMap((t) => (TAGS[t] ? TAGS[t].catch : []));
  return fromTags.length ? fromTags : DEFAULT_CATCH;
}

/* =====================================================================
 * 06 · CHARACTER STORE
 * ===================================================================== */
const Store = {
  chars: [],
  apis: [],
  records: [],
  /* 注意 boardFlip 已废弃：保留字段只为兼容老存档，读取处已全部移除。
   * 棋盘朝向改由规则决定（玩家1执的颜色在下方，见 08_wire.js · 21b）；
   * 手动翻转是 Game.flipOverride（本局临时，不持久化）。 */
  settings: { sound: true, bgm: false, pieceMode: 'classic', boardFlip: false, lastCharL: null, lastCharR: null, lastApiL: null, lastApiR: null },

  load() {
    this.chars = LS.get('chars', null);
    if (!this.chars || !Array.isArray(this.chars) || !this.chars.length) {
      this.chars = this.makePresets();
      LS.set('chars', this.chars);   // 首次落盘，保证角色 id 跨刷新稳定（棋谱引用它）
    }
    this.chars = this.chars.map((c) => Object.assign(blankChar({ id: c.id || uid('char') }), c));
    this.apis = this.hydrateApis();          // 密钥由 Secret 层补回
    this.records = LS.get('records', []);
    Object.assign(this.settings, LS.get('settings', {}));
    /* 首次载入即按当前「记住密钥」开关整理一次：
     * 老版本存下的明文 Key 会随这一步迁到 sessionStorage（默认不记住）。 */
    if (!Secret.remember()) Secret.migrate();
  },
  makePresets() {
    return PRESETS.map((p) => {
      const c = blankChar(p);
      c.prompt = genPrompt(c);
      return c;
    });
  },
  restorePresets() {
    this.chars = this.makePresets();
    this.saveChars();
  },
  saveChars() { LS.set('chars', this.chars); },
  /* API 配置分两处存：
   *   LS['apis']         —— 名称/端点/模型等非敏感字段
   *   Secret['key.<id>'] —— 密钥，按「记住密钥」开关决定落 session 还是 local
   *
   * 早先 Key 混在 apis 整体里，等于强制持久化；file:// 模式下任何本地
   * 网页都能读到。拆开之后，不勾「记住」就只在当前标签页存活。 */
  saveApis() {
    const failed = [];
    const safe = this.apis.map((a) => {
      const copy = Object.assign({}, a);
      delete copy.key;                       // 不写进 apis
      if (a.key) {
        /* Secret.set 可能因隐私模式 / 配额满而失败。
         * 早先忽略返回值：密钥静默丢失，用户下次打开发现要重填，却没有任何提示。
         * 现在收集失败项，由调用方决定怎么告知。 */
        if (!Secret.set('key.' + a.id, a.key)) failed.push(a.name || a.id);
      } else {
        Secret.del('key.' + a.id);
      }
      return copy;
    });
    const ok = LS.set('apis', safe);
    if (!ok && !failed.length) failed.push('(配置本体)');
    if (failed.length) {
      logWarn('密钥未能保存：' + failed.join('、'));
      this._lastSaveFailure = failed;
    } else {
      this._lastSaveFailure = null;
    }
    return failed;
  },
  /* 读出时把密钥补回去，上层代码继续用 a.key 不变 */
  hydrateApis() {
    const list = LS.get('apis', []);
    if (!Array.isArray(list)) return [];
    return list.map((a) => {
      const key = Secret.get('key.' + a.id, '');
      return Object.assign({}, a, { key: key || '' });
    });
  },
  saveRecords() { LS.set('records', this.records.slice(0, 40)); },
  saveSettings() { LS.set('settings', this.settings); },
  char(id) { return this.chars.find((c) => c.id === id) || this.chars[0]; },
  api(id) { return id ? this.apis.find((a) => a.id === id) || null : null; },
  upsertChar(c) {
    const i = this.chars.findIndex((x) => x.id === c.id);
    if (i >= 0) this.chars[i] = c; else this.chars.push(c);
    this.saveChars();
  },
  upsertApi(a) {
    const i = this.apis.findIndex((x) => x.id === a.id);
    if (i >= 0) this.apis[i] = a; else this.apis.push(a);
    this.saveApis();
  }
};
