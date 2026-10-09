// ============================================================
// dancer.js —— 蛙步舞者（核心模块 · 双角色版）
//
// 主页：奶蛙和疯狂的兔子【同时站在背景上】，点谁就选谁；
// 演出：只有被选中的角色留台跳舞。
//
// 奶蛙模型 rigged.glb：单块网格、无骨骼，代码程序化造骨 + 距离蒙皮权重
// （v20261114 根治版）；模型不密封，材质双面渲染（v20261116）。
// 疯狂的兔子：全部用球/椭球/胶囊程序化搭出真 3D，关节是枢轴组。
//
// 每个角色是独立对象：自带 parts / tweens / beatPhase，互不干扰。
// ============================================================
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// ---------------- 奶蛙可调参数 ----------------
const SPLIT = {
  HEAD_YN : 0.62,  // 脖子高度：身高的 62%（蛙头大）
  HIP_YN  : 0.33,  // 胯部高度
  SPINE_YN: 0.50,  // 脊柱中节高度（手臂挂这里）
  LEG_YN  : 0.30,  // 腿/身体分界
  ARM_XN  : 0.42,  // 手臂/身体左右分界
  TARGET_H: 2.0,   // 角色归一化后的目标身高（世界单位）
  YAW     : 0,     // 模型朝向微调
};

// ---------------- 角色总表 ----------------
export const CHARACTERS = [
  { id:'frog',   name:'奶蛙' },
  { id:'rabbit', name:'疯狂的兔子' },
];

// ---------------- 总管理状态 ----------------
export const Dancer = {
  layer   : null,     // 持久层组（加入场景一次，两个角色的根都在里面）
  chars   : {},       // { frog:ch, rabbit:ch }
  selected: 'frog',
  mode    : 'home',   // home | play
  ready   : false,
};

// ============================================================
// 每个角色自己的补间系统（互不串台）
// ============================================================
function beginGroup(ch,name){ ch._tag = name + (++ch._tagSeq); }
function tw(ch, obj, axis, to, dur, ease='outQuad', delay=0, amp=1){
  const tag = ch._tag;
  if(tag!==null){
    for(let i=ch.tweens.length-1;i>=0;i--){
      const w = ch.tweens[i];
      if(w.obj===obj && w.axis===axis && w.tag!==tag) ch.tweens.splice(i,1);
    }
  }
  ch.tweens.push({ obj, axis, from:null, to:to*amp, t0:performance.now()+delay, dur, ease, tag });
}
const EASE = {
  outQuad  : t=>1-(1-t)*(1-t),
  outBack  : t=>{const s=1.9;t--;return 1+t*t*((s+1)*t+s);},
  outElastic:t=>{if(t>=1)return 1;const p=0.42;return Math.pow(2,-9*t)*Math.sin((t-p/4)*(2*Math.PI)/p)+1;},
  inOutCubic: t=>t<.5?4*t*t*t:1-Math.pow(-2*t+2,3)/2,
};

// ============================================================
// 选中光环 + 名字牌（layer 直属，x 跟随角色根）
// ============================================================
function makeRing(){
  const m=new THREE.Mesh(
    new THREE.RingGeometry(0.62,0.8,72),
    new THREE.MeshBasicMaterial({color:0xffe17a,transparent:true,opacity:0.9,side:THREE.DoubleSide})
  );
  m.rotation.x=-Math.PI/2;
  m.position.y=0.02;
  m.visible=false;
  return m;
}
function makeNameTag(){
  const cv=document.createElement('canvas'); cv.width=560; cv.height=140;
  const ctx=cv.getContext('2d');
  const tex=new THREE.CanvasTexture(cv);
  const mat=new THREE.SpriteMaterial({map:tex,transparent:true,depthTest:false});
  const sp=new THREE.Sprite(mat); sp.scale.set(1.7,0.425,1); sp.position.set(0,0.14,1.15);
  function draw(text,active){
    ctx.clearRect(0,0,560,140);
    ctx.font='bold 60px "Microsoft YaHei",sans-serif';
    ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.shadowColor='rgba(0,0,0,.65)'; ctx.shadowBlur=8;
    ctx.fillStyle=active?'#ffe17a':'#a8afc2';
    ctx.fillText((active?'✓ ':'')+text, 280, 74);
    tex.needsUpdate=true;
  }
  return {sp,draw};
}

function updateMarks(){
  // 专门选角页方案：主页不再显示光环/名字牌（选择页的卡片负责显示）
  for(const id in Dancer.chars){
    const ch=Dancer.chars[id];
    ch.ring.visible=false;
    ch.tag.sp.visible=false;
  }
}

// 只让指定角色可见（主页中央 / 演出舞台都是它）
function setVisibleOnly(id){
  for(const k in Dancer.chars){
    const ch=Dancer.chars[k];
    ch.root.visible=(k===id);
    ch.slotX=0;
  }
}

// ============================================================
// 初始化 / 预载（两个角色都建好）
// ============================================================
export function initDancerLayer(){
  Dancer.layer=new THREE.Group();
  return Dancer.layer;
}

