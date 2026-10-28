const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const erp = require('../functions/erp-sync');

const NOW = '2026-10-28T10:00:00.000Z';
const order = (over = {}) => ({
  id: 'ORD-ABC', outletId: 'o1', status: 'Confirmed', date: '2026-10-28',
  createdBy: 'rep1', createdByName: 'Rep One', notes: 'n',
  items: [{pid: 'p1', name: 'Tea', sku: 'T1', qty: 10, price: 2, discount: {amount: 3}}],
  subtotal: 20, total: 20, discount: null, erpHeld: false,
  ...over,
});

test('new confirmed order maps to a pending ERP order with lines and outlet', () => {
  const p = erp.buildErpOrder({
    order: order(), erpCurrent: null, docId: 'doc1', zoneId: 'z1',
    outlet: {name: 'Kedai A', address: 'Jalan 1', phone: '012', route: 'R1'}, nowIso: NOW,
  });
  assert.equal(p.orderId, 'ORD-ABC');
  assert.equal(p.customer, 'Kedai A');
  assert.equal(p.repId, 'rep1');
  assert.equal(p.zone, 'z1');
  assert.equal(p.status, 'pending');
  assert.equal(p.deliveryStatus, 'pending');
  assert.equal(p.collectionStatus, 'not_required');
  assert.equal(p.createdAt, NOW);
  assert.deepEqual(p.items[0], {
    productId: 'p1', name: 'Tea', sku: 'T1', qty: 10, ctnQty: 0, pcsQty: 0, ctnSize: 0,
    unit: 'pcs', price: 2, discount: 3, total: 17,
  });
  assert.ok(!Object.values(p).includes(undefined));
});

test('manual invoice is flagged and keeps its own line totals', () => {
  const p = erp.buildErpOrder({
    order: order({id: 'INV-1', type: 'manual_invoice', items: [{pid: 'p1', name: 'Tea', qty: 2, price: 5, _lineTotal: 9}]}),
    erpCurrent: null, docId: 'd', zoneId: null, outlet: {}, nowIso: NOW,
  });
  assert.equal(p.isInvoice, true);
  assert.equal(p.invoiceNo, 'INV-1');
  assert.equal(p.items[0].total, 9);
});

test('delivery status changes reach ERP; unrelated edits do not clobber ERP status', () => {
  const inTransit = erp.buildErpOrder({
    order: order({status: 'In Transit', inTransitAt: NOW}),
    erpCurrent: {appStatus: 'Assigned', status: 'processing'}, docId: 'd', outlet: {}, nowIso: NOW,
  });
  assert.equal(inTransit.deliveryStatus, 'in_transit');
  assert.equal(inTransit.status, undefined, 'ERP-owned status untouched');
  assert.equal(inTransit.createdAt, undefined);

  const delivered = erp.buildErpOrder({
    order: order({status: 'Delivered', deliveredBy: 'dm1'}),
    erpCurrent: {appStatus: 'In Transit'}, docId: 'd', outlet: {}, nowIso: NOW,
  });
  assert.equal(delivered.status, 'delivered');
  assert.equal(delivered.deliveryStatus, 'delivered');
  assert.equal(delivered.deliveredBy, 'dm1');

  const notesOnly = erp.buildErpOrder({
    order: order({notes: 'changed'}),
    erpCurrent: {appStatus: 'Confirmed', status: 'processing'}, docId: 'd', outlet: {}, nowIso: NOW,
  });
  assert.equal(notesOnly.status, undefined);
  assert.equal(notesOnly.notes, 'changed');

  const failed = erp.buildErpOrder({
    order: order({status: 'Failed', failReason: 'closed'}),
    erpCurrent: {appStatus: 'In Transit'}, docId: 'd', outlet: {}, nowIso: NOW,
  });
  assert.equal(failed.deliveryStatus, 'failed');
  assert.equal(failed.failureReason, 'closed');

  const cancelled = erp.buildErpOrder({
    order: order({status: 'Cancelled'}), erpCurrent: {appStatus: 'Confirmed'}, docId: 'd', outlet: {}, nowIso: NOW,
  });
  assert.equal(cancelled.status, 'cancelled');
});

