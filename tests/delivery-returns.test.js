const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const rt = require('../functions/returns');
const ctl = require('../functions/order-controls');

const order = {
  status: 'delivered', total: 36,
  items: [{name: 'A', sku: 'A1', qty: 10, price: 2, total: 20}, {name: 'B', qty: 5, price: 4, total: 20}],
};

test('partial delivery is valued at the order total share, keeping discounts', () => {
  const items = [{qty: 10, price: 2}, {qty: 5, price: 4}];
  assert.equal(rt.deliveredTotal(items, [{qty: 5}, {qty: 5}], 36), 27);
  assert.equal(rt.deliveredTotal(items, [{qty: 10}, {qty: 5}], 36), 36);
  assert.equal(rt.deliveredTotal(items, [{qty: 99}, {qty: 0}], 40), 20, 'cannot exceed ordered qty');
});

test('returns are priced from the order net of discounts', () => {
  const r = rt.priceReturn({ret: {reason: 'expired', lines: [{line: 0, qty: 2, condition: 'resellable'}, {line: 1, qty: 1, condition: 'damaged'}]}, order});
  assert.equal(r.amount, 3.6 + 3.6);
  assert.deepEqual(r.lines.map((l) => [l.qty, l.unitPrice, l.condition]), [[2, 1.8, 'resellable'], [1, 3.6, 'damaged']]);
});

test('returns cannot exceed what was delivered or already returned', () => {
  const partial = {...order, deliveredItems: [{qty: 4}, {qty: 5}], returnedQty: {0: 3}};
  assert.match(rt.priceReturn({ret: {reason: 'x', lines: [{line: 0, qty: 2, condition: 'resellable'}]}, order: partial}).error, /only 1/);
  assert.equal(rt.priceReturn({ret: {reason: 'x', lines: [{line: 0, qty: 1, condition: 'resellable'}]}, order: partial}).amount, 1.8);
});

test('returns need a delivered order, a reason, quantities and a condition', () => {
  assert.match(rt.priceReturn({ret: {reason: 'x', lines: [{line: 0, qty: 1, condition: 'resellable'}]}, order: {...order, status: 'processing'}}).error, /delivered/);
  assert.match(rt.priceReturn({ret: {lines: [{line: 0, qty: 1, condition: 'resellable'}]}, order}).error, /reason/);
  assert.match(rt.priceReturn({ret: {reason: 'x', lines: []}, order}).error, /quantity/);
  assert.match(rt.priceReturn({ret: {reason: 'x', lines: [{line: 0, qty: 1}]}, order}).error, /resellable or damaged/);
  assert.match(rt.priceReturn({ret: {reason: 'x', lines: [{line: 7, qty: 1, condition: 'damaged'}]}, order}).error, /not on the order/);
  assert.match(rt.priceReturn({ret: {reason: 'x'}, order: null}).error, /not found/);
});

test('credit notes are numbered and reduce the outlet balance', () => {
  assert.equal(rt.creditNoteNumber(42), 'CN-000042');
  const owed = ctl.outletOutstanding({
    orders: [{id: 'A', total: 100}, {id: 'B', total: 50, deliveredTotal: 30}],
    collections: [{amount: 20}], creditNotes: [{amount: 15}], outlet: {},
  });
  assert.equal(owed, 100 + 30 - 20 - 15);
});

test('rules: returns approved by a different admin, credit notes and proofs server/once-only', () => {
  const rules = read('firestore.rules');
  const ret = rules.slice(rules.indexOf('match /stsb_returns/'), rules.indexOf('match /stsb_credit_notes/'));
  assert.match(ret, /resource\.data\.requestedBy != request\.auth\.uid/);
  assert.match(ret, /!\('amount' in request\.resource\.data\)/, 'the client cannot set the credit amount');
  assert.match(rules, /match \/stsb_credit_notes\/\{cnId\} \{\s*allow read: if isStsbERPAdmin\(\);\s*allow write: if false;/);
  const pod = rules.slice(rules.indexOf('match /deliveryProofs/'), rules.indexOf('match /audit_log/'));
  assert.match(pod, /allow update, delete: if false/);
  assert.match(pod, /deliveredBy == request\.auth\.uid/);
  for (const f of ['deliveredItems', 'deliveredTotal', 'receiverName', 'hasProof']) {
    assert.equal(rules.split(`'${f}'`).length - 1, 2, `${f} allowed on root and zone order rules`);
  }
});

test('ERP has a delivery planner, returns page and proof viewer; app completes deliveries with proof', () => {
  const portal = read('public/portal/index.html');
  for (const fn of ['async function deliveryPlanner(', 'window.plannerAction', 'async function returns(', 'window.viewDeliveryProof', 'window.printCreditNote']) {
    assert.ok(portal.includes(fn), fn);
  }
  assert.match(portal, /deliveryPlanner, returns,/);
  const deliv = read('js/deliveries.js');
  assert.match(deliv, /async function saveCompleteDelivery\(/);
  assert.match(deliv, /'deliveryProofs'/);
  assert.match(read('functions/index.js'), /after\.status === 'Delivered' && Array\.isArray\(after\.deliveredItems\) \? after\.deliveredItems/);
});

test('past-data import picks one source per order, preferring the zone copy', () => {
  const erp = require('../functions/erp-sync');
  const docs = [
    {path: 'orders/a', id: 'a', data: {id: 'ORD-A', _zoneId: 'z1', v: 'root'}, updateTime: 't2'},
    {path: 'zones/z1/orders/a', id: 'a', data: {id: 'ORD-A', v: 'zone'}, updateTime: 't1'},
    {path: 'orders/b', id: 'b', data: {id: 'ORD-B', v: 'owner'}, updateTime: 't1'},
    {path: 'portalUsers/u/orders/x', id: 'x', data: {id: 'ORD-X'}, updateTime: 't1'},
  ];
  const picked = erp.pickBackfillSources(docs, (d, id) => erp.erpOrderId(d, id));
  assert.deepEqual(picked.map((p) => [p.key, p.data.v, p.zoneId]).sort(), [['ORD-A', 'zone', 'z1'], ['ORD-B', 'owner', null]]);
});

test('ERP: full order view, invoicing, printable invoice, products page and past-data import', () => {
  const portal = read('public/portal/index.html');
  for (const fn of ['window.viewErpOrder', 'window.createInvoiceFromOrder', 'window.printInvoice', 'async function erpProducts(', 'window.startBackfill']) {
    assert.ok(portal.includes(fn), fn);
  }
  assert.match(portal, /runTransaction\(_db/, 'invoice numbers come from a transaction');
  assert.doesNotMatch(portal, /'INV-' \+ String\(count\+1\)/, 'no count-based invoice numbers');
  assert.match(portal, /data-page="products" onclick="goPage\('products'\)"><span class="ico">🛍️<\/span> Products<\/div>\s*<div class="sb-item" data-page="inventory"/);
  assert.match(read('functions/index.js'), /exports\.erpBackfill = /);
});