// ============================================================
// 疯狂的兔子 —— GIF 精灵版（v20261028 弃用 3D 建模）
// 直接用疯兔表情包动图：待机/四方向动作/Miss/庆祝各一张；
// 3D 场景里只留一个空锚点（root），每帧投影到屏幕坐标摆 DOM <img>。
// 每个 GIF 备 a/b 两个缓存变体，交替赋 src 强制从头播放。
// ============================================================
export function setDancerCamera(cam){ Dancer.camera=cam; }

const RABBIT_H   = 1.7;   // 兔子世界身高（比奶蛙 2.0 略矮），用于投影算像素高度
const GIF_DIR    = 'img/rabbit/';
const RABBIT_GIFS = {
  idle      : { url:GIF_DIR+'idle.gif' },                                        // 正面站立
  left      : { url:GIF_DIR+'act-left.gif'  , hold:1200 },                       // ← 呐喊举手
  down      : { url:GIF_DIR+'act-down.gif'  , hold:1200 },                       // ↓ 后仰大笑
  up        : { url:GIF_DIR+'act-up.gif'    , hold:1200 },                       // ↑ 红头带扭动
  right     : { url:GIF_DIR+'act-right.gif' , hold:1300 },                       // → 双兔对跳
  celebrate : { url:GIF_DIR+'celebrate.gif', hold:2400 },                        // 三兔干饭（结算）
  daze      : { url:GIF_DIR+'daze.gif'     , hold:1100 },                        // 发呆懵住（Miss/失败）
};
function initRabbitGifPool(){
  for(const k in RABBIT_GIFS){
    const g=RABBIT_GIFS[k];
    g.urls=[g.url+'?a', g.url+'?b'];   // 两个变体交替 → src 变化即重播，且都走缓存
    g._flip=0;
    g.urls.forEach(u=>{ const im=new Image(); im.src=u; });   // 预热缓存
  }
}
function showRabbitGif(ch,key,hold){
  const g=RABBIT_GIFS[key]; if(!g||!ch.sprite)return;
  ch._gifKey=key;
  clearTimeout(ch._gifTimer);
  g._flip^=1;
  ch.sprite.src=g.urls[g._flip];
  if(hold>0 && key!=='idle'){
    ch._gifTimer=setTimeout(()=>{ if(Dancer.chars.rabbit===ch) showRabbitGif(ch,'idle'); },hold);
  }
}
function makeRabbitGifCharacter(){
  const ch=newCharBase('rabbit','疯狂的兔子');
  ch.isGif=true;
  ch.root=new THREE.Group();          // 空锚点：仅用于定位投影（光环/名牌仍挂在 layer 上）
  ch.sprite=document.createElement('img');
  ch.sprite.className='rabbit-sprite';
  ch.sprite.alt=''; ch.sprite.draggable=false;
  document.body.appendChild(ch.sprite);
  initRabbitGifPool();
  showRabbitGif(ch,'idle');
  return ch;
}

// 每帧：把锚点(脚 y=0 / 头 y=RABBIT_H)投影到屏幕，按像素高摆 sprite
const _rpA=new THREE.Vector3(), _rpB=new THREE.Vector3();
function syncRabbitSprite(ch){
  const sp=ch.sprite;
  if(!Dancer.camera||!ch.root.visible){ sp.style.display='none'; return; }
  const x=ch.root.position.x, z=ch.root.position.z;
  _rpA.set(x,0,z).project(Dancer.camera);
  _rpB.set(x,RABBIT_H,z).project(Dancer.camera);
  const sx=v=>( v.x*0.5+0.5)*innerWidth;
  const sy=v=>(-v.y*0.5+0.5)*innerHeight;
  const footY=sy(_rpA), headY=sy(_rpB);
  const hPx=Math.abs(footY-headY);
  if(hPx<1){ sp.style.display='none'; return; }
  const nw=sp.naturalWidth, nh=sp.naturalHeight;
  const wPx=hPx*(nw&&nh?nw/nh:1);
  sp.style.display='block';
  sp.style.height=hPx.toFixed(1)+'px';
  sp.style.width=wPx.toFixed(1)+'px';
  sp.style.left=(((sx(_rpA)+sx(_rpB))/2-wPx/2)).toFixed(1)+'px';
  sp.style.top=(footY-hPx).toFixed(1)+'px';
}
function updateGifChar(ch,dt){
  // 主页待机：根位置平滑回站位（演出模式 slotX 也是 0，同样适用）
  ch.root.position.x+=(ch.slotX-ch.root.position.x)*Math.min(1,dt*6);
  // 演出中半透明（0.45），不挡音符视线；主页恢复不透明
  ch.sprite.style.opacity=(Dancer.mode==='play')?'0.45':'1';
  syncRabbitSprite(ch);
}

