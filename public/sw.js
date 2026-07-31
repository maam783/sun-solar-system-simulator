/**
 * Service worker.
 *
 * It exists because a browser will not offer to install a page as an
 * application unless one is registered with a fetch handler. That is the whole
 * of its job, and the first version of it did more than that and was worse for
 * it: caching the HTML meant an installed copy kept starting the build it was
 * installed with, so every later deploy was invisible from inside the app.
 *
 * So the document is never cached. It is fetched with the HTTP cache bypassed
 * as well, because GitHub Pages serves HTML with ten minutes of freshness and
 * that is ten minutes of looking at the wrong thing. Only the build's own
 * assets are kept, and those carry a content hash in the name, so a stale one
 * can never be served for a new build — the name would not match.
 */

const CACHE = 'sun-assets-v2';

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

const isDocument = (request) =>
  request.mode === 'navigate'
  || request.destination === 'document'
  || new URL(request.url).pathname.endsWith('.html')
  || new URL(request.url).pathname.endsWith('/');

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET' || !request.url.startsWith(self.location.origin)) return;

  if (isDocument(request)) {
    event.respondWith((async () => {
      try {
        return await fetch(request, { cache: 'no-store' });
      } catch {
        // Offline. Anything we have is better than a browser error page.
        const cached = await caches.match(request);
        if (cached) return cached;
        throw new Error('offline');
      }
    })());
    return;
  }

  // Assets: serve from cache when we have them, and refresh in the background.
  event.respondWith((async () => {
    const cached = await caches.match(request);
    const network = fetch(request).then(async (response) => {
      if (response.ok) (await caches.open(CACHE)).put(request, response.clone());
      return response;
    }).catch(() => null);
    return cached ?? (await network) ?? Promise.reject(new Error('offline'));
  })());
});
