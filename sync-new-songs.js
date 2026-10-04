// ============================================================
// sync-new-songs.js —— 一键同步新歌（不用找 AI，不花积分）
// ============================================================
// 用法（在项目文件夹里打开终端）：
//   node sync-new-songs.js                自动检测新歌，星级自动估，可交互修改，完成后自动提交+推送
//   node sync-new-songs.js --no-push      只提交，不推送（代理没开时用）
//   node sync-new-songs.js 39=5 40=3      直接指定新歌 id=星级，不问你
//
// 脚本会自动：检测数据库里游戏目录还没有的歌 → 把谱面写入 charts.json
//   → 复制音频到游戏目录和 naiwa-release → 在 ui.js 的 SONGS 里加条目
//   → 所有文件版本号 +1 → 提交并推送两个仓库
// ============================================================
const initSqlJs=require('sql.js');
const fs=require('fs');
const path=require('path');
const { execSync }=require('child_process');
const readline=require('readline');

const ROOT=__dirname;
const GAME_DIR=path.join(ROOT,'public','tools','新版奶蛙街舞');
const RELEASE_DIR=path.join(ROOT,'naiwa-release');

// ---------- 参数 ----------
const args=process.argv.slice(2);
const doPush=!args.includes('--no-push');
const overrides={};
for(const a of args){
  const m=a.match(/^(\d+)=([1-5])$/);
  if(m) overrides[+m[1]]=+m[2];
}