export async function preloadDancers(){
  console.log('%c========== 蛙步 · 双舞者预载 ==========', 'color:#ffe17a');
  const t0=performance.now();

  // 奶蛙（17MB GLB）
  const frog=await loadFrogGLB();
  Dancer.chars.frog=frog; Dancer.layer.add(frog.root); Dancer.layer.add(frog.ring); Dancer.layer.add(frog.tag.sp);
  // 兔子：GIF 精灵版（不用 3D 模型，直接用疯兔表情包动图）
  const rabbit=makeRabbitGifCharacter();
  Dancer.chars.rabbit=rabbit; Dancer.layer.add(rabbit.root); Dancer.layer.add(rabbit.ring); Dancer.layer.add(rabbit.tag.sp);

  applyHomeSlots();
  Dancer.ready=true;
  console.log(`%c✅ 双舞者就位 (${((performance.now()-t0)/1000).toFixed(2)}s)`, 'color:#7fffd4');
  if(typeof window!=='undefined') window.__dancer=Dancer;
  return Dancer;
}
function loadFrogGLB(){
  return new Promise((resolve,reject)=>{
    console.log('%c  ⏳ 下载/解析 rigged.glb …', 'color:#c9b8e8');
    new GLTFLoader().load('rigged.glb', (gltf)=>{
      try{ resolve(makeFrogCharacter(gltf)); }
      catch(e){ console.error('  ❌ 奶蛙绑骨失败：',e); reject(e); }
    }, (xhr)=>{
      if(xhr.total){
        const pct=Math.min(100,Math.round(xhr.loaded/xhr.total*100));
        window.dispatchEvent(new CustomEvent('dancer-progress',{detail:pct}));
      }
    }, (err)=>{ console.error('  ❌ rigged.glb 下载失败：',err); reject(err); });
  });
}

// 主页站位：窄屏自动靠拢（按相机可见宽度算）
export function applyHomeSlots(){
  const dist=5.4;
  const hw=Math.tan(THREE.MathUtils.degToRad(22.5))*dist*(innerWidth/innerHeight);
  const slot=THREE.MathUtils.clamp(hw*0.46,0.5,1.2);
  Dancer.chars.frog.slotX=-slot;
  Dancer.chars.rabbit.slotX=slot;
}

// 点选
const _ray=new THREE.Raycaster(), _nd=new THREE.Vector2();
export function pickAt(clientX,clientY,camera){
  if(Dancer.mode!=='home') return null;
  _nd.set((clientX/innerWidth)*2-1, -(clientY/innerHeight)*2+1);
  _ray.setFromCamera(_nd,camera);
  for(const id of ['frog','rabbit']){
    const ch=Dancer.chars[id];
    if(ch&&ch.root.visible&&_ray.intersectObject(ch.root,true).length) return id;
  }
  return null;
}
export function selectDancer(id){
  if(!Dancer.chars[id])return;
  const changed=Dancer.selected!==id;
  Dancer.selected=id;
  updateMarks();
  if(changed){
    const ch=Dancer.chars[id];             // 新选中：高兴地蹦一下
    if(ch.isGif){ showRabbitGif(ch,'up',RABBIT_GIFS.up.hold); return; }
    beginGroup(ch,'sel');
    tw(ch,ch.body.position,'y',0.32,150,'outQuad');
    tw(ch,ch.body.position,'y',ch.baseY,260,'outQuad',160);
  }
}

// 主/演模式（两个模式下都只显示被选中的角色；未选中的隐藏）
export function setDancerMode(mode){
  Dancer.mode=mode;
  setVisibleOnly(Dancer.selected);
  updateMarks();
}

// ============================================================
// 小工具：百分位数
// ============================================================
function pct(arr,p){
  if(!arr.length) return 0;
  const a=arr.slice().sort((x,y)=>x-y);
  return a[Math.min(a.length-1,Math.floor((a.length-1)*p))];
}
const _segTmp=new THREE.Vector3();
function distToSeg(px,py,pz, ax,ay,az, bx,by,bz){
  _v1.set(bx-ax,by-ay,bz-az);
  _v2.set(px-ax,py-ay,pz-az);
  const len2=_v1.lengthSq();
  let t=len2>0?_v2.dot(_v1)/len2:0;
  t=Math.max(0,Math.min(1,t));
  _segTmp.copy(_v1).multiplyScalar(t);
  return _v2.distanceTo(_segTmp);
}
const _v1=new THREE.Vector3(),_v2=new THREE.Vector3();

// 角色对象公共字段
function newCharBase(id,name){
  return {
    id,name,
    root:null, body:null, parts:{},
    tweens:[], _tag:null, _tagSeq:0, beatPhase:0,
    solidMats:[], baseX:0, baseY:0, slotX:0,
    ring:makeRing(), tag:makeNameTag(),
  };
}

