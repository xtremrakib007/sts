const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// The report calculations run in the ERP portal; load the exact block from
// the page so the tests exercise the shipped code.
const html = fs.readFileSync(path.join(__dirname, '..', 'public/portal/index.html'), 'utf8');
const src = html.slice(html.indexOf('// <reports-core>'), html.indexOf('// </reports-core>'));
const R = new Function(src + '; return ReportsCore;')();

const orders = [
  {orderId: 'A', date: '2026-10-01', status: 'delivered', total: 90, deliveredAt: '2026-10-02', deliveryDate: '2026-10-02', repId: 'r1', repName: 'Rep 1',
    customer: 'Shop X', outletId: 'o1', outletRoute: 'R1', payTerms: 'COD',
    items: [{name: 'Tea', sku: 'T1', qty: 10, price: 10, total: 100}]},
  {orderId: 'B', date: '2026-10-03', status: 'delivered', total: 50, deliveredTotal: 25, partial: true, deliveryStatus: 'partially_delivered',
    deliveredAt: '2026-10-06', deliveryDate: '2026-10-05', repId: 'r2', repName: 'Rep 2', customer: 'Shop Y', outletId: 'o2', payTerms: 'Credit',
    items: [{name: 'Sugar', sku: 'S1', qty: 10, price: 5, total: 50}], deliveredItems: [{qty: 5}]},
  {orderId: 'C', date: '2026-10-04', status: 'processing', total: 40, deliveryDate: '2026-10-05', repId: 'r1', customer: 'Shop X', outletId: 'o1', items: []},
  {orderId: 'D', date: '2026-10-04', status: 'cancelled', total: 999, repId: 'r1', customer: 'Shop X', outletId: 'o1', items: []},
  {orderId: 'E', date: '2026-09-01', status: 'delivered', total: 70, deliveredAt: '2026-09-02', customer: 'Shop X', outletId: 'o1', items: []},
];
const creditNotes = [{orderId: 'A', amount: 9, createdAt: '2026-10-10T01:00:00Z', customer: 'Shop X', outletId: 'o1', reason: 'Expired',
  lines: [{name: 'Tea', sku: 'T1', qty: 1, amount: 9}]}];
const ledger = [
  {type: 'sale', ref: 'A', sku: 'T1', name: 'Tea', value: -60, invId: 'tea', at: '2026-10-02'},
  {type: 'sale', ref: 'B', sku: 'S1', name: 'Sugar', value: -10, invId: 'sugar', at: '2026-10-06'},
  {type: 'receipt', invId: 'tea', qty: 50, value: 100, at: '2026-10-01'},
];

test('sales totals: ordered, delivered (partial at delivered value), returns, net and margin', () => {
  const {totals} = R.sales({orders, creditNotes, ledger, from: '2026-10-01', to: '2026-10-31', groupBy: 'salesman'});
  assert.deepEqual(
      [totals.orders, totals.ordered, totals.delivered, totals.returns, totals.net, totals.cogs, totals.margin],
      [3, 180, 115, 9, 106, 70, 36], 'cancelled and out-of-range orders excluded');
  assert.equal(totals.marginPct, 34);
});

test('sales by salesman and by product, with order discounts shared across lines', () => {
  const bySm = R.sales({orders, creditNotes, ledger, from: '2026-10-01', to: '2026-10-31', groupBy: 'salesman'}).rows;
  const r1 = bySm.find((r) => r.key === 'r1');
  assert.deepEqual([r1.orders, r1.delivered, r1.returns, r1.net, r1.cogs], [2, 90, 9, 81, 60]);
  const byProd = R.sales({orders, creditNotes, ledger, from: '2026-10-01', to: '2026-10-31', groupBy: 'product'}).rows;
  const tea = byProd.find((r) => r.key === 't1');
  assert.deepEqual([tea.qty, tea.ordered, tea.delivered, tea.returns, tea.cogs], [10, 90, 90, 9, 60], '10% order discount applied');
  const sugar = byProd.find((r) => r.key === 's1');
  assert.deepEqual([sugar.qty, sugar.delivered], [5, 25], 'partial delivery counts delivered qty');
});

test('sales by day puts returns on the credit-note day', () => {
  const rows = R.sales({orders, creditNotes, ledger, from: '2026-10-01', to: '2026-10-31', groupBy: 'day'}).rows;
  assert.deepEqual(rows.map((r) => r.key), ['2026-10-01', '2026-10-03', '2026-10-04', '2026-10-10']);
  assert.equal(rows.find((r) => r.key === '2026-10-10').returns, 9);
});

