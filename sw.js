/* sw.js — Bum Book — bump cache version to force refresh */
const CACHE = 'bumbook-v1';
const ASSETS = [
  './index.html',
  './style.css',
  './firebase.js',
  './cloudinary.js',
  './manifest.json',
  './config.js',
  './utils.js',
  './router.js',
  './auth.js',
  './feed.js',
  './discover.js',
  './profile.js',
  './notifications.js',
  './messages.js',
  './sidebar.js',
  './push.js',
  './boot.js',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  const isLocal = url.origin === self.location.origin;
  const isGet = e.request.method === 'GET';
  if (!isGet || !isLocal) { e.respondWith(fetch(e.request)); return; }
  // Network first — always get fresh JS/CSS, fall back to cache offline
  e.respondWith(
    fetch(e.request).then(res => {
      if (res.ok) {
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
      }
      return res;
    }).catch(() => caches.match(e.request))
  );
});

/* ── Web Push ── displays a notification even if every tab is closed,
   because this service worker keeps running independently of the page. */
self.addEventListener('push', (event) => {
  let data = { title: 'Bum Book', body: '' };
  try { data = event.data.json(); } catch (e) {
    if (event.data) data.body = event.data.text();
  }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body || '',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data: { url: data.url || '/feed' },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || '/feed';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes(targetUrl) && 'focus' in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow(targetUrl);
    })
  );
});
