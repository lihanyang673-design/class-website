// ============================================================
// main.js —— 程序入口 / 总调度
// 渲染器（开场+主舞台共用） → 开场动画 → 主舞台 → 渲染循环
// ============================================================
import * as THREE from 'three';
import { ensureCtx, Music, startMenuBgm, stopMenuBgm, setMenuBgmVolume, sfxClick, sfxBoing, sfxBoop, sfxEndVoice, sfxPokeVoice, sfxRandomVoice } from './audio.js?v=20261009';
import { updateOpening, Opening } from './opening.js?v=20261009';
import { initDancerLayer, preloadDancers, updateDancer, selectDancer, setDancerMode,
         setSkin, celebrate, lieDown, resetBody, Dancer } from './dancer.js?v=20261009';
import { initFx, updateFx, Fx, burst } from './fx.js?v=20261009';
import { Game, startGame, stopGame, pauseGame, resumeGame, hitLane, beginPlayback } from './game.js?v=20261009';
import { THEMES, SKINS, SONGS, DIFFS, initUI, showUIRoot, showStageUI, showScreen, showResult, showEndlessResult,
         getSelection, toast, renderHome, Store, getSongById, getThemeById, ensureChart, stopPreview } from './ui.js?v=20261009';

const $=id=>document.getElementById(id);

// ============================================================
// 主页顶部滚动提示条（跑马灯）
// 想添加新的滚动文字：在下面 TICKER_TEXTS 数组里加一行字符串，再加上引号和逗号即可
// ============================================================
const TICKER_TEXTS=[
  '请多多看帮助哦，里面会有很多内容',
];
function renderTicker(){
  const track=$('htTrack');
  if(!track) return;
  const one=TICKER_TEXTS.map(t=>`<span class="ht-item">${t}</span>`).join('');
  track.innerHTML=one+one;   // 内容复制两份，配合 CSS 滚动 -50% 实现无缝循环
}
renderTicker();

// ============================================================
// 帮助页「常见问题」手风琴：同一时刻只展开一个问题
// 点问题 → 展开答案；点其他问题 → 上一个自动收起；再点已展开的问题 → 收起
// ============================================================
const faqList=$('faqList');
if(faqList){
  faqList.addEventListener('click',e=>{
    const q=e.target.closest('.faq-q');
    if(!q) return;
    const item=q.closest('.faq-item');
    const wasOpen=item.classList.contains('open');
    faqList.querySelectorAll('.faq-item.open').forEach(x=>x.classList.remove('open'));
    if(!wasOpen) item.classList.add('open');
  });
}

// ============================================================
// 渲染器 / 场景 / 相机
// ============================================================
const renderer=new THREE.WebGLRenderer({antialias:true});
renderer.setPixelRatio(Math.min(devicePixelRatio,2));
renderer.setSize(innerWidth,innerHeight);
renderer.shadowMap.enabled=true;
renderer.shadowMap.type=THREE.PCFSoftShadowMap;
renderer.outputColorSpace=THREE.SRGBColorSpace;
$('app').appendChild(renderer.domElement);

const scene=new THREE.Scene();
const camera=new THREE.PerspectiveCamera(45,innerWidth/innerHeight,0.1,100);
const CAM_HOME=new THREE.Vector3(0,2.1,5.4);       // 主界面机位
const CAM_PLAY=new THREE.Vector3(0,2.35,6.4);      // 演出机位（稍远稍高）
camera.position.copy(CAM_HOME);
const camTarget=new THREE.Vector3(0,1.05,0);

// ============================================================
// 主舞台搭建（按主题）
// ============================================================
// 默认舞池（含完整舞台字段，供图片主题做底板）
// ★ 必须写在上面：下面的 curTheme 初始值要用它；const 有暂时性死区，
//   先使用后声明会直接抛 ReferenceError，整个模块中断 → 黑屏（v20261201 踩过）
const DEFAULT_THEME={
  id:'default', name:'默认', desc:'',
  bg:0x1c1030, fog:[10,34], floor:0x2a1745, ring:0xff3b6b, c1:0xff3b6b, c2:0x36d1ff,
  lampA:1, lampB:1, sky:'city'
};

