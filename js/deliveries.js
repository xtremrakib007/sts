// ═══════════════ DELIVERIES (Admin View) ═══════════════
async function loadDeliveries() {
  if(!isAdmin()){showToast('Access denied','error');return;}
  const srch=(document.getElementById('delivAdminSrch')?.value||'').toLowerCase();
  const statusF=document.getElementById('delivAdminStatus')?.value||'';
  // NOTE: Delivery man filter removed — assignment is handled by ERP

  const {where}=window.__SF;
  const ordDocs=await sfGet('orders');
  let orders=ordDocs.map(d=>({_docId:d.id,...d.data()}))
    .filter(o=>['Confirmed','Assigned','In Transit','Delivered','Failed'].includes(o.status));

  if(srch)orders=orders.filter(o=>(o.id||o._docId).toLowerCase().includes(srch)||outletName(o.outletId).toLowerCase().includes(srch));
  if(statusF)orders=orders.filter(o=>o.status===statusF);
  orders.sort((a,b)=>(b.createdAt?.seconds||0)-(a.createdAt?.seconds||0));

  // Stats
  const assigned=orders.filter(o=>o.status==='Assigned').length;
  const inTransit=orders.filter(o=>o.status==='In Transit').length;
  const delivered=orders.filter(o=>o.status==='Delivered').length;
  const failed=orders.filter(o=>o.status==='Failed').length;
  const statsEl=document.getElementById('delivAdminStats');
  if(statsEl)statsEl.innerHTML=
    statC('📋','Assigned',assigned,'Pending pickup','#f59e0b')+
    statC('🚚','In Transit',inTransit,'On the way','#3b82f6')+
    statC('✅','Delivered',delivered,'Completed','#22c55e')+
    statC('❌','Failed',failed,'Issues','#ef4444');

  const sBadge={Confirmed:'bdg-blu',Assigned:'bdg-ylw','In Transit':'bdg-acc',Delivered:'bdg-grn',Failed:'bdg-red'};
  const tbody=document.getElementById('delivAdminTbody');
  if(!tbody)return;
  tbody.innerHTML=orders.map(o=>{
    const outlet=allOutlets.find(x=>x.id===o.outletId)||{};
    // Stock status column
    const stockInfo = o.stockDeducted
      ? `<span class="bdg bdg-grn" style="font-size:10px">✅ Deducted</span>`
      : o.status==='Delivered'
        ? `<span class="bdg bdg-ylw" style="font-size:10px">⏳ Pending</span>`
        : `<span style="font-size:11px;color:var(--tx3)">—</span>`;
    return`<tr>
      <td><span style="font-family:'Syne',sans-serif;font-weight:700;font-size:12px">${o.id||o._docId}</span>
          ${o.erpSynced?'<span class="bdg bdg-grn" style="font-size:9px;margin-left:3px">ERP✓</span>':''}</td>
      <td style="font-size:12px">${outletName(o.outletId)}</td>
      <td style="font-size:11px;color:var(--tx2)">${outlet.route?`<span class="bdg bdg-pur" style="font-size:10px">🗺️ ${outlet.route}</span>`:'—'}</td>
      <td><span style="font-family:'Syne',sans-serif;font-weight:700;color:var(--acc)">${fmt(o.total)}</span></td>
      <td><span class="bdg ${sBadge[o.status]||'bdg-gry'}">${o.status}</span></td>
      <td>${stockInfo}</td>
    </tr>`;
  }).join('')||'<tr><td colspan="6" style="text-align:center;padding:24px;color:var(--tx3)">No deliveries found</td></tr>';

  // Badge: show count of Delivered orders with pending stock deduction
  const pendingStock=orders.filter(o=>o.status==='Delivered'&&!o.stockDeducted).length;
  const badge=document.getElementById('delivAdminBadge');
  if(badge){badge.textContent=pendingStock;badge.style.display=pendingStock?'':'none';}
}

// ── Delivery assignment is handled by ERP — these are stubs ──────────────────
function openAssignDelivery(ordDocId) {
  alert('🚚 Delivery assignment is managed by the ERP system.\n\nPlease log into the ERP portal to assign a delivery man and schedule the delivery for order ' + ordDocId + '.');
}

