const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const P = require('../js/price-floor.js');

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

// 2 cartons of 12 at RM 100 + 6 pcs at RM 9 = 254 for 30 pcs
const line = (extra = {}) => ({ pid: 'p1', name: 'Milo 1kg', price: 9, ctnPrice: 100, ctnSize: 12, ctnQty: 2, pcsQty: 6, qty: 30, _lineTotal: 254, ...extra });

test('net price per pcs counts cartons, loose pcs and the line discount', () => {
  assert.equal(P.lineGross(line()), 254);
  assert.equal(P.linePcs(line()), 30);
  assert.equal(P.netUnitPrice(line()), 8.47);
  assert.equal(P.netUnitPrice(line({ discount: { type: 'amount', value: 14, amount: 14 } })), 8);
  assert.equal(P.netUnitPrice(line({ discount: { amount: 14 } }), false), 8.47);
  assert.equal(P.netUnitPrice({ pid: 'x', price: 5, qty: 0 }), null);
  // older lines without _lineTotal
  assert.equal(P.netUnitPrice({ pid: 'x', price: 4, qty: 10 }), 4);
  assert.equal(P.netUnitPrice({ pid: 'x', price: 4, ctnPrice: 40, ctnSize: 12, ctnQty: 1, pcsQty: 0 }), 3.33);
});

test('items below the minimum are flagged; no minimum, no flag', () => {
  const items = [line({ discount: { amount: 30 } }), { pid: 'p2', name: 'Sugar', price: 3, qty: 10, _lineTotal: 30 }];
  const r = P.priceCheck(items, { p1: 8, p2: 2.5 }, {});
  assert.deepEqual(r.lines.map((l) => [l.pid, l.netPrice, l.minPrice, l.belowMin]), [['p1', 7.47, 8, true], ['p2', 3, 2.5, false]]);
  assert.equal(r.belowMin.length, 1);
  assert.equal(P.priceCheck(items, {}, {}).belowMin.length, 0);
  // exactly at the minimum is fine
  assert.equal(P.priceCheck([{ pid: 'p2', price: 3, qty: 10, _lineTotal: 30, discount: { amount: 5 } }], { p2: 2.5 }, {}).belowMin.length, 0);
});

test('last price: the outlet\'s latest earlier order, approved discounts only, cancelled skipped', () => {
  const orders = [
    { id: 'A', status: 'Delivered', createdAt: { seconds: 100 }, items: [{ pid: 'p1', price: 9, qty: 10, _lineTotal: 90 }] },
    { id: 'B', status: 'Delivered', createdAt: { seconds: 200 }, discount: { status: 'approved' }, items: [{ pid: 'p1', price: 9, qty: 10, _lineTotal: 90, discount: { amount: 5 } }] },
    { id: 'C', status: 'Cancelled', createdAt: { seconds: 300 }, items: [{ pid: 'p1', price: 1, qty: 10, _lineTotal: 10 }] },
    { id: 'D', status: 'Confirmed', createdAt: { seconds: 400 }, discount: { status: 'rejected' }, items: [{ pid: 'p2', price: 3, qty: 2, _lineTotal: 6, discount: { amount: 2 } }] },
    { id: 'NOW', status: 'Pending', createdAt: { seconds: 500 }, items: [{ pid: 'p1', price: 9, qty: 1, _lineTotal: 9 }] },
  ];
  const last = P.lastPrices(orders, 'NOW');
  assert.deepEqual(last.p1, { price: 8.5, orderId: 'B', date: '' });
  assert.equal(last.p2.price, 3);
  const chk = P.priceCheck([{ pid: 'p1', price: 9, qty: 1, _lineTotal: 9 }], {}, last);
  assert.equal(chk.lines[0].lastPrice, 8.5);
});

test('a typed minimum: empty or 0 clears it; negative or text is refused', () => {
  assert.equal(P.parseMinPrice(''), null);
  assert.equal(P.parseMinPrice('0'), null);
  assert.equal(P.parseMinPrice('7.255'), 7.26);
  assert.throws(() => P.parseMinPrice('-1'), /positive/);
  assert.throws(() => P.parseMinPrice('abc'), /positive/);
});

test('minimum prices are readable and writable only by admins and sub-admins', () => {
  const rules = read('firestore.rules');
  const m = rules.match(/match \/productMinPrices\/\{productId\} \{([\s\S]*?)\n    \}/);
  assert.ok(m, 'productMinPrices rule exists');
  assert.match(m[1], /allow read, write: if isSignedIn\(\) && _isAdminOrSub\(ud\(\)\);/);
  assert.doesNotMatch(m[1], /_isSalesRep|_isFieldUser|isPortalUser/);
  // Not stored on the product, which salesmen and the shop can read.
  assert.doesNotMatch(read('js/products.js'), /data\s*=\s*\{[^}]*minPrice/);
});

test('the app loads it only for admins and shows it in the approval dialog', () => {
  const products = read('js/products.js');
  assert.match(products, /async function loadMinPrices[\s\S]*?if\(!isAdmin\(\)\)return \{\};/);
  assert.match(products, /rootDocRef\('productMinPrices',pid\)/);
  const orders = read('js/orders.js');
  assert.match(orders, /const priceInfo=approve\?await _discountPriceSummary\(o\):'';/);
  assert.match(orders, /BELOW MINIMUM PRICE/);
  assert.match(read('build.js'), /'js\/price-floor\.js'/);
  assert.match(read('index.html'), /<script src="js\/price-floor\.js"><\/script>/);
});
