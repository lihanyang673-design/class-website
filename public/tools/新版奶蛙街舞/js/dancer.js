// ============================================================
// dancer.js —— 奶娃舞者（核心模块）
//
// 模型 rigged.glb 是【单块网格、无骨骼、无蒙皮、无动画】。
//
// ★ 根治版方案（v20261114 起）：不再把模型切成 6 块——
//   切块方案的关节两边各转各的，交界穿模只能靠"收角度"压制，治标不治本。
//   现在在代码里【程序化造一副骨骼】，并按"每个顶点到每根骨的距离"
//   自动算出平滑的蒙皮权重：关节附近的顶点同时受多根骨牵引，像橡皮一样
//   平滑弯折。网格始终是完整一块，结构上不可能再出现缝隙/撕裂/交界穿模。
//
// ★ v20261115：大臂根部埋在圆胖躯干里，单靠距离权重会被躯干骨稀释
//   （实测大臂主体只有 0.6~0.8 跟手臂骨，一挥臂就肩臂脱节）。
//   新增"手臂归属场"：按内外位置+高度的连续场明确归属，大臂主体权重=1，
//   肩窝处平滑过渡，纯躯干区域逻辑完全不变。
//
// 骨骼树（绑定姿势全部不旋转）：
//   pelvis 骨盆
//    ├ spine 脊柱
//    │   ├ head 头（颈处为枢轴）
//    │   ├ armL 左臂（肩处为枢轴）
//    │   └ armR 右臂
//    ├ legL 左腿（胯处为枢轴）
//    └ legR 右腿
//
// 可调常数在下方 SPLIT 区（关节高度比例等），跑起来不对就改这里。
// ============================================================
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// ---------------- 可调参数（看效果后微调这里） ----------------
const SPLIT = {
  HEAD_YN : 0.62,  // 脖子高度：身高的 62%（奶蛙头大）
  HIP_YN  : 0.33,  // 胯部高度
  SPINE_YN: 0.50,  // 脊柱中节高度（手臂挂这里）
  LEG_YN  : 0.30,  // 腿/身体分界
  ARM_XN  : 0.42,  // 手臂/身体左右分界
  TARGET_H: 2.0,   // 舞者归一化后的目标身高（世界单位）
  YAW     : 0,     // 模型朝向微调（若背对镜头改成 Math.PI）
};

// ---------------- 模块内状态 ----------------
export const Dancer = {
  root : null,        // 挂进场景的总根
  body : null,        // body 组（负责整体位移/旋转/挤压）
  parts: {},          // { pelvis:{bone,pose,idle}, spine:..., head:..., armL..., armR..., legL..., legR... }
  mats : [],          // [唯一材质]（保留数组形式，兼容旧代码遍历闪红）
  ready: false,
  _tweens: [],        // 动作补间队列
  _beatPhase: 0,      // 待机律动相位
};

// 小补间工具：把 obj[axis] 从当前值补到 to
// 【动作分组 tag】同一次 doAction/stumble/celebrate 里推的补间同组；
// 新动作开始时，把同一关节(obj+axis)上"别的组"的补间全部撤掉——
// 否则上一动作的回程动画还在跑、新动作又写这个关节，两批补间每帧互相覆盖，
// 关节数值瞬移，看起来就是肢体错位、抽一下。
let _curTag = null, _tagSeq = 0;
function beginGroup(name){ _curTag = name + (++_tagSeq); }
function tw(obj, axis, to, dur, ease='outQuad', delay=0, amp=1){
  const tag = _curTag;
  if(tag!==null){
    for(let i=Dancer._tweens.length-1;i>=0;i--){
      const w = Dancer._tweens[i];
      if(w.obj===obj && w.axis===axis && w.tag!==tag) Dancer._tweens.splice(i,1);
    }
  }
  Dancer._tweens.push({ obj, axis, from:null, to:to*amp, t0:performance.now()+delay, dur, ease, tag });
}
const EASE = {
  outQuad  : t=>1-(1-t)*(1-t),
  outBack  : t=>{const s=1.9;t--;return 1+t*t*((s+1)*t+s);},
  outElastic:t=>{if(t>=1)return 1;const p=0.42;return Math.pow(2,-9*t)*Math.sin((t-p/4)*(2*Math.PI)/p)+1;},
  inOutCubic: t=>t<.5?4*t*t*t:1-Math.pow(-2*t+2,3)/2,
};

