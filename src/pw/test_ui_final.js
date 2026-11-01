const puppeteer=require('puppeteer-core');
const path=require('path'), os=require('os');
const { chromePath } = require('./testenv');
const BASE = process.env.ARENA_BASE_URL || 'http://localhost:8765';
const FILE = BASE + '/index.html';
const SHOT=path.join(os.tmpdir(),'chess-arena-shots');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let fails=0;
const ck=(n,c,e)=>{ if(c){console.log('  OK  '+n+(e?' | '+e:''))} else {fails++;console.log('  FAIL '+n+(e?' | '+e:''))} };
(async()=>{
 const b=await puppeteer.launch({executablePath: chromePath(),headless:'new',args:['--no-sandbox','']});
 const p=await b.newPage(); const errs=[];
 p.on('pageerror',e=>errs.push(e.message));
 await p.setViewport({width:1600,height:1000});
 await p.goto(FILE,{waitUntil:'domcontentloaded'});
 await sleep(2000);

 console.log('\n=== PGN 导入 UI 流程 ===');
 await p.evaluate(()=>UI.go('records'));
 await sleep(300);
 await p.click('#btnImportPgn');
 await sleep(300);
 const open = await p.evaluate(()=>({shown: !document.getElementById('pgnBox').classList.contains('hidden')}));
 ck('导入面板打开', open.shown);
 await p.evaluate(()=>{ document.getElementById('pgnInput').value='[Event "Test"]\n[White "Alice"]\n[Black "Bob"]\n\n1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 *'; });
 await p.click('#btnDoImport');
 await sleep(600);
 const imported = await p.evaluate(()=>({
   n: Store.records.length,
   last: Store.records[0] ? {moves: Store.records[0].moves.length, white: Store.records[0].white.name} : null,
   cards: document.querySelectorAll('#recGrid .char-card').length
 }));
 ck('棋谱已导入', imported.n===1 && imported.last.moves===6, JSON.stringify(imported.last));
 ck('列表已刷新', imported.cards===1);

 // 打开回放
 await p.evaluate(()=>Replay.open(Store.records[0]));
 await sleep(500);
 const rp = await p.evaluate(()=>({idx: UI.replayIdx, white: document.getElementById('rpWhite').textContent}));
 ck('导入棋谱可回放', rp.idx===0 && /Alice/.test(rp.white), rp.white);
 await p.evaluate(()=>Replay.goto(4));
 await sleep(300);
 const rp2 = await p.evaluate(()=>document.getElementById('rpIdx').textContent);
 ck('回放步进正常', rp2==='4 / 6', rp2);

 console.log('\n=== 节奏按钮 ===');
 await p.evaluate(()=>{ UI.go('battle'); });
 await sleep(200);
 const paces=[];
 for (let i=0;i<3;i++){ await p.click('#btnPace'); await sleep(150); paces.push(await p.evaluate(()=>document.getElementById('paceLabel').textContent)); }
 ck('按钮循环三档', paces.length===3, paces.join(' → '));
 await p.screenshot({path: path.join(SHOT,'61-final-ui.png')});

 console.log('\n=== 高对比 ===');
 await p.click('#btnContrast');
 await sleep(300);
 const hc = await p.evaluate(()=>document.body.classList.contains('high-contrast'));
 ck('高对比可切换', hc===true);
 await p.screenshot({path: path.join(SHOT,'62-contrast.png')});
 await p.click('#btnContrast');

 console.log('\n=== 320px 极窄屏 ===');
 const m = await b.newPage();
 m.on('pageerror',e=>errs.push('m:'+e.message));
 await m.setViewport({width:320,height:680,deviceScaleFactor:2,isMobile:true,hasTouch:true});
 await m.goto(FILE,{waitUntil:'domcontentloaded'});
 await sleep(1800);
 await m.evaluate(()=>{ pendingMode='pve'; refreshSetup(); UI.go('setup'); startMatch(); });
 await sleep(2200);
 const narrow = await m.evaluate(()=>({
   overflow: document.documentElement.scrollWidth - window.innerWidth,
   boardW: Math.round(document.getElementById('boardCanvas').getBoundingClientRect().width),
   vw: window.innerWidth
 }));
 ck('320px 无横向溢出', narrow.overflow<=2, 'overflow='+narrow.overflow);
 ck('棋盘适配 320px', narrow.boardW<=narrow.vw && narrow.boardW>200, narrow.boardW+'/'+narrow.vw);
 await m.screenshot({path: path.join(SHOT,'63-320.png')});

 console.log('\n=== 错误 ===');
 console.log(errs.length?errs.join('\n'):'(无)');
 ck('无运行时错误', errs.length===0);
 console.log('\n RESULT: '+(fails?fails+' FAILED':'ALL PASS'));
 await b.close();
 process.exit(fails?1:0);
})();

