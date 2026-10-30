const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const erp = require('../functions/erp-sync');
const sl = require('../functions/stock-ledger');

// ── Storeman ────────────────────────────────────────────────────────────────

test('packing progress and the e-Invoice token flow from the ERP to the app order', () => {
  const base = {status: 'processing', deliveryStatus: 'pending'};
  assert.deepEqual(erp.appPatchFromErp(base, {...base, pickStatus: 'packed'}, 'Confirmed'),
    {pickStatus: 'packed', erpStatus: 'processing'});
  const t = erp.appPatchFromErp(base, {...base, invoiceNo: 'INV-000007', einvoiceToken: 'abc'}, 'Confirmed');
  assert.equal(t.invoiceNo, 'INV-000007');
  assert.equal(t.einvoiceToken, 'abc');
  assert.equal(erp.appPatchFromErp(base, {...base}, 'Confirmed'), null, 'no change, no write');
});

test('a storeman\'s adjustments always wait for an admin; receipts post directly', () => {
  const item = {name: 'Tea', qty: 100, avgCost: 2};
  const cfg = {approvalValue: 200, allowNegative: false};
  assert.equal(sl.needsApproval({type: 'damage', qty: 1}, item, cfg), false, 'admin: small damage posts');
  assert.equal(sl.needsApproval({type: 'damage', qty: 1, requestedByRole: 'storeman'}, item, cfg), true);
  assert.equal(sl.needsApproval({type: 'count', countedQty: 99, requestedByRole: 'storeman'}, item, cfg), true);
  assert.equal(sl.needsApproval({type: 'receipt', qty: 50, requestedByRole: 'storeman'}, item, cfg), false);
});

test('rules: storeman reads orders and stock, packs orders, cannot approve or see finance', () => {
  const rules = read('firestore.rules');
  assert.match(rules, /function isStsbStoreman\(\)[\s\S]*?role', ''\) == 'storeman'[\s\S]*?status', 'active'\) == 'active'/);
  assert.match(rules, /hasOnly\(\['pickStatus', 'pickedBy', 'pickedByName', 'pickStartedAt', 'packedAt', 'pickNote', 'updatedAt'\]\)/);
  assert.match(rules, /requestedByRole == 'storeman'/);
  const approvals = rules.slice(rules.indexOf('match /stsb_stock_requests/'), rules.indexOf('match /stsb_stock_ledger/'));
  assert.match(approvals, /allow update: if isStsbERPAdmin\(\)/, 'only ERP admins approve');
  for (const col of ['stsb_collections', 'stsb_invoices', 'stsb_credit_notes', 'stsb_returns']) {
    const block = rules.slice(rules.indexOf(`match /${col}/`), rules.indexOf('}', rules.indexOf(`match /${col}/`)));
    assert.doesNotMatch(block, /Storeman|isStsbStaff/, `${col} stays admin-only`);
  }
  assert.match(rules, /request\.resource\.data\.get\('role',''\) != 'storeman' \|\| resource\.data\.get\('role',''\) == 'storeman'/,
    'only the owner can turn someone into a storeman');
});

test('portal: storeman gets the warehouse menu and cost columns are hidden', () => {
  const p = read('public/portal/index.html');
  assert.match(p, /const STORE_PAGES = \['picking', 'inventory', 'storeRequests', 'stockLedger'\]/);
  assert.match(p, /if \(_appRole === 'store' && !STORE_PAGES\.includes\(page\)\) page = 'picking';/);
  assert.match(p, /body\.store-mode \.adm-only\{display:none!important\}/);
  assert.match(p, /<th class="adm-only" style="text-align:right">Avg cost<\/th>/);
  assert.match(p, /\.\.\.\(_appRole === 'store' \? \{ requestedByRole: 'storeman' \} : \{\}\)/);
});

// ── LHDN e-Invoice requests ────────────────────────────────────────────────

test('rules: public e-Invoice requests need the invoice\'s own token and only buyer fields', () => {
  const rules = read('firestore.rules');
  const block = rules.slice(rules.indexOf('function einvBuyerFields()'), rules.indexOf('match /stsb_suppliers/'));
  assert.match(block, /get\(inv\)\.data\.get\('einvoiceToken', ''\) == d\.token/);
  assert.match(block, /d\.keys\(\)\.hasOnly\(einvBuyerFields\(\)\)/);
  assert.match(block, /d\.status == 'pending'/);
  assert.match(block, /allow read, delete: if isStsbERPAdmin\(\);/);
  assert.match(block, /resource\.data\.status == 'pending' && validEinvRequest\(invNo\)/, 'buyer edits only while pending');
});

