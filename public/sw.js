// Parys Saint-Barber — Service Worker
// Hand-written, no build step, no external libraries (Workbox etc).
// Served as-is from /public/sw.js, so it must remain plain classic-script JS
// (no ES module imports/exports, no TypeScript).

// Bump this version string whenever the precache list or caching strategy
// changes, so old caches get cleaned up on activate.
const CACHE_NAME = 'parys-shell-v2';

// Statically known shell assets only. Astro emits hashed filenames for its
// JS/CSS bundles, so we deliberately do NOT try to guess those paths here —
// they get cached at runtime instead (see the fetch handler below).
// NOTE: /reelparys.mp4 is intentionally excluded — it's a large video file
// that should never be precached.
const PRECACHE_URLS = [
  '/',
  '/cennik',
  '/kontakt',
  '/offline',
  '/manifest.webmanifest',
  '/favicon.svg',
  '/parys_logo_final.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-512-maskable.png',
];

// Paths matched by exact pathname for the stale-while-revalidate strategy.
const SWR_PATHS = ['/', '/cennik', '/kontakt'];

// `cache.add()`/`cache.put()` reject a Response whose `redirected` flag is
// set (e.g. `/cennik` 307s to `/cennik/`) — re-wrapping strips that flag.
// Shared by precaching and both runtime strategies below.
function stripRedirected(response) {
  return response.redirected ? new Response(response.body, response) : response;
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // Cache each asset individually so a single failed fetch (e.g. a 404
      // on an asset that doesn't exist yet) doesn't abort the whole install,
      // the way a single addAll() failure would.
      return Promise.allSettled(
        PRECACHE_URLS.map((url) =>
          fetch(url)
            .then((response) => cache.put(url, stripRedirected(response)))
            .catch((err) => {
              console.warn('[sw] precache failed for', url, err);
            })
        )
      );
    }).then(() => {
      // Activate the new service worker as soon as it finishes installing,
      // without waiting for existing tabs to close.
      return self.skipWaiting();
    })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      );
    }).then(() => {
      // Take control of any already-open clients immediately, so the new
      // caching logic applies without requiring a page reload.
      return self.clients.claim();
    })
  );
});

// Stale-while-revalidate: serve from cache immediately if available while
// updating the cache in the background; if nothing is cached, wait on the
// network. If the network fails and there's no cache entry, fall back to
// the precached offline page.
function staleWhileRevalidate(request) {
  return caches.open(CACHE_NAME).then((cache) => {
    return cache.match(request).then((cachedResponse) => {
      const networkFetch = fetch(request)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.ok) {
            const cleanResponse = stripRedirected(networkResponse);
            cache.put(request, cleanResponse.clone());
            return cleanResponse;
          }
          return networkResponse;
        })
        .catch(() => null);

      if (cachedResponse) {
        // Update the cache in the background; don't block the response on it.
        networkFetch.catch(() => {});
        return cachedResponse;
      }

      // Nothing cached yet — wait for the network, and fall back to the
      // offline page if that fails too.
      return networkFetch.then((networkResponse) => {
        if (networkResponse) {
          return networkResponse;
        }
        return caches.match('/offline');
      });
    });
  });
}

// Network-first with offline fallback, used for navigations that aren't one
// of the SWR_PATHS above. Ensures navigating while offline never hard-fails
// with no UI at all.
function networkFirstNavigate(request) {
  return fetch(request)
    .then((networkResponse) => stripRedirected(networkResponse))
    .catch(() => {
      return caches.match(request).then((cachedResponse) => {
        return cachedResponse || caches.match('/offline');
      });
    });
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);

  // Never intercept API or panel routes — always go straight to the
  // network, no caching under any circumstance.
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/panel/')) {
    return;
  }

  const isSameOrigin = url.origin === self.location.origin;

  // Stale-while-revalidate for the shell pages. Matched by pathname (rather
  // than request.mode === 'navigate') so prefetch requests to these routes
  // are covered too, not just top-level navigations.
  if (isSameOrigin && request.method === 'GET' && SWR_PATHS.includes(url.pathname)) {
    event.respondWith(staleWhileRevalidate(request));
    return;
  }

  // Network-first with offline fallback for all other navigations, so an
  // offline navigation always resolves to something instead of failing hard.
  if (request.mode === 'navigate') {
    event.respondWith(networkFirstNavigate(request));
    return;
  }

  // Everything else (hashed JS/CSS bundles, images, fonts, etc.) passes
  // through untouched — no respondWith call, default browser behavior.
});

// Push payload shape sent by src/lib/push.ts's sendPushNotification:
// { title: string, body: string, url?: string, tag?: string }
self.addEventListener('push', (event) => {
  let data = {};
  if (event.data) {
    try {
      data = event.data.json();
    } catch (err) {
      console.warn('[sw] failed to parse push payload', err);
    }
  }

  const title = data.title || 'Parys Saint-Barber';
  const options = {
    body: data.body || 'Masz nowe powiadomienie.',
    tag: data.tag,
    data: { url: data.url },
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  const notification = event.notification;
  notification.close();

  const notificationUrl = notification.data && notification.data.url;
  // Notifications without an explicit url are barber-side reminders (new
  // booking, etc.) — send those into the panel rather than the homepage.
  const targetUrl = notificationUrl || (notification.tag && notification.tag.indexOf('barber') !== -1 ? '/panel' : '/');

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        const clientUrl = new URL(client.url, self.location.origin).pathname;
        if (clientUrl === targetUrl && 'focus' in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
      }
    })
  );
});