function saveDeliveryAssignment() {
  // No-op — ERP handles this
  if(typeof closeM === 'function') closeM('mAssignDelivery');
}

async function markDelivered(ordDocId) {
  if(!confirm('Mark this order as delivered? This will permanently deduct stock from ERP inventory.'))return;
  // Stock is deducted server-side (erpBridge) when the status becomes Delivered;
  // the order's stockDeducted flag turns on once that has happened.
  await sfUpdate('orders', ordDocId, {
    status: 'Delivered',
    deliveredAt: new Date().toISOString(),
    deliveredBy: CU.uid,
  });
  showToast('Order marked as Delivered ✅ — stock is being deducted in ERP', 'success');
  invalidateDashCache(); loadDeliveries(); renderDashboard();
}

async function markDeliveryFailed(ordDocId) {
  const reason=prompt('Reason for failed delivery (optional):');
  if(reason===null)return;
  await sfUpdate('orders',ordDocId,{
    status:'Failed',
    failureReason:reason||'',
    failedAt:new Date().toISOString(),
  });
  showToast('Delivery marked as failed','warn');
  loadDeliveries();
}

async function reopenFailedDelivery(ordDocId) {
  if(!isAdmin()){showToast('Admin only','error');return;}
  if(!confirm('Reopen this failed delivery? It will go back to Confirmed status and can be reassigned.'))return;
  await sfUpdate('orders',ordDocId,{
    status:'Confirmed',
    failureReason:'',
    failedAt:'',
    deliveryManId:'',
    deliveryManName:'',
    reopenedAt:new Date().toISOString(),
    reopenedBy:CU.uid,
  });
  showToast('Delivery reopened — ready to reassign 🔄','success');
  loadDeliveries();
  updateBadges();
}

