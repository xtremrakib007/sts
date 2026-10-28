/**
 * STFM Unified Build Script
 * Generates production bundles for both:
 *  - Firebase Hosting (public/)
 *  - Capacitor Android APK (www/)
 *
 * Run: node build.js
 */

const { minify: minifyJS }   = require('terser');
const { minify: minifyHTML } = require('html-minifier-terser');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const AdmZip = require('adm-zip');
const pkg = require('./package.json');

// Exact script loading sequence matching index.html (boot.js MUST be last)
const JS_FILES = [
  'node_modules/qrcode-generator/qrcode.js', // global qrcode() for invoice QR codes
  'js/core.js',
  'js/ui.js',
  'js/auth.js',
  'js/fcm.js',
  'js/tracking.js',
  'js/dashboard.js',
  'js/attendance.js',
  'js/orders.js',
  'js/outlets.js',
  'js/products.js',
  'js/collections.js',
  'js/routes.js',
  'js/deliveries.js',
  'js/reports.js',
  'js/users.js',
  'js/delete.js',
  'js/broadcast.js',
  'js/misc.js',
  'js/boot.js'
];

// Static assets copied to both public/ and www/
const COPY_FILES = [
  'app.css',
  'manifest.json',
  'sw.js',
  'firebase-messaging-sw.js',
  'fcm-client.js',
  'icon-192.png',
  'icon-512.png'
];

// Third-party browser files served as-is (the ERP portal loads these).
const VENDOR_FILES = {
  'node_modules/qrcode-generator/qrcode.js': 'vendor/qrcode.js',
};

const TARGET_DIRS = ['public', 'www'];

