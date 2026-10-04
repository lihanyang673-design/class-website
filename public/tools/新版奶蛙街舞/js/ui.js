// ============================================================
// ui.js —— 界面系统：存档 / 导航 / 商城 / 图鉴 / 成就 / 排行 / 设置 / 结算
//          + 玩家上传歌曲（自动生成谱面 → 存班级数据库 → 全班可玩）
// ============================================================
import { analyzeAudio } from './analyze.js?v=20261025';
import { Music, setSfxEnabled, sfxClick, sfxCoin, sfxMiss, ensureCtx, setMenuBgmVolume, setVoiceVolume } from './audio.js?v=20261091';
import { Game, pauseGame } from './game.js?v=20261091';

// ============================================================
// 存档（localStorage）
// ============================================================
const KEY='naiwa_dance_save_v1';
const DEFAULTS={
  playerId:'',             // 玩家唯一编号（首次进入自动生成，用于收发兑换码）
  coins:350,               // 每位新玩家初始奶币
  usedCodes:[],            // 已兑换的码（存签名段，防同一码重复用）
  owned:['classic'], equipped:'classic',
  stats:{plays:0,bestScore:0,bestRel:0,maxCombo:0,totalPerfect:0,totalCoins:0,bestAcc:0,fullCombos:0,ssCount:0},
  ach:{},
  scores:{easy:[],casual:[],normal:[],hard:[],endless:[]},
  set:{vol:0.8,sfx:1,offset:0,bpm:104,speed:1,quality:1},
};
export const Store={
  data:null,
  load(){
    try{ this.data={...structuredClone(DEFAULTS), ...(JSON.parse(localStorage.getItem(KEY))||{})}; }
    catch{ this.data=structuredClone(DEFAULTS); }
    // 深合并子对象
    this.data.stats={...DEFAULTS.stats,...(this.data.stats||{})};
    this.data.set={...DEFAULTS.set,...(this.data.set||{})};
    this.data.scores={...DEFAULTS.scores,...(this.data.scores||{})};
    // 迁移：删除旧版/残缺排行记录（无相对分或无判定明细，口径不公平）
    let purged=false;
    for(const d of Object.keys(this.data.scores)){
      const before=this.data.scores[d].length;
      // 无尽记录没有相对分（按绝对分记），迁移口径单独处理
      this.data.scores[d]=d==='endless'
        ? this.data.scores[d].filter(r=>typeof r.score==='number'&&typeof r.p==='number')
        : this.data.scores[d].filter(r=>typeof r.rel==='number'&&typeof r.p==='number');
      if(this.data.scores[d].length!==before) purged=true;
    }
    if(purged) this.save();
    this.data.usedCodes=this.data.usedCodes||[];
    // 首次进入 / 老存档：自动分配玩家编号
    if(!this.data.playerId && window.NaiCode){
      this.data.playerId=window.NaiCode.genPlayerId();
      this.save();
    }
    return this.data;
  },
  save(){ localStorage.setItem(KEY, JSON.stringify(this.data)); },
  reset(){
    localStorage.removeItem(KEY); this.load();
  },
};
Store.load();

// ============================================================
// 数据表：涂装 / 舞池 / 难度 / 图鉴 / 成就
// ============================================================
export const SKINS=[
  // ===== 免费 =====
  {id:'classic', name:'经典奶黄', desc:'出厂原味，奶香四溢', price:0,
   colors:{head:0xffffff,belly:0xffffff}},
  // ===== 50 奶币：入门水果 =====
  {id:'lemon',   name:'柠檬奶酸', desc:'酸到皱眉，提神醒脑', price:50,
   colors:{head:0xfff59e,belly:0xffe04a}},
  {id:'mint',    name:'薄荷奶凉', desc:'清清凉凉，夏日必备', price:50,
   colors:{head:0xc8f0dc,belly:0x8ee6c0}},
  {id:'sky',     name:'天空奶蓝', desc:'蓝天白云，心情舒畅', price:80,
   colors:{head:0xd6f0ff,belly:0x9dd8f5}},
  {id:'peach',   name:'蜜桃奶粉', desc:'粉嘟嘟，水嫩嫩', price:80,
   colors:{head:0xffd6cc,belly:0xffb3a0}},
  // ===== 150 奶币：常见水果 =====
  {id:'strawberry', name:'草莓奶红', desc:'红彤彤，甜丝丝，头上一点绿', price:150,
   colors:{head:0xff7a8a,belly:0xff4d6a}},
  {id:'apple',   name:'苹果奶脆', desc:'一天一苹果，奶娃远离我', price:150,
   colors:{head:0xff6b6b,belly:0xe84444}},
  {id:'orange',  name:'橙子奶VC', desc:'满满维C，活力满满', price:150,
   colors:{head:0xffc07a,belly:0xff9a3d}},
  {id:'banana',  name:'香蕉奶黄', desc:'弯弯的，甜甜的', price:150,
   colors:{head:0xfff08a,belly:0xffd93d}},
  // ===== 300 奶币：特色饮品 =====
  {id:'matcha',  name:'抹茶奶绿', desc:'微苦回甘，纯狱系奶娃', price:300,
   colors:{head:0xbfe8c0,belly:0x93d19a}},
  {id:'berry',   name:'草莓奶昔', desc:'粉粉嫩嫩，甜度拉满', price:300,
   colors:{head:0xffc2d4,belly:0xff9bbd}},
  {id:'milktea', name:'奶茶奶棕', desc:'珍珠奶茶，续命神器', price:300,
   colors:{head:0xd9b896,belly:0xb8895a}},
  {id:'ocean',   name:'海盐奶蓝', desc:'清爽冰凉，海洋之心', price:300,
   colors:{head:0xbfe6ff,belly:0x7fc9f2}},
  // ===== 400 奶币：深色系 =====
  {id:'choco',   name:'巧克力奶', desc:'浓郁丝滑，热量爆炸', price:400,
   colors:{head:0xb98a63,belly:0x8f6543}},
  {id:'grape',   name:'葡萄奶紫', desc:'一串葡萄，酸中带甜', price:400,
   colors:{head:0xc9a0e8,belly:0x9b59d0}},
  {id:'blueberry',name:'蓝莓奶靛', desc:'小小一颗，花青素爆表', price:400,
   colors:{head:0x7a8cd6,belly:0x4a5fb8}},
  {id:'cherry',  name:'樱桃奶红', desc:'两颗樱桃，鸿运当头', price:400,
   colors:{head:0xff5a7a,belly:0xd92d50}},
  // ===== 500 奶币：创意食物 =====
  {id:'watermelon',name:'西瓜奶皮', desc:'绿皮红瓤，夏天的味道', price:500,
   colors:{head:0x6fcf5c,belly:0xff5c6f}},
  {id:'tomato',  name:'西红柿奶酸', desc:'糖拌西红柿，童年回忆', price:500,
   colors:{head:0xff7a5c,belly:0xe8442a}},
  {id:'taro',    name:'紫薯奶芋', desc:'香芋本芋，奶紫奶紫的', price:500,
   colors:{head:0xd9c2f2,belly:0xb99ae6}},
  {id:'coconut', name:'椰子奶香', desc:'海南风味，椰奶飘香', price:500,
   colors:{head:0xf0e6d0,belly:0x8b6f47}},
  // ===== 600-800 奶币：特殊质感 =====
  {id:'caramel', name:'焦糖奶棕', desc:'焦香四溢，甜而不腻', price:600,
   colors:{head:0xd9a066,belly:0xa86a2a}},
  {id:'honey',   name:'蜂蜜奶金', desc:'纯天然，甜到心化', price:600,
   colors:{head:0xffd966,belly:0xe8a820}, glow:0xffaa00},
  {id:'gold',    name:'黑金奶霸', desc:'全场最贵，气场上分', price:666,
   colors:{head:0x3a3a3a,belly:0x1f1f1f}, glow:0xffd257},
  // ===== 1000+ 奶币：传说级 =====
  {id:'neon',    name:'霓虹奶龙', desc:'赛博奶味，夜店之光', price:1000,
   colors:{head:0x36d1ff,belly:0xff3b6b}, glow:0x7a4dff},
  {id:'rainbow', name:'彩虹奶糖', desc:'七彩斑斓，幸运加成', price:1500,
   colors:{head:0xff9a9a,belly:0x9a9aff}, glow:0xff66cc},
  {id:'galaxy',  name:'星河奶宙', desc:'把银河穿在身上', price:2000,
   colors:{head:0x4a3a8a,belly:0x1a1a4a}, glow:0x6644ff},
];

export const THEMES=[
  {id:'street', name:'街头篮球场', desc:'水泥地 + 涂鸦墙，最原始的街舞味',
   bg:0x1c1030, fog:[10,34], floor:0x2a1745, ring:0xff3b6b, c1:0xff3b6b, c2:0x36d1ff,
   lampA:1, lampB:1, sky:'city'},
  {id:'club',   name:'霓虹夜店', desc:'镭射灯球摇起来，蹦就完了',
   bg:0x0d0620, fog:[9,30], floor:0x1d0f38, ring:0xffe17a, c1:0xff2bd6, c2:0x2bfff6,
   lampA:1, lampB:1, sky:'city'},
  {id:'roof',   name:'天台日落', desc:'城市之巅，晚霞当背景板',
   bg:0x3a1636, fog:[12,38], floor:0x4a2440, ring:0xffa751, c1:0xff8a5c, c2:0xffe17a,
   lampA:1, lampB:0.7, sky:'sunset'},
  {id:'space',  name:'太空蹦迪', desc:'失重节拍，银河打碟',
   bg:0x050514, fog:[14,44], floor:0x101028, ring:0x7a4dff, c1:0x7a4dff, c2:0x36ffc2,
   lampA:1, lampB:1, sky:'stars'},
];

