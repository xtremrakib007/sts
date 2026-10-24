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

// Exact script loading sequence matching index.html (boot.js MUST be last)
const JS_FILES = [
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

  // Inject bundle before closing body or right before custom scripts
  if (html.includes('</body>')) {
    html = html.replace('</body>', '    <script src="js/app.min.js"></script>\n</body>');
  } else {
    html += '\n<script src="js/app.min.js"></script>';
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