let stageGroup=null, curTheme=DEFAULT_THEME;
let keyLight=null, lampL=null, lampR=null, floorMesh=null;
let _trackLines=[];   // 演奏模式的四条轨道线（用于律动）
let _stageToken=0, _bgTex=null;   // 图片背景：异步加载令牌（防旧回调覆盖）+ 当前背景贴图（用于释放）

// 正方形背景布局：宽度铺满、顶部对齐，整张图完整落在屏幕上部（约屏幕上半）；
// 图片永远等比显示，人物不会被拉长。
// ★ 下方延伸不能直接靠纹理 ClampToEdge：它逐列夹取底边像素，底边颜色一杂，
//   下方就变成一条条彩色竖条（v20261208 bug）。所以图片先经 bakeBgCanvas 烘焙，
//   下半改为底部条带重度模糊后铺满——颜色仍取自图片，但平滑无条纹。
// 烘焙画布 2:1：上半（v∈0.5~1）= 图片；下半（v∈0~0.5）= 模糊延伸。
function bakeBgCanvas(img){
  const iw=img.width||img.naturalWidth, ih=img.height||img.naturalHeight;
  const CW=1024, HALF=1024, CH=2048;
  const cv=document.createElement('canvas'); cv.width=CW; cv.height=CH;
  const ctx=cv.getContext('2d');

  // 1) 延伸色：取图片底部 1/8 条带压到 32×8，读出整体平均色 → 纯色填充。
  //    必须是单一颜色：模糊缩小对"小图+强对比底边"仍会留下可辨色带，纯色才能保证零条纹、各浏览器一致
  const stripH=Math.max(1,Math.round(ih/8));
  const tiny=document.createElement('canvas'); tiny.width=32; tiny.height=8;
  tiny.getContext('2d').drawImage(img,0,ih-stripH,iw,stripH,0,0,32,8);
  const td=tiny.getContext('2d').getImageData(0,0,32,8).data;
  let tr=0,tg=0,tb=0,tn=0;
  for(let i=0;i<td.length;i+=4){tr+=td[i];tg+=td[i+1];tb+=td[i+2];tn++;}
  ctx.fillStyle=`rgb(${tr/tn|0},${tg/tn|0},${tb/tn|0})`;
  // 向上多盖 56px 与图片重叠，接缝才能融合
  ctx.fillRect(0,HALF-56,CW,CH-HALF+56);

  // 2) 下半叠透明→深黑渐变，底部更沉稳
  const g=ctx.createLinearGradient(0,HALF,0,CH);
  g.addColorStop(0,'rgba(0,0,0,0)'); g.addColorStop(1,'rgba(0,0,0,.38)');
  ctx.fillStyle=g; ctx.fillRect(0,HALF,CW,CH-HALF);

  // 3) 上半画图片（cover 等比居中裁剪；裁剪图本身就是正方形）
  const sc=Math.max(CW/iw,HALF/ih), dw=iw*sc, dh=ih*sc;
  const top=document.createElement('canvas'); top.width=CW; top.height=HALF;
  const pctx=top.getContext('2d');
  pctx.drawImage(img,(CW-dw)/2,(HALF-dh)/2,dw,dh);
  // 底部 56px 渐隐为透明 → 和下面重叠的模糊延伸平滑相接
  pctx.globalCompositeOperation='destination-out';
  const fg=pctx.createLinearGradient(0,HALF-56,0,HALF);
  fg.addColorStop(0,'rgba(0,0,0,0)'); fg.addColorStop(1,'rgba(0,0,0,1)');
  pctx.fillStyle=fg; pctx.fillRect(0,HALF-56,CW,56);
  ctx.drawImage(top,0,0);
  return cv;
}

// 把"图片区 v∈0.5~1"摆到屏幕上部正方形区域；其余屏幕位置落到烘焙好的模糊延伸区
function layoutBgTex(tex){
  const sa=innerWidth/innerHeight;                  // 屏幕宽高比（竖屏<1）
  if(sa<=1){
    // 竖屏：屏幕 uv∈[1-sa,1] ↔ 图片 v∈[0.5,1]；屏幕底部 v<0.5 为模糊延伸
    tex.repeat.set(1, 0.5/sa);
    tex.offset.set(0, 1-0.5/sa);
  }else{
    // 横屏：纵向显示图片区；水平居中正方形，两侧夹取图片边缘
    tex.repeat.set(sa, 0.5);
    tex.offset.set((1-sa)/2, 0.5);
  }
}

