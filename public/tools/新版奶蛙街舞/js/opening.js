// ============================================================
// opening.js —— 开场动画
// 按用户要求：只保留两个 3D 奶娃模型按路径飞过，无任何特效（无拖尾/光带/闪光/粒子）
// 流程：
//  1. 简洁糖果渐变背景
//  2. baby1.glb 左上→右下、baby2.glb 右上→左下，干净飞过
//  3. 弹出「奶娃街舞」Q 弹标题 → 淡出 → 进主界面
// ============================================================
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { ensureCtx, sfxWhoosh, sfxBoop, sfxBoing, sfxOutro } from './audio.js?v=20261082';

export const Opening = { active:false };

// ---------- 模块内状态 ----------
let scene, cam, rendererRef, onDoneCb;
let flyers=[];
let started=false, finished=false, titleShown=false, fading=false;
let timeouts=[];
let t0=0;                       // 动画起始时刻

const $=id=>document.getElementById(id);

// ============================================================
// 工具
// ============================================================
function later(ms, fn){ timeouts.push(setTimeout(fn, ms)); }
function clearLater(){ timeouts.forEach(clearTimeout); timeouts=[]; }
const clamp01=v=>Math.max(0,Math.min(1,v));
const easeInOutSine=t=>-(Math.cos(Math.PI*t)-1)/2;

// 二次贝塞尔
function bez(p0,p1,p2,t,out){
  const a=(1-t)*(1-t), b=2*(1-t)*t, c=t*t;
  out.set(a*p0.x+b*p1.x+c*p2.x, a*p0.y+b*p1.y+c*p2.y, a*p0.z+b*p1.z+c*p2.z);
  return out;
}

// ============================================================
// 背景：纯糖果渐变（无光芒、无粒子，干净）
// ============================================================
function gradTexture(){
  const c=document.createElement('canvas'); c.width=c.height=512;
  const g=c.getContext('2d');
  const lg=g.createLinearGradient(0,0,512,512);
  lg.addColorStop(0,'#ff6b9d');    // 奶粉红
  lg.addColorStop(0.5,'#ffa751');  // 活力橙
  lg.addColorStop(1,'#ffe17a');    // 奶黄
  g.fillStyle=lg; g.fillRect(0,0,512,512);
  const t=new THREE.CanvasTexture(c);
  t.colorSpace=THREE.SRGBColorSpace;
  return t;
}
function buildSky(){
  scene.background=gradTexture();
}

// ============================================================
// 加载两个 baby 模型并归一化
// ============================================================
function normalizeModel(gltf, targetH){
  const g=new THREE.Group();
  const box=new THREE.Box3().setFromObject(gltf.scene);
  const size=box.getSize(new THREE.Vector3());
  const cen=box.getCenter(new THREE.Vector3());
  gltf.scene.position.sub(cen);                 // 居中
  g.add(gltf.scene);
  g.scale.setScalar(targetH/size.y);            // 归一化身高
  return g;
}
function loadBabyLog(url, targetH){
  const t0=performance.now();
  console.log(`%c  ⏳ [加载] ${url} 开始下载…`, 'color:#c9b8e8');
  return new Promise((res,rej)=>{
    // ★ 20秒超时兜底：网络太慢下不完 → 放弃等模型，直接走标题动画进主界面（绝不卡死）
    const to=setTimeout(()=>rej(new Error('[开场] '+url+' 下载超时')), 20000);
    new GLTFLoader().load(
      url,
      g=>{
        clearTimeout(to);
        console.log(`%c  ✅ [加载] ${url} 完成 (${((performance.now()-t0)/1000).toFixed(2)}s)`, 'color:#7fffd4');
        res(normalizeModel(g,targetH));
      },
      undefined,
      err=>{ clearTimeout(to); console.error(`  ❌ [加载] ${url} 失败`, err); rej(err); }
    );
  });
}

// ============================================================
// 主入口
// ============================================================
export function runOpening(renderer, onDone){
  rendererRef=renderer;
  onDoneCb=onDone;
  scene=new THREE.Scene();
  cam=new THREE.PerspectiveCamera(45, innerWidth/innerHeight, 0.1, 100);
  cam.position.set(0,0,10);
  buildSky();
  Opening.active=true;

  console.log('%c[开场] 场景就绪，等待用户点击「开跳」…', 'color:#36d1ff;font-weight:bold');
  $('openingUI').classList.add('on');
  $('openSkip').classList.remove('on');
  $('openSkip').addEventListener('click', onSkip);
  addEventListener('resize', onResize);
}

function onResize(){
  if(cam){ cam.aspect=innerWidth/innerHeight; cam.updateProjectionMatrix(); }
}

// ---------- main.js 在「开跳」按钮点击时调用 ----------
export function begin(){
  if(started) return;
  started=true;
  onGateClick();
}

