// Service Worker：离线也能打开应用外壳；动态数据(/api)始终走网络
const CACHE_NAME = 'class-app-v2';
const APP_SHELL = [
  '/',
  '/index.html',
  '/app.js',
  '/style.css',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;                 // 发帖/点赞/投票等一律不拦截
  const url = new URL(req.url);
  if (url.pathname.startsWith('/api/')) return;    // 动态接口永远请求最新
  if (url.pathname.startsWith('/uploads/')) return;// 用户上传文件不缓存（避免占满空间）

  // 静态资源：网络优先（保证代码更新后用户能立刻拿到新版本），离线时回退缓存
  e.respondWith(
    fetch(req).then(res => {
      if (res.ok && url.origin === self.location.origin) {
        const copy = res.clone();
        caches.open(CACHE_NAME).then(c => c.put(req, copy));
      }
      return res;
    }).catch(() => caches.match(req).then(hit => hit || caches.match('/index.html')))
  );
});
