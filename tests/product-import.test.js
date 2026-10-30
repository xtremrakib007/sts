const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const P = require('../js/product-import.js');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
// Columns and rows as in the stock-system export.
const HEAD = ['Product', 'SKU', 'Barcode', 'Category', 'UOM', 'Available At', 'On Hand (Bulk)', 'On Hand Unit', 'Held', 'Available (Bulk)', 'Bulk Unit', 'Purchase Price', 'Total Value', 'Status'];
const row = (name, sku, barcode, cat, uom, cost, status = 'IN STOCK') => [name, sku, barcode, cat, uom, 'SAIRAH TRADING (PERAK) SDN BHD (1)', 1, '', 0, 1, '', cost, 1, status];
const SHEET = [HEAD,
  row('01 PERUT Mentah 1CTN=20KG+/-', 'PD-FRO-0001', 'PRD:PD-FRO-0001', 'FROZEN', 'KG', 9.58),
  row('100 PLUS 1.5LX12', 'PD-BEV-0002', 'PRD:PD-BEV-0002', 'SOFT DRINKS', 'CTN', 33.92),
  row('100 PLUS 1.5LX12 (Single)', 'SKU-1600', '9556570312131', 'SOFT DRINKS', 'BTL', 2.86),
  row('100 PLUS 500mlX24', 'PD-BEV-0003', 'PRD:PD-BEV-0003', 'SOFT DRINKS', 'CTN', 38.71, 'OUT OF STOCK'),
  row('100 PLUS 500mlX24 (Single)', 'SKU-1601', '', 'SOFT DRINKS', 'BTL', 1.61, 'OUT OF STOCK'),
  row('11 FQ SLICE 900G+/- 1CTN=20PKT', 'PD-FRO-0004', 'PRD:PD-FRO-0004', 'FROZEN', 'PKT', 17.62),
  row('ACI Puffed Rice/Muri 400gX20', 'PD-RUN-0001', 'PRD:PD-RUN-0001', 'RUNCHIT', 'CTN', 38.73, 'OUT OF STOCK'),
  row('Ajinomoto 150g*10*8Pkt', 'PD-RUN-0016', 'PRD:PD-RUN-0016', 'RUNCHIT', 'CTN', 322.9, 'LOW STOCK'),
  row('Ajinomoto 150g*10*8Pkt (Single)', 'SKU-1735', '', 'RUNCHIT', 'PCS', 4.04),
  row('ACI PURE SALT 500 KG X 25 (Single)', 'SKU-2691', '', 'RUNCHIT', 'PKT', 2.8, 'OUT OF STOCK'),
];
const rule = { pct: 10, mode: 'markup', round: 0.01, apply: 'missing' };

test('stock-system sheet: headers map (On Hand read), other columns ignored', () => {
  assert.deepEqual(HEAD.map(P.productField), ['name', 'sku', 'barcode', 'category', 'unit', null, 'onHand', null, null, null, null, 'cost', null, 'stockStatus']);
});

test('carton + (Single) rows become one product with unit and carton prices from the margin', () => {
  const { plan, errors, singles } = P.buildImportPlan(SHEET, [], rule);
  assert.deepEqual(errors, []);
  assert.equal(singles, 3);
  const by = Object.fromEntries(plan.map((p) => [p.data.name, p.data]));
  assert.equal(plan.length, 7, 'three singles joined to their cartons');
  const plus = by['100 PLUS 1.5LX12'];
  assert.deepEqual([plus.sku, plus.singleSku, plus.singleBarcode, plus.unit, plus.ctnSize, plus.cost, plus.ctnCost, plus.price, plus.ctnPrice],
    ['PD-BEV-0002', 'SKU-1600', '9556570312131', 'BTL', 12, 2.86, 33.92, 3.15, 37.32]);
  assert.equal(by['100 PLUS 500mlX24'].stockStatus, 'out_of_stock');
  const aji = by['Ajinomoto 150g*10*8Pkt'];
  assert.deepEqual([aji.ctnSize, aji.cost, aji.ctnCost, aji.stockStatus], [80, 4.04, 322.9, 'in_stock'], 'LOW STOCK is in stock');
});

