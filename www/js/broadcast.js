// ═══════════════ BROADCAST ═══════════════
// Real-time listener — unsubscribed on logout
let _broadcastUnsub = null;

function _activeBroadcasts(docs) {
  const now = new Date();
  return docs.map(d=>({id:d.id,...d.data()})).filter(b=>{
    if(!b.active) return false;
    if(b.expiresAt && b.expiresAt !== 0) {
      const exp = b.expiresAt.toDate ? b.expiresAt.toDate() : new Date(b.expiresAt);
      if(exp < now) return false;
    }
    return true;
  });
}

function _renderTicker(active) {
  const ticker = document.getElementById('broadcastTicker');
  const track  = document.getElementById('tickerTrack');
  if(!ticker || !track) return;
  if(!active.length) { ticker.style.display='none'; return; }
  const icons = {urgent:'🚨', info:'ℹ️', normal:'📢'};
  const msgs = active.map(b=>{
    const ownerTag = b.fromOwner ? `<span style="background:rgba(34,197,94,.2);color:var(--acc);border-radius:3px;padding:0 4px;font-size:10px;margin-right:4px">OWNER</span>` : '';
    return `<span style="display:inline-flex;align-items:center;gap:5px;">${icons[b.priority]||'📢'} ${ownerTag}<strong style="color:var(--acc)">${b.priority==='urgent'?'URGENT: ':''}</strong>${b.message}<span style="opacity:.4;margin-left:10px">— ${b.sentByName||'Admin'}</span></span>`;
  });
  track.innerHTML = [...msgs,...msgs,...msgs].join('<span style="opacity:.2;margin:0 30px">◆</span>');
  ticker.style.display='';
}

// Start real-time listener — called once on boot
function startBroadcastListener() {
  if(_broadcastUnsub) { _broadcastUnsub(); _broadcastUnsub=null; }
  try {
    const {onSnapshot, query, where} = window.__SF;
    const q = query(colR('broadcasts'), where('active','==',true));
    _broadcastUnsub = onSnapshot(q, snap => {
      const active = _activeBroadcasts(snap.docs);
      _renderTicker(active);
      if(document.getElementById('mBroadcast')?.classList.contains('show')) {
        _renderActiveBroadcastsList(active);
      }
    }, err => console.warn('[broadcast]', err.message));
  } catch(e) { console.warn('startBroadcastListener', e.message); }
}

// Legacy one-shot (used by _executeDelete refresh)
async function loadBroadcasts() {
  try {
    const docs = await sfGet('broadcasts');
    _renderTicker(_activeBroadcasts(docs));
  } catch(e) { console.warn('loadBroadcasts', e.message); }
}

function closeBroadcastTicker() {
  const t = document.getElementById('broadcastTicker');
  if(t) t.style.display='none';
}

function openBroadcastModal() {
  if(!isAdmin()) { showToast('Only admin/sub-admin can send broadcasts','error'); return; }
  document.getElementById('broadcastMsg').value='';
  document.getElementById('broadcastPriority').value='normal';
  document.getElementById('broadcastExpiry').value='24';

  const zoneRow = document.getElementById('broadcastZoneRow');
  const zoneSel = document.getElementById('broadcastTargetZone');
  const infoBanner = document.getElementById('broadcastInfoBanner');
  if(isOwner() && zoneRow && zoneSel) {
    zoneRow.style.display='';
    zoneSel.innerHTML = '<option value="all">📡 All Zones</option>' +
      allZones.map(z=>`<option value="${z.id}">🗂️ ${z.name}</option>`).join('');
    zoneSel.value='all';
    if(infoBanner) infoBanner.innerHTML='📢 As super admin you can target all zones or a specific zone. Changes take effect immediately.';
  } else {
    if(zoneRow) zoneRow.style.display='none';
    if(infoBanner) infoBanner.innerHTML='📢 This message will appear as a scrolling ticker at the top of the app for your zone.';
  }
  loadActiveBroadcastsList();
  openM('mBroadcast');
}

