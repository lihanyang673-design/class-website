// ============================================================
// game.js —— 节奏玩法核心
// 判定线 + 四方向箭头掉落 + Perfect/Good/Miss + 连击计分
// 箭头用 DOM（贴判定线，清晰锐利），3D 舞台在背后同步反馈
// ============================================================
import * as THREE from 'three';
import { Music, sfxPerfect, sfxGood, sfxMiss, sfxRandomVoice } from './audio.js?v=20261090';
import { doAction, stumble } from './dancer.js?v=20261090';
import { laneFlash, burst, ringPulse, shake } from './fx.js?v=20260929r';

// ---------- 判定窗口（秒） ----------
const WIN_GOOD = 0.15, WIN_PERFECT = 0.07, WIN_MISS = 0.19;
const LANE_HEX = [0xff3b6b, 0x36d1ff, 0xffe17a, 0x7a4dff];  // 四轨道主题色
// 同轨相邻方块最小间隔（秒）：方块高 52px ÷ 下落 340px/s = 0.153s，加余量取 0.19s。
// 只保护"同一条轨道"（不同轨道的音再近也不会重叠）；同轨太近时优先把音挪到别的空闲轨，
// 四条轨都满才放弃该音。双押只额外加一个音 → 最多双押，不可能出现三押。
const LANE_GAP = 0.19;

// ---------- 可见窗口（音符提前多少秒开始显示） ----------
// 普通模式恒为 VIS_BASE；无尽模式随倍速线性扩大，补偿高速下变短的反应时间。
// 锚点：1.1×=0.9s(5行) · 1.4×=1.08s(6行) · 1.7×=1.26s(7行) · 2.0×=1.44s(8行)
// 拟合直线 k=1+(rate-1.1)×2/3，窗口 = VIS_BASE×k。只放宽显示阈值，不碰方块大小/间距/下落速度。
const VIS_BASE = 0.9;
function endlessVisTarget(rate){
  const r = Math.min(2, Math.max(1.1, rate));
  return VIS_BASE * (1 + (r - 1.1) * (2/3));
}

export const Game = {
  playing:false, paused:false,
  cfg:null, notes:[], dom:[],        // notes:{t,lane,el,state}
  score:0, combo:0, maxCombo:0,
  cnt:{perfect:0,good:0,miss:0},
  hooks:{},                          // main 注入：onEnd(result) / onEndlessEnd(result)
  endless:null,                      // 无尽难度状态：{base,round,lives,segLen,nextBoundary}
  _raf:0, _lastY:0,
  _head:0, _hitY:0,                  // 滑动窗口头指针 + 缓存的判定线位置
  _lastRaw:0,                        // 无尽用：上一帧的音频原始时钟（检测循环回绕）
  _visWin:VIS_BASE,                  // 当前可见窗口（秒）：帧间向 _visTarget 平滑靠拢
  _visTarget:VIS_BASE,
  _lastFrameMs:0,
};
if(typeof window!=='undefined') window.__game=Game;   // 调试只读钩子（同 __music/__danceParts 风格）

// ============================================================
// 谱面生成：按 BPM 网格 + 固定种子随机（同一难度谱面恒定，公平上榜）
// ============================================================
function mulberry32(seed){
  return function(){
    seed|=0; seed=seed+0x6D2B79F5|0;
    let t=Math.imul(seed^seed>>>15,1|seed);
    t=t+Math.imul(t^t>>>7,61|t)^t;
    return ((t^t>>>14)>>>0)/4294967296;
  };
}

// 字符串→种子（FNV-1a）：让每首歌+难度都有独一无二的谱面
function strSeed(s){
  let h=2166136261;
  for(let i=0;i<s.length;i++){ h^=s.charCodeAt(i); h=Math.imul(h,16777619); }
  return h>>>0;
}