// ============================================================
// 加载
// ============================================================
export function loadDancer(url){
  return new Promise((resolve, reject)=>{
    console.log('%c  ⏳ [加载] rigged.glb 舞者模型开始下载/解析…', 'color:#c9b8e8');
    const _t=performance.now();
    new GLTFLoader().load(url, (gltf)=>{
      try{
        build(gltf);
        console.log(`%c  ✅ [加载] rigged.glb 解析+自动绑骨蒙皮完成 (${((performance.now()-_t)/1000).toFixed(2)}s)`, 'color:#7fffd4');
        resolve(Dancer);
      }catch(e){ console.error('  ❌ rigged.glb 自动绑骨失败：', e); reject(e); }
    }, (xhr)=>{
      if(xhr.total){
        // 封顶 100%：QQ/微信等浏览器经压缩代理传输时，loaded 可能大于 total（解压后字节），导致出现 131%
        const pct = Math.min(100, Math.round(xhr.loaded/xhr.total*100));
        window.dispatchEvent(new CustomEvent('dancer-progress',{detail:pct}));
      }
    }, (err)=>{ console.error('  ❌ rigged.glb 下载失败：', err); reject(err); });
  });
}

// ============================================================
// 小工具：百分位数（从模型数据里估关节/手脚位置，比拍脑袋常量靠谱）
// ============================================================
function pct(arr, p){
  if(!arr.length) return 0;
  const a = arr.slice().sort((x,y)=>x-y);
  return a[Math.min(a.length-1, Math.floor((a.length-1)*p))];
}
const _segTmp = new THREE.Vector3();
// 点 p 到线段 a-b 的距离
function distToSeg(px,py,pz, ax,ay,az, bx,by,bz){
  _v1.set(bx-ax,by-ay,bz-az);
  _v2.set(px-ax,py-ay,pz-az);
  const len2 = _v1.lengthSq();
  let t = len2>0 ? _v2.dot(_v1)/len2 : 0;
  t = Math.max(0, Math.min(1, t));
  _segTmp.copy(_v1).multiplyScalar(t);
  return _v2.distanceTo(_segTmp);
}
const _v1=new THREE.Vector3(), _v2=new THREE.Vector3();

