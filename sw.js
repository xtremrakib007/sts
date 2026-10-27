/**
 * STFM — Service Worker
 *
 * ★ HOW TO PUSH AN UPDATE:
 *   1. Bump CACHE_VERSION below  (e.g. 'v9' → 'v10')
 *   2. Deploy  →  firebase deploy --only hosting
 *
 * The SW will:
 *   • Install the new cache in the background
 *   • Immediately call skipWaiting() — no user action needed
 *   • Delete every old cache on activate
 *   • Claim all open tabs so they reload with fresh assets
 *
 * Users NEVER need to manually clear their browser cache.
 */

const CACHE_VERSION = 'stfm-v11';           // Bump when the hosted app shell changes

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

  // 3. App shell (same origin) — Network-first, fall back to cache
  //    This ensures fresh JS/CSS on reload; cached copy used when offline
  if (url.origin === self.location.origin) {
    event.respondWith(
      fetch(request)
        .then(response => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_VERSION).then(cache => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => caches.match(request)) // offline fallback
    );
    return;
  }

  // 4. CDN resources (fonts, Firebase SDK from CDN, etc.) — Cache-first
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
