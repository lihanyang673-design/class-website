const express = require('express');
const session = require('express-session');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const FFMPEG = require('ffmpeg-static');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'classroom.sqlite');

// 机密信息（会话密钥、管理员密码）从本地 secrets.js 读取；该文件已 gitignore，不上传 GitHub
// 也可用环境变量 SESSION_SECRET / ADMIN_SECRET 覆盖
let LOCAL_SECRETS = {};
try { LOCAL_SECRETS = require('./secrets.js'); } catch (e) {}
const SESSION_SECRET = process.env.SESSION_SECRET || LOCAL_SECRETS.SESSION_SECRET || 'dev-only-secret';
const ADMIN_SECRET = process.env.ADMIN_SECRET || LOCAL_SECRETS.ADMIN_SECRET || '';
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const BACKUP_DIR = path.join(__dirname, 'backups');

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR);

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 * 7 }
}));
// 在线状态：内存 Map 记录每个登录用户最后活跃时间（最近 5 分钟内有访问 = 在线）
// 服务器重启后所有人临时显示离线，下次请求即恢复
const onlineMap = new Map();
const ONLINE_WINDOW_MS = 5 * 60 * 1000;
app.use((req, res, next) => {
  if (req.session && req.session.userId) onlineMap.set(req.session.userId, Date.now());
  next();
});
function isOnline(uid) {
  const t = onlineMap.get(uid);
  return !!(t && Date.now() - t < ONLINE_WINDOW_MS);
}
app.use('/uploads', express.static(UPLOAD_DIR));
// 分享链接预览：在静态文件之前拦截 /?postId=123，注入 OG meta 让 IM 软件显示标题/摘要/预览图
const INDEX_HTML_PATH = path.join(__dirname, 'public', 'index.html');
let _indexHtmlCache = '';
function getIndexHtml() {
  if (!_indexHtmlCache) _indexHtmlCache = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
  return _indexHtmlCache;
}
function escapeHtmlAttr(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
app.get('/', (req, res, next) => {
  const pid = parseInt(req.query.postId, 10);
  if (!pid) return next();
  let post = null;
  try {
    post = query('SELECT p.content, p.images, u.nickname FROM posts p JOIN users u ON p.user_id = u.id WHERE p.id = ?', [pid])[0];
  } catch (e) { console.error('share-preview error:', e.message); }
  let html = getIndexHtml();
  if (post) {
    const base = req.protocol + '://' + req.get('host');
    let img = '';
    if (post.images) {
      const first = String(post.images).split(',')[0].trim();
      if (first) img = first.startsWith('/') ? base + first : base + '/uploads/' + first;
    }
    const summary = String(post.content || '')
      .replace(/@[\w\u4e00-\u9fa5]+/g, '')
      .replace(/#[^#\n]+#/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 100);
    const title = post.nickname ? post.nickname + ' 分享的班级动态' : '班级动态';
    const ogMetas = `<meta property="og:title" content="${escapeHtmlAttr(title)}">
<meta property="og:description" content="${escapeHtmlAttr(summary || '点开看看这条班级动态～')}">
<meta property="og:image" content="${escapeHtmlAttr(img)}">
<meta property="og:type" content="article">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${escapeHtmlAttr(title)}">
<meta name="twitter:description" content="${escapeHtmlAttr(summary || '点开看看这条班级动态～')}">
<meta name="twitter:image" content="${escapeHtmlAttr(img)}">`;
    html = html.replace(/<title>[^<]*<\/title>/, `<title>${escapeHtmlAttr(title)} - 班级动态</title>\n${ogMetas}`);
  }
  res.type('text/html').send(html);
});
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, filePath){
    const f=filePath.toLowerCase();
    // 【自动更新规则】2026-10-03 起：
    // ① 代码文件(html/js/css)：每次打开都向服务器验证一次——没改版返回304秒过(几乎不耗流量)，
    //    改了版自动下载新文件。同学进游戏永远是最新代码，再也不用手动清缓存。
    if(/\.(html|js|css|mjs)$/.test(f)){
      res.setHeader('Cache-Control', 'no-cache');
    } else if(/\.(mp3|wav|ogg|m4a|aac|png|jpg|jpeg|gif|webp|bmp|svg|glb|gltf|bin|ktx2|obj|fbx|babylon)$/.test(f)){
      // ② 歌曲/图片/3D模型：长期缓存30天，不重复下载（这些文件基本不会变）
      res.setHeader('Cache-Control', 'public, max-age=2592000');
    }
    // 其他文件（如曲谱 .json）：走默认的 ETag 验证，稳妥兜底
  }
}));

let db;

