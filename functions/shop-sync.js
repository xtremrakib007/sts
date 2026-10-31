// ═══════════════════════════════════════════════════════════════
// Online shop link: stfm-sales (ERP + Sales App) feeds the shop at
// stfreshmart.my (Firebase project stfreshperak).
//
//   ERP → shop  products, photos, price (Sales App price + markup %) and
//               the stock the ERP can still sell (on hand − reserved).
//   shop → ERP  every shop order becomes a Sales App order (source 'shop'),
//               so the ERP reserves, invoices and delivers it like any other;
//               its status is copied back to the shop order.
//
// Pure logic, tested in tests/shop-sync.test.js; the functions that read
// and write both projects are in index.js. Settings: stsb_config/shopSync.
// ═══════════════════════════════════════════════════════════════
const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const r2 = (v) => Math.round(v * 100) / 100;
// Firestore rejects undefined values.
const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
const key = (v) => String(v || '').trim().toLowerCase();

// markupPct is the guest price markup; memberMarkupPct is for registered
// customers (0 = the sales rep price).
const DEFAULT_CONFIG = {
  enabled: false, projectId: 'stfreshperak', markupPct: 0, memberMarkupPct: 0,
  ordersEnabled: true, registerCustomers: false,
};

/**
 * The shop document id for an ERP product: its SKU (the shop keys products
 * by upper-case SKU), or ERP-<product id> when it has none.
 * @param {object} p Sales App product (with id).
 * @return {string}
 */
function shopSku(p) {
  const sku = String(p.sku || '').trim().toUpperCase().replace(/[^A-Z0-9._-]/g, '-').replace(/^-+|-+$/g, '');
  return (sku || ('ERP-' + String(p.id || '').toUpperCase().replace(/[^A-Z0-9._-]/g, '-'))).slice(0, 100);
}

/**
 * Shop retail price: the Sales App price plus the markup, rounded to sen.
 * @param {number} price
 * @param {number} markupPct
 * @return {number}
 */
function shopPrice(price, markupPct) {
  return r2(Math.max(0, n(price)) * (1 + Math.max(0, n(markupPct)) / 100));
}

/**
 * Whole pieces the ERP can still sell for a product: the matching ERP stock
 * record's on-hand less reserved; without one, the product's own stock qty.
 * Marked out of stock → 0.
 * @param {object} p Sales App product.
 * @param {{bySku: object, byName: object}} invIndex ids by key (see order-controls).
 * @param {Object<string, object>} invById
 * @return {number}
 */
function availableStock(p, invIndex, invById) {
  if (p.stockStatus === 'out_of_stock') return 0;
  const invId = invIndex.bySku[key(p.sku)] || invIndex.byName[key(p.name)];
  const inv = invId && invById[invId];
  const qty = inv ? n(inv.qty) - n(inv.reservedQty) : n(p.stockQty);
  return Math.max(0, Math.floor(qty));
}

/**
 * The fields the ERP owns on the shop product. Promo price, price slabs and
 * staff prices stay the shop's own.
 * @param {object} p Sales App product (with id).
 * @param {number} stock From availableStock, less shop reservations not yet in the ERP.
 * @param {object} cfg stsb_config/shopSync
 * @param {string} nowIso
 * @return {object}
 */
function shopProduct(p, stock, cfg, nowIso) {
  const price = shopPrice(p.price, cfg.markupPct);
  return {
    sku: shopSku(p),
    name: String(p.name || '').slice(0, 200),
    description: String(p.description || '').slice(0, 2000),
    category: String(p.category || 'Other').slice(0, 100),
    unit: String(p.unit || 'PCS').toUpperCase().slice(0, 30),
    imageUrl: typeof p.photo === 'string' ? p.photo : '',
    retailPrice: price,
    stock: Math.max(0, Math.floor(n(stock))),
    // Products without a price cannot be sold online.
    status: price > 0 ? 'active' : 'hidden',
    erpManaged: true,
    erpProductId: String(p.id || ''),
    erpSku: String(p.sku || ''),
    erpSyncedAt: nowIso,
  };
}

