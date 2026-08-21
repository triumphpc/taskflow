// Офлайн-кеш оболочки приложения. Регистрируется только в secure context
// (https:// или http://localhost) — иначе браузер service worker не разрешит.

const CACHE = 'taskflow-v3';

const SHELL = [
  './',
  './index.html',
  './styles.css',
  './manifest.webmanifest',
  './js/app.js',
  './js/ui.js',
  './js/model.js',
  './js/store.js',
  './js/util.js',
  './js/gcal.js',
  './js/moments.js',
  './js/sync.js',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // Google и всё стороннее — только сеть, кешировать нельзя.
  if (url.origin !== self.location.origin || e.request.method !== 'GET') return;

  // Синхронизация — всегда живая сеть. Закешированный ответ /api означал бы
  // слияние с устаревшим состоянием сервера, то есть потерю правок.
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return;

  // Сеть первична: свежая версия приложения важнее скорости на пару десятков
  // миллисекунд. Кеш — резерв для офлайна.
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request).then((cached) => cached || caches.match('./index.html'))),
  );
});
