// 由 sync_public.py 根据站点内容生成版本，更新页面时同步刷新离线资源。
const CACHE = 'jiaban-41fb3609b73e';
const ASSETS = ['./', './index.html', './sync-core.js', './sync-client.js', './app-update.js', './manifest.json', './icon.svg', './icon-192.png', './icon-512.png'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(
    keys.filter(key => key.startsWith('jiaban-') && key !== CACHE).map(key => caches.delete(key))
  )).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const request = event.request, url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/') || url.pathname.startsWith('/downloads/')) return;
  // 只处理应用外壳，避免给缺失的图标或其他请求返回 HTML。
  const navigation = request.mode === 'navigate';
  if (!navigation && !ASSETS.some(asset => new URL(asset, self.registration.scope).href === url.href)) return;
  const response = fetch(request);
  event.waitUntil(response.then(async res => {
    if (res.ok && !res.redirected) {
      const copy = res.clone();
      const cache = await caches.open(CACHE);
      await cache.put(request, copy);
    }
  }).catch(() => {}));
  const cachedResponse = async () => {
    const cache = await caches.open(CACHE);
    return await cache.match(request) || (navigation && await cache.match('./index.html'));
  };
  // 服务器暂时不可用时也能使用已缓存的页面；没有副本则保留原始错误响应。
  event.respondWith(response.then(async res => res.ok ? res : await cachedResponse() || res,
    async () => await cachedResponse() || Response.error()));
});
