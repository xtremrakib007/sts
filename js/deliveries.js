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

  // Fetch order to get items for stock deduction
  const ordSnap = await window.__SF.getDoc(docRef('orders', ordDocId));
  const o = ordSnap.exists() ? {_docId: ordSnap.id, ...ordSnap.data()} : null;
  if(!o){ showToast('Order not found','error'); return; }

  await sfUpdate('orders', ordDocId, {
    status: 'Delivered',
    deliveredAt: new Date().toISOString(),
    deliveredBy: CU.uid,
    stockDeducted: false, // will be set true after deduction
  });

  // ★ Actual stock deduction on delivery — deducts from stsb_inventory
  if (o.items && o.items.length) {
    try {
      await _reserveStock(o.items, o.id || ordDocId, 'deduct');
      // Mark stock as deducted
      await sfUpdate('orders', ordDocId, { stockDeducted: true, stockDeductedAt: new Date().toISOString() });
      // Sync status to ERP
      if (typeof _updateERPOrderStatus === 'function') {
        _updateERPOrderStatus(o.id || ordDocId, 'delivered', { deliveryStatus: 'delivered', stockDeducted: true });
      }
      showToast('Order marked as Delivered ✅ — stock deducted from ERP', 'success');
    } catch(e) {
      showToast('Delivered but stock deduction failed — check ERP manually', 'warn');
      console.error('[markDelivered stock]', e);
    }
  } else {
    showToast('Order marked as Delivered ✅', 'success');
  }

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
        <span class="bdg ${sBadge[o.status]||'bdg-gry'}">${o.status}</span>
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
      ${o.deliveryNotes?`<div style="background:rgba(245,158,11,.07);border:1px solid rgba(245,158,11,.2);border-radius:var(--r2);padding:8px 10px;font-size:11px;color:var(--ylw);margin-bottom:10px">📝 ${o.deliveryNotes}</div>`:''}
      <div style="display:flex;gap:7px;flex-wrap:wrap">
        ${o.status==='Assigned'?`<button class="btn btn-blu btn-sm" style="flex:1" onclick="startDelivery('${o._docId}')">🚚 Start Delivery</button>`:''}
        ${o.status==='In Transit'?`<button class="btn btn-grn btn-sm" style="flex:1" onclick="confirmDelivered('${o._docId}')">✅ Mark Delivered</button>`:''}
        ${o.status==='In Transit'?`<button class="btn btn-red btn-sm" style="flex:1" onclick="reportFailed('${o._docId}')">❌ Report Issue</button>`:''}
        ${hasPinned?`<button class="btn btn-ghost btn-sm" style="flex:1" onclick="window.open('https://www.google.com/maps/dir/?api=1&destination=${outlet.lat},${outlet.lng}&travelmode=driving','_blank')">🗺️ Navigate</button>`:''}
        <button class="btn btn-ghost btn-sm" onclick="viewOrder('${o._docId}')">👁 Details</button>
      </div>
    </div>`;
  }).join('');
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

async function confirmDelivered(ordDocId) {
  if(!confirm('Confirm this order was successfully delivered?'))return;
  await sfUpdate('orders',ordDocId,{status:'Delivered',deliveredAt:new Date().toISOString(),deliveredBy:CU.uid});
  showToast('Delivery confirmed ✅ — great work!','success');
  loadMyDeliveries();
}

async function reportFailed(ordDocId) {
  const reason=prompt('Describe the issue (e.g. outlet closed, wrong address):');
  if(reason===null)return;
  await sfUpdate('orders',ordDocId,{status:'Failed',failureReason:reason||'',failedAt:new Date().toISOString(),failedBy:CU.uid});
  showToast('Issue reported. Admin has been notified.','warn');
  loadMyDeliveries();
}

