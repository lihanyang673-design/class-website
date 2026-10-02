// ============================================================
// dancer.js —— 奶娃舞者（核心模块）
//
// 模型 rigged.glb 是【单块网格、无骨骼、无蒙皮】，无法用骨骼做动作。
// 解决方案：把整块网格按【三角面质心】切成 6 个独立部位 ——
//   头 head / 肚子 belly / 左手 armL / 右手 armR / 左腿 legL / 右腿 legR
// 每个部位挂在一个 Pivot（枢轴）上，旋转枢轴 = 关节动作。
//
// 切分规则（可调常数在下方 SPLIT 区，跑起来不对就改这几个数）：
//   头   ：质心高度 > 62% 身高（奶娃头大）
//   腿   ：质心高度 < 30% 身高，按 x 正负分左右
//   手臂 ：中段且 |x| > 42% 半身宽（在身体两侧）
//   其余 ：肚子
// ============================================================
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// ---------------- 可调切分参数（看效果后微调这里） ----------------
// 【重叠带 OVERLAP】：相邻部位在边界处各伸出 8% 身高的三角形，
// 这样关节旋转时边界三角形被两个部位同时持有，不会出现"缝隙/撕裂"。
const SPLIT = {
  HEAD_YN : 0.62,  // 头：质心高于身高的 62%（主边界）
  LEG_YN  : 0.30,  // 腿：质心低于身高的 30%（主边界）
  ARM_XN  : 0.42,  // 手臂：|归一化x| > 0.42（主边界）
  OVERLAP : 0.08,  // ★ 重叠带 = 8% 身高（边界模糊区，三角形同时归属两边）
  TARGET_H: 2.0,   // 舞者归一化后的目标身高（世界单位）
  YAW     : 0,     // 模型朝向微调（若背对镜头改成 Math.PI）
};

// ---------------- 模块内状态 ----------------
export const Dancer = {
  root : null,        // 挂进场景的总根
  body : null,        // body 组（负责整体位移/旋转/挤压）
  parts: {},          // { head:{pivot,mesh,base,pose,idle}, ... }
  mats : [],          // 6 个部位材质（涂装/受击闪红用）
  ready: false,
  _tweens: [],        // 动作补间队列
  _beatPhase: 0,      // 待机律动相位
};

// 小补间工具：把 obj[axis] 从当前值补到 to
function tw(obj, axis, to, dur, ease='outQuad', delay=0, amp=1){
  Dancer._tweens.push({ obj, axis, from:null, to:to*amp, t0:performance.now()+delay, dur, ease });
}
const EASE = {
  outQuad  : t=>1-(1-t)*(1-t),
  outBack  : t=>{const s=1.9;t--;return 1+t*t*((s+1)*t+s);},
  outElastic:t=>{if(t>=1)return 1;const p=0.42;return Math.pow(2,-9*t)*Math.sin((t-p/4)*(2*Math.PI)/p)+1;},
  inOutCubic: t=>t<.5?4*t*t*t:1-Math.pow(-2*t+2,3)/2,
};

// ============================================================
// 加载 + 切分
// ============================================================
export function loadDancer(url){
  return new Promise((resolve, reject)=>{
    console.log('%c  ⏳ [加载] rigged.glb 舞者模型开始下载/解析…', 'color:#c9b8e8');
    const _t=performance.now();
    new GLTFLoader().load(url, (gltf)=>{
      try{
        build(gltf);
        console.log(`%c  ✅ [加载] rigged.glb 解析+部位切分完成 (${((performance.now()-_t)/1000).toFixed(2)}s)`, 'color:#7fffd4');
        resolve(Dancer);
      }catch(e){ console.error('  ❌ rigged.glb 切分失败：', e); reject(e); }
    }, (xhr)=>{
      if(xhr.total){
        const pct = Math.round(xhr.loaded/xhr.total*100);
        window.dispatchEvent(new CustomEvent('dancer-progress',{detail:pct}));
      }
    }, (err)=>{ console.error('  ❌ rigged.glb 下载失败：', err); reject(err); });
  });
}