// 歌曲库：只保留真实存在的内置曲 music.mp3。
// （扒站时 songs/ 目录下的其他音频没有拿到，条目全是点了没声的死链，已按用户要求删除；
//   想听别的歌，用「上传歌曲」把音频连自动谱面一起存进班级曲库即可）
// stars = 难度星级（离线按「音符密度+双押/连续双押」评好直接写死，用户端不再计算）
export const SONGS=[
  {id:'default', name:'默认曲目', artist:'内置BGM', file:'music.mp3', bpm:104, desc:'游戏自带的节奏曲', cat:'builtin', stars:2},
  {id:'u14', name:'小半', artist:'陈粒', file:'1790904961734_529237489.mp3', bpm:165, desc:'165 BPM · 约5分钟', cat:'builtin', staticChart:true, stars:5},
  {id:'u15', name:'玻璃', artist:'Gareth.T', file:'1790905313361_805251406.mp3', bpm:146, desc:'146 BPM · 约3分钟', cat:'builtin', staticChart:true, stars:3},
  {id:'u16', name:'晴天', artist:'周杰伦', file:'1790905913537_81414028.mp3', bpm:137, desc:'137 BPM · 约4.5分钟', cat:'builtin', staticChart:true, stars:4},
  {id:'u17', name:'甲乙丙丁', artist:'李佳薇', file:'1790906408562_96433968.mp3', bpm:130, desc:'130 BPM · 约3.5分钟', cat:'builtin', staticChart:true, stars:3},
  {id:'u18', name:'雨天', artist:'孙燕姿', file:'1790921439546_533325666.mp3', bpm:114, desc:'114 BPM · 约4分钟', cat:'builtin', staticChart:true, stars:2},
  {id:'u19', name:'一见如故', artist:'同学上传', file:'1790930389175_193904487.mp3', bpm:118, desc:'118 BPM · 约4.5分钟', cat:'builtin', staticChart:true, stars:3},
  {id:'u20', name:'女骑士', artist:'徐良', file:'1790935598626_920508153.mp3', bpm:110, desc:'110 BPM · 约4分钟', cat:'builtin', staticChart:true, stars:2},
  {id:'u21', name:'河山大好', artist:'许嵩', file:'1790937139158_104059326.mp3', bpm:175, desc:'175 BPM · 约3.5分钟', cat:'builtin', staticChart:true, stars:5},
  {id:'u22', name:'渲染离别', artist:'许嵩', file:'1790940036039_422108884.mp3', bpm:120, desc:'120 BPM · 约4.5分钟', cat:'builtin', staticChart:true, stars:2},
  {id:'u23', name:'那时雨', artist:'徐良', file:'1790997804951_1054170.mp3', bpm:119, desc:'119 BPM · 约3.5分钟', cat:'builtin', staticChart:true, stars:2},
  {id:'u24', name:'下完这场雨', artist:'后弦', file:'1790997815955_933366348.mp3', bpm:146, desc:'146 BPM · 约4.5分钟', cat:'builtin', staticChart:true, stars:4},
  {id:'u25', name:'玫瑰花的葬礼', artist:'许嵩', file:'1790997826227_330567208.mp3', bpm:164, desc:'164 BPM · 约4.3分钟', cat:'builtin', staticChart:true, stars:4},
  {id:'u26', name:'画风', artist:'后弦', file:'1790997851988_318725934.mp3', bpm:146, desc:'146 BPM · 约4.1分钟', cat:'builtin', staticChart:true, stars:4},
  {id:'u30', name:'出雨林记', artist:'许嵩', file:'1791030610756_931040190.mp3', bpm:134, desc:'134 BPM · 约4.6分钟', cat:'builtin', staticChart:true, stars:3},
  {id:'u31', name:'有何不可', artist:'许嵩', file:'1791030705432_931125239.mp3', bpm:101, desc:'101 BPM · 约4分钟', cat:'builtin', staticChart:true, stars:1},
  {id:'u32', name:'幻听', artist:'许嵩', file:'1791086294114_816942499.mp3', bpm:118, desc:'118 BPM · 约4.5分钟', cat:'builtin', staticChart:true, stars:2},
  {id:'u33', name:'温泉', artist:'许嵩', file:'1791086359450_54004606.mp3', bpm:96, desc:'96 BPM · 约4.7分钟', cat:'builtin', staticChart:true, stars:1},
  {id:'u34', name:'卡农', artist:'帕赫贝尔', file:'1791091543262_943294308.mp3', bpm:120, desc:'120 BPM · 约4.8分钟', cat:'builtin', staticChart:true, stars:3},
  {id:'u35', name:'青石巷', artist:'魏琮霏', file:'1791092175093_984330658.mp3', bpm:173, desc:'173 BPM · 约2分钟', cat:'builtin', staticChart:true, stars:5},
  {id:'u36', name:'Love Story', artist:'Taylor Swift', file:'1791092496030_452131566.mp3', bpm:119, desc:'119 BPM · 约4分钟', cat:'builtin', staticChart:true, stars:3},
  {id:'u37', name:'九九八十一', artist:'乐正绫', file:'1791092773223_119670223.mp3', bpm:149, desc:'149 BPM · 约4.7分钟', cat:'builtin', staticChart:true, stars:4},
  {id:'u38', name:'忘情牛肉面', artist:'马健涛', file:'1791099498004_292032976.mp3', bpm:130, desc:'130 BPM · 约3分钟', cat:'builtin', staticChart:true, stars:4},
];

// 歌曲分类（渲染时每组带小标题；空的分组会自动跳过）
export const SONG_CATS=[
  {id:'builtin', name:'🎮 内置',   tip:'游戏自带'},
  {id:'user',    name:'⭐ 班级自制', tip:'同学上传 · 自动谱面'},
];

// 难度星级分组（歌曲列表按星数分区，空的分组自动跳过；星数离线评好写在每首歌的 stars 字段）
export const STAR_TIERS=[
  {stars:1, name:'⭐ 1 星 · 入门',    tip:'节奏缓慢 · 随手就能跟'},
  {stars:2, name:'⭐⭐ 2 星 · 轻松',  tip:'双押很少 · 喘得过来'},
  {stars:3, name:'⭐⭐⭐ 3 星 · 适中', tip:'半拍节奏 · 偶有双押'},
  {stars:4, name:'⭐⭐⭐⭐ 4 星 · 困难', tip:'高速节拍 · 双押频发'},
  {stars:5, name:'⭐⭐⭐⭐⭐ 5 星 · 地狱', tip:'极限密度 · 连续双押'},
];

// 静态版预置谱面（从 charts.json 加载）
export const STATIC_CHARTS={ loaded:false, map:{} };
export async function loadStaticCharts(){
  if(STATIC_CHARTS.loaded) return;
  try{
    const r=await fetch('charts.json?v=20261091');
    if(!r.ok) throw new Error('HTTP '+r.status);
    const data=await r.json();
    STATIC_CHARTS.map=data;
    STATIC_CHARTS.loaded=true;
  }catch(e){
    console.warn('[静态谱面] 加载失败，这些歌会退回程序生成谱面', e);
    STATIC_CHARTS.loaded=true;
  }
}

// ============================================================
// 玩家上传歌曲（存班级网站数据库，全班共享）
// ============================================================
export const USER_SONGS={ list:[], loaded:false, loadError:false };
// 临时歌曲（网页版专用）：选本地文件→浏览器分析→直接玩
// 音频 Blob 存 IndexedDB，元数据存 localStorage，刷新页面后仍可恢复
export const TEMP_SONGS=[];
let myIdentity=null;   // /api/me：{id, isAdmin}，用于判断能否删除
let serverOn=false;    // 是否连着班级服务器（静态版为 false → 上传走临时模式，在线排行不可用）

// ===== 本地持久化：IndexedDB 存音频 Blob，localStorage 存元数据 =====
const TEMP_DB='naiwa_dance_local';     // IndexedDB 数据库名
const TEMP_STORE='songs';              // objectStore 名
const TEMP_META_KEY='naiwa_dance_tempsongs_v1';  // localStorage 元数据 key
// 打开/初始化 IndexedDB（异步单例 Promise）
let _dbP=null;
function openDB(){
  if(_dbP) return _dbP;
  _dbP=new Promise((res,rej)=>{
    const req=indexedDB.open(TEMP_DB,1);
    req.onupgradeneeded=()=>{
      const db=req.result;
      if(!db.objectStoreNames.contains(TEMP_STORE)) db.createObjectStore(TEMP_STORE,{keyPath:'id'});
    };
    req.onsuccess=()=>res(req.result);
    req.onerror=()=>rej(req.error);
  });
  return _dbP;
}
// 存一条音频 Blob
async function putTempBlob(id,blob){
  const db=await openDB();
  return new Promise((res,rej)=>{
    const tx=db.transaction(TEMP_STORE,'readwrite');
    tx.objectStore(TEMP_STORE).put({id,blob,mime:blob.type||'audio/mpeg'});
    tx.oncomplete=()=>res();
    tx.onerror=()=>rej(tx.error);
  });
}
// 取一条音频 Blob
async function getTempBlob(id){
  const db=await openDB();
  return new Promise((res,rej)=>{
    const tx=db.transaction(TEMP_STORE,'readonly');
    const req=tx.objectStore(TEMP_STORE).get(id);
    req.onsuccess=()=>res(req.result?req.result.blob:null);
    req.onerror=()=>rej(req.error);
  });
}
// 删一条音频 Blob
async function delTempBlob(id){
  const db=await openDB();
  return new Promise((res,rej)=>{
    const tx=db.transaction(TEMP_STORE,'readwrite');
    tx.objectStore(TEMP_STORE).delete(id);
    tx.oncomplete=()=>res();
    tx.onerror=()=>rej(tx.error);
  });
}
// 元数据存/取/删（localStorage）
function saveTempMeta(list){
  try{ localStorage.setItem(TEMP_META_KEY, JSON.stringify(list.map(s=>({
    id:s.id, name:s.name, artist:s.artist, bpm:s.bpm, duration:s.duration,
    desc:s.desc, chart:s.chart, stars:s.stars, createdAt:s.createdAt||Date.now(),
  })))); }catch(e){ console.warn('[临时歌曲] 元数据保存失败', e); }
}
function loadTempMeta(){
  try{ return JSON.parse(localStorage.getItem(TEMP_META_KEY))||[]; }catch{ return []; }
}
// 从 IndexedDB + localStorage 恢复临时歌曲（页面加载时调用）
async function loadTempSongs(){
  const metas=loadTempMeta();
  if(!metas.length) return;
  const ok=[];
  for(const m of metas){
    try{
      const blob=await getTempBlob(m.id);
      if(!blob) continue;   // Blob 丢了（被清了）就跳过这首
      const url=URL.createObjectURL(blob);
      ok.push({
        id:m.id, name:m.name, artist:m.artist, bpm:m.bpm, duration:m.duration,
        desc:m.desc, chart:m.chart, stars:m.stars||3,
        file:url, cat:'user', user:true, temp:true, createdAt:m.createdAt,
      });
    }catch(e){ console.warn('[临时歌曲] 恢复失败', m.id, e); }
  }
  // 把恢复失败的（Blob 丢了的）从元数据里清掉，避免越积越多
  if(ok.length!==metas.length) saveTempMeta(ok);
  TEMP_SONGS.push(...ok);
  console.log('%c[临时歌曲] 已恢复 '+ok.length+' 首', 'color:#36d1ff;font-weight:bold');
}

function fmtDur(s){
  s=Math.round(s||0);
  return Math.floor(s/60)+':'+String(s%60).padStart(2,'0');
}

