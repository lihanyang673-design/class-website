let currentUser = null;
let latestPostId = 0;
let sections = [];          // 分区列表
let activeSection = 0;      // 当前浏览的分区（0=全部）
let postSection = 0;        // 发帖时选择的分区（0=不分区）
const feedPostsById = new Map();  // 已渲染帖子的缓存（用于分享预览等场景按 id 取帖子）
let currentProfileUid = 0;  // 当前正在查看的个人主页 user id（用于签到后刷新徽章）

// ===== 初始化 =====
async function init() {
  applyTheme();
  await loadMe();
  renderUserArea();
  await loadSections();
  applyFeedMode();              // 单列/双列瀑布流模式（localStorage 记忆）
  await loadPosts();
  loadAnnouncements();           // 班级公告板（首页顶部，游客也能看）
  loadBirthdayBanner();         // 生日墙横幅（今天寿星 + 近期生日，游客也能看）
  loadTopics();                 // 热门 #话题# 入口
  if (currentUser) {
    renderAdminPanel();
    pollNotifications();
    refreshMsgBadge();
    const checkinInfo = await loadCheckinStatus();  // 签到按钮状态 + 今日数据
    maybeShowCheckinRemind(checkinInfo);            // 今天没签到则打开网站时自动提醒
    updateDesktopNotifBtn();    // 桌面通知按钮的初始状态
    loadHotWeek();              // 首页本周热门榜
    // 心跳：每 30 秒上报一次，让同学列表/会话列表里的"在线"状态保持新鲜
    setInterval(() => { if (currentUser) fetch('/api/ping', { method: 'POST' }).catch(() => {}); }, 30000);
  }
  handlePostDeepLink();   // 解析 ?postId=123 链接，滚到对应帖并闪烁
  updateAddHomeBtn();     // 已添加到桌面（standalone）则隐藏 📱
  checkDraft();           // 有未完成草稿则在发帖框上方提示
  bindDraftListeners();   // 监听发帖框/投票选项改动，自动存草稿
  // 定时任务：检查新动态 / 新通知 / 未读私信
  setInterval(checkNewPosts, 60000);
  setInterval(pollNotifications, 30000);
  setInterval(refreshMsgBadge, 30000);
  // PWA：注册离线缓存（仅 https 或 localhost 可用，局域网 http 下自动跳过不报错）
  if ('serviceWorker' in navigator && window.isSecureContext) {
    window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
  }
}

async function loadSections() {
  sections = await fetch('/api/sections').then(r => r.json()).catch(() => []);
  // 当前选中的分区若已被删除，回到"全部"
  if (activeSection && !sections.some(s => s.id === activeSection)) activeSection = 0;
  renderSectionTabs();
  renderPostSectionPicker();
}

async function loadMe() {
  const res = await fetch('/api/me');
  currentUser = await res.json();
}

// 是否“当前会话”正处于管理员模式（登录后默认 false，输密码开启，退出管理员关闭）
function isAdminUser(u) { return !!(u && u.admin_mode === true); }

function renderUserArea() {
  const area = document.getElementById('user-area');
  if (currentUser) {
    const isAdmin = isAdminUser(currentUser);
    area.innerHTML = `
      <span class="me-block" onclick="showAvatarModal()" title="点击更换头像">
        ${avatarHtml({ id: null, name: currentUser.nickname || currentUser.username, avatar: currentUser.avatar })}
        <span class="me-name">${escapeHtml(currentUser.nickname || currentUser.username)}
          ${isAdmin ? '<span class="role-badge admin">管理员</span>' : ''}
        </span>
      </span>
      ${isAdmin ? '<button onclick="exitAdminMode()">退出管理员</button>' : '<button onclick="showAdminModal()">管理员模式</button>'}
      <button onclick="showRank()">🏆 排行</button>
      <button onclick="showFavorites()">⭐ 收藏</button>
      <button onclick="showPasswordModal()">🔑 改密码</button>
      <button onclick="doLogout()">退出</button>
    `;
    document.getElementById('post-editor').classList.remove('hidden');
    document.getElementById('notif-bell').classList.remove('hidden');
    document.getElementById('msg-bell').classList.remove('hidden');
    document.getElementById('users-bell').classList.remove('hidden');
    document.getElementById('checkin-btn').classList.remove('hidden');
    document.getElementById('desktop-notif-btn').classList.remove('hidden');
    document.getElementById('tab-msg').classList.remove('hidden');
  } else {
    area.innerHTML = '<button onclick="showLogin()">登录</button><button onclick="showRegister()">注册</button>';
    document.getElementById('post-editor').classList.add('hidden');
    document.getElementById('notif-bell').classList.add('hidden');
    document.getElementById('msg-bell').classList.add('hidden');
    document.getElementById('users-bell').classList.add('hidden');
    document.getElementById('checkin-btn').classList.add('hidden');
    document.getElementById('desktop-notif-btn').classList.add('hidden');
    document.getElementById('tab-msg').classList.add('hidden');
    updateNotifBadge(0);
  }
}

// ===== 每日签到 =====
async function loadCheckinStatus() {
  let d = null;
  try {
    d = await fetch('/api/checkin').then(r => r.json());
    const btn = document.getElementById('checkin-btn');
    if (d.checked_today) {
      btn.innerHTML = `📅<span class="streak-fire">🔥${d.streak}</span>`;
      btn.title = `今日已签到，连续 ${d.streak} 天，累计 ${d.total_days} 天`;
      btn.classList.add('checked');
    } else {
      btn.innerHTML = '📅';
      btn.title = `每日签到（连续 ${d.max_streak} 天最高记录，累计 ${d.total_days} 天）`;
      btn.classList.remove('checked');
    }
  } catch (e) { /* 忽略 */ }
  return d;
}

// 打开网站时若今天还没签到，自动弹出签到提醒。
// 同一标签会话内只弹一次（sessionStorage），刷新页面不会反复打扰；关掉浏览器重开还会提醒。
function maybeShowCheckinRemind(d) {
  if (!currentUser || !d || d.checked_today) return;
  if (sessionStorage.getItem('checkin_reminded') === '1') return;
  sessionStorage.setItem('checkin_reminded', '1');
  const body = document.getElementById('checkin-remind-body');
  body.innerHTML = `
    <div class="checkin-remind-emoji">🌞</div>
    <div class="checkin-remind-line">今天还没签到哦，点一下只要 1 秒钟～</div>
    <div class="checkin-remind-stats">🔥 已连续 <b>${d.streak || 0}</b> 天 · 累计签到 <b>${d.total_days || 0}</b> 天</div>
    <div class="checkin-remind-points">签到还能 +2 积分，别让连续记录断了！</div>`;
  // 延迟一点弹出，等首页内容渲染好
  setTimeout(() => {
    // 弹窗期间若用户已在别处签到则不弹
    if (!document.getElementById('checkin-remind-modal')) return;
    document.getElementById('checkin-remind-modal').classList.remove('hidden');
  }, 500);
}

async function checkinFromRemind() {
  closeModal('checkin-remind-modal');
  await doCheckin();
}

async function doCheckin() {
  if (!currentUser) return alert('请先登录');
  const res = await fetch('/api/checkin', { method: 'POST' });
  const d = await res.json();
  if (!res.ok) {
    // 已签到
    await loadCheckinStatus();
    return alert(d.error || '今日已签到');
  }
  await loadCheckinStatus();
  // 立即更新个人主页徽章（若当前正显示自己的主页）
  if (currentProfileUid) viewProfile(currentProfileUid);
  alert(`签到成功！连续 ${d.streak} 天，累计 ${d.total_days} 天`);
}

// ===== 添加到手机桌面（PWA） =====
let deferredInstallPrompt = null;
// Chrome/Edge（安卓 & 电脑）支持直接弹安装窗；先把事件存下来，用户点 📱 时再触发
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  updateAddHomeBtn();
});
// 安装成功后隐藏 📱 按钮
window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
  updateAddHomeBtn();
});
function isStandaloneMode() {
  return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches)
    || window.navigator.standalone === true;
}
function updateAddHomeBtn() {
  const btn = document.getElementById('add-home-btn');
  if (!btn) return;
  btn.classList.toggle('hidden', isStandaloneMode());
}
function showAddHome() {
  // 路径 A：浏览器支持原生安装（安卓 Chrome/Edge、电脑 Chrome）→ 直接弹安装窗
  if (deferredInstallPrompt) {
    deferredInstallPrompt.prompt();
    deferredInstallPrompt.userChoice.finally(() => {
      deferredInstallPrompt = null;
      updateAddHomeBtn();
    });
    return;
  }
  // 路径 B：给图文步骤。先判断环境
  const ua = navigator.userAgent;
  const isWeChat = /MicroMessenger/i.test(ua);
  const isIOS = /iphone|ipad|ipod/i.test(ua)
    || (/Macintosh/i.test(ua) && navigator.maxTouchPoints && navigator.maxTouchPoints > 1);
  const isIOSSafari = isIOS && /Safari/i.test(ua) && !/CriOS|FxiOS|EdgiOS/i.test(ua);
  const isAndroid = /Android/i.test(ua);
  const body = document.getElementById('add-home-body');
  const step = (n, icon, text) => `
    <div class="add-home-step">
      <span class="add-home-step-num">${n}</span>
      <span class="add-home-step-icon">${icon}</span>
      <span class="add-home-step-text">${text}</span>
    </div>`;
  if (isWeChat) {
    // 微信内置浏览器会拦截安装动作，必须先跳到系统浏览器
    body.innerHTML = `
      <p class="add-home-note">👇 微信里不能直接添加，请按以下步骤操作：</p>
      ${step(1, '⋯', '点右上角的 <b>⋯</b> 按钮')}
      ${step(2, '🌐', '选择 <b>「在浏览器打开」</b>（iPhone 选「在 Safari 打开」）')}
      ${step(3, '📱', '跳转到浏览器后，再点一次导航栏的 📱 按钮按提示添加')}
      <p class="add-home-note">添加成功后，桌面会出现「班级动态」图标，点开就像 App 一样全屏使用。</p>`;
  } else if (isIOSSafari) {
    body.innerHTML = `
      ${step(1, '📤', '点 Safari 底部的 <b>分享按钮</b>（方框里有个向上的箭头）')}
      ${step(2, '➕', '在弹出的菜单里找到并点 <b>「添加到主屏幕」</b>')}
      ${step(3, '添加', '点右上角的 <b>「添加」</b>，桌面就会出现班级动态图标')}`;
  } else if (isIOS) {
    // iPhone 上的 Chrome/QQ 浏览器等：先复制网址到 Safari
    body.innerHTML = `
      <p class="add-home-note">iPhone 添加到桌面需要用系统自带的 Safari 浏览器：</p>
      ${step(1, '📋', '点地址栏复制当前网址')}
      ${step(2, '🧭', '打开手机上的 <b>Safari</b>，粘贴网址访问')}
      ${step(3, '📤', '点底部分享按钮 → <b>「添加到主屏幕」</b> → 添加')}`;
  } else if (isAndroid) {
    body.innerHTML = `
      ${step(1, '⋮', '点浏览器底部或右上角的 <b>菜单按钮 ⋮</b>')}
      ${step(2, '📱', '选择 <b>「添加到主屏幕」</b> 或 <b>「安装应用」</b>')}
      ${step(3, '添加', '点确定，桌面就会出现班级动态图标')}
      <p class="add-home-note">如果菜单里找不到，说明浏览器版本较旧，换用最新版 Chrome 再点 📱 就能直接安装。</p>`;
  } else {
    // 电脑浏览器
    body.innerHTML = `
      <p class="add-home-note">电脑上也可以安装：点地址栏右侧出现的 <b>安装图标 ⊕</b>，或浏览器右上角菜单 ⋮ 里的 <b>「安装班级动态」</b>。</p>
      <p class="add-home-note">手机上请用手机浏览器打开本网站再点 📱，iPhone 请用 Safari。</p>`;
  }
  document.getElementById('add-home-modal').classList.remove('hidden');
}

// ===== 桌面通知 + 提示音 =====
let lastUnreadCount = 0;   // 上次轮询的未读数；只对"增加"触发提示
let desktopNotifReady = false;   // Notification.permission === 'granted' 且 localStorage 开关为 on

function updateDesktopNotifBtn() {
  const btn = document.getElementById('desktop-notif-btn');
  if (!btn) return;
  const enabled = localStorage.getItem('desktop_notif') === 'on';
  const granted = ('Notification' in window) && Notification.permission === 'granted';
  desktopNotifReady = enabled && granted;
  if (enabled && granted) {
    btn.innerHTML = '🔊';
    btn.title = '桌面通知已开启（点击关闭）';
    btn.classList.add('notif-on');
  } else if (enabled && Notification.permission === 'denied') {
    btn.innerHTML = '🔇';
    btn.title = '浏览器已拒绝通知权限，请到浏览器设置中允许本站通知';
    btn.classList.remove('notif-on');
  } else {
    btn.innerHTML = '🔇';
    btn.title = '开启桌面通知：评论/私信/@来时电脑右下角弹窗+响铃';
    btn.classList.remove('notif-on');
  }
}

async function toggleDesktopNotif() {
  if (!currentUser) return alert('请先登录');
  const enabled = localStorage.getItem('desktop_notif') === 'on';
  if (enabled) {
    // 关闭
    localStorage.setItem('desktop_notif', 'off');
    updateDesktopNotifBtn();
    return;
  }
  // 开启：先请求权限
  if (!('Notification' in window)) {
    return alert('当前浏览器不支持桌面通知');
  }
  if (Notification.permission === 'denied') {
    return alert('您之前拒绝了通知权限，请到浏览器设置中允许本站通知后再开启');
  }
  if (Notification.permission === 'default') {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') {
      updateDesktopNotifBtn();
      return alert('您没有授权通知，仅会在网页内响铃');
    }
  }
  localStorage.setItem('desktop_notif', 'on');
  updateDesktopNotifBtn();
  // 立即给一条测试通知
  try {
    new Notification('班级动态', { body: '桌面通知已开启，有新消息时会在此提醒你~' });
  } catch (e) { /* 某些浏览器需要在用户手势上下文中调用 */ }
  playBeep();
}

// Web Audio 合成一声"叮"
let audioCtx = null;
function playBeep() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    // 用户首次交互前 AudioContext 可能是 suspended，需要 resume
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const t = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, t);  // A5
    osc.frequency.exponentialRampToValueAtTime(1320, t + 0.08);  // 上升到 E6
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.3, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t);
    osc.stop(t + 0.45);
  } catch (e) { /* 忽略 */ }
}

// ===== 每周热门榜（首页顶部） =====
let hasHotWeek = false;   // 是否已加载到热门数据；用于切换视图时显隐
async function loadHotWeek() {
  const bar = document.getElementById('hot-week-bar');
  if (!bar) return;
  let list;
  try {
    list = await fetch('/api/posts/hot-week').then(r => r.json());
  } catch (e) { hasHotWeek = false; bar.classList.add('hidden'); return; }
  if (!list || !list.length) { hasHotWeek = false; bar.classList.add('hidden'); return; }
  hasHotWeek = true;
  bar.innerHTML = '<div class="hot-week-title">🔥 本周热门</div>' + list.map(p => `
    <div class="hot-week-item" onclick="jumpToPost(${p.id})" title="${escapeHtml(p.full_content || p.content)}">
      <div class="hot-week-content">${escapeHtml(p.content)}${p.full_content && p.full_content.length > 60 ? '...' : ''}</div>
      <div class="hot-week-meta">
        ${avatarHtml({ id: p.user_id, name: p.nickname, avatar: p.avatar }, 'avatar-xs')}
        <span class="hot-week-author">${escapeHtml(p.nickname)}</span>
        <span class="hot-week-stats">❤️${p.like_count} 💬${p.comment_count}</span>
      </div>
    </div>`).join('');
  bar.classList.remove('hidden');
}

async function jumpToPost(pid) {
  // 确保在首页全部视图，再尝试滚动到该帖
  goHome(true);
  await loadPosts();
  // 等 DOM 渲染完
  setTimeout(() => {
    const el = document.getElementById('post-card-' + pid);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('flash-highlight');
      setTimeout(() => el.classList.remove('flash-highlight'), 2000);
    } else {
      alert('该帖子可能已被删除');
    }
  }, 300);
}

// 通知里点"群聊 @ 提醒"：关掉通知弹窗，直接打开对应群聊
async function jumpToChatNotif(convId) {
  closeModal('notif-modal');
  await showConversations();
  openChat(convId);
}

// ===== 登录注册 =====
function showLogin() { document.getElementById('login-modal').classList.remove('hidden'); }
function showRegister() { document.getElementById('register-modal').classList.remove('hidden'); }
function closeModal(id) { document.getElementById(id).classList.add('hidden'); }

async function doLogin() {
  const username = document.getElementById('login-username').value;
  const password = document.getElementById('login-password').value;
  const res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  const data = await res.json();
  if (!res.ok) return alert(data.error);
  closeModal('login-modal');
  init();
}

async function doRegister() {
  const username = document.getElementById('reg-username').value;
  const password = document.getElementById('reg-password').value;
  const nickname = document.getElementById('reg-nickname').value;
  const res = await fetch('/api/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password, nickname })
  });
  const data = await res.json();
  if (!res.ok) return alert(data.error);
  alert('注册成功，请登录！');
  closeModal('register-modal');
  showLogin();
}

async function doLogout() {
  await fetch('/api/logout', { method: 'POST' });
  currentUser = null;
  // 重置通知/私信未读基准，避免换号登录后把别人的未读误当成新消息响铃
  lastUnreadCount = 0;
  lastMsgUnread = -1;
  const oldPanel = document.getElementById('admin-panel');
  if (oldPanel) oldPanel.remove();
  resetMsgPage();     // 清掉会话/聊天残留，避免下个账号看到
  renderUserArea();   // 恢复游客界面（之前漏掉导致 UI 错乱）
  goHome(true);
}

// 退出管理员模式（不注销账号）：移除面板、刷新帖子（去掉管理按钮）
async function exitAdminMode() {
  await fetch('/api/admin/exit', { method: 'POST' });
  await loadMe();
  const oldPanel = document.getElementById('admin-panel');
  if (oldPanel) oldPanel.remove();
  renderUserArea();
  goHome(true);   // 若停留在个人主页也回到首页，保证界面干净
  loadPosts();
}

function showAdminModal() {
  if (!currentUser) return alert('请先登录');
  document.getElementById('admin-password').value = '';
  document.getElementById('admin-modal').classList.remove('hidden');
  document.getElementById('admin-password').focus();
}

async function doApplyAdmin() {
  const secret = document.getElementById('admin-password').value;
  if (!secret) return alert('请输入管理员密码');
  const res = await fetch('/api/admin/apply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret })
  });
  const data = await res.json();
  if (!res.ok) return alert(data.error || '密码错误');
  closeModal('admin-modal');
  await loadMe();
  renderUserArea();
  renderAdminPanel();
  loadPosts();
  alert('已开启管理员模式，可以删除任何人的帖子和评论');
}

// ===== 深色 / 浅色主题 =====
function applyTheme() {
  const dark = localStorage.getItem('theme') === 'dark';
  document.documentElement.classList.toggle('dark', dark);
  document.getElementById('theme-toggle').textContent = dark ? '☀️' : '🌙';
}
function toggleTheme() {
  if (localStorage.getItem('theme') === 'dark') localStorage.removeItem('theme');
  else localStorage.setItem('theme', 'dark');
  applyTheme();
}

// ===== 头像 =====
const AVATAR_COLORS = ['#f44336', '#e91e63', '#9c27b0', '#673ab7', '#3f51b5', '#2196f2',
  '#009688', '#ff9800', '#795548', '#607d8b', '#4caf50', '#ff5722'];

function userColor(name) {
  let h = 0;
  for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

// o: {id, name, avatar}；id 为 null 时不响应点击
function avatarHtml(o, cls = '') {
  const name = o.name || '?';
  const a = o.avatar || '';
  const fullCls = ('avatar ' + cls).trim();
  const click = o.id ? `onclick="event.stopPropagation();viewProfile(${o.id})"` : '';
  if (a.startsWith('/uploads/')) {
    return `<img class="${fullCls}" src="${escapeHtml(a)}" alt="${escapeHtml(name)}" ${click}>`;
  }
  const inner = a.startsWith('emoji:') ? escapeHtml(a.slice(6)) : escapeHtml(name[0] || '?');
  return `<span class="${fullCls}" style="background:${userColor(name)}" ${click}>${inner}</span>`;
}

const AVATAR_PRESETS = ['🐱', '🐶', '🦊', '🐼', '🐨', '🦁', '🐯', '🐸', '🐵', '🐷',
  '🐰', '🐻', '🦄', '🐙', '🦋', '🌸', '⭐', '🌈', '🍀', '🍉', '⚽', '🎨', '🎵', '😎'];

function showAvatarModal() {
  if (!currentUser) return alert('请先登录');
  document.getElementById('avatar-presets').innerHTML =
    AVATAR_PRESETS.map(e => `<button type="button" class="preset-emoji" onclick="pickPresetAvatar('${e}')">${e}</button>`).join('');
  document.getElementById('avatar-modal').classList.remove('hidden');
}

async function pickPresetAvatar(e) {
  const res = await fetch('/api/avatar/preset', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ avatar: 'emoji:' + e })
  });
  if (!res.ok) return alert('设置失败');
  await loadMe();
  renderUserArea();
}