function build(gltf){
  // ---- 找到模型里的第一个 Mesh ----
  let srcMesh = null;
  gltf.scene.traverse(n=>{ if(!srcMesh && n.isMesh) srcMesh = n; });
  if(!srcMesh) throw new Error('rigged.glb 里没找到网格');

  srcMesh.updateWorldMatrix(true, false);
  const mw   = srcMesh.matrixWorld;                       // 把节点自带的旋转烤进顶点
  const nmat = new THREE.Matrix3().getNormalMatrix(mw);

  // ---- 总包围盒（世界系）----
  const box = new THREE.Box3().setFromObject(gltf.scene);
  const size = box.getSize(new THREE.Vector3());
  const H = size.y, W = size.x, cx = (box.min.x+box.max.x)/2;

  // ---- 取源几何数据 ----
  const g  = srcMesh.geometry;
  const pos = g.attributes.position;
  const nor = g.attributes.normal;
  const uv  = g.attributes.uv;
  const idx = g.index;
  const triCount = (idx ? idx.count : pos.count) / 3;

  // ---- 分类桶：每个部位收集三角形顶点 ----
  // 【重叠带方案】质心落在主边界 ±OVERLAP 模糊带内的三角形，同时归到相邻两个部位，
  // 这样关节旋转时两边各有一份三角形覆盖边界，不会出现缝隙/撕裂。
  const PARTS = ['head','belly','armL','armR','legL','legR'];
  const buckets = {}; PARTS.forEach(p=>buckets[p]=[]);
  const vA=new THREE.Vector3(), vB=new THREE.Vector3(), vC=new THREE.Vector3();
  const cen=new THREE.Vector3(), nA=new THREE.Vector3(), nB=new THREE.Vector3(), nC=new THREE.Vector3();
  const OL = SPLIT.OVERLAP;     // 重叠带半宽

  // 把一个三角形推入指定部位桶（位置/法线/UV 各 8 个数）
  // ★ i0/i1/i2 必须作为参数传入，因为 const 是块级作用域，函数定义在循环外无法直接访问循环内的 i0/i1/i2
  function pushTri(part, i0, i1, i2){
    buckets[part].push(
      vA.x,vA.y,vA.z, nA.x,nA.y,nA.z, uv?uv.getX(i0):0, uv?uv.getY(i0):0,
      vB.x,vB.y,vB.z, nB.x,nB.y,nB.z, uv?uv.getX(i1):0, uv?uv.getY(i1):0,
      vC.x,vC.y,vC.z, nC.x,nC.y,nC.z, uv?uv.getX(i2):0, uv?uv.getY(i2):0,
    );
  }

  for(let t=0;t<triCount;t++){
    const i0 = idx? idx.getX(t*3)   : t*3;
    const i1 = idx? idx.getX(t*3+1) : t*3+1;
    const i2 = idx? idx.getX(t*3+2) : t*3+2;
    // 顶点 -> 世界系（烤掉节点矩阵）
    vA.fromBufferAttribute(pos,i0).applyMatrix4(mw);
    vB.fromBufferAttribute(pos,i1).applyMatrix4(mw);
    vC.fromBufferAttribute(pos,i2).applyMatrix4(mw);
    cen.copy(vA).add(vB).add(vC).divideScalar(3);

    // ---- 质心分类（带重叠带）----
    const yn = (cen.y - box.min.y) / H;              // 0=脚底 1=头顶
    const xn = (cen.x - cx) / (W/2);                 // -1=左 1=右

    // 法线变换（用矩阵3）
    if(nor){
      nA.fromBufferAttribute(nor,i0).applyMatrix3(nmat).normalize();
      nB.fromBufferAttribute(nor,i1).applyMatrix3(nmat).normalize();
      nC.fromBufferAttribute(nor,i2).applyMatrix3(nmat).normalize();
    }

    // ---- 头 / 肚子 边界：HEAD_YN ± OL ----
    const isHead = yn > SPLIT.HEAD_YN - OL;
    const isBellyH = yn < SPLIT.HEAD_YN + OL;
    // ---- 腿 / 肚子 边界：LEG_YN ± OL ----
    const isLeg = yn < SPLIT.LEG_YN + OL;
    const isBellyL = yn > SPLIT.LEG_YN - OL;
    // ---- 手臂 / 肚子 边界：ARM_XN ± OL ----
    const absX = Math.abs(xn);
    const isArm = absX > SPLIT.ARM_XN - OL;
    const isBellyX = absX < SPLIT.ARM_XN + OL;

    // 腿分左右（只在腿区域内判断）
    const legSide = xn < 0 ? 'legL' : 'legR';
    // 手臂分左右
    const armSide = xn < 0 ? 'armL' : 'armR';

    // ---- 按区域归属（重叠带内三角形推入多个桶）----
    if(isHead) pushTri('head', i0, i1, i2);
    if(isLeg)  pushTri(legSide, i0, i1, i2);

    // 中段（肚子/手臂）：需要同时满足"不是纯头区"和"不是纯腿区"
    const midBelly = isBellyH && isBellyL;   // 在头腿之间
    if(midBelly){
      if(isArm) pushTri(armSide, i0, i1, i2);             // 手臂区域（含与肚子的重叠带）
      if(isBellyX) pushTri('belly', i0, i1, i2);          // 肚子区域（含与手臂的重叠带）
    }
  }

  // ---- 源材质（贴图共享，材质克隆 6 份便于涂装/闪红）----
  const srcMat = srcMesh.material;

  // ---- 组装：root > body > 各部位 pivot ----
  const root = new THREE.Group();                    // 总根
  const body = new THREE.Group();                    // 整体动作组
  root.add(body);
  // 落地 + 居中：顶点已是世界系绝对坐标，body 平移让脚底贴 y=0、水平居中
  body.position.set(-cx, -box.min.y, -(box.min.z+box.max.z)/2);
  if(SPLIT.YAW) body.rotation.y = SPLIT.YAW;

  const srcBox = box.clone();
  const parts = {};
  const mats = [];

  // —— 三段数组（位置/法线/UV）拼装每个部位的几何体 ——
  for(const p of PARTS){
    const arr = buckets[p];
    if(!arr.length) continue;
    const P=[],N=[],U=[];
    for(let i=0;i<arr.length;i+=8){
      P.push(arr[i],arr[i+1],arr[i+2]);
      N.push(arr[i+3],arr[i+4],arr[i+5]);
      U.push(arr[i+6],arr[i+7]);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(P,3));
    geo.setAttribute('normal',   new THREE.Float32BufferAttribute(N,3));
    geo.setAttribute('uv',       new THREE.Float32BufferAttribute(U,2));
    geo.computeBoundingBox();
    geo.computeBoundingSphere();

    const mat = srcMat.clone();
    mats.push(mat);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true;
    mesh.frustumCulled = false;   // 部位旋转后包围盒会偏，关掉裁剪保险

    // ---- 枢轴位置：各关节的世界坐标（转到 body 本地 = 世界坐标 - body.position）----
    const bb = geo.boundingBox;
    let pivotPos;
    switch(p){
      case 'head': pivotPos = new THREE.Vector3((bb.min.x+bb.max.x)/2, bb.min.y, (bb.min.z+bb.max.z)/2); break; // 脖子
      case 'armL': pivotPos = new THREE.Vector3(bb.max.x*0.82, bb.max.y*0.92, (bb.min.z+bb.max.z)/2); break;    // 肩
      case 'armR': pivotPos = new THREE.Vector3(bb.min.x*0.82, bb.max.y*0.92, (bb.min.z+bb.max.z)/2); break;    // 肩
      case 'legL': pivotPos = new THREE.Vector3((bb.min.x+bb.max.x)/2, bb.max.y, (bb.min.z+bb.max.z)/2); break; // 胯
      case 'legR': pivotPos = new THREE.Vector3((bb.min.x+bb.max.x)/2, bb.max.y, (bb.min.z+bb.max.z)/2); break; // 胯
      default   : pivotPos = new THREE.Vector3(0, bb.min.y, (bb.min.z+bb.max.z)/2); break;                      // 脊柱底
    }
    pivotPos.sub(body.position);               // 世界坐标 → body 本地坐标
    const pivot = new THREE.Group();
    pivot.position.copy(pivotPos);
    mesh.position.copy(pivotPos).negate();     // 网格相对枢轴反向偏移，落回原位
    pivot.add(mesh);
    body.add(pivot);

    parts[p] = {
      pivot, mesh, mat,
      base : {x:pivot.rotation.x, y:pivot.rotation.y, z:pivot.rotation.z},
      pose : {x:0, y:0, z:0},        // 动作偏移（补间写入）
      idle : {x:0, y:0, z:0},        // 待机律动偏移（每帧写入）
    };
  }

  // ---- 整体归一化到 TARGET_H ----
  root.scale.setScalar(SPLIT.TARGET_H / srcBox.getSize(new THREE.Vector3()).y);

  // ---- 清理源模型 ----
  gltf.scene.traverse(n=>{
    if(n.isMesh){ n.geometry.dispose(); }
  });

  Dancer.root = root;
  Dancer.body = body;
  Dancer.parts = parts;
  Dancer.mats = mats;
  Dancer.ready = true;
  Dancer._baseX = body.position.x;   // 记录初始水平位（跑动/复位用）
  Dancer._baseY = body.position.y;

  // 调试输出：各部位三角面数
  const stat = PARTS.map(p=>`${p}=${(buckets[p].length/24)|0}`).join(' ');
  console.log('%c[奶娃切分] 完成：'+stat, 'color:#ffe17a');
  window.__danceParts = parts;   // 控制台可查
}

