// ============================================================
// analyze.js —— 音频分析：上传的音乐自动生成谱面
// 真正的音游思路（音符跟"网格"走，不跟声音乱跑）：
//   1. 频谱通量法找出音频里的节奏点（onset）
//   2. 用节奏点间距估算 BPM，并找出"第 0 拍"在第几秒
//   3. 从第 0 拍铺一张固定网格：每拍 4 格（beat/4），每格放一个音符，
//      间隔永远固定 → 节奏感稳
//   4. 每格放哪条轨道：看这一拍前后哪个频段最活跃（底鼓→低轨、镲片→高轨），
//      音乐没声音的格子则按固定规律换轨，保证四轨均匀
// ============================================================

const WIN = 1024;    // FFT 窗长（约 23ms）
const HOP = 512;     // 帧移（约 12ms，判定精度足够）
const MIN_GAP = 0.16;    // 节奏点去噪：0.16 秒内只算一个点（仅用于估 BPM）

// ---------- 就地 FFT（迭代基-2，固定窗长预计算旋转因子） ----------
function makeFFT(n){
  const rev = new Uint32Array(n);
  for(let i=1;i<n;i++) rev[i]=(rev[i>>1]>>1)|((i&1)?(n>>1):0);
  const cos=new Float32Array(n/2), sin=new Float32Array(n/2);
  for(let i=0;i<n/2;i++){ cos[i]=Math.cos(-2*Math.PI*i/n); sin[i]=Math.sin(-2*Math.PI*i/n); }
  return function(re,im){
    for(let i=0;i<n;i++){ const j=rev[i]; if(j>i){ let t=re[i];re[i]=re[j];re[j]=t; t=im[i];im[i]=im[j];im[j]=t; } }
    for(let len=2;len<=n;len<<=1){
      const half=len>>1, step=n/len;
      for(let i=0;i<n;i+=len){
        for(let j=0;j<half;j++){
          const k=j*step, c=cos[k], s=sin[k];
          const xr=re[i+j+half]*c - im[i+j+half]*s;
          const xi=re[i+j+half]*s + im[i+j+half]*c;
          re[i+j+half]=re[i+j]-xr; im[i+j+half]=im[i+j]-xi;
          re[i+j]+=xr; im[i+j]+=xi;
        }
      }
    }
  };
}

// 页面在后台时 setTimeout 会被浏览器疯狂限流（每分钟才跑一次），
// 此时改用微任务不让步，保证分析全速跑完
const yieldUI = ()=> (typeof document!=='undefined' && document.hidden) ? Promise.resolve() : new Promise(r=>setTimeout(r,0));

// 分位数（阈值调参用，避免拍脑袋定常量）
function percentiles(arr, qs){
  const a=Float32Array.from(arr).sort();
  return qs.map(q=>+a[Math.min(a.length-1,Math.max(0,Math.floor(q*a.length)))].toFixed(4));
}

// 节奏点按时间排好，从每个 gap 窗口里挑最强的一个（估 BPM 用，避免重复点干扰）
function suppressPeaks(list, gap){
  const out=[];
  let i=0;
  while(i<list.length){
    let best=i, j=i+1;
    while(j<list.length && list[j].t-list[i].t<gap){
      if(list[j].s>list[best].s) best=j;
      j++;
    }
    out.push(list[best]);
    i=best+1;
    while(i<list.length && list[i].t-list[best].t<gap) i++;
  }
  return out;
}