document.getElementById('avatar-file-input').addEventListener('change', async function () {
  let file = this.files[0];
  if (!file) return;
  // iPhone 相册里的 HEIC 也先转成 JPG
  if (/\.heic$/i.test(file.name) && typeof heic2any !== 'undefined') {
    try {
      const out = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.9 });
      file = new File([Array.isArray(out) ? out[0] : out], 'avatar.jpg', { type: 'image/jpeg' });
    } catch (e) { /* 转换失败用原文件 */ }
  }
  const fd = new FormData();
  fd.append('avatar', file);
  const res = await fetch('/api/avatar', { method: 'POST', body: fd });
  const data = await res.json();
  if (!res.ok) return alert(data.error || '上传失败');
  this.value = '';
  closeModal('avatar-modal');
  await loadMe();
  renderUserArea();
});

// ===== 快捷表情包 =====
// 常用 emoji：评论、聊天框旁点 😀 弹出，点击直接追加到输入框，避免切输入法
const EMOJI_LIST = ['😂','👍','🎉','❤️','🤣','😍','😎','😭','😅','🤔','👋','🙏','💪','🔥','✨','💯','😴','🥳','😱','🤯','😁','🙂','🥰','😘','🤝','👏','🫶','✅','❌','⭐','🌙','☀️','🌹','🎁','🥺','😏','🤗','🫡','🐶','🐱'];
let activeEmojiTarget = null;   // 当前正在选表情的目标 input 元素

function toggleEmojiPicker(targetId, btnEl) {
  const target = document.getElementById(targetId);
  if (!target) return;
  let pop = document.getElementById('emoji-popover');
  if (pop && pop.dataset.target === targetId) { closeEmojiPicker(); return; }
  if (!pop) {
    pop = document.createElement('div');
    pop.id = 'emoji-popover';
    pop.className = 'emoji-popover';
    document.body.appendChild(pop);
  }
  pop.dataset.target = targetId;
  activeEmojiTarget = target;
  pop.innerHTML = EMOJI_LIST.map((e, i) => `<button type="button" class="emoji-cell" data-i="${i}">${e}</button>`).join('');
  pop.querySelectorAll('.emoji-cell').forEach(b => b.addEventListener('click', () => insertEmoji(b.textContent)));
  const rect = btnEl.getBoundingClientRect();
  pop.style.display = 'grid';
  const w = pop.offsetWidth || 280;
  pop.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - w - 8)) + 'px';
  pop.style.top = (rect.bottom + 4) + 'px';
}

function insertEmoji(e) {
  if (!activeEmojiTarget) return;
  const inp = activeEmojiTarget;
  const start = inp.selectionStart ?? inp.value.length;
  const end = inp.selectionEnd ?? inp.value.length;
  inp.value = inp.value.slice(0, start) + e + inp.value.slice(end);
  inp.focus();
  const pos = start + e.length;
  try { inp.setSelectionRange(pos, pos); } catch (_) {}
  inp.dispatchEvent(new Event('input', { bubbles: true }));
}

function closeEmojiPicker() {
  const pop = document.getElementById('emoji-popover');
  if (pop) pop.remove();
  activeEmojiTarget = null;
}

// 点 popover 外面或按 Esc 关闭
document.addEventListener('click', (e) => {
  if (e.target.closest('.emoji-popover') || e.target.closest('.emoji-btn')) return;
  closeEmojiPicker();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeEmojiPicker(); });

// ===== 帖子草稿自动保存 =====
// 写到一半刷新页面就丢太可惜：textarea/input 改动 500ms 后自动存 localStorage
// 发帖成功后清掉；页面加载时若检测到草稿，发帖框上方提示 恢复/丢弃
const DRAFT_KEY = 'post_draft';
let draftTimer = null;
function saveDraft() {
  const ta = document.getElementById('post-content');
  if (!ta) return;
  const content = ta.value;
  const opts = collectPollOptions() || [];
  if (!content.trim() && !opts.length && !postSection) { clearDraft(); return; }
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({
      content, section_id: postSection, poll_options: opts, ts: Date.now()
    }));
  } catch (e) {}
}
function loadDraft() {
  try { return JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null'); }
  catch (e) { return null; }
}
function clearDraft() {
  try { localStorage.removeItem(DRAFT_KEY); } catch (e) {}
  const bar = document.getElementById('draft-bar');
  if (bar) bar.classList.add('hidden');
}
function checkDraft() {
  const bar = document.getElementById('draft-bar');
  if (!bar || !currentUser) { if (bar) bar.classList.add('hidden'); return; }
  const d = loadDraft();
  if (d && d.content && d.content.trim()) bar.classList.remove('hidden');
  else bar.classList.add('hidden');
}
function restoreDraft() {
  const d = loadDraft();
  if (!d) return;
  const ta = document.getElementById('post-content');
  if (ta && d.content) ta.value = d.content;
  if (d.section_id) { postSection = d.section_id; renderPostSectionPicker(); }
  if (d.poll_options && d.poll_options.length) {
    showPollBuilder();
    const box = document.getElementById('poll-options');
    box.innerHTML = '';
    d.poll_options.forEach(text => {
      addPollOption();
      const last = box.lastElementChild && box.lastElementChild.querySelector('input');
      if (last) last.value = text;
    });
  }
  clearDraft();   // 恢复后从 localStorage 清掉，避免再次提示
}
function discardDraft() { clearDraft(); }
function scheduleDraftSave() {
  if (draftTimer) clearTimeout(draftTimer);
  draftTimer = setTimeout(saveDraft, 500);
}
function bindDraftListeners() {
  const ta = document.getElementById('post-content');
  if (ta && !ta._draftBound) {
    ta._draftBound = true;
    ta.addEventListener('input', scheduleDraftSave);
  }
  const pollBox = document.getElementById('poll-options');
  if (pollBox && !pollBox._draftBound) {
    pollBox._draftBound = true;
    pollBox.addEventListener('input', scheduleDraftSave);
    pollBox.addEventListener('click', e => {
      if (e.target.closest('.poll-del-opt')) scheduleDraftSave();   // 删除选项后存
    });
  }
}

// ===== 帖子分享链接/二维码 =====
// 用 ?postId=123 或 #post-123 链接直接打开某条帖子，自动滚动并闪烁高亮
let pendingPostId = null;
function handlePostDeepLink() {
  const m = /postId=(\d+)/.exec(location.search);
  const h = /post-(\d+)/.exec(location.hash);
  pendingPostId = (m && parseInt(m[1], 10)) || (h && parseInt(h[1], 10)) || null;
  if (pendingPostId) scrollToPendingPost();
}
async function scrollToPendingPost() {
  // 帖子可能在其它分区，先切回"全部"再找
  if (activeSection) { activeSection = 0; renderSectionTabs(); await loadPosts(); }
  let tries = 0;
  const tick = async () => {
    const el = document.getElementById('post-card-' + pendingPostId);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('highlight-flash');
      setTimeout(() => el.classList.remove('highlight-flash'), 2600);
      // 清掉 URL 参数，避免刷新又跳一次
      history.replaceState(null, '', location.pathname);
      pendingPostId = null;
      return;
    }
    if (tries++ < 10) { setTimeout(tick, 200); }
  };
  tick();
}

function showShareModal(pid) {
  const url = location.origin + '/?postId=' + pid;
  document.getElementById('share-url').value = url;
  document.getElementById('share-modal').classList.remove('hidden');
  // 渲染分享预览卡片：对方在微信/QQ 等收到链接时看到的样子
  const previewBox = document.getElementById('share-preview');
  const p = feedPostsById.get(pid);
  if (p) {
    const name = p.nickname || p.username || '同学';
    const summary = String(p.content || '')
      .replace(/@[\w\u4e00-\u9fa5]+/g, '')
      .replace(/#[^#\n]+#/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80);
    const firstImgRaw = p.images ? p.images.split(',').filter(Boolean)[0] : '';
    const firstImg = firstImgRaw && firstImgRaw.startsWith('/') ? firstImgRaw : (firstImgRaw ? '/uploads/' + firstImgRaw : '');
    const imgHtml = firstImg
      ? `<img class="share-preview-img" src="${escapeHtml(firstImg)}" alt="">`
      : '<div class="share-preview-noimg">📷</div>';
    previewBox.innerHTML = `
      <div class="share-preview-title">${escapeHtml(name)} 分享的班级动态</div>
      <div class="share-preview-body">
        ${imgHtml}
        <div class="share-preview-text">
          <div class="share-preview-desc">${escapeHtml(summary || '点开看看这条班级动态～')}</div>
          <div class="share-preview-host">${escapeHtml(location.host)} · 班级动态</div>
        </div>
      </div>`;
  } else {
    previewBox.innerHTML = '';
  }
  const qrBox = document.getElementById('share-qrcode');
  qrBox.innerHTML = '';
  if (typeof QRCode === 'undefined') {
    qrBox.innerHTML = '<div class="share-no-qr">二维码库加载失败，请直接复制链接</div>';
    return;
  }
  qrBox._qr = new QRCode(qrBox, {
    text: url, width: 192, height: 192,
    correctLevel: QRCode.CorrectLevel.M
  });
}
function closeShareModal() { document.getElementById('share-modal').classList.add('hidden'); }
async function copyShareLink() {
  const inp = document.getElementById('share-url');
  try {
    await navigator.clipboard.writeText(inp.value);
    alert('已复制链接到剪贴板');
  } catch (e) {
    inp.select();
    try { document.execCommand('copy'); alert('已复制（请直接粘贴）'); }
    catch (_) { alert('复制失败，请手动选中文本复制'); }
  }
}

// ===== 个人主页 =====
async function viewProfile(uid) {
  if (!uid) return;
  switchMainPage('feed');
  currentProfileUid = Number(uid);
  let u, posts, badges, board, visitors;
  try {
    const fetches = [
      fetch('/api/users/' + uid).then(r => r.json()),
      fetch('/api/users/' + uid + '/posts?device_id=' + encodeURIComponent(getDeviceId())).then(r => r.json()),
      fetch('/api/users/' + uid + '/achievements').then(r => r.json()).catch(() => []),
      fetch('/api/users/' + uid + '/board').then(r => r.json()).catch(() => [])
    ];
    [u, posts, badges, board] = await Promise.all(fetches);
    // 访客记录只有主页主人能看
    if (currentUser && currentUser.id === Number(uid)) {
      visitors = await fetch('/api/users/' + uid + '/visitors').then(r => r.json()).catch(() => []);
    }
  } catch (e) { return alert('加载失败'); }
  if (u.error) return alert(u.error);

  const pv = document.getElementById('profile-view');
  const isMe = currentUser && currentUser.id === u.id;
  const name = u.nickname || u.username;
  // 徽章网格
  const badgesHtml = (badges && badges.length) ? `
    <div class="badges-section">
      <h3>🏅 成就徽章</h3>
      <div class="badges-grid">
        ${badges.map(b => `
          <div class="badge ${b.unlocked ? 'unlocked' : 'locked'}" title="${escapeHtml(b.desc)}">
            <div class="badge-icon">${b.icon}</div>
            <div class="badge-name">${escapeHtml(b.name)}</div>
            <div class="badge-desc">${escapeHtml(b.desc)}</div>
          </div>`).join('')}
      </div>
    </div>` : '';
  // 生日行：自己可设置/修改；别人只看月日
  const birthdayLine = isMe
    ? `<span class="profile-birthday" onclick="editBirthday()">🎂 ${u.birthday ? '我的生日：' + u.birthday + '（点击修改）' : '设置我的生日（点击填写）'}</span>`
    : (u.birthday ? `<span class="profile-birthday">🎂 生日：${u.birthday}</span>` : '');
  // 最近访客（仅自己可见）
  const visitorsHtml = isMe ? `
    <div class="visitors-section">
      <h3>👀 最近访客</h3>
      <div class="visitors-row">
        ${(visitors && visitors.length) ? visitors.map(v => `
          <div class="visitor-item" onclick="viewProfile(${v.id})" title="${escapeHtml(v.nickname || v.username)} · ${formatTime(v.visited_at)}">
            ${avatarHtml({ id: v.id, name: v.nickname || v.username, avatar: v.avatar }, 'avatar-sm')}
            <span class="visitor-dot ${v.online ? 'online' : ''}"></span>
          </div>`).join('') : '<span class="visitors-empty">还没有人来看过~</span>'}
      </div>
    </div>` : '';
  // 留言板（电子同学录）
  const boardHtml = renderBoardSection(u, board || [], isMe);
  pv.innerHTML = `
    <div class="card profile-card">
      <button class="back-btn" onclick="goHome()">← 返回动态</button>
      <div class="profile-head">
        <div class="profile-avatar">${avatarHtml({ id: null, name, avatar: u.avatar }, 'avatar-lg')}</div>
        <h2>${escapeHtml(name)} ${levelBadge(u.points)}</h2>
        <p class="profile-sub">账号：${escapeHtml(u.username)} · 加入于 ${formatDate(u.created_at)}</p>
        <p class="profile-stat">📝 共发布 ${posts.length} 条动态 · ⭐ ${u.points || 0} 积分 ${birthdayLine}</p>
        <span class="online-line">${u.online ? '<span class="online-tag">● 在线</span>' : '<span class="offline-tag">○ 最近不在线</span>'}</span>
        ${isMe ? '<button onclick="showAvatarModal()">更换头像</button>' : (currentUser ? `<button class="primary-btn" onclick="startDirectChat(${u.id})">💬 发私信</button>` : '')}
        ${isMe ? `<button id="profile-checkin-btn" onclick="doCheckin()">📅 签到</button>` : ''}
        ${visitorsHtml}
        ${badgesHtml}
      </div>
    </div>
    ${boardHtml}`;
  // 若是自己：拉签到状态填充按钮文字
  if (isMe) loadCheckinStatusToProfileBtn();
  const postsWrap = document.createElement('div');
  if (!posts.length) {
    postsWrap.innerHTML = '<div class="card empty-state">🌸 TA 还没有发过动态~</div>';
  } else {
    posts.forEach(p => postsWrap.appendChild(renderPostCard(p)));
  }
  pv.appendChild(postsWrap);
  pv.classList.remove('hidden');
  document.getElementById('post-editor').classList.add('hidden');
  document.getElementById('posts-list').classList.add('hidden');
  document.getElementById('new-posts-bar').classList.add('hidden');
  const hbar3 = document.getElementById('hot-week-bar');
  if (hbar3) hbar3.classList.add('hidden');
  const bbar3 = document.getElementById('birthday-banner');
  if (bbar3) bbar3.classList.add('hidden');
  const abar3 = document.getElementById('announcement-bar');
  if (abar3) abar3.classList.add('hidden');
  const tbar3 = document.getElementById('topics-bar');
  if (tbar3) tbar3.classList.add('hidden');
  window.scrollTo(0, 0);
}

// 个人主页里的"签到"按钮显示当前连续天数（与导航栏按钮同步状态）
async function loadCheckinStatusToProfileBtn() {
  try {
    const d = await fetch('/api/checkin').then(r => r.json());
    const btn = document.getElementById('profile-checkin-btn');
    if (!btn) return;
    if (d.checked_today) {
      btn.textContent = `📅 今日已签 🔥${d.streak}`;
      btn.disabled = true;
      btn.classList.add('disabled-btn');
    } else {
      btn.textContent = `📅 立即签到（已连续最高 ${d.max_streak} 天）`;
    }
  } catch (e) { /* 忽略 */ }
}

// ===== 个人主页留言板（电子同学录）=====
function renderBoardSection(u, list, isMe) {
  const name = u.nickname || u.username;
  const items = list.length ? list.map(m => {
    const mine = currentUser && currentUser.id === m.author_uid;
    const canDel = currentUser && (mine || isMe || isAdminUser(currentUser));
    const mName = m.nickname || m.username;
    return `
      <div class="board-item" data-id="${m.id}">
        ${avatarHtml({ id: m.author_uid, name: mName, avatar: m.avatar }, 'avatar-sm')}
        <div class="board-body">
          <div>
            <span class="board-author" onclick="viewProfile(${m.author_uid})">${escapeHtml(mName)}</span>
            ${m.author_uid === u.id ? '<span class="board-host">主人</span>' : ''}
            <span class="board-time">${formatTime(m.created_at)}</span>
          </div>
          <div class="board-content">${linkMentions(m.content)}</div>
        </div>
        ${canDel ? `<button class="icon-mini" title="删除留言" onclick="deleteBoardMsg(${m.id}, ${u.id})">🗑</button>` : ''}
      </div>`;
  }).join('') : '<div class="board-empty">还没有留言，写下第一句祝福吧～</div>';
  const input = currentUser ? `
    <div class="board-input">
      <input id="board-text-${u.id}" maxlength="300" placeholder="给${escapeHtml(name)}留言（毕业时这就是电子同学录）..."
        onkeydown="if(event.key==='Enter')submitBoard(${u.id})">
      <button onclick="submitBoard(${u.id})">留言</button>
    </div>` : '<div class="board-guest">登录后即可在TA的主页留言</div>';
  return `
    <div class="card board-card">
      <h3>📝 留言板 <span class="board-count">${list.length} 条</span></h3>
      ${input}
      <div class="board-list">${items}</div>
    </div>`;
}

async function submitBoard(tid) {
  const inp = document.getElementById('board-text-' + tid);
  const content = inp.value.trim();
  if (!content) return;
  const res = await fetch('/api/users/' + tid + '/board', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content })
  });
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    return alert(d.error || '留言失败');
  }
  inp.value = '';
  viewProfile(tid);
  pollNotifications();
}

async function deleteBoardMsg(mid, tid) {
  if (!confirm('确定删除这条留言吗？')) return;
  const res = await fetch('/api/board/' + mid, { method: 'DELETE' });
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    return alert(d.error || '删除失败');
  }
  viewProfile(tid);
}

async function editBirthday() {
  const cur = currentUser.birthday || '';
  const v = prompt('输入你的生日（月-日，如 08-15；只记月日不记年份。清空可取消）', cur);
  if (v === null) return;
  const b = v.trim();
  if (b && !/^\d{2}-\d{2}$/.test(b)) return alert('格式不对，要像 08-15 这样');
  const res = await fetch('/api/account/birthday', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ birthday: b })
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) return alert(d.error || '保存失败');
  currentUser.birthday = b;
  viewProfile(currentUser.id);
  loadBirthdayBanner();
}

// ===== 生日墙横幅（今天寿星 + 未来60天内生日的同学） =====
let birthdayData = { today: [], upcoming: [] };
let hasBirthday = false;
// ===== 班级公告板 =====
let allAnnouncements = [];
let hasAnnouncement = false;
async function loadAnnouncements() {
  const bar = document.getElementById('announcement-bar');
  if (!bar) return;
  let list = [];
  try {
    list = await fetch('/api/announcements').then(r => r.json());
  } catch (e) { return; }
  allAnnouncements = Array.isArray(list) ? list : [];
  hasAnnouncement = allAnnouncements.length > 0;
  if (!hasAnnouncement) { bar.classList.add('hidden'); bar.innerHTML = ''; return; }
  // 首页常驻最新一条公告，点击展开详情；管理员可在底部删除
  const latest = allAnnouncements[0];
  const admin = isAdminUser(currentUser);
  bar.classList.remove('hidden');
  bar.innerHTML = `
    <div class="announcement-bar-inner" onclick="showAnnouncement(${latest.id})">
      <span class="announcement-icon">📢</span>
      <div class="announcement-bar-text">
        <div class="announcement-bar-title">${escapeHtml(latest.title)}</div>
        <div class="announcement-bar-desc">${escapeHtml((latest.content || '').slice(0, 80))}${(latest.content || '').length > 80 ? '…' : ''}</div>
      </div>
      <span class="announcement-bar-more">查看 →</span>
    </div>
    ${admin ? `<button class="announcement-admin-btn" onclick="event.stopPropagation();openAnnouncementEditor()">✏️ 发布新公告</button>` : ''}
    ${admin ? `<button class="announcement-admin-btn danger" onclick="event.stopPropagation();deleteAnnouncement(${latest.id})">🗑 删除本公告</button>` : ''}`;
}

