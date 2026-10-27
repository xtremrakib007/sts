/**
 * ONE-TIME BULK SYNC SCRIPT
 * Copies existing Sales App users into the ERP salesapp_users collection.
 *
 * Authentication: Application Default Credentials (ADC). The identity used
 * to run this script must have read access to stfm-sales and write access to
 * stsb-erp. Never commit service-account JSON files or private keys.
 *
 * Usage:
 *   gcloud auth application-default login
 *   node bulk_sync.js
 */

const {initializeApp, applicationDefault, getApps} = require('firebase-admin/app');
const {getFirestore} = require('firebase-admin/firestore');

function appFor(projectId, name) {
  const existing = getApps().find((app) => app.name === name);
  return existing || initializeApp({
    credential: applicationDefault(),
    projectId,
  }, name);
}

const salesApp = appFor('stfm-sales', 'sales');
const erpApp = appFor('stsb-erp', 'erp');
const salesDb = getFirestore(salesApp);
const erpDb = getFirestore(erpApp);

async function bulkSync() {
  console.log('Fetching users from Sales App (stfm-sales)...');
  const snap = await salesDb.collection('users').get();
  const docs = snap.docs;
  console.log(`Found ${docs.length} users. Syncing to ERP (stsb-erp)...`);

  // Firestore batches support at most 500 writes. Keep batches below the limit.
  for (let offset = 0; offset < docs.length; offset += 450) {
    const batch = erpDb.batch();
    docs.slice(offset, offset + 450).forEach((doc) => {
      const data = doc.data();
      batch.set(erpDb.collection('salesapp_users').doc(doc.id), {
        uid: doc.id,
        name: data.name || '',
        email: data.email || '',
        role: data.role || '',
        zone: data.zone || '',
        phone: data.phone || '',
        displayName: data.displayName || data.name || '',
        syncedAt: new Date().toISOString(),
        _source: 'stfm-sales',
      }, {merge: true});
    });
    await batch.commit();
    console.log(`Synced ${Math.min(offset + 450, docs.length)}/${docs.length} users.`);
  }

  console.log(`Done! ${docs.length} users synced to ERP salesapp_users.`);
}

bulkSync().catch((error) => {
  console.error('Bulk sync failed:', error.message);
  process.exitCode = 1;
});