test('carton-only CTN rows get a per-unit price; KG/PKT rows sell by their own unit', () => {
  const { plan } = P.buildImportPlan(SHEET, [], rule);
  const by = Object.fromEntries(plan.map((p) => [p.data.name, p.data]));
  const muri = by['ACI Puffed Rice/Muri 400gX20'];
  assert.deepEqual([muri.unit, muri.ctnSize, muri.ctnCost, muri.cost, muri.ctnPrice], ['pcs', 20, 38.73, 1.94, 42.61]);
  const perut = by['01 PERUT Mentah 1CTN=20KG+/-'];
  assert.deepEqual([perut.unit, perut.ctnSize, perut.cost, perut.price], ['KG', 0, 9.58, 10.54]);
  assert.deepEqual([by['11 FQ SLICE 900G+/- 1CTN=20PKT'].unit, by['11 FQ SLICE 900G+/- 1CTN=20PKT'].ctnSize], ['PKT', 0]);
  const salt = by['ACI PURE SALT 500 KG X 25'];
  assert.deepEqual([salt.unit, salt.ctnSize, salt.price], ['PKT', 0, 3.08], 'a single with no carton row stands alone');
});

test('margin rules: markup, margin on price, rounding', () => {
  assert.equal(P.priceFromCost(10, { pct: 10 }), 11);
  assert.equal(P.priceFromCost(10, { pct: 10, mode: 'margin' }), 11.12);
  assert.equal(P.priceFromCost(2.86, { pct: 10, round: 0.05 }), 3.15);
  assert.equal(P.priceFromCost(2.81, { pct: 10, round: 0.1 }), 3.1);
  assert.equal(P.priceFromCost(0, { pct: 10 }), 0);
});

test('existing products are matched by SKU / single SKU / name; a sheet price wins unless re-pricing all', () => {
  const existing = [{ id: 'x1', name: 'Old name', sku: 'SKU-1600', price: 3, ctnPrice: 34 }];
  const { plan } = P.buildImportPlan(SHEET, existing, rule);
  assert.equal(plan.find((p) => p.data.name === '100 PLUS 1.5LX12').id, 'x1');
  const priced = [['Name', 'SKU', 'Price', 'Cost'], ['Tea', 'T1', '5.50', '4']];
  assert.equal(P.buildImportPlan(priced, [], rule).plan[0].data.price, 5.5);
  assert.equal(P.buildImportPlan(priced, [], { ...rule, apply: 'all' }).plan[0].data.price, 4.4);
  assert.match(P.buildImportPlan([['Name', 'Category'], ['Tea', 'X']], [], rule).error, /Price/);
});

test('bulk margin re-prices products with a cost, carton from carton cost', () => {
  const rows = P.repriceByMargin([{ id: 'a', name: 'A', cost: 2.86, ctnSize: 12, ctnCost: 33.92, price: 3, ctnPrice: 35 }, { id: 'b', name: 'B', price: 1 }], { pct: 20 });
  assert.deepEqual(rows.map((r) => [r.id, r.price, r.ctnPrice]), [['a', 3.44, 40.71]]);
});

test('ERP portal uses the shared import + margin tool', () => {
  const portal = read('public/portal/index.html');
  assert.match(portal, /src="\/vendor\/product-import\.js"/);
  assert.match(portal, /window\.ProductImport\.buildImportPlan\(src\.rows, src\.existing, rule\)/);
  assert.match(portal, /window\.ProductImport\.repriceByMargin\(scope, rule\)/);
  assert.match(portal, /onclick="openPriceMargin\(\)"/);
  assert.match(read('build.js'), /'js\/product-import\.js': 'vendor\/product-import\.js'/);
});

test('our own template: Pcs per carton column keeps the carton on unit rows', () => {
  const t = [['Name', 'SKU', 'Category', 'Unit', 'Price (RM)', 'Cost (RM)', 'Pcs per carton', 'Carton price (RM)'], ['100PLUS 500ML*24', '100P-500', 'BEVERAGE', 'pcs', 2.1, 1.5, 24, 45]];
  const d = P.buildImportPlan(t, [], { pct: 10, apply: 'missing' }).plan[0].data;
  assert.deepEqual([d.unit, d.ctnSize, d.price, d.ctnPrice, d.cost], ['pcs', 24, 2.1, 45, 1.5]);
  const all = P.buildImportPlan(t, [], { pct: 10, apply: 'all' }).plan[0].data;
  assert.deepEqual([all.price, all.ctnPrice], [1.65, 39.6]);
});