/**
 * Price for a registered (logged-in) customer: the Sales App price plus the
 * member markup. Kept out of the public product (shop memberPrices/{SKU}).
 * @param {object} p
 * @param {object} cfg
 * @return {number}
 */
const memberPrice = (p, cfg) => shopPrice(p.price, cfg.memberMarkupPct);

// ── Customer accounts ──────────────────────────────────────────
// Every Sales App outlet with a mobile number gets a shop login: the number
// is the username (an internal e-mail is built from it), the first
// password is DEFAULT_PASSWORD and the shop asks for a new one at first login.
const DEFAULT_PASSWORD = 'ST1234';
const CUSTOMER_EMAIL_DOMAIN = 'customer.stfreshmart.my';

/**
 * Malaysian mobile number as 60XXXXXXXXX digits, or '' when it is not one.
 * @param {string} phone
 * @return {string}
 */
function normalizePhone(phone) {
  let d = String(phone || '').replace(/\D/g, '');
  if (d.startsWith('0')) d = '6' + d;
  else if (d.startsWith('1')) d = '60' + d;
  return /^601\d{8,9}$/.test(d) ? d : '';
}
const customerEmail = (digits) => `${digits}@${CUSTOMER_EMAIL_DOMAIN}`;
const customerUid = (digits) => `m${digits}`;

/**
 * Shop users/{uid} fields for an outlet's customer account. An account
 * shared by several outlets with one number keeps them all.
 * @param {object} outlet Sales App outlet (with id).
 * @param {object|null} cur Existing shop user doc.
 * @param {string} nowIso
 * @return {object}
 */
function customerUserDoc(outlet, cur, nowIso) {
  const ids = new Set([...(cur && Array.isArray(cur.erpOutletIds) ? cur.erpOutletIds : []), String(outlet.id)]);
  const doc = {
    role: (cur && cur.role) || 'customer',
    active: cur && cur.active === false ? false : true,
    name: String(outlet.name || (cur && cur.name) || '').slice(0, 120),
    phone: normalizePhone(outlet.phone),
    erpOutletId: (cur && cur.erpOutletId) || String(outlet.id),
    erpOutletIds: [...ids],
    erpManaged: true,
    updatedAt: nowIso,
  };
  if (!cur) {
    doc.createdAt = nowIso;
    doc.mustChangePassword = true;
  }
  return doc;
}

// ── Which salesman looks after a shop customer ─────────────────
/**
 * The salesman an outlet belongs to (same order of fields as the app).
 * @param {object|null} outlet
 * @return {string} user id or ''
 */
function outletSalesmanId(outlet) {
  return (outlet && (outlet.assignedRepId || outlet.assignedTo || outlet.repId || outlet.createdBy)) || '';
}

/**
 * Outlets by normalised mobile number.
 * @param {object[]} outlets with id
 * @return {Map<string, object[]>}
 */
function outletPhoneIndex(outlets) {
  const idx = new Map();
  for (const o of outlets) {
    const d = normalizePhone(o.phone);
    if (!d) continue;
    if (!idx.has(d)) idx.set(d, []);
    idx.get(d).push(o);
  }
  return idx;
}

/**
 * A guest's phone number matched to an outlet. Several outlets with the
 * number count as a match only when they all have the same salesman.
 * @param {Map<string, object[]>} idx
 * @param {string} phone
 * @return {{outlet: object, salesmanId: string, others: number}|null}
 */
function matchOutletByPhone(idx, phone) {
  const list = idx.get(normalizePhone(phone)) || [];
  if (!list.length) return null;
  const reps = new Set(list.map(outletSalesmanId));
  if (reps.size !== 1) return null;
  return {outlet: list[0], salesmanId: [...reps][0], others: list.length - 1};
}

/** What a shop product the ERP no longer has becomes (kept for old orders). */
const removedShopProduct = (nowIso) => ({status: 'hidden', stock: 0, erpSyncedAt: nowIso});

