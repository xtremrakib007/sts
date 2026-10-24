// ═══════════════ ORDERS ═══════════════
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
    document.getElementById('ordersRoleNote').textContent='Admins can approve, confirm, and manage all orders.';
  } else {
    document.getElementById('ordersRoleNote').textContent='You can create orders. Approval is done by admin/sub-admin.';
  }

  const {where}=window.__SF;
  const ordDocs = isAdmin()&&repF ? await sfGet('orders',[where('createdBy','==',repF)])
    : isAdmin() ? await sfGet('orders')
    : await sfGet('orders',[where('createdBy','==',CU.uid)]);
  // _docId = real Firestore document ID; id = stored ORD-XXXX display ID
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
    const discBadge=hasDiscount?`<span class="bdg ${o.discount.status==='approved'?'bdg-grn':o.discount.status==='rejected'?'bdg-red':'bdg-ylw'}" style="font-size:10px;margin-left:4px" title="Discount: ${o.discount.type==='percent'?o.discount.value+'%':fmt(o.discount.amount)}">🏷️${o.discount.status==='pending'?'?':o.discount.status==='approved'?'✓':'✕'}</span>`:'';
    const dm=o.deliveryManId?allUsers.find(u=>u.uid===o.deliveryManId):null;
    // Sales rep can assign delivery on their own confirmed orders; admin can always assign
    const canAssign=(isAdmin()||(CU.role==='sales_rep'&&o.createdBy===CU.uid))&&o.status==='Confirmed';
    const delivCell=dm
      ?`<div style="display:flex;align-items:center;gap:5px"><div class="ava ava-sm" style="background:var(--grn)">${dm.name[0]}</div><span style="font-size:11px">${dm.name.split(' ')[0]}</span></div>`
      :(canAssign?`<button class="btn btn-ylw btn-xs" onclick="openAssignDelivery('${o._docId}')">🚚 Assign</button>`:'<span style="color:var(--tx3);font-size:11px">—</span>');
    return`<tr>
    <td><span style="font-family:'Syne',sans-serif;font-weight:700;font-size:12px">${o.id||o._docId}</span></td>
    <td style="font-size:12px">${outletName(o.outletId)}</td>
    <td style="font-size:12px;color:var(--tx2)">${userName(o.createdBy)}</td>
    <td style="font-size:12px;color:var(--tx2)">${o.items?.length||0} item${(o.items?.length||0)!==1?'s':''}</td>
    <td><span style="font-family:'Syne',sans-serif;font-weight:700;color:var(--acc)">${fmt(o.total)}</span>${discBadge}</td>
    <td style="font-size:12px;color:var(--tx2)">${o.date||'—'}</td>
    <td><span class="bdg ${sBadge[o.status]||'bdg-gry'}">${o.status}</span></td>
    <td>${delivCell}</td>
    <td>
      <div style="display:flex;gap:5px;flex-wrap:wrap">
        <button class="btn btn-ghost btn-xs" onclick="viewOrder('${o._docId}')">👁</button>
        ${isAdmin()&&o.status==='Pending'?`<button class="btn btn-grn btn-xs" onclick="approveOrder('${o._docId}')">${hasDiscount&&o.discount.status==='pending'?'✓ Approve+Disc':'✓ Approve'}</button>`:''}
        ${isAdmin()&&o.status==='Confirmed'&&!o.deliveryManId?`<button class="btn btn-blu btn-xs" onclick="deliverOrder('${o._docId}')">✓ Deliver</button>`:''}
        ${isAdmin()&&(o.status==='Pending'||o.status==='Confirmed')?`<button class="btn btn-red btn-xs" onclick="cancelOrder('${o._docId}')">✕</button>`:''}
        ${isStrictAdmin()?`<button class="btn btn-red btn-xs" onclick="deleteOrder('${o._docId}','Order ${o.id||o._docId}','${o._zoneId||""}')" title="Permanently delete">🗑</button>`:''}
      </div>
    </td>
  </tr>`;}).join('')||'<tr><td colspan="9" style="text-align:center;padding:24px;color:var(--tx3)">No orders found</td></tr>';

  updateBadges();
}

