// ============================================================
// main.js —— 程序入口 / 总调度
// 渲染器（开场+主舞台共用） → 开场动画 → 主舞台 → 渲染循环
// ============================================================
import * as THREE from 'three';
import { ensureCtx, Music, startMenuBgm, stopMenuBgm, setMenuBgmVolume, sfxClick, sfxBoing, sfxBoop, sfxEndVoice, sfxPokeVoice, sfxRandomVoice } from './audio.js?v=20261055';
import { runOpening, updateOpening, begin as beginOpening, Opening } from './opening.js?v=20261055';
import { loadDancer, updateDancer, setSkin, celebrate, lieDown, resetBody, Dancer } from './dancer.js?v=20261055';
import { initFx, updateFx, Fx, burst } from './fx.js?v=20260929r';
import { Game, startGame, stopGame, pauseGame, resumeGame, hitLane, launchFromGate } from './game.js?v=20261055';
import { THEMES, SKINS, SONGS, initUI, showUIRoot, showStageUI, showScreen, showResult, showEndlessResult,
         checkAch, getSelection, toast, renderHome, Store, getSongById, ensureChart } from './ui.js?v=20261055';

const $=id=>document.getElementById(id);
let stageGateBound=false;    // 「点我开演」闸门按钮只绑定一次

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
let stageGroup=null, curTheme=THEMES[0];
let keyLight=null, lampL=null, lampR=null, floorMesh=null, ringMesh=null;

function buildStage(theme){
  curTheme=theme;
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
  scene.background=new THREE.Color(theme.bg);
  scene.fog=new THREE.Fog(theme.bg, theme.fog[0], theme.fog[1]);

  // ---- 圆形舞池地板 ----
  floorMesh=new THREE.Mesh(
    new THREE.CircleGeometry(5.2,72),
    new THREE.MeshStandardMaterial({color:theme.floor,roughness:0.55,metalness:0.35})
  );
  floorMesh.rotation.x=-Math.PI/2;
  floorMesh.receiveShadow=true;
  stageGroup.add(floorMesh);

  // 发光边缘环
  ringMesh=new THREE.Mesh(
    new THREE.RingGeometry(5.06,5.2,72),
    new THREE.MeshBasicMaterial({color:theme.ring,side:THREE.DoubleSide})
  );
  ringMesh.rotation.x=-Math.PI/2;
  ringMesh.position.y=0.012;
  stageGroup.add(ringMesh);

  // 内圈舞池刻线（十字放射线）
  for(let i=0;i<8;i++){
    const line=new THREE.Mesh(
      new THREE.PlaneGeometry(0.06,4.6),
      new THREE.MeshBasicMaterial({color:theme.ring,transparent:true,opacity:0.16})
    );
    line.rotation.x=-Math.PI/2;
    line.rotation.z=i*Math.PI/8;
    line.position.y=0.008;
    stageGroup.add(line);
  }

  // ---- 背景板 ----
  if(theme.sky==='city'){
    // 城市剪影楼群
    for(let i=0;i<11;i++){
      const h=2+Math.random()*4.5, w=1+Math.random()*1.4;
      const b=new THREE.Mesh(
        new THREE.BoxGeometry(w,h,0.6),
        new THREE.MeshStandardMaterial({color:0x0e0820,roughness:0.9,
          emissive:i%2?theme.c1:theme.c2, emissiveIntensity:0.05})
      );
      b.position.set(-11+i*2.2+(Math.random()-0.5), h/2-0.5, -9.5-Math.random()*2);
      stageGroup.add(b);
    }
  }else if(theme.sky==='sunset'){
    // 落日圆盘 + 楼群
    const sun=new THREE.Mesh(
      new THREE.CircleGeometry(2.6,48),
      new THREE.MeshBasicMaterial({color:0xffa751,transparent:true,opacity:0.85})
    );
    sun.position.set(0,2.6,-13);
    stageGroup.add(sun);
    for(let i=0;i<9;i++){
      const h=1.5+Math.random()*3.5;
      const b=new THREE.Mesh(new THREE.BoxGeometry(1.3,h,0.6),
        new THREE.MeshBasicMaterial({color:0x241028}));
      b.position.set(-9+i*2.3, h/2-0.6, -10);
      stageGroup.add(b);
    }
  }else if(theme.sky==='stars'){
    // 星空 + 带环行星
    const N=260, P=new Float32Array(N*3);
    for(let i=0;i<N;i++){
      const r=16+Math.random()*14, a=Math.random()*Math.PI*2, y=Math.random()*14-2;
      P[i*3]=Math.cos(a)*r; P[i*3+1]=y; P[i*3+2]=Math.sin(a)*r-6;
    }
    const sg=new THREE.BufferGeometry();
    sg.setAttribute('position',new THREE.BufferAttribute(P,3));
    stageGroup.add(new THREE.Points(sg,new THREE.PointsMaterial({color:0xffffff,size:0.09})));
    const planet=new THREE.Mesh(new THREE.SphereGeometry(1.1,32,32),
      new THREE.MeshStandardMaterial({color:0x7a4dff,roughness:0.5,emissive:0x7a4dff,emissiveIntensity:0.25}));
    planet.position.set(-6.5,4.5,-10);
    const pring=new THREE.Mesh(new THREE.RingGeometry(1.5,2.1,48),
      new THREE.MeshBasicMaterial({color:0x36d1ff,side:THREE.DoubleSide,transparent:true,opacity:0.6}));
    pring.rotation.x=1.2; pring.position.copy(planet.position);
    stageGroup.add(planet,pring);
  }

  // ---- 灯光（环境光全局只建一次；主光挂在舞台组随主题重建）----
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

  // 舞台特效（轨道灯/迪斯科球/扫描灯，只在首次初始化）
  if(!Fx.ready) initFx(scene,camera);
  Fx.camBase.copy(CAM_HOME);
}

