// ============================================================
// ui.js —— 界面系统：存档 / 导航 / 商城 / 图鉴 / 成就 / 排行 / 设置 / 结算
//          + 玩家上传歌曲（自动生成谱面 → 存班级数据库 → 全班可玩）
// ============================================================
import { analyzeAudio } from './analyze.js?v=20261025';
import { Music, setSfxEnabled, sfxClick, sfxCoin, sfxMiss, ensureCtx, setMenuBgmVolume, setVoiceVolume } from './audio.js?v=20261034';
import { Game, pauseGame } from './game.js?v=20261034';

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
  scores:{easy:[],casual:[],normal:[],hard:[]},
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
      this.data.scores[d]=this.data.scores[d].filter(r=>typeof r.rel==='number'&&typeof r.p==='number');
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
export const SONGS=[
  {id:'default', name:'默认曲目', artist:'内置BGM', file:'music.mp3', bpm:104, desc:'游戏自带的节奏曲', cat:'builtin'},
  {id:'u14', name:'小半', artist:'陈粒', file:'1790904961734_529237489.mp3', bpm:165, desc:'165 BPM · 约5分钟', cat:'builtin', staticChart:true},
  {id:'u15', name:'玻璃', artist:'Gareth.T', file:'1790905313361_805251406.mp3', bpm:146, desc:'146 BPM · 约3分钟', cat:'builtin', staticChart:true},
  {id:'u16', name:'晴天', artist:'周杰伦', file:'1790905913537_81414028.mp3', bpm:137, desc:'137 BPM · 约4.5分钟', cat:'builtin', staticChart:true},
  {id:'u17', name:'甲乙丙丁', artist:'李佳薇', file:'1790906408562_96433968.mp3', bpm:130, desc:'130 BPM · 约3.5分钟', cat:'builtin', staticChart:true},
  {id:'u18', name:'雨天', artist:'孙燕姿', file:'1790921439546_533325666.mp3', bpm:114, desc:'114 BPM · 约4分钟', cat:'builtin', staticChart:true},
  {id:'u19', name:'一见如故', artist:'同学上传', file:'1790930389175_193904487.mp3', bpm:118, desc:'118 BPM · 约4.5分钟', cat:'builtin', staticChart:true},
  {id:'u20', name:'女骑士', artist:'徐良', file:'1790935598626_920508153.mp3', bpm:110, desc:'110 BPM · 约4分钟', cat:'builtin', staticChart:true},
  {id:'u21', name:'河山大好', artist:'许嵩', file:'1790937139158_104059326.mp3', bpm:175, desc:'175 BPM · 约3.5分钟', cat:'builtin', staticChart:true},
  {id:'u22', name:'渲染离别', artist:'许嵩', file:'1790940036039_422108884.mp3', bpm:120, desc:'120 BPM · 约4.5分钟', cat:'builtin', staticChart:true},
];

// 歌曲分类（渲染时每组带小标题；空的分组会自动跳过）
export const SONG_CATS=[
  {id:'builtin', name:'🎮 内置',   tip:'游戏自带'},
  {id:'user',    name:'⭐ 班级自制', tip:'同学上传 · 自动谱面'},
];

