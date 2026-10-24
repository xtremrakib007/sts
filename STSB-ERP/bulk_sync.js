/**
 * BULK SYNC — One-time script
 * Copies ALL existing Sales App users into ERP's salesapp_users collection.
 * Run ONCE after deploying the Cloud Function.
 *
 * Usage:
 *   npm install firebase-admin
 *   node bulk_sync.js
 *
 * NOTE: You need stfm-sales-sa.json (Sales App service account).
 * Download from: Firebase Console → stfm-sales → Project Settings → Service Accounts
 */

const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore }        = require("firebase-admin/firestore");

const SALES_CREDENTIAL = require("./stfm-sales-sa.json");

const ERP_CREDENTIAL = {
  type: "service_account",
  project_id: "stsb-erp",
  private_key_id: "4a1ba0806e516424484c236b5571f39c064076fb",
  private_key: "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC/kwdmO+n/Ju14\n0Qv4LoQjnHtQjGZR7S914xpsm/D+70Er27O5yoHQCLuFMvM0mahExl9TRlV7BFne\nN8nOVbMkU1VUIOB3v5W0YTz8/kAZwJhljqRfCxh198l7sOj5rn0Si5UOys7+JeGa\nplY+L7lTCKlyA+y/TCb4omh6ZrtZUXQllHTLyEL+kZIVLpSUPYSU7ps7lC3jEmlz\nBTsw8hoIvA0BAshDiDeA2l6cU5neXm2PMFncwLgICEiJ4128dvxmWMd6R4RRNY/S\n/iAfPC3MGfTZ0htdOp1d/n5Y28AqOXHds8Ce+1YssmBrt4CWfCS2n4IXe2tzMhZG\nbiZPOyWdAgMBAAECggEAUJe3hKxO5/7F5042dV2ITHzvqbau8udP0I3OV4OQ8obP\niXZfWRlW3CBYVxRUmTvNPMWhY6SSoHJ3phMdLFcESpNeMcq089uezKgdoqcJa2wJ\nEKxd/PfrffFUi1sk36kmx8790Z/DTcq86rTwUi/8jHB37FW3WtDcEjwsrNWcGln8\n8hxlzmxZsUPaAsNdngrOSemG7SsVnEcFjAwr+SKDqIRr4IGuPYVwfHwrrGsazHzO\nmhr65q8QwdbGF+GV3j+QTWJdCdHvCBd1fexXkPDINgwMz2BdkwotW3OiSJLAhu9S\nxfdwG2LnElMIsBSral5/tUHuuUFXIObYBlysXZeXhwKBgQD4Na2j/7ZIZEqFiokt\nOYkszRlTgpZ3IFyX/MIO0MWYvfAwZ8722rVsY8/ABQcbBKfZ8Kx9VmK9SGimzha1\n6O8aNlZT4tK9Gauv0xB6lrsqk3DpYWZoZhkrjZilfJZlTKzb1i+e8WhiqKAyvsMl\nP1jtjGqfkgTrOQ9dqS4CiLQwKwKBgQDFlkugchgnDgz8S8DchrVJc41ivIFlL5yK\nZ9l/TxuMIehn2b5wvjyyWaxGXbRI0FkWPtRWQhL6ZrZGSmfmCz0OvlQJlG3ugeUu\nW/5T5iSRHbPlX6CaOvBSXRRNMaFWtWHlH5YWr5WOX7HmL+bPQe5GU0rsdHE/Gjx9\nDngGmUHVVwKBgQDKoB+Bu1YWoPEJNYAo0EiAr2qWdwvYci3E0c2mBJ7aw2waSBR4\nBzGGK7FEo5YaY2GXlFdr9qKivULZsXJuzJqs/mDZGFlLkHJNFfPk77oZ1sWdcCsG\n3Rp9KJnNtvib981Bpge4LIE30Ur+QibS+HTjb/b3D2A+mpVFs7/gx7K5gwKBgEz9\nyJBHhRPKzNKOriMANqndZe1gaMdF6yifWMfbym8rU0UMOsHxzvLsME3m+3YYAW7C\norjN3FlIJqRzH9Mq8+rHzTVCaiey49vRquOEXSFSwqORRKJ0buqZLGz79tMzsGa4\njSJf3tXwggChD74ZAcDTefFzWiFtlr5gIfLoSxfXAoGAFIzBGVKQDgOge0MWIeao\nhpaE+9yayAM6DkyukW7f4ehItHhzOd1R8tOF3Pow7xIz8xrGvYhZfX/sd0VUhJOo\nuj71MWq1Is9v95V2OAuFWGEOqVWK+PC7VK9lCCCKcSXVKbrPOD7b/uiHhojWPDSo\nzTXtpG3+fORuEY0OKFPWySE=\n-----END PRIVATE KEY-----\n",
  client_email: "firebase-adminsdk-fbsvc@stsb-erp.iam.gserviceaccount.com",
  client_id: "108424370136963662107",
  auth_uri: "https://accounts.google.com/o/oauth2/auth",
  token_uri: "https://oauth2.googleapis.com/token",
};

const salesApp = initializeApp({ credential: cert(SALES_CREDENTIAL) }, "sales");
const erpApp   = initializeApp({ credential: cert(ERP_CREDENTIAL), projectId: "stsb-erp" }, "erp");

const salesDb = getFirestore(salesApp);
const erpDb   = getFirestore(erpApp);

async function bulkSync() {
  console.log("Fetching all users from Sales App (stfm-sales)...");
  const snap = await salesDb.collection("users").get();
  console.log("Found " + snap.size + " users. Syncing to ERP salesapp_users...\n");

  const batch = erpDb.batch();
  snap.forEach(doc => {
    const d = doc.data();
    const name = d.displayName || d.name || (d.email ? d.email.split("@")[0] : "") || doc.id;
    batch.set(erpDb.collection("salesapp_users").doc(doc.id), {
      uid:         doc.id,
      name:        d.name        || "",
      email:       d.email       || "",
      role:        d.role        || "",
      zone:        d.zone        || "",
      phone:       d.phone       || "",
      displayName: d.displayName || d.name || "",
      syncedAt:    new Date().toISOString(),
      _source:     "stfm-sales",
    }, { merge: true });
    console.log("  -> " + name + " (" + (d.role || "no role") + ")");
  });

  await batch.commit();
  console.log("\nDone! " + snap.size + " users synced to ERP salesapp_users collection.");
  process.exit(0);
}

bulkSync().catch(e => { console.error("Error:", e.message); process.exit(1); });
