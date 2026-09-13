const CACHE_NAME = 'kotoba-no-ki-v3';
const CACHE_PREFIX = 'kotoba-no-ki-';
const APP_SHELL = Object.freeze([
  './',
  './index.html',
  './app.mjs',
  './src/core.mjs',
  './src/cloud-sync.mjs',
  './styles.css',
  './manifest.webmanifest',
  './DATA_SOURCES.md',
  './icons/kotoba-no-ki-192.png',
  './icons/kotoba-no-ki-512.png',
  './data/words.json',
  './data/diagnostic.json',
  './data/katakana.json',
]);
const APP_PATHS = new Set(APP_SHELL.map((asset) => new URL(asset, self.registration.scope).pathname));

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    try {
      // Fetch and validate the complete candidate before writing any entry.
      const fetched = await Promise.all(APP_SHELL.map(async (asset) => {
        const canonical = new Request(new URL(asset, self.registration.scope));
        const versioned = new URL(asset, self.registration.scope);
        versioned.searchParams.set('__precache', CACHE_NAME);
        const response = await fetch(new Request(versioned, { cache: 'reload' }));
        if (!response.ok) throw new Error(`Precache failed (${response.status}): ${asset}`);
        return [canonical, response];
      }));
      const cache = await caches.open(CACHE_NAME);
      await Promise.all(fetched.map(([request, response]) => cache.put(request, response)));
      await self.skipWaiting();
    } catch (error) {
      await caches.delete(CACHE_NAME);
      throw error;
    }
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
      .map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // Never cache Firebase/CDN/API traffic.

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        return await fetch(request);
      } catch {
        const cache = await caches.open(CACHE_NAME);
        return cache.match(new Request(new URL('./index.html', self.registration.scope)));
      }
    })());
    return;
  }

  if (!APP_PATHS.has(url.pathname)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;
    const response = await fetch(request);
    if (response.ok) await cache.put(new Request(url.origin + url.pathname), response.clone());
    return response;
  })());
});