export async function refreshUserSongs(){
  try{
    const r=await fetch('/api/dance/songs', {credentials:'same-origin'});
    if(!r.ok) throw new Error('HTTP '+r.status);
    const rows=await r.json();
    USER_SONGS.list=rows.map(row=>({
      id:'u'+row.id, dbId:row.id,
      name:row.title, artist:(row.uploader_name||'同学')+' 上传',
      file:row.audio, bpm:row.bpm||100,
      desc:`${row.note_count||0} 音符 · ${fmtDur(row.duration)}`,
      cat:'user', user:true, uploaderId:row.uploader_id,
      duration:row.duration||0, noteCount:row.note_count||0,
      // 星级沿用离线评好的写死值；以后新上传的歌默认 3 星，待我评完再补
      stars:SONGS.find(s=>s.id==='u'+row.id)?.stars||3,
    }));
    USER_SONGS.loaded=true; USER_SONGS.loadError=false;
    serverOn=true;
  }catch(e){
    USER_SONGS.loadError=true;
    serverOn=false;
    console.warn('[曲库] 玩家歌曲列表加载失败（未登录/离线也能玩内置曲）', e);
  }
  // 顺带拿一次身份（判断能否删歌）；失败不影响游戏
  try{
    const r2=await fetch('/api/me', {credentials:'same-origin'});
    const me=await r2.json();
    // isAdmin = 本次会话已开启管理员模式（/api/admin/apply 密码认证，与全站一致）
    myIdentity = me && me.id ? { id:me.id, isAdmin:!!me.admin_mode, name:me.nickname||me.username||('用户'+me.id) } : null;
    updateAdminAuthUI();
  }catch(e){ myIdentity=null; updateAdminAuthUI(); }
}

// 按 id 找歌（临时 + 内置 + 玩家上传），main.js 用
export function getSongById(id){
  return TEMP_SONGS.find(s=>s.id===id)
    || USER_SONGS.list.find(s=>s.id===id)
    || SONGS.find(s=>s.id===id);
}
// 拉取玩家歌曲的谱面（选歌后缓存到歌曲对象上）
export async function ensureChart(song){
  if(!song) return null;
  if(song.chart) return song.chart;
  if(song.staticChart){
    await loadStaticCharts();
    const dbId=song.id.replace(/^u/,'');
    song.chart=STATIC_CHARTS.map[dbId]||null;
    return song.chart;
  }
  if(!song.user) return null;
  const r=await fetch(`/api/dance/songs/${song.dbId}/chart`, {credentials:'same-origin'});
  if(!r.ok) throw new Error('谱面加载失败');
  song.chart=await r.json();
  return song.chart;
}

// 星级已离线评好直接写在 SONGS 里（stars 字段），用户端不再做任何难度计算。

// 一键更新曲谱：把原音频重新下载，用当前最新算法分析，覆盖服务器上的旧谱。
// 全程在浏览器完成，音频不换，只是谱面/BPM换成新版本 —— 省去删歌重传。
async function regenerateSong(ev,song){
  ev.stopPropagation();
  ensureCtx(); sfxClick();
  const yes=await askConfirm(
    `要用最新算法重新生成《${song.name}》的曲谱吗？音频不变，只需等十几秒分析，不用重新上传。`,
    {yesText:'开始更新'});
  if(!yes) return;
  try{
    toast('⏳ 正在读取原音频…');
    const r=await fetch(song.file, {credentials:'same-origin'});
    if(!r.ok) throw new Error('音频读取失败');
    const blob=await r.blob();
    const file=new File([blob], song.name+'.mp3', {type:blob.type||'audio/mpeg'});
    toast('⏳ 正在用新算法重新分析（约十几秒）…');
    const res=await analyzeAudio(file,()=>{});
    const pr=await fetch(`/api/dance/songs/${song.dbId}/regenerate`,{
      method:'POST', headers:{'Content-Type':'application/json'}, credentials:'same-origin',
      body:JSON.stringify({ chart:JSON.stringify(res.notes), bpm:res.bpm, duration:res.duration }),
    });
    const data=await pr.json().catch(()=>({}));
    if(!pr.ok) throw new Error(data.error||'更新失败');
    toast(`✅ 《${song.name}》曲谱已更新：${data.note_count} 音符 · BPM ${data.bpm}`);
    sfxCoin();
    await refreshUserSongs();
    renderPlay();
  }catch(e){
    toast('❌ '+(e.message||'更新失败'));
    sfxMiss();
  }
}

// 选中歌曲即后台预载：音频文件提前拉到本地、玩家歌曲的谱面 JSON 提前取回，
// 这样点"开始表演"时无需等待网络，也避免演出中途加载造成的卡顿
function preloadSong(song){
  try{ Music.setSong(song.file); }catch{}
  if(song.user) ensureChart(song).catch(()=>{});
}

// ============================================================
// 歌曲试听（选歌页）：点 🔊 开始；再点同一个 = 暂停/继续；点别的 = 直接切过去
// 全程复用游戏那唯一的 <audio> 元素 → 物理上不可能两首歌同时响
// ============================================================
let previewSong=null;     // 正在试听的歌曲对象（null = 没有任何试听）
let previewPaused=false;  // 当前试听是否处于手动暂停态

// 刷新所有试听小按钮的图标（不重建卡片，列表滚动位置不变）
function refreshPreviewIcons(){
  document.querySelectorAll('.song-preview').forEach(el=>{
    const s=el._song;
    if(s===previewSong && !previewPaused){ el.textContent='暂停'; el.classList.add('playing'); el.title='暂停试听'; }
    else if(s===previewSong && previewPaused){ el.textContent='继续'; el.classList.remove('playing'); el.title='继续试听'; }
    else{ el.textContent='试听'; el.classList.remove('playing'); el.title='试听这首歌'; }
  });
}

// 试听按钮的总入口：同一首 = 暂停/继续；不同首 = 停旧的、播新的
async function togglePreview(song){
  ensureCtx();
  if(previewSong===song){
    if(previewPaused){
      const ok=await Music.play();          // 从暂停位置继续
      if(ok) previewPaused=false;
    }else{
      Music.pause();                        // 暂停但保留进度
      previewPaused=true;
    }
    refreshPreviewIcons();
    return;
  }
  // 切歌：同一个 audio 元素换 src，旧歌立刻停（不会叠播）
  previewSong=null; previewPaused=false;
  Music.setSong(song.file);
  previewSong=song;
  Music.el.onended=()=>{                    // 自然播完：复位成 🔊
    previewSong=null; previewPaused=false;
    Music.el.onended=null;
    refreshPreviewIcons();
  };
  const ok=await Music.play();
  if(!ok){                                  // 极少数浏览器拦截：提示重点一次
    previewSong=null; Music.el.onended=null;
    toast('试听没启动，请再点一次 🔊');
  }
  refreshPreviewIcons();
}

// 完全停止试听（离开选歌页 / 开始演出时调用）：暂停 + 进度归零 + 清回调
export function stopPreview(){
  if(previewSong){
    Music.pause();
    try{ if(Music.el.readyState>=2) Music.el.currentTime=0; }catch{}
  }
  previewSong=null; previewPaused=false;
  Music.el.onended=null;
  refreshPreviewIcons();
}

// 能否删除某首玩家歌曲（上传者本人或管理员）
function canDelete(song){
  if(song.temp) return true;           // 临时歌：随时可本地移除
  if(!song.user || !myIdentity) return false;
  return myIdentity.isAdmin || song.uploaderId===myIdentity.id;
}

export const DIFFS=[
  {id:'easy',  name:'😌 热身', desc:'每拍一箭 · 轻松上手'},
  {id:'casual',name:'🙂 进阶', desc:'一两个一拍 · 初识双押'},
  {id:'normal',name:'🔥 狂热', desc:'半拍为主 · 更多喘息'},
  {id:'hard',  name:'💀 地狱', desc:'连续半拍 · 偶有双押'},
  {id:'endless',name:'♾ 无尽', desc:'计分从0开始 · 循环加速 · ❤×10'},
];

const CODEX=[
  {ic:'⬅️', key:'← 左键', name:'左勾鞭手', desc:'左手大回环甩出去，鞭出残影，古典 Breaking 起手式。Perfect 时会甩得更狠。'},
  {ic:'⬇️', key:'↓ 下键', name:'扫堂双踢', desc:'双腿交替前踢 + 下蹲闪避，落地带弹性回弹，奶娃牌地板动作。'},
  {ic:'⬆️', key:'↑ 上键', name:'扭肚抬头', desc:'肚子魔性左右一扭，脑袋高高抬起——不信你只看一遍。'},
  {ic:'➡️', key:'→ 右键', name:'大回旋 360°', desc:'整个奶娃原地转一整圈，附带挤压变形，街舞招牌杀招。'},
];

const ACHS=[
  // ===== 演出次数 =====
  {id:'first', ic:'🕺', name:'初次登台', desc:'完成第一场演出', goal:1, get:s=>s.stats.plays},
  {id:'p10',   ic:'🎪', name:'舞池常客', desc:'累计完成 10 场演出', goal:10, get:s=>s.stats.plays},
  {id:'p30',   ic:'🎭', name:'舞台老手', desc:'累计完成 30 场演出', goal:30, get:s=>s.stats.plays},
  {id:'p50',   ic:'🎤', name:'驻唱歌手', desc:'累计完成 50 场演出', goal:50, get:s=>s.stats.plays},
  {id:'p100',  ic:'👑', name:'百场舞王', desc:'累计完成 100 场演出', goal:100, get:s=>s.stats.plays},
  // ===== 连击 =====
  {id:'c10',   ic:'🔥', name:'小试牛刀', desc:'单场连击达到 10', goal:10, get:s=>s.stats.maxCombo},
  {id:'c30',   ic:'⚡', name:'连击新秀', desc:'单场连击达到 30', goal:30, get:s=>s.stats.maxCombo},
  {id:'c50',   ic:'💫', name:'连击达人', desc:'单场连击达到 50', goal:50, get:s=>s.stats.maxCombo},
  {id:'c80',   ic:'🌟', name:'连击狂人', desc:'单场连击达到 80', goal:80, get:s=>s.stats.maxCombo},
  {id:'c100',  ic:'💥', name:'百连不破', desc:'单场连击达到 100', goal:100, get:s=>s.stats.maxCombo},
  {id:'c200',  ic:'🌪️', name:'连击之神', desc:'单场连击达到 200', goal:200, get:s=>s.stats.maxCombo},
  // ===== 得分 =====
  {id:'s10k',  ic:'💯', name:'万元户', desc:'单场得分达到 10,000', goal:10000, get:s=>s.stats.bestScore},
  {id:'s30k',  ic:'💰', name:'三万俱乐部', desc:'单场得分达到 30,000', goal:30000, get:s=>s.stats.bestScore},
  {id:'s50k',  ic:'🏆', name:'五万分俱乐部', desc:'单场得分达到 50,000', goal:50000, get:s=>s.stats.bestScore},
  {id:'s100k', ic:'💎', name:'十万大舞', desc:'单场得分达到 100,000', goal:100000, get:s=>s.stats.bestScore},
  {id:'s200k', ic:'🚀', name:'二十万传奇', desc:'单场得分达到 200,000', goal:200000, get:s=>s.stats.bestScore},
  // ===== PERFECT =====
  {id:'pf50',  ic:'🎯', name:'准度初成', desc:'累计 50 次 PERFECT', goal:50, get:s=>s.stats.totalPerfect},
  {id:'pf100', ic:'🎯', name:'完美主义', desc:'累计 100 次 PERFECT', goal:100, get:s=>s.stats.totalPerfect},
  {id:'pf300', ic:'🎯', name:'完美大师', desc:'累计 300 次 PERFECT', goal:300, get:s=>s.stats.totalPerfect},
  {id:'pf500', ic:'🎯', name:'完美传说', desc:'累计 500 次 PERFECT', goal:500, get:s=>s.stats.totalPerfect},
  {id:'pf1000',ic:'🎯', name:'完美之神', desc:'累计 1000 次 PERFECT', goal:1000, get:s=>s.stats.totalPerfect},
  // ===== 涂装 =====
  {id:'buy1',  ic:'🛍️', name:'氪金第一步', desc:'购买第一套涂装', goal:1, get:s=>s.owned.length-1},
  {id:'own4',  ic:'👕', name:'时尚奶娃', desc:'拥有 4 套涂装', goal:4, get:s=>s.owned.length},
  {id:'own8',  ic:'👔', name:'衣帽间', desc:'拥有 8 套涂装', goal:8, get:s=>s.owned.length},
  {id:'own15', ic:'🧥', name:'穿搭博主', desc:'拥有 15 套涂装', goal:15, get:s=>s.owned.length},
  {id:'ownall',ic:'👑', name:'涂装收藏家', desc:'拥有全部涂装', goal:26, get:s=>s.owned.length},
  // ===== 评级 & 全连 =====
  {id:'fc1',   ic:'✨', name:'零失误', desc:'完成一次全连（无 Miss）', goal:1, get:s=>s.stats.fullCombos},
  {id:'fc5',   ic:'✨', name:'稳定输出', desc:'累计 5 次全连', goal:5, get:s=>s.stats.fullCombos},
  {id:'ss1',   ic:'🏅', name:'初露锋芒', desc:'获得一次 SS 评级', goal:1, get:s=>s.stats.ssCount},
  {id:'ss5',   ic:'🥇', name:'SS 专业户', desc:'累计 5 次 SS 评级', goal:5, get:s=>s.stats.ssCount},
  // ===== 金币 =====
  {id:'coin1k',ic:'🪙', name:'小富婆', desc:'累计获得 1000 奶币', goal:1000, get:s=>s.stats.totalCoins},
  {id:'coin5k',ic:'🪙', name:'大富翁', desc:'累计获得 5000 奶币', goal:5000, get:s=>s.stats.totalCoins},
];

