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
// ERP App secondary — credential loaded from Firebase config
// Set it once with:
//   firebase use stfm-sales
//   firebase functions:config:set \
//     erp.private_key_id="..." \
//     erp.private_key="-----BEGIN PRIVATE KEY-----\\n...\\n-----END PRIVATE KEY-----\\n" \
//     erp.client_email="firebase-adminsdk-xxxx@stsb-erp.iam.gserviceaccount.com" \
//     erp.client_id="..."
// Then deploy.
// ─────────────────────────────────────────────────────────────

const ERP_CREDENTIAL = {
  type: "service_account",
  project_id: "stsb-erp",
  private_key_id: "4a1ba0806e516424484c236b5571f39c064076fb",
  // eslint-disable-next-line max-len
  private_key: "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC/kwdmO+n/Ju14\n0Qv4LoQjnHtQjGZR7S914xpsm/D+70Er27O5yoHQCLuFMvM0mahExl9TRlV7BFne\nN8nOVbMkU1VUIOB3v5W0YTz8/kAZwJhljqRfCxh198l7sOj5rn0Si5UOys7+JeGa\nplY+L7lTCKlyA+y/TCb4omh6ZrtZUXQllHTLyEL+kZIVLpSUPYSU7ps7lC3jEmlz\nBTsw8hoIvA0BAshDiDeA2l6cU5neXm2PMFncwLgICEiJ4128dvxmWMd6R4RRNY/S\n/iAfPC3MGfTZ0htdOp1d/n5Y28AqOXHds8Ce+1YssmBrt4CWfCS2n4IXe2tzMhZG\nbiZPOyWdAgMBAAECggEAUJe3hKxO5/7F5042dV2ITHzvqbau8udP0I3OV4OQ8obP\niXZfWRlW3CBYVxRUmTvNPMWhY6SSoHJ3phMdLFcESpNeMcq089uezKgdoqcJa2wJ\nEKxd/PfrffFUi1sk36kmx8790Z/DTcq86rTwUi/8jHB37FW3WtDcEjwsrNWcGln8\n8hxlzmxZsUPaAsNdngrOSemG7SsVnEcFjAwr+SKDqIRr4IGuPYVwfHwrrGsazHzO\nmhr65q8QwdbGF+GV3j+QTWJdCdHvCBd1fexXkPDINgwMz2BdkwotW3OiSJLAhu9S\nxfdwG2LnElMIsBSral5/tUHuuUFXIObYBlysXZeXhwKBgQD4Na2j/7ZIZEqFiokt\nOYkszRlTgpZ3IFyX/MIO0MWYvfAwZ8722rVsY8/ABQcbBKfZ8Kx9VmK9SGimzha1\n6O8aNlZT4tK9Gauv0xB6lrsqk3DpYWZoZhkrjZilfJZlTKzb1i+e8WhiqKAyvsMl\nP1jtjGqfkgTrOQ9dqS4CiLQwKwKBgQDFlkugchgnDgz8S8DchrVJc41ivIFlL5yK\nZ9l/TxuMIehn2b5wvjyyWaxGXbRI0FkWPtRWQhL6ZrZGSmfmCz0OvlQJlG3ugeUu\nW/5T5iSRHbPlX6CaOvBSXRRNMaFWtWHlH5YWr5WOX7HmL+bPQe5GU0rsdHE/Gjx9\nDngGmUHVVwKBgQDKoB+Bu1YWoPEJNYAo0EiAr2qWdwvYci3E0c2mBJ7aw2waSBR4\nBzGGK7FEo5YaY2GXlFdr9qKivULZsXJuzJqs/mDZGFlLkHJNFfPk77oZ1sWdcCsG\n3Rp9KJnNtvib981Bpge4LIE30Ur+QibS+HTjb/b3D2A+mpVFs7/gx7K5gwKBgEz9\nyJBHhRPKzNKOriMANqndZe1gaMdF6yifWMfbym8rU0UMOsHxzvLsME3m+3YYAW7C\norjN3FlIJqRzH9Mq8+rHzTVCaiey49vRquOEXSFSwqORRKJ0buqZLGz79tMzsGa4\njSJf3tXwggChD74ZAcDTefFzWiFtlr5gIfLoSxfXAoGAFIzBGVKQDgOge0MWIeao\nhpaE+9yayAM6DkyukW7f4ehItHhzOd1R8tOF3Pow7xIz8xrGvYhZfX/sd0VUhJOo\nuj71MWq1Is9v95V2OAuFWGEOqVWK+PC7VK9lCCCKcSXVKbrPOD7b/uiHhojWPDSo\nzTXtpG3+fORuEY0OKFPWySE=\n-----END PRIVATE KEY-----\n",
  client_email: "firebase-adminsdk-fbsvc@stsb-erp.iam.gserviceaccount.com",
  client_id: "108424370136963662107",
  auth_uri: "https://accounts.google.com/o/oauth2/auth",
  token_uri: "https://oauth2.googleapis.com/token",
};

let _erpApp;

/**
 * Returns (or lazily creates) the secondary Firebase App for the ERP project.
 * @return {object} The ERP Firebase App instance.
 */
function erpApp() {
  if (!_erpApp) {
    const existing = getApps().find((a) => a.name === "erp");
    _erpApp = existing || initializeApp(
        {credential: admin.credential.cert(ERP_CREDENTIAL), projectId: "stsb-erp"},
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
