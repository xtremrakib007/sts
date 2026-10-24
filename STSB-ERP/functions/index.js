// ═══════════════════════════════════════════════════════════════
// STFM SALES — Firebase Cloud Functions
// Project: stfm-sales
// Deploy: firebase use stfm-sales && firebase deploy --only functions
//
// PURPOSE: Listens to Sales Firestore changes and pushes them
//          into the ERP project (stsb-erp) in real time.
// ═══════════════════════════════════════════════════════════════
const functions = require("firebase-functions/v1");
const admin = require("firebase-admin");
const {initializeApp, getApps} = require("firebase-admin/app");
const {getFirestore} = require("firebase-admin/firestore");

admin.initializeApp();

// ─────────────────────────────────────────────────────────────
// ERP App secondary — uses runtime Application Default Credentials.
let _erpApp;

/**
 * Returns (or lazily creates) the secondary Firebase App for the ERP project.
 * @return {object} The ERP Firebase App instance.
 */
function erpApp() {
  if (!_erpApp) {
    const existing = getApps().find((a) => a.name === "erp");
    _erpApp = existing || initializeApp(
        {credential: admin.credential.applicationDefault(), projectId: "stsb-erp"},
        "erp",
    );
  }
  return _erpApp;
}

/**
 * Returns the Firestore instance for the ERP project.
 * @return {object} ERP Firestore instance.
 */
const erpDb = () => getFirestore(erpApp());

// ─────────────────────────────────────────────────────────────
// LOOP-GUARD HELPER
// ─────────────────────────────────────────────────────────────

/**
 * Returns true if the ONLY fields that changed are sync metadata fields.
 * @param {object} before
 * @param {object} after
 * @param {string[]} metaFields
 * @return {boolean}
 */
function onlyMetaChanged(before, after, metaFields = [
  "_syncedFromERP", "_syncedFromSales", "_syncedAt",
]) {
  const allKeys = new Set([...Object.keys(before), ...Object.keys(after)]);
  metaFields.forEach((f) => allKeys.delete(f));
  return ![...allKeys].some(
      (k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]),
  );
}

// ─────────────────────────────────────────────────────────────
// SYNC HELPER — write to ERP project
// ─────────────────────────────────────────────────────────────

/**
 * Syncs a document from Sales Firestore → ERP Firestore.
 * Optionally also writes to a zone-scoped sub-collection in ERP.
 *
 * @param {string} col    - Top-level collection name.
 * @param {string} docId  - Document ID.
 * @param {object} data   - Document data payload.
 * @param {string|null} zoneId - Optional zone ID for zone-scoped writes.
 * @return {Promise<void>}
 */
async function syncToERP(col, docId, data, zoneId) {
  const ts = admin.firestore.FieldValue.serverTimestamp();
  const edb = erpDb();
  // Strip the incoming ERP sync flag before writing
  const {_syncedFromERP: _removed, ...cleanData} = data;
  const payload = {...cleanData, _syncedFromSales: true, _syncedAt: ts};
  await edb.doc(`${col}/${docId}`).set(payload, {merge: true});
  if (zoneId) {
    await edb.doc(`zones/${zoneId}/${col}/${docId}`).set(
        payload, {merge: true},
    );
  }
  console.log(`[→ERP] ${col}/${docId}`);
}

// ═══════════════════════════════════════════════════════════════
// ORDERS — Sales rep creates / updates orders in the field
// ═══════════════════════════════════════════════════════════════

/**
 * Fires when a sales rep creates a new order.
 * Pushes the full order to ERP immediately.
 */
exports.salesOrderCreated = functions.firestore
    .document("orders/{orderId}")
    .onCreate(async (snap, ctx) => {
      const d = snap.data();
      // Skip if this was pushed from ERP (loop guard)
      if (d._syncedFromERP) return;
      await syncToERP("orders", ctx.params.orderId, d, d.zoneId);
    });

/**
 * Fires when a sales rep updates an order (e.g. edits items, adds note).
 * Pushes the update to ERP immediately.
 */
exports.salesOrderUpdated = functions.firestore
    .document("orders/{orderId}")
    .onUpdate(async (change, ctx) => {
      const before = change.before.data();
      const after = change.after.data();
      if (after._syncedFromERP) return;
      if (onlyMetaChanged(before, after)) return;
      await syncToERP("orders", ctx.params.orderId, after, after.zoneId);
    });

// ═══════════════════════════════════════════════════════════════
// COLLECTIONS — Sales rep submits payment collections
// ═══════════════════════════════════════════════════════════════

/**
 * Fires when a sales rep creates a new payment collection.
 * Pushes it to ERP for verification.
 */
