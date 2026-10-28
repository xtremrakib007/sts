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
  assert.match(p, /Need an LHDN e-Invoice\?/);
  assert.match(p, /<script src="\/vendor\/qrcode\.js"><\/script>/);
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
  assert.match(p, /<script src="\/vendor\/read-excel-file\.js"><\/script>/);
  assert.match(p, /const _xlSafe = v => \(typeof v === 'string' && \/\^\[=\+@\\t\\r\]\/\.test\(v\)\)/, 'no spreadsheet formula injection');
  assert.match(p, /<html lang="en" data-theme="light">/, 'light by default');
  assert.match(p, /localStorage\.setItem\('erp-theme', next\)/);
  const build = read('build.js');
  assert.match(build, /'node_modules\/write-excel-file\/bundle\/write-excel-file\.min\.js': 'vendor\/write-excel-file\.js'/);
});