// ============================================================
// 动作系统
// ============================================================
const P = ()=>Dancer.parts;

// 四方向魔性动作（amp=幅度系数，Perfect 时更大）
export function doAction(dir, quality='good'){
  const amp = quality==='perfect' ? 1.28 : 1.0;
  const parts = P(); if(!parts.armL) return;

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
  else if(dir === 2){                  // ↑ 扭肚子 + 抬头
    tw(parts.belly.pose,'y',  0.62, 140, 'outQuad', 0, amp);
    tw(parts.belly.pose,'y', -0.42, 240, 'inOutCubic', 150);
    tw(parts.belly.pose,'y',  0,   420, 'outElastic', 400);
    if(parts.head){ tw(parts.head.pose,'x', -0.62, 150, 'outBack', 0, amp); tw(parts.head.pose,'x', 0, 520, 'outElastic', 180); }
    tw(Dancer.body.scale,'x', 0.9, 130, 'outQuad', 0, amp);
    tw(Dancer.body.scale,'x', 1,  440, 'outElastic', 140);
  }
  else if(dir === 3){                  // → 整体大回旋 360°
    const b = Dancer.body;
    tw(b.rotation,'y', Math.PI*2, 420, 'inOutCubic', 0, amp);
    setTimeout(()=>{ if(Dancer.body===b) b.rotation.y = 0; }, 460);  // 转完归零（360°≡0）
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
  tw(b.rotation,'z',  0.3, 90, 'outQuad');
  tw(b.rotation,'z', -0.22, 180, 'inOutCubic', 100);
  tw(b.rotation,'z',  0,   320, 'outElastic', 290);
  const parts = P();
  if(parts.head){ tw(parts.head.pose,'z', 0.4, 120, 'outQuad'); tw(parts.head.pose,'z', 0, 400, 'outElastic', 140); }
  // 材质闪红
  Dancer.mats.forEach(m=>{
    m.emissive = m.emissive || new THREE.Color(0,0,0);
    m.emissive.setHex(0xff2244);
    m.emissiveIntensity = 0.85;
  });
  setTimeout(()=>{ Dancer.mats.forEach(m=>{ if(m.emissive) m.emissiveIntensity = 0; }); }, 220);
}

// 结算庆祝：蹦跳 + 挥双手 + 转圈
export function celebrate(){
  const parts = P(); const b = Dancer.body;
  for(let i=0;i<3;i++){
    tw(b.position,'y', 0.55, 180, 'outQuad', i*420);
    tw(b.position,'y', 0,    240, 'outQuad', i*420+190);
  }
  tw(b.rotation,'y', Math.PI*2, 700, 'inOutCubic', 200);
  setTimeout(()=>{ b.rotation.y = 0; }, 950);
  if(parts.armL){ tw(parts.armL.pose,'z', -2.8, 200, 'outBack');  tw(parts.armL.pose,'z', 0, 600, 'outElastic', 800); }
  if(parts.armR){ tw(parts.armR.pose,'z',  2.8, 200, 'outBack');  tw(parts.armR.pose,'z', 0, 600, 'outElastic', 800); }
}

// ★ 结算失败：躺地上（整体后倒 + 四肢摊开 + 垂头）
export function lieDown(){
  const b = Dancer.body; if(!b) return;
  const parts = P();
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
  // 局部 pose 复位
  for(const k in Dancer.parts){
    const p = Dancer.parts[k];
    p.pose.x=0; p.pose.y=0; p.pose.z=0;
  }
}

// ============================================================
// 每帧更新：补间 + 待机律动
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

  // ---- 律动：演出中手脚肚腿全动（跟节拍），待机时整体轻扭 ----
  const bps = (dancing? bpm : 100) / 60;
  Dancer._beatPhase += dt * bps * Math.PI;          // 半拍一相位
  const s = Math.sin(Dancer._beatPhase);
  const c = Math.cos(Dancer._beatPhase * 0.5);
  const s2 = Math.sin(Dancer._beatPhase * 2);       // 倍频，用于更密集的动作
  const b = Dancer.body;
  const parts = Dancer.parts;

  if(dancing){
    // ========== 演出中：手脚肚腿全开，跟节拍狂扭 ==========
    const e = 1.0;
    // 整体弹跳 + 呼吸
    if(!Dancer._tweens.some(w=>w.obj===b.position && w.axis==='y')){
      b.position.y = Math.abs(s) * 0.12 * e;
    }
    // ★ 整体左右跑动（不止原地摇摆，真的在舞台跑来跑去）
    if(!Dancer._tweens.some(w=>w.obj===b.position && w.axis==='x')){
      b.position.x = (Dancer._baseX||0) + Math.sin(Dancer._beatPhase*0.5) * 0.8;
    }
    if(!Dancer._tweens.some(w=>w.obj===b.scale)){
      b.scale.x = 1 + s * 0.04 * e;
      b.scale.y = 1 - s * 0.04 * e;
    }
    // 整体左右大幅摇摆
    if(!Dancer._tweens.some(w=>w.obj===b.rotation)){
      b.rotation.z = s * 0.12 * e;
      b.rotation.y = c * 0.15 * e;
    }
    // 手臂：大幅上下甩动（左右交替）
    if(parts.armL){ parts.armL.idle.x = s * 0.9 * e; parts.armL.idle.z = s2 * 0.4 * e; }
    if(parts.armR){ parts.armR.idle.x = -s * 0.9 * e; parts.armR.idle.z = -s2 * 0.4 * e; }
    // 肚子：左右扭
    if(parts.belly){ parts.belly.idle.y = s * 0.35 * e; parts.belly.idle.z = c * 0.12 * e; }
    // 腿：左右交替踏步
    if(parts.legL){ parts.legL.idle.x = Math.max(0,s) * 0.7 * e; parts.legL.idle.z = s2 * 0.2 * e; }
    if(parts.legR){ parts.legR.idle.x = Math.max(0,-s) * 0.7 * e; parts.legR.idle.z = -s2 * 0.2 * e; }
    // 头：跟节拍点头
    if(parts.head){ parts.head.idle.x = c * 0.25 * e; parts.head.idle.z = s * 0.15 * e; }
  }else{
    // ========== 待机：整体轻微扭动 + 呼吸，局部几乎不动（防撕裂）==========
    const e = 0.55;
    if(!Dancer._tweens.some(w=>w.obj===b.position && w.axis==='y')){
      b.position.y = Math.abs(s) * 0.05 * e;
    }
    // ★ 待机时 x 复位（演出跑动后回到舞台中央）
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
    // 待机时局部幅度极小
    if(parts.head){ parts.head.idle.z = s * 0.03 * e; parts.head.idle.x = c * 0.02 * e; }
    if(parts.armL) parts.armL.idle.x = s * 0.08 * e;
    if(parts.armR) parts.armR.idle.x = -s * 0.08 * e;
    if(parts.belly){ parts.belly.idle.y = 0; parts.belly.idle.x = 0; parts.belly.idle.z = 0; }
    if(parts.legL){ parts.legL.idle.x = 0; parts.legL.idle.y = 0; parts.legL.idle.z = 0; }
    if(parts.legR){ parts.legR.idle.x = 0; parts.legR.idle.y = 0; parts.legR.idle.z = 0; }
  }

  // ---- 合成最终姿态：base + pose + idle ----
  for(const k in parts){
    const p = parts[k];
    p.pivot.rotation.set(
      p.base.x + p.pose.x + p.idle.x,
      p.base.y + p.pose.y + p.idle.y,
      p.base.z + p.pose.z + p.idle.z
    );
    // idle 衰减到 0 附近没关系，每帧都会重写
  }
}

// ============================================================
// 涂装：给 6 个部位上色（map 保留，color 相乘）
// ============================================================
export function setSkin(skin){
  if(!Dancer.ready) return;
  Dancer.mats.forEach(m=>{ m.color.setHex(0xffffff); });
  for(const k in skin.colors){
    const p = Dancer.parts[k];
    if(p) p.mat.color.setHex(skin.colors[k]);
  }
  if(skin.glow){
    Dancer.mats.forEach(m=>{ m.emissive = m.emissive||new THREE.Color(); m.emissive.setHex(skin.glow); m.emissiveIntensity = 0.22; });
  } else {
    Dancer.mats.forEach(m=>{ if(m.emissive) m.emissiveIntensity = 0; });
  }
}
