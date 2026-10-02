// 帖子快照生成器：从 classroom.sqlite 导出帖子 → snapshot/ 静态页（供 GitHub Pages 展示）
// 直接复用原版 public/style.css + 原版帖子 DOM 结构，外观和完整版一致
// 用法：& 'D:\node\node.exe' snapshot.js   （在项目根目录运行）
const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const BASE = 'https://lihanyang673-design.github.io/class-website'; // 分享预览用的绝对地址
const OUT = path.join(__dirname, 'snapshot');
const IMG_OUT = path.join(OUT, 'img');
const HALL = '../'; // 返回入口大厅（根 index.html）

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

// 原版头像配色（app.js AVATAR_COLORS + userColor）
const AVATAR_COLORS = ['#f44336', '#e91e63', '#9c27b0', '#673ab7', '#3f51b5', '#2196f2',
  '#009688', '#ff9800', '#795548', '#607d8b', '#4caf50', '#ff5722'];
function userColor(name) {
  let h = 0;
  for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}
// 原版 avatarHtml 的静态版：emoji 头像可显示，图片头像（未导出）回退为首字
function avatarHtml(name, avatar, cls = '') {
  const a = avatar || '';
  const full = ('avatar ' + cls).trim();
  if (a.startsWith('emoji:')) return `<span class="${full}" style="background:${userColor(name)}">${esc(a.slice(6))}</span>`;
  return `<span class="${full}" style="background:${userColor(name)}">${esc(String(name || '?')[0] || '?')}</span>`;
}