test('approved discount is applied, pending discount orders stay held', () => {
  assert.equal(erp.isHeldFromErp(order({status: 'Pending', erpHeld: true, discount: {status: 'pending', amount: 5}})), true);
  assert.equal(erp.isHeldFromErp(order()), false);
  const p = erp.buildErpOrder({
    order: order({total: 15, discount: {status: 'approved', amount: 5}}),
    erpCurrent: null, docId: 'd', outlet: {}, nowIso: NOW,
  });
  assert.equal(p.discount, 5);
  assert.equal(p.discountStatus, 'approved');
  assert.equal(p.total, 15);
});

test('loop guards ignore sync metadata and ERP back-sync writes', () => {
  const a = order();
  assert.equal(erp.onlySyncMetaChanged(a, {...a, erpSynced: true, erpSyncedAt: NOW}), true);
  assert.equal(erp.onlySyncMetaChanged(a, {...a, status: 'Delivered'}), false);
  assert.equal(erp.isErpOriginatedWrite({...a, _syncedFromERP: true, _syncedAt: 1}, {...a, _syncedFromERP: true, _syncedAt: 2}), true);
  // Flag left over from an earlier ERP write must not block a later app edit.
  assert.equal(erp.isErpOriginatedWrite({...a, _syncedFromERP: true, _syncedAt: 1}, {...a, _syncedFromERP: true, _syncedAt: 1, notes: 'x'}), false);
});

test('stale or retried events never overwrite newer ERP state', () => {
  assert.equal(erp.isStaleEvent(null, NOW), false);
  assert.equal(erp.isStaleEvent({_srcEventTime: '2026-10-28T10:00:01.000Z'}, NOW), true);
  assert.equal(erp.isStaleEvent({_srcEventTime: '2026-10-28T09:59:59.000Z'}, NOW), false);
});

test('collections map to ERP payment records; deletions are flagged, not erased', () => {
  const c = erp.buildErpCollection({
    collection: {id: 'COL-1', outletId: 'o1', amount: '50.5', mode: 'Cash', createdBy: 'rep1', createdByName: 'Rep', _zoneId: 'z2'},
    docId: 'c1', zoneId: null, outlet: {name: 'Kedai A'}, nowIso: NOW,
  });
  assert.equal(c.amount, 50.5);
  assert.equal(c.zone, 'z2');
  assert.equal(c.customer, 'Kedai A');
  assert.equal(c.method, 'Cash');
  assert.equal(c.submittedBy, 'rep1');
  assert.equal(c.status, 'pending_erp', 'new app collections wait for ERP acceptance');
  const edited = erp.buildErpCollection({
    collection: {id: 'COL-1', amount: 60}, erpCurrent: {status: 'accepted'}, docId: 'c1', outlet: {}, nowIso: NOW,
  });
  assert.equal(edited.status, undefined, 'ERP acceptance is not reset by an app edit');
  assert.equal(edited.createdAt, undefined);
  assert.deepEqual(erp.deletionPatch('order', NOW).status, 'cancelled');
  assert.deepEqual(erp.deletionPatch('collection', NOW).status, 'void');
});

test('server bridge listens to root and zone orders and collections', () => {
  const src = read('functions/index.js');
  for (const p of ["'orders/{orderId}'", "'zones/{zoneId}/orders/{orderId}'", "'collections/{docId}'", "'zones/{zoneId}/collections/{docId}'"]) {
    assert.match(src, new RegExp(`document\\(${p.replace(/[{}/]/g, '\\$&')}\\)\\s*\\n\\s*\\.onWrite`), p);
  }
});

test('client no longer writes ERP orders directly', () => {
  const orders = read('js/orders.js');
  assert.doesNotMatch(orders, /_syncOrderToERP|_updateERPOrderStatus/);
  assert.doesNotMatch(orders, /erpCol\('orders'\)/);
  assert.doesNotMatch(read('js/deliveries.js'), /_updateERPOrderStatus/);
});

test('app refreshes order views live and stops listening on logout', () => {
  assert.match(read('js/boot.js'), /startOrdersLiveListener\(\)/);
  assert.match(read('js/auth.js'), /stopOrdersLiveListener\(\)/);
});

test('zone delivery staff may write the same delivery fields the app sends', () => {
  const rules = read('firestore.rules');
  const start = rules.indexOf('match /zones/{zoneId} {');
  const block = rules.slice(rules.indexOf('match /orders/{orderId} {', start), rules.indexOf('match /outlets/{outletId} {', start));
  for (const f of ['inTransitAt', 'inTransitBy', 'deliveredBy', 'failureReason', 'failedAt', 'failedBy']) {
    assert.match(block, new RegExp(`'${f}'`), f);
  }
});

