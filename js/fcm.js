// ═══════════════════════════════════════════════════════════════
// ══  FCM PUSH NOTIFICATION SYSTEM
// ══
// ══  FIXES APPLIED:
// ══
// ══  FIX A — PWA foreground double-banner
// ══    Root cause: Firebase onMessage AND the service-worker
// ══    postMessage both called _showInAppNotif for the same push.
// ══    Fix: onMessage is the sole foreground-banner source.
// ══    SW postMessage handles NOTIF_CLICK (tap navigation) ONLY.
// ══    _isDuplicate() marks the id so any late SW echo is dropped.
// ══
// ══  FIX B — Capacitor APK not receiving notifications
// ══    Root cause: window.Capacitor.isNativePlatform() was called
// ══    synchronously before the native bridge finished injecting
// ══    the PushNotifications plugin into window.Capacitor.Plugins.
// ══    Fix: _capacitorReady() polls up to 3 s for the plugin to
// ══    appear before proceeding, then falls through to web path
// ══    if still unavailable.
// ══
// ══  FIX C — Duplicate OS notifications (Android tray)
// ══    Root cause: Token stored in TWO Firestore locations:
// ══      • fcmTokens/{uid}.token   (written by _saveTokenToFirestore)
// ══      • users/{uid}.fcmToken    (old field, written elsewhere)
// ══    Cloud Function _getNotifTokens() read BOTH locations. If
// ══    they held different values (stale vs fresh token), it sent
// ══    two separate FCM requests → 2 OS notifications per event.
// ══    Fix: _saveTokenToFirestore now writes both locations in one
// ══    batch so they are always identical. Dedup-by-value in
// ══    _getNotifTokens() then collapses them to a single send.
// ═══════════════════════════════════════════════════════════════
let _fcmToken     = null;
let _fcmServerKey = null;

// ─────────────────────────────────────────────────────────────
// FIX 2: DEDUP GUARDS — prevents "open app 10x = 10 banners"
//
// Root cause: onSnapshot listeners always replay the entire
// collection on first attach. Every app open = full replay.
//
// Guard A — _appOpenedAt: ignore any doc created before this
//           page load (± 5 s buffer). New docs pass through.
//
// Guard B — _shownNotifIds: a Set that tracks every notification
//           ID shown this session. Prevents the same push
//           arriving twice (e.g. mirror-write race condition).
// ─────────────────────────────────────────────────────────────
const _shownNotifIds = new Set();
const _appOpenedAt   = Date.now();  // timestamp when page loaded

function _isDuplicate(id) {
  if (!id) return false;
  if (_shownNotifIds.has(id)) return true;
  _shownNotifIds.add(id);
  return false;
}

function _isTooOld(createdAt) {
  if (!createdAt) return false;
  const ms = createdAt.toMillis  ? createdAt.toMillis()
           : createdAt.seconds   ? createdAt.seconds * 1000
           : Number(createdAt);
  return ms < (_appOpenedAt - 5000); // older than page load → skip
}

// ── Load server key from Firestore ───────────────────────────
async function _loadFcmServerKey() {
  if (_fcmServerKey) return _fcmServerKey;
  try {
    const snap = await window.__SF.getDoc(
      window.__SF.doc(window.__SF.db, 'config', 'app')
    );
    if (snap.exists()) _fcmServerKey = snap.data().fcmServerKey || null;
  } catch(e) { console.warn('[FCM] Could not load server key:', e.message); }
  return _fcmServerKey;
}

function _getMessagingInstance() {
  return window.__SF && window.__SF.messaging ? window.__SF.messaging : null;
}