// ============================================================
// 主舞台搭建（按主题 + 模式）
// mode: 'home' 主界面（无舞台，只有背景图+灯光） | 'play' 演奏（简约深色舞台）
// ============================================================
function buildStage(theme, mode='home'){
  curTheme=theme;
  const token=++_stageToken;
  const hasImg=!!theme.bgImage;
  // 图片主题：只换背景，灯光颜色等缺失字段沿用默认舞池
  if(hasImg) theme={...DEFAULT_THEME, ...theme};
  // 清理旧舞台
  if(stageGroup){
    stageGroup.traverse(n=>{
      if(n.isMesh){ n.geometry.dispose(); (Array.isArray(n.material)?n.material:[n.material]).forEach(m=>m.dispose()); }
    });
    scene.remove(stageGroup);
  }
  stageGroup=new THREE.Group();
  scene.add(stageGroup);

  // 背景与雾
  if(_bgTex){ _bgTex.dispose(); _bgTex=null; }
  if(hasImg){
    scene.background=null;
    // 图片异步加载；令牌过期（已切换到别的舞池）就直接丢弃，不覆盖
    new THREE.TextureLoader().load(curTheme.bgImage, raw=>{
      if(token!==_stageToken){ raw.dispose(); return; }
      let tex;
      try{
        tex=new THREE.CanvasTexture(bakeBgCanvas(raw.image));   // 烘焙：下方模糊延伸，杜绝竖条
        raw.dispose();
      }catch(e){
        console.warn('背景烘焙失败，改用原图',e); tex=raw;      // 兜底：烘焙失败不致黑屏
      }
      tex.colorSpace=THREE.SRGBColorSpace;
      layoutBgTex(tex);
      _bgTex=tex; scene.background=tex;
    });
    scene.fog=new THREE.Fog(DEFAULT_THEME.bg, DEFAULT_THEME.fog[0], DEFAULT_THEME.fog[1]);
  }else{
    scene.background=new THREE.Color(theme.bg);
    scene.fog=new THREE.Fog(theme.bg, theme.fog[0], theme.fog[1]);
  }

  // 灯光（主界面/演奏共用，照亮舞者）
  if(!scene.userData.ambient){
    const amb=new THREE.AmbientLight(0xffffff,0.55);
    scene.add(amb);
    scene.userData.ambient=amb;
  }
  keyLight=new THREE.DirectionalLight(0xffffff,1.15);
  keyLight.position.set(4,7,5);
  keyLight.castShadow=true;
  keyLight.shadow.mapSize.set(1024,1024);
  keyLight.shadow.camera.near=1; keyLight.shadow.camera.far=25;
  keyLight.shadow.camera.left=-6; keyLight.shadow.camera.right=6;
  keyLight.shadow.camera.top=6;   keyLight.shadow.camera.bottom=-6;
  stageGroup.add(keyLight);
  lampL=new THREE.PointLight(theme.c1,2.2,15,1.8); lampL.position.set(-4,2.4,2.5);
  lampR=new THREE.PointLight(theme.c2,2.2,15,1.8); lampR.position.set( 4,2.4,2.5);
  stageGroup.add(lampL,lampR);

  // 主界面模式：不要任何舞台结构，只留背景+灯光
  if(mode==='home'){
    // 舞台特效（轨道灯/迪斯科球/扫描灯，只在首次初始化）
    if(!Fx.ready) initFx(scene,camera);
    Fx.camBase.copy(CAM_HOME);
    return;
  }

  // ========== 演奏模式：简约深色舞台（和主界面区分） ==========
  // 半透明深色地板（不抢背景图风头，铺满下半屏）
  floorMesh=new THREE.Mesh(
    new THREE.PlaneGeometry(16,10),
    new THREE.MeshStandardMaterial({color:0x0d0818,roughness:0.8,metalness:0.1,transparent:true,opacity:0.85})
  );
  floorMesh.rotation.x=-Math.PI/2;
  floorMesh.position.y=0;
  floorMesh.position.z=-1;
  floorMesh.receiveShadow=true;
  stageGroup.add(floorMesh);

  // 四条轨道竖线：与 DOM 轨道对齐（11%/36%/61%/86%），考虑透视和 16 度倾斜
  _trackLines=[];
  const laneX=[-2.6, -0.87, 0.87, 2.6];  // 近似对齐 DOM 轨道中心
  for(let i=0;i<4;i++){
    const track=new THREE.Mesh(
      new THREE.PlaneGeometry(0.06,8),
      new THREE.MeshBasicMaterial({color:theme.c2,transparent:true,opacity:0.35})
    );
    track.rotation.x=-Math.PI/2;
    track.position.set(laneX[i], 0.005, -0.5);
    stageGroup.add(track);
    _trackLines.push(track);
  }

  // 舞台特效（轨道灯/迪斯科球/扫描灯，只在首次初始化）
  if(!Fx.ready) initFx(scene,camera);
  Fx.camBase.copy(CAM_HOME);
}