// ---------- 开场流程（无特效版）----------
async function onGateClick(){
  ensureCtx();
  $('openSkip').classList.add('on');
  console.log('%c[开场] ▶ 开始加载 baby1.glb / baby2.glb …', 'color:#ffe17a;font-weight:bold');

  try{
    const [b1,b2]=await Promise.all([
      loadBabyLog('baby1.glb',1.9),
      loadBabyLog('baby2.glb',1.9),
    ]);
    if(finished) return;                 // 等待期间被跳过就不再继续
    console.log('%c[开场] ✓ 两个奶娃加载完成，开始飞行', 'color:#7fffd4;font-weight:bold');

    t0=performance.now();

    // 可视范围
    const V=Math.tan(cam.fov*Math.PI/360)*cam.position.z;
    const VH=V*cam.aspect;
    const m=1.25;

    // 航线：左上→右下 / 右上→左下（干净飞过，无特效）
    flyers=[
      { model:b1,
        p0:new THREE.Vector3(-VH*m, V*0.9, 0),
        p1:new THREE.Vector3(0,       V*0.42, 0),
        p2:new THREE.Vector3( VH*0.62,-V*0.5, 0),
        start:0,   dur:1350, spin:-1, land:new THREE.Vector3( VH*0.62,-V*0.5,0) },
      { model:b2,
        p0:new THREE.Vector3( VH*m, V*0.9, 0),
        p1:new THREE.Vector3(0,     V*0.42, 0),
        p2:new THREE.Vector3(-VH*0.62,-V*0.5,0),
        start:350, dur:1350, spin:1,  land:new THREE.Vector3(-VH*0.62,-V*0.5,0) },
    ];
    flyers.forEach(f=>{
      f.model.position.copy(f.p0);
      f.landed=false; f.landT=0;
      f.normScale=f.model.scale.x;
      scene.add(f.model);
    });

    // ---- 音效（仅呼啸 + 落地，无交叉音）----
    later(0,   ()=>sfxWhoosh(-0.8, 0.8, 0.9));
    later(350, ()=>sfxWhoosh( 0.8,-0.8, 0.9));
    later(1350+480, ()=>sfxBoop(0,-0.5));
    later(1700+480, ()=>sfxBoop(0, 0.5));

    // ---- 标题（单色 Q 版：弹出→放大→缩小→淡出，一气呵成 2.2s）----
    later(2450, showTitle);
    later(2450+2100, sfxOutro);          // 标题淡出尾声音效
    later(2450+2300, finish);            // 标题动画结束 → 进主界面
  }catch(e){
    // ★ 模型下载失败/超时：也照常弹出「奶娃街舞」标题 → 进主界面（保证开场完整走完）
    console.error('[开场] ⚠ 模型未就绪（超时/失败），直接弹出标题进主界面', e);
    t0=performance.now();
    clearLater(); showTitle();
    later(2100, sfxOutro);
    later(2300, finish);
  }
}

// ---------- 标题弹出 ----------
function showTitle(){
  if(titleShown||finished) return;
  titleShown=true;
  const el=$('openTitle');
  el.style.opacity='1';
  el.classList.add('pop');
  sfxBoing();
}

// ---------- 淡出 ----------
function startFade(){
  if(fading||finished) return;
  fading=true;
  $('openTitle').classList.add('bye');
  sfxOutro();
}

// ---------- 跳过（★ 下载期间也有效，绝不让玩家被困在开场）----------
function onSkip(){
  if(!started||finished) return;
  if(!t0){                             // 模型还在下载中：立刻进主界面
    clearLater(); finish(); return;
  }
  if(!titleShown){
    clearLater(); showTitle();
    later(2100, sfxOutro);
    later(2300, finish);
  }else{
    clearLater(); finish();
  }
}

// ---------- 收尾 ----------
function finish(){
  if(finished) return;
  finished=true;
  clearLater();
  removeEventListener('resize', onResize);
  $('openSkip').removeEventListener('click', onSkip);
  $('openingUI').classList.remove('on');
  $('openTitle').className=''; $('openTitle').style.opacity='0';
  scene.traverse(n=>{
    if(n.isMesh){
      n.geometry && n.geometry.dispose();
      const m=n.material;
      if(Array.isArray(m)) m.forEach(x=>{x.map&&x.map.dispose();x.dispose();});
      else if(m){ m.map&&m.map.dispose(); m.dispose(); }
    }
  });
  Opening.active=false;
  onDoneCb && onDoneCb();
}

// ============================================================
// 每帧更新（仅模型飞行 + 落地，无特效）
// ============================================================
const _tmp=new THREE.Vector3();
export function updateOpening(dt, now){
  if(!scene) return;
  const t=now-t0;

  for(const f of flyers){
    if(!started){ continue; }
    const u=clamp01((t-f.start)/f.dur);
    if(u<1){
      bez(f.p0,f.p1,f.p2,easeInOutSine(u),_tmp);
      f.model.position.copy(_tmp);
      f.model.rotation.z=f.spin*(1-u)*(1-u)*5.5;   // 边飞边转
      f.model.rotation.y=Math.sin(u*9)*0.25;
      f.landT=0;
    }else if(!f.landed){
      f.landed=true;
      f.model.position.copy(f.land);
      f.model.rotation.z=0;
      f.landT=now;
    }
    // 落地后轻微弹跳
    if(f.landed && f.landT){
      const k=(now-f.landT)/500;
      if(k<1){
        const s=Math.exp(-4.5*k)*Math.cos(k*14);
        f.model.scale.setScalar(f.normScale*(1+s*0.22));
        f.model.scale.y*=1-s*0.3;
      }else{
        f.model.scale.setScalar(f.normScale*(1+Math.sin(now/300)*0.03));
      }
    }
  }

  rendererRef.render(scene,cam);
}
