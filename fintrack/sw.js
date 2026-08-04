// FinTrack v1 — アプリシェルのstale-while-revalidateキャッシュ(オフラインでもシェル起動可)。
// GAS(クロスオリジン)へのデータ要求は一切触らない。
const CACHE = 'fintrack-v1';
const ASSETS = ['./', 'index.html', 'app.js?v=1', 'manifest.json', 'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    caches.match(e.request).then(hit => {
      const fresh = fetch(e.request).then(res => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy));
        }
        return res;
      }).catch(() => hit || (e.request.mode === 'navigate' ? caches.match('./') : undefined));
      return hit || fresh;
    })
  );
});