// ---------- 小工具 ----------
function q(s){ return "'"+String(s).replace(/'/g,"\\'")+"'"; }   // 单引号字符串
function minsOf(d){ return (d/60).toFixed(1).replace(/\.0$/,''); }
// 歌名里常见“歌名 - 歌手”，拆开
function splitTitle(title){
  const m=title.match(/^(.*?)\s+-\s+(.+)$/);
  return m ? {name:m[1].trim(), artist:m[2].trim()} : {name:title.trim(), artist:''};
}
// 密度自动估星（只是初始建议，脚本会问你，也可以在参数里指定）
function starsByDensity(d){
  if(d<7.2) return 1;
  if(d<8.4) return 2;
  if(d<9.2) return 3;
  if(d<10.7) return 4;
  return 5;
}
function ask(q){
  return new Promise(res=>{
    const rl=readline.createInterface({input:process.stdin,output:process.stdout});
    rl.question(q,a=>{ rl.close(); res(a.trim()); });
  });
}

(async()=>{
  // 1) 读数据库
  const SQL=await initSqlJs();
  const db=new SQL.Database(fs.readFileSync(path.join(ROOT,'classroom.sqlite')));
  const res=db.exec("SELECT id,title,artist,bpm,duration,note_count,chart,audio,uploader_name FROM dance_songs ORDER BY id");
  if(!res.length){ console.log('数据库里没有歌曲。'); return; }
  const cols=res[0].columns;
  const allRows=res[0].values.map(v=>Object.fromEntries(cols.map((c,i)=>[c,v[i]])));

  // 2) 找新歌：音频文件名游戏目录里还没有
  const existing=new Set(fs.readdirSync(GAME_DIR));
  let newSongs=allRows.filter(r=>!existing.has(r.audio.split('/').pop()));
  // 已经在 ui.js 里有条目的，也不算新歌（防止重复加）
  const uiPath=path.join(GAME_DIR,'js','ui.js');
  let uiCode=fs.readFileSync(uiPath,'utf8');
  newSongs=newSongs.filter(r=>!uiCode.includes(`id:'u${r.id}'`));

  if(!newSongs.length){
    console.log('✅ 没有检测到新歌，曲库已是最新。');
    return;
  }

  // 3) 确定每首新歌的星级
  console.log(`\n检测到 ${newSongs.length} 首新歌：`);
  const prepared=[];
  for(const r of newSongs){
    const chart=JSON.parse(r.chart);
    const density=chart.length/r.duration;
    let stars=overrides[r.id] ?? starsByDensity(density);
    const {name, artist}=splitTitle(r.title);
    const fname=r.audio.split('/').pop();
    console.log(`  #${r.id} 《${name}》 ${r.bpm}BPM 密度${density.toFixed(2)} → 建议 ${stars} 星`);

    // 交互确认：只有在你手动运行、且没在参数里指定星级时才问
    if(process.stdin.isTTY && overrides[r.id]===undefined){
      const ans=await ask(`    《${name}》评几星？(1-5，回车=${stars}) `);
      if(/^[1-5]$/.test(ans)) stars=+ans;
    }
    prepared.push({r,chart,fname,name,artist:r.artist||artist||'同学上传',stars,density});
  }

  // 4) 更新 charts.json
  const chartsPath=path.join(GAME_DIR,'charts.json');
  const charts=JSON.parse(fs.readFileSync(chartsPath,'utf8'));
  for(const p of prepared) charts[String(p.r.id)]=p.chart;
  fs.writeFileSync(chartsPath, JSON.stringify(charts));
  console.log('✅ charts.json 已更新');

  // 5) 复制音频到两个目录
  for(const p of prepared){
    const src=path.join(ROOT,'uploads','dance',p.fname);
    fs.copyFileSync(src, path.join(GAME_DIR,p.fname));
    fs.copyFileSync(src, path.join(RELEASE_DIR,p.fname));
  }
  console.log('✅ 音频已复制到游戏目录和 naiwa-release');

  // 6) ui.js 的 SONGS 里加条目（插在数组结尾 ]; 之前）
  const marker='export const SONGS=[';
  const start=uiCode.indexOf(marker)+marker.length;
  const end=uiCode.indexOf('];',start);
  const lines=prepared.map(p=>
    `  {id:${q('u'+p.r.id)}, name:${q(p.name)}, artist:${q(p.artist)}, file:${q(p.fname)}, bpm:${p.r.bpm}, desc:${q(p.r.bpm+' BPM · 约'+minsOf(p.r.duration)+'分钟')}, cat:'builtin', staticChart:true, stars:${p.stars}},`
  );
  uiCode=uiCode.slice(0,end)+lines.join('\n')+'\n'+uiCode.slice(end);

  // 7) 版本号 +1（找出现有最大版本号，所有文件统一 +1）
  const verFiles=[
    path.join(GAME_DIR,'index.html'),
    path.join(GAME_DIR,'js','main.js'),
    path.join(GAME_DIR,'js','ui.js'),
    path.join(GAME_DIR,'js','game.js'),
    path.join(GAME_DIR,'js','opening.js'),
  ];
  let maxVer=0;
  for(const f of verFiles){
    const code=fs.readFileSync(f,'utf8');
    for(const m of code.matchAll(/v=(2026\d{3})/g)) maxVer=Math.max(maxVer,+m[1]);
  }
  const newVer=maxVer+1;
  const writeVer=new Map();   // 记住每个文件新内容，后面复制到 naiwa-release
  for(const f of verFiles){
    const code=fs.readFileSync(f,'utf8').replace(/v=2026\d{3}/g,'v='+newVer);
    fs.writeFileSync(f,code);
    writeVer.set(f,code);
  }
  // ui.js 自己也要 bump 版本号（前面的修改 + 版本号）
  uiCode=uiCode.replace(/v=2026\d{3}/g,'v='+newVer);
  fs.writeFileSync(uiPath,uiCode);
  console.log(`✅ 版本号 → v=${newVer}`);

  // 8) 同步改动过的代码文件到 naiwa-release
  const copyMap=[
    ['index.html','index.html'],
    ['charts.json','charts.json'],
    ['style.css','style.css'],
    ['js/main.js','js/main.js'],
    ['js/ui.js','js/ui.js'],
    ['js/game.js','js/game.js'],
    ['js/opening.js','js/opening.js'],
    ['js/analyze.js','js/analyze.js'],
    ['js/audio.js','js/audio.js'],
    ['js/fx.js','js/fx.js'],
    ['js/dancer.js','js/dancer.js'],
    ['js/codec.js','js/codec.js'],
  ];
  for(const [rel,dstRel] of copyMap){
    fs.copyFileSync(path.join(GAME_DIR,rel), path.join(RELEASE_DIR,dstRel));
  }
  console.log('✅ 代码已同步到 naiwa-release');

  // 9) 提交两个仓库
  const names=prepared.map(p=>'《'+p.name+'》'+p.stars+'星').join('、');
  const msg=`v${newVer} 新增${names}`;
  function git(cmd,cwd){ return execSync(cmd,{cwd,stdio:'inherit'}); }
  git('git add -A', ROOT);
  git(`git commit -m ${JSON.stringify(msg)}`, ROOT);
  git('git add -A', RELEASE_DIR);
  git(`git commit -m ${JSON.stringify(msg)}`, RELEASE_DIR);
  console.log('✅ 两个仓库已提交');

  if(doPush){
    try{
      git('git push origin main', ROOT);
      git('git push origin main', RELEASE_DIR);
      console.log('\n🎉 全部完成！两个仓库都已推送。');
    }catch(e){
      console.log('\n⚠️ 推送失败（代理没开？）。提交已保存，开好代理后分别在项目根目录和 naiwa-release 里运行 git push 即可。');
    }
  }else{
    console.log('\n✅ 全部完成（未推送）。准备好后运行 git push 即可。');
  }
})().catch(e=>{ console.error('❌ 出错了：',e.message); process.exit(1); });
