const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const R = require('../js/delivery-report.js');

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const it = [{ name: 'Tea', qty: 24, price: 3.5 }, { name: 'Rice', qty: 2, price: 20 }];
const day = '2026-10-30', at = (h) => `${day}T0${h}:00:00.000Z`;
const orders = [
  { id: 'A', status: 'Delivered', deliveryManId: 'd1', total: 120, items: it, deliveredAt: at(1), paymentMethod: 'cash', paymentAmount: 120 },
  { id: 'B', status: 'Delivered', deliveryManId: 'd1', total: 120, items: it, partial: true, deliveredItems: [{ qty: 12 }, { qty: 2 }], deliveredTotal: 80, deliveredAt: at(2), paymentMethod: 'cheque', paymentAmount: 50, paymentRef: '9' },
  { id: 'C', status: 'Failed', deliveryManId: 'd2', total: 50, items: it, failedAt: at(3), failureReason: 'Shop closed' },
  { id: 'D', status: 'Delivered', deliveryManId: 'd2', total: 70, items: it, deliveredAt: at(4), paymentMethod: 'pending', paymentAmount: 0 },
  { id: 'E', status: 'Delivered', deliveryManId: 'd2', total: 40, items: it, deliveredAt: at(5) }, // before payments were recorded
  { id: 'F', status: 'In Transit', deliveryManId: 'd1', total: 30, items: it },
  { id: 'G', status: 'Delivered', deliveryManId: 'd1', total: 99, items: it, deliveredAt: '2026-10-01T01:00:00Z', paymentMethod: 'cash', paymentAmount: 99 },
  { id: 'H', status: 'Confirmed', total: 10, items: it },
  { id: 'I', status: 'Delivered', deliveryManId: 'd1', total: 10, items: it, deliveredAt: at(6), paymentMethod: 'cash', paymentAmount: 10, appDeleted: true },
];

test('delivery report: outcomes, values and money by method, per driver', () => {
  const r = R.buildDeliveryReport(orders, { from: day, to: day, tzOffsetMin: 480 });
  assert.deepEqual(r.rows.map((x) => x.id), ['E', 'D', 'C', 'B', 'A'], 'newest first; other days, deleted and undelivered left out');
  assert.deepEqual(r.out.map((x) => x.id), ['F']);
  const t = r.total;
  assert.deepEqual([t.done, t.full, t.partial, t.failed], [5, 3, 1, 1]);
  assert.equal(t.delivered, 120 + 80 + 70 + 40);
  assert.equal(t.shortValue, 40);
  assert.equal(t.failedValue, 50);
  assert.deepEqual([t.cash, t.cheque, t.online, t.collected, t.cheques], [120, 50, 0, 170, 1]);
  assert.equal(t.pending, 30 + 70 + 40, 'part payment, not paid and unrecorded stay pending');
  const d1 = r.drivers.find((d) => d.dmId === 'd1');
  assert.deepEqual([d1.done, d1.cash, d1.cheque, d1.pending], [2, 120, 50, 30]);
  const B = r.rows.find((x) => x.id === 'B');
  assert.deepEqual(B.short, [{ name: 'Tea', ordered: 24, delivered: 12 }]);
  assert.equal(r.rows.find((x) => x.id === 'E').method, 'unrecorded');
  assert.equal(R.buildDeliveryReport(orders, { from: day, to: day, dm: 'd2', tzOffsetMin: 480 }).rows.length, 3);
});

test('collected never exceeds what was delivered', () => {
  const row = R.deliveryRow({ status: 'Delivered', deliveryManId: 'x', total: 50, paymentMethod: 'cash', paymentAmount: 80, deliveredAt: at(1) }, 480);
  assert.equal(row.collected, 50);
  assert.equal(row.pending, 0);
});

test('local day uses the given time zone', () => {
  assert.equal(R.localDay('2026-10-30T17:00:00Z', 480), '2026-10-31');
  assert.equal(R.localDay('', 480), '');
});

test('ERP portal has the Delivery Report page; the Sales App records payment and shows the delivery dashboard', () => {
  const portal = read('public/portal/index.html');
  assert.match(portal, /<script defer src="\/vendor\/delivery-report\.js"><\/script>/);
  assert.match(portal, /data-page="deliveryReport"/);
  assert.match(portal, /window\.DeliveryReport\.buildDeliveryReport\(orders, st\)/);
  assert.match(read('build.js'), /'js\/delivery-report\.js': 'vendor\/delivery-report\.js'/);
  const d = read('js/deliveries.js');
  assert.match(d, /name="cdPayM" value="\$\{k\}"/);
  assert.match(d, /paymentStatus:amt<=0\?'pending':amt\+0\.009<due\?'part_paid':'paid'/);
  assert.match(d, /source:'delivery'/, 'payment becomes a collection');
  assert.match(d, /function _dmDirections\(ordDocId\)/);
  assert.match(d, /function _dmWhatsApp\(ordDocId\)/);
  assert.match(read('js/dashboard.js'), /if\(isDeliveryMan\(\)\)\{ _renderDeliveryDashboard\(ordDocs, attDocs\); return; \}/);
  assert.match(read('index.html'), /page:'outlets',\s+ico:'🏪', lbl:'Outlets',\s+roles:\[\.\.\.R_ADMIN,\.\.\.R_SALES,\.\.\.R_DELIV\]/);
  const rules = read('firestore.rules');
  assert.equal((rules.match(/'paymentMethod','paymentAmount','paymentStatus','paymentAt',\s+'paymentRef','chequeBank','chequeDate'/g) || []).length, 2, 'zone + root order rules');
  assert.equal((rules.match(/_isDeliveryMan\(ud\(\)\) && request\.resource\.data\.createdBy == request\.auth\.uid\s+&& request\.resource\.data\.get\('source', ''\) == 'delivery'/g) || []).length, 2, 'zone + root collection rules');
});