// ============================================================
// 构建：烤顶点 → 估关节 → 造骨骼 → 算权重 → 蒙皮
// ============================================================
function build(gltf){
  // ---- 找到模型里的第一个 Mesh ----
  let srcMesh = null;
  gltf.scene.traverse(n=>{ if(!srcMesh && n.isMesh) srcMesh = n; });
  if(!srcMesh) throw new Error('rigged.glb 里没找到网格');

  // ---- 总包围盒（世界系）----
  const box = new THREE.Box3().setFromObject(gltf.scene);

  // setFromObject 的遍历会触碰场景里各节点共享的 matrixWorld；
  // 在它之后强制重算一次，并【克隆】矩阵再用于烤顶点，
  // 避免拿到被遍历过程改写的 matrixWorld 引用（否则几何和骨骼会落在两套坐标）
  srcMesh.updateWorldMatrix(true, false);
  const mw = srcMesh.matrixWorld.clone();

  const size = box.getSize(new THREE.Vector3());
  const H = size.y, W = size.x;
  const cx = (box.min.x+box.max.x)/2;
  const midz = (box.min.z+box.max.z)/2;

  // ---- 整块几何：该模型 POSITION 是【交错缓冲】(stride≠3)，
  // 直接 geo.clone().applyMatrix4 会写错顶点分量；
  // 改为从原始 position 逐顶点读取（已验证正确），手动烤成独立紧密 Float32 属性 ----
  const srcGeo = srcMesh.geometry;
  const sp = srcGeo.attributes.position;
  const VN = sp.count;
  const bakedArr = new Float32Array(VN*3);
  const _v = new THREE.Vector3();
  for(let i=0;i<VN;i++){
    _v.fromBufferAttribute(sp,i).applyMatrix4(mw);
    bakedArr[i*3]=_v.x; bakedArr[i*3+1]=_v.y; bakedArr[i*3+2]=_v.z;
  }
  const geo = srcGeo.clone();
  geo.setAttribute('position', new THREE.BufferAttribute(bakedArr,3));
  // 法线同步旋转（均匀缩放下只需应用同一旋转），否则光照方向错位
  const _sn = srcGeo.attributes.normal;
  if(_sn){
    const normArr = new Float32Array(VN*3);
    const _nv = new THREE.Vector3();
    for(let i=0;i<VN;i++){
      _nv.fromBufferAttribute(_sn,i).applyQuaternion(srcMesh.quaternion).normalize();
      normArr[i*3]=_nv.x; normArr[i*3+1]=_nv.y; normArr[i*3+2]=_nv.z;
    }
    geo.setAttribute('normal', new THREE.BufferAttribute(normArr,3));
  }
  const pos = geo.attributes.position;

  // ---- 每个顶点的归一化坐标 + 部位标签（皮肤涂装只染头/肚）----
  const labels = new Array(VN);
  const xs=new Array(VN), ys=new Array(VN);
  const armLVerts=[], armRVerts=[], legLVerts=[], legRVerts=[], headVerts=[], bellyVerts=[];
  for(let i=0;i<VN;i++){
    const x=pos.getX(i), y=pos.getY(i), z=pos.getZ(i);
    const yn=(y-box.min.y)/H;
    const xn=(x-cx)/(W/2);
    let lb;
    if(yn>=SPLIT.HEAD_YN) lb='head';
    else if(yn<=SPLIT.LEG_YN) lb = xn<0?'legL':'legR';
    else if(Math.abs(xn)>=SPLIT.ARM_XN) lb = xn<0?'armL':'armR';
    else lb='belly';
    labels[i]=lb;
    xs[i]=x; ys[i]=y;
    if(lb==='head') headVerts.push(i);
    else if(lb==='belly') bellyVerts.push(i);
    // 测量簇带一点容差，保证四肢根部的点也被量到
    if(yn>SPLIT.LEG_YN-0.04 && yn<SPLIT.HEAD_YN+0.02){
      if(xn< -SPLIT.ARM_XN+0.06) armLVerts.push(i);
      if(xn>  SPLIT.ARM_XN-0.06) armRVerts.push(i);
    }
    if(yn<SPLIT.LEG_YN+0.06){
      if(xn<0) legLVerts.push(i); else legRVerts.push(i);
    }
  }

  // ---- 从数据估关节与四肢末端（绝对坐标）----
  const hipY   = box.min.y + H*SPLIT.HIP_YN;
  const spineY = box.min.y + H*SPLIT.SPINE_YN;
  const neckY  = box.min.y + H*SPLIT.HEAD_YN;

  function shoulderPoint(ids, side){
    if(ids.length<4) return new THREE.Vector3(cx+side*H*0.16, neckY-H*0.06, midz);
    const oxs=ids.map(i=>Math.abs(xs[i]-cx));
    const yys=ids.map(i=>ys[i]);
    const zzs=ids.map(i=>pos.getZ(i));
    return new THREE.Vector3(
      cx + side*pct(oxs,0.25),                 // 靠身体内侧 = 手臂根部
      pct(yys,0.8),                            // 簇内偏上
      zzs.reduce((a,b)=>a+b,0)/zzs.length
    );
  }
  function handPoint(ids, side){
    if(ids.length<4) return new THREE.Vector3(cx+side*H*0.3, spineY-H*0.22, midz);
    const oxs=ids.map(i=>Math.abs(xs[i]-cx));
    const yys=ids.map(i=>ys[i]);
    return new THREE.Vector3(cx+side*pct(oxs,0.9), pct(yys,0.12), midz);
  }
  function footPoint(ids, side){
    if(ids.length<4) return new THREE.Vector3(cx+side*H*0.07, box.min.y+0.01, midz);
    const xxs=ids.map(i=>xs[i]);
    return new THREE.Vector3(pct(xxs,0.5), pct(ids.map(i=>ys[i]),0.02), midz);
  }
  const shL=shoulderPoint(armLVerts,-1), shR=shoulderPoint(armRVerts, 1);
  const handL=handPoint(armLVerts,-1), handR=handPoint(armRVerts, 1);
  const footL=footPoint(legLVerts,-1), footR=footPoint(legRVerts, 1);

  // ---- 造骨骼（绑定姿势全部零旋转；位置用绝对坐标，和几何体同一坐标系）----
  const pelvis=new THREE.Bone(); pelvis.position.set(cx,hipY,midz);
  const spine=new THREE.Bone();  spine.position.set(0, spineY-hipY, 0);
  const head=new THREE.Bone();   head.position.set(0, neckY-spineY, 0);
  const armL=new THREE.Bone();   armL.position.set(shL.x-cx, shL.y-spineY, shL.z-midz);
  const armR=new THREE.Bone();   armR.position.set(shR.x-cx, shR.y-spineY, shR.z-midz);
  const legL=new THREE.Bone();   legL.position.set(footL.x-cx, 0, footL.z-midz);
  const legR=new THREE.Bone();   legR.position.set(footR.x-cx, 0, footR.z-midz);
  pelvis.add(spine);
  spine.add(head); spine.add(armL); spine.add(armR);
  pelvis.add(legL); pelvis.add(legR);
  const boneArr=[pelvis,spine,head,armL,armR,legL,legR];
  const boneNames=['pelvis','spine','head','armL','armR','legL','legR'];

  // ---- 每根骨的"骨段"（a→b 绝对坐标）与影响半径 ----
  // 半径从模型实测：四肢取簇内 70 百分位到骨段距离再放宽 1.5 倍
  function limbRadius(ids, a, b){
    if(ids.length<4) return H*0.06;
    const ds=ids.map(i=>distToSeg(pos.getX(i),pos.getY(i),pos.getZ(i), a.x,a.y,a.z, b.x,b.y,b.z));
    return Math.max(H*0.02, pct(ds,0.7)*1.5);
  }
  const rArmL=limbRadius(armLVerts,shL,handL);
  const rArmR=limbRadius(armRVerts,shR,handR);
  const rLegL=limbRadius(legLVerts,new THREE.Vector3(cx,hipY,midz),footL);
  const rLegR=limbRadius(legRVerts,new THREE.Vector3(cx,hipY,midz),footR);
  // 头半径
  let rHead=H*0.16;
  if(headVerts.length){
    const ds=headVerts.map(i=>Math.max(Math.abs(pos.getX(i)-cx),Math.abs(pos.getZ(i)-midz)));
    rHead=pct(ds,0.8)*1.3;   // 奶蛙头特别大，系数放宽保证整个头都在影响范围内
  }
  // 躯干半径（用肚子区域到中轴的横向距离）
  let rBelly=H*0.22;
  if(bellyVerts.length){
    const ds=bellyVerts.map(i=>{
      _v1.set(pos.getX(i)-cx,0,pos.getZ(i)-midz); return _v1.length();
    });
    rBelly=pct(ds,0.8)*1.2;
  }
  // 骨段表：[ax,ay,az, bx,by,bz, radius]
  const segs=[
    [cx,hipY,midz, cx,spineY,midz, rBelly*1.15],          // pelvis
    [cx,spineY,midz, cx,neckY,midz, rBelly],              // spine
    [cx,neckY,midz, cx,box.max.y,midz, rHead],            // head
    [shL.x,shL.y,shL.z, handL.x,handL.y,handL.z, rArmL],  // armL
    [shR.x,shR.y,shR.z, handR.x,handR.y,handR.z, rArmR],  // armR
    [cx,hipY,midz, footL.x,footL.y,footL.z, rLegL],       // legL
    [cx,hipY,midz, footR.x,footR.y,footR.z, rLegR],       // legR
  ];

  // ---- 自动蒙皮权重：w = max(0, 1-d/r)^2，top4 归一 ----
  const skinIdx=new Uint16Array(VN*4);
  const skinW=new Float32Array(VN*4);
  let fallbackCount=0;
  const ws=new Array(boneArr.length);
  // 平滑阶跃
  const ss=(a,b,x)=>{ if(x<=a)return 0; if(x>=b)return 1; const t=(x-a)/(b-a); return t*t*(3-2*t); };
  for(let i=0;i<VN;i++){
    const px=pos.getX(i), py=pos.getY(i), pz=pos.getZ(i);
    let sum=0, best=-1, bestW=1e-6;
    for(let bI=0;bI<boneArr.length;bI++){
      const s=segs[bI];
      const d=distToSeg(px,py,pz, s[0],s[1],s[2],s[3],s[4],s[5]);
      let w=1-d/s[6]; if(w<0) w=0; w=w*w;
      ws[bI]=w; sum+=w;
      if(w>bestW){ bestW=w; best=bI; }
    }
    // 手臂归属场 gL/gR：大臂根部埋在圆胖躯干里，单靠距离会被躯干稀释，
    // 用“内外位置 + 高度”连续场明确归属（大臂主体=1、肩窝平滑、躯干=0）
    const yn=(py-box.min.y)/H, xn=(px-cx)/(W/2);
    const hy=(1-ss(0.60,0.66,yn))*ss(0.26,0.32,yn);   // 只在手臂高度带，上下软边
    const gL=hy*ss(0.30,0.54,-xn);
    const gR=hy*ss(0.30,0.54, xn);
    const os=Math.max(0,1-gL-gR);
    // 臂骨票=归属；非臂骨票按原距离权重并被手臂归属压缩（纯躯干处 os=1，完全同原逻辑）
    const score=[ws[0]*os, ws[1]*os, ws[2]*os, gL, gR, ws[5]*os, ws[6]*os];
    let tot=0; for(let bI=0;bI<7;bI++) tot+=score[bI];
    if(tot<1e-4){
      // 兜底：离哪根骨最近就全归它（理论上极少，半径都是按实测放宽的）
      fallbackCount++;
      for(let k=0;k<4;k++){ skinIdx[i*4+k]=best<0?0:best; skinW[i*4+k]=k===0?1:0; }
      continue;
    }
    for(let bI=0;bI<7;bI++) score[bI]/=tot;   // 归一
    // 取最大的 4 个
    const order=score.map((w,bI)=>[w,bI]).sort((a,b)=>b[0]-a[0]).slice(0,4);
    for(let k=0;k<4;k++){
      skinIdx[i*4+k]=order[k][1];
      skinW[i*4+k]=order[k][0];
    }
  }
  geo.setAttribute('skinIndex', new THREE.BufferAttribute(skinIdx,4));
  geo.setAttribute('skinWeight', new THREE.BufferAttribute(skinW,4));

  // ---- 组装：root > body > rig >（SkinnedMesh + 骨骼）----
  const root=new THREE.Group();
  const body=new THREE.Group();
  const rig=new THREE.Group();
  root.add(body); body.add(rig);
  // 顶点是绝对坐标：rig 平移让脚底贴 y=0、水平居中
  rig.position.set(-cx, -box.min.y, -midz);
  if(SPLIT.YAW) body.rotation.y=SPLIT.YAW;

  // ---- 材质：唯一材质 + 顶点色（分部位涂装靠它）----
  const mat=srcMesh.material.clone();
  mat.vertexColors=true;
  const vColor=new Float32Array(VN*3).fill(1);
  geo.setAttribute('color', new THREE.BufferAttribute(vColor,3));

  const mesh=new THREE.SkinnedMesh(geo, mat);
  mesh.castShadow=true;
  mesh.frustumCulled=false;   // 骨姿态变化后包围盒会偏，关掉裁剪保险
  rig.add(mesh);
  rig.add(pelvis);

  // ---- 绑定蒙皮：先更新世界矩阵，再算逆绑定矩阵，最后 bind ----
  root.updateMatrixWorld(true);
  const skeleton=new THREE.Skeleton(boneArr);
  skeleton.calculateInverses();
  mesh.bind(skeleton);

  // ---- 整体归一化到 TARGET_H ----
  root.scale.setScalar(SPLIT.TARGET_H/H);

  // ---- 清理源模型 ----
  gltf.scene.traverse(n=>{
    if(n.isMesh){ n.geometry.dispose(); }
  });

  // ---- 部位动作结构：每根骨带 pose（动作补间）+ idle（每帧律动）----
  const parts={};
  boneArr.forEach((b,i)=>{
    parts[boneNames[i]]={ bone:b, pose:{x:0,y:0,z:0}, idle:{x:0,y:0,z:0} };
  });

  Dancer.root=root;
  Dancer.body=body;
  Dancer.parts=parts;
  Dancer.mats=[mat];
  Dancer._mat=mat;
  Dancer._colorAttr=geo.attributes.color;
  Dancer._labels=labels;
  Dancer.ready=true;
  Dancer._baseX=body.position.x;
  Dancer._baseY=body.position.y;

  console.log(`%c[奶蛙绑骨] 完成：顶点 ${VN}，7 根骨，兜底顶点 ${fallbackCount} 个`, 'color:#ffe17a');
  if(typeof window!=='undefined') window.__dancer=Dancer;   // 调试只读钩子（同 __game/__music 风格）
}

