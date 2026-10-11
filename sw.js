// Offline support: the app opens from the home screen even with no signal,
// showing the last feed it saw (the feed itself is cached in localStorage by app.js).
const CACHE = 'gooldbook-v4';
const APP_SHELL = ['./', 'index.html', 'styles.css?v=4', 'app.js?v=4', 'Manifest.json', 'icon-192.png', 'apple-touch-icon.png'];
// Version-pinned libraries never change, so they can be served from cache first
const PINNED_CDN = ['https://cdnjs.cloudflare.com/', 'https://cdn.jsdelivr.net/npm/html2canvas@', 'https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation@'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // App files: always try the network first so updates show up right away; fall back to cache offline
  if (url.origin === self.location.origin) {
    event.respondWith(
      fetch(req).then(res => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
        return res;
      }).catch(() => caches.match(req).then(hit => hit || caches.match('index.html')))
    );
    return;
  }

  if (PINNED_CDN.some(prefix => req.url.startsWith(prefix))) {
    event.respondWith(
      caches.match(req).then(hit => hit || fetch(req).then(res => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
        return res;
      }))
    );
  }
  // Everything else (feed, images, Giphy) goes straight to the network as before
});
