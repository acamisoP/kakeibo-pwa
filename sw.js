// v1: PWAインストール要件を満たすための最小実装。
// オフライン撮影→後送信(キューイング)は v1.1 で実装予定。
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => { /* パススルー */ });
