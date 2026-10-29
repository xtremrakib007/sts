// ═══════════════ ORDERS ═══════════════

// ── ERP config ──────────────────────────────────────────────────────────────
// ERP uses tenant-prefixed Firestore collections: stsb_orders, stsb_inventory
const ERP_TENANT_PREFIX = 'stsb';
function erpCol(name) { return `${ERP_TENANT_PREFIX}_${name}`; }

// ── Stock cache — loaded from stsb_inventory, keyed by SKU ──────────────────
let _stockMap = {}; // { [sku]: { qty, reservedQty, name, unit, ctnSize } }
let _stockLoaded = false;

async function _loadStock() {
  try {
    const snap = await window.__SF.getDocs(
      window.__SF.collection(window.__SF.db, erpCol('inventory'))
    );
    _stockMap = {};
    snap.docs.forEach(d => {
      const v = d.data();
      // Key by SKU (primary) and also by name (fallback matching)
      const key = (v.sku || v.name || '').toLowerCase().trim();
      if (key) _stockMap[key] = { id: d.id, ...v };
    });
    _stockLoaded = true;
  } catch(e) {
    console.warn('[Stock] Failed to load inventory:', e.message);
  }
}

// Find stock record for a product — match by SKU first, then name
function _getStock(product) {
  if (!product) return null;
  const skuKey = (product.sku || '').toLowerCase().trim();
  const nameKey = (product.name || '').toLowerCase().trim();
  return _stockMap[skuKey] || _stockMap[nameKey] || null;
}

// Available qty = total qty - reserved
function _availableQty(stock) {
  if (!stock) return null;
  const qty = stock.qty || 0;
  const reserved = stock.reservedQty || 0;
  return Math.max(0, qty - reserved);
}

// ── Live order listener ──────────────────────────────────────────────────────
// Keeps the orders / deliveries / dashboard views current when the ERP or
// another user changes an order (delivery assignment, status, approval).
// Changes this device makes itself are skipped — their callers already reload.
let _ordersUnsub = null;
let _ordersLiveTimer = null;

function startOrdersLiveListener() {
  stopOrdersLiveListener();
  try {
    const {onSnapshot, query, where} = window.__SF;
    const ref = col('orders');
    const q = isAdmin() ? ref
      : isDeliveryMan() ? query(ref, where('deliveryManId','==',CU.uid))
      : query(ref, where('createdBy','==',CU.uid));
    let first = true;
    _ordersUnsub = onSnapshot(q, snap => {
      if (first) { first = false; return; }
      if (snap.metadata.hasPendingWrites || !snap.docChanges().length) return;
      clearTimeout(_ordersLiveTimer);
      _ordersLiveTimer = setTimeout(_refreshActiveOrderViews, 800);
    }, err => console.warn('[orders live]', err.message));
  } catch(e) { console.warn('startOrdersLiveListener', e.message); }
}

function stopOrdersLiveListener() {
  clearTimeout(_ordersLiveTimer);
  if (_ordersUnsub) { _ordersUnsub(); _ordersUnsub = null; }
}

function _refreshActiveOrderViews() {
  const pg = document.querySelector('.page.active')?.id || '';
  if (typeof invalidateCache === 'function') invalidateCache();
  if (typeof invalidateDashCache === 'function') invalidateDashCache();
  if (pg === 'pageOrders') loadOrders();
  else if (pg === 'pageDeliveries') loadDeliveries();
  else if (pg === 'pageDelivery') loadMyDeliveries();
  else if (pg === 'pageDashboard') renderDashboard();
  if (typeof updateBadges === 'function') updateBadges();
}

async function loadOrders() {
  const srch=document.getElementById('ordSrch')?.value.toLowerCase()||'';
  const statusF=document.getElementById('ordStatus')?.value||'';
  const repF=document.getElementById('ordRepFilter')?.value||'';
  const dateFrom=document.getElementById('ordDateFrom')?.value||'';
  const dateTo=document.getElementById('ordDateTo')?.value||'';

  if(isAdmin()){
    const rf=document.getElementById('ordRepFilter');
    if(rf){
      rf.style.display='';
      if(rf.options.length===1){
        allUsers.forEach(u=>{const o=document.createElement('option');o.value=u.uid;o.textContent=u.name;rf.appendChild(o);});
      }
    }
    document.getElementById('ordersRoleNote').textContent='Admins can approve and manage all orders. Delivery is managed by ERP.';
  } else {
    document.getElementById('ordersRoleNote').textContent='You can create orders. Approval and delivery is handled by admin/ERP.';
  }

  const {where}=window.__SF;
  const ordDocs = isAdmin()&&repF ? await sfGet('orders',[where('createdBy','==',repF)])
    : isAdmin() ? await sfGet('orders')
    : await sfGet('orders',[where('createdBy','==',CU.uid)]);

  let orders=ordDocs.map(d=>({_docId:d.id,...d.data()}));
  if(srch)orders=orders.filter(o=>(o.id||o._docId).toLowerCase().includes(srch)||outletName(o.outletId).toLowerCase().includes(srch)||userName(o.createdBy).toLowerCase().includes(srch));
  if(statusF)orders=orders.filter(o=>o.status===statusF);
  if(dateFrom)orders=orders.filter(o=>o.date>=dateFrom);
  if(dateTo)orders=orders.filter(o=>o.date<=dateTo);
  orders.sort((a,b)=>(b.createdAt?.seconds||0)-(a.createdAt?.seconds||0));

  const sBadge={Pending:'bdg-ylw',Confirmed:'bdg-blu',Delivered:'bdg-grn',Cancelled:'bdg-red'};
  const tbody=document.getElementById('ordersTbody');
  tbody.innerHTML=orders.map(o=>{
    const hasDiscount=o.discount&&o.discount.amount>0;
    const discPending=hasDiscount&&o.discount.status==='pending';
    const discApproved=hasDiscount&&o.discount.status==='approved';
    const discRejected=hasDiscount&&o.discount.status==='rejected';
    const creditPending=!!(o.creditHold&&o.creditHold.status==='pending');
    const discBadge=hasDiscount
      ?`<span class="bdg ${discApproved?'bdg-grn':discRejected?'bdg-red':'bdg-ylw'}" style="font-size:10px;margin-left:4px" title="Discount: ${o.discount.type==='percent'?o.discount.value+'%':fmt(o.discount.amount)}">🏷️${discPending?'?':discApproved?'✓':'✕'}</span>`:'';
    const erpBadge=o.erpSynced
      ?`<span class="bdg bdg-grn" style="font-size:9px;margin-left:4px" title="Synced to ERP">ERP✓</span>`
      :o.erpHeld
        ?`<span class="bdg bdg-ylw" style="font-size:9px;margin-left:4px" title="Held — awaiting ${creditPending?'credit':'discount'} approval">ERP⏳</span>`
        :`<span class="bdg bdg-gry" style="font-size:9px;margin-left:4px" title="Pending ERP sync">ERP?</span>`;
    return`<tr>
    <td><span style="font-family:'Syne',sans-serif;font-weight:700;font-size:12px">${o.id||o._docId}</span>${erpBadge}</td>
    <td style="font-size:12px">${outletName(o.outletId)}</td>
    <td style="font-size:12px;color:var(--tx2)">${userName(o.createdBy)}</td>
    <td style="font-size:12px;color:var(--tx2)">${o.items?.length||0} item${(o.items?.length||0)!==1?'s':''}</td>
    <td><span style="font-family:'Syne',sans-serif;font-weight:700;color:var(--acc)">${fmt(o.total)}</span>${discBadge}</td>
    <td style="font-size:12px;color:var(--tx2)">${o.date||'—'}</td>
    <td><span class="bdg ${sBadge[o.status]||'bdg-gry'}">${o.status}</span>${discPending?'<span class="bdg bdg-ylw" style="font-size:9px;margin-left:3px">🏷️ Disc?</span>':''}${creditPending?`<span class="bdg bdg-red" style="font-size:9px;margin-left:3px" title="Over credit limit by ${fmt(o.creditHold.exceededBy)}">💳 Credit?</span>`:''}</td>
    <td style="font-size:11px;color:var(--tx3)">ERP</td>
    <td>
      <div style="display:flex;gap:5px;flex-wrap:wrap">
        <button class="btn btn-ghost btn-xs" onclick="viewOrder('${o._docId}')">👁</button>
        ${isAdmin()&&creditPending?`<button class="btn btn-ylw btn-xs" onclick="approveCredit('${o._docId}',true)" title="Approve over credit limit">💳 Approve</button><button class="btn btn-red btn-xs" onclick="approveCredit('${o._docId}',false)" title="Reject — cancels the order">✕ Credit</button>`:''}
        ${isAdmin()&&discPending?`<button class="btn btn-ylw btn-xs" onclick="approveDiscount('${o._docId}',true)" title="Approve discount & send to ERP">🏷️ Approve</button><button class="btn btn-red btn-xs" onclick="approveDiscount('${o._docId}',false)" title="Reject discount & send to ERP at full price">✕ Disc</button>`:''}
        ${_appOrderEditable(o)?`<button class="btn btn-ghost btn-xs" title="Edit / add products" onclick="editMyOrder('${o._docId}')">✏️</button>`:''}
        ${!isAdmin()&&_appOrderEditable(o)?`<button class="btn btn-red btn-xs" title="Cancel order" onclick="cancelMyOrder('${o._docId}')">✕</button>`:''}
        ${isAdmin()&&(o.status==='Pending'||o.status==='Confirmed')&&!discPending?`<button class="btn btn-red btn-xs" onclick="cancelOrder('${o._docId}')">✕</button>`:''}
        ${isStrictAdmin()?`<button class="btn btn-red btn-xs" onclick="deleteOrder('${o._docId}','Order ${o.id||o._docId}','${o._zoneId||""}')" title="Permanently delete">🗑</button>`:''}
      </div>
    </td>
  </tr>`;}).join('')||'<tr><td colspan="9" style="text-align:center;padding:24px;color:var(--tx3)">No orders found</td></tr>';

  updateBadges();
}

// ═══════════════ ORDER CATALOG (Full-screen, mobile-first) ═══════════════
let ocSelectedCat = null;
let qpProduct = null;
let qpUnit = 'pcs';
let qpQty = 1;
let qpCtnQty = 0; // separate ctn input
let qpPcsQty = 0; // separate pcs input

async function openNewOrder(preselectedOutletId=null) {
  if(!isAdmin()) {
    const {where:wci}=window.__SF;
    const todayAttDocs=await sfGet('attendance',[wci('userId','==',CU.uid)]);
    const hasCheckedIn=todayAttDocs.some(d=>d.data().date===todayStr());
    if(!hasCheckedIn){
      showToast('You must check in first before placing an order.','warn');
      goPage('attendance');
      return;
    }
  }
  if(!allProducts.length || !allOutlets.length) await loadCachedData();
  const available=allProducts.filter(p=>p.stockStatus!=='out_of_stock');
  if(!available.length){showToast('No products in stock. Add products first.','warn');return;}

  // Load stock from ERP inventory
  await _loadStock();

  ordItems=[];
  _ocDraft={};

  const routeSel=document.getElementById('ordRoute');
  if(routeSel){
    routeSel.innerHTML='<option value="">All Routes</option>'+
      allRoutes.map(r=>`<option value="${r.id}">${r.name}</option>`).join('');
  }

  const visibleOutlets=isAdmin()?allOutlets:allOutlets.filter(o=>o.createdBy===CU.uid||o.assignedRepId===CU.uid);
  window._ocAllOutlets=visibleOutlets.filter(o=>o.balanceStatus!=='pending'||!o.openingBalance);
  _ocPopulateOutlets('');
  document.getElementById('ordDate').value=todayStr();
  document.getElementById('ordNotes').value='';

  const oc=document.getElementById('orderCatalog');
  oc.style.display='flex';
  document.body.style.overflow='hidden';

  if(preselectedOutletId){
    const targetOutlet=allOutlets.find(o=>o.id===preselectedOutletId);
    if(targetOutlet){
      document.getElementById('ordOutlet').value=preselectedOutletId;
      document.getElementById('ocStep1').style.display='none';
      document.getElementById('ocStep2').style.display='flex';
      document.getElementById('ocStep3').style.display='none';
      document.getElementById('ocOutletLabel').textContent=targetOutlet.name;
      ocRenderCatalog();
      showToast(`📦 Order for ${targetOutlet.name}`,'info');
      return;
    }
  }

  document.getElementById('ocStep1').style.display='flex';
  document.getElementById('ocStep2').style.display='none';
  document.getElementById('ocStep3').style.display='none';
}