// ============================================================
// 奶蛙 —— GLB + 程序化骨/蒙皮
// ============================================================
function makeFrogCharacter(gltf){
  const ch=newCharBase('frog','奶蛙');

  let srcMesh=null;
  gltf.scene.traverse(n=>{ if(!srcMesh&&n.isMesh) srcMesh=n; });
  if(!srcMesh) throw new Error('rigged.glb 里没找到网格');

  const box=new THREE.Box3().setFromObject(gltf.scene);
  srcMesh.updateWorldMatrix(true,false);
  const mw=srcMesh.matrixWorld.clone();

  const size=box.getSize(new THREE.Vector3());
  const H=size.y, W=size.x;
  const cx=(box.min.x+box.max.x)/2;
  const midz=(box.min.z+box.max.z)/2;

  const srcGeo=srcMesh.geometry;
  const sp=srcGeo.attributes.position;
  const VN=sp.count;
  const bakedArr=new Float32Array(VN*3);
  const _v=new THREE.Vector3();
  for(let i=0;i<VN;i++){
    _v.fromBufferAttribute(sp,i).applyMatrix4(mw);
    bakedArr[i*3]=_v.x;bakedArr[i*3+1]=_v.y;bakedArr[i*3+2]=_v.z;
  }
  const geo=srcGeo.clone();
  geo.setAttribute('position',new THREE.BufferAttribute(bakedArr,3));
  const _sn=srcGeo.attributes.normal;
  if(_sn){
    const normArr=new Float32Array(VN*3);
    const _nv=new THREE.Vector3();
    for(let i=0;i<VN;i++){
      _nv.fromBufferAttribute(_sn,i).applyQuaternion(srcMesh.quaternion).normalize();
      normArr[i*3]=_nv.x;normArr[i*3+1]=_nv.y;normArr[i*3+2]=_nv.z;
    }
    geo.setAttribute('normal',new THREE.BufferAttribute(normArr,3));
  }
  const pos=geo.attributes.position;

  const labels=new Array(VN);
  const xs=new Array(VN),ys=new Array(VN);
  const armLVerts=[],armRVerts=[],legLVerts=[],legRVerts=[],headVerts=[],bellyVerts=[];
  for(let i=0;i<VN;i++){
    const x=pos.getX(i),y=pos.getY(i),z=pos.getZ(i);
    const yn=(y-box.min.y)/H;
    const xn=(x-cx)/(W/2);
    let lb;
    if(yn>=SPLIT.HEAD_YN) lb='head';
    else if(yn<=SPLIT.LEG_YN) lb=xn<0?'legL':'legR';
    else if(Math.abs(xn)>=SPLIT.ARM_XN) lb=xn<0?'armL':'armR';
    else lb='belly';
    labels[i]=lb;
    xs[i]=x;ys[i]=y;
    if(lb==='head')headVerts.push(i);
    else if(lb==='belly')bellyVerts.push(i);
    if(yn>SPLIT.LEG_YN-0.04&&yn<SPLIT.HEAD_YN+0.02){
      if(xn<-SPLIT.ARM_XN+0.06)armLVerts.push(i);
      if(xn> SPLIT.ARM_XN-0.06)armRVerts.push(i);
    }
    if(yn<SPLIT.LEG_YN+0.06){
      if(xn<0)legLVerts.push(i);else legRVerts.push(i);
    }
  }

  const hipY=box.min.y+H*SPLIT.HIP_YN;
  const spineY=box.min.y+H*SPLIT.SPINE_YN;
  const neckY=box.min.y+H*SPLIT.HEAD_YN;

  function shoulderPoint(ids,side){
    if(ids.length<4)return new THREE.Vector3(cx+side*H*0.16,neckY-H*0.06,midz);
    const oxs=ids.map(i=>Math.abs(xs[i]-cx));
    const yys=ids.map(i=>ys[i]);
    const zzs=ids.map(i=>pos.getZ(i));
    return new THREE.Vector3(cx+side*pct(oxs,0.25),pct(yys,0.8),zzs.reduce((a,b)=>a+b,0)/zzs.length);
  }
  function handPoint(ids,side){
    if(ids.length<4)return new THREE.Vector3(cx+side*H*0.3,spineY-H*0.22,midz);
    const oxs=ids.map(i=>Math.abs(xs[i]-cx));
    const yys=ids.map(i=>ys[i]);
    return new THREE.Vector3(cx+side*pct(oxs,0.9),pct(yys,0.12),midz);
  }
  function footPoint(ids,side){
    if(ids.length<4)return new THREE.Vector3(cx+side*H*0.07,box.min.y+0.01,midz);
    const xxs=ids.map(i=>xs[i]);
    return new THREE.Vector3(pct(xxs,0.5),pct(ids.map(i=>ys[i]),0.02),midz);
  }
  const shL=shoulderPoint(armLVerts,-1),shR=shoulderPoint(armRVerts,1);
  const handL=handPoint(armLVerts,-1),handR=handPoint(armRVerts,1);
  const footL=footPoint(legLVerts,-1),footR=footPoint(legRVerts,1);

  const pelvis=new THREE.Bone();pelvis.position.set(cx,hipY,midz);
  const spine=new THREE.Bone();spine.position.set(0,spineY-hipY,0);
  const head=new THREE.Bone();head.position.set(0,neckY-spineY,0);
  const armL=new THREE.Bone();armL.position.set(shL.x-cx,shL.y-spineY,shL.z-midz);
  const armR=new THREE.Bone();armR.position.set(shR.x-cx,shR.y-spineY,shR.z-midz);
  const legL=new THREE.Bone();legL.position.set(footL.x-cx,0,footL.z-midz);
  const legR=new THREE.Bone();legR.position.set(footR.x-cx,0,footR.z-midz);
  pelvis.add(spine);
  spine.add(head);spine.add(armL);spine.add(armR);
  pelvis.add(legL);pelvis.add(legR);
  const boneArr=[pelvis,spine,head,armL,armR,legL,legR];
  const boneNames=['pelvis','spine','head','armL','armR','legL','legR'];

  function limbRadius(ids,a,b){
    if(ids.length<4)return H*0.06;
    const ds=ids.map(i=>distToSeg(pos.getX(i),pos.getY(i),pos.getZ(i),a.x,a.y,a.z,b.x,b.y,b.z));
    return Math.max(H*0.02,pct(ds,0.7)*1.5);
  }
  const rArmL=limbRadius(armLVerts,shL,handL);
  const rArmR=limbRadius(armRVerts,shR,handR);
  const rLegL=limbRadius(legLVerts,new THREE.Vector3(cx,hipY,midz),footL);
  const rLegR=limbRadius(legRVerts,new THREE.Vector3(cx,hipY,midz),footR);
  let rHead=H*0.16;
  if(headVerts.length){
    const ds=headVerts.map(i=>Math.max(Math.abs(pos.getX(i)-cx),Math.abs(pos.getZ(i)-midz)));
    rHead=pct(ds,0.8)*1.3;
  }
  let rBelly=H*0.22;
  if(bellyVerts.length){
    const ds=bellyVerts.map(i=>{_v1.set(pos.getX(i)-cx,0,pos.getZ(i)-midz);return _v1.length();});
    rBelly=pct(ds,0.8)*1.2;
  }
  const segs=[
    [cx,hipY,midz,cx,spineY,midz,rBelly*1.15],
    [cx,spineY,midz,cx,neckY,midz,rBelly],
    [cx,neckY,midz,cx,box.max.y,midz,rHead],
    [shL.x,shL.y,shL.z,handL.x,handL.y,handL.z,rArmL],
    [shR.x,shR.y,shR.z,handR.x,handR.y,handR.z,rArmR],
    [cx,hipY,midz,footL.x,footL.y,footL.z,rLegL],
    [cx,hipY,midz,footR.x,footR.y,footR.z,rLegR],
  ];

  const skinIdx=new Uint16Array(VN*4);
  const skinW=new Float32Array(VN*4);
  let fallbackCount=0;
  const ws=new Array(boneArr.length);
  for(let i=0;i<VN;i++){
    const px=pos.getX(i),py=pos.getY(i),pz=pos.getZ(i);
    let sum=0,best=-1,bestW=1e-6;
    for(let bI=0;bI<boneArr.length;bI++){
      const s=segs[bI];
      const d=distToSeg(px,py,pz,s[0],s[1],s[2],s[3],s[4],s[5]);
      let w=1-d/s[6];if(w<0)w=0;w=w*w;
      ws[bI]=w;sum+=w;
      if(w>bestW){bestW=w;best=bI;}
    }
    if(sum<1e-4){
      fallbackCount++;
      for(let k=0;k<4;k++){skinIdx[i*4+k]=best<0?0:best;skinW[i*4+k]=k===0?1:0;}
      continue;
    }
    const order=ws.map((w,bI)=>[w/sum,bI]).sort((a,b)=>b[0]-a[0]).slice(0,4);
    for(let k=0;k<4;k++){skinIdx[i*4+k]=order[k][1];skinW[i*4+k]=order[k][0];}
  }
  geo.setAttribute('skinIndex',new THREE.BufferAttribute(skinIdx,4));
  geo.setAttribute('skinWeight',new THREE.BufferAttribute(skinW,4));

  const root=new THREE.Group();
  const body=new THREE.Group();
  const rig=new THREE.Group();
  root.add(body);body.add(rig);
  rig.position.set(-cx,-box.min.y,-midz);
  if(SPLIT.YAW)body.rotation.y=SPLIT.YAW;

  const mat=srcMesh.material.clone();
  mat.side=THREE.DoubleSide;
  mat.vertexColors=true;
  const vColor=new Float32Array(VN*3).fill(1);
  geo.setAttribute('color',new THREE.BufferAttribute(vColor,3));

  const mesh=new THREE.SkinnedMesh(geo,mat);
  mesh.castShadow=true;
  mesh.frustumCulled=false;
  rig.add(mesh);
  rig.add(pelvis);

  root.updateMatrixWorld(true);
  const skeleton=new THREE.Skeleton(boneArr);
  skeleton.calculateInverses();
  mesh.bind(skeleton);

  root.scale.setScalar(SPLIT.TARGET_H/H);

  gltf.scene.traverse(n=>{if(n.isMesh)n.geometry.dispose();});

  const parts={};
  boneArr.forEach((b,i)=>{parts[boneNames[i]]={bone:b,pose:{x:0,y:0,z:0},idle:{x:0,y:0,z:0}};});

  ch.root=root;ch.body=body;ch.parts=parts;
  ch.solidMats=[{m:mat,base:new THREE.Color(0xffffff)}];
  ch.baseX=body.position.x;ch.baseY=body.position.y;
  ch._labels=labels;                          // 涂装按部位染顶点要用

  console.log(`%c[奶蛙绑骨] 顶点 ${VN}，7 骨，兜底 ${fallbackCount}`, 'color:#ffe17a');
  return ch;
}