// ═══════════════ DELIVERIES (Delivery Man View) ═══════════════
async function loadMyDeliveries() {
  const srch=(document.getElementById('delivSrch')?.value||'').toLowerCase();
  const statusF=document.getElementById('delivStatusFilter')?.value||'';
  const {where}=window.__SF;
  const ordDocs=await sfGet('orders',[where('deliveryManId','==',CU.uid)]);
  let orders=ordDocs.map(d=>({_docId:d.id,...d.data()}));
  _dmOrders=Object.fromEntries(orders.map(o=>[o._docId,o]));
  if(srch)orders=orders.filter(o=>(o.id||o._docId).toLowerCase().includes(srch)||outletName(o.outletId).toLowerCase().includes(srch));
  if(statusF)orders=orders.filter(o=>o.status===statusF);
  orders.sort((a,b)=>(b.createdAt?.seconds||0)-(a.createdAt?.seconds||0));

  // Summary
  const total=orders.length;
  const pending=orders.filter(o=>o.status==='Assigned').length;
  const done=orders.filter(o=>o.status==='Delivered').length;
  const transit=orders.filter(o=>o.status==='In Transit').length;
  const summEl=document.getElementById('delivSummary');
  if(summEl)summEl.innerHTML=`
    <div class="cs-card"><div class="cs-v" style="color:var(--ylw)">${pending}</div><div class="cs-l">Assigned</div></div>
    <div class="cs-card"><div class="cs-v" style="color:var(--blu)">${transit}</div><div class="cs-l">In Transit</div></div>
    <div class="cs-card"><div class="cs-v" style="color:var(--grn)">${done}</div><div class="cs-l">Delivered</div></div>`;

  const list=document.getElementById('deliveryList');
  if(!list)return;

  // Update sidebar badge
  const badge=document.getElementById('delivBadge');
  if(badge){badge.textContent=pending;badge.style.display=pending?'':'none';}

  if(!orders.length){
    list.innerHTML=`<div style="text-align:center;padding:40px;color:var(--tx3)">
      <div style="font-size:40px;margin-bottom:12px">🚚</div>
      <div style="font-size:14px;font-weight:600">No deliveries assigned</div>
      <div style="font-size:12px;margin-top:6px">Your admin will assign orders to you</div>
    </div>`;
    return;
  }

  const sBadge={Assigned:'bdg-ylw','In Transit':'bdg-acc',Delivered:'bdg-grn',Failed:'bdg-red'};
  list.innerHTML=orders.map(o=>{
    const outlet=allOutlets.find(x=>x.id===o.outletId)||{name:'Unknown',address:'',phone:'',lat:null,lng:null};
    const hasPinned=!!(outlet.lat&&outlet.lng);
    return`<div style="background:var(--s1);border:1px solid var(--bdr);border-radius:var(--r);padding:16px;margin-bottom:12px">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:10px">
        <div>
          <div style="font-family:'Syne',sans-serif;font-size:14px;font-weight:700">${o.id||o._docId}</div>
          <div style="font-size:12px;color:var(--tx2);margin-top:2px">📅 ${o.deliveryDate||o.date||'—'}</div>
        </div>
        <div style="display:flex;flex-direction:column;gap:4px;align-items:flex-end">
          <span class="bdg ${sBadge[o.status]||'bdg-gry'}">${o.status}</span>
          ${o.pickStatus==='packed'?'<span class="bdg bdg-grn" style="font-size:10px">📦 Packed</span>':o.pickStatus==='picking'?'<span class="bdg bdg-ylw" style="font-size:10px">🧺 Picking</span>':''}
        </div>
      </div>
      <div style="background:var(--s2);border-radius:var(--r2);padding:11px;margin-bottom:10px">
        <div style="font-weight:700;font-size:13px;margin-bottom:2px">🏪 ${outlet.name}</div>
        ${outlet.route?`<div style="font-size:11px;color:var(--pur)">🗺️ ${outlet.route}</div>`:''}
        ${outlet.phone?`<div style="font-size:11px;color:var(--tx2)">📞 ${outlet.phone}</div>`:''}
        ${outlet.address?`<div style="font-size:11px;color:var(--tx3)">📍 ${outlet.address}</div>`:''}
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
        <span style="font-size:12px;color:var(--tx2)">${(o.items||[]).length} item(s)</span>
        <span style="font-family:'Syne',sans-serif;font-size:18px;font-weight:800;color:var(--acc)">${fmt(o.total)}</span>
      </div>
      ${o.status==='Delivered'?`<div style="font-size:12px;margin-bottom:10px;color:var(--tx2)">${o.partial?'🟡 Partly delivered · '+fmt(o.deliveredTotal):'✅ Delivered in full'}${o.paymentMethod?` · ${PAY_METHODS[o.paymentMethod]||o.paymentMethod}${Number(o.paymentAmount)?' '+fmt(o.paymentAmount):''}`:''}</div>`:''}
      ${o.status==='Failed'?`<div style="font-size:12px;margin-bottom:10px;color:var(--red)">❌ Not delivered${o.failureReason?' · '+escH(o.failureReason):''}</div>`:''}
      ${o.deliveryNotes?`<div style="background:rgba(245,158,11,.07);border:1px solid rgba(245,158,11,.2);border-radius:var(--r2);padding:8px 10px;font-size:11px;color:var(--ylw);margin-bottom:10px">📝 ${o.deliveryNotes}</div>`:''}
      <div style="display:flex;gap:7px;flex-wrap:wrap">
        ${o.status==='Assigned'?`<button class="btn btn-blu btn-sm" style="flex:1" onclick="startDelivery('${o._docId}')">🚚 Start Delivery</button>`:''}
        ${o.status==='In Transit'?`<button class="btn btn-grn btn-sm" style="flex:1" onclick="openCompleteDelivery('${o._docId}')">✅ Complete Delivery</button>`:''}
        <button class="btn btn-ghost btn-sm" style="flex:1" onclick="_dmDirections('${o._docId}')" ${hasPinned||outlet.address?'':'disabled title="No location or address saved"'}>🗺️ Direction</button>
        <button class="btn btn-ghost btn-sm" style="flex:1" onclick="_dmWhatsApp('${o._docId}')" ${outlet.phone?'':'disabled title="No phone number saved"'}>💬 WhatsApp</button>
        ${outlet.phone?`<a class="btn btn-ghost btn-sm" href="tel:${escH(String(outlet.phone).replace(/[^\d+]/g,''))}">📞 Call</a>`:''}
        <button class="btn btn-ghost btn-sm" onclick="viewOrder('${o._docId}')">👁 Details</button>
      </div>
    </div>`;
  }).join('');
}