// ============================================================
// 舞者：后台预载 rigged.glb（页面一打开就开始，与开场并行）
// ============================================================
console.log('%c========== 奶娃街舞 · 启动 ==========', 'color:#ffe17a;font-size:14px;font-weight:bold');
console.log('[启动] ① 后台开始下载舞者模型 rigged.glb（17MB）…');
const tBoot0=performance.now();
const dancerReady=new Promise((res)=>{
  loadDancer('rigged.glb').then(()=>{
    scene.add(Dancer.root);
    // 应用已装备涂装
    const sk=SKINS.find(s=>s.id===Store.data.equipped)||SKINS[0];
    setSkin(sk);
    console.log(`%c[启动] ✓ 舞者模型就位并完成部位切分 (${((performance.now()-tBoot0)/1000).toFixed(2)}s)`, 'color:#7fffd4;font-weight:bold');
    res(true);
  }).catch(e=>{
    console.error('[启动] ❌ 舞者模型加载失败（不阻塞进游戏）：', e);
    res(false);
  });
});
addEventListener('dancer-progress',e=>{
  const pct=e.detail;
  // 舞者下载占进度条 5%~60% 区间
  $('loadBar').style.width=Math.min(100,(5+pct*0.55))+'%';
  $('loadSub').textContent=`舞者模型下载中 ${pct}%`;
});

// 音乐就绪日志（不阻塞）
Music.el.addEventListener('canplaythrough', ()=>console.log('[启动] ✓ 背景音乐 music.mp3 已就绪'), {once:true});
Music.el.addEventListener('error', ()=>console.warn('[启动] ⚠ 背景音乐 music.mp3 加载失败，游戏可照常进行'), {once:true});