// ============================================================
// 界面初始化
// ============================================================
let sel={theme:'street', diff:'normal', song:'default'};
let playStep=1;   // 选曲页分步：1=舞池 2=歌曲 3=难度
let mainRef=null;   // main.js 注入 { startShow, switchTheme, applyQuality }

export function initUI(main){
  mainRef=main;
  const d=Store.data;

  // ---- 导航 ----
  document.querySelectorAll('[data-scr]').forEach(btn=>{
    btn.addEventListener('click',()=>{
      sfxClick();
      const id=btn.dataset.scr;
      if(id==='scr-play'){ playStep=1; renderPlay(); }
      if(id==='scr-shop') renderShop();
      if(id==='scr-codex') renderCodex();
      if(id==='scr-ach')  renderAch();
      if(id==='scr-rank') renderRank();
      if(id==='scr-board') renderBoard();
      if(id==='scr-endless') renderEndlessBoard();
      if(id==='scr-home') renderHome();
      if(id==='scr-set') updateAdminAuthUI();
      if(id!=='scr-play') stopPreview();   // 离开选歌页：试听必须停
      showScreen(id);
    });
  });
  document.getElementById('btnGoPlay').addEventListener('click',()=>{
    sfxClick(); playStep=1; renderPlay(); showScreen('scr-play');
  });

  // ---- 首页编号徽章：点击复制 ----
  document.getElementById('btnHomeCopyId').addEventListener('click',async ()=>{
    sfxClick();
    const id=Store.data.playerId;
    try{ await navigator.clipboard.writeText(id); }
    catch(e){
      const t=document.createElement('textarea'); t.value=id; document.body.appendChild(t);
      t.select(); document.execCommand('copy'); t.remove();
    }
    toast('📋 编号已复制：'+id+'，发给管理员领奶币');
  });

  // ---- 所有子页面的返回键（data-back）----
  document.querySelectorAll('[data-back]').forEach(btn=>{
    btn.addEventListener('click',()=>{ sfxClick(); showScreen('scr-home'); renderHome(); });
  });

  // ---- 设置控件 ----
  bindSettings();

  // ---- 玩家歌曲：上传弹窗 + 曲库拉取 ----
  bindUpload();
  // ---- 帮助页：公告 + 一键更新 ----
  const helpNotice=document.getElementById('helpNotice');
  if(helpNotice) helpNotice.addEventListener('click',()=>{ sfxClick(); mainRef.showNotice&&mainRef.showNotice(); });
  const helpUpdate=document.getElementById('helpUpdate');
  if(helpUpdate) helpUpdate.addEventListener('click',async ()=>{
    sfxClick();
    toast('🔄 正在清理缓存并刷新…');
    try{
      if('caches' in window){
        const CODE=/\.(html|js|css|json)(\?.*)?$/i;
        for(const name of await caches.keys()){
          const cache=await caches.open(name);
          for(const req of await cache.keys()){
            const p=new URL(req.url).pathname;
            if(CODE.test(p)) await cache.delete(req);
          }
        }
      }
    }catch(_){}
    const url=new URL(location.href);
    url.searchParams.set('_v', Date.now().toString(36));
    location.replace(url.toString());
  });
  // 恢复本地临时歌曲（IndexedDB 音频 + localStorage 元数据），不阻塞曲库加载
  loadTempSongs().then(()=>{
    if(document.getElementById('scr-play').classList.contains('cur')) renderPlay();
  });
  refreshUserSongs().then(()=>{
    // 列表到位后，如果用户已停在选歌页，立即补渲染
    if(document.getElementById('scr-play').classList.contains('cur')) renderPlay();
  });

  // ---- 结算按钮 ----
  document.getElementById('btnRetry').addEventListener('click',()=>{ sfxClick(); startShow(); });
  document.getElementById('btnBackHome').addEventListener('click',()=>{
    sfxClick(); showScreen('scr-home'); renderHome();
  });

  // ---- ★ 选曲页底部按钮：分步推进（我选好了 → 我选好了 → 开始表演）----
  document.getElementById('btnNextStep').addEventListener('click',()=>{
    sfxClick();
    if(playStep<3){ playStep++; renderPlay(); }
    else{ ensureCtx(); startShow(); }   // 第3步：开演
  });

  // ---- ★ 随机按钮：根据当前步骤随机选舞池/歌曲/难度 ----
  document.getElementById('btnRandom').addEventListener('click',()=>{
    sfxClick();
    if(playStep===1){
      const t=THEMES[Math.floor(Math.random()*THEMES.length)];
      sel.theme=t.id; mainRef.switchTheme(t.id);
    }else if(playStep===2){
      const all=serverOn
        ? [...TEMP_SONGS, ...USER_SONGS.list, SONGS.find(s=>s.id==='default')]
        : [...TEMP_SONGS, ...SONGS];
      const s=all[Math.floor(Math.random()*all.length)];
      sel.song=s.id; preloadSong(s);
    }else{
      const d=DIFFS[Math.floor(Math.random()*DIFFS.length)];
      sel.diff=d.id;
    }
    renderPlay();
  });

  // ---- ★ 选曲页返回按钮：第1步回主界面，第2/3步回上一步 ----
  const btnPlayBack=document.getElementById('btnPlayBack');
  if(btnPlayBack) btnPlayBack.addEventListener('click',()=>{
    sfxClick();
    if(playStep>1){ playStep--; renderPlay(); }
    else{ showScreen('scr-home'); renderHome(); }
  });

  // ---- 暂停按钮 ----
  document.getElementById('btnResume').addEventListener('click',()=>{ mainRef.resume(); document.getElementById('pauseOv').classList.remove('on'); });
  document.getElementById('btnRestart').addEventListener('click',async()=>{
    const yes=await askConfirm('确定重新开始吗？当前进度会清空');
    if(!yes) return;
    document.getElementById('pauseOv').classList.remove('on');
    mainRef.resume(); startShow();
  });
  document.getElementById('btnQuit').addEventListener('click',async()=>{
    const yes=await askConfirm('确定退出演出吗？');
    if(!yes) return;
    document.getElementById('pauseOv').classList.remove('on');
    mainRef.quitShow(); showScreen('scr-home'); renderHome();
  });
  // ---- ★ 舞台右上角暂停按钮（触屏用户也能暂停/退出）----
  document.getElementById('btnPause').addEventListener('click',()=>{
    const ov=document.getElementById('pauseOv');
    if(Game.paused){ mainRef.resume(); ov.classList.remove('on'); }
    else{ pauseGame(); ov.classList.add('on'); }
  });
  // ---- ★ 直接退出按钮：弹确认框防误触 ----
  document.getElementById('btnQuitDirect').addEventListener('click',async()=>{
    const yes=await askConfirm('确定退出演出吗？');
    if(!yes) return;
    document.getElementById('pauseOv').classList.remove('on');
    mainRef.quitShow(); showScreen('scr-home'); renderHome();
  });

  // ---- 排行 tab ----
  document.querySelectorAll('#rankTabs button').forEach(b=>{
    b.addEventListener('click',()=>{
      document.querySelectorAll('#rankTabs button').forEach(x=>x.classList.remove('cur'));
      b.classList.add('cur');
      renderRankList(b.dataset.d);
    });
  });

  applyVolume();
  updateAdminAuthUI();
  renderHome();
}

export function showScreen(id){
  document.querySelectorAll('.screen').forEach(s=>s.classList.toggle('cur', s.id===id));
  document.querySelectorAll('#mainNav button').forEach(b=>b.classList.toggle('cur', b.dataset.scr===id));
}
export function showUIRoot(on){
  document.getElementById('uiRoot').classList.toggle('on', on);
}
export function showStageUI(on){
  document.getElementById('stageUI').classList.toggle('on', on);
}

// ---------- 主界面 ----------
export function renderHome(){
  // GitHub 静态版：排行榜和无尽榜需要班级服务器，直接隐藏入口
  const isStatic = location.hostname.includes('github.io') || location.protocol==='file:';
  const bBoard=document.getElementById('homeBtnBoard');
  const bEndless=document.getElementById('homeBtnEndless');
  if(bBoard) bBoard.style.display = isStatic ? 'none' : '';
  if(bEndless) bEndless.style.display = isStatic ? 'none' : '';
  const s=Store.data.stats;
  document.getElementById('stPlays').textContent=s.plays;
  document.getElementById('stBest').textContent=(s.bestRel||0).toLocaleString();
  document.getElementById('stCombo').textContent=s.maxCombo;
  document.getElementById('stPerf').textContent=s.totalPerfect;
  document.getElementById('coinNum').textContent=Store.data.coins.toLocaleString();
  const hp=document.getElementById('homePlayerId');
  if(hp) hp.textContent=Store.data.playerId||'------';
  refreshPlayerId();
}