// 查看公告详情（按 id 查 allAnnouncements，找不到则取最新）
function showAnnouncement(id) {
  const a = allAnnouncements.find(x => x.id === id) || allAnnouncements[0];
  if (!a) return;
  document.getElementById('announcement-modal-title').textContent = '📢 ' + a.title;
  document.getElementById('announcement-modal-meta').innerHTML =
    `<span>发布人：${escapeHtml(a.author_nickname || '管理员')}</span> · <span>${formatTime(a.created_at)}</span>`;
  // 内容支持简单的换行显示
  document.getElementById('announcement-modal-body').innerHTML =
    `<p>${escapeHtml(a.content || '').replace(/\n/g, '<br>')}</p>`;
  document.getElementById('announcement-modal').classList.remove('hidden');
}

// 管理员：打开公告编辑器
function openAnnouncementEditor() {
  document.getElementById('announcement-title-input').value = '';
  document.getElementById('announcement-content-input').value = '';
  document.getElementById('announcement-edit-modal').classList.remove('hidden');
}

async function submitAnnouncement() {
  const title = document.getElementById('announcement-title-input').value.trim();
  const content = document.getElementById('announcement-content-input').value.trim();
  if (!title) return alert('请填写标题');
  if (!content) return alert('请填写内容');
  const res = await fetch('/api/announcements', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, content })
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) return alert(d.error || '发布失败');
  closeModal('announcement-edit-modal');
  await loadAnnouncements();
  pollNotifications();  // 顺带刷新通知状态
}

async function deleteAnnouncement(id) {
  if (!confirm('确定删除这条公告吗？')) return;
  const res = await fetch('/api/announcements/' + id, { method: 'DELETE' });
  if (!res.ok) return alert('删除失败');
  await loadAnnouncements();
}

async function loadBirthdayBanner() {
  const bar = document.getElementById('birthday-banner');
  if (!bar) return;
  let d;
  try {
    d = await fetch('/api/birthdays').then(r => r.json());
  } catch (e) { return; }
  birthdayData = d || { today: [], upcoming: [] };
  const today = birthdayData.today || [];
  const upcoming = birthdayData.upcoming || [];
  hasBirthday = !!(today.length || upcoming.length);
  if (!hasBirthday) { bar.classList.add('hidden'); bar.innerHTML = ''; return; }
  const uName = u => escapeHtml(u.nickname || u.username);
  // 今天有人过生日：醒目大横幅；自己也是寿星时文案不同
  let mainHtml = '';
  if (today.length) {
    const isMe = currentUser && today.some(u => u.id === currentUser.id);
    mainHtml = `
      <div class="bb-main">
        <span class="bb-cake">🎈🎂🎉</span>
        <div class="bb-lines">
          <div class="bb-title">${isMe
            ? '今天是你的生日！生日快乐，天天开心！🥳'
            : '今天是 ' + today.map(u => `<a class="bb-person" onclick="viewProfile(${u.id})">${uName(u)}</a>`).join('、') + ' 的生日！'}</div>
          <div class="bb-sub">${isMe ? '看看同学们都给你留了什么祝福吧～' : '快去 TA 的主页留言板写下祝福吧～'}</div>
        </div>
        <button class="bb-go" onclick="viewProfile(${today[0].id})">送祝福 →</button>
      </div>`;
  }
  // 近期生日：小字号一行，没有寿星时它就是横幅全部内容
  const upHtml = upcoming.length
    ? `<div class="bb-upcoming ${today.length ? '' : 'bb-upcoming-only'}">🎂 近期生日：${upcoming.slice(0, 5).map(u =>
        `<span class="bb-up-item" onclick="viewProfile(${u.id})">${uName(u)}<b>${u.days === 1 ? '明天' : u.days + '天后'}</b></span>`).join('')}</div>`
    : '';
  bar.innerHTML = mainHtml + upHtml;
  bar.classList.toggle('slim', !today.length);
  bar.classList.remove('hidden');
}

// ===== 热门 #话题# =====
let hotTopics = [];
async function loadTopics() {
  const bar = document.getElementById('topics-bar');
  if (!bar) return;
  try {
    hotTopics = await fetch('/api/topics').then(r => r.json());
  } catch (e) { hotTopics = []; }
  if (!Array.isArray(hotTopics) || !hotTopics.length) {
    bar.classList.add('hidden');
    bar.innerHTML = '';
    return;
  }
  bar.innerHTML = '<span class="topics-label">#话题</span>' + hotTopics.map(t =>
    `<button class="topic-chip" onclick="showTopic(this.getAttribute('data-tag'))" data-tag="${escapeHtml(t.tag)}">
       #${escapeHtml(t.tag)}#<span class="topic-count">${t.count}</span>
     </button>`).join('');
  bar.classList.remove('hidden');
}

// 点开某个话题：列出所有带 #tag# 的帖子
async function showTopic(tag) {
  if (!tag) return;
  switchMainPage('feed');
  let posts = [];
  try {
    posts = await fetch('/api/topic/' + encodeURIComponent(tag) + '?device_id=' + encodeURIComponent(getDeviceId()))
      .then(r => r.json());
  } catch (e) { return alert('加载失败，请重试'); }
  if (!Array.isArray(posts)) posts = [];
  openContextView(`#${escapeHtml(tag)}# · ${posts.length} 条动态`, posts,
    '这个话题下还没有动态，发帖时带上 #' + escapeHtml(tag) + '# 抢沙发吧～');
}

// ===== 积分榜 / 签到榜 =====
async function showRank() {
  if (!currentUser) return alert('请先登录');
  switchMainPage('feed');
  const pv = document.getElementById('profile-view');
  pv.innerHTML = `
    <div class="card context-card">
      <button class="back-btn" onclick="goHome()">← 返回动态</button>
      <h2>🏆 班级排行榜</h2>
      <p class="rank-tip">积分靠发帖、评论、收获点赞和每日签到获得，越活跃头衔越高～</p>
      <div id="rank-loading" class="rank-loading">加载中...</div>
    </div>`;
  pv.classList.remove('hidden');
  document.getElementById('posts-list').classList.add('hidden');
  document.getElementById('post-editor').classList.add('hidden');
  ['hot-week-bar', 'birthday-banner', 'announcement-bar', 'topics-bar'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.add('hidden');
  });
  window.scrollTo(0, 0);
  let d;
  try {
    d = await fetch('/api/rank').then(r => r.json());
  } catch (e) {
    pv.querySelector('#rank-loading').textContent = '加载失败，请重试';
    return;
  }
  const medal = i => ['🥇', '🥈', '🥉'][i] || (i + 1);
  const meId = currentUser.id;
  const rowHtml = (u, i, rightTxt, showLevel) => {
    const name = u.nickname || u.username;
    return `
      <div class="rank-row ${u.id === meId ? 'me' : ''} ${i < 3 ? 'top' + (i + 1) : ''}" onclick="viewProfile(${u.id})">
        <span class="rank-no">${medal(i)}</span>
        <span class="rank-av-wrap">
          ${avatarHtml({ id: u.id, name, avatar: u.avatar }, 'avatar-sm')}
          <span class="rank-online ${u.online ? 'on' : ''}"></span>
        </span>
        <span class="rank-name">${escapeHtml(name)} ${showLevel ? levelBadge(u.points || 0) : ''}</span>
        <span class="rank-val">${rightTxt}</span>
      </div>`;
  };
  pv.querySelector('#rank-loading').outerHTML = `
    <div class="rank-mine card">
      <div class="rank-mine-item">⭐ 我的积分 <b>${d.me.points}</b><span>全校第 ${d.me.points_rank} 名</span></div>
      <div class="rank-mine-item">📅 累计签到 <b>${d.me.checkin}</b> 天<span>全校第 ${d.me.checkin_rank} 名</span></div>
    </div>
    <div class="rank-columns">
      <div class="card rank-block">
        <h3>⭐ 积分榜</h3>
        ${d.points.map((u, i) => rowHtml(u, i, '<b>' + (u.points || 0) + '</b> 分', true)).join('')}
      </div>
      <div class="card rank-block">
        <h3>📅 签到榜</h3>
        ${d.checkin.map((u, i) => rowHtml(u, i, '<b>' + (u.total || 0) + '</b> 天', false)).join('')}
      </div>
    </div>`;
}

// ===== 双列瀑布流（小红书式）=====
function isWaterfall() {
  try { return localStorage.getItem('feed_mode') === 'waterfall'; } catch (e) { return false; }
}
function applyFeedMode() {
  const list = document.getElementById('posts-list');
  if (list) list.classList.toggle('waterfall', isWaterfall());
  const btn = document.getElementById('feed-mode-btn');
  if (btn) btn.textContent = isWaterfall() ? '📃 单列' : '🖼 双列';
}
function toggleFeedMode() {
  try {
    if (isWaterfall()) localStorage.removeItem('feed_mode');
    else localStorage.setItem('feed_mode', 'waterfall');
  } catch (e) { /* 隐私模式忽略 */ }
  applyFeedMode();
}

// skipReload=true 时只切换视图（退出登录用）
function goHome(skipReload) {
  // 回到"动态"主页面；信息通讯页的会话/聊天状态保留，方便来回切换
  switchMainPage('feed');
  const pv = document.getElementById('profile-view');
  pv.classList.add('hidden');
  pv.innerHTML = '';
  // 恢复分区标签栏显示
  const tabs = document.getElementById('section-tabs');
  if (tabs) tabs.style.display = '';
  document.getElementById('posts-list').classList.remove('hidden');
  if (currentUser) document.getElementById('post-editor').classList.remove('hidden');
  // 清掉搜索框的上下文（但保留已输入的文字，方便修改关键词）
  document.getElementById('search-clear').classList.add('hidden');
  // 恢复首页热门榜显示（仅当之前加载到了数据）
  const hbar = document.getElementById('hot-week-bar');
  if (hbar) hbar.classList.toggle('hidden', !hasHotWeek);
  // 恢复生日墙横幅 / 热门话题栏
  const bbar = document.getElementById('birthday-banner');
  if (bbar) bbar.classList.toggle('hidden', !hasBirthday);
  // 恢复班级公告板
  const abar = document.getElementById('announcement-bar');
  if (abar) abar.classList.toggle('hidden', !hasAnnouncement);
  const tbar = document.getElementById('topics-bar');
  if (tbar) tbar.classList.toggle('hidden', !hotTopics.length);
  if (!skipReload) loadPosts();
}

// 退出登录时：清空信息通讯页残留内容，避免下一个登录的人看到
function resetMsgPage() {
  if (chatPollTimer) { clearInterval(chatPollTimer); chatPollTimer = null; }
  currentChatId = 0;
  ['users-view', 'conversations-view', 'chat-view'].forEach(id => {
    const el = document.getElementById(id);
    el.classList.add('hidden');
    el.innerHTML = '';
  });
}

// ===== 通用上下文视图（搜索结果 / 我的收藏，都渲染到 profile-view） =====
function openContextView(title, posts, emptyText) {
  switchMainPage('feed');
  const pv = document.getElementById('profile-view');
  pv.innerHTML = `
    <div class="card context-card">
      <button class="back-btn" onclick="goHome()">← 返回动态</button>
      <h2>${title}</h2>
    </div>`;
  const wrap = document.createElement('div');
  if (!posts.length) {
    wrap.innerHTML = `<div class="card empty-state">${emptyText}</div>`;
  } else {
    posts.forEach(p => wrap.appendChild(renderPostCard(p)));
  }
  pv.appendChild(wrap);
  pv.classList.remove('hidden');
  document.getElementById('posts-list').classList.add('hidden');
  document.getElementById('post-editor').classList.add('hidden');
  const hbar2 = document.getElementById('hot-week-bar');
  if (hbar2) hbar2.classList.add('hidden');
  const bbar2 = document.getElementById('birthday-banner');
  if (bbar2) bbar2.classList.add('hidden');
  const abar2 = document.getElementById('announcement-bar');
  if (abar2) abar2.classList.add('hidden');
  const tbar2 = document.getElementById('topics-bar');
  if (tbar2) tbar2.classList.add('hidden');
  window.scrollTo(0, 0);
}

// ===== 搜索 =====
async function doSearch() {
  const input = document.getElementById('search-input');
  const q = input.value.trim();
  if (!q) return;
  document.getElementById('search-clear').classList.remove('hidden');
  let posts = [];
  try {
    posts = await fetch('/api/search?q=' + encodeURIComponent(q) + '&device_id=' + encodeURIComponent(getDeviceId())).then(r => r.json());
  } catch (e) { return alert('搜索失败，请重试'); }
  openContextView(`🔍 搜索“${escapeHtml(q)}” · ${posts.length} 条结果`, posts,
    '😅 没有找到相关帖子，换个关键词试试');
}

function clearSearch() {
  document.getElementById('search-input').value = '';
  document.getElementById('search-clear').classList.add('hidden');
  goHome();
}

// ===== 我的收藏 =====
async function showFavorites() {
  if (!currentUser) return alert('请先登录');
  let posts = [];
  try {
    posts = await fetch('/api/favorites').then(r => r.json());
  } catch (e) { return alert('加载失败'); }
  openContextView('⭐ 我的收藏 · ' + posts.length + ' 条', posts,
    '还没有收藏，帖子右下角点 ⭐ 即可收藏');
}

// ===== 消息通知 =====
function updateNotifBadge(n) {
  const b = document.getElementById('notif-badge');
  if (n > 0) {
    b.textContent = n > 99 ? '99+' : n;
    b.classList.remove('hidden');
  } else {
    b.classList.add('hidden');
  }
}

async function pollNotifications() {
  if (!currentUser) return;
  try {
    const d = await fetch('/api/notifications').then(r => r.json());
    updateNotifBadge(d.unread);
    // 桌面通知 + 提示音：只在未读数"增加"时触发（避免打开页面就响）
    if (d.unread > lastUnreadCount && d.unread > 0) {
      playBeep();
      if (desktopNotifReady && d.list && d.list.length) {
        // 取最新一条作为桌面通知内容
        const n = d.list[0];
        const actionText = { like: '赞了你的动态', comment: '评论了你', mention: '@ 了你', chat_mention: '在群聊中 @ 了你', board: '在你的主页留了言', birthday: '今天过生日 🎂', announcement: '发布了班级公告 📢', poll: '参与了你的投票 🗳️' };
        const body = `${n.actor_nickname || '同学'} ${actionText[n.type] || '有新消息'}${n.content ? '：' + n.content.slice(0, 50) : ''}`;
        try {
          new Notification('班级动态', { body, tag: 'class-' + n.id });
        } catch (e) { /* 忽略 */ }
      }
    }
    lastUnreadCount = d.unread;
  } catch (e) { /* 忽略轮询失败 */ }
}

async function showNotifications() {
  if (!currentUser) return alert('请先登录');
  const d = await fetch('/api/notifications').then(r => r.json());
  const box = document.getElementById('notif-list');
  if (!d.list.length) {
    box.innerHTML = '<div class="notif-empty">暂时没有消息~</div>';
  } else {
    const actionText = { like: '赞了你的动态 ❤️', comment: '评论了你 💬', mention: '@了你 📢', chat_mention: '在群聊中 @ 了你 📢', board: '在你的主页留了言 📝', birthday: '今天过生日 🎂', announcement: '发布了班级公告 📢', poll: '参与了你的投票 🗳️' };
    box.innerHTML = d.list.map(n => {
      let click = '';
      if (n.conversation_id) {
        click = `onclick="jumpToChatNotif(${n.conversation_id})" title="点击打开群聊"`;
      } else if (n.post_id) {
        click = `onclick="closeModal('notif-modal');jumpToPost(${n.post_id})" title="点击查看这条动态"`;
      } else if (n.type === 'birthday') {
        click = `onclick="closeModal('notif-modal');viewProfile(${n.actor_id})" title="点击去TA的主页送祝福"`;
      } else if (n.type === 'board') {
        click = `onclick="closeModal('notif-modal');viewProfile(${currentUser.id})" title="点击查看我的留言板"`;
      } else if (n.type === 'announcement') {
        click = `onclick="closeModal('notif-modal');goHome();showAnnouncement(${n.id})" title="点击查看公告"`;
      }
      return `
      <div class="notif-item ${n.is_read ? '' : 'unread'}" ${click}>
        ${avatarHtml({ id: n.actor_id, name: n.actor_nickname, avatar: n.actor_avatar }, 'avatar-sm')}
        <div class="notif-text">
          <b>${escapeHtml(n.actor_nickname)}</b> ${actionText[n.type] || '有新消息'}
          ${n.content ? `<div class="notif-snippet">${escapeHtml(n.content)}</div>` : ''}
          <div class="notif-time">${formatTime(n.created_at)}</div>
        </div>
      </div>`;
    }).join('');
  }
  document.getElementById('notif-modal').classList.remove('hidden');
  await fetch('/api/notifications/read', { method: 'POST' });
  updateNotifBadge(0);
  lastUnreadCount = 0;  // 已全部标为已读，下次轮询的基准也归零
}

// ===== 发布动态 =====
function fmtSize(n) {
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(2) + 'MB';
  if (n >= 1024) return (n / 1024).toFixed(1) + 'KB';
  return n + 'B';
}

function updateUploadProgress(loaded, total) {
  const pct = total ? Math.floor(loaded / total * 100) : 0;
  document.getElementById('upload-progress-fill').style.width = pct + '%';
  document.getElementById('upload-progress-text').textContent = `${pct}%（${fmtSize(loaded)}/${fmtSize(total)}）`;
}

function submitPost() {
  const content = document.getElementById('post-content').value;
  const pollOptions = collectPollOptions();
  if (!content.trim() && !selectedImages.length && !selectedVideos.length && !selectedFiles.length && !pollOptions) {
    return alert('内容不能为空');
  }

  const formData = new FormData();
  formData.append('content', content);
  formData.append('section_id', postSection);
  if (pollOptions) formData.append('poll', JSON.stringify({ options: pollOptions }));
  for (const f of selectedImages) formData.append('images', f);
  for (const f of selectedVideos) formData.append('videos', f);
  for (const f of selectedFiles) formData.append('files', f);

  const btn = document.getElementById('submit-post');
  const btnText = btn.textContent;
  btn.disabled = true;
  btn.textContent = '发布中...';
  document.getElementById('upload-progress').classList.remove('hidden');
  updateUploadProgress(0, 0);

  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/posts');
  xhr.upload.addEventListener('progress', e => {
    if (e.lengthComputable) updateUploadProgress(e.loaded, e.total);
  });
  xhr.addEventListener('load', () => {
    btn.disabled = false;
    btn.textContent = btnText;
    document.getElementById('upload-progress').classList.add('hidden');
    if (xhr.status !== 200) {
      let msg = '发布失败';
      try { msg = JSON.parse(xhr.responseText).error || msg; } catch (e) {}
      return alert(msg);
    }
    document.getElementById('post-content').value = '';
    selectedImages.length = 0;
    selectedVideos.length = 0;
    selectedFiles.length = 0;
    renderImagePreview();
    renderVideoPreview();
    renderFilePreview();
    resetPollBuilder();
    clearDraft();        // 发帖成功，清掉本地草稿
    loadPosts();
  });
  xhr.addEventListener('error', () => {
    btn.disabled = false;
    btn.textContent = btnText;
    document.getElementById('upload-progress').classList.add('hidden');
    alert('网络错误，发布失败');
  });
  xhr.send(formData);
}

// ===== 已选文件预览（多次选择累积；上限：图片9张、视频1个、文件5个） =====
const selectedImages = [];
const selectedVideos = [];
const selectedFiles = [];
const IMAGE_LIMIT = 9, VIDEO_LIMIT = 1, FILE_LIMIT = 5;

function fileKey(f) { return f.name + '|' + f.size + '|' + f.lastModified; }

function addFiles(state, files, limit, limitMsg) {
  let full = false;
  for (const f of files) {
    if (state.length >= limit) { full = true; break; }
    if (!state.some(x => fileKey(x) === fileKey(f))) state.push(f);
  }
  if (full) alert(limitMsg);
}

function renderImagePreview() {
  const box = document.getElementById('image-preview');
  box.innerHTML = '';
  selectedImages.forEach((f, i) => {
    const item = document.createElement('div');
    item.className = 'preview-item';
    item.innerHTML = `<img src="${URL.createObjectURL(f)}"><button class="preview-remove" title="移除" onclick="removeSelectedImage(${i})">×</button>`;
    box.appendChild(item);
  });
}

function renderFilePreview() {
  const box = document.getElementById('file-preview');
  box.innerHTML = '';
  selectedFiles.forEach((f, i) => {
    const size = f.size > 1024 * 1024 ? (f.size / 1024 / 1024).toFixed(1) + 'MB' : Math.max(1, Math.round(f.size / 1024)) + 'KB';
    const item = document.createElement('div');
    item.className = 'file-item';
    item.innerHTML = `<span>📎 ${escapeHtml(f.name)} <span class="file-size">(${size})</span></span><button class="preview-remove" title="移除" onclick="removeSelectedFile(${i})">×</button>`;
    box.appendChild(item);
  });
}

function removeSelectedImage(i) { selectedImages.splice(i, 1); renderImagePreview(); }
function removeSelectedFile(i) { selectedFiles.splice(i, 1); renderFilePreview(); }