// ============================================================
// 动作系统
// ============================================================
const P = ()=>Dancer.parts;

// 四方向魔性动作（amp=幅度系数，Perfect 时更大）
export function doAction(dir, quality='good'){
  const amp = quality==='perfect' ? 1.28 : 1.0;
  const parts = P(); if(!parts.armL) return;
  beginGroup('act');   // 本次所有 tw 同组，组内"去程+回程"不互相取消；旧动作的补间被清掉

  if(dir === 0){                       // ← 甩左手（大回环鞭手）
    tw(parts.armL.pose,'z', -2.6, 130, 'outQuad', 0, amp);
    tw(parts.armL.pose,'z',  0,  520, 'outElastic', 140);
    tw(parts.armL.pose,'x', -0.7, 130, 'outQuad', 0, amp);
    tw(parts.armL.pose,'x',  0,  480, 'outElastic', 150);
    tw(Dancer.body.rotation,'z', -0.16, 130, 'outQuad', 0, amp);
    tw(Dancer.body.rotation,'z',  0,  480, 'outElastic', 150);
    if(parts.head){ tw(parts.head.pose,'z', -0.3, 150, 'outQuad', 0, amp); tw(parts.head.pose,'z', 0, 420, 'outElastic', 170); }
  }
  else if(dir === 1){                  // ↓ 双踢腿（扫堂腿 + 下蹲）
    if(parts.legL){ tw(parts.legL.pose,'x', -1.5, 120, 'outQuad', 0, amp); tw(parts.legL.pose,'x', 0, 460, 'outElastic', 130); }
    if(parts.legR){ tw(parts.legR.pose,'x',  1.1, 140, 'outQuad', 60, amp); tw(parts.legR.pose,'x', 0, 460, 'outElastic', 210); }
    tw(Dancer.body.position,'y', -0.14, 130, 'outQuad', 0, amp);
    tw(Dancer.body.position,'y',  0,  430, 'outElastic', 140);
  }
  else if(dir === 2){                  // ↑ 扭脊柱 + 抬头（肚子是整块网格的中段，扭转交给脊柱骨）
    tw(parts.spine.pose,'y',  0.5, 140, 'outQuad', 0, amp);
    tw(parts.spine.pose,'y', -0.32, 240, 'inOutCubic', 150);
    tw(parts.spine.pose,'y',  0,   420, 'outElastic', 400);
    if(parts.head){ tw(parts.head.pose,'x', -0.62, 150, 'outBack', 0, amp); tw(parts.head.pose,'x', 0, 520, 'outElastic', 180); }
    tw(Dancer.body.scale,'x', 0.9, 130, 'outQuad', 0, amp);
    tw(Dancer.body.scale,'x', 1,  440, 'outElastic', 140);
  }
  else if(dir === 3){                  // → 整体大回旋 360°
    const b = Dancer.body;
    tw(b.rotation,'y', Math.PI*2, 420, 'inOutCubic', 0, amp);
    // 转完归零（360°≡0）；若这 460ms 内又有新的转身补间，就别硬归零打断它
    setTimeout(()=>{
      if(Dancer.body===b && !Dancer._tweens.some(w=>w.obj===b.rotation && w.axis==='y')) b.rotation.y = 0;
    }, 460);
    tw(b.scale,'x', 0.82, 150, 'outQuad', 0, amp);
    tw(b.scale,'x', 1,  460, 'outElastic', 160);
    if(parts.armR){ tw(parts.armR.pose,'z', 2.6, 140, 'outQuad', 0, amp); tw(parts.armR.pose,'z', 0, 500, 'outElastic', 150); }
  }
}

