// ═══════════════ DELETE APPROVAL SYSTEM ═══════════════
// Non-strict-admins cannot delete anything directly.
// They submit a delete request which strict admin approves/rejects.

async function requestDeleteApproval(itemType, itemId, itemLabel) {
  if(!CU)return;
  if(isStrictAdmin())return true; // strict admin: direct delete allowed
  // Submit approval request
  const reason=prompt(`Reason for deleting "${itemLabel}" (required):`);
  if(reason===null||reason.trim()===''){showToast('Delete request cancelled — reason is required','warn');return false;}
  try {
    await sfAdd('deleteRequests',{
      itemType,   // 'outlet','order','collection','product','route','broadcast'
      itemId,
      itemLabel,
      reason:reason.trim(),
      requestedBy:CU.uid,
      requestedByName:CU.name,
      requestedByRole:CU.role,
      status:'pending',
      createdAt:window.__SF.serverTimestamp(),
    });
    showToast(`Delete request sent for "${itemLabel}" — awaiting Admin approval 📋`,'info');
    // Refresh admin badge
    updateDeleteRequestBadge();
    return false; // caller should NOT proceed with delete
  } catch(e) {
    showToast('Failed to send request: '+e.message,'error');
    return false;
  }
}

async function updateDeleteRequestBadge() {
  if(!isStrictAdmin())return;
  try {
    const {where}=window.__SF;
    const docs=await sfGet('deleteRequests',[where('status','==','pending')]);
    const badge=document.getElementById('deleteReqBadge');
    if(badge){badge.textContent=docs.length;badge.style.display=docs.length?'':'none';}
  } catch(e){}
}

async function loadDeleteRequests() {
  if(!isStrictAdmin()){showToast('Admin only','error');return;}
  await updateDeleteRequestBadge();
  const {where,orderBy}=window.__SF;
  const docs=await sfGet('deleteRequests',[where('status','==','pending')]);
  const requests=docs.map(d=>({_docId:d.id,...d.data()}));
  const typeIcon={outlet:'🏪',order:'📦',collection:'💰',product:'🛒',route:'🗺️',broadcast:'📢'};

  const body=document.getElementById('mDeleteReqBody');
  if(!body)return;
  if(!requests.length){
    body.innerHTML='<div style="text-align:center;padding:30px;color:var(--tx3)">✅ No pending delete requests</div>';
    openM('mDeleteRequests');return;
  }
  body.innerHTML=requests.map(r=>`
    <div style="background:var(--s2);border:1px solid var(--bdr);border-radius:var(--r2);padding:13px;margin-bottom:10px">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px">
        <div style="flex:1;min-width:0">
          <div style="font-size:13px;font-weight:700;margin-bottom:3px">${typeIcon[r.itemType]||'🗑'} Delete ${r.itemType}: <span style="color:var(--acc)">${r.itemLabel}</span></div>
          <div style="font-size:11px;color:var(--tx2)">By <strong>${r.requestedByName}</strong> (${r.requestedByRole?.replace('_',' ')||'—'})</div>
          <div style="font-size:11px;color:var(--tx3);margin-top:4px">Reason: ${r.reason}</div>
        </div>
        <div style="display:flex;flex-direction:column;gap:6px;flex-shrink:0">
          <button class="btn btn-grn btn-xs" onclick="approveDeleteRequest('${r._docId}','${r.itemType}','${r.itemId}','${r.itemLabel}')">✓ Approve</button>
          <button class="btn btn-ghost btn-xs" onclick="rejectDeleteRequest('${r._docId}','${r.itemLabel}')">✕ Reject</button>
        </div>
      </div>
    </div>`).join('');
  openM('mDeleteRequests');
}

async function approveDeleteRequest(reqDocId, itemType, itemId, itemLabel) {
  if(!isStrictAdmin())return;
  if(!confirm(`Confirm DELETE "${itemLabel}"? This cannot be undone.`))return;
  try {
    // Execute the actual delete
    await _executeDelete(itemType, itemId);
    // Mark request as approved
    await sfUpdate('deleteRequests',reqDocId,{
      status:'approved', decidedBy:CU.uid, decidedByName:CU.name, decidedAt:new Date().toISOString()
    });
    showToast(`"${itemLabel}" deleted ✅`,'success');
    invalidateCache();invalidateDashCache();
    loadDeleteRequests();
    updateDeleteRequestBadge();
  } catch(e){showToast('Delete failed: '+e.message,'error');}
}

async function rejectDeleteRequest(reqDocId, itemLabel) {
  if(!isStrictAdmin())return;
  const reason=prompt(`Reason for rejecting delete of "${itemLabel}" (optional):`)||'';
  await sfUpdate('deleteRequests',reqDocId,{
    status:'rejected', decidedBy:CU.uid, decidedByName:CU.name, decidedAt:new Date().toISOString(), rejectReason:reason
  });
  showToast(`Delete request rejected`,'info');
  loadDeleteRequests();
  updateDeleteRequestBadge();
}

// ═══════════════ DEVICE APPROVAL MANAGEMENT (Admin) ═══════════════