// ── Save token to Firestore (shared by web + native paths) ───
// ─────────────────────────────────────────────────────────────
// FIX C (duplicate OS notifications — token stored in two places):
//
// Root cause: The Cloud Function's _getNotifTokens() collects tokens
// from BOTH users/{uid}.fcmToken AND fcmTokens/{uid}.token.
// If these two locations held different values (e.g. stale web token
// on the user doc vs fresh APK token in fcmTokens), the function
// sent separate FCM requests for each → 2 OS notifications per event.
//
// Fix: Always write the token to BOTH locations in one batch so they
// are always identical. _getNotifTokens() dedup-by-value then
// collapses them to a single send regardless of which path it uses.
// ─────────────────────────────────────────────────────────────
async function _saveTokenToFirestore(token) {
  try {
    const batch = window.__SF.writeBatch(window.__SF.db);

    // Primary store — read by sendPushToUsers() and Cloud Function
    batch.set(
      window.__SF.doc(window.__SF.db, 'fcmTokens', CU.uid),
      {
        token,
        uid:       CU.uid,
        name:      CU.name,
        role:      CU.role,
        zoneId:    CU.zoneId || null,
        updatedAt: window.__SF.serverTimestamp(),
        device:    navigator.userAgent.slice(0, 120),
      },
      { merge: true }
    );

    // Mirror onto user doc — keeps users/{uid}.fcmToken in sync so
    // _getNotifTokens() primary-path dedup-by-value always collapses
    // both locations to one token and one send.
    batch.update(
      window.__SF.doc(window.__SF.db, 'users', CU.uid),
      { fcmToken: token }
    );

    await batch.commit();
    console.log('[FCM] Token saved to Firestore ✅');
  } catch(e) {
    console.warn('[FCM] Token save failed:', e.message);
  }
}

// ── Navigate to a screen by name ─────────────────────────────
// FIX 1: Called when notification is tapped (from SW postMessage
//        or from Capacitor pushNotificationActionPerformed).
// Map screen names to your actual page-switching function.
function _navigateToScreen(screen) {
  if (!screen) return;
  console.log('[FCM] Navigating to screen:', screen);
  // Replace showPage() with whatever your app uses to switch tabs/pages
  if (typeof showPage === 'function') {
    showPage(screen);
    return;
  }
  // Fallback: check ?screen= on page URL (app closed → reopened)
  const url = new URL(window.location.href);
  if (url.searchParams.get('screen')) {
    url.searchParams.delete('screen');
    window.history.replaceState({}, '', url);
  }
}

// ── Native Capacitor push (Android/iOS APK) ──────────────────
async function _initCapacitorPush() {
  // ─────────────────────────────────────────────────────────────
  // FIX (Capacitor): Capacitor plugins are injected asynchronously
  // by the native bridge. Polling up to 3 s gives the bridge time
  // to register PushNotifications before we give up.
  // ─────────────────────────────────────────────────────────────
  const _capacitorReady = () => new Promise((resolve) => {
    // Already available — resolve immediately
    if (window.Capacitor?.isNativePlatform?.() && window.Capacitor?.Plugins?.PushNotifications) {
      return resolve(true);
    }
    // Not a native platform at all — no point waiting
    if (window.Capacitor && !window.Capacitor.isNativePlatform?.()) {
      return resolve(false);
    }
    // Wait for the bridge to finish injecting plugins (up to 3 s)
    let elapsed = 0;
    const interval = setInterval(() => {
      elapsed += 100;
      if (window.Capacitor?.Plugins?.PushNotifications) {
        clearInterval(interval);
        resolve(true);
      } else if (elapsed >= 3000) {
        clearInterval(interval);
        resolve(false);
      }
    }, 100);
  });

  const isReady = await _capacitorReady();
  if (!isReady) return false;

  // Native push needs Firebase configured for this APK's app id. Without it
  // PushNotifications.register() crashes the whole app (FirebaseApp not
  // initialised), so skip native push and stay quiet instead.
  try {
    const info = await window.Capacitor.Plugins.App?.getInfo?.();
    const ids = window.__PUSH_APP_IDS || [];
    if (!info?.id || !ids.includes(info.id)) {
      console.warn('[FCM] Push disabled: no Firebase config for app id', info?.id);
      return true; // native app — don't fall through to web push
    }
  } catch (e) {
    console.warn('[FCM] Push disabled: app id check failed:', e.message);
    return true;
  }

  try {
    const { PushNotifications } = window.Capacitor.Plugins;
    if (!PushNotifications) {
      console.warn('[FCM] PushNotifications plugin not found');
      return false;
    }

    const permResult = await PushNotifications.requestPermissions();
    if (permResult.receive !== 'granted') {
      console.log('[FCM] Native push permission denied');
      return true; // still handled by native path — don't fall through to web
    }

    await PushNotifications.register();

    PushNotifications.addListener('registration', async (token) => {
      console.log('[FCM] Native token:', token.value);
      _fcmToken = token.value;
      await _saveTokenToFirestore(token.value);
    });

    PushNotifications.addListener('registrationError', (err) => {
      console.warn('[FCM] Native registration error:', err.error);
    });

    // Foreground notification — dedup before showing
    PushNotifications.addListener('pushNotificationReceived', (notification) => {
      const id = notification.id || notification.data?.notifId || notification.title;
      if (_isDuplicate(id)) return;
      _showInAppNotif(notification.title, notification.body, notification.data || {});
    });

    // FIX 1 (native): notification tapped → navigate to correct screen
    PushNotifications.addListener('pushNotificationActionPerformed', (action) => {
      const data = action.notification.data || {};
      if (data.screen) _navigateToScreen(data.screen);
    });

    console.log('[FCM] Capacitor native push initialized ✅');
    return true;
  } catch(e) {
    console.warn('[FCM] Capacitor push init error:', e.message);
    return false;
  }
}

