// ═══════════════ DELIVERY REPORT: shared logic ═══════════════
// Used by the ERP portal (vendor copy, Operations → Delivery Report) and the
// unit tests. Works on Sales App orders (root `orders`), where the delivery
// man's app records the outcome and the payment taken at the door:
//   status: Assigned → In Transit → Delivered | Failed
//   partial, deliveredItems, deliveredTotal, receiverName, failureReason,
//   paymentMethod: cash | cheque | online | pending, paymentAmount,
//   paymentStatus: paid | part_paid | pending, paymentRef, chequeBank, chequeDate
(function (root) {
  const PAY_METHODS = { cash: 'Cash', cheque: 'Cheque', online: 'Online', pending: 'Pending' };
  const n = (v) => Number(v) || 0;
  const rm = (v) => Math.round(v * 100) / 100;

  // Local calendar day (the browser's time zone) of an ISO time.
  function localDay(iso, tzOffsetMin) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d)) return '';
    const off = tzOffsetMin != null ? tzOffsetMin : -d.getTimezoneOffset();
    return new Date(d.getTime() + off * 60000).toISOString().slice(0, 10);
  }

  function outcomeOf(o) {
    if (o.status === 'Failed') return 'failed';
    if (o.status === 'Delivered') return o.partial ? 'partial' : 'full';
    if (o.status === 'In Transit') return 'in_transit';
    if (o.status === 'Assigned') return 'assigned';
    return '';
  }

  // One report row per order with a delivery man.
  function deliveryRow(o, tzOffsetMin) {
    const outcome = outcomeOf(o);
    const ordered = n(o.total);
    const delivered = outcome === 'full' || outcome === 'partial' ? (o.deliveredTotal != null ? n(o.deliveredTotal) : ordered) : 0;
    const method = outcome === 'full' || outcome === 'partial' ? (o.paymentMethod || 'unrecorded') : '';
    const collected = method && method !== 'pending' && method !== 'unrecorded' ? Math.min(n(o.paymentAmount), delivered) : 0;
    const items = o.items || [];
    const short = outcome === 'partial'
      ? items.map((it, i) => ({ name: it.name || 'Item', ordered: n(it.qty), delivered: n((o.deliveredItems || [])[i] && o.deliveredItems[i].qty) }))
        .filter((x) => x.delivered < x.ordered)
      : [];
    const at = o.deliveredAt || o.failedAt || o.inTransitAt || '';
    return {
      id: o.id || o._docId || '', docId: o._docId || '', outletId: o.outletId || '', outletName: o.outletName || '',
      dmId: o.deliveryManId || '', dmName: o.deliveryManName || '',
      outcome, at, day: localDay(o.deliveredAt || o.failedAt, tzOffsetMin), planned: o.deliveryDate || '',
      ordered: rm(ordered), delivered: rm(delivered), shortValue: rm(outcome === 'partial' ? Math.max(0, ordered - delivered) : 0),
      failedValue: rm(outcome === 'failed' ? ordered : 0),
      method, collected: rm(collected), pending: rm(Math.max(0, delivered - collected)),
      ref: o.paymentRef || '', chequeBank: o.chequeBank || '', chequeDate: o.chequeDate || '',
      receiver: o.receiverName || '', reason: o.failureReason || '', note: o.deliveryNote || '', short,
    };
  }

  // Finished deliveries in [from, to] (local days), optionally one driver,
  // plus the ones still out (any date), with totals and a per-driver sheet.
  function buildDeliveryReport(orders, { from, to, dm, tzOffsetMin } = {}) {
    const all = orders.filter((o) => o.deliveryManId && !o.appDeleted).map((o) => deliveryRow(o, tzOffsetMin))
      .filter((r) => !dm || r.dmId === dm);
    const done = all.filter((r) => (r.outcome === 'full' || r.outcome === 'partial' || r.outcome === 'failed')
      && (!from || r.day >= from) && (!to || r.day <= to))
      .sort((a, b) => String(b.at).localeCompare(String(a.at)));
    const out = all.filter((r) => r.outcome === 'assigned' || r.outcome === 'in_transit')
      .sort((a, b) => String(a.planned).localeCompare(String(b.planned)));
    const blank = () => ({ done: 0, full: 0, partial: 0, failed: 0, ordered: 0, delivered: 0, shortValue: 0, failedValue: 0,
      cash: 0, cheque: 0, online: 0, collected: 0, pending: 0, cheques: 0 });
    const add = (t, r) => {
      t.done++; t[r.outcome]++;
      t.ordered += r.ordered; t.delivered += r.delivered; t.shortValue += r.shortValue; t.failedValue += r.failedValue;
      if (r.method === 'cash' || r.method === 'cheque' || r.method === 'online') t[r.method] += r.collected;
      if (r.method === 'cheque' && r.collected > 0) t.cheques++;
      t.collected += r.collected; t.pending += r.pending;
    };
    const total = blank(), byDm = {};
    done.forEach((r) => { add(total, r); add(byDm[r.dmId] = byDm[r.dmId] || { ...blank(), dmId: r.dmId, dmName: r.dmName }, r); });
    const round = (t) => { for (const k of Object.keys(t)) if (typeof t[k] === 'number') t[k] = rm(t[k]); return t; };
    return {
      rows: done, out, total: round(total),
      drivers: Object.values(byDm).map(round).sort((a, b) => b.delivered - a.delivered),
    };
  }

  const api = { PAY_METHODS, localDay, outcomeOf, deliveryRow, buildDeliveryReport };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.DeliveryReport = api;
})(typeof window !== 'undefined' ? window : globalThis);