// 静态版预置谱面（从 charts.json 加载）
export const STATIC_CHARTS={ loaded:false, map:{} };
export async function loadStaticCharts(){
  if(STATIC_CHARTS.loaded) return;
  try{
    const r=await fetch('charts.json');
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
// 临时歌曲（网页版专用）：选本地文件→浏览器分析→直接玩；只存在内存里，刷新页面就消失
export const TEMP_SONGS=[];
let myIdentity=null;   // /api/me：{id, isAdmin}，用于判断能否删除
let serverOn=false;    // 是否连着班级服务器（静态版为 false → 上传走临时模式，在线排行不可用）

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
  {id:'endless',name:'♾ 无尽', desc:'计分从0开始 · 循环加速 · ❤×5'},
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
let mainRef=null;   // main.js 注入 { startShow, switchTheme, applyQuality }

export function initUI(main){
  mainRef=main;
  const d=Store.data;

  // ---- 导航 ----
  document.querySelectorAll('[data-scr]').forEach(btn=>{
    btn.addEventListener('click',()=>{
      sfxClick();
      const id=btn.dataset.scr;
      if(id==='scr-play') renderPlay();
      if(id==='scr-shop') renderShop();
      if(id==='scr-codex') renderCodex();
      if(id==='scr-ach')  renderAch();
      if(id==='scr-rank') renderRank();
      if(id==='scr-board') renderBoard();
      if(id==='scr-endless') renderEndlessBoard();
      if(id==='scr-home') renderHome();
      if(id==='scr-set') updateAdminAuthUI();
      showScreen(id);
    });
  });
  document.getElementById('btnGoPlay').addEventListener('click',()=>{
    sfxClick(); renderPlay(); showScreen('scr-play');
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
  refreshUserSongs().then(()=>{
    // 列表到位后，如果用户已停在选歌页，立即补渲染
    if(document.getElementById('scr-play').classList.contains('cur')) renderPlay();
  });

  // ---- 结算按钮 ----
  document.getElementById('btnRetry').addEventListener('click',()=>{ sfxClick(); startShow(); });
  document.getElementById('btnBackHome').addEventListener('click',()=>{
    sfxClick(); showScreen('scr-home'); renderHome();
  });

  // ---- ★ 选舞池页「开始表演」按钮（之前漏绑，导致点不动）----
  document.getElementById('btnStart').addEventListener('click',()=>{
    sfxClick();
    ensureCtx();          // 确保 AudioContext 已解锁（首次点击触发）
    startShow();
  });

  // ---- ★ 选舞池页返回按钮（窄屏导航隐藏时保证能退回主界面）----
  const btnPlayBack=document.getElementById('btnPlayBack');
  if(btnPlayBack) btnPlayBack.addEventListener('click',()=>{
    sfxClick(); showScreen('scr-home'); renderHome();
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
function renderPlay(){
  // 上传入口：有服务器→存班级曲库；网页版→临时歌曲（刷新就没）
  const upBtn=document.getElementById('btnUploadSong');
  if(upBtn){
    upBtn.style.display='';
    upBtn.innerHTML=serverOn
      ? '⬆️ 上传歌曲 <small>AUTO CHART</small>'
      : '🎲 临时歌曲 <small>选本地音乐直接玩</small>';
  }
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
  // 歌曲 —— 按分类分组渲染（内置 / 班级自制 / 中文 / 日文 / 电音）
  const sg=document.getElementById('songGrid');
  if(sg){
    sg.innerHTML='';
    // 渲染前顺手刷新一次玩家歌曲（首次进页面时已拉过，这里只在未加载时补拉）
    SONG_CATS.forEach(cat=>{
      // 连着班级服务器（本地版）时隐藏「内置」分区：内置歌都来自同学上传，避免重复显示
      if(cat.id==='builtin' && serverOn) return;
      const list=cat.id==='user' ? [...TEMP_SONGS, ...USER_SONGS.list] : SONGS.filter(s=>s.cat===cat.id);
      if(!list.length){
        // 班级自制分区：哪怕还没歌也显示出来，让同学知道这里能放自己的歌
        if(cat.id==='user'){
          const head=document.createElement('div');
          head.className='song-cat-head';
          const tip=!serverOn ? '点上方「临时歌曲」选一首本地音乐，分析完就能玩（刷新页面会消失）'
            : (USER_SONGS.loadError ? '未连接班级服务器，暂时读不到曲库' : '还没有作品，点上方「上传歌曲」当第一个 DJ！');
          head.innerHTML=`<span class="sc-name">${cat.name}</span><span class="sc-tip">${tip}</span>`;
          sg.appendChild(head);
        }
        return;
      }
      // 分类小标题（网页版时"班级自制"改叫"临时歌曲"）
      const catName=(cat.id==='user'&&!serverOn)?'🎲 临时歌曲':cat.name;
      const catTipText=(cat.id==='user'&&!serverOn)?'本地分析 · 刷新消失':cat.tip;
      const head=document.createElement('div');
      head.className='song-cat-head';
      head.innerHTML=`<span class="sc-name">${catName}</span><span class="sc-tip">${catTipText} · ${list.length} 首</span>`;
      sg.appendChild(head);
      // 该分类下的歌曲卡片
      list.forEach(s=>{
        const b=document.createElement('button');
        b.className='theme-card'+(sel.song===s.id?' sel':'');
        b.style.background=`linear-gradient(135deg, #7a4dffcc, #36d1ffcc)`;
        b.innerHTML=`<div class="tname">🎵 ${s.name}</div><div class="tdesc">${s.artist} · ${s.bpm}BPM<br>${s.desc}</div>
          ${sel.song===s.id?'<span class="tag">✓ 已选</span>':''}
          ${cat.id==='user' && canDelete(s)?(s.temp?'<span class="song-del" title="移除（临时歌曲刷新也会消失）">🗑</span>':'<span class="song-regen" title="用最新算法重新生成曲谱">🔄</span><span class="song-del" title="删除这首歌">🗑</span>'):''}`;
        b.onclick=()=>{ sfxClick(); sel.song=s.id; renderPlay(); preloadSong(s); };
        if(cat.id==='user' && canDelete(s)){
          b.querySelector('.song-del').addEventListener('click',async ev=>{
            ev.stopPropagation();
            // 临时歌：直接从内存移除，不碰服务器
            if(s.temp){
              const yes=await askConfirm(`确定移除《${s.name}》吗？`, {yesText:'移除'});
              if(!yes) return;
              URL.revokeObjectURL(s.file);
              const i=TEMP_SONGS.indexOf(s); if(i>=0) TEMP_SONGS.splice(i,1);
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
  }
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
  $('setSpeed').value=String(d.speed);
  $('setQuality').value=String(d.quality);

  vol.oninput=()=>{ d.vol=vol.value/100; $('setVolV').textContent=vol.value+'%'; applyVolume(); Store.save(); };
  off.oninput=()=>{ d.offset=+off.value; $('setOffsetV').textContent=off.value+'ms'; Store.save(); };
  bpm.oninput=()=>{ d.bpm=+bpm.value; $('setBpmV').textContent=bpm.value; Store.save(); };
  $('setSfx').onchange=e=>{ d.sfx=+e.target.value; setSfxEnabled(!!d.sfx); Store.save(); };
  $('setSpeed').onchange=e=>{ d.speed=+e.target.value; Store.save(); };
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
      : '选一首本地音乐 → 浏览器自动分析节奏生成谱面 → 直接开跳。不会上传，刷新页面就消失';
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
    // ===== 网页版临时模式：不联网，直接内存建歌 =====
    if(!serverOn){
      const url=URL.createObjectURL(analyzed.file);
      const song={
        id:'temp'+Date.now(),
        name:title,
        artist:artistIn.value.trim()||'本地音乐',
        file:url,
        bpm:analyzed.bpm,
        desc:`${analyzed.notes.length} 音符 · ${fmtDur(analyzed.duration)} · ⏱临时`,
        cat:'user', user:true, temp:true,
        chart:analyzed.notes,
      };
      TEMP_SONGS.push(song);
      sel.song=song.id;
      ov.classList.remove('on');
      reset();
      toast('🎵 《'+title+'》准备好了，选好难度点「开始表演」！');
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
