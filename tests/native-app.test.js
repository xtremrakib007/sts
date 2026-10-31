const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

test('Android app bundles its code instead of loading the website', () => {
  const cfg = JSON.parse(read('capacitor.config.json'));
  assert.equal(cfg.webDir, 'www');
  assert.equal(cfg.server.url, undefined);
  const upd = cfg.plugins.CapacitorUpdater;
  assert.equal(upd.autoUpdate, false, 'updates are applied by js/boot.js, never mid-task');
  assert.equal(upd.statsUrl, '', 'no telemetry to the plugin vendor');
});

test('build publishes a checksummed OTA package and versioned asset URLs', () => {
  const build = read('build.js');
  assert.match(build, /app\.min\.js\?v=\$\{version\}/);
  assert.match(build, /latest\.json/);
  assert.match(build, /createHash\('sha256'\)\.update\(zipBuf\)/);
  const pkg = JSON.parse(read('package.json'));
  assert.ok(pkg.stfm.otaMinNativeBuild >= 1);
  assert.ok(pkg.dependencies['@capgo/capacitor-updater']);
});

test('OTA manifest is never cached and is reachable from the app', () => {
  const headers = JSON.parse(read('firebase.json')).hosting.headers;
  const latest = headers.find((h) => h.source === 'ota/latest.json');
  assert.ok(latest.headers.some((h) => h.key === 'Cache-Control' && h.value === 'no-store'));
  assert.ok(latest.headers.some((h) => h.key === 'Access-Control-Allow-Origin'));
  assert.match(read('index.html'), /connect-src 'self' https:\/\/stfm-sales\.web\.app/);
  assert.match(read('sw.js'), /url\.pathname\.startsWith\('\/ota\/'\)[\s\S]*stfm-sales\.web\.app/);
});

test('app confirms each bundle and only applies updates when safe', () => {
  const boot = read('js/boot.js');
  assert.match(boot, /notifyAppReady\(\)/);
  assert.match(boot, /applyIfSafe && _safeToReload\(\)/);
  assert.match(boot, /checksum: m\.checksum/);
  assert.match(boot, /minNativeBuild/);
});

test('field staff are blocked from the web Sales App, admins are not', () => {
  const boot = read('js/boot.js');
  assert.match(boot, /user\.role === 'sales_rep' \|\| user\.role === 'delivery_man'/);
  assert.match(boot, /_fieldStaffBlockedOnWeb\(CU\)/);
});

