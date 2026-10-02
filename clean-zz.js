// Clean up zz_ test accounts and their related data (checkins/posts/etc.)
// Also cleans guest test data (device ids prefixed with zz-guest-), even when
// no zz_ test account exists (guest-only API tests don't create users).
// Usage: node clean-zz.js   (must be run while server is stopped)

const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const DB_FILE = path.join(__dirname, 'classroom.sqlite');

(async () => {
  if (!fs.existsSync(DB_FILE)) {
    console.log('DB file not found, nothing to clean');
    return;
  }
  const SQL = await initSqlJs();
  const db = new SQL.Database(fs.readFileSync(DB_FILE));

  // ---- 游客接口测试数据：统一使用 zz-guest- 前缀的设备号，会落在真实帖子/工具上 ----
  db.run(`DELETE FROM likes WHERE device_id LIKE 'zz-guest-%'`);
  db.run(`DELETE FROM comments WHERE device_id LIKE 'zz-guest-%'`);
  db.run(`DELETE FROM tool_likes WHERE device_id LIKE 'zz-guest-%'`);
  // 游客行为产生的通知（落在真实用户头上；功能上线前无真实游客数据）
  db.run(`DELETE FROM notifications WHERE actor_id = 0`);
  console.log('Guest test data (zz-guest-*) cleaned');

  // ---- zz_ 测试账号及其关联数据 ----
  const zzUsers = db.exec("SELECT id, username FROM users WHERE username LIKE 'zz_%'");
  const ids = zzUsers.length ? zzUsers[0].values.map(r => r[0]) : [];
  if (ids.length > 0) {
    console.log('Found zz_ accounts:', ids.join(', '));
    // Delete dependent rows first (no FK constraints enforced in sqlite by default)
    const ph = ids.map(() => '?').join(',');
    db.run(`DELETE FROM checkins WHERE user_id IN (${ph})`, ids);
    db.run(`DELETE FROM post_views WHERE user_id IN (${ph})`, ids);
    db.run(`DELETE FROM poll_votes WHERE user_id IN (${ph})`, ids);
    db.run(`DELETE FROM likes WHERE user_id IN (${ph})`, ids);
    db.run(`DELETE FROM favorites WHERE user_id IN (${ph})`, ids);
    db.run(`DELETE FROM comments WHERE user_id IN (${ph})`, ids);
    // Delete posts by zz_ users (and their dependent rows)
    const postIds = db.exec(`SELECT id FROM posts WHERE user_id IN (${ph})`, ids);
    if (postIds.length) {
      const pids = postIds[0].values.map(r => r[0]);
      const ph2 = pids.map(() => '?').join(',');
      db.run(`DELETE FROM likes WHERE post_id IN (${ph2})`, pids);
      db.run(`DELETE FROM comments WHERE post_id IN (${ph2})`, pids);
      db.run(`DELETE FROM favorites WHERE post_id IN (${ph2})`, pids);
      db.run(`DELETE FROM poll_votes WHERE post_id IN (${ph2})`, pids);
      db.run(`DELETE FROM post_views WHERE post_id IN (${ph2})`, pids);
      db.run(`DELETE FROM notifications WHERE post_id IN (${ph2})`, pids);
      db.run(`DELETE FROM reports WHERE post_id IN (${ph2})`, pids);
      db.run(`DELETE FROM posts WHERE user_id IN (${ph})`, ids);
    }
    // 举报记录（zz 账号举报别人的，以及对 zz 帖子的举报）
    db.run(`DELETE FROM reports WHERE reporter_id IN (${ph})`, ids);
    db.run(`DELETE FROM reports WHERE post_id NOT IN (SELECT id FROM posts)`, []);
    // 工具分享：zz 账号的赞、zz 账号上传的工具及其赞
    db.run(`DELETE FROM tool_likes WHERE user_id IN (${ph})`, ids);
    db.run(`DELETE FROM tools WHERE user_id IN (${ph})`, ids);
    // 测试分类（zz_ 前缀）；先把引用置 0 再删
    db.run(`UPDATE tools SET category_id = 0 WHERE category_id IN (SELECT id FROM tool_categories WHERE name LIKE 'zz_%')`);
    db.run(`DELETE FROM tool_categories WHERE name LIKE 'zz_%'`);
    // 学习资料库：zz 账号上传的资料行（测试上传的物理文件由测试脚本单独删）
    db.run(`DELETE FROM resources WHERE user_id IN (${ph})`, ids);
    // 测试课程（zz_ 前缀，正常情况下此时已为空课程）
    db.run(`DELETE FROM courses WHERE name LIKE 'zz[_]%'`);
    // Messages / conversation_members
    db.run(`DELETE FROM messages WHERE sender_id IN (${ph})`, ids);
    db.run(`DELETE FROM conversation_members WHERE user_id IN (${ph})`, ids);
    // 清掉成员已全部删除的孤儿会话（测试用私聊/群聊行）及其残留消息
    db.run(`DELETE FROM messages WHERE conversation_id NOT IN (SELECT DISTINCT conversation_id FROM conversation_members)`);
    db.run(`DELETE FROM conversations WHERE id NOT IN (SELECT DISTINCT conversation_id FROM conversation_members)`);
    // 留言板 / 主页访客：zz 账号写的、以及落在 zz 主页上的
    db.run(`DELETE FROM board_messages WHERE author_uid IN (${ph})`, ids);
    db.run(`DELETE FROM board_messages WHERE target_uid IN (${ph})`, ids);
    db.run(`DELETE FROM profile_visits WHERE visitor_uid IN (${ph})`, ids);
    db.run(`DELETE FROM profile_visits WHERE target_uid IN (${ph})`, ids);
    // Notifications
    db.run(`DELETE FROM notifications WHERE user_id IN (${ph})`, ids);
    db.run(`DELETE FROM notifications WHERE actor_id IN (${ph})`, ids);
    // Finally delete the user rows
    db.run(`DELETE FROM users WHERE id IN (${ph})`, ids);
    console.log('zz_ accounts cleaned');
  } else {
    console.log('No zz_ test accounts to clean');
  }

  fs.writeFileSync(DB_FILE, Buffer.from(db.export()));
  console.log('Done');
  db.close();
})().catch(e => { console.error('ERROR:', e); process.exit(1); });