test('invoices carry a random token and print an e-Invoice QR code', () => {
  const p = read('public/portal/index.html');
  assert.match(p, /crypto\.getRandomValues\(new Uint8Array\(16\)\)/);
  assert.match(p, /tx\.set\(invRef, \{ \.\.\._invoiceFromOrder\(orderId, o, no\), einvoiceToken \}\)/);
  assert.match(read('js/invoice-template.js'), /Scan for E-Invoice/);
  assert.match(p, /<script defer src="\/vendor\/qrcode\.js"><\/script>/);
  const page = read('public/einvoice.html');
  assert.match(page, /setDoc\(doc\(db, 'stsb_einvoice_requests', invoiceNo\), data\)/);
  assert.match(page, /\/\^\[a-f0-9\]\{32\}\$\/\.test\(token\)/);
  const build = read('build.js');
  assert.match(build, /'node_modules\/qrcode-generator\/qrcode\.js', \/\/ global qrcode\(\)/);
});

test('the QR code library encodes the e-Invoice link', () => {
  const qrcode = require('qrcode-generator');
  const qr = qrcode(0, 'M');
  qr.addData('https://stfm-sales.web.app/einvoice.html?i=INV-000001&t=' + 'a'.repeat(32));
  qr.make();
  assert.ok(qr.getModuleCount() >= 21);
  assert.match(qr.createSvgTag({cellSize: 3, margin: 2, scalable: true}), /^<svg[\s\S]*<\/svg>$/);
});

// ── Sales App product picker ───────────────────────────────────────────────

function loadPicker(products) {
  const ctx = {console, document: {getElementById: () => null}, allProducts: products};
  vm.createContext(ctx);
  vm.runInContext(read('js/core.js').replace(/^"use strict";/, '') + '\n' + read('js/orders.js') +
    '\nthis.api={_ocSetItem,_ocDiscAmount,get items(){return ordItems;}};', ctx);
  return ctx.api;
}

test('picker: cartons and pieces price correctly and keep the discount when qty changes', () => {
  const p = {id: 'p1', name: 'Tea', price: 2, ctnSize: 12, ctnPrice: 22, unit: 'pcs'};
  const api = loadPicker([p]);
  let it = api._ocSetItem(p, 2, 3);
  assert.equal(it.qty, 27);
  assert.equal(it._lineTotal, 50, '2 × RM22 + 3 × RM2');
  assert.equal(it.qtyDisplay, '2ctn+3pcs');
  it.discount = api._ocDiscAmount({type: 'percent', value: 10}, it._lineTotal);
  assert.equal(it.discount.amount, 5);
  it = api._ocSetItem(p, 1, 0);
  assert.equal(it._lineTotal, 22);
  assert.equal(it.discount.amount, 2.2, 'discount recalculated on the new line value');
  assert.equal(api._ocDiscAmount({type: 'fixed', value: 99}, 22).amount, 22, 'never more than the line');
  assert.equal(api._ocDiscAmount({type: 'percent', value: 150}, 22).amount, 22);
  api._ocSetItem(p, 0, 0);
  assert.equal(api.items.length, 0, 'zero quantity removes the line');
});

// ── Owner account named super_admin ────────────────────────────────────────

test('super_admin is the owner in the rules and the Sales App, and only the owner can grant it', () => {
  const rules = read('firestore.rules');
  assert.match(rules, /function _isOwner\(u\)\s*\{ return \(u\.get\('role',''\) == 'admin' && u\.get\('isOwner', false\) == true\) \|\| u\.get\('role',''\) == 'super_admin'; \}/);
  assert.match(rules, /function _isAdminOrSub\(u\)\s*\{ return u\.get\('role',''\) in \['admin', 'sub_admin', 'super_admin'\]; \}/);
  assert.match(rules, /request\.resource\.data\.get\('role',''\) != 'super_admin'\s*&& resource\.data\.get\('role',''\) != 'super_admin'/);
  assert.match(read('js/boot.js'), /if \(CU\.role === 'super_admin'\) CU = \{ \.\.\.CU, role: 'admin', isOwner: true, erpRole: 'super_admin' \};/);
});

// ── ERP products: Sales App catalogue, light theme, Excel/CSV ─────────────

