self.addEventListener('install', event => {
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', event => {
  // Simple network-first strategy for API calls, cache-first for assets could be added
  event.respondWith(fetch(event.request).catch(() => caches.match(event.request)));
});
