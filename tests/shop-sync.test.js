const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const S = require('../functions/shop-sync');
const ctl = require('../functions/order-controls');
const erp = require('../functions/erp-sync');

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const inv = (list) => ({index: ctl.inventoryIndex(list), byId: Object.fromEntries(list.map((v) => [v.id, v]))});

test('shop SKU: upper-case, shop-safe, ERP-<id> when the product has none', () => {
  assert.equal(S.shopSku({id: 'p1', sku: 'tea-01'}), 'TEA-01');
  assert.equal(S.shopSku({id: 'p1', sku: ' Milo 1kg '}), 'MILO-1KG');
  assert.equal(S.shopSku({id: 'aBc9', sku: ''}), 'ERP-ABC9');
  assert.match(S.shopSku({id: 'x', sku: 'a/b c#'}), /^[A-Z0-9._-]+$/);
});

test('price is the Sales App price plus markup, rounded to sen', () => {
  assert.equal(S.shopPrice(10, 0), 10);
  assert.equal(S.shopPrice(10, 15), 11.5);
  assert.equal(S.shopPrice(3.33, 10), 3.66);
  assert.equal(S.shopPrice(-5, 10), 0);
  assert.equal(S.shopPrice(10, -20), 10, 'no negative markup');
});

test('stock: ERP on hand less reserved, whole pieces; out of stock is 0', () => {
  const i = inv([{id: 'i1', sku: 'TEA-01', name: 'Tea', qty: 50, reservedQty: 12.5}, {id: 'i2', name: 'Kopi', qty: 3, reservedQty: 9}]);
  assert.equal(S.availableStock({sku: 'tea-01', name: 'x'}, i.index, i.byId), 37);
  assert.equal(S.availableStock({sku: '', name: 'kopi'}, i.index, i.byId), 0, 'over-reserved never goes negative');
  assert.equal(S.availableStock({sku: 'TEA-01', stockStatus: 'out_of_stock'}, i.index, i.byId), 0);
  assert.equal(S.availableStock({sku: 'NONE', name: 'none', stockQty: 7}, i.index, i.byId), 7, 'no ERP stock record: the product stock qty');
});

test('shop product: ERP fields only, hidden without a price, unchanged → no write', () => {
  const p = {id: 'p1', sku: 'tea-01', name: 'Tea', category: 'Drinks', unit: 'pcs', price: 10, photo: 'data:image/jpeg;base64,xx', description: 'Nice'};
  const doc = S.shopProduct(p, 5, {markupPct: 20}, '2026-10-30T00:00:00Z');
  assert.deepEqual({...doc, erpSyncedAt: 0}, {
    sku: 'TEA-01', name: 'Tea', description: 'Nice', category: 'Drinks', unit: 'PCS', imageUrl: 'data:image/jpeg;base64,xx',
    retailPrice: 12, stock: 5, status: 'active', erpManaged: true, erpProductId: 'p1', erpSku: 'tea-01', erpSyncedAt: 0,
  });
  for (const k of ['promoPrice', 'priceSlabs', 'staffPrice', 'purchasePrice']) assert.ok(!(k in doc), `${k} stays the shop's own`);
  assert.equal(S.shopProduct({...p, price: 0}, 5, {markupPct: 0}, '').status, 'hidden');
  const later = S.shopProduct(p, 5, {markupPct: 20}, '2026-10-31T00:00:00Z');
  assert.ok(S.sameShopProduct({...doc, promoPrice: 9}, later), 'only the sync time differs');
  assert.ok(!S.sameShopProduct(doc, S.shopProduct(p, 4, {markupPct: 20}, '')));
  assert.ok(!S.sameShopProduct(null, doc));
  assert.deepEqual(S.removedShopProduct('t'), {status: 'hidden', stock: 0, erpSyncedAt: 't'});
});

test('shop orders not yet in the ERP still hold their stock', () => {
  const held = S.pendingShopReservations([
    {status: 'Pending', stockReserved: true, items: [{sku: 'tea-01', qty: 2}, {sku: 'KOPI', qty: 1}]},
    {status: 'Pending', stockReserved: true, items: [{sku: 'TEA-01', qty: 3}]},
    {status: 'Accepted', stockReserved: true, erpOrderId: 'WEB-1', items: [{sku: 'TEA-01', qty: 50}]},
    {status: 'Cancelled', stockReserved: true, items: [{sku: 'TEA-01', qty: 50}]},
    {status: 'Pending', stockReserved: false, items: [{sku: 'TEA-01', qty: 50}]},
  ]);
  assert.deepEqual(held, {'TEA-01': 5, 'KOPI': 1});
});

test('import: only new, not imported, not cancelled, link and orders switched on', () => {
  const cfg = {enabled: true, ordersEnabled: true, ordersSince: '2026-10-30T00:00:00Z'};
  const o = {status: 'Pending', items: [{sku: 'A', qty: 1}], createdAt: '2026-10-30T05:00:00Z'};
  assert.ok(S.shouldImport(o, cfg));
  assert.ok(S.shouldImport({...o, createdAt: {toMillis: () => Date.parse('2026-10-31T00:00:00Z')}}, cfg));
  assert.ok(!S.shouldImport({...o, createdAt: '2026-10-29T23:00:00Z'}, cfg), 'placed before the link was on');
  assert.ok(!S.shouldImport({...o, erpOrderId: 'WEB-1'}, cfg));
  assert.ok(!S.shouldImport({...o, status: 'Cancelled'}, cfg));
  assert.ok(!S.shouldImport({...o, items: []}, cfg));
  assert.ok(!S.shouldImport(o, {...cfg, enabled: false}));
  assert.ok(!S.shouldImport(o, {...cfg, ordersEnabled: false}));
});