// Miss：踉跄 + 全身闪红
let _stumbleT = 0;
export function stumble(){
  const now = performance.now();
  if(now - _stumbleT < 320) return;    // 节流，连 miss 不至于抽搐
  _stumbleT = now;
  const b = Dancer.body;
  if(!b) return;   // ★ 舞者尚未加载就位时忽略（防止游戏循环刷空引用错误）
  beginGroup('miss');
  tw(b.rotation,'z',  0.3, 90, 'outQuad');
  tw(b.rotation,'z', -0.22, 180, 'inOutCubic', 100);
  tw(b.rotation,'z',  0,   320, 'outElastic', 290);
  const parts = P();
  if(parts.head){ tw(parts.head.pose,'z', 0.4, 120, 'outQuad'); tw(parts.head.pose,'z', 0, 400, 'outElastic', 140); }
  // 材质闪红（整块网格只有一个材质，整体染红再恢复，跳过 emissive 兼容问题）
  const m=Dancer._mat;
  if(m){
    m.color.setHex(0xff5566);
    setTimeout(()=>{ m.color.setHex(0xffffff); }, 220);
  }
}

// 结算庆祝：蹦跳 + 挥双手 + 转圈
export function celebrate(){
  const parts = P(); const b = Dancer.body;
  beginGroup('cel');
  for(let i=0;i<3;i++){
    tw(b.position,'y', 0.55, 180, 'outQuad', i*420);
    tw(b.position,'y', 0,    240, 'outQuad', i*420+190);
  }
  tw(b.rotation,'y', Math.PI*2, 700, 'inOutCubic', 200);
  setTimeout(()=>{ if(!Dancer._tweens.some(w=>w.obj===b.rotation && w.axis==='y')) b.rotation.y = 0; }, 950);
  if(parts.armL){ tw(parts.armL.pose,'z', -2.8, 200, 'outBack');  tw(parts.armL.pose,'z', 0, 600, 'outElastic', 800); }
  if(parts.armR){ tw(parts.armR.pose,'z',  2.8, 200, 'outBack');  tw(parts.armR.pose,'z', 0, 600, 'outElastic', 800); }
}