function _ocPopulateOutlets(routeId) {
  const outlets = routeId
    ? (window._ocAllOutlets||[]).filter(o=>o.routeId===routeId)
    : (window._ocAllOutlets||[]);
  const sel=document.getElementById('ordOutlet');
  if(sel) sel.innerHTML='<option value="">Select outlet...</option>'+
    outlets.map(o=>`<option value="${o.id}">${o.name}${o.route?' ('+o.route+')':''}</option>`).join('');
}

function ocFilterOutletsByRoute() {
  const routeId=document.getElementById('ordRoute')?.value||'';
  _ocPopulateOutlets(routeId);
  document.getElementById('ordOutlet').value='';
}

function closeOrderCatalog(){
  document.getElementById('orderCatalog').style.display='none';
  document.body.style.overflow='';
}

function ocGoProducts(){
  const outletId=document.getElementById('ordOutlet').value;
  if(!outletId){showToast('Select an outlet first','warn');return;}
  const outName=outletName(outletId);
  document.getElementById('ocOutletLabel').textContent=outName;
  document.getElementById('ocStep1').style.display='none';
  document.getElementById('ocStep2').style.display='flex';
  const srch=document.getElementById('ocSearch');if(srch)srch.value='';
  const bar=document.getElementById('ocCatBar');if(bar)bar.style.display='flex';
  ocRenderCatalog();
}

function ocBack(){
  document.getElementById('ocStep2').style.display='none';
  document.getElementById('ocStep1').style.display='flex';
}

function ocGoCart(){
  const open=Object.keys(_ocDraft).filter(pid=>{const p=allProducts.find(x=>x.id===pid),d=_ocDraft[pid];return p&&_ocBuildItem(p,d.ctnQty,d.pcsQty);});
  if(open.length&&!confirm(`${open.length} product(s) have a quantity but were not added to the cart:\n\n${open.map(pid=>'• '+(allProducts.find(x=>x.id===pid)?.name||pid)).join('\n')}\n\nGo to the cart without them?`))return;
  document.getElementById('ocStep2').style.display='none';
  document.getElementById('ocStep3').style.display='flex';
  ocRenderCart();
}

function ocBackToProducts(){
  document.getElementById('ocStep3').style.display='none';
  document.getElementById('ocStep2').style.display='flex';
  const srch=document.getElementById('ocSearch');if(srch)srch.value='';
  const bar=document.getElementById('ocCatBar');if(bar)bar.style.display='flex';
  ocRenderCatalog();
  ocUpdateCartBtn();
}

function ocSearchProducts() {
  const q = (document.getElementById('ocSearch')?.value || '').toLowerCase().trim();
  if (!q) { ocRenderCatalog(); return; }
  const matches = allProducts.filter(p =>
    p.stockStatus !== 'out_of_stock' &&
    (p.name?.toLowerCase().includes(q) ||
     p.category?.toLowerCase().includes(q) ||
     p.unit?.toLowerCase().includes(q))
  );
  const list = document.getElementById('ocProductList');
  list.innerHTML = matches.length
    ? `<div class="oc-prod-list" style="padding-top:4px">${matches.map(p => ocProductCard(p)).join('')}</div>`
    : `<div style="text-align:center;padding:40px;color:var(--tx3)">No products found for "<strong>${q}</strong>"</div>`;
  const bar = document.getElementById('ocCatBar');
  if (bar) bar.style.display = q ? 'none' : 'flex';
  if (window._ocObserver) window._ocObserver.disconnect();
}

function ocRenderCatalog(){
  const available=allProducts.filter(p=>p.stockStatus!=='out_of_stock');
  const grouped={};
  available.forEach(p=>{
    const c=p.category||'Other';
    if(!grouped[c])grouped[c]=[];
    grouped[c].push(p);
  });
  const cats=Object.keys(grouped).sort();

  const bar=document.getElementById('ocCatBar');
  bar.innerHTML=`<button class="oc-cat-pill active" id="ocCat-all" onclick="ocScrollToAll()">🏷️ All</button>`+
    cats.map(c=>`<button class="oc-cat-pill" id="ocCat-${CSS.escape(c)}" onclick="ocScrollToCat('${c.replace(/'/g,"\\'")}')">
      ${getCatEmoji(c)} ${c} <span style="font-size:10px;opacity:.6">${grouped[c].length}</span>
    </button>`).join('');

  const list=document.getElementById('ocProductList');
  list.innerHTML=cats.map(cat=>`
    <div class="oc-cat-section" data-cat="${cat}" id="ocSec-${cat.replace(/\s+/g,'_')}">
      <div class="oc-cat-heading">${getCatEmoji(cat)} ${cat}</div>
      <div class="oc-prod-list">
        ${grouped[cat].map(p=>ocProductCard(p)).join('')}
      </div>
    </div>`).join('');

  ocUpdateCartBtn();

  if(window._ocObserver) window._ocObserver.disconnect();
  const sections=list.querySelectorAll('.oc-cat-section');
  window._ocObserver=new IntersectionObserver(entries=>{
    entries.forEach(e=>{
      if(e.isIntersecting){
        document.querySelectorAll('.oc-cat-pill').forEach(p=>p.classList.remove('active'));
        const id='ocCat-'+CSS.escape(e.target.dataset.cat);
        const pill=document.getElementById(id);
        if(pill){
          pill.classList.add('active');
          pill.scrollIntoView({behavior:'smooth',block:'nearest',inline:'center'});
        }
      }
    });
  },{root:list,threshold:0.3});
  sections.forEach(s=>window._ocObserver.observe(s));
}

// ── Product card: photo · name · price · category · + button. Tapping +
// opens CTN/PCS steppers and an item discount on the card; nothing goes
// into the cart until the rep presses "Add to cart". A product already in
// the cart shows its line, with Edit to change it.
let _ocDraft = {}; // pid → { ctnQty, pcsQty, discount: {type, value} } being entered

// Pieces per carton; products without one count a carton as 1 pcs.
function _ocCtnSize(p) { return Number(p.ctnSize ?? p.ctn_size) || 1; }

function ocProductCard(p){
  const item = ordItems.find(x=>x.pid===p.id);
  const draft = _ocDraft[p.id];
  const photo = p.photo
    ? `<img src="${escH(p.photo)}" alt="" loading="lazy"><button class="oc-zoom" onclick="event.stopPropagation();ocZoomPhoto('${p.id}')" aria-label="View photo">🔍</button>`
    : '<span class="oc-noimg">📦</span>';
  const ctnSz = p.ctnSize ?? p.ctn_size ?? 0;
  const ctnPr = p.ctnPrice ?? p.ctn_price ?? null;
  const stock = _getStock(p);
  const avail = _availableQty(stock);
  let stockTag = '';
  if (avail !== null) {
    const cls = avail <= 0 ? 'out' : avail <= (stock.minStock || 5) ? 'low' : 'ok';
    stockTag = `<span class="oc-stock ${cls}">${avail <= 0 ? 'Out of stock' : avail + ' ' + escH(stock.unit || p.unit || 'pcs') + ' left'}</span>`;
  }
  const mainPrice = ctnSz > 0 && ctnPr ? ctnPr : p.price;
  const subPrice = ctnSz > 0 && ctnPr
    ? `<div class="oc-sub">${fmt(p.price)} / pcs · ${ctnSz} pcs per ctn</div>` : '';
  const action = draft ? ''
    : item ? `<button class="oc-incart" onclick="ocOpenDraft('${p.id}')" aria-label="Edit ${escH(p.name)} in cart">✓ ${escH(item.qtyDisplay)}<span>Edit</span></button>`
    : `<button class="oc-plus" onclick="ocOpenDraft('${p.id}')" aria-label="Add ${escH(p.name)}">+</button>`;
  return `<div class="oc-row${item ? ' oc-in-cart' : ''}${draft ? ' oc-drafting' : ''}" id="ocProd-${p.id}">
    <div class="oc-row-main">
      <div class="oc-row-photo">${photo}</div>
      <div class="oc-row-info">
        <div class="oc-row-name">${escH(p.name)}</div>
        <div class="oc-row-price">${fmt(mainPrice)}${ctnSz > 0 && ctnPr ? '<span>/ctn</span>' : ''}</div>
        ${subPrice}
        <div class="oc-row-cat">${escH(p.category || '')} ${stockTag}</div>
      </div>
      ${action}
    </div>
    ${draft ? _ocCardEditor(p, draft, !!item) : ''}
  </div>`;
}

function _ocStepper(pid, unit, val, label) {
  return `<div class="oc-step">
    <span class="oc-step-lbl">${label}</span>
    <button onclick="ocStepQty('${pid}','${unit}',-1)" aria-label="Less ${label}">−</button>
    <input type="number" inputmode="numeric" min="0" value="${val || 0}" onchange="ocSetQty('${pid}','${unit}',this.value)" onfocus="this.select()">
    <button onclick="ocStepQty('${pid}','${unit}',1)" aria-label="More ${label}">+</button>
  </div>`;
}

function _ocCardEditor(p, draft, inCart) {
  const d = draft.discount || { type: '', value: 0 };
  const line = _ocBuildItem(p, draft.ctnQty, draft.pcsQty, d);
  return `<div class="oc-edit">
    <div class="oc-edit-qty">
      ${_ocStepper(p.id, 'ctn', draft.ctnQty, 'CTN')}
      ${_ocStepper(p.id, 'pcs', draft.pcsQty, 'PCS')}
    </div>
    <div class="oc-edit-disc">
      <select onchange="ocCardDiscType('${p.id}',this.value)" aria-label="Discount type">
        <option value="" ${!d.type ? 'selected' : ''}>No discount</option>
        <option value="percent" ${d.type === 'percent' ? 'selected' : ''}>Discount %</option>
        <option value="fixed" ${d.type === 'fixed' ? 'selected' : ''}>Discount RM</option>
      </select>
      <input type="number" min="0" step="0.01" inputmode="decimal" placeholder="0" value="${d.value || ''}" ${d.type ? '' : 'disabled'}
        oninput="ocCardDiscVal('${p.id}',this.value)" aria-label="Discount value">
    </div>
    <div class="oc-warn" id="ocWarn-${p.id}" hidden></div>
    <div class="oc-edit-total"><span id="ocSum-${p.id}"></span><strong id="ocLine-${p.id}"></strong></div>
    <div class="oc-edit-actions">
      ${inCart ? `<button class="oc-del" onclick="ocRemovePid('${p.id}')" aria-label="Remove from cart">🗑 Remove</button>` : ''}
      <button class="oc-cancel" onclick="ocCancelDraft('${p.id}')">Cancel</button>
      <button class="oc-addcart" id="ocAdd-${p.id}" onclick="ocAddToCart('${p.id}')" ${line ? '' : 'disabled'}>🛒 ${inCart ? 'Update cart' : 'Add to cart'}</button>
    </div>
  </div>`;
}

function _ocLineText(item) {
  const gross = item._lineTotal ?? item.price * item.qty;
  const disc = item.discount?.amount || 0;
  return disc > 0 ? `<s>${fmt(gross)}</s> ${fmt(gross - disc)}` : fmt(gross);
}

