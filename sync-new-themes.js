// ============================================================
// sync-new-themes.js —— 一键把上传的舞池背景同步成内置背景
// ============================================================
// 用法（在项目文件夹里打开终端）：
//   node sync-new-themes.js                自动检测新背景，同步进内置 THEMES，提交+推送两个仓库
//   node sync-new-themes.js --no-push      只提交，不推送（代理没开时用）
//
// 脚本会自动：读数据库 dance_themes → 找还没同步过的背景 → 复制图片到游戏目录和
//   naiwa-release → 在 ui.js 的内置 THEMES 里加条目 → 版本号 +1 → 提交并推送
//
// 小知识：同步后 GitHub 静态版也有这些背景；班级服务器版会自动去重，不会重复显示。
// ============================================================
const initSqlJs=require('sql.js');
const fs=require('fs');
const path=require('path');
const { execSync }=require('child_process');

const ROOT=__dirname;
const GAME_DIR=path.join(ROOT,'public','tools','新版奶蛙街舞');
const RELEASE_DIR=path.join(ROOT,'naiwa-release');

const doPush=!process.argv.includes('--no-push');
function q(s){ return "'"+String(s).replace(/'/g,"\\'")+"'"; }

(async()=>{
  // 1) 读数据库
  const SQL=await initSqlJs();
  const db=new SQL.Database(fs.readFileSync(path.join(ROOT,'classroom.sqlite')));
  const res=db.exec("SELECT id,name,image,uploader_name FROM dance_themes ORDER BY id");
  if(!res.length){ console.log('数据库里还没有自定义舞池。'); return; }
  const cols=res[0].columns;
  const rows=res[0].values.map(v=>Object.fromEntries(cols.map((c,i)=>[c,v[i]])));

  // 2) 找还没同步过的：ui.js 的内置 THEMES 里没有 fromDb:<id> 标记
  const uiPath=path.join(GAME_DIR,'js','ui.js');
  let uiCode=fs.readFileSync(uiPath,'utf8');
  const newRows=rows.filter(r=>!uiCode.includes(`fromDb:${r.id}`));
  if(!newRows.length){
    console.log('✅ 所有上传的舞池背景都已同步，没有新的。');
    return;
  }
  console.log(`\n检测到 ${newRows.length} 个新背景：`);
  newRows.forEach(r=>console.log(`  #${r.id} 《${r.name}》 ${r.image.split('/').pop()}`));

  // 3) 复制图片到游戏目录和 naiwa-release（内置版用纯文件名，和 index.html 同目录）
  for(const r of newRows){
    const fname=r.image.split('/').pop();
    const src=path.join(ROOT,'uploads','dance',fname);
    fs.copyFileSync(src, path.join(GAME_DIR,fname));
    fs.copyFileSync(src, path.join(RELEASE_DIR,fname));
  }
  console.log('✅ 图片已复制到游戏目录和 naiwa-release');

  // 4) 内置 THEMES 里加条目（插在数组结尾 ]; 之前）
  //    只放 id/name/bgImage/fromDb：buildStage 遇到图片背景会自动补齐默认地板和灯光
  const marker='export const THEMES=[';
  const start=uiCode.indexOf(marker)+marker.length;
  const end=uiCode.indexOf('];',start);
  const lines=newRows.map(r=>{
    const fname=r.image.split('/').pop();
    return `  {id:${q('it'+r.id)}, name:${q(r.name)}, desc:'自定义图片背景', bgImage:${q(fname)}, fromDb:${r.id}},`;
  });
  uiCode=uiCode.slice(0,end)+lines.join('\n')+'\n'+uiCode.slice(end);

  // 5) 版本号 +1
  const verFiles=[
    path.join(GAME_DIR,'index.html'),
    path.join(GAME_DIR,'js','main.js'),
    path.join(GAME_DIR,'js','ui.js'),
    path.join(GAME_DIR,'js','game.js'),
    path.join(GAME_DIR,'js','opening.js'),
  ];
  let maxVer=0;
  for(const f of verFiles){
    for(const m of fs.readFileSync(f,'utf8').matchAll(/v=(2026\d{4})/g)) maxVer=Math.max(maxVer,+m[1]);
  }
  const newVer=maxVer+1;
  for(const f of verFiles){
    fs.writeFileSync(f, fs.readFileSync(f,'utf8').replace(/v=2026\d{4}/g,'v='+newVer));
  }
  uiCode=uiCode.replace(/v=2026\d{4}/g,'v='+newVer);
  fs.writeFileSync(uiPath,uiCode);
  console.log(`✅ 版本号 → v=${newVer}`);

  // 6) 同步代码文件到 naiwa-release
  const copyMap=[
    ['index.html','index.html'], ['charts.json','charts.json'], ['style.css','style.css'],
    ['js/main.js','js/main.js'], ['js/ui.js','js/ui.js'], ['js/game.js','js/game.js'],
    ['js/opening.js','js/opening.js'], ['js/analyze.js','js/analyze.js'],
    ['js/audio.js','js/audio.js'], ['js/fx.js','js/fx.js'], ['js/dancer.js','js/dancer.js'],
    ['js/codec.js','js/codec.js'],
  ];
  for(const [rel,dstRel] of copyMap){
    fs.copyFileSync(path.join(GAME_DIR,rel), path.join(RELEASE_DIR,dstRel));
  }
  console.log('✅ 代码已同步到 naiwa-release');

  // 7) 提交两个仓库
  const names=newRows.map(r=>'《'+r.name+'》').join('、');
  const msg=`v${newVer} 同步${names}为内置舞池背景`;
  const git=(cmd,cwd)=>execSync(cmd,{cwd,stdio:'inherit'});
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
      console.log('\n⚠️ 推送失败（代理没开？）。提交已保存，开好代理后在项目根目录和 naiwa-release 里各运行 git push 即可。');
    }
  }else{
    console.log('\n✅ 全部完成（未推送），准备好后运行 git push。');
  }
})().catch(e=>{ console.error('❌ 出错了：',e.message); process.exit(1); });
