const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const sl = require('../functions/stock-ledger');

const NOW = '2026-10-28T10:00:00.000Z';
const item = {name: 'Tea', sku: 'T1', qty: 100, avgCost: 2, minStock: 20};

test('requests are validated before posting', () => {
  assert.equal(sl.validateRequest({type: 'receipt', invId: 'i', qty: 5}), null);
  assert.match(sl.validateRequest({type: 'sale', invId: 'i', qty: 5}), /Unknown/, 'sales are system-only');
  assert.match(sl.validateRequest({type: 'receipt', invId: 'i', qty: 0}), /more than zero/);
  assert.match(sl.validateRequest({type: 'damage', invId: 'i', qty: 1}), /reason/);
  assert.match(sl.validateRequest({type: 'count', invId: 'i', reason: 'x'}), /Counted/);
  assert.equal(sl.validateRequest({type: 'count', invId: 'i', countedQty: 0, reason: 'x'}), null, 'a count of zero is valid');
  assert.match(sl.validateRequest({type: 'receipt', qty: 1}), /item/);
});

test('receipts re-average cost; outflows use the average', () => {
  const r = sl.computePosting({request: {type: 'receipt', invId: 'i', qty: 100, unitCost: 4}, inventory: item, nowIso: NOW});
  assert.deepEqual(r.inventoryPatch, {qty: 200, avgCost: 3, lastMovementAt: NOW});
  assert.equal(r.entry.value, 400);
  assert.equal(r.entry.unitCost, 4);
  const d = sl.computePosting({request: {type: 'damage', invId: 'i', qty: 10, reason: 'crushed'}, inventory: item, nowIso: NOW});
  assert.equal(d.entry.qty, -10);
  assert.equal(d.entry.value, -20);
  assert.equal(d.inventoryPatch.avgCost, 2, 'outflows never change average cost');
});

test('counts post the difference to the counted figure', () => {
  const r = sl.computePosting({request: {type: 'count', invId: 'i', countedQty: 93, reason: 'Oct count'}, inventory: item, nowIso: NOW});
  assert.equal(r.entry.qty, -7);
  assert.equal(r.inventoryPatch.qty, 93);
});

test('stock cannot go negative unless the policy allows it', () => {
  const r = sl.computePosting({request: {type: 'adjust_out', invId: 'i', qty: 101, reason: 'x'}, inventory: item, nowIso: NOW});
  assert.match(r.error, /Not enough stock/);
  const ok = sl.computePosting({request: {type: 'adjust_out', invId: 'i', qty: 101, reason: 'x'}, inventory: item,
    config: {approvalValue: 0, allowNegative: true}, nowIso: NOW});
  assert.equal(ok.inventoryPatch.qty, -1);
});

test('receiving into negative stock averages over received goods only', () => {
  const r = sl.computePosting({request: {type: 'receipt', invId: 'i', qty: 10, unitCost: 5}, inventory: {qty: -4, avgCost: 2}, nowIso: NOW});
  assert.equal(r.inventoryPatch.qty, 6);
  assert.equal(r.inventoryPatch.avgCost, 5);
});

test('adjustments above the threshold need a different admin', () => {
  const cfg = {approvalValue: 200};
  assert.equal(sl.needsApproval({type: 'damage', qty: 100}, item, cfg), true, 'RM 200 → approval');
  assert.equal(sl.needsApproval({type: 'damage', qty: 99}, item, cfg), false);
  assert.equal(sl.needsApproval({type: 'receipt', qty: 10000}, item, cfg), false, 'receipts post directly');
  assert.equal(sl.needsApproval({type: 'count', countedQty: 0}, item, cfg), true);
  assert.equal(sl.canApprove({requestedBy: 'a'}, 'a'), false);
  assert.equal(sl.canApprove({requestedBy: 'a'}, 'b'), true);
});

test('low-stock alert fires once, when crossing the reorder level', () => {
  assert.equal(sl.crossedReorderLevel(25, 20, 20), true);
  assert.equal(sl.crossedReorderLevel(20, 15, 20), false);
  assert.equal(sl.crossedReorderLevel(25, 21, 20), false);
  assert.equal(sl.crossedReorderLevel(25, 0, 0), false);
});

test('rules lock stock quantities and the ledger to the server', () => {
  const rules = read('firestore.rules');
  const inv = rules.slice(rules.indexOf('match /stsb_inventory/{itemId}'), rules.indexOf('match /stsb_stock_requests/'));
  assert.match(inv, /hasAny\(\['qty', 'reservedQty', 'reservations', 'avgCost', 'lastMovementAt'\]\)/);
  assert.match(inv, /get\('qty', 0\) == 0/);
  const req = rules.slice(rules.indexOf('match /stsb_stock_requests/'), rules.indexOf('match /stsb_stock_ledger/'));
  assert.match(req, /resource\.data\.requestedBy != request\.auth\.uid/);
  assert.match(req, /allow delete: if false/);
  assert.match(rules, /match \/stsb_stock_ledger\/\{entryId\} \{\s*allow read: if isStsbERPAdmin\(\);\s*allow write: if false;/);
});

test('portal and Sales App never write stock quantities directly', () => {
  const portal = read('public/portal/index.html');
  const save = portal.slice(portal.indexOf('window.saveInventory'), portal.indexOf('window.saveProduct'));
  const itemFields = save.slice(save.indexOf('const data = {'), save.indexOf('};'));
  assert.doesNotMatch(itemFields, /\b(qty|reservedQty|avgCost):/, 'item details only');
  assert.match(save, /requestStockMovement\(\{ type:'opening'/, 'opening stock goes through the ledger');
  assert.match(portal, /window\.openGRN = /);
  assert.doesNotMatch(portal, /setStatus\('hq_orders','\$\{d\.id\}','received'/);
  const products = read('js/products.js');
  assert.doesNotMatch(products, /qty:data\.stockQty|reservedQty:0/);
});