test('on-hand stock: single units for carton + single, cartons × size for carton-only, opening vs count', () => {
  const H = ['Product', 'SKU', 'UOM', 'On Hand (Bulk)', 'On Hand Unit', 'Purchase Price'];
  const sheet = [H,
    ['100 PLUS 1.5LX12', 'B1', 'CTN', 73.833, '', 33.92], ['100 PLUS 1.5LX12 (Single)', 'S1', 'BTL', 885.996, '', 2.86],
    ['ACI Puffed Rice/Muri 400gX20', 'B2', 'CTN', 3, '', 38.73],
    ['01 PERUT Mentah 1CTN=20KG+/-', 'B3', 'KG', 140, '', 9.58],
    ['ATTA 5KG', 'B4', 'PCS', 0, '', 13.97],
    ['No count', 'B5', 'PCS', '', '', 1]];
  const res = P.buildImportPlan(sheet, [{ id: 'old4', name: 'ATTA 5KG', sku: 'B4' }], { pct: 10, apply: 'missing' });
  assert.equal(res.hasStock, true);
  const by = Object.fromEntries(res.plan.map((p) => [p.data.name, p]));
  assert.equal(by['100 PLUS 1.5LX12'].onHand, 886);
  assert.equal(by['ACI Puffed Rice/Muri 400gX20'].onHand, 60);
  assert.equal(by['01 PERUT Mentah 1CTN=20KG+/-'].onHand, 140);
  assert.equal(by['No count'].onHand, null, 'blank cell leaves stock alone');
  const plan = res.plan.map((p, i) => ({ ...p, id: p.id || 'n' + i }));
  const ids = Object.fromEntries(plan.map((p) => [p.data.name, p.id]));
  const moves = P.stockMovesFor(plan, { [ids['01 PERUT Mentah 1CTN=20KG+/-']]: 100, old4: 5 }, 'Stock import x.xlsx');
  const m = Object.fromEntries(moves.map((x) => [x.invId, x]));
  assert.deepEqual([m[ids['100 PLUS 1.5LX12']].type, m[ids['100 PLUS 1.5LX12']].qty, m[ids['100 PLUS 1.5LX12']].unitCost], ['opening', 886, 2.86]);
  assert.deepEqual([m[ids['01 PERUT Mentah 1CTN=20KG+/-']].type, m[ids['01 PERUT Mentah 1CTN=20KG+/-']].countedQty], ['count', 140], 'existing stock → count, not added');
  assert.deepEqual([m.old4.type, m.old4.countedQty, m.old4.reason], ['count', 0, 'Stock import x.xlsx']);
  assert.equal(moves.length, 4, 'no move for unchanged / blank rows');
  assert.equal(P.stockMovesFor(plan, Object.fromEntries(plan.map((p) => [p.id, p.onHand || 0])), 'n').length, 0, 're-import of the same sheet changes nothing');
  assert.equal(P.productField('On Hand Unit'), null);
});

test('ERP invoice form: product/outlet dropdowns, walk-in, salesman, pcs/ctn/kg/bag, mobile + address saved', () => {
  const portal = read('public/portal/index.html');
  assert.match(portal, /id="invCust" autocomplete="off"/);
  assert.doesNotMatch(portal, /<datalist id="inv/, 'own dropdown, datalist does not open on phones');
  assert.match(portal, /function _combo\(input, source, onPick\)/);
  assert.match(portal, /const INV_UNITS = \['pcs', 'ctn', 'kg', 'bag'\]/);
  assert.match(portal, /const INV_WALKIN = 'Walk-in customer'/);
  assert.match(portal, /id="invRep"/);
  assert.match(portal, /repId: document\.getElementById\('invRep'\)\.value/);
  assert.match(portal, /id="invPhone"/);
  assert.match(portal, /id="invAddr"/);
  assert.match(portal, /class="finp il-prod" autocomplete="off"/);
  assert.match(portal, /window\.__invCatalog = prods\.filter\(p => p\.name\)/, 'all products loaded');
  assert.match(portal, /customerPhone: document\.getElementById\('invPhone'\)\.value\.trim\(\), customerAddress: document\.getElementById\('invAddr'\)\.value\.trim\(\)/);
});
