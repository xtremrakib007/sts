// ═══════════════════════════════════════════════════════════════
// Sales returns and credit notes — pure rules
//
// A return is raised in the ERP against a delivered order, approved by a
// second admin, then posted by the server: resellable goods go back into
// stock (return_in), damaged goods are written off, and a numbered credit
// note reduces what the outlet owes. No Firebase dependency.
// ═══════════════════════════════════════════════════════════════

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const round2 = (v) => Math.round(num(v) * 100) / 100;

/**
 * Quantities actually delivered per order line: the delivered quantities
 * for a partial delivery, else the ordered quantities.
 * @param {object} order ERP order (stsb_orders).
 * @return {number[]}
 */
function deliveredQtys(order) {
  const items = order.items || [];
  const delivered = order.deliveredItems;
  return items.map((it, i) =>
    Array.isArray(delivered) && delivered[i] ? num(delivered[i].qty) : num(it.qty));
}

/**
 * Net unit price of a line (line total after discount ÷ quantity).
 * @param {object} it
 * @return {number}
 */
function netUnitPrice(it) {
  const qty = num(it.qty);
  if (qty <= 0) return 0;
  const total = it.total != null ? num(it.total) : num(it.price) * qty - num(it.discount);
  return total / qty;
}

/**
 * Ratio of what the customer pays to the sum of the line totals, so an
 * order-level discount is shared across lines (1 when none applies).
 * @param {object} order
 * @return {number}
 */
function payableRatio(order) {
  const lines = (order.items || []).reduce((s, it) => s + netUnitPrice(it) * num(it.qty), 0);
  if (lines <= 0 || order.total == null) return 1;
  return Math.min(1, num(order.total) / lines);
}

/**
 * Validates a return and prices it from the original order.
 * @param {object} p
 * @param {object} p.ret Return document: {lines: [{line, qty, condition}], reason}.
 * @param {object} p.order ERP order.
 * @return {{error: string}|{lines: object[], amount: number}}
 */
function priceReturn({ret, order}) {
  if (!order) return {error: 'Order not found'};
  if (!['delivered'].includes(order.status) && order.deliveryStatus !== 'delivered' &&
      order.deliveryStatus !== 'partially_delivered') {
    return {error: 'Only delivered orders can be returned'};
  }
  if (!String(ret.reason || '').trim()) return {error: 'A reason is required'};
  const lines = (ret.lines || []).filter((l) => num(l.qty) > 0);
  if (!lines.length) return {error: 'Enter a quantity for at least one item'};
  const items = order.items || [];
  const delivered = deliveredQtys(order);
  const returned = order.returnedQty || {};
  const ratio = payableRatio(order);
  const out = [];
  for (const l of lines) {
    const it = items[l.line];
    if (!it) return {error: `Line ${l.line + 1} is not on the order`};
    const left = delivered[l.line] - num(returned[l.line]);
    if (num(l.qty) > left + 1e-9) {
      return {error: `${it.name}: only ${left} can still be returned`};
    }
    if (!['resellable', 'damaged'].includes(l.condition)) {
      return {error: `${it.name}: choose resellable or damaged`};
    }
    const unit = netUnitPrice(it) * ratio;
    out.push({
      line: l.line, name: it.name || '', sku: it.sku || '', productId: it.productId || '',
      qty: num(l.qty), unitPrice: round2(unit), amount: round2(unit * num(l.qty)),
      condition: l.condition,
    });
  }
  return {lines: out, amount: round2(out.reduce((s, l) => s + l.amount, 0))};
}

/**
 * Credit note number from a running counter, e.g. CN-000042.
 * @param {number} n
 * @return {string}
 */
function creditNoteNumber(n) {
  return 'CN-' + String(n).padStart(6, '0');
}

/**
 * Amount due after a partial delivery: the order total scaled by the share
 * of line value actually delivered (keeps any order-level discount).
 * @param {object[]} items Sales App order lines.
 * @param {object[]} deliveredItems Same lines with delivered qty.
 * @param {number} orderTotal
 * @return {number}
 */
function deliveredTotal(items, deliveredItems, orderTotal) {
  let full = 0;
  let got = 0;
  (items || []).forEach((it, i) => {
    const qty = num(it.qty);
    if (qty <= 0) return;
    const lineTotal = it._lineTotal != null ? num(it._lineTotal) :
      num(it.price) * qty - num(it.discount && it.discount.amount);
    const q = deliveredItems && deliveredItems[i] ? num(deliveredItems[i].qty) : qty;
    full += lineTotal;
    got += (lineTotal / qty) * Math.min(q, qty);
  });
  return full > 0 ? round2(num(orderTotal) * got / full) : 0;
}

module.exports = {
  deliveredQtys,
  netUnitPrice,
  payableRatio,
  priceReturn,
  creditNoteNumber,
  deliveredTotal,
};