// Direction: the pinned spot, or the address when no pin was saved.
// WhatsApp: tells the shop which order is on the way.
let _dmOrders={};
function _dmOutlet(ordDocId){const o=_dmOrders[ordDocId]||{};return [o,allOutlets.find(x=>x.id===o.outletId)||{}];}
function _dmDirections(ordDocId){
  const [,out]=_dmOutlet(ordDocId);
  const dest=out.lat&&out.lng?`${out.lat},${out.lng}`:out.address?encodeURIComponent(out.address):'';
  if(!dest){showToast('No location or address saved for this outlet','warn');return;}
  window.open(`https://www.google.com/maps/dir/?api=1&destination=${dest}&travelmode=driving`,'_blank');
}
function _dmWhatsApp(ordDocId){
  const [o,out]=_dmOutlet(ordDocId);
  const raw=String(out.phone||'').replace(/\D/g,'');
  if(!raw){showToast('No phone number saved for this outlet','warn');return;}
  const intl=raw.startsWith('60')?raw:raw.startsWith('0')?'6'+raw:'60'+raw;
  const msg=`Hello ${out.name||''}, this is ${CU.name} from Sairah Trading. I am on the way with your order ${o.id||ordDocId} (${fmt(o.deliveredTotal??o.total)}).`;
  window.open(`https://wa.me/${intl}?text=${encodeURIComponent(msg)}`,'_blank');
}

async function startDelivery(ordDocId) {
  await sfUpdate('orders',ordDocId,{
    status:'In Transit',
    inTransitAt:new Date().toISOString(),
    inTransitBy:CU.uid,
  });
  showToast('Delivery started 🚚 — drive safe!','success');
  loadMyDeliveries();
}

// ── Complete a delivery: full, partial or failed, with proof ───────────────
// Partial deliveries record the quantity handed over per line; the server
// deducts only that from stock and releases the rest of the reservation.
// The proof (photo, receiver, GPS) is stored once in deliveryProofs/{order}.
const FAIL_REASONS=['Customer not available','Shop closed','Customer refused','Wrong address','Payment not ready','Other'];
const PAY_METHODS={cash:'💵 Cash',cheque:'🧾 Cheque',online:'🏦 Online',pending:'⏳ Not paid'};
const PAY_MODE={cash:'Cash',cheque:'Cheque',online:'Online Transfer'}; // collection "mode", as in the Collection page
let _podPhoto='', _cdOrder=null;

