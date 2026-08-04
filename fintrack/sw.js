// 自壊用SW: FinTrackの移転(→ /fintrack/)に伴い、旧キャッシュを全削除して自分を登録解除し、
// 開いているクライアントを再読込させてリダイレクトページを踏ませる。
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    try {
      const ks = await caches.keys();
      await Promise.all(ks.map(k => caches.delete(k)));
      await self.registration.unregister();
      const cs = await self.clients.matchAll({ type: 'window' });
      cs.forEach(c => c.navigate(c.url));
    } catch (err) { }
  })());
});