// ---------- 玩家自制谱面：固定网格 + 四档平滑难度 ----------
// 机制（与原版 genChart 同源）：
//   1) 候选网格：easy 每拍1个；casual/normal/hard 每拍最多2个
//   2) rest：按概率随机休息   easy25% / casual55% / normal30% / hard10%
//   3) dbl：按概率同点双押    easy0   / casual2%  / normal3%  / hard7%
//   4) 轨道随机游走：每个音 70% 概率强制换到与上一个音不同的轨
//      → 方块在轨道间跳散，同轨永远不会连续紧挨（这是音游手感的关键）
// 当前四档参数由用户拍板：地狱=旧狂热（无碎拍），狂热再下调。
// 时间点全部取自存库密谱（对齐音乐），随机走 mulberry32 固定种子 → 同一首歌每次一样。
export function chartNotes(chart, diff, durSec, seedStr){
  const end = Math.max(4, durSec - 0.5);
  const P = {
    easy  : {cand:4, rest:0.25, dbl:0.00, burst:0.00},
    casual: {cand:2, rest:0.55, dbl:0.02, burst:0.00},
    normal: {cand:2, rest:0.30, dbl:0.03, burst:0.00},
    hard  : {cand:2, rest:0.10, dbl:0.07, burst:0.00},
  }[diff];
  const rnd = mulberry32(strSeed((seedStr||'song')+'|'+diff));
  const seen=new Set();
  const out=[];
  const lastLaneT=[-9,-9,-9,-9];        // 每条轨道上一次出音时间（按轨防重叠的依据）
  function add(t,lane){
    const key=t.toFixed(3)+'|'+lane;     // 同一时间点同一轨：只留一个（重叠方块合并）
    if(seen.has(key)) return false;
    seen.add(key);
    out.push({ t, lane, state:0 });
    lastLaneT[lane]=t;
    return true;
  }
  // 想落在 want 轨、但同轨太近 → 随机挪到任一空闲轨；四条轨都满返回 -1（放弃此音）
  function pickLane(want,t){
    if(t-lastLaneT[want]>=LANE_GAP) return want;
    const free=[0,1,2,3].filter(x=>t-lastLaneT[x]>=LANE_GAP);
    return free.length ? free[(rnd()*free.length)|0] : -1;
  }
  // 某时间点找一个"非排除轨道 + 不违反同轨间隔"的空闲轨（碎拍补音用）
  function freeLaneAt(t,exclude){
    const c=[0,1,2,3].filter(x=>!exclude.includes(x) && t-lastLaneT[x]>=LANE_GAP);
    return c.length ? c[(rnd()*c.length)|0] : -1;
  }
  let lane=(rnd()*4)|0;                  // 起始轨道
  // cand 个密谱格 = 一个候选位置（easy 每4格=整拍；其余每2格=半拍）
  for(let i=0; i<chart.length; i+=P.cand){
    const t=+chart[i].t;
    if(t<1.0 || t>end) continue;
    if(rnd() < P.rest) continue;                    // 原版：按概率休息（休息不换道）
    const L=pickLane(lane,t);                       // 同轨太近就挪轨，而不是删音
    if(L<0) continue;                               // 四条轨此刻都太近：放弃此音（休息不换道）
    add(t, L);
    if(P.dbl && rnd() < P.dbl){                     // 原版：按概率双押（只加一个、必不同于本轨）
      const c=[0,1,2,3].filter(x=>x!==L && t-lastLaneT[x]>=LANE_GAP);
      if(c.length) add(t, c[(rnd()*c.length)|0]);
    }
    if(P.burst && rnd() < P.burst && i+2<chart.length && +chart[i+2].t<=end){
      // hard 独有：beat/4、beat/2 后各补一音；各自选空闲轨、受同轨间隔保护
      const t1=+chart[i+1].t, t2=+chart[i+2].t;
      const L1=freeLaneAt(t1,[]);
      if(L1>=0){
        add(t1,L1);
        const L2=freeLaneAt(t2,[L1]);
        if(L2>=0){ add(t2,L2); i+=P.cand; }   // beat/2 已被碎拍占用 → 跳过下一常规候选
      }
    }
    lane = rnd()<0.7 ? (L + 1 + ((rnd()*3)|0)) % 4 : L;  // 原版：70% 强制换道（基于实际落轨）
  }
  return out.sort((a,b)=>a.t-b.t||a.lane-b.lane);
}
export function genChart(diff, bpm, durSec, offsetSec, seedStr=''){
  const rnd = mulberry32(strSeed((seedStr||'x')+diff));
  const beat = 60/bpm;
  const first = Math.max(1.2, offsetSec + beat*4);   // 前奏留白
  const last  = Math.max(first+4, durSec - 1.6);
  const notes = [];
  const DIFF = {
    easy  :{div:1,  rest:0.25, dbl:0.00, burst:0},
    casual:{div:2,  rest:0.55, dbl:0.02, burst:0},
    normal:{div:2,  rest:0.30, dbl:0.03, burst:0},
    hard  :{div:2,  rest:0.10, dbl:0.07, burst:0},
  }[diff];
  let lane = (rnd()*4)|0;
  const step = beat/DIFF.div;
  const lastLaneT=[-9,-9,-9,-9];        // 每条轨道上一次出音时间（按轨防重叠）

  const seen=new Set();
  const reg=(t,l)=>seen.add(t.toFixed(3)+'|'+l);
  let b=first;
  while(b<last){
    if(rnd() < DIFF.rest){ b+=step; continue; }      // 随机休息拍
    let L=lane;                                     // 同轨太近 → 挪到空闲轨，而不是删音
    if(b-lastLaneT[L]<LANE_GAP){
      const free=[0,1,2,3].filter(x=>b-lastLaneT[x]>=LANE_GAP);
      if(!free.length){ b+=step; continue; }        // 四条轨此刻都太近：放弃此拍
      L=free[(rnd()*free.length)|0];
    }
    notes.push({ t:b, lane:L, state:0 });              // state: 0待 1hit 2miss
    reg(b,L); lastLaneT[L]=b;
    // 双押：只加一个、避开本轨和太近的轨 → 最多双押，不会三押
    if(rnd() < DIFF.dbl){
      const c=[0,1,2,3].filter(x=>x!==L && b-lastLaneT[x]>=LANE_GAP);
      if(c.length){
        const l2=c[(rnd()*c.length)|0];
        notes.push({ t:b, lane:l2, state:0 });
        reg(b,l2); lastLaneT[l2]=b;
      }
    }
    // 16 分小连打（困难）：各自选空闲轨、受同轨间隔保护
    if(rnd() < DIFF.burst && b+beat/2<last){
      const pick=(t,ex)=>{
        const c=[0,1,2,3].filter(x=>!ex.includes(x) && t-lastLaneT[x]>=LANE_GAP);
        return c.length ? c[(rnd()*c.length)|0] : -1;
      };
      const t1=b+beat/4, t2=b+beat/2;
      const f1=pick(t1,[]);
      if(f1>=0){
        notes.push({ t:t1, lane:f1, state:0 }); reg(t1,f1); lastLaneT[f1]=t1;
        const f2=pick(t2,[f1]);
        if(f2>=0){
          notes.push({ t:t2, lane:f2, state:0 }); reg(t2,f2); lastLaneT[f2]=t2;
          b += step;
        }   // beat/2 已被碎拍占用 → 跳过下一个常规位置
      }
    }
    // 随机游走换道（不重复上一次的概率高）
    lane = rnd()<0.7 ? (L + 1 + ((rnd()*3)|0))%4 : L;
    b+=step;
  }
  // 出口兜底：同点同轨合并（任何残留原因都在此被兜住）
  const emit=new Set();
  return notes.filter(n=>{
    const k=n.t.toFixed(3)+'|'+n.lane;
    if(emit.has(k)) return false;
    emit.add(k); return true;
  });
}