/**
 * True when nothing the shop shows would change (skips needless writes,
 * which would also wake the shop's own listeners).
 * @param {object|null} cur Current shop product.
 * @param {object} next
 * @return {boolean}
 */
function sameShopProduct(cur, next) {
  if (!cur) return false;
  return Object.keys(next).every((k) => k === 'erpSyncedAt' || JSON.stringify(cur[k]) === JSON.stringify(next[k]));
}

/**
 * Shop orders not in the ERP yet still hold shop stock that the ERP does not
 * know about; the synced stock must leave it out or it would be sold twice.
 * @param {object[]} shopOrders
 * @return {Object<string, number>} pieces by shop SKU
 */
function pendingShopReservations(shopOrders) {
  const out = {};
  for (const o of shopOrders) {
    if (o.erpOrderId || o.status === 'Cancelled' || o.status === 'Delivered') continue;
    if (o.stockReserved !== true && o.stockDeducted !== true) continue;
    for (const it of (Array.isArray(o.items) ? o.items : [])) {
      const sku = String(it.sku || '').trim().toUpperCase();
      if (sku) out[sku] = (out[sku] || 0) + Math.max(0, n(it.qty));
    }
  }
  return out;
}

/**
 * Should this shop order be brought into the ERP? Only new orders (placed
 * after the link was switched on), not yet imported and not cancelled.
 * @param {object} o Shop order.
 * @param {object} cfg
 * @return {boolean}
 */
function shouldImport(o, cfg) {
  if (!cfg.enabled || cfg.ordersEnabled === false) return false;
  if (o.erpOrderId || o.status === 'Cancelled') return false;
  if (!Array.isArray(o.items) || !o.items.length) return false;
  const created = toMillis(o.createdAt);
  const since = cfg.ordersSince ? Date.parse(cfg.ordersSince) : 0;
  return !(since && created && created < since);
}

function toMillis(v) {
  if (!v) return 0;
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (typeof v === 'string') return Date.parse(v) || 0;
  if (typeof v._seconds === 'number') return v._seconds * 1000;
  return 0;
}

const myDate = (ms) => new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 10);

/**
 * The Sales App order for a shop order. It has no outlet: the shop
 * customer's name, phone and address travel on the order itself.
 * @param {object} p
 * @param {string} p.shopOrderId
 * @param {object} p.order Shop order.
 * @param {Object<string, object>} p.shopProducts shop products by SKU (for erpProductId).
 * @param {number} p.nowMs
 * @param {object|null} [p.outlet] The customer's Sales App outlet (registered customers).
 * @param {object|null} [p.salesman] {id, name, by: 'account'|'phone', outletId, outletName}: who looks
 *   after this customer. Shown on the order only; it is not the order's creator, so it does not
 *   count in that salesman's sales.
 * @return {object}
 */
