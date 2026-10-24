// ═══════════════════════════════════════════════════════════════
// STFM — Push Notification Client (add this to your app.js)
// ═══════════════════════════════════════════════════════════════
// Place this block AFTER firebase.initializeApp() and AFTER
// the user is confirmed signed in (inside your auth listener).
// ═══════════════════════════════════════════════════════════════

// ── 1. Get this from Firebase Console → Project Settings
//       → Cloud Messaging → Web Push certificates → Generate key pair
const FCM_VAPID_KEY = "BMTnzoh_WQPYB6PnQt4U8tUOJhrPUPTMWInhzhARB53s2Z6c4C5JC3M_WP_PN9Ex1dZyB2KKFFwIZD4NOXclQ5c";

// ── 2. FCM instance (requires firebase-messaging.js loaded in HTML)
let _messaging = null;
function getMessaging() {
  if (!_messaging) _messaging = firebase.messaging();
  return _messaging;
}

// ── 3. Call this right after confirming the user is logged in
async function initPushNotifications() {
  // Only supported in secure contexts
  if (!("Notification" in window) || !("serviceWorker" in navigator)) return;

  try {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      console.log("Push notifications declined by user.");
      return;
    }

    const messaging = getMessaging();
    const token = await messaging.getToken({ vapidKey: FCM_VAPID_KEY });

    if (token) {
      await saveFCMToken(token);
      console.log("FCM token saved.");
    }

    // Handle notifications when app is in the FOREGROUND
    messaging.onMessage((payload) => {
      const { title, body } = payload.notification || {};
      const data = payload.data || {};
      showPushToast(title, body, data);
    });

    // Refresh token if it changes
    messaging.onTokenRefresh(async () => {
      const newToken = await messaging.getToken({ vapidKey: FCM_VAPID_KEY });
      if (newToken) await saveFCMToken(newToken);
    });

  } catch (err) {
    console.warn("Push notification setup failed:", err);
  }
}

// ── 4. Save token to the user's Firestore record
async function saveFCMToken(token) {
  const user = firebase.auth().currentUser;
  if (!user) return;

  // currentUser is your app's user object with zone info
  const zone = currentUser?.zone;
  const path = zone
    ? `zones/${zone}/users/${user.uid}`
    : `users/${user.uid}`;

  await firebase.firestore().doc(path).update({
    fcmToken: token,
    fcmUpdatedAt: firebase.firestore.FieldValue.serverTimestamp(),
  });
}

// ── 5. Remove token on logout (stop notifications after sign out)
async function clearFCMToken() {
  try {
    const messaging = getMessaging();
    const token = await messaging.getToken({ vapidKey: FCM_VAPID_KEY });
    if (token) await messaging.deleteToken();

    const user = firebase.auth().currentUser;
    if (!user) return;
    const zone = currentUser?.zone;
    const path = zone
      ? `zones/${zone}/users/${user.uid}`
      : `users/${user.uid}`;

    await firebase.firestore().doc(path).update({ fcmToken: null });
  } catch (e) {
    console.warn("FCM token clear failed:", e);
  }
}

// ── 6. In-app toast notification (shown when app is open)
function showPushToast(title, body, data = {}) {
  // Remove old toasts
  document.querySelectorAll(".push-toast").forEach((el) => el.remove());

  const toast = document.createElement("div");
  toast.className = "push-toast";
  toast.innerHTML = `
    <div class="push-toast-icon">${getNotifIcon(data.type)}</div>
    <div class="push-toast-content">
      <div class="push-toast-title">${title || "STFM"}</div>
      <div class="push-toast-body">${body || ""}</div>
    </div>
    <button class="push-toast-close" onclick="this.parentElement.remove()">✕</button>
  `;

  // Tap to navigate to relevant screen
  if (data.screen) {
    toast.style.cursor = "pointer";
    toast.addEventListener("click", (e) => {
      if (e.target.classList.contains("push-toast-close")) return;
      navigateToScreen(data.screen);
      toast.remove();
    });
  }

  document.body.appendChild(toast);

  // Auto-dismiss after 6 seconds
  setTimeout(() => toast?.remove(), 6000);
}

function getNotifIcon(type) {
  const icons = {
    new_order: "📦",
    order_confirmed: "✅",
    delivery_assigned: "🚚",
    order_delivered: "📬",
    collection: "💰",
    broadcast: "📢",
  };
  return icons[type] || "🔔";
}

// Navigate to a screen in your app — adjust to match your existing nav function
function navigateToScreen(screen) {
  const map = {
    orders: "orders",
    deliveries: "deliveries",
    collection: "collection",
    dashboard: "dashboard",
  };
  const target = map[screen] || "dashboard";
  // Replace showSection / setActiveNav with your actual navigation calls:
  showSection(target);
  setActiveNav(target);
}

// ═══════════════════════════════════════════════════════════════
// WHERE TO CALL THESE FUNCTIONS IN YOUR EXISTING CODE
// ═══════════════════════════════════════════════════════════════
//
// A) After successful login / auth state confirmed:
//    initPushNotifications();
//
// B) In your sign-out function, before firebase.auth().signOut():
//    await clearFCMToken();
//    await firebase.auth().signOut();
//
// ═══════════════════════════════════════════════════════════════