async function updateDeviceRequestBadge() {
  if (!isAdmin()) return;
  try {
    const { where, query, getDocs } = window.__SF;
    const q = query(rootCol('deviceApprovalRequests'), where('status', '==', 'pending'));
    const snap = await getDocs(q);
    const badge = document.getElementById('deviceReqBadge');
    const count = snap.docs.length;
    if (badge) { badge.textContent = count; badge.style.display = count ? '' : 'none'; }
  } catch(e) { console.warn('[deviceBadge]', e.message); }
}

async function loadDeviceRequests() {
  if (!isAdmin()) { showToast('Admin only', 'error'); return; }
  await updateDeviceRequestBadge();
  const { where, query, getDocs } = window.__SF;
  const q = query(rootCol('deviceApprovalRequests'), where('status', '==', 'pending'));
  const snap = await getDocs(q);
  const requests = snap.docs.map(d => ({ _docId: d.id, ...d.data() }));
  const body = document.getElementById('mDeviceReqBody');
  if (!body) return;
  if (!requests.length) {
    body.innerHTML = '<div style="text-align:center;padding:30px;color:var(--tx3)">✅ No pending device requests</div>';
    openM('mDeviceRequests'); return;
  }
  body.innerHTML = requests.map(r => `
    <div class="device-list-item">
      <div class="device-list-meta">
        <div class="device-list-name">📱 ${r.label||'Unknown Device'}</div>
        <div style="font-size:11px;color:var(--tx2);margin-top:2px">👤 <strong>${r.userName}</strong> · ${r.userEmail}</div>
        <div class="device-list-id">${r.deviceId}</div>
        <div class="device-list-time">Requested: ${r.requestedAt ? new Date(r.requestedAt).toLocaleString('en-MY') : '—'}</div>
        ${r.zoneId ? `<div style="font-size:10px;color:var(--ylw);margin-top:2px">🗂️ Zone: ${zoneName(r.zoneId)||r.zoneId}</div>` : ''}
      </div>
      <div class="device-list-actions">
        <button class="btn btn-grn btn-xs" onclick="approveDeviceRequest('${r._docId}','${r.uid}','${r.deviceId}','${(r.userName||'').replace(/'/g,'')}')">✓ Approve</button>
        <button class="btn btn-red btn-xs" onclick="rejectDeviceRequest('${r._docId}','${r.uid}','${r.deviceId}','${(r.userName||'').replace(/'/g,'')}')">✕ Reject</button>
      </div>
    </div>`).join('');
  openM('mDeviceRequests');
}

async function approveDeviceRequest(reqDocId, uid, deviceId, userName) {
  if (!isAdmin()) return;
  try {
    const now = new Date().toISOString();
    await window.__SF.updateDoc(
      window.__SF.doc(db(), `deviceApprovals/${uid}/devices/${deviceId}`),
      { status: 'approved', approvedBy: CU.uid, approvedByName: CU.name, approvedAt: now }
    );
    await window.__SF.updateDoc(
      rootDocRef('deviceApprovalRequests', reqDocId),
      { status: 'approved', approvedBy: CU.uid, approvedByName: CU.name, approvedAt: now }
    );
    showToast(`✅ Device approved for ${userName}`, 'success');
    loadDeviceRequests();
    updateDeviceRequestBadge();
  } catch(e) { showToast('Failed: ' + e.message, 'error'); }
}

async function rejectDeviceRequest(reqDocId, uid, deviceId, userName) {
  if (!isAdmin()) return;
  try {
    const now = new Date().toISOString();
    await window.__SF.updateDoc(
      window.__SF.doc(db(), `deviceApprovals/${uid}/devices/${deviceId}`),
      { status: 'rejected', rejectedBy: CU.uid, rejectedByName: CU.name, rejectedAt: now }
    );
    await window.__SF.updateDoc(
      rootDocRef('deviceApprovalRequests', reqDocId),
      { status: 'rejected', rejectedBy: CU.uid, rejectedByName: CU.name, rejectedAt: now }
    );
    showToast(`Device rejected for ${userName}`, 'info');
    loadDeviceRequests();
    updateDeviceRequestBadge();
  } catch(e) { showToast('Failed: ' + e.message, 'error'); }
}