test('the two Functions sources deploy as separate codebases', () => {
  const rootCodebase = JSON.parse(read('firebase.json')).functions[0].codebase;
  const erpCodebase = JSON.parse(read('STSB-ERP/firebase.json')).functions[0].codebase;
  assert.notEqual(rootCodebase, erpCodebase);
});

test('ERP delivery, dispatch, cancel and driver assignment flow back to the app order', () => {
  const base = {status: 'pending', deliveryStatus: 'pending'};
  assert.equal(erp.appPatchFromErp(base, {...base, status: 'dispatched'}, 'Confirmed').status, 'In Transit');
  const d = erp.appPatchFromErp({...base, status: 'dispatched'}, {status: 'delivered', deliveryStatus: 'delivered'}, 'In Transit');
  assert.equal(d.status, 'Delivered');
  assert.ok(d.deliveredAt);
  assert.equal(erp.appPatchFromErp(base, {...base, status: 'cancelled'}, 'Confirmed').status, 'Cancelled');
  const a = erp.appPatchFromErp(base, {...base, deliveryManId: 'dm1', deliveryManName: 'Ali'}, 'Confirmed');
  assert.deepEqual([a.status, a.deliveryManId, a.deliveryManName], ['Assigned', 'dm1', 'Ali']);
  // ERP acceptance shows on the app order without changing its status.
  assert.deepEqual(erp.appPatchFromErp(base, {...base, status: 'processing'}, 'Confirmed'), {erpStatus: 'processing'});
  // Finished app orders and ERP-only fields are left alone.
  assert.equal(erp.appPatchFromErp(base, {...base, status: 'cancelled'}, 'Delivered'), null);
  assert.equal(erp.appPatchFromErp(base, {...base, collectionStatus: 'collection_accepted'}, 'Confirmed'), null);
});

test('ERP records written by the bridge are not echoed back to the app', () => {
  assert.equal(erp.isBridgeWrite({_srcEventTime: 'a'}, {_srcEventTime: 'b'}), true);
  assert.equal(erp.isBridgeWrite({_srcEventTime: 'a'}, {_srcEventTime: 'a', status: 'delivered'}), false);
  assert.match(read('functions/index.js'), /document\(`\$\{erp\.erpCol\('orders'\)\}\/\{orderId\}`\)\s*\n\s*\.onUpdate/);
});

test('ERP failed deliveries, reschedules and delivery dates reach the app', () => {
  const base = {status: 'dispatched', deliveryStatus: 'in_transit', deliveryManId: 'dm1'};
  const f = erp.appPatchFromErp(base, {...base, deliveryStatus: 'failed', failureReason: 'Shop closed'}, 'In Transit');
  assert.deepEqual([f.status, f.failureReason], ['Failed', 'Shop closed']);
  const r = erp.appPatchFromErp({...base, deliveryStatus: 'failed'},
      {...base, status: 'processing', deliveryStatus: 'rescheduled', deliveryDate: '2026-11-02'}, 'Failed');
  assert.deepEqual([r.status, r.deliveryDate, r.failureReason], ['Assigned', '2026-11-02', '']);
  const d = erp.appPatchFromErp({status: 'processing'}, {status: 'processing', deliveryDate: '2026-11-03'}, 'Confirmed');
  assert.deepEqual(d, {deliveryDate: '2026-11-03', erpStatus: 'processing'});
});

test('partial deliveries reach the ERP with delivered quantities and value', () => {
  const p = erp.buildErpOrder({
    order: {id: 'O', status: 'Delivered', partial: true, total: 36, deliveredTotal: 27,
      items: [{name: 'A', qty: 10, price: 2}], deliveredItems: [{name: 'A', qty: 5, price: 2}],
      receiverName: 'Ali', hasProof: true, deliveryOutcome: 'partial'},
    erpCurrent: {appStatus: 'In Transit'}, docId: 'd', outlet: {}, nowIso: '2026-10-28T00:00:00Z',
  });
  assert.equal(p.status, 'delivered');
  assert.equal(p.deliveryStatus, 'partially_delivered');
  assert.equal(p.deliveredTotal, 27);
  assert.equal(p.deliveredItems[0].qty, 5);
  assert.equal(p.receiverName, 'Ali');
});