// ---------- 开跳页 ----------
async function renderPlay(){
  // ---- 步骤指示器 + 分区显隐 ----
  const stepTitles={1:'🎵 选择舞池 <small>DANCE FLOOR</small>',2:'🎵 选择歌曲 <small>SELECT SONG</small>',3:'🔥 选择难度 <small>DIFFICULTY</small>'};
  document.getElementById('playStepTitle').innerHTML=stepTitles[playStep];
  document.querySelectorAll('#stepIndicator .step').forEach(el=>{
    const s=+el.dataset.step;
    el.classList.toggle('active', s===playStep);
    el.classList.toggle('done', s<playStep);
  });
  document.getElementById('stepTheme').style.display = playStep===1?'':'none';
  document.getElementById('stepSong').style.display  = playStep===2?'':'none';
  document.getElementById('stepDiff').style.display  = playStep===3?'':'none';
  // 底部按钮：第3步显示「开始表演」，其余显示「我选好了」
  const nextBtn=document.getElementById('btnNextStep');
  nextBtn.textContent = playStep===3 ? '🚀 开始表演' : '我选好了';
  // 随机按钮文字随步骤变化
  const rndBtn=document.getElementById('btnRandom');
  if(rndBtn) rndBtn.textContent = playStep===1 ? '🎲 随机舞池' : playStep===2 ? '🎲 随机歌曲' : '🎲 随机难度';

  // 上传入口：有服务器→存班级曲库；网页版→临时歌曲（刷新就没）
  const upBtn=document.getElementById('btnUploadSong');
  if(upBtn) upBtn.style.display='none';   // 旧的小按钮隐藏，改用下方彩色卡片
  // 舞池
  const tg=document.getElementById('themeGrid');
  tg.innerHTML='';
  THEMES.forEach(t=>{
    const b=document.createElement('button');
    b.className='theme-card'+(sel.theme===t.id?' sel':'');
    b.style.background=`linear-gradient(135deg, #${t.c1.toString(16).padStart(6,'0')}cc, #${t.c2.toString(16).padStart(6,'0')}cc)`;
    b.innerHTML=`<div class="tname">${t.name}</div><div class="tdesc">${t.desc}</div>
      ${sel.theme===t.id?'<span class="tag">✓ 已选</span>':''}`;
    b.onclick=()=>{ sfxClick(); sel.theme=t.id; renderPlay(); mainRef.switchTheme(t.id); };
    tg.appendChild(b);
  });
  // 歌曲 —— 按难度星级分组（stars 离线评好写死，直接同步渲染，无需等待）
  const sg=document.getElementById('songGrid');
  if(sg){
    sg.innerHTML='';
    // 上传/临时歌曲卡片：放在所有星级分区的最上面，颜色醒目（暖黄渐变，和歌曲卡片区分）
    const upCard=document.createElement('button');
    upCard.className='theme-card song-upload-card';
    upCard.style.background='linear-gradient(135deg,#ff9a3ccc,#ffe17acc)';
    upCard.innerHTML=`<div class="tname" style="color:#3a1f00">${serverOn?'⬆️ 上传歌曲':'🎲 临时歌曲'}</div>
      <div class="tdesc" style="color:#5c3300">${serverOn?'上传本地音乐，自动生成谱面，全班可玩':'选一首本地音乐，自动保存到本地，下次打开还能玩'}</div>
      <span class="tag" style="background:#3a1f00;color:#ffe17a">${serverOn?'AUTO CHART':'TEMP CHART'}</span>`;
    upCard.onclick=()=>{ ensureCtx(); sfxClick(); document.getElementById('btnUploadSong').click(); };
    sg.appendChild(upCard);
    // 去重后的全部歌曲：连着服务器时数据库版与内置版是同一首，只留数据库版；默认曲目数据库没有，单独保留
    const allSongs=serverOn
      ? [...TEMP_SONGS, ...USER_SONGS.list, SONGS.find(s=>s.id==='default')]
      : [...TEMP_SONGS, ...SONGS];
    STAR_TIERS.forEach(tier=>{
      const list=allSongs.filter(s=>s.stars===tier.stars);
      if(!list.length) return;
      const head=document.createElement('div');
      head.className='song-cat-head';
      head.innerHTML=`<span class="sc-name">${tier.name}</span><span class="sc-tip">${tier.tip} · ${list.length} 首</span>`;
      sg.appendChild(head);
      // 该星级下的歌曲卡片
      list.forEach(s=>{
        const b=document.createElement('button');
        b.className='theme-card'+(sel.song===s.id?' sel':'');
        b.style.background=`linear-gradient(135deg, #7a4dffcc, #36d1ffcc)`;
        b.innerHTML=`<div class="tname">🎵 ${s.name}</div><div class="tdesc">${s.artist} · ${s.bpm}BPM<br>${s.desc}</div>
          <span class="song-preview" title="试听这首歌">试听</span>
          ${sel.song===s.id?'<span class="tag">✓ 已选</span>':''}
          ${canDelete(s)?(s.temp?'<span class="song-del" title="从本地移除这首歌">🗑</span>':'<span class="song-regen" title="用最新算法重新生成曲谱">🔄</span><span class="song-del" title="删除这首歌">🗑</span>'):''}`;
        b.onclick=()=>{ sfxClick(); sel.song=s.id; renderPlay(); preloadSong(s); };
        // 试听：独立小按钮，阻止冒泡 → 试听不会同时选中这首歌
        const pv=b.querySelector('.song-preview'); pv._song=s;
        pv.addEventListener('click', ev=>{ ev.stopPropagation(); togglePreview(s); });
        if(canDelete(s)){
          b.querySelector('.song-del').addEventListener('click',async ev=>{
            ev.stopPropagation();
            // 临时歌：从内存 + IndexedDB + localStorage 一并移除
            if(s.temp){
              const yes=await askConfirm(`确定移除《${s.name}》吗？（从本地删除）`, {yesText:'移除'});
              if(!yes) return;
              URL.revokeObjectURL(s.file);
              const i=TEMP_SONGS.indexOf(s); if(i>=0) TEMP_SONGS.splice(i,1);
              saveTempMeta(TEMP_SONGS);              // 同步更新 localStorage 元数据
              delTempBlob(s.id).catch(()=>{});       // 异步删 IndexedDB，不阻塞
              if(sel.song===s.id) sel.song='default';
              renderPlay();
              return;
            }
            const yes=await askConfirm(`确定删除《${s.name}》吗？全班都无法再玩这首歌了`, {yesText:'删除'});
            if(!yes) return;
            try{
              const r=await fetch(`/api/dance/songs/${s.dbId}`, {method:'DELETE', credentials:'same-origin'});
              const data=await r.json().catch(()=>({}));
              if(!r.ok) throw new Error(data.error||'删除失败');
              toast('🗑 已删除《'+s.name+'》');
              if(sel.song===s.id) sel.song='default';
              await refreshUserSongs(); renderPlay();
            }catch(e){ toast('❌ '+(e.message||'删除失败')); }
          });
          const regenEl=b.querySelector('.song-regen');
          if(regenEl) regenEl.addEventListener('click',ev=>regenerateSong(ev,s));
        }
        sg.appendChild(b);
      });
    });
    // 还没有任何自制作品时，末尾放一个上传引导（有歌之后就不显示）
    if(!TEMP_SONGS.length && !USER_SONGS.list.length){
      const h=document.createElement('div');
      h.className='song-cat-head';
      const tip=!serverOn ? '还没有本地歌曲，点上方卡片选一首本地音乐，自动保存到本地，下次打开还能玩'
        : (USER_SONGS.loadError ? '未连接班级服务器，暂时读不到曲库' : '还没有班级自制作品，点上方卡片当第一个 DJ！');
      h.innerHTML=`<span class="sc-tip">${tip}</span>`;
      sg.appendChild(h);
    }
  }
  refreshPreviewIcons();   // 重渲染后恢复试听中的图标（🔊/⏸/▶）
  // 难度
  const dr=document.getElementById('diffRow');
  dr.innerHTML='';
  DIFFS.forEach(f=>{
    const b=document.createElement('div');
    b.className='diff-card'+(sel.diff===f.id?' sel':'');
    b.innerHTML=`<div class="dname">${f.name}</div><div class="ddesc">${f.desc}</div>`;
    b.onclick=()=>{ sfxClick(); sel.diff=f.id; renderPlay(); };
    dr.appendChild(b);
  });
}
export function getSelection(){ return sel; }
export function startShow(){ mainRef.startShow(sel.theme, sel.diff, sel.song); }

// ---------- 商城（涂装工坊）—— 购买 + 装备皮肤 ----------
function renderShop(){
  const g=document.getElementById('shopGrid'); g.innerHTML='';
  const d=Store.data;
  SKINS.forEach(sk=>{
    const owned = d.owned.includes(sk.id);
    const equipped = d.equipped===sk.id;
    const card=document.createElement('div');
    card.className='card skin-card';

    // 颜色预览球（头色 + 肚色）
    const headHex='#'+sk.colors.head.toString(16).padStart(6,'0');
    const bellyHex='#'+sk.colors.belly.toString(16).padStart(6,'0');
    const swatch=sk.glow
      ? `<div class="preview-ball" style="background:radial-gradient(circle at 35% 30%,${headHex},${bellyHex});box-shadow:0 0 18px #${sk.glow.toString(16).padStart(6,'0')}aa, inset 0 -6px 14px #00000044"></div>`
      : `<div class="preview-ball" style="background:radial-gradient(circle at 35% 30%,${headHex},${bellyHex});box-shadow:inset 0 -6px 14px #00000044"></div>`;

    let btn;
    if(equipped){
      btn=`<button class="buy use" disabled>✓ 使用中</button>`;
    }else if(owned){
      btn=`<button class="buy use" data-act="equip" data-id="${sk.id}">装备</button>`;
    }else{
      btn=`<button class="buy" data-act="buy" data-id="${sk.id}">🪙 ${sk.price} 购买</button>`;
    }

    card.innerHTML=`
      ${equipped?'<div class="ribbon">已装备</div>':''}
      ${swatch}
      <div class="sname">${sk.name}</div>
      <div class="sdesc">${sk.desc}</div>
      ${btn}
    `;
    g.appendChild(card);
  });

  // 绑定购买/装备
  g.querySelectorAll('button[data-act]').forEach(b=>{
    b.addEventListener('click',()=>{
      const id=b.dataset.id;
      const sk=SKINS.find(s=>s.id===id);
      if(!sk) return;
      if(b.dataset.act==='buy'){
        if(Store.data.coins<sk.price){ toast(`奶币不足，还差 ${sk.price-Store.data.coins} 🪙`); sfxMiss(); return; }
        Store.data.coins-=sk.price;
        Store.data.owned.push(id);
        Store.save();
        sfxCoin();
        toast(`🛍️ 购入「${sk.name}」！`);
        renderShop();
        renderHome();
      }else if(b.dataset.act==='equip'){
        Store.data.equipped=id;
        Store.save();
        if(mainRef.applySkin) mainRef.applySkin(sk);
        sfxClick();
        toast(`👕 已换装：${sk.name}`);
        renderShop();
      }
    });
  });
}

