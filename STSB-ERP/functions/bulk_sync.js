/**
 * ONE-TIME BULK SYNC SCRIPT
 * ─────────────────────────
 * Run this ONCE to copy all existing Sales App users into the ERP.
 * After this, the Cloud Function (index.js) keeps them in sync automatically.
 *
 * USAGE:
 *   node bulk_sync.js
 *
 * REQUIREMENTS:
 *   npm install firebase-admin
 *   Place your TWO service account JSON files in this folder:
 *     - stfm-sales-sa.json   (Sales App service account)
 *     - stsb-erp-sa.json     (ERP service account)
 */

const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore }        = require('firebase-admin/firestore');

// ── Init both Firebase apps ───────────────────────────────────────────────────
const salesApp = initializeApp({ credential: cert(require('./stfm-sales-sa.json')) }, 'sales');
const erpApp   = initializeApp({ credential: cert(require('./stsb-erp-sa.json'))   }, 'erp');

const salesDb = getFirestore(salesApp);
const erpDb   = getFirestore(erpApp);

async function bulkSync() {
  console.log('📥 Fetching all users from Sales App (stfm-sales)...');
  const snap = await salesDb.collection('users').get();
  console.log(`✅ Found ${snap.size} users. Syncing to ERP (stsb-erp)...`);

  const batch = erpDb.batch();
  let count = 0;

  snap.forEach(doc => {
    const data = doc.data();
    const erpRef = erpDb.collection('salesapp_users').doc(doc.id);
    batch.set(erpRef, {
      uid:         doc.id,
      name:        data.name        || '',
      email:       data.email       || '',
      role:        data.role        || '',
      zone:        data.zone        || '',
      phone:       data.phone       || '',
      displayName: data.displayName || data.name || '',
      syncedAt:    new Date().toISOString(),
      _source:     'stfm-sales',
    }, { merge: true });

    console.log(`  → ${data.name || doc.id} (${data.role || 'no role'})`);
    count++;
  });

  await batch.commit();
  console.log(`\n🎉 Done! ${count} users synced to ERP salesapp_users collection.`);
  process.exit(0);
}

bulkSync().catch(e => { console.error('❌ Error:', e.message); process.exit(1); });