// ═══════════════ ORDER CATALOG (Full-screen, mobile-first) ═══════════════
let ocSelectedCat = null; // currently highlighted category pill
let qpProduct = null;     // product being qty-picked
let qpUnit = 'pcs';       // 'pcs' or 'ctn'
let qpQty = 1;

// Open the catalog — entry point
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

  // Reset cart and discount
  ordItems=[];

  // Populate route dropdown for filtering
  const routeSel=document.getElementById('ordRoute');
  if(routeSel){
    routeSel.innerHTML='<option value="">All Routes</option>'+
      allRoutes.map(r=>`<option value="${r.id}">${r.name}</option>`).join('');
  }

  // Populate outlet dropdown (rep sees only their own outlets)
  const visibleOutlets=isAdmin()?allOutlets:allOutlets.filter(o=>o.createdBy===CU.uid||o.assignedRepId===CU.uid);
  window._ocAllOutlets=visibleOutlets.filter(o=>o.balanceStatus!=='pending'||!o.openingBalance);
  _ocPopulateOutlets('');
  document.getElementById('ordDate').value=todayStr();
  document.getElementById('ordNotes').value='';

  const oc=document.getElementById('orderCatalog');
  oc.style.display='flex';
  document.body.style.overflow='hidden';

  // If a QR-scanned outlet is pre-selected, skip step 1 and jump straight to products
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

  // Normal flow — show step 1
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
  // Clear search when entering product step
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
  // Clear search on return
  const srch=document.getElementById('ocSearch');if(srch)srch.value='';
  const bar=document.getElementById('ocCatBar');if(bar)bar.style.display='flex';
  ocRenderCatalog();
  ocUpdateCartBtn();
}

// Product search filter
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
  // Hide category pills when searching
  const bar = document.getElementById('ocCatBar');
  if (bar) bar.style.display = q ? 'none' : 'flex';
  // Disconnect category observer during search
  if (window._ocObserver) window._ocObserver.disconnect();
}