async function build() {
  console.log('🚀 Starting STFM build process...\n');

  // 1. Ensure target directories exist
  for (const dir of TARGET_DIRS) {
    fs.mkdirSync(path.join(dir, 'js'), { recursive: true });
  }

  // 2. Minify JS bundle
  console.log('⚙️  Minifying JavaScript bundle...');
  const code = {};
  for (const f of JS_FILES) {
    if (!fs.existsSync(f)) {
      throw new Error(`Required JS file not found: ${f}`);
    }
    code[f] = fs.readFileSync(f, 'utf8');
  }

  const jsResult = await minifyJS(code, {
    compress: {
      drop_console: false, // Keep logs for production debugging if needed
      drop_debugger: true
    },
    mangle: true
  });

  if (!jsResult.code) {
    throw new Error('JS minification returned empty code');
  }

  for (const dir of TARGET_DIRS) {
    const targetJs = path.join(dir, 'js', 'app.min.js');
    fs.writeFileSync(targetJs, jsResult.code, 'utf8');
    const kb = (fs.statSync(targetJs).size / 1024).toFixed(1);
    console.log(`   ✅ ${targetJs} (${kb} KB)`);
  }

  // 3. Process and minify index.html
  console.log('\n⚙️  Processing index.html...');
  let html = fs.readFileSync('index.html', 'utf8');

  // Replace individual script tags with single minified script bundle
  const scriptRegex = /<script\s+src=["']js\/(core|ui|auth|fcm|tracking|dashboard|attendance|orders|outlets|products|collections|routes|deliveries|reports|users|delete|broadcast|misc|boot)\.js["']><\/script>\s*/gi;
  html = html.replace(scriptRegex, '');

  // Version = hash of the shipped JS + CSS. It goes into the asset URLs so
  // the year-long immutable cache can never serve stale code, and names the
  // over-the-air package the Android app downloads (step 6).
  const css = fs.readFileSync('app.css', 'utf8');
  const version = crypto.createHash('sha256').update(jsResult.code).update(css).digest('hex').slice(0, 12);
  html = html.replace(/href=(["'])app\.css\1/, `href="app.css?v=${version}"`);
  // Android app ids registered in google-services.json. Native push needs
  // Firebase initialised for the APK's own id — registering without it
  // kills the app — so js/fcm.js only registers when its id is listed.
  let pushAppIds = [];
  try {
    const gs = JSON.parse(fs.readFileSync('android/app/google-services.json', 'utf8'));
    pushAppIds = (gs.client || []).map(c => c.client_info?.android_client_info?.package_name).filter(Boolean);
  } catch (e) { /* no Firebase config: native push stays off */ }
  const versionTag = `<script>window.__APP_VERSION='${version}';window.__PUSH_APP_IDS=${JSON.stringify(pushAppIds)};</script>`;
  const bundleTag = `<script src="js/app.min.js?v=${version}"></script>`;

  // Inject bundle before closing body or right before custom scripts
  if (html.includes('</body>')) {
    html = html.replace('</body>', `    ${versionTag}\n    ${bundleTag}\n</body>`);
  } else {
    html += `\n${versionTag}\n${bundleTag}`;
  }

  const htmlResult = await minifyHTML(html, {
    collapseWhitespace:        true,
    removeComments:            true,
    removeRedundantAttributes: true,
    removeEmptyAttributes:     true,
    minifyCSS:                 true,
    minifyJS:                  false // Inline scripts already handled or large
  });

  for (const dir of TARGET_DIRS) {
    const targetHtml = path.join(dir, 'index.html');
    fs.writeFileSync(targetHtml, htmlResult, 'utf8');
    const kb = (fs.statSync(targetHtml).size / 1024).toFixed(1);
    console.log(`   ✅ ${targetHtml} (${kb} KB)`);
  }

  console.log(`   🏷️  version ${version}`);

  // 4. Copy static assets
  console.log('\n⚙️  Copying static assets...');
  for (const file of COPY_FILES) {
    if (fs.existsSync(file)) {
      for (const dir of TARGET_DIRS) {
        fs.copyFileSync(file, path.join(dir, file));
        console.log(`   📋 ${path.join(dir, file)}`);
      }
    } else {
      console.warn(`   ⚠️ Asset not found to copy: ${file}`);
    }
  }

  for (const [from, to] of Object.entries(VENDOR_FILES)) {
    for (const dir of TARGET_DIRS) {
      fs.mkdirSync(path.join(dir, path.dirname(to)), { recursive: true });
      fs.copyFileSync(from, path.join(dir, to));
      console.log(`   📋 ${path.join(dir, to)}`);
    }
  }

  // Remove stale source maps so previous builds cannot leak original source code.
  for (const dir of TARGET_DIRS) {
    const jsDir = path.join(dir, 'js');
    if (fs.existsSync(jsDir)) {
      for (const file of fs.readdirSync(jsDir)) {
        if (file.endsWith('.map')) {
          fs.unlinkSync(path.join(jsDir, file));
          console.log(`   🛡️ Removed source map: ${dir}/js/${file}`);
        }
      }
    }
  }

  // 6. Over-the-air package for the Android app: the same files the APK
  //    bundles, zipped, with a sha256 the updater plugin verifies before
  //    installing. Raise stfm.otaMinNativeBuild in package.json whenever
  //    a change also needs a new APK (new plugin, permission, native code).
  console.log('\n📦 Publishing over-the-air update package...');
  const otaDir = path.join('public', 'ota');
  fs.rmSync(otaDir, { recursive: true, force: true });
  fs.mkdirSync(otaDir, { recursive: true });
  const zip = new AdmZip();
  for (const file of ['index.html', 'js/app.min.js', ...COPY_FILES]) {
    const src = path.join('www', file);
    if (fs.existsSync(src)) zip.addLocalFile(src, path.dirname(file) === '.' ? '' : path.dirname(file));
  }
  const zipName = `${version}.zip`;
  const zipBuf = zip.toBuffer();
  fs.writeFileSync(path.join(otaDir, zipName), zipBuf);
  const ota = pkg.stfm || {};
  fs.writeFileSync(path.join(otaDir, 'latest.json'), JSON.stringify({
    version,
    url: zipName,
    checksum: crypto.createHash('sha256').update(zipBuf).digest('hex'),
    minNativeBuild: ota.otaMinNativeBuild || 0,
    apkUrl: ota.apkUrl || '',
    builtAt: new Date().toISOString(),
  }, null, 2) + '\n', 'utf8');
  console.log(`   ✅ public/ota/${zipName} (${(zipBuf.length / 1024).toFixed(1)} KB) + latest.json`);

  // 5. Clean up any sensitive files from output folders
  console.log('\n🔒 Verifying security of distribution directories...');
  for (const dir of TARGET_DIRS) {
    const files = fs.readdirSync(dir);
    for (const f of files) {
      if (f.endsWith('.json') && (f.includes('service-account') || f.includes('stfm-sales') || f.includes('-sa'))) {
        fs.unlinkSync(path.join(dir, f));
        console.log(`   🛡️ Removed sensitive credential from ${dir}/${f}`);
      }
    }
  }

  console.log('\n✨ Build complete! Targets updated: [public/] (Firebase) & [www/] (Capacitor)');
}

build().catch(err => {
  console.error('\n❌ Build failed:', err.message);
  process.exit(1);
});