// ---------- 图鉴 ----------
function renderCodex(){
  const g=document.getElementById('codexGrid'); if(g.dataset.done) return;
  CODEX.forEach(c=>{
    const card=document.createElement('div');
    card.className='card codex-card';
    card.innerHTML=`<div class="ci">${c.ic}</div><div class="ck">${c.key}</div>
      <div class="cname">${c.name}</div><div class="cdesc">${c.desc}</div>`;
    g.appendChild(card);
  });
  g.dataset.done='1';
}

// ---------- 成就 ----------
function renderAch(){
  const list=document.getElementById('achList'); list.innerHTML='';
  const d=Store.data;
  ACHS.forEach(a=>{
    const v=Math.min(a.get(d), a.goal);
    const done=v>=a.goal;
    const item=document.createElement('div');
    item.className='ach-item'+(done?' done':'');
    item.innerHTML=`
      <div class="ai">${a.ic}</div>
      <div class="amid">
        <div class="aname">${a.name} ${done?'✓':''}</div>
        <div class="adesc">${a.desc}</div>
        <div class="abar"><i style="width:${v/a.goal*100}%"></i></div>
      </div>
      <div class="aright">${done?'已完成':`${v.toLocaleString()} / ${a.goal.toLocaleString()}`}</div>`;
    list.appendChild(item);
  });
}

// ---------- 排行 ----------
// 排序依据：相对分（旧记录没有相对分，沉底）
function rankCmp(a,b){ return (b.rel??-1)-(a.rel??-1); }
function renderRank(){ renderRankList(document.querySelector('#rankTabs button.cur').dataset.d); }
function renderRankList(diff){
  const list=document.getElementById('rankList'); list.innerHTML='';
  const help=document.querySelector('#scr-rank .rank-help');
  // ★ 无尽页签：本地记录按绝对分排，结构与普通难度不同
  if(diff==='endless'){
    help.innerHTML='💡 <b>无尽记录只看绝对分。</b>无尽模式计分从 0 开始，看你在 ❤×10 打光之前能攒下多少总分。每条记录都备注了<b>曲目、坚持段数、连击和日期</b>，只保存在你这台设备上（全班排名需在校园网版查看）。';
    const arr=[...(Store.data.scores.endless||[])].sort((a,b)=>b.score-a.score).slice(0,5);
    if(!arr.length){ list.innerHTML='<div class="rank-empty">暂无无尽纪录 —— 去撑一波！</div>'; return; }
    arr.forEach((r,i)=>{
      const row=document.createElement('div');
      row.className='rank-row'+(i===0?' top1':'');
      row.innerHTML=`<div class="no">${i===0?'🥇':i===1?'🥈':i===2?'🥉':i+1}</div>
        <div class="rbody">
          <div class="rsong">🎵 ${r.song||'未知曲目'}</div>
          <div class="ebig">${r.score.toLocaleString()}<small>绝对分</small></div>
          <div class="rj"><span class="rj-p">完美 ${r.p}</span><span class="rj-g">良好 ${r.g}</span><span class="rj-m">漏掉 ${r.m}</span></div>
          <div class="rmeta">坚持 ${r.round} 段 · 最大连击 ×${r.combo} · ${r.date}</div>
        </div>
        <div class="rrank">♾</div>`;
      list.appendChild(row);
    });
    return;
  }
  // 普通难度：恢复相对分说明框
  help.innerHTML='💡 <b>什么是相对分？</b>每首歌音符多少不同，直接比总分不公平。<b>相对分 = 你的得分 ÷ 这首歌的满分 × 100000</b>（满分就是"一个不漏、全部打完美"的成绩）。所以相对分越高，代表越接近完美；范围固定 0～100000，任何歌曲都能公平比较。';
  const arr=[...(Store.data.scores[diff]||[])].sort(rankCmp).slice(0,5);
  if(!arr.length){ list.innerHTML='<div class="rank-empty">暂无纪录 —— 上去就是第一名！</div>'; return; }
  arr.forEach((r,i)=>{
    const pct=Math.max(0,Math.min(100,r.rel/1000));
    const row=document.createElement('div');
    row.className='rank-row'+(i===0?' top1':'');
    row.innerHTML=`<div class="no">${i===0?'🥇':i===1?'🥈':i===2?'🥉':i+1}</div>
      <div class="rbody">
        <div class="rsong">🎵 ${r.song||'未知曲目'}</div>
        <div class="rbar"><div class="rfill" style="width:${pct.toFixed(2)}%"></div><span class="rpct">${pct.toFixed(2)}%</span></div>
        <div class="rj"><span class="rj-p">完美 ${r.p}</span><span class="rj-g">良好 ${r.g}</span><span class="rj-m">漏掉 ${r.m}</span></div>
        <div class="rmeta">相对分 ${r.rel.toLocaleString()} / 100,000 · 绝对分 ${r.score.toLocaleString()} · 连击 ×${r.combo} · ${r.date}</div>
      </div>
      <div class="rrank">${r.rank}</div>`;
    list.appendChild(row);
  });
}

// ---------- 全班排行榜 ----------
const boardState={song:'default', diff:'easy', ready:false};

async function renderBoard(){
  if(!USER_SONGS.loaded) await refreshUserSongs();
  const sel=document.getElementById('boardSong');
  const tabs=document.getElementById('boardTabs');
  // 静态版：没有在线排行榜，直接说明
  if(!serverOn){
    if(sel) sel.style.display='none';
    if(tabs) tabs.style.display='none';
    document.getElementById('boardList').innerHTML=
      '<div class="rank-empty">🌐 这是网页版，多人排行榜需要连接班级服务器。<br>回到校园网玩，就能和全班比高低啦！<br>（你自己的成绩仍然保存在「🏆 我的纪录」里）</div>';
    return;
  }
  if(sel) sel.style.display='';
  if(tabs) tabs.style.display='';
  // 曲目下拉：内置 + 全班上传，只构建一次
  if(!boardState.ready){
    const all=[...SONGS, ...USER_SONGS.list];
    sel.innerHTML=all.map(s=>`<option value="${s.id}">${s.name}${s.user?'（上传曲）':''}</option>`).join('');
    sel.value=boardState.song;
    sel.addEventListener('change',()=>{ boardState.song=sel.value; loadBoardScores(); });
    document.querySelectorAll('#boardTabs button').forEach(b=>{
      b.addEventListener('click',()=>{
        document.querySelectorAll('#boardTabs button').forEach(x=>x.classList.remove('cur'));
        b.classList.add('cur');
        boardState.diff=b.dataset.d;
        paintBoard();
      });
    });
    boardState.ready=true;
  }
  await loadBoardScores();
}

async function loadBoardScores(){
  const list=document.getElementById('boardList');
  list.innerHTML='<div class="rank-empty">加载中…</div>';
  try{
    const r=await fetch('/api/dance/scores/'+encodeURIComponent(boardState.song), {credentials:'same-origin'});
    if(!r.ok) throw new Error('HTTP '+r.status);
    boardState.data=await r.json();
  }catch(e){
    boardState.data=null;
    list.innerHTML='<div class="rank-empty">加载失败，请稍后再试</div>';
    return;
  }
  paintBoard();
}

function paintBoard(){
  const list=document.getElementById('boardList'); list.innerHTML='';
  const arr=(boardState.data&&boardState.data.byDiff[boardState.diff])||[];
  if(!arr.length){ list.innerHTML='<div class="rank-empty">这首曲子这个难度还没人上榜 —— 来抢第一名！</div>'; return; }
  arr.forEach((r,i)=>{
    const pct=Math.max(0,Math.min(100,r.rel/1000));
    const date=String(r.created_at||'').slice(0,10);
    const row=document.createElement('div');
    row.className='rank-row'+(i===0?' top1':'');
    row.innerHTML=`<div class="no">${i===0?'🥇':i===1?'🥈':i===2?'🥉':i+1}</div>
      <div class="rbody">
        <div class="rsong">👤 ${r.user_name||'玩家'}</div>
        <div class="rbar"><div class="rfill" style="width:${pct.toFixed(2)}%"></div><span class="rpct">${pct.toFixed(2)}%</span></div>
        <div class="rj"><span class="rj-p">完美 ${r.p}</span><span class="rj-g">良好 ${r.g}</span><span class="rj-m">漏掉 ${r.m}</span></div>
        <div class="rmeta">相对分 ${r.rel.toLocaleString()} / 100,000 · 绝对分 ${r.score.toLocaleString()} · 连击 ×${r.combo} · ${date}</div>
      </div>
      <div class="rrank">${r.rank}</div>`;
    list.appendChild(row);
  });
}

// ---------- 无尽模式排行榜（仅地狱难度，按累计总分排行）----------
const endlessState={song:'default', ready:false};

async function renderEndlessBoard(){
  if(!USER_SONGS.loaded) await refreshUserSongs();
  const sel=document.getElementById('endlessSong');
  // 静态版：没有在线排行榜，直接说明
  if(!serverOn){
    if(sel) sel.style.display='none';
    document.getElementById('endlessList').innerHTML=
      '<div class="rank-empty">🌐 这是网页版，无尽排行榜需要连接班级服务器。<br>回到校园网玩，就能和全班比高低啦！<br>（无尽模式本身照常可玩：整首地狱谱弹完后点「♾ 继续无尽模式」）</div>';
    return;
  }
  if(sel) sel.style.display='';
  // 曲目下拉：内置 + 全班上传，只构建一次
  if(!endlessState.ready){
    const all=[...SONGS, ...USER_SONGS.list];
    sel.innerHTML=all.map(s=>`<option value="${s.id}">${s.name}${s.user?'（上传曲）':''}</option>`).join('');
    sel.value=endlessState.song;
    sel.addEventListener('change',()=>{ endlessState.song=sel.value; loadEndlessScores(); });
    endlessState.ready=true;
  }
  await loadEndlessScores();
}

async function loadEndlessScores(){
  const list=document.getElementById('endlessList');
  list.innerHTML='<div class="rank-empty">加载中…</div>';
  try{
    const r=await fetch('/api/dance/endless/'+encodeURIComponent(endlessState.song), {credentials:'same-origin'});
    if(!r.ok) throw new Error('HTTP '+r.status);
    endlessState.data=await r.json();
  }catch(e){
    endlessState.data=null;
    list.innerHTML='<div class="rank-empty">加载失败，请稍后再试</div>';
    return;
  }
  paintEndless();
}

