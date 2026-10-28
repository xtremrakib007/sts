// ═══════════════════════════════════════════════════════════════
// STFM — Firebase Cloud Functions (v1 compatible)
// ═══════════════════════════════════════════════════════════════
const functions = require('firebase-functions/v1');
const admin     = require('firebase-admin');
const { FieldValue } = require('firebase-admin/firestore');

admin.initializeApp();

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────
const db = () => admin.firestore();

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
    const res = await admin.messaging().sendEachForMulticast(msg);
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
exports.onPushQueueCreated = functions.firestore
  .document('pushQueue/{docId}')
  .onCreate(async (snap) => {
    const d = snap.data();
    if (!d.tokens?.length) { await snap.ref.update({ status: 'skipped', processedAt: new Date() }); return; }
    await _sendPush(d.tokens, d.title, d.body, d.data || {});
    await snap.ref.update({ status: 'sent', processedAt: new Date() });
  });

// ─────────────────────────────────────────────────────────────
// 2. ORDERS CREATED
// ─────────────────────────────────────────────────────────────
exports.onOrderCreatedRoot = functions.firestore
  .document('orders/{orderId}')
  .onCreate(async (snap) => {
    const d = snap.data();
    const tokens = await _getAdminTokens(d.zoneId);
    await _sendPush(tokens, '📦 New Order', `${d.repName || 'A rep'} placed order — ${d.outletName || ''}`, { screen: 'orders', type: 'new_order' });
  });

exports.onOrderCreatedZone = functions.firestore
  .document('zones/{zoneId}/orders/{orderId}')
  .onCreate(async (snap, ctx) => {
    const d = snap.data();
    const tokens = await _getAdminTokens(ctx.params.zoneId);
    await _sendPush(tokens, '📦 New Order', `${d.repName || 'A rep'} placed order — ${d.outletName || ''}`, { screen: 'orders', type: 'new_order' });
  });

