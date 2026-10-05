// ============================================================
// fx.js —— 舞台特效：粒子爆发 / 地板闪光 / 迪斯科球 / 镜头反馈
// ============================================================
import * as THREE from 'three';

export const Fx = {
  ready:false,
  _bursts:[],     // 粒子爆发池
  _rings:[],      // 地板冲击环
  _strips:[],     // 4 条轨道地板灯
  _spotA:null, _spotB:null,   // 扫描灯
  _disco:null,    // 迪斯科球
  _shakeT:0, _shakeMag:0,
  _beatT:0,
  camBase:new THREE.Vector3(0,2.0,5.2),
};

let sceneRef=null, camRef=null;

// 柔光圆点贴图（canvas 现画，无外部文件）
function dotTexture(){
  const c=document.createElement('canvas'); c.width=c.height=64;
  const g=c.getContext('2d');
  const rg=g.createRadialGradient(32,32,2,32,32,30);
  rg.addColorStop(0,'rgba(255,255,255,1)');
  rg.addColorStop(0.4,'rgba(255,255,255,.6)');
  rg.addColorStop(1,'rgba(255,255,255,0)');
  g.fillStyle=rg; g.fillRect(0,0,64,64);
  const t=new THREE.CanvasTexture(c); return t;
}

export function initFx(scene, camera){
  sceneRef=scene; camRef=camera;

  // ---- 4 条轨道地板灯（跟 DOM 轨道对应，命中时闪） ----
  for(let i=0;i<4;i++){
    const m=new THREE.Mesh(
      new THREE.PlaneGeometry(0.85,0.6),
      new THREE.MeshBasicMaterial({color:0x000000,transparent:true,opacity:0.0,side:THREE.DoubleSide})
    );
    m.rotation.x=-Math.PI/2;
    m.position.set((i-1.5)*0.95, 0.02, 1.7);
    scene.add(m);
    Fx._strips.push(m);
  }

  // ---- 迪斯科球 ----
  const disco=new THREE.Group();
  const ball=new THREE.Mesh(
    new THREE.IcosahedronGeometry(0.42,1),
    new THREE.MeshStandardMaterial({color:0xbfd8ff,metalness:1,roughness:0.18,flatShading:true})
  );
  disco.add(ball);
  const rope=new THREE.Mesh(
    new THREE.CylinderGeometry(0.015,0.015,1.6),
    new THREE.MeshBasicMaterial({color:0x333333})
  );
  rope.position.y=1.0; disco.add(rope);
  disco.position.set(0,4.0,-0.5);
  scene.add(disco);
  Fx._disco=disco;

  // ---- 双色扫描灯 ----
  const mk=(color,x)=>{
    const s=new THREE.SpotLight(color,60,30,0.32,0.5,1.6);
    s.position.set(x,6.5,2.5);
    s.target.position.set(0,0,-1);
    scene.add(s); scene.add(s.target);
    return s;
  };
  Fx._spotA=mk(0xff3b6b,-4.5);
  Fx._spotB=mk(0x36d1ff, 4.5);

  Fx.ready=true;
}

// ---------- 粒子爆发 ----------
const _dotTex = { v:null };
export function burst(pos, hex=0xffe17a, n=60){
  if(!Fx.ready) return;
  if(!_dotTex.v) _dotTex.v=dotTexture();
  const geo=new THREE.BufferGeometry();
  const P=new Float32Array(n*3), V=[];
  for(let i=0;i<n;i++){
    P[i*3]=pos.x; P[i*3+1]=pos.y; P[i*3+2]=pos.z;
    const a=Math.random()*Math.PI*2, b=Math.random()*Math.PI-Math.PI/2, sp=2+Math.random()*4.5;
    V.push(new THREE.Vector3(Math.cos(a)*Math.cos(b)*sp, Math.abs(Math.sin(b))*sp+1.5, Math.sin(a)*Math.cos(b)*sp));
  }
  geo.setAttribute('position',new THREE.BufferAttribute(P,3));
  const mat=new THREE.PointsMaterial({
    size:0.14, map:_dotTex.v, color:hex, transparent:true, opacity:1,
    depthWrite:false, blending:THREE.AdditiveBlending,
  });
  const pts=new THREE.Points(geo,mat);
  sceneRef.add(pts);
  Fx._bursts.push({pts,V,life:0,dur:0.75});
}