// ★ 结算失败：躺地上（整体后倒 + 四肢摊开 + 垂头）
export function lieDown(){
  const b = Dancer.body; if(!b) return;
  const parts = P();
  beginGroup('lie');
  tw(b.rotation,'x', -Math.PI*0.46, 520, 'outQuad');   // 向后倒下接近躺平
  tw(b.position,'y', (Dancer._baseY||0) - 0.35, 520, 'outQuad');
  if(parts.armL){ tw(parts.armL.pose,'z', -0.55, 420, 'outQuad'); }
  if(parts.armR){ tw(parts.armR.pose,'z',  0.55, 420, 'outQuad'); }
  if(parts.legL){ tw(parts.legL.pose,'x',  0.35, 420, 'outQuad'); }
  if(parts.legR){ tw(parts.legR.pose,'x',  0.35, 420, 'outQuad'); }
  if(parts.head){ tw(parts.head.pose,'x', -0.5,  420, 'outQuad'); }
}

// ★ 开演前复位 body（清除上局 celebrate/lieDown/stumble 残留）
export function resetBody(){
  const b = Dancer.body; if(!b) return;
  Dancer._tweens.length = 0;            // 清空补间
  b.rotation.set(0,0,0);
  b.position.x = Dancer._baseX || 0;
  b.position.y = Dancer._baseY || 0;
  b.scale.set(1,1,1);
  // 骨骼 pose 复位
  for(const k in Dancer.parts){
    const p = Dancer.parts[k];
    p.pose.x=0; p.pose.y=0; p.pose.z=0;
  }
}