// ============================================================
// 舞者：后台预载【奶蛙 + 疯狂的兔子】（页面一打开就开始，与开场并行）
// ============================================================
console.log('%c========== 蛙步 · 启动 ==========', 'color:#ffe17a;font-size:14px;font-weight:bold');
console.log('[启动] ① 后台开始预载双舞者（奶蛙 rigged.glb 17MB + 兔子程序化建模）…');
const tBoot0=performance.now();
scene.add(initDancerLayer());
const dancerReady=new Promise((res)=>{
  preloadDancers().then(()=>{
    // 按存档恢复上次选的舞者
    const saved=Store.data.dancer==='rabbit'?'rabbit':'frog';
    selectDancer(saved);
    setDancerMode('home');      // 主页只显示存档选中的角色
    // 应用已装备涂装（仅奶蛙）
    const sk=SKINS.find(s=>s.id===Store.data.equipped)||SKINS[0];
    setSkin(sk);
    console.log(`%c[启动] ✓ 双舞者就位 (${((performance.now()-tBoot0)/1000).toFixed(2)}s)，当前：${saved}`, 'color:#7fffd4;font-weight:bold');
    res(true);
  }).catch(e=>{
    console.error('[启动] ❌ 舞者预载失败（不阻塞进游戏）：', e);
    res(false);
  });
});

// 音乐就绪日志（不阻塞）
Music.el.addEventListener('canplaythrough', ()=>console.log('[启动] ✓ 背景音乐 music.mp3 已就绪'), {once:true});
Music.el.addEventListener('error', ()=>console.warn('[启动] ⚠ 背景音乐 music.mp3 加载失败，游戏可照常进行'), {once:true});