/** View all approved/rejected devices for a specific sales rep (from Users page) */
async function viewRepDevices(uid, name) {
  if (!isAdmin()) return;
  const snaps = await window.__SF.getDocs(
    window.__SF.collection(db(), `deviceApprovals/${uid}/devices`)
  );
  const devices = snaps.docs.map(d => ({ id: d.id, ...d.data() }));
  const statusIcon = { approved: '✅', rejected: '🚫', pending: '⏳' };
  const statusColor = { approved: 'var(--grn)', rejected: 'var(--red)', pending: 'var(--ylw)' };
  const body = document.getElementById('mRepDevicesBody');
  const title = document.getElementById('mRepDevicesTitle');
  if (title) title.textContent = `Devices — ${name}`;
  if (!body) return;
  if (!devices.length) {
    body.innerHTML = '<div style="text-align:center;padding:24px;color:var(--tx3)">No registered devices yet</div>';
  } else {
    body.innerHTML = devices.map(d => `
      <div class="device-list-item">
        <div class="device-list-meta">
          <div class="device-list-name">📱 ${d.label||'Unknown Device'}</div>
          <div class="device-list-id">${d.deviceId}</div>
          <div class="device-list-time">Last seen: ${d.lastSeen ? new Date(d.lastSeen).toLocaleString('en-MY') : '—'}</div>
        </div>
        <div class="device-list-actions" style="align-items:flex-end">
          <span style="font-size:11px;font-weight:700;color:${statusColor[d.status]||'var(--tx3)'}">${statusIcon[d.status]||'❓'} ${d.status||'unknown'}</span>
          ${d.status !== 'approved' ? `<button class="btn btn-grn btn-xs" onclick="approveDeviceById('${uid}','${d.deviceId}','${name}')">✓ Approve</button>` : ''}
          ${d.status === 'approved' ? `<button class="btn btn-red btn-xs" onclick="revokeDevice('${uid}','${d.deviceId}','${name}')">✕ Revoke</button>` : ''}
        </div>
      </div>`).join('');
  }
  openM('mRepDevices');
}

async function approveDeviceById(uid, deviceId, name) {
  try {
    const now = new Date().toISOString();
    await window.__SF.updateDoc(
      window.__SF.doc(db(), `deviceApprovals/${uid}/devices/${deviceId}`),
      { status: 'approved', approvedBy: CU.uid, approvedByName: CU.name, approvedAt: now }
    );
    // Also update top-level request if exists
    try {
      await window.__SF.updateDoc(
        window.__SF.doc(db(), `deviceApprovalRequests/${uid}_${deviceId}`),
        { status: 'approved', approvedBy: CU.uid, approvedByName: CU.name, approvedAt: now }
      );
    } catch(e2) {}
    showToast(`✅ Device approved for ${name}`, 'success');
    viewRepDevices(uid, name);
    updateDeviceRequestBadge();
  } catch(e) { showToast('Failed: ' + e.message, 'error'); }
}

async function revokeDevice(uid, deviceId, name) {
  if (!confirm(`Revoke this device for ${name}? They will need re-approval to log in from it.`)) return;
  try {
    await window.__SF.updateDoc(
      window.__SF.doc(db(), `deviceApprovals/${uid}/devices/${deviceId}`),
      { status: 'rejected', revokedBy: CU.uid, revokedByName: CU.name, revokedAt: new Date().toISOString() }
    );
    showToast(`Device revoked for ${name}`, 'info');
    viewRepDevices(uid, name);
  } catch(e) { showToast('Failed: ' + e.message, 'error'); }
}

async function _executeDelete(itemType, itemId) {
  switch(itemType){
    case 'outlet':{
      const _dOu=allOutlets.find(x=>x.id===itemId);
      const _dOZ=(_dOu&&_dOu._zoneId)||_ownerZoneFilter||((!isOwner()&&CU.zoneId)?CU.zoneId:null);
      await Promise.all([
        window.__SF.deleteDoc(window.__SF.doc(window.__SF.db,'outlets',itemId)).catch(()=>{}),
        _dOZ?window.__SF.deleteDoc(window.__SF.doc(window.__SF.db,'zones',_dOZ,'outlets',itemId)).catch(()=>{}):Promise.resolve()
      ]);
      invalidateCache();
      loadOutlets();break;}
    case 'order':
      await sfUpdate('orders',itemId,{status:'Cancelled',cancelledBy:CU.uid,cancelledAt:new Date().toISOString()});
      loadOrders();renderDashboard();updateBadges();break;
    case 'collection':{
      const _xDocs=await sfGet('collections');
      const _xT=_xDocs.find(d=>d.data().id===itemId);
      if(_xT){
        const _xZ=_xT.data().zoneId||_ownerZoneFilter||((!isOwner()&&CU.zoneId)?CU.zoneId:null);
        await Promise.all([
          window.__SF.deleteDoc(window.__SF.doc(window.__SF.db,'collections',_xT.id)).catch(()=>{}),
          _xZ?window.__SF.deleteDoc(window.__SF.doc(window.__SF.db,'zones',_xZ,'collections',_xT.id)).catch(()=>{}):Promise.resolve()
        ]);
      }
      loadCollections();break;}
    case 'product':
      await sfDelete('products',itemId);
      await loadCachedData();loadProducts();break;
    case 'route':
      await sfDelete('routes',itemId);
      await loadCachedData();loadRoutes();break;
    case 'broadcast':
      await sfUpdate('broadcasts',itemId,{active:false});
      loadBroadcasts();loadActiveBroadcastsList();break;
    default:
      throw new Error('Unknown item type: '+itemType);
  }
}
// No outlet: walk-in invoices and online shop orders (their customer is on the order).
function outletName(id) { if(!id) return 'Walk-in / online shop'; return (allOutlets.find(o=>o.id===id)||{name:'Unknown'}).name; }
function userName(id) { return (allUsers.find(u=>u.uid===id)||{name:'Unknown'}).name; }
function routeName(id) { return (allRoutes.find(r=>r.id===id)||{name:id||'—'}).name; }