async function openCompleteDelivery(ordDocId) {
  const snap=await window.__SF.getDoc(docRef('orders',ordDocId));
  if(!snap.exists()){showToast('Order not found','error');return;}
  const o=snap.data();
  _podPhoto=''; _cdOrder=o;
  const credit=o.payTerms&&!/^(cod|cash)$/i.test(String(o.payTerms));
  document.getElementById('mCompleteDelivery')?.remove();
  const el=document.createElement('div');
  el.className='moverlay'; el.id='mCompleteDelivery';
  el.innerHTML=`<div class="modal"><div class="mhdr"><div class="mttl">🚚 Complete ${o.id||ordDocId}</div><button class="mcls" onclick="closeM('mCompleteDelivery')">✕</button></div>
    <div class="mbody">
      <div class="fgrp"><label class="flbl">Outcome</label>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          <label class="bdg bdg-grn" style="cursor:pointer;padding:8px 10px"><input type="radio" name="cdOutcome" value="full" checked onchange="_cdOutcome()"> Delivered in full</label>
          <label class="bdg bdg-ylw" style="cursor:pointer;padding:8px 10px"><input type="radio" name="cdOutcome" value="partial" onchange="_cdOutcome()"> Partly delivered</label>
          <label class="bdg bdg-red" style="cursor:pointer;padding:8px 10px"><input type="radio" name="cdOutcome" value="failed" onchange="_cdOutcome()"> Not delivered</label>
        </div></div>
      <div id="cdPartial" style="display:none">
        <div class="flbl" style="margin-bottom:6px">Quantity handed over</div>
        ${(o.items||[]).map((it,i)=>`<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
          <div style="flex:1;font-size:12px">${it.name||'Item'} <span style="color:var(--tx3)">(ordered ${it.qty})</span></div>
          <input class="finp cd-qty" data-i="${i}" data-max="${Number(it.qty)||0}" type="number" min="0" max="${Number(it.qty)||0}" step="any" value="${Number(it.qty)||0}" style="width:90px" oninput="_cdDue()">
        </div>`).join('')}
      </div>
      <div id="cdFailed" style="display:none" class="fgrp"><label class="flbl">Reason *</label>
        <select class="finp" id="cdReason">${FAIL_REASONS.map(r=>`<option>${r}</option>`).join('')}</select></div>
      <div id="cdPay" class="cd-pay">
        <div class="flbl" style="margin-bottom:6px">💰 Payment <span id="cdDue" style="float:right;color:var(--acc)"></span></div>
        <div class="cd-pay-opts">${Object.entries(PAY_METHODS).map(([k,l])=>`<label><input type="radio" name="cdPayM" value="${k}" ${k===(credit?'pending':'cash')?'checked':''} onchange="_cdPayM()"><span>${l}</span></label>`).join('')}</div>
        <div id="cdAmtRow" class="fgrp" style="margin:10px 0 0"><label class="flbl">Amount received (RM)</label><input class="finp" id="cdAmt" type="number" min="0" step="0.01" inputmode="decimal"></div>
        <div id="cdChq" style="display:none;margin-top:8px"><div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
          <input class="finp" id="cdChqNo" placeholder="Cheque no. *"><input class="finp" id="cdChqBank" placeholder="Bank"></div>
          <label class="flbl" style="margin-top:6px">Cheque date</label><input class="finp" id="cdChqDate" type="date"></div>
        <div id="cdOnl" style="display:none;margin-top:8px"><input class="finp" id="cdRef" placeholder="Transfer reference / TNG / DuitNow ID *"></div>
        <div id="cdPayHint" style="font-size:11px;color:var(--tx3);margin-top:6px"></div>
      </div>
      <div class="fgrp"><label class="flbl" id="cdReceiverLbl">Received by *</label><input class="finp" id="cdReceiver" placeholder="Name of person who received the goods"></div>
      <div class="fgrp"><label class="flbl">Note</label><input class="finp" id="cdNote" placeholder="Optional"></div>
      <div class="fgrp"><label class="flbl">Photo proof</label>
        <input type="file" accept="image/*" capture="environment" id="cdPhotoInp" onchange="_cdPhoto(this)" style="font-size:12px">
        <img id="cdPhotoPrev" style="display:none;margin-top:8px;max-width:100%;max-height:160px;border-radius:8px">
      </div>
      <div style="font-size:11px;color:var(--tx3)">${typeof _userLat==='number'&&_userLat?'📍 Your location will be attached':'📍 Location unavailable — turn on GPS for proof of location'}</div>
    </div>
    <div class="mfoot"><button class="btn btn-ghost" onclick="closeM('mCompleteDelivery')">Cancel</button><button class="btn btn-primary" id="cdSave" onclick="saveCompleteDelivery('${ordDocId}')">Save</button></div></div>`;
  document.body.appendChild(el);
  _cdDue(true);
  _cdPayM();
  openM('mCompleteDelivery');
}

// Value of what is being handed over: the order total, or for a partial
// delivery the share delivered. Sets the amount box to it unless edited.
function _cdDeliveredValue() {
  const o=_cdOrder||{}, items=o.items||[];
  const v=document.querySelector('input[name="cdOutcome"]:checked')?.value;
  if(v!=='partial') return Number(o.total)||0;
  const qtys=[...document.querySelectorAll('.cd-qty')].map(i=>({qty:Math.max(0,Math.min(Number(i.value)||0,Number(i.dataset.max)||0))}));
  return _deliveredTotal(items,qtys,o.total);
}
function _cdDue(init) {
  const due=_cdDeliveredValue(), amt=document.getElementById('cdAmt');
  const d=document.getElementById('cdDue'); if(d) d.textContent='Due '+fmt(due);
  if(amt&&(init||!amt.dataset.edited)) amt.value=due.toFixed(2);
  if(amt&&!amt.__wired){ amt.__wired=true; amt.addEventListener('input',()=>{amt.dataset.edited='1';_cdPayHint();}); }
  _cdPayHint();
}
function _cdPayM() {
  const m=document.querySelector('input[name="cdPayM"]:checked')?.value||'cash';
  document.getElementById('cdAmtRow').style.display=m==='pending'?'none':'';
  document.getElementById('cdChq').style.display=m==='cheque'?'':'none';
  document.getElementById('cdOnl').style.display=m==='online'?'':'none';
  _cdPayHint();
}
function _cdPayHint() {
  const h=document.getElementById('cdPayHint'); if(!h) return;
  const m=document.querySelector('input[name="cdPayM"]:checked')?.value||'cash';
  const due=_cdDeliveredValue(), amt=Number(document.getElementById('cdAmt')?.value)||0;
  h.textContent=m==='pending'?`Nothing collected — ${fmt(due)} stays on the outlet's dues.`
    :amt<due?`Part payment — ${fmt(due-amt)} stays on the outlet's dues.`
    :amt>due?'⚠️ More than the delivered value — check the amount.':'Paid in full ✅';
}