// ============================================================
// 主程序接口（注入给 ui.js）
// ============================================================
const main={
  switchTheme(id){
    buildStage(getThemeById(id), 'home');
  },
  applySkin(sk){ setSkin(sk); },
  applyQuality(q){
    renderer.setPixelRatio(q>=2?Math.min(devicePixelRatio,2):q);
  },
  async startShow(themeId,diffId,songId){
    ensureCtx();
    stopMenuBgm();              // 开演：停菜单 BGM，交由歌曲
    // 点开始后舞台中央倒计时 3、2、1，归零才开演（这3秒浏览器顺便缓冲歌曲）
    const song=getSongById(songId)||SONGS[0];
    Music.setSong(song.file);
    const theme=getThemeById(themeId);
    // 演奏模式：无论主题是否切换，都重建为演奏舞台（主界面是无舞台的）
    buildStage(theme, 'play');
    const set=Store.data.set;
    const bpm=song.bpm||set.bpm;          // 优先用歌曲自带 BPM
    showUIRoot(false);
    showStageUI(true);
    camera.position.copy(CAM_PLAY);
    Fx.camBase.copy(CAM_PLAY);
    setDancerMode('play');     // 演出：只留被选中的角色，走到舞台中央
    resetBody();               // ★ 开演前复位（清上局躺地/庆祝残留）
    Game.hooks.onEnd=onShowEnd;
    Game.hooks.onEndlessEnd=onEndlessOver;
    // 拿到歌曲真实时长（很快，元数据选歌时一般已就绪）
    const dur = await Music.awaitDuration(3000);
    // 玩家自制歌曲：拉取存库谱面；失败则用程序生成谱面兜底
    let chart=null;
    try{ chart=await ensureChart(song); }
    catch(e){ console.warn('[演出] 谱面加载失败，退回程序生成谱面', e); }
    // 演出中渲染分辨率封顶1.5：高画质手机每帧要算的像素减少约4成，3D只是背景肉眼几乎无差；退出时恢复
    if(renderer.getPixelRatio() > 1.5) renderer.setPixelRatio(1.5);
    stopPreview();   // 正在试听就先停掉、进度归零，避免和演出音乐冲突
    // 只搭台不开播；startCountdown 倒计时归零后自动开播
    startGame({diff:diffId, bpm, offset:set.offset, speed:set.speed, duration:dur, songId:song.id, songName:song.name, chart});
    // 倒计时界面显示本场信息
    const diff=DIFFS.find(d=>d.id===diffId);
    const notes=chart&&chart.notes?chart.notes.length:0;
    const mm=Math.floor(dur/60), ss=Math.floor(dur%60).toString().padStart(2,'0');
    $('countInfo').innerHTML=
      `<div class="ci-song">${song.name}${song.artist?` · ${song.artist}`:''}</div>
       <div class="ci-line">🎵 ${theme?theme.name:'默认舞池'}　🎯 ${diff?diff.name:diffId}</div>
       <div class="ci-meta">BPM <b>${bpm}</b>　时长 <b>${mm}:${ss}</b>　音符 <b>${notes}</b></div>`;
    startCountdown();
  },
  resume(){ resumeGame(); $('pauseOv').classList.remove('on'); },
  showNotice(){ showNoticeIfNeeded(true); },   // 主页强制展示公告
  chooseDancer(id){                            // 选择舞者页选定后调用
    selectDancer(id);
    setDancerMode(Dancer.mode);                // 立刻切换显示（主页背景随之换角色）
  },
  quitShow(){
    stopGame(false);
    showStageUI(false);
    showUIRoot(true);           // ★ 退出演出必须恢复主界面（之前漏了）
    buildStage(curTheme, 'home');  // 切回主界面：无舞台模式
    setDancerMode('home');     // 两个角色重新同台
    camera.position.copy(CAM_HOME);
    Fx.camBase.copy(CAM_HOME);
    const q=Store.data.set.quality;   // ★ 恢复主界面的渲染分辨率
    renderer.setPixelRatio(q>=2?Math.min(devicePixelRatio,2):q);
    startMenuBgm();             // 回到菜单：恢复 BGM
  },
};
initUI(main);

// ============================================================
// 开局倒计时：舞台中央 3、2、1，归零自动开播
// ============================================================
let countTimer=null;    // 句柄持久化：重开前先清旧计时，防止多个倒计时叠加
function startCountdown(){
  clearInterval(countTimer);
  const ov=$('countOverlay'), num=$('countNum');
  ov.classList.add('on');
  let n=3;
  num.textContent=n;
  countTimer=setInterval(()=>{
    n--;
    if(n>0){
      num.textContent=n;
      // 重触发弹出动画：清掉动画→强制回流→重新挂上
      num.style.animation='none'; void num.offsetWidth; num.style.animation='';
      return;
    }
    clearInterval(countTimer); countTimer=null;
    if(!Game.playing) return;          // 极端情况：倒计时中演出已取消 → 不再开播
    ov.classList.remove('on');
    // 倒计时归零直接开播；浏览器拒绝播放时（极少数手机浏览器）提示重开
    beginPlayback(!!Game.endless).then(ok=>{
      if(!ok) toast('音乐启动失败，请退出后重新点「开始表演」');
    });
  },1000);
}

// ============================================================
// 演出结束回调：结算 + 存档 + 成就
// ============================================================
function onShowEnd(res){
  showStageUI(false);
  showUIRoot(true);                  // ★ 先恢复主界面容器，再切结算页
  camera.position.copy(CAM_HOME);
  Fx.camBase.copy(CAM_HOME);
  const prevBest=Store.data.stats.bestRel||0;
  const isNew=res.rel>prevBest;
  showResult(res,isNew);            // ui 内部完成存档 + showScreen('scr-result')
  if(res.acc>=0.8) celebrate();    // ★ 赢了：蹦跳庆祝
  else lieDown();                  // ★ 输了：躺地上
  startMenuBgm();                   // 演出结束回到结算页：恢复菜单 BGM
  // ★ 每局结束必播结束语音（稍延迟，等页面切稳）
  setTimeout(()=>sfxEndVoice(), 500);
}

