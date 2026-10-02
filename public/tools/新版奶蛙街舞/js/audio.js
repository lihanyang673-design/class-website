// ============================================================
// audio.js —— 音频系统
// 1) 音乐：HTMLAudioElement 播放 music.mp3（currentTime 即游戏时钟，暂停天然对齐）
// 2) 音效：Web Audio API 全程序化合成，零外部文件
// ============================================================

// ---------- 全局 AudioContext（首次用户手势后创建/恢复） ----------
let ctx = null;          // AudioContext
let sfxGain = null;      // 音效总线
let sfxOn = true;        // 音效开关

export function ensureCtx(){
  if(!ctx){
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    sfxGain = ctx.createGain();
    sfxGain.gain.value = 0.9;
    sfxGain.connect(ctx.destination);
  }
  if(ctx.state === 'suspended') ctx.resume();
  return ctx;
}
export function setSfxEnabled(b){ sfxOn = !!b; }

// ============================================================
// 基础合成工具
// ============================================================

// 快速衰减的「叮/爆点」：osc + gain 包络
function ping(freq, dur=0.25, type='sine', vol=0.5, when=0, pan=0){
  if(!ctx || !sfxOn) return;
  const t = ctx.currentTime + when;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type; o.frequency.setValueAtTime(freq, t);
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  route(o, g, pan, t, dur);
}
// 带立体声/总线连接的小工具
function route(node, g, pan, t, dur){
  let last = g;
  if(pan !== 0 && ctx.createStereoPanner){
    const p = ctx.createStereoPanner(); p.pan.value = pan;
    g.connect(p); last = p;
  }
  node.connect(g); last.connect(sfxGain);
  node.start(t); node.stop(t + dur + 0.05);
}

// 白噪声 buffer（缓存复用）
let noiseBuf = null;
function getNoise(){
  if(noiseBuf) return noiseBuf;
  const len = ctx.sampleRate * 1.2;
  noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for(let i=0;i<len;i++) d[i] = Math.random()*2-1;
  return noiseBuf;
}

// ============================================================
// 开场动画专用音效（配合每个动画节点）
// ============================================================

// ① 呼啸飞过：噪声 + 带通扫频 + 左右声像移动
export function sfxWhoosh(panFrom = -0.8, panTo = 0.8, dur = 0.85){
  if(!ctx || !sfxOn) return;
  const t = ctx.currentTime;
  const src = ctx.createBufferSource();
  src.buffer = getNoise();
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass'; bp.Q.value = 1.2;
  bp.frequency.setValueAtTime(300, t);
  bp.frequency.exponentialRampToValueAtTime(2600, t + dur*0.7);
  bp.frequency.exponentialRampToValueAtTime(500, t + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.001, t);
  g.gain.exponentialRampToValueAtTime(0.5, t + dur*0.35);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  let last = g;
  if(ctx.createStereoPanner){
    const p = ctx.createStereoPanner();
    p.pan.setValueAtTime(panFrom, t);
    p.pan.linearRampToValueAtTime(panTo, t + dur);
    g.connect(p); last = p;
  }
  src.connect(bp); bp.connect(g); last.connect(sfxGain);
  src.start(t); src.stop(t + dur + 0.1);
}

