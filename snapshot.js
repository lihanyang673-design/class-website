// 帖子快照生成器：从 classroom.sqlite 导出帖子 → snapshot/ 静态页（供 GitHub Pages 展示）
// 用法：& 'D:\node\node.exe' snapshot.js   （在项目根目录运行）
const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const BASE = 'https://lihanyang673-design.github.io/class-website'; // 分享预览用的绝对地址
const OUT = path.join(__dirname, 'snapshot');
const IMG_OUT = path.join(OUT, 'img');

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
// UTC 时间转北京时间显示
const fmtTime = t => {
  if (!t) return '';
  const d = new Date(t.replace(' ', 'T') + 'Z');
  if (isNaN(d)) return t;
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours() + 8)}:${p(d.getMinutes())}`;
};

(async () => {
  const SQL = await initSqlJs();
  const db = new SQL.Database(fs.readFileSync('classroom.sqlite'));
  const q = sql => {
    const r = db.exec(sql);
    if (!r.length) return [];
    return r[0].values.map(row => Object.fromEntries(row.map((v, i) => [r[0].columns[i], v])));
  };

  const users = Object.fromEntries(q('SELECT id, nickname, username FROM users').map(u => [u.id, u.nickname || u.username]));
  const sections = Object.fromEntries(q('SELECT id, name FROM sections').map(s => [s.id, s.name]));
  const posts = q(`SELECT p.*,
      (SELECT COUNT(*) FROM likes WHERE post_id = p.id) AS like_count,
      (SELECT COUNT(*) FROM comments WHERE post_id = p.id) AS comment_count
    FROM posts p ORDER BY p.pinned DESC, p.id DESC LIMIT 300`);

  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(IMG_OUT, { recursive: true });

  // 复制帖子图片和评论图片到 snapshot/img（数据库里存的是 "/uploads/xxx.jpg" 完整路径）
  const copyImg = name => {
    if (!name) return null;
    const base = name.replace(/^\/?uploads\//, '');
    const src = path.join(__dirname, 'uploads', base);
    if (fs.existsSync(src)) { fs.copyFileSync(src, path.join(IMG_OUT, base)); return base; }
    return null;
  };

  const postsData = [];
  for (const p of posts) {
    const imgs = (p.images || '').split(',').filter(Boolean).map(copyImg).filter(Boolean);
    const cmts = q(`SELECT c.*, u.nickname, u.username FROM comments c
      LEFT JOIN users u ON u.id = c.user_id WHERE c.post_id = ${p.id} ORDER BY c.id ASC`);
    for (const c of cmts) { c.imgOk = copyImg(c.image); c.name = c.user_id > 0 ? (c.nickname || c.username || '同学') : (c.guest_name || '游客'); }
    postsData.push({
      id: p.id, author: users[p.user_id] || '同学', content: p.content, imgs,
      videos: (p.videos || '').split(',').filter(Boolean).length,
      files: (p.files || '').split(',').filter(Boolean).length,
      poll: !!p.poll, pinned: !!p.pinned, section: sections[p.section_id] || '',
      time: fmtTime(p.created_at), views: p.view_count || 0,
      likes: p.like_count, cmts: cmts.map(c => ({ name: c.name, content: c.content, img: c.imgOk, time: fmtTime(c.created_at) })),
    });
  }

  const css = `
  *{box-sizing:border-box;margin:0;padding:0}body{font-family:system-ui,-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;background:#eef3f8;color:#1c2b3a}
  a{color:inherit;text-decoration:none}.wrap{max-width:640px;margin:0 auto;padding:14px}
  .top{background:linear-gradient(135deg,#1877f2,#3a9bfc);color:#fff;padding:22px 14px 18px;text-align:center}
  .top h1{font-size:22px}.top p{font-size:12px;opacity:.85;margin-top:6px}
  .card{background:#fff;border-radius:14px;padding:14px;margin-bottom:12px;box-shadow:0 1px 4px rgba(0,0,0,.06)}
  .head{display:flex;align-items:center;gap:10px}
  .avatar{width:40px;height:40px;border-radius:50%;background:#3a9bfc;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;flex-shrink:0}
  .meta{flex:1;min-width:0}.name{font-weight:600;font-size:14px}.time{font-size:12px;color:#8a97a5}
  .badge{font-size:11px;background:#e7f0ff;color:#1877f2;border-radius:8px;padding:2px 8px;margin-left:6px}
  .badge.pin{background:#fff3d6;color:#b07d00}.content{margin-top:10px;font-size:15px;line-height:1.6;white-space:pre-wrap;word-break:break-word}
  .imgs{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-top:10px}
  .imgs img{width:100%;aspect-ratio:1;object-fit:cover;border-radius:8px;display:block}
  .imgs.single img{aspect-ratio:auto;max-height:340px;object-fit:contain}
  .foot{display:flex;gap:18px;margin-top:10px;font-size:13px;color:#8a97a5}
  .ph{margin-top:10px;background:#f2f5f8;border-radius:8px;padding:10px;font-size:13px;color:#8a97a5;text-align:center}
  .btn{display:inline-block;background:#1877f2;color:#fff;border-radius:20px;padding:8px 20px;font-size:14px;border:0;cursor:pointer}
  .btn.plain{background:#fff;color:#1877f2;border:1px solid #cfe0f5}
  .back{display:inline-block;margin:12px 0;font-size:14px;color:#1877f2}
  .cmt{display:flex;gap:10px;padding:10px 0;border-top:1px solid #f0f3f6}
  .cmt .avatar{width:32px;height:32px;font-size:13px}.cmt .name{font-size:13px}.cmt .content{margin-top:4px;font-size:14px;white-space:pre-wrap}
  .cmt img{max-width:180px;border-radius:8px;margin-top:6px;display:block}
  .toast{position:fixed;left:50%;bottom:40px;transform:translateX(-50%);background:rgba(0,0,0,.75);color:#fff;padding:8px 18px;border-radius:20px;font-size:13px;opacity:0;transition:.3s;pointer-events:none}
  .toast.on{opacity:1}`;

  const head = (title, desc, ogImg) => `<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${esc(title)}</title><meta property="og:title" content="${esc(title)}">
  <meta property="og:description" content="${esc(desc)}">
  ${ogImg ? `<meta property="og:image" content="${BASE}/snapshot/img/${encodeURIComponent(ogImg)}">` : ''}
  <style>${css}</style></head>`;

  // 列表页
  let listHtml = postsData.map(p => {
    const snip = p.content.length > 120 ? p.content.slice(0, 120) + '…' : p.content;
    return `<a class="card" href="post_${p.id}.html"><div class="head">
    <div class="avatar">${esc((p.author[0] || '同').toUpperCase())}</div>
    <div class="meta"><div class="name">${esc(p.author)}${p.section ? `<span class="badge">${esc(p.section)}</span>` : ''}${p.pinned ? '<span class="badge pin">📌 置顶</span>' : ''}</div>
    <div class="time">${esc(p.time)}</div></div></div>
    <div class="content">${esc(snip)}</div>
    ${p.imgs.length ? `<div class="imgs${p.imgs.length === 1 ? ' single' : ''}">${p.imgs.slice(0, 3).map(i => `<img loading="lazy" src="img/${encodeURIComponent(i)}">`).join('')}</div>` : ''}
    <div class="foot"><span>❤ ${p.likes}</span><span>💬 ${p.cmts.length}</span><span>👁 ${p.views}</span></div></a>`;
  }).join('\n');

  fs.writeFileSync(path.join(OUT, 'index.html'), `<!DOCTYPE html><html lang="zh-CN">
  ${head('班级动态 · 帖子广场', '同学们的精彩动态，共 ' + postsData.length + ' 条帖子', '')}
  <body><div class="top"><h1>📚 班级动态 · 帖子广场</h1><p>静态快照 · 更新于 ${new Date().toLocaleString('zh-CN')} · 完整功能（登录/发帖/评论）请在校园网内访问</p></div>
  <div class="wrap">${listHtml || '<div class="card" style="text-align:center;color:#8a97a5">还没有帖子</div>'}</div></body></html>`);

  // 详情页（带 OG 分享标签 + 分享按钮）
  for (const p of postsData) {
    const snip = p.content.replace(/\s+/g, ' ').slice(0, 60);
    const title = `${p.author}：${snip || '班级动态'}`;
    fs.writeFileSync(path.join(OUT, `post_${p.id}.html`), `<!DOCTYPE html><html lang="zh-CN">
    ${head(title, snip, p.imgs[0])}
    <body><div class="wrap">
    <a class="back" href="index.html">← 返回帖子广场</a>
    <div class="card">
      <div class="head"><div class="avatar">${esc((p.author[0] || '同').toUpperCase())}</div>
      <div class="meta"><div class="name">${esc(p.author)}${p.section ? `<span class="badge">${esc(p.section)}</span>` : ''}${p.pinned ? '<span class="badge pin">📌 置顶</span>' : ''}</div>
      <div class="time">${esc(p.time)}</div></div></div>
      <div class="content">${esc(p.content)}</div>
      ${p.imgs.length ? `<div class="imgs${p.imgs.length === 1 ? ' single' : ''}" style="grid-template-columns:${p.imgs.length === 1 ? '1fr' : 'repeat(3,1fr)'}">${p.imgs.map(i => `<img loading="lazy" src="img/${encodeURIComponent(i)}">`).join('')}</div>` : ''}
      ${p.videos ? `<div class="ph">🎬 含 ${p.videos} 个视频（请在校园网完整版查看）</div>` : ''}
      ${p.files ? `<div class="ph">📎 含 ${p.files} 个附件（请在校园网完整版查看）</div>` : ''}
      ${p.poll ? '<div class="ph">📊 此帖含投票（请在校园网完整版参与）</div>' : ''}
      <div class="foot"><span>❤ ${p.likes}</span><span>💬 ${p.cmts.length}</span><span>👁 ${p.views}</span>
      <span style="margin-left:auto"><button class="btn" style="padding:4px 14px;font-size:13px" onclick="share()">🔗 分享</button></span></div>
    </div>
    <div class="card"><div style="font-weight:600;font-size:15px;margin-bottom:4px">💬 评论 ${p.cmts.length}</div>
    ${p.cmts.map(c => `<div class="cmt"><div class="avatar">${esc((c.name[0] || '评').toUpperCase())}</div>
      <div style="flex:1;min-width:0"><div class="name">${esc(c.name)}<span class="time" style="margin-left:8px">${esc(c.time)}</span></div>
      <div class="content">${esc(c.content)}</div>${c.img ? `<img loading="lazy" src="img/${encodeURIComponent(c.img)}">` : ''}</div></div>`).join('')
      || '<div style="color:#8a97a5;font-size:14px;padding:10px 0">暂无评论</div>'}
    </div>
    <div style="text-align:center;margin:16px 0"><a class="btn plain" href="index.html">📱 看更多帖子</a></div></div>
    <div class="toast" id="toast">链接已复制</div>
    <script>
    function share(){
      var url=location.href;
      if(navigator.share){navigator.share({title:document.title,url:url}).catch(function(){});return}
      (navigator.clipboard?navigator.clipboard.writeText(url):Promise.reject()).then(ok,function(){
        var i=document.createElement('input');i.value=url;document.body.appendChild(i);i.select();
        try{document.execCommand('copy');ok()}catch(e){}
        document.body.removeChild(i)});
      function ok(){var t=document.getElementById('toast');t.classList.add('on');setTimeout(function(){t.classList.remove('on')},1800)}
    }
    </script></body></html>`);
  }

  console.log(`快照完成：${postsData.length} 条帖子 → snapshot/`);
})();