function _cdOutcome() {
  const v=document.querySelector('input[name="cdOutcome"]:checked').value;
  document.getElementById('cdPartial').style.display=v==='partial'?'':'none';
  document.getElementById('cdFailed').style.display=v==='failed'?'':'none';
  document.getElementById('cdReceiverLbl').textContent=v==='failed'?'Spoke to':'Received by *';
  document.getElementById('cdPay').style.display=v==='failed'?'none':'';
  _cdDue();
}

// Shrink the photo to ~1024px JPEG so the proof stays small.
function _cdPhoto(input) {
  const f=input.files&&input.files[0]; if(!f)return;
  const img=new Image();
  img.onload=()=>{
    const scale=Math.min(1,1024/Math.max(img.width,img.height));
    const c=document.createElement('canvas');
    c.width=Math.round(img.width*scale); c.height=Math.round(img.height*scale);
    c.getContext('2d').drawImage(img,0,0,c.width,c.height);
    _podPhoto=c.toDataURL('image/jpeg',0.6);
    if(_podPhoto.length>380000)_podPhoto=c.toDataURL('image/jpeg',0.4);
    const prev=document.getElementById('cdPhotoPrev'); prev.src=_podPhoto; prev.style.display='';
    URL.revokeObjectURL(img.src);
  };
  img.src=URL.createObjectURL(f);
}