function paintEndless(){
  const list=document.getElementById('endlessList'); list.innerHTML='';
  const arr=(endlessState.data&&endlessState.data.rows)||[];
  if(!arr.length){ list.innerHTML='<div class="rank-empty">这首曲子还没人挑战无尽 —— 弹完整首地狱谱试试！</div>'; return; }
  const top=arr[0].score||1;
  arr.forEach((r,i)=>{
    const pct=Math.max(2,Math.min(100,r.score/top*100));
    const date=String(r.created_at||'').slice(0,10);
    const row=document.createElement('div');
    row.className='rank-row'+(i===0?' top1':'');
    row.innerHTML=`<div class="no">${i===0?'🥇':i===1?'🥈':i===2?'🥉':i+1}</div>
      <div class="rbody">
        <div class="rsong">👤 ${r.user_name||'玩家'}</div>
        <div class="rbar"><div class="rfill" style="width:${pct.toFixed(2)}%"></div><span class="rpct">${r.score.toLocaleString()} 分</span></div>
        <div class="rj"><span class="rj-p">♾ 坚持 ${r.round} 段</span><span class="rj-g">连击 ×${r.combo}</span><span class="rj-m">击中 ${r.notes}</span></div>
        <div class="rmeta">累计总分 ${r.score.toLocaleString()} · ${date}</div>
      </div>
      <div class="rrank">♾</div>`;
    list.appendChild(row);
  });
}

// ---------- 设置 ----------
// 管理员认证区块的状态显示（已认证/未认证，按钮在"认证/退出认证"间切换）
function updateAdminAuthUI(){
  // 静态版整个管理员认证区块不需要
  const block=document.getElementById('setAdminAuth');
  if(block) block.style.display=serverOn?'':'none';
  const tip=document.getElementById('adminAuthTip');
  const btn=document.getElementById('btnAdminAuth');
  if(!tip||!btn) return;
  if(myIdentity&&myIdentity.isAdmin){
    tip.textContent='✅ 已认证：可删除任意同学上传的歌曲';
    tip.style.color='#7fe38a';
    btn.textContent='退出认证';
    btn.dataset.mode='exit';
  }else{
    tip.textContent='先在班级网站登录管理员账号，认证后可删除任意同学上传的歌曲';
    tip.style.color='';
    btn.textContent='认证';
    btn.dataset.mode='auth';
  }
}

function bindSettings(){
  const d=Store.data.set;
  const $=id=>document.getElementById(id);
  const vol=$('setVol'), off=$('setOffset'), bpm=$('setBpm');
  vol.value=d.vol*100; $('setVolV').textContent=Math.round(d.vol*100)+'%';
  off.value=d.offset;  $('setOffsetV').textContent=d.offset+'ms';
  bpm.value=d.bpm;     $('setBpmV').textContent=d.bpm;
  $('setSfx').value=String(d.sfx);
  $('setQuality').value=String(d.quality);

  vol.oninput=()=>{ d.vol=vol.value/100; $('setVolV').textContent=vol.value+'%'; applyVolume(); Store.save(); };
  off.oninput=()=>{ d.offset=+off.value; $('setOffsetV').textContent=off.value+'ms'; Store.save(); };
  bpm.oninput=()=>{ d.bpm=+bpm.value; $('setBpmV').textContent=bpm.value; Store.save(); };
  $('setSfx').onchange=e=>{ d.sfx=+e.target.value; setSfxEnabled(!!d.sfx); Store.save(); };
  $('setQuality').onchange=e=>{ d.quality=+e.target.value; mainRef.applyQuality(d.quality); Store.save(); };

  // 跟拍测 BPM：连续点击间隔取平均
  let taps=[];
  $('btnTap').onclick=()=>{
    ensureCtx(); sfxClick();
    const now=performance.now();
    taps=taps.filter(t=>now-t<2500); taps.push(now);
    if(taps.length>=4){
      const iv=[];
      for(let i=1;i<taps.length;i++) iv.push(taps[i]-taps[i-1]);
      const avg=iv.reduce((a,b)=>a+b)/iv.length;
      const b2=Math.round(60000/avg);
      if(b2>=60&&b2<=180){ d.bpm=b2; bpm.value=b2; $('setBpmV').textContent=b2; Store.save(); toast(`🥁 测得 BPM ≈ ${b2}`); }
    }else toast(`继续点… ${taps.length}/4`);
  };

  $('btnReset').onclick=()=>{
    if(confirm('确定清空全部进度？此操作不可恢复！')){
      Store.reset(); applyVolume(); renderHome(); refreshPlayerId(); toast('存档已清空');
    }
  };

  // ---- 清理本站缓存：只删旧【代码】文件，保留 3D 模型/图片（重新下载模型很慢）----
  // 同学自己就能点，不用清整个浏览器/QQ；存档(localStorage)完全不动
  $('btnClearCache').onclick=async()=>{
    const btn=$('btnClearCache');
    btn.textContent='清理中…'; btn.disabled=true;
    let delN=0, keptN=0;
    try{
      if('caches' in window){
        const CODE=/\.(html|js|css|json)(\?.*)?$/i;   // 只清代码；.glb/.gltf/.bin/图片/音频一律保留
        for(const name of await caches.keys()){
          const cache=await caches.open(name);
          for(const req of await cache.keys()){
            const p=new URL(req.url).pathname;
            if(CODE.test(p)){ await cache.delete(req); delN++; }
            else keptN++;
          }
        }
      }
      // 注意：不注销 Service Worker —— 它是"网络优先"，在线时永远先拿新代码，旧缓存只在断网时兜底
      toast(`已清 ${delN} 个旧代码文件，3D模型等 ${keptN} 个文件保留；2秒后刷新`);
    }catch(e){
      console.error('清缓存失败', e);
      toast('清理完成，2秒后自动刷新');
    }
    // 带随机参数强制刷新，确保 HTML/JS 拿到全新文件
    setTimeout(()=>{ location.href=location.pathname+'?v='+Date.now(); }, 2000);
  };

  // ---- 管理员认证：调全站统一接口，认证后会话获得管理员模式 ----
  $('btnAdminAuth').onclick=async()=>{
    ensureCtx();
    const btn=$('btnAdminAuth');
    if(btn.dataset.mode==='exit'){
      const r=await fetch('/api/admin/exit',{method:'POST',credentials:'same-origin'});
      if(r.ok){
        await refreshUserSongs();
        if(document.getElementById('scr-play').classList.contains('cur')) renderPlay();
        toast('已退出管理员认证');
      }
      return;
    }
    const secret=$('adminSecretInput').value.trim();
    if(!secret){ toast('请输入管理员密码'); return; }
    try{
      const r=await fetch('/api/admin/apply',{method:'POST',credentials:'same-origin',
        headers:{'Content-Type':'application/json'},body:JSON.stringify({secret})});
      const data=await r.json().catch(()=>({}));
      if(!r.ok) throw new Error(data.error||'认证失败');
      sfxClick();
      await refreshUserSongs();                       // 重新拿身份（admin_mode=true）
      if(document.getElementById('scr-play').classList.contains('cur')) renderPlay();
      toast('🛡️ 管理员认证成功');
      $('adminSecretInput').value='';
    }catch(e){ toast('❌ '+(e.message||'认证失败')); }
  };
  $('adminSecretInput').addEventListener('keydown',e=>{
    if(e.key==='Enter') $('btnAdminAuth').click();
  });

  // ---- 玩家编号 ----
  refreshPlayerId();
  $('btnCopyId').onclick=async ()=>{
    sfxClick();
    const id=Store.data.playerId;
    try{
      await navigator.clipboard.writeText(id);
      toast('📋 编号已复制：'+id);
    }catch(e){
      // 老浏览器/非 https 兜底
      const t=document.createElement('textarea'); t.value=id; document.body.appendChild(t);
      t.select(); document.execCommand('copy'); t.remove();
      toast('📋 编号已复制：'+id);
    }
  };

  // ---- 管理入口暗号：连点版本号 5 次才显示（普通玩家看不到）----
  const egg=$('verEgg'), secret=$('adminSecretLink');
  if(sessionStorage.getItem('naiwa_admin_unlocked')) secret.style.display='inline';
  let eggTaps=0, eggTimer=0;
  egg.style.pointerEvents='auto';
  egg.addEventListener('click',()=>{
    clearTimeout(eggTimer);
    eggTaps++;
    if(eggTaps>=5){
      eggTaps=0;
      sessionStorage.setItem('naiwa_admin_unlocked','1');
      secret.style.display='inline';
      toast('🛠️ 管理入口已解锁');
    }else{
      eggTimer=setTimeout(()=>eggTaps=0,1500);
    }
  });
}

// 刷新设置页显示的玩家编号
function refreshPlayerId(){
  const el=document.getElementById('myPlayerId');
  if(el) el.textContent=Store.data.playerId||'------';
}

