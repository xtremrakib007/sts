// ═══════════════════════════════════════════════════════════════
// ══  FIREBASE MESSAGING SERVICE WORKER
// ══  Place this file at the ROOT of your project: /firebase-messaging-sw.js
// ══
// ══  CRITICAL — Double-notification fix:
// ══    This SW must NOT postMessage('PUSH_RECEIVED') or call
// ══    any equivalent that triggers a banner in the app.
// ══    The app's onMessage() handler (in fcm.js) is the ONLY
// ══    source of foreground in-app banners.
// ══
// ══    This SW is responsible for:
// ══      1. Background push → show OS notification (app closed/hidden)
// ══      2. Notification click → postMessage NOTIF_CLICK to app
// ══         so fcm.js can navigate to the right screen
// ══
// ══    When the app IS in the foreground, Firebase SDK suppresses
// ══    the OS notification automatically and fires onMessage()
// ══    instead — so we never show a banner here in that case.
// ═══════════════════════════════════════════════════════════════

importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey:            'AIzaSyC0cO3x4Oqi8GBUhzON-InN3YZTm-RfMyA',
  authDomain:        'stfm-sales.firebaseapp.com',
  projectId:         'stfm-sales',
  storageBucket:     'stfm-sales.firebasestorage.app',
  messagingSenderId: '53800678989',
  appId:             '1:53800678989:web:bce1be11a8beb92c084e04',
});

const messaging = firebase.messaging();

// ── Background push handler ───────────────────────────────────
// Fires when the app is closed or in the background.
// When the app IS open, Firebase SDK intercepts the push and fires
// onMessage() in the page instead — this handler does NOT run.
messaging.onBackgroundMessage((payload) => {
  console.log('[SW] Background push received:', payload);

  const title = payload.notification?.title || payload.data?.title || 'STSB';
  const body  = payload.notification?.body  || payload.data?.body  || '';
  const icon  = payload.notification?.icon  || '/icon-192.png';
  const data  = payload.data || {};

  // ── IMPORTANT: do NOT postMessage('PUSH_RECEIVED') here. ──
  // If the app is open, Firebase SDK already called onMessage()
  // in the page. If the app is closed, there's no page to receive
  // a postMessage anyway. Either way, posting here causes duplicates.

  return self.registration.showNotification(title, {
    body,
    icon,
    badge:  '/icon-96.png',
    tag:    data.notifId || title,  // same tag = replaces duplicate OS toasts
    renotify: false,
    data,   // passed through to notificationclick event below
  });
});

// ── Notification tap handler ──────────────────────────────────
// Fires when the user taps the OS notification banner.
// Focuses or opens the app, then posts NOTIF_CLICK so fcm.js
// can navigate to the right screen.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const data   = event.notification.data || {};
  const screen = data.screen || null;
  const notifId = data.notifId || null;

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // Re-use an existing open tab if possible
      for (const client of clientList) {
        if ('focus' in client) {
          client.focus();
          // Tell fcm.js which screen to navigate to
          client.postMessage({
            type:    'NOTIF_CLICK',
            screen,
            notifId,
          });
          return;
        }
      }
      // No existing tab — open a new one (with ?screen= so fcm.js
      // can pick it up after the app finishes initialising)
      const url = screen
        ? `${self.registration.scope}?screen=${encodeURIComponent(screen)}`
        : self.registration.scope;
      return clients.openWindow(url);
    })
  );
});
