// ═══════════════════════════════════════════════════════════════
// Customer portal: what one outlet sees on its private link
// (https://stfm-sales.web.app/customer?t=TOKEN). Pure logic, tested in
// tests/customer-portal.test.js; the HTTP function is in index.js.
//
// The outlet's portalToken (random, 32 hex characters) is the only key:
// nothing is returned without it, and only that outlet's own orders,
// payments and balance are returned.
// ═══════════════════════════════════════════════════════════════
const n = (v) => Number(v) || 0;
const r2 = (v) => Math.round(v * 100) / 100;

const TOKEN_RE = /^[a-f0-9]{32}$/;
const isValidToken = (t) => typeof t === 'string' && TOKEN_RE.test(t);

// Delivered value less returns (same as dues and the Sales App).
const orderValue = (o) => Math.max(0, (o.deliveredTotal != null ? n(o.deliveredTotal) : n(o.total)) - n(o.returnedTotal));
const dayOf = (o) => o.date || (typeof o.createdAt === 'string' ? o.createdAt.slice(0, 10) :
  o.createdAt && o.createdAt.toDate ? o.createdAt.toDate().toISOString().slice(0, 10) : '');

const STATUS_TEXT = {
  'Pending': 'Received', 'Confirmed': 'Confirmed', 'Assigned': 'Preparing for delivery',
  'In Transit': 'On the way', 'Delivered': 'Delivered', 'Failed': 'Delivery missed — will be rescheduled',
  'Cancelled': 'Cancelled',
};

/**
 * Builds the outlet's statement: orders newest first with what each still
 * owes (payments tied to an order go to it first, the rest to the opening
 * balance and the oldest orders), payments, and the balance.
 * @param {object} p
 * @param {object} p.outlet
 * @param {object[]} p.orders
 * @param {object[]} p.collections
 * @param {object} [p.company]
 * @return {object}
 */
function buildCustomerPortal({outlet, orders, collections, company = {}}) {
  const live = orders.filter((o) => o.status !== 'Cancelled' && !o.appDeleted)
    .sort((a, b) => String(dayOf(a)).localeCompare(String(dayOf(b))));
  const opening = outlet.balanceStatus === 'approved' ? n(outlet.openingBalance) : 0;
  const lines = live.map((o) => ({o, amount: r2(orderValue(o)), paid: 0}));
  if (opening > 0) lines.unshift({opening: true, amount: r2(opening), paid: 0});
  let free = 0;
  for (const c of collections) {
    const amt = n(c.amount);
    if (amt <= 0 || c.status === 'rejected') continue;
    const ln = c.orderId && lines.find((l) => l.o && (l.o.id === c.orderId || l.o._docId === c.orderId));
    if (ln) {
      const take = Math.min(amt, ln.amount - ln.paid); ln.paid += take; free += amt - take;
    } else free += amt;
  }
  for (const ln of lines) {
    if (free <= 0) break;
    const take = Math.min(free, ln.amount - ln.paid); ln.paid += take; free -= take;
  }
  const byOrder = new Map(lines.filter((l) => l.o).map((l) => [l.o, l]));
  const sales = r2(live.reduce((s, o) => s + orderValue(o), 0));
  const paid = r2(collections.filter((c) => c.status !== 'rejected').reduce((s, c) => s + n(c.amount), 0));
  return {
    outlet: {name: outlet.name || '', address: outlet.address || '', route: outlet.route || ''},
    company: {name: company.name || 'Sairah Trading', phone: company.phone || ''},
    balance: r2(Math.max(0, sales + opening - paid)),
    credit: r2(free),
    opening: r2(opening),
    orders: [...orders].filter((o) => !o.appDeleted)
      .sort((a, b) => String(dayOf(b)).localeCompare(String(dayOf(a)))).slice(0, 50)
      .map((o) => {
        const ln = byOrder.get(o);
        return {
          number: o.invoiceNo || o.id || '', date: dayOf(o), status: STATUS_TEXT[o.status] || o.status || '',
          cancelled: o.status === 'Cancelled', total: r2(orderValue(o)),
          due: ln ? r2(ln.amount - ln.paid) : 0,
          items: (o.deliveredItems || o.items || []).slice(0, 40).map((it) => ({
            name: it.name || '', qty: n(it.qty), display: it.qtyDisplay || '',
          })),
        };
      }),
    payments: [...collections].filter((c) => c.status !== 'rejected')
      .sort((a, b) => String(b.date || '').localeCompare(String(a.date || ''))).slice(0, 50)
      .map((c) => ({date: c.date || '', amount: r2(n(c.amount)), method: c.mode || c.method || ''})),
  };
}

module.exports = {isValidToken, buildCustomerPortal, orderValue, STATUS_TEXT};