function onBroadcastZoneChange() {
  const val  = document.getElementById('broadcastTargetZone')?.value;
  const info = document.getElementById('broadcastInfoBanner');
  if(!info) return;
  if(val==='all') {
    info.innerHTML='📡 <strong>All Zones</strong> — broadcast will be pushed to every zone immediately.';
  } else {
    const z = allZones.find(z=>z.id===val);
    info.innerHTML=`🗂️ <strong>${z?z.name:val}</strong> — broadcast will appear only in that zone.`;
  }
}

function _renderActiveBroadcastsList(active) {
  const list = document.getElementById('activeBroadcastsList');
  if(!list) return;
  if(!active.length) {
    list.innerHTML='<div style="font-size:12px;color:var(--tx3);padding:8px 0">No active broadcasts</div>';
    return;
  }
  list.innerHTML = active.map(b=>{
    const ownerBadge = b.fromOwner
      ? `<span style="background:rgba(34,197,94,.15);color:var(--acc);border-radius:3px;padding:1px 5px;font-size:9px;margin-left:4px">OWNER</span>` : '';
    const canDelete = isStrictAdmin() || (isAdmin() && CU.zoneId);
    return `<div style="background:var(--s2);border:1px solid var(--bdr);border-radius:var(--r2);padding:9px 12px;margin-bottom:7px;display:flex;align-items:center;gap:8px">
      <div style="flex:1;min-width:0">
        <div style="font-size:12px;font-weight:600;color:var(--tx)">${b.message}${ownerBadge}</div>
        <div style="font-size:10px;color:var(--tx3);margin-top:2px">By ${b.sentByName||'Admin'} · ${b.priority}</div>
      </div>
      ${canDelete?`<button class="btn btn-red btn-xs" onclick="deleteBroadcast('${b.id}')">✕</button>`:''}
    </div>`;
  }).join('');
}

async function loadActiveBroadcastsList() {
  const docs = await sfGet('broadcasts');
  _renderActiveBroadcastsList(_activeBroadcasts(docs));
}

async function saveBroadcast() {
  const msg = document.getElementById('broadcastMsg').value.trim();
  if(!msg) { showToast('Enter a broadcast message','warn'); return; }
  const priority    = document.getElementById('broadcastPriority').value;
  const expiryHours = parseInt(document.getElementById('broadcastExpiry').value);
  const targetZone  = isOwner() ? (document.getElementById('broadcastTargetZone')?.value||'all') : (CU.zoneId||'all');
  let expiresAt = null;
  if(expiryHours > 0) expiresAt = new Date(Date.now() + expiryHours * 3600000);
  try {
    const data = {
      message: msg, priority, active: true,
      sentBy: CU.uid, sentByName: CU.name,
      sentAt: window.__SF.serverTimestamp(),
      expiresAt: expiresAt ? window.__SF.Timestamp.fromDate(expiresAt) : 0,
      targetZone, fromOwner: isOwner(),
    };
    const addedDoc = await sfAdd('broadcasts', data);
    // Owner: push to target zone subcollections immediately
    if(isOwner() && allZones.length) {
      const zonesToPush = targetZone==='all' ? allZones : allZones.filter(z=>z.id===targetZone);
      const pushData = {...data, sentAt: new Date().toISOString(), fromOwner: true};
      await Promise.all(zonesToPush.map(z=>
        window.__SF.setDoc(zoneDocRef(z.id,'broadcasts',addedDoc.id),
          {...pushData, _zoneId:z.id, _zoneName:z.name})
      ));
      const label = targetZone==='all' ? `all ${allZones.length} zone(s)` : (allZones.find(z=>z.id===targetZone)?.name||targetZone);
      showToast(`Broadcast pushed to ${label} 📢`,'success');
    } else {
      showToast('Broadcast sent 📢','success');
    }
    loadActiveBroadcastsList();
    document.getElementById('broadcastMsg').value='';
  } catch(e) { showToast('Failed: '+e.message,'error'); }
}

async function deleteBroadcast(id) {
  if(isStrictAdmin() || (isAdmin() && CU.zoneId)) {
    try {
      await sfUpdate('broadcasts',id,{active:false});
      showToast('Broadcast removed','info');
      loadActiveBroadcastsList(); loadBroadcasts();
    } catch(e){ showToast('Error removing broadcast','error'); }
  } else {
    await requestDeleteApproval('broadcast',id,'Broadcast');
  }
}

