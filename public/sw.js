/**
 * Service worker.
 *
 * It exists because a browser will not offer to install a page as an
 * application unless one is registered with a fetch handler. That is its whole
 * job, and it has now been wrong twice by trying to do more.
 *
 * The first version cached the document, so an installed copy kept starting the
 * build it was installed with. The second stopped caching the document but kept
 * serving assets from the cache first, on the reasoning that build assets carry
 * a content hash in the name and so can never go stale. That reasoning was
 * false: it holds for the bundle, which Vite renames every build, and not at
 * all for anything in `public/`, which is copied through verbatim.
 * `assets/audio/rcs.mp3` keeps that name forever, so replacing the file changed
 * nothing for anyone who had already loaded it once — they heard the previous
 * take, every time, one version behind for as long as it went on.
 *
 * So: nothing is served from the cache while there is a network. The cache is
 * only what makes the installed app open without one. That costs a revalidation
 * per asset, which the HTTP cache absorbs, and it removes an entire category of
 * bug that cost several rounds to find.
 */

const CACHE = 'sun-v3';

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

const isDocument = (request) => {
  if (request.mode === 'navigate' || request.destination === 'document') return true;
  const path = new URL(request.url).pathname;
  return path.endsWith('.html') || path.endsWith('/');
};

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET' || !request.url.startsWith(self.location.origin)) return;

  event.respondWith((async () => {
    try {
      // The document additionally bypasses the HTTP cache, because Pages serves
      // HTML with ten minutes of freshness and that is ten minutes of looking
      // at the wrong build.
      const response = await fetch(request, isDocument(request) ? { cache: 'no-store' } : undefined);
      if (response.ok && !isDocument(request)) {
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