// A cart line for a product and quantity (null when the quantity is 0).
function _ocBuildItem(p, ctnQty, pcsQty, discount) {
  const size = _ocCtnSize(p);
  ctnQty = Math.max(0, Math.floor(ctnQty || 0));
  pcsQty = Math.max(0, Math.floor(pcsQty || 0));
  const totalPcs = ctnQty * size + pcsQty;
  if (totalPcs <= 0) return null;
  const ctnPr = p.ctnPrice ?? p.ctn_price ?? (p.price * size);
  const ctnTotal = ctnQty * ctnPr;
  const pcsTotal = pcsQty * p.price;
  const item = {
    pid: p.id, name: p.name, sku: p.sku || '',
    price: p.price, ctnPrice: ctnPr,
    qty: totalPcs, ctnQty, pcsQty,
    ctnSize: size, unit: p.unit || 'pcs',
    qtyDisplay: ctnQty > 0 ? (pcsQty > 0 ? `${ctnQty}ctn+${pcsQty}pcs` : `${ctnQty}ctn`) : `${totalPcs}pcs`,
    _ctnTotal: ctnTotal, _pcsTotal: pcsTotal, _lineTotal: ctnTotal + pcsTotal,
  };
  if (discount && discount.type) item.discount = _ocDiscAmount(discount, item._lineTotal);
  return item;
}

// Puts a line in the cart (replacing that product's line), or removes it at 0.
function _ocSetItem(p, ctnQty, pcsQty, discount) {
  const idx = ordItems.findIndex(x => x.pid === p.id);
  const item = _ocBuildItem(p, ctnQty, pcsQty, discount !== undefined ? discount : ordItems[idx]?.discount);
  if (!item) { if (idx >= 0) ordItems.splice(idx, 1); return null; }
  if (idx >= 0) ordItems[idx] = item; else ordItems.push(item);
  return item;
}

function _ocDiscAmount(disc, lineTotal) {
  const value = Math.max(0, parseFloat(disc.value) || 0);
  let amount = 0;
  if (disc.type === 'percent') amount = Math.min(lineTotal, Math.min(value, 100) / 100 * lineTotal);
  else if (disc.type === 'fixed') amount = Math.min(lineTotal, value);
  return { type: disc.type || '', value, amount: Math.round(amount * 100) / 100 };
}

function _ocRedrawCard(pid) {
  const p = allProducts.find(x => x.id === pid);
  const el = document.getElementById('ocProd-' + pid);
  if (p && el && el.isConnected) el.outerHTML = ocProductCard(p);
  if (_ocDraft[pid]) _ocRefreshCard(pid);
  ocUpdateCartBtn();
}

// Updates the draft's totals in place, without rebuilding the card, so a
// tap on another control right after typing (change/blur first) still lands.
function _ocRefreshCard(pid) {
  const p = allProducts.find(x => x.id === pid), dr = _ocDraft[pid];
  if (!p || !dr) return;
  const it = _ocBuildItem(p, dr.ctnQty, dr.pcsQty, dr.discount);
  const set = (id, html) => { const e = document.getElementById(id + pid); if (e) e.innerHTML = html; };
  set('ocLine-', it ? _ocLineText(it) : fmt(0));
  set('ocSum-', it ? `1 ctn = ${_ocCtnSize(p)} pcs · total ${it.qty} pcs` : 'Enter a quantity');
  const avail = _availableQty(_getStock(p));
  const w = document.getElementById('ocWarn-' + pid);
  if (w) {
    w.hidden = !(it && avail !== null && it.qty > avail);
    w.textContent = w.hidden ? '' : `⚠️ Only ${avail} pcs in stock — the shortfall goes to back-order`;
  }
  const add = document.getElementById('ocAdd-' + pid);
  if (add) add.disabled = !it;
}

// + (or Edit): open the entry panel, starting from the cart line or 1 unit.
function ocOpenDraft(pid) {
  const p = allProducts.find(x => x.id === pid); if (!p) return;
  const it = ordItems.find(x => x.pid === pid);
  _ocDraft[pid] = it
    ? { ctnQty: it.ctnQty || 0, pcsQty: it.pcsQty || 0, discount: it.discount ? { type: it.discount.type, value: it.discount.value } : { type: '', value: 0 } }
    : { ctnQty: _ocCtnSize(p) > 1 ? 1 : 0, pcsQty: _ocCtnSize(p) > 1 ? 0 : 1, discount: { type: '', value: 0 } };
  _ocRedrawCard(pid);
}

function ocStepQty(pid, unit, delta) {
  const dr = _ocDraft[pid]; if (!dr) return;
  if (unit === 'ctn') dr.ctnQty = Math.max(0, (dr.ctnQty || 0) + delta); else dr.pcsQty = Math.max(0, (dr.pcsQty || 0) + delta);
  const card = document.getElementById('ocProd-' + pid);
  const inp = card && card.querySelectorAll('.oc-step input')[unit === 'ctn' ? 0 : 1];
  if (inp) inp.value = unit === 'ctn' ? dr.ctnQty : dr.pcsQty;
  _ocRefreshCard(pid);
}

function ocSetQty(pid, unit, val) {
  const dr = _ocDraft[pid]; if (!dr) return;
  const n = Math.max(0, parseInt(val, 10) || 0);
  if (unit === 'ctn') dr.ctnQty = n; else dr.pcsQty = n;
  _ocRefreshCard(pid);
}

function ocCardDiscType(pid, type) {
  const dr = _ocDraft[pid]; if (!dr) return;
  dr.discount = { type, value: 0 };
  const inp = document.querySelector('#ocProd-' + pid + ' .oc-edit-disc input');
  if (inp) { inp.disabled = !type; inp.value = ''; if (type) inp.focus(); }
  _ocRefreshCard(pid);
}

function ocCardDiscVal(pid, val) {
  const dr = _ocDraft[pid]; if (!dr || !dr.discount?.type) return;
  dr.discount = { type: dr.discount.type, value: val };
  _ocRefreshCard(pid);
}

function ocAddToCart(pid) {
  const p = allProducts.find(x => x.id === pid), dr = _ocDraft[pid];
  if (!p || !dr) return;
  const wasIn = ordItems.some(x => x.pid === pid);
  const it = _ocSetItem(p, dr.ctnQty, dr.pcsQty, dr.discount);
  if (!it) { showToast('Enter a quantity in CTN or PCS', 'warn'); return; }
  delete _ocDraft[pid];
  _ocRedrawCard(pid);
  showToast(`${p.name} ${wasIn ? 'updated' : 'added'} — ${it.qtyDisplay} 🛒`, 'success');
}

function ocCancelDraft(pid) {
  delete _ocDraft[pid];
  _ocRedrawCard(pid);
}

function ocRemovePid(pid) {
  const i = ordItems.findIndex(x => x.pid === pid);
  if (i >= 0) ordItems.splice(i, 1);
  delete _ocDraft[pid];
  _ocRedrawCard(pid);
}

function ocZoomPhoto(pid) {
  const p = allProducts.find(x => x.id === pid); if (!p?.photo) return;
  const ov = document.createElement('div');
  ov.className = 'oc-zoom-ov';
  ov.innerHTML = `<img src="${escH(p.photo)}" alt=""><div>${escH(p.name)}</div>`;
  ov.onclick = () => ov.remove();
  document.body.appendChild(ov);
}

function getCatEmoji(cat){
  const m={Grains:'🌾',Beverages:'🥤',Oils:'🫙',Staples:'🧂',Dairy:'🥛',Snacks:'🍿',
    Cleaning:'🧹',Personal:'🧴',Frozen:'❄️',Bakery:'🍞',Meat:'🥩',Produce:'🥬',Other:'📦'};
  for(const k of Object.keys(m)) if(cat.toLowerCase().includes(k.toLowerCase())) return m[k];
  return '📂';
}

function ocScrollToCat(cat){
  const id='ocSec-'+cat.replace(/\s+/g,'_');
  const el=document.getElementById(id);
  if(el)el.scrollIntoView({behavior:'smooth',block:'start'});
}

function ocScrollToAll(){
  document.getElementById('ocProductList').scrollTo({top:0,behavior:'smooth'});
}

function ocUpdateCartBtn(){
  const btn=document.getElementById('ocCartBtn');
  const lines=ordItems.length;
  const total=ordItems.reduce((s,x)=>s+(x._lineTotal??x.price*x.qty)-(x.discount?.amount||0),0);
  document.getElementById('ocCartCount').textContent=lines;
  btn.style.display=lines?'inline-flex':'none';
  const bar=document.getElementById('ocBottomBar');
  if(bar){
    bar.style.display=lines?'flex':'none';
    const t=document.getElementById('ocBarText');
    if(t)t.textContent=`${lines} item${lines===1?'':'s'} · ${fmt(total)}`;
  }
}

// ── Quantity Picker ──────────────────────────────────────────────────────────
function openQtyPicker(pid){
  const p=allProducts.find(x=>x.id===pid);
  if(!p)return;
  qpProduct=p;

  const existing=ordItems.find(x=>x.pid===pid);
  if(existing){
    qpCtnQty = existing.ctnQty || 0;
    qpPcsQty = existing.pcsQty || existing.qty || 0;
  } else {
    qpCtnQty = 0;
    qpPcsQty = 0;
  }

  const photo=document.getElementById('qpPhoto');
  photo.innerHTML=p.photo?`<img src="${p.photo}" style="width:100%;height:100%;object-fit:cover;border-radius:10px">`:'📦';
  document.getElementById('qpName').textContent=p.name;

  // Show CTN option only if ctnSize defined
  const hasCtn = p.ctnSize > 0;
  document.getElementById('qpUnitRow').style.display = hasCtn ? 'flex' : 'none';
  document.getElementById('qpUnitNote').textContent = hasCtn ? `1 CTN = ${p.ctnSize} pcs` : '';

  // ── Stock info in picker: ERP + app-level pcs/ctn ──
  const stock = _getStock(p);
  const avail = _availableQty(stock);
  // App-level stock
  const appQty  = p.stockQty ?? p.stock_qty ?? null;
  const ctnSz   = p.ctnSize  ?? p.ctn_size  ?? 0;
  const ctnPr   = p.ctnPrice ?? p.ctn_price ?? null;
  const appCtns = (appQty !== null && ctnSz > 0) ? Math.floor(appQty / ctnSz) : null;
  const stockInfoEl = document.getElementById('qpStockInfo');
  if (stockInfoEl) {
    const parts = [];
    if (avail !== null) {
      // ERP source
      const color = avail <= 0 ? 'var(--red)' : avail <= (stock.minStock || 5) ? 'var(--ylw)' : 'var(--grn)';
      parts.push(`<span style="color:${color};font-weight:600">📦 ERP: ${avail} ${stock.unit||p.unit||'pcs'} avail</span>`);
    }
    if (appQty !== null) {
      // App source
      const appColor = appQty <= 0 ? 'var(--red)' : 'var(--grn)';
      parts.push(`<span style="color:${appColor}">App: ${appQty} pcs${appCtns !== null ? ' / '+appCtns+' ctn' : ''}</span>`);
    }
    if (ctnPr && ctnSz) {
      parts.push(`<span style="color:var(--tx2)">Ctn price: ${fmt(ctnPr)} (${ctnSz} pcs)</span>`);
    }
    if (parts.length) {
      stockInfoEl.innerHTML = `<div style="font-size:11px;display:flex;flex-wrap:wrap;gap:8px">${parts.join('')}</div>`;
      stockInfoEl.style.display = '';
    } else {
      stockInfoEl.style.display = 'none';
    }
  }

  qpRender();

  const m=document.getElementById('mQtyPicker');
  m.style.display='flex';
  document.body.style.overflow='hidden';
}

function closeQtyPicker(){
  document.getElementById('mQtyPicker').style.display='none';
  document.body.style.overflow='hidden';
}

// Called when CTN input changes
function qpCtnInput(val){
  qpCtnQty = Math.max(0, parseInt(val)||0);
  qpRender();
}

// Called when PCS input changes
function qpPcsInput(val){
  qpPcsQty = Math.max(0, parseInt(val)||0);
  qpRender();
}