// ♾ 无尽结束回调（❤ 打光）：结算累计总分 + 上传无尽榜
function onEndlessOver(res){
  showStageUI(false);
  showUIRoot(true);                  // ★ 先恢复主界面容器，再切结算页
  camera.position.copy(CAM_HOME);
  Fx.camBase.copy(CAM_HOME);
  showEndlessResult(res);           // ui 内部完成存档 + 自动上传无尽榜
  lieDown();                        // ❤ 打光：蛙躺地上
  startMenuBgm();
  setTimeout(()=>sfxEndVoice(), 500);
}

// ============================================================
// 输入绑定
// ============================================================
const KEYMAP={ArrowLeft:0,ArrowDown:1,ArrowUp:2,ArrowRight:3,KeyA:0,KeyS:1,KeyW:2,KeyD:3};
addEventListener('keydown',e=>{
  // 倒计时显示期间游戏还没真正开始：屏蔽游戏按键（防误判/误暂停）
  const counting=$('countOverlay').classList.contains('on');
  if(Game.playing && !counting){
    if(e.code in KEYMAP){ e.preventDefault(); if(!e.repeat) hitLane(KEYMAP[e.code]); }
    else if(e.code==='Escape'||e.code==='KeyP'){
      e.preventDefault();
      if(Game.paused){ main.resume(); }
      else{ pauseGame(); $('pauseOv').classList.add('on'); }
    }
  }
});
// 手机触控
document.querySelectorAll('#touchPads button').forEach(b=>{
  const lane=+b.dataset.l;
  b.addEventListener('pointerdown',e=>{ e.preventDefault(); hitLane(lane); });
});
addEventListener('resize',()=>{
  camera.aspect=innerWidth/innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth,innerHeight);
  // 当前是图片背景：按新的屏幕比例重新布局，保持不变形
  if(_bgTex) layoutBgTex(_bgTex);
});

// 主界面点击蛙 → 随机搞怪语音 + 轻微弹跳
renderer.domElement.addEventListener('pointerdown',()=>{
  if(!Game.playing){
    sfxPokeVoice();
    const b=Dancer.chars[Dancer.selected]?.body;
    if(b){
      b.scale.setScalar(1.15);
      setTimeout(()=>{ b.scale.setScalar(1); },120);
    }
  }
});

// ============================================================
// 启动序列（无加载遮罩，直接进主界面）
// ============================================================
console.log('[启动] ② 预加载背景音乐…');
Music.load();
console.log('[启动] ③ 搭建主舞台（灯光/地板/主题素材）…');
buildStage(DEFAULT_THEME);
console.log('%c[启动] ④ 初始化完成，直接进入主界面 ✓', 'color:#7fffd4;font-weight:bold');

// 无加载遮罩，直接进主界面
enterHome();

// ---------- 进入主界面 ----------
function enterHome(){
  console.log('%c[启动] ⑥ 进入主界面', 'color:#36d1ff;font-weight:bold');
  // 最多等舞者 12 秒；超时也进，绝不再卡死加载页
  let danced=false;   // 舞者是否已就绪（race 输了之后 setTimeout 仍会触发，用标志位防止误报超时）
  Promise.race([
    dancerReady.then(ok=>{ danced=true; return ok; }),
    new Promise(r=>setTimeout(()=>{ if(!danced) console.warn('[启动] ⚠ 等待舞者超时，先进入主界面'); r(false); }, 12000)),
  ]).then(ok=>{
    console.log(ok?'[启动] ⑦ 进入主界面（舞者已在舞台上）':'[启动] ⑦ 进入主界面（舞者稍后自动出现）');
    showUIRoot(true);
    showScreen('scr-home');
    renderHome();
    setTimeout(showNoticeIfNeeded, 600);  // ★ 主界面出来后弹公告（延迟一点更自然）
    setMenuBgmVolume(Store.data.set.vol);
    startMenuBgm();                   // ★ 进入主界面：启动菜单 BGM
    if(ok) burst(new THREE.Vector3(0,1.2,0.5), 0xffe17a, 70);
    else toast('舞者还在换装，马上就好…');
    // ★ 进主界面 2.5~5 秒后随机来一声搞怪语音
    setTimeout(()=>sfxRandomVoice(), 2500 + Math.random()*2500);
  });
}