// ─────────────────────────────────────────────────────────────
// 3. ORDERS UPDATED
// ─────────────────────────────────────────────────────────────
exports.onOrderUpdatedRoot = functions.firestore
  .document('orders/{orderId}')
  .onUpdate(async (change) => {
    const before = change.before.data();
    const after  = change.after.data();
    if (before.status === after.status) return;
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

exports.onOrderUpdatedZone = functions.firestore
  .document('zones/{zoneId}/orders/{orderId}')
  .onUpdate(async (change, ctx) => {
    const before = change.before.data();
    const after  = change.after.data();
    if (before.status === after.status) return;
    const repUid = after.createdBy || after.repUid;
    if (!repUid) return;
    const tokens = await _getTokenForUid(repUid, ctx.params.zoneId);
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
exports.onCollectionCreatedRoot = functions.firestore
  .document('collections/{docId}')
  .onCreate(async (snap) => {
    const d = snap.data();
    const tokens = await _getAdminTokens(d.zoneId);
    await _sendPush(tokens, '💰 Payment Collected', `${d.repName || 'A rep'} collected RM ${d.amount || '?'} from ${d.outletName || 'an outlet'}`, { screen: 'collection', type: 'collection' });
  });

exports.onCollectionCreatedZone = functions.firestore
  .document('zones/{zoneId}/collections/{docId}')
  .onCreate(async (snap, ctx) => {
    const d = snap.data();
    const tokens = await _getAdminTokens(ctx.params.zoneId);
    await _sendPush(tokens, '💰 Payment Collected', `${d.repName || 'A rep'} collected RM ${d.amount || '?'} from ${d.outletName || 'an outlet'}`, { screen: 'collection', type: 'collection' });
  });

// ─────────────────────────────────────────────────────────────
// 5. ATTENDANCE
// ─────────────────────────────────────────────────────────────
exports.onAttendanceCreatedRoot = functions.firestore
  .document('attendance/{docId}')
  .onCreate(async (snap) => {
    const d = snap.data();
    const tokens = await _getAdminTokens(d.zoneId);
    const isOut = !!d.checkOut;
    await _sendPush(tokens, isOut ? '🏁 Check-Out' : '🟢 Check-In', `${d.name || 'A rep'} ${isOut ? 'checked out' : 'checked in'}`, { screen: 'monitoring', type: 'attendance' });
  });

exports.onAttendanceCreatedZone = functions.firestore
  .document('zones/{zoneId}/attendance/{docId}')
  .onCreate(async (snap, ctx) => {
    const d = snap.data();
    const tokens = await _getAdminTokens(ctx.params.zoneId);
    const isOut = !!d.checkOut;
    await _sendPush(tokens, isOut ? '🏁 Check-Out' : '🟢 Check-In', `${d.name || 'A rep'} ${isOut ? 'checked out' : 'checked in'}`, { screen: 'monitoring', type: 'attendance' });
  });

// ─────────────────────────────────────────────────────────────
// 6. BROADCASTS
// ─────────────────────────────────────────────────────────────
exports.onBroadcastRoot = functions.firestore
  .document('broadcasts/{docId}')
  .onCreate(async (snap) => {
    const d = snap.data();
    const uSnap = await db().collection('users').get();
    const tokens = uSnap.docs.map(u => u.data().fcmToken).filter(Boolean);
    await _sendPush(tokens, `📢 ${d.title || 'Broadcast'}`, d.message || d.body || '', { screen: 'dashboard', type: 'broadcast' });
  });

exports.onBroadcastZone = functions.firestore
  .document('zones/{zoneId}/broadcasts/{docId}')
  .onCreate(async (snap, ctx) => {
    const d = snap.data();
    const uSnap = await db().collection(`zones/${ctx.params.zoneId}/users`).get();
    const tokens = uSnap.docs.map(u => u.data().fcmToken).filter(Boolean);
    await _sendPush(tokens, `📢 ${d.title || 'Broadcast'}`, d.message || d.body || '', { screen: 'dashboard', type: 'broadcast' });
  });

// ─────────────────────────────────────────────────────────────
// 7. OUTLETS
// ─────────────────────────────────────────────────────────────
exports.onOutletCreatedRoot = functions.firestore
  .document('outlets/{docId}')
  .onCreate(async (snap) => {
    const d = snap.data();
    const tokens = await _getAdminTokens(d.zoneId);
    await _sendPush(tokens, '🏪 New Outlet', `${d.name || 'New outlet'} added by ${d.createdByName || 'a rep'}`, { screen: 'outlets', type: 'outlet' });
  });

exports.onOutletCreatedZone = functions.firestore
  .document('zones/{zoneId}/outlets/{docId}')
  .onCreate(async (snap, ctx) => {
    const d = snap.data();
    const tokens = await _getAdminTokens(ctx.params.zoneId);
    await _sendPush(tokens, '🏪 New Outlet', `${d.name || 'New outlet'} added by ${d.createdByName || 'a rep'}`, { screen: 'outlets', type: 'outlet' });
  });

// ─────────────────────────────────────────────────────────────
// 8. NP VISITS
// ─────────────────────────────────────────────────────────────
exports.onVisitCreatedRoot = functions.firestore
  .document('npVisits/{docId}')
  .onCreate(async (snap) => {
    const d = snap.data();
    const tokens = await _getAdminTokens(d.zoneId);
    await _sendPush(tokens, '📍 New Visit', `${d.repName || 'A rep'} visited ${d.outletName || 'an outlet'}`, { screen: 'monitoring', type: 'visit' });
  });

exports.onVisitCreatedZone = functions.firestore
  .document('zones/{zoneId}/npVisits/{docId}')
  .onCreate(async (snap, ctx) => {
    const d = snap.data();
    const tokens = await _getAdminTokens(ctx.params.zoneId);
    await _sendPush(tokens, '📍 New Visit', `${d.repName || 'A rep'} visited ${d.outletName || 'an outlet'}`, { screen: 'monitoring', type: 'visit' });
  });

// ─────────────────────────────────────────────────────────────
// 9. DEVICE APPROVAL
// ─────────────────────────────────────────────────────────────
exports.onDeviceApprovalRequest = functions.firestore
  .document('deviceApprovals/{uid}/devices/{deviceId}')
  .onCreate(async (snap) => {
    const d = snap.data();
    if (d.status !== 'pending') return;
    const tokens = await _getAdminTokens(d.zoneId);
    await _sendPush(tokens, '📱 Device Approval Request', `${d.name || 'A user'} is requesting device approval`, { screen: 'users', type: 'device_request' });
  });

exports.onDeviceApprovalDecision = functions.firestore
  .document('deviceApprovals/{uid}/devices/{deviceId}')
  .onUpdate(async (change, ctx) => {
    const before = change.before.data();
    const after  = change.after.data();
    if (before.status === after.status || after.status === 'pending') return;
    const tokens = await _getTokenForUid(ctx.params.uid, after.zoneId);
    const approved = after.status === 'approved';
    await _sendPush(tokens,
      approved ? '✅ Device Approved' : '❌ Device Rejected',
      approved ? 'Your device has been approved. You can now log in.' : 'Your device was rejected. Contact your admin.',
      { screen: 'dashboard', type: 'device_decision' });
  });

// ─────────────────────────────────────────────────────────────
// 10. ADMIN NOTIFICATIONS
// ─────────────────────────────────────────────────────────────
exports.onAdminNotificationCreated = functions.firestore
  .document('admin_notifications/{docId}')
  .onCreate(async (snap) => {
    const d = snap.data();
    let tokens = [];

    try {
      if (d.target === 'specific' && d.specificUserId) {
        tokens = await _getTokenForUid(d.specificUserId, d.zone);
      } else if (d.target === 'all') {
        const uSnap = await db().collection('users').get();
        tokens = uSnap.docs.map(u => u.data().fcmToken).filter(Boolean);
      } else if (d.target) {
        // target is a role (admin, sales_rep, delivery_man)
        const q = db().collection('users').where('role', '==', d.target);
        const s = await (d.zone ? q.where('zoneId', '==', d.zone) : q).get();
        tokens = s.docs.map(u => u.data().fcmToken).filter(Boolean);
      } else {
        tokens = await _getAdminTokens(d.zone);
      }

      const uniqueTokens = [...new Set(tokens.filter(Boolean))];
      await _sendPush(uniqueTokens, d.title || 'Notification', d.message || '', {
        screen: d.screen || 'dashboard',
        type: 'admin_notif'
      });

      await snap.ref.update({
        status: 'sent',
        tokenCount: uniqueTokens.length,
        processedAt: FieldValue.serverTimestamp()
      });
    } catch (e) {
      console.error('[AdminNotif] Error:', e.message);
      await snap.ref.update({
        status: 'error',
        error: e.message,
        processedAt: FieldValue.serverTimestamp()
      });
    }
  });

// ─────────────────────────────────────────────────────────────
// 11. REAL-TIME ERP BRIDGE (orders · manual invoices · deliveries · collections)
//
// Every Sales App write — create, edit, approval, delivery status,
// cancel, delete — is mirrored into the ERP's stsb_* collections from
// the server. The Admin SDK is not bound by client rules, so a write a
// rep, zone admin or delivery man makes always reaches the ERP; the
// client no longer writes ERP order records directly.
// ─────────────────────────────────────────────────────────────
const erp = require('./erp-sync');

async function _loadOutlet(outletId, zoneId) {
  if (!outletId) return {};
  try {
    const root = await db().doc(`outlets/${outletId}`).get();
    if (root.exists) return root.data();
    if (zoneId) {
      const z = await db().doc(`zones/${zoneId}/outlets/${outletId}`).get();
      if (z.exists) return z.data();
    }
  } catch (e) { console.warn('[ERP] outlet lookup failed:', e.message); }
  return {};
}

function _eventTime(change, ctx) {
  const t = change.after.exists ? change.after.updateTime : null;
  return t ? t.toDate().toISOString() : new Date(ctx.timestamp).toISOString();
}

// ── Stock and credit controls ────────────────────────────────
const ctl = require('./order-controls');
const _num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

let _invIndex = null;
let _invIndexAt = 0;
async function _inventoryIndex() {
  if (_invIndex && Date.now() - _invIndexAt < 60000) return _invIndex;
  const snap = await db().collection(erp.erpCol('inventory')).get();
  _invIndex = ctl.inventoryIndex(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  _invIndexAt = Date.now();
  return _invIndex;
}

// Root copy and zone copy of an app order share the same doc id.
async function _updateAppOrder(docId, zoneId, data, patch) {
  const z = zoneId || data._zoneId || data.zoneId || null;
  const refs = [db().doc(`orders/${docId}`)];
  if (z) refs.push(db().doc(`zones/${z}/orders/${docId}`));
  await Promise.all(refs.map(r => r.update(patch).catch((e) => {
    if (e.code !== 5) throw e; // NOT_FOUND: owner orders have no zone copy
  })));
}

// Brings stsb_inventory in line with what the order should hold now.
// A per-order ledger (stsb_stock_moves) records what was already applied,
// so retries, the root+zone double trigger and item edits only ever move
// the difference.
async function _reconcileStock(status, items, ordId, eventTime, nowIso) {
  const { lines, unmatched } = ctl.orderStockLines(items, await _inventoryIndex());
  const ledgerRef = db().doc(`${erp.erpCol('stock_moves')}/${ordId}`);
  const erpOrderRef = db().doc(`${erp.erpCol('orders')}/${ordId}`);
  return db().runTransaction(async (tx) => {
    const led = await tx.get(ledgerRef);
    const cur = led.exists ? led.data() : {};
    if (erp.isStaleEvent(led.exists ? cur : null, eventTime)) return null;
    const desired = ctl.desiredStock(status, lines, cur);
    const deltas = ctl.stockDeltas(cur, desired);
    const invRefs = Object.keys(deltas).map(id => db().doc(`${erp.erpCol('inventory')}/${id}`));
    const invSnaps = invRefs.length ? await tx.getAll(...invRefs) : [];
    const erpOrder = await tx.get(erpOrderRef);

    invSnaps.forEach((snap) => {
      if (!snap.exists) return;
      const v = snap.data();
      const d = deltas[snap.id];
      const held = desired.reserved[snap.id];
      tx.update(snap.ref, {
        reservedQty: Math.max(0, _num(v.reservedQty) + d.reserved),
        qty: _num(v.qty) + d.qty,
        [`reservations.${ordId}`]: held ? held : FieldValue.delete(),
        updatedAt: nowIso,
      });
    });
    const deducted = Object.keys(desired.deducted).length > 0;
    tx.set(ledgerRef, {
      orderId: ordId, status: status || 'Deleted',
      reserved: desired.reserved, deducted: desired.deducted, unmatched,
      updatedAt: nowIso, _srcEventTime: eventTime,
    });
    if (erpOrder.exists) tx.update(erpOrderRef, { stockDeducted: deducted });
    if (Object.keys(deltas).length) console.log(`[stock] ${ordId} ${status || 'Deleted'}`, JSON.stringify(deltas));
    return { deducted, unmatched };
  });
}

// Credit outlets: hold a salesman's order that would take the outlet past
// its credit limit until an admin approves it. Orders placed by admins are
// their own approval.
async function _creditHold(order, zid) {
  const outlet = await _loadOutlet(order.outletId, zid);
  if (outlet.paymentType !== 'credit' || !(_num(outlet.creditLimit) > 0)) return null;
  const creator = order.createdBy ? await db().doc(`users/${order.createdBy}`).get() : null;
  const role = creator && creator.exists ? creator.data().role : '';
  if (role === 'admin' || role === 'sub_admin') return null;
  const [ords, cols] = await Promise.all([
    db().collection('orders').where('outletId', '==', order.outletId).get(),
    db().collection('collections').where('outletId', '==', order.outletId).get(),
  ]);
  const outstanding = ctl.outletOutstanding({
    orders: ords.docs.map(d => d.data()),
    collections: cols.docs.map(d => d.data()),
    outlet, excludeOrderId: order.id,
  });
  return ctl.creditCheck({ outlet, outstanding, orderTotal: order.total });
}

async function _bridgeOrder(change, ctx, zoneId) {
  const docId = ctx.params.orderId;
  const before = change.before.exists ? change.before.data() : null;
  const after = change.after.exists ? change.after.data() : null;
  const nowIso = new Date().toISOString();
  const eventTime = _eventTime(change, ctx);

  if (!after) {
    const ordId = erp.erpOrderId(before, docId);
    try {
      await _reconcileStock(null, before.items, ordId, eventTime, nowIso);
    } catch (e) { console.error(`[stock] ${ordId} release failed:`, e.message); }
    const ref = db().doc(`${erp.erpCol('orders')}/${ordId}`);
    await db().runTransaction(async (tx) => {
      const cur = await tx.get(ref);
      if (!cur.exists || erp.isStaleEvent(cur.data(), eventTime)) return;
      tx.set(ref, { ...erp.deletionPatch('order', nowIso), _srcEventTime: eventTime }, { merge: true });
    });
    console.log(`[→ERP] order deleted ${docId}`);
    return;
  }
  if (before && erp.onlySyncMetaChanged(before, after)) return;

  const zid = zoneId || after.zoneId || after._zoneId || null;
  const ordId = erp.erpOrderId(after, docId);
  let stockDeducted = !!after.stockDeducted;

  // Stock follows every status/item change, including ones the ERP made.
  const stockRelevant = !before || before.status !== after.status ||
    JSON.stringify(before.items) !== JSON.stringify(after.items);
  if (stockRelevant) {
    try {
      const res = await _reconcileStock(after.status, after.items, ordId, eventTime, nowIso);
      if (res) {
        stockDeducted = res.deducted;
        const patch = {};
        if (res.deducted !== !!after.stockDeducted) {
          patch.stockDeducted = res.deducted;
          patch.stockDeductedAt = res.deducted ? nowIso : '';
        }
        if (JSON.stringify(res.unmatched) !== JSON.stringify(after.stockUnmatched || [])) {
          patch.stockUnmatched = res.unmatched;
        }
        if (after.stockSyncError) patch.stockSyncError = FieldValue.delete();
        if (Object.keys(patch).length) await _updateAppOrder(docId, zid, after, patch);
      }
    } catch (e) {
      console.error(`[stock] ${ordId} failed:`, e.message);
      await _updateAppOrder(docId, zid, after, { stockSyncError: e.message }).catch(() => {});
    }
  }

  if (before && erp.isErpOriginatedWrite(before, after)) return;

  if (!before && after.status !== 'Cancelled' && !ctl.isCreditHeld(after)) {
    const hold = await _creditHold(after, zid);
    if (hold) {
      await _updateAppOrder(docId, zid, after, {
        status: 'Pending', erpHeld: true,
        creditHold: { ...hold, at: nowIso },
        approvedBy: '', approvedByName: '', approvedAt: '',
      });
      console.log(`[credit] ${ordId} held: over limit by ${hold.exceededBy}`);
      return;
    }
  }
  if (erp.isHeldFromErp(after)) return;

  try {
    const outlet = await _loadOutlet(after.outletId, zid);
    const ref = db().doc(`${erp.erpCol('orders')}/${ordId}`);
    await db().runTransaction(async (tx) => {
      const cur = await tx.get(ref);
      const erpCurrent = cur.exists ? cur.data() : null;
      if (erp.isStaleEvent(erpCurrent, eventTime)) return;
      const payload = erp.buildErpOrder({
        order: { ...after, stockDeducted }, erpCurrent, docId, zoneId: zid, outlet, nowIso,
      });
      // The ERP portal sorts by createdAt, so keep it a Timestamp like its own records.
      if (payload.createdAt) payload.createdAt = FieldValue.serverTimestamp();
      tx.set(ref, { ...payload, _srcEventTime: eventTime }, { merge: true });
    });
    if (!after.erpSynced || after.erpSyncError) {
      await change.after.ref.update({
        erpSynced: true, erpSyncedAt: nowIso,
        erpSyncError: FieldValue.delete(),
      });
    }
    console.log(`[→ERP] order ${ordId} (${after.status})`);
  } catch (e) {
    console.error(`[→ERP] order ${docId} failed:`, e.message);
    await change.after.ref.update({ erpSynced: false, erpSyncError: e.message }).catch(() => {});
    throw e;
  }
}

async function _bridgeCollection(change, ctx, zoneId) {
  const docId = ctx.params.docId;
  const after = change.after.exists ? change.after.data() : null;
  const before = change.before.exists ? change.before.data() : null;
  const nowIso = new Date().toISOString();
  const eventTime = _eventTime(change, ctx);
  const ref = db().doc(`${erp.erpCol('collections')}/${docId}`);

  if (!after) {
    await db().runTransaction(async (tx) => {
      const cur = await tx.get(ref);
      if (!cur.exists || erp.isStaleEvent(cur.data(), eventTime)) return;
      tx.set(ref, { ...erp.deletionPatch('collection', nowIso), _srcEventTime: eventTime }, { merge: true });
    });
    console.log(`[→ERP] collection deleted ${docId}`);
    return;
  }
  if (before && erp.onlySyncMetaChanged(before, after)) return;
  if (before && erp.isErpOriginatedWrite(before, after)) return;

  const zid = zoneId || after.zoneId || after._zoneId || null;
  const outlet = await _loadOutlet(after.outletId, zid);
  await db().runTransaction(async (tx) => {
    const cur = await tx.get(ref);
    const erpCurrent = cur.exists ? cur.data() : null;
    if (erp.isStaleEvent(erpCurrent, eventTime)) return;
    const payload = erp.buildErpCollection({ collection: after, erpCurrent, docId, zoneId: zid, outlet, nowIso });
    if (payload.createdAt) payload.createdAt = FieldValue.serverTimestamp();
    tx.set(ref, { ...payload, _srcEventTime: eventTime }, { merge: true });
  });
  console.log(`[→ERP] collection ${docId}`);
}

exports.erpBridgeOrderRoot = functions.firestore
  .document('orders/{orderId}')
  .onWrite((change, ctx) => _bridgeOrder(change, ctx, null));

exports.erpBridgeOrderZone = functions.firestore
  .document('zones/{zoneId}/orders/{orderId}')
  .onWrite((change, ctx) => _bridgeOrder(change, ctx, ctx.params.zoneId));

exports.erpBridgeCollectionRoot = functions.firestore
  .document('collections/{docId}')
  .onWrite((change, ctx) => _bridgeCollection(change, ctx, null));

exports.erpBridgeCollectionZone = functions.firestore
  .document('zones/{zoneId}/collections/{docId}')
  .onWrite((change, ctx) => _bridgeCollection(change, ctx, ctx.params.zoneId));

// ERP → App: when the ERP dispatches, confirms delivery, cancels or assigns
// a driver on stsb_orders, update the Sales App order (root + zone copy) so
// the salesman and delivery staff see it live. Writes are stamped
// _syncedFromERP/_syncedAt so the bridge above does not echo them back.
exports.erpOrderToApp = functions.firestore
  .document(`${erp.erpCol('orders')}/{orderId}`)
  .onUpdate(async (change, ctx) => {
    const before = change.before.data();
    const after = change.after.data();
    if (erp.isBridgeWrite(before, after)) return;

    const refs = [];
    if (after.appDocId) {
      refs.push(db().doc(`orders/${after.appDocId}`));
      if (after.zoneId) refs.push(db().doc(`zones/${after.zoneId}/orders/${after.appDocId}`));
    } else {
      // ERP records written by older app builds carry only the order number.
      const q = await db().collection('orders').where('id', '==', ctx.params.orderId).limit(1).get();
      q.docs.forEach(d => {
        refs.push(d.ref);
        if (d.data()._zoneId) refs.push(db().doc(`zones/${d.data()._zoneId}/orders/${d.id}`));
      });
    }
    const snaps = (await Promise.all(refs.map(r => r.get()))).filter(s => s.exists);
    if (!snaps.length) return;

    const appStatus = snaps[0].data().status || '';
    const patch = erp.appPatchFromErp(before, after, appStatus);
    if (!patch) return;
    const stamped = { ...patch, _syncedFromERP: true, _syncedAt: FieldValue.serverTimestamp() };
    await Promise.all(snaps.map(s => s.ref.update(stamped)));
    if (patch.status) await change.after.ref.update({ appStatus: patch.status });
    console.log(`[ERP→App] ${ctx.params.orderId} ${appStatus} → ${patch.status || '(fields)'}`);
  });