function qpRender(){
  const p = qpProduct; if(!p) return;
  const hasCtn = p.ctnSize > 0;

  // Update input values
  const ctnInp = document.getElementById('qpCtnQty');
  const pcsInp = document.getElementById('qpPcsQty');
  if (ctnInp) ctnInp.value = qpCtnQty || '';
  if (pcsInp) pcsInp.value = qpPcsQty || '';

  // Total pcs = (ctn × ctnSize) + extra pcs
  const totalPcs = hasCtn ? (qpCtnQty * (p.ctnSize||1)) + qpPcsQty : qpPcsQty;
  const totalPrice = totalPcs * p.price;

  // Display breakdown
  const breakdown = hasCtn && qpCtnQty > 0
    ? `${qpCtnQty} CTN${qpPcsQty > 0 ? ` + ${qpPcsQty} pcs` : ''} = ${totalPcs} pcs total`
    : `${totalPcs} pcs`;

  const subtotalEl = document.getElementById('qpSubtotal');
  if (subtotalEl) subtotalEl.textContent = `${breakdown} · Total: ${fmt(totalPrice)}`;

  // Price display — use product's ctnPrice if set, else calculate
  const priceEl = document.getElementById('qpPrice');
  if (priceEl) {
    const ctnPrDisplay = p.ctnPrice ?? p.ctn_price ?? (p.price * (p.ctnSize||1));
    if (hasCtn && p.ctnSize) {
      priceEl.textContent = `${fmt(p.price)}/pcs · ${fmt(ctnPrDisplay)}/ctn`;
    } else {
      priceEl.textContent = `${fmt(p.price)}/pcs`;
    }
  }
}

// Legacy step buttons (kept for pcs quick +/-)
function qpStep(delta){
  qpPcsQty = Math.max(0, qpPcsQty + delta);
  qpRender();
}

function qpAddToCart(){
  const p = qpProduct; if(!p) return;
  const hasCtn = p.ctnSize > 0;
  const totalPcs = hasCtn ? (qpCtnQty * (p.ctnSize||1)) + qpPcsQty : qpPcsQty;

  if(totalPcs <= 0){
    showToast('Enter qty in CTN or PCS','warn');
    return;
  }

  // Check stock availability (ERP first, then app-level)
  const stock = _getStock(p);
  const avail = _availableQty(stock);
  if (avail !== null && totalPcs > avail) {
    const ok = confirm(`⚠️ Only ${avail} pcs available in ERP stock.\nYou are ordering ${totalPcs} pcs.\n\nProceed? ERP will handle the shortfall.`);
    if (!ok) return;
  } else {
    // App-level check
    const appQty = p.stockQty ?? p.stock_qty ?? null;
    if (appQty !== null && totalPcs > appQty) {
      const ok = confirm(`⚠️ Only ${appQty} pcs available in stock.\nYou are ordering ${totalPcs} pcs.\n\nProceed anyway?`);
      if (!ok) return;
    }
  }

  // Calculate correct price: ctn rows use ctnPrice, pcs rows use price
  const ctnPr = p.ctnPrice ?? p.ctn_price ?? (p.price * (p.ctnSize||1));
  const ctnTotal  = hasCtn ? qpCtnQty * ctnPr : 0;
  const pcsTotal  = qpPcsQty * p.price;
  const totalPrice = ctnTotal + pcsTotal;

  let qtyDisplay;
  if (hasCtn && qpCtnQty > 0) {
    qtyDisplay = qpPcsQty > 0 ? `${qpCtnQty}ctn+${qpPcsQty}pcs` : `${qpCtnQty}ctn`;
  } else {
    qtyDisplay = `${totalPcs}pcs`;
  }

  ordItems = ordItems.filter(x=>x.pid!==p.id);
  ordItems.push({
    pid: p.id,
    name: p.name,
    sku: p.sku || '',
    price: p.price,         // unit pcs price (for line total calcs)
    ctnPrice: ctnPr,
    qty: totalPcs,          // always in pcs
    ctnQty: qpCtnQty,
    pcsQty: qpPcsQty,
    ctnSize: p.ctnSize || 0,
    unit: p.unit || 'pcs',
    qtyDisplay,
    // Pre-calculated totals for accuracy
    _ctnTotal: ctnTotal,
    _pcsTotal: pcsTotal,
    _lineTotal: totalPrice,
  });

  closeQtyPicker();

  const cardEl = document.getElementById('ocProd-'+p.id);
  if(cardEl){
    const existing = cardEl.querySelector('.oc-cart-badge');
    const badge = document.createElement('div');
    badge.className = 'oc-cart-badge';
    badge.textContent = qtyDisplay;
    if(existing) existing.replaceWith(badge); else cardEl.prepend(badge);
    cardEl.classList.add('oc-in-cart');
  }
  ocUpdateCartBtn();
  showToast(`${p.name} added — ${qtyDisplay} 🛒`, 'success');
}

// ── Cart Review ──────────────────────────────────────────────────────────────
function ocRenderCart(){
  const list=document.getElementById('ocCartList');
  if(!ordItems.length){
    list.innerHTML='<div style="text-align:center;padding:40px;color:var(--tx3)">🛒 Cart is empty</div>';
    document.getElementById('ocCartTotal').textContent=fmt(0);
    document.getElementById('ocSubtotalAmt').textContent=fmt(0);
    return;
  }
  list.innerHTML=ordItems.map((item,i)=>{
    const p=allProducts.find(x=>x.id===item.pid)||{};
    const photo=p.photo?`<img src="${p.photo}" style="width:100%;height:100%;object-fit:cover;border-radius:8px">`:'📦';
    const lineTotal=item._lineTotal??item.price*item.qty;
    const disc=item.discount||{type:'',value:0,amount:0};
    const discAmt=disc.amount||0;
    const finalLine=Math.max(0,lineTotal-discAmt);
    return`<div style="padding:12px;background:var(--s1);border:1px solid var(--bdr);border-radius:var(--r);margin-bottom:10px">
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:8px">
        <div style="width:48px;height:48px;border-radius:8px;background:var(--s2);display:flex;align-items:center;justify-content:center;font-size:22px;flex-shrink:0;overflow:hidden">${photo}</div>
        <div style="flex:1;min-width:0">
          <div style="font-weight:600;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${item.name}</div>
          <div style="font-size:11px;color:var(--tx3)">${item.qtyDisplay||item.qty} × ${fmt(item.price)}</div>
          <div style="font-family:'Syne',sans-serif;font-size:14px;font-weight:700;color:${discAmt>0?'var(--tx3)':'var(--acc)'};${discAmt>0?'text-decoration:line-through;font-size:12px;':''}">${fmt(lineTotal)}</div>
          ${discAmt>0?`<div style="font-family:'Syne',sans-serif;font-size:14px;font-weight:700;color:var(--acc)">${fmt(finalLine)} <span style="font-size:10px;color:var(--ylw)">(-${fmt(discAmt)})</span></div>`:''}
        </div>
        <div style="display:flex;flex-direction:column;gap:5px;align-items:center">
          <button onclick="ocEditItem(${i})" style="background:var(--s2);border:1px solid var(--bdr);border-radius:6px;padding:5px 9px;color:var(--tx2);font-size:12px;cursor:pointer">✏️</button>
          <button onclick="ocRemoveItem(${i})" style="background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.2);border-radius:6px;padding:5px 9px;color:var(--red);font-size:12px;cursor:pointer">🗑</button>
        </div>
      </div>
      <!-- Per-item discount -->
      <div style="background:var(--s2);border:1px solid var(--bdr);border-radius:var(--r2);padding:8px 10px">
        <div style="font-size:11px;font-weight:600;color:var(--tx2);margin-bottom:6px">🏷️ Discount for this item</div>
        <div style="display:flex;gap:6px;align-items:center">
          <select onchange="ocItemDiscountType(${i},this.value)" style="flex:0 0 105px;background:var(--s3);border:1px solid var(--bdr);border-radius:var(--r2);color:var(--tx);font-size:11px;padding:5px 7px;cursor:pointer">
            <option value="" ${!disc.type?'selected':''}>No Discount</option>
            <option value="percent" ${disc.type==='percent'?'selected':''}>% Percent</option>
            <option value="fixed" ${disc.type==='fixed'?'selected':''}>RM Fixed</option>
          </select>
          <input type="number" min="0" step="0.01" placeholder="0"
            value="${disc.value||''}"
            ${!disc.type?'disabled':''}
            id="itemDiscVal-${i}"
            oninput="ocItemDiscountValue(${i},this.value)"
            style="flex:1;background:var(--s3);border:1px solid var(--bdr);border-radius:var(--r2);color:var(--tx);font-size:11px;padding:5px 7px;outline:none">
        </div>
      </div>
    </div>`;
  }).join('');
  ocUpdateCartTotals();
}

function ocItemDiscountType(idx,type){
  if(!ordItems[idx])return;
  if(!type){ordItems[idx].discount={type:'',value:0,amount:0};}
  else{ordItems[idx].discount={type,value:0,amount:0};}
  const inp=document.getElementById(`itemDiscVal-${idx}`);
  if(inp){inp.disabled=!type;inp.value='';}
  ocUpdateCartTotals();
}

function ocItemDiscountValue(idx,val){
  if(!ordItems[idx])return;
  const disc=ordItems[idx].discount||{type:'',value:0,amount:0};
  ordItems[idx].discount=_ocDiscAmount({type:disc.type,value:val},ordItems[idx]._lineTotal??ordItems[idx].price*ordItems[idx].qty);
  ocUpdateCartTotals();
}

function ocUpdateCartTotals(){
  // Use pre-calculated _lineTotal (ctn-aware) when available, else fallback to price*qty
  const subtotal=ordItems.reduce((s,x)=>s+(x._lineTotal??x.price*x.qty),0);
  const totalDiscount=ordItems.reduce((s,x)=>s+(x.discount?.amount||0),0);
  const finalTotal=Math.max(0,subtotal-totalDiscount);
  const subtotalEl=document.getElementById('ocSubtotalAmt');
  const discRow=document.getElementById('ocDiscountRow');
  const discAmt=document.getElementById('ocDiscountAmt');
  const totalEl=document.getElementById('ocCartTotal');
  if(subtotalEl)subtotalEl.textContent=fmt(subtotal);
  if(totalDiscount>0){
    if(discRow)discRow.style.display='flex';
    if(discAmt)discAmt.textContent='−'+fmt(totalDiscount);
  } else {
    if(discRow)discRow.style.display='none';
  }
  if(totalEl)totalEl.textContent=fmt(finalTotal);
}

function ocEditItem(i){
  const item=ordItems[i];
  if(!item)return;
  ocBackToProducts();
  ocOpenDraft(item.pid);
  setTimeout(()=>document.getElementById('ocProd-'+item.pid)?.scrollIntoView({behavior:'smooth',block:'center'}),100);
}

function ocRemoveItem(i){
  const item=ordItems[i];
  ordItems.splice(i,1);
  const cardEl=document.getElementById('ocProd-'+item.pid);
  if(cardEl){
    cardEl.querySelector('.oc-cart-badge')?.remove();
    cardEl.classList.remove('oc-in-cart');
  }
  ocRenderCart();
  ocUpdateCartBtn();
}