// ============================================================
// 每帧更新：补间 + 律动
// ============================================================
export function updateDancer(dt, bpm, dancing){
  if(!Dancer.ready) return;
  const now = performance.now();

  // ---- 处理补间队列 ----
  for(let i=Dancer._tweens.length-1;i>=0;i--){
    const w = Dancer._tweens[i];
    if(now < w.t0) continue;
    if(w.from === null) w.from = w.obj[w.axis];
    let t = (now - w.t0) / w.dur;
    if(t >= 1){ w.obj[w.axis] = w.to; Dancer._tweens.splice(i,1); continue; }
    w.obj[w.axis] = w.from + (w.to - w.from) * EASE[w.ease](t);
  }

  // ---- 律动：演出中手脚脊腿全动（跟节拍），待机时整体轻扭 ----
  const bps = (dancing? bpm : 100) / 60;
  Dancer._beatPhase += dt * bps * Math.PI;          // 半拍一相位
  const s = Math.sin(Dancer._beatPhase);
  const c = Math.cos(Dancer._beatPhase * 0.5);
  const s2 = Math.sin(Dancer._beatPhase * 2);       // 倍频，用于更密集的动作
  const b = Dancer.body;
  const parts = Dancer.parts;

  if(dancing){
    // ========== 演出中：跟节拍律动（动作补间是主角，律动打底） ==========
    const e = 1.0;
    if(!Dancer._tweens.some(w=>w.obj===b.position && w.axis==='y')){
      b.position.y = Math.abs(s) * 0.12 * e;
    }
    if(!Dancer._tweens.some(w=>w.obj===b.position && w.axis==='x')){
      b.position.x = (Dancer._baseX||0) + Math.sin(Dancer._beatPhase*0.5) * 0.8;
    }
    if(!Dancer._tweens.some(w=>w.obj===b.scale)){
      b.scale.x = 1 + s * 0.04 * e;
      b.scale.y = 1 - s * 0.04 * e;
    }
    if(!Dancer._tweens.some(w=>w.obj===b.rotation)){
      b.rotation.z = s * 0.09 * e;
      b.rotation.y = c * 0.13 * e;
    }
    // 手臂
    if(parts.armL){ parts.armL.idle.x = s * 0.55 * e; parts.armL.idle.z = s2 * 0.22 * e; }
    if(parts.armR){ parts.armR.idle.x = -s * 0.55 * e; parts.armR.idle.z = -s2 * 0.22 * e; }
    // 脊柱（带轻微左右扭）
    if(parts.spine){ parts.spine.idle.y = s * 0.14 * e; parts.spine.idle.z = c * 0.06 * e; }
    // 腿
    if(parts.legL){ parts.legL.idle.x = Math.max(0,s) * 0.45 * e; parts.legL.idle.z = s2 * 0.1 * e; }
    if(parts.legR){ parts.legR.idle.x = Math.max(0,-s) * 0.45 * e; parts.legR.idle.z = -s2 * 0.1 * e; }
    // 头
    if(parts.head){ parts.head.idle.x = c * 0.18 * e; parts.head.idle.z = s * 0.1 * e; }
    // 骨盆本身不扭（整体摇摆都在 body 上）
    if(parts.pelvis){ parts.pelvis.idle.x=0; parts.pelvis.idle.y=0; parts.pelvis.idle.z=0; }
  }else{
    // ========== 待机：整体轻微扭动 + 呼吸，骨骼几乎不动 ==========
    const e = 0.55;
    if(!Dancer._tweens.some(w=>w.obj===b.position && w.axis==='y')){
      b.position.y = Math.abs(s) * 0.05 * e;
    }
    if(!Dancer._tweens.some(w=>w.obj===b.position && w.axis==='x')){
      b.position.x = Dancer._baseX || 0;
    }
    if(!Dancer._tweens.some(w=>w.obj===b.scale)){
      b.scale.x = 1 + s * 0.015 * e;
      b.scale.y = 1 - s * 0.015 * e;
    }
    if(!Dancer._tweens.some(w=>w.obj===b.rotation)){
      b.rotation.z = s * 0.04 * e;
      b.rotation.y = c * 0.06 * e;
    }
    if(parts.head){ parts.head.idle.z = s * 0.03 * e; parts.head.idle.x = c * 0.02 * e; }
    if(parts.armL) parts.armL.idle.x = s * 0.08 * e;
    if(parts.armR) parts.armR.idle.x = -s * 0.08 * e;
    for(const k of ['pelvis','spine','legL','legR']){
      if(parts[k]){ parts[k].idle.x=0; parts[k].idle.y=0; parts[k].idle.z=0; }
    }
  }

  // ---- 合成最终骨姿态：pose + idle（绑定姿势为零旋转）----
  for(const k in parts){
    const p = parts[k];
    p.bone.rotation.set(
      p.pose.x + p.idle.x,
      p.pose.y + p.idle.y,
      p.pose.z + p.idle.z
    );
  }
}

// ============================================================
// 涂装：单材质 + 顶点色，按部位标签分别染头/肚子
// ============================================================
const _cHead=new THREE.Color(), _cBelly=new THREE.Color();
export function setSkin(skin){
  if(!Dancer.ready) return;
  const attr=Dancer._colorAttr, labels=Dancer._labels;
  _cHead.setHex(skin.colors.head ?? 0xffffff);
  _cBelly.setHex(skin.colors.belly ?? 0xffffff);
  for(let i=0;i<labels.length;i++){
    const lb=labels[i];
    if(lb==='head') attr.setXYZ(i,_cHead.r,_cHead.g,_cHead.b);
    else if(lb==='belly') attr.setXYZ(i,_cBelly.r,_cBelly.g,_cBelly.b);
    else attr.setXYZ(i,1,1,1);
  }
  attr.needsUpdate=true;
  // 发光涂装（材质带 emissive 才生效）
  const m=Dancer._mat;
  if(m && 'emissive' in m){
    if(skin.glow){ m.emissive.setHex(skin.glow); m.emissiveIntensity=0.22; }
    else m.emissiveIntensity=0;
  }
}