// ============================================================
// 开始 / 暂停 / 结束
// ============================================================
// 创建单个音符的箭头 DOM（开局建场与无尽追加段共用）
function spawnNoteEl(n){
  const el=document.createElement('div');
  el.className='note'; el.dataset.l=n.lane; el.dataset.dir=n.lane;
  el.innerHTML='<span class="na">➤</span>';
  const hex='#'+LANE_HEX[n.lane].toString(16).padStart(6,'0');
  el.style.borderColor=hex; el.style.color=hex;
  el.style.textShadow=`0 0 14px ${hex}88`;
  el.style.display='none';
  document.querySelector(`.lane[data-l="${n.lane}"]`).appendChild(el);
  n.el=el;
  return el;
}

export function startGame(cfg){
  // cfg:{diff,bpm,offset,speed,duration,chart?}
  // diff==='endless' = 无尽难度（独立第5难度，谱面按地狱密度生成，计分从0开始）
  // chart 存在 = 玩家自制谱面（按难度抽稀）；否则按 BPM 程序化生成
  // 只搭台不开播：倒计时归零后由 main.js 调用 beginPlayback 开播
  stopGame(true);
  Game.cfg = cfg;
  const endless = cfg.diff==='endless';
  const gdiff = endless ? 'hard' : cfg.diff;    // 无尽谱面密度 = 地狱
  Game.notes = cfg.chart && cfg.chart.length
    ? chartNotes(cfg.chart, gdiff, cfg.duration, cfg.songId||'')
    : genChart(gdiff, cfg.bpm, cfg.duration, cfg.offset/1000, cfg.songId||'');
  Game.score=0; Game.combo=0; Game.maxCombo=0;  // 任何难度（含无尽）计分都从 0 开始
  Game.cnt={perfect:0,good:0,miss:0};
  // ===== 无尽难度：音乐循环 + 每段提速 + ❤×10 =====
  if(endless){
    // 切段规则：歌几分钟就切几+1段（约每分钟一段提速一次）；3.5分钟的歌 = 4段
    const segN=Math.max(1, Math.floor(cfg.duration/60)+1);
    const segLen=cfg.duration/segN;
    Game.endless={ base:0, round:1, lives:10, segLen, nextBoundary:segLen };
    Music.el.loop=true;                // 音乐循环播放
    Music.el.playbackRate=1.1;         // 无尽第 1 段就提速 10%
  }else{
    Game.endless=null;
    Music.el.loop=false;
    Music.el.playbackRate=1;
  }
  Game.playing=true; Game.paused=false;
  Game._head=0; Game._lastRaw=0;
  Game._visWin=VIS_BASE; Game._visTarget=VIS_BASE; Game._lastFrameMs=0;   // 每局视野从基准开始
  // 判定线位置缓存：开局算一次，窗口尺寸变化时更新（避免主循环每帧读 offsetTop 强制重排）
  Game._hitY=document.getElementById('hitLine').offsetTop;
  if(!Game._onResize){
    Game._onResize=()=>{ Game._hitY=document.getElementById('hitLine').offsetTop; };
    window.addEventListener('resize', Game._onResize);
  }

  // 清空轨道 DOM，建立箭头元素（延迟到接近屏幕才显示）
  const tilt=document.getElementById('noteTilt');
  tilt.querySelectorAll('.note').forEach(n=>n.remove());
  // 方块延迟创建：开局不一次性建上千个DOM（手机会卡死/顿一下），
  // 只在音符进入1.4秒窗口时才建（见 loop），每帧最多一两个，完全平滑
  Game.dom = [];

  updateHud();
  // 无尽模式用 loop 循环播放，onended 永不触发；普通局一曲结束 = 自然结算
  Music.el.onended = endless ? null : ()=> finishGame(true);
  window.__music = Music.el;   // 调试钩子（与 __game 同性质）
  console.log(`%c[演出] 🎬 开始！难度=${cfg.diff} BPM=${cfg.bpm} 音符数=${Game.notes.length} 时长≈${cfg.duration.toFixed(0)}s`, 'color:#ffe17a;font-weight:bold');
  // 搭台完成：只搭台不开播，倒计时归零后由 main.js 调用 beginPlayback 开播
}

