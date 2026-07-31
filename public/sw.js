/**
 * Service worker.
 *
 * It exists for two reasons. The first is that a browser will not offer to
 * install a page as an application unless one is registered with a fetch
 * handler — without this there is no Install button to find. The second is that
 * once installed it should behave like an application, which means opening
 * without a network.
 *
 * Network first, cache as the fallback. The other way round is faster but
 * serves yesterday's build after a deploy, and this is a page that changes.
 */

const CACHE = 'sun-v1';

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET' || !request.url.startsWith(self.location.origin)) return;

  event.respondWith((async () => {
    try {
      const response = await fetch(request);
      if (response.ok) {
        const cache = await caches.open(CACHE);
        cache.put(request, response.clone());
      }
      return response;
    } catch {
      const cached = await caches.match(request);
      if (cached) return cached;
      throw new Error('offline and not cached');
    }
  })());
});