test('a shop order becomes a confirmed Sales App order the ERP stock check can match', () => {
  const order = {
    customer: {name: 'Aina', phone: '0123', company: ''}, method: 'STANDARD DELIVERY',
    delivery: {address: '1 Jalan A', city: 'Ipoh', state: 'Perak', postcode: '30000', date: '2026-11-01', instructions: 'Gate 2'},
    items: [{sku: 'TEA-01', name: 'Tea (shop)', unit: 'PCS', qty: 3, price: 12}, {sku: 'ERP-P2', name: 'Kopi', qty: 1, price: 5}],
    total: 41, createdAt: '2026-10-30T20:00:00Z',
  };
  const a = S.appOrderFromShop({shopOrderId: 'abcdefghijklmnop', order, nowMs: Date.parse('2026-10-30T20:01:00Z'), shopProducts: {
    'TEA-01': {erpProductId: 'p1', erpSku: 'tea-01', name: 'Tea', erpManaged: true},
    'ERP-P2': {erpProductId: 'p2', erpSku: '', name: 'Kopi', erpManaged: true},
  }});
  assert.equal(a.id, 'WEB-ABCDEFGHIJ');
  assert.equal(a.source, 'shop');
  assert.equal(a.status, 'Confirmed');
  assert.equal(a.outletId, '');
  assert.equal(a.outletName, '🛒 Aina');
  assert.equal(a.date, '2026-10-31', 'Malaysia date');
  assert.equal(a.deliveryAddress, '1 Jalan A, Ipoh, 30000, Perak');
  assert.equal(a.total, 41);
  assert.match(a.notes, /Gate 2/);
  assert.ok(!('deliveryDate' in a) || a.deliveryDate === '2026-11-01');
  assert.deepEqual(a.items.map((it) => [it.pid, it.sku, it.name, it.qty, it._lineTotal]), [['p1', 'tea-01', 'Tea', 3, 36], ['p2', '', 'Kopi', 1, 5]]);
  // The ERP's stock lines match by its own SKU / name.
  const i = ctl.inventoryIndex([{id: 'i1', sku: 'tea-01', name: 'Tea'}, {id: 'i2', name: 'Kopi'}]);
  assert.deepEqual(ctl.orderStockLines(a.items, i), {lines: {i1: 3, i2: 1}, unmatched: []});
  // …and the ERP record carries the customer.
  const e = erp.buildErpOrder({order: a, docId: 'shop_abcdefghijklmnop', zoneId: null, outlet: {}, nowIso: 'now'});
  assert.equal(e.customer, '🛒 Aina');
  assert.equal(e.outletAddress, '1 Jalan A, Ipoh, 30000, Perak');
  assert.equal(e.outletPhone, '0123');
  assert.equal(e.source, 'online_shop');
  assert.equal(e.shopOrderId, 'abcdefghijklmnop');
  assert.ok(!Object.values(a).includes(undefined), 'Firestore-safe');
  const pickup = S.appOrderFromShop({shopOrderId: 'x', order: {...order, method: 'SELF PICKUP', delivery: {collector: 'Ali', date: '2026-11-01', time: '10:00'}}, nowMs: 0});
  assert.equal(pickup.deliveryAddress, 'Self pickup');
  assert.match(pickup.notes, /Pickup by Ali/);
});

test('status goes back to the shop in its own steps', () => {
  assert.equal(S.shopStatusPatch({status: 'Confirmed'}, {status: 'Accepted'}), null);
  assert.deepEqual(S.shopStatusPatch({status: 'Assigned'}, {status: 'Accepted'}), {status: 'Preparing', erpStatus: 'Assigned'});
  assert.equal(S.shopStatusPatch({status: 'In Transit'}, {status: 'Preparing'}).status, 'Out For Delivery');
  const d = S.shopStatusPatch({status: 'Delivered', deliveredItems: [{name: 'Tea', sku: 't', qty: 2, price: 1}], deliveredTotal: 24}, {status: 'Out For Delivery'});
  assert.deepEqual(d, {status: 'Delivered', erpStatus: 'Delivered', deliveredItems: [{name: 'Tea', sku: 't', qty: 2}], deliveredTotal: 24});
  assert.equal(S.shopStatusPatch({status: 'Cancelled'}, {status: 'Accepted'}).cancellationReason, 'Cancelled by the store');
  assert.match(S.shopStatusPatch({status: 'Failed', failureReason: 'Shop closed'}, {status: 'Out For Delivery'}).erpNote, /Shop closed/);
  assert.equal(S.shopStatusPatch({status: 'Weird'}, {status: 'Accepted'}), null);
});

test('functions: wired to products, stock, settings and orders; no key stored', () => {
  const idx = read('functions/index.js');
  for (const f of ['shopPullOrders', 'shopSyncHourly', 'shopSyncConfig', 'shopSyncProduct', 'shopSyncStock', 'shopOrderStatus']) {
    assert.match(idx, new RegExp(`exports\\.${f}\\b`), f);
  }
  assert.match(idx, /initializeApp\(\{ projectId \}, name\)/, 'second app uses this project\'s own service account');
  assert.doesNotMatch(idx, /private_key|credential\.cert/);
  assert.match(idx, /doc\(`orders\/shop_\$\{d\.id\}`\)[\s\S]*\.create\(/, 'fixed app order id, create-only (idempotent)');
});

test('ERP settings card for the shop link', () => {
  const html = read('public/portal/index.html');
  assert.match(html, /loadShopSync/);
  assert.match(html, /doc\(_db, C\('config'\), 'shopSync'\)/);
  assert.match(html, /shopMarkup/);
});