// ── Save Order + ERP Sync + Stock Reservation ────────────────────────────────
async function saveOrder() {
  const outletId=document.getElementById('ordOutlet').value;
  if(!outletId){showToast('Select an outlet','error');return;}
  if(!ordItems.length){showToast('Add at least one item','error');return;}

  const subtotal=ordItems.reduce((s,x)=>s+(x._lineTotal??x.price*x.qty),0);
  const totalDiscountAmt=ordItems.reduce((s,x)=>s+(x.discount?.amount||0),0);
  const hasDiscount=totalDiscountAmt>0;
  const itemDiscounts=ordItems.map(x=>({
    pid:x.pid,name:x.name,
    discountType:x.discount?.type||'',
    discountValue:x.discount?.value||0,
    discountAmount:x.discount?.amount||0,
  })).filter(x=>x.discountAmount>0);

  let discountRequest=null;
  if(hasDiscount){
    discountRequest={
      type:'multi',
      amount:totalDiscountAmt,
      status:'pending',
      requestedBy:CU.uid,
      requestedByName:CU.name,
      items:itemDiscounts,
    };
  }

  // ★ KEY LOGIC:
  // No discount  → auto Confirmed, sync to ERP immediately, no approval needed
  // Has discount → stays Pending, blocked from ERP until admin approves discount
  const total=subtotal; // discount applied to total only after approval
  // Credit outlets: an order that takes the outlet past its credit limit is
  // held for admin approval (the server re-checks this on every new order).
  const creditHold=await _creditLimitCheck(outletId,total);
  if(creditHold&&!confirm(`⚠️ Credit limit exceeded\n\nLimit: ${fmt(creditHold.limit)}\nOutstanding: ${fmt(creditHold.outstanding)}\nThis order: ${fmt(total)}\nOver by: ${fmt(creditHold.exceededBy)}\n\nThe order will be held until an admin approves it. Place it anyway?`))return;
  const held=hasDiscount||!!creditHold;
  const initialStatus=held?'Pending':'Confirmed';
  const ordId='ORD-'+uid6();
  const orderDate=document.getElementById('ordDate').value;
  const notes=document.getElementById('ordNotes').value;

  try {
    // ── 1. Save to app Firestore ─────────────────────────────────────────
    await sfAdd('orders',{
      id:ordId, outletId, items:[...ordItems], subtotal, total,
      discount:discountRequest||null,
      date:orderDate,
      status:initialStatus,
      notes,
      createdBy:CU.uid, createdByName:CU.name,
      approvedBy:   held?'':CU.uid,
      approvedAt:   held?'':new Date().toISOString(),
      approvedByName:held?'':'Auto (no discount)',
      erpSynced:false,
      erpHeld:held,   // flag: blocked from ERP pending discount / credit approval
      creditHold:creditHold?{...creditHold,at:new Date().toISOString()}:null,
      createdAt:window.__SF.serverTimestamp()
    });

    // ── 2. Stock reservation and ERP sync run server-side in real time
    //       (erpBridge Cloud Functions). Held orders reserve stock but reach
    //       the ERP only once an admin decides.

    closeOrderCatalog();
    invalidateDashCache();

    if(creditHold){
      showToast(`Order ${ordId} placed ✅\n⏳ Over credit limit by ${fmt(creditHold.exceededBy)} — waiting for admin approval`,'warn');
      notifyAdmins('💳 Credit Limit Approval Needed',`${CU.name} placed ${ordId} for ${outletName(outletId)} — ${fmt(creditHold.exceededBy)} over credit limit`,{tag:'credit-pending',ordId});
    } else if(hasDiscount){
      showToast(`Order ${ordId} placed ✅\n⏳ Discount ${fmt(totalDiscountAmt)} pending admin approval — will appear in ERP after approval`,'warn');
      notifyAdmins('🏷️ Discount Approval Needed',`${CU.name} placed ${ordId} with discount ${fmt(totalDiscountAmt)} — approval required`,{tag:'discount-pending',ordId});
    } else {
      showToast(`Order ${ordId} confirmed ✅ · Stock reserved · Sent to ERP`,'success');
      notifyAdmins('📦 New Order (Auto-Confirmed)',`${CU.name} placed ${ordId} — no discount, auto-confirmed and sent to ERP`,{tag:'order-new',ordId});
    }
    loadOrders();renderDashboard();updateBadges();updateSidebarStats();

  } catch(e) {
    showToast('Failed to place order: '+e.message,'error');
    console.error('[saveOrder]', e);
  }
}

// ── Stock ───────────────────────────────────────────────────────────────────
// Reservation (order placed), release (cancelled/deleted) and deduction
// (delivered) are applied to stsb_inventory by the erpBridge Cloud Functions,
// whichever app or ERP screen changed the order. The client only reads stock.

// ── Credit limit ────────────────────────────────────────────────────────────
// Outstanding = non-cancelled orders − collections + approved opening balance,
// the same figure the collection screen shows. Returns the hold record when a
// salesman's order would exceed the outlet's credit limit, else null.
async function _creditLimitCheck(outletId, orderTotal) {
  const outlet=allOutlets.find(o=>o.id===outletId);
  const limit=Number(outlet?.creditLimit)||0;
  if(!outlet||outlet.paymentType!=='credit'||limit<=0||isAdmin())return null;
  try {
    const {where}=window.__SF;
    const [ordD,colD]=await Promise.all([
      sfGet('orders',[where('outletId','==',outletId)]),
      sfGet('collections',[where('outletId','==',outletId)]),
    ]);
    const ordered=ordD.map(d=>d.data()).filter(x=>x.status!=='Cancelled').reduce((s,x)=>s+_orderAmountDue(x),0);
    const paid=colD.map(d=>d.data()).reduce((s,x)=>s+(Number(x.amount)||0),0);
    const opening=outlet.balanceStatus==='approved'?(Number(outlet.openingBalance)||0):0;
    const outstanding=Math.max(0,ordered-paid+opening);
    const after=outstanding+(Number(orderTotal)||0);
    if(after<=limit)return null;
    return {status:'pending',limit,outstanding:Math.round(outstanding*100)/100,orderTotal:Number(orderTotal)||0,exceededBy:Math.round((after-limit)*100)/100};
  } catch(e) {
    console.warn('[credit] check failed — server will enforce:', e.message);
    return null;
  }
}

async function approveCredit(id, approve=true) {
  if(!isAdmin()){showToast('Only admin can approve credit','error');return;}
  const ordDoc=await window.__SF.getDoc(docRef('orders',id));
  const o=ordDoc.exists()?{_docId:ordDoc.id,...ordDoc.data()}:null;
  if(!o){showToast('Order not found','error');return;}
  const h=o.creditHold;
  if(!h||h.status!=='pending'){showToast('No pending credit approval on this order','warn');return;}
  const msg=`${approve?'APPROVE':'REJECT'} order ${o.id||id} over the credit limit?\n\nLimit: ${fmt(h.limit)}\nOutstanding: ${fmt(h.outstanding)}\nThis order: ${fmt(h.orderTotal)}\nOver by: ${fmt(h.exceededBy)}\n\n${approve?'The order continues to the ERP.':'The order will be cancelled and its stock released.'}`;
  if(!confirm(msg))return;
  const now=new Date().toISOString();
  const decided={...h,status:approve?'approved':'rejected',decidedBy:CU.uid,decidedByName:CU.name,decidedAt:now};
  if(!approve){
    await sfUpdate('orders',id,{creditHold:decided,status:'Cancelled',cancelledBy:CU.uid,cancelledAt:now,cancelReason:'Credit limit exceeded'});
  } else {
    const discPending=o.discount&&o.discount.status==='pending';
    await sfUpdate('orders',id,discPending
      ?{creditHold:decided}
      :{creditHold:decided,status:'Confirmed',erpHeld:false,approvedBy:CU.uid,approvedAt:now,approvedByName:CU.name});
  }
  showToast(approve?`Credit approved ✅ · ${o.id||id}${o.discount?.status==='pending'?' — discount still pending':' sent to ERP'}`:`Order ${o.id||id} rejected — over credit limit`,approve?'success':'warn');
  invalidateDashCache();loadOrders();renderDashboard();updateBadges();
  try{notifyRep(o.createdBy,approve?'✅ Credit Approved':'❌ Order Rejected',approve?`Your order ${o.id||id} was approved over the credit limit`:`Your order ${o.id||id} was rejected: credit limit exceeded`,{tag:'credit-decision'});}catch(e){}
}

// ── ERP order sync ───────────────────────────────────────────────────────────
// Orders, manual invoices and delivery status are mirrored into stsb_orders by
// the erpBridge Cloud Functions on every write to the app order (create, edit,
// approval, delivery, cancel, delete). The client must not write stsb_orders
// itself: rules deny it for most roles and a full setDoc would overwrite the
// server's newer state.

// legacy stubs
function renderOrderItems(){}
function addItem(){}
function rmOrdItem(){}
function updOrdItem(){}

// ── Discount-only approval (called from pending discount badge/button) ────────
async function approveDiscount(id, approve=true) {
  if(!isAdmin()){showToast('Only admin can approve discounts','error');return;}
  const ordDoc=await window.__SF.getDoc(docRef('orders',id));
  const o=ordDoc.exists()?{_docId:ordDoc.id,...ordDoc.data()}:null;
  if(!o){showToast('Order not found','error');return;}
  if(!o.discount||o.discount.status!=='pending'){showToast('No pending discount on this order','warn');return;}

  const discAmt=o.discount.amount||0;
  const discLabel=o.discount.type==='multi'
    ?`${fmt(discAmt)} across ${(o.discount.items||[]).length} item(s)`
    :o.discount.type==='percent'?`${o.discount.value}% (${fmt(discAmt)})`:fmt(discAmt);

  const action=approve?'APPROVE':'REJECT';
  if(!confirm(`${action} discount of ${discLabel} for order ${o.id||id}?\n\n${approve?'Discount will be applied and order sent to ERP.':'Order will proceed at full price and be sent to ERP.'}`))return;

  const discStatus=approve?'approved':'rejected';
  const newTotal=approve?(o.subtotal||o.total)-discAmt:(o.subtotal||o.total);
  const creditPending=o.creditHold&&o.creditHold.status==='pending';
  await sfUpdate('orders',id,{
    status:creditPending?'Pending':'Confirmed',
    total:newTotal,
    erpHeld:!!creditPending,
    discount:{...o.discount,status:discStatus,decidedBy:CU.uid,decidedAt:new Date().toISOString()},
    approvedBy:CU.uid,
    approvedAt:new Date().toISOString(),
    approvedByName:CU.name,
  });

  // ★ erpHeld is now false — the erpBridge function pushes it to ERP in real time

  showToast(`Discount ${discStatus} ✅ · Order ${o.id||id} confirmed and sent to ERP`,'success');
  invalidateDashCache();loadOrders();renderDashboard();updateBadges();
  try{notifyRep(o.createdBy,`${approve?'✅ Discount Approved':'❌ Discount Rejected'}`,`Your discount request for order ${o.id||id} was ${discStatus}. Order is now confirmed.`,{tag:'discount-decision'});}catch(e){}
}

async function approveOrder(id) {
  if(!isAdmin()){showToast('Only admin can approve orders','error');return;}
  const ordDoc=await window.__SF.getDoc(docRef('orders',id));
  const o=ordDoc.exists()?{_docId:ordDoc.id,...ordDoc.data()}:null;
  if(!o)return;

  if(o.creditHold&&o.creditHold.status==='pending'){
    await approveCredit(id, true);
    return;
  }

  // If order has a pending discount, route to discount approval flow
  if(o.discount&&o.discount.status==='pending'){
    const discAmt=o.discount.amount||0;
    const discLabel=o.discount.type==='multi'
      ?`${fmt(discAmt)} across ${(o.discount.items||[]).length} item(s)`
      :o.discount.type==='percent'?`${o.discount.value}% (${fmt(discAmt)})`:fmt(discAmt);
    const choice=confirm(`This order has a pending discount: ${discLabel}\n\nClick OK to APPROVE the discount (order sent to ERP with discount).\nClick Cancel to REJECT it (order sent to ERP at full price).`);
    await approveDiscount(id, choice);
    return;
  }

  // No discount — order should already be Confirmed and in ERP (auto-flow)
  // This path handles edge cases (e.g. admin manually re-approving)
  await sfUpdate('orders',id,{status:'Confirmed',approvedBy:CU.uid,approvedAt:new Date().toISOString(),approvedByName:CU.name,erpHeld:false});
  showToast('Order confirmed ✅','success');
  invalidateDashCache();loadOrders();renderDashboard();updateBadges();
  try{notifyRep(o.createdBy,'✅ Order Confirmed',`Your order ${o.id||id} has been confirmed`,{tag:'order-confirmed'});}catch(e){}
}

