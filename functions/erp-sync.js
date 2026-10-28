// ═══════════════════════════════════════════════════════════════
// STFM → STSB ERP real-time bridge — pure mapping helpers
//
// The ERP portal shares the stfm-sales project and reads the stsb_*
// collections. These helpers turn Sales App documents (orders, manual
// invoices, deliveries and collections) into ERP records. They have no
// Firebase dependency so they can be unit-tested with plain Node.
// ═══════════════════════════════════════════════════════════════

const ERP_PREFIX = 'stsb';
const erpCol = (name) => `${ERP_PREFIX}_${name}`;

// Fields written back onto the Sales App doc by the bridge itself.
// A change touching only these must never trigger another sync.
const SYNC_META_FIELDS = [
  'erpSynced', 'erpSyncedAt', 'erpSyncError',
  '_syncedFromERP', '_syncedFromSales', '_syncedAt',
  'stockDeducted', 'stockDeductedAt', 'stockUnmatched', 'stockSyncError',
];

/**
 * True when nothing but sync metadata differs between two snapshots.
 * @param {object} before
 * @param {object} after
 * @return {boolean}
 */
function onlySyncMetaChanged(before, after) {
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  SYNC_META_FIELDS.forEach((k) => keys.delete(k));
  return ![...keys].some((k) => JSON.stringify((before || {})[k]) !== JSON.stringify((after || {})[k]));
}

/**
 * True when the update was written by the ERP → Sales back-sync
 * (it stamps _syncedFromERP and a fresh _syncedAt). Echoing that back
 * would overwrite the ERP's own, more specific status.
 * @param {object} before
 * @param {object} after
 * @return {boolean}
 */
function isErpOriginatedWrite(before, after) {
  return !!(after && after._syncedFromERP) &&
    JSON.stringify((before || {})._syncedAt) !== JSON.stringify(after._syncedAt);
}

// App order status → ERP status fields. Only applied when the app
// status differs from the appStatus last recorded on the ERP record,
// so ERP-side progress (processing, dispatched, …) is not clobbered by
// unrelated edits such as notes, and a late or retried event cannot
// lose a status change.
const ORDER_STATUS_MAP = {
  'Pending': {status: 'pending', deliveryStatus: 'pending'},
  'Confirmed': {status: 'pending', deliveryStatus: 'pending'},
  'Assigned': {deliveryStatus: 'assigned'},
  'In Transit': {deliveryStatus: 'in_transit'},
  'Delivered': {status: 'delivered', deliveryStatus: 'delivered'},
  'Failed': {deliveryStatus: 'failed'},
  'Cancelled': {status: 'cancelled', deliveryStatus: 'cancelled'},
};

/**
 * Orders held for discount or credit-limit approval stay out of the ERP until an
 * admin decides — the Sales App's documented business rule.
 * @param {object} o
 * @return {boolean}
 */
function isHeldFromErp(o) {
  return !!o.erpHeld ||
    (o.status === 'Pending' && !!o.discount && o.discount.status === 'pending') ||
    (!!o.creditHold && o.creditHold.status === 'pending');
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
// Firestore rejects undefined values; drop them rather than fail the sync.
const clean = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));

/**
 * Maps a Sales App order line to the ERP line shape.
 * @param {object} item
 * @return {object}
 */
function mapItem(item) {
  const qty = num(item.qty);
  const price = num(item.price);
  const discount = num(item.discount && item.discount.amount);
  const lineTotal = item._lineTotal != null ? num(item._lineTotal) : (price * qty) - discount;
  return {
    productId: item.pid || item.productId || '',
    name: item.name || '',
    sku: item.sku || '',
    qty,
    ctnQty: num(item.ctnQty),
    pcsQty: num(item.pcsQty),
    ctnSize: num(item.ctnSize),
    unit: item.unit || 'pcs',
    price,
    discount,
    total: lineTotal,
  };
}

/**
 * The ERP document id for a Sales App order: its human order number
 * (ORD-… / INV-…), which the client also used, falling back to the
 * Firestore doc id.
 * @param {object} o
 * @param {string} docId
 * @return {string}
 */
function erpOrderId(o, docId) {
  return String((o && o.id) || docId);
}

/**
 * Builds the ERP order payload for a Sales App order snapshot.
 * @param {object} p
 * @param {object} p.order   App order data (after the change).
 * @param {object|null} p.erpCurrent Existing ERP record (null when new).
 * @param {string} p.docId   App Firestore doc id.
 * @param {string|null} p.zoneId Zone the order belongs to.
 * @param {object} p.outlet  Outlet data ({} when unknown).
 * @param {string} p.nowIso  Current time as ISO string.
 * @return {object}
 */