exports.salesCollectionCreated = functions.firestore
    .document("collections/{docId}")
    .onCreate(async (snap, ctx) => {
      const d = snap.data();
      if (d._syncedFromERP) return;
      await syncToERP("collections", ctx.params.docId, d, d.zoneId);
    });

/**
 * Fires when a sales rep updates a collection record.
 * Pushes the changes to ERP.
 */
exports.salesCollectionUpdated = functions.firestore
    .document("collections/{docId}")
    .onUpdate(async (change, ctx) => {
      const before = change.before.data();
      const after = change.after.data();
      if (after._syncedFromERP) return;
      if (onlyMetaChanged(before, after)) return;

      const watched = ["status", "amount", "paymentMethod", "receiptUrl", "notes"];
      const changed = watched.some(
          (f) => JSON.stringify(before[f]) !== JSON.stringify(after[f]),
      );
      if (!changed) return;

      await syncToERP("collections", ctx.params.docId, after, after.zoneId);
    });

// ═══════════════════════════════════════════════════════════════
// USERS — Sync Sales App users → ERP salesapp_users collection
// Fires on every create/update to users/{userId} in stfm-sales.
// The ERP reads salesapp_users (its own DB) — no cross-project
// reads needed at runtime.
// ═══════════════════════════════════════════════════════════════

/**
 * Builds the sanitised user payload written to ERP.
 * @param {string} uid
 * @param {object} data
 * @return {object}
 */
function buildUserPayload(uid, data) {
  return {
    uid,
    name:        data.name        || "",
    email:       data.email       || "",
    role:        data.role        || "",
    zone:        data.zone        || "",
    phone:       data.phone       || "",
    displayName: data.displayName || data.name || "",
    syncedAt:    admin.firestore.FieldValue.serverTimestamp(),
    _source:     "stfm-sales",
  };
}

/**
 * Fires when a new user document is created in the Sales App.
 * Immediately mirrors it to ERP → salesapp_users/{userId}.
 */
exports.syncUserToErpOnCreate = functions.firestore
    .document("users/{userId}")
    .onCreate(async (snap, ctx) => {
      const payload = buildUserPayload(ctx.params.userId, snap.data());
      await erpDb()
          .doc(`salesapp_users/${ctx.params.userId}`)
          .set(payload, {merge: true});
      console.log(`[→ERP users] created: ${ctx.params.userId} (${payload.role})`);
    });

/**
 * Fires when an existing Sales App user document is updated.
 * Re-mirrors the full document to ERP → salesapp_users/{userId}.
 * Ignores updates that only touch sync metadata to avoid loops.
 */
exports.syncUserToErpOnUpdate = functions.firestore
    .document("users/{userId}")
    .onUpdate(async (change, ctx) => {
      const before = change.before.data();
      const after  = change.after.data();
      // Skip if nothing meaningful changed
      if (onlyMetaChanged(before, after, ["_syncedFromERP", "_syncedAt", "_source", "syncedAt"])) return;
      const payload = buildUserPayload(ctx.params.userId, after);
      await erpDb()
          .doc(`salesapp_users/${ctx.params.userId}`)
          .set(payload, {merge: true});
      console.log(`[→ERP users] updated: ${ctx.params.userId} (${payload.role})`);
    });

/**
 * Fires when a Sales App user document is deleted.
 * Removes the mirror from ERP → salesapp_users/{userId}.
 */
exports.syncUserToErpOnDelete = functions.firestore
    .document("users/{userId}")
    .onDelete(async (snap, ctx) => {
      await erpDb()
          .doc(`salesapp_users/${ctx.params.userId}`)
          .delete();
      console.log(`[→ERP users] deleted: ${ctx.params.userId}`);
    });

// ═══════════════════════════════════════════════════════════════
// DELIVERIES — Sales rep updates delivery status in the field
// ═══════════════════════════════════════════════════════════════

/**
 * Fires when a sales rep updates a delivery record (e.g. marks delivered).
 * Pushes the status change to ERP.
 */
exports.salesDeliveryUpdated = functions.firestore
    .document("deliveries/{docId}")
    .onUpdate(async (change, ctx) => {
      const before = change.before.data();
      const after = change.after.data();
      if (after._syncedFromERP) return;
      if (onlyMetaChanged(before, after)) return;

      const watched = [
        "status", "deliveredAt", "signedBy", "proofUrl", "notes",
      ];
      const changed = watched.some(
          (f) => JSON.stringify(before[f]) !== JSON.stringify(after[f]),
      );
      if (!changed) return;

      await syncToERP("deliveries", ctx.params.docId, after, after.zoneId);
    });
