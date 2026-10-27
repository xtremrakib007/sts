/**
 * BULK SYNC — copies Sales App users into the ERP salesapp_users collection.
 *
 * Run once after the sync Cloud Function is deployed:
 *   npm install firebase-admin
 *   node bulk_sync.js
 *
 * Authentication uses Application Default Credentials (ADC). Before running,
 * authenticate with an identity that can read stfm-sales and write stsb-erp,
 * or run in an environment whose service account has those permissions.
 * Never place service-account private keys in this repository.
 */
const {initializeApp, applicationDefault, getApps} = require("firebase-admin/app");
const {getFirestore} = require("firebase-admin/firestore");

function appFor(projectId, name) {
  const existing = getApps().find((app) => app.name === name);
  return existing || initializeApp({
    credential: applicationDefault(),
    projectId,
  }, name);
}

const salesApp = appFor("stfm-sales", "sales");
const erpApp = appFor("stsb-erp", "erp");
const salesDb = getFirestore(salesApp);
const erpDb = getFirestore(erpApp);

async function bulkSync() {
  console.log("Fetching all users from Sales App (stfm-sales)...");
  const snap = await salesDb.collection("users").get();
  console.log("Found " + snap.size + " users. Syncing to ERP salesapp_users...");

  // Firestore batches are limited to 500 writes. Chunk to avoid failing on
  // businesses with more than 500 users.
  const docs = snap.docs;
  for (let offset = 0; offset < docs.length; offset += 450) {
    const batch = erpDb.batch();
    docs.slice(offset, offset + 450).forEach((doc) => {
      const d = doc.data();
      batch.set(erpDb.collection("salesapp_users").doc(doc.id), {
        uid: doc.id,
        name: d.name || "",
        email: d.email || "",
        role: d.role || "",
        zone: d.zone || "",
        phone: d.phone || "",
        displayName: d.displayName || d.name || "",
        syncedAt: new Date().toISOString(),
        _source: "stfm-sales",
      }, {merge: true});
    });
    await batch.commit();
    console.log("Synced " + Math.min(offset + 450, docs.length) + "/" + docs.length + " users.");
  }

  console.log("Done! " + snap.size + " users synced to ERP salesapp_users.");
}

bulkSync().catch((e) => {
  console.error("Bulk sync failed:", e.message);
  process.exitCode = 1;
});