// ★ Delivery is now managed by ERP — this function just syncs status back from ERP
async function deliverOrder(id) {
  if(!isAdmin()){showToast('Only admin can mark delivered','error');return;}
  const ordDoc = await window.__SF.getDoc(docRef('orders',id));
  const o = ordDoc.exists() ? {_docId:ordDoc.id,...ordDoc.data()} : null;
  if(!o) return;

  // Stock is deducted server-side when the status becomes Delivered
  await sfUpdate('orders',id,{status:'Delivered', deliveredAt:new Date().toISOString()});

  showToast('Order marked as delivered — stock will be deducted ✅','success');
  invalidateDashCache();loadOrders();renderDashboard();
  try{const _dODoc=await window.__SF.getDoc(window.__SF.doc(window.__SF.db,_zonePath('orders'),id));if(_dODoc.exists()){const _dOD=_dODoc.data();notifyRep(_dOD.createdBy,'🚚 Order Delivered',`Order ${_dOD.id||id} has been delivered`,{tag:'order-delivered'});}}
  catch(e){}
}

// ═══════════════ EDIT / CANCEL OWN ORDER ═══════════════
// Until the ERP accepts or invoices an order, the salesman who placed it
// (or an admin) can change quantities, add or remove products and notes,
// or cancel it. Prices come from the catalogue; price changes are done in
// the ERP. The server re-reserves stock for the new lines.
function _appOrderEditable(o) {
  if(!o)return false;
  if(!['Pending','Confirmed'].includes(o.status))return false;
  if(o.invoiceNo)return false;
  if(o.erpStatus&&o.erpStatus!=='pending')return false;
  return isAdmin()||o.createdBy===CU.uid;
}
let _eoItems=[], _eoOrder=null;

async function editMyOrder(docId) {
  const snap=await window.__SF.getDoc(docRef('orders',docId));
  const o=snap.exists()?{_docId:snap.id,...snap.data()}:null;
  if(!_appOrderEditable(o)){showToast('This order can no longer be changed — it is being processed. Ask the office.','warn');return;}
  if(!allProducts.length)await loadCachedData();
  _eoOrder=o;
  _eoItems=(o.items||[]).map(it=>({...it, ctnQty:Number(it.ctnQty)||0, pcsQty:it.ctnSize?(Number(it.pcsQty)||0):(Number(it.qty)||0)}));
  document.getElementById('mEditMyOrder')?.remove();
  const el=document.createElement('div');
  el.className='moverlay'; el.id='mEditMyOrder';
  el.innerHTML=`<div class="modal"><div class="mhdr"><div class="mttl">✏️ Edit ${o.id||docId}</div><button class="mcls" onclick="closeM('mEditMyOrder')">✕</button></div>
    <div class="mbody">
      <div style="font-size:12px;color:var(--tx2);margin-bottom:8px">🏪 ${outletName(o.outletId)}</div>
      <div id="eoLines"></div>
      <div style="display:flex;gap:6px;margin:10px 0">
        <select class="finp" id="eoProd" style="flex:1"><option value="">+ Add a product…</option>${allProducts.filter(p=>p.stockStatus!=='out_of_stock').map(p=>`<option value="${p.id}">${p.name} — ${fmt(p.price)}</option>`).join('')}</select>
        <button class="btn btn-ghost btn-sm" onclick="_eoAdd()">Add</button>
      </div>
      <div class="fgrp"><label class="flbl">Notes</label><input class="finp" id="eoNotesApp" value="${(o.notes||'').replace(/"/g,'&quot;')}"></div>
      <div id="eoTotal" style="text-align:right;font-weight:700"></div>
    </div>
    <div class="mfoot"><button class="btn btn-ghost" onclick="closeM('mEditMyOrder')">Cancel</button><button class="btn btn-primary" onclick="saveMyOrderEdit()">Save changes</button></div></div>`;
  document.body.appendChild(el);
  openM('mEditMyOrder');
  _eoDraw();
}

function _eoLineTotal(it) {
  const ctnPr=it.ctnPrice??((Number(it.price)||0)*(Number(it.ctnSize)||1));
  return (it.ctnSize?(Number(it.ctnQty)||0)*ctnPr:0)+(Number(it.pcsQty)||0)*(Number(it.price)||0);
}

function _eoDraw() {
  document.getElementById('eoLines').innerHTML=_eoItems.map((it,i)=>`<div style="display:flex;align-items:center;gap:6px;padding:8px 0;border-bottom:1px solid var(--bdr)">
      <div style="flex:1;font-size:12px"><strong>${it.name}</strong><div style="color:var(--tx3);font-size:11px">${fmt(it.price)}/pc${it.ctnSize?` · ${it.ctnSize}/ctn`:''}</div></div>
      ${it.ctnSize?`<input class="finp" type="number" min="0" value="${it.ctnQty}" style="width:58px;padding:6px" title="Cartons" oninput="_eoQty(${i},'ctnQty',this.value)"><span style="font-size:10px;color:var(--tx3)">ctn</span>`:''}
      <input class="finp" type="number" min="0" value="${it.pcsQty}" style="width:62px;padding:6px" title="Pieces" oninput="_eoQty(${i},'pcsQty',this.value)"><span style="font-size:10px;color:var(--tx3)">pcs</span>
      <span id="eoLt${i}" style="width:78px;text-align:right;font-size:12px">${fmt(_eoLineTotal(it))}</span>
      <button class="btn btn-red btn-xs" onclick="_eoItems.splice(${i},1);_eoDraw()">✕</button></div>`).join('')
    ||'<div style="text-align:center;color:var(--tx3);padding:14px">No items — add a product or cancel the order</div>';
  _eoSum();
}
function _eoQty(i,k,v){ _eoItems[i][k]=Math.max(0,Math.floor(Number(v)||0)); const c=document.getElementById('eoLt'+i); if(c)c.textContent=fmt(_eoLineTotal(_eoItems[i])); _eoSum(); }
function _eoSum(){ const t=_eoItems.reduce((s,it)=>s+_eoLineTotal(it),0); const el=document.getElementById('eoTotal'); if(el)el.textContent=`New subtotal ${fmt(t)} (was ${fmt(_eoOrder.subtotal??_eoOrder.total)})`; }
function _eoAdd(){
  const sel=document.getElementById('eoProd'); const p=allProducts.find(x=>x.id===sel.value); if(!p)return;
  if(_eoItems.some(it=>it.pid===p.id)){showToast('Already on the order — change its quantity','info');sel.value='';return;}
  const ctnSize=Number(p.ctnSize)||0;
  _eoItems.push({pid:p.id,name:p.name,sku:p.sku||'',price:p.price,ctnPrice:p.ctnPrice??p.ctn_price??null,ctnSize,unit:p.unit||'pcs',ctnQty:ctnSize?1:0,pcsQty:ctnSize?0:1});
  sel.value=''; _eoDraw();
}

async function saveMyOrderEdit() {
  const o=_eoOrder;
  if(!_eoItems.length){showToast('No items left — cancel the order instead','error');return;}
  const items=_eoItems.map(it=>{
    const qty=(it.ctnSize?(Number(it.ctnQty)||0)*it.ctnSize:0)+(Number(it.pcsQty)||0);
    const line=Math.round(_eoLineTotal(it)*100)/100;
    const disc=it.discount&&it.discount.amount?{...it.discount,amount:Math.min(Number(it.discount.amount)||0,line)}:(it.discount||null);
    return {...it,qty,ctnQty:it.ctnSize?(Number(it.ctnQty)||0):0,pcsQty:Number(it.pcsQty)||0,_lineTotal:line,discount:disc,
      qtyDisplay:it.ctnSize&&it.ctnQty?`${it.ctnQty}ctn${it.pcsQty?`+${it.pcsQty}pcs`:''}`:`${qty}pcs`};
  });
  const zero=items.find(it=>it.qty<=0);
  if(zero){showToast(`${zero.name}: enter a quantity or remove it`,'error');return;}
  const subtotal=Math.round(items.reduce((s,it)=>s+it._lineTotal,0)*100)/100;
  // An approved discount stays: line discounts follow their lines; an
  // order-level amount is kept as is. A pending discount still waits.
  const d=o.discount;
  const discAmt=d&&d.status==='approved'?(d.type==='multi'?items.reduce((s,it)=>s+(Number(it.discount?.amount)||0),0):Number(d.amount)||0):0;
  const total=Math.max(0,Math.round((subtotal-discAmt)*100)/100);
  try {
    await sfUpdate('orders',o._docId,{items,subtotal,total,notes:document.getElementById('eoNotesApp').value.trim(),
      updatedAt:new Date().toISOString(),editedAt:new Date().toISOString(),editedBy:CU.uid,editedByName:CU.name});
    closeM('mEditMyOrder');
    showToast(`Order ${o.id||''} updated ✓ — total ${fmt(total)}`,'success');
    loadOrders();
  } catch(e){ showToast('Could not save: '+e.message,'error'); }
}

async function cancelMyOrder(docId) {
  const snap=await window.__SF.getDoc(docRef('orders',docId));
  const o=snap.exists()?{_docId:snap.id,...snap.data()}:null;
  if(!_appOrderEditable(o)){showToast('This order can no longer be cancelled here — ask the office.','warn');return;}
  const why=prompt(`Cancel order ${o.id||docId}?\n\nReason (required):`);
  if(!why)return;
  try {
    await sfUpdate('orders',docId,{status:'Cancelled',cancelledAt:new Date().toISOString(),cancelledBy:CU.uid,cancelReason:why,updatedAt:new Date().toISOString()});
    showToast('Order cancelled — reserved stock released','warn');
    loadOrders();
    try{notifyAdmins('❌ Order Cancelled',`${CU.name} cancelled ${o.id||docId}: ${why}`,{tag:'order-cancelled'});}catch(e){}
  } catch(e){ showToast('Could not cancel: '+e.message,'error'); }
}

async function cancelOrder(id) {
  if(!isAdmin()){showToast('Only admin/sub-admin can cancel orders','error');return;}
  const ordDoc=await window.__SF.getDoc(docRef('orders',id));
  const o=ordDoc.exists()?{_docId:ordDoc.id,...ordDoc.data()}:null;
  const label=o?`Order ${o.id||id}`:`Order ${id}`;
  if(isStrictAdmin()){
    if(!confirm(`Cancel ${label}?`))return;
    await sfUpdate('orders',id,{status:'Cancelled',cancelledBy:CU.uid,cancelledAt:new Date().toISOString()});
    // Reserved stock is released server-side when the status becomes Cancelled
    showToast('Order cancelled — stock reservation released','warn');
    invalidateDashCache();loadOrders();renderDashboard();updateBadges();
    try{const _cODoc=await window.__SF.getDoc(window.__SF.doc(window.__SF.db,_zonePath('orders'),id));if(_cODoc.exists()){const _cOD=_cODoc.data();notifyRep(_cOD.createdBy,'❌ Order Cancelled',`Order ${_cOD.id||id} was cancelled`,{tag:'order-cancelled'});}}
    catch(e){}
  } else {
    await requestDeleteApproval('order',id,label);
  }
}

// LHDN e-Invoice request QR for an invoiced order (token set by the ERP).
function _einvoiceQrSvg(o) {
  if (!o.invoiceNo || !o.einvoiceToken || typeof qrcode !== 'function') return '';
  const url = `https://stfm-sales.web.app/einvoice.html?i=${encodeURIComponent(o.invoiceNo)}&t=${encodeURIComponent(o.einvoiceToken)}`;
  const qr = qrcode(0, 'M'); qr.addData(url); qr.make();
  return qr.createSvgTag({ cellSize: 3, margin: 2, scalable: true });
}