// iPhone HEIC 图片选择时自动转换成 JPG
async function handleImageSelection() {
  const input = document.getElementById('image-input');
  const files = [...input.files];
  input.value = '';
  const heics = files.filter(f => /\.heic$/i.test(f.name) || f.type === 'image/heic');
  if (heics.length && typeof heic2any !== 'undefined') {
    const box = document.getElementById('image-preview');
    box.innerHTML = '<div style="font-size:13px;color:var(--text-secondary)">正在转换 iPhone 图片(HEIC)为 JPG，请稍候...</div>';
    const converted = [];
    for (const f of files) {
      if (heics.includes(f)) {
        try {
          const out = await heic2any({ blob: f, toType: 'image/jpeg', quality: 0.9 });
          const blob = Array.isArray(out) ? out[0] : out;
          converted.push(new File([blob], f.name.replace(/\.heic$/i, '.jpg'), { type: 'image/jpeg' }));
        } catch (e) { converted.push(f); }
      } else {
        converted.push(f);
      }
    }
    addFiles(selectedImages, converted, IMAGE_LIMIT, '图片最多9张');
  } else {
    addFiles(selectedImages, files, IMAGE_LIMIT, '图片最多9张');
  }
  renderImagePreview();
}

function renderVideoPreview() {
  const box = document.getElementById('video-preview');
  box.innerHTML = '';
  selectedVideos.forEach((f, i) => {
    const item = document.createElement('div');
    item.className = 'preview-item video-preview-item';
    item.innerHTML = `<video src="${URL.createObjectURL(f)}" muted></video><button class="preview-remove" title="移除" onclick="removeSelectedVideo(${i})">×</button>`;
    box.appendChild(item);
  });
}

function removeSelectedVideo(i) { selectedVideos.splice(i, 1); renderVideoPreview(); }

function handleVideoSelection() {
  const input = document.getElementById('video-input');
  const files = [...input.files];
  input.value = '';
  addFiles(selectedVideos, files, VIDEO_LIMIT, '每条动态只能上传1个视频');
  renderVideoPreview();
}

function handleFileSelection() {
  const input = document.getElementById('file-input');
  const files = [...input.files];
  input.value = '';
  addFiles(selectedFiles, files, FILE_LIMIT, '文件最多5个');
  renderFilePreview();
}

document.getElementById('image-input').addEventListener('change', handleImageSelection);
document.getElementById('video-input').addEventListener('change', handleVideoSelection);
document.getElementById('file-input').addEventListener('change', handleFileSelection);

// ===== 分区标签栏（全部 + 各分区） =====
function renderSectionTabs() {
  const box = document.getElementById('section-tabs');
  const chip = (id, name) =>
    `<button class="section-tab ${activeSection === id ? 'active' : ''}" onclick="switchSection(${id})">${name}</button>`;
  box.innerHTML = chip(0, '全部') + sections.map(s => chip(s.id, escapeHtml(s.name))).join('')
    + '<button class="section-tab feed-mode-toggle" id="feed-mode-btn" onclick="toggleFeedMode()" title="切换单列/双列瀑布流">🖼 双列</button>';
  applyFeedMode();
}

function switchSection(id) {
  if (!document.getElementById('profile-view').classList.contains('hidden')) goHome(true);
  activeSection = id;
  renderSectionTabs();
  loadPosts();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ===== 发帖时的分区选择 =====
function renderPostSectionPicker() {
  const box = document.getElementById('post-section-picker');
  if (!sections.length) { box.innerHTML = ''; return; }
  if (postSection && !sections.some(s => s.id === postSection)) postSection = 0;
  const chip = (id, name) =>
    `<button type="button" class="post-section-chip ${postSection === id ? 'active' : ''}" onclick="pickPostSection(${id})">${name}</button>`;
  box.innerHTML = '<span class="picker-label">分区</span>' +
    chip(0, '不分区') + sections.map(s => chip(s.id, escapeHtml(s.name))).join('');
}
function pickPostSection(id) { postSection = id; renderPostSectionPicker(); saveDraft(); }

// ===== 发帖时的投票构建器 =====
let pollBuilderOn = false;
function showPollBuilder() {
  pollBuilderOn = true;
  document.getElementById('poll-builder').classList.remove('hidden');
  const box = document.getElementById('poll-options');
  if (!box.children.length) {
    addPollOption(); addPollOption();   // 默认两行
  }
}
function removePollBuilder() {
  pollBuilderOn = false;
  document.getElementById('poll-builder').classList.add('hidden');
  saveDraft();
}
function addPollOption() {
  const box = document.getElementById('poll-options');
  if (box.children.length >= 6) return alert('最多 6 个选项');
  const row = document.createElement('div');
  row.className = 'poll-option-row';
  row.innerHTML =
    `<input class="poll-option-input" placeholder="选项内容（最多30字）" maxlength="30">
     <button type="button" class="poll-del-opt" onclick="this.parentElement.remove(); saveDraft()">✕</button>`;
  box.appendChild(row);
  row.querySelector('input').focus();
}
// 收集有效选项；不足2个返回 null
function collectPollOptions() {
  if (!pollBuilderOn) return null;
  const vals = [...document.querySelectorAll('.poll-option-input')]
    .map(i => i.value.trim()).filter(Boolean);
  if (vals.length < 2) return null;
  return vals.slice(0, 6);
}
// 发布成功后重置构建器
function resetPollBuilder() {
  document.getElementById('poll-options').innerHTML = '';
  removePollBuilder();
}

// ===== 动态列表 =====
function showSkeletons(el) {
  el.innerHTML = [1, 2, 3].map(() => `
    <div class="card skeleton-card">
      <div class="sk-line sk-head"></div>
      <div class="sk-line sk-body" style="width:90%"></div>
      <div class="sk-line sk-body" style="width:70%"></div>
      <div class="sk-line sk-actions"></div>
    </div>`).join('');
}

async function loadPosts() {
  const listEl = document.getElementById('posts-list');
  if (!listEl.children.length) showSkeletons(listEl);
  let posts;
  try {
    const qs = [];
    if (activeSection) qs.push('sectionId=' + activeSection);
    qs.push('device_id=' + encodeURIComponent(getDeviceId()));
    posts = await fetch('/api/posts?' + qs.join('&')).then(r => r.json());
  } catch (e) {
    listEl.innerHTML = '<div class="card empty-state">加载失败，请刷新页面重试</div>';
    return;
  }
  // latestPostId 只跟踪"全部"视图，避免分区视图干扰新动态提醒
  if (!activeSection) latestPostId = posts.length ? posts[0].id : 0;
  document.getElementById('new-posts-bar').classList.add('hidden');
  listEl.innerHTML = '';
  if (!posts.length) {
    const secName = sections.find(s => s.id === activeSection);
    listEl.innerHTML = secName
      ? `<div class="card empty-state">📂 “${escapeHtml(secName.name)}”分区还没有帖子，来发布第一条吧~</div>`
      : '<div class="card empty-state">🌸 还没有动态，快来发布第一条吧~</div>';
    return;
  }
  for (const p of posts) listEl.appendChild(renderPostCard(p));
}

// 检查是否有新动态（轻量轮询）
async function checkNewPosts() {
  if (!document.getElementById('profile-view').classList.contains('hidden')) return;
  try {
    const posts = await fetch('/api/posts').then(r => r.json());
    const newest = posts.length ? posts[0].id : 0;
    if (latestPostId && newest > latestPostId) {
      document.getElementById('new-posts-bar').classList.remove('hidden');
    }
  } catch (e) { /* 忽略 */ }
}

// 渲染单条帖子（首页和个人主页共用）
function renderPostCard(p) {
  feedPostsById.set(p.id, p);  // 缓存到全局 Map，供分享预览等按 id 取帖子
  const name = p.nickname || p.username;
  // 登录用户按账号识别点赞；游客按设备识别（后端 liked 已包含设备分支）
  const liked = !!p.liked;
  const favorited = currentUser && !!p.favorited;
  const canDelete = currentUser && (currentUser.id === p.user_id || isAdminUser(currentUser));
  const canEdit = currentUser && (currentUser.id === p.user_id || isAdminUser(currentUser));
  const admin = isAdminUser(currentUser);
  const images = p.images ? p.images.split(',').filter(Boolean) : [];
  const videos = p.videos ? p.videos.split(',').filter(Boolean) : [];
  const files = p.files ? p.files.split(',').filter(Boolean) : [];

  const div = document.createElement('div');
  div.id = 'post-card-' + p.id;
  div.className = 'card' + (p.pinned ? ' pinned-post' : '');
  div.innerHTML = `
    <div class="post-header">
      <div class="post-user">
        ${avatarHtml({ id: p.user_id, name, avatar: p.avatar })}
        <div class="post-meta">
          <span class="post-author" onclick="viewProfile(${p.user_id})">${escapeHtml(name)}
            ${p.pinned ? '<span class="pin-badge">📌 置顶</span>' : ''}
          </span>
          <span class="post-time">· ${formatTime(p.created_at)}
            ${p.section_name ? `<span class="post-section-badge">📂 ${escapeHtml(p.section_name)}</span>` : ''}
            <span class="view-badge">👀 <span id="view-count-${p.id}">${p.view_count || 0}</span></span>
          </span>
        </div>
      </div>
      <div class="post-manage">
        ${admin ? `
        <select class="move-section-select" title="移动到分区" onchange="movePostSection(${p.id}, this.value)">
          <option value="0" ${!p.section_id ? 'selected' : ''}>📂 未分区</option>
          ${sections.map(s => `<option value="${s.id}" ${p.section_id === s.id ? 'selected' : ''}>${escapeHtml(s.name)}</option>`).join('')}
        </select>` : ''}
        ${admin ? `<button class="icon-mini" title="${p.pinned ? '取消置顶' : '置顶'}" onclick="togglePin(${p.id})">${p.pinned ? '取消置顶' : '📌'}</button>` : ''}
        ${canEdit ? `<button class="icon-mini" title="编辑" onclick="startEdit(${p.id})">✏️</button>` : ''}
        ${canDelete ? `<button class="icon-mini" title="删除" onclick="deletePost(${p.id})">🗑</button>` : ''}
      </div>
    </div>
    ${p.content ? `<div class="post-content" id="post-content-text-${p.id}">${linkMentions(p.content)}</div>` : ''}
    <div class="edit-area hidden" id="edit-area-${p.id}">
      <textarea id="edit-ta-${p.id}" rows="3"></textarea>
      <div class="edit-actions">
        <button onclick="saveEdit(${p.id})">保存</button>
        <button class="modal-cancel" onclick="cancelEdit(${p.id})">取消</button>
      </div>
    </div>
    ${images.length ? `<div class="post-images">${images.map(i => `<img src="${i}" onclick="showImage('${i}')">`).join('')}</div>` : ''}
    ${videos.length ? `<div class="post-videos">${videos.map(v => `<video src="${v}" controls preload="metadata" playsinline></video>`).join('')}</div>` : ''}
    ${files.length ? `<div class="post-files">${files.map(f => `<a href="${f}" download>📎 ${decodeURIComponent(f.split('/').pop())}</a>`).join('')}</div>` : ''}
    ${p.poll ? renderPollBox(p) : ''}
    <div class="post-actions">
      <button id="like-btn-${p.id}" onclick="toggleLike(${p.id}, this)" class="${liked ? 'active' : ''}">
        ❤️ <span class="like-count">${p.like_count}</span>
      </button>
      <button id="comment-btn-${p.id}" onclick="toggleComments(${p.id})">💬 评论 (${p.comment_count})</button>
      ${currentUser ? `<button id="fav-btn-${p.id}" onclick="toggleFavorite(${p.id}, this)" class="${favorited ? 'active' : ''}">
        ${favorited ? '🌟 已收藏' : '⭐ 收藏'}</button>` : ''}
      <button class="share-btn" onclick="showShareModal(${p.id})" title="复制链接 / 二维码分享">🔗 分享</button>
      ${currentUser && currentUser.id !== p.user_id ? `<button class="report-btn" onclick="reportPost(${p.id})" title="举报这条动态给管理员">🚩 举报</button>` : ''}
    </div>
    <div class="comments-section hidden" id="comments-${p.id}">
      <div class="comments-list" id="comments-list-${p.id}"></div>
      ${currentUser ? `
        <div class="comment-img-preview" id="comment-img-preview-${p.id}"></div>
        <div class="comment-input">
          <button type="button" class="emoji-btn" title="插入表情" onclick="event.stopPropagation();toggleEmojiPicker('comment-input-${p.id}', this)">😀</button>
          <input placeholder="写评论...（@昵称 可提醒TA）" id="comment-input-${p.id}"
            onkeydown="if(event.key==='Enter')submitComment(${p.id})">
          <button type="button" class="comment-img-btn" title="发图片/表情包" onclick="pickImg('comment-img-input-${p.id}')">🖼</button>
          <input type="file" id="comment-img-input-${p.id}" accept="image/jpeg,image/png,image/gif,image/webp" hidden
            onchange="uploadCommentImg('c${p.id}','comment-img-preview-${p.id}',this)">
          <button onclick="submitComment(${p.id})">发送</button>
        </div>` : `
        <div class="comment-input guest-comment-input">
          <input class="guest-name-input" id="guest-name-${p.id}" placeholder="昵称（选填）" maxlength="12">
          <input placeholder="游客也可以评论，说点什么吧..." id="comment-input-${p.id}"
            onkeydown="if(event.key==='Enter')submitComment(${p.id})">
          <button onclick="submitComment(${p.id})">发送</button>
        </div>`}
    </div>`;
  // 保存投票定义到 DOM 元素上，投票后就地刷新
  if (p.poll) {
    const pb = div.querySelector('.poll-box');
    if (pb) pb._poll = JSON.parse(JSON.stringify(p.poll));
  }
  // 帖子真正进入视野时浏览量 +1（会话去重防刷）
  observeView(div, p.id);
  return div;
}

// ===== 浏览量：帖子在屏幕上露出 60% 时计一次 =====
let viewObserver = null;
// 游客身份的设备标识：localStorage 持久保存，同一浏览器/设备始终一致
function getDeviceId() {
  try {
    let id = localStorage.getItem('device_id');
    if (!id) {
      id = 'd-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
      localStorage.setItem('device_id', id);
    }
    return id;
  } catch (e) { return ''; }  // 隐私模式无 localStorage 时回退
}
function observeView(el, pid) {
  if (!('IntersectionObserver' in window)) return;
  if (!viewObserver) {
    viewObserver = new IntersectionObserver(entries => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const vpid = e.target.dataset.pid;
        viewObserver.unobserve(e.target);
        fetch('/api/posts/' + vpid + '/view', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ device_id: getDeviceId() })
        })
          .then(r => r.json())
          .then(d => {
            const c = document.getElementById('view-count-' + vpid);
            if (c) c.textContent = d.viewCount;
          }).catch(() => {});
      }
    }, { threshold: 0.6 });
  }
  el.dataset.pid = pid;
  viewObserver.observe(el);
}

// ===== 编辑帖子 =====
function startEdit(pid) {
  const box = document.getElementById('edit-area-' + pid);
  const textEl = document.getElementById('post-content-text-' + pid);
  document.getElementById('edit-ta-' + pid).value = textEl ? textEl.textContent : '';
  box.classList.remove('hidden');
  document.getElementById('edit-ta-' + pid).focus();
}
function cancelEdit(pid) { document.getElementById('edit-area-' + pid).classList.add('hidden'); }
async function saveEdit(pid) {
  const content = document.getElementById('edit-ta-' + pid).value;
  const res = await fetch(`/api/posts/${pid}/edit`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content })
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) return alert(d.error || '保存失败');
  const textEl = document.getElementById('post-content-text-' + pid);
  if (textEl) textEl.innerHTML = linkMentions(d.content);
  cancelEdit(pid);
}

// ===== 收藏 =====
async function toggleFavorite(pid, btn) {
  const res = await fetch(`/api/posts/${pid}/favorite`, { method: 'POST' });
  if (res.status === 401) return alert('请先登录');
  if (!res.ok) return alert('操作失败');
  const d = await res.json();
  btn.classList.toggle('active', d.favorited);
  btn.textContent = d.favorited ? '🌟 已收藏' : '⭐ 收藏';
}

// ===== 投票渲染 =====
// 规则：投票前就能看到每个选项的票数、比例、投票人昵称；点击选项即投票，已投后点其他选项可改选
function pollBoxInner(poll) {
  const voted = !!poll.my_vote;
  const total = poll.total_votes || 0;
  const rows = poll.options.map(o => {
    const r = poll.results.find(x => x.option_id === o.id);
    const count = r ? r.count : 0;
    const voters = (r && r.voters) || [];
    const pct = total ? Math.round(count / total * 100) : 0;
    const mine = poll.my_vote === o.id;
    const chips = voters.map(v => `<span class="poll-voter">${escapeHtml(v.nickname)}</span>`).join('');
    return `<div class="poll-row">
      <button type="button" class="poll-result ${mine ? 'mine' : ''}" onclick="castVote(this,${o.id})">
        <div class="poll-bar" style="width:${pct}%"></div>
        <span class="poll-option-text">${escapeHtml(o.text)}${mine ? ' ✅' : ''}</span>
        <span class="poll-pct">${pct}% · ${count}票</span>
      </button>
      ${voters.length ? `<div class="poll-voters">👥 ${chips}</div>` : ''}
    </div>`;
  }).join('');
  return `<div class="poll-title">🗳️ 投票 · ${voted ? '已投（点击其他选项可改选）' : '点击选项投票，也可先看看大家的选择'}</div>
    ${rows}<div class="poll-total">共 ${total} 人参与</div>`;
}
function renderPollBox(p) {
  return `<div class="poll-box" id="poll-box-${p.id}">${pollBoxInner(p.poll)}</div>`;
}
async function castVote(btn, oid) {
  const box = btn.closest('.poll-box');
  const pid = box.id.replace('poll-box-', '');
  const res = await fetch(`/api/posts/${pid}/vote`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ option_id: oid })
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) return alert(d.error || '投票失败');
  // 用返回结果更新本地投票对象，就地重绘（不刷新整个列表）
  const poll = box._poll;
  poll.results = d.results;
  poll.total_votes = d.total_votes;
  poll.my_vote = d.my_vote;
  box.innerHTML = pollBoxInner(poll);
}

async function toggleComments(pid) {
  const sec = document.getElementById('comments-' + pid);
  const willOpen = sec.classList.contains('hidden');
  sec.classList.toggle('hidden');
  if (willOpen && !sec.dataset.loaded) {
    sec.dataset.loaded = '1';
    await loadCommentsFor(pid);
  }
}

async function loadCommentsFor(pid) {
  const box = document.getElementById('comments-list-' + pid);
  box.innerHTML = '<div class="comment-loading">加载中...</div>';
  const list = await fetch(`/api/posts/${pid}/comments`).then(r => r.json());
  if (!list.length) {
    box.innerHTML = '<div class="comment-empty">还没有评论，快来抢沙发~</div>';
    return;
  }
  // 后端返回扁平列表（带 parent_id），前端构建嵌套树
  const tree = buildCommentTree(list);
  box.innerHTML = tree.map(c => commentNodeHtml(c, pid, 0)).join('');
}

// 把扁平评论列表（每条带 parent_id）构造成嵌套树（c.children 数组）
// 同时给每条子评论挂 parent_name，便于显示"回复 XXX："
function buildCommentTree(list) {
  const map = {};
  list.forEach(c => { c.children = []; map[c.id] = c; });
  const roots = [];
  list.forEach(c => {
    const pid = c.parent_id || 0;
    if (pid && map[pid]) {
      c.parent_name = map[pid].nickname || map[pid].username;
      map[pid].children.push(c);
    } else {
      c.parent_name = '';
      roots.push(c);   // parent_id=0 或父评论已删除 → 视作顶级
    }
  });
  return roots;
}

