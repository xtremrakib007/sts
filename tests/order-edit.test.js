const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const erp = require('../functions/erp-sync');

test('ERP edits flow to the app order with app-only line details kept', () => {
  const prevApp = [{pid: 'p1', name: 'Tea', sku: 'T1', price: 2, ctnPrice: 22, ctnSize: 12, qty: 24, ctnQty: 2, pcsQty: 0, _lineTotal: 44, qtyDisplay: '2ctn'}];
  const erpItems = [
    {productId: 'p1', name: 'Tea', sku: 'T1', price: 2, ctnPrice: 22, ctnSize: 12, qty: 40, ctnQty: 3, pcsQty: 4, discount: 2, total: 72},
    {productId: 'p2', name: 'Sugar', sku: 'S1', price: 5, qty: 3, ctnQty: 0, pcsQty: 3, discount: 0, total: 15},
  ];
  const before = {status: 'processing', editedAt: null, items: []};
  const after = {status: 'processing', editedAt: '2026-10-28T10:00:00Z', editedByName: 'Admin', items: erpItems, subtotal: 89, total: 87, notes: 'more tea'};
  const p = erp.appPatchFromErp(before, after, 'Confirmed', {items: prevApp});
  assert.equal(p.items.length, 2);
  assert.deepEqual([p.items[0].qty, p.items[0].ctnQty, p.items[0].pcsQty, p.items[0].ctnPrice, p.items[0]._lineTotal, p.items[0].discount.amount], [40, 3, 4, 22, 74, 2]);
  assert.equal(p.items[1].pid, 'p2');
  assert.deepEqual([p.subtotal, p.total, p.notes, p.editedByName], [89, 87, 'more tea', 'Admin']);
});

test('app line totals and ERP line totals agree on discounts both ways', () => {
  const app = {pid: 'p1', name: 'Tea', price: 2, ctnPrice: 22, ctnSize: 12, qty: 36, ctnQty: 3, pcsQty: 0, _lineTotal: 66, discount: {amount: 6}};
  const e = erp.mapItem(app);
  assert.equal(e.total, 60, 'line total is after its discount');
  assert.equal(e.ctnPrice, 22);
  const back = erp.appItemsFromErp([e], [app])[0];
  assert.deepEqual([back._lineTotal, back.discount.amount], [66, 6]);
});

test('invoice voiding clears the app invoice number', () => {
  const p = erp.appPatchFromErp({invoiceNo: 'INV-000004'}, {invoiceNo: ''}, 'Confirmed');
  assert.equal(p.invoiceNo, '');
});

test('rules: salesman edits or cancels own order only before ERP acceptance/invoice, never the discount', () => {
  const rules = read('firestore.rules');
  assert.equal(rules.split("resource.data.get('erpStatus', '') in ['', 'pending']").length - 1, 2, 'root + zone');
  assert.equal(rules.split("resource.data.get('invoiceNo', '') == ''").length - 1, 2);
  assert.doesNotMatch(rules, /hasOnly\(\['items','total','notes','updatedAt','discount'\]\)/, 'salesmen can no longer rewrite the discount');
  assert.match(rules, /request\.resource\.data\.get\('cancelledBy', ''\) == request\.auth\.uid/);
});

test('ERP order editor and app edit/cancel are wired in', () => {
  const portal = read('public/portal/index.html');
  for (const fn of ['window.editErpOrder', 'window.saveErpOrderEdit', 'window.voidInvoice', 'function _orderEditBlock(']) assert.ok(portal.includes(fn), fn);
  assert.match(portal, /Order is invoiced \(\$\{o\.invoiceNo\}\) — void the invoice first/);
  const orders = read('js/orders.js');
  for (const fn of ['async function editMyOrder(', 'async function saveMyOrderEdit(', 'async function cancelMyOrder(', 'function _appOrderEditable(']) assert.ok(orders.includes(fn), fn);
});

test('ERP edits are not overwritten by older or in-flight app events', () => {
  const edited = {_srcEventTime: '2026-10-28T10:00:00.000Z', editedAt: '2026-10-28T10:05:00.000Z'};
  assert.equal(erp.isStaleEvent(edited, '2026-10-28T10:01:00.000Z'), true, 'edit not yet copied to the app');
  const applied = {...edited, _erpEditFor: edited.editedAt, _erpEditTime: '2026-10-28T10:05:01.000Z'};
  assert.equal(erp.isStaleEvent(applied, '2026-10-28T10:03:00.000Z'), true, 'app event older than the edit');
  assert.equal(erp.isStaleEvent(applied, '2026-10-28T10:06:00.000Z'), false, 'later app changes still sync');
});
