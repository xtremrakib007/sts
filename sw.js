/**
 * STFM — Service Worker
 *
 * ★ HOW UPDATES REACH USERS:
 *   Merging to main builds and deploys Hosting. Nothing to bump by hand:
 *   • Pages are fetched network-first and revalidated on every open.
 *   • JS/CSS URLs carry a ?v=<build hash>, so the immutable HTTP cache
 *     never serves an old bundle.
 *   The Android app bundles its code and updates over the air from
 *   /ota/ (see build.js and js/boot.js).
 *
 * Bump CACHE_VERSION only when this file's caching rules change.
 *
 * Users NEVER need to manually clear their browser cache.
 */

const CACHE_VERSION = 'stfm-v12';           // Bump when the hosted app shell changes

const APP_SHELL = [
  '/',
  '/index.html',
  '/js/app.min.js',
  '/app.css',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
];

// Third-party CDN resources cached separately — NOT cleared on version bump
// (fonts, Firebase SDK, etc. are versioned by their own URLs)
const CDN_CACHE = 'stfm-cdn-v1';

// These request origins always go network-only — never cache Firebase API calls
const NETWORK_ONLY_ORIGINS = [
  'firestore.googleapis.com',
  'firebase.googleapis.com',
  'identitytoolkit.googleapis.com',
  'securetoken.googleapis.com',
  'fcmregistrations.googleapis.com',
  'firebaseinstallations.googleapis.com',
  'api.anthropic.com',
];

// ─────────────────────────────────────────────────────────────────────────────
// INSTALL — cache app shell, then skip waiting immediately
// ─────────────────────────────────────────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting()) // ← take over without waiting for old SW to die
      .catch(err => {
        console.warn('[SW] Install cache failed (non-fatal):', err);
        return self.skipWaiting(); // still skip waiting even if pre-cache partially fails
      })
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// ACTIVATE — delete ALL old caches, claim all open clients immediately
// ─────────────────────────────────────────────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== CACHE_VERSION && k !== CDN_CACHE)
          .map(k => {
            console.log('[SW] Deleting old cache:', k);
            return caches.delete(k);
          })
      )
    ).then(() => self.clients.claim()) // claim all open tabs immediately
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// FETCH — routing strategy
// ─────────────────────────────────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // 1. Network-only: Firebase + API calls — never cache these
  if (NETWORK_ONLY_ORIGINS.some(o => url.hostname.includes(o))) {
    event.respondWith(fetch(request));
    return;
  }

  // 2. Non-GET requests — always network
  if (request.method !== 'GET') {
    event.respondWith(fetch(request));
    return;
  }

  // 3. Update packages for the Android app — never cached by this worker.
  //    The app runs on its own origin and fetches these cross-origin, so
  //    they must not fall through to the cache-first CDN rule below.
  if (url.pathname.startsWith('/ota/') &&
      (url.origin === self.location.origin || url.hostname === 'stfm-sales.web.app')) {
    event.respondWith(fetch(request));
    return;
  }

  // 4. App shell (same origin) — Network-first, fall back to cache
  //    Pages revalidate with the server on every load, so a new deploy is
  //    picked up on the next open; JS/CSS URLs carry a ?v= build hash.
  //    The cached copy is used when offline.
  if (url.origin === self.location.origin) {
    const fresh = request.mode === 'navigate' ? fetch(request, { cache: 'no-cache' }) : fetch(request);
    event.respondWith(
      fresh
        .then(response => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_VERSION).then(cache => cache.put(request, clone));
          }
          return response;
        })
        // Offline fallback; ignoreSearch lets a new ?v= URL use the cached copy
        .catch(() => caches.match(request, { ignoreSearch: true })
          .then(hit => hit || (request.mode === 'navigate' ? caches.match('/index.html') : undefined)))
    );
    return;
  }

  // 5. CDN resources (fonts, Firebase SDK from CDN, etc.) — Cache-first
  event.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached;
      return fetch(request).then(response => {
        if (response && response.status === 200) {
          const clone = response.clone();
          caches.open(CDN_CACHE).then(cache => cache.put(request, clone));
        }
        return response;
      });
    })
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// MESSAGE — legacy support (applySwUpdate() in index.html sends SKIP_WAITING)
// No longer needed since we auto-skip, but kept for compatibility
// ─────────────────────────────────────────────────────────────────────────────
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