// Company details for invoices: ERP → Settings → Company profile (copied to
// config/company), cached for the session; template defaults otherwise.
let _invoiceCompanyCache = null;
async function _invoiceCompany() {
  if (_invoiceCompanyCache) return _invoiceCompanyCache;
  try {
    const d = await window.__SF.getDoc(window.__SF.doc(window.__SF.db, 'config', 'company'));
    _invoiceCompanyCache = d.exists() ? d.data() : {};
  } catch (e) { _invoiceCompanyCache = {}; }
  return _invoiceCompanyCache;
}

async function viewOrder(docId) {
  const _od=await window.__SF.getDoc(docRef('orders',docId));
  const o=_od.exists()?{_docId:_od.id,..._od.data()}:null;
  if(!o)return;
  const sBadge={Pending:'bdg-ylw',Confirmed:'bdg-blu',Delivered:'bdg-grn',Cancelled:'bdg-red'};
  const outlet=allOutlets.find(x=>x.id===o.outletId)||{name:'Unknown',address:'',phone:''};
  const createdByUser=allUsers.find(u=>u.uid===o.createdBy)||{name:o.createdByName||'Unknown'};
  const discountInfo=o.discount&&o.discount.amount>0?o.discount:null;
  const company=await _invoiceCompany();
  const created=o.createdAt?.toDate?o.createdAt.toDate():(typeof o.createdAt==='string'?new Date(o.createdAt):null);
  const time=created&&!isNaN(created)?' '+created.toLocaleTimeString('en-MY',{hour:'numeric',minute:'2-digit',hour12:true}).toLowerCase():'';
  const invoiced=!!o.invoiceNo||o.type==='manual_invoice';
  const sheet=renderSalesInvoice({
    company, qrSvg:_einvoiceQrSvg(o),
    title:o.status==='Cancelled'?(invoiced?'Sales Invoice (CANCELLED)':'Sales Order (CANCELLED)'):invoiced?'Sales Invoice':'Sales Order',
    number:o.invoiceNo||o.id||o._docId, orderRef:o.invoiceNo&&o.id&&o.id!==o.invoiceNo?o.id:'',
    date:(o.date||'')+time, salesBy:createdByUser.name,
    customer:{id:outlet.code||outlet.customerCode||(outlet.id?String(outlet.id).slice(0,8).toUpperCase():''),name:outlet.name,address:outlet.address,mobile:outlet.phone},
    items:o.items||[], total:o.deliveredTotal!=null?o.deliveredTotal:o.total,
    sst:o.sst, transport:o.transportCost, paid:o.paidAmount, cashReturn:o.cashReturn, notes:o.notes,
  });
  // App-only status line, outside the printable invoice.
  const statusBar=`<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px">
    <span class="bdg ${sBadge[o.status]||'bdg-gry'}">${escH(o.status||'')}</span>
    ${o.erpSynced?'<span class="bdg bdg-grn">✓ Synced to ERP</span>':'<span class="bdg bdg-ylw">⏳ Pending ERP sync</span>'}
    ${discountInfo&&discountInfo.status!=='approved'?`<span class="bdg ${discountInfo.status==='rejected'?'bdg-red':'bdg-ylw'}">🏷️ Discount ${fmt(discountInfo.amount)} ${escH(discountInfo.status)}</span>`:''}
  </div>`;
  const invoiceHtml=`${statusBar}<div id="invoiceContent" style="background:#fff">${sheet}</div>`;
  window.__currentInvoiceSheet=sheet;
  document.getElementById('mOrdDetTitle').textContent='Invoice — '+(o.invoiceNo||o.id||o._docId);
  document.getElementById('mOrdDetBody').innerHTML=invoiceHtml;
  window.__currentInvoiceOrder = o;
  openM('mOrderDetail');
}