// ② 交叉火花：清脆双音 + 上滑闪光感
export function sfxCross(){
  ping(1318, 0.3, 'sine', 0.4);        // E6
  ping(1760, 0.35, 'sine', 0.32, 0.05);// A6
  if(!ctx || !sfxOn) return;
  const t = ctx.currentTime;
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = 'triangle';
  o.frequency.setValueAtTime(900, t);
  o.frequency.exponentialRampToValueAtTime(3200, t + 0.22);
  g.gain.setValueAtTime(0.18, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
  route(o, g, 0, t, 0.25);
}

// ③ 落地「啵」泡泡音：音高下滑的短 sine
export function sfxBoop(when = 0, pan = 0){
  if(!ctx || !sfxOn) return;
  const t = ctx.currentTime + when;
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = 'sine';
  o.frequency.setValueAtTime(520, t);
  o.frequency.exponentialRampToValueAtTime(150, t + 0.14);
  g.gain.setValueAtTime(0.4, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
  route(o, g, pan, t, 0.16);
}

// ④ 标题 Q 弹「BOING」：主音上行 + 颤音衰减（果冻感）
export function sfxBoing(){
  if(!ctx || !sfxOn) return;
  const t = ctx.currentTime;
  // 主 BOING：sine 从 170 冲到 540，带 LFO 颤音
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = 'sine';
  o.frequency.setValueAtTime(170, t);
  o.frequency.exponentialRampToValueAtTime(540, t + 0.12);
  const lfo = ctx.createOscillator(), lg = ctx.createGain();
  lfo.frequency.setValueAtTime(26, t);
  lfo.frequency.exponentialRampToValueAtTime(7, t + 0.5);
  lg.gain.setValueAtTime(90, t);
  lg.gain.exponentialRampToValueAtTime(6, t + 0.5);
  lfo.connect(lg); lg.connect(o.frequency);
  g.gain.setValueAtTime(0.55, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.6);
  o.connect(g); g.connect(sfxGain);
  o.start(t); lfo.start(t); o.stop(t + 0.65); lfo.stop(t + 0.65);
  // 底鼓垫一下
  ping(70, 0.2, 'sine', 0.6);
}

// ⑤ 淡出时的下行柔光
export function sfxOutro(){
  if(!ctx || !sfxOn) return;
  const t = ctx.currentTime;
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = 'triangle';
  o.frequency.setValueAtTime(1250, t);
  o.frequency.exponentialRampToValueAtTime(320, t + 0.8);
  g.gain.setValueAtTime(0.16, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.85);
  route(o, g, 0, t, 0.85);
}

// ============================================================
// 游戏内音效
// ============================================================
export function sfxPerfect(){
  ping(1568, 0.18, 'sine', 0.35);       // G6
  ping(2093, 0.22, 'sine', 0.25, 0.03); // C7 亮一点
}
export function sfxGood(){
  ping(880, 0.15, 'triangle', 0.3);
}
export function sfxMiss(){
  if(!ctx || !sfxOn) return;
  const t = ctx.currentTime;
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = 'sawtooth';
  o.frequency.setValueAtTime(220, t);
  o.frequency.exponentialRampToValueAtTime(90, t + 0.22);
  g.gain.setValueAtTime(0.22, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.24);
  route(o, g, 0, t, 0.24);
}
export function sfxCoin(){
  ping(1976, 0.1, 'square', 0.16);
  ping(2637, 0.16, 'square', 0.14, 0.06);
}
export function sfxClick(){
  ping(660, 0.07, 'sine', 0.25);
}

// ============================================================
// 语音/搞怪音效（外部 MP3，与合成音效共用开关）
//  - voice-end.mp3：每局演出结束必播
//  - voice-1/2/3.mp3：随机搞怪池（戳奶龙 / Miss / 进主界面 随机穿插）
// ============================================================
const VOICE_END = 'sounds/voice-end.mp3';
const VOICE_FUN = ['sounds/voice-1.mp3','sounds/voice-2.mp3','sounds/voice-3.mp3'];
let voiceVol = 0.9;
let lastFunAt = 0;          // 上次搞怪音时间戳（节流，防叠加刷屏）

export function setVoiceVolume(v){ voiceVol = Math.min(1, Math.max(0, +v || 0)); }

function playVoiceFile(file){
  if(!sfxOn) return;
  try{
    const a = new Audio(file);
    a.volume = voiceVol;
    a.play().catch(()=>{});  // 自动播放策略拦截时静默
  }catch(e){ /* 语音缺失/失败不影响游戏 */ }
}

// 搞怪池统一入口：prob=触发概率，gap=两次最小间隔(ms)
function pokeFun(prob, gap){
  const now = performance.now();
  if(now - lastFunAt < gap) return;
  if(Math.random() > prob) return;
  lastFunAt = now;
  playVoiceFile(VOICE_FUN[(Math.random()*VOICE_FUN.length)|0]);
}
// 戳奶龙：基本必响（0.8s 防抖，防狂戳叠音）
export function sfxPokeVoice(){ pokeFun(1, 800); }
// 演出中 Miss：35% 概率、至少间隔 5 秒（失误太频繁也不会吵）
export function sfxRandomVoice(){ pokeFun(0.35, 5000); }
// 每局结束：必播
export function sfxEndVoice(){ playVoiceFile(VOICE_END); }

// ============================================================
// 音乐（HTMLAudioElement）
// ============================================================
const music = new Audio();
music.src = 'music.mp3';
music.preload = 'auto';
music.loop = false;   // 一曲结束 = 一场演出结束
// ★ 调试钩子：监听 error 事件 + 暴露到 window
music.addEventListener('error', ()=>{
  const e = music.error;
  console.log('%c[音乐] ❌ error! code='+(e?e.code:'?')+' src='+music.src+' currentSrc='+music.currentSrc, 'color:#ff4d4d;font-weight:bold');
});
window.__music = music;

export const Music = {
  el: music,
  currentSong: 'music.mp3',
  // 切换歌曲（传入文件名，如 'song2.mp3'）
  setSong(file){
    // 路径适配：绝对路径/URL 直接用；默认曲直接放游戏目录；上传曲根据环境选前缀
    let src=file;
    if(!file.startsWith('/') && !file.includes('://') && file!=='music.mp3'){
      const isStatic = location.hostname.includes('github.io') || location.protocol==='file:';
      src = isStatic ? file : '/uploads/dance/'+file;
    }
    this.currentSong = file;
    this._src = src;
    // ★ 同一首歌已在加载/已加载（选歌时已 preload）→ 不重复 load，避免开演时重新下载造成卡顿
    const cur = music.currentSrc || '';
    if(cur && (cur.endsWith(src) || cur.endsWith(encodeURI(src)))){
      if(music.readyState>=3){ music._readyP = Promise.resolve(music.duration||95); return; }
      if(music._readyP) return;   // 正在加载中：沿用选歌时已建好的就绪 Promise
    }
    music.src = src;
    music.load();
    // ★ load 之后立即注册 ready 监听（避免错过事件），等 canplay/loadedmetadata 或超时
    music._readyP = new Promise(res=>{
      if(music.readyState>=3){ res(music.duration||95); return; }
      let done=false;
      const fin=(v)=>{ if(done) return; done=true; cleanup(); res(v); };
      const onReady=()=>fin(music.duration||95);
      const onErr=()=>fin(95);
      const to=setTimeout(()=>fin(music.duration||95), 5000);
      const cleanup=()=>{ music.removeEventListener('canplay',onReady); music.removeEventListener('loadedmetadata',onReady); music.removeEventListener('error',onErr); clearTimeout(to); };
      music.addEventListener('canplay',onReady,{once:true});
      music.addEventListener('loadedmetadata',onReady,{once:true});
      music.addEventListener('error',onErr,{once:true});
    });
    console.log('%c[音乐] 🎵 切歌 → '+file, 'color:#36d1ff;font-weight:bold');
  },
  load(){ music.load(); },
  async play(){
    const want = this._src || this.currentSong;
    // ★ 保底：用 URL 规范化比较，解决 QQ 浏览器路径编码差异导致误判"不匹配"而强制重载卡住
    const needReload = ()=>{
      if(!want) return false;
      try{
        const curUrl = new URL(music.currentSrc, location.href).pathname;
        const wantUrl = new URL(want, location.href).pathname;
        return decodeURIComponent(curUrl) !== decodeURIComponent(wantUrl);
      }catch{ return true; }
    };
    if(needReload()){
      console.log('%c[音乐] ⚠ 路径不匹配，重载 → '+want, 'color:#ff9800;font-weight:bold');
      music.src = want;
      music.load();
      if(music.readyState < 3){
        await new Promise(r=>{
          const ok=()=>{cleanup();r();}, err=()=>{cleanup();r();}, to=setTimeout(()=>{cleanup();r();},3000);
          const cleanup=()=>{ music.removeEventListener('canplay',ok); music.removeEventListener('error',err); clearTimeout(to); };
          music.addEventListener('canplay',ok,{once:true});
          music.addEventListener('error',err,{once:true});
        });
      }
    }
    console.log('%c[音乐] ▶ 播放 → '+music.currentSrc+' (readyState='+music.readyState+')', 'color:#7fffd4;font-weight:bold');
    try{
      await music.play();
      return true;
    }catch(e){
      // ★ 手机浏览器（QQ/微信）拒绝异步手势后的播放：不静默，返回 false 让闸门提示玩家再点一次
      console.warn('[音乐] 播放被浏览器拒绝：', e.name, e.message);
      return false;
    }
  },
  pause(){ music.pause(); },
  // ★ 只在已加载足够数据时才 seek，避免 abort 还在加载的新歌
  stop(){ music.pause(); if(music.readyState>=2) music.currentTime = 0; },
  // 游戏时钟：当前歌曲时间（秒），判定全部以它为准
  time(){ return music.currentTime; },
  duration(){ return music.duration || 0; },
  // ★ 等待【本次切歌】加载就绪，返回真实时长（用 setSong 里建好的 _readyP，不会错过事件）
  awaitDuration(){
    return music._readyP || Promise.resolve(music.duration||95);
  },
  setVolume(v){ music.volume = Math.min(1, Math.max(0, v)); },
  isPlaying(){ return !music.paused; },
};

// ============================================================
// 菜单 BGM（Web Audio 合成 · 欢快芯片流行风）
// 鼓组(底鼓/军鼓/踩镲) + 跳跃贝斯 + 和弦垫 + 明亮主旋律，8 小节循环
// 开演后调用 stopMenuBgm()，由玩家选的歌曲接管
// ============================================================
let menuBgm = {
  timer:null,        // 调度定时器
  gain:null,         // 菜单 BGM 总线
  playing:false,
};

const BGM_BPM = 138;
// 音高 → 频率：semi=0 为 C4(261.6Hz)
function midiFreq(semi){ return 440 * Math.pow(2, (semi-9)/12); }

// ---- 8 小节和声（C-G-Am-F-C-G-Am-G，经典明亮走向）；音高以 C4 为 0 ----
const CHORDS = [
  [0,4,7], [-5,-1,2], [-3,0,4], [-7,-3,0],
  [0,4,7], [-5,-1,2], [-3,0,4], [-5,-1,2],
];
// 每小节贝斯根音
const BASS_ROOT = [0,-5,-3,-7, 0,-5,-3,-5];
// 主旋律 [音高,时值(16分音符为1)]，总长 128 格 = 8 小节，跳跃断奏
const MELODY_RAW = [
  // Bar1 (C)
  [12,2],[16,2],[19,2],[16,2],[21,2],[19,2],[16,2],[14,2],
  // Bar2 (G)
  [12,2],[16,2],[19,2],[23,2],[24,4],[23,2],[21,2],
  // Bar3 (Am)
  [21,2],[19,2],[16,2],[14,2],[12,2],[14,2],[16,2],[19,2],
  // Bar4 (F)
  [17,2],[16,2],[14,2],[12,2],[14,4],[12,4],
  // Bar5 (C) —— 扬起
  [12,2],[16,2],[19,2],[24,2],[26,2],[24,2],[19,2],[16,2],
  // Bar6 (G)
  [24,2],[23,2],[21,2],[19,2],[16,2],[19,2],[21,2],[23,2],
  // Bar7 (Am)
  [21,2],[24,2],[23,2],[21,2],[19,2],[16,2],[19,2],[21,2],
  // Bar8 (F→G) —— 导音收尾接回 C
  [17,2],[16,2],[14,2],[12,2],[14,2],[12,2],[11,2],[12,2],
];
// 展开成 128 格时间轴
const LEAD = (()=>{
  const arr = new Array(128).fill(null);
  let p = 0;
  for(const [semi,dur] of MELODY_RAW){ arr[p] = {semi,dur}; p += dur; }
  if(p !== 128) console.warn('[BGM] 旋律长度异常：', p);
  return arr;
})();

// ---------- 鼓组合成 ----------
function bgmKick(t){
  const o=ctx.createOscillator(), g=ctx.createGain();
  o.type='sine';
  o.frequency.setValueAtTime(150,t);
  o.frequency.exponentialRampToValueAtTime(48,t+0.11);
  g.gain.setValueAtTime(0.5,t);
  g.gain.exponentialRampToValueAtTime(0.001,t+0.17);
  o.connect(g); g.connect(menuBgm.gain);
  o.start(t); o.stop(t+0.19);
}
function bgmNoise(t,{freq=1800,vol=0.13,dur=0.12,type='highpass'}={}){
  const src=ctx.createBufferSource(); src.buffer=getNoise();
  const f=ctx.createBiquadFilter(); f.type=type; f.frequency.value=freq;
  const g=ctx.createGain();
  g.gain.setValueAtTime(vol,t);
  g.gain.exponentialRampToValueAtTime(0.001,t+dur);
  src.connect(f); f.connect(g); g.connect(menuBgm.gain);
  src.start(t); src.stop(t+dur+0.03);
}
// ---------- 贝斯（triangle，带切分的跳跃感）----------
function bgmBass(t,semi,lenSec){
  const o=ctx.createOscillator(), g=ctx.createGain();
  o.type='triangle'; o.frequency.value=midiFreq(semi-12);
  g.gain.setValueAtTime(0,t);
  g.gain.linearRampToValueAtTime(0.26,t+0.015);
  g.gain.setValueAtTime(0.26,t+lenSec*0.55);
  g.gain.exponentialRampToValueAtTime(0.001,t+lenSec*0.95);
  o.connect(g); g.connect(menuBgm.gain);
  o.start(t); o.stop(t+lenSec+0.05);
}
// ---------- 和弦垫（柔和三音，铺在旋律下面）----------
function bgmPad(t,notes,lenSec){
  for(const semi of notes){
    const o=ctx.createOscillator(), g=ctx.createGain();
    o.type='triangle'; o.frequency.value=midiFreq(semi);
    g.gain.setValueAtTime(0,t);
    g.gain.linearRampToValueAtTime(0.045,t+0.08);
    g.gain.setValueAtTime(0.045,t+lenSec*0.7);
    g.gain.exponentialRampToValueAtTime(0.001,t+lenSec);
    o.connect(g); g.connect(menuBgm.gain);
    o.start(t); o.stop(t+lenSec+0.05);
  }
}
// ---------- 主旋律（triangle 主音 + 轻方波垫底，明亮芯片音色）----------
function bgmLead(t,semi,lenSec){
  // 主音
  const o=ctx.createOscillator(), g=ctx.createGain();
  o.type='triangle'; o.frequency.value=midiFreq(semi+12);
  g.gain.setValueAtTime(0,t);
  g.gain.linearRampToValueAtTime(0.16,t+0.015);
  g.gain.exponentialRampToValueAtTime(0.001,t+lenSec*0.92);
  o.connect(g); g.connect(menuBgm.gain);
  o.start(t); o.stop(t+lenSec+0.05);
  // 方波低八度，增加 chiptune 厚度
  const o2=ctx.createOscillator(), g2=ctx.createGain();
  o2.type='square'; o2.frequency.value=midiFreq(semi);
  g2.gain.setValueAtTime(0,t);
  g2.gain.linearRampToValueAtTime(0.035,t+0.015);
  g2.gain.exponentialRampToValueAtTime(0.001,t+lenSec*0.9);
  o2.connect(g2); g2.connect(menuBgm.gain);
  o2.start(t); o2.stop(t+lenSec+0.05);
}

// 启动菜单 BGM
export function startMenuBgm(){
  if(!ctx) ensureCtx();
  if(menuBgm.playing) return;
  if(ctx.state==='suspended') ctx.resume();
  menuBgm.playing = true;
  if(!menuBgm.gain){
    menuBgm.gain = ctx.createGain();
    menuBgm.gain.connect(ctx.destination);
  }
  menuBgm.gain.gain.value = 0.12;   // ★ 恢复音量（stopMenuBgm 会设 0）
  const stepSec = 60 / BGM_BPM / 4;   // 16 分音符时长
  let step = 0;
  const tick = ()=>{
    if(!menuBgm.playing) return;
    const t = ctx.currentTime + 0.03;
    const bar = Math.floor(step/16) % 8;
    const inBar = step % 16;

    // 主旋律
    const note = LEAD[step];
    if(note) bgmLead(t, note.semi, note.dur*stepSec);
    // 和弦垫：每小节开头换一次
    if(inBar === 0) bgmPad(t, CHORDS[bar], 16*stepSec);
    // 贝斯：0 / 6 / 10 / 14 步，切分跳跃
    if(inBar === 0)      bgmBass(t, BASS_ROOT[bar], 5*stepSec);
    else if(inBar===6 || inBar===10 || inBar===14) bgmBass(t, BASS_ROOT[bar], 2*stepSec);
    // 底鼓：四拍踩满（4-on-the-floor）
    if(inBar===0 || inBar===4 || inBar===8 || inBar===12) bgmKick(t);
    // 军鼓：2、4 拍；最后一小节末尾加鼓花 fill
    if(inBar===4 || inBar===12) bgmNoise(t,{freq:1700,vol:0.14,dur:0.13});
    if(bar===7 && (inBar===13 || inBar===14)) bgmNoise(t,{freq:1700,vol:0.09,dur:0.08});
    if(bar===7 && inBar===15) bgmKick(t), bgmNoise(t,{freq:1700,vol:0.16,dur:0.14});
    // 踩镲：每个 8 分音符
    if(step % 2 === 0){
      const acc = (inBar===4 || inBar===12) ? 0.025 : 0.05;
      bgmNoise(t,{freq:7500,vol:acc,dur:0.045,type:'highpass'});
    }

    step = (step+1) % 128;
    menuBgm.timer = setTimeout(tick, stepSec*1000);
  };
  tick();
  console.log('%c[音频] 🎵 菜单 BGM 已启动（欢快芯片风 · BPM '+BGM_BPM+'）', 'color:#36d1ff');
}

// 停止菜单 BGM
export function stopMenuBgm(){
  if(!menuBgm.playing) return;
  menuBgm.playing = false;
  if(menuBgm.timer){ clearTimeout(menuBgm.timer); menuBgm.timer=null; }
  if(menuBgm.gain) menuBgm.gain.gain.value = 0;   // ★ 立即静音，已调度的尾音也听不到
}

// 设置菜单 BGM 音量（跟随全局音量）
export function setMenuBgmVolume(v){
  if(menuBgm.gain) menuBgm.gain.gain.value = Math.min(0.25, Math.max(0, v*0.18));
}
