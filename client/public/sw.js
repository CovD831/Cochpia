// Cochpia Service Worker：仅缓存可安全复用的资源，HTML 和 SW 始终从网络获取。
// CACHE 必须在每次发布时变化，避免旧版本资源继续存活。
const CACHE = 'cochpia-v24';
const CORE = ['/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(CORE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  // HTML is the version entry point: always prefer the network so a new
  // deployment is visible immediately, while retaining an offline fallback.
  const acceptsHtml = request.headers.get('accept')?.includes('text/html');
  if (request.mode === 'navigate' || acceptsHtml || url.pathname === '/sw.js') {
    event.respondWith(
      fetch(request, { cache: 'no-store' })
        .then(response => {
          if (response.ok && url.pathname !== '/sw.js') {
            const clone = response.clone();
            caches.open(CACHE).then(cache => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => caches.match(request))
    );
    return;
  }

  // API 请求：网络优先，失败回退缓存（保证弱网时也能看到上次内容）
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(request)
        .then(response => {
          const clone = response.clone();
          caches.open(CACHE).then(cache => cache.put(request, clone));
          return response;
        })
        .catch(() => caches.match(request))
    );
    return;
  }

  // 静态资源：构建产物使用 Vite hash，可缓存；开发服务器资源不应被旧 SW 接管。
  // 带查询参数的入口资源也优先走网络，防止历史版本的 JS/CSS 被复用。
  const isDevAsset = url.port === '5173' || url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  const isVersionedRequest = url.searchParams.has('v');
  if (isDevAsset || isVersionedRequest) {
    event.respondWith(fetch(request, { cache: 'no-store' }));
    return;
  }
  event.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached;
      return fetch(request).then(response => {
        if (response && response.status === 200 && response.type === 'basic') {
          const clone = response.clone();
          caches.open(CACHE).then(cache => cache.put(request, clone));
        }
        return response;
      });
    })
  );
});