// 真正开播：音乐 + 主循环（无尽顺带弹开局提醒）
export async function beginPlayback(endless){
  // 卡顿全靠主循环的滑动窗口：已处理的永久跳过、每帧只算1.4秒内的几个方块
  const ok=await Music.play();
  if(!ok) return false;
  if(endless) speedToast('♾ 无尽模式 · 计分从0开始 · 1.1×');
  loop();
  return true;
}

export function pauseGame(){
  if(!Game.playing || Game.paused) return;
  Game.paused=true; Music.pause();
}
export function resumeGame(){
  if(!Game.playing || !Game.paused) return;
  Game.paused=false; Music.play();
}
export function stopGame(silent){
  Game.playing=false; Game.paused=false;
  cancelAnimationFrame(Game._raf);
  Music.stop();
  Music.el.onended=null;
  Music.el.loop=false; Music.el.playbackRate=1;
  Game.endless=null;
  document.getElementById('countOverlay')?.classList.remove('on');
  if(!silent){
    document.getElementById('stageUI').classList.remove('on');
    document.getElementById('noteTilt').querySelectorAll('.note').forEach(n=>n.remove());
  }
}

// ============================================================
// 主循环：箭头位移 + 过线 miss 检测
// ============================================================
function loop(){
  if(!Game.playing) return;
  Game._raf = requestAnimationFrame(loop);
  if(Game.paused) return;

  // 歌曲时钟（秒）。无尽模式：音频时钟倒回 = 循环回绕 → 追加下一段更快谱面
  const raw = Music.time();
  if(Game.endless){
    if(raw < Game._lastRaw - 0.05) nextRound(true);   // currentTime 倒回 = 音乐循环了一圈
    else if(raw >= Game.endless.nextBoundary) nextRound(false);  // 到达段界 = 提速进入下一段
    Game._lastRaw = raw;
  }
  const t = Game.endless ? raw + Game.endless.base : raw;   // 谱面时间（跨段累加，永远前进）
  const hitY = Game._hitY;                     // 判定线位置（开局/窗口变化时才算，避免每帧强制重排）
  const pps = Game.endless ? 340 : 340 * Game.cfg.speed;  // 像素/秒（无尽固定基准，不吃自定义速度；它靠 playbackRate 提速）

  // 可见窗口：无尽随倍速平滑扩大（补偿反应时间）；其他模式恒为基准
  const nowMs=performance.now();
  const fdt=Game._lastFrameMs ? Math.min(0.05,(nowMs-Game._lastFrameMs)/1000) : 0.016;
  Game._lastFrameMs=nowMs;
  Game._visTarget = Game.endless ? endlessVisTarget(Music.el.playbackRate) : VIS_BASE;
  Game._visWin += (Game._visTarget-Game._visWin)*Math.min(1,fdt*6);
  const visWin=Game._visWin;

  // 滑动窗口头指针：已终结的音符（hit/miss）永久跳过，不再每帧从头扫
  const ns = Game.notes;
  while(Game._head < ns.length && ns[Game._head].state !== 0) Game._head++;

  let spawnLeft=2;   // ★ 本帧最多新建2个方块：把DOM创建分摊到多帧，避免开局/循环时一帧建十几个造成卡顿
  for(let i=Game._head; i<ns.length; i++){
    const n = ns[i];
    const dt = n.t - t;
    if(n.state !== 0){
      if(n.el && n.el.dataset.done!=='2' && dt < -WIN_MISS){ n.el.remove(); n.el.dataset.done='2'; }
      continue;
    }
    const spawnAhead=Math.max(1.8, visWin+0.4);  // 提前建方块：保证扩大后的窗口内音符都已就位
    if(dt > spawnAhead) break;
    // 延迟创建：每帧最多2个；但0.6秒内就要可见的必须立即建（兜底，任何情况都不会漏方块）
    if(!n.el && (spawnLeft>0 || dt<=0.6)){ spawnNoteEl(n); spawnLeft--; }
    if(!n.el) continue;                        // 本帧还没轮到建它 → 下帧再说
    // 位置：判定线上方 dt 秒 × 速度（y 为相对轨道顶端的绝对坐标）
    const y = hitY - dt*pps - 26;              // -26 让箭头中心对准判定线
    if(dt > visWin){ n.el.style.display='none'; continue; }
    if(n.el.style.display==='none') n.el.style.display='';
    n.el.style.transform = `translateY(${y}px)`;
    // 过线未按 → Miss
    if(dt < -WIN_MISS) judge(n, 'miss', 0);
  }
  // ★ 兜底：普通局所有音符都已处理完（但音乐尾音还在放）→ 立刻结算，不傻等 onended
  //        或音频元素已 ended 但 onended 事件没派发（浏览器偶发）→ 也立刻结算
  if(!Game.endless && (Game._head >= Game.notes.length || Music.el.ended)){
    finishGame(true);
  }
}

