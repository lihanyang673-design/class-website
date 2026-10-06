// ============================================================
// opening.js —— 开场动画（简化版：Logo + 标题）
// 流程：
//  1. 东南大学风格渐变背景
//  2. Logo 弹跳动画
//  3. 弹出「蛙步」标题 → 淡出 → 进主界面
// ============================================================
import * as THREE from 'three';
import { ensureCtx, sfxBoing, sfxOutro } from './audio.js?v=20261018';

export const Opening = { active:false };

// ---------- 模块内状态 ----------
let scene, cam, rendererRef, onDoneCb;
let started=false, finished=false, titleShown=false;
let timeouts=[];
let t0=0;

const $=id=>document.getElementById(id);

// ============================================================
// 工具
// ============================================================
function later(ms, fn){ timeouts.push(setTimeout(fn, ms)); }
function clearLater(){ timeouts.forEach(clearTimeout); timeouts=[]; }

// ============================================================
// 背景：东南大学风格渐变
// ============================================================
function gradTexture(){
  const c=document.createElement('canvas'); c.width=c.height=512;
  const g=c.getContext('2d');
  const lg=g.createLinearGradient(0,0,512,512);
  lg.addColorStop(0,'#fbbf24');    // 金黄
  lg.addColorStop(0.5,'#f59e0b');  // 暖橙
  lg.addColorStop(1,'#d97706');    // 深橙
  g.fillStyle=lg; g.fillRect(0,0,512,512);
  const t=new THREE.CanvasTexture(c);
  t.colorSpace=THREE.SRGBColorSpace;
  return t;
}
function buildSky(){
  scene.background=gradTexture();
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

  console.log('%c[开场] 场景就绪，等待用户点击「开始游戏」…', 'color:#36d1ff;font-weight:bold');
  $('openingUI').classList.add('on');
  $('openSkip').classList.remove('on');
  $('openSkip').addEventListener('click', onSkip);
  addEventListener('resize', onResize);
}

function onResize(){
  if(cam){ cam.aspect=innerWidth/innerHeight; cam.updateProjectionMatrix(); }
}

// ---------- main.js 在「开始游戏」按钮点击时调用 ----------
export function begin(){
  if(started) return;
  started=true;
  onGateClick();
}

// ---------- 开场流程 ----------
function onGateClick(){
  ensureCtx();
  $('openSkip').classList.add('on');
  console.log('%c[开场] ▶ 开始播放开场动画', 'color:#ffe17a;font-weight:bold');

  t0=performance.now();

  // ---- 标题动画 ----
  later(300, showTitle);
  later(2300, sfxOutro);
  later(2500, finish);
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

// ---------- 跳过 ----------
function onSkip(){
  if(!started||finished) return;
  clearLater();
  finish();
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
  Opening.active=false;
  onDoneCb && onDoneCb();
}

// ============================================================
// 每帧更新（仅渲染背景，无模型动画）
// ============================================================
export function updateOpening(dt, now){
  if(!scene) return;
  rendererRef.render(scene,cam);
}
