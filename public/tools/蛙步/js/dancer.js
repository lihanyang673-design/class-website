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
export async function preloadDancers(){
  console.log('%c========== 蛙步 · 双舞者预载 ==========', 'color:#ffe17a');
  const t0=performance.now();

  // 奶蛙（17MB GLB）
  const frog=await loadFrogGLB();
  Dancer.chars.frog=frog; Dancer.layer.add(frog.root); Dancer.layer.add(frog.ring); Dancer.layer.add(frog.tag.sp);
  // 兔子（同步即建）
  const rabbit=makeRabbitCharacter();
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
// 疯狂的兔子 —— 程序化真 3D
// ============================================================
function makeRabbitCharacter(){
  const ch=newCharBase('rabbit','疯狂的兔子');

  const fur   =new THREE.MeshStandardMaterial({color:0xf6f3ed,roughness:0.82,metalness:0});
  const pink  =new THREE.MeshStandardMaterial({color:0xf0b2a1,roughness:0.72,metalness:0});
  const pink2 =new THREE.MeshStandardMaterial({color:0xf3bdae,roughness:0.72,metalness:0});
  const eyeW  =new THREE.MeshStandardMaterial({color:0xfdfcf9,roughness:0.3,metalness:0});
  const irisM =new THREE.MeshStandardMaterial({color:0x3d9ed8,roughness:0.3,metalness:0});
  const black =new THREE.MeshStandardMaterial({color:0x1c1015,roughness:0.5,metalness:0});
  const tooth =new THREE.MeshStandardMaterial({color:0xfffdf4,roughness:0.4,metalness:0});
  const red   =new THREE.MeshStandardMaterial({color:0xc83845,roughness:0.5,metalness:0});

  function msh(geo,mat){const m=new THREE.Mesh(geo,mat);m.castShadow=true;return m;}

  const root=new THREE.Group();
  const body=new THREE.Group();
  const rig=new THREE.Group();
  root.add(body);body.add(rig);

  const HIP=2.15,CHEST=3.55,NECK=3.85;
  const pelvis=new THREE.Group();pelvis.position.set(0,HIP,0);
  const spine=new THREE.Group();spine.position.set(0,CHEST-HIP,0);
  const head=new THREE.Group();head.position.set(0,NECK-CHEST,0);
  pelvis.add(spine);spine.add(head);

  const lower=msh(new THREE.SphereGeometry(1,32,24),fur);
  lower.scale.set(1.08,1.35,0.92);lower.position.set(0,-0.05,0);
  pelvis.add(lower);
  const belly=msh(new THREE.SphereGeometry(1,24,18),pink);
  belly.scale.set(0.56,0.82,0.10);belly.position.set(0,0.35,0.86);
  pelvis.add(belly);

  const chest=msh(new THREE.SphereGeometry(1,28,20),fur);
  chest.scale.set(0.95,0.85,0.82);chest.position.set(0,-0.10,0);
  spine.add(chest);

  const skull=msh(new THREE.SphereGeometry(1,36,28),fur);
  skull.scale.set(0.92,1.18,0.86);skull.position.set(0,0.72,0);
  head.add(skull);
  const muzzle=msh(new THREE.SphereGeometry(1,24,18),pink);
  muzzle.scale.set(0.52,0.42,0.34);muzzle.position.set(0,0.34,0.72);
  head.add(muzzle);
  const mouth=msh(new THREE.SphereGeometry(1,16,12),black);
  mouth.scale.set(0.30,0.20,0.08);mouth.position.set(0,0.16,1.0);
  head.add(mouth);
  const tongue=msh(new THREE.SphereGeometry(1,10,8),red);
  tongue.scale.set(0.12,0.07,0.05);tongue.position.set(0,0.04,1.02);
  head.add(tongue);
  for(const s of [-1,1]){
    const t=msh(new THREE.BoxGeometry(0.20,0.24,0.09),tooth);
    t.position.set(s*0.13,0.30,0.97);t.rotation.z=s*0.08;
    head.add(t);
  }

  for(const s of [-1,1]){
    const eye=new THREE.Group();
    eye.position.set(s*0.80,0.82,0.18);
    eye.add(msh(new THREE.SphereGeometry(0.32,24,18),eyeW));
    const ir=msh(new THREE.CircleGeometry(0.17,24),irisM);
    ir.position.set(s*0.04,0.03,0.30);ir.rotation.y=s*0.35;
    eye.add(ir);
    const pu=msh(new THREE.CircleGeometry(0.085,18),black);
    pu.position.set(s*0.04,0.03,0.315);pu.rotation.y=s*0.35;
    eye.add(pu);
    const hl=msh(new THREE.SphereGeometry(0.045,8,6),eyeW);
    hl.position.set(s*0.02,0.13,0.34);
    eye.add(hl);
    head.add(eye);
  }

  const earL=new THREE.Group();earL.position.set(-0.40,1.32,-0.04);
  const earR=new THREE.Group();earR.position.set( 0.40,1.32,-0.04);
  for(const s of [-1,1]){
    const eg=s<0?earL:earR;
    const outer=msh(new THREE.CapsuleGeometry(0.21,1.15,8,16),fur);
    outer.position.set(0,0.82,0);outer.scale.z=0.55;
    outer.rotation.z=s*0.16;outer.rotation.x=-0.06;
    eg.add(outer);
    const inner=msh(new THREE.CapsuleGeometry(0.12,0.85,8,14),pink2);
    inner.position.set(0,0.82,0.09);inner.scale.z=0.4;
    inner.rotation.z=s*0.16;inner.rotation.x=-0.06;
    eg.add(inner);
  }
  head.add(earL);head.add(earR);

  const armL=new THREE.Group();armL.position.set(-0.86,-0.02,0.04);
  const armR=new THREE.Group();armR.position.set( 0.86,-0.02,0.04);
  for(const s of [-1,1]){
    const ag=s<0?armL:armR;
    const cap=msh(new THREE.CapsuleGeometry(0.25,0.85,8,14),fur);
    cap.position.set(0,-0.72,0);
    ag.add(cap);
    const hand=msh(new THREE.SphereGeometry(0.30,18,14),fur);
    hand.scale.set(1,0.9,1);hand.position.set(0,-1.38,0.03);
    ag.add(hand);
    for(const f of [-1,1]){
      const fg=msh(new THREE.SphereGeometry(0.11,10,8),fur);
      fg.position.set(f*0.15,-1.42,0.12);
      ag.add(fg);
    }
    const palm=msh(new THREE.SphereGeometry(1,10,8),pink2);
    palm.scale.set(0.13,0.16,0.05);palm.position.set(0,-1.38,0.28);
    ag.add(palm);
  }
  spine.add(armL);spine.add(armR);

  const legL=new THREE.Group();legL.position.set(-0.40,0,0);
  const legR=new THREE.Group();legR.position.set( 0.40,0,0);
  for(const s of [-1,1]){
    const lg=s<0?legL:legR;
    const thigh=msh(new THREE.CapsuleGeometry(0.30,0.45,8,14),fur);
    thigh.position.set(0,-0.62,0);
    lg.add(thigh);
    const foot=msh(new THREE.SphereGeometry(1,20,14),fur);
    foot.scale.set(0.40,0.28,0.60);foot.position.set(0,-0.72,0.30);
    lg.add(foot);
  }
  pelvis.add(legL);pelvis.add(legR);
  rig.add(pelvis);

  const box=new THREE.Box3().setFromObject(rig);
  const size=box.getSize(new THREE.Vector3());
  const cxx=(box.min.x+box.max.x)/2,czz=(box.min.z+box.max.z)/2;
  rig.position.set(-cxx,-box.min.y,-czz);
  root.scale.setScalar(2.0/size.y);

  const defs=[['pelvis',pelvis],['spine',spine],['head',head],
              ['armL',armL],['armR',armR],['legL',legL],['legR',legR],
              ['earL',earL],['earR',earR]];
  const parts={};
  defs.forEach(([n,b])=>{parts[n]={bone:b,pose:{x:0,y:0,z:0},idle:{x:0,y:0,z:0}};});

  ch.root=root;ch.body=body;ch.parts=parts;
  ch.solidMats=[fur,pink,pink2].map(m=>({m,base:m.color.clone()}));
  ch.baseX=0;ch.baseY=0;

  console.log('%c[兔子建模] 9 个关节枢轴（含双耳）', 'color:#ffe17a');
  return ch;
}

// ============================================================
// 动作：四方向
// ============================================================
export function doAction(dir,quality='good'){
  const ch=Dancer.chars[Dancer.selected];
  if(!ch||!ch.parts.armL)return;
  const amp=quality==='perfect'?1.28:1.0;
  if(ch.id==='rabbit')rabbitAction(ch,dir,amp);
  else frogAction(ch,dir,amp);
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

function rabbitAction(ch,dir,amp){
  const parts=ch.parts;
  beginGroup(ch,'act');

  if(dir===0){                          // ← 疯狂甩耳
    tw(ch,parts.earL.pose,'z',-1.35,130,'outQuad',0,amp);
    tw(ch,parts.earL.pose,'z',0,520,'outElastic',150);
    tw(ch,parts.earL.pose,'x',-0.8,120,'outQuad',0,amp);
    tw(ch,parts.earL.pose,'x',0,480,'outElastic',140);
    tw(ch,parts.earR.pose,'z',0.55,120,'outQuad',20,amp);
    tw(ch,parts.earR.pose,'z',0,460,'outElastic',150);
    tw(ch,parts.armL.pose,'z',-2.4,130,'outQuad',0,amp);
    tw(ch,parts.armL.pose,'z',0,500,'outElastic',140);
    tw(ch,parts.head.pose,'z',-0.35,140,'outQuad',0,amp);
    tw(ch,parts.head.pose,'z',0,440,'outElastic',160);
    tw(ch,ch.body.rotation,'z',-0.14,130,'outQuad',0,amp);
    tw(ch,ch.body.rotation,'z',0,480,'outElastic',150);
  }
  else if(dir===1){                     // ↓ 兔子蹬鹰
    tw(ch,ch.body.position,'y',-0.30,150,'outQuad',0,amp);
    tw(ch,ch.body.position,'y',0,440,'outElastic',170);
    tw(ch,parts.spine.pose,'x',0.28,150,'outQuad',0,amp);
    tw(ch,parts.spine.pose,'x',0,430,'outElastic',170);
    tw(ch,parts.legL.pose,'x',-1.55,130,'outQuad',90,amp);
    tw(ch,parts.legL.pose,'x',0,470,'outElastic',230);
    tw(ch,parts.legR.pose,'x',-1.55,130,'outQuad',150,amp);
    tw(ch,parts.legR.pose,'x',0,470,'outElastic',290);
    tw(ch,parts.earL.pose,'x',-1.15,120,'outQuad',80,amp);
    tw(ch,parts.earL.pose,'x',0,500,'outElastic',220);
    tw(ch,parts.earR.pose,'x',-1.15,120,'outQuad',80,amp);
    tw(ch,parts.earR.pose,'x',0,500,'outElastic',220);
    tw(ch,parts.head.pose,'x',-0.35,140,'outQuad',80,amp);
    tw(ch,parts.head.pose,'x',0,420,'outElastic',230);
  }
  else if(dir===2){                     // ↑ 兔子高蹦
    tw(ch,ch.body.position,'y',0.85,200,'outQuad',0,amp);
    tw(ch,ch.body.position,'y',0,300,'outQuad',220);
    tw(ch,parts.armL.pose,'z',-2.7,180,'outBack',0,amp);
    tw(ch,parts.armL.pose,'z',0,520,'outElastic',240);
    tw(ch,parts.armR.pose,'z',2.7,180,'outBack',0,amp);
    tw(ch,parts.armR.pose,'z',0,520,'outElastic',240);
    tw(ch,parts.earL.pose,'x',-0.55,180,'outQuad',0,amp);
    tw(ch,parts.earL.pose,'x',0.95,120,'outQuad',250,amp);
    tw(ch,parts.earL.pose,'x',0,520,'outElastic',380);
    tw(ch,parts.earR.pose,'x',-0.55,180,'outQuad',0,amp);
    tw(ch,parts.earR.pose,'x',0.95,120,'outQuad',250,amp);
    tw(ch,parts.earR.pose,'x',0,520,'outElastic',380);
    tw(ch,parts.head.pose,'x',-0.3,200,'outQuad',0,amp);
    tw(ch,parts.head.pose,'x',0.2,100,'outQuad',300,amp);
    tw(ch,parts.head.pose,'x',0,480,'outElastic',410);
  }
  else{                                 // → 旋风兔
    const b=ch.body;
    tw(ch,b.rotation,'y',Math.PI*2,430,'inOutCubic',0,amp);
    setTimeout(()=>{if(Dancer.chars[Dancer.selected].body===b&&!ch.tweens.some(w=>w.obj===b.rotation&&w.axis==='y'))b.rotation.y=0;},470);
    tw(ch,parts.armR.pose,'z',2.5,140,'outQuad',0,amp);
    tw(ch,parts.armR.pose,'z',0,500,'outElastic',150);
    tw(ch,parts.legL.pose,'x',-0.7,140,'outQuad',0,amp);
    tw(ch,parts.legL.pose,'x',0,420,'outElastic',160);
    tw(ch,parts.earL.pose,'z',-1.25,150,'outQuad',0,amp);
    tw(ch,parts.earL.pose,'z',0,480,'outElastic',170);
    tw(ch,parts.earR.pose,'z',1.25,150,'outQuad',0,amp);
    tw(ch,parts.earR.pose,'z',0,480,'outElastic',170);
  }
}

// Miss：踉跄 + 闪红
let _stumbleT=0;
export function stumble(){
  const now=performance.now();
  if(now-_stumbleT<320)return;
  _stumbleT=now;
  const ch=Dancer.chars[Dancer.selected];
  if(!ch||!ch.body)return;
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
  if(!ch||!ch.body)return;
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
    if(!ch.root.visible)continue;
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