// ── Invoice print / PDF / share ─────────────────────────────────────────
// Android app: Print opens Android's print screen (also "Save as PDF") via
// the StfmPrint plugin in MainActivity; PDF and Share build the PDF on the
// phone (html2canvas + jsPDF) and save it or hand it to the share sheet
// (Filesystem + Share plugins). Nothing opens a browser. In a web browser
// the same buttons use the browser's print, download and share.
function _invNative() { return !!window.Capacitor?.isNativePlatform?.(); }
function _invPlugin(name) {
  const C = window.Capacitor;
  if (!C?.isPluginAvailable?.(name)) return null;
  return C.Plugins?.[name] || (C.registerPlugin ? C.registerPlugin(name) : null);
}
function _invFileName() {
  const o = window.__currentInvoiceOrder || {};
  return String(o.invoiceNo || o.id || o._docId || 'invoice').replace(/[^A-Za-z0-9_-]+/g, '-') + '.pdf';
}
function _invDocHtml() {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>${escH(_invFileName().replace(/\.pdf$/, ''))}</title><style>@page{size:A4;margin:10mm}body{margin:0;background:#fff}</style></head>
    <body>${window.__currentInvoiceSheet || ''}</body></html>`;
}
function _invNeedsUpdate(what) {
  showToast(`${what} needs the latest STSB app — install the new APK from your admin`, 'warn');
}

const _scriptLoads = {};
function _loadScriptOnce(src) {
  return _scriptLoads[src] || (_scriptLoads[src] = new Promise((res, rej) => {
    const el = document.createElement('script');
    el.src = src; el.onload = res;
    el.onerror = () => { delete _scriptLoads[src]; rej(new Error('Could not load ' + src)); };
    document.head.appendChild(el);
  }));
}

// Renders the invoice at A4 width off-screen and returns a jsPDF document.
async function _invBuildPdf() {
  await Promise.all([_loadScriptOnce('vendor/html2canvas.js'), _loadScriptOnce('vendor/jspdf.js')]);
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-10000px;top:0;width:794px;background:#fff;z-index:-1';
  host.innerHTML = window.__currentInvoiceSheet || '';
  document.body.appendChild(host);
  try {
    const canvas = await window.html2canvas(host, { scale: 2, backgroundColor: '#ffffff', useCORS: true, logging: false });
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF({ unit: 'pt', format: 'a4', compress: true });
    const pageW = pdf.internal.pageSize.getWidth(), pageH = pdf.internal.pageSize.getHeight(), margin = 18;
    const imgW = pageW - margin * 2, imgH = canvas.height * imgW / canvas.width;
    const img = canvas.toDataURL('image/jpeg', 0.92);
    let shown = 0;
    while (shown < imgH) { // long invoices continue on further pages
      if (shown) pdf.addPage();
      pdf.addImage(img, 'JPEG', margin, margin - shown, imgW, imgH);
      shown += pageH - margin * 2;
    }
    return pdf;
  } finally { host.remove(); }
}

async function _invWriteFile(dir, path, pdf) {
  const fs = _invPlugin('Filesystem');
  const data = pdf.output('datauristring').split(',')[1];
  const r = await fs.writeFile({ path, data, directory: dir, recursive: true });
  return r.uri;
}

async function printInvoice() {
  if (!window.__currentInvoiceSheet) { showToast('No invoice open', 'warn'); return; }
  if (_invNative()) {
    const pr = _invPlugin('StfmPrint');
    if (!pr) { _invNeedsUpdate('Printing'); return; }
    try { await pr.print({ html: _invDocHtml(), name: _invFileName().replace(/\.pdf$/, '') }); }
    catch (e) { showToast('Could not print: ' + (e.message || e), 'error'); }
    return;
  }
  const print = document.getElementById('invoicePrintArea');
  print.innerHTML = `<div style="background:#fff">${window.__currentInvoiceSheet}</div>`;
  print.style.display = 'block';
  window.print();
  setTimeout(() => { print.style.display = 'none'; }, 1000);
}

async function downloadInvoicePDF() {
  if (!window.__currentInvoiceSheet) { showToast('No invoice open', 'warn'); return; }
  const name = _invFileName();
  showToast('Creating PDF…', 'info');
  try {
    const pdf = await _invBuildPdf();
    if (!_invNative()) { pdf.save(name); return; }
    if (!_invPlugin('Filesystem')) { _invNeedsUpdate('Saving PDFs'); return; }
    try {
      await _invWriteFile('DOCUMENTS', 'STSB/' + name, pdf);
      showToast(`PDF saved: Documents/STSB/${name}`, 'success');
    } catch (e) {
      // Some Android versions block shared Documents: offer it to save instead.
      const uri = await _invWriteFile('CACHE', name, pdf);
      const sh = _invPlugin('Share');
      if (sh) await sh.share({ title: name, files: [uri], dialogTitle: 'Save PDF to…' }).catch(() => {});
      else showToast('Could not save the PDF: ' + (e.message || e), 'error');
    }
  } catch (e) { showToast('Could not create the PDF: ' + (e.message || e), 'error'); }
}

async function shareInvoice() {
  const o = window.__currentInvoiceOrder;
  if (!o || !window.__currentInvoiceSheet) return;
  const co = _invoiceCompanyCache && _invoiceCompanyCache.name || INVOICE_DEFAULT_COMPANY.name;
  const text = `*${co}*\nInvoice: ${o.invoiceNo || o.id || o._docId}\nDate: ${o.date}\nOutlet: ${outletName(o.outletId)}\n*Total: ${fmt(o.deliveredTotal ?? o.total)}*`;
  const name = _invFileName();
  showToast('Preparing invoice…', 'info');
  try {
    const pdf = await _invBuildPdf();
    if (_invNative()) {
      const sh = _invPlugin('Share');
      if (!sh || !_invPlugin('Filesystem')) { _invNeedsUpdate('Sharing'); return; }
      const uri = await _invWriteFile('CACHE', name, pdf);
      await sh.share({ title: name, text, files: [uri], dialogTitle: 'Share invoice' });
      return;
    }
    const file = new File([pdf.output('blob')], name, { type: 'application/pdf' });
    if (navigator.canShare?.({ files: [file] })) { await navigator.share({ title: name, text, files: [file] }); return; }
    if (navigator.share) { await navigator.share({ title: name, text }); return; }
    pdf.save(name);
    navigator.clipboard?.writeText(text).catch(() => {});
    showToast('PDF downloaded and invoice details copied', 'success');
  } catch (e) {
    if (e && (e.name === 'AbortError' || /cancel/i.test(e.message || ''))) return; // closed the share sheet
    showToast('Could not share: ' + (e.message || e), 'error');
  }
}

// ═══════════════ MANUAL INVOICE BUILDER ═══════════════
// State for manual invoice items
let _manInvItems = [];  // { pid, name, sku, unit, price, ctnSize, ctnPrice, qty, ctnQty, pcsQty, qtyDisplay, lineTotal }

function openManualInvoice() {
  _manInvItems = [];
  // Reset form
  const outEl = document.getElementById('manInvOutlet');
  if(outEl){
    outEl.innerHTML='<option value="">Select outlet...</option>'+
      allOutlets.map(o=>`<option value="${o.id}">${o.name}${o.route?' ('+o.route+')':''}</option>`).join('');
  }
  const dateEl = document.getElementById('manInvDate');
  if(dateEl) dateEl.value = todayStr ? todayStr() : new Date().toISOString().slice(0,10);
  const notesEl = document.getElementById('manInvNotes');
  if(notesEl) notesEl.value = '';
  _manInvRenderProducts('');
  _manInvRenderItems();
  openM('mManualInvoice');
}

function _manInvRenderProducts(srch) {
  const container = document.getElementById('manInvProductList');
  if(!container) return;
  const q = (srch||'').toLowerCase().trim();
  let prods = allProducts || [];
  if(q) prods = prods.filter(p =>
    (p.name||'').toLowerCase().includes(q) ||
    (p.sku||'').toLowerCase().includes(q) ||
    (p.category||'').toLowerCase().includes(q)
  );
  if(!prods.length){
    container.innerHTML='<div style="padding:16px;text-align:center;color:var(--tx3);font-size:12px">No products found</div>';
    return;
  }
  container.innerHTML = prods.map(p => {
    const inCart = _manInvItems.find(x=>x.pid===p.id);
    const ctnSz = p.ctnSize||p.ctn_size||0;
    const ctnPr = p.ctnPrice||p.ctn_price||0;
    const sqty  = p.stockQty??p.stock_qty??null;
    const stockLabel = sqty!==null
      ? `<span style="font-size:10px;color:${sqty<=0?'var(--red)':sqty<=(ctnSz||5)?'var(--ylw)':'var(--grn)'}">📦 ${sqty}pcs${ctnSz&&sqty>0?' / '+Math.floor(sqty/ctnSz)+'ctn':''}</span>`
      : '';
    return`<div style="display:flex;align-items:center;gap:10px;padding:10px 12px;border-bottom:1px solid var(--bdr);background:${inCart?'rgba(34,197,94,.06)':'transparent'}">
      ${p.photo?`<img src="${p.photo}" style="width:36px;height:36px;border-radius:7px;object-fit:cover;flex-shrink:0">`:`<div style="width:36px;height:36px;border-radius:7px;background:var(--s2);display:flex;align-items:center;justify-content:center;font-size:16px;flex-shrink:0">📦</div>`}
      <div style="flex:1;min-width:0">
        <div style="font-size:12px;font-weight:700;color:var(--tx)">${p.name}${p.sku?`<span style="font-size:10px;color:var(--tx3);margin-left:4px">[${p.sku}]</span>`:''}</div>
        <div style="font-size:11px;color:var(--tx3)">${p.category||''}${p.unit?' · '+p.unit:''}</div>
        <div style="display:flex;gap:8px;align-items:center;margin-top:2px">
          <span style="font-size:11px;font-weight:700;color:var(--acc)">${fmt(p.price)}/pcs</span>
          ${ctnPr&&ctnSz?`<span style="font-size:10px;color:var(--tx2)">${fmt(ctnPr)}/${ctnSz}pcs ctn</span>`:''}
          ${stockLabel}
        </div>
      </div>
      <div style="display:flex;flex-direction:column;gap:4px;align-items:flex-end">
        ${inCart
          ? `<span style="font-size:10px;color:var(--grn);font-weight:700">✓ Added</span>
             <button class="btn btn-ghost btn-xs" onclick="_manInvEditItem('${p.id}')">Edit</button>`
          : `<button class="btn btn-primary btn-xs" onclick="_manInvAddProduct('${p.id}')">+ Add</button>`}
      </div>
    </div>`;
  }).join('');
}

function _manInvAddProduct(pid) {
  const p = allProducts.find(x=>x.id===pid);
  if(!p) return;
  // Show inline qty picker inside the product row
  _manInvOpenQtyPanel(p, 0, 0);
}

function _manInvEditItem(pid) {
  const item = _manInvItems.find(x=>x.pid===pid);
  const p = allProducts.find(x=>x.id===pid);
  if(!p) return;
  _manInvOpenQtyPanel(p, item?.ctnQty||0, item?.pcsQty||0);
}

let _manInvPickerPid = null;
function _manInvOpenQtyPanel(p, initCtn=0, initPcs=0) {
  _manInvPickerPid = p.id;
  const panel = document.getElementById('manInvQtyPanel');
  if(!panel) return;
  const ctnSz = p.ctnSize||p.ctn_size||0;
  const ctnPr = p.ctnPrice||p.ctn_price||(p.price*(ctnSz||1));
  const sqty  = p.stockQty??p.stock_qty??null;
  panel.innerHTML = `
    <div style="background:var(--s1);border:1px solid var(--acc);border-radius:var(--r);padding:14px;margin-bottom:10px">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px">
        <div>
          <div style="font-size:13px;font-weight:700;color:var(--tx)">${p.name}</div>
          <div style="font-size:11px;color:var(--tx3)">${fmt(p.price)}/pcs${ctnSz?` · ${fmt(ctnPr)}/${ctnSz}pcs ctn`:''}</div>
          ${sqty!==null?`<div style="font-size:10px;color:${sqty<=0?'var(--red)':'var(--grn)'}">Stock: ${sqty} pcs</div>`:''}
        </div>
        <button onclick="document.getElementById('manInvQtyPanel').innerHTML=''" style="background:0 0;border:none;color:var(--tx3);cursor:pointer;font-size:16px">✕</button>
      </div>
      ${ctnSz?`
      <div style="margin-bottom:10px">
        <div style="font-size:11px;color:var(--tx2);margin-bottom:4px;font-weight:600">🗃️ Cartons (1 ctn = ${ctnSz} pcs · ${fmt(ctnPr)} each)</div>
        <div style="display:flex;align-items:center;gap:8px">
          <button onclick="var i=document.getElementById('manInvCtnQty');i.value=Math.max(0,(parseInt(i.value)||0)-1)" class="btn btn-ghost btn-sm" style="width:36px;height:36px;padding:0;font-size:18px">−</button>
          <input id="manInvCtnQty" type="number" min="0" value="${initCtn}" class="finp" style="flex:1;text-align:center;font-size:18px;font-weight:700;padding:6px">
          <button onclick="var i=document.getElementById('manInvCtnQty');i.value=(parseInt(i.value)||0)+1" class="btn btn-ghost btn-sm" style="width:36px;height:36px;padding:0;font-size:18px;color:var(--acc)">+</button>
        </div>
      </div>`:''}
      <div style="margin-bottom:12px">
        <div style="font-size:11px;color:var(--tx2);margin-bottom:4px;font-weight:600">📦 Pieces (${fmt(p.price)} each)</div>
        <div style="display:flex;align-items:center;gap:8px">
          <button onclick="var i=document.getElementById('manInvPcsQty');i.value=Math.max(0,(parseInt(i.value)||0)-1)" class="btn btn-ghost btn-sm" style="width:36px;height:36px;padding:0;font-size:18px">−</button>
          <input id="manInvPcsQty" type="number" min="0" value="${initPcs}" class="finp" style="flex:1;text-align:center;font-size:18px;font-weight:700;padding:6px">
          <button onclick="var i=document.getElementById('manInvPcsQty');i.value=(parseInt(i.value)||0)+1" class="btn btn-ghost btn-sm" style="width:36px;height:36px;padding:0;font-size:18px;color:var(--acc)">+</button>
        </div>
      </div>
      <div style="display:flex;gap:8px">
        <button class="btn btn-ghost btn-sm" style="flex:1" onclick="document.getElementById('manInvQtyPanel').innerHTML=''">Cancel</button>
        <button class="btn btn-primary btn-sm" style="flex:1" onclick="_manInvConfirmAdd()">✓ Add to Invoice</button>
      </div>
    </div>`;
  panel.scrollIntoView({behavior:'smooth',block:'nearest'});
}

function _manInvConfirmAdd() {
  const p = allProducts.find(x=>x.id===_manInvPickerPid);
  if(!p) return;
  const ctnSz = p.ctnSize||p.ctn_size||0;
  const ctnPr = p.ctnPrice||p.ctn_price||(p.price*(ctnSz||1));
  const ctnQty = parseInt(document.getElementById('manInvCtnQty')?.value||0)||0;
  const pcsQty = parseInt(document.getElementById('manInvPcsQty')?.value||0)||0;
  const totalPcs = (ctnQty * (ctnSz||1)) + pcsQty;

  if(totalPcs <= 0){ showToast('Enter a quantity','warn'); return; }

  const ctnTotal = ctnQty * ctnPr;
  const pcsTotal = pcsQty * p.price;
  const lineTotal = ctnTotal + pcsTotal;
  const qtyDisplay = ctnSz&&ctnQty>0
    ? (pcsQty>0?`${ctnQty}ctn+${pcsQty}pcs`:`${ctnQty}ctn`)
    : `${totalPcs}pcs`;

  _manInvItems = _manInvItems.filter(x=>x.pid!==p.id);
  _manInvItems.push({
    pid:p.id, name:p.name, sku:p.sku||'', unit:p.unit||'pcs',
    price:p.price, ctnPrice:ctnPr, ctnSize:ctnSz,
    qty:totalPcs, ctnQty, pcsQty, qtyDisplay, lineTotal
  });

  document.getElementById('manInvQtyPanel').innerHTML='';
  _manInvPickerPid=null;
  _manInvRenderProducts(document.getElementById('manInvSearch')?.value||'');
  _manInvRenderItems();
  showToast(`${p.name} added — ${qtyDisplay}`,'success');
}

function _manInvRenderItems() {
  const container = document.getElementById('manInvCartItems');
  if(!container) return;
  if(!_manInvItems.length){
    container.innerHTML='<div style="padding:16px;text-align:center;color:var(--tx3);font-size:12px">No items added yet</div>';
    document.getElementById('manInvTotal') && (document.getElementById('manInvTotal').textContent='RM 0.00');
    return;
  }
  const total = _manInvItems.reduce((s,x)=>s+x.lineTotal,0);
  container.innerHTML = _manInvItems.map((item,i)=>`
    <div style="display:flex;align-items:center;gap:8px;padding:9px 12px;border-bottom:1px solid var(--bdr)">
      <div style="flex:1;min-width:0">
        <div style="font-size:12px;font-weight:700;color:var(--tx)">${item.name}${item.sku?`<span style="font-size:10px;color:var(--tx3);margin-left:4px">[${item.sku}]</span>`:''}</div>
        <div style="font-size:11px;color:var(--tx3)">${item.qtyDisplay}</div>
      </div>
      <div style="font-size:12px;font-weight:700;color:var(--acc);flex-shrink:0">${fmt(item.lineTotal)}</div>
      <button onclick="_manInvEditItem('${item.pid}')" style="background:0 0;border:none;color:var(--tx3);cursor:pointer;font-size:13px;padding:0 2px" title="Edit">✏️</button>
      <button onclick="_manInvItems.splice(${i},1);_manInvRenderItems();_manInvRenderProducts(document.getElementById('manInvSearch')?.value||'')" style="background:0 0;border:none;color:var(--tx3);cursor:pointer;font-size:13px;padding:0 2px" title="Remove">✕</button>
    </div>`).join('');
  if(document.getElementById('manInvTotal'))
    document.getElementById('manInvTotal').textContent=fmt(total);
}

async function saveManualInvoice() {
  const outletId = document.getElementById('manInvOutlet')?.value;
  if(!outletId){showToast('Select an outlet','error');return;}
  if(!_manInvItems.length){showToast('Add at least one product','error');return;}

  const date = document.getElementById('manInvDate')?.value || new Date().toISOString().slice(0,10);
  const notes = document.getElementById('manInvNotes')?.value||'';
  const total = _manInvItems.reduce((s,x)=>s+x.lineTotal,0);
  const ordId = 'INV-'+uid6();

  try {
    // Save as a confirmed order (manual invoices skip approval)
    await sfAdd('orders',{
      id:ordId, outletId,
      items:_manInvItems.map(x=>({
        pid:x.pid, name:x.name, sku:x.sku, unit:x.unit,
        price:x.price, ctnPrice:x.ctnPrice, ctnSize:x.ctnSize,
        qty:x.qty, ctnQty:x.ctnQty, pcsQty:x.pcsQty,
        qtyDisplay:x.qtyDisplay, _lineTotal:x.lineTotal
      })),
      subtotal:total, total,
      discount:null,
      date, notes,
      status:'Confirmed',
      type:'manual_invoice',
      approvedBy:CU.uid, approvedAt:new Date().toISOString(), approvedByName:CU.name,
      erpSynced:false, erpHeld:false,
      createdBy:CU.uid, createdByName:CU.name,
      createdAt:window.__SF.serverTimestamp()
    });

    // ERP sync happens server-side (erpBridge) from the saved invoice items

    closeM('mManualInvoice');
    _manInvItems=[];
    showToast(`Manual Invoice ${ordId} created ✅ · Sent to ERP`,'success');
    invalidateDashCache();loadOrders();renderDashboard();updateBadges();
  } catch(e){
    showToast('Failed to save invoice: '+e.message,'error');
    console.error('[manualInvoice]',e);
  }
}