// ── Init FCM: native APK first, web PWA fallback ─────────────
async function initFCM() {
  const handledByNative = await _initCapacitorPush();
  if (handledByNative) return;

  // Web PWA path
  try {
    if (!('Notification' in window) || !('serviceWorker' in navigator)) return;

    const reg = await navigator.serviceWorker.register('/firebase-messaging-sw.js');

    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      console.log('[FCM] Notification permission denied');
      return;
    }

    let vapidKey = null;
    try {
      const cfgSnap = await window.__SF.getDoc(window.__SF.doc(window.__SF.db, 'config', 'app'));
      if (cfgSnap.exists()) {
        vapidKey = cfgSnap.data().vapidKey || cfgSnap.data().fcmVapidKey || null;
        if (!_fcmServerKey) _fcmServerKey = cfgSnap.data().fcmServerKey || null;
      }
    } catch(e) { console.warn('[FCM] Could not load config:', e.message); }

    if (!vapidKey) { console.warn('[FCM] No vapidKey in Firestore config/app — push disabled'); return; }

    const messaging = _getMessagingInstance();
    if (!messaging) { console.warn('[FCM] Firebase Messaging not available'); return; }

    const token = await window.__SF.getToken(messaging, { vapidKey, serviceWorkerRegistration: reg });
    if (!token) { console.warn('[FCM] No token received'); return; }
    _fcmToken = token;
    await _saveTokenToFirestore(token);
    console.log('[FCM] Token registered ✅');

    // ─────────────────────────────────────────────────────────────
    // FIX (PWA double-banner):
    //
    // Root cause: Two paths both call _showInAppNotif for the same
    // foreground message:
    //   Path A — Firebase onMessage (fires while app is open)
    //   Path B — SW postMessage (the service worker also fires a
    //             message event for every push, even in foreground)
    //
    // Fix: onMessage is the ONLY source of foreground banners.
    // SW postMessage is used ONLY for NOTIF_CLICK (tap navigation).
    // We also register the messageId in _shownNotifIds inside
    // onMessage so that any late SW echo is silently dropped by
    // _isDuplicate().
    // ─────────────────────────────────────────────────────────────
    if (typeof window.__SF.onMessage === 'function') {
      window.__SF.onMessage(messaging, payload => {
        const id = payload.messageId || payload.data?.notifId || payload.notification?.title;
        if (_isDuplicate(id)) return;          // marks id as seen
        const { title, body } = payload.notification || {};
        _showInAppNotif(title, body, payload.data || {});
      });
    }

    // FIX 1 (web): SW postMessage — ONLY handle tap navigation, never show banners here
    navigator.serviceWorker.addEventListener('message', (event) => {
      if (event.data?.type === 'NOTIF_CLICK') {
        // Also mark as seen so onMessage doesn't re-show if app was backgrounded
        if (event.data?.notifId) _isDuplicate(event.data.notifId);
        _navigateToScreen(event.data.screen);
      }
      // All other SW message types (e.g. PUSH_RECEIVED) are intentionally ignored here
      // to prevent duplicate banners. onMessage above is the sole foreground banner source.
    });

    // FIX 1 (web): handle ?screen= if app was closed when notif was tapped
    const urlScreen = new URLSearchParams(window.location.search).get('screen');
    if (urlScreen) {
      // Small delay so the app finishes its own init first
      setTimeout(() => _navigateToScreen(urlScreen), 800);
    }

  } catch(e) {
    console.warn('[FCM] initFCM error:', e.message);
  }
}