// ============================================================
// 上传歌曲弹窗：选文件 → 本地分析生成谱面 → 连音频一起传到班级曲库
// ============================================================
function bindUpload(){
  const $=id=>document.getElementById(id);
  const ov=$('uploadOv'), fileIn=$('upFile'), stage=$('upStage'), bar=$('upBar'),
        info=$('upInfo'), titleIn=$('upTitle'), artistIn=$('upArtist'), submit=$('upSubmit');
  let analyzed=null, analyzing=false;

  function reset(){
    analyzed=null; analyzing=false;
    fileIn.value='';
    stage.textContent='支持 mp3 / m4a / ogg / wav，30MB 以内';
    bar.style.width='0'; info.textContent='';
    submit.disabled=true; titleIn.value=''; artistIn.value='';
  }
  $('btnUploadSong').addEventListener('click',()=>{
    ensureCtx(); sfxClick();
    reset();
    // 根据是否连着班级服务器，切换弹窗文案（临时模式 / 入库模式）
    const head=document.querySelector('#uploadOv .up-head');
    const tip=document.querySelector('#uploadOv .up-tip');
    const note=document.querySelector('#uploadOv .up-note');
    if(head) head.innerHTML=serverOn ? '⬆️ 上传歌曲 <small>AUTO CHART</small>' : '🎲 临时歌曲 <small>TEMP CHART</small>';
    if(tip) tip.textContent=serverOn
      ? '选一首音乐 → 浏览器自动分析节奏生成谱面 → 存进班级曲库，全班都能跳'
      : '选一首本地音乐 → 浏览器自动分析节奏生成谱面 → 自动保存到本地，下次打开还能玩';
    if(note) note.textContent=serverOn
      ? '上传需要先登录班级网站 · 请上传有版权使用权的音乐哦'
      : '纯本地分析，不会上传任何文件 · 请使用有版权使用权的音乐哦';
    submit.textContent=serverOn ? '⬆️ 上传到班级曲库' : '🎮 生成并开跳';
    ov.classList.add('on');
  });
  $('upCancel').addEventListener('click',()=>{ sfxClick(); ov.classList.remove('on'); });
  ov.addEventListener('click',e=>{ if(e.target===ov && !analyzing) ov.classList.remove('on'); });

  // 选好文件 → 立刻本地分析（浏览器完成，不占服务器）
  fileIn.addEventListener('change', async ()=>{
    const f=fileIn.files[0];
    if(!f) return;
    if(f.size>30*1024*1024){ toast('❌ 文件超过 30MB，压一压再来'); fileIn.value=''; return; }
    analyzing=true; submit.disabled=true; info.textContent='';
    titleIn.value=f.name.replace(/\.[^.]+$/,'').slice(0,50);
    bar.style.width='5%';
    try{
      const res=await analyzeAudio(f,(text,pct)=>{
        stage.textContent=text;
        if(pct!=null) bar.style.width=pct+'%';
      });
      analyzed={ file:f, ...res };
      analyzing=false;
      bar.style.width='100%';
      stage.textContent='✅ 分析完成！选好难度就能开跳';
      info.textContent=`时长 ${fmtDur(res.duration)} · ${res.notes.length} 个音符 · 估算 BPM ${res.bpm}`;
      submit.disabled=false;
      sfxCoin();
    }catch(e){
      analyzing=false;
      stage.textContent='❌ '+(e.message||'分析失败，换个文件试试');
      bar.style.width='0';
      sfxMiss();
    }
  });

  // 有服务器：上传到班级曲库；网页版：生成临时歌曲直接玩
  submit.addEventListener('click', async ()=>{
    if(!analyzed || analyzing) return;
    submit.disabled=true;
    const title=(titleIn.value.trim()||'未命名歌曲');
    // ===== 网页版临时模式：不联网，存本地（IndexedDB + localStorage），刷新后仍在 =====
    if(!serverOn){
      const url=URL.createObjectURL(analyzed.file);
      const song={
        id:'temp'+Date.now(),
        name:title,
        artist:artistIn.value.trim()||'本地音乐',
        file:url,
        bpm:analyzed.bpm,
        desc:`${analyzed.notes.length} 音符 · ${fmtDur(analyzed.duration)} · 📂本地`,
        cat:'user', user:true, temp:true,
        chart:analyzed.notes, duration:analyzed.duration,
        stars:3,   // 临时本地歌：默认 3 星（不现场评估）
        createdAt:Date.now(),
      };
      TEMP_SONGS.push(song);
      // 持久化：音频 Blob → IndexedDB；元数据 → localStorage
      try{
        await putTempBlob(song.id, analyzed.file);
        saveTempMeta(TEMP_SONGS);
      }catch(e){ console.warn('[临时歌曲] 本地保存失败（仍可临时玩）', e); }
      sel.song=song.id;
      ov.classList.remove('on');
      reset();
      toast('🎵 《'+title+'》已保存到本地，下次打开还在！');
      sfxCoin();
      renderPlay();
      return;
    }
    // ===== 班级服务器模式：POST 入库 =====
    stage.textContent='正在上传到班级曲库…';
    try{
      const fd=new FormData();
      fd.append('audio', analyzed.file);
      fd.append('title', title);
      fd.append('artist', artistIn.value.trim());
      fd.append('bpm', analyzed.bpm);
      fd.append('duration', analyzed.duration);
      fd.append('chart', JSON.stringify(analyzed.notes));
      const r=await fetch('/api/dance/songs', {method:'POST', body:fd, credentials:'same-origin'});
      const data=await r.json().catch(()=>({}));
      if(!r.ok) throw new Error(data.error||('上传失败('+r.status+')'));
      toast('🎉 《'+title+'》已入库，全班都能玩了！');
      sfxCoin();
      ov.classList.remove('on');
      reset();
      await refreshUserSongs();
      sel.song='u'+data.id;      // 自动选中刚上传的歌
      renderPlay();
    }catch(e){
      stage.textContent='❌ '+(e.message||'上传失败');
      submit.disabled=false;
      sfxMiss();
    }
  });
}
function applyVolume(){ Music.setVolume(Store.data.set.vol); setMenuBgmVolume(Store.data.set.vol); setVoiceVolume(Store.data.set.vol); }

// ---------- 结算 ----------
// 自动上传成绩到全班排行榜（fire-and-forget；登录用户身份由服务器强制认定）
async function submitServerScore(res){
  if(!serverOn) return;   // 静态版没有在线排行榜
  try{
    const localId=Store.data.playerId||'anon';
    const body={
      songKey:res.songId||'default',
      songName:res.song||'',
      diff:res.diff,
      userKey:'g'+localId,
      userName:myIdentity?myIdentity.name:('游客'+String(localId).slice(-4)),
      score:res.score, rel:res.rel, combo:res.maxCombo, rank:res.rank,
      p:res.cnt.perfect, g:res.cnt.good, m:res.cnt.miss,
    };
    await fetch('/api/dance/scores',{
      method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify(body), credentials:'same-origin',
    });
  }catch(e){ console.warn('[排行榜] 成绩自动上传失败（不影响游戏）', e); }
}

export function showResult(res, isNew){
  submitServerScore(res);   // 自动上传，不等待
  const s=Store.data.stats;
  s.plays++; s.totalPerfect+=res.cnt.perfect; s.totalCoins+=res.coin;
  if(res.score>s.bestScore) s.bestScore=res.score;
  if(res.rel>(s.bestRel||0)) s.bestRel=res.rel;
  if(res.maxCombo>s.maxCombo) s.maxCombo=res.maxCombo;
  if(res.acc>s.bestAcc) s.bestAcc=res.acc;
  if(res.cnt.miss===0 && res.cnt.perfect+res.cnt.good>0) s.fullCombos++;
  if(res.rank==='SS') s.ssCount++;
  Store.data.coins+=res.coin;
  // 写入排行榜（含相对分，排行按相对分，不同歌曲才公平）
  Store.data.scores[res.diff]=Store.data.scores[res.diff]||[];
  Store.data.scores[res.diff].push({
    score:res.score, combo:res.maxCombo, rank:res.rank,
    date:new Date().toLocaleDateString(),
    rel:res.rel, max:res.maxScore, notes:res.notes,
    p:res.cnt.perfect, g:res.cnt.good, m:res.cnt.miss,
    song:res.song||'',
  });
  Store.data.scores[res.diff].sort(rankCmp);
  Store.data.scores[res.diff]=Store.data.scores[res.diff].slice(0,10);
  Store.save();

  document.getElementById('resRank').textContent=res.rank;
  document.getElementById('resScore').textContent=res.score.toLocaleString();
  document.getElementById('resRel').textContent=res.rel.toLocaleString()+' / 100000';
  document.getElementById('resPerfect').textContent=res.cnt.perfect;
  document.getElementById('resGood').textContent=res.cnt.good;
  document.getElementById('resMiss').textContent=res.cnt.miss;
  document.getElementById('resCombo').textContent=res.maxCombo;
  document.getElementById('resCoinLine').innerHTML='🪙 本场演出费 +<span id="resCoin">'+res.coin+'</span> 奶币';
  document.getElementById('resNew').style.display=isNew?'':'none';
  showScreen('scr-result');
  renderHome(); renderAch();
}

// ---------- 无尽模式结算 ----------
// 自动上传无尽成绩（fire-and-forget；排行=累计总分，同玩家同曲目只留最高）
async function submitServerEndless(res){
  if(!serverOn) return;
  try{
    const localId=Store.data.playerId||'anon';
    const body={
      songKey:res.songId||'default',
      songName:res.song||'',
      userKey:'g'+localId,
      userName:myIdentity?myIdentity.name:('游客'+String(localId).slice(-4)),
      score:res.score, round:res.round, combo:res.maxCombo,
      notes:res.cnt.perfect+res.cnt.good,
    };
    await fetch('/api/dance/endless',{
      method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify(body), credentials:'same-origin',
    });
  }catch(e){ console.warn('[无尽榜] 成绩自动上传失败（不影响游戏）', e); }
}

// 无尽结束（❤ 打光）→ 复用结算屏展示累计总分
export function showEndlessResult(res){
  submitServerEndless(res);
  const s=Store.data.stats;
  if(res.score>s.bestScore) s.bestScore=res.score;
  if(res.maxCombo>s.maxCombo) s.maxCombo=res.maxCombo;
  // 无尽演出费：无尽计分从0开始，直接按总分发奶币
  const coin=Math.floor(res.score/400);
  Store.data.coins+=coin;
  // ★ 写入本地「我的纪录·无尽」：只记绝对分，备注曲目/段数/判定/日期（保留最近10条，按分排序）
  Store.data.scores.endless=Store.data.scores.endless||[];
  Store.data.scores.endless.push({
    score:res.score, combo:res.maxCombo,
    date:new Date().toLocaleDateString(),
    song:res.song||'', round:res.round,
    p:res.cnt.perfect, g:res.cnt.good, m:res.cnt.miss,
  });
  Store.data.scores.endless.sort((a,b)=>b.score-a.score);
  Store.data.scores.endless=Store.data.scores.endless.slice(0,10);
  Store.save();

  document.getElementById('resRank').textContent='♾';
  document.getElementById('resScore').textContent=res.score.toLocaleString();
  document.getElementById('resRel').textContent=`坚持 ${res.round} 段 · 累计总分排行（无尽榜）`;
  document.getElementById('resNew').style.display='none';
  document.getElementById('resPerfect').textContent=res.cnt.perfect;
  document.getElementById('resGood').textContent=res.cnt.good;
  document.getElementById('resMiss').textContent=res.cnt.miss;
  document.getElementById('resCombo').textContent=res.maxCombo;
  document.getElementById('resCoinLine').innerHTML='🪙 无尽演出费 +<span id="resCoin">'+coin+'</span> 奶币';
  showScreen('scr-result');
  renderHome(); renderAch();
}

// ---------- Toast ----------
let toastT=0;
export function toast(msg){
  const t=document.getElementById('toast');
  t.textContent=msg; t.classList.add('on');
  clearTimeout(toastT); toastT=setTimeout(()=>t.classList.remove('on'),1800);
}

// ★ 通用确认弹窗（玻璃拟态，防误触）。返回 Promise<boolean>
// 用法：const yes = await askConfirm('确定退出吗？'); if(yes) ...
export function askConfirm(msg, opts={}){
  const {yesText='确定', noText='取消', danger=true} = opts;
  return new Promise(res=>{
    const mask=document.createElement('div');
    mask.className='cf-mask';
    const box=document.createElement('div');
    box.className='cf-box';
    box.innerHTML=`
      <div class="cf-msg">${msg}</div>
      <div class="cf-btns">
        <button class="cf-no">${noText}</button>
        <button class="cf-yes${danger?' danger':''}">${yesText}</button>
      </div>`;
    mask.appendChild(box);
    document.body.appendChild(mask);
    requestAnimationFrame(()=>mask.classList.add('in'));
    let done=false;
    const close=(v)=>{ if(done) return; done=true; mask.classList.remove('in'); setTimeout(()=>mask.remove(),180); res(v); };
    box.querySelector('.cf-no').onclick=()=>close(false);
    box.querySelector('.cf-yes').onclick=()=>close(true);
    mask.addEventListener('click',e=>{ if(e.target===mask) close(false); });
  });
}

// ---------- 成就检测（game 结束时调用） ----------
export function checkAch(){
  const d=Store.data; const got=[];
  ACHS.forEach(a=>{
    if(!d.ach[a.id] && a.get(d)>=a.goal){ d.ach[a.id]=1; got.push(a); }
  });
  if(got.length) Store.save();
  return got;
}
