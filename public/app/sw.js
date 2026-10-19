/* 食刻 · 网页版（PWA）的 Service Worker
 *
 * 只做两件事：
 *   1. 把界面外壳（HTML / CSS / JS / 图标）缓存下来，断网也能打开；
 *   2. 保证「发新版之后能看到新版」—— 导航请求永远先走网络，失败才回落缓存。
 *
 * 接口（/api/*）和别的域名一律不碰：数据和登录态必须是实时的，
 * 缓存一份旧的版本清单反而会让人收到过时的更新提示。
 */
const CACHE = 'shike-shell-1000016';
const SHELL = [
  './',
  'index.html',
  'css/app.css',
  'js/data.js',
  'js/icons.js',
  'js/theme.js',
  'js/api.js',
  'js/app.js',
  'img/icon-180.png',
  'img/icon-192.png',
  'img/icon-512.png',
  'manifest.webmanifest'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' }))))
      .catch(() => null)
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;      // 后端在别的域名，直接走网络
  if (url.pathname.indexOf('/api/') === 0) return;      // 接口永不缓存

  // 打开页面：先要网络上的新版本，失败才用缓存（离线也能进去看已存的数据）
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put('index.html', copy)).catch(() => null);
        return res;
      }).catch(() => caches.match('index.html').then((hit) => hit || caches.match('./')))
    );
    return;
  }

  // 静态文件：先给缓存（快），同时后台更新一份
  e.respondWith(
    caches.match(req).then((hit) => {
      const refresh = fetch(req).then((res) => {
        if (res && res.status === 200) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => null);
        }
        return res;
      }).catch(() => null);
      return hit || refresh.then((r) => r || caches.match('index.html'));
    })
  );
});