function buildErpOrder({order: o, erpCurrent = null, docId, zoneId, outlet = {}, nowIso}) {
  const discountAmt = o.discount && o.discount.status === 'approved' ? num(o.discount.amount) : 0;
  const isInvoice = o.type === 'manual_invoice';
  const payload = {
    orderId: erpOrderId(o, docId),
    appDocId: docId,
    zoneId: zoneId || o.zoneId || o._zoneId || null,
    zone: zoneId || o.zoneId || o._zoneId || null,
    type: o.type || 'order',
    isInvoice,
    invoiceNo: isInvoice ? erpOrderId(o, docId) : (o.invoiceNo || undefined),
    customer: outlet.name || o.outletName || '',
    outletId: o.outletId || '',
    outletAddress: outlet.address || '',
    outletPhone: outlet.phone || '',
    outletRoute: outlet.route || '',
    repId: o.createdBy || '',
    repName: o.createdByName || '',
    items: Array.isArray(o.items) ? o.items.map(mapItem) : [],
    subtotal: num(o.subtotal != null ? o.subtotal : o.total),
    discount: discountAmt,
    discountStatus: o.discount ? (o.discount.status || 'pending') : 'not_required',
    total: num(o.total),
    payTerms: o.payTerms || 'COD',
    notes: o.notes || '',
    date: o.date || '',
    appStatus: o.status || '',
    approvedBy: o.approvedBy || '',
    approvedByName: o.approvedByName || '',
    approvedAt: o.approvedAt || '',
    deliveryManId: o.deliveryManId || '',
    deliveryManName: o.deliveryManName || '',
    inTransitAt: o.inTransitAt || '',
    deliveredAt: o.deliveredAt || '',
    deliveredBy: o.deliveredBy || '',
    failureReason: o.failureReason || o.failReason || '',
    failedAt: o.failedAt || '',
    cancelledAt: o.cancelledAt || '',
    cancelledBy: o.cancelledBy || '',
    stockDeducted: !!o.stockDeducted,
    deliveryDate: o.deliveryDate || undefined,
    deliveryOutcome: o.deliveryOutcome || '',
    partial: !!o.partial,
    deliveredItems: Array.isArray(o.deliveredItems) ? o.deliveredItems.map(mapItem) : undefined,
    deliveredTotal: o.deliveredTotal != null ? num(o.deliveredTotal) : undefined,
    receiverName: o.receiverName || '',
    hasProof: !!o.hasProof,
    source: 'sales_app',
    updatedAt: nowIso,
    _syncedFromSales: true,
  };

  const statusChanged = !erpCurrent || erpCurrent.appStatus !== o.status;
  if (statusChanged && ORDER_STATUS_MAP[o.status]) {
    Object.assign(payload, ORDER_STATUS_MAP[o.status]);
    if (o.status === 'Delivered' && o.partial) payload.deliveryStatus = 'partially_delivered';
  }
  if (!erpCurrent) {
    payload.collectionStatus = 'not_required';
    payload.createdAt = nowIso;
  }
  return clean(payload);
}

/**
 * Builds the ERP collection (payment) payload.
 * @param {object} p
 * @param {object} p.collection App collection data.
 * @param {string} p.docId
 * @param {string|null} p.zoneId
 * @param {object} p.outlet
 * @param {string} p.nowIso
 * @return {object}
 */
function buildErpCollection({collection: c, erpCurrent = null, docId, zoneId, outlet = {}, nowIso}) {
  const payload = clean({
    collectionId: c.id || docId,
    appDocId: docId,
    zoneId: zoneId || c.zoneId || c._zoneId || null,
    zone: zoneId || c.zoneId || c._zoneId || null,
    outletId: c.outletId || '',
    customer: outlet.name || c.outletName || '',
    orderRef: c.orderId || c.orderRef || '',
    amount: num(c.amount),
    method: c.mode || c.paymentMethod || '',
    date: c.date || '',
    notes: c.notes || '',
    repId: c.createdBy || '',
    repName: c.createdByName || '',
    submittedBy: c.createdBy || '',
    source: 'sales_app',
    updatedAt: nowIso,
    _syncedFromSales: true,
  });
  // New app collections wait for ERP acceptance; once the ERP has
  // accepted or rejected one, an app-side edit must not reset that.
  if (!erpCurrent) {
    payload.status = 'pending_erp';
    payload.createdAt = nowIso;
  }
  return payload;
}

/**
 * Out-of-order guard: Cloud Functions may deliver events late or retry
 * them, and every zone write fires twice (zone doc + root mirror). An
 * event older than the one that last wrote the ERP record is dropped.
 * @param {object|null} erpCurrent Existing ERP record.
 * @param {string} eventTime ISO time of the triggering write.
 * @return {boolean}
 */
function isStaleEvent(erpCurrent, eventTime) {
  return !!(erpCurrent && erpCurrent._srcEventTime && eventTime &&
    erpCurrent._srcEventTime > eventTime);
}

/**
 * Fields applied to an ERP record whose Sales App source was deleted.
 * Financial records are kept for the audit trail and only flagged.
 * @param {string} kind 'order' | 'collection'
 * @param {string} nowIso
 * @return {object}
 */