async function saveCompleteDelivery(ordDocId) {
  const outcome=document.querySelector('input[name="cdOutcome"]:checked').value;
  const receiver=document.getElementById('cdReceiver').value.trim();
  const note=document.getElementById('cdNote').value.trim();
  if(outcome!=='failed'&&!receiver){showToast('Enter who received the goods','error');return;}
  const snap=await window.__SF.getDoc(docRef('orders',ordDocId));
  const o=snap.data()||{};
  const now=new Date().toISOString();
  let patch;
  if(outcome==='failed'){
    const reason=document.getElementById('cdReason').value;
    patch={status:'Failed',failureReason:note?`${reason} — ${note}`:reason,failedAt:now,failedBy:CU.uid,deliveryOutcome:'failed'};
  } else {
    patch={status:'Delivered',deliveredAt:now,deliveredBy:CU.uid,receiverName:receiver,deliveryOutcome:outcome,partial:false};
    if(outcome==='partial'){
      const qtys=[...document.querySelectorAll('.cd-qty')].map(i=>Math.max(0,Math.min(Number(i.value)||0,Number(i.dataset.max)||0)));
      const items=o.items||[];
      if(qtys.every((q,i)=>q>=(Number(items[i]?.qty)||0))){showToast('All items delivered — choose "Delivered in full"','warn');return;}
      if(qtys.every(q=>q<=0)){showToast('Nothing handed over — choose "Not delivered"','warn');return;}
      patch.partial=true;
      patch.deliveredItems=items.map((it,i)=>({...it,qty:qtys[i]}));
      patch.deliveredTotal=_deliveredTotal(items,patch.deliveredItems,o.total);
    }
    if(note)patch.deliveryNote=note;
    const due=patch.deliveredTotal??(Number(o.total)||0);
    const m=document.querySelector('input[name="cdPayM"]:checked')?.value||'pending';
    const amt=m==='pending'?0:Math.round((Number(document.getElementById('cdAmt').value)||0)*100)/100;
    if(m!=='pending'&&!(amt>0)){showToast('Enter the amount received, or choose "Not paid"','error');return;}
    if(amt>due+0.009){showToast(`Amount is more than the delivered value (${fmt(due)})`,'error');return;}
    const ref=m==='cheque'?document.getElementById('cdChqNo').value.trim():m==='online'?document.getElementById('cdRef').value.trim():'';
    if(m==='cheque'&&!ref){showToast('Enter the cheque number','error');return;}
    if(m==='online'&&!ref){showToast('Enter the transfer reference','error');return;}
    Object.assign(patch,{paymentMethod:m,paymentAmount:amt,paymentAt:now,
      paymentStatus:amt<=0?'pending':amt+0.009<due?'part_paid':'paid'});
    if(ref)patch.paymentRef=ref;
    if(m==='cheque'){patch.chequeBank=document.getElementById('cdChqBank').value.trim();patch.chequeDate=document.getElementById('cdChqDate').value||'';}
  }
  const btn=document.getElementById('cdSave'); if(btn){btn.disabled=true;btn.textContent='Saving…';}
  try {
    const hasGps=typeof _userLat==='number'&&_userLat&&typeof _userLng==='number';
    if(_podPhoto||receiver||hasGps){
      await window.__SF.setDoc(window.__SF.doc(window.__SF.db,'deliveryProofs',ordDocId),{
        orderId:o.id||ordDocId, outcome, receiverName:receiver, note,
        photo:_podPhoto||'', lat:hasGps?_userLat:null, lng:hasGps?_userLng:null,
        deliveredBy:CU.uid, deliveredByName:CU.name, at:now,
      });
      patch.hasProof=true;
    }
    await sfUpdate('orders',ordDocId,patch);
    // Money taken at the door is a collection like any other: it reduces
    // the outlet's dues and reaches the ERP for acceptance.
    if(patch.paymentAmount>0){
      try {
        await sfAdd('collections',{
          id:'COL-'+uid6(), outletId:o.outletId, amount:patch.paymentAmount, mode:PAY_MODE[patch.paymentMethod],
          date:_localDay(now), notes:`Delivery ${o.id||ordDocId}${patch.paymentRef?' · ref '+patch.paymentRef:''}`,
          orderId:o.id||ordDocId, orderDocId:ordDocId, source:'delivery',
          paymentRef:patch.paymentRef||'', chequeBank:patch.chequeBank||'', chequeDate:patch.chequeDate||'',
          createdBy:CU.uid, createdByName:CU.name, zoneId:CU.zoneId||null, createdAt:window.__SF.serverTimestamp(),
        });
      } catch(e){ showToast('Delivery saved, but the payment could not be recorded: '+e.message+' — tell your admin','warn'); }
    }
    invalidateDashCache();
    closeM('mCompleteDelivery');
    showToast(outcome==='failed'?'Issue reported. Admin has been notified.':(outcome==='partial'?`Partial delivery saved — ${fmt(patch.deliveredTotal)} delivered`:'Delivery confirmed ✅')+(patch.paymentAmount>0?` · ${fmt(patch.paymentAmount)} ${PAY_MODE[patch.paymentMethod].toLowerCase()} received`:' · payment pending'),outcome==='failed'?'warn':'success');
    loadMyDeliveries();
  } catch(e) {
    showToast('Could not save: '+e.message,'error');
    if(btn){btn.disabled=false;btn.textContent='Save';}
  }
}

// Same rule as functions/returns.js deliveredTotal: the order total scaled by
// the share of line value delivered, so any order discount is kept.
function _deliveredTotal(items, delivered, orderTotal) {
  let full=0, got=0;
  items.forEach((it,i)=>{
    const q=Number(it.qty)||0; if(q<=0)return;
    const line=(it._lineTotal!=null?Number(it._lineTotal):(Number(it.price)||0)*q)-(Number(it.discount?.amount)||0);
    full+=line; got+=(line/q)*Math.min(Number(delivered[i]?.qty)||0,q);
  });
  return full>0?Math.round((Number(orderTotal)||0)*got/full*100)/100:0;
}