function appOrderFromShop({shopOrderId, order: o, shopProducts = {}, nowMs, outlet = null, salesman = null}) {
  const c = o.customer || {};
  const d = o.delivery || {};
  const pickup = o.method === 'SELF PICKUP';
  const address = pickup ? 'Self pickup' : [d.address, d.city, d.postcode, d.state].filter(Boolean).join(', ');
  const items = (o.items || []).map((it) => {
    const sku = String(it.sku || '').trim().toUpperCase();
    const sp = shopProducts[sku] || {};
    const qty = Math.max(0, n(it.qty));
    const price = n(it.price);
    return {
      // The ERP's own SKU and name, so its stock record is found.
      pid: sp.erpProductId || '', name: String(sp.name || it.name || sku),
      sku: sp.erpSku != null ? sp.erpSku : (sku.startsWith('ERP-') ? '' : sku),
      qty, pcsQty: qty, ctnQty: 0, ctnSize: 1, unit: String(it.unit || 'pcs').toLowerCase(),
      price, _lineTotal: r2(qty * price),
    };
  });
  const total = r2(n(o.total) || items.reduce((s, it) => s + it._lineTotal, 0));
  const when = [d.date, d.time].filter(Boolean).join(' ');
  const created = toMillis(o.createdAt) || nowMs;
  const nowIso = new Date(nowMs).toISOString();
  return clean({
    id: 'WEB-' + String(shopOrderId).slice(0, 10).toUpperCase(),
    source: 'shop',
    shopOrderId,
    // A registered customer's order goes on their outlet's account.
    outletId: outlet ? String(outlet.id) : '',
    outletName: outlet ? String(outlet.name || '') : '🛒 ' + String(c.name || 'Online customer').slice(0, 120),
    zoneId: outlet && (outlet.zoneId || outlet._zoneId) || undefined,
    customer: {name: String(c.name || ''), phone: String(c.phone || ''), company: String(c.company || ''), email: String(c.email || '')},
    deliveryMethod: o.method || '',
    deliveryAddress: address,
    deliveryDate: d.date || undefined,
    items,
    requestedItems: [],
    subtotal: total,
    total,
    payTerms: 'COD',
    date: myDate(created),
    status: 'Confirmed',
    notes: ['Online shop order', pickup ? `Pickup by ${d.collector || c.name || ''}${d.collectorPhone ? ' (' + d.collectorPhone + ')' : ''}` : '',
      when ? 'When: ' + when : '', d.instructions || d.notes || '', `Phone: ${c.phone || ''}`].filter(Boolean).join(' · '),
    outletRepId: salesman && salesman.id ? salesman.id : undefined,
    outletRepName: salesman && salesman.name ? salesman.name : undefined,
    repMatchedBy: salesman && salesman.id ? salesman.by : undefined,
    matchedOutletId: salesman && salesman.by === 'phone' ? salesman.outletId : undefined,
    matchedOutletName: salesman && salesman.by === 'phone' ? salesman.outletName : undefined,
    createdBy: '',
    createdByName: 'Online shop', repName: 'Online shop',
    approvedBy: '', approvedByName: 'Online shop', approvedAt: nowIso,
    erpSynced: false, erpHeld: false, creditHold: null,
    discount: null,
  });
}

// Sales App status → shop status (the shop's own steps).
const SHOP_STATUS = {
  'Pending': 'Accepted', 'Confirmed': 'Accepted', 'Assigned': 'Preparing',
  'In Transit': 'Out For Delivery', 'Delivered': 'Delivered', 'Failed': 'Ready', 'Cancelled': 'Cancelled',
};

/**
 * Patch for the shop order when its ERP order moves on, or null.
 * @param {object} appOrder
 * @param {object} shopOrder
 * @return {object|null}
 */
function shopStatusPatch(appOrder, shopOrder) {
  const to = SHOP_STATUS[appOrder.status];
  if (!to || to === shopOrder.status) return null;
  const patch = {status: to, erpStatus: appOrder.status};
  if (appOrder.status === 'Failed') patch.erpNote = appOrder.failureReason || appOrder.failReason || 'Delivery missed — will be rescheduled';
  if (appOrder.status === 'Cancelled') patch.cancellationReason = appOrder.cancelReason || 'Cancelled by the store';
  if (appOrder.status === 'Delivered' && Array.isArray(appOrder.deliveredItems)) {
    patch.deliveredItems = appOrder.deliveredItems.map((it) => ({name: it.name || '', sku: it.sku || '', qty: n(it.qty)}));
    if (appOrder.deliveredTotal != null) patch.deliveredTotal = n(appOrder.deliveredTotal);
  }
  return patch;
}

module.exports = {
  DEFAULT_CONFIG, shopSku, shopPrice, memberPrice, DEFAULT_PASSWORD, CUSTOMER_EMAIL_DOMAIN,
  normalizePhone, customerEmail, customerUid, customerUserDoc,
  outletSalesmanId, outletPhoneIndex, matchOutletByPhone, availableStock, shopProduct, removedShopProduct, sameShopProduct,
  pendingShopReservations, shouldImport, appOrderFromShop, shopStatusPatch, SHOP_STATUS, toMillis,
};