// ── In-app notification banner (foreground) ──────────────────
function _showInAppNotif(title, body, data={}) {
  const wrap = document.createElement('div');
  wrap.style.cssText = `
    position:fixed;top:16px;right:16px;z-index:99999;
    background:var(--s1);border:1px solid var(--bdr);
    border-left:4px solid var(--acc);
    border-radius:var(--r);padding:14px 16px;
    max-width:320px;box-shadow:0 8px 24px rgba(0,0,0,.35);
    animation:slideInRight .3s ease;font-family:'DM Sans',sans-serif;
    cursor:pointer;
  `;
  wrap.innerHTML = `
    <div style="display:flex;align-items:flex-start;gap:10px">
      <div style="font-size:22px;flex-shrink:0">🔔</div>
      <div style="flex:1;min-width:0">
        <div style="font-weight:700;font-size:13px;color:var(--tx);margin-bottom:3px">${title||'STSB'}</div>
        <div style="font-size:12px;color:var(--tx2);line-height:1.4">${body||''}</div>
      </div>
      <button onclick="this.parentElement.parentElement.remove()" style="background:none;border:none;color:var(--tx3);cursor:pointer;font-size:16px;padding:0;flex-shrink:0">✕</button>
    </div>
  `;

  // Tapping the banner body navigates to the screen
  wrap.addEventListener('click', (e) => {
    if (e.target.tagName === 'BUTTON') return;
    if (data.screen) _navigateToScreen(data.screen);
    wrap.remove();
  });

  if (!document.getElementById('notifStyle')) {
    const s = document.createElement('style');
    s.id = 'notifStyle';
    s.textContent = '@keyframes slideInRight{from{transform:translateX(120%);opacity:0}to{transform:translateX(0);opacity:1}}';
    document.head.appendChild(s);
  }
  document.body.appendChild(wrap);
  setTimeout(() => wrap.remove(), 7000);
}

// ── Fetch tokens for given UIDs ──────────────────────────────
async function _getTokensForUids(uids) {
  const tokens = [];
  await Promise.all(uids.map(async uid => {
    try {
      const snap = await window.__SF.getDoc(
        window.__SF.doc(window.__SF.db, 'fcmTokens', uid)
      );
      if (snap.exists() && snap.data().token) tokens.push(snap.data().token);
    } catch(e) {}
  }));
  return tokens;
}

// ── Admin UIDs helper ─────────────────────────────────────────
function _adminUids() {
  return allUsers
    .filter(u => (u.role==='admin'||u.role==='sub_admin') && u.uid !== CU.uid)
    .map(u => u.uid);
}

// ── Core send — writes to Firestore pushQueue ─────────────────
async function sendPushToUsers(uids, title, body, data={}) {
  if (!uids || !uids.length) return;
  const tokens = await _getTokensForUids(uids.filter(id => id !== CU.uid));
  if (!tokens.length) { console.log('[FCM] No tokens found for recipients'); return; }
  try {
    await window.__SF.addDoc(
      window.__SF.collection(window.__SF.db, 'pushQueue'),
      {
        tokens,
        uids:       uids.filter(id => id !== CU.uid),
        title:      title || 'STSB',
        body:       body || '',
        data:       data || {},
        icon:       '/icon-192.png',
        priority:   'high',
        sentBy:     CU.uid,
        sentByName: CU.name,
        status:     'pending',
        createdAt:  window.__SF.serverTimestamp(),
      }
    );
    console.log('[FCM] Push queued for', tokens.length, 'device(s) ✅');
  } catch(e) {
    console.warn('[FCM] pushQueue write failed:', e.message);
  }
}

// ── Convenience wrappers ──────────────────────────────────────
async function notifyAdmins(title, body, data={}) {
  await sendPushToUsers(_adminUids(), title, body, data);
}
async function notifyUser(uid, title, body, data={}) {
  await sendPushToUsers([uid], title, body, data);
}
async function notifyRep(repUid, title, body, data={}) {
  if (repUid && repUid !== CU.uid) await sendPushToUsers([repUid], title, body, data);
}

// ─────────────────────────────────────────────────────────────
// HOW TO USE _isTooOld() IN YOUR OTHER onSnapshot LISTENERS
// ─────────────────────────────────────────────────────────────
// If you have onSnapshot listeners elsewhere (broadcasts, visits,
// etc.) that call _showInAppNotif, wrap them like this:
//
//   onSnapshot(query, (snap) => {
//     snap.docChanges().forEach(change => {
//       if (change.type !== 'added') return;
//       const d = change.doc.data();
//       if (_isTooOld(d.createdAt))       return; // existed before app opened
//       if (_isDuplicate(change.doc.id))  return; // already shown
//       _showInAppNotif(d.title, d.message, d);
//     });
//   });
// ─────────────────────────────────────────────────────────────