// ============================================================
// 动作：四方向
// ============================================================
export function doAction(dir,quality='good'){
  const ch=Dancer.chars[Dancer.selected];
  if(!ch)return;
  if(ch.isGif){                             // 兔子：GIF 动作（←↓↑→ 各一张）
    const map=['left','down','up','right'];
    const key=map[dir]||'up';
    showRabbitGif(ch,key,RABBIT_GIFS[key].hold);
    return;
  }
  if(!ch.parts.armL)return;
  const amp=quality==='perfect'?1.28:1.0;
  frogAction(ch,dir,amp);
}

function frogAction(ch,dir,amp){
  const parts=ch.parts;
  beginGroup(ch,'act');

  if(dir===0){                          // ← 甩左手
    tw(ch,parts.armL.pose,'z',-2.6,130,'outQuad',0,amp);
    tw(ch,parts.armL.pose,'z',0,520,'outElastic',140);
    tw(ch,parts.armL.pose,'x',-0.7,130,'outQuad',0,amp);
    tw(ch,parts.armL.pose,'x',0,480,'outElastic',150);
    tw(ch,ch.body.rotation,'z',-0.16,130,'outQuad',0,amp);
    tw(ch,ch.body.rotation,'z',0,480,'outElastic',150);
    if(parts.head){tw(ch,parts.head.pose,'z',-0.3,150,'outQuad',0,amp);tw(ch,parts.head.pose,'z',0,420,'outElastic',170);}
  }
  else if(dir===1){                     // ↓ 双踢腿
    if(parts.legL){tw(ch,parts.legL.pose,'x',-1.5,120,'outQuad',0,amp);tw(ch,parts.legL.pose,'x',0,460,'outElastic',130);}
    if(parts.legR){tw(ch,parts.legR.pose,'x',1.1,140,'outQuad',60,amp);tw(ch,parts.legR.pose,'x',0,460,'outElastic',210);}
    tw(ch,ch.body.position,'y',-0.14,130,'outQuad',0,amp);
    tw(ch,ch.body.position,'y',0,430,'outElastic',140);
  }
  else if(dir===2){                     // ↑ 扭脊抬头
    tw(ch,parts.spine.pose,'y',0.5,140,'outQuad',0,amp);
    tw(ch,parts.spine.pose,'y',-0.32,240,'inOutCubic',150);
    tw(ch,parts.spine.pose,'y',0,420,'outElastic',400);
    if(parts.head){tw(ch,parts.head.pose,'x',-0.62,150,'outBack',0,amp);tw(ch,parts.head.pose,'x',0,520,'outElastic',180);}
    tw(ch,ch.body.scale,'x',0.9,130,'outQuad',0,amp);
    tw(ch,ch.body.scale,'x',1,440,'outElastic',140);
  }
  else{                                 // → 360 回旋
    const b=ch.body;
    tw(ch,b.rotation,'y',Math.PI*2,420,'inOutCubic',0,amp);
    setTimeout(()=>{if(Dancer.chars[Dancer.selected].body===b&&!ch.tweens.some(w=>w.obj===b.rotation&&w.axis==='y'))b.rotation.y=0;},460);
    tw(ch,b.scale,'x',0.82,150,'outQuad',0,amp);
    tw(ch,b.scale,'x',1,460,'outElastic',160);
    if(parts.armR){tw(ch,parts.armR.pose,'z',2.6,140,'outQuad',0,amp);tw(ch,parts.armR.pose,'z',0,500,'outElastic',150);}
  }
}

