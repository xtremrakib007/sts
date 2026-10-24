// ═══════════════════════════════════════════════════════════════
// STFM — Firebase Cloud Functions (v2)
// Deploy: firebase deploy --only functions
// ═══════════════════════════════════════════════════════════════
const { onDocumentCreated, onDocumentUpdated } = require('firebase-functions/v2/firestore');
const { initializeApp }    = require('firebase-admin/app');
const { getFirestore }     = require('firebase-admin/firestore');
const { getMessaging }     = require('firebase-admin/messaging');

initializeApp();

function db() { return getFirestore(); }

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────
async function _getAdminTokens(zoneId) {
  const tokens = new Set();
  const rootSnap = await db().collection('users')
    .where('role', 'in', ['admin', 'sub_admin', 'owner']).get();
  rootSnap.docs.forEach(d => { if (d.data().fcmToken) tokens.add(d.data().fcmToken); });
  if (zoneId) {
    const zSnap = await db().collection(`zones/${zoneId}/users`)
      .where('role', 'in', ['admin', 'sub_admin', 'owner']).get();
    zSnap.docs.forEach(d => { if (d.data().fcmToken) tokens.add(d.data().fcmToken); });
  }
  return [...tokens];
}

async function _getTokenForUid(uid, zoneId) {
  const tokens = new Set();
  try {
    const t = await db().doc(`fcmTokens/${uid}`).get();
    if (t.exists && t.data().token) tokens.add(t.data().token);
    const u = await db().doc(`users/${uid}`).get();
    if (u.exists && u.data().fcmToken) tokens.add(u.data().fcmToken);
    if (zoneId) {
      const z = await db().doc(`zones/${zoneId}/users/${uid}`).get();
      if (z.exists && z.data().fcmToken) tokens.add(z.data().fcmToken);
    }
  } catch(e) {}
  return [...tokens];
}

async function _sendPush(tokens, title, body, data = {}) {
  if (!tokens || !tokens.length) return;
  const unique = [...new Set(tokens.filter(Boolean))];
  if (!unique.length) return;
  const msg = {
    tokens: unique,
    notification: { title: title || 'STSB', body: body || '' },
    android: { priority: 'high', notification: { sound: 'default', channelId: 'fcm_default_channel', color: '#22c55e' } },
    apns:    { payload: { aps: { sound: 'default', badge: 1 } } },
    data: Object.fromEntries(
      Object.entries({ screen: 'dashboard', type: 'general', notifId: Date.now().toString(), ...data })
        .map(([k, v]) => [k, String(v)])
    ),
  };
  try {
    const res = await getMessaging().sendEachForMulticast(msg);
    const bad = [];
    res.responses.forEach((r, i) => {
      if (!r.success && (
        r.error?.code === 'messaging/invalid-registration-token' ||
        r.error?.code === 'messaging/registration-token-not-registered'
      )) bad.push(unique[i]);
    });
    if (bad.length) {
      const snap = await db().collection('fcmTokens').get();
      const batch = db().batch();
      snap.docs.forEach(d => { if (bad.includes(d.data().token)) batch.delete(d.ref); });
      await batch.commit();
    }
    console.log(`[FCM] sent=${res.successCount} failed=${res.failureCount}`);
  } catch(e) { console.error('[FCM] error:', e.message); }
}

// ─────────────────────────────────────────────────────────────
// 1. PUSH QUEUE
// ─────────────────────────────────────────────────────────────
exports.onPushQueueCreated = onDocumentCreated('pushQueue/{docId}', async (event) => {
  const snap = event.data;
  if (!snap) return;
  const d = snap.data();
  if (!d.tokens?.length) { await snap.ref.update({ status: 'skipped', processedAt: new Date() }); return; }
  await _sendPush(d.tokens, d.title, d.body, d.data || {});
  await snap.ref.update({ status: 'sent', processedAt: new Date() });
});

// ─────────────────────────────────────────────────────────────
// 2. ORDERS CREATED
// ─────────────────────────────────────────────────────────────
exports.onOrderCreatedRoot = onDocumentCreated('orders/{orderId}', async (event) => {
  const d = event.data?.data();
  if (!d) return;
  const tokens = await _getAdminTokens(d.zoneId);
  await _sendPush(tokens, '📦 New Order', `${d.repName || 'A rep'} placed order — ${d.outletName || ''}`, { screen: 'orders', type: 'new_order' });
});

exports.onOrderCreatedZone = onDocumentCreated('zones/{zoneId}/orders/{orderId}', async (event) => {
  const d = event.data?.data();
  if (!d) return;
  const tokens = await _getAdminTokens(event.params.zoneId);
  await _sendPush(tokens, '📦 New Order', `${d.repName || 'A rep'} placed order — ${d.outletName || ''}`, { screen: 'orders', type: 'new_order' });
});