test('GitHub builds the APK: debug without secrets, signed release with them', () => {
  const wf = read('.github/workflows/android-apk.yml');
  assert.match(wf, /npm run build[\s\S]*npx cap sync android[\s\S]*gradlew --no-daemon assembleRelease[\s\S]*assembleDebug/);
  assert.match(wf, /java-version: 17/);
  assert.match(wf, /upload-artifact@v4/);
  assert.match(wf, /github\.ref == 'refs\/heads\/main' && env\.STFM_KEYSTORE_FILE != ''/, 'releases only for signed main builds');
  const gradle = read('android/app/build.gradle');
  assert.match(gradle, /if \(System\.getenv\('STFM_KEYSTORE_FILE'\)\) \{\s*signingConfig signingConfigs\.release/);
  assert.doesNotMatch(gradle, /storePassword\s+['"]/, 'no passwords in the repo');
});

test('Android build stays on API 34: WorkManager pinned below 2.10 (needs compileSdk 35)', () => {
  assert.match(read('android/build.gradle'), /resolutionStrategy\.force 'androidx\.work:work-runtime:2\.9\.1'/);
  assert.match(read('android/variables.gradle'), /compileSdkVersion = 34/);
  // androidx.savedstate 1.4 (via the updater plugin) and Capacitor 7 need Android 6.0+.
  assert.match(read('android/variables.gradle'), /minSdkVersion = 23/);
});

test('a Firebase config without this app id disables push instead of failing the build, with a warning', () => {
  assert.match(read('android/app/build.gradle'), /servicesJSON\.text\.contains\("\\"package_name\\": \\"\$\{appId\}\\""\)/);
  assert.match(read('.github/workflows/android-apk.yml'), /::warning title=Push notifications disabled::/);
});

// The Capacitor native bridge returns the callback id straight from
// Geolocation.watchPosition (no promise); calling .then on it crashed the
// app on sign-in for sales reps and delivery men.
test('field-staff location tracking works when watchPosition returns the id directly', async () => {
  const vm = require('node:vm');
  const saved = [];
  const pos = { coords: { latitude: 4.6, longitude: 101.1, accuracy: 5 } };
  for (const mode of ['id', 'promise']) {
    const ctx = {
      console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout, setInterval: () => 1, clearInterval() {},
      navigator: {}, localStorage: { getItem: () => null, setItem() {} }, document: { getElementById: () => null, addEventListener() {} }, addEventListener() {},
      CU: { uid: 'rep1', role: 'sales_rep' }, isAdmin: () => false, showToast() {},
    };
    ctx.window = ctx;
    ctx.Capacitor = { isNativePlatform: () => true, Plugins: { Geolocation: {
      getCurrentPosition: async () => pos,
      watchPosition: (o, cb) => { setTimeout(() => cb(pos), 0); return mode === 'id' ? 'cb-1' : Promise.resolve('cb-1'); },
      clearWatch: () => undefined,
    } } };
    vm.createContext(ctx);
    vm.runInContext(read('js/tracking.js'), ctx);
    vm.runInContext('saveUserLocation = p => __saved.push(p); _captureAndSaveLocation = () => {}; _registerPeriodicLocationSync = () => {}; _requestNotificationPermission = () => {}; _showTrackingIndicator = () => {}; _dismissTrackingNotification = () => {};', Object.assign(ctx, { __saved: saved }));
    assert.doesNotThrow(() => vm.runInContext('startLocationTracking()', ctx), mode);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(vm.runInContext('_locationWatcher', ctx), 'cb-1', mode);
    assert.doesNotThrow(() => vm.runInContext('stopLocationTracking()', ctx), mode);
  }
  assert.equal(saved.length, 2, 'each watcher delivered a position');
  assert.match(read('js/boot.js'), /try \{ startLocationTracking\(\); \} catch/);
});

test('owner (super_admin) gets the admin home tiles and alerts', () => {
  const html = read('index.html');
  assert.match(html, /if \(role === 'super_admin'\) role = 'admin';/, 'home grid maps super_admin to admin');
  assert.match(html, /\['admin','sub_admin','super_admin'\]\.includes\(role\)/, 'low stock alert');
  assert.match(html, /\{ page:'advances',\s+ico:'💵', lbl:'Advances',\s+roles:\[\.\.\.R_ALL\]/);
});

test('no automatic logout: no inactivity timer, logins are kept', () => {
  const html = read('index.html');
  assert.doesNotMatch(html, /SESSION_TIMEOUT_MS|session_timeout'\s*\}\)|stsbSessionCountdown/, 'Sales App inactivity logout removed');
  assert.match(html, /id="rememberMe" checked/, 'Keep me signed in is on by default');
  assert.match(read('js/auth.js'), /getElementById\('rememberMe'\)\?\.checked!==false/);
  const portal = read('public/portal/index.html');
  assert.match(portal, /await setPersistence\(_auth, browserLocalPersistence\)/, 'ERP keeps its login');
  assert.doesNotMatch(portal, /setTimeout\([^)]*signOut/, 'ERP has no timed sign-out');
});

test('Live Locations reads the GPS the app saves on each user profile, live', () => {
  const html = read('index.html');
  assert.doesNotMatch(html, /userLocations/, 'no separate collection (no rules for it; writes were refused)');
  assert.match(html, /sf\(\)\.onSnapshot\(_usersQuery\(\)/);
  assert.match(html, /const gpsTs = toDate\(u\.lastLocationAt\);/);
  assert.match(html, /where\('zoneId', '==', CU\.zoneId\)/, 'zone admins query their own zone (rules)');
  const t = read('js/tracking.js');
  assert.match(t, /lastAccuracy: Math\.round\(pos\.coords\.accuracy \|\| 0\),\s+lastSeen: new Date\(\)\.toISOString\(\),/);
  assert.match(t, /_ensureNativePermission\(\)\.then\(_captureAndSaveLocation\)/);
  const rules = read('firestore.rules');
  assert.match(rules, /'fcmToken','lastSeen','pushEnabled','name','phone','avatar',\s+'lastLat','lastLng','lastLocationAt','lastAccuracy'/, 'self-update of these fields is allowed');
  assert.match(read('js/boot.js'), /liveLocations: \(\)=>window\.__llReload&&window\.__llReload\(\),/);
});

test('Sync button: reloads data from the server, redraws the page, applies a waiting app update', () => {
  assert.match(read('index.html'), /id="syncBtn" onclick="syncApp\(\)"/);
  const boot = read('js/boot.js');
  const fn = boot.slice(boot.indexOf('async function syncApp()'));
  for (const step of ['invalidateCache();', 'await loadCachedData(true);', '_reloadActivePage();', '_captureAndSaveLocation();', '_otaCheck(true);'])
    assert.ok(fn.slice(0, 1200).includes(step), step);
  assert.match(fn, /if \(!navigator\.onLine\)/, 'offline: says so instead of failing');
});

test('outlet statement: delivered value, order-tied payments first, then oldest first', () => {
  const vm = require('node:vm');
  const ctx = { console, window: {}, document: { getElementById: () => null, querySelectorAll: () => [], addEventListener: () => {} } };
  vm.createContext(ctx);
  vm.runInContext("const PUBLIC_APP_URL='https://sales.stfreshmart.my';\n" + read('js/outlets.js') + '\nthis.L=outletLedger;', ctx);
  const J = (x) => JSON.parse(JSON.stringify(x));
  const orders = [
    { _docId: 'a', id: 'A', status: 'Delivered', total: 100, date: '2026-10-01' },
    { _docId: 'b', id: 'B', status: 'Delivered', total: 100, deliveredTotal: 80, date: '2026-10-10' },
    { _docId: 'c', id: 'C', status: 'Confirmed', total: 60, date: '2026-10-20' },
    { _docId: 'd', id: 'D', status: 'Cancelled', total: 999, date: '2026-10-21' },
  ];
  const L = ctx.L(orders, [{ amount: 30, orderId: 'B' }, { amount: 120 }], 0);
  assert.deepEqual([L.sales, L.paid, L.outstanding], [240, 150, 90]);
  assert.deepEqual(J(L.pending.map((l) => [l.o.id, l.paid, l.balance])), [['B', 50, 30], ['C', 0, 60]]);
  assert.deepEqual(J(L.orders.map((l) => l.o.id)), ['C', 'B', 'A'], 'newest first, cancelled left out');
  const withOpening = ctx.L(orders.slice(0, 1), [{ amount: 50 }], 70);
  assert.deepEqual(J(withOpening.pending.map((l) => [l.opening ? 'opening' : l.o.id, l.balance])), [['opening', 20], ['A', 100]], 'payment clears the opening balance first');
  assert.match(read('js/ui.js'), /el\.style\.zIndex=String\(\+\+_mTop\)/, 'invoice opens above the outlet window');
});

test('over-the-air package carries vendor/ (invoice PDF and share need html2canvas + jsPDF)', () => {
  const build = read('build.js');
  assert.match(build, /for \(const file of \['index\.html', 'js\/app\.min\.js', \.\.\.COPY_FILES, \.\.\.vendorFiles, 'portal\/index\.html'\]\)/);
  assert.match(read('js/orders.js'), /_loadScriptOnce\('vendor\/html2canvas\.js'\), _loadScriptOnce\('vendor\/jspdf\.js'\)/);
});

test('Sync for field staff does not list users (rules allow only their own profile)', () => {
  const boot = read('js/boot.js');
  assert.match(boot, /isAdmin\(\) \? _fetchUsers\(\)\.catch\(none\) : Promise\.resolve\(_selfOnly\(\)\)/);
  assert.match(boot, /isAdmin\(\) \? get\(_usersRef\(\)\) : Promise\.resolve\(_selfOnly\(\)\)/);
  assert.match(boot, /window\.__SF\.getDocs\(rootCol\('products'\)\)\.catch\(none\)/);
});

test('Audit Log / Data Export / Error Log pages work', () => {
  const html = read('index.html');
  assert.match(html, /writeBatch, limit \} from "https:\/\/www\.gstatic\.com\/firebasejs\/10\.12\.2\/firebase-firestore\.js"/, 'limit imported (audit query used it)');
  assert.match(html, /writeBatch: writeBatch, limit: limit,/);
  assert.match(html, /<div id="pageAuditLog" class="page">/, 'no inline display:none hiding the page');
  assert.match(html, /<div id="pageDataExport" class="page">/);
  assert.match(html, /window\.stsbLoadMoreAudit = function\(\)/);
  assert.match(html, /window\.stsbExportAuditCSV = function\(\)/);
  assert.match(html, /async function _stsbTriggerDownload\(blob, filename\) \{\n        if \(typeof _invNative === 'function' && _invNative\(\)\)/, 'app saves files to Documents');
  assert.match(html, /window\.stsbLogError = function\(kind, message, stack\)/);
  assert.match(html, /<div id="pageErrorLog" class="page">/);
  assert.match(read('firestore.rules'), /match \/error_log\/\{entryId\} \{/);
});

test('delivery man: working outlets only until the office closes his day', () => {
  assert.match(read('js/core.js'), /function _dmActiveOutletIds\(orders\)/);
  assert.match(read('js/outlets.js'), /allowedIds=_dmActiveOutletIds\(myO\.map\(d=>d\.data\(\)\)\)/);
  assert.match(read('public/portal/index.html'), /window\.closeDriverDay = async function\(dmId\)/);
  assert.match(read('js/collections.js'), /\.\.\.\(isDeliveryMan\(\)\?\{source:'delivery'\}:\{\}\)/);
});

test('Audit / Error / Data Export pages live in the app page area (open at the top)', () => {
  const html = read('index.html');
  assert.match(html, /\['pageAuditLog', 'pageErrorLog', 'pageDataExport'\]\.forEach\(id => \{\n            const el = document\.getElementById\(id\);\n            if \(el && el\.parentNode !== host\) host\.appendChild\(el\);/);
  assert.match(read('js/ui.js'), /auditLog:\{title:'Audit Log'/);
});

test('background location (APK 1.5+): foreground service watcher, native saves in the background', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.dependencies['@capacitor-community/background-geolocation'], '1.2.26');
  assert.equal(JSON.parse(read('capacitor.config.json')).android.useLegacyBridge, true, 'updates keep coming after 5 min in the background');
  assert.match(read('android/capacitor.settings.gradle'), /include ':capacitor-community-background-geolocation'/);
  assert.match(read('android/app/src/main/res/values/strings.xml'), /capacitor_background_geolocation_notification_icon">drawable\/ic_stat_location</);
  const t = read('js/tracking.js');
  assert.match(t, /backgroundTitle: 'STSB is sharing your location'/);
  assert.match(t, /if \(_bgGeo\(\)\) \{\n    _startBackgroundWatch\(\);/);
  assert.match(t, /document\.visibilityState === 'hidden' && _isCapacitor\(\) && await _saveLocationNative\(fields\)/);
  assert.match(t, /BG\.removeWatcher\(\{ id: _bgWatcherId \}\)/, 'stops on sign out');
  assert.match(read('android/app/src/main/AndroidManifest.xml'), /ACCESS_BACKGROUND_LOCATION/);
});

test('custom domains: erp.* opens the ERP, customer links use sales.stfreshmart.my, updates stay on web.app', () => {
  const html = read('index.html');
  assert.match(html, /if \(\/\^erp\\\.\/i\.test\(location\.hostname\) && !\/\^\\\/portal\(\\\/\|\$\)\/\.test\(location\.pathname\)\) location\.replace\('\/portal'/);
  assert.match(read('js/core.js'), /const PUBLIC_ERP_URL = 'https:\/\/erp\.stfreshmart\.my';/);
  assert.match(read('js/orders.js'), /\$\{PUBLIC_APP_URL\}\/einvoice\.html\?i=/);
  assert.match(read('js/boot.js'), /const OTA_BASE = 'https:\/\/stfm-sales\.web\.app\/ota\/';/, 'phones keep updating from the default domain');
});

test('native push only on APKs built with Firebase (older APKs crash in register())', () => {
  const fcm = fs.readFileSync(path.join(__dirname, '..', 'js', 'fcm.js'), 'utf8');
  assert.match(fcm, /const PUSH_MIN_NATIVE_BUILD = (\d+);/);
  const min = Number(fcm.match(/const PUSH_MIN_NATIVE_BUILD = (\d+);/)[1]);
  const gradle = fs.readFileSync(path.join(__dirname, '..', 'android', 'app', 'build.gradle'), 'utf8');
  assert.ok(Number(gradle.match(/versionCode (\d+)/)[1]) >= min, 'the current APK has push');
  assert.ok(min >= 6, 'APK 1.4 (build 5) had no Firebase');
  const guard = fcm.indexOf('< PUSH_MIN_NATIVE_BUILD'), reg = fcm.indexOf('await PushNotifications.register()');
  assert.ok(guard > 0 && guard < reg, 'build check comes before register()');
});

test('no "Confirm Navigation" box in the app; website warns only with an unfinished order', () => {
  const boot = read('js/boot.js');
  const i = boot.indexOf("addEventListener('beforeunload'");
  assert.ok(i > 0);
  const before = boot.slice(Math.max(0, i - 200), i);
  assert.match(before, /if \(!\(window\.Capacitor && window\.Capacitor\.isNativePlatform && window\.Capacitor\.isNativePlatform\(\)\)\) \{/);
  assert.match(boot.slice(i, i + 200), /if \(typeof ordItems === 'undefined' \|\| !ordItems\.length\) return;/);
});

test('owner, all zones: zone-only records are read too; outlet list has zone chips', () => {
  const core = read('js/core.js'), boot = read('js/boot.js'), out = read('js/outlets.js'), fn = read('functions/index.js');
  assert.match(core, /function _ownerAllZones\(colName\) \{\s*return !!\(isOwner\(\) && !_ownerZoneFilter && MIRROR_COLS\.has\(colName\) && colName !== 'products'\);/);
  assert.match(core, /const docs = await _withZoneOnlyDocs\(colName, snap\.docs, getDocs, constraints\);/, 'sfGet');
  assert.match(boot, /_withZoneOnlyDocs\(n, s\.docs, get\)/, 'start-up load');
  assert.match(core, /return _ownerZoneOf\.get\(colName \+ '\/' \+ docId\) \|\| null;/, 'owner edits reach zone-only records');
  assert.match(out, /function _outletZoneBar\(\)/);
  assert.match(out, /let base=allOutlets\.filter\(_inOutletZone\);/);
  assert.match(fn, /collection\(`zones\/\$\{z\.id\}\/outlets`\)\.where\('portalToken', '==', t\)/, 'customer page finds zone-only outlets');
  assert.match(fn, /exports\.shopRegisterCustomerZone = functions\.firestore\.document\('zones\/\{zoneId\}\/outlets\/\{outletId\}'\)/);
});

test('ERP Sales Orders: salesmen orders and customer (online shop) orders are separate options', () => {
  const html = read('public/portal/index.html');
  assert.match(html, /const isCust = v => v\.source === 'online_shop';/);
  assert.match(html, /all\.filter\(d => \(tab === 'customer'\) === isCust\(d\.data\(\)\)\)/);
  assert.match(html, /🛒 Customer orders/);
  assert.match(html, /onclick="window\.__soTab='customer';goPage\('salesOrders'\)"/);
});
