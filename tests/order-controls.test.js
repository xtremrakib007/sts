const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const ctl = require('../functions/order-controls');
const erp = require('../functions/erp-sync');

const index = ctl.inventoryIndex([
  {id: 'inv-tea', sku: 'T1', name: 'Tea'},
  {id: 'inv-sugar', name: 'Sugar 1kg'},
]);

test('order lines match inventory by SKU, then by name, case-insensitively', () => {
  const {lines, unmatched} = ctl.orderStockLines([
    {sku: 't1', name: 'Tea Box', qty: 10},
    {name: 'SUGAR 1KG ', qty: 4},
    {name: 'Tea', sku: '', qty: 2},
    {name: 'Ghost', qty: 1},
    {name: 'Tea', qty: 0},
  ], index);
  assert.deepEqual(lines, {'inv-tea': 12, 'inv-sugar': 4});
  assert.deepEqual(unmatched, ['Ghost']);
});

test('stock follows the order lifecycle: reserve → deduct, or reserve → release', () => {
  const lines = {'inv-tea': 10};
  let led = {};
  const step = (status, l = lines) => {
    const desired = ctl.desiredStock(status, l, led);
    const deltas = ctl.stockDeltas(led, desired);
    led = desired;
    return deltas;
  };
  assert.deepEqual(step('Confirmed'), {'inv-tea': {reserved: 10, qty: 0}});
  assert.deepEqual(step('Assigned'), {}, 'no double reservation');
  assert.deepEqual(step('In Transit', {'inv-tea': 8}), {'inv-tea': {reserved: -2, qty: 0}}, 'item edit moves only the difference');
  assert.deepEqual(step('Delivered', {'inv-tea': 8}), {'inv-tea': {reserved: -8, qty: -8}});
  assert.deepEqual(step('Delivered', {'inv-tea': 8}), {}, 'retry does not deduct twice');
  assert.deepEqual(step('Cancelled', {'inv-tea': 8}), {}, 'delivered goods are not restocked by a status change');

  led = {};
  step('Pending');
  assert.deepEqual(step('Cancelled'), {'inv-tea': {reserved: -10, qty: 0}});
  led = {};
  step('Confirmed');
  assert.deepEqual(step(null), {'inv-tea': {reserved: -10, qty: 0}}, 'deleting an order releases its reservation');
});

test('failed deliveries keep their reservation for redelivery', () => {
  const led = ctl.desiredStock('Confirmed', {'inv-tea': 5}, {});
  assert.deepEqual(ctl.stockDeltas(led, ctl.desiredStock('Failed', {'inv-tea': 5}, led)), {});
});

test('outstanding balance matches the collection screen formula', () => {
  const outstanding = ctl.outletOutstanding({
    orders: [{id: 'A', total: 300}, {id: 'B', total: 200, status: 'Cancelled'}, {id: 'NEW', total: 999}],
    collections: [{amount: 100}, {amount: '50'}],
    outlet: {balanceStatus: 'approved', openingBalance: 40},
    excludeOrderId: 'NEW',
  });
  assert.equal(outstanding, 190);
  assert.equal(ctl.outletOutstanding({orders: [], collections: [{amount: 10}], outlet: {}}), 0);
});

test('credit limit holds only credit outlets that would go over the limit', () => {
  const outlet = {paymentType: 'credit', creditLimit: 1000};
  assert.equal(ctl.creditCheck({outlet, outstanding: 600, orderTotal: 400}), null, 'exactly at limit is allowed');
  const hold = ctl.creditCheck({outlet, outstanding: 600, orderTotal: 450.5});
  assert.deepEqual(hold, {status: 'pending', limit: 1000, outstanding: 600, orderTotal: 450.5, exceededBy: 50.5});
  assert.equal(ctl.creditCheck({outlet: {paymentType: 'cash', creditLimit: 10}, outstanding: 50, orderTotal: 50}), null);
  assert.equal(ctl.creditCheck({outlet: {paymentType: 'credit', creditLimit: 0}, outstanding: 50, orderTotal: 50}), null);
});

test('credit-held orders stay out of the ERP until approved', () => {
  assert.equal(erp.isHeldFromErp({status: 'Pending', creditHold: {status: 'pending'}}), true);
  assert.equal(erp.isHeldFromErp({status: 'Confirmed', creditHold: {status: 'approved'}}), false);
  assert.equal(ctl.isCreditHeld({creditHold: {status: 'pending'}}), true);
});

test('stock write-backs never retrigger the ERP sync', () => {
  const o = {status: 'Delivered', total: 5};
  assert.equal(erp.onlySyncMetaChanged(o, {...o, stockDeducted: true, stockDeductedAt: 't', stockUnmatched: []}), true);
});

test('client no longer writes stock; admins can approve credit holds', () => {
  for (const f of ['js/orders.js', 'js/deliveries.js']) {
    assert.doesNotMatch(read(f), /_reserveStock|erpCol\('inventory'\),\s*stock/, f);
  }
  const orders = read('js/orders.js');
  assert.match(orders, /async function approveCredit\(/);
  assert.match(orders, /creditHold:creditHold\?/);
});