// 递归渲染单条评论（含子回复）
// pid 是帖子 id（用于重新加载评论），depth 控制缩进与最大嵌套层级
function commentNodeHtml(c, pid, depth) {
  const isGuest = !c.user_id;
  const name = c.nickname || c.username || '游客';
  // 游客评论 user_id=0，管理员可以删除（后端 adminMode 放行）
  const canDel = currentUser && (!isGuest && (currentUser.id === c.user_id || isAdminUser(currentUser)) || isAdminUser(currentUser));
  // 最多 4 级缩进，第 5 级起不再加深，避免评论栏被挤窄
  const indent = Math.min(depth, 4) * 18;
  // 回复对象：父评论的作者名（顶级评论 depth=0 时无）
  let replyTo = '';
  if (depth > 0 && c.parent_name) {
    replyTo = `<span class="reply-to">回复 <b>${escapeHtml(c.parent_name)}</b>：</span>`;
  }
  const childrenHtml = (c.children && c.children.length)
    ? '<div class="comment-replies">' + c.children.map(ch => commentNodeHtml(ch, pid, depth + 1)).join('') + '</div>'
    : '';
  const authorHtml = isGuest
    ? `<span class="comment-author guest-author">${escapeHtml(name)}<span class="guest-badge">游客</span></span>`
    : `<span class="comment-author" onclick="viewProfile(${c.user_id})">${escapeHtml(name)}</span>`;
  const commentImage = c.image
    ? `<img class="comment-image" src="${escapeHtml(c.image)}" alt="评论图片" onclick="showImage(this.src)">` : '';
  return `
    <div class="comment" data-id="${c.id}" style="margin-left:${indent}px">
      ${avatarHtml({ id: isGuest ? null : c.user_id, name, avatar: c.avatar }, 'avatar-sm')}
      <div class="comment-body">
        ${authorHtml}
        ${replyTo}
        <span class="comment-text">${linkMentions(c.content)}</span>
        ${commentImage}
        <div class="comment-meta">
          <span class="comment-time">${formatTime(c.created_at)}</span>
          <button class="comment-reply-btn" onclick="startReply(${c.id}, ${pid})">回复</button>
        </div>
      </div>
      ${canDel ? `<button class="icon-mini" title="删除评论（含所有回复）" onclick="deleteComment(${c.id}, ${pid})">🗑</button>` : ''}
      <div class="reply-input hidden" id="reply-input-${c.id}">
        ${currentUser ? '' : '<input class="reply-guest-name" placeholder="昵称（选填）" maxlength="12">'}
        <input class="reply-content-input" placeholder="回复 ${escapeHtml(name)}..." maxlength="2000"
          onkeydown="if(event.key==='Enter'){event.preventDefault();submitReply(${pid},${c.id})} if(event.key==='Escape')cancelReply(${c.id})">
        ${currentUser ? `
          <button type="button" class="emoji-btn" title="插入表情" onclick="event.stopPropagation();toggleEmojiPicker('reply-input-field-${c.id}', this)">😀</button>
          <button type="button" class="comment-img-btn" title="发图片/表情包" onclick="pickImg('reply-img-input-${c.id}')">🖼</button>
          <input type="file" id="reply-img-input-${c.id}" accept="image/jpeg,image/png,image/gif,image/webp" hidden
            onchange="uploadCommentImg('r${c.id}','reply-img-preview-${c.id}',this)">` : ''}
        <button onclick="submitReply(${pid}, ${c.id})">发送</button>
        <button class="modal-cancel" onclick="cancelReply(${c.id})">取消</button>
        ${currentUser ? `<div class="comment-img-preview reply-img-preview" id="reply-img-preview-${c.id}"></div>` : ''}
      </div>
      ${childrenHtml}
    </div>`;
}

// 楼中楼回复输入框控制：一次只允许一个评论展开回复框
function startReply(cid, pid) {
  cancelAllReplies();
  const wrap = document.getElementById('reply-input-' + cid);
  if (!wrap) return;
  // 给正文输入框设置 id 便于 emoji picker 定位（游客回复框里还有一个昵称框）
  const inp = wrap.querySelector('.reply-content-input');
  inp.id = 'reply-input-field-' + cid;
  wrap.classList.remove('hidden');
  inp.value = '';
  inp.focus();
}
function cancelReply(cid) {
  const wrap = document.getElementById('reply-input-' + cid);
  if (wrap) wrap.classList.add('hidden');
}
function cancelAllReplies() {
  document.querySelectorAll('.reply-input:not(.hidden)').forEach(el => el.classList.add('hidden'));
}
// 组装评论/回复请求体：登录用户只发内容；游客额外带设备标识和选填昵称
function commentPayload(extra) {
  const body = Object.assign({}, extra);
  if (!currentUser) body.device_id = getDeviceId();
  return body;
}

// ===== 评论图片/表情包（仅登录用户；先上传拿 URL，发送评论时一并提交） =====
// key：顶级评论用 'c'+帖子id，回复用 'r'+评论id；值是已上传图片的 /uploads/ 地址
const pendingCommentImg = {};
function pickImg(inputId) {
  const el = document.getElementById(inputId);
  if (el) el.click();
}
async function uploadCommentImg(key, previewId, input) {
  const f = input.files && input.files[0];
  input.value = '';
  if (!f) return;
  if (f.size > 8 * 1024 * 1024) return alert('图片不能超过 8MB');
  const fd = new FormData();
  fd.append('image', f);
  let res;
  try {
    res = await fetch('/api/upload/comment-image', { method: 'POST', body: fd });
  } catch (e) { return alert('上传失败，请重试'); }
  const d = await res.json().catch(() => ({}));
  if (!res.ok) return alert(d.error || '上传失败');
  pendingCommentImg[key] = d.url;
  const box = document.getElementById(previewId);
  if (box) {
    box.innerHTML = `<img src="${d.url}" onclick="showImage('${d.url}')">
      <button type="button" class="comment-img-rm" title="移除图片" onclick="cancelCommentImg('${key}','${previewId}')">×</button>`;
  }
}
function cancelCommentImg(key, previewId) {
  delete pendingCommentImg[key];
  const box = document.getElementById(previewId);
  if (box) box.innerHTML = '';
}

async function submitReply(pid, cid) {
  const wrap = document.getElementById('reply-input-' + cid);
  if (!wrap) return;
  const inp = wrap.querySelector('.reply-content-input');
  const content = (inp.value || '').trim();
  const imgKey = 'r' + cid;
  const image = pendingCommentImg[imgKey] || '';
  if (!content && !image) return;
  const payload = commentPayload({ content, image, parent_id: cid });
  if (!currentUser) {
    payload.guest_name = (wrap.querySelector('.reply-guest-name') || {}).value || '';
  }
  const res = await fetch(`/api/posts/${pid}/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    return alert(d.error || '回复失败');
  }
  inp.value = '';
  cancelCommentImg(imgKey, 'reply-img-preview-' + cid);
  await loadCommentsFor(pid);
  if (currentUser) pollNotifications();
}

async function submitComment(pid) {
  const input = document.getElementById('comment-input-' + pid);
  const content = input.value.trim();
  const imgKey = 'c' + pid;
  const image = pendingCommentImg[imgKey] || '';
  if (!content && !image) return;
  const payload = commentPayload({ content, image });
  let guestNameInput = null;
  if (!currentUser) {
    guestNameInput = document.getElementById('guest-name-' + pid);
    payload.guest_name = guestNameInput ? guestNameInput.value : '';
  }
  const res = await fetch(`/api/posts/${pid}/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    return alert(d.error || '评论失败');
  }
  input.value = '';
  cancelCommentImg(imgKey, 'comment-img-preview-' + pid);
  await loadCommentsFor(pid);
  const n = document.querySelectorAll('#comments-list-' + pid + ' .comment').length;
  document.getElementById('comment-btn-' + pid).innerHTML = `💬 评论 (${n})`;
  if (currentUser) pollNotifications();
}

async function toggleLike(postId, btn) {
  const res = await fetch(`/api/posts/${postId}/like`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_id: getDeviceId() })
  });
  // 409：游客这台设备已经赞过
  if (res.status === 409) {
    btn.classList.add('active');
    const d = await res.json().catch(() => ({}));
    return alert(d.error || '这台设备已经赞过啦');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return alert(data.error || '操作失败');
  btn.querySelector('.like-count').textContent = data.likeCount;
  if (data.liked) { btn.classList.add('active'); likeBurst(btn); }
  else btn.classList.remove('active');
}

// 点赞动画：按钮弹跳 + 飘出小爱心
function likeBurst(btn) {
  btn.classList.remove('like-pop');
  void btn.offsetWidth;
  btn.classList.add('like-pop');
  const rect = btn.getBoundingClientRect();
  for (let i = 0; i < 3; i++) {
    const h = document.createElement('span');
    h.className = 'float-heart';
    h.textContent = ['❤️', '💕', '💖'][i];
    h.style.left = (rect.left + rect.width / 2 + (i - 1) * 14) + 'px';
    h.style.top = (rect.top - 6) + 'px';
    document.body.appendChild(h);
    setTimeout(() => h.remove(), 900);
  }
}

async function togglePin(postId) {
  const res = await fetch(`/api/posts/${postId}/pin`, { method: 'POST' });
  if (res.status === 403) return alert('需要管理员权限');
  if (!res.ok) return alert('操作失败');
  loadPosts();
}

// 管理员移动帖子到分区
async function movePostSection(postId, sectionId) {
  const res = await fetch(`/api/posts/${postId}/section`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ section_id: parseInt(sectionId, 10) || 0 })
  });
  if (res.status === 403) return alert('需要管理员权限');
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    return alert(d.error || '移动失败');
  }
  loadPosts();  // 在分区视图里移走帖子后，列表自动刷新
}

async function deletePost(id) {
  if (!confirm('确定删除这条动态？相关图片、视频和文件都会一起删除')) return;
  const res = await fetch(`/api/posts/${id}`, { method: 'DELETE' });
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    return alert(d.error || '删除失败');
  }
  loadPosts();
}