test('delivery performance: on time, fill rate, lead time, overdue only when scheduled', () => {
  const f = R.fulfilment({orders: [...orders, {orderId: 'F', date: '2026-10-04', status: 'pending', items: []}],
    from: '2026-10-01', to: '2026-10-31', today: '2026-10-08'});
  assert.deepEqual([f.full, f.partial, f.cancelled, f.open, f.unscheduled], [1, 1, 1, 2, 1]);
  assert.equal(f.onTimePct, 50, 'B delivered a day late');
  assert.equal(f.fillRatePct, 82.1, '115 of 140');
  assert.equal(f.avgLeadDays, 2);
  assert.deepEqual(f.overdue.map((o) => [o.orderId, o.daysLate]), [['C', 3]]);
});

test('receivables ageing applies payments and credit notes to the oldest debts', () => {
  const a = R.ageing({orders, creditNotes,
    collections: [{customer: 'Shop X', amount: 100, date: '2026-10-05'}, {outletId: 'o1', amount: 50, status: 'rejected', date: '2026-10-05'}],
    asOf: '2026-11-15'});
  const x = a.rows.find((r) => r.key === 'o1');
  // Shop X owes 70 (Sep) + 90 (Oct); paid 100 + credit 9 → 51 left, all from the October order.
  assert.deepEqual([x.current, x.d31, x.d61, x.d90, x.total, x.oldestDays], [0, 51, 0, 0, 51, 44]);
  const y = a.rows.find((r) => r.key === 'o2');
  assert.equal(y.total, 25, 'partial delivery owes its delivered value');
  assert.equal(a.totals.total, 76);
});

test('ageing shows overpayment as unapplied credit', () => {
  const a = R.ageing({orders: [orders[4]], creditNotes: [], collections: [{outletId: 'o1', amount: 100, date: '2026-09-05'}], asOf: '2026-10-01'});
  assert.deepEqual([a.rows[0].unapplied, a.rows[0].total], [30, -30]);
});

test('collections vs cash expected from COD deliveries, by salesman and method', () => {
  const c = R.collections({orders, from: '2026-10-01', to: '2026-10-31', collections: [
    {repId: 'r1', amount: 60, method: 'cash', status: 'accepted', date: '2026-10-03'},
    {repId: 'r1', amount: 20, method: 'bank', date: '2026-10-04'},
    {repId: 'r1', amount: 5, method: 'cash', status: 'rejected', date: '2026-10-04'}]});
  const r1 = c.rows.find((r) => r.key === 'r1');
  assert.deepEqual([r1.expected, r1.accepted, r1.pending, r1.rejected, r1.variance], [90, 60, 20, 5, -10]);
  assert.deepEqual(c.byMethod, {cash: 60, bank: 20});
  assert.equal(c.rows.find((r) => r.key === 'r2'), undefined, 'credit-terms orders are not expected cash');
});

test('inventory: valuation by category, movements, reorder and slow movers', () => {
  const v = R.inventory({from: '2026-10-01', to: '2026-10-31', ledger, items: [
    {id: 'tea', name: 'Tea', category: 'Drinks', qty: 40, avgCost: 6, minStock: 50},
    {id: 'coffee', name: 'Coffee', category: 'Drinks', qty: 10, costPrice: 3},
    {id: 'sugar', name: 'Sugar', category: 'Food', qty: 0, avgCost: 2}]});
  assert.deepEqual(v.byCategory[0], {category: 'Drinks', items: 2, qty: 50, value: 270});
  assert.deepEqual(v.low.map((x) => x.id), ['tea']);
  assert.deepEqual(v.slow.map((x) => x.id), ['coffee']);
  assert.equal(v.moves.find((m) => m.type === 'sale').value, -70);
});

test('returns report and return rate', () => {
  const r = R.returnsReport({creditNotes, orders, from: '2026-10-01', to: '2026-10-31'});
  assert.deepEqual([r.total, r.count, r.ratePct], [9, 1, 7.8]);
  assert.equal(r.byProduct[0].qty, 1);
  assert.equal(r.byReason[0].label, 'Expired');
});

test('portal exposes functions used by inline handlers (module script)', () => {
  assert.match(html, /Object\.assign\(window, \{ prepModal, myOrders, deliveryPlanner, reports, _pickRender, einvoiceRequests, staffAdvances \}\)/);
  assert.match(html, /--chart-1:#00b07a/);
  assert.match(html, /--chart-1:#008f62/);
});