function deletionPatch(kind, nowIso) {
  const patch = {appDeleted: true, appDeletedAt: nowIso, updatedAt: nowIso};
  if (kind === 'order') {
    Object.assign(patch, {appStatus: 'Deleted', status: 'cancelled', deliveryStatus: 'cancelled'});
  } else {
    patch.status = 'void';
  }
  return patch;
}

// App statuses after which an ERP update must not move the order again.
const APP_FINAL = new Set(['Delivered', 'Cancelled']);

/**
 * ERP → App: works out the Sales App order update for an ERP-side change
 * (ERP dispatch, delivery confirmation, cancellation, driver assignment)
 * so the salesman and delivery staff see it immediately.
 * @param {object} before ERP record before the change.
 * @param {object} after  ERP record after the change.
 * @param {string} appStatus Current status of the Sales App order.
 * @return {object|null} Fields to merge into the app order, or null.
 */
function appPatchFromErp(before, after, appStatus) {
  if (!after || APP_FINAL.has(appStatus)) return null;
  const changed = (k) => JSON.stringify((before || {})[k]) !== JSON.stringify(after[k]);
  const patch = {};
  if (changed('status') || changed('deliveryStatus')) {
    if (after.status === 'cancelled') {
      patch.status = 'Cancelled';
    } else if (after.status === 'delivered' || after.deliveryStatus === 'delivered') {
      patch.status = 'Delivered';
      patch.deliveredAt = toIso(after.deliveredAt) || new Date().toISOString();
    } else if (after.status === 'dispatched' && appStatus !== 'In Transit') {
      patch.status = 'In Transit';
    } else if (after.deliveryStatus === 'failed' && appStatus !== 'Failed') {
      patch.status = 'Failed';
      patch.failureReason = after.failureReason || 'Marked failed in ERP';
    } else if (after.deliveryStatus === 'rescheduled') {
      // Back into the queue for a new delivery date.
      patch.status = after.deliveryManId ? 'Assigned' : 'Confirmed';
      patch.failureReason = '';
    }
  }
  if (changed('deliveryManId') && after.deliveryManId) {
    patch.deliveryManId = after.deliveryManId;
    patch.deliveryManName = after.deliveryManName || '';
    if (['Confirmed', 'Failed'].includes(appStatus) && !patch.status) patch.status = 'Assigned';
  }
  if (changed('deliveryDate') && after.deliveryDate) patch.deliveryDate = after.deliveryDate;
  if (changed('invoiceNo') && after.invoiceNo) patch.invoiceNo = after.invoiceNo;
  if (patch.status === appStatus) delete patch.status;
  if (changed('status')) patch.erpStatus = after.status || '';
  if (!Object.keys(patch).length) return null;
  patch.erpStatus = after.status || '';
  return patch;
}

function toIso(v) {
  if (!v) return '';
  if (typeof v === 'string') return v;
  if (typeof v.toDate === 'function') return v.toDate().toISOString();
  return '';
}

/**
 * True when an ERP order write came from the Sales → ERP bridge itself
 * (it stamps a new _srcEventTime); such writes must not echo back.
 * @param {object} before
 * @param {object} after
 * @return {boolean}
 */
function isBridgeWrite(before, after) {
  return JSON.stringify((before || {})._srcEventTime) !== JSON.stringify((after || {})._srcEventTime);
}

/**
 * Backfill: picks one source document per order/collection from a
 * collection-group read (root copy + zone copies). The zone copy wins
 * because it is the primary write; the root copy is a mirror.
 * @param {Array<{path: string, id: string, data: object, updateTime: string}>} docs
 * @param {function(object, string): string} keyOf ERP id for a doc.
 * @return {Array<{key: string, docId: string, zoneId: string|null, data: object, updateTime: string}>}
 */
function pickBackfillSources(docs, keyOf) {
  const out = {};
  docs.forEach((d) => {
    const parts = d.path.split('/');
    const zoneId = parts[0] === 'zones' && parts.length === 4 ? parts[1] : null;
    if (parts.length !== 2 && !zoneId) return; // ignore any other nesting
    const key = keyOf(d.data, d.id);
    const cur = out[key];
    if (!cur || (zoneId && !cur.fromZone)) {
      out[key] = {key, docId: d.id, fromZone: !!zoneId, zoneId: zoneId || d.data._zoneId || d.data.zoneId || null,
        data: d.data, updateTime: d.updateTime};
    }
  });
  return Object.values(out).map(({fromZone, ...src}) => src);
}

module.exports = {
  pickBackfillSources,
  appPatchFromErp,
  isBridgeWrite,
  ERP_PREFIX,
  erpCol,
  SYNC_META_FIELDS,
  ORDER_STATUS_MAP,
  onlySyncMetaChanged,
  isErpOriginatedWrite,
  isHeldFromErp,
  mapItem,
  erpOrderId,
  buildErpOrder,
  buildErpCollection,
  deletionPatch,
  isStaleEvent,
};