// 举报帖子：选一个原因（可改），提交给管理员后台
async function reportPost(pid) {
  const reason = prompt('请填写举报原因（选填）：\n如：广告/垃圾信息、辱骂或不文明内容、不实信息等', '其他不合适的内容');
  if (reason === null) return;
  try {
    const res = await fetch(`/api/posts/${pid}/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: reason.trim() })
    });
    const d = await res.json();
    if (res.status === 409) return alert(d.error || '你已经举报过这条动态');
    if (!res.ok) return alert(d.error || '举报失败');
    alert('举报已提交，管理员会尽快处理，谢谢你的反馈 🙏');
  } catch (e) {
    alert('网络错误，举报失败');
  }
}

async function deleteComment(id, pid) {
  if (!confirm('确定删除这条评论？它下面的所有回复也会一并删除。')) return;
  const res = await fetch(`/api/comments/${id}`, { method: 'DELETE' });
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    return alert(d.error || '删除失败');
  }
  if (pid) await loadCommentsFor(pid);
}

// ===== 管理员面板 =====
async function renderAdminPanel() {
  if (!isAdminUser(currentUser)) return;
  const container = document.getElementById('page-feed');
  const panel = document.createElement('div');
  panel.className = 'admin-panel';
  panel.id = 'admin-panel';

  const [users, apps, repData, backupData] = await Promise.all([
    fetch('/api/admin/users').then(r => r.json()),
    fetch('/api/admin/applications').then(r => r.json()).catch(() => []),
    fetch('/api/admin/reports').then(r => r.json()).catch(() => ({ list: [] })),
    fetch('/api/admin/backups').then(r => r.json()).catch(() => ({ list: [] }))
  ]);
  const reports = repData.list || [];
  const backups = backupData.list || [];

  panel.innerHTML = `
    <h3>🛠 管理员面板</h3>
    <p style="font-size:13px;color:var(--text-secondary)">💡 点帖子右上角的 📌 可置顶重要通知</p>
    <p style="margin-top:4px">💾 数据库自动备份</p>
    <div class="admin-backup-row">
      <button class="primary-btn" onclick="doManualBackup()">➕ 立即备份一次</button>
      <button onclick="downloadBackup()">⬇️ 下载当前数据库</button>
    </div>
    <p class="modal-tip" style="margin:4px 0 2px">服务器每天自动备份一个，保留最近 ${backupData.keep_days || 7} 天；手动备份会长期保留，需自己删除。</p>
    ${backups.length ? backups.map(b => `
      <div class="user-item backup-item">
        <span class="backup-info">
          <span class="backup-tag ${b.manual ? 'manual' : 'auto'}">${b.manual ? '手动' : '自动'}</span>
          ${formatTime(b.mtime)} · ${formatFileSize(b.size)}
        </span>
        <div class="user-item-actions">
          <button onclick="downloadBackupFile('${b.name}')">⬇️ 下载</button>
          <button class="danger" onclick="deleteBackupFile('${b.name}')">🗑 删除</button>
        </div>
      </div>`).join('') : '<p style="font-size:13px;color:var(--text-secondary)">暂无备份文件</p>'}
    <p style="margin-top:12px">📢 班级公告板</p>
    <button class="primary-btn" onclick="openAnnouncementEditor()">➕ 发布新公告</button>
    ${allAnnouncements.length ? allAnnouncements.map(a => `
      <div class="user-item" style="flex-direction:column;align-items:flex-start;gap:6px">
        <div><b>${escapeHtml(a.title)}</b> <span style="color:var(--text-secondary);font-size:12px">· ${escapeHtml(a.author_nickname || '管理员')} · ${formatTime(a.created_at)}</span></div>
        <div style="font-size:13px;color:var(--text-secondary)">${escapeHtml((a.content || '').slice(0, 80))}${(a.content || '').length > 80 ? '…' : ''}</div>
        <div class="user-item-actions">
          <button onclick="showAnnouncement(${a.id})">查看</button>
          <button class="danger" onclick="deleteAnnouncement(${a.id})">🗑 删除</button>
        </div>
      </div>`).join('') : '<p style="font-size:13px;color:var(--text-secondary)">暂无公告</p>'}
    ${reports.length ? `<p style="margin-top:12px">🚩 待处理举报 (${reports.length})</p>
      ${reports.map(g => `
      <div class="report-item">
        <div class="report-post">
          ${g.post_exists
            ? `<a onclick="jumpToPost(${g.post_id})" title="点击查看原帖">${escapeHtml((g.post_content || '（图片/文件动态）').slice(0, 80))}${(g.post_content || '').length > 80 ? '…' : ''}</a>`
            : '<span class="report-gone">⚠️ 原帖已被删除</span>'}
          ${g.post_author_nickname ? `<span class="report-author">作者：${escapeHtml(g.post_author_nickname)}</span>` : ''}
        </div>
        ${g.reports.map(r => `
          <div class="report-line">
            <span class="report-who">🚩 ${escapeHtml(r.reporter_nickname)}（${escapeHtml(r.reporter_username)}）</span>
            <span class="report-reason">${r.reason ? '原因：' + escapeHtml(r.reason) : '未填写原因'}</span>
            <span class="report-time">${formatTime(r.created_at)}</span>
          </div>`).join('')}
        <div class="report-actions">
          ${g.post_exists
            ? `<button class="danger" onclick="resolveReport(${g.post_id}, 'delete')">🗑 删除帖子并结案</button>`
            : ''}
          <button onclick="resolveReport(${g.post_id}, 'keep')">✅ 没有问题，忽略举报</button>
        </div>
      </div>`).join('')}` : ''}
    ${apps.length ? `<p>📋 待审批申请 (${apps.length})</p>
      ${apps.map(a => `<div class="user-item"><span>${a.nickname} (${a.username})</span>
        <div><button onclick="approveAdmin(${a.id})">批准</button></div></div>`).join('')}` : ''}
    <p style="margin-top:12px">📂 分区管理（新增 / 删除模块）</p>
    <div class="section-admin-add">
      <input id="new-section-name" placeholder="新分区名称，最多12字" maxlength="12"
        onkeydown="if(event.key==='Enter')addSection()">
      <button onclick="addSection()">＋ 添加</button>
    </div>
    ${sections.length ? sections.map(s => `
      <div class="user-item section-admin-item">
        <span>${escapeHtml(s.name)}</span>
        <button class="danger" onclick="deleteSection(${s.id})">删除</button>
      </div>`).join('') : '<p style="font-size:13px;color:var(--text-secondary)">暂无分区</p>'}
    <p style="margin-top:10px">👥 用户列表</p>
    ${users.map(u => {
      const status = u.role === 'admin' ? '<span class="role-badge admin">超级管理员</span>'
        : u.admin_status === 'approved' ? '<span class="role-badge admin">管理员</span>'
        : u.admin_status === 'pending' ? '<span class="role-badge">申请中</span>'
        : '<span class="role-badge">普通用户</span>';
      return `<div class="user-item"><span>${u.nickname} (${u.username}) ${status}</span>
        <div class="user-item-actions">
          <button onclick="resetUserPassword(${u.id}, '${escapeHtml(u.nickname || u.username).replace(/'/g, "\\'")}')">🔑 重置密码</button>
          ${u.admin_status === 'approved' ? `<button class="danger" onclick="revokeAdmin(${u.id})">撤销</button>` : ''}
        </div>
      </div>`;
    }).join('')}`;

  const old = document.getElementById('admin-panel');
  if (old) old.remove();
  container.insertBefore(panel, container.firstChild);
}

async function approveAdmin(id) {
  await fetch(`/api/admin/users/${id}/approve`, { method: 'POST' });
  renderAdminPanel();
}

// ===== 分区增删 =====
async function addSection() {
  const input = document.getElementById('new-section-name');
  const name = input.value.trim();
  if (!name) return;
  const res = await fetch('/api/sections', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name })
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) return alert(d.error || '添加失败');
  await loadSections();
  renderAdminPanel();
}

async function deleteSection(id) {
  if (!confirm('确定删除该分区？分区内的帖子会变为"未分类"，帖子本身不会被删除')) return;
  const res = await fetch('/api/sections/' + id, { method: 'DELETE' });
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    return alert(d.error || '删除失败');
  }
  await loadSections();
  renderAdminPanel();
}

async function revokeAdmin(id) {
  if (!confirm('确定撤销该用户的管理员权限？')) return;
  await fetch(`/api/admin/users/${id}/revoke`, { method: 'POST' });
  renderAdminPanel();
}

// 下载数据库备份（浏览器会弹出保存文件对话框）
function downloadBackup() {
  window.location.href = '/api/admin/backup';
}

// ===== 自动备份管理 =====
function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(2) + ' MB';
}

// 立即手动备份
async function doManualBackup() {
  const res = await fetch('/api/admin/backups', { method: 'POST' });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) return alert(d.error || '备份失败');
  alert('备份成功：' + d.name);
  renderAdminPanel();
}

// 下载某个备份文件
function downloadBackupFile(name) {
  window.location.href = '/api/admin/backups/' + encodeURIComponent(name) + '/download';
}

// 删除某个备份文件
async function deleteBackupFile(name) {
  if (!confirm('确定删除备份「' + name + '」？删除后无法恢复')) return;
  const res = await fetch('/api/admin/backups/' + encodeURIComponent(name), { method: 'DELETE' });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) return alert(d.error || '删除失败');
  renderAdminPanel();
}

// 管理员帮同学重置密码（同学忘记密码时）
async function resetUserPassword(id, name) {
  const pwd = prompt('给「' + name + '」设置新密码（6-32 位），告诉 TA 用新密码登录：', '123456');
  if (pwd === null) return;
  if (pwd.length < 6 || pwd.length > 32) return alert('密码长度需为 6-32 位');
  const res = await fetch(`/api/admin/users/${id}/reset-password`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ newPassword: pwd })
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) return alert(d.error || '重置失败');
  alert('已把「' + name + '」的密码重置为：' + pwd);
}

// 处理举报：delete=删帖结案；keep=忽略举报
async function resolveReport(pid, action) {
  const tip = action === 'delete' ? '确定删除这条动态并结案吗？相关评论和文件会一并删除。' : '确定忽略这条举报吗？（举报记录将标记为已处理）';
  if (!confirm(tip)) return;
  const res = await fetch(`/api/admin/reports/post/${pid}/resolve`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action })
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) return alert(d.error || '操作失败');
  await renderAdminPanel();
  if (action === 'delete') loadPosts();
}

// ===== 修改自己的密码 =====
function showPasswordModal() {
  if (!currentUser) return;
  ['pwd-old', 'pwd-new', 'pwd-confirm'].forEach(id => { document.getElementById(id).value = ''; });
  document.getElementById('password-modal').classList.remove('hidden');
  setTimeout(() => document.getElementById('pwd-old').focus(), 50);
}

async function submitChangePassword() {
  const oldPassword = document.getElementById('pwd-old').value;
  const newPassword = document.getElementById('pwd-new').value;
  const confirmPwd = document.getElementById('pwd-confirm').value;
  if (!oldPassword) return alert('请输入原密码');
  if (newPassword.length < 6 || newPassword.length > 32) return alert('新密码长度需为 6-32 位');
  if (newPassword !== confirmPwd) return alert('两次输入的新密码不一致');
  const res = await fetch('/api/account/password', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ oldPassword, newPassword })
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) return alert(d.error || '修改失败');
  closeModal('password-modal');
  alert('密码修改成功，下次登录请使用新密码');
}

// ===== 工具 =====
function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s == null ? '' : String(s);
  return d.innerHTML;
}

// 转义后把 @昵称 高亮、#话题# 变成可点击链接
function linkMentions(text) {
  return escapeHtml(text)
    .replace(/@([^\s@，。,.!?！？]{1,20})/g, '<span class="mention-text">@$1</span>')
    .replace(/#([^#\s#，。,.!?！？]{1,20})#/g,
      (m, tag) => `<span class="topic-text" onclick="showTopic(${JSON.stringify(tag)})">#${tag}#</span>`);
}

// 等级头衔（与 server.js 的 LEVELS 保持一致）
const LEVELS = [
  { min: 0,    icon: '🌱', name: '萌新同学' },
  { min: 30,   icon: '☀️', name: '活跃分子' },
  { min: 100,  icon: '💬', name: '水群之王' },
  { min: 250,  icon: '🌟', name: '人气之星' },
  { min: 500,  icon: '📚', name: '班级卷王' },
  { min: 1000, icon: '👑', name: '班级传说' }
];
function levelOf(p) {
  let lv = LEVELS[0];
  for (const l of LEVELS) if ((p || 0) >= l.min) lv = l;
  return lv;
}
function levelBadge(points) {
  const lv = levelOf(points);
  return `<span class="level-badge" title="积分 ${points || 0}">${lv.icon} ${lv.name}</span>`;
}

function toLocalDate(t) {
  const d = new Date(String(t).replace(' ', 'T') + 'Z');
  return isNaN(d) ? null : d;
}

function formatDate(t) {
  const d = toLocalDate(t);
  if (!d) return t || '';
  return `${d.getFullYear()}.${d.getMonth() + 1}.${d.getDate()}`;
}

function formatTime(t) {
  const d = toLocalDate(t);
  if (!d) return t || '';
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}.${d.getMonth() + 1}.${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ===== 图片查看器（滚轮缩放、拖动移动、右上角❌关闭） =====
const viewerEl = document.getElementById('image-viewer');
const viewerImg = document.getElementById('image-viewer-img');
let viewScale = 1, viewX = 0, viewY = 0, imgDragging = false, dragStartX = 0, dragStartY = 0;

function applyView() {
  viewerImg.style.transform = `translate(${viewX}px, ${viewY}px) scale(${viewScale})`;
}

function showImage(src) {
  viewScale = 1; viewX = 0; viewY = 0;
  applyView();
  viewerImg.src = src;
  viewerEl.classList.remove('hidden');
}

function closeImageViewer() {
  viewerEl.classList.add('hidden');
  viewerImg.src = '';
}

viewerEl.addEventListener('wheel', e => {
  e.preventDefault();
  viewScale *= (e.deltaY < 0 ? 1.15 : 1 / 1.15);
  viewScale = Math.min(Math.max(viewScale, 0.2), 10);
  applyView();
}, { passive: false });

viewerImg.addEventListener('mousedown', e => {
  e.preventDefault();
  imgDragging = true;
  dragStartX = e.clientX - viewX;
  dragStartY = e.clientY - viewY;
  viewerImg.classList.add('dragging');
});
document.addEventListener('mousemove', e => {
  if (!imgDragging) return;
  viewX = e.clientX - dragStartX;
  viewY = e.clientY - dragStartY;
  applyView();
});
document.addEventListener('mouseup', () => {
  imgDragging = false;
  viewerImg.classList.remove('dragging');
});
viewerImg.addEventListener('dragstart', e => e.preventDefault());

// ===== 同学列表 / 私信 / 群聊 =====
let usersCache = [];          // 同学列表缓存
let currentChatId = 0;        // 当前打开的会话 id
let chatPollTimer = null;     // 聊天轮询计时器
let lastMsgId = 0;            // 当前会话已加载的最大消息 id（用于增量轮询）
let chatReceipts = [];        // 当前会话各成员的最后已读时间（已读回执）
let chatIsGroup = false;      // 当前会话是不是群聊
let chatMembers = [];         // 当前会话成员（@自动补全用）
let mentionCands = [];        // @弹出菜单当前候选
let mentionIdx = 0;           // @菜单高亮项

// ===== 三个主页面：feed=班级动态，msg=信息通讯，tools=工具分享，可自由来回切换 =====
let currentMainPage = 'feed';

// 只做主页面级别的显隐，页面内部打开的内容（个人主页/聊天界面等）原样保留
function switchMainPage(page) {
  if (page !== 'feed' && page !== 'msg' && page !== 'tools' && page !== 'study') return;
  currentMainPage = page;
  document.getElementById('page-feed').classList.toggle('hidden', page !== 'feed');
  document.getElementById('page-msg').classList.toggle('hidden', page !== 'msg');
  document.getElementById('page-tools').classList.toggle('hidden', page !== 'tools');
  document.getElementById('page-study').classList.toggle('hidden', page !== 'study');
  document.getElementById('tab-feed').classList.toggle('active', page === 'feed');
  document.getElementById('tab-msg').classList.toggle('active', page === 'msg');
  document.getElementById('tab-tools').classList.toggle('active', page === 'tools');
  document.getElementById('tab-study').classList.toggle('active', page === 'study');
  if (page !== 'msg') {
    // 离开信息通讯页：暂停聊天轮询，切回来时自动恢复
    if (chatPollTimer) { clearInterval(chatPollTimer); chatPollTimer = null; }
  } else if (currentChatId && !document.getElementById('chat-view').classList.contains('hidden')) {
    // 回到信息通讯页时若正开着某个聊天，恢复实时轮询
    if (!chatPollTimer) chatPollTimer = setInterval(pollChatMessages, 4000);
  }
  window.scrollTo(0, 0);
}

// 点"信息通讯"大标签：已经开着聊天就留在聊天，否则展示会话列表
function openMsgTab() {
  if (!currentUser) return alert('请先登录');
  switchMainPage('msg');
  const inChat = currentChatId && !document.getElementById('chat-view').classList.contains('hidden');
  const inUsers = !document.getElementById('users-view').classList.contains('hidden');
  if (!inChat && !inUsers) showConversations();
}

// ===== 主页面三：工具分享 =====
let toolCats = [];          // 工具分类缓存
let currentToolCat = 0;     // 当前筛选分类（0=全部）

// 按域名猜一个图标（纯本地，不请求外网）
function toolIcon(host) {
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
}

async function openToolsTab() {
  switchMainPage('tools');
  const root = document.getElementById('page-tools');
  root.innerHTML = '<div class="card">加载中...</div>';
  try {
    const [cats] = await Promise.all([
      fetch('/api/tool-categories').then(r => r.json())
    ]);
    toolCats = Array.isArray(cats) ? cats : [];
  } catch (e) { /* 分类加载失败也不影响看列表 */ }
  await renderToolsPage();
}

async function renderToolsPage() {
  const root = document.getElementById('page-tools');
  const admin = isAdminUser(currentUser);
  const q = currentToolCat ? '?category_id=' + currentToolCat + '&' : '?';
  let tools = [];
  try {
    tools = await fetch('/api/tools' + q + 'device_id=' + encodeURIComponent(getDeviceId())).then(r => r.json());
  } catch (e) {
    root.innerHTML = '<div class="card">加载失败，请重试</div>';
    return;
  }
  if (!Array.isArray(tools)) tools = [];

  // 分类筛选条（管理员可增删）
  const chips = [`<button class="tool-chip ${currentToolCat === 0 ? 'active' : ''}" onclick="setToolCat(0)">全部</button>`]
    .concat(toolCats.map(c =>
      `<span class="tool-chip-wrap ${currentToolCat === c.id ? 'active' : ''}">
         <button class="tool-chip" onclick="setToolCat(${c.id})">${escapeHtml(c.name)}</button>
         ${admin ? `<button class="tool-chip-del" title="删除分类（工具变为未分类）" onclick="deleteToolCategory(${c.id})">✕</button>` : ''}
       </span>`)).join('');

  // 上传表单（仅登录用户；游客提示登录）
  const catOptions = '<option value="0">未分类</option>' +
    toolCats.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
  const uploadCard = currentUser ? `
    <div class="card tool-upload-card">
      <h3>🧰 分享一个好用的工具网站</h3>
      <div class="tool-form-row">
        <input id="tool-url" placeholder="网址，如 example.com（必填）" maxlength="300">
      </div>
      <div class="tool-form-row">
        <input id="tool-title" placeholder="名称（不填就自动用网址域名）" maxlength="50">
      </div>
      <div class="tool-form-row">
        <textarea id="tool-desc" rows="2" placeholder="一句话简介：这个网站能干嘛、怎么用（必填）" maxlength="500"></textarea>
      </div>
      <div class="tool-form-row tool-form-bottom">
        <select id="tool-cat">${catOptions}</select>
        <button class="primary-btn" onclick="submitTool()">提交分享</button>
      </div>
    </div>` : `
    <div class="card tool-guest-tip">👀 你正在以游客身份浏览，可以打开链接和点赞；<b>登录后</b>就能分享工具网站。
      <button onclick="showLogin()">去登录</button>
    </div>`;

  // 管理员新增分类
  const adminCatRow = admin ? `
    <div class="tool-cat-admin">
      <input id="new-tool-cat" placeholder="新分类名称，最多12字" maxlength="12"
        onkeydown="if(event.key==='Enter')addToolCategory()">
      <button onclick="addToolCategory()">＋ 新建分类</button>
    </div>` : '';

  root.innerHTML = `
    <div class="tool-chips-row">${chips}</div>
    ${adminCatRow}
    ${uploadCard}
    <div id="tools-list">
      ${tools.length ? tools.map(renderToolCard).join('')
        : '<div class="card empty-state">🧰 这里还空空的，快来分享第一个工具网站吧～</div>'}
    </div>`;
}

function renderToolCard(t) {
  const admin = isAdminUser(currentUser);
  // 站内工具页（/ 开头的相对路径，如 /tools/random-number.html）：当前窗口打开；
  // 外部网站：新标签打开。站内工具的"域名"显示为"班级自制"
  const isLocal = t.url.startsWith('/');
  let host = '';
  if (isLocal) {
    host = '班级自制';
  } else {
    try { host = new URL(t.url).hostname.replace(/^www\./, ''); } catch (e) { host = t.url; }
  }
  const name = t.nickname || t.username || '同学';
  const canDelete = currentUser && (currentUser.id === t.user_id || admin);
  const catBadge = t.category_name ? `<span class="tool-cat-badge">📂 ${escapeHtml(t.category_name)}</span>` : '';
  const linkTarget = ' target="_blank" rel="noopener noreferrer"';
  const linkTag = isLocal ? 'tool-local-link' : '';
  // 管理员：调整分类的下拉框
  const catSelect = admin ? `
    <select class="tool-move-select" title="移动到分类" onchange="moveToolCategory(${t.id}, this.value)">
      <option value="0" ${!t.category_id ? 'selected' : ''}>📂 未分类</option>
      ${toolCats.map(c => `<option value="${c.id}" ${t.category_id === c.id ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('')}
    </select>` : '';
  return `
    <div class="card tool-card" data-id="${t.id}">
      <div class="tool-card-main">
        <span class="tool-icon">${isLocal ? '🧰' : toolIcon(host)}</span>
        <div class="tool-info">
          <a class="tool-title ${linkTag}" href="${escapeHtml(t.url)}"${linkTarget}>
            ${escapeHtml(t.title)} <span class="tool-open-ico">↗</span>
          </a>
          <div class="tool-host">${escapeHtml(host)}</div>
          <div class="tool-desc">${escapeHtml(t.description)}</div>
          <div class="tool-meta">
            ${avatarHtml({ id: t.user_id, name, avatar: t.avatar }, 'avatar-xs')}
            <span class="tool-who" ${t.user_id ? `onclick="viewProfile(${t.user_id})"` : ''}>${escapeHtml(name)}</span>
            <span>· ${formatDate(t.created_at)} 分享</span>
            ${catBadge}
          </div>
        </div>
      </div>
      <div class="tool-actions">
        <button class="tool-like-btn ${t.liked ? 'active' : ''}" onclick="toggleToolLike(${t.id}, this)">
          ❤️ <span class="tool-like-count">${t.like_count}</span>
        </button>
        <a class="tool-open-btn" href="${escapeHtml(t.url)}"${linkTarget}>${isLocal ? '打开工具 ↗' : '打开网站 ↗'}</a>
        ${catSelect}
        ${canDelete ? `<button class="danger" onclick="deleteTool(${t.id})">🗑 删除</button>` : ''}
      </div>
    </div>`;
}

function setToolCat(id) {
  currentToolCat = parseInt(id, 10) || 0;
  renderToolsPage();
}

async function submitTool() {
  const url = document.getElementById('tool-url').value.trim();
  const title = document.getElementById('tool-title').value.trim();
  const description = document.getElementById('tool-desc').value.trim();
  const category_id = parseInt(document.getElementById('tool-cat').value, 10) || 0;
  if (!url) return alert('请填写工具网址');
  if (!description) return alert('请写一句简介');
  const res = await fetch('/api/tools', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, title, description, category_id })
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) return alert(d.error || '提交失败');
  await renderToolsPage();
}

async function toggleToolLike(id, btn) {
  const res = await fetch(`/api/tools/${id}/like`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_id: getDeviceId() })
  });
  const d = await res.json().catch(() => ({}));
  if (res.status === 409) { btn.classList.add('active'); return alert(d.error || '已经赞过了'); }
  if (!res.ok) return alert(d.error || '操作失败');
  btn.querySelector('.tool-like-count').textContent = d.likeCount;
  if (d.liked) { btn.classList.add('active'); likeBurst(btn); }
  else btn.classList.remove('active');
}

async function deleteTool(id) {
  if (!confirm('确定删除这个工具分享吗？')) return;
  const res = await fetch('/api/tools/' + id, { method: 'DELETE' });
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    return alert(d.error || '删除失败');
  }
  renderToolsPage();
}

async function moveToolCategory(id, cid) {
  const res = await fetch(`/api/tools/${id}/category`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ category_id: parseInt(cid, 10) || 0 })
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) return alert(d.error || '移动失败');
  renderToolsPage();
}

async function addToolCategory() {
  const inp = document.getElementById('new-tool-cat');
  const name = inp.value.trim();
  if (!name) return;
  const res = await fetch('/api/admin/tool-categories', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name })
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) return alert(d.error || '新建失败');
  inp.value = '';
  await openToolsTab();
}

async function deleteToolCategory(id) {
  if (!confirm('删除这个分类？分类里的工具会变成"未分类"，不会被删除。')) return;
  const res = await fetch('/api/admin/tool-categories/' + id, { method: 'DELETE' });
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    return alert(d.error || '删除失败');
  }
  if (currentToolCat === id) currentToolCat = 0;
  await openToolsTab();
}

// 切换视图：隐藏页面内部子视图，显示其中一个
function switchView(name) {
  ['profile-view', 'users-view', 'conversations-view', 'chat-view'].forEach(id => {
    document.getElementById(id).classList.add('hidden');
  });
  if (name) document.getElementById(name).classList.remove('hidden');
  // 进入非动态列表视图时隐藏分区标签栏，避免视觉混乱
  const tabs = document.getElementById('section-tabs');
  if (tabs) tabs.style.display = name ? 'none' : '';
  // 非动态列表视图也隐藏首页热门榜
  const hbar = document.getElementById('hot-week-bar');
  if (hbar) hbar.classList.toggle('hidden', name ? true : !hasHotWeek);
}

// —— 同学列表 ——
async function showUsers() {
  if (!currentUser) return alert('请先登录');
  switchMainPage('msg');
  switchView('users-view');
  const v = document.getElementById('users-view');
  v.innerHTML = '<div class="card">加载中...</div>';
  try {
    usersCache = await fetch('/api/users').then(r => r.json());
  } catch (e) { v.innerHTML = '<div class="card">加载失败</div>'; return; }
  if (!usersCache.length) { v.innerHTML = '<div class="card">暂无其他同学</div>'; return; }
  const cards = usersCache.map(u => {
    const name = u.nickname || u.username;
    const initials = (u.avatar && u.avatar.startsWith('emoji:')) ? u.avatar.slice(6) : (name[0] || '?');
    const avHtml = u.avatar && u.avatar.startsWith('/uploads/')
      ? `<img class="user-card-avatar" src="${escapeHtml(u.avatar)}" alt="">`
      : `<span class="user-card-avatar" style="background:${userColor(name)}">${escapeHtml(initials)}</span>`;
    const onlineDot = u.online ? '<span class="online-dot"></span>' : '<span class="offline-dot"></span>';
    return `
      <div class="user-card">
        <div class="user-avatar-wrap" onclick="viewProfile(${u.id})">
          ${avHtml}
          ${onlineDot}
        </div>
        <div class="user-info">
          <div class="user-name" onclick="viewProfile(${u.id})">${escapeHtml(name)}</div>
          <div class="user-meta">📝 ${u.post_count || 0} 帖 · ❤️ ${u.like_received || 0} 赞</div>
          <div class="user-meta">加入于 ${formatDate(u.created_at)}</div>
        </div>
        ${u.id === currentUser.id ? '' : `<button class="msg-start-btn" onclick="startDirectChat(${u.id})">💬 私信</button>`}
      </div>`;
  }).join('');
  v.innerHTML = `
    <div class="card context-card">
      <div class="context-card-head">
        <h2>👥 同学（共 ${usersCache.length} 人）</h2>
        <div class="context-card-actions">
          <button class="primary-btn" onclick="showCreateGroupModal()">➕ 创建群聊</button>
          <button onclick="showConversations()">💬 返回消息</button>
        </div>
      </div>
      <div class="users-grid">${cards}</div>
    </div>`;
}

// —— 私信会话列表 ——
async function showConversations() {
  if (!currentUser) return alert('请先登录');
  switchMainPage('msg');
  switchView('conversations-view');
  // 回到会话列表 = 离开当前聊天：停掉该聊天的实时轮询
  if (chatPollTimer) { clearInterval(chatPollTimer); chatPollTimer = null; }
  currentChatId = 0;
  const v = document.getElementById('conversations-view');
  v.innerHTML = '<div class="card">加载中...</div>';
  let convs;
  try {
    convs = await fetch('/api/conversations').then(r => r.json());
  } catch (e) { v.innerHTML = '<div class="card">加载失败</div>'; return; }
  if (!convs.length) {
    v.innerHTML = `
      <div class="card context-card">
        <button class="back-btn" onclick="goHome()">← 返回</button>
        <h2>💬 私信</h2>
        <p class="empty-tip">还没有任何会话，去 <a href="javascript:void(0)" onclick="showUsers()">同学列表</a> 发起私聊吧～</p>
      </div>`;
    return;
  }
  const items = convs.map(c => {
    const isGroup = c.type === 'group';
    const avHtml = isGroup
      ? `<span class="conv-avatar group-avatar">👥</span>`
      : (c.avatar && c.avatar.startsWith('/uploads/')
          ? `<img class="conv-avatar" src="${escapeHtml(c.avatar)}" alt="">`
          : `<span class="conv-avatar" style="background:${userColor(c.name)}">${escapeHtml((c.name || '?')[0])}</span>`);
    const onlineDot = (!isGroup && c.peer_online) ? '<span class="online-dot"></span>' : '';
    let preview = '(暂无消息)';
    if (c.last_message) {
      const sender = c.last_message.sender_id === currentUser.id ? '我: ' : '';
      preview = sender + (c.last_message.type === 'image' ? '[图片]'
        : c.last_message.type === 'file' ? '[文件]' + escapeHtml(chatFileName(c.last_message.content)).slice(0, 20)
        : escapeHtml(c.last_message.content).slice(0, 30));
    }
    const unread = c.unread > 0 ? `<span class="conv-unread">${c.unread}</span>` : '';
    return `
      <div class="conv-item" onclick="openChat(${c.id})">
        <div class="conv-avatar-wrap">${avHtml}${onlineDot}</div>
        <div class="conv-body">
          <div class="conv-top"><span class="conv-name">${escapeHtml(c.name)}</span>
            <span class="conv-time">${c.last_message ? formatDate(c.last_message.created_at) : ''}</span></div>
          <div class="conv-preview">${preview}</div>
        </div>
        ${unread}
      </div>`;
  }).join('');
  v.innerHTML = `
    <div class="card context-card">
      <button class="back-btn" onclick="goHome()">← 返回</button>
      <h2>💬 私信</h2>
      <div class="conv-list">${items}</div>
    </div>`;
}

// —— 聊天界面 ——
async function startDirectChat(targetUid) {
  if (!currentUser) return alert('请先登录');
  const res = await fetch('/api/conversations/direct/' + targetUid, { method: 'POST' });
  const d = await res.json();
  if (!res.ok) return alert(d.error || '创建会话失败');
  openChat(d.id);
}

async function openChat(convId) {
  switchMainPage('msg');
  switchView('chat-view');
  currentChatId = convId;
  lastMsgId = 0;
  const v = document.getElementById('chat-view');
  v.innerHTML = '<div class="card">加载中...</div>';
  // 拉取会话详情、消息和已读回执
  let detail, msgs, receipts;
  try {
    [detail, msgs, receipts] = await Promise.all([
      fetch('/api/conversations/' + convId).then(r => r.json()),
      fetch('/api/conversations/' + convId + '/messages').then(r => r.json()),
      fetch('/api/conversations/' + convId + '/receipts').then(r => r.json()).catch(() => [])
    ]);
  } catch (e) { v.innerHTML = '<div class="card">加载失败</div>'; return; }
  if (detail.error) { v.innerHTML = `<div class="card">${escapeHtml(detail.error)}</div>`; return; }
  chatReceipts = Array.isArray(receipts) ? receipts : [];
  chatIsGroup = detail.type === 'group';
  // 标记已读
  fetch('/api/conversations/' + convId + '/read', { method: 'POST' }).then(refreshMsgBadge);
  const isGroup = chatIsGroup;
  chatMembers = Array.isArray(detail.members) ? detail.members : [];
  // 私聊标题用对方昵称；群聊用群名
  const peer = !isGroup ? detail.members.find(m => m.id !== currentUser.id) : null;
  const titleName = isGroup ? (detail.name || '群聊') : (peer ? (peer.nickname || peer.username) : '私聊');
  // 渲染消息
  msgs.forEach(m => { if (m.id > lastMsgId) lastMsgId = m.id; });
  v.innerHTML = `
    <div class="chat-container">
      <div class="chat-header">
        <button class="back-btn" onclick="showConversations()">←</button>
        <div class="chat-title">
          <span>${isGroup ? '👥 ' : '💬 '}${escapeHtml(titleName)}</span>
          ${isGroup ? `<span class="chat-sub">(${detail.members.length} 人)</span>` : ''}
        </div>
        ${isGroup ? `<button class="icon-btn-sm" onclick="showGroupSettings(${convId})" title="群设置">☰</button>` : ''}
      </div>
      <div class="chat-messages" id="chat-messages">${renderMessages(msgs, detail)}</div>
      <div id="chat-mention-box" class="mention-popup hidden"></div>
      <div class="chat-input-bar">
        <label class="chat-img-btn" title="发送图片">
          📷<input type="file" id="chat-image-input" accept="image/*" hidden>
        </label>
        <label class="chat-file-btn" title="发送文件（最大 100MB）">
          📎<input type="file" id="chat-file-input" hidden>
        </label>
        <button type="button" class="emoji-btn" title="插入表情" onclick="event.stopPropagation();toggleEmojiPicker('chat-text-input', this)">😀</button>
        <input type="text" id="chat-text-input" placeholder="输入消息...（群里输入 @ 可点名同学）" maxlength="2000"
          oninput="onChatMentionInput()" onkeydown="handleChatKeydown(event)">
        <button class="primary-btn" onclick="sendChatText()">发送</button>
      </div>
    </div>`;
  // 滚到底
  const msgsBox = document.getElementById('chat-messages');
  msgsBox.scrollTop = msgsBox.scrollHeight;
  updateReceipts();
  // 图片输入
  document.getElementById('chat-image-input').addEventListener('change', sendChatImage);
  // 文件输入
  document.getElementById('chat-file-input').addEventListener('change', sendChatFile);
  // 启动轮询
  if (chatPollTimer) clearInterval(chatPollTimer);
  chatPollTimer = setInterval(pollChatMessages, 4000);
}

// created_at 是 UTC 时间字符串，转成本地时间对象
function msgDate(t) { return new Date(String(t).replace(' ', 'T') + 'Z'); }

function renderMessages(msgs, detail) {
  if (!msgs.length) return '<div class="chat-empty">还没有消息，发送第一条吧～</div>';
  return msgs.map(m => {
    const mine = m.sender_id === currentUser.id;
    const senderName = mine ? '我' : (m.sender_nickname || m.sender_id);
    const initials = (m.sender_avatar && m.sender_avatar.startsWith('emoji:'))
      ? m.sender_avatar.slice(6)
      : (senderName[0] || '?');
    const avHtml = (m.sender_avatar && m.sender_avatar.startsWith('/uploads/'))
      ? `<img class="msg-avatar" src="${escapeHtml(m.sender_avatar)}" alt="">`
      : `<span class="msg-avatar" style="background:${userColor(senderName)}">${escapeHtml(initials)}</span>`;
    // 已撤回：只显示一条灰色提示，不显示原内容
    let content;
    if (m.recalled) {
      content = `<div class="msg-recalled">${mine ? '你撤回了一条消息' : escapeHtml(senderName) + ' 撤回了一条消息'}</div>`;
    } else if (m.type === 'image') {
      content = `<img class="msg-image" src="${escapeHtml(m.content)}" alt="图片" onclick="showImage('${m.content}')">`;
    } else if (m.type === 'file') {
      content = renderFileMsg(m.content);
    } else {
      content = `<div class="msg-text">${linkMentions(m.content)}</div>`;
    }
    // 自己发的、2 分钟内、未撤回：显示撤回按钮
    const canRecall = mine && !m.recalled && (Date.now() - msgDate(m.created_at).getTime() < 2 * 60 * 1000);
    return `
      <div class="msg-row ${mine ? 'mine' : ''}" data-mid="${m.id}" data-ts="${m.recalled ? 0 : msgDate(m.created_at).getTime()}">
        ${mine ? '' : avHtml}
        <div class="msg-bubble-wrap">
          ${mine ? '' : `<div class="msg-sender">${escapeHtml(senderName)}</div>`}
          ${content}
          <div class="msg-time">${formatTime(m.created_at)}
            ${canRecall ? `<button class="msg-recall-btn" onclick="recallMessage(${m.id})">撤回</button>` : ''}
            ${mine && !m.recalled ? '<span class="msg-receipt"></span>' : ''}
          </div>
        </div>
        ${mine ? avHtml : ''}
      </div>`;
  }).join('');
}

// 文件大小转可读文字
function formatBytes(n) {
  n = Number(n) || 0;
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

// 按扩展名选文件图标
function fileIcon(ext) {
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'heic'].includes(ext)) return '🖼️';
  if (['mp4', 'mov', 'avi', 'mkv', 'webm'].includes(ext)) return '🎬';
  if (['mp3', 'wav', 'flac', 'm4a'].includes(ext)) return '🎵';
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) return '🗜️';
  if (ext === 'pdf') return '📕';
  if (['doc', 'docx'].includes(ext)) return '📘';
  if (['xls', 'xlsx', 'csv'].includes(ext)) return '📗';
  if (['ppt', 'pptx'].includes(ext)) return '📙';
  if (['txt', 'md'].includes(ext)) return '📝';
  return '📄';
}

// 渲染文件消息：可点击下载的文件卡片（content 是 JSON：url/name/size）
function renderFileMsg(raw) {
  let meta;
  try { meta = JSON.parse(raw); } catch (e) { meta = null; }
  if (!meta || !meta.url) return `<div class="msg-text">${escapeHtml(String(raw))}</div>`;
  const ext = (String(meta.name).split('.').pop() || '').toLowerCase().slice(0, 8);
  return `<a class="msg-file" href="${escapeHtml(meta.url)}" target="_blank" rel="noopener"
      download="${escapeHtml(meta.name)}">
      <span class="file-icon">${fileIcon(ext)}</span>
      <span class="file-meta">
        <span class="file-name">${escapeHtml(meta.name)}</span>
        <span class="file-size">${formatBytes(meta.size)}</span>
      </span>
      <span class="file-download">⬇️</span>
    </a>`;
}

// 从文件消息的 JSON content 里取原始文件名（会话列表预览用）
function chatFileName(raw) {
  try { return JSON.parse(raw).name || ''; } catch (e) { return ''; }
}

// 根据各成员最后已读时间，给自己发的消息打"已读/未读"标记
function updateReceipts() {
  if (!chatReceipts || !chatReceipts.length) return;
  const others = chatReceipts.filter(r => r.id !== currentUser.id);
  if (!others.length) return;
  document.querySelectorAll('.msg-row.mine').forEach(row => {
    const ts = Number(row.dataset.ts);
    if (!ts) return;  // 已撤回消息 ts=0，不显示回执
    const span = row.querySelector('.msg-receipt');
    if (!span) return;
    const readOnes = others.filter(r => msgDate(r.last_read_at).getTime() >= ts);
    if (chatIsGroup) {
      const total = others.length, n = readOnes.length;
      span.textContent = n > 0 ? `👁 ${n}/${total} 已读` : `👁 ${total} 人未读`;
      span.className = 'msg-receipt ' + (n === total ? 'msg-read' : (n > 0 ? 'msg-partial' : 'msg-unread'));
      const nameOf = r => r.nickname || r.username;
      const unread = others.filter(r => !readOnes.includes(r));
      span.title = '已读：' + (readOnes.map(nameOf).join('、') || '无')
        + '\n未读：' + (unread.map(nameOf).join('、') || '无');
    } else {
      if (readOnes.length) { span.textContent = '已读'; span.className = 'msg-receipt msg-read'; }
      else { span.textContent = '未读'; span.className = 'msg-receipt msg-unread'; }
    }
  });
}

// 撤回一条消息（发送后 2 分钟内）
async function recallMessage(mid) {
  if (!currentChatId) return;
  if (!confirm('确定撤回这条消息吗？')) return;
  const res = await fetch(`/api/conversations/${currentChatId}/messages/${mid}/recall`, { method: 'POST' });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) return alert(d.error || '撤回失败');
  markRecalledDom(mid);
}

// 把屏幕上某条消息就地变成"已撤回"提示（自己撤回 / 轮询发现别人撤回都走这里）
function markRecalledDom(mid) {
  const row = document.querySelector(`.msg-row[data-mid="${mid}"]`);
  if (!row) return;
  const wrap = row.querySelector('.msg-bubble-wrap');
  if (!wrap || wrap.querySelector('.msg-recalled')) return;
  const mine = row.classList.contains('mine');
  const senderEl = wrap.querySelector('.msg-sender');
  const who = mine ? '你' : (senderEl ? senderEl.textContent : 'TA');
  wrap.innerHTML = `<div class="msg-recalled">${escapeHtml(who)} 撤回了一条消息</div>`;
}

// 同步最近消息的撤回状态（别人撤回时，4 秒轮询会在这里反映出来）
async function syncChatState() {
  if (!currentChatId) return;
  let rows;
  try {
    rows = await fetch('/api/conversations/' + currentChatId + '/messages-sync').then(r => r.json());
  } catch (e) { return; }
  if (!Array.isArray(rows)) return;
  rows.forEach(r => { if (r.recalled) markRecalledDom(r.id); });
  // 撤回有 2 分钟时限：停留在聊天页超过 2 分钟时，把过期的撤回按钮收起来
  document.querySelectorAll('.msg-recall-btn').forEach(btn => {
    const row = btn.closest('.msg-row');
    const ts = row && Number(row.dataset.ts);
    if (ts && Date.now() - ts > 2 * 60 * 1000) btn.remove();
  });
}

async function sendChatText() {
  const inp = document.getElementById('chat-text-input');
  if (!inp) return;
  const content = inp.value.trim();
  if (!content) return;
  inp.value = '';
  const box = document.getElementById('chat-mention-box');
  if (box) box.classList.add('hidden');
  const res = await fetch('/api/conversations/' + currentChatId + '/messages', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content })
  });
  const d = await res.json();
  if (!res.ok) return alert(d.error || '发送失败');
  // 立即追加到界面
  appendMessage(d);
  pollNotifications();  // 顺带刷新通知（自己 @ 了别人时不会通知自己，主要是保持状态一致）
}

// ===== 群聊 @ 同学：输入 @ 弹出成员菜单，点击/回车插入 =====
function onChatMentionInput() {
  const inp = document.getElementById('chat-text-input');
  const box = document.getElementById('chat-mention-box');
  if (!inp || !box) return;
  const before = inp.value.slice(0, inp.selectionStart || 0);
  const m = before.match(/(?:^|\s)@([一-龥A-Za-z0-9_]{0,19})$/);
  if (!m) { box.classList.add('hidden'); return; }
  const kw = m[1].toLowerCase();
  mentionCands = chatMembers
    .filter(u => u.id !== currentUser.id)
    .map(u => ({ id: u.id, name: u.nickname || u.username }))
    .filter(u => !kw || u.name.toLowerCase().includes(kw))
    .slice(0, 6);
  if (!mentionCands.length) { box.classList.add('hidden'); return; }
  mentionIdx = 0;
  renderMentionBox();
  box.classList.remove('hidden');
}

function renderMentionBox() {
  const box = document.getElementById('chat-mention-box');
  if (!box) return;
  box.innerHTML = mentionCands.map((u, i) =>
    `<div class="mention-item ${i === mentionIdx ? 'active' : ''}" onmousedown="event.preventDefault();pickMention(${i})">@${escapeHtml(u.name)}</div>`).join('');
}

function pickMention(i) {
  const inp = document.getElementById('chat-text-input');
  const u = mentionCands[i];
  if (!inp || !u) return;
  const pos = inp.selectionStart != null ? inp.selectionStart : inp.value.length;
  const before = inp.value.slice(0, pos);
  const after = inp.value.slice(pos);
  const replaced = before.replace(/(^|\s)@[一-龥A-Za-z0-9_]{0,19}$/, '$1@' + u.name + ' ');
  inp.value = replaced + after;
  inp.focus();
  inp.selectionStart = inp.selectionEnd = replaced.length;
  document.getElementById('chat-mention-box').classList.add('hidden');
}

function handleChatKeydown(e) {
  const box = document.getElementById('chat-mention-box');
  const openBox = box && !box.classList.contains('hidden');
  if (openBox && mentionCands.length) {
    if (e.key === 'ArrowDown') { e.preventDefault(); mentionIdx = (mentionIdx + 1) % mentionCands.length; renderMentionBox(); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); mentionIdx = (mentionIdx - 1 + mentionCands.length) % mentionCands.length; renderMentionBox(); return; }
    if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pickMention(mentionIdx); return; }
    if (e.key === 'Escape') { box.classList.add('hidden'); return; }
  }
  if (e.key === 'Enter') { e.preventDefault(); sendChatText(); }
}

async function sendChatImage(e) {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const fd = new FormData();
  fd.append('image', file);
  const res = await fetch('/api/conversations/' + currentChatId + '/messages/image', {
    method: 'POST', body: fd
  });
  const d = await res.json();
  if (!res.ok) return alert(d.error || '图片发送失败');
  appendMessage(d);
}

// 发送文件（XHR 以便显示上传进度）
function sendChatFile(e) {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  if (file.size > 100 * 1024 * 1024) return alert('文件不能超过 100MB');
  const box = document.getElementById('chat-messages');
  // 临时进度气泡
  const tmp = document.createElement('div');
  tmp.className = 'msg-row mine';
  tmp.innerHTML = `<div class="msg-bubble-wrap"><div class="msg-file file-sending">
      <span class="file-icon">📎</span>
      <span class="file-meta">
        <span class="file-name">${escapeHtml(file.name)}</span>
        <span class="file-progress"><span class="file-progress-bar" style="width:0%"></span></span>
        <span class="file-size">上传中 0%</span>
      </span>
    </div></div>`;
  box.appendChild(tmp);
  box.scrollTop = box.scrollHeight;
  const bar = tmp.querySelector('.file-progress-bar');
  const pct = tmp.querySelector('.file-size');
  const fd = new FormData();
  fd.append('file', file);
  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/conversations/' + currentChatId + '/messages/file');
  xhr.upload.onprogress = ev => {
    if (ev.lengthComputable) {
      const p = Math.round(ev.loaded / ev.total * 100);
      bar.style.width = p + '%';
      pct.textContent = '上传中 ' + p + '%';
    }
  };
  xhr.onload = () => {
    let d;
    try { d = JSON.parse(xhr.responseText); } catch (err) { d = {}; }
    tmp.remove();
    if (xhr.status >= 200 && xhr.status < 300) appendMessage(d);
    else alert(d.error || '文件发送失败');
  };
  xhr.onerror = () => { tmp.remove(); alert('文件发送失败（网络错误）'); };
  xhr.send(fd);
}

function appendMessage(m) {
  const box = document.getElementById('chat-messages');
  if (!box) return;
  if (m.id > lastMsgId) lastMsgId = m.id;
  // 渲染单条消息（复用 renderMessages 逻辑）
  // 注意：渲染结果以换行/空格开头，firstChild 会取到空白文本节点，必须用 firstElementChild
  const tmp = document.createElement('div');
  tmp.innerHTML = renderMessages([m], chatIsGroup ? { type: 'group' } : null).trim();
  const node = tmp.firstElementChild;
  if (node) box.appendChild(node);
  box.scrollTop = box.scrollHeight;
  updateReceipts();  // 刚发出的消息先按当前回执显示（通常是"未读"）
}

async function pollChatMessages() {
  if (!currentChatId) return;
  let msgs;
  try {
    msgs = await fetch('/api/conversations/' + currentChatId + '/messages?after=' + lastMsgId).then(r => r.json());
  } catch (e) { return; }
  if (msgs.error) return;
  if (msgs.length) {
    msgs.forEach(m => {
      if (m.id > lastMsgId) lastMsgId = m.id;
      appendMessage(m);
    });
    // 有新消息时标记已读
    fetch('/api/conversations/' + currentChatId + '/read', { method: 'POST' }).then(refreshMsgBadge);
  }
  // 不管有没有新消息，都同步一次撤回状态（别人撤回旧消息时也能及时看到）
  await syncChatState();
  // 刷新已读回执（对方打开聊天后，我的消息从"未读"变"已读"）
  try {
    const r = await fetch('/api/conversations/' + currentChatId + '/receipts').then(x => x.json());
    if (Array.isArray(r)) { chatReceipts = r; updateReceipts(); }
  } catch (e) { /* 忽略 */ }
}

// —— 创建群聊弹窗 ——
async function showCreateGroupModal() {
  if (!usersCache.length) {
    usersCache = await fetch('/api/users').then(r => r.json()).catch(() => []);
  }
  document.getElementById('group-name-input').value = '';
  const list = document.getElementById('group-member-list');
  list.innerHTML = usersCache
    .filter(u => u.id !== currentUser.id)
    .map(u => {
      const name = u.nickname || u.username;
      return `<label class="group-member-row">
        <input type="checkbox" value="${u.id}" class="group-member-cb">
        <span>${escapeHtml(name)}</span>
        ${u.online ? '<span class="online-dot"></span>' : ''}
      </label>`;
    }).join('') || '<p class="modal-tip">暂无可邀请的同学</p>';
  document.getElementById('group-modal').classList.remove('hidden');
}

async function createGroup() {
  const name = document.getElementById('group-name-input').value.trim();
  const memberIds = Array.from(document.querySelectorAll('.group-member-cb:checked')).map(cb => parseInt(cb.value, 10));
  if (!name) return alert('请输入群名称');
  if (memberIds.length < 1) return alert('至少邀请 1 位同学');
  const res = await fetch('/api/conversations/group', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, memberIds })
  });
  const d = await res.json();
  if (!res.ok) return alert(d.error || '创建失败');
  closeModal('group-modal');
  openChat(d.id);
}

// —— 群设置弹窗（改名 / 加人 / 移除 / 退群 / 解散） ——
let gsDetail = null;   // 当前打开设置的群详情
let gsUsers = [];      // 全部同学（加人候选列表用）
async function showGroupSettings(convId) {
  let detail, allUsers;
  try {
    [detail, allUsers] = await Promise.all([
      fetch('/api/conversations/' + convId).then(r => r.json()),
      fetch('/api/users').then(r => r.json()).catch(() => [])
    ]);
  } catch (e) { return alert('加载失败'); }
  if (detail.error) return alert(detail.error);
  gsDetail = detail;
  gsUsers = allUsers;
  renderGroupSettings();
  document.getElementById('group-settings-modal').classList.remove('hidden');
}

function renderGroupSettings() {
  const d = gsDetail;
  if (!d) return;
  const isOwner = d.creator_id === currentUser.id;
  const memberIds = new Set(d.members.map(m => m.id));
  const candidates = gsUsers.filter(u => !memberIds.has(u.id));
  // 群名称：群主可编辑改名，普通成员只读
  const renameBlock = `
    <div class="gs-section">
      <h3>群名称</h3>
      ${isOwner ? `
      <div class="gs-rename-row">
        <input id="gs-name-input" maxlength="30" value="${escapeHtml(d.name || '')}">
        <button class="primary-btn" onclick="renameGroup()">保存</button>
      </div>` : `
      <div class="gs-rename-row">
        <span class="gs-name-readonly">${escapeHtml(d.name || '')}</span>
        <span class="modal-tip">仅群主可修改</span>
      </div>`}
    </div>`;
  // 群主：加人区（列出还不在群里的同学）
  const addBlock = isOwner ? `
    <div class="gs-section">
      <h3>添加成员</h3>
      ${candidates.length ? `
      <div class="gs-add-list">
        ${candidates.map(u => `<label class="gs-add-row">
          <input type="checkbox" value="${u.id}" class="gs-add-cb">
          <span>${avatarHtml({ id: u.id, name: u.nickname || u.username, avatar: u.avatar }, 'avatar-xs')} ${escapeHtml(u.nickname || u.username)}</span>
          ${u.online ? '<span class="online-dot"></span>' : ''}
        </label>`).join('')}
      </div>
      <button class="primary-btn gs-add-btn" onclick="addGroupMembers()">➕ 添加选中的同学</button>`
      : '<p class="modal-tip">所有同学都已在群里啦</p>'}
    </div>` : '';
  // 成员列表（群主可移除其他人）
  const membersHtml = d.members.map(u => {
    const name = u.nickname || u.username;
    return `<div class="gs-member-row">
      <span class="gs-member-name" onclick="closeModal('group-settings-modal');viewProfile(${u.id})">
        ${avatarHtml({ id: u.id, name, avatar: u.avatar }, 'avatar-sm')} ${escapeHtml(name)}
      </span>
      ${u.id === d.creator_id ? '<span class="role-badge admin">群主</span>' : ''}
      ${u.online ? '<span class="online-dot"></span>' : '<span class="offline-dot"></span>'}
      ${(isOwner && u.id !== d.creator_id) ? `<button class="danger-btn-sm" onclick="kickMember(${u.id})">移除</button>` : ''}
    </div>`;
  }).join('');
  // 底部危险区：群主解散，普通成员退群
  const danger = isOwner
    ? '<button class="danger-btn" onclick="dismissGroup()">⛔ 解散群聊（所有消息将被删除）</button>'
    : '<button class="danger-btn" onclick="leaveGroup()">🚪 退出群聊</button>';
  document.getElementById('gs-body').innerHTML = `
    ${renameBlock}${addBlock}
    <div class="gs-section">
      <h3>群成员（${d.members.length} 人）</h3>
      <div class="gs-members">${membersHtml}</div>
    </div>
    <div class="gs-danger-zone">${danger}</div>`;
}

// 操作后重新拉取群详情和同学列表，再渲染
async function refreshGroupSettings(reopenChat) {
  if (!gsDetail) return;
  const id = gsDetail.id;
  gsDetail = await fetch('/api/conversations/' + id).then(r => r.json()).catch(() => null);
  if (!gsDetail || gsDetail.error) { closeModal('group-settings-modal'); return; }
  gsUsers = await fetch('/api/users').then(r => r.json()).catch(() => []);
  renderGroupSettings();
  if (reopenChat && currentChatId === id) openChat(id);
}

async function renameGroup() {
  const inp = document.getElementById('gs-name-input');
  const name = inp.value.trim();
  if (!name) return alert('群名不能为空');
  const res = await fetch('/api/conversations/' + gsDetail.id + '/rename', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name })
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) return alert(d.error || '改名失败');
  await refreshGroupSettings();
  // 轻量更新聊天页头部标题，不整页重载
  const titleEl = document.querySelector('#chat-view .chat-title > span:first-child');
  if (titleEl) titleEl.textContent = '👥 ' + name;
}

async function addGroupMembers() {
  const ids = Array.from(document.querySelectorAll('.gs-add-cb:checked')).map(cb => parseInt(cb.value, 10));
  if (!ids.length) return alert('请先勾选要添加的同学');
  let firstErr = '';
  for (const uid of ids) {
    const res = await fetch('/api/conversations/' + gsDetail.id + '/members', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: uid })
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok && !firstErr) firstErr = d.error || '添加失败';
  }
  if (firstErr) alert('部分成员添加失败：' + firstErr);
  await refreshGroupSettings(true);
}

async function kickMember(uid) {
  if (!confirm('确定将该成员移出群聊吗？')) return;
  const res = await fetch(`/api/conversations/${gsDetail.id}/members/${uid}`, { method: 'DELETE' });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) return alert(d.error || '移除失败');
  await refreshGroupSettings(true);
}

async function leaveGroup() {
  if (!confirm('确定退出该群聊吗？退出后将不再收到群消息。')) return;
  const res = await fetch(`/api/conversations/${gsDetail.id}/members/${currentUser.id}`, { method: 'DELETE' });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) return alert(d.error || '退群失败');
  closeModal('group-settings-modal');
  gsDetail = null;
  showConversations();
}

async function dismissGroup() {
  if (!confirm('解散后所有群消息都会被永久删除，无法恢复。确定解散该群吗？')) return;
  const res = await fetch('/api/conversations/' + gsDetail.id, { method: 'DELETE' });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) return alert(d.error || '解散失败');
  closeModal('group-settings-modal');
  gsDetail = null;
  showConversations();
}

// —— 未读消息红点轮询（未读增加时响铃 + 桌面弹窗） ——
let lastMsgUnread = -1;   // -1=尚未初始化，首次轮询只记基准不响铃
async function refreshMsgBadge() {
  if (!currentUser) return;
  let d;
  try {
    d = await fetch('/api/conversations/unread').then(r => r.json());
  } catch (e) { return; }
  const badge = document.getElementById('msg-badge');
  if (d.unread > 0) {
    badge.textContent = d.unread > 99 ? '99+' : d.unread;
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
  // 同步到"信息通讯"主页面标签上的小红点
  const tabBadge = document.getElementById('tab-msg-badge');
  if (tabBadge) {
    tabBadge.textContent = d.unread > 99 ? '99+' : d.unread;
    tabBadge.classList.toggle('hidden', d.unread <= 0);
  }
  // 未读数比上次多 = 收到了新私信：响铃 + 桌面通知（正在聊的天会被即时标已读，不会误响）
  if (lastMsgUnread >= 0 && d.unread > lastMsgUnread) {
    playBeep();
    if (desktopNotifReady) {
      try {
        const convs = await fetch('/api/conversations').then(r => r.json());
        const c = (convs || []).find(x => x.unread > 0);
        if (c) {
          const preview = c.last_message
            ? (c.last_message.type === 'image' ? '[图片]'
              : c.last_message.type === 'file' ? '[文件]' + chatFileName(c.last_message.content).slice(0, 30)
              : String(c.last_message.content).slice(0, 40))
            : '你有新消息';
          const n = new Notification('💬 新消息', {
            body: `${c.name}：${preview}`,
            tag: 'conv-' + c.id
          });
          // 点桌面通知直接打开该会话
          n.onclick = () => {
            try { window.focus(); } catch (e) {}
            showConversations().then(() => openChat(c.id));
          };
        }
      } catch (e) { /* 忽略 */ }
    }
  }
  lastMsgUnread = d.unread;
}

// ===== 主页面四：学习（🍅 番茄钟 + 📚 学习资料库）=====

// ---------- 番茄钟（计时状态全局唯一，切到别的页面再回来不会重置）----------
const POMO_STATS_KEY = 'pomo_stats_v1';

function pomoToday() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function loadPomoStats() {
  try {
    const s = JSON.parse(localStorage.getItem(POMO_STATS_KEY));
    if (s && s.date === pomoToday()) return { date: s.date, count: s.count | 0, mins: s.mins | 0 };
  } catch (e) { /* 忽略 */ }
  return { date: pomoToday(), count: 0, mins: 0 };
}
let pomoStats = loadPomoStats();
function savePomoStats() {
  try { localStorage.setItem(POMO_STATS_KEY, JSON.stringify(pomoStats)); } catch (e) { /* 忽略 */ }
}

const pomo = {
  mode: 'focus',     // focus=专注中 / break=休息中
  running: false,
  remaining: 25 * 60,
  focusMin: 25,
  breakMin: 5,
  timer: null
};
function pomoMMSS() {
  const m = Math.floor(pomo.remaining / 60);
  const s = pomo.remaining % 60;
  return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}
function renderPomo() {
  const ring = document.getElementById('pomo-ring');
  if (!ring) return;  // 页面没打开时只在后台计时
  const total = (pomo.mode === 'focus' ? pomo.focusMin : pomo.breakMin) * 60;
  const done = total ? (1 - pomo.remaining / total) * 100 : 0;
  const color = pomo.mode === 'focus' ? 'var(--brand)' : '#43a047';
  ring.classList.toggle('break', pomo.mode === 'break');
  ring.style.background = `conic-gradient(${color} ${done}%, var(--border) ${done}%)`;
  document.getElementById('pomo-time').textContent = pomoMMSS();
  document.getElementById('pomo-mode-text').textContent =
    pomo.mode === 'focus' ? (pomo.running ? '🔥 专注中，请勿打扰' : '📖 专注时间') : '☕ 休息一下';
  document.getElementById('pomo-toggle').textContent = pomo.running ? '⏸ 暂停' : '▶ 开始';
  document.getElementById('pomo-today').textContent =
    `今日已完成 ${pomoStats.count} 个番茄钟 · 共专注 ${pomoStats.mins} 分钟`;
  document.title = pomo.running
    ? `${pomoMMSS()} ${pomo.mode === 'focus' ? '专注中' : '休息中'} - 班级动态`
    : '班级动态';
}
function pomoTick() {
  if (pomo.remaining > 0) { pomo.remaining--; renderPomo(); return; }
  clearInterval(pomo.timer);
  pomo.timer = null;
  pomo.running = false;
  if (pomo.mode === 'focus') {
    pomoStats.count++;
    pomoStats.mins += pomo.focusMin;
    savePomoStats();
    pomo.mode = 'break';
    pomo.remaining = pomo.breakMin * 60;
    pomoFlash('🎉 一个番茄钟完成！站起来喝口水、休息一下吧');
  } else {
    pomo.mode = 'focus';
    pomo.remaining = pomo.focusMin * 60;
    pomoFlash('☕ 休息结束，继续加油！');
  }
  playBeep();
  setTimeout(playBeep, 500);
  setTimeout(playBeep, 1000);
  renderPomo();
}
function pomoFlash(msg) {
  const el = document.getElementById('pomo-flash');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 6000);
}
function togglePomo() {
  if (pomo.running) {
    clearInterval(pomo.timer);
    pomo.timer = null;
    pomo.running = false;
  } else {
    pomo.running = true;
    pomo.timer = setInterval(pomoTick, 1000);
  }
  renderPomo();
}
function resetPomo() {
  clearInterval(pomo.timer);
  pomo.timer = null;
  pomo.running = false;
  pomo.remaining = (pomo.mode === 'focus' ? pomo.focusMin : pomo.breakMin) * 60;
  renderPomo();
}
function skipPomo() {
  clearInterval(pomo.timer);
  pomo.timer = null;
  pomo.running = false;
  pomo.mode = pomo.mode === 'focus' ? 'break' : 'focus';
  pomo.remaining = (pomo.mode === 'focus' ? pomo.focusMin : pomo.breakMin) * 60;
  renderPomo();
}
function setPomoMin(kind, val) {
  val = parseInt(val, 10) || 25;
  if (kind === 'focus') {
    pomo.focusMin = val;
    if (pomo.mode === 'focus' && !pomo.running) pomo.remaining = val * 60;
  } else {
    pomo.breakMin = val;
    if (pomo.mode === 'break' && !pomo.running) pomo.remaining = val * 60;
  }
  renderPomo();
}

// ---------- 学习资料库 ----------
let studyCourses = [];
let currentCourseId = 0;
let resourceQuery = '';

async function openStudyTab() {
  switchMainPage('study');
  const root = document.getElementById('page-study');
  root.innerHTML = studyShellHtml();
  renderPomo();
  currentCourseId = 0;
  resourceQuery = '';
  await Promise.all([loadCourses(), loadResources()]);
}

function studyShellHtml() {
  return `
    <div class="card pomo-card">
      <h3>🍅 番茄钟</h3>
      <div id="pomo-ring" class="pomo-ring"><div class="pomo-inner">
        <div id="pomo-mode-text" class="pomo-mode">📖 专注时间</div>
        <div id="pomo-time" class="pomo-time">25:00</div>
      </div></div>
      <div class="pomo-controls">
        <button id="pomo-toggle" class="primary-btn" onclick="togglePomo()">▶ 开始</button>
        <button onclick="resetPomo()">↺ 重置</button>
        <button onclick="skipPomo()">⏭ 跳过</button>
      </div>
      <div class="pomo-durations">
        专注
        <select onchange="setPomoMin('focus', this.value)">
          <option value="15">15分钟</option>
          <option value="25" selected>25分钟</option>
          <option value="45">45分钟</option>
        </select>
        休息
        <select onchange="setPomoMin('break', this.value)">
          <option value="5" selected>5分钟</option>
          <option value="10">10分钟</option>
          <option value="15">15分钟</option>
        </select>
      </div>
      <div id="pomo-today" class="pomo-today"></div>
      <div id="pomo-flash" class="pomo-flash"></div>
    </div>

    <div class="study-lib-head">
      <h3>📚 学习资料库</h3>
      <div class="search-box study-search">
        <span class="search-icon">🔍</span>
        <input id="res-search" placeholder="搜索资料文件名、备注..."
          onkeydown="if(event.key==='Enter')doResourceSearch()">
        <button class="study-search-btn" onclick="doResourceSearch()">搜索</button>
      </div>
    </div>
    <div id="course-chips" class="tool-chips-row"></div>
    <div id="course-create-row"></div>
    <div id="res-upload-card"></div>
    <div id="resources-list"></div>`;
}

async function loadCourses() {
  try {
    studyCourses = await fetch('/api/courses').then(r => r.json());
    if (!Array.isArray(studyCourses)) studyCourses = [];
  } catch (e) { studyCourses = []; }
  renderCourseChips();
  renderUploadCard();
}

function renderCourseChips() {
  const el = document.getElementById('course-chips');
  if (!el) return;
  const admin = isAdminUser(currentUser);
  let html = `<button class="tool-chip ${currentCourseId === 0 ? 'active' : ''}" onclick="selectCourse(0)">全部</button>`;
  html += studyCourses.map(c => {
    const canDel = currentUser && (c.created_by === currentUser.id || admin);
    return `<span class="tool-chip-wrap ${currentCourseId === c.id ? 'active' : ''}">
      <button class="tool-chip" onclick="selectCourse(${c.id})">${escapeHtml(c.name)} ${c.res_count}</button>
      ${canDel ? `<button class="tool-chip-del" title="只能删除没有资料的空课程" onclick="deleteCourse(${c.id})">✕</button>` : ''}
    </span>`;
  }).join('');
  el.innerHTML = html;
}

function renderUploadCard() {
  const el = document.getElementById('res-upload-card');
  if (!el) return;
  if (!currentUser) {
    el.innerHTML = `<div class="card tool-guest-tip">👀 游客可以浏览和下载资料，<b>登录后</b>就能上传课件、真题、笔记。
      <button onclick="showLogin()">去登录</button></div>`;
    return;
  }
  const opts = studyCourses.length
    ? studyCourses.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('')
    : '<option value="0">（还没有课程，请先在上面新建一门）</option>';
  el.innerHTML = `
    <div class="card tool-upload-card">
      <h3>📤 上传学习资料（+2 积分）</h3>
      <div class="tool-form-row">
        <select id="res-course">${opts}</select>
      </div>
      <div class="tool-form-row">
        <input id="res-note" placeholder="备注，如「2024 期中真题带答案」（可选）" maxlength="200">
      </div>
      <div class="tool-form-row tool-form-bottom">
        <label class="res-file-label">📁 选择文件（pdf/word/ppt/excel/压缩包/图片，≤2GB）
          <input type="file" id="res-file" onchange="onResFilePick()">
        </label>
        <button class="primary-btn" id="res-submit" onclick="submitResource()">上传</button>
      </div>
      <div id="res-pick-name" class="res-pick-name"></div>
    </div>`;
  const createRow = document.getElementById('course-create-row');
  createRow.innerHTML = `
    <div class="tool-cat-admin">
      <input id="new-course-name" placeholder="新建课程，如：高等数学" maxlength="30"
        onkeydown="if(event.key==='Enter')createCourse()">
      <button onclick="createCourse()">＋ 新建课程</button>
    </div>`;
  if (currentCourseId) {
    const sel = document.getElementById('res-course');
    if (sel) sel.value = currentCourseId;
  }
}

async function selectCourse(id) {
  currentCourseId = id;
  renderCourseChips();
  const sel = document.getElementById('res-course');
  if (sel && id) sel.value = id;
  await loadResources();
}

function doResourceSearch() {
  const inp = document.getElementById('res-search');
  resourceQuery = inp ? inp.value.trim() : '';
  loadResources();
}

async function createCourse() {
  const inp = document.getElementById('new-course-name');
  const name = inp.value.trim();
  if (!name) return;
  const r = await fetch('/api/courses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name })
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) return alert(d.error || '创建失败');
  inp.value = '';
  currentCourseId = d.id;
  await Promise.all([loadCourses(), loadResources()]);
}

async function deleteCourse(id) {
  if (!confirm('确定删除这门课程吗？（只有课程里没有资料时才能删除）')) return;
  const r = await fetch('/api/courses/' + id, { method: 'DELETE' });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) return alert(d.error || '删除失败');
  if (currentCourseId === id) currentCourseId = 0;
  await Promise.all([loadCourses(), loadResources()]);
}

async function loadResources() {
  const el = document.getElementById('resources-list');
  if (!el) return;
  const params = new URLSearchParams();
  if (currentCourseId) params.set('course_id', currentCourseId);
  if (resourceQuery) params.set('q', resourceQuery);
  let list = [];
  try {
    list = await fetch('/api/resources?' + params.toString()).then(r => r.json());
    if (!Array.isArray(list)) list = [];
  } catch (e) { list = []; }
  if (!list.length) {
    el.innerHTML = '<div class="card empty-state">📭 还没有资料，快把课件、真题、笔记传上来造福同学吧～</div>';
    return;
  }
  el.innerHTML = list.map(renderResourceRow).join('');
}

function resIcon(name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (ext === 'pdf') return '📕';
  if (['doc', 'docx'].includes(ext)) return '📘';
  if (['xls', 'xlsx', 'csv'].includes(ext)) return '📗';
  if (['ppt', 'pptx'].includes(ext)) return '📙';
  if (['zip', 'rar', '7z'].includes(ext)) return '🗜️';
  if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext)) return '🖼️';
  if (['txt', 'md'].includes(ext)) return '📝';
  return '📎';
}
function fmtSize(bytes) {
  bytes = +bytes || 0;
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

function renderResourceRow(r) {
  const admin = isAdminUser(currentUser);
  const canDel = currentUser && (r.user_id === currentUser.id || admin);
  const ava = avatarHtml({ id: r.user_id, name: r.nickname || r.username || '同学', avatar: r.avatar }, 'res-ava');
  return `
    <div class="card res-row">
      <div class="res-icon">${resIcon(r.original_name)}</div>
      <div class="res-main">
        <a class="res-name" href="/api/resources/${r.id}/download">${escapeHtml(r.original_name)}</a>
        ${r.note ? `<div class="res-note">${escapeHtml(r.note)}</div>` : ''}
        <div class="res-meta">
          <span class="res-course-tag">${escapeHtml(r.course_name)}</span>
          ${ava}
          <span>${escapeHtml(r.nickname || r.username || '同学')}</span>
          <span>${fmtSize(r.size)}</span>
          <span>⬇ ${r.downloads}</span>
          <span>${formatTime(r.created_at)}</span>
        </div>
      </div>
      <div class="res-actions">
        <a class="res-dl-btn" href="/api/resources/${r.id}/download">⬇ 下载</a>
        ${canDel ? `<button onclick="deleteResource(${r.id})">删除</button>` : ''}
      </div>
    </div>`;
}

function onResFilePick() {
  const fi = document.getElementById('res-file');
  const tip = document.getElementById('res-pick-name');
  if (!fi || !tip) return;
  if (fi.files.length) tip.textContent = '已选择：' + fi.files[0].name + '（' + fmtSize(fi.files[0].size) + '）';
  else tip.textContent = '';
}

async function submitResource() {
  const fi = document.getElementById('res-file');
  const sel = document.getElementById('res-course');
  const noteEl = document.getElementById('res-note');
  const btn = document.getElementById('res-submit');
  if (!fi.files.length) return alert('请先选择要上传的文件');
  const cid = parseInt(sel && sel.value, 10) || 0;
  if (!cid) return alert('请先选择课程（没有的话先在上面新建一门课）');
  if (fi.files[0].size > 2 * 1024 * 1024 * 1024) return alert('文件不能超过 2GB');
  btn.disabled = true;
  btn.textContent = '上传中...';
  try {
    const fd = new FormData();
    fd.append('course_id', cid);
    fd.append('note', noteEl.value);
    fd.append('file', fi.files[0]);
    const resp = await fetch('/api/resources', { method: 'POST', body: fd });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) return alert(data.error || '上传失败');
    fi.value = '';
    noteEl.value = '';
    document.getElementById('res-pick-name').textContent = '';
    if (currentUser) currentUser.points = (currentUser.points || 0) + 2;
    await Promise.all([loadCourses(), loadResources()]);
  } catch (e) {
    alert('网络错误，上传失败');
  } finally {
    const b = document.getElementById('res-submit');
    if (b) { b.disabled = false; b.textContent = '上传'; }
  }
}

async function deleteResource(id) {
  if (!confirm('确定删除这个资料吗？删除后服务器上的文件不可恢复。')) return;
  const r = await fetch('/api/resources/' + id, { method: 'DELETE' });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) return alert(d.error || '删除失败');
  await Promise.all([loadCourses(), loadResources()]);
}

init();