// ─────────────────────────────────────────────────────────────
// 3. ORDERS UPDATED
// ─────────────────────────────────────────────────────────────
exports.onOrderUpdatedRoot = onDocumentUpdated('orders/{orderId}', async (event) => {
  const before = event.data?.before?.data();
  const after  = event.data?.after?.data();
  if (!before || !after || before.status === after.status) return;
  const repUid = after.createdBy || after.repUid;
  if (!repUid) return;
  const tokens = await _getTokenForUid(repUid, after.zoneId);
  const msgs = {
    'Confirmed': ['✅ Order Confirmed', `Your order ${after.id || ''} has been confirmed`],
    'Cancelled': ['❌ Order Cancelled', `Your order ${after.id || ''} was cancelled`],
    'Delivered': ['📬 Order Delivered', `Your order ${after.id || ''} has been delivered`],
    'Failed':    ['⚠️ Delivery Failed',  `Delivery failed for order ${after.id || ''}`],
  };
  const m = msgs[after.status];
  if (m) await _sendPush(tokens, m[0], m[1], { screen: 'orders', type: 'order_update' });
});

exports.onOrderUpdatedZone = onDocumentUpdated('zones/{zoneId}/orders/{orderId}', async (event) => {
  const before = event.data?.before?.data();
  const after  = event.data?.after?.data();
  if (!before || !after || before.status === after.status) return;
  const repUid = after.createdBy || after.repUid;
  if (!repUid) return;
  const tokens = await _getTokenForUid(event.params.zoneId);
  const msgs = {
    'Confirmed': ['✅ Order Confirmed', `Your order ${after.id || ''} has been confirmed`],
    'Cancelled': ['❌ Order Cancelled', `Your order ${after.id || ''} was cancelled`],
    'Delivered': ['📬 Order Delivered', `Your order ${after.id || ''} has been delivered`],
    'Failed':    ['⚠️ Delivery Failed',  `Delivery failed for order ${after.id || ''}`],
  };
  const m = msgs[after.status];
  if (m) await _sendPush(tokens, m[0], m[1], { screen: 'orders', type: 'order_update' });
});

// ─────────────────────────────────────────────────────────────
// 4. COLLECTIONS
// ─────────────────────────────────────────────────────────────
exports.onCollectionCreatedRoot = onDocumentCreated('collections/{docId}', async (event) => {
  const d = event.data?.data();
  if (!d) return;
  const tokens = await _getAdminTokens(d.zoneId);
  await _sendPush(tokens, '💰 Payment Collected', `${d.repName || 'A rep'} collected RM ${d.amount || '?'} from ${d.outletName || 'an outlet'}`, { screen: 'collection', type: 'collection' });
});

exports.onCollectionCreatedZone = onDocumentCreated('zones/{zoneId}/collections/{docId}', async (event) => {
  const d = event.data?.data();
  if (!d) return;
  const tokens = await _getAdminTokens(event.params.zoneId);
  await _sendPush(tokens, '💰 Payment Collected', `${d.repName || 'A rep'} collected RM ${d.amount || '?'} from ${d.outletName || 'an outlet'}`, { screen: 'collection', type: 'collection' });
});

// ─────────────────────────────────────────────────────────────
// 5. ATTENDANCE
// ─────────────────────────────────────────────────────────────
exports.onAttendanceCreatedRoot = onDocumentCreated('attendance/{docId}', async (event) => {
  const d = event.data?.data();
  if (!d) return;
  const tokens = await _getAdminTokens(d.zoneId);
  const isOut = !!d.checkOut;
  await _sendPush(tokens, isOut ? '🏁 Check-Out' : '🟢 Check-In', `${d.name || 'A rep'} ${isOut ? 'checked out' : 'checked in'}`, { screen: 'monitoring', type: 'attendance' });
});

exports.onAttendanceCreatedZone = onDocumentCreated('zones/{zoneId}/attendance/{docId}', async (event) => {
  const d = event.data?.data();
  if (!d) return;
  const tokens = await _getAdminTokens(event.params.zoneId);
  const isOut = !!d.checkOut;
  await _sendPush(tokens, isOut ? '🏁 Check-Out' : '🟢 Check-In', `${d.name || 'A rep'} ${isOut ? 'checked out' : 'checked in'}`, { screen: 'monitoring', type: 'attendance' });
});

// ─────────────────────────────────────────────────────────────
// 6. BROADCASTS
// ─────────────────────────────────────────────────────────────
exports.onBroadcastRoot = onDocumentCreated('broadcasts/{docId}', async (event) => {
  const d = event.data?.data();
  if (!d) return;
  const uSnap = await db().collection('users').get();
  const tokens = uSnap.docs.map(u => u.data().fcmToken).filter(Boolean);
  await _sendPush(tokens, `📢 ${d.title || 'Broadcast'}`, d.message || d.body || '', { screen: 'dashboard', type: 'broadcast' });
});