// ===== 数据库初始化 =====
async function initDB() {
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_FILE)) {
    const data = fs.readFileSync(DB_FILE);
    db = new SQL.Database(data);
  } else {
    db = new SQL.Database();
  }
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    nickname TEXT,
    role TEXT DEFAULT 'student',
    admin_status TEXT DEFAULT 'none',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    content TEXT NOT NULL,
    images TEXT DEFAULT '',
    videos TEXT DEFAULT '',
    files TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  )`);
  // 旧数据库迁移：补上 videos 列
  const postCols = query('PRAGMA table_info(posts)');
  if (!postCols.some(c => c.name === 'videos')) db.run("ALTER TABLE posts ADD COLUMN videos TEXT DEFAULT ''");
  if (!postCols.some(c => c.name === 'pinned')) db.run("ALTER TABLE posts ADD COLUMN pinned INTEGER DEFAULT 0");
  if (!postCols.some(c => c.name === 'section_id')) db.run("ALTER TABLE posts ADD COLUMN section_id INTEGER DEFAULT 0");
  if (!postCols.some(c => c.name === 'view_count')) db.run("ALTER TABLE posts ADD COLUMN view_count INTEGER DEFAULT 0");
  if (!postCols.some(c => c.name === 'poll')) db.run("ALTER TABLE posts ADD COLUMN poll TEXT DEFAULT ''");
  // 分区（模块）表
  db.run(`CREATE TABLE IF NOT EXISTS sections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    sort_order INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  // 首次使用时预置三个分区，之后可自行增删
  const secCount = query('SELECT COUNT(*) AS c FROM sections')[0].c;
  if (secCount === 0) {
    ['学习', '恶搞', '温馨'].forEach((n, i) => db.run('INSERT INTO sections (name, sort_order) VALUES (?, ?)', [n, i]));
  }
  // 旧数据库迁移：users 补上 avatar 列
  const userCols = query('PRAGMA table_info(users)');
  if (!userCols.some(c => c.name === 'avatar')) db.run("ALTER TABLE users ADD COLUMN avatar TEXT DEFAULT ''");
  if (!userCols.some(c => c.name === 'birthday')) db.run("ALTER TABLE users ADD COLUMN birthday TEXT DEFAULT ''");  // 'MM-DD'
  if (!userCols.some(c => c.name === 'points')) db.run("ALTER TABLE users ADD COLUMN points INTEGER DEFAULT 0");
  if (!userCols.some(c => c.name === 'last_seen')) db.run("ALTER TABLE users ADD COLUMN last_seen DATETIME");
  // 旧库迁移：comments 补 parent_id 列（楼中楼回复；0 = 顶级评论）
  const commentCols = query('PRAGMA table_info(comments)');
  if (!commentCols.some(c => c.name === 'parent_id')) db.run("ALTER TABLE comments ADD COLUMN parent_id INTEGER DEFAULT 0");
  db.run(`CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    actor_id INTEGER NOT NULL,
    type TEXT NOT NULL,
    post_id INTEGER,
    content TEXT DEFAULT '',
    is_read INTEGER DEFAULT 0,
    conversation_id INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  // 旧库迁移：通知增加会话 id（群聊 @ 提醒点击后直接跳到该群聊）
  const notifCols = query('PRAGMA table_info(notifications)');
  if (!notifCols.some(c => c.name === 'conversation_id')) {
    db.run("ALTER TABLE notifications ADD COLUMN conversation_id INTEGER DEFAULT 0");
  }
  db.run(`CREATE TABLE IF NOT EXISTS likes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL DEFAULT 0,
    device_id TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  // 旧库迁移：原表有 UNIQUE(post_id,user_id)，游客都用 user_id=0 会互相冲突。
  // 重建为无表级唯一约束的新表，改用两个"部分唯一索引"分别约束登录用户和游客设备。
  const likesMaster = query("SELECT sql FROM sqlite_master WHERE type='table' AND name='likes'")[0];
  if (likesMaster && /UNIQUE\s*\(\s*"?post_id"?\s*,\s*"?user_id"?\s*\)/i.test(likesMaster.sql || '')) {
    db.run('ALTER TABLE likes RENAME TO likes_old');
    db.run(`CREATE TABLE likes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL DEFAULT 0,
      device_id TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    // 旧表没有 device_id 列，搬迁时补空串
    db.run("INSERT INTO likes (id, post_id, user_id, device_id, created_at) SELECT id, post_id, user_id, '', created_at FROM likes_old");
    db.run('DROP TABLE likes_old');
  }
  const likeCols = query('PRAGMA table_info(likes)');
  if (!likeCols.some(c => c.name === 'device_id')) db.run("ALTER TABLE likes ADD COLUMN device_id TEXT DEFAULT ''");
  db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_likes_user ON likes(post_id, user_id) WHERE user_id > 0');
  db.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_likes_device ON likes(post_id, device_id) WHERE device_id <> ''");
  db.run(`CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    device_id TEXT DEFAULT '',
    guest_name TEXT DEFAULT '',
    content TEXT NOT NULL,
    image TEXT DEFAULT '',
    parent_id INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  // 旧库迁移：游客评论（user_id=0）记录设备和昵称
  const cCols = query('PRAGMA table_info(comments)');
  if (!cCols.some(c => c.name === 'device_id')) db.run("ALTER TABLE comments ADD COLUMN device_id TEXT DEFAULT ''");
  if (!cCols.some(c => c.name === 'guest_name')) db.run("ALTER TABLE comments ADD COLUMN guest_name TEXT DEFAULT ''");
  if (!cCols.some(c => c.name === 'image')) db.run("ALTER TABLE comments ADD COLUMN image TEXT DEFAULT ''");  // 表情包/图片评论
  db.run(`CREATE TABLE IF NOT EXISTS favorites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(post_id, user_id)
  )`);
  // 浏览去重表：登录用户按 user_id 去重，游客按 device_id 去重
  // device_id 为前端 localStorage 中持久保存的随机串
  db.run(`CREATE TABLE IF NOT EXISTS post_views (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER NOT NULL,
    user_id INTEGER DEFAULT 0,
    device_id TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS poll_votes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER NOT NULL,
    option_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(post_id, user_id)
  )`);
  // 私聊 / 群聊三张表
  db.run(`CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,                -- 'direct' 一对一, 'group' 群聊
    name TEXT DEFAULT '',              -- 群聊名，direct 时为空
    creator_id INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS conversation_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    last_read_at DATETIME DEFAULT '1970-01-01',
    joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(conversation_id, user_id)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL,
    sender_id INTEGER NOT NULL,
    type TEXT NOT NULL DEFAULT 'text',  -- 'text' | 'image' | 'file'
    content TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  // 旧库迁移：消息撤回标记（1=已撤回，content 同时清空）
  const msgCols = query('PRAGMA table_info(messages)');
  if (!msgCols.some(c => c.name === 'recalled')) db.run("ALTER TABLE messages ADD COLUMN recalled INTEGER DEFAULT 0");
  // 每日签到：date 存 'YYYY-MM-DD'（用户本地日期，前端传），UNIQUE 防重复签到
  db.run(`CREATE TABLE IF NOT EXISTS checkins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, date)
  )`);
  // ===== 工具分享 =====
  db.run(`CREATE TABLE IF NOT EXISTS tool_categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    sort_order INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS tools (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    url TEXT NOT NULL,
    description TEXT DEFAULT '',
    category_id INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  // 工具点赞：登录用户 user_id>0；游客 user_id=0 + device_id（同一设备只能赞一次）
  db.run(`CREATE TABLE IF NOT EXISTS tool_likes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tool_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL DEFAULT 0,
    device_id TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_tlikes_user ON tool_likes(tool_id, user_id) WHERE user_id > 0');
  db.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_tlikes_device ON tool_likes(tool_id, device_id) WHERE device_id <> ''");
  // ===== 学习资料库：课程文件夹 + 资料文件 =====
  db.run(`CREATE TABLE IF NOT EXISTS courses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    created_by INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS resources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    course_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    original_name TEXT NOT NULL,
    stored_name TEXT NOT NULL,
    note TEXT DEFAULT '',
    size INTEGER DEFAULT 0,
    downloads INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  // ===== 个人主页留言板（电子同学录）=====
  db.run(`CREATE TABLE IF NOT EXISTS board_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target_uid INTEGER NOT NULL,
    author_uid INTEGER NOT NULL,
    content TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  // ===== 主页访客记录（同一访客只保留最近一次）=====
  db.run(`CREATE TABLE IF NOT EXISTS profile_visits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target_uid INTEGER NOT NULL,
    visitor_uid INTEGER NOT NULL,
    visited_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(target_uid, visitor_uid)
  )`);
  // 班级公告：管理员发布，全员收到通知，最新公告常驻首页顶部
  db.run(`CREATE TABLE IF NOT EXISTS announcements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    created_by INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  // 帖子举报：每人对每帖只能举报一次；status: open 待处理 / resolved 已删帖 / dismissed 已忽略
  db.run(`CREATE TABLE IF NOT EXISTS reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER NOT NULL,
    reporter_id INTEGER NOT NULL,
    reason TEXT DEFAULT '',
    status TEXT DEFAULT 'open',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(post_id, reporter_id)
  )`);
  // ===== 奶娃街舞：玩家上传歌曲 + 自动生成的谱面 =====
  db.run(`CREATE TABLE IF NOT EXISTS dance_songs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    artist TEXT DEFAULT '',
    bpm INTEGER DEFAULT 100,
    duration REAL DEFAULT 0,
    note_count INTEGER DEFAULT 0,
    chart TEXT NOT NULL DEFAULT '[]',
    audio TEXT NOT NULL,
    uploader_id INTEGER DEFAULT 0,
    uploader_name TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  // ===== 奶娃街舞：多人排行榜（按曲目+难度，全班共享）=====
  db.run(`CREATE TABLE IF NOT EXISTS dance_scores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    song_key TEXT NOT NULL,           -- 曲目稳定标识：内置 'default' / 上传 'u'+dbId
    song_name TEXT DEFAULT '',
    diff TEXT NOT NULL,               -- easy / casual / normal / hard
    user_key TEXT NOT NULL,           -- 玩家标识：'u'+userId / 游客 'g'+本地playerId
    user_name TEXT DEFAULT '玩家',
    score INTEGER DEFAULT 0,          -- 绝对分
    rel INTEGER DEFAULT 0,            -- 相对分（排行依据，0~100000）
    combo INTEGER DEFAULT 0,
    rank TEXT DEFAULT 'C',
    p INTEGER DEFAULT 0,              -- PERFECT
    g INTEGER DEFAULT 0,              -- GOOD
    m INTEGER DEFAULT 0,              -- MISS
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(song_key, diff, user_key)
  )`);
  // ===== 奶娃街舞：无尽模式排行榜（仅地狱难度，音乐循环加速，按累计总分排行）=====
  db.run(`CREATE TABLE IF NOT EXISTS dance_endless (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    song_key TEXT NOT NULL,           -- 曲目稳定标识：内置 'default' / 上传 'u'+dbId
    song_name TEXT DEFAULT '',
    user_key TEXT NOT NULL,           -- 玩家标识：'u'+userId / 游客 'g'+本地playerId
    user_name TEXT DEFAULT '玩家',
    score INTEGER DEFAULT 0,          -- 累计总分（普通局 + 无尽各段累加），排行依据
    round INTEGER DEFAULT 1,          -- 坚持到的段数（第1段=1.1倍速，每段+10%）
    combo INTEGER DEFAULT 0,          -- 累计最大连击
    notes INTEGER DEFAULT 0,          -- 累计击中音符数（PERFECT+GOOD）
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(song_key, user_key)        -- 同一玩家同一首歌只留最高总分
  )`);
  saveDB();
}

function saveDB() {
  const data = db.export();
  fs.writeFileSync(DB_FILE, Buffer.from(data));
}

// ===== 自动备份 =====
// 每天服务器本地日期一个自动备份 backup-YYYY-MM-DD.sqlite，保留最近 7 天；
// 手动备份 manual-YYYY-MM-DD-HHmmss.sqlite 不自动清理，由管理员自己管理。
const BACKUP_KEEP_DAYS = 7;
const BACKUP_NAME_RE = /^(backup|manual)-\d{4}-\d{2}-\d{2}(-\d{6})?\.sqlite$/;

function pad2(n) { return String(n).padStart(2, '0'); }
function ymdStr(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }

// 把当前内存数据库导出为备份文件，返回文件名
function createBackupFile(manual) {
  const d = new Date();
  const name = manual
    ? `manual-${ymdStr(d)}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}.sqlite`
    : `backup-${ymdStr(d)}.sqlite`;
  fs.writeFileSync(path.join(BACKUP_DIR, name), Buffer.from(db.export()));
  return name;
}

// 每天自动备份：今天的备份不存在就创建一个，然后删掉超过保留期的旧自动备份
function ensureDailyBackup() {
  try {
    const todayFile = `backup-${ymdStr(new Date())}.sqlite`;
    if (!fs.existsSync(path.join(BACKUP_DIR, todayFile))) {
      createBackupFile(false);
      console.log(`[备份] 已创建今日自动备份 ${todayFile}`);
    }
    // 清理：文件名里的日期早于 7 天前的自动备份
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - (BACKUP_KEEP_DAYS - 1));  // 保留"今天 + 前6天"共7个
    const cutoffStr = ymdStr(cutoff);
    for (const f of fs.readdirSync(BACKUP_DIR)) {
      if (!/^backup-\d{4}-\d{2}-\d{2}\.sqlite$/.test(f)) continue;
      const datePart = f.slice(7, 17);
      if (datePart < cutoffStr) {
        fs.unlinkSync(path.join(BACKUP_DIR, f));
        console.log(`[备份] 已清理过期备份 ${f}`);
      }
    }
  } catch (e) {
    console.error('[备份] 自动备份失败:', e.message);
  }
}

// 备份文件列表（含大小/时间），时间新的在前
function listBackupFiles() {
  return fs.readdirSync(BACKUP_DIR)
    .filter(f => BACKUP_NAME_RE.test(f))
    .map(f => {
      const st = fs.statSync(path.join(BACKUP_DIR, f));
      return {
        name: f,
        size: st.size,
        mtime: st.mtime,
        manual: f.startsWith('manual-')
      };
    })
    .sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
}

function query(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const results = [];
  while (stmt.step()) results.push(stmt.getAsObject());
  stmt.free();
  return results;
}

function run(sql, params = []) {
  db.run(sql, params);
  saveDB();
}

// 插入数据并返回新行的 id（注意：必须在 saveDB/export 之前取 last_insert_rowid，
// 因为 sql.js 的 export 会把 last_insert_rowid 重置为 0）
function insert(sql, params = []) {
  db.run(sql, params);
  const id = query('SELECT last_insert_rowid() AS id')[0].id;
  saveDB();
  return id;
}

// ===== 通知 =====
// convId 用于聊天类通知（群聊 @），点击通知可直接跳到对应会话
function addNotification(userId, actorId, type, postId, content = '', convId = 0) {
  if (!userId || userId === actorId) return;  // 不通知自己
  run('INSERT INTO notifications (user_id, actor_id, type, post_id, content, conversation_id) VALUES (?, ?, ?, ?, ?, ?)',
    [userId, actorId, type, postId, String(content).slice(0, 100), convId || 0]);
}

// ===== 积分 / 等级头衔 =====
// 积分规则：签到+2、发帖+5、评论+1、动态被评论作者+2、被赞作者+1（取消赞扣回）
function addPoints(uid, delta) {
  if (!uid || !delta) return;
  run('UPDATE users SET points = MAX(0, points + ?) WHERE id = ?', [delta, uid]);
}
// 积分等级（达到 min 即获得对应头衔）——前端 app.js 的 LEVELS 必须与此一致
const LEVELS = [
  { min: 0,    icon: '🌱', name: '萌新同学' },
  { min: 30,   icon: '☀️', name: '活跃分子' },
  { min: 100,  icon: '💬', name: '水群之王' },
  { min: 250,  icon: '🌟', name: '人气之星' },
  { min: 500,  icon: '📚', name: '班级卷王' },
  { min: 1000, icon: '👑', name: '班级传说' }
];
function levelForPoints(p) {
  let lv = LEVELS[0];
  for (const l of LEVELS) if ((p || 0) >= l.min) lv = l;
  return lv;
}

// 解析文字中的 @昵称，返回被 @ 的用户列表
function parseMentions(text) {
  const found = [];
  const re = /@([^\s@，。,.!?！？]{1,20})/g;
  let m;
  while ((m = re.exec(text || '')) !== null) {
    if (!found.includes(m[1])) found.push(m[1]);
  }
  const users = [];
  for (const nick of found) {
    // 通知所有同名用户（重名时一个都不遗漏）
    const rows = query('SELECT id, nickname FROM users WHERE nickname = ?', [nick]);
    for (const r of rows) {
      if (!users.some(u => u.id === r.id)) users.push(r);
    }
  }
  return users;
}

// ===== 文件上传配置 =====
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, Date.now() + '_' + Math.round(Math.random() * 1e9) + ext);
  }
});
const upload = multer({ storage, limits: { fileSize: 200 * 1024 * 1024 } });  // 单个文件最大 200MB

// ===== 中间件 =====
function authRequired(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: '请先登录' });
  next();
}

// 取"操作者身份"：登录用户用 user_id，未登录游客用前端传的 device_id
// body 优先（POST），其次 query（GET）
function getIdentity(req) {
  const uid = req.session.userId || 0;
  const device = String((req.body && req.body.device_id) || req.query.device_id || '').trim().slice(0, 64);
  return { uid, device };
}

function adminRequired(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: '请先登录' });
  // 管理员是“本次会话”的开关：登录默认关闭，输对密码才开启，退出管理员/重新登录即关闭
  if (!req.session.adminMode) return res.status(403).json({ error: '需要管理员权限' });
  next();
}

// ===== 用户接口 =====
app.post('/api/register', async (req, res) => {
  try {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    let nickname = String(req.body.nickname || '').trim();
    if (!username || !password) return res.status(400).json({ error: '用户名和密码必填' });
    // 用户名：2-20 位，只能用中英文、数字、下划线
    if (!/^[\u4e00-\u9fa5A-Za-z0-9_]{2,20}$/.test(username)) {
      return res.status(400).json({ error: '用户名需为 2-20 位中英文、数字或下划线' });
    }
    if (password.length < 6 || password.length > 32) {
      return res.status(400).json({ error: '密码长度需为 6-32 位' });
    }
    if (nickname.length > 12) nickname = nickname.slice(0, 12);
    const exist = query('SELECT id FROM users WHERE username = ?', [username]);
    if (exist.length) return res.status(400).json({ error: '用户名已存在' });
    const hash = await bcrypt.hash(password, 10);
    run('INSERT INTO users (username, password, nickname) VALUES (?, ?, ?)', [username, hash, nickname || username]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const users = query('SELECT * FROM users WHERE username = ?', [username]);
    if (!users.length) return res.status(401).json({ error: '用户名或密码错误' });
    const match = await bcrypt.compare(password, users[0].password);
    if (!match) return res.status(401).json({ error: '用户名或密码错误' });
    req.session.userId = users[0].id;
    req.session.adminMode = false;  // 每次登录默认普通用户，需要管理员请重新输入密码
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', (req, res) => {
  if (!req.session.userId) return res.json(null);
  const users = query('SELECT id, username, nickname, avatar, role, admin_status, birthday, points FROM users WHERE id = ?', [req.session.userId]);
  const u = users[0] || null;
  if (u) u.admin_mode = !!req.session.adminMode;  // 当前会话是否处于管理员模式
  res.json(u);
});

// 修改自己的密码（需验证旧密码）
app.post('/api/account/password', authRequired, async (req, res) => {
  try {
    const oldPwd = String(req.body.oldPassword || '');
    const newPwd = String(req.body.newPassword || '');
    if (newPwd.length < 6 || newPwd.length > 32) {
      return res.status(400).json({ error: '新密码长度需为 6-32 位' });
    }
    const users = query('SELECT * FROM users WHERE id = ?', [req.session.userId]);
    if (!users.length) return res.status(404).json({ error: '用户不存在' });
    const match = await bcrypt.compare(oldPwd, users[0].password);
    if (!match) return res.status(400).json({ error: '原密码不正确' });
    if (newPwd === oldPwd) return res.status(400).json({ error: '新密码不能和原密码一样' });
    const hash = await bcrypt.hash(newPwd, 10);
    run('UPDATE users SET password = ? WHERE id = ?', [hash, req.session.userId]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== 动态接口 =====
// 为带投票的帖子附加：各选项票数、总票数、当前用户的选择
function attachPolls(posts, uid) {
  const pollPosts = posts.filter(p => p.poll);
  if (!pollPosts.length) return posts;
  const ids = pollPosts.map(p => p.id);
  const ph = ids.map(() => '?').join(',');
  const counts = query(`SELECT post_id, option_id, COUNT(*) AS c FROM poll_votes
    WHERE post_id IN (${ph}) GROUP BY post_id, option_id`, ids);
  // 投票人明细（昵称）：投票前也能看到每个选项都有谁投了
  const voterRows = query(`SELECT pv.post_id, pv.option_id, pv.user_id, u.nickname
    FROM poll_votes pv JOIN users u ON u.id = pv.user_id
    WHERE pv.post_id IN (${ph})`, ids);
  const myVotes = uid
    ? query(`SELECT post_id, option_id FROM poll_votes WHERE user_id = ? AND post_id IN (${ph})`, [uid, ...ids]) : [];
  for (const p of pollPosts) {
    let poll;
    try { poll = JSON.parse(p.poll); } catch (e) { poll = null; }
    if (!poll || !Array.isArray(poll.options)) { p.poll = null; continue; }
    poll.results = poll.options.map(o => {
      const voters = voterRows
        .filter(v => v.post_id === p.id && v.option_id === o.id)
        .map(v => ({ user_id: v.user_id, nickname: v.nickname }));
      return {
        option_id: o.id,
        count: counts.filter(c => c.post_id === p.id && c.option_id === o.id)
          .reduce((s, c) => s + c.c, 0),
        voters
      };
    });
    poll.total_votes = poll.results.reduce((s, r) => s + r.count, 0);
    const mine = myVotes.find(v => v.post_id === p.id);
    poll.my_vote = mine ? mine.option_id : 0;
    p.poll = poll;  // 字符串替换为完整对象
  }
  return posts;
}

// 帖子列表通用查询（首页/个人主页/搜索/收藏共用）；sectionId>0 时按分区过滤
function postsSelect(extraWhere, extraParams) {
  const uid = extraParams.uid || 0;
  const device = extraParams.device || '';
  const where = extraWhere.sql || '';
  const posts = query(`SELECT p.*, u.username, u.nickname, u.avatar, s.name AS section_name,
      (SELECT COUNT(*) FROM likes WHERE post_id = p.id) AS like_count,
      (SELECT COUNT(*) FROM comments WHERE post_id = p.id) AS comment_count,
      (EXISTS(SELECT 1 FROM likes WHERE post_id = p.id AND user_id = ? AND ? > 0)
        OR EXISTS(SELECT 1 FROM likes WHERE post_id = p.id AND device_id = ? AND ? <> '')) AS liked,
      EXISTS(SELECT 1 FROM favorites WHERE post_id = p.id AND user_id = ? AND ? > 0) AS favorited
    FROM posts p
    JOIN users u ON p.user_id = u.id
    LEFT JOIN sections s ON p.section_id = s.id
    ${where}
    ORDER BY p.pinned DESC, p.created_at DESC`,
    [uid, uid, device, device, uid, uid, ...extraWhere.params || []]);
  return attachPolls(posts, uid);
}

app.get('/api/posts', (req, res) => {
  const sectionId = parseInt(req.query.sectionId, 10) || 0;
  const cond = sectionId > 0 ? { sql: 'WHERE p.section_id = ?', params: [sectionId] } : { sql: '', params: [] };
  res.json(postsSelect(cond, { uid: req.session.userId || 0, device: String(req.query.device_id || '').slice(0, 64) }));
});

// 分区列表（所有人可查）
app.get('/api/sections', (req, res) => {
  res.json(query('SELECT * FROM sections ORDER BY sort_order ASC, id ASC'));
});

// 搜索（帖子内容 / 昵称 / 用户名）
app.get('/api/search', (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json([]);
  const kw = '%' + q.slice(0, 50) + '%';
  res.json(postsSelect({
    sql: 'WHERE p.content LIKE ? OR u.nickname LIKE ? OR u.username LIKE ?',
    params: [kw, kw, kw]
  }, { uid: req.session.userId || 0, device: String(req.query.device_id || '').slice(0, 64) }));
});

const heicConverter = require('./heic-convert-server');

app.post('/api/posts', authRequired, upload.fields([{ name: 'images', maxCount: 9 }, { name: 'videos', maxCount: 1 }, { name: 'files', maxCount: 5 }]), async (req, res) => {
  try {
    // HEIC 兜底转换：前端转换失败时（如 iPhone HDR 照片），由服务器转成 JPG
    const imgFiles = (req.files && req.files['images']) || [];
    for (const f of imgFiles) {
      if (/\.heic$/i.test(f.filename)) {
        try {
          const newName = await heicConverter.convertToJpg(f.path);
          if (newName) f.filename = newName;
        } catch (e) { /* 转换失败则保留原文件 */ }
      }
    }
    const content = req.body.content || '';
    const images = ((req.files && req.files['images']) || []).map(f => '/uploads/' + f.filename).join(',');
    const videos = ((req.files && req.files['videos']) || []).map(f => '/uploads/' + f.filename).join(',');
    const files = ((req.files && req.files['files']) || []).map(f => '/uploads/' + f.filename).join(',');
    // 校验分区：不存在则归为未分类(0)
    let sectionId = parseInt(req.body.section_id, 10) || 0;
    if (sectionId && !query('SELECT id FROM sections WHERE id = ?', [sectionId]).length) sectionId = 0;
    // 校验投票：至少2个非空选项（最多6个，每项最多30字）
    let pollJson = '';
    if (req.body.poll) {
      try {
        // 表单(FormData)提交时 poll 是字符串需 parse；JSON 提交时已经是对象
        const poll = typeof req.body.poll === 'string' ? JSON.parse(req.body.poll) : req.body.poll;
        // 兼容两种提交：FormData 构建器给的是字符串数组；JSON 可能给 {id,text} 对象数组
        const opts = (poll.options || [])
          .map(o => (typeof o === 'object' && o !== null ? String(o.text || '') : String(o || '')).trim())
          .filter(Boolean).slice(0, 6);
        if (opts.length < 2) return res.status(400).json({ error: '投票至少需要2个选项' });
        pollJson = JSON.stringify({
          options: opts.map((t, i) => ({ id: i + 1, text: t.slice(0, 30) }))
        });
      } catch (e) { return res.status(400).json({ error: '投票数据无效' }); }
    }
    if (!content && !images && !videos && !pollJson) return res.status(400).json({ error: '内容不能为空' });
    const newPostId = insert('INSERT INTO posts (user_id, content, images, videos, files, section_id, poll) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [req.session.userId, content, images, videos, files, sectionId, pollJson]);
    addPoints(req.session.userId, 5);
    // @提及通知
    for (const u of parseMentions(content)) addNotification(u.id, req.session.userId, 'mention', newPostId);
    res.json({ ok: true, id: newPostId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/posts/:id', authRequired, (req, res) => {
  const posts = query('SELECT user_id, images, videos, files FROM posts WHERE id = ?', [req.params.id]);
  if (!posts.length) return res.status(404).json({ error: '不存在' });
  if (posts[0].user_id !== req.session.userId && !req.session.adminMode) {
    return res.status(403).json({ error: '无权删除' });
  }
  // 同步删除帖子对应的图片和附件文件
  for (const col of [posts[0].images, posts[0].videos, posts[0].files]) {
    if (!col) continue;
    for (const name of col.split(',')) {
      if (name) fs.unlink(path.join(UPLOAD_DIR, path.basename(name)), () => {});
    }
  }
  run('DELETE FROM posts WHERE id = ?', [req.params.id]);
  run('DELETE FROM likes WHERE post_id = ?', [req.params.id]);
  run('DELETE FROM comments WHERE post_id = ?', [req.params.id]);
  run('DELETE FROM favorites WHERE post_id = ?', [req.params.id]);
  run('DELETE FROM poll_votes WHERE post_id = ?', [req.params.id]);
  run('DELETE FROM notifications WHERE post_id = ?', [req.params.id]);
  run('DELETE FROM post_views WHERE post_id = ?', [req.params.id]);
  run('DELETE FROM reports WHERE post_id = ?', [req.params.id]);
  res.json({ ok: true });
});

// ===== 点赞接口 =====
// 点赞/取消点赞：登录用户可反复切换；游客（无登录）只能点赞，同一设备只记录一次
app.post('/api/posts/:id/like', (req, res) => {
  const pid = parseInt(req.params.id, 10);
  const postRow = query('SELECT user_id FROM posts WHERE id = ?', [pid]);
  if (!postRow.length) return res.status(404).json({ error: '动态不存在' });
  const { uid, device } = getIdentity(req);
  const authorId = postRow[0].user_id;
  let liked;
  if (uid > 0) {
    const exist = query('SELECT id FROM likes WHERE post_id = ? AND user_id = ?', [pid, uid]);
    if (exist.length) {
      run('DELETE FROM likes WHERE post_id = ? AND user_id = ?', [pid, uid]);
      if (authorId !== uid) addPoints(authorId, -1);  // 取消赞，扣回作者积分
      liked = false;
    } else {
      run('INSERT INTO likes (post_id, user_id, device_id) VALUES (?, ?, ?)', [pid, uid, '']);
      if (authorId !== uid) addPoints(authorId, 1);
      addNotification(authorId, uid, 'like', pid);
      liked = true;
    }
  } else {
    if (!device) return res.status(400).json({ error: '设备标识缺失，请刷新页面重试' });
    const exist = query('SELECT id FROM likes WHERE post_id = ? AND user_id = 0 AND device_id = ?', [pid, device]);
    if (exist.length) return res.status(409).json({ error: '这台设备已经赞过啦', liked: true });
    run('INSERT INTO likes (post_id, user_id, device_id) VALUES (?, 0, ?)', [pid, device]);
    addPoints(authorId, 1);  // 游客赞也给作者加分（游客无法取消，不扣回）
    addNotification(authorId, 0, 'like', pid);
    liked = true;
  }
  const count = query('SELECT COUNT(*) as c FROM likes WHERE post_id = ?', [pid])[0].c;
  res.json({ ok: true, likeCount: count, liked });
});

// 举报帖子（登录即可；不能举报自己；同一人对同一帖只能举报一次）
app.post('/api/posts/:id/report', authRequired, (req, res) => {
  const pid = parseInt(req.params.id, 10);
  const uid = req.session.userId;
  const post = query('SELECT user_id FROM posts WHERE id = ?', [pid]);
  if (!post.length) return res.status(404).json({ error: '动态不存在' });
  if (post[0].user_id === uid) return res.status(400).json({ error: '不能举报自己的动态' });
  const reason = String(req.body.reason || '').trim().slice(0, 100);
  const exist = query('SELECT id, status FROM reports WHERE post_id = ? AND reporter_id = ?', [pid, uid]);
  if (exist.length && exist[0].status === 'open') return res.status(409).json({ error: '你已经举报过这条动态，请等待管理员处理' });
  if (exist.length) {
    run('UPDATE reports SET status = ?, reason = ?, created_at = CURRENT_TIMESTAMP WHERE id = ?', ['open', reason, exist[0].id]);
  } else {
    run('INSERT INTO reports (post_id, reporter_id, reason) VALUES (?, ?, ?)', [pid, uid, reason]);
  }
  res.json({ ok: true });
});

app.get('/api/posts/:id/likes', (req, res) => {
  const list = query(`SELECT l.*, u.username, u.nickname FROM likes l
    JOIN users u ON l.user_id = u.id WHERE l.post_id = ?`, [req.params.id]);
  res.json(list);
});

// ===== 评论接口 =====
// 游客评论 user_id=0，昵称取 guest_name（LEFT JOIN 防止游客评论被 JOIN 丢掉）
const COMMENT_SELECT = `SELECT c.*, u.username, u.avatar,
    CASE WHEN c.user_id > 0 THEN u.nickname ELSE c.guest_name END AS nickname
  FROM comments c
  LEFT JOIN users u ON c.user_id = u.id`;
// c.* 已含 image 列，无需额外列出

app.get('/api/posts/:id/comments', (req, res) => {
  const list = query(`${COMMENT_SELECT} WHERE c.post_id = ? ORDER BY c.created_at ASC`, [req.params.id]);
  res.json(list);
});

// 登录用户和游客都可以发多条评论/回复；游客仅记录设备号用于展示归属，不限制条数
// （点赞仍是一设备一次，见 /api/posts/:id/like）
app.post('/api/posts/:id/comments', (req, res) => {
  const pid = parseInt(req.params.id, 10);
  const { uid, device } = getIdentity(req);
  const content = String(req.body.content || '').trim();
  const image = String(req.body.image || '').trim().slice(0, 300);
  // 图片路径只允许本站 /uploads/ 下的文件
  if (image && !/^\/uploads\/[\w.\-]+$/i.test(image)) return res.status(400).json({ error: '图片地址无效' });
  let parentId = parseInt(req.body.parent_id, 10);
  if (!Number.isFinite(parentId) || parentId < 0) parentId = 0;
  if (!content && !image) return res.status(400).json({ error: '评论内容不能为空' });
  if (content.length > 2000) return res.status(400).json({ error: '评论最多 2000 字' });
  const post = query('SELECT user_id FROM posts WHERE id = ?', [pid]);
  if (!post.length) return res.status(404).json({ error: '动态不存在' });
  let guestName = '';
  if (uid === 0) {
    if (!device) return res.status(400).json({ error: '设备标识缺失，请刷新页面重试' });
    guestName = String(req.body.guest_name || '').trim().slice(0, 12) || '游客';
  }
  // 如果指定了父评论，要校验它属于本帖（防止跨帖回帖）
  let parentUid = 0;
  if (parentId > 0) {
    const pc = query('SELECT id, user_id, post_id FROM comments WHERE id = ?', [parentId]);
    if (!pc.length) return res.status(400).json({ error: '父评论不存在' });
    if (String(pc[0].post_id) !== String(pid)) return res.status(400).json({ error: '父评论不属于本帖' });
    parentUid = pc[0].user_id;
  }
  const actorId = uid || 0;
  const newId = insert(
    'INSERT INTO comments (post_id, user_id, device_id, guest_name, content, image, parent_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [pid, uid, uid > 0 ? '' : device, guestName, content, image, parentId]);
  const row = query(`${COMMENT_SELECT} WHERE c.id = ?`, [newId])[0];
  // 积分：评论者 +1；帖子作者收到评论 +2（自己评自己不重复加）
  if (uid > 0) addPoints(uid, 1);
  if (post[0].user_id !== actorId) addPoints(post[0].user_id, 2);
  // 通知：帖子作者 + 父评论作者 + 被 @ 的人（actor=0 时通知里显示"游客"）
  addNotification(post[0].user_id, actorId, 'comment', pid, content);
  if (parentUid && parentUid !== actorId && parentUid !== post[0].user_id) {
    addNotification(parentUid, actorId, 'comment', pid, content);
  }
  for (const u of parseMentions(content)) {
    if (uid > 0 && u.id === uid) continue;
    addNotification(u.id, actorId, 'mention', pid, content);
  }
  res.json(row);
});

// 递归删除一条评论及其所有子回复（楼中楼：删父评论连同所有回复一起删）
function deleteCommentTree(id) {
  const children = query('SELECT id FROM comments WHERE parent_id = ?', [id]);
  for (const ch of children) deleteCommentTree(ch.id);
  db.run('DELETE FROM comments WHERE id = ?', [id]);
}

// 评论图片/表情包上传（仅登录用户；先上传拿 URL，再随评论内容一起提交）
const commentImageUpload = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024 },  // 评论图最大 8MB
  fileFilter: (req, file, cb) => cb(null, /^image\/(jpe?g|png|gif|webp)$/i.test(file.mimetype))
});
app.post('/api/upload/comment-image', authRequired, commentImageUpload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '请选择图片文件' });
  res.json({ ok: true, url: '/uploads/' + req.file.filename });
});

app.delete('/api/comments/:id', authRequired, (req, res) => {
  const c = query('SELECT user_id FROM comments WHERE id = ?', [req.params.id]);
  if (!c.length) return res.status(404).json({ error: '不存在' });
  if (c[0].user_id !== req.session.userId && !req.session.adminMode) {
    return res.status(403).json({ error: '无权删除' });
  }
  deleteCommentTree(parseInt(req.params.id, 10));
  saveDB();
  res.json({ ok: true });
});

// ===== 置顶接口（管理员） =====
app.post('/api/posts/:id/pin', adminRequired, (req, res) => {
  const posts = query('SELECT id, pinned FROM posts WHERE id = ?', [req.params.id]);
  if (!posts.length) return res.status(404).json({ error: '动态不存在' });
  const pinned = posts[0].pinned ? 0 : 1;
  run('UPDATE posts SET pinned = ? WHERE id = ?', [pinned, req.params.id]);
  res.json({ ok: true, pinned });
});

// ===== 移动帖子到分区（管理员，可移动任何人的帖子） =====
app.post('/api/posts/:id/section', adminRequired, (req, res) => {
  const posts = query('SELECT id FROM posts WHERE id = ?', [req.params.id]);
  if (!posts.length) return res.status(404).json({ error: '动态不存在' });
  let sectionId = parseInt(req.body.section_id, 10) || 0;
  if (sectionId && !query('SELECT id FROM sections WHERE id = ?', [sectionId]).length) {
    return res.status(400).json({ error: '分区不存在' });
  }
  run('UPDATE posts SET section_id = ? WHERE id = ?', [sectionId, req.params.id]);
  res.json({ ok: true, section_id: sectionId });
});

// ===== 编辑帖子（作者本人或管理员；只改文字） =====
app.post('/api/posts/:id/edit', authRequired, (req, res) => {
  const posts = query('SELECT user_id FROM posts WHERE id = ?', [req.params.id]);
  if (!posts.length) return res.status(404).json({ error: '动态不存在' });
  if (posts[0].user_id !== req.session.userId && !req.session.adminMode) {
    return res.status(403).json({ error: '无权编辑' });
  }
  const content = (req.body.content || '').trim();
  if (!content) return res.status(400).json({ error: '内容不能为空' });
  run('UPDATE posts SET content = ? WHERE id = ?', [content.slice(0, 5000), req.params.id]);
  res.json({ ok: true, content });
});

// ===== 浏览量 +1 =====
// 登录用户：按 user_id 跨会话去重（重新登录、换设备登录同一账号都会被认成同一人）
// 未登录游客：按 device_id（前端 localStorage 持久串）去重，同一浏览器只算一次
app.post('/api/posts/:id/view', (req, res) => {
  const pid = parseInt(req.params.id, 10);
  const posts = query('SELECT id FROM posts WHERE id = ?', [pid]);
  if (!posts.length) return res.status(404).json({ error: '动态不存在' });

  const uid = req.session.userId || 0;
  const deviceId = String(req.body && req.body.device_id || '').slice(0, 64);
  // 先查是否已记录过本次浏览
  let already;
  if (uid > 0) {
    already = query('SELECT id FROM post_views WHERE post_id = ? AND user_id = ?', [pid, uid]).length > 0;
  } else if (deviceId) {
    already = query('SELECT id FROM post_views WHERE post_id = ? AND user_id = 0 AND device_id = ?', [pid, deviceId]).length > 0;
  } else {
    // 啥都没有：回退到 session.viewedPosts（最老式防刷）
    const seen = req.session.viewedPosts || [];
    already = seen.includes(pid);
    if (!already) { seen.push(pid); req.session.viewedPosts = seen; }
  }
  if (!already) {
    run('INSERT INTO post_views (post_id, user_id, device_id) VALUES (?, ?, ?)', [pid, uid, uid > 0 ? '' : deviceId]);
    run('UPDATE posts SET view_count = view_count + 1 WHERE id = ?', [pid]);
  }
  const viewCount = query('SELECT view_count FROM posts WHERE id = ?', [pid])[0].view_count;
  res.json({ ok: true, viewCount });
});

// ===== 收藏 / 取消收藏 =====
app.post('/api/posts/:id/favorite', authRequired, (req, res) => {
  const posts = query('SELECT id FROM posts WHERE id = ?', [req.params.id]);
  if (!posts.length) return res.status(404).json({ error: '动态不存在' });
  const exist = query('SELECT id FROM favorites WHERE post_id = ? AND user_id = ?',
    [req.params.id, req.session.userId]);
  let favorited;
  if (exist.length) {
    run('DELETE FROM favorites WHERE post_id = ? AND user_id = ?', [req.params.id, req.session.userId]);
    favorited = false;
  } else {
    run('INSERT INTO favorites (post_id, user_id) VALUES (?, ?)', [req.params.id, req.session.userId]);
    favorited = true;
  }
  res.json({ ok: true, favorited });
});

// 我的收藏列表
app.get('/api/favorites', authRequired, (req, res) => {
  res.json(postsSelect({
    sql: 'JOIN favorites f ON f.post_id = p.id WHERE f.user_id = ?',
    params: [req.session.userId]
  }, { uid: req.session.userId }));
});

// ===== 投票（可改票；一人一票） =====
app.post('/api/posts/:id/vote', authRequired, (req, res) => {
  const posts = query('SELECT poll, user_id FROM posts WHERE id = ?', [req.params.id]);
  if (!posts.length) return res.status(404).json({ error: '动态不存在' });
  let poll;
  try { poll = JSON.parse(posts[0].poll); } catch (e) { poll = null; }
  const optionId = parseInt(req.body.option_id, 10);
  if (!poll || !poll.options.some(o => o.id === optionId)) {
    return res.status(400).json({ error: '投票选项无效' });
  }
  // 改票前先看这个人之前投没投过：只有"新人第一次投票"才通知发起人，避免改票反复打扰
  const hadVoted = query('SELECT 1 FROM poll_votes WHERE post_id = ? AND user_id = ?',
    [req.params.id, req.session.userId]).length > 0;
  run('DELETE FROM poll_votes WHERE post_id = ? AND user_id = ?', [req.params.id, req.session.userId]);
  run('INSERT INTO poll_votes (post_id, option_id, user_id) VALUES (?, ?, ?)',
    [req.params.id, optionId, req.session.userId]);

  if (!hadVoted) {
    const creatorId = posts[0].user_id;
    const voter = query('SELECT nickname FROM users WHERE id = ?', [req.session.userId])[0];
    const optText = (poll.options.find(o => o.id === optionId) || {}).text || '';
    // 不给自己发通知
    if (creatorId !== req.session.userId && voter) {
      insert('INSERT INTO notifications (user_id, actor_id, type, post_id, content) VALUES (?, ?, ?, ?, ?)',
        [creatorId, req.session.userId, 'poll', req.params.id,
          `投了「${optText.slice(0, 30)}」`]);
    }
  }

  const rows = query(`SELECT pv.option_id, u.id AS uid, u.nickname
    FROM poll_votes pv JOIN users u ON u.id = pv.user_id
    WHERE pv.post_id = ?`, [req.params.id]);
  const total = rows.length;
  res.json({
    ok: true,
    results: poll.options.map(o => ({
      option_id: o.id,
      count: rows.filter(r => r.option_id === o.id).length,
      voters: rows.filter(r => r.option_id === o.id).map(r => ({ user_id: r.uid, nickname: r.nickname }))
    })),
    total_votes: total,
    my_vote: optionId
  });
});

// ===== 分区（模块）管理：新增 / 删除（管理员） =====
app.post('/api/sections', adminRequired, (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: '分区名称不能为空' });
  if (name.length > 12) return res.status(400).json({ error: '分区名称最多12个字' });
  if (query('SELECT id FROM sections WHERE name = ?', [name]).length) {
    return res.status(400).json({ error: '该分区已存在' });
  }
  const maxOrder = query('SELECT COALESCE(MAX(sort_order), 0) AS m FROM sections')[0].m;
  const id = insert('INSERT INTO sections (name, sort_order) VALUES (?, ?)', [name, maxOrder + 1]);
  res.json({ ok: true, id });
});

app.delete('/api/sections/:id', adminRequired, (req, res) => {
  const sections = query('SELECT id FROM sections WHERE id = ?', [req.params.id]);
  if (!sections.length) return res.status(404).json({ error: '分区不存在' });
  // 该分区下的帖子不删除，回归"未分类"
  run('UPDATE posts SET section_id = 0 WHERE section_id = ?', [req.params.id]);
  run('DELETE FROM sections WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
});

// ===== 头像接口 =====
const avatarUpload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });  // 头像最大 5MB
app.post('/api/avatar', authRequired, avatarUpload.single('avatar'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '请选择图片' });
  run('UPDATE users SET avatar = ? WHERE id = ?', ['/uploads/' + req.file.filename, req.session.userId]);
  res.json({ ok: true, avatar: '/uploads/' + req.file.filename });
});
app.post('/api/avatar/preset', authRequired, (req, res) => {
  const { avatar } = req.body;
  if (!/^emoji:.$/u.test(avatar || '')) return res.status(400).json({ error: '无效头像' });
  run('UPDATE users SET avatar = ? WHERE id = ?', [avatar, req.session.userId]);
  res.json({ ok: true, avatar });
});

// ===== 个人主页接口 =====
// 所有登录用户可查看同学列表（含头像/昵称/加入时间/发帖数/获赞数/在线状态）
app.get('/api/users', authRequired, (req, res) => {
  const list = query(`SELECT u.id, u.username, u.nickname, u.avatar, u.created_at,
      (SELECT COUNT(*) FROM posts WHERE user_id = u.id) AS post_count,
      (SELECT COUNT(*) FROM likes l JOIN posts p ON l.post_id = p.id WHERE p.user_id = u.id) AS like_received
    FROM users u
    ORDER BY u.created_at ASC`);
  res.json(list.map(u => ({
    id: u.id, username: u.username, nickname: u.nickname,
    avatar: u.avatar, created_at: u.created_at,
    post_count: u.post_count, like_received: u.like_received,
    online: isOnline(u.id)
  })));
});

app.get('/api/users/:id', (req, res) => {
  const tid = parseInt(req.params.id, 10);
  const users = query('SELECT id, username, nickname, avatar, created_at, birthday, points FROM users WHERE id = ?', [tid]);
  if (!users.length) return res.status(404).json({ error: '用户不存在' });
  const u = users[0];
  u.online = isOnline(tid);
  // 记录主页访客（登录用户、不是看自己）
  const me = req.session.userId || 0;
  if (me && me !== tid) {
    run(`INSERT INTO profile_visits (target_uid, visitor_uid, visited_at) VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(target_uid, visitor_uid) DO UPDATE SET visited_at = CURRENT_TIMESTAMP`, [tid, me]);
  }
  res.json(u);
});

// 设置自己的生日（MM-DD，只记月日不记年份，避免年龄隐私）
app.post('/api/account/birthday', authRequired, (req, res) => {
  const b = String(req.body.birthday || '').trim();
  if (b) {
    const m = b.match(/^(\d{2})-(\d{2})$/);
    if (!m) return res.status(400).json({ error: '生日格式应为 月-日，如 08-15' });
    const mo = parseInt(m[1], 10), da = parseInt(m[2], 10);
    if (mo < 1 || mo > 12 || da < 1 || da > 31) return res.status(400).json({ error: '生日日期不正确' });
  }
  run('UPDATE users SET birthday = ? WHERE id = ?', [b, req.session.userId]);
  res.json({ ok: true, birthday: b });
});

// 生日墙：今天过生日的 + 未来 60 天内即将过生日的（按距今天数排序）
app.get('/api/birthdays', (req, res) => {
  const today = new Date();
  const fmt = d => String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  const users = query("SELECT id, nickname, username, avatar, birthday FROM users WHERE birthday <> ''");
  const todayMD = fmt(today);
  const todayList = [], upcoming = [];
  for (const u of users) {
    if (u.birthday === todayMD) { todayList.push(u); continue; }
    // 计算下一个生日距今天数
    const yy = today.getFullYear();
    const [mo, da] = u.birthday.split('-').map(Number);
    let next = new Date(yy, mo - 1, da);
    if (next < today) next = new Date(yy + 1, mo - 1, da);
    const days = Math.round((next - new Date(today.getFullYear(), today.getMonth(), today.getDate())) / 86400000);
    if (days <= 60) upcoming.push(Object.assign({ days }, u));
  }
  upcoming.sort((a, b) => a.days - b.days);
  res.json({ today: todayList, upcoming: upcoming.slice(0, 20) });
});

// 主页最近访客（仅主页主人可看）
app.get('/api/users/:id/visitors', authRequired, (req, res) => {
  const tid = parseInt(req.params.id, 10);
  if (tid !== req.session.userId && !req.session.adminMode) return res.status(403).json({ error: '只能查看自己主页的访客' });
  const list = query(`SELECT v.visited_at, u.id, u.nickname, u.username, u.avatar
    FROM profile_visits v JOIN users u ON v.visitor_uid = u.id
    WHERE v.target_uid = ? ORDER BY v.visited_at DESC LIMIT 12`, [tid]);
  res.json(list.map(u => Object.assign(u, { online: isOnline(u.id) })));
});

// ===== 个人主页留言板（电子同学录）=====
app.get('/api/users/:id/board', (req, res) => {
  const tid = parseInt(req.params.id, 10);
  if (!query('SELECT id FROM users WHERE id = ?', [tid]).length) return res.status(404).json({ error: '用户不存在' });
  const list = query(`SELECT b.*, u.nickname, u.username, u.avatar
    FROM board_messages b JOIN users u ON b.author_uid = u.id
    WHERE b.target_uid = ? ORDER BY b.created_at DESC LIMIT 50`, [tid]);
  res.json(list);
});

app.post('/api/users/:id/board', authRequired, (req, res) => {
  const tid = parseInt(req.params.id, 10);
  if (!query('SELECT id FROM users WHERE id = ?', [tid]).length) return res.status(404).json({ error: '用户不存在' });
  const content = String(req.body.content || '').trim().slice(0, 300);
  if (!content) return res.status(400).json({ error: '留言内容不能为空' });
  const id = insert('INSERT INTO board_messages (target_uid, author_uid, content) VALUES (?, ?, ?)',
    [tid, req.session.userId, content]);
  addPoints(req.session.userId, 1);
  if (tid !== req.session.userId) {
    addPoints(tid, 1);  // 收到同学留言也加分
    addNotification(tid, req.session.userId, 'board', 0, content);
  }
  res.json({ ok: true, id });
});

// 删除留言：留言作者、主页主人或管理员可以删
app.delete('/api/board/:mid', authRequired, (req, res) => {
  const mid = parseInt(req.params.mid, 10);
  const row = query('SELECT target_uid, author_uid FROM board_messages WHERE id = ?', [mid]);
  if (!row.length) return res.status(404).json({ error: '留言不存在' });
  const uid = req.session.userId;
  if (row[0].author_uid !== uid && row[0].target_uid !== uid && !req.session.adminMode) {
    return res.status(403).json({ error: '无权删除' });
  }
  run('DELETE FROM board_messages WHERE id = ?', [mid]);
  res.json({ ok: true });
});

// 心跳：前端每 30 秒上报一次，刷新在线状态（onlineMap 中间件也会更新，此接口显式兜底）
app.post('/api/ping', authRequired, (req, res) => res.json({ ok: true }));

// ===== #话题# =====
// 从帖子正文里统计 #话题# 出现的帖子数（同一帖同一话题只计一次）
function extractTopics(content) {
  const re = /#([^#\s#，。,.!?！？]{1,20})#/g;
  const set = new Set();
  let m;
  while ((m = re.exec(content || '')) !== null) set.add(m[1]);
  return [...set];
}
app.get('/api/topics', (req, res) => {
  const posts = query("SELECT content FROM posts WHERE content LIKE '%#%'");
  const counts = {};
  for (const p of posts) {
    for (const t of extractTopics(p.content)) counts[t] = (counts[t] || 0) + 1;
  }
  const list = Object.entries(counts).map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count).slice(0, 20);
  res.json(list);
});

app.get('/api/topic/:tag', (req, res) => {
  const tag = String(req.params.tag || '').slice(0, 20);
  if (!tag) return res.status(400).json({ error: '话题不能为空' });
  const rows = postsSelect({ sql: 'WHERE p.content LIKE ?', params: ['%#' + tag + '#%'] },
    { uid: req.session.userId || 0, device: String(req.query.device_id || '').slice(0, 64) });
  res.json(rows);
});

// ===== 积分 / 签到排行榜 =====
app.get('/api/rank', authRequired, (req, res) => {
  const points = query(`SELECT id, nickname, username, avatar, points FROM users
    ORDER BY points DESC, id ASC LIMIT 20`)
    .map((u, i) => Object.assign(u, { rank: i + 1, online: isOnline(u.id) }));
  const checkin = query(`SELECT u.id, u.nickname, u.username, u.avatar, COUNT(c.id) AS total
    FROM users u LEFT JOIN checkins c ON c.user_id = u.id
    GROUP BY u.id ORDER BY total DESC, u.id ASC LIMIT 20`)
    .map((u, i) => Object.assign(u, { rank: i + 1, online: isOnline(u.id) }));
  // 我的排名（即使不在前 20 也要显示自己）
  const uid = req.session.userId;
  const myPoints = query('SELECT points FROM users WHERE id = ?', [uid])[0]?.points || 0;
  const myPointsRank = query('SELECT COUNT(*) AS c FROM users WHERE points > ?', [myPoints])[0].c + 1;
  const myCheckin = query('SELECT COUNT(*) AS c FROM checkins WHERE user_id = ?', [uid])[0].c;
  const myCheckinRank = query(`SELECT COUNT(*) AS c FROM (
    SELECT user_id, COUNT(*) AS n FROM checkins GROUP BY user_id HAVING n > ?)`, [myCheckin])[0].c + 1;
  res.json({
    points, checkin,
    me: { points: myPoints, points_rank: myPointsRank, checkin: myCheckin, checkin_rank: myCheckinRank }
  });
});

app.get('/api/users/:id/posts', (req, res) => {
  res.json(postsSelect({ sql: 'WHERE p.user_id = ?', params: [req.params.id] },
    { uid: req.session.userId || 0, device: String(req.query.device_id || '').slice(0, 64) }));
});

// ===== 私聊 / 群聊 =====
// 校验当前用户是会话成员
function ensureMember(convId, uid) {
  return query('SELECT id FROM conversation_members WHERE conversation_id = ? AND user_id = ?',
    [convId, uid]).length > 0;
}

// 会话展示名：群聊用 name，一对一用对方昵称
function conversationDisplay(conv, uid) {
  if (conv.type === 'group') return conv.name || '未命名群聊';
  // direct：取另一个成员的昵称
  const other = query(`SELECT u.id, u.nickname, u.username, u.avatar FROM conversation_members m
    JOIN users u ON m.user_id = u.id
    WHERE m.conversation_id = ? AND m.user_id != ?`, [conv.id, uid])[0];
  if (!other) return '已退出';
  return other.nickname || other.username;
}

// 我的会话列表（带最新消息预览、未读数、对方头像）
app.get('/api/conversations', authRequired, (req, res) => {
  const uid = req.session.userId;
  const convs = query(`SELECT c.*, m.last_read_at
    FROM conversations c
    JOIN conversation_members m ON m.conversation_id = c.id
    WHERE m.user_id = ?
    ORDER BY (SELECT MAX(created_at) FROM messages WHERE conversation_id = c.id) DESC`, [uid]);
  const result = convs.map(c => {
    const lastMsg = query(`SELECT content, type, sender_id, created_at FROM messages
      WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 1`, [c.id])[0];
    const unread = query(`SELECT COUNT(*) AS c FROM messages
      WHERE conversation_id = ? AND sender_id != ? AND created_at > ?`,
      [c.id, uid, c.last_read_at])[0].c;
    // 群聊用群名，一对一用对方信息
    let displayName, displayAvatar = '', peerId = null, peerOnline = false;
    if (c.type === 'group') {
      displayName = c.name || '未命名群聊';
      // 群聊用第一个成员头像占位（前端会处理）
    } else {
      const other = query(`SELECT u.id, u.nickname, u.username, u.avatar FROM conversation_members m
        JOIN users u ON m.user_id = u.id
        WHERE m.conversation_id = ? AND m.user_id != ?`, [c.id, uid])[0];
      if (other) {
        displayName = other.nickname || other.username;
        displayAvatar = other.avatar;
        peerId = other.id;
        peerOnline = isOnline(other.id);
      } else { displayName = '已退出'; }
    }
    return {
      id: c.id, type: c.type, name: displayName, avatar: displayAvatar,
      peer_id: peerId, peer_online: peerOnline,
      last_message: lastMsg ? { content: lastMsg.content, type: lastMsg.type, sender_id: lastMsg.sender_id, created_at: lastMsg.created_at } : null,
      unread,
      created_at: c.created_at
    };
  });
  res.json(result);
});

// 未读总数（用于导航栏红点）
app.get('/api/conversations/unread', authRequired, (req, res) => {
  const uid = req.session.userId;
  const c = query(`SELECT COUNT(*) AS c FROM messages msg
    JOIN conversation_members m ON m.conversation_id = msg.conversation_id
    WHERE m.user_id = ? AND msg.sender_id != ? AND msg.created_at > m.last_read_at`, [uid, uid])[0].c;
  res.json({ unread: c });
});

// 创建或获取与某用户的一对一会话
app.post('/api/conversations/direct/:userId', authRequired, (req, res) => {
  const uid = req.session.userId;
  const targetId = parseInt(req.params.userId, 10);
  if (targetId === uid) return res.status(400).json({ error: '不能和自己私聊' });
  const target = query('SELECT id FROM users WHERE id = ?', [targetId]);
  if (!target.length) return res.status(404).json({ error: '用户不存在' });
  // 查是否已有一对一会话
  let conv = query(`SELECT c.id FROM conversations c
    WHERE c.type = 'direct'
    AND EXISTS (SELECT 1 FROM conversation_members WHERE conversation_id = c.id AND user_id = ?)
    AND EXISTS (SELECT 1 FROM conversation_members WHERE conversation_id = c.id AND user_id = ?)`,
    [uid, targetId])[0];
  if (!conv) {
    const newId = insert(`INSERT INTO conversations (type, name, creator_id) VALUES ('direct', '', ?)`, [uid]);
    run('INSERT INTO conversation_members (conversation_id, user_id) VALUES (?, ?)', [newId, uid]);
    run('INSERT INTO conversation_members (conversation_id, user_id) VALUES (?, ?)', [newId, targetId]);
    return res.json({ id: newId });
  }
  res.json({ id: conv.id });
});

// 创建群聊
app.post('/api/conversations/group', authRequired, (req, res) => {
  const uid = req.session.userId;
  const name = String(req.body.name || '').trim().slice(0, 30) || '群聊';
  const memberIds = (req.body.memberIds || []).filter(id => Number(id) && Number(id) !== uid);
  if (memberIds.length < 1) return res.status(400).json({ error: '至少邀请 1 位其他成员' });
  // 校验所有成员都存在
  const valid = query(`SELECT id FROM users WHERE id IN (${memberIds.map(() => '?').join(',')})`, memberIds);
  if (valid.length !== memberIds.length) return res.status(400).json({ error: '部分用户不存在' });
  const newId = insert(`INSERT INTO conversations (type, name, creator_id) VALUES ('group', ?, ?)`, [name, uid]);
  run('INSERT INTO conversation_members (conversation_id, user_id) VALUES (?, ?)', [newId, uid]);
  for (const mid of memberIds) {
    run('INSERT INTO conversation_members (conversation_id, user_id) VALUES (?, ?)', [newId, Number(mid)]);
  }
  res.json({ id: newId, name });
});

// 群主加成员
app.post('/api/conversations/:id/members', authRequired, (req, res) => {
  const uid = req.session.userId;
  const convId = parseInt(req.params.id, 10);
  const conv = query('SELECT * FROM conversations WHERE id = ?', [convId])[0];
  if (!conv) return res.status(404).json({ error: '会话不存在' });
  if (conv.type !== 'group') return res.status(400).json({ error: '一对一会话不支持加人' });
  if (conv.creator_id !== uid) return res.status(403).json({ error: '仅群主可加成员' });
  const newMemberId = parseInt(req.body.userId, 10);
  if (!newMemberId) return res.status(400).json({ error: '参数错误' });
  const exist = query('SELECT id FROM users WHERE id = ?', [newMemberId]);
  if (!exist.length) return res.status(404).json({ error: '用户不存在' });
  const already = query('SELECT id FROM conversation_members WHERE conversation_id = ? AND user_id = ?', [convId, newMemberId]);
  if (already.length) return res.status(400).json({ error: '该用户已在群中' });
  run('INSERT INTO conversation_members (conversation_id, user_id) VALUES (?, ?)', [convId, newMemberId]);
  res.json({ ok: true });
});

// 群主踢人 / 自己退群
app.delete('/api/conversations/:id/members/:userId', authRequired, (req, res) => {
  const uid = req.session.userId;
  const convId = parseInt(req.params.id, 10);
  const targetId = parseInt(req.params.userId, 10);
  const conv = query('SELECT * FROM conversations WHERE id = ?', [convId])[0];
  if (!conv) return res.status(404).json({ error: '会话不存在' });
  if (conv.type !== 'group') return res.status(400).json({ error: '一对一会话不支持移除成员' });
  // 仅群主可踢人，自己可退群
  if (targetId !== uid && conv.creator_id !== uid) return res.status(403).json({ error: '仅群主可移除他人' });
  if (targetId === conv.creator_id) return res.status(400).json({ error: '群主不可退出' });
  run('DELETE FROM conversation_members WHERE conversation_id = ? AND user_id = ?', [convId, targetId]);
  res.json({ ok: true });
});

// 拉取会话消息（支持 ?after=id 增量拉取，前端轮询用）
app.get('/api/conversations/:id/messages', authRequired, (req, res) => {
  const uid = req.session.userId;
  const convId = parseInt(req.params.id, 10);
  if (!ensureMember(convId, uid)) return res.status(403).json({ error: '你不是会话成员' });
  const afterId = parseInt(req.query.after, 10) || 0;
  const msgs = query(`SELECT m.*, u.nickname AS sender_nickname, u.avatar AS sender_avatar
    FROM messages m JOIN users u ON m.sender_id = u.id
    WHERE m.conversation_id = ? AND m.id > ?
    ORDER BY m.created_at ASC, m.id ASC LIMIT 200`, [convId, afterId]);
  res.json(msgs);
});

// 发送文字消息
app.post('/api/conversations/:id/messages', authRequired, (req, res) => {
  const uid = req.session.userId;
  const convId = parseInt(req.params.id, 10);
  if (!ensureMember(convId, uid)) return res.status(403).json({ error: '你不是会话成员' });
  const content = String(req.body.content || '').trim();
  if (!content) return res.status(400).json({ error: '消息内容不能为空' });
  const id = insert('INSERT INTO messages (conversation_id, sender_id, type, content) VALUES (?, ?, ?, ?)',
    [convId, uid, 'text', content.slice(0, 2000)]);
  // 群聊里 @ 了谁，就给谁发一条通知（只通知本群成员；私聊不发，未读消息本身就会提醒）
  const conv = query('SELECT type FROM conversations WHERE id = ?', [convId])[0];
  if (conv && conv.type === 'group') {
    const memberIds = query('SELECT user_id FROM conversation_members WHERE conversation_id = ?', [convId])
      .map(r => r.user_id);
    for (const u of parseMentions(content)) {
      if (u.id !== uid && memberIds.includes(u.id)) {
        addNotification(u.id, uid, 'chat_mention', null, content, convId);
      }
    }
  }
  const row = query(`SELECT m.*, u.nickname AS sender_nickname, u.avatar AS sender_avatar
    FROM messages m JOIN users u ON m.sender_id = u.id WHERE m.id = ?`, [id])[0];
  res.json(row);
});

// 发送图片消息（multipart 上传，单图限 10MB；独立限制，不走帖子附件的 200MB）
const msgImageUpload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } }).single('image');
app.post('/api/conversations/:id/messages/image', authRequired, msgImageUpload, (req, res) => {
  const uid = req.session.userId;
  const convId = parseInt(req.params.id, 10);
  if (!ensureMember(convId, uid)) return res.status(403).json({ error: '你不是会话成员' });
  const f = req.file;
  if (!f) return res.status(400).json({ error: '未上传图片' });
  const url = '/uploads/' + f.filename;
  const id = insert('INSERT INTO messages (conversation_id, sender_id, type, content) VALUES (?, ?, ?, ?)',
    [convId, uid, 'image', url]);
  const row = query(`SELECT m.*, u.nickname AS sender_nickname, u.avatar AS sender_avatar
    FROM messages m JOIN users u ON m.sender_id = u.id WHERE m.id = ?`, [id])[0];
  res.json(row);
});

// 发送文件消息（multipart 上传，单文件限 100MB；content 存 JSON：url/原始文件名/大小）
const msgFileUpload = multer({ storage, limits: { fileSize: 100 * 1024 * 1024 } }).single('file');
app.post('/api/conversations/:id/messages/file', authRequired, msgFileUpload, (req, res) => {
  const uid = req.session.userId;
  const convId = parseInt(req.params.id, 10);
  if (!ensureMember(convId, uid)) {
    // 文件已被 multer 落盘但发送者不是成员：删掉，不留垃圾
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(403).json({ error: '你不是会话成员' });
  }
  const f = req.file;
  if (!f) return res.status(400).json({ error: '未选择文件（单个文件最大 100MB）' });
  // multer/busboy 默认按 latin1 解码文件名，中文需要转回 UTF-8（纯 ASCII 不受影响）
  let origName;
  try { origName = Buffer.from(f.originalname, 'latin1').toString('utf8'); }
  catch (e) { origName = f.originalname; }
  origName = path.basename(origName).replace(/[\x00-\x1f]/g, '').slice(0, 200) || '未命名文件';
  const meta = JSON.stringify({ url: '/uploads/' + f.filename, name: origName, size: f.size || 0 });
  const id = insert('INSERT INTO messages (conversation_id, sender_id, type, content) VALUES (?, ?, ?, ?)',
    [convId, uid, 'file', meta]);
  const row = query(`SELECT m.*, u.nickname AS sender_nickname, u.avatar AS sender_avatar
    FROM messages m JOIN users u ON m.sender_id = u.id WHERE m.id = ?`, [id])[0];
  res.json(row);
});

// 撤回消息：只能撤回自己发的，且发送不超过 2 分钟
app.post('/api/conversations/:id/messages/:mid/recall', authRequired, (req, res) => {
  const uid = req.session.userId;
  const convId = parseInt(req.params.id, 10);
  const mid = parseInt(req.params.mid, 10);
  if (!ensureMember(convId, uid)) return res.status(403).json({ error: '你不是会话成员' });
  const msg = query('SELECT id, sender_id, type, content FROM messages WHERE id = ? AND conversation_id = ?',
    [mid, convId])[0];
  if (!msg) return res.status(404).json({ error: '消息不存在' });
  if (msg.sender_id !== uid) return res.status(403).json({ error: '只能撤回自己发送的消息' });
  // created_at 是 UTC，直接在 SQLite 里算年龄（分钟）
  const mins = query("SELECT (julianday('now') - julianday(created_at)) * 24 * 60 AS m FROM messages WHERE id = ?",
    [mid])[0].m;
  if (mins > 2) return res.status(400).json({ error: '发送超过 2 分钟的消息不能撤回' });
  run('UPDATE messages SET recalled = 1, content = ? WHERE id = ?', ['', mid]);
  // 图片消息撤回时顺手删掉图片文件，避免占空间
  if (msg.type === 'image' && msg.content) {
    fs.unlink(path.join(UPLOAD_DIR, path.basename(msg.content)), () => {});
  } else if (msg.type === 'file' && msg.content) {
    // 文件消息 content 是 JSON，取里面的 url 删物理文件
    try {
      const meta = JSON.parse(msg.content);
      if (meta && meta.url) fs.unlink(path.join(UPLOAD_DIR, path.basename(meta.url)), () => {});
    } catch (e) {}
  }
  res.json({ ok: true, id: mid });
});

// 最近消息状态同步（前端轮询用：让撤回动作在其他人屏幕上及时生效）
app.get('/api/conversations/:id/messages-sync', authRequired, (req, res) => {
  const uid = req.session.userId;
  const convId = parseInt(req.params.id, 10);
  if (!ensureMember(convId, uid)) return res.status(403).json({ error: '你不是会话成员' });
  const rows = query(`SELECT m.id, m.recalled FROM messages m
    WHERE m.conversation_id = ? ORDER BY m.id DESC LIMIT 10`, [convId]);
  res.json(rows);
});

// 标记已读（进入会话时调用）
app.post('/api/conversations/:id/read', authRequired, (req, res) => {
  const uid = req.session.userId;
  const convId = parseInt(req.params.id, 10);
  if (!ensureMember(convId, uid)) return res.status(403).json({ error: '你不是会话成员' });
  run('UPDATE conversation_members SET last_read_at = CURRENT_TIMESTAMP WHERE conversation_id = ? AND user_id = ?',
    [convId, uid]);
  res.json({ ok: true });
});

// 已读回执：会话内每个成员最后读到的时间（前端据此给自己发的消息标"已读/未读"）
app.get('/api/conversations/:id/receipts', authRequired, (req, res) => {
  const uid = req.session.userId;
  const convId = parseInt(req.params.id, 10);
  if (!ensureMember(convId, uid)) return res.status(403).json({ error: '你不是会话成员' });
  const list = query(`SELECT cm.user_id AS id, u.nickname, u.username, u.avatar, cm.last_read_at
    FROM conversation_members cm JOIN users u ON u.id = cm.user_id
    WHERE cm.conversation_id = ?`, [convId]);
  res.json(list);
});

// 会话详情（含群成员列表）
app.get('/api/conversations/:id', authRequired, (req, res) => {
  const uid = req.session.userId;
  const convId = parseInt(req.params.id, 10);
  if (!ensureMember(convId, uid)) return res.status(403).json({ error: '你不是会话成员' });
  const conv = query('SELECT * FROM conversations WHERE id = ?', [convId])[0];
  if (!conv) return res.status(404).json({ error: '会话不存在' });
  const members = query(`SELECT u.id, u.username, u.nickname, u.avatar, u.created_at
    FROM conversation_members m JOIN users u ON m.user_id = u.id
    WHERE m.conversation_id = ? ORDER BY u.nickname ASC`, [convId]);
  res.json({
    id: conv.id, type: conv.type, name: conv.name, creator_id: conv.creator_id,
    created_at: conv.created_at,
    members: members.map(u => ({ ...u, online: isOnline(u.id) }))
  });
});

// 修改群名（仅群主）
app.post('/api/conversations/:id/rename', authRequired, (req, res) => {
  const uid = req.session.userId;
  const convId = parseInt(req.params.id, 10);
  const conv = query('SELECT * FROM conversations WHERE id = ?', [convId])[0];
  if (!conv) return res.status(404).json({ error: '会话不存在' });
  if (conv.type !== 'group') return res.status(400).json({ error: '一对一会话不能改名' });
  if (conv.creator_id !== uid) return res.status(403).json({ error: '仅群主可修改群名' });
  const name = String(req.body.name || '').trim().slice(0, 30);
  if (!name) return res.status(400).json({ error: '群名不能为空' });
  run('UPDATE conversations SET name = ? WHERE id = ?', [name, convId]);
  res.json({ ok: true, name });
});

// 解散群聊（仅群主；连同消息和成员关系一起删除）
app.delete('/api/conversations/:id', authRequired, (req, res) => {
  const uid = req.session.userId;
  const convId = parseInt(req.params.id, 10);
  const conv = query('SELECT * FROM conversations WHERE id = ?', [convId])[0];
  if (!conv) return res.status(404).json({ error: '会话不存在' });
  if (conv.type !== 'group') return res.status(400).json({ error: '仅支持解散群聊' });
  if (conv.creator_id !== uid) return res.status(403).json({ error: '仅群主可解散群聊' });
  run('DELETE FROM messages WHERE conversation_id = ?', [convId]);
  run('DELETE FROM conversation_members WHERE conversation_id = ?', [convId]);
  run('DELETE FROM conversations WHERE id = ?', [convId]);
  res.json({ ok: true });
});

// ===== 通知查询接口 =====
app.get('/api/notifications', authRequired, (req, res) => {
  const list = query(`SELECT n.*,
      COALESCE(a.nickname, '游客') AS actor_nickname,
      a.avatar AS actor_avatar
    FROM notifications n
    LEFT JOIN users a ON n.actor_id = a.id
    WHERE n.user_id = ?
    ORDER BY n.created_at DESC
    LIMIT 30`, [req.session.userId]);
  const unread = query('SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND is_read = 0',
    [req.session.userId])[0].c;
  res.json({ list, unread });
});

app.post('/api/notifications/read', authRequired, (req, res) => {
  run('UPDATE notifications SET is_read = 1 WHERE user_id = ?', [req.session.userId]);
  res.json({ ok: true });
});

// ===== 管理员接口 =====
// ADMIN_SECRET 在文件开头从 secrets.js / 环境变量读取，密码不写死在代码里

app.post('/api/admin/apply', authRequired, (req, res) => {
  const { secret } = req.body;
  if (secret === ADMIN_SECRET) {
    run("UPDATE users SET admin_status = 'approved' WHERE id = ?", [req.session.userId]);
    req.session.adminMode = true;   // 本次会话开启管理员模式
    res.json({ ok: true });
  } else {
    res.status(400).json({ error: '管理员密码错误' });
  }
});

// 退出管理员模式：只关闭管理员开关，不注销账号
app.post('/api/admin/exit', authRequired, (req, res) => {
  req.session.adminMode = false;
  res.json({ ok: true });
});
app.get('/api/admin/applications', adminRequired, (req, res) => {
  const list = query('SELECT id, username, nickname, admin_status, created_at FROM users WHERE admin_status = ?', ['pending']);
  res.json(list);
});

app.post('/api/admin/users/:id/approve', adminRequired, (req, res) => {
  run("UPDATE users SET admin_status = 'approved' WHERE id = ?", [req.params.id]);
  res.json({ ok: true });
});

app.post('/api/admin/users/:id/revoke', adminRequired, (req, res) => {
  run("UPDATE users SET admin_status = 'none' WHERE id = ?", [req.params.id]);
  res.json({ ok: true });
});

app.get('/api/admin/users', adminRequired, (req, res) => {
  const list = query('SELECT id, username, nickname, role, admin_status, created_at FROM users ORDER BY id');
  res.json(list);
});

// 管理员重置某位同学的密码（同学忘记密码时用，不需要知道原密码）
app.post('/api/admin/users/:id/reset-password', adminRequired, async (req, res) => {
  try {
    const uid = parseInt(req.params.id, 10);
    const newPwd = String(req.body.newPassword || '');
    if (newPwd.length < 6 || newPwd.length > 32) {
      return res.status(400).json({ error: '新密码长度需为 6-32 位' });
    }
    const exist = query('SELECT id FROM users WHERE id = ?', [uid]);
    if (!exist.length) return res.status(404).json({ error: '用户不存在' });
    const hash = await bcrypt.hash(newPwd, 10);
    run('UPDATE users SET password = ? WHERE id = ?', [hash, uid]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 管理员下载数据库备份（所有帖子、账号、聊天记录都在这一个文件里）
app.get('/api/admin/backup', adminRequired, (req, res) => {
  try {
    saveDB();  // 先把内存里的最新数据落盘
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
    res.download(DB_FILE, `classroom-backup-${stamp}.sqlite`);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== 自动备份管理（仅管理员） =====
// 备份文件列表
app.get('/api/admin/backups', adminRequired, (req, res) => {
  try {
    const list = listBackupFiles().map(f => ({
      name: f.name, size: f.size, mtime: f.mtime.toISOString(), manual: f.manual
    }));
    res.json({ ok: true, list, keep_days: BACKUP_KEEP_DAYS });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 立即手动备份（手动备份不会被自动清理）
app.post('/api/admin/backups', adminRequired, (req, res) => {
  try {
    saveDB();  // 确保备份的是最新数据
    const name = createBackupFile(true);
    res.json({ ok: true, name });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 下载指定备份文件
app.get('/api/admin/backups/:name/download', adminRequired, (req, res) => {
  const name = req.params.name;
  if (!BACKUP_NAME_RE.test(name)) return res.status(400).json({ error: '文件名无效' });
  const file = path.join(BACKUP_DIR, name);
  if (!fs.existsSync(file)) return res.status(404).json({ error: '备份不存在' });
  res.download(file, name);
});

// 删除指定备份文件
app.delete('/api/admin/backups/:name', adminRequired, (req, res) => {
  const name = req.params.name;
  if (!BACKUP_NAME_RE.test(name)) return res.status(400).json({ error: '文件名无效' });
  const file = path.join(BACKUP_DIR, name);
  if (!fs.existsSync(file)) return res.status(404).json({ error: '备份不存在' });
  try {
    fs.unlinkSync(file);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== 班级公告板 =====
// 公告列表：所有人可见，按时间倒序，附带发布人昵称
app.get('/api/announcements', (req, res) => {
  res.json(query(`
    SELECT a.*, u.nickname AS author_nickname
    FROM announcements a
    JOIN users u ON u.id = a.created_by
    ORDER BY a.created_at DESC
    LIMIT 50`));
});
// 创建公告：仅管理员。同步给所有用户发一条 type='announcement' 的通知
app.post('/api/announcements', adminRequired, (req, res) => {
  const title = String(req.body.title || '').trim().slice(0, 60);
  const content = String(req.body.content || '').trim().slice(0, 1000);
  if (!title || !content) return res.status(400).json({ error: '标题和内容都不能为空' });
  const id = insert('INSERT INTO announcements (title, content, created_by) VALUES (?, ?, ?)',
    [title, content, req.session.userId]);
  // 给所有用户（除发布者自己）发通知
  const users = query('SELECT id FROM users WHERE id <> ?', [req.session.userId]);
  for (const u of users) {
    try {
      insert('INSERT INTO notifications (user_id, actor_id, type, post_id, content) VALUES (?, ?, ?, ?, ?)',
        [u.id, req.session.userId, 'announcement', 0, title]);
    } catch (e) { /* 同一通知 UNIQUE 冲突忽略 */ }
  }
  saveDB();
  res.json({ ok: true, id });
});
// 删除公告：仅管理员
app.delete('/api/announcements/:id', adminRequired, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: '无效的公告 id' });
  run('DELETE FROM announcements WHERE id = ?', [id]);
  saveDB();
  res.json({ ok: true });
});

// ===== 举报后台 =====
// 待处理举报列表：按帖子聚合，同一条动态被多人举报只显示一行，附带每个举报人的理由
app.get('/api/admin/reports', adminRequired, (req, res) => {
  const rows = query(`
    SELECT r.id AS report_id, r.post_id, r.reason, r.created_at, r.status,
           ru.id AS reporter_id, ru.nickname AS reporter_nickname, ru.username AS reporter_username,
           p.content AS post_content, p.images AS post_images, p.user_id AS post_user_id,
           pu.nickname AS post_author_nickname
    FROM reports r
    JOIN users ru ON ru.id = r.reporter_id
    LEFT JOIN posts p ON p.id = r.post_id
    LEFT JOIN users pu ON pu.id = p.user_id
    WHERE r.status = 'open'
    ORDER BY r.created_at DESC`, []);
  // 按 post_id 聚合
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.post_id)) {
      map.set(r.post_id, {
        post_id: r.post_id,
        post_exists: !!r.post_content || !!r.post_images,
        post_content: r.post_content || '',
        post_images: r.post_images || '',
        post_author_nickname: r.post_author_nickname || '',
        latest_at: r.created_at,
        reports: []
      });
    }
    const g = map.get(r.post_id);
    g.reports.push({
      report_id: r.report_id,
      reporter_id: r.reporter_id,
      reporter_nickname: r.reporter_nickname,
      reporter_username: r.reporter_username,
      reason: r.reason,
      created_at: r.created_at
    });
  }
  res.json({ list: Array.from(map.values()) });
});

// 处理举报：action=delete 删帖并结案；action=keep 忽略，仅结案举报
app.post('/api/admin/reports/post/:postId/resolve', adminRequired, (req, res) => {
  const pid = parseInt(req.params.postId, 10);
  const action = String(req.body.action || '');
  if (action === 'delete') {
    const posts = query('SELECT images, videos, files FROM posts WHERE id = ?', [pid]);
    if (posts.length) {
      for (const col of [posts[0].images, posts[0].videos, posts[0].files]) {
        if (!col) continue;
        for (const name of col.split(',')) {
          if (name) fs.unlink(path.join(UPLOAD_DIR, path.basename(name)), () => {});
        }
      }
      // posts 表主键叫 id；其余关联表用 post_id
      for (const t of ['likes', 'comments', 'favorites', 'poll_votes', 'notifications', 'post_views']) {
        run(`DELETE FROM ${t} WHERE post_id = ?`, [pid]);
      }
      run('DELETE FROM posts WHERE id = ?', [pid]);
    }
    run('DELETE FROM reports WHERE post_id = ?', [pid]);
  } else if (action === 'keep') {
    run("UPDATE reports SET status = 'dismissed' WHERE post_id = ? AND status = 'open'", [pid]);
  } else {
    return res.status(400).json({ error: '未知操作' });
  }
  res.json({ ok: true });
});

// ===== 工具分享 =====
// 规整网址：补协议、只允许 http/https，返回 {url, host} 或 null
function normalizeToolUrl(raw) {
  let s = String(raw || '').trim();
  if (!s) return null;
  // 站内自制工具页：仅允许 /tools/xxx 形式，避免路径穿越
  if (s.startsWith('/tools/')) {
    if (s.includes('..')) return null;
    return { url: s, host: '班级自制' };
  }
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s)) s = 'https://' + s;
  let u;
  try { u = new URL(s); } catch (e) { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (!u.hostname.includes('.')) return null;
  return { url: u.href, host: u.hostname.replace(/^www\./, '') };
}

// 分类列表（所有人可查）
app.get('/api/tool-categories', (req, res) => {
  res.json(query('SELECT * FROM tool_categories ORDER BY sort_order ASC, id ASC'));
});

// 工具列表：带提交者信息、点赞数、当前用户/设备是否已赞；可按分类过滤
app.get('/api/tools', (req, res) => {
  const cid = parseInt(req.query.category_id, 10) || 0;
  const { uid, device } = getIdentity(req);
  const where = cid > 0 ? 'WHERE t.category_id = ?' : '';
  const params = cid > 0 ? [cid] : [];
  const rows = query(`SELECT t.*, u.nickname, u.username, u.avatar, c.name AS category_name,
      (SELECT COUNT(*) FROM tool_likes WHERE tool_id = t.id) AS like_count,
      (EXISTS(SELECT 1 FROM tool_likes WHERE tool_id = t.id AND user_id = ? AND ? > 0)
        OR EXISTS(SELECT 1 FROM tool_likes WHERE tool_id = t.id AND device_id = ? AND ? <> '')) AS liked
    FROM tools t
    JOIN users u ON t.user_id = u.id
    LEFT JOIN tool_categories c ON t.category_id = c.id
    ${where}
    ORDER BY t.created_at DESC`, [uid, uid, device, device, ...params]);
  res.json(rows);
});

// 上传工具网站（登录用户）
app.post('/api/tools', authRequired, (req, res) => {
  const norm = normalizeToolUrl(req.body.url);
  if (!norm) return res.status(400).json({ error: '网址格式不正确，请填写类似 example.com 的有效网址' });
  let title = String(req.body.title || '').trim().slice(0, 50);
  if (!title) {
    // 没填名称就用域名
    title = norm.host;
  }
  const description = String(req.body.description || '').trim().slice(0, 500);
  if (!description) return res.status(400).json({ error: '写一句简介吧，让同学们知道这工具是干嘛的' });
  let cid = parseInt(req.body.category_id, 10) || 0;
  if (cid && !query('SELECT id FROM tool_categories WHERE id = ?', [cid]).length) cid = 0;
  const id = insert('INSERT INTO tools (user_id, title, url, description, category_id) VALUES (?, ?, ?, ?, ?)',
    [req.session.userId, title, norm.url, description, cid]);
  res.json({ ok: true, id });
});

// 删除工具：提交者本人或管理员
app.delete('/api/tools/:id', authRequired, (req, res) => {
  const row = query('SELECT user_id FROM tools WHERE id = ?', [req.params.id]);
  if (!row.length) return res.status(404).json({ error: '工具不存在' });
  if (row[0].user_id !== req.session.userId && !req.session.adminMode) {
    return res.status(403).json({ error: '无权删除' });
  }
  run('DELETE FROM tool_likes WHERE tool_id = ?', [req.params.id]);
  run('DELETE FROM tools WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
});

// 工具点赞：登录用户可取消；游客设备只记录一次
app.post('/api/tools/:id/like', (req, res) => {
  const tid = parseInt(req.params.id, 10);
  const exist = query('SELECT id FROM tools WHERE id = ?', [tid]);
  if (!exist.length) return res.status(404).json({ error: '工具不存在' });
  const { uid, device } = getIdentity(req);
  let liked;
  if (uid > 0) {
    const mine = query('SELECT id FROM tool_likes WHERE tool_id = ? AND user_id = ?', [tid, uid]);
    if (mine.length) {
      run('DELETE FROM tool_likes WHERE tool_id = ? AND user_id = ?', [tid, uid]);
      liked = false;
    } else {
      run('INSERT INTO tool_likes (tool_id, user_id, device_id) VALUES (?, ?, ?)', [tid, uid, '']);
      liked = true;
    }
  } else {
    if (!device) return res.status(400).json({ error: '设备标识缺失，请刷新页面重试' });
    const mine = query('SELECT id FROM tool_likes WHERE tool_id = ? AND user_id = 0 AND device_id = ?', [tid, device]);
    if (mine.length) return res.status(409).json({ error: '这台设备已经赞过啦', liked: true });
    run('INSERT INTO tool_likes (tool_id, user_id, device_id) VALUES (?, 0, ?)', [tid, device]);
    liked = true;
  }
  const count = query('SELECT COUNT(*) AS c FROM tool_likes WHERE tool_id = ?', [tid])[0].c;
  res.json({ ok: true, likeCount: count, liked });
});

// 管理员：新增工具分类
app.post('/api/admin/tool-categories', adminRequired, (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 12);
  if (!name) return res.status(400).json({ error: '分类名称不能为空' });
  if (query('SELECT id FROM tool_categories WHERE name = ?', [name]).length) {
    return res.status(409).json({ error: '分类已存在' });
  }
  const maxOrder = query('SELECT MAX(sort_order) AS m FROM tool_categories')[0].m || 0;
  const id = insert('INSERT INTO tool_categories (name, sort_order) VALUES (?, ?)', [name, maxOrder + 1]);
  res.json({ ok: true, id });
});

// 管理员：删除分类（分类下的工具自动变为"未分类"，不会被删）
app.delete('/api/admin/tool-categories/:id', adminRequired, (req, res) => {
  const id = parseInt(req.params.id, 10);
  run('UPDATE tools SET category_id = 0 WHERE category_id = ?', [id]);
  run('DELETE FROM tool_categories WHERE id = ?', [id]);
  res.json({ ok: true });
});

// 管理员：把工具移动到指定分类（0=未分类）
app.post('/api/tools/:id/category', adminRequired, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!query('SELECT id FROM tools WHERE id = ?', [id]).length) {
    return res.status(404).json({ error: '工具不存在' });
  }
  const cid = parseInt(req.body.category_id, 10) || 0;
  if (cid && !query('SELECT id FROM tool_categories WHERE id = ?', [cid]).length) {
    return res.status(400).json({ error: '分类不存在' });
  }
  run('UPDATE tools SET category_id = ? WHERE id = ?', [cid, id]);
  res.json({ ok: true, category_id: cid });
});

// ===== 学习资料库 =====
// 允许的资料类型：课件/论文/文档/压缩包/图片，单个最大 2GB
const RESOURCE_EXT_RE = /\.(pdf|docx?|xlsx?|pptx?|txt|md|zip|rar|7z|jpe?g|png|gif|webp)$/i;
const resourceUpload = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, RESOURCE_EXT_RE.test(file.originalname))
});

// 课程列表（带每门课的资料数量）
app.get('/api/courses', (req, res) => {
  res.json(query(`SELECT c.*,
      (SELECT COUNT(*) FROM resources WHERE course_id = c.id) AS res_count
    FROM courses c ORDER BY c.name ASC`));
});

// 新建课程（登录用户，同名冲突 409）
app.post('/api/courses', authRequired, (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 30);
  if (!name) return res.status(400).json({ error: '课程名称不能为空' });
  if (query('SELECT id FROM courses WHERE name = ?', [name]).length) {
    return res.status(409).json({ error: '这门课已经存在啦' });
  }
  const id = insert('INSERT INTO courses (name, created_by) VALUES (?, ?)', [name, req.session.userId]);
  res.json({ ok: true, id });
});

// 删除空课程：创建者或管理员；课程里还有资料时拒绝，防止误删整个文件夹
app.delete('/api/courses/:id', authRequired, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const rows = query('SELECT * FROM courses WHERE id = ?', [id]);
  if (!rows.length) return res.status(404).json({ error: '课程不存在' });
  if (rows[0].created_by !== req.session.userId && !req.session.adminMode) {
    return res.status(403).json({ error: '无权删除' });
  }
  if (query('SELECT COUNT(*) AS c FROM resources WHERE course_id = ?', [id])[0].c > 0) {
    return res.status(409).json({ error: '课程里还有资料，请先把资料删完' });
  }
  run('DELETE FROM courses WHERE id = ?', [id]);
  res.json({ ok: true });
});

// 资料列表：可按课程过滤、按文件名/备注搜索；游客也能看
app.get('/api/resources', (req, res) => {
  const cid = parseInt(req.query.course_id, 10) || 0;
  const q = String(req.query.q || '').trim().slice(0, 50);
  const where = [];
  const params = [];
  if (cid) { where.push('r.course_id = ?'); params.push(cid); }
  if (q) {
    where.push('(r.original_name LIKE ? OR r.note LIKE ?)');
    params.push('%' + q + '%', '%' + q + '%');
  }
  const rows = query(`SELECT r.*, u.nickname, u.username, u.avatar, c.name AS course_name
    FROM resources r
    JOIN users u ON r.user_id = u.id
    JOIN courses c ON r.course_id = c.id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY r.created_at DESC`, params);
  res.json(rows);
});

// 上传资料（登录用户）：multipart 字段 file=文件、course_id=课程、note=备注
app.post('/api/resources', authRequired, resourceUpload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: '请选择允许的文件类型（pdf/word/ppt/excel/txt/压缩包/图片，最大50MB）' });
  }
  const cid = parseInt(req.body.course_id, 10) || 0;
  if (!query('SELECT id FROM courses WHERE id = ?', [cid]).length) {
    fs.unlink(req.file.path, () => {});  // 课程无效，删掉刚落盘的文件
    return res.status(400).json({ error: '请先选择课程（没有的话先新建一门课）' });
  }
  // multer/busboy 默认按 latin1 解码文件名，中文需要转回 UTF-8（纯 ASCII 不受影响）
  let origName;
  try { origName = Buffer.from(req.file.originalname, 'latin1').toString('utf8'); }
  catch (e) { origName = req.file.originalname; }
  origName = path.basename(origName).replace(/[\x00-\x1f]/g, '').slice(0, 200) || '未命名文件';
  const note = String(req.body.note || '').trim().slice(0, 200);
  const id = insert(`INSERT INTO resources
    (course_id, user_id, original_name, stored_name, note, size) VALUES (?, ?, ?, ?, ?, ?)`,
    [cid, req.session.userId, origName, req.file.filename, note, req.file.size || 0]);
  addPoints(req.session.userId, 2);  // 分享资料 +2 积分
  res.json({ ok: true, id });
});

// 下载资料（游客也能下）：计数 +1，用原始文件名保存到本地
app.get('/api/resources/:id/download', (req, res) => {
  const rows = query('SELECT * FROM resources WHERE id = ?', [parseInt(req.params.id, 10)]);
  if (!rows.length) return res.status(404).json({ error: '资料不存在' });
  const fp = path.join(UPLOAD_DIR, path.basename(rows[0].stored_name));
  if (!fs.existsSync(fp)) return res.status(404).json({ error: '文件已被移除' });
  run('UPDATE resources SET downloads = downloads + 1 WHERE id = ?', [rows[0].id]);
  res.download(fp, path.basename(rows[0].original_name));
});

// 删除资料：上传者本人或管理员，同时删掉服务器上的文件
app.delete('/api/resources/:id', authRequired, (req, res) => {
  const rows = query('SELECT * FROM resources WHERE id = ?', [parseInt(req.params.id, 10)]);
  if (!rows.length) return res.status(404).json({ error: '资料不存在' });
  if (rows[0].user_id !== req.session.userId && !req.session.adminMode) {
    return res.status(403).json({ error: '无权删除' });
  }
  fs.unlink(path.join(UPLOAD_DIR, path.basename(rows[0].stored_name)), () => {});
  run('DELETE FROM resources WHERE id = ?', [rows[0].id]);
  res.json({ ok: true });
});

// ===== 签到 =====
// 计算 yyyy-mm-dd（可指定偏移天数：0=今天，-1=昨天）
function ymdOffset(offsetDays = 0, base = new Date()) {
  const d = new Date(base);
  d.setDate(d.getDate() + offsetDays);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// 计算连续签到天数：把该用户所有签到日期升序，相邻日期是昨天+1 否则重置 1，返回最大值
function calcStreak(userRows) {
  if (!userRows.length) return 0;
  const dates = userRows.map(r => {
    const [y, m, d] = r.date.split('-').map(Number);
    return new Date(y, m - 1, d).getTime();
  }).sort((a, b) => a - b);
  let max = 1, cur = 1;
  for (let i = 1; i < dates.length; i++) {
    const gap = Math.round((dates[i] - dates[i - 1]) / 86400000);
    if (gap === 1) { cur++; if (cur > max) max = cur; }
    else if (gap === 0) { /* 同一天跳过 */ }
    else cur = 1;
  }
  return max;
}

app.get('/api/checkin', authRequired, (req, res) => {
  const today = ymdOffset(0);
  const rows = query('SELECT date FROM checkins WHERE user_id = ? ORDER BY date ASC', [req.session.userId]);
  const checkedToday = rows.some(r => r.date === today);
  const lastDate = rows.length ? rows[rows.length - 1].date : null;
  const streak = checkedToday ? calcStreak(rows) : 0;
  res.json({
    checked_today: checkedToday,
    streak,
    max_streak: calcStreak(rows),
    total_days: rows.length,
    last_date: lastDate
  });
});

app.post('/api/checkin', authRequired, (req, res) => {
  const today = ymdOffset(0);
  const exist = query('SELECT id FROM checkins WHERE user_id = ? AND date = ?', [req.session.userId, today]);
  if (exist.length) return res.status(400).json({ error: '今日已签到', streak: 0 });
  insert('INSERT INTO checkins (user_id, date) VALUES (?, ?)', [req.session.userId, today]);
  addPoints(req.session.userId, 2);
  const rows = query('SELECT date FROM checkins WHERE user_id = ? ORDER BY date ASC', [req.session.userId]);
  const streak = calcStreak(rows);
  res.json({ ok: true, streak, total_days: rows.length });
});

// ===== 个人成就徽章 =====
const ACHIEVEMENTS = [
  { key: 'first_post',   icon: '🌱', name: '初出茅庐', desc: '发布第一条动态' },
  { key: 'posts_10',     icon: '📝', name: '勤于发言', desc: '累计发布 10 条动态' },
  { key: 'likes_50',     icon: '⭐', name: '人气爆棚', desc: '累计获得 50 个赞' },
  { key: 'streak_7',     icon: '🔥', name: '坚持一周', desc: '连续签到 7 天' },
  { key: 'group_creator',icon: '👥', name: '群聊组织者', desc: '创建过群聊' },
  { key: 'early_bird',   icon: '🌅', name: '早起的鸟儿', desc: '在 6:00-8:00 期间发过动态' },
  { key: 'social',       icon: '💌', name: '广受关注', desc: '累计收到 10 条评论' },
  { key: 'poll_master',  icon: '🗳️', name: '民意调查员', desc: '发起过 3 次投票' }
];

app.get('/api/users/:id/achievements', (req, res) => {
  const uid = parseInt(req.params.id, 10);
  const u = query('SELECT id FROM users WHERE id = ?', [uid])[0];
  if (!u) return res.status(404).json({ error: '用户不存在' });

  const postCount = query('SELECT COUNT(*) AS c FROM posts WHERE user_id = ?', [uid])[0].c;
  const likeReceived = query(`SELECT COUNT(*) AS c FROM likes l
    JOIN posts p ON l.post_id = p.id WHERE p.user_id = ?`, [uid])[0].c;
  const commentReceived = query(`SELECT COUNT(*) AS c FROM comments c
    JOIN posts p ON c.post_id = p.id WHERE p.user_id = ?`, [uid])[0].c;
  const groupCreated = query('SELECT COUNT(*) AS c FROM conversations WHERE creator_id = ? AND type = ?', [uid, 'group'])[0].c;
  const checkinRows = query('SELECT date FROM checkins WHERE user_id = ? ORDER BY date ASC', [uid]);
  const maxStreak = calcStreak(checkinRows);
  // 早鸟：用户本地时间 6:00-8:00 发过帖
  // SQLite CURRENT_TIMESTAMP 是 UTC，6:00-8:00 北京时间 = 22:00-24:00 UTC（含 0 点）
  const earlyBird = query(`SELECT COUNT(*) AS c FROM posts
    WHERE user_id = ? AND CAST(strftime('%H', created_at) AS INTEGER) IN (22, 23, 0)`, [uid])[0].c;
  const pollCount = query('SELECT COUNT(*) AS c FROM posts WHERE user_id = ? AND poll != ?', [uid, ''])[0].c;

  const unlocked = {
    first_post: postCount >= 1,
    posts_10: postCount >= 10,
    likes_50: likeReceived >= 50,
    streak_7: maxStreak >= 7,
    group_creator: groupCreated >= 1,
    early_bird: earlyBird >= 1,
    social: commentReceived >= 10,
    poll_master: pollCount >= 3
  };
  res.json(ACHIEVEMENTS.map(a => ({
    key: a.key, icon: a.icon, name: a.name, desc: a.desc,
    unlocked: !!unlocked[a.key]
  })));
});

// ===== 每周热门榜 =====
let hotWeekCache = null;  // { ts, data }
app.get('/api/posts/hot-week', (req, res) => {
  // 5 分钟缓存避免每次重算
  if (hotWeekCache && Date.now() - hotWeekCache.ts < 5 * 60 * 1000) {
    return res.json(hotWeekCache.data);
  }
  // 近 7 天帖子按 (点赞数 + 评论数) 倒序前 3 条
  const rows = query(`SELECT p.id, p.content, p.user_id, p.created_at, p.section_id,
      u.nickname, u.avatar, s.name AS section_name,
      (SELECT COUNT(*) FROM likes WHERE post_id = p.id) AS like_count,
      (SELECT COUNT(*) FROM comments WHERE post_id = p.id) AS comment_count
    FROM posts p
    JOIN users u ON p.user_id = u.id
    LEFT JOIN sections s ON p.section_id = s.id
    WHERE p.created_at >= datetime('now', '-7 days')
    ORDER BY (like_count + comment_count) DESC, p.created_at DESC
    LIMIT 3`);
  const data = rows.map(r => ({
    id: r.id,
    content: (r.content || '').slice(0, 60),
    full_content: r.content,
    nickname: r.nickname,
    avatar: r.avatar,
    user_id: r.user_id,
    like_count: r.like_count,
    comment_count: r.comment_count,
    section_name: r.section_name,
    created_at: r.created_at
  }));
  hotWeekCache = { ts: Date.now(), data };
  res.json(data);
});

// 统一错误处理：文件超限时返回友好提示
app.use((err, req, res, next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ error: '文件太大啦：帖子的图片/视频/文件单个不超过200MB，聊天图片不超过10MB，头像不超过5MB' });
  }
  if (err) return res.status(500).json({ error: err.message });
  next();
});

// ===== 生日通知：今天有同学过生日时，给全班每人发一次（当天不重复）=====
function ensureBirthdayNotifs() {
  const now = new Date();
  const md = String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
  const stars = query("SELECT id, nickname FROM users WHERE birthday = ?", [md]);
  if (!stars.length) return;
  // 本地今天 0 点对应的 UTC 时间串，用于当天去重（created_at 存的是 UTC）
  const localMidnightUTC = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString().slice(0, 19).replace('T', ' ');
  const allUsers = query('SELECT id FROM users');
  for (const star of stars) {
    const already = query(
      "SELECT id FROM notifications WHERE type = 'birthday' AND actor_id = ? AND created_at >= ?",
      [star.id, localMidnightUTC]);
    if (already.length) continue;
    for (const u of allUsers) {
      if (u.id === star.id) {
        // 给寿星本人一条提醒
        run(`INSERT INTO notifications (user_id, actor_id, type, post_id, content) VALUES (?, ?, 'birthday', 0, ?)`,
          [star.id, star.id, '🎂 今天是你的生日！快看看同学们的祝福吧～']);
      } else {
        run(`INSERT INTO notifications (user_id, actor_id, type, post_id, content) VALUES (?, ?, 'birthday', 0, ?)`,
          [u.id, star.id, '🎂 今天是' + star.nickname + '的生日，去TA的主页留言送祝福吧！']);
      }
    }
    console.log('已发送生日通知：', star.nickname);
  }
}

// ============================================================
// 奶娃街舞 · 玩家自制歌曲（上传音频 + 客户端自动生成的谱面）
// ============================================================
const DANCE_DIR = path.join(UPLOAD_DIR, 'dance');
if (!fs.existsSync(DANCE_DIR)) fs.mkdirSync(DANCE_DIR);
const danceUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, DANCE_DIR),
    filename: (req, file, cb) => {
      const ext = (path.extname(file.originalname) || '.mp3').toLowerCase();
      cb(null, Date.now() + '_' + Math.round(Math.random() * 1e9) + ext);
    }
  }),
  limits: { fileSize: 30 * 1024 * 1024 },   // 音频最大 30MB
  fileFilter: (req, file, cb) => {
    if (/^audio\//.test(file.mimetype) || /\.(mp3|m4a|aac|ogg|wav|flac|weba|webm)$/i.test(file.originalname)) cb(null, true);
    else cb(new Error('只支持音频文件（mp3 / m4a / ogg / wav 等）'));
  }
});

// 上传后自动压缩：任何格式统一转 128kbps mp3（文件小、手机加载快、省流量，和游戏里其他歌一致）。
// 成功返回最终文件名；转码失败/超时 → 返回原文件名兜底（绝不让压缩问题导致上传失败）
function compressDanceAudio(file) {
  return new Promise((resolve) => {
    const base = path.basename(file.filename, path.extname(file.filename));
    const outName = base + '.mp3';
    const finalPath = path.join(DANCE_DIR, outName);
    const tmpPath = finalPath + '.tmp';
    let done = false;
    const finish = (name) => { if (!done) { done = true; resolve(name); } };
    const to = setTimeout(() => { try { fs.unlinkSync(tmpPath); } catch {} finish(file.filename); }, 60000);
    // -f mp3：临时文件后缀是 .tmp，ffmpeg 无法靠后缀判断格式，必须显式指定
    execFile(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', '-i', file.path,
                      '-map_metadata', '-1', '-b:a', '128k', '-f', 'mp3', tmpPath], (err) => {
      clearTimeout(to);
      if (err) { try { fs.unlinkSync(tmpPath); } catch {} return finish(file.filename); }
      try {
        if (fs.statSync(tmpPath).size < 1024) throw new Error('输出文件异常');
        if (outName === file.filename) fs.unlinkSync(file.path);  // Windows 不能 rename 覆盖已存在文件：先删原文件
        fs.renameSync(tmpPath, finalPath);
        if (outName !== file.filename) { try { fs.unlinkSync(file.path); } catch {} }
      } catch (e) { try { fs.unlinkSync(tmpPath); } catch {} return finish(file.filename); }
      finish(outName);
    });
  });
}

// 歌曲列表（不含谱面，谱面较大按需单独拉取）
app.get('/api/dance/songs', (req, res) => {
  const rows = query(`SELECT id, title, artist, bpm, duration, note_count, audio,
                      uploader_id, uploader_name, created_at FROM dance_songs ORDER BY id DESC`);
  res.json(rows);
});

// 单首歌的谱面（进入游戏时才拉取）
app.get('/api/dance/songs/:id/chart', (req, res) => {
  const row = query('SELECT chart FROM dance_songs WHERE id = ?', [+req.params.id || 0])[0];
  if (!row) return res.status(404).json({ error: '歌曲不存在' });
  res.type('application/json').send(row.chart || '[]');
});

// 上传：音频文件走 multipart，谱面/信息走表单字段（谱面在浏览器本地分析生成）
// 不强制登录：游客也能上传，uploader_id 记 0、名字记"游客"（游客歌曲仅管理员可删）
app.post('/api/dance/songs', danceUpload.single('audio'), async (req, res) => {
  let finalName = null;
  try {
    if (!req.file) return res.status(400).json({ error: '缺少音频文件' });
    const title = String(req.body.title || '').trim().slice(0, 50) || '未命名歌曲';
    const artist = String(req.body.artist || '').trim().slice(0, 30);
    const bpm = Math.min(300, Math.max(40, Math.round(+req.body.bpm) || 100));
    const duration = Math.min(1200, Math.max(1, +req.body.duration || 0));
    let chart;
    try { chart = JSON.parse(req.body.chart || '[]'); } catch { chart = []; }
    if (!Array.isArray(chart)) chart = [];
    // 清洗谱面：只留合法音符，时间精确到毫秒并排序，最多 5000 个
    chart = chart
      .filter(n => n && isFinite(n.t) && +n.t >= 0 && Number.isInteger(+n.lane) && +n.lane >= 0 && +n.lane <= 3)
      .map(n => ({ t: Math.round(+n.t * 1000) / 1000, lane: +n.lane }))
      .sort((a, b) => a.t - b.t)
      .slice(0, 5000);
    if (!chart.length) {
      try { fs.unlinkSync(req.file.path); } catch {}
      return res.status(400).json({ error: '谱面数据无效，请重新分析后再上传' });
    }
    // ★ 谱面没问题后压缩音频（约几秒），任何格式都压成 128k mp3；失败时用原文件兜底
    finalName = await compressDanceAudio(req.file);
    // 登录用户记本人 id 和昵称；游客记 0 / "游客"
    const uid = req.session.userId || 0;
    let uploaderName = '游客';
    if (uid) {
      const me = query('SELECT nickname FROM users WHERE id = ?', [uid])[0];
      if (me) uploaderName = me.nickname;
    }
    const id = insert(
      `INSERT INTO dance_songs (title, artist, bpm, duration, note_count, chart, audio, uploader_id, uploader_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [title, artist, bpm, duration, chart.length, JSON.stringify(chart),
       '/uploads/dance/' + finalName, uid, uploaderName]);
    res.json({ ok: true, id, note_count: chart.length });
  } catch (e) {
    // 清理落盘音频（压缩后文件名可能已变为 finalName）
    for (const f of [finalName && path.join(DANCE_DIR, finalName), req.file && req.file.path]) {
      if (f) { try { fs.unlinkSync(f); } catch {} }
    }
    res.status(500).json({ error: '保存失败：' + e.message });
  }
});