// ---------- 地板冲击环 ----------
export function ringPulse(x,z,hex=0xffe17a){
  if(!Fx.ready) return;
  const m=new THREE.Mesh(
    new THREE.RingGeometry(0.55,0.72,48),
    new THREE.MeshBasicMaterial({color:hex,transparent:true,opacity:0.9,side:THREE.DoubleSide,depthWrite:false})
  );
  m.rotation.x=-Math.PI/2; m.position.set(x,0.03,z);
  sceneRef.add(m);
  Fx._rings.push({m,life:0,dur:0.5});
}

// ---------- 轨道地板灯闪光 ----------
export function laneFlash(lane,hex=0xffe17a,power=1){
  const s=Fx._strips[lane]; if(!s) return;
  s.material.color.setHex(hex);
  s.material.opacity=0.95*power;
}

// ---------- 镜头震动 ----------
export function shake(mag=0.12){
  Fx._shakeMag=Math.max(Fx._shakeMag,mag);
  Fx._shakeT=0.32;
}

// ---------- 每帧更新 ----------
export function updateFx(dt, t, theme, dancing, beatPulse){
  if(!Fx.ready) return;

  // 粒子
  for(let i=Fx._bursts.length-1;i>=0;i--){
    const b=Fx._bursts[i]; b.life+=dt;
    const k=b.life/b.dur;
    if(k>=1){ sceneRef.remove(b.pts); b.pts.geometry.dispose(); b.pts.material.dispose(); Fx._bursts.splice(i,1); continue; }
    const arr=b.pts.geometry.attributes.position.array;
    for(let j=0;j<b.V.length;j++){
      const v=b.V[j];
      arr[j*3]+=v.x*dt; arr[j*3+1]+=v.y*dt; arr[j*3+2]+=v.z*dt;
      v.y-=6.5*dt;
    }
    b.pts.geometry.attributes.position.needsUpdate=true;
    b.pts.material.opacity=1-k;
    b.pts.material.size=0.14*(1-k*0.5);
  }

  // 冲击环
  for(let i=Fx._rings.length-1;i>=0;i--){
    const r=Fx._rings[i]; r.life+=dt;
    const k=r.life/r.dur;
    if(k>=1){ sceneRef.remove(r.m); r.m.geometry.dispose(); r.m.material.dispose(); Fx._rings.splice(i,1); continue; }
    const s=1+k*3.4; r.m.scale.set(s,s,1);
    r.m.material.opacity=0.9*(1-k);
  }

  // 轨道灯衰减
  Fx._strips.forEach(s=>{
    if(s.material.opacity>0) s.material.opacity=Math.max(0,s.material.opacity-dt*2.4);
  });

  // 迪斯科球 + 扫描灯
  if(Fx._disco){
    Fx._disco.rotation.y+=dt*(dancing?2.2:0.6);
    Fx._disco.children[0].rotation.x+=dt*0.8;
    const puls=0.55+Math.sin(t*(dancing?8:3))*0.45;
    Fx._spotA.intensity=(dancing?70:30)*puls*(theme.lampA?1:0.4);
    Fx._spotB.intensity=(dancing?70:30)*(1-puls)*(theme.lampB?1:0.4);
    Fx._spotA.color.setHex(theme.c1); Fx._spotB.color.setHex(theme.c2);
    // 扫描目标绕圈
    const R=2.6, w=t*(dancing?1.5:0.5);
    Fx._spotA.target.position.set(Math.cos(w)*R,0,Math.sin(w)*R*0.4-1);
    Fx._spotB.target.position.set(Math.cos(w+Math.PI)*R,0,Math.sin(w+Math.PI)*R*0.4-1);
  }

  // 节拍脉冲（镜头轻轻前顶）
  if(beatPulse){
    Fx._beatT=0.14;
  }
  if(Fx._beatT>0){
    Fx._beatT-=dt;
    const k=Math.max(0,Fx._beatT/0.14);
    camRef.position.z=Fx.camBase.z - k*0.12;
  } else {
    camRef.position.z += (Fx.camBase.z - camRef.position.z)*dt*8;
  }

  // 震动
  if(Fx._shakeT>0){
    Fx._shakeT-=dt;
    const m=Fx._shakeMag*(Fx._shakeT/0.32);
    camRef.position.x+= (Math.random()-0.5)*m;
    camRef.position.y+= (Math.random()-0.5)*m;
    if(Fx._shakeT<=0){ Fx._shakeMag=0; }
  }
  // 震动/脉冲结束后镜头缓慢回归基准（x/y 由 main 的对准逻辑每帧插值）
}