// Build category pills + product cards
function ocRenderCatalog(){
  const available=allProducts.filter(p=>p.stockStatus!=='out_of_stock');
  const grouped={};
  available.forEach(p=>{
    const c=p.category||'Other';
    if(!grouped[c])grouped[c]=[];
    grouped[c].push(p);
  });
  const cats=Object.keys(grouped).sort();

  // Category pill bar
  const bar=document.getElementById('ocCatBar');
  bar.innerHTML=`<button class="oc-cat-pill active" id="ocCat-all" onclick="ocScrollToAll()">🏷️ All</button>`+
    cats.map(c=>`<button class="oc-cat-pill" id="ocCat-${CSS.escape(c)}" onclick="ocScrollToCat('${c.replace(/'/g,"\\'")}')">
      ${getCatEmoji(c)} ${c} <span style="font-size:10px;opacity:.6">${grouped[c].length}</span>
    </button>`).join('');

  // Product list grouped by category
  const list=document.getElementById('ocProductList');
  list.innerHTML=cats.map(cat=>`
    <div class="oc-cat-section" data-cat="${cat}" id="ocSec-${cat.replace(/\s+/g,'_')}">
      <div class="oc-cat-heading">${getCatEmoji(cat)} ${cat}</div>
      <div class="oc-prod-grid">
        ${grouped[cat].map(p=>ocProductCard(p)).join('')}
      </div>
    </div>`).join('');

  ocUpdateCartBtn();

  // Intersection observer to highlight active category pill
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
  const inCart=ordItems.find(x=>x.pid===p.id);
  const cartBadge=inCart?`<div class="oc-cart-badge">${inCart.qtyDisplay||inCart.qty}</div>`:'';
  const photo=p.photo?`<img src="${p.photo}" style="width:100%;height:100%;object-fit:cover;border-radius:10px 10px 0 0">`:'📦';
  return`<div class="oc-prod-card" onclick="openQtyPicker('${p.id}')" id="ocProd-${p.id}">
    ${cartBadge}
    <div class="oc-prod-photo">${photo}</div>
    <div class="oc-prod-info">
      <div class="oc-prod-name">${p.name}</div>
      ${p.unit?`<div class="oc-prod-unit">${p.unit}</div>`:''}
      <div class="oc-prod-price">${fmt(p.price)}</div>
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

// ── Quantity Picker ──
function openQtyPicker(pid){
  const p=allProducts.find(x=>x.id===pid);
  if(!p)return;
  qpProduct=p;
  qpQty=1;

  // Check if already in cart
  const existing=ordItems.find(x=>x.pid===pid);
  if(existing){qpQty=existing.qty;qpUnit=existing.unit||'pcs';}
  else{qpUnit='pcs';}

  // Photo
  const photo=document.getElementById('qpPhoto');
  photo.innerHTML=p.photo?`<img src="${p.photo}" style="width:100%;height:100%;object-fit:cover;border-radius:10px">`:'📦';

  document.getElementById('qpName').textContent=p.name;
  document.getElementById('qpPrice').textContent=fmt(p.price)+' / pcs';

  // Show CTN option only if ctnSize defined
  const hasCtn=p.ctnSize>0;
  document.getElementById('qpUnitRow').style.display=hasCtn?'flex':'none';
  document.getElementById('qpUnitNote').textContent=hasCtn?`1 CTN = ${p.ctnSize} pcs`:'';

  qpSetUnit(qpUnit);
  qpRender();

  const m=document.getElementById('mQtyPicker');
  m.style.display='flex';
  document.body.style.overflow='hidden';
}

function closeQtyPicker(){
  document.getElementById('mQtyPicker').style.display='none';
  document.body.style.overflow='hidden'; // catalog is still open
}

function qpSetUnit(u){
  qpUnit=u;
  const active='background:var(--acc);color:#fff;border:none;';
  const ghost='background:var(--s2);color:var(--tx2);border:1px solid var(--bdr);';
  document.getElementById('qpBtnCtn').style.cssText=(u==='ctn'?active:ghost)+'flex:1;';
  document.getElementById('qpBtnPcs').style.cssText=(u==='pcs'?active:ghost)+'flex:1;';
  document.getElementById('qpQtyUnit').textContent=u==='ctn'?'carton(s)':'piece(s)';
  const p=qpProduct;
  if(p){
    const pricePerUnit=u==='ctn'&&p.ctnSize?p.price*p.ctnSize:p.price;
    document.getElementById('qpPrice').textContent=fmt(pricePerUnit)+' / '+(u==='ctn'?'ctn':'pcs');
  }
  qpRender();
}

function qpStep(delta){
  qpQty=Math.max(1,qpQty+delta);
  qpRender();
}

function qpRender(){
  const p=qpProduct;if(!p)return;
  const pricePerUnit=(qpUnit==='ctn'&&p.ctnSize)?p.price*p.ctnSize:p.price;
  const total=pricePerUnit*qpQty;
  const inp=document.getElementById('qpQtyDisp');
  if(inp){inp.value=qpQty;}
  document.getElementById('qpSubtotal').textContent=`Subtotal: ${fmt(total)}`;
}

function qpManualQty(val){
  const n=parseInt(val);
  if(n&&n>0){qpQty=n;}
  else{qpQty=1;}
  // Re-render subtotal only (don't reset input value which user is typing)
  const p=qpProduct;if(!p)return;
  const pricePerUnit=(qpUnit==='ctn'&&p.ctnSize)?p.price*p.ctnSize:p.price;
  const total=pricePerUnit*qpQty;
  document.getElementById('qpSubtotal').textContent=`Subtotal: ${fmt(total)}`;
}

function qpAddToCart(){
  const p=qpProduct;if(!p)return;
  const pcsPerUnit=(qpUnit==='ctn'&&p.ctnSize)?p.ctnSize:1;
  const pricePerUnit=(qpUnit==='ctn'&&p.ctnSize)?p.price*p.ctnSize:p.price;
  const totalPcs=qpQty*pcsPerUnit;

  // Remove existing entry for this product
  ordItems=ordItems.filter(x=>x.pid!==p.id);
  ordItems.push({
    pid:p.id,name:p.name,price:pricePerUnit,qty:qpQty,
    unit:qpUnit,pcsEach:pcsPerUnit,totalPcs,
    qtyDisplay:qpUnit==='ctn'?`${qpQty}ctn`:qpQty+'pcs'
  });

  closeQtyPicker();
  // Refresh the card badge
  const cardEl=document.getElementById('ocProd-'+p.id);
  if(cardEl){
    const existing=cardEl.querySelector('.oc-cart-badge');
    const badge=document.createElement('div');
    badge.className='oc-cart-badge';
    badge.textContent=qpUnit==='ctn'?`${qpQty}ctn`:qpQty+'pcs';
    if(existing)existing.replaceWith(badge);else cardEl.prepend(badge);
    cardEl.classList.add('oc-in-cart');
  }
  ocUpdateCartBtn();
  showToast(`${p.name} added to cart 🛒`,'success');
}

// ── Cart Review ──
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
  const subtotal=ordItems.reduce((s,x)=>s+(x.price*x.qty),0);
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
  // Update line totals in DOM
  ordItems.forEach((item,i)=>{
    // Already rendered in ocRenderCart — no DOM update needed here
  });
}

function ocEditItem(i){
  const item=ordItems[i];
  if(!item)return;
  qpUnit=item.unit||'pcs';
  qpQty=item.qty;
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

async function saveOrder() {
  const outletId=document.getElementById('ordOutlet').value;
  if(!outletId){showToast('Select an outlet','error');return;}
  if(!ordItems.length){showToast('Add at least one item','error');return;}
  const subtotal=ordItems.reduce((s,x)=>s+x.price*x.qty,0);

  // Per-item discounts — collect all items that have a discount request
  const totalDiscountAmt=ordItems.reduce((s,x)=>s+(x.discount?.amount||0),0);
  const itemDiscounts=ordItems.map(x=>({
    pid:x.pid,name:x.name,
    discountType:x.discount?.type||'',
    discountValue:x.discount?.value||0,
    discountAmount:x.discount?.amount||0,
  })).filter(x=>x.discountAmount>0);

  // Build a combined discount request object for backward compatibility
  let discountRequest=null;
  if(totalDiscountAmt>0){
    discountRequest={
      type:'multi',
      amount:totalDiscountAmt,
      status:'pending',
      requestedBy:CU.uid,
      requestedByName:CU.name,
      items:itemDiscounts,
    };
  }

  const total=subtotal; // total stays full price until admin approves discount
  const ordId='ORD-'+uid6();
  try{
    await sfAdd('orders',{
      id:ordId,outletId,items:[...ordItems],subtotal,total,
      discount:discountRequest||null,
      date:document.getElementById('ordDate').value,
      status:'Pending',
      notes:document.getElementById('ordNotes').value,
      createdBy:CU.uid,createdByName:CU.name,
      approvedBy:'',approvedAt:'',
      createdAt:window.__SF.serverTimestamp()
    });
    closeOrderCatalog();
    const discMsg=discountRequest?` Discount of ${fmt(totalDiscountAmt)} requested across ${itemDiscounts.length} item(s) — pending admin approval.`:'';
    invalidateDashCache();showToast(`Order ${ordId} placed — awaiting approval 📦`+(discMsg?'\n'+discMsg:''),'success');
    loadOrders();renderDashboard();updateBadges();updateSidebarStats();
    // 🔔 Notify admins
    notifyAdmins('📦 New Order Placed',`${CU.name} placed ${ordId} — awaiting approval`,{tag:'order-new',ordId});
  }catch(e){showToast('Failed to place order: '+e.message,'error');}
}

// legacy stubs (no longer used but kept so nothing breaks)
function renderOrderItems(){}
function addItem(){}
function rmOrdItem(){}
function updOrdItem(){}

async function approveOrder(id) {
  if(!isAdmin()){showToast('Only admin can approve orders','error');return;}
  const ordDoc=await window.__SF.getDoc(docRef('orders',id));
  const o=ordDoc.exists()?{_docId:ordDoc.id,...ordDoc.data()}:null;
  if(!o)return;
  // If order has a pending discount, ask admin to decide
  if(o.discount&&o.discount.status==='pending'){
    const discAmt=o.discount.amount||0;
    const discLabel=o.discount.type==='multi'
      ? `${fmt(discAmt)} across ${(o.discount.items||[]).length} item(s)`
      : o.discount.type==='percent'?`${o.discount.value}% (${fmt(discAmt)})`:fmt(discAmt);
    const choice=confirm(`This order has a pending discount request: ${discLabel}\n\nClick OK to APPROVE the discount, or Cancel to REJECT it and keep full price.`);
    const discStatus=choice?'approved':'rejected';
    const newTotal=choice?(o.subtotal||o.total)-discAmt:(o.subtotal||o.total);
    await sfUpdate('orders',id,{
      status:'Confirmed',
      approvedBy:CU.uid,
      approvedAt:new Date().toISOString(),
      total:newTotal,
      discount:{...o.discount,status:discStatus,decidedBy:CU.uid,decidedAt:new Date().toISOString()}
    });
    showToast(`Order confirmed ✅ · Discount ${discStatus}`,'success');
  } else {
    await sfUpdate('orders',id,{status:'Confirmed',approvedBy:CU.uid,approvedAt:new Date().toISOString()});
    showToast('Order confirmed ✅','success');
  }
  invalidateDashCache();loadOrders();renderDashboard();updateBadges();
  // 🔔 Notify rep
  try{const _aODoc=await window.__SF.getDoc(window.__SF.doc(window.__SF.db,_zonePath('orders'),id));if(_aODoc.exists()){const _aOD=_aODoc.data();notifyRep(_aOD.createdBy,'✅ Order Confirmed',`Your order ${_aOD.id||id} has been confirmed by admin`,{tag:'order-confirmed'});}}
  catch(e){}
}
async function deliverOrder(id) {
  if(!isAdmin()){showToast('Only admin can mark delivered','error');return;}
  await sfUpdate('orders',id,{status:'Delivered'});
  showToast('Order marked as delivered','success');invalidateDashCache();loadOrders();renderDashboard();
  // 🔔 Notify rep
  try{const _dODoc=await window.__SF.getDoc(window.__SF.doc(window.__SF.db,_zonePath('orders'),id));if(_dODoc.exists()){const _dOD=_dODoc.data();notifyRep(_dOD.createdBy,'🚚 Order Delivered',`Order ${_dOD.id||id} has been delivered`,{tag:'order-delivered'});}}
  catch(e){}
}
async function cancelOrder(id) {
  if(!isAdmin()){showToast('Only admin/sub-admin can cancel orders','error');return;}
  const ordDoc=await window.__SF.getDoc(docRef('orders',id));
  const o=ordDoc.exists()?ordDoc.data():null;
  const label=o?`Order ${o.id||id}`:`Order ${id}`;
  if(isStrictAdmin()){
    if(!confirm(`Cancel ${label}?`))return;
    await sfUpdate('orders',id,{status:'Cancelled',cancelledBy:CU.uid,cancelledAt:new Date().toISOString()});
    showToast('Order cancelled','warn');invalidateDashCache();loadOrders();renderDashboard();updateBadges();
    // 🔔 Notify rep
    try{const _cODoc=await window.__SF.getDoc(window.__SF.doc(window.__SF.db,_zonePath('orders'),id));if(_cODoc.exists()){const _cOD=_cODoc.data();notifyRep(_cOD.createdBy,'❌ Order Cancelled',`Order ${_cOD.id||id} was cancelled by admin`,{tag:'order-cancelled'});}}
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
    <!-- Header -->
    <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:22px;padding-bottom:18px;border-bottom:2px solid #f0f0f0">
      <div>
        <div style="font-family:'Syne',sans-serif;font-size:22px;font-weight:800;color:#22c55e;letter-spacing:-.5px">SAIRAH TRADING SDN BHD</div>
        <div style="font-size:11px;color:#666;margin-top:5px">Sales & Distribution Management</div>
      </div>
      <div style="text-align:right">
        <div style="font-family:'Syne',sans-serif;font-size:28px;font-weight:800;color:#1a1a1a;letter-spacing:-1px">INVOICE</div>
        <div style="font-size:14px;font-weight:700;color:#22c55e;margin-top:2px">${o.id||o._docId}</div>
        <div style="margin-top:6px"><span style="display:inline-block;padding:3px 10px;border-radius:20px;font-size:11px;font-weight:700;background:${o.status==='Delivered'?'#dcfce7':o.status==='Cancelled'?'#fee2e2':o.status==='Confirmed'?'#dbeafe':'#fef9c3'};color:${o.status==='Delivered'?'#16a34a':o.status==='Cancelled'?'#dc2626':o.status==='Confirmed'?'#1d4ed8':'#b45309'}">${o.status}</span></div>
      </div>
    </div>
    <!-- Bill To / Info Grid -->
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
          ${o.deliveryManId?`<div style="display:flex;justify-content:space-between;font-size:12px"><span style="color:#666">Delivery Man:</span><span style="font-weight:600;color:#16a34a">🚚 ${o.deliveryManName||userName(o.deliveryManId)}</span></div>`:''}
          <div style="display:flex;justify-content:space-between;font-size:12px"><span style="color:#666">Items:</span><span style="font-weight:600">${(o.items||[]).length}</span></div>
        </div>
      </div>
    </div>
    <!-- Items Table -->
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
          <td style="padding:9px 12px;font-size:13px;font-weight:600;color:#1a1a1a">${it.name}${it.unit&&it.unit!=='pcs'?`<span style="font-size:10px;color:#999;margin-left:4px">(${it.unit})</span>`:''}</td>
          <td style="padding:9px 12px;font-size:13px;text-align:center;color:#444">${it.qtyDisplay||it.qty}</td>
          <td style="padding:9px 12px;font-size:13px;text-align:right;color:#444">${fmt(it.price)}</td>
          <td style="padding:9px 12px;font-size:13px;text-align:right;font-weight:700;color:#22c55e">${fmt(it.price*it.qty)}</td>
        </tr>`).join('')}
      </tbody>
    </table>
    <!-- Totals -->
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
    <!-- Footer -->
    <div style="border-top:1px solid #f0f0f0;padding-top:14px;text-align:center;font-size:11px;color:#999">
      <div>Thank you for your business · Sairah Trading Sdn Bhd</div>
    </div>
  </div>`;
  document.getElementById('mOrdDetTitle').textContent='Invoice — '+(o.id||o._docId);
  document.getElementById('mOrdDetBody').innerHTML=invoiceHtml;
  // Store order for print/PDF
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
  // Build printable HTML blob and open in new tab for user to save as PDF
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
  const text=`*SAIRAH TRADING SDN BHD*\nInvoice: ${o.id||o._docId}\nDate: ${o.date}\nOutlet: ${outletName(o.outletId)}\nItems: ${(o.items||[]).length}\n*Total: ${fmt(o.total)}*\nStatus: ${o.status}`;
  if(navigator.share){
    navigator.share({title:`Invoice ${o.id}`,text}).catch(()=>{});
  } else {
    navigator.clipboard?.writeText(text).then(()=>showToast('Invoice details copied to clipboard','success')).catch(()=>showToast('Could not share','error'));
  }
}