test('ERP products page reads the Sales App catalogue and offers Excel/CSV import and export', () => {
  const p = read('public/portal/index.html');
  assert.match(p, /getDocs\(collection\(_db, 'products'\)\)/, 'root catalogue is listed');
  assert.match(p, /const \[prods, inv\] = await Promise\.all\(\[_allProducts\(\)/);
  assert.match(p, /onclick="exportProducts\('xlsx'\)"/);
  assert.match(p, /accept="\.xlsx,\.csv/);
  assert.match(p, /<script defer src="\/vendor\/read-excel-file\.js"><\/script>/);
  assert.match(p, /const _xlSafe = v => \(typeof v === 'string' && \/\^\[=\+@\\t\\r\]\/\.test\(v\)\)/, 'no spreadsheet formula injection');
  assert.match(p, /<html lang="en" data-theme="light">/, 'light by default');
  assert.match(p, /localStorage\.setItem\('erp-theme', next\)/);
  const build = read('build.js');
  assert.match(build, /'node_modules\/write-excel-file\/bundle\/write-excel-file\.min\.js': 'vendor\/write-excel-file\.js'/);
});

test('picker: + only opens entry; the cart changes on "Add to cart"', () => {
  const o = read('js/orders.js');
  assert.match(o, /<button class="oc-plus" onclick="ocOpenDraft\('\$\{p\.id\}'\)"/);
  assert.match(o, /onclick="ocAddToCart\('\$\{p\.id\}'\)"/);
  assert.doesNotMatch(o, /function ocQuickAdd/, 'no one-tap add any more');
});

// ── Sales Invoice layout ──────────────────────────────────────────────────

test('sales invoice: company header, customer block, rows, totals and amount in words', () => {
  const t = require('../js/invoice-template.js');
  assert.equal(t.amountInWords(254), 'Two Hundred Fifty Four only');
  assert.equal(t.amountInWords(1012.5), 'One Thousand Twelve and Fifty Sen only');
  const rows = t.invoiceRows([{name: 'Tea', qty: 26, ctnQty: 2, pcsQty: 2, ctnSize: 12, ctnPrice: 22, price: 2, unit: 'pcs'}, {name: 'Kobis CN', qty: 2, unit: 'bag', price: 25}]);
  assert.deepEqual(rows.map(r => [r.qty, r.unit, r.total]), [[2, 'CTN', 44], [2, 'PCS', 4], [2, 'BAG', 50]]);
  const html = t.renderSalesInvoice({company: {name: 'ACME <b>', tin: 'C1'}, number: 'INV-000008', date: '2026-10-28', salesBy: 'Rakib',
    customer: {id: 'CL-1', name: 'GREEN YED', mobile: '0165109491'}, items: [{name: 'Kobis CN', qty: 2, unit: 'bag', price: 25}], total: 45, paid: 10});
  assert.match(html, /ACME &lt;b&gt;/, 'escaped');
  assert.match(html, /ST FRESH MART/, 'default branch');
  assert.match(html, /Customer Mobile:<\/strong> 0165109491/);
  assert.match(html, /<strong>Invoice No\.:<\/strong> INV-000008/);
  assert.match(html, />Discount<\/td><td[^>]*>5\.00</, 'discount = rows − total');
  assert.match(html, />Due<\/td><td[^>]*>35\.00</);
  assert.match(html, /Forty Five only/);
  assert.match(html, /Received by/);
});

test('app invoice Print / PDF / Share work inside the Android app', () => {
  const o = read('js/orders.js');
  assert.match(o, /_invPlugin\('StfmPrint'\)/, 'native print');
  assert.match(o, /_invWriteFile\('DOCUMENTS', 'STSB\/' \+ name, pdf\)/, 'PDF saved on the phone');
  assert.match(o, /sh\.share\(\{ title: name, text, files: \[uri\]/, 'PDF file to the share sheet');
  assert.doesNotMatch(o.slice(o.indexOf('async function printInvoice'), o.indexOf('// ═══════════════ MANUAL INVOICE BUILDER')), /window\.open|a\.target='_blank'/, 'no browser tabs');
  const plugin = read('android/app/src/main/java/com/sairah/stfm/PrintPlugin.java');
  assert.match(plugin, /@CapacitorPlugin\(name = "StfmPrint"\)/);
  assert.match(plugin, /createPrintDocumentAdapter/);
  assert.match(read('android/app/src/main/java/com/sairah/stfm/MainActivity.java'), /registerPlugin\(PrintPlugin\.class\);\s*super\.onCreate/);
  const pkg = JSON.parse(read('package.json'));
  assert.ok(pkg.dependencies['@capacitor/share'] && pkg.dependencies['@capacitor/filesystem']);
  assert.match(read('android/capacitor.settings.gradle'), /capacitor-share/);
  assert.match(read('build.js'), /'node_modules\/jspdf\/dist\/jspdf\.umd\.min\.js': 'vendor\/jspdf\.js'/);
});

test('logo, animated splash and faster loading', () => {
  const html = read('index.html');
  assert.doesNotMatch(html, /data:image\/[a-z]+;base64/, 'no embedded images in the app page');
  assert.match(html, /<div id="appSplash"/);
  assert.match(html, /window\._hideSplash=function/);
  assert.match(html, /getDocsFromCache: getDocsFromCache/);
  const boot = read('js/boot.js');
  assert.match(boot, /const gpsPromise = requestGPSPermission\(\);/, 'GPS check runs alongside loading');
  assert.match(boot, /const shownFromCache = await _bootLoad\('cache'\)/, 'first screen from the device cache');
  assert.match(read('js/core.js'), /const _SF_MEMO_MS = 30000;/);
  const portal = read('public/portal/index.html');
  assert.match(portal, /function getDocs\(ref\) \{\s*if \(ref && ref\.type === 'collection' && _liveSnaps\.has\(ref\.path\)\)/, 'ERP reads use live data');
  assert.match(portal, /_liveSnaps\.set\(livePath, snap\);/);
  for (const f of ['logo.png', 'favicon.png', 'icon-192.png', 'android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png']) assert.ok(read(f).length > 500, f);
  assert.equal(JSON.parse(read('capacitor.config.json')).plugins.SplashScreen.backgroundColor, '#ffffff');
});

test('sign-in page: new design, same login fields, light mode by default', () => {
  const html = read('index.html');
  const login = html.slice(html.indexOf('<div id="loginPage"'), html.indexOf('<div id="app">'));
  for (const id of ['lemail', 'lpwd', 'rememberMe', 'loginBtn']) assert.match(login, new RegExp(`id="${id}"`), id);
  assert.match(login, /class="lg-card"/);
  assert.match(login, /onclick="openForgotPassword\(\)"/);
  assert.match(login, /autocomplete="current-password"/);
  assert.match(html, /\("dark" !== localStorage\.getItem\("stfm-theme"\)\) && document\.documentElement\.setAttribute\("data-theme", "light"\)/);
});

test('outlets: every role gets a Nearby list sorted by distance', () => {
  const o = read('js/outlets.js');
  assert.match(o, /let _outletView=\(\(\)=>\{try\{return localStorage\.getItem\('stsb-outlet-view'\)\|\|'near';/, 'Nearby is the default');
  const near = o.slice(o.indexOf("if(_outletView==='near'){"), o.indexOf('// Sort helper: by distance'));
  assert.match(near, /const list=allOutlets\.filter\(/, 'all outlets the user can access, not only their own');
  assert.match(near, /sort\(\(x,y\)=>\(x\.km-y\.km\)/, 'nearest first');
  assert.match(near, /_outletLocate\(false\);/, 'gets the current position, also for admins');
  assert.match(o, /_getPositionNative\(\)\.then\(pos=>\{/);
});

// ── Owner Zone View: writes follow the zone being viewed ───────────────────

function loadCore(store, user, zoneFilter) {
  const ref = (...p) => ({ path: p.slice(1).join('/') });
  const SF = {
    db: {},
    collection: ref, doc: ref,
    addDoc: async (c, d) => { const id = 'n' + Object.keys(store).length; store[c.path + '/' + id] = { ...d }; return { id }; },
    setDoc: async (r, d) => { store[r.path] = { ...d }; },
    updateDoc: async (r, d) => { if (!store[r.path]) throw Object.assign(new Error('no doc'), { code: 'not-found' }); Object.assign(store[r.path], d); },
    deleteDoc: async (r) => { delete store[r.path]; },
    getDoc: async (r) => ({ exists: () => !!store[r.path], data: () => store[r.path] }),
  };
  const ctx = { console, window: { __SF: SF }, document: { getElementById: () => null }, invalidateCache: () => {} };
  vm.createContext(ctx);
  vm.runInContext(read('js/core.js').replace(/^"use strict";/, '') +
    `\nCU=${JSON.stringify(user)};_ownerZoneFilter=${JSON.stringify(zoneFilter)};allZones=[{id:'z1',name:'Ipoh'}];` +
    '\nthis.api={sfAdd,sfUpdate,sfDelete,setZone:z=>{_ownerZoneFilter=z;}};', ctx);
  return ctx.api;
}

test('owner in Zone View: new outlets go to that zone (mirrored to root), edits/deletes reach both copies', async () => {
  const owner = { uid: 'boss', role: 'admin', isOwner: true };
  const store = { 'outlets/o1': { name: 'A', _zoneId: 'z1' }, 'zones/z1/outlets/o1': { name: 'A' } };
  const api = loadCore(store, owner, 'z1');
  const { id } = await api.sfAdd('outlets', { name: 'New', zoneId: null });
  assert.equal(store['zones/z1/outlets/' + id].zoneId, 'z1');
  assert.equal(store['outlets/' + id]._zoneId, 'z1');
  await api.sfUpdate('outlets', id, { phone: '1' });
  assert.equal(store['zones/z1/outlets/' + id].phone, '1');
  assert.equal(store['outlets/' + id].phone, '1');
  api.setZone(null);
  await api.sfUpdate('outlets', 'o1', { phone: '2' });
  assert.equal(store['zones/z1/outlets/o1'].phone, '2', 'All Zones edit reaches the zone copy');
  await api.sfDelete('outlets', 'o1');
  assert.ok(!store['outlets/o1'] && !store['zones/z1/outlets/o1']);
  api.setZone('z1');
  const p = await api.sfAdd('products', { name: 'P' });
  assert.ok(store['products/' + p.id] && !store['zones/z1/products/' + p.id], 'catalogue stays global');
  const rep = loadCore(store, { uid: 'r', role: 'sales_rep', zoneId: 'z1' }, null);
  const r = await rep.sfAdd('outlets', { name: 'Rep shop' });
  assert.ok(store['zones/z1/outlets/' + r.id] && store['outlets/' + r.id]._zoneId === 'z1', 'zone users unchanged');
});

test('Outlets by rep: zone reps only, and outlets with no listed rep are shown, not dropped', () => {
  const js = read('js/outlets.js');
  assert.match(js, /u\.role==='sales_rep'&&u\.status!=='disabled'&&\(!isOwner\(\)\|\|!_ownerZoneFilter\|\|u\.zoneId===_ownerZoneFilter\)/);
  assert.match(js, /const orphans=allSrchOutlets\.filter\(o=>!repIds\.has\(o\.assignedRepId\)&&!repIds\.has\(o\.createdBy\)\);/);
});

test('outlet list per role: rep own, delivery man assigned, admin all', () => {
  const list = [
    { id: 'a', createdBy: 'r1' }, { id: 'b', createdBy: 'r2', assignedRepId: 'r2' },
    { id: 'c', createdBy: 'r1', assignedRepId: 'r2' }, { id: 'd', createdBy: 'adm', assignedRepId: 'r1' },
  ];
  const run = (user, orders) => {
    const ctx = { console, window: {}, document: { getElementById: () => null } };
    vm.createContext(ctx);
    vm.runInContext(read('js/core.js').replace(/^"use strict";/, '') + `\nCU=${JSON.stringify(user)};this.r=_scopeOutlets(${JSON.stringify(list)},${JSON.stringify(orders)}).map(o=>o.id).join();`, ctx);
    return ctx.r;
  };
  assert.equal(run({ uid: 'r1', role: 'sales_rep' }, []), 'a,d', 'own + assigned to me; not one reassigned away');
  assert.equal(run({ uid: 'dm', role: 'delivery_man' }, [{ outletId: 'b', deliveryManId: 'dm' }, { outletId: 'c', deliveryManId: 'x' }]), 'b');
  assert.equal(run({ uid: 'z', role: 'admin' }, []), 'a,b,c,d');
  assert.equal(run({ uid: 's', role: 'storeman' }, []), '');
  const rules = read('firestore.rules');
  assert.match(rules, /allow read:   if isSignedIn\(\) && \(_isZoneAdmin\(ud\(\), zoneId\) \|\| \(_isFieldUser\(ud\(\)\) && _inZone\(ud\(\), zoneId\)\)\);/);
  assert.match(rules, /_inZone\(ud\(\), zoneId\) && subCol != 'outlets';/);
});

test('out-of-stock products: shown, requestable, never on the charged order', () => {
  const js = read('js/orders.js');
  assert.match(js, /function _ocIsOut\(p\)\{\n  if\(p\.stockStatus==='out_of_stock'\)return true;/);
  assert.match(js, /requestedItems:ordRequests\.map\(r=>\(\{\.\.\.r\}\)\),/);
  assert.match(js, /if\(nowOut\.length\)\{showToast\(`Out of stock:/);
  assert.doesNotMatch(js, /const available=allProducts\.filter\(p=>p\.stockStatus!=='out_of_stock'\);/);
  const portal = read('public/portal/index.html');
  assert.match(portal, /window\.addRequestedToOrder = async function\(i\)/);
  assert.match(portal, /const reqHtml = await _requestedItemsHtml\(orderId, o\);/);
});