// ============================================================
// 判定
// ============================================================
export function hitLane(lane){
  if(!Game.playing || Game.paused) return;
  // 谱面时间与主循环同源（无尽模式 = 音频时钟 + 已累加的段长）
  const t = Game.endless ? Music.time() + Game.endless.base : Music.time();
  let best=null, bestDt=1e9;
  for(let i=Game._head; i<Game.notes.length; i++){
    const n=Game.notes[i];
    if(n.state!==0 || n.lane!==lane) continue;
    const dt = Math.abs(n.t - t);
    if(dt < bestDt){ bestDt=dt; best=n; }
    if(n.t - t > 0.4) break;
  }
  if(!best || bestDt > WIN_MISS){ receptorPop(lane, false); return; }  // 空按不惩罚
  judge(best, bestDt<=WIN_PERFECT ? 'perfect' : 'good', lane);
}

function judge(n, q, lane){
  n.state = q==='miss' ? 2 : 1;
  const el = n.el;

  if(q === 'miss'){
    Game.cnt.miss++; Game.combo=0;
    if(el){ el.classList.add('missed'); setTimeout(()=>el.remove(), 420); n.el=null; }
    sfxMiss(); stumble();
    sfxRandomVoice();   // ★ 失误时随机穿插搞怪语音（内部带概率+5秒节流）
    shake(0.16);
    const vig=document.getElementById('missVig');
    vig.classList.add('on'); setTimeout(()=>vig.classList.remove('on'),130);
    floatText(lane,'MISS','#ff5b7f');
    // 无尽模式：Miss 扣一颗 ❤，扣光 = 无尽结束（结算累计总分）
    if(Game.endless){
      Game.endless.lives--;
      if(Game.endless.lives<=0){ endEndless(); return; }
    }
  } else {
    Game.cnt[q==='perfect'?'perfect':'good']++;
    Game.combo++; Game.maxCombo=Math.max(Game.maxCombo,Game.combo);
    Game.score += (q==='perfect'?1000:500) + Math.min(Game.combo,60)*10;
    if(el){
      const hex=LANE_HEX[n.lane];
      el.style.setProperty('--eatT', el.style.transform||'translateY(0px)');
      el.classList.add('gone'); setTimeout(()=>el.remove(), 200); n.el=null;
      receptorPop(n.lane, true);
      laneFlash(n.lane, hex);
      ringPulse((n.lane-1.5)*0.95, 1.7, hex);
      const c = new THREE.Vector3((n.lane-1.5)*0.6, 1.1, 0.4);
      burst(c, hex, q==='perfect'?52:26);
      q==='perfect' ? sfxPerfect() : sfxGood();
      floatText(n.lane, q==='perfect'?'PERFECT!':'GOOD', q==='perfect'?'#4fe3ff':'#ffe17a');
    }
    doAction(n.lane, q);
  }
  updateHud();
}