// Miss：踉跄 + 闪红
let _stumbleT=0;
export function stumble(){
  const now=performance.now();
  if(now-_stumbleT<320)return;
  _stumbleT=now;
  const ch=Dancer.chars[Dancer.selected];
  if(!ch)return;
  if(ch.isGif){ showRabbitGif(ch,'daze',RABBIT_GIFS.daze.hold); return; }   // 兔子：懵住一下
  if(!ch.body)return;
  beginGroup(ch,'miss');
  tw(ch,ch.body.rotation,'z',0.3,90,'outQuad');
  tw(ch,ch.body.rotation,'z',-0.22,180,'inOutCubic',100);
  tw(ch,ch.body.rotation,'z',0,320,'outElastic',290);
  const parts=ch.parts;
  if(parts.head){tw(ch,parts.head.pose,'z',0.4,120,'outQuad');tw(ch,parts.head.pose,'z',0,400,'outElastic',140);}
  if(parts.earL){tw(ch,parts.earL.pose,'z',-0.5,110,'outQuad');tw(ch,parts.earL.pose,'z',0,380,'outElastic',130);}
  if(parts.earR){tw(ch,parts.earR.pose,'z',0.5,110,'outQuad');tw(ch,parts.earR.pose,'z',0,380,'outElastic',130);}
  if(ch.solidMats.length){
    ch.solidMats.forEach(s=>s.m.color.setHex(0xff5566));
    setTimeout(()=>{ch.solidMats.forEach(s=>s.m.color.copy(s.base));},220);
  }
}

