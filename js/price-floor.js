// ═══════════════ MINIMUM PRICE: shared logic ═══════════════
// A product's minimum selling price (per pcs) is admin-only: it lives in
// productMinPrices/{productId} ({ minPrice, updatedAt, updatedBy }), which
// the Firestore rules let only admins and sub-admins read or write, so a
// salesman never sees it. Admins see it on the product, and when approving
// a discount they see, per item, the price after discount, the minimum and
// the last price this outlet paid. Used by js/orders.js, js/products.js and
// the unit tests.
(function (root) {
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const r2 = (v) => Math.round(v * 100) / 100;

  /** Gross value of an order line: cartons at the carton price plus loose pcs. */
  function lineGross(it) {
    if (it && it._lineTotal !== undefined && it._lineTotal !== null) return n(it._lineTotal);
    const ctnSize = n(it && it.ctnSize);
    const ctnPrice = it && it.ctnPrice !== undefined && it.ctnPrice !== null ? n(it.ctnPrice) : n(it && it.price) * (ctnSize || 1);
    if (ctnSize > 0 && (it.ctnQty !== undefined || it.pcsQty !== undefined)) {
      return n(it.ctnQty) * ctnPrice + n(it.pcsQty) * n(it.price);
    }
    return n(it && it.price) * n(it && it.qty);
  }

  /** Total pcs on a line. */
  function linePcs(it) {
    if (n(it && it.qty) > 0) return n(it.qty);
    return n(it && it.ctnQty) * (n(it && it.ctnSize) || 1) + n(it && it.pcsQty);
  }

  /**
   * Price per pcs after the line's discount, or null when the line has no pcs.
   * @param {object} it order line
   * @param {boolean} withDiscount count the line discount (false when it was rejected)
   */
  function netUnitPrice(it, withDiscount = true) {
    const pcs = linePcs(it);
    if (pcs <= 0) return null;
    const disc = withDiscount ? n(it && it.discount && it.discount.amount) : 0;
    return r2(Math.max(0, lineGross(it) - disc) / pcs);
  }

  /** Whether a discount on this past order counted (approved), for its last price. */
  function discountCounted(order) {
    const d = order && order.discount;
    return !!(d && d.status === 'approved');
  }

  const when = (o) => {
    const t = o && (o.createdAt || o.date);
    if (!t) return 0;
    if (typeof t.toMillis === 'function') return t.toMillis();
    if (typeof t.seconds === 'number') return t.seconds * 1000;
    const ms = Date.parse(t);
    return Number.isFinite(ms) ? ms : 0;
  };

  /**
   * The last price per pcs the outlet paid for each product, from its earlier
   * orders (cancelled ones and the order being approved are skipped).
   * @return {Object<string, {price: number, orderId: string, date: string}>}
   */
  function lastPrices(orders, excludeId) {
    const out = {};
    (orders || [])
      .filter((o) => o && o.status !== 'Cancelled' && o.id !== excludeId && o._docId !== excludeId)
      .sort((a, b) => when(b) - when(a))
      .forEach((o) => {
        (o.items || []).forEach((it) => {
          if (!it || !it.pid || out[it.pid]) return;
          const p = netUnitPrice(it, discountCounted(o));
          if (p !== null) out[it.pid] = { price: p, orderId: o.id || o._docId || '', date: String(o.date || '') };
        });
      });
    return out;
  }

  /**
   * Each line of an order checked against the minimum prices.
   * @param {Array} items order lines
   * @param {Object<string, number>} minPrices productId → minimum per pcs
   * @param {Object} last result of lastPrices()
   * @return {{lines: Array, belowMin: Array}}
   */
  function priceCheck(items, minPrices, last) {
    const lines = (items || []).map((it) => {
      const net = netUnitPrice(it, true);
      const min = minPrices && n(minPrices[it.pid]) > 0 ? n(minPrices[it.pid]) : null;
      const prev = last && last[it.pid] ? last[it.pid] : null;
      return {
        pid: it.pid, name: it.name || it.pid,
        listPrice: n(it.price), netPrice: net, minPrice: min,
        lastPrice: prev ? prev.price : null, lastOrderId: prev ? prev.orderId : '',
        belowMin: min !== null && net !== null && net + 1e-9 < min,
      };
    });
    return { lines, belowMin: lines.filter((l) => l.belowMin) };
  }

  /** A minimum price an admin types: a positive number, or null to clear it. */
  function parseMinPrice(v) {
    if (v === undefined || v === null || String(v).trim() === '') return null;
    const x = Number(v);
    if (!Number.isFinite(x) || x < 0) throw new Error('Minimum price must be a positive number');
    return x === 0 ? null : r2(x);
  }

  const api = { lineGross, linePcs, netUnitPrice, lastPrices, priceCheck, parseMinPrice };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  Object.assign(root, { PriceFloor: api });
})(typeof window !== 'undefined' ? window : globalThis);