// ---------- 公告弹窗 ----------
const NOTICE_VER='7';   // 公告版本号：每次更换公告内容/样式就 +1，当天勾选过「不再弹出」的同学也会重新看到新公告

// 一键复制：优先现代 clipboard API；QQ/微信等旧内核浏览器用 textarea+execCommand 兜底
async function copyText(t){
  try{ await navigator.clipboard.writeText(t); return true; }
  catch(e){
    const ta=document.createElement('textarea');
    ta.value=t; ta.style.position='fixed'; ta.style.opacity='0';
    document.body.appendChild(ta); ta.focus(); ta.select();
    let ok=false;
    try{ ok=document.execCommand('copy'); }catch(_){}
    ta.remove();
    return ok;
  }
}
// 复制按钮事件委托（只绑一次）：成功显示「✅ 已复制」，1.6 秒后恢复
$('noticeOv').addEventListener('click', async e=>{
  const b=e.target.closest('.notice-copy');
  if(!b) return;
  const old=b.textContent;
  const ok=await copyText(b.dataset.copy);
  b.textContent= ok?'✅ 已复制':'❌ 复制失败';
  setTimeout(()=>{ b.textContent=old; }, 1600);
});

function showNoticeIfNeeded(force){
  const n=new Date();
  const today=n.getFullYear()+'-'+(n.getMonth()+1)+'-'+n.getDate();
  if(!force && localStorage.getItem('naiwa_step_notice_hide')===today+'|'+NOTICE_VER) return;  // 当天+同版本已关闭 → 不弹
  const ov=$('noticeOv');
  $('noticeHideToday').checked=false;
  ov.classList.add('on');
  const close=()=>{
    if($('noticeHideToday').checked) localStorage.setItem('naiwa_step_notice_hide', today+'|'+NOTICE_VER);
    ov.classList.remove('on');
  };
  $('noticeOk').onclick=close;
  $('noticeX').onclick=close;
}

// ============================================================
// 渲染主循环
// ============================================================
const clock=new THREE.Clock();
let lastBeat=0;

function loop(){
  requestAnimationFrame(loop);
  const dt=Math.min(clock.getDelta(),0.05);
  const now=performance.now();
  const t=clock.elapsedTime;

  // ---------- 开场动画分支 ----------
  if(Opening.active){ updateOpening(dt,now); return; }

  // ---------- 主舞台 ----------
  const dancing=Game.playing&&!Game.paused;
  const bpm=Store.data.set.bpm;

  updateDancer(dt,bpm,dancing);

  // 节拍脉冲（给 Fx 做镜头心跳）
  let beat=false;
  if(Game.playing){
    const bi=Math.floor(Music.time()*bpm/60);
    if(bi!==lastBeat){ lastBeat=bi; beat=true; }
  }
  updateFx(dt,t,curTheme,dancing,beat);

  // 主界面待机：镜头轻微呼吸环绕；演出中：Fx 接管 z 轴脉冲
  if(!Game.playing){
    camera.position.x+=((CAM_HOME.x+Math.sin(t*0.25)*0.55)-camera.position.x)*dt*2;
    camera.position.y+=(CAM_HOME.y-camera.position.y)*dt*2;
    camera.position.z+=(CAM_HOME.z-camera.position.z)*dt*2;
    camera.lookAt(camTarget);
  }else{
    camera.position.x+=(CAM_PLAY.x-camera.position.x)*dt*4;
    camera.position.y+=(CAM_PLAY.y-camera.position.y)*dt*4;
    camera.lookAt(camTarget.x,0.9,0);
  }

  // 轨道线呼吸发光（演奏模式）
  for(let i=0;i<_trackLines.length;i++){
    _trackLines[i].material.opacity=0.2+Math.sin(t*(dancing?6:2)+i)*0.15;
  }

  // 侧灯律动
  if(lampL){ lampL.intensity=2.0+Math.sin(t*3)*0.6; lampR.intensity=2.0+Math.cos(t*3)*0.6; }

  renderer.render(scene,camera);
}
loop();