function receptorPop(lane, hit){
  const r=document.querySelector(`.receptor[data-l="${lane}"]`);
  if(!r) return;
  r.classList.toggle('hit', hit);
  if(hit) setTimeout(()=>r.classList.remove('hit'), 110);
}

function floatText(lane, txt, color){
  const layer=document.getElementById('floatLayer');
  if(!layer) return;
  const d=document.createElement('div');
  d.className='floatJudge'; d.textContent=txt; d.style.color=color;
  d.style.left = ['11%','36%','61%','86%'][lane];
  layer.appendChild(d);
  setTimeout(()=>d.remove(), 520);
}

function updateHud(){
  document.getElementById('hudScore').textContent = Game.score.toLocaleString();
  if(Game.endless){
    // 无尽 HUD：❤ 血量 + 段数 + 倍速（分数继续走主显示位）
    const E=Game.endless;
    const rate=(1 + 0.1*E.round).toFixed(1);
    document.getElementById('hudMeta').textContent =
      '❤ ×'+E.lives+'/10 · 第'+E.round+'段 · '+rate+'×';
  }else{
    const total = Game.cnt.perfect+Game.cnt.good+Game.cnt.miss;
    const acc = total ? Math.round((Game.cnt.perfect + Game.cnt.good*0.5)/total*100) : 100;
    document.getElementById('hudMeta').textContent =
      `P ${Game.cnt.perfect} · G ${Game.cnt.good} · M ${Game.cnt.miss} · ${acc}%`;
  }
  const cb=document.getElementById('comboBox');
  if(Game.combo>=2){
    cb.classList.add('on');
    document.getElementById('comboNum').textContent='×'+Game.combo;
    cb.classList.remove('pop'); void cb.offsetWidth; cb.classList.add('pop');
  } else cb.classList.remove('on');
}

// ============================================================
// 结算
// ============================================================
// 该曲满分：假设全部 PERFECT。计分规则——第 k 个音（combo=k）得 1000+min(k,60)*10，
// 故前60音为 1000+10k（k=1..60），之后每音固定 1600。
export function maxPossibleScore(n){
  const m=Math.max(0,Math.min(n,60));
  return 1000*m + 5*m*(m+1) + Math.max(0,n-m)*1600;
}