exports.onBroadcastZone = onDocumentCreated('zones/{zoneId}/broadcasts/{docId}', async (event) => {
  const d = event.data?.data();
  if (!d) return;
  const uSnap = await db().collection(`zones/${event.params.zoneId}/users`).get();
  const tokens = uSnap.docs.map(u => u.data().fcmToken).filter(Boolean);
  await _sendPush(tokens, `📢 ${d.title || 'Broadcast'}`, d.message || d.body || '', { screen: 'dashboard', type: 'broadcast' });
});

// ─────────────────────────────────────────────────────────────
// 7. OUTLETS
// ─────────────────────────────────────────────────────────────
exports.onOutletCreatedRoot = onDocumentCreated('outlets/{docId}', async (event) => {
  const d = event.data?.data();
  if (!d) return;
  const tokens = await _getAdminTokens(d.zoneId);
  await _sendPush(tokens, '🏪 New Outlet', `${d.name || 'New outlet'} added by ${d.createdByName || 'a rep'}`, { screen: 'outlets', type: 'outlet' });
});

exports.onOutletCreatedZone = onDocumentCreated('zones/{zoneId}/outlets/{docId}', async (event) => {
  const d = event.data?.data();
  if (!d) return;
  const tokens = await _getAdminTokens(event.params.zoneId);
  await _sendPush(tokens, '🏪 New Outlet', `${d.name || 'New outlet'} added by ${d.createdByName || 'a rep'}`, { screen: 'outlets', type: 'outlet' });
});

// ─────────────────────────────────────────────────────────────
// 8. NP VISITS
// ─────────────────────────────────────────────────────────────
exports.onVisitCreatedRoot = onDocumentCreated('npVisits/{docId}', async (event) => {
  const d = event.data?.data();
  if (!d) return;
  const tokens = await _getAdminTokens(d.zoneId);
  await _sendPush(tokens, '📍 New Visit', `${d.repName || 'A rep'} visited ${d.outletName || 'an outlet'}`, { screen: 'monitoring', type: 'visit' });
});

exports.onVisitCreatedZone = onDocumentCreated('zones/{zoneId}/npVisits/{docId}', async (event) => {
  const d = event.data?.data();
  if (!d) return;
  const tokens = await _getAdminTokens(event.params.zoneId);
  await _sendPush(tokens, '📍 New Visit', `${d.repName || 'A rep'} visited ${d.outletName || 'an outlet'}`, { screen: 'monitoring', type: 'visit' });
});

// ─────────────────────────────────────────────────────────────
// 9. DEVICE APPROVAL
// ─────────────────────────────────────────────────────────────
exports.onDeviceApprovalRequest = onDocumentCreated('deviceApprovals/{uid}/devices/{deviceId}', async (event) => {
  const d = event.data?.data();
  if (!d || d.status !== 'pending') return;
  const tokens = await _getAdminTokens(d.zoneId);
  await _sendPush(tokens, '📱 Device Approval Request', `${d.name || 'A user'} is requesting device approval`, { screen: 'users', type: 'device_request' });
});

exports.onDeviceApprovalDecision = onDocumentUpdated('deviceApprovals/{uid}/devices/{deviceId}', async (event) => {
  const before = event.data?.before?.data();
  const after  = event.data?.after?.data();
  if (!before || !after || before.status === after.status || after.status === 'pending') return;
  const tokens = await _getTokenForUid(event.params.uid, after.zoneId);
  const approved = after.status === 'approved';
  await _sendPush(tokens,
    approved ? '✅ Device Approved' : '❌ Device Rejected',
    approved ? 'Your device has been approved. You can now log in.' : 'Your device was rejected. Contact your admin.',
    { screen: 'dashboard', type: 'device_decision' });
});

// ─────────────────────────────────────────────────────────────
// 10. ADMIN NOTIFICATIONS
// ─────────────────────────────────────────────────────────────
exports.onAdminNotificationCreated = onDocumentCreated('adminNotifications/{docId}', async (event) => {
  const d = event.data?.data();
  if (!d) return;
  let tokens = [];
  if (d.targetUid) {
    tokens = await _getTokenForUid(d.targetUid, d.zoneId);
  } else if (d.targetRole) {
    const s = await db().collection('users').where('role', '==', d.targetRole).get();
    tokens = s.docs.map(u => u.data().fcmToken).filter(Boolean);
  } else {
    tokens = await _getAdminTokens(d.zoneId);
  }
  await _sendPush(tokens, d.title || 'Notification', d.body || d.message || '', { screen: d.screen || 'dashboard', type: 'admin_notif' });
});