// 庆祝：蹦 + 挥双手 + 转圈
export function celebrate(){
  const ch=Dancer.chars[Dancer.selected];
  if(!ch)return;
  if(ch.isGif){ showRabbitGif(ch,'celebrate',RABBIT_GIFS.celebrate.hold); return; }   // 兔子：三兔干饭庆祝
  const parts=ch.parts,b=ch.body;
  beginGroup(ch,'cel');
  for(let i=0;i<3;i++){
    tw(ch,b.position,'y',0.55,180,'outQuad',i*420);
    tw(ch,b.position,'y',0,240,'outQuad',i*420+190);
  }
  tw(ch,b.rotation,'y',Math.PI*2,700,'inOutCubic',200);
  setTimeout(()=>{if(!ch.tweens.some(w=>w.obj===b.rotation&&w.axis==='y'))b.rotation.y=0;},950);
  if(parts.armL){tw(ch,parts.armL.pose,'z',-2.8,200,'outBack');tw(ch,parts.armL.pose,'z',0,600,'outElastic',800);}
  if(parts.armR){tw(ch,parts.armR.pose,'z',2.8,200,'outBack');tw(ch,parts.armR.pose,'z',0,600,'outElastic',800);}
  if(parts.earL){tw(ch,parts.earL.pose,'x',1.0,190,'outQuad');tw(ch,parts.earL.pose,'x',0,520,'outElastic',210);}
  if(parts.earR){tw(ch,parts.earR.pose,'x',1.0,190,'outQuad');tw(ch,parts.earR.pose,'x',0,520,'outElastic',210);}
}

// 失败躺地
export function lieDown(){
  const ch=Dancer.chars[Dancer.selected];
  if(!ch)return;
  if(ch.isGif){ showRabbitGif(ch,'daze',6000); return; }   // 兔子：失败懵住（保持较久）
  const parts=ch.parts;
  beginGroup(ch,'lie');
  tw(ch,ch.body.rotation,'x',-Math.PI*0.46,520,'outQuad');
  tw(ch,ch.body.position,'y',(ch.baseY||0)-0.35,520,'outQuad');
  if(parts.armL)tw(ch,parts.armL.pose,'z',-0.55,420,'outQuad');
  if(parts.armR)tw(ch,parts.armR.pose,'z',0.55,420,'outQuad');
  if(parts.legL)tw(ch,parts.legL.pose,'x',0.35,420,'outQuad');
  if(parts.legR)tw(ch,parts.legR.pose,'x',0.35,420,'outQuad');
  if(parts.head)tw(ch,parts.head.pose,'x',-0.5,420,'outQuad');
  if(parts.earL){tw(ch,parts.earL.pose,'x',-1.1,400,'outQuad');tw(ch,parts.earL.pose,'z',-0.5,400,'outQuad');}
  if(parts.earR){tw(ch,parts.earR.pose,'x',-1.1,400,'outQuad');tw(ch,parts.earR.pose,'z',0.5,400,'outQuad');}
}

// 开演前复位
export function resetBody(){
  const ch=Dancer.chars[Dancer.selected];
  if(!ch)return;
  if(ch.isGif){ showRabbitGif(ch,'idle'); return; }   // 兔子：复位到待机 GIF
  if(!ch.body)return;
  ch.tweens.length=0;
  ch.body.rotation.set(0,0,0);
  ch.body.position.x=ch.baseX||0;
  ch.body.position.y=ch.baseY||0;
  ch.body.scale.set(1,1,1);
  for(const k in ch.parts){
    const p=ch.parts[k];
    p.pose.x=0;p.pose.y=0;p.pose.z=0;
  }
}

// ============================================================
// 每帧更新
// ============================================================
export function updateDancer(dt,bpm,dancing){
  if(!Dancer.ready)return;

  // 光环呼吸 + 跟随
  const tNow=performance.now()*0.004;
  for(const id in Dancer.chars){
    const ch=Dancer.chars[id];
    if(ch.ring.visible){
      const p=0.5+Math.sin(tNow)*0.5;
      ch.ring.material.opacity=0.55+p*0.4;
      ch.ring.scale.setScalar(0.92+p*0.12);
    }
    ch.ring.position.x=ch.root.position.x;
    ch.tag.sp.position.x=ch.root.position.x;
  }

  for(const id in Dancer.chars){
    const ch=Dancer.chars[id];
    if(!ch.root.visible){ if(ch.isGif) ch.sprite.style.display='none'; continue; }
    if(ch.isGif){ updateGifChar(ch,dt); continue; }
    const onStage = dancing&&Dancer.selected===id&&Dancer.mode==='play';
    updateChar(ch,dt,onStage,bpm);
  }
}

