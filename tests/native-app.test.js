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
  vm.runInContext(read('js/outlets.js') + '\nthis.L=outletLedger;', ctx);
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
