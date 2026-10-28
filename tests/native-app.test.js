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
