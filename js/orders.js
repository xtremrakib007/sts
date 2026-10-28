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
    ? `<div class="oc-prod-grid" style="padding-top:4px">${matches.map(p => ocProductCard(p)).join('')}</div>`
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
      <div class="oc-prod-grid">
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

function ocProductCard(p){
  const inCart = ordItems.find(x=>x.pid===p.id);
  const cartBadge = inCart ? `<div class="oc-cart-badge">${inCart.qtyDisplay||inCart.qty}</div>` : '';
  const photo = p.photo ? `<img src="${p.photo}" style="width:100%;height:100%;object-fit:cover;border-radius:10px 10px 0 0">` : '📦';

  // ── Stock display: ERP inventory first, fall back to product's own stockQty ──
  const stock = _getStock(p);
  const avail = _availableQty(stock);
  // App-level stock (pcs & ctn) — from product record
  const appQty  = p.stockQty ?? p.stock_qty ?? null;
  const ctnSz   = p.ctnSize  ?? p.ctn_size  ?? 0;
  const appCtns = (appQty !== null && ctnSz > 0) ? Math.floor(appQty / ctnSz) : null;
  const ctnPr   = p.ctnPrice ?? p.ctn_price ?? null;

  let stockBadge = '';
  if (stock !== null && avail !== null) {
    // ERP stock takes precedence for badge colour/number
    if (avail <= 0) {
      stockBadge = `<div style="position:absolute;top:6px;left:6px;background:rgba(239,68,68,.9);color:#fff;font-size:9px;font-weight:700;padding:2px 6px;border-radius:4px">OUT</div>`;
    } else if (avail <= (stock.minStock || 5)) {
      stockBadge = `<div style="position:absolute;top:6px;left:6px;background:rgba(245,158,11,.9);color:#fff;font-size:9px;font-weight:700;padding:2px 6px;border-radius:4px">LOW ${avail}</div>`;
    } else {
      stockBadge = `<div style="position:absolute;top:6px;left:6px;background:rgba(34,197,94,.85);color:#fff;font-size:9px;font-weight:700;padding:2px 6px;border-radius:4px">${avail} ${stock.unit||p.unit||'pcs'}</div>`;
    }
  } else if (appQty !== null) {
    // No ERP record — use app-level stockQty
    const color = appQty <= 0 ? 'rgba(239,68,68,.9)' : appQty <= (ctnSz || 5) ? 'rgba(245,158,11,.9)' : 'rgba(34,197,94,.85)';
    const label = appQty <= 0 ? 'OUT' : `${appQty}pcs${appCtns !== null ? ' / '+appCtns+'ctn' : ''}`;
    stockBadge = `<div style="position:absolute;top:6px;left:6px;background:${color};color:#fff;font-size:9px;font-weight:700;padding:2px 6px;border-radius:4px">${label}</div>`;
  }

  // Price line: show pcs price + ctn price if available
  const priceHtml = ctnPr && ctnSz
    ? `<div class="oc-prod-price">${fmt(p.price)}<span style="font-size:9px;color:var(--tx3);margin-left:4px">/ pcs</span></div>
       <div style="font-size:10px;color:var(--tx2);margin-top:1px">Ctn ${ctnSz}pcs: <strong>${fmt(ctnPr)}</strong></div>`
    : `<div class="oc-prod-price">${fmt(p.price)}</div>`;

  return`<div class="oc-prod-card" onclick="openQtyPicker('${p.id}')" id="ocProd-${p.id}" style="position:relative">
    ${cartBadge}
    ${stockBadge}
    <div class="oc-prod-photo">${photo}</div>
    <div class="oc-prod-info">
      <div class="oc-prod-name">${p.name}</div>
      ${p.unit?`<div class="oc-prod-unit">${p.unit}</div>`:''}
      ${priceHtml}
    </div>
  </div>`;
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
  const cnt=ordItems.reduce((s,x)=>s+x.qty,0);
  document.getElementById('ocCartCount').textContent=cnt;
  btn.style.display=cnt?'inline-flex':'none';
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
    const lineTotal=item.price*item.qty;
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
  const lineTotal=ordItems[idx].price*ordItems[idx].qty;
  const rawVal=parseFloat(val)||0;
  disc.value=rawVal;
  if(disc.type==='percent'){disc.amount=Math.min(lineTotal,(rawVal/100)*lineTotal);}
  else if(disc.type==='fixed'){disc.amount=Math.min(lineTotal,rawVal);}
  else{disc.amount=0;}
  ordItems[idx].discount=disc;
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
  qpCtnQty = item.ctnQty || 0;
  qpPcsQty = item.pcsQty || item.qty || 0;
  ocBackToProducts();
  setTimeout(()=>openQtyPicker(item.pid),100);
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

async function viewOrder(docId) {
  const _od=await window.__SF.getDoc(docRef('orders',docId));
  const o=_od.exists()?{_docId:_od.id,..._od.data()}:null;
  if(!o)return;
  const sBadge={Pending:'bdg-ylw',Confirmed:'bdg-blu',Delivered:'bdg-grn',Cancelled:'bdg-red'};
  const outlet=allOutlets.find(x=>x.id===o.outletId)||{name:'Unknown',address:'',phone:''};
  const createdByUser=allUsers.find(u=>u.uid===o.createdBy)||{name:o.createdByName||'Unknown'};
  const subtotal=(o.items||[]).reduce((s,it)=>s+(it.price*it.qty),0);
  const discountInfo=o.discount&&o.discount.amount>0?o.discount:null;
  const finalTotal=o.total;
  const invoiceHtml=`
  <div id="invoiceContent" style="background:#fff;color:#1a1a1a;padding:28px 30px;font-family:'DM Sans',sans-serif">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:22px;padding-bottom:18px;border-bottom:2px solid #f0f0f0">
      <div>
        <div style="font-family:'Syne',sans-serif;font-size:22px;font-weight:800;color:#22c55e;letter-spacing:-.5px">SAIRAH TRADING SDN BHD</div>
        <div style="font-size:12px;color:#888;margin-top:3px">Sales & Distribution Management</div>
        ${o.erpSynced?'<div style="font-size:10px;color:#22c55e;margin-top:2px">✓ Synced to ERP</div>':'<div style="font-size:10px;color:#f59e0b;margin-top:2px">⏳ Pending ERP sync</div>'}
      </div>
      <div style="text-align:right">
        <div style="font-family:'Syne',sans-serif;font-size:28px;font-weight:800;color:#1a1a1a;letter-spacing:-1px">INVOICE</div>
        <div style="font-size:14px;font-weight:700;color:#22c55e;margin-top:2px">${o.invoiceNo||o.id||o._docId}</div>
        ${o.invoiceNo?`<div style="font-size:11px;color:#888">Order ${o.id||o._docId}</div>`:''}
        <div style="margin-top:6px"><span style="display:inline-block;padding:3px 10px;border-radius:20px;font-size:11px;font-weight:700;background:${o.status==='Delivered'?'#dcfce7':o.status==='Cancelled'?'#fee2e2':o.status==='Confirmed'?'#dbeafe':'#fef9c3'};color:${o.status==='Delivered'?'#16a34a':o.status==='Cancelled'?'#dc2626':o.status==='Confirmed'?'#1d4ed8':'#b45309'}">${o.status}</span></div>
      </div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:22px">
      <div style="background:#fafafa;border-radius:8px;padding:14px;border:1px solid #f0f0f0">
        <div style="font-size:10px;font-weight:700;color:#999;letter-spacing:.8px;text-transform:uppercase;margin-bottom:7px">BILL TO</div>
        <div style="font-weight:700;font-size:14px;color:#1a1a1a">${outlet.name}</div>
        ${outlet.type?`<div style="font-size:12px;color:#666;margin-top:2px">${outlet.type}${outlet.area?' · '+outlet.area:''}</div>`:''}
        ${outlet.phone?`<div style="font-size:12px;color:#666;margin-top:2px">📞 ${outlet.phone}</div>`:''}
        ${outlet.address?`<div style="font-size:11px;color:#888;margin-top:4px;line-height:1.4">📍 ${outlet.address}</div>`:''}
        ${outlet.route?`<div style="font-size:11px;color:#888;margin-top:3px">🗺️ Route: ${outlet.route}</div>`:''}
      </div>
      <div style="background:#fafafa;border-radius:8px;padding:14px;border:1px solid #f0f0f0">
        <div style="font-size:10px;font-weight:700;color:#999;letter-spacing:.8px;text-transform:uppercase;margin-bottom:7px">INVOICE DETAILS</div>
        <div style="display:flex;flex-direction:column;gap:5px">
          <div style="display:flex;justify-content:space-between;font-size:12px"><span style="color:#666">Date:</span><span style="font-weight:600">${o.date||'—'}</span></div>
          <div style="display:flex;justify-content:space-between;font-size:12px"><span style="color:#666">Sales Rep:</span><span style="font-weight:600">${createdByUser.name}</span></div>
          ${o.approvedBy?`<div style="display:flex;justify-content:space-between;font-size:12px"><span style="color:#666">Approved By:</span><span style="font-weight:600">${userName(o.approvedBy)}</span></div>`:''}
          <div style="display:flex;justify-content:space-between;font-size:12px"><span style="color:#666">Items:</span><span style="font-weight:600">${(o.items||[]).length}</span></div>
          <div style="display:flex;justify-content:space-between;font-size:12px"><span style="color:#666">Delivery:</span><span style="font-weight:600;color:#3b82f6">Managed by ERP</span></div>
        </div>
      </div>
    </div>
    <table style="width:100%;border-collapse:collapse;margin-bottom:18px">
      <thead>
        <tr style="background:#22c55e">
          <th style="text-align:left;padding:9px 12px;font-size:11px;font-weight:700;color:#fff;letter-spacing:.5px;border-radius:6px 0 0 6px">ITEM</th>
          <th style="text-align:center;padding:9px 12px;font-size:11px;font-weight:700;color:#fff;letter-spacing:.5px">QTY</th>
          <th style="text-align:right;padding:9px 12px;font-size:11px;font-weight:700;color:#fff;letter-spacing:.5px">UNIT PRICE</th>
          <th style="text-align:right;padding:9px 12px;font-size:11px;font-weight:700;color:#fff;letter-spacing:.5px;border-radius:0 6px 6px 0">AMOUNT</th>
        </tr>
      </thead>
      <tbody>
        ${(o.items||[]).map((it,i)=>`
        <tr style="border-bottom:1px solid #f5f5f5;background:${i%2===0?'#fff':'#fafafa'}">
          <td style="padding:9px 12px;font-size:13px;font-weight:600;color:#1a1a1a">${it.name}${it.sku?`<span style="font-size:10px;color:#999;margin-left:4px">[${it.sku}]</span>`:''}</td>
          <td style="padding:9px 12px;font-size:13px;text-align:center;color:#444">${it.qtyDisplay||it.qty}</td>
          <td style="padding:9px 12px;font-size:13px;text-align:right;color:#444">${fmt(it.price)}</td>
          <td style="padding:9px 12px;font-size:13px;text-align:right;font-weight:700;color:#22c55e">${fmt(it.price*it.qty)}</td>
        </tr>`).join('')}
      </tbody>
    </table>
    <div style="display:flex;justify-content:flex-end;margin-bottom:18px">
      <div style="min-width:240px">
        <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #f0f0f0;font-size:13px"><span style="color:#666">Subtotal</span><span style="font-weight:600">${fmt(subtotal)}</span></div>
        ${discountInfo?`<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #f0f0f0;font-size:13px">
          <span style="color:${discountInfo.status==='approved'?'#16a34a':discountInfo.status==='rejected'?'#dc2626':'#b45309'}">
            🏷️ Discount${discountInfo.type==='multi'?' ('+((discountInfo.items||[]).length)+' items)':discountInfo.type==='percent'?' ('+discountInfo.value+'%)':''}
            <span style="font-size:10px">(${discountInfo.status})</span>
          </span>
          <span style="font-weight:600;color:${discountInfo.status==='approved'?'#16a34a':'#b45309'}">−${fmt(discountInfo.amount)}</span>
        </div>`:''}
        <div style="display:flex;justify-content:space-between;padding:6px 0;font-size:13px"><span style="color:#666">GST/SST</span><span style="color:#999">—</span></div>
        <div style="display:flex;justify-content:space-between;padding:9px 12px;margin-top:4px;background:#1a1a1a;border-radius:8px">
          <span style="font-weight:700;color:#fff;font-size:14px">TOTAL</span>
          <span style="font-family:'Syne',sans-serif;font-weight:800;color:#22c55e;font-size:18px">${fmt(finalTotal)}</span>
        </div>
      </div>
    </div>
    ${o.notes?`<div style="background:#fff9f0;border:1px solid #fed7aa;border-radius:8px;padding:11px 14px;font-size:12px;color:#7c3c00;margin-bottom:14px">📝 Notes: ${o.notes}</div>`:''}
    <div style="border-top:1px solid #f0f0f0;padding-top:14px;text-align:center;font-size:11px;color:#999">
      <div>Thank you for your business · Sairah Trading Sdn Bhd</div>
    </div>
  </div>`;
  document.getElementById('mOrdDetTitle').textContent='Invoice — '+(o.invoiceNo||o.id||o._docId);
  document.getElementById('mOrdDetBody').innerHTML=invoiceHtml;
  window.__currentInvoiceOrder = o;
  openM('mOrderDetail');
}

function printInvoice() {
  const content=document.getElementById('invoiceContent');
  if(!content)return;
  const print=document.getElementById('invoicePrintArea');
  print.innerHTML=content.outerHTML;
  print.style.display='block';
  window.print();
  setTimeout(()=>{print.style.display='none';},1000);
}

function downloadInvoicePDF() {
  const content=document.getElementById('invoiceContent');
  if(!content){showToast('No invoice open','warn');return;}
  const o=window.__currentInvoiceOrder;
  const html=`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Invoice ${o?.id||''}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Syne:wght@400;700;800&family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>body{margin:0;font-family:'DM Sans',sans-serif;background:#fff;}</style>
  </head><body>${content.outerHTML}
  <script>window.onload=function(){window.print();}<\/script>
  </body></html>`;
  const blob=new Blob([html],{type:'text/html'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');
  a.href=url;a.target='_blank';
  a.click();
  setTimeout(()=>URL.revokeObjectURL(url),3000);
  showToast('PDF opened in new tab — use browser Print to save as PDF','info');
}

function shareInvoice() {
  const o=window.__currentInvoiceOrder;
  if(!o)return;
  const text=`*SAIRAH TRADING SDN BHD*\nInvoice: ${o.invoiceNo||o.id||o._docId}\nDate: ${o.date}\nOutlet: ${outletName(o.outletId)}\nItems: ${(o.items||[]).length}\n*Total: ${fmt(o.total)}*\nStatus: ${o.status}`;
  if(navigator.share){
    navigator.share({title:`Invoice ${o.id}`,text}).catch(()=>{});
  } else {
    navigator.clipboard?.writeText(text).then(()=>showToast('Invoice details copied to clipboard','success')).catch(()=>showToast('Could not share','error'));
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