function updateChar(ch,dt,dancing,bpm){
  const now=performance.now();

  for(let i=ch.tweens.length-1;i>=0;i--){
    const w=ch.tweens[i];
    if(now<w.t0)continue;
    if(w.from===null)w.from=w.obj[w.axis];
    let t=(now-w.t0)/w.dur;
    if(t>=1){w.obj[w.axis]=w.to;ch.tweens.splice(i,1);continue;}
    w.obj[w.axis]=w.from+(w.to-w.from)*EASE[w.ease](t);
  }

  const bps=(dancing?bpm:100)/60;
  ch.beatPhase+=dt*bps*Math.PI;
  const s=Math.sin(ch.beatPhase);
  const c=Math.cos(ch.beatPhase*0.5);
  const s2=Math.sin(ch.beatPhase*2);
  const b=ch.body;
  const parts=ch.parts;

  if(dancing){
    const e=1.0;
    if(!ch.tweens.some(w=>w.obj===b.position&&w.axis==='y'))b.position.y=Math.abs(s)*0.12*e;
    if(!ch.tweens.some(w=>w.obj===b.position&&w.axis==='x'))b.position.x=Math.sin(ch.beatPhase*0.5)*0.7;
    if(!ch.tweens.some(w=>w.obj===b.scale)){b.scale.x=1+s*0.04*e;b.scale.y=1-s*0.04*e;}
    if(!ch.tweens.some(w=>w.obj===b.rotation)){b.rotation.z=s*0.09*e;b.rotation.y=c*0.13*e;}
    if(parts.armL){parts.armL.idle.x=s*0.55*e;parts.armL.idle.z=s2*0.22*e;}
    if(parts.armR){parts.armR.idle.x=-s*0.55*e;parts.armR.idle.z=-s2*0.22*e;}
    if(parts.spine){parts.spine.idle.y=s*0.14*e;parts.spine.idle.z=c*0.06*e;}
    if(parts.legL){parts.legL.idle.x=Math.max(0,s)*0.45*e;parts.legL.idle.z=s2*0.1*e;}
    if(parts.legR){parts.legR.idle.x=Math.max(0,-s)*0.45*e;parts.legR.idle.z=-s2*0.1*e;}
    if(parts.head){parts.head.idle.x=c*0.18*e;parts.head.idle.z=s*0.1*e;}
    if(parts.earL){parts.earL.idle.x=s*0.22;parts.earL.idle.z=-s2*0.10;}
    if(parts.earR){parts.earR.idle.x=s*0.22;parts.earR.idle.z=s2*0.10;}
    if(parts.pelvis){parts.pelvis.idle.x=0;parts.pelvis.idle.y=0;parts.pelvis.idle.z=0;}
  }else{
    // 主页待机：根位置平滑回到站位
    ch.root.position.x+=(ch.slotX-ch.root.position.x)*Math.min(1,dt*6);
    const e=0.55;
    if(!ch.tweens.some(w=>w.obj===b.position&&w.axis==='y'))b.position.y=Math.abs(s)*0.05*e;
    if(!ch.tweens.some(w=>w.obj===b.position&&w.axis==='x'))b.position.x=0;
    if(!ch.tweens.some(w=>w.obj===b.scale)){b.scale.x=1+s*0.015*e;b.scale.y=1-s*0.015*e;}
    if(!ch.tweens.some(w=>w.obj===b.rotation)){b.rotation.z=s*0.04*e;b.rotation.y=c*0.06*e;}
    if(parts.head){parts.head.idle.z=s*0.03*e;parts.head.idle.x=c*0.02*e;}
    if(parts.armL)parts.armL.idle.x=s*0.08*e;
    if(parts.armR)parts.armR.idle.x=-s*0.08*e;
    if(parts.earL){parts.earL.idle.x=s2*0.04;parts.earL.idle.z=-s2*0.04;}
    if(parts.earR){parts.earR.idle.x=s2*0.04;parts.earR.idle.z=s2*0.04;}
    for(const k of ['pelvis','spine','legL','legR']){
      if(parts[k]){parts[k].idle.x=0;parts[k].idle.y=0;parts[k].idle.z=0;}
    }
  }

  for(const k in parts){
    const p=parts[k];
    p.bone.rotation.set(p.pose.x+p.idle.x,p.pose.y+p.idle.y,p.pose.z+p.idle.z);
  }
}

// ============================================================
// 涂装（仅奶蛙）：顶点色按部位染
// ============================================================
const _cHead=new THREE.Color(),_cBelly=new THREE.Color();
export function setSkin(skin){
  const ch=Dancer.chars.frog;
  if(!ch)return;
  let mesh=null;
  ch.root.traverse(n=>{if(!mesh&&n.isSkinnedMesh)mesh=n;});
  if(!mesh)return;
  const colorAttr=mesh.geometry.attributes.color;
  const labels=ch._labels;
  _cHead.setHex(skin.colors.head??0xffffff);
  _cBelly.setHex(skin.colors.belly??0xffffff);
  if(!labels)return;
  for(let i=0;i<labels.length;i++){
    const lb=labels[i];
    if(lb==='head')colorAttr.setXYZ(i,_cHead.r,_cHead.g,_cHead.b);
    else if(lb==='belly')colorAttr.setXYZ(i,_cBelly.r,_cBelly.g,_cBelly.b);
    else colorAttr.setXYZ(i,1,1,1);
  }
  colorAttr.needsUpdate=true;
  const m=ch.solidMats[0]?.m;
  if(m&&'emissive' in m){
    if(skin.glow){m.emissive.setHex(skin.glow);m.emissiveIntensity=0.22;}
    else m.emissiveIntensity=0;
  }
}