(async () => {
  const SQL = await initSqlJs();
  const db = new SQL.Database(fs.readFileSync('classroom.sqlite'));
  const q = sql => {
    const r = db.exec(sql);
    if (!r.length) return [];
    return r[0].values.map(row => Object.fromEntries(row.map((v, i) => [r[0].columns[i], v])));
  };

  const users = Object.fromEntries(q('SELECT id, nickname, username, avatar FROM users').map(u => [u.id, u]));
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
    const u = users[p.user_id] || {};
    const imgs = (p.images || '').split(',').filter(Boolean).map(copyImg).filter(Boolean);
    const cmts = q(`SELECT c.*, u.nickname, u.username, u.avatar FROM comments c
      LEFT JOIN users u ON u.id = c.user_id WHERE c.post_id = ${p.id} ORDER BY c.id ASC`);
    for (const c of cmts) {
      c.imgOk = copyImg(c.image);
      const cu = c.user_id > 0 ? users[c.user_id] : null;
      c.name = cu ? (cu.nickname || cu.username || '同学') : (c.guest_name || '游客');
      c.avatar = cu ? cu.avatar : '';
    }
    const cidName = Object.fromEntries(cmts.map(c => [c.id, c.name]));
    for (const c of cmts) c.replyTo = c.parent_id > 0 ? (cidName[c.parent_id] || '同学') : '';
    postsData.push({
      id: p.id, author: u.nickname || u.username || '同学', avatar: u.avatar || '',
      content: p.content, imgs,
      videos: (p.videos || '').split(',').filter(Boolean).length,
      files: (p.files || '').split(',').filter(Boolean).length,
      poll: !!p.poll, pinned: !!p.pinned, section: sections[p.section_id] || '',
      time: fmtTime(p.created_at), views: p.view_count || 0,
      likes: p.like_count, cmts,
    });
  }

  // 额外的静态页补充样式（主体样式来自 ../public/style.css，与原版一致）
  const extraCss = `
  .static-wrap{max-width:640px;margin:0 auto;padding:14px}
  .nav-back{display:inline-flex;align-items:center;gap:4px;color:#fff;background:rgba(255,255,255,.18);
    border:0;border-radius:18px;padding:5px 13px;font-size:13px;cursor:pointer;text-decoration:none}
  .post-card-link{cursor:pointer;transition:box-shadow .15s}
  .post-card-link:hover{box-shadow:0 3px 10px rgba(0,0,0,.12)}
  .static-tip{text-align:center;font-size:12px;color:var(--text-secondary);margin:2px 0 12px}
  .comment-reply-tag{color:var(--link);font-size:13px;margin-right:4px}
  .toast{position:fixed;left:50%;bottom:40px;transform:translateX(-50%);background:rgba(0,0,0,.75);color:#fff;
    padding:8px 18px;border-radius:20px;font-size:13px;opacity:0;transition:.3s;pointer-events:none;z-index:99}
  .toast.on{opacity:1}`;

  const pageHead = (title, desc, ogImg) => `<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${esc(title)}</title><meta property="og:title" content="${esc(title)}">
  <meta property="og:description" content="${esc(desc)}">
  ${ogImg ? `<meta property="og:image" content="${BASE}/snapshot/img/${encodeURIComponent(ogImg)}">` : ''}
  <link rel="stylesheet" href="../public/style.css"><style>${extraCss}</style></head>`;

  const navbar = `<header class="navbar"><h1 style="display:flex;align-items:center;gap:10px">
    <a class="nav-back" href="${HALL}">⬅ 大厅</a>📚 班级动态</h1></header>`;

  const shareJs = `<div class="toast" id="toast">链接已复制</div><script>
  function doShare(url){
    if(navigator.share){navigator.share({title:document.title,url:url}).catch(function(){});return}
    (navigator.clipboard?navigator.clipboard.writeText(url):Promise.reject()).then(ok,function(){
      var i=document.createElement('input');i.value=url;document.body.appendChild(i);i.select();
      try{document.execCommand('copy');ok()}catch(e){}
      document.body.removeChild(i)});
    function ok(){var t=document.getElementById('toast');t.classList.add('on');setTimeout(function(){t.classList.remove('on')},1800)}
  }
  function go(p){location.href=p}
  </script>`;

  // 单条帖子卡片（原版 renderPostCard 的静态版）
  const cardHtml = (p, linkToList) => {
    const snip = p.content.length > 120 ? p.content.slice(0, 120) + '…' : p.content;
    return `<div class="card post-card-link" ${linkToList ? `onclick="go('post_${p.id}.html')"` : ''} id="post-card-${p.id}">
    <div class="post-header"><div class="post-user">
      ${avatarHtml(p.author, p.avatar)}
      <div class="post-meta">
        <span class="post-author">${esc(p.author)}${p.pinned ? '<span class="pin-badge">📌 置顶</span>' : ''}</span>
        <span class="post-time">· ${esc(p.time)}
          ${p.section ? `<span class="post-section-badge">📂 ${esc(p.section)}</span>` : ''}
          <span class="view-badge">� ${p.views}</span></span>
      </div></div></div>
    ${p.content ? `<div class="post-content">${esc(snip)}</div>` : ''}
    ${p.imgs.length ? `<div class="post-images">${p.imgs.map(i => `<img loading="lazy" src="img/${encodeURIComponent(i)}" onclick="event.stopPropagation();window.open(this.src)">`).join('')}</div>` : ''}
    ${p.videos ? `<div class="static-tip">🎬 含 ${p.videos} 个视频（请在校园网完整版观看）</div>` : ''}
    ${p.files ? `<div class="static-tip">📎 含 ${p.files} 个附件（请在校园网完整版下载）</div>` : ''}
    ${p.poll ? '<div class="static-tip">📊 此帖含投票（请在校园网完整版参与）</div>' : ''}
    <div class="post-actions">
      <button class="static-like">❤️ <span class="like-count">${p.likes}</span></button>
      <button ${linkToList ? `onclick="event.stopPropagation();go('post_${p.id}.html')"` : ''}>💬 评论 (${p.cmts.length})</button>
      <button class="share-btn" onclick="event.stopPropagation();doShare('${BASE}/snapshot/post_${p.id}.html')" title="复制链接 / 分享">🔗 分享</button>
    </div>
    ${!linkToList ? `<div class="comments-section" style="display:block"><div class="comments-list">
      ${p.cmts.map(c => `<div class="comment" style="margin-left:${c.parent_id > 0 ? 24 : 0}px">
        ${avatarHtml(c.name, c.avatar, 'avatar-sm')}
        <div class="comment-body">
          <span class="comment-author">${esc(c.name)}${c.user_id > 0 ? '' : '<span class="guest-badge">游客</span>'}</span>
          ${c.replyTo ? `<span class="comment-reply-tag">回复 @${esc(c.replyTo)}</span>` : ''}
          <span class="comment-text">${esc(c.content)}</span>
          ${c.imgOk ? `<img class="comment-image" loading="lazy" src="img/${encodeURIComponent(c.imgOk)}" onclick="window.open(this.src)">` : ''}
          <div class="comment-meta"><span class="comment-time">${esc(c.time)}</span></div>
        </div></div>`).join('') || '<div class="comment-empty">还没有评论，快来抢沙发~</div>'}
    </div><div class="static-tip">💡 评论、点赞、发帖请使用校园网内的完整版网站</div></div>` : ''}
    </div>`;
  };

  // 列表页（原版风格 + 返回大厅按钮）
  fs.writeFileSync(path.join(OUT, 'index.html'), `<!DOCTYPE html><html lang="zh-CN">
  ${pageHead('班级动态 · 帖子广场', '同学们的精彩动态，共 ' + postsData.length + ' 条帖子', '')}
  <body>${navbar}<div class="static-wrap">
  <div class="static-tip">静态快照 · 更新于 ${new Date().toLocaleString('zh-CN')} · 登录/发帖/评论请在校园网内使用完整版</div>
  ${postsData.map(p => cardHtml(p, true)).join('\n') || '<div class="card" style="text-align:center;color:var(--text-secondary)">还没有帖子</div>'}
  </div>${shareJs}</body></html>`);

  // 详情页（评论全展开 + OG 分享标签）
  for (const p of postsData) {
    const snip = (p.content || '').replace(/\s+/g, ' ').slice(0, 60);
    fs.writeFileSync(path.join(OUT, `post_${p.id}.html`), `<!DOCTYPE html><html lang="zh-CN">
    ${pageHead(`${p.author}：${snip || '班级动态'}`, snip, p.imgs[0])}
    <body>${navbar}<div class="static-wrap">
    <a class="static-tip" href="index.html" style="display:block;text-align:left;color:var(--link)">← 返回帖子广场</a>
    ${cardHtml(p, false)}
    </div>${shareJs}</body></html>`);
  }

  // ===== 工具分享（原版"🌐 网站分享"模块的静态版） =====
  // 原版 app.js toolIcon() 的完整拷贝
  const toolIcon = host => {
    const h = (host || '').toLowerCase();
    if (h.includes('bilibili')) return '📺';
    if (h.includes('github')) return '🐙';
    if (h.includes('zhihu')) return '💡';
    if (h.includes('baidu')) return '🐾';
    if (h.includes('docs.qq') || h.includes('doc')) return '📄';
    if (h.includes('pan.') || h.includes('drive') || h.includes('disk')) return '💾';
    if (h.includes('edu') || h.includes('xuexi') || h.includes('school')) return '🎓';
    if (h.includes('translate')) return '🌍';
    if (h.includes('music') || h.includes('163')) return '🎵';
    if (h.includes('video') || h.includes('tv')) return '🎬';
    return '🧰';
  };

  const toolCats = q('SELECT id, name, sort_order FROM tool_categories ORDER BY sort_order, id');
  const toolRows = q(`SELECT t.*, u.nickname, u.username, u.avatar,
      (SELECT COUNT(*) FROM tool_likes WHERE tool_id = t.id) AS like_count
    FROM tools t LEFT JOIN users u ON u.id = t.user_id ORDER BY t.id DESC`);
  const catName = Object.fromEntries(toolCats.map(c => [c.id, c.name]));

  const toolCards = toolRows.map(t => {
    const tu = t.user_id > 0 ? users[t.user_id] : null;
    const name = tu ? (tu.nickname || tu.username || '同学') : '同学';
    const avatar = tu ? tu.avatar : '';
    const host = (() => { try { return new URL(t.url.startsWith('http') ? t.url : 'https://' + t.url).hostname.replace(/^www\./, ''); } catch (e) { return t.url; } })();
    const url = /^https?:\/\//.test(t.url) ? t.url : 'https://' + t.url;
    return `<div class="card tool-card" data-cat="${t.category_id || 0}">
      <div class="tool-card-main">
        <span class="tool-icon">${toolIcon(host)}</span>
        <div class="tool-info">
          <a class="tool-title" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(t.title)} <span class="tool-open-ico">↗</span></a>
          <div class="tool-host">${esc(host)}</div>
          <div class="tool-desc">${esc(t.description)}</div>
          <div class="tool-meta">
            ${avatarHtml(name, avatar, 'avatar-xs')}
            <span class="tool-who">${esc(name)}</span>
            <span>· ${esc(fmtTime(t.created_at))} 分享</span>
            ${t.category_id ? `<span class="tool-cat-badge">📂 ${esc(catName[t.category_id] || '未分类')}</span>` : ''}
          </div>
        </div>
      </div>
      <div class="tool-actions">
        <button class="tool-like-btn">❤️ <span class="tool-like-count">${t.like_count}</span></button>
        <a class="tool-open-btn" href="${esc(url)}" target="_blank" rel="noopener noreferrer">打开网站 ↗</a>
      </div></div>`;
  }).join('\n');

  const chipHtml = ['<button class="tool-chip active" data-cat="0" onclick="setCat(0)">全部</button>']
    .concat(toolCats.map(c => `<button class="tool-chip" data-cat="${c.id}" onclick="setCat(${c.id})">${esc(c.name)}</button>`)).join('');

  fs.writeFileSync(path.join(OUT, 'tools.html'), `<!DOCTYPE html><html lang="zh-CN">
  ${pageHead('班级动态 · 网站分享', '同学们分享的好用工具网站，共 ' + toolRows.length + ' 个', '')}
  <body>${navbar}<div class="static-wrap">
  <div class="static-tip">🧰 同学们分享的好用工具网站 · 登录/上传/点赞请使用校园网完整版</div>
  <div class="tool-chips-row">${chipHtml}</div>
  ${toolCards || '<div class="card empty-state">🧰 这里还空空的，快来分享第一个工具网站吧～</div>'}
  </div><script>
  function setCat(id){
    document.querySelectorAll('.tool-chip').forEach(function(b){b.classList.toggle('active', b.dataset.cat == id)});
    document.querySelectorAll('.tool-card').forEach(function(c){c.style.display = (id == 0 || c.dataset.cat == id) ? '' : 'none'});
  }
  </script></body></html>`);

  console.log(`快照完成：${postsData.length} 条帖子、${toolRows.length} 个工具 → snapshot/`);
})();
