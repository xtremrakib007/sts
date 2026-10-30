const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const P = require('../functions/customer-portal');

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

test('only a 32-hex token is accepted', () => {
  assert.ok(P.isValidToken('0123456789abcdef0123456789abcdef'));
  for (const t of ['', 'x', '0123456789ABCDEF0123456789ABCDEF', '0123456789abcdef0123456789abcde', null, 42]) assert.ok(!P.isValidToken(t));
});

test('statement: delivered value, order-tied payments first, oldest first, cancelled shown but not owed', () => {
  const d = P.buildCustomerPortal({
    outlet: { name: 'Kedai A', address: 'Ipoh', balanceStatus: 'approved', openingBalance: 10, portalToken: 'secret', phone: '011' },
    orders: [
      { _docId: 'a', id: 'ORD-A', invoiceNo: 'INV-1', status: 'Delivered', total: 100, date: '2026-10-01', items: [{ name: 'Tea', qty: 2 }] },
      { _docId: 'b', id: 'ORD-B', status: 'Delivered', total: 100, deliveredTotal: 80, date: '2026-10-10' },
      { _docId: 'c', id: 'ORD-C', status: 'Cancelled', total: 50, date: '2026-10-12' },
      { _docId: 'd', id: 'ORD-D', status: 'In Transit', total: 60, date: '2026-10-20' },
    ],
    collections: [{ amount: 30, orderId: 'ORD-B', date: '2026-10-11', mode: 'Cash' }, { amount: 120, date: '2026-10-15', mode: 'Cheque' }, { amount: 999, status: 'rejected' }],
    company: { name: 'Sairah Trading', phone: '05-123' },
  });
  assert.equal(d.balance, 10 + 100 + 80 + 60 - 150);
  assert.deepEqual(d.orders.map((o) => [o.number, o.due, o.status]), [
    ['ORD-D', 60, 'On the way'], ['ORD-C', 0, 'Cancelled'], ['ORD-B', 40, 'Delivered'], ['INV-1', 0, 'Delivered']]);
  assert.equal(d.payments.length, 2, 'rejected payment left out');
  assert.equal(JSON.stringify(d).includes('secret'), false, 'the token never leaves the server');
  assert.equal(JSON.stringify(d).includes('011'), false, 'no outlet phone in the reply');
});

test('the app shares the hosted link (never the app address); hosting serves page + function', () => {
  const html = read('index.html');
  assert.match(html, /const portalBase = \(\) => \(typeof PUBLIC_APP_URL !== 'undefined' \? PUBLIC_APP_URL : 'https:\/\/sales\.stfreshmart\.my'\) \+ '\/customer\?t=';/);
  assert.match(read('js/core.js'), /const PUBLIC_APP_URL = 'https:\/\/sales\.stfreshmart\.my';/);
  assert.doesNotMatch(html, /window\.location\.origin \+ window\.location\.pathname \+ '\?portal=1'/);
  const fb = JSON.parse(read('firebase.json'));
  assert.deepEqual(fb.hosting.rewrites.slice(0, 2), [{ source: '/api/customer-portal', function: 'customerPortal' }, { source: '/customer', destination: '/customer.html' }]);
  assert.match(read('functions/index.js'), /exports\.customerPortal = functions\.https\.onRequest/);
  assert.match(read('public/customer.html'), /fetch\('\/api\/customer-portal\?t=' \+ encodeURIComponent\(t\)/);
});