// ============================================================
// 主程序接口（注入给 ui.js）
// ============================================================
const main={
  switchTheme(id){
    const t=THEMES.find(t=>t.id===id); if(t) buildStage(t);
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
    const theme=THEMES.find(t=>t.id===themeId);
    if(theme && theme.id!==curTheme.id) buildStage(theme);
    const set=Store.data.set;
    const bpm=song.bpm||set.bpm;          // 优先用歌曲自带 BPM
    showUIRoot(false);
    showStageUI(true);
    camera.position.copy(CAM_PLAY);
    Fx.camBase.copy(CAM_PLAY);
    resetBody();               // ★ 开演前复位奶蛙（清上局躺地/庆祝残留）
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
    // defer=true：只搭台不开播；startCountdown 倒计时归零后自动开播
    startGame({diff:diffId, bpm, offset:set.offset, speed:set.speed, duration:dur, songId:song.id, songName:song.name, chart}, true);
    startCountdown();
  },
  resume(){ resumeGame(); $('pauseOv').classList.remove('on'); },
  quitShow(){
    stopGame(false);
    showStageUI(false);
    showUIRoot(true);           // ★ 退出演出必须恢复主界面（之前漏了）
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
  const gate=$('stageGate'), btn=$('stageGateBtn'), sub=$('stageGateSub');
  gate.classList.add('on');
  btn.classList.add('counting');
  btn.disabled=true;
  let n=3;
  btn.textContent=n;
  sub.textContent='准备好，马上开跳';
  countTimer=setInterval(async ()=>{
    n--;
    if(n>0){
      btn.textContent=n;
      // 重触发弹出动画：先摘掉样式再强制回流，再挂回去
      btn.classList.remove('counting'); void btn.offsetWidth; btn.classList.add('counting');
      return;
    }
    clearInterval(countTimer); countTimer=null;
    btn.classList.remove('counting');
    if(!Game.playing) return;          // 极端情况：倒计时中演出已取消 → 不再开播
    const ok=await launchFromGate();   // 桌面浏览器：自动开播
    if(!ok){                            // 手机浏览器拦截自动播放：按钮留作兜底，亲手点一下
      btn.disabled=false;
      btn.textContent='▶ 点我开演';
      sub.textContent='手机要求音乐由你亲手点开';
    }
  },1000);
}

// 兜底点击：正常流程倒计时会自动开播，无需点；仅手机拦截自动播放时才用到
$('stageGateBtn').addEventListener('click', async ()=>{
  ensureCtx();
  sfxClick();
  const btn=$('stageGateBtn');
  btn.disabled=true;
  const ok=await launchFromGate();
  if(!ok) btn.disabled=false;
});

// ============================================================
// 演出结束回调：结算 + 存档 + 成就
// ============================================================
function onShowEnd(res){
  showStageUI(false);
  camera.position.copy(CAM_HOME);
  Fx.camBase.copy(CAM_HOME);
  const prevBest=Store.data.stats.bestRel||0;
  const isNew=res.rel>prevBest;
  showResult(res,isNew);            // ui 内部完成存档
  const got=checkAch();
  if(got.length) setTimeout(()=>toast('🏆 成就达成：'+got.map(g=>g.name).join('、')),600);
  if(res.acc>=0.8) celebrate();    // ★ 赢了：蹦跳庆祝
  else lieDown();                  // ★ 输了：躺地上
  showUIRoot(true);
  startMenuBgm();                   // 演出结束回到结算页：恢复菜单 BGM
  // ★ 每局结束必播结束语音（稍延迟，等页面切稳）
  setTimeout(()=>sfxEndVoice(), 500);
}

// ♾ 无尽结束回调（❤ 打光）：结算累计总分 + 上传无尽榜
function onEndlessOver(res){
  showStageUI(false);
  camera.position.copy(CAM_HOME);
  Fx.camBase.copy(CAM_HOME);
  showEndlessResult(res);           // ui 内部完成存档 + 自动上传无尽榜
  lieDown();                        // ❤ 打光：奶娃躺地上
  showUIRoot(true);
  startMenuBgm();
  setTimeout(()=>sfxEndVoice(), 500);
}

// ============================================================
// 输入绑定
// ============================================================
const KEYMAP={ArrowLeft:0,ArrowDown:1,ArrowUp:2,ArrowRight:3,KeyA:0,KeyS:1,KeyW:2,KeyD:3};
addEventListener('keydown',e=>{
  // 倒计时/闸门显示期间游戏还没真正开始：屏蔽游戏按键（防误判/误暂停）
  const gateOpen=$('stageGate').classList.contains('on');
  if(Game.playing && !gateOpen){
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
});

// 主界面点击奶娃 → 随机搞怪语音 + 轻微弹跳
renderer.domElement.addEventListener('pointerdown',()=>{
  if(!Game.playing){
    sfxPokeVoice();
    if(Dancer.body){
      const b=Dancer.body;
      b.scale.setScalar(1.15);
      setTimeout(()=>{ if(b) b.scale.setScalar(1); },120);
    }
  }
});

// ============================================================
// 启动序列（每一步都有日志，卡住时一眼能看到停在哪）
// ============================================================
console.log('[启动] ② 预加载背景音乐…');
Music.load();
console.log('[启动] ③ 搭建主舞台（灯光/地板/4 主题素材）…');
buildStage(THEMES[0]);
$('loadBar').style.width='5%';
console.log('[启动] ④ 初始化开场动画场景…');
runOpening(renderer, enterHome);

// 核心初始化已完成 → 点亮「开跳」按钮（无需等 17MB 模型下完）
const btnStart=$('loadStart');
btnStart.classList.remove('hidden');
btnStart.disabled=false;
$('loadTxt').textContent='准备好了吗？';
$('loadSub').textContent='点击按钮，欣赏开场（舞者模型在后台继续加载）';
console.log('%c[启动] ⑤ 初始化完成，「开跳」按钮已可点击 ✓', 'color:#7fffd4;font-weight:bold');

// 点击：解锁音频 → 收起加载遮罩 → 开始开场动画
btnStart.addEventListener('click', ()=>{
  console.log('%c[启动] 👆 用户点击「开跳」→ 解锁音频，开始开场动画', 'color:#36d1ff;font-weight:bold');
  ensureCtx();                        // ★ 首次用户手势内创建/恢复 AudioContext
  sfxClick();                         // 点击音效
  sfxBoing();                         // Q弹启动音效
  setMenuBgmVolume(Store.data.set.vol);
  $('loadOverlay').classList.add('hide');
  beginOpening();
}, {once:true});

// ---------- 开场结束 → 进入主界面 ----------
function enterHome(){
  console.log('%c[启动] ⑥ 开场动画播放完毕，准备进入主界面…', 'color:#36d1ff;font-weight:bold');
  // 最多等舞者 12 秒；超时也进，绝不再卡死加载页
  Promise.race([
    dancerReady,
    new Promise(r=>setTimeout(()=>{ console.warn('[启动] ⚠ 等待舞者超时，先进入主界面'); r(false); }, 12000)),
  ]).then(ok=>{
    console.log(ok?'[启动] ⑦ 进入主界面（舞者已在舞台上）':'[启动] ⑦ 进入主界面（舞者稍后自动出现）');
    $('loadBar').style.width='100%';
    showUIRoot(true);
    showScreen('scr-home');
    renderHome();
    setMenuBgmVolume(Store.data.set.vol);
    startMenuBgm();                   // ★ 进入主界面：启动菜单 BGM
    if(ok) burst(new THREE.Vector3(0,1.2,0.5), 0xffe17a, 70);
    else toast('舞者还在换装，马上就好…');
    // ★ 进主界面 2.5~5 秒后随机来一声搞怪语音
    setTimeout(()=>sfxRandomVoice(), 2500 + Math.random()*2500);
  });
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

  // 边缘环呼吸发光
  if(ringMesh) ringMesh.material.opacity=0.75+Math.sin(t*(dancing?6:2))*0.25;

  // 侧灯律动
  if(lampL){ lampL.intensity=2.0+Math.sin(t*3)*0.6; lampR.intensity=2.0+Math.cos(t*3)*0.6; }

  renderer.render(scene,camera);
}
loop();