// 删除：仅上传者本人或管理员
app.delete('/api/dance/songs/:id', authRequired, (req, res) => {
  const row = query('SELECT * FROM dance_songs WHERE id = ?', [+req.params.id || 0])[0];
  if (!row) return res.status(404).json({ error: '歌曲不存在' });
  // 管理员身份与全站统一：本次会话开启了"管理员模式"（/api/admin/apply 密码认证）
  // role='admin' 作为兜底也认，避免以后改角色体系时再次失配
  const me = query('SELECT role FROM users WHERE id = ?', [req.session.userId])[0];
  const isAdmin = !!req.session.adminMode || !!(me && me.role === 'admin');
  if (row.uploader_id !== req.session.userId && !isAdmin) return res.status(403).json({ error: '只能删除自己上传的歌曲' });
  run('DELETE FROM dance_songs WHERE id = ?', [row.id]);
  try { fs.unlinkSync(path.join(__dirname, String(row.audio).replace(/^\//, '').replace(/\//g, path.sep))); } catch {}
  res.json({ ok: true });
});

// 一键更新曲谱：客户端用新版算法分析原音频后，把新谱提交覆盖（权限同删歌：本人或管理员）
app.post('/api/dance/songs/:id/regenerate', authRequired, (req, res) => {
  try {
    const row = query('SELECT * FROM dance_songs WHERE id = ?', [+req.params.id || 0])[0];
    if (!row) return res.status(404).json({ error: '歌曲不存在' });
    const me = query('SELECT role FROM users WHERE id = ?', [req.session.userId])[0];
    const isAdmin = !!req.session.adminMode || !!(me && me.role === 'admin');
    if (row.uploader_id !== req.session.userId && !isAdmin) {
      return res.status(403).json({ error: '只能更新自己上传的歌曲' });
    }
    const b = req.body || {};
    let chart;
    try { chart = JSON.parse(b.chart || '[]'); } catch { chart = []; }
    if (!Array.isArray(chart)) chart = [];
    chart = chart
      .filter(n => n && isFinite(n.t) && +n.t >= 0 && Number.isInteger(+n.lane) && +n.lane >= 0 && +n.lane <= 3)
      .map(n => ({ t: Math.round(+n.t * 1000) / 1000, lane: +n.lane }))
      .sort((a, b2) => a.t - b2.t)
      .slice(0, 5000);
    if (!chart.length) return res.status(400).json({ error: '新谱数据无效' });
    const bpm = Math.min(300, Math.max(40, Math.round(+b.bpm) || row.bpm || 100));
    const duration = Math.min(1200, Math.max(1, +b.duration || row.duration || 0));
    run(`UPDATE dance_songs SET chart=?, bpm=?, duration=?, note_count=? WHERE id=?`,
      [JSON.stringify(chart), bpm, duration, chart.length, row.id]);
    saveDB();
    res.json({ ok: true, note_count: chart.length, bpm, duration });
  } catch (e) {
    res.status(500).json({ error: '更新失败：' + e.message });
  }
});

// ===== 多人排行榜 =====
// 按曲目查询：返回该曲目各难度的全员成绩（同曲目同难度按相对分降序）
app.get('/api/dance/scores/:songKey', (req, res) => {
  const songKey = String(req.params.songKey || '').slice(0, 60);
  if (!songKey) return res.status(400).json({ error: '缺少曲目标识' });
  const rows = query(
    `SELECT diff, user_name, score, rel, combo, rank, p, g, m, created_at
     FROM dance_scores WHERE song_key = ? ORDER BY diff ASC, rel DESC, id ASC`,
    [songKey]);
  const byDiff = { easy: [], casual: [], normal: [], hard: [] };
  for (const r of rows) (byDiff[r.diff] || byDiff.easy).push(r);
  const songRow = query('SELECT song_name FROM dance_scores WHERE song_key = ? LIMIT 1', [songKey])[0];
  res.json({ song: songRow ? songRow.song_name : '', byDiff });
});

// 提交成绩（自动上传，结算时调用；不强制登录，游客用本地 playerId 标识）
// 同一玩家同一曲目同一难度只保留最好成绩（相对分更高才覆盖）
app.post('/api/dance/scores', (req, res) => {
  try {
    const b = req.body || {};
    const songKey = String(b.songKey || '').slice(0, 60);
    const songName = String(b.songName || '').slice(0, 50);
    const diff = ['easy', 'casual', 'normal', 'hard'].includes(b.diff) ? b.diff : 'easy';
    const userKey = String(b.userKey || '').slice(0, 60);
    let userName = String(b.userName || '').trim().slice(0, 20) || '玩家';
    if (!songKey || !userKey) return res.status(400).json({ error: '缺少曲目或玩家标识' });
    const score = Math.max(0, Math.min(2000000000, Math.round(+b.score) || 0));
    const rel = Math.max(0, Math.min(100000, Math.round(+b.rel) || 0));
    const combo = Math.max(0, Math.min(100000, Math.round(+b.combo) || 0));
    const rank = ['SS', 'S', 'A', 'B', 'C'].includes(b.rank) ? b.rank : 'C';
    const p = Math.max(0, Math.round(+b.p) || 0);
    const g = Math.max(0, Math.round(+b.g) || 0);
    const m = Math.max(0, Math.round(+b.m) || 0);

    // 登录玩家：强制以账号 id 和昵称为准（防伪造身份）；游客沿用浏览器提交的本地标识
    let finalUserKey = userKey, finalUserName = userName;
    if (req.session.userId) {
      const me = query('SELECT nickname FROM users WHERE id = ?', [req.session.userId])[0];
      finalUserKey = 'u' + req.session.userId;
      if (me && me.nickname) finalUserName = me.nickname;
    }

    const old = query('SELECT rel FROM dance_scores WHERE song_key = ? AND diff = ? AND user_key = ?',
      [songKey, diff, finalUserKey])[0];
    if (old && rel <= old.rel) return res.json({ ok: true, updated: false });

    if (old) {
      run(`UPDATE dance_scores SET song_name=?, user_name=?, score=?, rel=?, combo=?, rank=?, p=?, g=?, m=?,
           created_at=CURRENT_TIMESTAMP
           WHERE song_key=? AND diff=? AND user_key=?`,
        [songName, finalUserName, score, rel, combo, rank, p, g, m, songKey, diff, finalUserKey]);
    } else {
      run(`INSERT INTO dance_scores (song_key, song_name, diff, user_key, user_name, score, rel, combo, rank, p, g, m)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [songKey, songName, diff, finalUserKey, finalUserName, score, rel, combo, rank, p, g, m]);
    }
    saveDB();
    res.json({ ok: true, updated: true });
  } catch (e) {
    res.status(500).json({ error: '成绩提交失败：' + e.message });
  }
});

// ===== 无尽模式排行榜 =====
// 按曲目查询：全员无尽成绩（按累计总分降序；同玩家只留最高分已在表内保证）
app.get('/api/dance/endless/:songKey', (req, res) => {
  const songKey = String(req.params.songKey || '').slice(0, 60);
  if (!songKey) return res.status(400).json({ error: '缺少曲目标识' });
  const rows = query(
    `SELECT user_name, score, round, combo, notes, created_at
     FROM dance_endless WHERE song_key = ? ORDER BY score DESC, id ASC`,
    [songKey]);
  const songRow = query('SELECT song_name FROM dance_endless WHERE song_key = ? LIMIT 1', [songKey])[0];
  res.json({ song: songRow ? songRow.song_name : '', rows });
});

// 提交无尽成绩（死亡结算时自动上传；不强制登录，身份规则与普通榜一致）
// 同一玩家同一首歌只保留累计总分最高的一次
app.post('/api/dance/endless', (req, res) => {
  try {
    const b = req.body || {};
    const songKey = String(b.songKey || '').slice(0, 60);
    const songName = String(b.songName || '').slice(0, 50);
    const userKey = String(b.userKey || '').slice(0, 60);
    let userName = String(b.userName || '').trim().slice(0, 20) || '玩家';
    if (!songKey || !userKey) return res.status(400).json({ error: '缺少曲目或玩家标识' });
    const score = Math.max(0, Math.min(2000000000, Math.round(+b.score) || 0));
    const round = Math.max(1, Math.min(9999, Math.round(+b.round) || 1));
    const combo = Math.max(0, Math.min(1000000, Math.round(+b.combo) || 0));
    const notes = Math.max(0, Math.min(10000000, Math.round(+b.notes) || 0));

    // 登录玩家：强制以账号 id 和昵称为准（防伪造身份）；游客沿用浏览器提交的本地标识
    let finalUserKey = userKey, finalUserName = userName;
    if (req.session.userId) {
      const me = query('SELECT nickname FROM users WHERE id = ?', [req.session.userId])[0];
      finalUserKey = 'u' + req.session.userId;
      if (me && me.nickname) finalUserName = me.nickname;
    }

    const old = query('SELECT score FROM dance_endless WHERE song_key = ? AND user_key = ?',
      [songKey, finalUserKey])[0];
    if (old && score <= old.score) return res.json({ ok: true, updated: false });

    if (old) {
      run(`UPDATE dance_endless SET song_name=?, user_name=?, score=?, round=?, combo=?, notes=?,
           created_at=CURRENT_TIMESTAMP
           WHERE song_key=? AND user_key=?`,
        [songName, finalUserName, score, round, combo, notes, songKey, finalUserKey]);
    } else {
      run(`INSERT INTO dance_endless (song_key, song_name, user_key, user_name, score, round, combo, notes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [songKey, songName, finalUserKey, finalUserName, score, round, combo, notes]);
    }
    saveDB();
    res.json({ ok: true, updated: true });
  } catch (e) {
    res.status(500).json({ error: '无尽成绩提交失败：' + e.message });
  }
});

// 上传类错误的统一 JSON 返回（文件超限 / 类型不对），不影响其他路由
app.use((err, req, res, next) => {
  if (err && (err instanceof multer.MulterError || /只支持音频文件/.test(err.message || ''))) {
    return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? '音频超过 30MB 上限' : err.message });
  }
  next(err);
});
// ===== 启动 =====
initDB().then(() => {
  console.log('数据库初始化完成');
  ensureBirthdayNotifs();
  setInterval(ensureBirthdayNotifs, 60 * 60 * 1000);  // 每小时检查一次
  ensureDailyBackup();                                // 启动时确保今天已有备份
  setInterval(ensureDailyBackup, 60 * 60 * 1000);     // 每小时检查，跨天自动补备份
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`班级网站已启动 http://localhost:${PORT}`);
  });
});