function finishGame(natural){
  if(!Game.playing) return;
  Game.playing=false;
  cancelAnimationFrame(Game._raf);
  Music.stop();

  const total = Game.cnt.perfect+Game.cnt.good+Game.cnt.miss;
  const acc = total ? (Game.cnt.perfect + Game.cnt.good*0.5)/total : 0;
  let rank='C';
  if(acc>=0.98 && Game.cnt.miss===0) rank='SS';
  else if(acc>=0.92) rank='S';
  else if(acc>=0.80) rank='A';
  else if(acc>=0.65) rank='B';
  const coin = Math.floor(Game.score/400);

  // 相对分：100000 × 绝对分 / 该曲满分（不同歌曲、不同音符数也能公平比较）
  const noteN=Game.notes.length;
  const maxScore=maxPossibleScore(noteN);
  const rel=maxScore?Math.round(100000*Game.score/maxScore):0;

  Game.hooks.onEnd && Game.hooks.onEnd({
    score:Game.score, maxCombo:Game.maxCombo, cnt:{...Game.cnt},
    acc, rank, coin, diff:Game.cfg.diff, rel, maxScore, notes:noteN,
    song:Game.cfg.songName||'', songId:Game.cfg.songId||'',
  });
}

// ============================================================
// 无尽模式：音乐循环播放，每段提速 10%（最高 2×），方块同倍率移动；
// 分数/连击/判定从普通局继续累加；Miss 扣 ❤（5 颗），打光即结束。
// ============================================================
// 提速提醒：屏幕上方弹一个小动画（fixed 定位、pointer-events:none，不挡轨道视线）
function speedToast(txt){
  const d=document.createElement('div');
  d.className='speedToast'; d.textContent=txt;
  document.body.appendChild(d);
  setTimeout(()=>d.remove(), 1600);
}

// 进入下一段（wrap=true 音乐循环回绕一圈；false 只是到达本圈内的段界）：
// 每段提速 10%（最高 2×）；回绕时才追加下一圈谱面（固定种子 = 与第一遍完全相同的节奏型）
function nextRound(wrap){
  const E=Game.endless, cfg=Game.cfg;
  if(wrap){
    E.base += Game._lastRaw;      // 谱面时间轴整体前移一段的长度（上一帧音频时钟 ≈ 圈长）
    E.nextBoundary = E.segLen;    // 段界在新圈内重新计
    // 重新生成同一圈谱面并平移追加（notes 保持有序，滑动窗口/判定逻辑全部无感复用）
    let seg;
    if(cfg.chart && cfg.chart.length) seg=chartNotes(cfg.chart,'hard',cfg.duration,cfg.songId||'',0.18);
    else seg=genChart('hard',cfg.bpm,cfg.duration,cfg.offset/1000,cfg.songId||'');
    // 只追加音符数据，不建DOM（延迟创建会在它们进场前逐个建，避免一圈结束时顿卡）
    for(const n of seg){ n.t += E.base; Game.notes.push(n); }
  }else{
    E.nextBoundary += E.segLen;   // 下一道段界
  }
  E.round++;
  const newRate=Math.min(2, 1 + 0.1*E.round);          // 每段 +10%，最高 2 倍速
  if(newRate - Music.el.playbackRate > 0.001){
    Music.el.playbackRate = newRate;
    speedToast('⚡ 提速 '+newRate.toFixed(1)+'×');
  }else if(!E.maxedNoticed){                            // 已到 2× 封顶：只提醒一次
    E.maxedNoticed=true;
    speedToast('🔥 已到最高速 2×');
  }
  updateHud();
  console.log(`%c[无尽] ⚡ 第${E.round}段开始，倍速 ${Music.el.playbackRate.toFixed(1)}×，❤×${E.lives}`, 'color:#ff9de2;font-weight:bold');
}

// ❤ 打光：结束无尽 → 结算累计总分（普通局分数 + 无尽各段累加）
function endEndless(){
  const E=Game.endless;
  Game.endless=null;
  Game.playing=false;
  cancelAnimationFrame(Game._raf);
  Music.el.loop=false; Music.el.playbackRate=1;
  Music.stop();
  Game.hooks.onEndlessEnd && Game.hooks.onEndlessEnd({
    score:Game.score, maxCombo:Game.maxCombo, cnt:{...Game.cnt},
    round:E.round, lives:E.lives, diff:Game.cfg.diff,
    song:Game.cfg.songName||'', songId:Game.cfg.songId||'',
  });
}

// 总谱面剩余时长（生成后调用，用于判断提前结束）
export function chartDuration(){
  return Game.notes.length ? Game.notes[Game.notes.length-1].t + 1.5 : 0;
}
