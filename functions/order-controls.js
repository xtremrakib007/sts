// ═══════════════════════════════════════════════════════════════
// Order controls — stock reservation and outlet credit limits
//
// Pure helpers used by the erpBridge functions. No Firebase dependency,
// so the rules can be unit-tested with plain Node.
// ═══════════════════════════════════════════════════════════════

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const key = (s) => String(s || '').toLowerCase().trim();

// ── STOCK ─────────────────────────────────────────────────────

/**
 * Builds a lookup of ERP inventory keyed by SKU and by name, the same
 * matching the Sales App catalogue uses (SKU first, name as fallback).
 * @param {Array<{id: string, sku?: string, name?: string}>} inventory
 * @return {{bySku: object, byName: object}}
 */
function inventoryIndex(inventory) {
  const bySku = {};
  const byName = {};
  (inventory || []).forEach((inv) => {
    if (key(inv.sku)) bySku[key(inv.sku)] = inv.id;
    if (key(inv.name)) byName[key(inv.name)] = inv.id;
  });
  return {bySku, byName};
}

/**
 * Totals an order's pcs quantity per inventory record.
 * @param {Array<object>} items Sales App order lines (qty is total pcs).
 * @param {{bySku: object, byName: object}} index
 * @return {{lines: object, unmatched: string[]}}
 */
function orderStockLines(items, index) {
  const lines = {};
  const unmatched = [];
  (items || []).forEach((it) => {
    const qty = num(it.qty);
    if (qty <= 0) return;
    const invId = index.bySku[key(it.sku)] || index.byName[key(it.name)];
    if (!invId) { unmatched.push(it.name || it.sku || '?'); return; }
    lines[invId] = (lines[invId] || 0) + qty;
  });
  return {lines, unmatched};
}

/**
 * The stock an order should hold for its current state.
 *   active (Pending … Failed) → reserved
 *   Delivered                 → deducted from on-hand qty
 *   Cancelled / deleted       → nothing reserved
 * A deduction is never reversed automatically: goods that left the
 * warehouse come back only through a return, not by editing the order.
 * @param {string|null} status App order status, null when deleted.
 * @param {object} lines {invId: qty} for the order's current items.
 * @param {{reserved?: object, deducted?: object}} current Ledger state.
 * @return {{reserved: object, deducted: object}}
 */
function desiredStock(status, lines, current = {}) {
  const deducted = {...(current.deducted || {})};
  if (status === null || status === 'Cancelled') return {reserved: {}, deducted};
  if (status === 'Delivered') {
    return {reserved: {}, deducted: Object.keys(deducted).length ? deducted : {...lines}};
  }
  return {reserved: {...lines}, deducted};
}

/**
 * Per-inventory changes needed to move from the current ledger state to
 * the desired one. Only records whose numbers change are returned.
 * @param {{reserved?: object, deducted?: object}} current
 * @param {{reserved: object, deducted: object}} desired
 * @return {Object<string, {reserved: number, qty: number}>}
 */
function stockDeltas(current, desired) {
  const cur = {reserved: current.reserved || {}, deducted: current.deducted || {}};
  const ids = new Set([
    ...Object.keys(cur.reserved), ...Object.keys(cur.deducted),
    ...Object.keys(desired.reserved), ...Object.keys(desired.deducted),
  ]);
  const out = {};
  ids.forEach((id) => {
    const reserved = num(desired.reserved[id]) - num(cur.reserved[id]);
    const qty = num(cur.deducted[id]) - num(desired.deducted[id]);
    if (reserved || qty) out[id] = {reserved, qty};
  });
  return out;
}

// ── CREDIT LIMIT ──────────────────────────────────────────────

/**
 * Outstanding balance of an outlet, as the Sales App collection screen
 * computes it: non-cancelled orders − collections + approved opening
 * balance.
 * @param {object} p
 * @param {Array<object>} p.orders Orders for the outlet.
 * @param {Array<object>} p.collections Collections for the outlet.
 * @param {object} p.outlet
 * @param {string} [p.excludeOrderId] Order being evaluated.
 * @return {number}
 */
function outletOutstanding({orders, collections, outlet, excludeOrderId}) {
  const ordered = (orders || [])
      .filter((o) => o.status !== 'Cancelled' && o.id !== excludeOrderId)
      .reduce((s, o) => s + num(o.total), 0);
  const paid = (collections || []).reduce((s, c) => s + num(c.amount), 0);
  const opening = outlet && outlet.balanceStatus === 'approved' ? num(outlet.openingBalance) : 0;
  return Math.max(0, ordered - paid + opening);
}

/**
 * Decides whether a new order breaches the outlet's credit limit.
 * Only credit outlets with a positive limit are checked.
 * @param {object} p
 * @param {object} p.outlet
 * @param {number} p.outstanding Balance before this order.
 * @param {number} p.orderTotal
 * @return {object|null} creditHold record, or null when within limit.
 */
function creditCheck({outlet, outstanding, orderTotal}) {
  const limit = num(outlet && outlet.creditLimit);
  if (!outlet || outlet.paymentType !== 'credit' || limit <= 0) return null;
  const after = num(outstanding) + num(orderTotal);
  if (after <= limit) return null;
  return {
    status: 'pending',
    limit,
    outstanding: Math.round(num(outstanding) * 100) / 100,
    orderTotal: num(orderTotal),
    exceededBy: Math.round((after - limit) * 100) / 100,
  };
}

const isCreditHeld = (o) => !!(o && o.creditHold && o.creditHold.status === 'pending');

module.exports = {
  inventoryIndex,
  orderStockLines,
  desiredStock,
  stockDeltas,
  outletOutstanding,
  creditCheck,
  isCreditHeld,
};
