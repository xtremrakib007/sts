// ═══════════════════════════════════════════════════════════════
// Stock ledger — posting rules for ERP stock movements
//
// Every change to on-hand stock is a movement: a request (written by the
// ERP portal) is validated and posted by the server, which updates the
// inventory record and writes an immutable ledger entry in the same
// transaction. Pure helpers, no Firebase dependency.
// ═══════════════════════════════════════════════════════════════

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const round2 = (v) => Math.round(num(v) * 100) / 100;

// sign: +1 adds stock, -1 removes it, 0 = count (sets on-hand to a figure).
// approval: may need a second admin above the value threshold.
const MOVEMENT_TYPES = {
  opening: {sign: 1, label: 'Opening stock', cost: true},
  receipt: {sign: 1, label: 'Goods received', cost: true},
  adjust_in: {sign: 1, label: 'Adjustment (+)', reason: true, approval: true},
  adjust_out: {sign: -1, label: 'Adjustment (−)', reason: true, approval: true},
  damage: {sign: -1, label: 'Damaged', reason: true, approval: true},
  expiry: {sign: -1, label: 'Expired', reason: true, approval: true},
  count: {sign: 0, label: 'Stock count', reason: true, approval: true},
  transfer_in: {sign: 1, label: 'Transfer in'},
  transfer_out: {sign: -1, label: 'Transfer out'},
  return_in: {sign: 1, label: 'Customer return', reason: true},
  // Posted only by the order bridge, never requested from the portal.
  sale: {sign: -1, label: 'Delivered to customer', system: true},
};

const DEFAULT_CONFIG = {approvalValue: 200, allowNegative: false};

/**
 * Checks a portal stock request before anything is posted.
 * @param {object} r Request document.
 * @return {string|null} Error message, or null when valid.
 */
function validateRequest(r) {
  const t = MOVEMENT_TYPES[r && r.type];
  if (!t || t.system) return 'Unknown movement type';
  if (!r.invId) return 'Stock item is required';
  if (r.type === 'count') {
    if (!(num(r.countedQty) >= 0) || r.countedQty === '' || r.countedQty == null) return 'Counted quantity is required';
  } else if (!(num(r.qty) > 0)) {
    return 'Quantity must be more than zero';
  }
  if (t.reason && !String(r.reason || '').trim()) return 'A reason is required';
  if (t.cost && r.unitCost != null && num(r.unitCost) < 0) return 'Unit cost cannot be negative';
  return null;
}

/**
 * Signed change to on-hand stock for a request against the current item.
 * @param {object} r
 * @param {object} inv Inventory record.
 * @return {number}
 */
function movementDelta(r, inv) {
  const t = MOVEMENT_TYPES[r.type];
  if (r.type === 'count') return round2(num(r.countedQty) - num(inv.qty));
  return round2(t.sign * num(r.qty));
}

const unitCostOf = (inv) => num(inv.avgCost) || num(inv.costPrice);

/**
 * Whether a request must wait for a second admin's approval.
 * @param {object} r
 * @param {object} inv
 * @param {object} config
 * @return {boolean}
 */
function needsApproval(r, inv, config = DEFAULT_CONFIG) {
  const t = MOVEMENT_TYPES[r.type];
  if (!t || !t.approval) return false;
  // A storeman's adjustment, damage, expiry or count always needs an admin.
  if (r.requestedByRole === 'storeman') return true;
  const value = Math.abs(movementDelta(r, inv)) * unitCostOf(inv);
  return value >= num(config.approvalValue);
}

/**
 * The approver must be a different person from the requester.
 * @param {object} r
 * @param {string} approverUid
 * @return {boolean}
 */
function canApprove(r, approverUid) {
  return !!approverUid && approverUid !== r.requestedBy;
}

/**
 * Works out the posting: new on-hand quantity, weighted average cost and
 * ledger entry. Receipts and opening stock with a unit cost re-average the
 * cost; outflows are valued at the current average.
 * @param {object} p
 * @param {object} p.request
 * @param {object} p.inventory Current inventory record.
 * @param {object} [p.config]
 * @param {string} p.nowIso
 * @return {{error: string}|{inventoryPatch: object, entry: object}}
 */
function computePosting({request: r, inventory: inv, config = DEFAULT_CONFIG, nowIso}) {
  const t = MOVEMENT_TYPES[r.type];
  const delta = movementDelta(r, inv);
  const qtyBefore = num(inv.qty);
  const qtyAfter = round2(qtyBefore + delta);
  if (qtyAfter < 0 && !config.allowNegative) {
    return {error: `Not enough stock: ${qtyBefore} on hand, movement needs ${Math.abs(delta)}`};
  }
  let avgCost = unitCostOf(inv);
  const unitCost = t.cost && r.unitCost != null && r.unitCost !== '' ? num(r.unitCost) : avgCost;
  if (t.cost && delta > 0) {
    const base = Math.max(0, qtyBefore);
    avgCost = base + delta > 0 ? (base * avgCost + delta * unitCost) / (base + delta) : unitCost;
  }
  avgCost = Math.round(avgCost * 10000) / 10000;
  return {
    inventoryPatch: {qty: qtyAfter, avgCost, lastMovementAt: nowIso},
    entry: {
      invId: r.invId,
      sku: inv.sku || '',
      name: inv.name || '',
      type: r.type,
      label: t.label,
      qty: delta,
      qtyBefore,
      qtyAfter,
      unitCost: round2(delta > 0 && t.cost ? unitCost : avgCost),
      value: round2(delta * (delta > 0 && t.cost ? unitCost : avgCost)),
      avgCostAfter: avgCost,
      ref: r.ref || '',
      reason: r.reason || '',
      requestedBy: r.requestedBy || '',
      requestedByName: r.requestedByName || '',
      approvedBy: r.approvedBy || '',
      at: nowIso,
    },
  };
}

/**
 * True when a posting takes an item from above its reorder level to at
 * or below it — the moment to alert admins once, not on every movement.
 * @param {number} before
 * @param {number} after
 * @param {number} minStock
 * @return {boolean}
 */
function crossedReorderLevel(before, after, minStock) {
  const min = num(minStock);
  return min > 0 && num(before) > min && num(after) <= min;
}

module.exports = {
  MOVEMENT_TYPES,
  DEFAULT_CONFIG,
  validateRequest,
  movementDelta,
  needsApproval,
  canApprove,
  computePosting,
  crossedReorderLevel,
};