// ============================================================
// 主入口：analyzeAudio(File, onStage) → { duration, bpm, notes:[{t,lane}] }
// notes 是"每拍 4 格"的固定网格密谱，game.js 再按难度抽成固定节奏型
// ============================================================
export async function analyzeAudio(file, onStage){
  const say = (text,pct)=>{ try{ onStage&&onStage(text,pct); }catch(e){} };

  say('正在解码音频…', 5);
  const AC = window.AudioContext || window.webkitAudioContext;
  const ctx = new AC();
  let audio;
  try{
    audio = await ctx.decodeAudioData(await file.arrayBuffer());
  }finally{
    try{ ctx.close && ctx.close(); }catch(e){}
  }
  const sr = audio.sampleRate, N = audio.length;
  if(N < sr*3) throw new Error('音频太短了（至少 3 秒）');

  // 混成单声道
  const chs = audio.numberOfChannels;
  const mono = new Float32Array(N);
  for(let c=0;c<chs;c++){
    const d = audio.getChannelData(c);
    for(let i=0;i<N;i++) mono[i]+=d[i]/chs;
  }

  const frames = Math.max(1, Math.floor((N-WIN)/HOP)+1);
  const BINS = WIN/2;
  const hann = new Float32Array(WIN);
  for(let i=0;i<WIN;i++) hann[i]=0.5-0.5*Math.cos(2*Math.PI*i/WIN);
  const fft = makeFFT(WIN);

  // 频段 → 轨道：←0=低音(鼓/贝斯) ↓1=中低 ↑2=中高 →3=高频(镲/气声)
  const edges=[0, 200, 800, 3000, sr/2].map(hz=>Math.min(BINS, Math.max(1, Math.round(hz*WIN/sr))));
  const binBand=new Uint8Array(BINS);
  for(let b=0;b<BINS;b++){
    binBand[b]= b<edges[1]?0 : b<edges[2]?1 : b<edges[3]?2 : 3;
  }
  // 各频段 bin 数不同（高频 bin 多几十倍），一律求平均，公平比较
  const bandSize=[0,0,0,0];
  for(let b=1;b<BINS;b++) bandSize[binBand[b]]++;

  const flux=new Float32Array(frames);          // 每帧总通量
  const bandFlux=new Float32Array(frames*4);    // 每帧 4 频段平均起音通量
  const bandEnergy=new Float32Array(frames*4);  // 每帧 4 频段平均能量（此刻什么在响）
  let prev=new Float32Array(BINS);
  const re=new Float32Array(WIN), im=new Float32Array(WIN);

  say('正在分析节奏…', 10);
  for(let f0=0; f0<frames; f0+=512){
    const f1=Math.min(frames, f0+512);
    for(let f=f0; f<f1; f++){
      const off=f*HOP;
      for(let i=0;i<WIN;i++){ re[i]=mono[off+i]*hann[i]; im[i]=0; }
      fft(re,im);
      let fl=0;
      const bf=[0,0,0,0], be=[0,0,0,0];
      for(let b=1;b<BINS;b++){
        const mag=Math.sqrt(re[b]*re[b]+im[b]*im[b]);
        const lm=Math.log1p(mag*8);        // 对数压缩，高低频量级接近
        be[binBand[b]]+=lm;                // 能量：不管有没有起音
        const d=lm-prev[b];
        prev[b]=lm;
        if(d>0){ fl+=d; bf[binBand[b]]+=d; }
      }
      flux[f]=fl;
      bandFlux[f*4]  =bf[0]/(bandSize[0]||1);
      bandFlux[f*4+1]=bf[1]/(bandSize[1]||1);
      bandFlux[f*4+2]=bf[2]/(bandSize[2]||1);
      bandFlux[f*4+3]=bf[3]/(bandSize[3]||1);
      bandEnergy[f*4]  =be[0]/(bandSize[0]||1);
      bandEnergy[f*4+1]=be[1]/(bandSize[1]||1);
      bandEnergy[f*4+2]=be[2]/(bandSize[2]||1);
      bandEnergy[f*4+3]=be[3]/(bandSize[3]||1);
    }
    say('正在分析节奏…', 10+Math.round(f1/frames*40));
    await yieldUI();
  }

  // ---------- 能量基线：判断格子里到底有没有在响 ----------
  // 中位数≈全曲普通响度；每个频段的 12 分位≈该频段"安静地板"
  const meanEnergy=new Float32Array(frames);
  for(let f=0;f<frames;f++){
    meanEnergy[f]=(bandEnergy[f*4]+bandEnergy[f*4+1]+bandEnergy[f*4+2]+bandEnergy[f*4+3])/4;
  }
  const medEnergy=percentiles(meanEnergy,[0.5])[0];
  const floorEnergy=[0,0,0,0];
  for(let b=0;b<4;b++){
    const col=new Float32Array(frames);
    for(let f=0;f<frames;f++) col[f]=bandEnergy[f*4+b];
    floorEnergy[b]=percentiles(col,[.12])[0];
  }

  // 每频段起音通量的均值/标准差（标准分比较，高频镲再常见也不会躺赢）
  // + 每频段能量中位数（持续段选轨用）+ 总通量中位数（判断此刻算不算强起音）
  const fluxStat=[];
  const bandMedE=[0,0,0,0];
  for(let b=0;b<4;b++){
    const colF=new Float32Array(frames), colE=new Float32Array(frames);
    for(let f=0;f<frames;f++){ colF[f]=bandFlux[f*4+b]; colE[f]=bandEnergy[f*4+b]; }
    const mean=colF.reduce((a,c)=>a+c,0)/frames;
    let va=0; for(let f=0;f<frames;f++) va+=(colF[f]-mean)*(colF[f]-mean);
    fluxStat.push({mean,std:Math.sqrt(va/frames)+1e-6});
    bandMedE[b]=Float32Array.from(colE).sort()[frames>>1];
  }
  const fluxMed=percentiles(flux,[.5])[0];

  // ---------- 自适应阈值找节奏点 ----------
  say('正在提取节奏点…', 52);
  // 全曲通量中位数：安静段的小抖动再"局部突出"也不能超它的一定比例
  const globalMedian=Float32Array.from(flux).sort()[frames>>1];
  const W=Math.round(1.4*sr/HOP);   // 前后各 1.4s 的滑动窗口
  const peaks=[];
  for(let f=1; f<frames-1; f++){
    const v=flux[f];
    if(v<flux[f-1] || v<=flux[f+1]) continue;              // 必须是局部极大
    const a=Math.max(0,f-W), b2=Math.min(frames-1,f+W);
    let sum=0;
    for(let k=a;k<=b2;k++) sum+=flux[k];
    const mean=sum/(b2-a+1);
    if(v > mean*1.4 + 0.02 && v > globalMedian*0.4){
      peaks.push({ t:f*HOP/sr, s:v });
    }
  }
  if(!peaks.length) throw new Error('没检测到明显的节奏点，换一首节奏感强的歌试试');

  // ---------- BPM 估算（节奏点间距直方图） ----------
  say('正在估算 BPM…', 62);
  const cand = suppressPeaks(peaks, MIN_GAP);
  const hist={};
  for(let i=1;i<cand.length;i++){
    let iv=cand[i].t-cand[i-1].t;
    while(iv<0.30) iv*=2;
    while(iv>1.00) iv/=2;
    const key=Math.round(iv/0.02);
    hist[key]=(hist[key]||0)+1;
  }
  let bestKey=0, bestN=0;
  for(const k in hist){ if(hist[k]>bestN){ bestN=hist[k]; bestKey=+k; } }
  let bpm=bestKey ? 60/(bestKey*0.02) : 120;
  while(bpm<60) bpm*=2;
  while(bpm>=180) bpm/=2;
  bpm=Math.round(bpm);

  // ---------- 精调 BPM + 第 0 拍（网格和音乐对不上，音游就废了）----------
  // 粗估 BPM（直方图）误差常有 ±2~3，逐拍累积，歌到后半段就错位。
  // 在粗估值 ±4 范围内每 0.1 试一个 BPM，配上前 5 秒最强的几个起点候选，
  // 让【全部节奏点】与整拍线的契合度最高 → BPM 与起点一起定准
  say('正在校准节拍…', 72);
  const anchorCands=peaks.filter(p=>p.t<5).sort((a,b)=>b.s-a.s).slice(0,4).map(p=>p.t);
  let anchor=peaks[0].t, bestFit=-1;
  for(let b0=bpm-4; b0<=bpm+4; b0+=0.1){
    const bb=60/b0;
    for(const a0 of anchorCands){
      let fit=0;
      for(const p of peaks){
        let d=Math.abs((p.t-a0)/bb); d=Math.abs(d-Math.round(d))*bb;  // 距最近整拍的秒数
        if(d<0.12) fit += p.s*(1-d/0.12);
      }
      if(fit>bestFit){ bestFit=fit; bpm=Math.round(b0*10)/10; anchor=a0; }
    }
  }
  const beat=60/bpm;
  const step=beat/4;             // 网格最小格：每拍 4 格

  // ---------- 铺固定网格：每拍 4 格，每格一个音符，间隔永远 = step ----------
  say('正在生成节奏网格…', 82);
  // 从第 0 拍【前一拍】开始（保证 1 秒前奏留白后网格相位整齐），一直铺到歌曲结束
  const startT=anchor-beat;
  const slotCount=Math.ceil((audio.duration-startT)/step)+4;
  const notes=[];
  const useCount=[0,0,0,0];   // 各轨道已用次数（分数接近时挑少的，四轨自然均衡）
  let lane=0, soundN=0;
  for(let i=0;i<slotCount;i++){
    const ts=startT+i*step;
    if(ts<0 || ts>audio.duration+0.5) continue;

    // 该格前后 ±60ms：频段能量（此刻什么在响）+ 起音通量（什么刚开始响）
    const fL=Math.max(0, Math.floor((ts-0.06)*sr/HOP));
    const fR=Math.min(frames-1, Math.ceil((ts+0.07)*sr/HOP));
    const en=[0,0,0,0], on=[0,0,0,0];
    for(let f=fL;f<=fR;f++) for(let b=0;b<4;b++){
      en[b]+=bandEnergy[f*4+b];
      on[b]+=bandFlux[f*4+b];
    }
    const fcnt=Math.max(1,fR-fL+1);
    // 最响频段的本地能量 > 全曲普通响度的六成 → 这一格确实在响
    const hasSound=Math.max(...en)/fcnt > medEnergy*0.6;

    if(hasSound){
      soundN++;
      // 窗口内最强一帧的总通量：够强 → 按起音标准分选轨；否则按持续能量选轨
      let maxFl=0;
      for(let f=fL;f<=fR;f++) if(flux[f]>maxFl) maxFl=flux[f];
      const scores=[0,0,0,0];
      if(maxFl>fluxMed*0.7){
        for(let b=0;b<4;b++) scores[b]=(on[b]/fcnt-fluxStat[b].mean)/fluxStat[b].std;
      }else{
        for(let b=0;b<4;b++) scores[b]=(en[b]/fcnt-bandMedE[b])/(0.5*bandMedE[b]+0.1);
      }
      // 分数接近（相对差<15%）的候选里：挑用得最少的，其次避开上一格同轨
      const mx=Math.max(...scores);
      const near=[];
      for(let b=0;b<4;b++) if(scores[b]>=mx-0.15*Math.max(1,Math.abs(mx))) near.push(b);
      near.sort((a,b)=>useCount[a]-useCount[b]
        || ((a===lane?1:0)-(b===lane?1:0)) || a-b);
      lane=near[0];
      useCount[lane]++;
    }else{
      // 安静的格子：固定规律换轨（不靠 Math.random，同一首歌每次一样）
      lane=(lane+1+((i*7)%3))%4;
      useCount[lane]++;
    }
    notes.push({ t:Math.round(ts*1000)/1000, lane });
  }
  if(!notes.length) throw new Error('网格生成失败，换个文件试试');

  // 调试数据（调阈值用）：各指标分位数 + 有多少格被判为"在响"
  window.__analyzeDbg={
    medEnergy, soundN, total:notes.length,
    fluxPct:percentiles(flux,[.1,.25,.5,.75,.9]),
    meanEPct:percentiles(meanEnergy,[.1,.25,.5,.75,.9]),
    enPct:[0,1,2,3].map(b=>{
      const col=new Float32Array(frames);
      for(let f=0;f<frames;f++) col[f]=bandEnergy[f*4+b];
      return percentiles(col,[.12,.5,.9]);
    }),
  };

  say('分析完成！', 100);
  return { duration: audio.duration, bpm, notes };
}
