'use strict';
// ═══════════════ GLOBALS ═══════════════
let CU = null; // current user

// ★ DEVICE GATE — persisted in sessionStorage so it survives the
// onAuthStateChanged(null) → showLoginPage() cycle that happens after signOut.
// Key: 'stfm_device_gate' → 'pending' | 'rejected' | null
function _getDeviceGate()      { return sessionStorage.getItem('stfm_device_gate'); }
function _setDeviceGate(state) { sessionStorage.setItem('stfm_device_gate', state); }
function _clearDeviceGate()    { sessionStorage.removeItem('stfm_device_gate'); }
const COLORS=['#22c55e','#3b82f6','#22c55e','#a855f7','#f59e0b','#ef4444','#06b6d4','#ec4899'];
const MONTHLY_TARGET = 500000;

// Owner zone filter: null = all zones (root mirror), zoneId string = specific zone
let _ownerZoneFilter = null;

let ordItems = [];
let selfieMode = null;
let selfieData = null;
let selfieTimestamp = null;
let camStream = null;
let allOutlets = [];
let allUsers = [];
let allProducts = [];
let allRoutes = [];
let allZones  = [];

// ═══════════════ ZONE HELPERS ═══════════════
function zoneName(id) { return (allZones.find(z=>z.id===id)||{name:'—'}).name; }
function getActiveZoneId() { return (CU&&!isOwner())?CU.zoneId:null; }
// Root-level col refs (bypass zone routing) — used by migration and zone-admin ops
function rootCol(c)         { return window.__SF.collection(db(), c); }
function rootDocRef(c,id)   { return window.__SF.doc(db(), c, id); }
function zoneColRef(zid,c)  { return window.__SF.collection(db(), `zones/${zid}/${c}`); }
function zoneDocRef(zid,c,id){ return window.__SF.doc(db(), `zones/${zid}/${c}`, id); }
// ── User query helper ──────────────────────────────────────────────────────
// Always use this instead of getDocs(rootCol('users')) for non-owner reads.
// Unfiltered getDocs on users is rejected by Firestore rules for field users
// because the rule has a per-doc resource.data.zoneId check.
// Owner gets full unfiltered access; everyone else is zone-scoped.
function _usersRef() {
  const ref = rootCol('users');
  if (isOwner()) return ref;
  if (CU && CU.zoneId) return window.__SF.query(ref, window.__SF.where('zoneId','==',CU.zoneId));
  return ref;
}
async function _fetchUsers() {
  return window.__SF.getDocs(_usersRef());
}

let csvParsedRows = [];

// ═══════════════ HELPERS ═══════════════
const db  = () => window.__SF.db;

// ── Zone-prefixed path helpers ──
// Superadmin (isOwner) sees root collections — full cross-zone access
// Every other user is routed to zones/ZONE_ID/collection based on CU.zoneId
// Shared collections (zones, users) are always at root
const SHARED_COLS = new Set(['zones','users']);
// ── Zone product override helpers ─────────────────────────────────────────────
// Zone admins store per-zone price/cost/stockStatus in productOverrides sub-col.
// allProducts carries merged data: zone copy fields + productOverrides on top.

async function _loadZoneProductOverrides(zoneIdOverride) {
  // Determine which zone's overrides to load:
  // - Owner viewing a specific zone → use that zone
  // - Zone admin/sub-admin → use their own zone
  // - Owner viewing All Zones or no zone → no overrides (global prices)
  const zid = zoneIdOverride || (isOwner() ? _ownerZoneFilter : CU?.zoneId) || null;
  if (!zid) return {};
  try {
    const snap = await window.__SF.getDocs(
      window.__SF.collection(db(), `zones/${zid}/productOverrides`)
    );
    const map = {};
    snap.docs.forEach(d => { map[d.id] = d.data(); });
    return map;
  } catch(e) { console.warn('[productOverrides]', e.message); return {}; }
}

function _applyProductOverrides(prDocs, overrideMap) {
  return prDocs.map(d => {
    const base = { id: d.id, ...d.data() };
    const ov   = overrideMap[d.id];
    if (!ov) return base;
    return {
      ...base,
      price:       ov.price       ?? base.price,
      cost:        ov.cost        ?? base.cost,
      stockStatus: ov.stockStatus ?? base.stockStatus,
      _zoneOverride: true,
    };
  }).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
}

// Write path — owner always writes to root; zone users write to their zone
function _zonePath(c) {
  if(SHARED_COLS.has(c)) return c;
  if(!CU || !CU.zoneId || isOwner()) return c;  // owner/no-zone → root
  return `zones/${CU.zoneId}/${c}`;
}
// Read path — owner can filter to a specific zone for viewing; others same as write path
function _zoneReadPath(c) {
  if(SHARED_COLS.has(c)) return c;
  if(isOwner() && _ownerZoneFilter) return `zones/${_ownerZoneFilter}/${c}`;
  return _zonePath(c);
}
const col    = (c)    => window.__SF.collection(db(), _zonePath(c));
const docRef = (c,id) => window.__SF.doc(db(), _zonePath(c), id);
// Read-only collection reference respecting the owner zone filter
const colR   = (c)    => window.__SF.collection(db(), _zoneReadPath(c));

// ── Mirror-write helpers ──────────────────────────────────────────
// When a zone user writes data, we ALSO write a copy to the root path
// so the owner dashboard always sees live data from every zone.
// Only applies when the user is in a zone (not owner, not no-zone).
// Collections that are already shared at root (zones, users) are skipped.
const MIRROR_COLS = new Set(['orders','outlets','collections','attendance','visits','products','routes','broadcasts','targets','deleteRequests']);

// addDoc with mirror: returns the zone doc ref (primary)
async function sfAdd(colName, data) {
  const zoneRef = col(colName);
  const docAdded = await window.__SF.addDoc(zoneRef, data);
  if(CU && CU.zoneId && !isOwner() && MIRROR_COLS.has(colName)){
    try {
      await window.__SF.setDoc(rootDocRef(colName, docAdded.id), {...data, _zoneId: CU.zoneId, _zoneName: (allZones.find(z=>z.id===CU.zoneId)||{}).name||CU.zoneId});
    } catch(e){ console.warn('[mirror] addDoc root failed:', e.message); }
  }
  invalidateCache();
  return docAdded;
}

// updateDoc with mirror
async function sfUpdate(colName, docId, data) {
  await window.__SF.updateDoc(docRef(colName, docId), data);
  if(CU && CU.zoneId && !isOwner() && MIRROR_COLS.has(colName)){
    try {
      await window.__SF.updateDoc(rootDocRef(colName, docId), data);
    } catch(e){
      try {
        await window.__SF.setDoc(rootDocRef(colName, docId), {...data, _zoneId: CU.zoneId}, {merge: true});
      } catch(e2){ console.warn('[mirror] updateDoc root failed:', e2.message); }
    }
  }
  invalidateCache();
}

// deleteDoc with mirror
async function sfDelete(colName, docId) {
  await window.__SF.deleteDoc(docRef(colName, docId));
  if(CU && CU.zoneId && !isOwner() && MIRROR_COLS.has(colName)){
    try {
      await window.__SF.deleteDoc(rootDocRef(colName, docId));
    } catch(e){ console.warn('[mirror] deleteDoc root failed:', e.message); }
  }
  invalidateCache();
}

async function sfGet(colName, constraints=[]) {
  try {
    const {getDocs, query} = window.__SF;
    const ref = colR(colName); // colR respects _ownerZoneFilter for reads
    const q = constraints.length ? query(ref, ...constraints) : ref;
    const snap = await getDocs(q);
    return snap.docs;
  } catch(e) {
    console.warn('sfGet', colName, e.message);
    return [];
  }
}
async function sfGetOne(colName, docId) {
  try {
    const snap = await window.__SF.getDoc(docRef(colName, docId));
    return snap.exists() ? {id:snap.id,...snap.data()} : null;
  } catch(e) { return null; }
}
function fmt(n) { return 'RM '+Number(n||0).toLocaleString('en-MY',{minimumFractionDigits:2,maximumFractionDigits:2}); }
function fmtD(d) { if(!d) return '—'; const dt=d.toDate?d.toDate():new Date(d); return dt.toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'}); }
function fmtT(d) { if(!d) return '--:--'; const dt=d.toDate?d.toDate():new Date(d); return dt.toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',hour12:false}); }
function todayStr() { return new Date().toISOString().split('T')[0]; }
function uid6() { return Date.now().toString(36).toUpperCase()+Math.random().toString(36).slice(2,5).toUpperCase(); }
function isAdmin() { return CU && (CU.role==='admin'||CU.role==='sub_admin'); }
function isStrictAdmin() { return CU && CU.role==='admin'; }
function isDeliveryMan() { return CU && CU.role==='delivery_man'; }
function isOwner() { return CU && CU.role==='admin' && CU.isOwner===true; }



// ═══════════════════════════════════════════════════════════════
// ══  FCM PUSH NOTIFICATION SYSTEM
// ═══════════════════════════════════════════════════════════════
let _fcmToken = null;
let _fcmServerKey = null; // loaded once from Firestore config/app

// ── 1. Load server key from Firestore (stored by admin) ──────
async function _loadFcmServerKey() {
  if (_fcmServerKey) return _fcmServerKey;
  try {
    const snap = await window.__SF.getDoc(
      window.__SF.doc(window.__SF.db, 'config', 'app')
    );
    if (snap.exists()) {
      _fcmServerKey = snap.data().fcmServerKey || null;
    }
  } catch(e) { console.warn('[FCM] Could not load server key:', e.message); }
  return _fcmServerKey;
}

// ── 2. Init FCM: request permission, get token, save to Firestore ──
async function initFCM() {
  try {
    if (!('Notification' in window) || !('serviceWorker' in navigator)) return;
    // Register service worker
    const reg = await navigator.serviceWorker.register('/firebase-messaging-sw.js');
    // Request permission
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      console.log('[FCM] Notification permission denied');
      return;
    }
    // Load VAPID key from Firestore config/app (field: vapidKey)
    let vapidKey = null;
    try {
      const cfgSnap = await window.__SF.getDoc(window.__SF.doc(window.__SF.db, 'config', 'app'));
      if (cfgSnap.exists()) {
        vapidKey = cfgSnap.data().vapidKey || cfgSnap.data().fcmVapidKey || null;
        if (!_fcmServerKey) _fcmServerKey = cfgSnap.data().fcmServerKey || null;
      }
    } catch(e) { console.warn('[FCM] Could not load config:', e.message); }
    if (!vapidKey) { console.warn('[FCM] No vapidKey in Firestore config/app — push disabled'); return; }
    const messaging = firebase.messaging();
    const token = await messaging.getToken({ vapidKey, serviceWorkerRegistration: reg });
    if (!token) { console.warn('[FCM] No token received'); return; }
    _fcmToken = token;
    // Save token to Firestore under user's uid
    await window.__SF.setDoc(
      window.__SF.doc(window.__SF.db, 'fcmTokens', CU.uid),
      {
        token,
        uid: CU.uid,
        name: CU.name,
        role: CU.role,
        zoneId: CU.zoneId || null,
        updatedAt: window.__SF.serverTimestamp(),
        device: navigator.userAgent.slice(0, 120),
      },
      { merge: true }
    );
    console.log('[FCM] Token registered ✅');
    // Handle foreground messages
    messaging.onMessage(payload => {
      const { title, body } = payload.notification || {};
      _showInAppNotif(title, body, payload.data);
    });
  } catch(e) {
    console.warn('[FCM] initFCM error:', e.message);
  }
}

// ── 3. In-app notification banner (foreground) ───────────────
function _showInAppNotif(title, body, data={}) {
  const wrap = document.createElement('div');
  wrap.style.cssText = `
    position:fixed;top:16px;right:16px;z-index:99999;
    background:var(--s1);border:1px solid var(--bdr);
    border-left:4px solid var(--acc);
    border-radius:var(--r);padding:14px 16px;
    max-width:320px;box-shadow:0 8px 24px rgba(0,0,0,.35);
    animation:slideInRight .3s ease;font-family:'DM Sans',sans-serif;
    cursor:pointer;
  `;
  wrap.innerHTML = `
    <div style="display:flex;align-items:flex-start;gap:10px">
      <div style="font-size:22px;flex-shrink:0">🔔</div>
      <div style="flex:1;min-width:0">
        <div style="font-weight:700;font-size:13px;color:var(--tx);margin-bottom:3px">${title||'STFM'}</div>
        <div style="font-size:12px;color:var(--tx2);line-height:1.4">${body||''}</div>
      </div>
      <button onclick="this.parentElement.parentElement.remove()" style="background:none;border:none;color:var(--tx3);cursor:pointer;font-size:16px;padding:0;flex-shrink:0">✕</button>
    </div>
  `;
  // Add keyframe if not present
  if (!document.getElementById('notifStyle')) {
    const s = document.createElement('style');
    s.id = 'notifStyle';
    s.textContent = '@keyframes slideInRight{from{transform:translateX(120%);opacity:0}to{transform:translateX(0);opacity:1}}';
    document.head.appendChild(s);
  }
  document.body.appendChild(wrap);
  setTimeout(() => wrap.remove(), 7000);
}

// ── 4. Fetch tokens for given UIDs ───────────────────────────
async function _getTokensForUids(uids) {
  const tokens = [];
  await Promise.all(uids.map(async uid => {
    try {
      const snap = await window.__SF.getDoc(
        window.__SF.doc(window.__SF.db, 'fcmTokens', uid)
      );
      if (snap.exists() && snap.data().token) tokens.push(snap.data().token);
    } catch(e) {}
  }));
  return tokens;
}

// ── 5. Get UIDs of all admins in same zone ───────────────────
function _adminUids() {
  return allUsers
    .filter(u => (u.role==='admin'||u.role==='sub_admin') && u.uid !== CU.uid)
    .map(u => u.uid);
}

// ── 6. Core send function — calls FCM Legacy HTTP API ────────
async function sendPushToUsers(uids, title, body, data={}) {
  if (!uids || !uids.length) return;
  const key = await _loadFcmServerKey();
  if (!key) {
    console.warn('[FCM] No server key — set fcmServerKey in Firestore config/app');
    return;
  }
  const tokens = await _getTokensForUids(uids.filter(id=>id!==CU.uid));
  if (!tokens.length) return;
  // FCM Legacy API (send to multiple tokens)
  try {
    const res = await fetch('https://fcm.googleapis.com/fcm/send', {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': 'key=' + key,
      },
      body: JSON.stringify({
        registration_ids: tokens,
        notification: { title, body, icon: '/icon-192.png', sound: 'default' },
        data: { ...data, click_action: 'FLUTTER_NOTIFICATION_CLICK' },
        priority: 'high',
      }),
    });
    const result = await res.json();
    console.log('[FCM] Send result:', result);
  } catch(e) {
    console.warn('[FCM] Send error:', e.message);
  }
}

// ── 7. Convenience wrappers ───────────────────────────────────
// Notify all admins
async function notifyAdmins(title, body, data={}) {
  await sendPushToUsers(_adminUids(), title, body, data);
}
// Notify a specific user by uid
async function notifyUser(uid, title, body, data={}) {
  await sendPushToUsers([uid], title, body, data);
}
// Notify the rep who created an order/collection
async function notifyRep(repUid, title, body, data={}) {
  if (repUid && repUid !== CU.uid) await sendPushToUsers([repUid], title, body, data);
}

let _userLat = null;
let _userLng = null;
let _gpsGranted = false;

function haversineKm(lat1,lng1,lat2,lng2){
  const R=6371;
  const dLat=(lat2-lat1)*Math.PI/180;
  const dLng=(lng2-lng1)*Math.PI/180;
  const a=Math.sin(dLat/2)**2+Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLng/2)**2;
  return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
}

async function requestGPSPermission() {
  return new Promise((resolve)=>{
    if(!navigator.geolocation){
      showToast('GPS not supported on this device','error');
      resolve(false);return;
    }
    navigator.geolocation.getCurrentPosition(
      pos=>{
        _userLat=pos.coords.latitude;
        _userLng=pos.coords.longitude;
        _gpsGranted=true;
        resolve(true);
      },
      err=>{
        if(err.code===1){
          showToast('GPS permission denied. Please allow location access and refresh.','error');
        } else {
          showToast('Could not get GPS location. Check device settings.','warn');
        }
        resolve(false);
      },
      {enableHighAccuracy:true,timeout:12000,maximumAge:60000}
    );
  });
}

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
  if(!await _customConfirm(`"${itemLabel}" will be permanently removed.`, {title:'Confirm Delete',okText:'Delete',cancelText:'Cancel',danger:true,icon:'🗑️'}))return;
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
  if (!await _customConfirm(`Revoke device for ${name}?\n\nThey will need re-approval to log in from it.`, {title:'Revoke Device',okText:'Revoke',cancelText:'Cancel',danger:true,icon:'📵'})) return;
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
function outletName(id) { return (allOutlets.find(o=>o.id===id)||{name:'Unknown'}).name; }
function userName(id) { return (allUsers.find(u=>u.uid===id)||{name:'Unknown'}).name; }
function routeName(id) { return (allRoutes.find(r=>r.id===id)||{name:id||'—'}).name; }

// ═══════════════ TOAST ═══════════════
function showToast(msg,type='info') {
  const icons={success:'✅',error:'❌',info:'ℹ️',warn:'⚠️'};
  const t=document.createElement('div');
  t.className=`toast ${type}`;
  t.innerHTML=`<span>${icons[type]||'ℹ️'}</span><span style="flex:1">${msg}</span>`;
  document.getElementById('toasts').appendChild(t);
  setTimeout(()=>{t.classList.add('fo');setTimeout(()=>t.remove(),300);},3200);
}

// ═══════════════ AUTH ═══════════════
function showLoginPage() {
  // ★ If a device gate is active, show that screen instead of login
  const gate = _getDeviceGate();
  if (gate === 'pending' || gate === 'rejected') {
    showDevicePendingScreen(gate);
    return;
  }
  const loader = document.getElementById('loader');
  if(loader) { loader.classList.add('hidden'); loader.classList.remove('device-gate'); }
  document.getElementById('loginPage').style.display='flex';
  document.getElementById('app').style.display='none';
  const lb=document.getElementById('loginBtn');
  if(lb){lb.disabled=false;lb.textContent='Sign In →';}
}

// ═══════════════ DEVICE FINGERPRINT ═══════════════
/**
 * Generates a stable device ID from browser signals.
 * Stored in localStorage so it persists across sessions on the same device.
 */
function getDeviceId() {
  const LS_KEY = 'stfm_device_id';
  let id = localStorage.getItem(LS_KEY);
  if (id) return id;
  // Build a fingerprint from available browser signals
  const raw = [
    navigator.userAgent,
    navigator.language,
    screen.width + 'x' + screen.height,
    screen.colorDepth,
    new Date().getTimezoneOffset(),
    navigator.hardwareConcurrency || '',
    navigator.platform || '',
  ].join('|');
  // Simple hash
  let hash = 0;
  for (let i = 0; i < raw.length; i++) {
    hash = ((hash << 5) - hash) + raw.charCodeAt(i);
    hash |= 0;
  }
  id = 'dev_' + Math.abs(hash).toString(36) + '_' + Date.now().toString(36);
  localStorage.setItem(LS_KEY, id);
  return id;
}

function getDeviceLabel() {
  const ua = navigator.userAgent;
  let os = 'Unknown OS';
  if (/Windows/.test(ua)) os = 'Windows';
  else if (/Android/.test(ua)) os = 'Android';
  else if (/iPhone|iPad/.test(ua)) os = 'iOS';
  else if (/Mac/.test(ua)) os = 'macOS';
  else if (/Linux/.test(ua)) os = 'Linux';
  let browser = 'Unknown Browser';
  if (/Edg\//.test(ua)) browser = 'Edge';
  else if (/Chrome\//.test(ua)) browser = 'Chrome';
  else if (/Firefox\//.test(ua)) browser = 'Firefox';
  else if (/Safari\//.test(ua)) browser = 'Safari';
  return `${browser} on ${os}`;
}

// ═══════════════ DEVICE APPROVAL CHECK ═══════════════
/**
 * After Firebase signs in a sales_rep, check if their device is trusted.
 * If not → sign them out, submit an approval request, show pending screen.
 */
// ═══════════════ DEVICE APPROVAL GATE ═══════════════
/**
 * Called from INSIDE bootApp for every sales_rep login.
 * Returns true  → device is approved, boot continues.
 * Returns false → device is pending/rejected, gate screen shown, boot aborts.
 *
 * Uses sessionStorage to persist gate state across the signOut →
 * onAuthStateChanged(null) → showLoginPage() cycle.
 */
async function _enforceDeviceGate(userProfile) {
  const deviceId = getDeviceId();
  try {
    const deviceRef = window.__SF.doc(db(), `deviceApprovals/${userProfile.uid}/devices/${deviceId}`);
    const deviceSnap = await window.__SF.getDoc(deviceRef);

    if (deviceSnap.exists() && deviceSnap.data().status === 'approved') {
      // ✅ Trusted — clear any stale gate, update last seen silently
      _clearDeviceGate();
      window.__SF.updateDoc(deviceRef, { lastSeen: new Date().toISOString() }).catch(()=>{});
      return true;
    }

    const gateState = (deviceSnap.exists() && deviceSnap.data().status === 'rejected')
      ? 'rejected' : 'pending';

    // ★ Persist gate state BEFORE signOut — survives the auth observer cycle
    _setDeviceGate(gateState);

    // Write request doc if new device
    if (gateState === 'pending' && (!deviceSnap.exists() || deviceSnap.data().status !== 'pending')) {
      const label = getDeviceLabel();
      const reqData = {
        deviceId, label,
        userAgent: navigator.userAgent,
        uid: userProfile.uid,
        userName: userProfile.name,
        userEmail: userProfile.email,
        zoneId: userProfile.zoneId || null,
        status: 'pending',
        requestedAt: new Date().toISOString(),
        lastSeen: new Date().toISOString(),
      };
      await window.__SF.setDoc(deviceRef, reqData);
      await window.__SF.setDoc(
        window.__SF.doc(db(), `deviceApprovalRequests/${userProfile.uid}_${deviceId}`),
        { ...reqData }
      );
    }

    // Sign out — onAuthStateChanged fires → showLoginPage() →
    // but showLoginPage() now reads sessionStorage and shows gate screen instead
    await window.__SF.signOut(window.__SF.auth);

    // Show gate screen immediately (signOut is async but screen shows now)
    showDevicePendingScreen(gateState);
    return false;

  } catch(e) {
    console.error('[deviceGate] error:', e.message);
    _clearDeviceGate();
    return true; // fail open if Firestore rules not yet deployed
  }
}

/**
 * Called from doLogin — thin wrapper, real check is in bootApp → _enforceDeviceGate
 */
async function checkDeviceApproval(firebaseUser) {
  const snap = await window.__SF.getDoc(rootDocRef('users', firebaseUser.uid));
  if (!snap.exists()) return;
  const profile = snap.data();
  if (profile.role !== 'sales_rep') return;
  await _enforceDeviceGate({ ...profile, uid: firebaseUser.uid });
}

function showDevicePendingScreen(status) {
  // Hide login, hide app
  document.getElementById('loginPage').style.display = 'none';
  document.getElementById('app').style.display = 'none';
  const loader = document.getElementById('loader');
  loader.classList.remove('hidden');
  loader.style.display = 'flex';
  loader.classList.add('device-gate');

  if (status === 'rejected') {
    loader.innerHTML = `
      <div class="device-gate-card">
        <div class="device-gate-icon">🚫</div>
        <div class="device-gate-title rejected">Device Access Denied</div>
        <div class="device-gate-body">Your admin has rejected this device. Use an approved device or contact your admin.</div>
        <div class="device-gate-info">
          📱 ${getDeviceLabel()}
          <br><small>${getDeviceId()}</small>
        </div>
        <div class="device-gate-actions">
          <button class="btn btn-ghost" onclick="_clearDeviceGate();document.getElementById('loader').classList.add('hidden');document.getElementById('loader').classList.remove('device-gate');document.getElementById('loginPage').style.display='flex';">← Back to Login</button>
        </div>
      </div>`;
  } else {
    loader.innerHTML = `
      <div class="device-gate-card">
        <div class="device-gate-icon pulse">📱</div>
        <div class="device-gate-title pending">New Device — Awaiting Approval</div>
        <div class="device-gate-body">Your admin has been notified. Once approved you can log in. You'll receive a push notification.</div>
        <div class="device-gate-info">
          📱 ${getDeviceLabel()}
          <br><small>${getDeviceId()}</small>
        </div>
        <div class="device-gate-actions">
          <button class="btn btn-primary" onclick="location.reload()">🔄 Check Again</button>
          <button class="btn btn-ghost" onclick="_clearDeviceGate();document.getElementById('loader').classList.add('hidden');document.getElementById('loader').classList.remove('device-gate');document.getElementById('loginPage').style.display='flex';">← Back to Login</button>
        </div>
      </div>`;
  }
}

async function doLogin() {
  const e=document.getElementById('lemail').value.trim();
  const p=document.getElementById('lpwd').value;
  if(!e||!p){showToast('Enter email and password','warn');return;}
  const btn=document.getElementById('loginBtn');
  btn.disabled=true;btn.textContent='Signing in...';
  const safeReset=setTimeout(()=>{btn.disabled=false;btn.textContent='Sign In →';},10000);
  try {
    const rememberMe=document.getElementById('rememberMe')?.checked;
    const {setPersistence,browserLocalPersistence,browserSessionPersistence}=window.__SF;
    await setPersistence(window.__SF.auth, rememberMe ? browserLocalPersistence : browserSessionPersistence);
    const cred = await window.__SF.signInWithEmailAndPassword(window.__SF.auth,e,p);
    clearTimeout(safeReset);
    btn.disabled=false; btn.textContent='Sign In →';
    // ★ Device approval gate — runs before bootApp for sales reps
    try {
      await checkDeviceApproval(cred.user);
    } catch(devErr) {
      console.error('[deviceApproval] check failed:', devErr.message);
      // If the check itself errors (e.g. Firestore rules), fail open for non-sales-rep
      // For safety, show an error toast but still allow bootApp to proceed
      showToast('Device check failed — contact admin if you cannot access the app', 'warn');
    }
  } catch(err) {
    clearTimeout(safeReset);
    btn.disabled=false;btn.textContent='Sign In →';
    const msgs={
      'auth/user-not-found':'No account found with this email.',
      'auth/wrong-password':'Incorrect password.',
      'auth/invalid-credential':'Incorrect email or password.',
      'auth/invalid-email':'Please enter a valid email address.',
      'auth/user-disabled':'This account has been disabled. Contact your admin.',
      'auth/too-many-requests':'Too many failed attempts. Try again later or reset your password.',
      'auth/network-request-failed':'Network error. Check your internet connection and try again.',
    };
    showToast(msgs[err.code]||('Login failed: '+err.message),'error');
  }
}

async function doLogout() {
  _clearDeviceGate();
  stopCamera();
  stopLocationTracking();
  _stopRepLocationsListener();
  if(_broadcastUnsub){_broadcastUnsub();_broadcastUnsub=null;}
  await window.__SF.signOut(window.__SF.auth);
}

// ═══════════════ PASSWORD MANAGEMENT ═══════════════

// --- Forgot Password (login screen) ---
function openForgotPassword() {
  const email=document.getElementById('lemail')?.value.trim()||'';
  document.getElementById('fpEmail').value=email;
  openM('mForgotPwd');
}

async function sendPasswordReset() {
  const email=document.getElementById('fpEmail').value.trim();
  if(!email){showToast('Enter your email address','warn');return;}
  const btn=document.querySelector('#mForgotPwd .btn-primary');
  if(btn){btn.disabled=true;btn.textContent='Sending…';}
  try {
    await window.__SF.sendPasswordResetEmail(window.__SF.auth, email);
    closeM('mForgotPwd');
    showToast(`Reset link sent to ${email} — check your inbox 📧`,'success');
  } catch(err) {
    const msgs={
      'auth/user-not-found':'No account found with this email.',
      'auth/invalid-email':'Please enter a valid email address.',
      'auth/too-many-requests':'Too many requests. Try again later.',
    };
    showToast(msgs[err.code]||'Failed to send reset email: '+err.message,'error');
  } finally {
    if(btn){btn.disabled=false;btn.textContent='📧 Send Reset Link';}
  }
}

// --- Change Password (logged-in user) ---
function openChangePassword() {
  if(!CU){showToast('Not logged in','error');return;}
  document.getElementById('cpCurrent').value='';
  document.getElementById('cpNew').value='';
  document.getElementById('cpConfirm').value='';
  document.getElementById('cpUserLabel').textContent=`${CU.name} (${CU.email})`;
  document.getElementById('pwdStrengthBar').style.display='none';
  document.getElementById('pwdStrengthLabel').textContent='';
  closeSidebar();
  openM('mChangePwd');
}

function togglePwdVisibility(inputId, btn) {
  const el=document.getElementById(inputId);
  if(!el)return;
  const isHidden=el.type==='password';
  el.type=isHidden?'text':'password';
  btn.textContent=isHidden?'🙈':'👁';
}

function checkPwdStrength(pwd) {
  const bar=document.getElementById('pwdStrengthBar');
  const fill=document.getElementById('pwdStrengthFill');
  const label=document.getElementById('pwdStrengthLabel');
  if(!pwd){bar.style.display='none';label.textContent='';return;}
  bar.style.display='';
  let score=0;
  if(pwd.length>=6)score++;
  if(pwd.length>=10)score++;
  if(/[A-Z]/.test(pwd))score++;
  if(/[0-9]/.test(pwd))score++;
  if(/[^A-Za-z0-9]/.test(pwd))score++;
  const levels=[
    {w:'20%',bg:'var(--red)',t:'Very weak'},
    {w:'40%',bg:'var(--ylw)',t:'Weak'},
    {w:'60%',bg:'var(--ylw)',t:'Fair'},
    {w:'80%',bg:'var(--grn)',t:'Strong'},
    {w:'100%',bg:'#16a34a',t:'Very strong'},
  ];
  const lvl=levels[Math.min(score,4)];
  fill.style.width=lvl.w;fill.style.background=lvl.bg;
  label.style.color=lvl.bg;label.textContent=lvl.t;
}

async function doChangePassword() {
  const current=document.getElementById('cpCurrent').value;
  const newPwd=document.getElementById('cpNew').value;
  const confirm=document.getElementById('cpConfirm').value;
  if(!current){showToast('Enter your current password','warn');return;}
  if(!newPwd||newPwd.length<6){showToast('New password must be at least 6 characters','warn');return;}
  if(newPwd!==confirm){showToast('New passwords do not match','error');return;}
  if(newPwd===current){showToast('New password must be different from current password','warn');return;}
  const btn=document.querySelector('#mChangePwd .btn-primary');
  if(btn){btn.disabled=true;btn.textContent='Updating…';}
  try {
    const user=window.__SF.auth.currentUser;
    if(!user)throw new Error('Not authenticated');
    // Re-authenticate first
    const cred=window.__SF.EmailAuthProvider.credential(user.email, current);
    await window.__SF.reauthenticateWithCredential(user, cred);
    // Now update password
    await window.__SF.updatePassword(user, newPwd);
    closeM('mChangePwd');
    showToast('Password changed successfully 🔑','success');
  } catch(err) {
    const msgs={
      'auth/wrong-password':'Current password is incorrect.',
      'auth/invalid-credential':'Current password is incorrect.',
      'auth/too-many-requests':'Too many attempts. Try again later.',
      'auth/weak-password':'New password is too weak. Use at least 6 characters.',
      'auth/requires-recent-login':'Session expired. Please sign out and sign in again before changing your password.',
    };
    showToast(msgs[err.code]||'Failed to change password: '+err.message,'error');
  } finally {
    if(btn){btn.disabled=false;btn.textContent='🔑 Update Password';}
  }
}

// --- Admin reset another user's password ---
function openAdminResetPassword(name, email) {
  if(!isAdmin()){showToast('Admin only','error');return;}
  document.getElementById('arpUserName').textContent=name;
  document.getElementById('arpUserEmail').textContent=email;
  document.getElementById('arpUserEmailHidden').value=email;
  openM('mAdminResetPwd');
}

async function doAdminResetPassword() {
  const email=document.getElementById('arpUserEmailHidden').value;
  if(!email){showToast('No email found','error');return;}
  const btn=document.querySelector('#mAdminResetPwd .btn-ylw');
  if(btn){btn.disabled=true;btn.textContent='Sending…';}
  try {
    await window.__SF.sendPasswordResetEmail(window.__SF.auth, email);
    closeM('mAdminResetPwd');
    showToast(`Password reset email sent to ${email} 📧`,'success');
  } catch(err) {
    const msgs={
      'auth/user-not-found':'No Firebase account found for this email.',
      'auth/too-many-requests':'Too many requests. Try again later.',
    };
    showToast(msgs[err.code]||'Failed: '+err.message,'error');
  } finally {
    if(btn){btn.disabled=false;btn.textContent='📧 Send Reset Email';}
  }
}

// ═══════════════ FIRST SETUP ═══════════════
let _setupUser = null;
function showSetupPanel(user) {
  document.getElementById('loader').classList.add('hidden');
  _setupUser = user;
  document.getElementById('setupPanel').classList.add('show');
}

async function completeSetup() {
  const name=document.getElementById('setupName').value.trim();
  if(!name){showToast('Enter your name','warn');return;}
  await window.__SF.setDoc(rootDocRef('users',_setupUser.uid),{
    uid:_setupUser.uid, name, email:_setupUser.email,
    role:'admin', isOwner:true, phone:document.getElementById('setupPhone').value.trim()||'',
    status:'active', createdAt:new Date().toISOString()
  });
  window.__currentUser={uid:_setupUser.uid,name,email:_setupUser.email,role:'admin',isOwner:true,status:'active'};
  document.getElementById('setupPanel').classList.remove('show');
  bootApp();
  showToast(`Welcome, ${name}! Admin account created.`,'success');
}

// ═══════════════ BOOT ═══════════════
async function bootApp() {
  // ★ If sessionStorage gate is active, show gate screen and abort boot
  const gate = _getDeviceGate();
  if (gate === 'pending' || gate === 'rejected') {
    showDevicePendingScreen(gate);
    return;
  }
  try {
    CU = window.__currentUser;
    if(!CU || !CU.uid) { showLoginPage(); return; }

    // ★ DEVICE APPROVAL GATE — enforce inside bootApp for sales_rep
    if (CU.role === 'sales_rep') {
      const allowed = await _enforceDeviceGate(CU);
      if (!allowed) return;
    }

    // Show the app shell immediately
    document.getElementById('loader').classList.add('hidden');
    document.getElementById('loginPage').style.display='none';
    const appEl = document.getElementById('app');
    appEl.style.display='flex';

    document.getElementById('sbName').textContent = CU.name;
    document.getElementById('sbAva').textContent = CU.name[0].toUpperCase();
    setupNavForRole();
    startClock();
    initDateDefaults();

    const lb=document.getElementById('loginBtn');
    if(lb){lb.disabled=false;lb.textContent='Sign In →';}

    // ★ GPS PERMISSION — required for field users (sales_rep, delivery_man) for tracking
    // Admins do NOT need GPS and must never be blocked by GPS denial
    const gpsOk = await requestGPSPermission();
    if(!gpsOk && !isAdmin()){
      // Show a blocking GPS required screen only for field users
      const appEl2=document.getElementById('app');
      appEl2.style.display='none';
      const loader2=document.getElementById('loader');
      loader2.classList.remove('hidden');
      loader2.style.display='flex';
      loader2.innerHTML=`
        <div style="text-align:center;padding:24px;max-width:320px">
          <div style="font-size:48px;margin-bottom:12px">📍</div>
          <div style="font-family:'Syne',sans-serif;font-size:17px;font-weight:700;color:var(--tx);margin-bottom:8px">Location Required</div>
          <div style="font-size:13px;color:var(--tx2);margin-bottom:20px;line-height:1.5">STFM needs your GPS location for outlet sorting and field tracking. Please allow location access.</div>
          <button onclick="location.reload()" style="background:linear-gradient(135deg,#22c55e,#15803d);color:#fff;border:none;padding:12px 28px;border-radius:10px;font-size:14px;font-weight:600;cursor:pointer;width:100%">📍 Allow Location & Retry</button>
          <button onclick="doLogout()" style="background:var(--s2);color:var(--tx2);border:1px solid var(--bdr);padding:10px 22px;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;margin-top:10px;width:100%">Sign Out</button>
        </div>`;
      return;
    }
    // Old code: await loadCachedData() [3 fetches], then renderDashboard() [3 more fetches] = sequential slow
    // New code: all 6 fire at the same time — saves one full round-trip latency
    // New code: all collections fire at the same time — saves one full round-trip latency
    const [ouDocs, prDocs, ordDocs, colDocs, attDocs, rtDocs, znDocs] = await Promise.all([
      sfGet('outlets'), window.__SF.getDocs(rootCol('products')), // always root global catalog
      sfGet('orders'),  sfGet('collections'), sfGet('attendance'), sfGet('routes'), sfGet('zones')
    ]);
    // Users always fetched from root (shared collection)
    const uSnapBoot = await _fetchUsers(); // zone-filtered for non-owners

    allZones    = znDocs.map(d=>({id:d.id,...d.data()}));
    allOutlets  = ouDocs.map(d=>({id:d.id,...d.data()}));
    allUsers    = isOwner()
      ? uSnapBoot.docs.map(d=>({...d.data()}))
      : uSnapBoot.docs.map(d=>({...d.data()})).filter(u=>u.isOwner||u.zoneId===CU.zoneId||u.uid===CU.uid);
    const _ovMap1 = await _loadZoneProductOverrides();
    // Products always from root global catalog; prDocs already from rootCol('products') in boot
    allProducts = _applyProductOverrides(prDocs.docs, _ovMap1);
    allRoutes   = rtDocs.map(d=>({id:d.id,...d.data()}));

    // Init zone bar + export buttons NOW — allZones is populated
    if(isAdmin()) initOwnerZoneBar();

    // Pre-loaded docs used directly — zone scoping is handled at collection path level
    const filtOrdDocs = ordDocs;
    const filtColDocs = colDocs;
    const filtAttDocs = attDocs;

    // Use internal functions that accept pre-loaded data — no extra Firestore round-trips
    _renderDashboard(filtOrdDocs, filtColDocs, filtAttDocs);
    _checkTodayAttendance(filtAttDocs);
    _updateBadges(filtOrdDocs);
    _updateSidebarStats(filtOrdDocs, filtColDocs);

    // ★ Restore last page or default based on role
    const lastPg = sessionStorage.getItem('stfm_lastPage');
    if(CU.role==='delivery_man') {
      goPage('delivery');
    } else if(lastPg && lastPg!=='dashboard') {
      goPage(lastPg);
    }

    // ★ Exit confirmation — warn before leaving the app
    window.addEventListener('beforeunload', e=>{
      e.preventDefault();
      e.returnValue='Are you sure you want to leave STFM?';
      return e.returnValue;
    });

    // NEW: start real-time broadcast listener + location tracking + sales target
    startBroadcastListener();
    startLocationTracking();
    loadSalesTarget();
    if(isStrictAdmin()) updateDeleteRequestBadge();
    if(isAdmin()) updateDeviceRequestBadge();
    // ★ FCM push notification registration
    initFCM().catch(e=>console.warn('[FCM] init failed:',e.message));

    // QR deep-link: ?oc=OUTLET_ID — auto-open order for that outlet after boot
    const _urlParams=new URLSearchParams(window.location.search);
    const _qrOutlet=_urlParams.get('oc');
    if(_qrOutlet){
      goPage('orders');
      setTimeout(()=>openNewOrder(_qrOutlet),600);
    }

  } catch(err) {
    console.error('bootApp error:', err);
    const loader = document.getElementById('loader');
    loader.style.display='flex';
    loader.classList.remove('hidden');
    loader.innerHTML = `
      <div style="text-align:center;padding:20px">
        <div style="font-size:36px;margin-bottom:12px">⚠️</div>
        <div style="font-family:'Syne',sans-serif;font-size:16px;font-weight:700;color:var(--tx);margin-bottom:6px">Failed to load</div>
        <div style="font-size:12px;color:var(--tx3);margin-bottom:18px;max-width:280px">${err.message||'Could not connect. Check your internet connection.'}</div>
        <button onclick="location.reload()" style="background:linear-gradient(135deg,#22c55e,#15803d);color:#fff;border:none;padding:10px 22px;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer">🔄 Retry</button>
        <button onclick="doLogout()" style="background:var(--s2);color:var(--tx2);border:1px solid var(--bdr);padding:10px 22px;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;margin-left:8px">Sign Out</button>
      </div>`;
  }
}

function setupNavForRole() {
  const role = CU.role;
  if (role === 'admin' || role === 'sub_admin') {
    document.querySelectorAll('.admin-only').forEach(e => e.style.display = 'flex');
  }
  if (role === 'sub_admin') {
    document.querySelectorAll('.admin-user-only').forEach(e => e.style.display = 'none');
  }
  // Delete Requests nav only visible to strict admin
  const delReqNav = document.getElementById('deleteReqNav');
  if(delReqNav) delReqNav.style.display = role==='admin' ? 'flex' : 'none';

  // Zones nav — owner only
  const zonesNav = document.getElementById('zonesNav');
  if(zonesNav) zonesNav.style.display = isOwner() ? 'flex' : 'none';
  const migrationNav = document.getElementById('migrationNav');
  if(migrationNav) migrationNav.style.display = isOwner() ? 'flex' : 'none';

  if (role === 'delivery_man') {
    document.querySelectorAll('.delivery-only').forEach(e => e.style.display = 'flex');
    ['orders','collection','reports'].forEach(pg=>{
      const nitem=[...document.querySelectorAll('.nitem')].find(n=>n.textContent.trim().toLowerCase().startsWith(pg.slice(0,4)));
      if(nitem)nitem.style.display='none';
    });
  }

  const ownerLabel = isOwner() ? ' 👑' : '';
  const roleMap = {admin:`🔑 Admin Dashboard${ownerLabel}`,sub_admin:'🛡️ Sub-Admin Dashboard',sales_rep:'👤 Sales Rep Dashboard',delivery_man:'🚚 Delivery Dashboard'};
  const tbSub = document.getElementById('tbSub');
  if(tbSub) tbSub.textContent = roleMap[role] || 'Dashboard';
  const roleEl = document.getElementById('sbRole');
  if(roleEl) {
    const roleLabels = {admin:isOwner()?'Owner / Super Admin':'Administrator',sub_admin:'Sub Admin',sales_rep:'Sales Rep',delivery_man:'Delivery Man'};
    roleEl.textContent = roleLabels[role] || role;
    const roleColors = {admin:'var(--acc)',sub_admin:'var(--pur)',sales_rep:'var(--blu)',delivery_man:'var(--grn)'};
    roleEl.style.color = roleColors[role] || 'var(--tx2)';
  }
  // Show zone badge in sidebar
  const zoneBadgeEl = document.getElementById('sbZoneBadge');
  if(zoneBadgeEl){
    if(isOwner()){
      zoneBadgeEl.innerHTML='<span style="font-size:10px;color:var(--acc);font-weight:700">👑 All Zones Access</span>';
    } else if(CU.zoneId){
      const zn=allZones.find(z=>z.id===CU.zoneId);
      zoneBadgeEl.innerHTML=`<span style="font-size:10px;color:var(--tx3)">🗂️ Zone: <strong style="color:var(--ylw)">${zn?zn.name:CU.zoneId}</strong></span>`;
    } else {
      zoneBadgeEl.innerHTML='<span style="font-size:10px;color:var(--red)">⚠️ No zone assigned — contact owner</span>';
    }
    zoneBadgeEl.style.display='';
  }
}
// NOTE: initOwnerZoneBar() is called from bootApp AFTER allZones is populated

// ═══════════════ OWNER ZONE FILTER ═══════════════
// Map of export button id → pages it should show on
const _EXPORT_BTN_MAP = {
  exportOrdersBtn:   ['orders'],
  exportOutletsBtn:  ['outlets'],
  exportCollBtn:     ['collection'],
  exportReportBtn:   ['reports'],
  exportMonBtn:      ['monitoring'],
};

function _showExportBtns(pg) {
  if(!isAdmin()) return;
  Object.entries(_EXPORT_BTN_MAP).forEach(([id, pages]) => {
    const btn = document.getElementById(id);
    if(btn) btn.style.display = pages.includes(pg) ? '' : 'none';
  });
}

function initOwnerZoneBar() {
  // Export buttons — visible for all admins on the matching page
  // (called once from setupNavForRole; actual per-page toggle done in _updateOwnerZoneBar)
  _showExportBtns('dashboard'); // hides all initially; goPage will show correct ones

  if(!isOwner()) return;
  const bar = document.getElementById('ownerZoneBar');
  const sel = document.getElementById('ownerZoneSelect');
  if(!bar || !sel) return;
  bar.style.display = 'none'; // hidden until a data page is opened
  // Populate zone options
  sel.innerHTML = '<option value="">📡 All Zones (combined)</option>' +
    allZones.map(z=>`<option value="${z.id}">${z.name}</option>`).join('');
  sel.value = _ownerZoneFilter || '';
}

async function setOwnerZoneFilter(zid) {
  _ownerZoneFilter = zid || null;
  const lbl = document.getElementById('ownerZoneFilterLabel');
  if(lbl) {
    if(_ownerZoneFilter) {
      const z = allZones.find(z=>z.id===_ownerZoneFilter);
      lbl.textContent = `Showing zone: ${z ? z.name : _ownerZoneFilter}`;
      lbl.style.color = 'var(--ylw)';
    } else {
      lbl.textContent = 'Viewing root — combined data from all zones';
      lbl.style.color = 'var(--tx3)';
    }
  }
  // Invalidate all caches — zone change means all data is stale
  invalidateCache();
  invalidateDashCache();
  // Force-reload cached collections so allOutlets/allRoutes/allUsers reflect new zone
  await loadCachedData(true);
  // Reload current active page under the new zone scope
  const activePage = document.querySelector('.page.active');
  if(!activePage) return;
  const raw = activePage.id.replace(/^page/, '');
  const pg  = raw.charAt(0).toLowerCase() + raw.slice(1);
  const reloaders = {
    dashboard:  renderDashboard,
    orders:     loadOrders,
    outlets:    loadOutlets,
    collection: loadCollections,
    reports:    renderReports,
    monitoring: loadMonitoring,
    routes:     loadRoutes,
    users:      loadUsers,
    products:   ()=>{ loadCachedData(true).then(loadProducts); }, // force fresh + zone overrides
    deliveries: loadDeliveries,
    delivery:   loadMyDeliveries,
    attendance: ()=>{ loadAttHistory(); },
    zones:      loadZones,
    outletstructure: loadOutletStructure,
  };
  if(reloaders[pg]) reloaders[pg]();

  // If rep locations modal is open, restart the live listener under the new zone filter
  const repLocModal = document.getElementById('mRepLocations');
  if(repLocModal && repLocModal.classList.contains('show')) {
    _startRepLocationsListener();
  }
}

// ── Show/hide zone bar + export buttons on every page transition ──
const _ZONE_BAR_PAGES = new Set(['dashboard','orders','outlets','collection','reports','monitoring','routes','users','attendance','products','deliveries','outletstructure']);
function _updateOwnerZoneBar(pg) {
  // Export buttons for any admin
  _showExportBtns(pg);
  // Zone filter bar for owner only
  if(!isOwner()) return;
  const bar = document.getElementById('ownerZoneBar');
  if(bar) bar.style.display = _ZONE_BAR_PAGES.has(pg) ? '' : 'none';
}

// ═══════════════ CSV EXPORT ═══════════════
// Generic download helper
function _downloadCSV(rows, filename) {
  if(!rows.length){ showToast('No data to export','warn'); return; }
  const csv = rows.map(r => r.map(cell => {
    const s = String(cell ?? '').replace(/"/g, '""');
    return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s}"` : s;
  }).join(',')).join('\n');
  const a = document.createElement('a');
  a.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);
  a.download = filename;
  a.click();
  showToast(`Exported ${rows.length - 1} rows to ${filename}`, 'success');
}

async function exportOrders() {
  showToast('Preparing orders export...', 'info');
  const ordDocs = await sfGet('orders');
  const orders = ordDocs.map(d=>({_docId:d.id,...d.data()}));
  const zoneLabel = _ownerZoneFilter ? (allZones.find(z=>z.id===_ownerZoneFilter)?.name||_ownerZoneFilter) : 'AllZones';
  const rows = [['Order ID','Outlet','Rep','Items','Total (RM)','Date','Status','Zone']];
  orders.sort((a,b)=>(b.createdAt?.seconds||0)-(a.createdAt?.seconds||0)).forEach(o=>{
    rows.push([
      o.id||o._docId, outletName(o.outletId), userName(o.createdBy),
      o.items?.length||0, (o.total||0).toFixed(2), o.date||'',
      o.status||'', o._zoneName||zoneLabel
    ]);
  });
  _downloadCSV(rows, `STFM_Orders_${zoneLabel}_${todayStr()}.csv`);
}

async function exportOutlets() {
  showToast('Preparing outlets export...', 'info');
  await loadCachedData();
  const zoneLabel = _ownerZoneFilter ? (allZones.find(z=>z.id===_ownerZoneFilter)?.name||_ownerZoneFilter) : 'AllZones';
  const rows = [['Outlet Name','Type','Area','Route','Phone','Opening Balance','Balance Status','GPS Lat','GPS Lng','Zone']];
  allOutlets.forEach(o=>{
    rows.push([
      o.name||'', o.type||'', o.area||'', routeName(o.routeId)||'',
      o.phone||'', o.openingBalance||0, o.balanceStatus||'',
      o.lat||'', o.lng||'', o._zoneName||zoneLabel
    ]);
  });
  _downloadCSV(rows, `STFM_Outlets_${zoneLabel}_${todayStr()}.csv`);
}

async function exportCollections() {
  showToast('Preparing collections export...', 'info');
  const colDocs = await sfGet('collections');
  const cols = colDocs.map(d=>({id:d.id,...d.data()}));
  const zoneLabel = _ownerZoneFilter ? (allZones.find(z=>z.id===_ownerZoneFilter)?.name||_ownerZoneFilter) : 'AllZones';
  const rows = [['Receipt ID','Outlet','Rep','Amount (RM)','Mode','Date','Notes','Zone']];
  cols.sort((a,b)=>(b.createdAt?.seconds||0)-(a.createdAt?.seconds||0)).forEach(c=>{
    rows.push([
      c.id||'', outletName(c.outletId), userName(c.createdBy),
      (c.amount||0).toFixed(2), c.mode||'', c.date||'', c.notes||'',
      c._zoneName||zoneLabel
    ]);
  });
  _downloadCSV(rows, `STFM_Collections_${zoneLabel}_${todayStr()}.csv`);
}

async function exportReport() {
  showToast('Preparing report export...', 'info');
  const days = parseInt(document.getElementById('rptPeriod')?.value||30);
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate()-days);
  const cutStr = cutoff.toISOString().split('T')[0];
  const zoneLabel = _ownerZoneFilter ? (allZones.find(z=>z.id===_ownerZoneFilter)?.name||_ownerZoneFilter) : 'AllZones';

  const [ordDocs, colDocs] = await Promise.all([sfGet('orders'), sfGet('collections')]);
  const orders = ordDocs.map(d=>({id:d.id,...d.data()})).filter(o=>!o.date||o.date>=cutStr);
  const cols   = colDocs.map(d=>d.data()).filter(c=>!c.date||c.date>=cutStr);

  // Combine into one sheet: orders + collections tabs via two CSV downloads
  const ordRows = [['Type','ID','Outlet','Rep','Amount (RM)','Date','Status','Zone']];
  orders.forEach(o=> ordRows.push(['Order', o.id||'', outletName(o.outletId), userName(o.createdBy), (o.total||0).toFixed(2), o.date||'', o.status||'', o._zoneName||zoneLabel]));
  cols.forEach(c=> ordRows.push(['Collection', c.id||'', outletName(c.outletId), userName(c.createdBy), (c.amount||0).toFixed(2), c.date||'', c.mode||'', c._zoneName||zoneLabel]));

  _downloadCSV(ordRows, `STFM_Report_${activeRpt}_${zoneLabel}_${todayStr()}.csv`);
}

async function exportMonitoring() {
  showToast('Preparing monitoring export...', 'info');
  const zoneLabel = _ownerZoneFilter ? (allZones.find(z=>z.id===_ownerZoneFilter)?.name||_ownerZoneFilter) : 'AllZones';
  const today = todayStr();
  const visitDocs = await sfGet('visits');
  const visits = visitDocs.map(d=>({id:d.id,...d.data()})).filter(v=>v.date===today);
  const rows = [['Date','Rep','Outlet','Reason','Notes','Zone']];
  visits.forEach(v=>{
    rows.push([v.date||'', v.createdByName||'', v.outletName||outletName(v.outletId), v.reason||'', v.notes||'', v._zoneName||zoneLabel]);
  });
  _downloadCSV(rows, `STFM_NPVisits_Today_${zoneLabel}_${todayStr()}.csv`);
}

// ── Smart cache: skip Firestore if data is < TTL ms old ─────────────────────
let _cacheTs = 0;
const _CACHE_TTL = 8000; // 8 seconds — stale after writes that call invalidateCache()
function invalidateCache() { _cacheTs = 0; }

async function loadCachedData(force = false) {
  const now = Date.now();
  if (!force && _cacheTs && (now - _cacheTs) < _CACHE_TTL) return; // cache hit
  // Products ALWAYS from root global catalog — never zone subcollection
  // Other collections use zone-scoped reads via colR (respects _ownerZoneFilter)
  const [ouDocs, prDocs, rtDocs, znDocs, uSnap, _ovMap2] = await Promise.all([
    sfGet('outlets'),
    window.__SF.getDocs(rootCol('products')), // always root — zone overrides applied below
    sfGet('routes'),
    sfGet('zones'),
    _fetchUsers(),                          // zone-filtered for non-owners
    _loadZoneProductOverrides(),              // loads for active zone (owner filter or CU.zoneId)
  ]);
  allZones   = znDocs.map(d=>({id:d.id,...d.data()}));
  allOutlets = ouDocs.map(d=>({id:d.id,...d.data()}));
  allUsers   = isOwner()
    ? uSnap.docs.map(d=>({...d.data()}))
    : uSnap.docs.map(d=>({...d.data()})).filter(u=>u.isOwner||u.zoneId===CU.zoneId||u.uid===CU.uid);
  allProducts = _applyProductOverrides(prDocs.docs, _ovMap2);
  allRoutes  = rtDocs.map(d=>({id:d.id,...d.data()}));
  _cacheTs = Date.now();
}

function initDateDefaults() {
  const t=todayStr();
  const m=t.slice(0,7);
  ['attMonth','attMonthRep'].forEach(id=>{const el=document.getElementById(id);if(el)el.value=m;});
  ['cDate','ordDate'].forEach(id=>{const el=document.getElementById(id);if(el)el.value=t;});
  const f=new Date();f.setDate(f.getDate()-30);
  const fd=document.getElementById('colFrom');const tdEl=document.getElementById('colTo');
  if(fd)fd.value=f.toISOString().split('T')[0];
  if(tdEl)tdEl.value=t;
}

// ═══════════════ CLOCK ═══════════════
let clockIv;
function startClock() {
  clearInterval(clockIv);
  clockIv = setInterval(()=>{
    const now=new Date();
    const ts=now.toLocaleTimeString('en-US',{hour12:false});
    document.getElementById('liveClock').textContent=ts;
    const ae=document.getElementById('attClk');
    if(ae)ae.textContent=ts;
    const ad=document.getElementById('attDateStr');
    if(ad)ad.textContent=now.toLocaleDateString('en-US',{weekday:'long',year:'numeric',month:'long',day:'numeric'});
    updateLiveHours();
  },1000);
}

// ═══════════════ PAGE NAV ═══════════════
const PAGE_META={
  dashboard:{title:'Dashboard',sub:'Overview of your sales performance'},
  attendance:{title:'Attendance',sub:'Daily check-in / check-out with selfie'},
  orders:{title:'Orders',sub:'Manage customer orders'},
  outlets:{title:'Outlets',sub:'Manage customer outlets'},
  routes:{title:'Routes',sub:'Manage delivery routes — outlets must belong to a route'},
  collection:{title:'Collection',sub:'Track payment collections'},
  reports:{title:'Reports',sub:'Analytics & business insights'},
  users:{title:'Users',sub:'Manage sales representatives & admins'},
  products:{title:'Products',sub:'Manage product catalogue, stock & pricing'},
  delivery:{title:'My Deliveries',sub:'Orders assigned to you for delivery'},
  deliveries:{title:'Delivery Management',sub:'Assign and track all deliveries'},
  monitoring:{title:'Rep Monitoring',sub:'Track rep activity, NP visits, orders & attendance'},
  zones:{title:'Zone Management',sub:'Manage zones — scope data access by region or territory'},
  outletstructure:{title:'Outlet Structure',sub:'Sales rep → route → outlets hierarchy'},
};
function goPage(pg) {
  if((pg==='users'||pg==='products')&&!isAdmin()){showToast('Access denied','error');return;}
  if(pg==='deliveries'&&!isAdmin()){showToast('Access denied','error');return;}
  if(pg==='delivery'&&CU.role!=='delivery_man'&&!isAdmin()){showToast('Access denied','error');return;}
  // Zone guard: non-owner without zone can only access zones page + dashboard
  if(!isOwner()&&!CU.zoneId&&pg!=='dashboard'&&pg!=='zones'){
    showToast('You have no zone assigned. Contact the Owner.','error');return;
  }
  // ★ Persist last page across accidental exits
  try{sessionStorage.setItem('stfm_lastPage',pg);}catch(e){}
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.nitem').forEach(n=>n.classList.remove('active'));
  const pel=document.getElementById('page'+pg.charAt(0).toUpperCase()+pg.slice(1));
  if(pel)pel.classList.add('active');
  const nitems=[...document.querySelectorAll('.nitem')];
  const ni=nitems.find(n=>{const t=n.textContent.toLowerCase().trim();return t.startsWith(pg.slice(0,4));});
  if(ni)ni.classList.add('active');
  document.getElementById('tbTitle').textContent=PAGE_META[pg]?.title||pg;
  document.getElementById('tbSub').textContent=PAGE_META[pg]?.sub||'';
  if(pg==='dashboard')renderDashboard();
  if(pg==='attendance'){checkTodayAttendance();loadAttHistory();}
  if(pg==='orders')loadOrders();
  if(pg==='outlets')loadOutlets();
  if(pg==='routes')loadRoutes();
  if(pg==='collection')loadCollections();
  if(pg==='reports')renderReports();
  if(pg==='users')loadUsers();
  if(pg==='products')loadProducts();
  if(pg==='delivery')loadMyDeliveries();
  if(pg==='deliveries')loadDeliveries();
  if(pg==='monitoring')loadMonitoring();
  if(pg==='outletstructure')loadOutletStructure();
  if(pg==='zones')loadZones();
  // Update zone bar visibility for owner
  _updateOwnerZoneBar(pg);
  // close mobile sidebar
  closeSidebar();
}

function openM(id){document.getElementById(id).classList.add('show');}
function closeM(id){document.getElementById(id).classList.remove('show');}

function openSidebar(){
  document.getElementById('sidebar').classList.add('open');
  document.getElementById('sidebarBackdrop').classList.add('show');
  document.body.style.overflow='hidden';
}
function closeSidebar(){
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebarBackdrop').classList.remove('show');
  document.body.style.overflow='';
}

// ═══════════════ DASHBOARD ═══════════════
function statC(ico,lbl,val,chg,color,onclick='') {
  return`<div class="scard" ${onclick?`onclick="${onclick}" style="cursor:pointer"`:''} title="${onclick?'Click to view details':''}">
    <div class="sc-bg" style="background:${color}"></div>
    <div class="sc-ico">${ico}</div>
    <div class="sc-lbl">${lbl}</div>
    <div class="sc-val">${val}</div>
    <div class="sc-chg neu">${chg}</div>
  </div>`;
}

// ★ FIX: Internal function accepting pre-loaded docs — used by bootApp to avoid double-fetching
function _renderDashboard(ordDocs, colDocs, attDocs) {
  if(!CU) return;
  const t=todayStr();
  const m=t.slice(0,7);

  const myOrders=ordDocs.map(d=>({id:d.id,...d.data()}))
    .filter(o=>isAdmin()||o.createdBy===CU.uid);
  const myCols=colDocs.map(d=>d.data())
    .filter(c=>isAdmin()||c.createdBy===CU.uid);

  const totalSales=myOrders.filter(o=>o.status!=='Cancelled').reduce((s,o)=>s+(o.total||0),0);
  const todaySales=myOrders.filter(o=>o.date===t&&o.status!=='Cancelled').reduce((s,o)=>s+(o.total||0),0);
  const pendingCount=myOrders.filter(o=>o.status==='Pending').length;
  const totalCollected=myCols.reduce((s,c)=>s+(c.amount||0),0);

  const myAttDocs=isAdmin()?attDocs:attDocs.filter(d=>d.data().userId===CU.uid);
  const todayAtt=myAttDocs.map(d=>d.data()).find(a=>a.date===t&&a.userId===CU.uid);
  const daysPresent=myAttDocs.filter(d=>d.data().month===m&&(isAdmin()?true:d.data().userId===CU.uid)).length;

  const ds=document.getElementById('dashStats');
  if(ds) ds.innerHTML=
    statC('💵','Today Sales',fmt(todaySales),'Today\'s orders','#22c55e',"goPage('orders')")+
    statC('📦','Total Sales',fmt(totalSales),'Active orders','#3b82f6',"goPage('orders')")+
    statC('💰','Collected',fmt(totalCollected),'All payments','#22c55e',"goPage('collection')")+
    statC('⏳','Pending',pendingCount,'Awaiting approval','#f59e0b',"goPage('orders')");

  const days=['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
  const vals=days.map((_,i)=>{const d=new Date();d.setDate(d.getDate()-6+i);const ds2=d.toISOString().split('T')[0];return myOrders.filter(o=>o.date===ds2&&o.status!=='Cancelled').reduce((s,o)=>s+(o.total||0),0);});
  const maxV=Math.max(...vals,1);
  document.getElementById('wkChart').innerHTML=vals.map((v,i)=>`<div class="bcol-w ${i===6?'bactive':''}"><div class="bcol" data-v="${fmt(v)}" style="height:${Math.max(5,(v/maxV)*100)}px"></div><div class="blbl">${days[i]}</div></div>`).join('');

  const pct=Math.min(100,Math.round(totalSales/Math.max(MONTHLY_TARGET_DYNAMIC,1)*100));
  const offset=289-(pct/100)*289;
  const rd=document.getElementById('ringDash');if(rd)rd.setAttribute('stroke-dashoffset',offset);
  const rp=document.getElementById('ringPct');if(rp)rp.textContent=pct+'%';
  const rt=document.getElementById('rTarget');if(rt)rt.textContent=fmt(MONTHLY_TARGET_DYNAMIC);
  const ra=document.getElementById('rAchieved');if(ra)ra.textContent=fmt(totalSales);

  const da=document.getElementById('dashActivity');
  if(da){
    const attHtml=todayAtt?
      `<div style="background:rgba(34,197,94,.07);border:1px solid rgba(34,197,94,.2);border-radius:var(--r2);padding:12px;margin-bottom:10px;cursor:pointer" onclick="goPage('attendance')">
        <div style="font-size:12px;font-weight:700;color:var(--grn);margin-bottom:4px">✅ Checked In Today</div>
        <div style="font-size:11px;color:var(--tx2)">In: ${todayAtt.checkInTime||'—'} · Out: ${todayAtt.checkOutTime||'Still working'}</div>
      </div>`:
      `<div style="background:rgba(245,158,11,.07);border:1px solid rgba(245,158,11,.2);border-radius:var(--r2);padding:12px;margin-bottom:10px;cursor:pointer" onclick="goPage('attendance')">
        <div style="font-size:12px;font-weight:700;color:var(--ylw);margin-bottom:4px">⏰ Not Checked In Yet</div>
        <div style="font-size:11px;color:var(--tx2)">Remember to check in today!</div>
      </div>`;
    const recentOrders=myOrders.slice(-4).reverse().map(o=>`
      <div style="display:flex;align-items:center;gap:12px;padding:8px 0;border-bottom:1px solid rgba(30,45,69,.4);cursor:pointer" onclick="goPage('orders')">
        <div style="width:7px;height:7px;border-radius:50%;background:${o.status==='Delivered'?'var(--grn)':o.status==='Confirmed'?'var(--blu)':o.status==='Pending'?'var(--ylw)':'var(--red)'};flex-shrink:0"></div>
        <div style="flex:1;font-size:12px;color:var(--tx2)">${o.id} · ${outletName(o.outletId)}</div>
        <div style="font-size:11px;font-weight:700;color:var(--acc)">${fmt(o.total||0)}</div>
      </div>`).join('');
    da.innerHTML=attHtml+(recentOrders||'<div style="color:var(--tx3);font-size:12px">No recent orders</div>');
  }

  const dto=document.getElementById('dashTopOutlets');
  const myOutletSales=allOutlets.map(o=>({...o,s:myOrders.filter(x=>x.outletId===o.id&&x.status!=='Cancelled').reduce((t,x)=>t+(x.total||0),0)})).filter(o=>o.s>0).sort((a,b)=>b.s-a.s).slice(0,4);
  if(dto)dto.innerHTML=myOutletSales.map(o=>`<div style="margin-bottom:11px;cursor:pointer" onclick="goPage('outlets')">
    <div style="display:flex;justify-content:space-between;margin-bottom:4px"><span style="font-size:12px;font-weight:600">${o.name}</span><span style="font-family:'Syne',sans-serif;font-size:12px;font-weight:700;color:var(--acc)">${fmt(o.s)}</span></div>
    <div class="pgbar"><div class="pgfill" style="width:${myOutletSales[0].s?Math.round(o.s/myOutletSales[0].s*100):0}%"></div></div>
  </div>`).join('')||'<div style="color:var(--tx3);font-size:12px">No outlet sales yet</div>';

  const pas=document.getElementById('pendingApprovalsSection');
  if(pas)pas.style.display='none';

  // ★ Owner cross-zone summary panel
  _renderOwnerZoneSummary();
}

// ── Owner-only: cross-zone summary ──
async function _renderOwnerZoneSummary() {
  const panel = document.getElementById('ownerZoneSummary');
  if(!panel) return;
  if(!isOwner()) { panel.style.display='none'; return; }
  if(!allZones.length) { panel.style.display='none'; return; }
  panel.style.display='';
  panel.innerHTML=`<div style="font-family:'Syne',sans-serif;font-size:14px;font-weight:700;margin-bottom:12px;color:var(--tx)">👑 All Zones Overview</div>
    <div style="font-size:12px;color:var(--tx3);margin-bottom:10px">Loading zone data...</div>`;

  try {
    const rows = await Promise.all(allZones.map(async z=>{
      const [ordSnap,colSnap,ouSnap] = await Promise.all([
        window.__SF.getDocs(zoneColRef(z.id,'orders')),
        window.__SF.getDocs(zoneColRef(z.id,'collections')),
        window.__SF.getDocs(zoneColRef(z.id,'outlets')),
      ]);
      const orders=ordSnap.docs.map(d=>d.data());
      const cols=colSnap.docs.map(d=>d.data());
      const sales=orders.filter(o=>o.status!=='Cancelled').reduce((s,o)=>s+(o.total||0),0);
      const collected=cols.reduce((s,c)=>s+(c.amount||0),0);
      const pending=orders.filter(o=>o.status==='Pending').length;
      const outlets=ouSnap.docs.length;
      return {z,sales,collected,pending,outlets};
    }));

    const totalSales=rows.reduce((s,r)=>s+r.sales,0);
    const totalCol=rows.reduce((s,r)=>s+r.collected,0);
    const totalPend=rows.reduce((s,r)=>s+r.pending,0);

    panel.innerHTML=`
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;flex-wrap:wrap;gap:8px">
        <div style="font-family:'Syne',sans-serif;font-size:14px;font-weight:700;color:var(--tx)">👑 All Zones Overview</div>
        <div style="display:flex;gap:10px;flex-wrap:wrap">
          <span style="font-size:11px;color:var(--tx3)">Total Sales: <strong style="color:var(--acc)">${fmt(totalSales)}</strong></span>
          <span style="font-size:11px;color:var(--tx3)">Collected: <strong style="color:var(--grn)">${fmt(totalCol)}</strong></span>
          <span style="font-size:11px;color:var(--tx3)">Pending: <strong style="color:var(--ylw)">${totalPend}</strong></span>
        </div>
      </div>
      <div style="display:flex;flex-direction:column;gap:8px">
        ${rows.map(r=>`
          <div style="background:var(--s2);border:1px solid var(--bdr);border-radius:var(--r2);padding:11px 14px;display:flex;align-items:center;gap:12px;flex-wrap:wrap">
            <div style="flex:1;min-width:130px">
              <div style="font-size:13px;font-weight:700">${r.z.name}</div>
              <div style="font-size:10px;color:var(--tx3)">${r.outlets} outlet${r.outlets!==1?'s':''}</div>
            </div>
            <div style="display:flex;gap:14px;flex-wrap:wrap">
              <div style="text-align:center"><div style="font-family:'Syne',sans-serif;font-size:14px;font-weight:800;color:var(--acc)">${fmt(r.sales)}</div><div style="font-size:9px;color:var(--tx3)">Sales</div></div>
              <div style="text-align:center"><div style="font-family:'Syne',sans-serif;font-size:14px;font-weight:800;color:var(--grn)">${fmt(r.collected)}</div><div style="font-size:9px;color:var(--tx3)">Collected</div></div>
              <div style="text-align:center"><div style="font-family:'Syne',sans-serif;font-size:14px;font-weight:800;color:var(--ylw)">${r.pending}</div><div style="font-size:9px;color:var(--tx3)">Pending</div></div>
            </div>
          </div>`).join('')}
      </div>`;
  } catch(e) {
    panel.innerHTML=`<div style="font-size:12px;color:var(--red)">⚠️ Failed to load zone summary: ${e.message}</div>`;
  }
}

// Public wrapper — fetches fresh data on demand (page navigation)
let _dashOrdDocs=null,_dashColDocs=null,_dashAttDocs=null,_dashTs=0;
const _DASH_TTL=12000;
function invalidateDashCache(){_dashTs=0;}

async function renderDashboard() {
  if(!CU) return;
  const now=Date.now();
  if(!_dashTs||(now-_dashTs)>_DASH_TTL){
    [_dashOrdDocs,_dashColDocs,_dashAttDocs]=await Promise.all([
      sfGet('orders'),sfGet('collections'),sfGet('attendance')
    ]);
    _dashTs=Date.now();
  }
  _renderDashboard(_dashOrdDocs,_dashColDocs,_dashAttDocs);
}

// ═══════════════ ATTENDANCE ═══════════════
let checkinTime=null;

function _checkTodayAttendance(allAttDocs) {
  const t=todayStr();
  const m=t.slice(0,7);
  const allMyAtt=allAttDocs.filter(d=>d.data().userId===CU.uid);
  const todayRecs=allMyAtt.filter(d=>d.data().date===t);
  const monthRecs=allMyAtt.filter(d=>d.data().month===m);
  const el=document.getElementById('attPill');
  const cin=document.getElementById('btnCheckIn');
  const cout=document.getElementById('btnCheckOut');

  // Admins don't need to check in — hide the controls and show a badge
  if(isAdmin()){
    if(el){el.textContent='● Admin';el.style.cssText='background:rgba(168,85,247,.1);border:1px solid rgba(168,85,247,.25);color:var(--pur);padding:6px 12px;border-radius:8px;font-size:11px;font-weight:700';}
    if(cin)cin.style.display='none';
    if(cout)cout.style.display='none';
    const aDays=document.getElementById('aDays');
    if(aDays)aDays.textContent='—';
    const adminAV=document.getElementById('adminAttView');
    if(adminAV)adminAV.style.display='';
    const uf=document.getElementById('attUserFilter');
    if(uf)uf.innerHTML='<option value="">All Representatives</option>'+allUsers.map(u=>`<option value="${u.uid}">${u.name}</option>`).join('');
    return;
  }

  if(!todayRecs.length){
    el.textContent='● Offline';el.style.cssText='background:var(--s2);border:1px solid var(--bdr);color:var(--tx3);padding:6px 12px;border-radius:8px;font-size:11px;font-weight:700';
    if(cin)cin.style.display='inline-flex';
    if(cout)cout.style.display='none';
    checkinTime=null;
  } else {
    const rec=todayRecs[0].data();
    if(rec.checkInTime){document.getElementById('aIn').textContent=rec.checkInTime;}
    if(rec.checkOutTime){
      document.getElementById('aOut').textContent=rec.checkOutTime;
      el.textContent='● Completed';el.style.cssText='background:rgba(59,130,246,.1);border:1px solid rgba(59,130,246,.25);color:#3b82f6;padding:6px 12px;border-radius:8px;font-size:11px;font-weight:700';
      if(cin)cin.style.display='none';
      if(cout)cout.style.display='none';
      checkinTime=null;
      calcAndShowHours(rec.checkInTime,rec.checkOutTime);
    } else {
      el.textContent='● Checked In';el.style.cssText='background:rgba(34,197,94,.1);border:1px solid rgba(34,197,94,.25);color:#22c55e;padding:6px 12px;border-radius:8px;font-size:11px;font-weight:700';
      if(cin)cin.style.display='none';
      if(cout)cout.style.display='inline-flex';
      checkinTime=rec.checkInTime;
    }
  }
  const aDays=document.getElementById('aDays');
  if(aDays)aDays.textContent=monthRecs.length;
  if(isAdmin()||CU.role==='sub_admin'){
    const adminAV=document.getElementById('adminAttView');
    if(adminAV)adminAV.style.display='';
    const uf=document.getElementById('attUserFilter');
    if(uf)uf.innerHTML='<option value="">All Representatives</option>'+allUsers.map(u=>`<option value="${u.uid}">${u.name}</option>`).join('');
  }
}

// Public wrapper — fetches fresh data (used by page navigation)
async function checkTodayAttendance() {
  const {where}=window.__SF;
  const allAttDocs=await sfGet('attendance',[where('userId','==',CU.uid)]);
  _checkTodayAttendance(allAttDocs);
}

function startCheckIn() {
  // Only allow check-in on the current real date
  if(new Date().toISOString().split('T')[0] !== todayStr()) {
    showToast('Check-in is only allowed on the current date','error');return;
  }
  selfieMode='checkin'; openSelfieModal('Check In Selfie','Look at the camera clearly');
}
function startCheckOut() {
  // Only allow check-out on the current real date
  if(new Date().toISOString().split('T')[0] !== todayStr()) {
    showToast('Check-out is only allowed on the current date','error');return;
  }
  selfieMode='checkout'; openSelfieModal('Check Out Selfie','Look at the camera clearly');
}

function openSelfieModal(title,inst) {
  document.getElementById('mSelfieTitle').textContent='📷 '+title;
  document.getElementById('mSelfieInst').textContent=inst;
  document.getElementById('mSelfiePreview').style.display='none';
  document.getElementById('mCamVideo').style.display='block';
  document.getElementById('mSelfieCapBtn').style.display='inline-flex';
  document.getElementById('mSelfieConfBtn').style.display='none';
  selfieData=null;
  const now=new Date();
  document.getElementById('mSelfieTs').textContent=now.toLocaleString('en-GB');
  selfieTimestamp=now;
  openM('mSelfie');
  startCamera();
}

async function startCamera() {
  stopCamera();
  try {
    const stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:'user',width:320,height:240},audio:false});
    camStream=stream;
    const vid=document.getElementById('mCamVideo');
    vid.srcObject=stream;
    await vid.play();
  } catch(e) {
    showToast('Camera access denied. Enable camera permission.','error');
    closeM('mSelfie');
  }
}

function stopCamera() {
  if(camStream){camStream.getTracks().forEach(t=>t.stop());camStream=null;}
}

function captureSelfie() {
  const vid=document.getElementById('mCamVideo');
  const cvs=document.getElementById('mCamCanvas');
  cvs.width=240;cvs.height=180;
  const ctx=cvs.getContext('2d');
  ctx.drawImage(vid,0,0,240,180);
  ctx.fillStyle='rgba(0,0,0,0.55)';
  ctx.fillRect(0,cvs.height-28,cvs.width,28);
  ctx.fillStyle='#ffffff';
  ctx.font='bold 11px monospace';
  ctx.fillText(selfieTimestamp.toLocaleString('en-GB'),8,cvs.height-10);
  selfieData=cvs.toDataURL('image/jpeg',0.55);
  document.getElementById('mSelfieImg').src=selfieData;
  document.getElementById('mSelfiePreview').style.display='block';
  document.getElementById('mCamVideo').style.display='none';
  document.getElementById('mSelfieCapBtn').style.display='none';
  document.getElementById('mSelfieConfBtn').style.display='inline-flex';
}

function retakeSelfie() {
  selfieData=null;
  document.getElementById('mSelfiePreview').style.display='none';
  document.getElementById('mCamVideo').style.display='block';
  document.getElementById('mSelfieCapBtn').style.display='inline-flex';
  document.getElementById('mSelfieConfBtn').style.display='none';
  selfieTimestamp=new Date();
  document.getElementById('mSelfieTs').textContent=selfieTimestamp.toLocaleString('en-GB');
  startCamera();
}

async function confirmSelfie() {
  if(!selfieData){showToast('Capture selfie first','warn');return;}
  stopCamera();closeM('mSelfie');
  if(selfieMode==='checkin') await doCheckIn();
  else if(selfieMode==='checkout') await doCheckOut();
}

function cancelSelfie() { stopCamera(); closeM('mSelfie'); }

async function doCheckIn() {
  const t=todayStr();
  // Hard guard: timestamp must match today's date (prevents backdating if date changes mid-session)
  const realToday=new Date().toISOString().split('T')[0];
  if(realToday!==t){showToast('Check-in not allowed — date mismatch. Please refresh the app.','error');return;}
  const {where:wh5}=window.__SF;
  const allAttDocs=await sfGet('attendance',[wh5('userId','==',CU.uid)]);
  if(allAttDocs.some(d=>d.data().date===t)){showToast('Already checked in today','warn');return;}
  const now=new Date();
  const timeStr=now.toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',hour12:false});
  const m=t.slice(0,7);
  await sfAdd('attendance',{
    userId:CU.uid,userName:CU.name,date:t,month:m,
    checkInTime:timeStr,checkInPhoto:selfieData,
    checkInTimestamp:selfieTimestamp.toISOString(),
    checkOutTime:'',checkOutPhoto:'',checkOutTimestamp:'',
    status:'Present',createdAt:window.__SF.serverTimestamp()
  });
  checkinTime=timeStr;
  document.getElementById('aIn').textContent=timeStr;
  document.getElementById('btnCheckIn').style.display='none';
  document.getElementById('btnCheckOut').style.display='inline-flex';
  document.getElementById('attPill').textContent='● Checked In';
  document.getElementById('attPill').style.cssText='background:rgba(34,197,94,.1);border:1px solid rgba(34,197,94,.25);color:#22c55e;padding:6px 12px;border-radius:8px;font-size:11px;font-weight:700';
  showToast(`Checked in at ${timeStr} ✅`,'success');
  loadAttHistory();
  // 🔔 Notify admins
  notifyAdmins('⏰ Check-In',`${CU.name} checked in at ${timeStr}`,{tag:'attendance-checkin'});
}

async function doCheckOut() {
  const t=todayStr();
  const realToday=new Date().toISOString().split('T')[0];
  if(realToday!==t){showToast('Check-out not allowed — date mismatch. Please refresh the app.','error');return;}
  const {where:wh6}=window.__SF;
  const allCoDocs=await sfGet('attendance',[wh6('userId','==',CU.uid)]);
  const todayDocs=allCoDocs.filter(d=>d.data().date===t);
  if(!todayDocs.length){showToast('No check-in found','error');return;}
  const docId=todayDocs[0].id;
  const inTime=todayDocs[0].data().checkInTime;
  const now=new Date();
  const timeStr=now.toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',hour12:false});
  await sfUpdate('attendance',docId,{
    checkOutTime:timeStr,checkOutPhoto:selfieData,checkOutTimestamp:now.toISOString()
  });
  document.getElementById('aOut').textContent=timeStr;
  document.getElementById('btnCheckOut').style.display='none';
  document.getElementById('attPill').textContent='● Completed';
  document.getElementById('attPill').style.cssText='background:rgba(59,130,246,.1);border:1px solid rgba(59,130,246,.25);color:#3b82f6;padding:6px 12px;border-radius:8px;font-size:11px;font-weight:700';
  calcAndShowHours(inTime,timeStr);
  checkinTime=null;
  showToast(`Checked out at ${timeStr} — Great work!`,'success');
  loadAttHistory();
  // 🔔 Notify admins
  notifyAdmins('⏰ Check-Out',`${CU.name} checked out at ${timeStr}`,{tag:'attendance-checkout'});
}

function updateLiveHours() {
  if(!checkinTime||!document.getElementById('aHrs'))return;
  const [ch,cm]=checkinTime.split(':').map(Number);
  const now=new Date();
  const mins=(now.getHours()*60+now.getMinutes())-(ch*60+cm);
  if(mins>0)document.getElementById('aHrs').textContent=`${Math.floor(mins/60)}h ${mins%60}m`;
}

function calcAndShowHours(ci,co) {
  const [ch,cm]=ci.split(':').map(Number);
  const [oh,om]=co.split(':').map(Number);
  const m=(oh*60+om)-(ch*60+cm);
  if(m>0&&document.getElementById('aHrs'))document.getElementById('aHrs').textContent=`${Math.floor(m/60)}h ${m%60}m`;
}

async function loadAttHistory() {
  const periodEl = document.getElementById('attPeriod');
  const periodVal = periodEl?.value || 'today';
  const monthEl = document.getElementById('attMonth');
  const today = todayStr();
  // Show/hide custom month picker
  if (monthEl) monthEl.style.display = periodVal === 'custom' ? '' : 'none';
  // Compute date filter
  let filterFn;
  if (periodVal === 'today') {
    filterFn = d => d.date === today;
  } else if (periodVal === 'week') {
    const weekAgo = new Date(); weekAgo.setDate(weekAgo.getDate() - 6);
    const weekStr = weekAgo.toISOString().split('T')[0];
    filterFn = d => d.date >= weekStr && d.date <= today;
  } else if (periodVal === 'month') {
    const month = today.slice(0, 7);
    filterFn = d => (d.month === month || (d.date && d.date.startsWith(month)));
  } else {
    // custom
    const month = monthEl?.value || today.slice(0, 7);
    filterFn = d => (d.month === month || (d.date && d.date.startsWith(month)));
  }
  const repFilter = document.getElementById('attUserFilter')?.value;
  const {where:wh4} = window.__SF;
  const attDocs = isAdmin() && repFilter ? await sfGet('attendance', [wh4('userId','==',repFilter)])
    : isAdmin() ? await sfGet('attendance')
    : await sfGet('attendance', [wh4('userId','==',CU.uid)]);
  const recs = attDocs.map(d=>({id:d.id,...d.data()})).filter(filterFn).sort((a,b)=>b.date.localeCompare(a.date));
  const tbody = document.getElementById('attTbody');
  const photoThumb = src => src ? `<img src="${src}" class="att-hist-photo" onclick="viewPhoto('${src}')" style="cursor:pointer" title="Click to enlarge">` : '—';
  const emptyMsg = periodVal === 'today' ? 'No attendance records for today' : 'No records in this period';
  tbody.innerHTML = recs.map(r => `<tr>
    <td style="font-size:12px">${r.date}</td>
    <td style="font-size:12px;font-weight:600">${r.userName||'—'}</td>
    <td>${r.checkInTime||'—'}</td>
    <td>${photoThumb(r.checkInPhoto)}</td>
    <td>${r.checkOutTime||'—'}</td>
    <td>${photoThumb(r.checkOutPhoto)}</td>
    <td style="font-size:12px">${r.checkInTime&&r.checkOutTime?calcH(r.checkInTime,r.checkOutTime):'—'}</td>
    <td><span class="bdg bdg-grn">Present</span></td>
    ${isStrictAdmin()?`<td><button class="btn btn-red btn-xs" onclick="deleteAttendanceRecord('${r.id}','${r.userName||r.date}')" title="Delete record">🗑</button></td>`:'<td></td>'}
  </tr>`).join('') || `<tr><td colspan="${isStrictAdmin()?9:8}" style="text-align:center;padding:24px;color:var(--tx3)">${emptyMsg}</td></tr>`;
}

function viewPhoto(src) {
  const w=window.open('','_blank');
  w.document.write(`<body style="margin:0;background:#000;display:flex;align-items:center;justify-content:center;min-height:100vh">
    <img src="${src}" style="max-width:100%;max-height:100vh;border-radius:8px"></body>`);
}

function calcH(ci,co){const[ch,cm]=ci.split(':').map(Number);const[oh,om]=co.split(':').map(Number);const m=(oh*60+om)-(ch*60+cm);return`${Math.floor(m/60)}h ${m%60}m`;}
function calcMins(ci,co){const[ch,cm]=ci.split(':').map(Number);const[oh,om]=co.split(':').map(Number);return(oh*60+om)-(ch*60+cm);}

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
    const choice=await _customConfirm(`Pending discount request:\n${discLabel}\n\nApprove to apply the discount, or Reject to keep the full price.`, {title:'Discount Request',okText:'Approve ✅',cancelText:'Reject ❌',danger:false,icon:'💰'});
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
    if(!await _customConfirm(`Cancel ${label}?`, {title:'Cancel Order',okText:'Yes, Cancel',cancelText:'Keep',danger:true,icon:'🚫'}))return;
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

// ═══════════════ OUTLETS — ACCORDION TREE ═══════════════
// State: which rep-node and route-node are open
const _outletOpen={rep:null, route:null};

async function loadOutlets() {
  await loadCachedData();
  const addBtn=document.getElementById('addOutletBtn');
  if(addBtn)addBtn.style.display=isDeliveryMan()?'none':'';
  const srch=(document.getElementById('outSrch')?.value||'').toLowerCase();

  // Pending balances (admin)
  if(isAdmin()){
    const pending=allOutlets.filter(o=>o.balanceStatus==='pending'&&o.openingBalance>0);
    document.getElementById('pendingBalancesSection').style.display=pending.length?'':'none';
    document.getElementById('pendingBalancesList').innerHTML=pending.map(o=>`
      <div class="apv-card">
        <div class="apv-info">
          <div class="apv-title">${o.name} <span class="bdg bdg-ylw" style="margin-left:6px">Pending Balance</span></div>
          <div class="apv-sub">Opening Balance: ${fmt(o.openingBalance)} · Type: ${o.type} · Area: ${o.area||'—'}</div>
        </div>
        <div class="apv-actions">
          <button class="btn btn-grn btn-xs" onclick="approveBalance('${o.id}')">✓ Approve</button>
          <button class="btn btn-red btn-xs" onclick="rejectBalance('${o.id}')">✕ Reject</button>
        </div>
      </div>`).join('');
    const outletApvBadge=document.getElementById('outletApvBadge');
    if(outletApvBadge){outletApvBadge.textContent=pending.length;outletApvBadge.style.display=pending.length?'':'none';}
  }

  // Load order/collection stats lazily
  const [ordDocs2,colDocs2]=await Promise.all([sfGet('orders'),sfGet('collections')]);
  const orders=ordDocs2.map(d=>d.data());
  const cols=colDocs2.map(d=>d.data());

  const tree=document.getElementById('outletTree');
  if(!tree)return;

  // ★ Distance-sort outlets if GPS available
  function distKm(o){
    if(!_gpsGranted||!_userLat||!_userLng||!o.lat||!o.lng)return Infinity;
    return haversineKm(_userLat,_userLng,Number(o.lat),Number(o.lng));
  }
  function fmtDist(km){
    if(km===Infinity)return '';
    if(km<1)return `${Math.round(km*1000)}m`;
    return `${km.toFixed(1)}km`;
  }

  // Outlet card builder (shared by all views)
  // Compact grid tile — lives inside .tree-body2 (grid layout)
  function buildOutletCard(o,i){
    const oOrders=orders.filter(x=>x.outletId===o.id&&x.status!=='Cancelled').reduce((s,x)=>s+x.total,0);
    const oCol=cols.filter(x=>x.outletId===o.id).reduce((s,x)=>s+x.amount,0);
    const due=Math.max(0,oOrders-oCol+(o.balanceStatus==='approved'?o.openingBalance:0));
    const hasPhone=!!o.phone;
    const hasPinned=!!(o.lat&&o.lng);
    const clr=o.color||COLORS[i%COLORS.length];
    const km=distKm(o);
    const distBadge=km!==Infinity?`<span style="font-size:9px;color:var(--blu);font-weight:600">📍${fmtDist(km)}</span>`:'';
    return`<div class="oc-grid" onclick="viewOutlet('${o.id}')">
      <div class="oc-grid-top">
        <div class="oc-grid-ava" style="background:${clr}">${o.name[0]}</div>
        <div style="flex:1;min-width:0"><div class="oc-grid-name">${o.name}</div>${distBadge}</div>
      </div>
      <div class="oc-grid-sub">${o.type}${o.area?' · '+o.area:''}</div>
      <div class="oc-grid-sub" style="color:${due>0?'var(--red)':'var(--tx3)'}">Due: <strong>${fmt(due)}</strong></div>
      <div class="oc-grid-btns" onclick="event.stopPropagation()">
        <button class="btn btn-primary btn-xs" onclick="openNewOrder('${o.id}')" title="Order">📦</button>
        <button class="btn btn-ylw btn-xs" onclick="openNPVisit('${o.id}')" title="NP Visit">📝</button>
        ${hasPhone?`<button class="btn btn-grn btn-xs" onclick="openWhatsApp('${o.id}')" title="WhatsApp">💬</button>`:''}
        ${hasPinned?`<button class="btn btn-blu btn-xs" onclick="openDirections('${o.id}')" title="Directions">🗺️</button>`:''}
        <button class="btn btn-ghost btn-xs" onclick="editOutlet('${o.id}')" title="Edit">✏️</button>
        ${isAdmin()?`<button class="btn btn-red btn-xs" onclick="delOutlet('${o.id}')" title="Delete">🗑</button>`:''}
      </div>
    </div>`;
  }

  // Sort helper: by distance (pinned outlets first, then by km)
  function sortByDist(arr){
    return [...arr].sort((a,b)=>{
      const da=distKm(a),db=distKm(b);
      return da-db;
    });
  }

  // Delivery man: flat list of their outlets sorted by distance
  if(isDeliveryMan()){
    const {where:wdm}=window.__SF;
    let allowedIds=new Set();
    try{const myO=await sfGet('orders',[wdm('deliveryManId','==',CU.uid)]);allowedIds=new Set(myO.map(d=>d.data().outletId));}catch(e){}
    const myOutlets=sortByDist(allOutlets.filter(o=>allowedIds.has(o.id)));
    tree.innerHTML=myOutlets.length
      ?`<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:8px">${myOutlets.map((o,i)=>buildOutletCard(o,i)).join('')}</div>`
      :'<div style="text-align:center;padding:30px;color:var(--tx3)">No outlets assigned to your deliveries</div>';
    return;
  }

  // For sales rep: route → outlets (2 levels)
  if(!isAdmin()){
    const myOutlets=allOutlets.filter(o=>o.createdBy===CU.uid||o.assignedRepId===CU.uid);
    const myRouteIds=[...new Set(myOutlets.map(o=>o.routeId).filter(Boolean))];
    const myRoutes=allRoutes.filter(r=>myRouteIds.includes(r.id)||r.repId===CU.uid);
    if(!myRoutes.length&&!myOutlets.length){
      tree.innerHTML='<div style="text-align:center;padding:30px;color:var(--tx3)">No outlets or routes assigned yet</div>';return;
    }
    // Build route folders
    const html=myRoutes.map((r,ri)=>{
      const routeOutlets=sortByDist(myOutlets.filter(o=>o.routeId===r.id).filter(o=>!srch||o.name.toLowerCase().includes(srch)||r.name.toLowerCase().includes(srch)));
      const isOpen=_outletOpen.route===r.id;
      return`<div class="tree-l2" id="otl2-${r.id}">
        <div class="tree-hdr2 ${isOpen?'open':''}" onclick="toggleOutletRoute('${r.id}')">
          <span class="tree-chevron">▶</span>
          <span style="font-size:16px">🗺️</span>
          <div style="flex:1">
            <div style="font-size:13px;font-weight:700">${r.name}</div>
            <div style="font-size:10px;color:var(--tx3)">${routeOutlets.length} outlet${routeOutlets.length!==1?'s':''}</div>
          </div>
          ${isAdmin()?`<button class="btn btn-ghost btn-xs" onclick="event.stopPropagation();editRoute('${r.id}')">✏️</button>`:''}
        </div>
        <div class="tree-body2 ${isOpen?'open':''}" id="otbody2-${r.id}">
          ${routeOutlets.length?routeOutlets.map((o,i)=>buildOutletCard(o,i)).join(''):'<div style="font-size:12px;color:var(--tx3);padding:6px">No outlets on this route</div>'}
        </div>
      </div>`;
    }).join('');
    // Unrouted outlets sorted by distance
    const unrouted=sortByDist(myOutlets.filter(o=>!o.routeId).filter(o=>!srch||o.name.toLowerCase().includes(srch)));
    tree.innerHTML=html+(unrouted.length?`<div class="tree-l2"><div class="tree-hdr2" onclick="toggleOutletRoute('__unrouted__')"><span class="tree-chevron">▶</span><span style="font-size:16px">⚠️</span><div style="flex:1"><div style="font-size:13px;font-weight:700">Unassigned to Route</div><div style="font-size:10px;color:var(--tx3)">${unrouted.length} outlet${unrouted.length!==1?'s':''}</div></div></div><div class="tree-body2" id="otbody2-__unrouted__">${unrouted.map((o,i)=>buildOutletCard(o,i)).join('')}</div></div>`:'');
    return;
  }

  // Admin: rep → route → outlets (3 levels)
  const reps=allUsers.filter(u=>u.role==='sales_rep');
  const allSrchOutlets=allOutlets.filter(o=>!srch||o.name.toLowerCase().includes(srch)||(o.route||'').toLowerCase().includes(srch));

  let html=reps.map((rep,ri)=>{
    const repOutlets=allSrchOutlets.filter(o=>o.createdBy===rep.uid||o.assignedRepId===rep.uid);
    if(srch&&!repOutlets.length&&!rep.name.toLowerCase().includes(srch))return'';
    const repRouteIds=[...new Set(repOutlets.map(o=>o.routeId).filter(Boolean))];
    const repRoutes=allRoutes.filter(r=>repRouteIds.includes(r.id)||r.repId===rep.uid);
    const isRepOpen=_outletOpen.rep===rep.uid;
    return`<div class="tree-node" id="otrep-${rep.uid}">
      <div class="tree-hdr ${isRepOpen?'open':''}" onclick="toggleOutletRep('${rep.uid}')">
        <span class="tree-chevron">▶</span>
        <div class="ava ava-sm" style="background:var(--blu);flex-shrink:0">${rep.name[0]}</div>
        <div style="flex:1">
          <div style="font-size:13px;font-weight:700">${rep.name}</div>
          <div style="font-size:10px;color:var(--tx3)">${repOutlets.length} outlet${repOutlets.length!==1?'s':''} · ${repRoutes.length} route${repRoutes.length!==1?'s':''}</div>
        </div>
        <span class="bdg bdg-blu" style="font-size:10px">${rep.phone||''}</span>
      </div>
      <div class="tree-body ${isRepOpen?'open':''}" id="otrepbody-${rep.uid}">
        ${repRoutes.map(r=>{
          const routeOutlets=sortByDist(repOutlets.filter(o=>o.routeId===r.id));
          const isOpen=_outletOpen.route===r.id;
          return`<div class="tree-l2" id="otl2-${r.id}">
            <div class="tree-hdr2 ${isOpen?'open':''}" onclick="toggleOutletRoute('${r.id}')">
              <span class="tree-chevron">▶</span>
              <span style="font-size:15px">🗺️</span>
              <div style="flex:1">
                <div style="font-size:12px;font-weight:700">${r.name}</div>
                <div style="font-size:10px;color:var(--tx3)">${routeOutlets.length} outlet${routeOutlets.length!==1?'s':''}</div>
              </div>
              <div onclick="event.stopPropagation();editRoute('${r.id}')" style="font-size:11px;cursor:pointer;color:var(--tx3);padding:4px 6px">✏️</div>
            </div>
            <div class="tree-body2 ${isOpen?'open':''}" id="otbody2-${r.id}">
              ${routeOutlets.length?routeOutlets.map((o,i)=>buildOutletCard(o,i)).join(''):'<div style="font-size:12px;color:var(--tx3);padding:6px">No outlets on this route</div>'}
            </div>
          </div>`;
        }).join('')}
        ${repOutlets.filter(o=>!o.routeId).length?`<div style="font-size:11px;color:var(--ylw);padding:6px">⚠️ ${repOutlets.filter(o=>!o.routeId).length} outlet(s) not assigned to a route</div>`:''}
        ${!repRoutes.length?'<div style="font-size:12px;color:var(--tx3);padding:6px">No routes assigned</div>':''}
      </div>
    </div>`;
  }).join('');

  // Truly unassigned outlets: no assignedRepId AND no createdBy
  // (Sales rep outlets are excluded — they auto-get assignedRepId on save)
  const orphans=allSrchOutlets.filter(o=>!o.assignedRepId&&!o.createdBy);
  if(orphans.length){
    const isOrphanOpen=_outletOpen.rep==='__orphan__';
    html+=`<div class="tree-node" id="otrep-__orphan__">
      <div class="tree-hdr ${isOrphanOpen?'open':''}" onclick="toggleOutletRep('__orphan__')">
        <span class="tree-chevron">▶</span><span style="font-size:16px">⚠️</span>
        <div style="flex:1">
          <div style="font-size:13px;font-weight:700;color:var(--ylw)">Unassigned Outlets (${orphans.length})</div>
          <div style="font-size:10px;color:var(--tx3)">No rep assigned — tap Assign to set one</div>
        </div>
        <span class="bdg bdg-ylw" style="font-size:10px">${orphans.length}</span>
      </div>
      <div class="tree-body ${isOrphanOpen?'open':''}" id="otrepbody-__orphan__">
        ${orphans.map(o=>`
          <div class="oc-mini" style="border-left:3px solid var(--ylw)">
            <div class="oc-mini-ava" style="background:${o.color||'var(--ylw)'}">${o.name[0]}</div>
            <div class="oc-mini-info" style="cursor:pointer" onclick="viewOutlet('${o.id}')">
              <div class="oc-mini-name">${o.name}</div>
              <div class="oc-mini-sub">${o.type||''}${o.area?' · '+o.area:''}${o.route?' · 🗺️ '+o.route:''}</div>
            </div>
            <div class="oc-mini-btns" onclick="event.stopPropagation()">
              <button class="btn btn-ylw btn-xs" onclick="adminAssignRep('${o.id}')">👤 Assign</button>
              <button class="btn btn-primary btn-xs" onclick="openNewOrder('${o.id}')">📦</button>
            </div>
          </div>`).join('')}
      </div>
    </div>`;
  }

  tree.innerHTML=html||'<div style="text-align:center;padding:30px;color:var(--tx3)">No outlets found</div>';
}

function toggleOutletRep(repUid){
  const wasOpen=_outletOpen.rep===repUid;
  // Close all reps
  document.querySelectorAll('[id^="otrep-"]').forEach(n=>{
    n.querySelector('.tree-hdr')?.classList.remove('open');
    n.querySelector('.tree-body')?.classList.remove('open');
  });
  _outletOpen.route=null;
  if(!wasOpen){
    _outletOpen.rep=repUid;
    const hdr=document.querySelector(`#otrep-${CSS.escape(repUid)} .tree-hdr`);
    const body=document.getElementById(`otrepbody-${repUid}`);
    if(hdr)hdr.classList.add('open');
    if(body)body.classList.add('open');
  } else {
    _outletOpen.rep=null;
  }
}

function toggleOutletRoute(routeId){
  const wasOpen=_outletOpen.route===routeId;
  // Close all routes
  document.querySelectorAll('[id^="otl2-"]').forEach(n=>{
    n.querySelector('.tree-hdr2')?.classList.remove('open');
    n.querySelector('.tree-body2')?.classList.remove('open');
  });
  if(!wasOpen){
    _outletOpen.route=routeId;
    const hdr=document.querySelector(`#otl2-${CSS.escape(routeId)} .tree-hdr2`);
    const body=document.getElementById(`otbody2-${routeId}`);
    if(hdr)hdr.classList.add('open');
    if(body)body.classList.add('open');
  } else {
    _outletOpen.route=null;
  }
}

// ── Admin: assign a rep to an outlet that has none ──
async function adminAssignRep(outletId) {
  if(!isAdmin()){showToast('Admin only','error');return;}
  const o=allOutlets.find(x=>x.id===outletId);if(!o)return;
  const reps=allUsers.filter(u=>u.role==='sales_rep'&&u.status!=='disabled');
  if(!reps.length){showToast('No active sales reps found','warn');return;}
  const list=reps.map((u,i)=>(i+1)+') '+u.name+(u.phone?' ('+u.phone+')':'')).join(', ');
  const num=window.prompt('Assign "'+o.name+'" to rep. Options: '+list+'. Enter number 1-'+reps.length+':');
  if(!num)return;
  const idx=parseInt(num,10)-1;
  if(isNaN(idx)||idx<0||idx>=reps.length){showToast('Invalid - enter 1 to '+reps.length,'warn');return;}
  const rep=reps[idx];
  try{
    await sfUpdate('outlets',outletId,{assignedRepId:rep.uid,assignedRepName:rep.name});
    showToast('"'+o.name+'" assigned to '+rep.name+' OK','success');
    await loadCachedData();
    loadOutlets();
  }catch(e){showToast('Error: '+e.message,'error');}
}

async function openNewOutlet() {
  // Ensure routes and users are loaded before populating dropdowns
  // try/catch so a Firestore error never silently blocks the modal from opening
  // loadCachedData not needed here — cache is kept fresh by invalidateCache() on writes
  document.getElementById('mOutletTitle').textContent='🏪 Add Outlet';
  document.getElementById('oEditId').value='';
  ['oName','oArea','oCon','oPhn','oLotNum','oAddr','oROC','oCategoryOthers','oCreditCustomDays'].forEach(id=>{const el=document.getElementById(id);if(el)el.value='';});
  const oEthEl=document.getElementById('oEthnicity');if(oEthEl)oEthEl.value='';
  const oCatEl=document.getElementById('oCategory');if(oCatEl)oCatEl.value='';
  document.getElementById('oCategoryOthersRow').style.display='none';
  // Reset payment type radios
  document.getElementById('oTypeCash').checked=false;
  document.getElementById('oTypeCredit').checked=false;
  document.getElementById('oCreditFields').style.display='none';
  const oCTEl=document.getElementById('oCreditTerm');if(oCTEl)oCTEl.value='';
  const oCLEl=document.getElementById('oCreditLimit');if(oCLEl)oCLEl.value='';
  document.getElementById('oCreditCustomDaysRow').style.display='none';
  clearOutletLocation();
  clearOutletPhoto('signboard');
  clearOutletPhoto('cover');
  cancelOutletCamera();
  _populateRouteDropdown('oRoute','');
  _populateOutletRepDropdown('');
  // Admin sees rep assignment field; reps do not
  const oRepRow=document.getElementById('oRepRow');
  if(oRepRow)oRepRow.style.display=isAdmin()?'':'none';
  // Unlock name field for new outlet
  const nameEl=document.getElementById('oName');
  if(nameEl){nameEl.readOnly=false;nameEl.style.background='';nameEl.style.color='';nameEl.title='';}
  const lockBadge=document.getElementById('oNameLockBadge');
  if(lockBadge)lockBadge.style.display='none';
  openM('mOutlet');
}

function _populateOutletRepDropdown(selectedUid) {
  const el=document.getElementById('oAssignedRep');if(!el)return;
  const reps=allUsers.filter(u=>u.role==='sales_rep'&&u.status!=='disabled');
  el.innerHTML='<option value="">Unassigned</option>'+
    reps.map(u=>`<option value="${u.uid}" ${u.uid===selectedUid?'selected':''}>${u.name}</option>`).join('');
}

/* ── Outlet form UI helpers ─────────────────────── */
function onOutletCategoryChange(){
  const val=document.getElementById('oCategory')?.value;
  document.getElementById('oCategoryOthersRow').style.display=val==='others'?'':'none';
}
function onOutletPayTypeChange(){
  const isCr=document.getElementById('oTypeCredit')?.checked;
  document.getElementById('oCreditFields').style.display=isCr?'':'none';
  const oCTEl=document.getElementById('oCreditTerm');if(oCTEl&&!isCr)oCTEl.value='';
  if(!isCr){const el=document.getElementById('oCreditCustomDaysRow');if(el)el.style.display='none';}
}
document.addEventListener('change',function(e){
  if(e.target&&e.target.id==='oCreditTerm'){
    document.getElementById('oCreditCustomDaysRow').style.display=e.target.value==='custom'?'':'none';
  }
});

/* ── Outlet photo helpers ─────────────────────── */
let _oPhotoCamStream=null;
let _oPhotoCamTarget=null; // 'signboard' | 'cover'

function clearOutletPhoto(which){
  const key=which==='signboard'?'signboard':'cover';
  if(key==='signboard'){
    const preview=document.getElementById('oSignboardPhotoPreview');
    if(preview)preview.style.display='none';
    const previewImg=document.getElementById('oSignboardPhotoImg');
    if(previewImg)previewImg.src='';
    const empty=document.getElementById('oSignboardEmpty');
    if(empty)empty.style.display='';
    // Also clear cover if it was auto-filled from signboard
    const coverImg=document.getElementById('oCoverImg');
    const coverWrap=document.getElementById('oCoverPreviewWrap');
    const coverEmpty=document.getElementById('oCoverEmpty');
    if(coverImg&&coverImg.dataset.autoFromSignboard){
      coverImg.src='';coverImg.removeAttribute('data-auto-from-signboard');
      if(coverWrap)coverWrap.style.display='none';
      if(coverEmpty)coverEmpty.style.display='';
    }
  } else {
    const img=document.getElementById('oCoverImg');
    if(img){img.src='';img.removeAttribute('data-auto-from-signboard');}
    const wrap=document.getElementById('oCoverPreviewWrap');
    if(wrap)wrap.style.display='none';
    const emp=document.getElementById('oCoverEmpty');
    if(emp)emp.style.display='';
  }
}

function onOutletPhotoFile(which,input){
  const file=input.files&&input.files[0];if(!file)return;
  // Compress before preview for faster saves
  const img=new Image();
  const objUrl=URL.createObjectURL(file);
  img.onload=function(){
    const maxW=1024,maxH=1024;
    let w=img.naturalWidth,h=img.naturalHeight;
    if(w>maxW||h>maxH){const s=Math.min(maxW/w,maxH/h);w=Math.round(w*s);h=Math.round(h*s);}
    const canvas=document.createElement('canvas');canvas.width=w;canvas.height=h;
    canvas.getContext('2d').drawImage(img,0,0,w,h);
    const dataUrl=canvas.toDataURL('image/jpeg',0.78);
    URL.revokeObjectURL(objUrl);
    _setOutletPhoto(which,dataUrl);
  };
  img.onerror=function(){
    URL.revokeObjectURL(objUrl);
    const reader=new FileReader();
    reader.onload=function(e){_setOutletPhoto(which,e.target.result);};
    reader.readAsDataURL(file);
  };
  img.src=objUrl;
  input.value='';
}

function _setOutletPhoto(which,dataUrl){
  const key=which==='signboard'?'signboard':'cover';
  if(key==='signboard'){
    // Show full preview, hide empty placeholder
    const preview=document.getElementById('oSignboardPhotoPreview');
    const previewImg=document.getElementById('oSignboardPhotoImg');
    if(previewImg)previewImg.src=dataUrl;
    if(preview)preview.style.display='';
    const empty=document.getElementById('oSignboardEmpty');
    if(empty)empty.style.display='none';
    // Auto-apply signboard as cover photo (if cover hasn't been manually set)
    const coverImg=document.getElementById('oCoverImg');
    const coverWrap=document.getElementById('oCoverPreviewWrap');
    const coverEmpty=document.getElementById('oCoverEmpty');
    const hasManualCover=coverImg&&coverImg.src&&!coverImg.dataset.autoFromSignboard&&coverImg.src!==window.location.href&&coverImg.src!=='';
    if(!hasManualCover){
      if(coverImg){coverImg.src=dataUrl;coverImg.dataset.autoFromSignboard='1';}
      if(coverWrap)coverWrap.style.display='';
      if(coverEmpty)coverEmpty.style.display='none';
    }
  } else {
    // Manual cover set — mark as manual (remove auto flag)
    const img=document.getElementById('oCoverImg');
    if(img){img.src=dataUrl;img.removeAttribute('data-auto-from-signboard');}
    const wrap=document.getElementById('oCoverPreviewWrap');
    if(wrap)wrap.style.display='';
    const emp=document.getElementById('oCoverEmpty');
    if(emp)emp.style.display='none';
  }
}

async function captureOutletPhoto(which){
  _oPhotoCamTarget=which;
  // Each photo type has its own camera wrap/video/canvas
  const wrapId=which==='signboard'?'oPhotoCamWrap':'oCoverCamWrap';
  const videoId=which==='signboard'?'oPhotoCamVideo':'oCoverCamVideo';
  const wrap=document.getElementById(wrapId);
  const video=document.getElementById(videoId);
  if(!wrap||!video)return;
  const lbl=document.getElementById('oPhotoCamLabel');
  if(lbl)lbl.textContent=which==='signboard'?'📷 Capture Signboard Photo':'📷 Capture Cover Photo';
  try{
    _oPhotoCamStream=await navigator.mediaDevices.getUserMedia({video:{facingMode:'environment'},audio:false});
    video.srcObject=_oPhotoCamStream;
    wrap.style.display='';
    wrap.scrollIntoView({behavior:'smooth',block:'nearest'});
  }catch(err){
    showToast('Camera access denied: '+err.message,'error');
  }
}

function snapOutletPhoto(){
  const videoId=_oPhotoCamTarget==='signboard'?'oPhotoCamVideo':'oCoverCamVideo';
  const canvasId=_oPhotoCamTarget==='signboard'?'oPhotoCamCanvas':'oCoverCamCanvas';
  const video=document.getElementById(videoId);
  const canvas=document.getElementById(canvasId);
  if(!video||!canvas)return;
  canvas.width=video.videoWidth||640;
  canvas.height=video.videoHeight||480;
  canvas.getContext('2d').drawImage(video,0,0);
  const offscreen=document.createElement('canvas');
  const maxW=1024;const scale=Math.min(1,maxW/canvas.width);
  offscreen.width=Math.round(canvas.width*scale);
  offscreen.height=Math.round(canvas.height*scale);
  offscreen.getContext('2d').drawImage(canvas,0,0,offscreen.width,offscreen.height);
  const dataUrl=offscreen.toDataURL('image/jpeg',0.78);
  _setOutletPhoto(_oPhotoCamTarget,dataUrl);
  cancelOutletCamera();
}

function cancelOutletCamera(){
  if(_oPhotoCamStream){_oPhotoCamStream.getTracks().forEach(t=>t.stop());_oPhotoCamStream=null;}
  ['oPhotoCamWrap','oCoverCamWrap'].forEach(id=>{
    const w=document.getElementById(id);if(w)w.style.display='none';
  });
  ['oPhotoCamVideo','oCoverCamVideo'].forEach(id=>{
    const v=document.getElementById(id);if(v)v.srcObject=null;
  });
  _oPhotoCamTarget=null;
}

async function editOutlet(id) {
  const o=allOutlets.find(x=>x.id===id);if(!o)return;
  // Sales rep can only edit their own outlets
  if(!isAdmin() && o.createdBy !== CU.uid){showToast('You can only edit your own outlets','error');return;}
  document.getElementById('mOutletTitle').textContent='✏️ Edit Outlet';
  document.getElementById('oEditId').value=id;
  document.getElementById('oName').value=o.name;
  // Category
  const oCatEl=document.getElementById('oCategory');
  if(oCatEl){oCatEl.value=o.category||'';}
  const othersRow=document.getElementById('oCategoryOthersRow');
  if(othersRow)othersRow.style.display=o.category==='others'?'':'none';
  const oCOEl=document.getElementById('oCategoryOthers');if(oCOEl)oCOEl.value=o.categoryOthers||'';
  // Payment type
  const payType=o.paymentType||'cash';
  const cashRadio=document.getElementById('oTypeCash');
  const creditRadio=document.getElementById('oTypeCredit');
  if(cashRadio)cashRadio.checked=payType==='cash';
  if(creditRadio)creditRadio.checked=payType==='credit';
  document.getElementById('oCreditFields').style.display=payType==='credit'?'':'none';
  const oCTEl=document.getElementById('oCreditTerm');if(oCTEl)oCTEl.value=o.creditTerm||'';
  const oCLEl=document.getElementById('oCreditLimit');if(oCLEl)oCLEl.value=o.creditLimit||'';
  const customDaysRow=document.getElementById('oCreditCustomDaysRow');
  if(customDaysRow)customDaysRow.style.display=o.creditTerm==='custom'?'':'none';
  const oCCDEl=document.getElementById('oCreditCustomDays');if(oCCDEl)oCCDEl.value=o.creditCustomDays||'';
  // Other fields
  document.getElementById('oArea').value=o.area||'';
  document.getElementById('oCon').value=o.contact||'';
  document.getElementById('oPhn').value=o.phone||'';
  // Split stored address back into lot/unit + street body
  // Lot patterns: "No 56", "Unit 3A", "Lot 7", "PT 1234", or leading digits
  const savedAddr=o.address||'';
  const lotMatch=savedAddr.match(/^(No\.?\s*\S[^,]*|Unit\s+[^,]+|Lot\s+[^,]+|PT\s+[^,]+|\d+[^,]*),\s*/i);
  const lotEl2=document.getElementById('oLotNum');
  const addrEl2=document.getElementById('oAddr');
  if(lotMatch&&lotEl2){
    lotEl2.value=lotMatch[1].trim();
    if(addrEl2) addrEl2.value=savedAddr.slice(lotMatch[0].length).trim();
  } else {
    if(lotEl2) lotEl2.value='';
    if(addrEl2) addrEl2.value=savedAddr;
  }
  const oROCEl=document.getElementById('oROC');if(oROCEl)oROCEl.value=o.roc||'';
  const oEthEl=document.getElementById('oEthnicity');if(oEthEl)oEthEl.value=o.ethnicity||'';
  _populateRouteDropdown('oRoute', o.routeId||o.route||'');
  _populateOutletRepDropdown(o.assignedRepId||'');
  const oRepRow=document.getElementById('oRepRow');
  if(oRepRow)oRepRow.style.display=isAdmin()?'':'none';

  // Photos
  clearOutletPhoto('signboard');clearOutletPhoto('cover');cancelOutletCamera();
  if(o.signboardPhoto){
    const preview=document.getElementById('oSignboardPhotoPreview');
    const previewImg=document.getElementById('oSignboardPhotoImg');
    if(previewImg)previewImg.src=o.signboardPhoto;
    if(preview)preview.style.display='';
    const empty=document.getElementById('oSignboardEmpty');
    if(empty)empty.style.display='none';
  }
  if(o.coverPhoto||o.interiorPhoto){
    const coverSrc=o.coverPhoto||o.interiorPhoto;
    const coverImg=document.getElementById('oCoverImg');
    if(coverImg){coverImg.src=coverSrc;coverImg.removeAttribute('data-auto-from-signboard');}
    const coverWrap=document.getElementById('oCoverPreviewWrap');
    if(coverWrap)coverWrap.style.display='';
    const coverEmpty=document.getElementById('oCoverEmpty');
    if(coverEmpty)coverEmpty.style.display='none';
  } else if(o.signboardPhoto){
    // Auto-fill cover with signboard if no separate cover saved
    const coverImg=document.getElementById('oCoverImg');
    if(coverImg){coverImg.src=o.signboardPhoto;coverImg.dataset.autoFromSignboard='1';}
    const coverWrap=document.getElementById('oCoverPreviewWrap');
    if(coverWrap)coverWrap.style.display='';
    const coverEmpty=document.getElementById('oCoverEmpty');
    if(coverEmpty)coverEmpty.style.display='none';
  }

  // Lock outlet name for non-strict-admin
  const nameEl=document.getElementById('oName');
  if(nameEl){
    const isLocked=CU&&CU.role==='sales_rep';
    nameEl.readOnly=isLocked;
    nameEl.style.background=isLocked?'var(--s3)':'';
    nameEl.style.color=isLocked?'var(--tx3)':'';
    nameEl.title=isLocked?'Outlet name can only be changed by Admin':'';
    // Show/hide lock badge
    let lockBadge=document.getElementById('oNameLockBadge');
    if(!lockBadge){
      lockBadge=document.createElement('div');
      lockBadge.id='oNameLockBadge';
      lockBadge.style.cssText='font-size:10px;color:var(--ylw);margin-top:4px;display:flex;align-items:center;gap:4px';
      nameEl.parentNode.insertBefore(lockBadge,nameEl.nextSibling);
    }
    lockBadge.style.display=isLocked?'flex':'none';
    lockBadge.innerHTML='🔒 Outlet name is locked — only Admin can change it';
  }

  // Restore saved location
  const latEl=document.getElementById('oLat');
  const lngEl=document.getElementById('oLng');
  if(latEl) latEl.value=o.lat||'';
  if(lngEl) lngEl.value=o.lng||'';
  if(o.lat&&o.lng){
    const d=document.getElementById('outletLocDisplay');
    if(d) d.innerHTML=`<span style="color:var(--grn)">✅ ${Number(o.lat).toFixed(6)}, ${Number(o.lng).toFixed(6)}</span>`;
    const clr=document.getElementById('clearLocBtn');if(clr)clr.style.display='inline-flex';
  } else {
    clearOutletLocation();
  }
  openM('mOutlet');
}

async function saveOutlet() {
  try {
    const nameEl=document.getElementById('oName');
    const editId=document.getElementById('oEditId').value;
    const existing=editId?allOutlets.find(o=>o.id===editId):null;
    const isSalesRep=CU&&CU.role==='sales_rep';
    const name=isSalesRep&&existing?existing.name:(nameEl?nameEl.value.trim():'');
    const category=document.getElementById('oCategory')?.value||'';
    const categoryOthers=category==='others'?(document.getElementById('oCategoryOthers')?.value.trim()||''):'';
    const paymentType=document.querySelector('input[name="oPayType"]:checked')?.value||'';
    const creditTerm=paymentType==='credit'?(document.getElementById('oCreditTerm')?.value||''):'';
    const creditLimit=paymentType==='credit'?(parseFloat(document.getElementById('oCreditLimit')?.value)||0):0;
    const creditCustomDays=creditTerm==='custom'?(parseInt(document.getElementById('oCreditCustomDays')?.value)||0):0;
    const area=document.getElementById('oArea').value.trim();
    const contact=document.getElementById('oCon').value.trim();
    const phone=document.getElementById('oPhn').value.trim();
    const lotNum=document.getElementById('oLotNum')?.value.trim()||'';
    const addrBody=document.getElementById('oAddr')?.value.trim()||'';
    // Combine into full address: "No 56, Jalan X, Taman Y, 31450 Ipoh, Perak, Malaysia"
    const address=[lotNum,addrBody].filter(Boolean).join(', ');
    const roc=document.getElementById('oROC')?.value.trim()||'';
    const ethnicity=document.getElementById('oEthnicity')?.value||'';
    // Signboard photo — read from preview img
    const signboardPreviewImg=document.getElementById('oSignboardPhotoImg');
    const _sbSrc=(signboardPreviewImg&&signboardPreviewImg.src&&signboardPreviewImg.src!==window.location.href&&signboardPreviewImg.src!=='')?signboardPreviewImg.src:'';
    const signboardPhoto=_sbSrc||'';
    const interiorImg=document.getElementById('oCoverImg');
    const interiorPhoto=(interiorImg&&interiorImg.src&&!interiorImg.src.endsWith(window.location.href))?interiorImg.src:'';

    if(!name){showToast('Outlet name is required','error');return;}
    if(!category){showToast('Select a category','error');return;}
    if(category==='others'&&!categoryOthers){showToast('Please specify the category','error');return;}
    if(!paymentType){showToast('Select payment type (Cash or Credit)','error');return;}
    if(paymentType==='credit'){
      if(!creditTerm){showToast('Select credit term','error');return;}
      if(creditTerm==='custom'&&!creditCustomDays){showToast('Enter custom credit days','error');return;}
      if(!creditLimit){showToast('Enter credit limit amount','error');return;}
    }
    if(!area){showToast('Area/Zone is required','error');return;}
    if(!phone){showToast('Phone number is required','error');return;}
    if(!contact){showToast('Contact person name is required','error');return;}
    if(!address){showToast('Address is required — enter lot/unit no and street','error');return;}
    if(!signboardPhoto){showToast('Signboard photo is required','error');return;}

    const routeEl=document.getElementById('oRoute');
    const routeId=routeEl?routeEl.value:'';
    if(!routeId){showToast('Select a route (create routes first under Routes)','warn');return;}
    const selectedRoute=allRoutes.find(r=>r.id===routeId);
    const routeNameVal=selectedRoute?selectedRoute.name:'';
    const rawLat=document.getElementById('oLat')?.value;
    const rawLng=document.getElementById('oLng')?.value;

    // type is now derived from category for backward compat
    const typeLegacy=category;

    const data={
      name, category, categoryOthers, type:typeLegacy,
      paymentType, creditTerm, creditLimit, creditCustomDays,
      area, routeId, route:routeNameVal, contact, phone, address, roc, ethnicity,
      signboardPhoto, coverPhoto: interiorPhoto,
      assignedRepId:isAdmin()?(document.getElementById('oAssignedRep')?.value||''):CU.uid,
      assignedRepName:isAdmin()?((allUsers.find(u=>u.uid===document.getElementById('oAssignedRep')?.value)||{}).name||''):CU.name,
      color:COLORS[allOutlets.length%COLORS.length],
      lat:rawLat?parseFloat(rawLat):null, lng:rawLng?parseFloat(rawLng):null, zoneId:CU.zoneId||null,
    };

    if(editId){
      if(existing&&isSalesRep&&name!==existing.name){showToast('Outlet name cannot be changed. Contact Admin.','error');return;}
      // Credit outlets: flag for approval if not already approved or if credit fields changed
      if(paymentType==='credit'){
        const creditChanged=!existing||existing.paymentType!=='credit'||existing.creditLimit!==creditLimit||existing.creditTerm!==creditTerm;
        if(creditChanged&&!isAdmin()){data.creditStatus='pending';data.creditRequestedBy=CU.uid;}
        else if(isAdmin()){data.creditStatus='approved';data.creditApprovedBy=CU.uid;}
      } else {
        data.creditStatus='none';
      }
      await sfUpdate('outlets',editId,data);
      showToast('Outlet updated','success');
    } else {
      data.createdBy=CU.uid;data.createdByName=CU.name;data.createdAt=new Date().toISOString();
      if(paymentType==='credit'){
        data.creditStatus=isAdmin()?'approved':'pending';
        if(isAdmin())data.creditApprovedBy=CU.uid;
      } else {
        data.creditStatus='none';
      }
      // Keep legacy openingBalance as 0 for compat
      data.openingBalance=0;data.balanceStatus='none';
      await sfAdd('outlets',data);
      const msg=paymentType==='credit'&&!isAdmin()?'Outlet added — credit terms pending admin approval.':'Outlet added';
      showToast(msg,'success');
      // 🔔 Notify admins if credit approval needed
      if(paymentType==='credit'&&!isAdmin()) notifyAdmins('🏦 Credit Approval Needed',`${CU.name} added outlet "${name}" — credit terms pending approval`,{tag:'credit-pending'});
    }
    closeM('mOutlet');
    await loadCachedData();
    loadOutlets();updateBadges();updateSidebarStats();
  } catch(e) {
    console.error('saveOutlet error:',e);
    showToast('Error saving outlet: '+e.message,'error');
  }
}

function _populateRouteDropdown(selectId, selectedVal) {
  const el=document.getElementById(selectId);
  if(!el)return;
  el.innerHTML='<option value="">Select route...</option>'+
    allRoutes.map(r=>`<option value="${r.id}" ${r.id===selectedVal?'selected':''}>${r.name}</option>`).join('');
}

// ── Outlet location helpers ──
function pinOutletLocation() {
  if(!navigator.geolocation){showToast('Geolocation not supported','error');return;}
  showToast('Getting GPS location…','info');
  navigator.geolocation.getCurrentPosition(pos=>{
    const lat=pos.coords.latitude.toFixed(6);
    const lng=pos.coords.longitude.toFixed(6);
    const acc=Math.round(pos.coords.accuracy);
    const latEl=document.getElementById('oLat');
    const lngEl=document.getElementById('oLng');
    if(latEl)latEl.value=lat;
    if(lngEl)lngEl.value=lng;
    const d=document.getElementById('outletLocDisplay');
    if(d)d.innerHTML=`<span style="color:var(--grn)">✅ ${lat}, ${lng}</span><span style="font-size:10px;color:var(--tx3);margin-left:6px">(±${acc}m)</span>`;
    const clr=document.getElementById('clearLocBtn');if(clr)clr.style.display='inline-flex';
    showToast('Location pinned ✅','success');
  },err=>{
    showToast('Could not get location. Enable GPS and try again.','error');
    console.warn('GPS error',err.message);
  },{enableHighAccuracy:true,timeout:12000,maximumAge:0});
}

function clearOutletLocation() {
  const latEl=document.getElementById('oLat');if(latEl)latEl.value='';
  const lngEl=document.getElementById('oLng');if(lngEl)lngEl.value='';
  const d=document.getElementById('outletLocDisplay');if(d)d.textContent='Not pinned yet';
  const clr=document.getElementById('clearLocBtn');if(clr)clr.style.display='none';
}

async function autoFillAddress() {
  if(!navigator.geolocation){showToast('Geolocation not supported','error');return;}
  showToast('Getting location…','info');
  navigator.geolocation.getCurrentPosition(async pos=>{
    const lat=pos.coords.latitude;
    const lng=pos.coords.longitude;
    // Pin coordinates
    const latEl=document.getElementById('oLat');if(latEl)latEl.value=lat.toFixed(6);
    const lngEl=document.getElementById('oLng');if(lngEl)lngEl.value=lng.toFixed(6);
    const d=document.getElementById('outletLocDisplay');
    const acc=Math.round(pos.coords.accuracy);
    if(d)d.innerHTML=`<span style="color:var(--grn)">✅ ${lat.toFixed(6)}, ${lng.toFixed(6)}</span><span style="font-size:10px;color:var(--tx3);margin-left:6px">(±${acc}m)</span>`;
    const clr=document.getElementById('clearLocBtn');if(clr)clr.style.display='inline-flex';
    try {
      // zoom=18 = building level; addressdetails=1 gives structured fields; namedetails=1 gives building name
      const url=`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&addressdetails=1&namedetails=1&zoom=18`;
      const resp=await fetch(url,{headers:{'Accept-Language':'en','User-Agent':'STFM-App'}});
      const json=await resp.json();
      if(json&&json.address){
        const a=json.address;

        // ── Lot / unit number ──────────────────────────────────────────────
        // OSM may have it in house_number; also check top-level name for "No X / Lot X / PT X"
        let lotNum=a.house_number||'';
        if(!lotNum){
          const topName=json.name||(json.namedetails&&json.namedetails.name)||'';
          if(/^(No\.?\s*\d|Lot\s*\d|PT\s*\d|Unit\s*\d|\d)/i.test(topName)) lotNum=topName;
        }
        // Only fill lot field if OSM returned something AND field is currently empty
        const lotEl=document.getElementById('oLotNum');
        if(lotEl&&lotNum&&!lotEl.value) lotEl.value=lotNum;

        // ── Street ────────────────────────────────────────────────────────
        const road=a.road||a.street||a.pedestrian||a.path||'';
        // ── Estate / taman / suburb ───────────────────────────────────────
        const suburb=a.neighbourhood||a.suburb||a.quarter||a.residential||a.village||a.hamlet||'';
        // ── Postcode + city ───────────────────────────────────────────────
        const city=a.city||a.town||a.municipality||a.county||'';
        const postcodeCity=[a.postcode,city].filter(Boolean).join(' ');
        // ── State, Country ────────────────────────────────────────────────
        const tail=[a.state,a.country].filter(Boolean).join(', ');

        const addrBody=[road,suburb,postcodeCity,tail].filter(Boolean).join(', ');
        const addrEl=document.getElementById('oAddr');
        if(addrEl) addrEl.value=addrBody||json.display_name||'';

        const gotLot=!!(lotEl&&lotEl.value);
        showToast(gotLot?'Address & lot filled ✅':'Address filled — enter lot/unit no manually ✅','success');
      } else {
        showToast('Location pinned. Address not found — enter manually.','warn');
      }
    } catch(e){
      console.warn('[autoFillAddress]',e.message);
      showToast('Location pinned. Could not fetch address.','warn');
    }
  },err=>{
    showToast('Could not get location. Enable GPS.','error');
  },{enableHighAccuracy:true,timeout:15000,maximumAge:0});
}

function openWhatsApp(outletId) {
  const o=allOutlets.find(x=>x.id===outletId);if(!o||!o.phone)return;
  const raw=o.phone.replace(/\D/g,'');
  const intl=raw.startsWith('0')?'6'+raw:raw.startsWith('60')?raw:'60'+raw;
  const msg=encodeURIComponent(`Hello ${o.name}, I am your sales rep from Sairah Trading. I would like to assist with your order.`);
  const waUrl=`https://wa.me/${intl}?text=${msg}`;
  const wabUrl=`https://wa.me/${intl}?text=${msg}`;

  // Show a small picker modal
  const existing=document.getElementById('waPickerModal');
  if(existing)existing.remove();
  const el=document.createElement('div');
  el.id='waPickerModal';
  el.style.cssText='position:fixed;inset:0;z-index:9000;background:rgba(0,0,0,.65);display:flex;align-items:flex-end;justify-content:center;backdrop-filter:blur(4px)';
  el.innerHTML=`
    <div style="background:var(--s1);border:1px solid var(--bdr);border-radius:20px 20px 0 0;width:100%;max-width:480px;padding:20px 20px calc(20px + env(safe-area-inset-bottom,0px));animation:slideUpBanner .25s ease">
      <div style="font-family:'Syne',sans-serif;font-size:15px;font-weight:700;margin-bottom:4px;text-align:center">💬 Open in WhatsApp</div>
      <div style="font-size:12px;color:var(--tx2);text-align:center;margin-bottom:18px">${o.name} · ${o.phone}</div>
      <div style="display:flex;flex-direction:column;gap:10px">
        <button onclick="window.open('${waUrl}','_blank');document.getElementById('waPickerModal').remove()"
          style="display:flex;align-items:center;gap:13px;padding:14px 16px;background:var(--s2);border:1px solid var(--bdr);border-radius:var(--r);cursor:pointer;color:var(--tx);font-size:14px;font-weight:600;transition:var(--tr)"
          onmouseover="this.style.borderColor='#25D366'" onmouseout="this.style.borderColor='var(--bdr)'">
          <span style="font-size:26px">💬</span>
          <div style="text-align:left"><div>WhatsApp</div><div style="font-size:11px;color:var(--tx3);font-weight:400">Standard personal/business chat</div></div>
        </button>
        <button onclick="window.open('whatsapp://send?phone=${intl}&text=${msg}','_blank');setTimeout(()=>{if(document.hidden===false)window.open('${waUrl}','_blank')},1500);document.getElementById('waPickerModal').remove()"
          style="display:flex;align-items:center;gap:13px;padding:14px 16px;background:var(--s2);border:1px solid var(--bdr);border-radius:var(--r);cursor:pointer;color:var(--tx);font-size:14px;font-weight:600;transition:var(--tr)"
          onmouseover="this.style.borderColor='#128C7E'" onmouseout="this.style.borderColor='var(--bdr)'">
          <span style="font-size:26px">🏢</span>
          <div style="text-align:left"><div>WhatsApp Business</div><div style="font-size:11px;color:var(--tx3);font-weight:400">For business accounts & catalogues</div></div>
        </button>
        <button onclick="document.getElementById('waPickerModal').remove()"
          style="padding:12px;background:transparent;border:1px solid var(--bdr);border-radius:var(--r2);cursor:pointer;color:var(--tx2);font-size:13px;font-weight:600">
          Cancel
        </button>
      </div>
    </div>`;
  el.addEventListener('click',e=>{if(e.target===el)el.remove();});
  document.body.appendChild(el);
}

function openDirections(outletId) {
  const o=allOutlets.find(x=>x.id===outletId);if(!o)return;
  if(!o.lat||!o.lng){showToast('No location pinned for this outlet','warn');return;}
  const label=encodeURIComponent(o.name);
  window.open(`https://www.google.com/maps/dir/?api=1&destination=${o.lat},${o.lng}&destination_place_id=${label}&travelmode=driving`,'_blank');
}

function viewOutletQR(outletId) {
  const o=allOutlets.find(x=>x.id===outletId);if(!o)return;
  const base=window.location.origin+window.location.pathname.replace(/\/$/,'');
  const url=`${base}?oc=${outletId}`;
  const qrImg=`https://api.qrserver.com/v1/create-qr-code/?size=260x260&data=${encodeURIComponent(url)}&bgcolor=ffffff&color=0d1117&margin=12&ecc=M`;
  document.getElementById('mQRTitle').textContent=`📷 ${o.name}`;
  document.getElementById('mQRSubtitle').textContent=`Scan to open order for ${o.name}`;
  document.getElementById('mQRCode').innerHTML=`<img src="${qrImg}" style="width:220px;height:220px;border-radius:8px;display:block" alt="QR Code" onerror="this.alt='QR load failed — check internet'">`;
  document.getElementById('mQRUrl').textContent=url;
  window.__currentQROutlet={id:outletId,name:o.name,url};
  openM('mOutletQR');
}

function downloadOutletQR() {
  const q=window.__currentQROutlet;if(!q)return;
  const qrHigh=`https://api.qrserver.com/v1/create-qr-code/?size=600x600&data=${encodeURIComponent(q.url)}&bgcolor=ffffff&color=0d1117&margin=20&ecc=M`;
  // Open in new tab so user can long-press save (mobile) or right-click save (desktop)
  const w=window.open('','_blank');
  if(w){
    w.document.write(`<!DOCTYPE html><html><head><title>QR – ${q.name}</title>
    <style>body{margin:0;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;background:#f5f5f5;font-family:sans-serif;gap:14px}
    img{border-radius:12px;box-shadow:0 4px 24px rgba(0,0,0,.15);max-width:90vw}
    p{font-size:13px;color:#666;text-align:center;max-width:320px}
    h2{font-size:16px;font-weight:700;margin:0}</style></head>
    <body><h2>${q.name}</h2><img src="${qrHigh}" alt="QR Code"><p>Long-press (mobile) or right-click → Save image to download.<br><small>${q.url}</small></p></body></html>`);
  }
}

async function approveBalance(id) {
  if(!isAdmin()){showToast('Only admin can approve balances','error');return;}
  await sfUpdate('outlets',id,{balanceStatus:'approved',balanceApprovedBy:CU.uid,balanceApprovedAt:new Date().toISOString()});
  showToast('Opening balance approved ✅','success');
  await loadCachedData();loadOutlets();renderDashboard();updateBadges();
}

async function rejectBalance(id) {
  if(!isAdmin()){showToast('Only admin can manage balances','error');return;}
  await sfUpdate('outlets',id,{balanceStatus:'rejected',openingBalance:0});
  showToast('Opening balance rejected','warn');
  await loadCachedData();loadOutlets();updateBadges();
}

async function delOutlet(id) {
  if(!isAdmin()){showToast('Only admin can delete outlets','error');return;}
  const o=allOutlets.find(x=>x.id===id);
  const label=o?o.name:`Outlet ${id}`;
  if(isStrictAdmin()){
    if(!await _customConfirm(`"${label}" will be permanently deleted.`, {title:'Delete Outlet',okText:'Delete',cancelText:'Cancel',danger:true,icon:'🗑️'}))return;
    await Promise.all([
      window.__SF.deleteDoc(window.__SF.doc(window.__SF.db,'outlets',id)).catch(()=>{}),
      _oZone?window.__SF.deleteDoc(window.__SF.doc(window.__SF.db,'zones',_oZone,'outlets',id)).catch(()=>{}):Promise.resolve()
    ]);
    showToast('Outlet deleted','warn');
    await loadCachedData();loadOutlets();
  } else {
    await requestDeleteApproval('outlet',id,label);
  }
}

async function viewOutlet(id) {
  const o=allOutlets.find(x=>x.id===id);if(!o)return;
  const [ordD,colD]=await Promise.all([sfGet('orders'),sfGet('collections')]);
  const oOrders=ordD.map(d=>({_docId:d.id,...d.data()})).filter(x=>x.outletId===id);
  const oCols=colD.map(d=>d.data()).filter(x=>x.outletId===id);
  const totalSales=oOrders.filter(x=>x.status!=='Cancelled').reduce((s,x)=>s+x.total,0);
  const totalPaid=oCols.reduce((s,x)=>s+x.amount,0);
  const approvedBalance=o.balanceStatus==='approved'?o.openingBalance:0;
  const hasPinned=!!(o.lat&&o.lng);
  const hasPhone=!!o.phone;

  document.getElementById('mODTitle').textContent=o.name;
  document.getElementById('mODBody').innerHTML=`
    <!-- Header row -->
    <div style="display:flex;gap:11px;align-items:center;margin-bottom:14px;padding-bottom:14px;border-bottom:1px solid var(--bdr)">
      <div class="oava" style="background:${o.color||COLORS[0]};width:50px;height:50px;border-radius:12px;font-size:20px;flex-shrink:0">${o.name[0]}</div>
      <div style="flex:1;min-width:0">
        <div style="font-family:'Syne',sans-serif;font-size:17px;font-weight:700">${o.name}</div>
        <div style="font-size:12px;color:var(--tx2)">${o.type}${o.ethnicity?' · 👥 '+o.ethnicity:''}${o.area?' · '+o.area:''}${o.route?' · 🗺️ '+o.route:''}</div>
        ${hasPhone?`<div style="font-size:11px;color:var(--tx3)">📞 ${o.phone}${o.contact?' · 👤 '+o.contact:''}</div>`:''}
      </div>
    </div>

    <!-- Action buttons -->
    <div style="display:flex;gap:7px;margin-bottom:14px;flex-wrap:wrap">
      <button class="btn btn-primary btn-sm" style="flex:1;min-width:100px" onclick="closeM('mOutletDetail');openNewOrder('${o.id}')">📦 New Order</button>
      ${hasPhone?`<button class="btn btn-grn btn-sm" style="flex:1;min-width:90px" onclick="openWhatsApp('${o.id}')">💬 WhatsApp</button>`:''}
      <button class="btn btn-blu btn-sm" style="flex:1;min-width:90px" onclick="openDirections('${o.id}')" title="${hasPinned?'Open directions':'No location pinned'}">🗺️ Direction</button>
      <button class="btn btn-ghost btn-sm" style="flex:1;min-width:70px" onclick="viewOutletQR('${o.id}')">📷 QR Code</button>
    </div>

    <!-- GPS pin info -->
    <div style="background:${hasPinned?'rgba(34,197,94,.07)':'rgba(34,197,94,.05)'};border:1px solid ${hasPinned?'rgba(34,197,94,.2)':'var(--bdr)'};border-radius:var(--r2);padding:9px 12px;margin-bottom:14px;font-size:12px;display:flex;align-items:center;gap:9px">
      <span style="font-size:18px">${hasPinned?'📍':'🔘'}</span>
      <div style="flex:1">
        ${hasPinned
          ? `<div style="font-weight:700;color:var(--grn);margin-bottom:2px">Location Pinned</div>
             <div style="color:var(--tx3)">${Number(o.lat).toFixed(6)}, ${Number(o.lng).toFixed(6)}</div>`
          : `<div style="font-weight:600;color:var(--tx2)">No location pin set</div>
             <div style="color:var(--tx3)">Edit outlet and tap "Pin Current Location" while at the outlet</div>`}
      </div>
      ${hasPinned?`<a href="https://www.google.com/maps?q=${o.lat},${o.lng}" target="_blank" style="font-size:11px;color:var(--blu);text-decoration:none;white-space:nowrap">🗺️ View</a>`:''}
    </div>

    <!-- Stats -->
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:9px;margin-bottom:14px">
      <div style="background:var(--s2);border-radius:var(--r2);padding:11px;text-align:center"><div style="font-family:'Syne',sans-serif;font-size:17px;font-weight:800;color:var(--acc)">${fmt(totalSales)}</div><div style="font-size:10px;color:var(--tx3)">Total Sales</div></div>
      <div style="background:var(--s2);border-radius:var(--r2);padding:11px;text-align:center"><div style="font-family:'Syne',sans-serif;font-size:17px;font-weight:800;color:var(--grn)">${fmt(totalPaid)}</div><div style="font-size:10px;color:var(--tx3)">Collected</div></div>
      <div style="background:var(--s2);border-radius:var(--r2);padding:11px;text-align:center"><div style="font-family:'Syne',sans-serif;font-size:17px;font-weight:800;color:var(--red)">${fmt(Math.max(0,totalSales-totalPaid+approvedBalance))}</div><div style="font-size:10px;color:var(--tx3)">Outstanding</div></div>
    </div>

    ${o.openingBalance>0?`<div style="background:${o.balanceStatus==='approved'?'rgba(34,197,94,.07)':'rgba(245,158,11,.07)'};border:1px solid ${o.balanceStatus==='approved'?'rgba(34,197,94,.2)':'rgba(245,158,11,.2)'};border-radius:var(--r2);padding:10px;margin-bottom:12px;font-size:12px">Opening Balance: ${fmt(o.openingBalance)} — <strong>${o.balanceStatus==='approved'?'✅ Approved':o.balanceStatus==='rejected'?'❌ Rejected':'⏳ Pending Admin Approval'}</strong></div>`:''}
    ${o.address?`<div style="background:var(--s2);border-radius:var(--r2);padding:10px;margin-bottom:12px;font-size:12px;color:var(--tx2)">📍 ${o.address}</div>`:''}

    <div style="font-size:11px;color:var(--tx3);font-weight:700;margin-bottom:8px;letter-spacing:.5px">RECENT ORDERS</div>
    ${oOrders.slice(-5).reverse().map(ord=>`
      <div style="display:flex;justify-content:space-between;align-items:center;padding:9px 0;border-bottom:1px solid rgba(30,45,69,.4);font-size:12px;gap:8px">
        <span style="font-weight:600;font-size:11px;flex-shrink:0">${ord.id||ord._docId}</span>
        <span style="color:var(--tx2);flex-shrink:0">${ord.date||'—'}</span>
        <span style="font-family:'Syne',sans-serif;font-weight:700;color:var(--acc);flex-shrink:0">${fmt(ord.total)}</span>
        <span class="bdg bdg-${ord.status==='Delivered'?'grn':ord.status==='Pending'?'ylw':ord.status==='Cancelled'?'red':'blu'}" style="font-size:10px;flex-shrink:0">${ord.status}</span>
      </div>`).join('')||'<div style="color:var(--tx3);font-size:12px;padding:6px 0">No orders yet</div>'}
  `;
  openM('mOutletDetail');
}

// ═══════════════ COLLECTIONS ═══════════════
async function loadCollections() {
  const srch=document.getElementById('colSrch')?.value.toLowerCase()||'';
  const from=document.getElementById('colFrom')?.value;
  const to=document.getElementById('colTo')?.value;
  const {where:wh3}=window.__SF;
  const colDocs=isAdmin()?await sfGet('collections'):await sfGet('collections',[wh3('createdBy','==',CU.uid)]);
  let cols=colDocs.map(d=>({id:d.id,...d.data()}));
  cols.sort((a,b)=>(b.createdAt?.seconds||0)-(a.createdAt?.seconds||0));
  if(srch)cols=cols.filter(c=>outletName(c.outletId).toLowerCase().includes(srch)||c.id.toLowerCase().includes(srch));
  if(from)cols=cols.filter(c=>c.date>=from);
  if(to)cols=cols.filter(c=>c.date<=to);
  const total=cols.reduce((s,c)=>s+c.amount,0);
  const today=todayStr();
  const todayT=cols.filter(c=>c.date===today).reduce((s,c)=>s+c.amount,0);
  const cash=cols.filter(c=>c.mode==='Cash').reduce((s,c)=>s+c.amount,0);
  document.getElementById('colSummary').innerHTML=`
    <div class="cs-card"><div class="cs-v" style="color:var(--acc)">${fmt(total)}</div><div class="cs-l">Total Collected</div></div>
    <div class="cs-card"><div class="cs-v" style="color:var(--grn)">${fmt(todayT)}</div><div class="cs-l">Today's Collection</div></div>
    <div class="cs-card"><div class="cs-v" style="color:var(--blu)">${fmt(cash)}</div><div class="cs-l">Cash Collected</div></div>`;
  const mC={Cash:'bdg-grn','Bank Transfer':'bdg-blu',bKash:'bdg-pur',Nagad:'bdg-acc',Cheque:'bdg-ylw'};
  document.getElementById('colTbody').innerHTML=cols.map(c=>`<tr>
    <td style="font-family:'Syne',sans-serif;font-size:12px;font-weight:700">${c.id}</td>
    <td style="font-size:12px">${outletName(c.outletId)}</td>
    <td style="font-size:12px;color:var(--tx2)">${userName(c.createdBy)}</td>
    <td><span style="font-family:'Syne',sans-serif;font-weight:800;color:var(--grn)">${fmt(c.amount)}</span></td>
    <td><span class="bdg ${mC[c.mode]||'bdg-gry'}">${c.mode}</span></td>
    <td style="font-size:12px;color:var(--tx2)">${c.date}</td>
    <td style="font-size:11px;color:var(--tx2);max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${c.notes||'—'}</td>
    <td>${isAdmin()?`<button class="btn btn-red btn-xs" onclick="delCollection('${c.id}')">🗑</button>`:'—'}</td>
  </tr>`).join('')||'<tr><td colspan="8" style="text-align:center;padding:24px;color:var(--tx3)">No collections found</td></tr>';
}

async function openNewCollection() {
  // Outlets: admin sees all, rep sees only own
  const myOutlets = isAdmin() ? allOutlets : allOutlets.filter(o=>o.createdBy===CU.uid);
  document.getElementById('cOutlet').innerHTML='<option value="">Select outlet...</option>'+
    myOutlets.map(o=>`<option value="${o.id}">${o.name}${o.route?' ['+o.route+']':''}</option>`).join('');
  document.getElementById('cDate').value=todayStr();
  document.getElementById('cAmt').value='';
  document.getElementById('cNotes').value='';
  document.getElementById('pendingBalanceInfo').style.display='none';
  openM('mCol');
}

// Pending balance state
let _pendingAmt = 0;

async function loadOutletPendingBalance(outletId) {
  const info=document.getElementById('pendingBalanceInfo');
  if(!outletId){info.style.display='none';return;}
  // Calculate outstanding: total orders - total collections + approved opening balance
  const [ordD,colD]=await Promise.all([sfGet('orders'),sfGet('collections')]);
  const outlet=allOutlets.find(o=>o.id===outletId)||{};
  const oOrders=ordD.map(d=>d.data()).filter(x=>x.outletId===outletId&&x.status!=='Cancelled').reduce((s,x)=>s+x.total,0);
  const oCols=colD.map(d=>d.data()).filter(x=>x.outletId===outletId).reduce((s,x)=>s+x.amount,0);
  const approvedBal=outlet.balanceStatus==='approved'?outlet.openingBalance:0;
  const outstanding=Math.max(0,oOrders-oCols+approvedBal);
  _pendingAmt=outstanding;
  if(outstanding>0){
    document.getElementById('pendingBalanceText').textContent=`Outstanding balance: ${fmt(outstanding)} (Total Orders: ${fmt(oOrders)} − Collected: ${fmt(oCols)}${approvedBal>0?' + Opening Balance: '+fmt(approvedBal):''})`;
    info.style.display='';
  } else {
    info.style.display='none';
  }
}

function fillPendingAmount() {
  if(_pendingAmt>0){
    document.getElementById('cAmt').value=_pendingAmt.toFixed(2);
    showToast('Amount pre-filled with outstanding balance','info');
  }
}

async function saveCollection() {
  const outletId=document.getElementById('cOutlet').value;
  const amount=parseFloat(document.getElementById('cAmt').value);
  if(!outletId){showToast('Select an outlet','error');return;}
  if(!amount||amount<=0){showToast('Enter valid amount','error');return;}
  const colId='COL-'+uid6();
  await sfAdd('collections',{
    id:colId,outletId,amount,
    mode:document.getElementById('cMode').value,
    date:document.getElementById('cDate').value,
    notes:document.getElementById('cNotes').value,
    createdBy:CU.uid,createdByName:CU.name,
    zoneId:CU.zoneId||null,
    createdAt:window.__SF.serverTimestamp()
  });
  closeM('mCol');
  invalidateDashCache();showToast(`Collection of ${fmt(amount)} recorded 💰`,'success');
  loadCollections();renderDashboard();updateSidebarStats();
  // 🔔 Notify admins
  notifyAdmins('💰 Collection Recorded',`${CU.name} recorded a collection of ${fmt(amount)}`,{tag:'collection-new'});
}

async function delCollection(id) {
  if(!isAdmin()){showToast('Only admin can delete records','error');return;}
  if(isStrictAdmin()){
    if(!await _customConfirm('This collection record will be permanently deleted.', {title:'Delete Record',okText:'Delete',cancelText:'Cancel',danger:true,icon:'🗑️'}))return;
    const cDocs=await sfGet('collections');
    const _cTarget=cDocs.find(d=>d.data().id===id);
    if(!_cTarget){showToast('Record not found','error');return;}
    const _cDocId=_cTarget.id;
    const _cZone=_cTarget.data().zoneId||_ownerZoneFilter||((!isOwner()&&CU.zoneId)?CU.zoneId:null);
    await Promise.all([
      window.__SF.deleteDoc(window.__SF.doc(window.__SF.db,'collections',_cDocId)).catch(()=>{}),
      _cZone?window.__SF.deleteDoc(window.__SF.doc(window.__SF.db,'zones',_cZone,'collections',_cDocId)).catch(()=>{}):Promise.resolve()
    ]);
    showToast('Collection deleted','warn');loadCollections();
  } else {
    await requestDeleteApproval('collection',id,`Collection ${id}`);
  }
}

// ═══════════════ REPORTS ═══════════════
let activeRpt='sales';
function switchRpt(t,el){activeRpt=t;document.querySelectorAll('.rtab').forEach(x=>x.classList.remove('active'));el.classList.add('active');renderReports();}

async function renderReports() {
  const periodVal=document.getElementById('rptPeriod')?.value||'today';
  const cutStr=periodVal==='today'?todayStr():(()=>{const d=new Date();d.setDate(d.getDate()-(parseInt(periodVal)||30));return d.toISOString().split('T')[0];})();
  const periodLbl=periodVal==='today'?'Today':'Last '+periodVal+' Days';

  if(activeRpt==='npvisits'){ await renderNPVisitsRpt(cutStr,periodLbl); return; }

  const [ordSnp,colSnp,attSnp]=await Promise.all([
    sfGet('orders').then(docs=>({docs})),
    sfGet('collections').then(docs=>({docs})),
    sfGet('attendance').then(docs=>({docs}))
  ]);
  const allOrders=ordSnp.docs.map(d=>({id:d.id,...d.data()}));
  const allCols=colSnp.docs.map(d=>d.data());
  const allAtt=attSnp.docs.map(d=>d.data());
  const myOrders=isAdmin()?allOrders:allOrders.filter(o=>o.createdBy===CU.uid);
  const myCols=isAdmin()?allCols:allCols.filter(c=>c.createdBy===CU.uid);
  const myAtt=allAtt.filter(a=>isAdmin()||a.userId===CU.uid);
  const myOutletIds=isAdmin()?null:allOutlets.filter(o=>o.createdBy===CU.uid||o.assignedRepId===CU.uid).map(o=>o.id);

  if(activeRpt==='sales')renderSalesRpt(myOrders.filter(o=>o.date>=cutStr),periodLbl);
  else if(activeRpt==='collection')renderColRpt(myCols.filter(c=>c.date>=cutStr),periodLbl);
  else if(activeRpt==='attendance')renderAttRpt(myAtt.filter(a=>a.date>=cutStr),periodLbl);
  else if(activeRpt==='outlets'){
    const filtOrders=myOrders.filter(o=>o.date>=cutStr);
    const visibleOutlets=myOutletIds?allOutlets.filter(o=>myOutletIds.includes(o.id)):allOutlets;
    renderOutletRpt(filtOrders,visibleOutlets,cutStr,periodLbl);
  }
}

function renderSalesRpt(orders) {
  const total=orders.filter(o=>o.status!=='Cancelled').reduce((s,o)=>s+o.total,0);
  const delivered=orders.filter(o=>o.status==='Delivered').reduce((s,o)=>s+o.total,0);
  const pending=orders.filter(o=>o.status==='Pending').length;
  const cancelled=orders.filter(o=>o.status==='Cancelled').length;
  const wkData={};
  orders.forEach(o=>{const d=new Date(o.date);const wk='W'+Math.ceil(d.getDate()/7)+' '+d.toLocaleString('default',{month:'short'});if(!wkData[wk])wkData[wk]={l:wk,t:0};if(o.status!=='Cancelled')wkData[wk].t+=o.total;});
  const wks=Object.values(wkData).slice(-6);const maxW=Math.max(...wks.map(x=>x.t),1);
  document.getElementById('rptContent').innerHTML=`
    <div class="sgrid">${statC('💵','Total Sales',fmt(total),'','#22c55e')+statC('✅','Delivered',fmt(delivered),'','#22c55e')+statC('⏳','Pending',pending,'','#f59e0b')+statC('❌','Cancelled',cancelled,'','#ef4444')}</div>
    <div class="card"><div class="card-hdr"><div class="card-ttl">📊 Sales by Week</div></div>
      <div class="bchart" style="height:140px">${wks.map(w=>`<div class="bcol-w"><div class="bcol" data-v="${fmt(w.t)}" style="height:${Math.max(6,(w.t/maxW)*130)}px"></div><div class="blbl">${w.l}</div></div>`).join('')}</div>
    </div>
    <div class="card" style="margin-top:18px"><div class="card-hdr"><div class="card-ttl">📦 Status Breakdown</div></div>
      <div style="display:flex;gap:14px;flex-wrap:wrap;margin-top:6px">
        ${['Delivered','Confirmed','Pending','Cancelled'].map(s=>{const c=orders.filter(o=>o.status===s).length;const p=orders.length?Math.round(c/orders.length*100):0;const cl={Delivered:'var(--grn)',Confirmed:'var(--blu)',Pending:'var(--ylw)',Cancelled:'var(--red)'}[s];return`<div style="flex:1;min-width:100px;background:var(--s2);border-radius:var(--r);padding:13px;text-align:center"><div style="font-family:'Syne',sans-serif;font-size:22px;font-weight:800;color:${cl}">${c}</div><div style="font-size:12px;color:var(--tx2);margin:3px 0">${s}</div><div class="pgbar"><div class="pgfill" style="width:${p}%;background:${cl}"></div></div><div style="font-size:10px;color:var(--tx3);margin-top:3px">${p}%</div></div>`;}).join('')}
      </div>
    </div>`;
}

async function renderNPVisitsRpt(cutStr) {
  document.getElementById('rptContent').innerHTML=`<div style="text-align:center;padding:40px;color:var(--tx3)">⏳ Loading NP Visits...</div>`;
  const {where:wv}=window.__SF;
  const visitDocs=isAdmin()?await sfGet('visits'):await sfGet('visits',[wv('createdBy','==',CU.uid)]);
  const today=todayStr();
  // cutStr defaults to today — shows only today's visits by default
  const effectiveCut = cutStr || today;
  const showingToday = effectiveCut === today;
  const visits=visitDocs.map(d=>({id:d.id,...d.data()}))
    .filter(v=>v.date>=effectiveCut && v.date<=today)
    .sort((a,b)=>(b.date||'').localeCompare(a.date||''));
  const reasons={};
  visits.forEach(v=>{if(v.reason){if(!reasons[v.reason])reasons[v.reason]=0;reasons[v.reason]++;}});
  const topReasons=Object.entries(reasons).sort((a,b)=>b[1]-a[1]);
  const periodTxt=showingToday?'Today':effectiveCut===today?'Today':`${effectiveCut} → ${today}`;
  document.getElementById('rptContent').innerHTML=`
    <div style="display:flex;justify-content:flex-end;margin-bottom:10px;gap:6px">
      <button class="btn btn-${showingToday?'primary':'ghost'} btn-sm" onclick="renderNPVisitsRpt('${today}')">📅 Today</button>
      <button class="btn btn-${!showingToday?'primary':'ghost'} btn-sm" onclick="renderNPVisitsRpt(new Date(Date.now()-29*86400000).toISOString().split('T')[0])">📆 Last 30 Days</button>
    </div>
    <div class="sgrid" style="grid-template-columns:repeat(3,1fr)">
      ${statC('📝','Total Visits',visits.length,periodTxt,'#a855f7')+
        statC('🏪','Unique Outlets',[...new Set(visits.map(v=>v.outletId))].length,'Different outlets','#22c55e')+
        statC('👤','Reps Active',[...new Set(visits.map(v=>v.createdBy))].length,'With NP visits','#3b82f6')}
    </div>
    ${topReasons.length?`<div class="card" style="margin-top:14px"><div class="card-hdr"><div class="card-ttl">📊 By Reason</div></div>
      <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:6px">
        ${topReasons.map(([r,c])=>`<div style="background:var(--s2);border-radius:var(--r2);padding:8px 13px;font-size:12px"><span style="font-weight:700;color:var(--pur)">${c}×</span> ${r}</div>`).join('')}
      </div></div>`:''}
    <div class="card" style="margin-top:14px"><div class="card-hdr"><div class="card-ttl">📋 Visit Log</div><span style="font-size:11px;color:var(--tx3)">${periodTxt}</span></div>
      <div class="twrap"><table><thead><tr><th>Date</th><th>Outlet</th><th>Reason</th><th>Rep</th><th>Notes</th><th>Photo</th>${isStrictAdmin()?'<th>Del</th>':''}</tr></thead>
        <tbody>${visits.map(v=>`<tr>
          <td style="font-size:12px">${v.date||'—'}</td>
          <td style="font-size:12px;font-weight:600">${v.outletName||outletName(v.outletId)}</td>
          <td><span class="bdg bdg-pur" style="font-size:10px">${v.reason||'—'}</span></td>
          <td style="font-size:11px;color:var(--tx2)">${v.createdByName||'—'}</td>
          <td style="font-size:11px;color:var(--tx3);max-width:180px">${v.notes||'—'}</td>
          <td>${v.photo?`<img src="${v.photo}" style="width:40px;height:40px;object-fit:cover;border-radius:6px;cursor:pointer" onclick="viewPhoto('${v.photo}')">`:'—'}</td>
          ${isStrictAdmin()?`<td><button class="btn btn-red btn-xs" onclick="deleteNPVisit('${v.id}','${(v.outletName||'outlet').replace(/'/g,"\\'")}')">🗑</button></td>`:''}`).join('')||`<tr><td colspan="${isStrictAdmin()?7:6}" style="text-align:center;padding:20px;color:var(--tx3)">No visits recorded</td></tr>`}
        </tbody></table></div>
    </div>`;
}
function renderColRpt(cols) {
  const total=cols.reduce((s,c)=>s+c.amount,0);
  const cash=cols.filter(c=>c.mode==='Cash').reduce((s,c)=>s+c.amount,0);
  const digital=cols.filter(c=>c.mode!=='Cash').reduce((s,c)=>s+c.amount,0);
  const byOu={};allOutlets.forEach(o=>{byOu[o.id]={n:o.name,t:0};});
  cols.forEach(c=>{if(byOu[c.outletId])byOu[c.outletId].t+=c.amount;});
  const top=Object.values(byOu).sort((a,b)=>b.t-a.t).filter(o=>o.t>0);
  document.getElementById('rptContent').innerHTML=`
    <div class="sgrid" style="grid-template-columns:repeat(3,1fr)">${statC('💰','Total',fmt(total),'','#22c55e')+statC('💵','Cash',fmt(cash),'','#22c55e')+statC('📱','Digital',fmt(digital),'','#3b82f6')}</div>
    <div class="card"><div class="card-hdr"><div class="card-ttl">🏪 By Outlet</div></div>
      ${top.map(o=>`<div style="margin-bottom:12px"><div style="display:flex;justify-content:space-between;margin-bottom:4px"><span style="font-size:13px;font-weight:600">${o.n}</span><span style="font-family:'Syne',sans-serif;font-weight:700;color:var(--grn)">${fmt(o.t)}</span></div><div class="pgbar"><div class="pgfill" style="width:${top[0].t?Math.round(o.t/top[0].t*100):0}%;background:#22c55e"></div></div></div>`).join('')||'<div style="color:var(--tx3)">No data</div>'}
    </div>`;
}

function renderAttRpt(att) {
  const m=todayStr().slice(0,7);
  const thisM=att.filter(a=>a.month===m);
  const present=thisM.length;
  const totalMins=thisM.filter(a=>a.checkInTime&&a.checkOutTime).reduce((s,a)=>s+calcMins(a.checkInTime,a.checkOutTime),0);
  document.getElementById('rptContent').innerHTML=`
    <div class="sgrid" style="grid-template-columns:repeat(3,1fr)">${statC('✅','Present Days',present,'This month','#22c55e')+statC('⏱','Total Hours',`${Math.floor(totalMins/60)}h`,'','#3b82f6')+statC('📊','Avg/Day',`${Math.floor(totalMins/Math.max(present,1)/60)}h ${Math.floor(totalMins/Math.max(present,1)%60)}m`,'','#22c55e')}</div>
    <div class="card"><div class="card-hdr"><div class="card-ttl">📋 This Month Log</div></div>
      <div class="twrap"><table><thead><tr><th>Date</th><th>Rep</th><th>In</th><th>Out</th><th>Hrs</th></tr></thead>
        <tbody>${thisM.sort((a,b)=>b.date.localeCompare(a.date)).map(r=>`<tr>
          <td style="font-size:12px">${r.date}</td><td style="font-size:12px">${r.userName||'—'}</td>
          <td style="font-size:12px">${r.checkInTime||'—'}</td><td style="font-size:12px">${r.checkOutTime||'—'}</td>
          <td style="font-size:12px">${r.checkInTime&&r.checkOutTime?`${Math.floor(calcMins(r.checkInTime,r.checkOutTime)/60)}h ${calcMins(r.checkInTime,r.checkOutTime)%60}m`:'—'}</td>
        </tr>`).join('')||'<tr><td colspan="5" style="text-align:center;color:var(--tx3);padding:16px">No records</td></tr>'}
        </tbody></table></div>
    </div>`;
}

function renderOutletRpt(orders,visibleOutlets,cutStr,periodLbl) {
  const today=todayStr();
  const lbl=periodLbl||'Today';
  const outlets=visibleOutlets||allOutlets;
  const rpt=outlets.map(o=>({...o,c:orders.filter(x=>x.outletId===o.id).length,s:orders.filter(x=>x.outletId===o.id&&x.status!=='Cancelled').reduce((t,x)=>t+x.total,0)})).sort((a,b)=>b.s-a.s);

  // New outlets added within the selected period
  const newOutlets=outlets.filter(o=>{
    const d=(o.createdAt||'').slice(0,10);
    return d>=(cutStr||today)&&d<=today;
  });

  // Per-rep breakdown of new outlets
  const repMap={};
  newOutlets.forEach(o=>{
    const uid=o.createdBy||'unknown';
    const name=o.createdByName||'Unknown Rep';
    if(!repMap[uid]) repMap[uid]={name,count:0,outlets:[]};
    repMap[uid].count++;
    repMap[uid].outlets.push(o);
  });
  const repRows=Object.values(repMap).sort((a,b)=>b.count-a.count);

  // Scroll targets — IDs for each card
  const scrollTo=id=>`document.getElementById('${id}')?.scrollIntoView({behavior:'smooth',block:'start'})`;

  document.getElementById('rptContent').innerHTML=`
    <div class="sgrid" style="grid-template-columns:repeat(2,1fr)">
      ${statC('🏪','Total Outlets',outlets.length,'All registered',  '#a855f7',scrollTo('orpt-perf'))}
      ${statC('🆕','New ('+lbl+')',newOutlets.length,'Added',         '#3b82f6',scrollTo('orpt-new'))}
      ${statC('📦','Active',rpt.filter(o=>o.c>0).length,'With orders','#22c55e',scrollTo('orpt-perf'))}
      ${statC('💵','Avg Sales',fmt(rpt.reduce((s,o)=>s+o.s,0)/Math.max(rpt.length,1)),'per outlet','#f59e0b',scrollTo('orpt-perf'))}
    </div>

    <!-- New Outlets card with per-rep breakdown -->
    <div class="card" id="orpt-new" style="margin-bottom:14px">
      <div class="card-hdr">
        <div class="card-ttl">🆕 New Outlets — ${lbl}</div>
        <span style="font-size:11px;color:var(--tx3)">${newOutlets.length} outlet${newOutlets.length!==1?'s':''}</span>
      </div>
      ${newOutlets.length===0
        ? `<div style="color:var(--tx3);font-size:12px;padding:8px 0">No new outlets in this period</div>`
        : `<!-- Per-rep summary -->
           <div style="display:flex;flex-direction:column;gap:0">
             ${repRows.map(rep=>`
               <details style="border-bottom:1px solid var(--bdr)">
                 <summary style="display:flex;align-items:center;gap:10px;padding:9px 2px;cursor:pointer;list-style:none;outline:none">
                   <div style="width:30px;height:30px;border-radius:8px;background:var(--s3);display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:800;color:var(--tx2);flex-shrink:0">${rep.name[0]}</div>
                   <div style="flex:1;min-width:0">
                     <div style="font-size:13px;font-weight:700">${rep.name}</div>
                     <div style="font-size:10px;color:var(--tx3)">Added ${rep.count} outlet${rep.count!==1?'s':''}</div>
                   </div>
                   <span style="font-family:'Syne',sans-serif;font-size:16px;font-weight:800;color:var(--blu)">${rep.count}</span>
                 </summary>
                 <div style="padding:4px 0 10px 40px;display:flex;flex-direction:column;gap:5px">
                   ${rep.outlets.map(o=>`
                     <div style="display:flex;align-items:center;gap:8px;cursor:pointer" onclick="viewOutlet('${o.id}')">
                       <div style="width:28px;height:28px;border-radius:7px;overflow:hidden;flex-shrink:0;background:${o.color||'#22c55e'};display:flex;align-items:center;justify-content:center;font-weight:800;color:#fff;font-size:11px">
                         ${o.signboardPhoto?`<img src="${o.signboardPhoto}" style="width:100%;height:100%;object-fit:cover">`:`${o.name[0]}`}
                       </div>
                       <div style="flex:1;min-width:0">
                         <div style="font-size:12px;font-weight:600">${o.name}</div>
                         <div style="font-size:10px;color:var(--tx3)">${o.type}${o.area?' · '+o.area:''}</div>
                       </div>
                       <span style="font-size:10px;color:var(--tx3);flex-shrink:0">${(o.createdAt||'').slice(0,10)}</span>
                     </div>`).join('')}
                 </div>
               </details>`).join('')}
           </div>`}
    </div>

    <!-- Performance table -->
    <div class="card" id="orpt-perf">
      <div class="card-hdr">
        <div class="card-ttl">🏆 Performance</div>
        <span style="font-size:11px;color:var(--tx3)">${lbl}</span>
      </div>
      <div class="twrap"><table><thead><tr><th>Outlet</th><th>Type</th><th>Orders</th><th>Sales</th><th>Rank</th></tr></thead>
        <tbody>${rpt.map((o,i)=>`<tr style="cursor:pointer" onclick="viewOutlet('${o.id}')">
          <td><div style="display:flex;align-items:center;gap:7px">
            <div style="width:26px;height:26px;border-radius:6px;overflow:hidden;flex-shrink:0;background:${o.color||'#22c55e'};display:flex;align-items:center;justify-content:center;font-weight:800;color:#fff;font-size:11px">
              ${o.signboardPhoto?`<img src="${o.signboardPhoto}" style="width:100%;height:100%;object-fit:cover">`:`${o.name[0]}`}
            </div>
            <span style="font-weight:600;font-size:13px">${o.name}</span>
          </div></td>
          <td><span class="bdg bdg-blu">${o.type}</span></td>
          <td>${o.c}</td>
          <td><span style="font-family:'Syne',sans-serif;font-weight:700;color:var(--acc)">${fmt(o.s)}</span></td>
          <td>${['🥇','🥈','🥉'][i]||'#'+(i+1)}</td>
        </tr>`).join('')}
        </tbody></table></div>
    </div>`;
}

// ═══════════════ USERS ═══════════════
async function loadUsers() {
  if(!isAdmin()){showToast('Access denied','error');return;}
  // Users collection is shared — owner sees all, others see only their zone
  const uSnpAll = await window.__SF.getDocs(rootCol('users'));
  const allFetched = uSnpAll.docs.map(d=>({...d.data()}));
  const users = isOwner()
    ? allFetched
    : allFetched.filter(u=>u.isOwner||u.zoneId===CU.zoneId||u.uid===CU.uid);
  const roleLabel={admin:'Admin',sub_admin:'Sub Admin',sales_rep:'Sales Rep',delivery_man:'Delivery Man'};
  const roleBadge={admin:'bdg-acc',sub_admin:'bdg-pur',sales_rep:'bdg-blu',delivery_man:'bdg-grn'};
  document.getElementById('usersTbody').innerHTML=users.map(u=>{
    const isMe=u.uid===CU.uid;
    const isOwnerUser=u.isOwner===true;
    const isAdminRole=u.role==='admin';
    const canToggle=!isMe&&!isOwnerUser&&!(isAdminRole&&!isStrictAdmin());
    const canDelete=isStrictAdmin()&&!isOwnerUser&&!isMe;
    const uZone=allZones.find(z=>z.id===u.zoneId);
    const zonePill=isOwner()
      ?(uZone?`<span class="bdg" style="font-size:9px;background:rgba(34,197,94,.12);color:var(--acc)">${uZone.name}</span>`
             :'<span style="font-size:10px;color:var(--tx3)">—</span>')
      :'';
    return`<tr>
    <td><div style="display:flex;align-items:center;gap:9px"><div class="ava ava-sm">${u.name[0]}</div>
      <div><span style="font-size:13px;font-weight:600">${u.name}</span>${isOwnerUser?'<span class="bdg bdg-acc" style="font-size:9px;margin-left:5px">👑 Owner</span>':''}</div></div></td>
    <td style="font-size:12px;color:var(--tx2)">${u.email}</td>
    <td><span class="bdg ${roleBadge[u.role]||'bdg-gry'}">${roleLabel[u.role]||u.role}</span></td>
    <td style="font-size:12px;color:var(--tx2)">${u.phone||'—'}</td>
    <td>${zonePill}</td>
    <td><span class="bdg ${u.status==='active'?'bdg-grn':'bdg-red'}">${u.status||'active'}</span></td>
    <td><div style="display:flex;gap:5px;flex-wrap:wrap">
      ${isMe?'<span style="font-size:11px;color:var(--tx3)">You</span>':''}
      ${canToggle?`<button class="btn btn-${u.status==='active'?'red':'grn'} btn-xs" onclick="toggleUser('${u.uid}','${u.status||'active'}')">${u.status==='active'?'Disable':'Enable'}</button>`:''}
      ${isOwnerUser&&!isMe?'<span style="font-size:10px;color:var(--ylw)">👑 Protected</span>':''}
      <button class="btn btn-ghost btn-xs" onclick="openAdminResetPassword('${u.name}','${u.email}')" title="Send password reset email">🔑</button>
      <button class="btn btn-ghost btn-xs" onclick="showUserId('${u.uid}','${u.name}','${u.role}')" title="View User ID">🪪</button>
      ${canDelete?`<button class="btn btn-red btn-xs" onclick="deleteUser('${u.uid}','${u.name}')" title="Delete user permanently">🗑</button>`:''}
      ${isOwner()&&!isOwnerUser&&!isMe?`<button class="btn btn-ghost btn-xs" onclick="reassignUserZone('${u.uid}','${u.name.replace(/'/g,'')}')" title="Change zone">🗂️</button>`:''}
      ${isAdmin()&&u.role==='sales_rep'?`<button class="btn btn-ghost btn-xs" onclick="viewRepDevices('${u.uid}','${u.name.replace(/'/g,'')}')" title="Manage trusted devices">📱</button>`:''}
    </div></td>
  </tr>`;}).join('');
}

function openNewUser() {
  ['uName','uEmail','uPwd','uPhone'].forEach(id=>document.getElementById(id).value='');
  document.getElementById('uRole').value='sales_rep';
  document.getElementById('uEditId').value='';
  // Zone dropdown — owner sees all zones; zone-users auto-assign their zone
  const uZoneSel=document.getElementById('uZone');
  const uZoneRow=document.getElementById('uZoneRow');
  if(uZoneSel){
    if(isOwner()){
      uZoneSel.innerHTML='<option value="">No Zone</option>'+
        allZones.map(z=>`<option value="${z.id}">${z.name}</option>`).join('');
      if(uZoneRow)uZoneRow.style.display='';
    } else {
      // Zone admin: auto-assign to their zone, hide the picker
      const myZone=allZones.find(z=>z.id===CU.zoneId);
      uZoneSel.innerHTML=`<option value="${CU.zoneId||''}" selected>${myZone?myZone.name:(CU.zoneId||'—')}</option>`;
      if(uZoneRow)uZoneRow.style.display='none';
    }
  }
  openM('mUser');
}

async function saveUser() {
  if(!isAdmin()){showToast('Only admin can create users','error');return;}
  const name=document.getElementById('uName').value.trim();
  const email=document.getElementById('uEmail').value.trim();
  const pwd=document.getElementById('uPwd').value;
  const role=document.getElementById('uRole').value;
  const phone=document.getElementById('uPhone').value.trim();
  if(!name||!email||!pwd){showToast('Name, email and password required','error');return;}
  if(pwd.length<6){showToast('Password must be at least 6 characters','error');return;}
  const adminEmail=CU.email;
  const adminUid=CU.uid;
  const adminPwd=prompt('Enter YOUR admin password to confirm user creation:');
  if(!adminPwd){showToast('Admin password required to create user','warn');return;}
  try {
    // Determine zoneId: owner picks from dropdown; zone admin assigns their own zone
    const uZoneSel=document.getElementById('uZone');
    const assignedZoneId=isOwner()?(uZoneSel?.value||null):(CU.zoneId||null);
    const assignedZone=allZones.find(z=>z.id===assignedZoneId);
    const cred=await window.__SF.createUserWithEmailAndPassword(window.__SF.auth,email,pwd);
    // Users always stored at root — use rootDocRef
    await window.__SF.setDoc(rootDocRef('users',cred.user.uid),{
      uid:cred.user.uid,name,email,role,phone,status:'active',
      zoneId:assignedZoneId,
      zoneName:assignedZone?.name||null,
      createdBy:adminUid,createdAt:new Date().toISOString()
    });
    await window.__SF.signInWithEmailAndPassword(window.__SF.auth,adminEmail,adminPwd);
    closeM('mUser');
    showToast(`User ${name} created as ${role.replace('_',' ')} ✅`,'success');
    await loadCachedData();loadUsers();
  } catch(err) {
    const msgs={
      'auth/email-already-in-use':'Email already registered.',
      'auth/weak-password':'Password too weak.',
      'auth/wrong-password':'Wrong admin password — you have been signed out. Please log in again.',
      'auth/invalid-credential':'Wrong admin password — please log in again.'
    };
    showToast(msgs[err.code]||err.message,'error');
  }
}

async function toggleUser(uid,currentStatus) {
  if(!isAdmin())return;
  // Find target user
  const target=allUsers.find(u=>u.uid===uid);
  if(target?.isOwner){showToast('The Owner account cannot be disabled','error');return;}
  if(target?.role==='admin'&&!isStrictAdmin()){showToast('Only the Owner/Admin can disable another admin','error');return;}
  const newStatus=currentStatus==='active'?'disabled':'active';
  await window.__SF.updateDoc(rootDocRef('users',uid),{status:newStatus});
  showToast(`User ${newStatus==='active'?'enabled':'disabled'}`,'info');
  loadUsers();
}

// ═══════════════ SUPERADMIN (Owner) DELETE FUNCTIONS ═══════════════
async function deleteUser(uid, name) {
  if(!isStrictAdmin()){showToast('Only superadmin can delete users','error');return;}
  const target=allUsers.find(u=>u.uid===uid);
  if(target?.isOwner){showToast('The Owner account cannot be deleted','error');return;}
  if(uid===CU.uid){showToast('You cannot delete your own account','error');return;}
  if(!await _customConfirm(`"${name}" will be permanently removed from the system.\n\nTheir Firebase Auth account must be deleted separately in Firebase Console.`, {title:'Delete User',okText:'Delete',cancelText:'Cancel',danger:true,icon:'⚠️'}))return;
  try{
    await window.__SF.deleteDoc(rootDocRef('users',uid));
    showToast(`User "${name}" deleted from system`,'warn');
    await loadCachedData();loadUsers();
  }catch(e){showToast('Failed to delete user: '+e.message,'error');}
}

async function deleteOrder(docId, label, zoneId) {
  if(!isStrictAdmin()){showToast('Superadmin only','error');return;}
  if(!await _customConfirm(`${label} will be permanently deleted.`, {title:'Delete Order',okText:'Delete',cancelText:'Cancel',danger:true,icon:'⚠️'}))return;
  try{
    const effectiveZone = zoneId || _ownerZoneFilter || ((!isOwner() && CU.zoneId) ? CU.zoneId : null);
    const dels = [window.__SF.deleteDoc(window.__SF.doc(window.__SF.db,'orders',docId)).catch(e=>console.warn('[deleteOrder] root:',e.message))];
    if(effectiveZone) dels.push(window.__SF.deleteDoc(window.__SF.doc(window.__SF.db,'zones',effectiveZone,'orders',docId)).catch(e=>console.warn('[deleteOrder] zone:',e.message)));
    await Promise.all(dels);
    showToast(label + ' permanently deleted','warn');
    loadOrders();renderDashboard();updateBadges();
  }catch(e){showToast('Failed: '+e.message,'error');}
}

async function deleteAttendanceRecord(docId, label) {
  if(!isStrictAdmin()){showToast('Superadmin only','error');return;}
  if(!await _customConfirm(`Attendance record for ${label} will be permanently deleted.`, {title:'Delete Attendance',okText:'Delete',cancelText:'Cancel',danger:true,icon:'🗑️'}))return;
  try{
    let _aZone=_ownerZoneFilter||((!isOwner()&&CU.zoneId)?CU.zoneId:null);
    try{const _as=await window.__SF.getDoc(window.__SF.doc(window.__SF.db,'attendance',docId));if(_as.exists()&&_as.data()._zoneId)_aZone=_as.data()._zoneId;}catch(_){}
    await Promise.all([
      window.__SF.deleteDoc(window.__SF.doc(window.__SF.db,'attendance',docId)).catch(()=>{}),
      _aZone?window.__SF.deleteDoc(window.__SF.doc(window.__SF.db,'zones',_aZone,'attendance',docId)).catch(()=>{}):Promise.resolve()
    ]);
    showToast('Attendance record deleted','warn');
    loadAttHistory();
  }catch(e){showToast('Failed: '+e.message,'error');}
}

async function deleteNPVisit(docId, label) {
  if(!isStrictAdmin()){showToast('Superadmin only','error');return;}
  if(!await _customConfirm(`NP visit record for ${label} will be permanently deleted.`, {title:'Delete Visit',okText:'Delete',cancelText:'Cancel',danger:true,icon:'🗑️'}))return;
  try{
    await sfDelete('visits',docId);
    showToast('NP visit deleted','warn');
  }catch(e){showToast('Failed: '+e.message,'error');}
}

function showUserId(uid, name, role) {
  if(!isAdmin()){showToast('Admin only','error');return;}
  const roleLabel={admin:'Admin',sub_admin:'Sub Admin',sales_rep:'Sales Rep',delivery_man:'Delivery Man'};
  const roleBadge={admin:'var(--acc)',sub_admin:'var(--pur)',sales_rep:'var(--blu)',delivery_man:'var(--grn)'};
  // Build inline popup over the page
  const existing=document.getElementById('uidPopup');
  if(existing)existing.remove();
  const el=document.createElement('div');
  el.id='uidPopup';
  el.style.cssText='position:fixed;inset:0;z-index:9000;background:rgba(0,0,0,.65);display:flex;align-items:center;justify-content:center;padding:20px;backdrop-filter:blur(4px)';
  el.innerHTML=`
    <div style="background:var(--s1);border:1px solid var(--bdr);border-radius:var(--r);padding:24px;max-width:420px;width:100%;box-shadow:var(--sh)">
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:18px">
        <div class="ava" style="background:${roleBadge[role]||'var(--tx3)'}">${name[0]}</div>
        <div>
          <div style="font-family:'Syne',sans-serif;font-size:15px;font-weight:700">${name}</div>
          <div style="font-size:11px;color:var(--tx3)">${roleLabel[role]||role}</div>
        </div>
      </div>
      <div style="margin-bottom:6px;font-size:11px;color:var(--tx3);font-weight:600;letter-spacing:.4px;text-transform:uppercase">User ID (UID)</div>
      <div style="background:var(--s2);border:1px solid var(--bdr);border-radius:var(--r2);padding:12px 14px;margin-bottom:14px;display:flex;align-items:center;gap:10px">
        <code style="flex:1;font-size:12px;color:var(--acc);word-break:break-all;font-family:monospace;line-height:1.5">${uid}</code>
        <button id="uidCopyBtn" onclick="
          navigator.clipboard.writeText('${uid}').then(()=>{
            document.getElementById('uidCopyBtn').textContent='✅';
            setTimeout(()=>document.getElementById('uidCopyBtn').textContent='📋',1500);
          }).catch(()=>{showToast('Copy failed — long-press to select manually','warn')})
        " style="background:var(--s3);border:1px solid var(--bdr);border-radius:var(--r2);padding:7px 10px;cursor:pointer;color:var(--tx);font-size:14px;flex-shrink:0" title="Copy UID">📋</button>
      </div>
      <div style="font-size:11px;color:var(--tx3);margin-bottom:18px">
        💡 Use this UID to reference this user in Firestore queries, route assignments, or integrations.
      </div>
      <button onclick="document.getElementById('uidPopup').remove()"
        style="width:100%;padding:11px;background:var(--s2);border:1px solid var(--bdr);border-radius:var(--r2);cursor:pointer;color:var(--tx2);font-size:13px;font-weight:600">
        Close
      </button>
    </div>`;
  el.addEventListener('click',e=>{if(e.target===el)el.remove();});
  document.body.appendChild(el);
}

// ═══════════════ PRODUCTS ═══════════════
// ═══════════════ ZONE PRODUCT PRICE OVERRIDE ═══════════════

// Owner can set overrides for any specific zone when viewing it via zone filter
async function openZonePriceOverrideForZone(productId, zoneId) {
  const p=allProducts.find(x=>x.id===productId);
  if(!p)return;
  let ov={};
  try{
    const s=await window.__SF.getDoc(window.__SF.doc(db(),`zones/${zoneId}/productOverrides/${productId}`));
    if(s.exists())ov=s.data();
  }catch(e){}
  const zName=(allZones.find(z=>z.id===zoneId)||{}).name||zoneId;
  document.getElementById('zpoProductId').value=productId+'|'+zoneId; // encode zoneId
  document.getElementById('zpoProductName').textContent=p.name+' ('+zName+')';
  document.getElementById('zpoBasePrice').textContent=`Master price: ${fmt(p.price)}`;
  document.getElementById('zpoPrice').value=ov.price??p.price??'';
  document.getElementById('zpoCost').value=ov.cost??p.cost??'';
  document.getElementById('zpoStock').value=ov.stockStatus??p.stockStatus??'in_stock';
  openM('mZonePriceOverride');
}

async function openZonePriceOverride(productId) {
  if(!isAdmin()||isOwner())return;
  const p=allProducts.find(x=>x.id===productId);
  if(!p){showToast('Product not found','error');return;}
  let ov={};
  try{
    const s=await window.__SF.getDoc(window.__SF.doc(db(),`zones/${CU.zoneId}/productOverrides/${productId}`));
    if(s.exists())ov=s.data();
  }catch(e){}
  document.getElementById('zpoProductId').value=productId;
  document.getElementById('zpoProductName').textContent=p.name;
  document.getElementById('zpoBasePrice').textContent=`Master price: ${fmt(p.price)}`;
  document.getElementById('zpoPrice').value=ov.price??p.price??'';
  document.getElementById('zpoCost').value=ov.cost??p.cost??'';
  document.getElementById('zpoStock').value=ov.stockStatus??p.stockStatus??'in_stock';
  openM('mZonePriceOverride');
}

async function saveZonePriceOverride() {
  const rawId=document.getElementById('zpoProductId').value;
  // rawId may be "productId" or "productId|zoneId" (when owner sets for a specific zone)
  const [productId, encodedZone] = rawId.includes('|') ? rawId.split('|') : [rawId, null];
  const zid = encodedZone || CU.zoneId;
  const price=parseFloat(document.getElementById('zpoPrice').value);
  const cost=parseFloat(document.getElementById('zpoCost').value)||0;
  const stockStatus=document.getElementById('zpoStock').value;
  if(!productId){showToast('Error: no product','error');return;}
  if(!zid){showToast('Error: no zone','error');return;}
  if(!price||price<=0){showToast('Enter a valid price','error');return;}
  try{
    const now=new Date().toISOString();
    const ovRef=window.__SF.doc(db(),`zones/${zid}/productOverrides/${productId}`);
    await window.__SF.setDoc(ovRef,{price,cost,stockStatus,updatedAt:now,updatedBy:CU.uid,updatedByName:CU.name},{merge:true});
    const zpRef=window.__SF.doc(db(),`zones/${zid}/products/${productId}`);
    await window.__SF.setDoc(zpRef,{price,cost,stockStatus,updatedAt:now},{merge:true});
    showToast('Zone price saved ✅','success');
    closeM('mZonePriceOverride');
    invalidateCache();await loadCachedData(true);loadProducts();
  }catch(e){showToast('Save failed: '+e.message,'error');}
}

async function clearZonePriceOverride() {
  const rawId=document.getElementById('zpoProductId').value;
  const [productId, encodedZone] = rawId.includes('|') ? rawId.split('|') : [rawId, null];
  const zid = encodedZone || CU.zoneId;
  if(!productId||!zid)return;
  if(!await _customConfirm('Remove zone override?\n\nProduct will use master catalog price/stock.', {title:'Remove Override',okText:'Remove',cancelText:'Cancel',danger:true,icon:'↩️'}))return;
  try{
    await window.__SF.deleteDoc(window.__SF.doc(db(),`zones/${zid}/productOverrides/${productId}`));
    const master=allProducts.find(x=>x.id===productId);
    if(master){
      const zpRef=window.__SF.doc(db(),`zones/${zid}/products/${productId}`);
      await window.__SF.setDoc(zpRef,{price:master.price,cost:master.cost||0,stockStatus:master.stockStatus||'in_stock'},{merge:true});
    }
    showToast('Zone override removed','info');
    closeM('mZonePriceOverride');
    invalidateCache();await loadCachedData(true);loadProducts();
  }catch(e){showToast('Error: '+e.message,'error');}
}

// ═══════════════ MERGE DUPLICATE PRODUCTS ═══════════════

let _mergeGroups=[];

async function openMergeProducts() {
  if(!isAdmin()){showToast('Admin only','error');return;}
  const body=document.getElementById('mMergeBody');
  if(!body)return;
  body.innerHTML='<div style="text-align:center;padding:30px;color:var(--tx3)">🔍 Scanning for duplicate products…</div>';
  openM('mMergeProducts');
  await scanMergeProducts();
}

async function scanMergeProducts() {
  const body = document.getElementById('mMergeBody');
  try {
    // ── Step 1: collect all products from root + zone subcollections ──────────
    // Key: docId → best product data. We track all sources per doc ID.
    const rootMap  = {}; // docId → data (from root products)
    const zoneMap  = {}; // "zoneId::docId" → data (from zone subcollections, legacy)

    // Fire root + ALL zone reads simultaneously
    const zonesToScan = isOwner() ? allZones : allZones.filter(z => z.id === CU.zoneId);
    const [rootSnap, ...zoneSnaps] = await Promise.all([
      window.__SF.getDocs(rootCol('products')),
      ...zonesToScan.map(z =>
        window.__SF.getDocs(window.__SF.collection(db(), `zones/${z.id}/products`))
          .catch(() => ({ docs: [] }))
      )
    ]);
    rootSnap.docs.forEach(d => {
      rootMap[d.id] = { id: d.id, ...d.data(), _source: 'root' };
    });
    zoneSnaps.forEach((zSnap, zi) => {
      const z = zonesToScan[zi];
      (zSnap.docs || []).forEach(d => {
        if (!rootMap[d.id]) {
          const key = `${z.id}::${d.id}`;
          zoneMap[key] = { id: d.id, ...d.data(), _source: 'zone', _zoneId: z.id, _zoneName: z.name || z.id, _legacyKey: key };
        }
      });
    });

    // ── Step 2: merge into one pool and group by normalised name ──────────────
    const allPool = [...Object.values(rootMap), ...Object.values(zoneMap)];
    const byName  = {};
    allPool.forEach(p => {
      const k = (p.name || '').toLowerCase().trim();
      if (!byName[k]) byName[k] = [];
      byName[k].push(p);
    });

    // ── Step 3: keep only groups with more than one distinct doc ──────────────
    _mergeGroups = Object.entries(byName)
      .filter(([, g]) => g.length > 1)
      .map(([name, group]) => ({ name, group }));

    if (!_mergeGroups.length) {
      body.innerHTML = `<div style="text-align:center;padding:30px;color:var(--tx3)">
        ✅ No duplicate products found.<br>
        <span style="font-size:11px">Scanned ${allPool.length} product(s) across root catalog${zonesToScan.length ? ' + ' + zonesToScan.length + ' zone(s)' : ''}.</span>
      </div>`;
      return;
    }

    // ── Step 4: render picker UI ──────────────────────────────────────────────
    body.innerHTML = `
      <div style="font-size:12px;color:var(--tx2);margin-bottom:14px">
        Found <strong>${_mergeGroups.length}</strong> duplicate group(s) across ${allPool.length} total products.
        Select the <strong>master</strong> to keep for each group — others will be removed and their zone pricing preserved as overrides.
      </div>
      ${_mergeGroups.map((g, gi) => `
        <div style="background:var(--s2);border:1px solid var(--bdr);border-radius:10px;padding:14px;margin-bottom:12px">
          <div style="font-family:'Syne',sans-serif;font-size:13px;font-weight:700;margin-bottom:10px">
            📦 ${g.name}
            <span style="font-size:10px;color:var(--tx3);font-weight:400">(${g.group.length} copies)</span>
          </div>
          ${g.group.map((p, pi) => `
            <label style="display:flex;align-items:center;gap:10px;padding:8px;border-radius:8px;border:1px solid var(--bdr);background:var(--s1);margin-bottom:6px;cursor:pointer">
              <input type="radio" name="mg_${gi}" value="${pi}" ${pi === 0 ? 'checked' : ''} style="accent-color:var(--acc);flex-shrink:0">
              <div style="flex:1;min-width:0">
                <div style="font-size:12px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${p.name}</div>
                <div style="font-size:10px;color:var(--tx3)">
                  ${p._source === 'root' ? '🌐 Global Catalog' : '📍 Zone: ' + p._zoneName}
                  · RM ${(p.price || 0).toFixed(2)} · ${p.stockStatus === 'out_of_stock' ? '❌ Out of Stock' : '✅ In Stock'}
                  ${p.sku ? '· SKU: ' + p.sku : ''}
                </div>
              </div>
              <span style="font-size:10px;font-weight:700;padding:2px 6px;border-radius:4px;background:${p._source === 'root' ? 'rgba(34,197,94,0.15)' : 'rgba(245,158,11,0.15)'};color:${p._source === 'root' ? 'var(--grn)' : 'var(--ylw)'}">
                ${p._source === 'root' ? '✅ Global' : '⚠️ Zone only'}
              </span>
            </label>
          `).join('')}
        </div>
      `).join('')}
      <div style="display:flex;justify-content:flex-end;padding-top:4px">
        <button class="btn btn-primary btn-sm" onclick="executeMergeAll()">🔀 Merge All Groups</button>
      </div>`;

  } catch(e) {
    body.innerHTML = `<div style="text-align:center;padding:24px;color:var(--red)">❌ Error scanning products: ${e.message}</div>`;
    console.error('[scanMergeProducts]', e);
  }
}

async function executeMergeAll() {
  if (!isAdmin()) return;
  const body = document.getElementById('mMergeBody');

  // Snapshot radio selections BEFORE touching DOM
  const keepIdxByGroup = _mergeGroups.map((_, gi) => {
    const sel = document.querySelector(`input[name="mg_${gi}"]:checked`);
    return sel ? parseInt(sel.value) : 0;
  });

  const total = _mergeGroups.length;
  let merged = 0, errors = 0;

  body.innerHTML = `
    <div style="padding:8px 0">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <span style="font-size:13px;font-weight:600;color:var(--tx2)" id="_mpLabel">Building merge plan…</span>
        <span style="font-size:12px;font-weight:700;color:var(--acc)" id="_mpPct">0%</span>
      </div>
      <div style="background:var(--s2);border-radius:20px;height:10px;overflow:hidden;border:1px solid var(--bdr);margin-bottom:8px">
        <div id="_mpBar" style="height:100%;background:linear-gradient(90deg,var(--acc),#15803d);border-radius:20px;width:0%;transition:width .15s ease"></div>
      </div>
      <div style="font-size:11px;color:var(--tx3);text-align:center" id="_mpSub">0 / ${total} groups</div>
    </div>`;

  const setProgress = (done, label) => {
    const pct = Math.round((done / total) * 100);
    const g = id => document.getElementById(id);
    if(g('_mpBar')) g('_mpBar').style.width = pct + '%';
    if(g('_mpPct')) g('_mpPct').textContent = pct + '%';
    if(g('_mpLabel')) g('_mpLabel').textContent = label || 'Merging…';
    if(g('_mpSub')) g('_mpSub').textContent = `${done} / ${total} groups`;
  };

  // Phase 1: promote zone-only masters to root (sequential — creates new IDs)
  const canonicalIds = new Array(total);
  const now = new Date().toISOString();
  for (let gi = 0; gi < total; gi++) {
    const master = _mergeGroups[gi].group[keepIdxByGroup[gi]];
    if (master._source === 'root') {
      canonicalIds[gi] = master.id;
    } else {
      try {
        const { id: _x, _source, _zoneId, _zoneName, _legacyKey, ...masterData } = master;
        const newRef = window.__SF.doc(window.__SF.collection(db(), 'products'));
        await window.__SF.setDoc(newRef, { ...masterData, promotedAt: now });
        canonicalIds[gi] = newRef.id;
      } catch(e) { console.error('[promote]', gi, e); canonicalIds[gi] = master.id; errors++; }
    }
    if (gi % 20 === 0) { setProgress(0, `Promoting masters… ${gi}/${total}`); await new Promise(r=>setTimeout(r,0)); }
  }

  setProgress(0, 'Writing batches…');
  await new Promise(r => setTimeout(r, 0));

  // Phase 2: batch all overrides + deletes (Firestore writeBatch = 1 round-trip per 400 ops)
  const MAX_BATCH = 400;
  let batch = window.__SF.writeBatch(db());
  let batchOps = 0, batchCount = 0;

  const flushBatch = async () => {
    if (!batchOps) return;
    await batch.commit();
    batchCount++;
    batch = window.__SF.writeBatch(db());
    batchOps = 0;
    await new Promise(r => setTimeout(r, 0)); // yield to browser per batch
  };

  for (let gi = 0; gi < total; gi++) {
    const g = _mergeGroups[gi];
    const master = g.group[keepIdxByGroup[gi]];
    const dupes = g.group.filter((_, i) => i !== keepIdxByGroup[gi]);
    const canonicalId = canonicalIds[gi];
    try {
      for (const dup of dupes) {
        if (dup._zoneId) {
          batch.set(
            window.__SF.doc(db(), `zones/${dup._zoneId}/productOverrides/${canonicalId}`),
            { price: dup.price ?? master.price, cost: dup.cost ?? 0,
              stockStatus: dup.stockStatus ?? 'in_stock', mergedFrom: dup.id, mergedAt: now },
            { merge: true }
          );
          batch.delete(window.__SF.doc(db(), `zones/${dup._zoneId}/products/${dup.id}`));
          batchOps += 2;
        } else {
          batch.delete(window.__SF.doc(db(), 'products', dup.id));
          batchOps++;
        }
        if (batchOps >= MAX_BATCH) await flushBatch();
      }
      merged++;
    } catch(e) { console.error('[batch build]', gi, e); errors++; }
    if (gi % 50 === 0) { setProgress(gi, `Batching… ${batchCount} committed`); }
  }
  try { await flushBatch(); } catch(e) { console.error('[flush]', e); errors++; }

  setProgress(total, 'Done!');
  invalidateCache();

  body.innerHTML = `
    <div style="text-align:center;padding:30px">
      <div style="font-size:36px;margin-bottom:12px">${errors ? '⚠️' : '✅'}</div>
      <div style="font-family:'Syne',sans-serif;font-size:16px;font-weight:700;margin-bottom:8px">Merge Complete</div>
      <div style="font-size:12px;color:var(--tx2);line-height:1.6">
        ${merged} group(s) merged · ${batchCount} Firestore batch(es)${errors ? ` · ${errors} error(s)` : ''}.<br>
        Zone pricing preserved as overrides.
      </div>
      <button class="btn btn-primary btn-sm" style="margin-top:16px"
        onclick="closeM('mMergeProducts');loadCachedData(true).then(loadProducts)">✓ Done</button>
    </div>`;
}


async function loadProducts() {
  if(!isAdmin()){showToast('Access denied','error');return;}
  // Role-based toolbar
  const _mb=document.getElementById('btnMergeProducts');
  const _ab=document.getElementById('btnAddProduct');
  const _zb=document.getElementById('zoneProductBanner');
  if(_mb) _mb.style.display='';           // visible for all admins
  if(_ab) _ab.style.display=isOwner()?'':'none'; // only owner adds to global catalog
  if(_zb) _zb.style.display=(!isOwner()&&CU.zoneId)?'':'none';
  // Force fresh: ensures zone overrides for the current zone filter are applied
  await loadCachedData(true);
  const srch=(document.getElementById('prodSrch')?.value||'').toLowerCase();
  const catF=document.getElementById('prodCatFilter')?.value||'';
  const stockF=document.getElementById('prodStockFilter')?.value||'';
  const cats=[...new Set(allProducts.map(p=>p.category).filter(Boolean))].sort();
  const catSel=document.getElementById('prodCatFilter');
  if(catSel){const prev=catSel.value;catSel.innerHTML='<option value="">All Categories</option>'+cats.map(c=>`<option value="${c}">${c}</option>`).join('');catSel.value=prev;}
  const dl=document.getElementById('catList');
  if(dl)dl.innerHTML=cats.map(c=>`<option value="${c}">`).join('');
  let prods=allProducts.filter(p=>{
    const ms=!srch||p.name.toLowerCase().includes(srch)||(p.sku||'').toLowerCase().includes(srch)||(p.category||'').toLowerCase().includes(srch);
    const mc=!catF||p.category===catF;
    const mst=!stockF||p.stockStatus===stockF;
    return ms&&mc&&mst;
  });
  const grid=document.getElementById('productsGrid');
  if(!prods.length){
    grid.innerHTML=`<div style="grid-column:1/-1;color:var(--tx3);font-size:13px;padding:30px;text-align:center">${allProducts.length?'No products match filters.':'No products yet. Add your first product or import via CSV.'}</div>`;
    return;
  }
  grid.innerHTML=prods.map(p=>{
    const inStock=p.stockStatus!=='out_of_stock';
    const imgHtml=p.photo?`<img src="${p.photo}" style="width:100%;height:110px;object-fit:cover;border-radius:10px 10px 0 0;display:block" alt="${p.name}">`
      :`<div style="width:100%;height:110px;background:var(--s2);border-radius:10px 10px 0 0;display:flex;align-items:center;justify-content:center;font-size:40px">📦</div>`;
    return`<div style="background:var(--s1);border:1px solid var(--bdr);border-radius:var(--r);overflow:hidden;transition:var(--tr)" class="scard">
      <div style="position:relative">${imgHtml}<div style="position:absolute;top:7px;right:7px"><span class="bdg ${inStock?'bdg-grn':'bdg-red'}" style="font-size:10px">${inStock?'In Stock':'Out of Stock'}</span></div></div>
      <div style="padding:12px">
        <div style="font-family:'Syne',sans-serif;font-size:13px;font-weight:700;margin-bottom:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${p.name}</div>
        ${p.category?`<div style="font-size:10px;color:var(--tx3);margin-bottom:6px">${p.category}${p.unit?' · '+p.unit:''}</div>`:''}
        ${p.sku?`<div style="font-size:10px;color:var(--tx3);margin-bottom:4px">SKU: ${p.sku}</div>`:''}
        <div style="display:flex;justify-content:space-between;align-items:center;margin-top:8px">
          <div style="font-family:'Syne',sans-serif;font-size:16px;font-weight:800;color:var(--acc)">${fmt(p.price)}</div>
          ${p.cost?`<div style="font-size:10px;color:var(--tx3)">Cost: ${fmt(p.cost)}</div>`:''}
        </div>
        <div style="display:flex;gap:6px;margin-top:10px">
          ${isOwner() && !_ownerZoneFilter
            ? `<button class="btn btn-ghost btn-xs" style="flex:1" onclick="editProduct('${p.id}')">✏️ Edit</button>
               <button class="btn ${inStock?'btn-red':'btn-grn'} btn-xs" onclick="toggleStock('${p.id}','${p.stockStatus}')">${inStock?'📵 OOS':'✅ Stock'}</button>
               <button class="btn btn-red btn-xs" onclick="deleteProduct('${p.id}')">🗑</button>`
            : isOwner() && _ownerZoneFilter
            ? `<button class="btn btn-ghost btn-xs" style="flex:1" onclick="editProduct('${p.id}')">✏️ Edit</button>
               <button class="btn btn-primary btn-xs" onclick="openZonePriceOverrideForZone('${p.id}','${_ownerZoneFilter}')">💱 Zone Price</button>
               <button class="btn ${inStock?'btn-red':'btn-grn'} btn-xs" onclick="toggleStock('${p.id}','${p.stockStatus}')">${inStock?'📵 OOS':'✅ Stock'}</button>`
            : `<button class="btn btn-primary btn-xs" style="flex:1" onclick="openZonePriceOverride('${p.id}')">💱 Zone Price</button>
               <button class="btn ${inStock?'btn-red':'btn-grn'} btn-xs" onclick="toggleStock('${p.id}','${p.stockStatus}')">${inStock?'📵 OOS':'✅ Stock'}</button>`
          }
        </div>
        ${p._zoneOverride
          ? `<div style="font-size:10px;color:var(--ylw);margin-top:4px;text-align:right">💱 Zone price override active</div>`
          : (isOwner()&&_ownerZoneFilter&&!p._zoneOverride)
            ? `<div style="font-size:10px;color:var(--tx3);margin-top:4px;text-align:right">🌐 Global price</div>`
            : ''}
      </div>
    </div>`;
  }).join('');
}

function openNewProduct() {
  document.getElementById('mProductTitle').textContent='🛒 Add Product';
  document.getElementById('pEditId').value='';
  ['pName','pSku','pCat','pUnit','pDesc'].forEach(id=>document.getElementById(id).value='');
  document.getElementById('pPrice').value='';
  document.getElementById('pCost').value='';
  document.getElementById('pStock').value='in_stock';
  document.getElementById('prodPhotoData').value='';
  const prev=document.getElementById('prodPhotoPreview');
  prev.innerHTML='📦';prev.style.cssText='width:80px;height:80px;border-radius:10px;background:var(--s2);border:2px dashed var(--bdr);display:flex;align-items:center;justify-content:center;font-size:28px;overflow:hidden;flex-shrink:0';
  openM('mProduct');
}

async function editProduct(id) {
  const p=allProducts.find(x=>x.id===id);if(!p)return;
  document.getElementById('mProductTitle').textContent='✏️ Edit Product';
  document.getElementById('pEditId').value=id;
  document.getElementById('pName').value=p.name||'';
  document.getElementById('pSku').value=p.sku||'';
  document.getElementById('pCat').value=p.category||'';
  document.getElementById('pUnit').value=p.unit||'';
  document.getElementById('pPrice').value=p.price||'';
  document.getElementById('pCost').value=p.cost||'';
  document.getElementById('pStock').value=p.stockStatus||'in_stock';
  document.getElementById('pDesc').value=p.description||'';
  document.getElementById('prodPhotoData').value=p.photo||'';
  const prev=document.getElementById('prodPhotoPreview');
  if(p.photo){prev.innerHTML=`<img src="${p.photo}" style="width:100%;height:100%;object-fit:cover">`;prev.style.border='2px solid var(--grn)';}
  else{prev.innerHTML='📦';prev.style.cssText='width:80px;height:80px;border-radius:10px;background:var(--s2);border:2px dashed var(--bdr);display:flex;align-items:center;justify-content:center;font-size:28px;overflow:hidden;flex-shrink:0';}
  openM('mProduct');
}

function previewProdPhoto(input) {
  const file=input.files[0];if(!file)return;
  if(file.size>10*1024*1024){showToast('Image too large (max 10MB)','error');return;}
  const reader=new FileReader();
  reader.onload=e=>{
    document.getElementById('prodPhotoData').value=e.target.result;
    const prev=document.getElementById('prodPhotoPreview');
    prev.innerHTML=`<img src="${e.target.result}" style="width:100%;height:100%;object-fit:cover">`;
    prev.style.border='2px solid var(--grn)';
  };
  reader.readAsDataURL(file);
}

async function saveProduct() {
  const name=document.getElementById('pName').value.trim();
  const price=parseFloat(document.getElementById('pPrice').value);
  if(!name){showToast('Product name is required','error');return;}
  if(!price||price<=0){showToast('Enter a valid price','error');return;}
  const editId=document.getElementById('pEditId').value;
  // Duplicate check — name must be unique (case-insensitive), excluding current record
  const nameLower=name.toLowerCase();
  const dup=allProducts.find(p=>p.name.toLowerCase()===nameLower&&p.id!==editId);
  if(dup){showToast(`Product "${dup.name}" already exists. Use a unique name.`,'error');return;}
  const data={name,price,
    sku:document.getElementById('pSku').value.trim(),
    category:document.getElementById('pCat').value.trim(),
    unit:document.getElementById('pUnit').value.trim(),
    cost:parseFloat(document.getElementById('pCost').value)||0,
    stockStatus:document.getElementById('pStock').value,
    description:document.getElementById('pDesc').value.trim(),
    photo:document.getElementById('prodPhotoData').value,
    updatedAt:new Date().toISOString(),updatedBy:CU.uid
  };
  try{
    let savedId = editId;
    if(editId){
      await sfUpdate('products',editId,data);
      showToast(`${name} updated ✅`,'success');
    } else {
      data.createdAt=new Date().toISOString();data.createdBy=CU.uid;
      const newRef = await sfAdd('products',data);
      savedId = newRef?.id || editId;
      showToast(`${name} added 🛒`,'success');
    }
    // Owner: broadcast new/updated product to ALL zone subcollections
    // so every zone's sales reps can see it immediately
    if(isOwner() && allZones.length) {
      const broadcastData = {...data, _globalProduct:true, updatedAt:new Date().toISOString()};
      await Promise.all(allZones.map(z =>
        window.__SF.setDoc(
          window.__SF.doc(db(), `zones/${z.id}/products/${savedId}`),
          broadcastData, {merge:true}
        ).catch(()=>{}) // fail silently per zone
      ));
    }
    closeM('mProduct');
    invalidateCache();await loadCachedData(true);loadProducts();
  }catch(e){showToast('Error saving product: '+e.message,'error');}
}

async function toggleStock(id,currentStatus) {
  if(!isAdmin())return;
  const newStatus=currentStatus==='out_of_stock'?'in_stock':'out_of_stock';
  if(isOwner()) {
    // Owner updates root + broadcast to all zones
    await sfUpdate('products',id,{stockStatus:newStatus});
    if(allZones.length) {
      await Promise.all(allZones.map(z =>
        window.__SF.setDoc(window.__SF.doc(db(),`zones/${z.id}/products/${id}`),{stockStatus:newStatus},{merge:true}).catch(()=>{})
      ));
    }
  } else {
    // Zone admin: update their zone's copy directly
    await window.__SF.setDoc(
      window.__SF.doc(db(),`zones/${CU.zoneId}/productOverrides/${id}`),
      {stockStatus:newStatus, updatedAt:new Date().toISOString(), updatedBy:CU.uid},{merge:true}
    );
  }
  showToast(newStatus==='in_stock'?'Marked as In Stock ✅':'Marked as Out of Stock ❌','info');
  await loadCachedData();loadProducts();
}

async function deleteProduct(id) {
  if(!isAdmin())return;
  const p=allProducts.find(x=>x.id===id);
  const label=p?p.name:`Product ${id}`;
  if(isStrictAdmin()){
    if(!await _customConfirm(`"${label}" will be permanently deleted.`, {title:'Delete Product',okText:'Delete',cancelText:'Cancel',danger:true,icon:'🗑️'}))return;
    showToast('Product deleted','warn');
    await loadCachedData();loadProducts();
  } else {
    await requestDeleteApproval('product',id,label);
  }
}

// ── CSV / EXCEL IMPORT ──
function openCsvImport() {
  csvParsedRows=[];
  document.getElementById('csvPreview').style.display='none';
  document.getElementById('csvImportBtn').disabled=true;
  document.getElementById('csvFileInput').value='';
  openM('mCsvImport');
}

function downloadSampleCsv() {
  const rows=[
    ['name','price','category','unit','sku','cost','stock_status','description','photo_url'],
    ['Premium Rice 5kg','650','Grains','kg','RICE-5KG','480','in_stock','High quality premium rice',''],
    ['Cooking Oil 1L','180','Oils','L','OIL-1L','130','in_stock','Refined cooking oil',''],
    ['Sugar 1kg','120','Staples','kg','SUGAR-1KG','90','out_of_stock','White refined sugar','']
  ];
  const csv=rows.map(r=>r.map(c=>`"${c}"`).join(',')).join('\n');
  const a=document.createElement('a');
  a.href='data:text/csv;charset=utf-8,'+encodeURIComponent(csv);
  a.download='product_import_sample.csv';a.click();
}

function handleCsvDrop(e) {
  e.preventDefault();
  document.getElementById('csvDropzone').style.borderColor='var(--bdr)';
  const file=e.dataTransfer.files[0];
  if(file)handleCsvFile(file);
}

function handleCsvFile(file) {
  if(!file)return;
  const ext=file.name.split('.').pop().toLowerCase();
  if(ext==='csv'){
    const reader=new FileReader();
    reader.onload=e=>parseCsvText(e.target.result);
    reader.readAsText(file);
  } else if(ext==='xlsx'||ext==='xls'){
    if(window.XLSX){
      const reader=new FileReader();
      reader.onload=e=>{const wb=XLSX.read(e.target.result,{type:'binary'});const ws=wb.Sheets[wb.SheetNames[0]];parseCsvText(XLSX.utils.sheet_to_csv(ws));};
      reader.readAsBinaryString(file);
    } else {
      const s=document.createElement('script');
      s.src='https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
      s.onload=()=>{const reader=new FileReader();reader.onload=e=>{const wb=XLSX.read(e.target.result,{type:'binary'});const ws=wb.Sheets[wb.SheetNames[0]];parseCsvText(XLSX.utils.sheet_to_csv(ws));};reader.readAsBinaryString(file);};
      document.head.appendChild(s);
    }
  } else {
    showToast('Unsupported file type. Use .csv, .xlsx or .xls','error');
  }
}

function parseCsvText(text) {
  const lines=text.trim().split('\n').filter(l=>l.trim());
  if(lines.length<2){showToast('File is empty or invalid','error');return;}
  const headers=lines[0].split(',').map(h=>h.replace(/"/g,'').trim().toLowerCase());
  const nameI=headers.indexOf('name');const priceI=headers.indexOf('price');
  if(nameI===-1||priceI===-1){showToast('CSV must have "name" and "price" columns','error');return;}
  const catI=headers.indexOf('category');const unitI=headers.indexOf('unit');const skuI=headers.indexOf('sku');
  const costI=headers.indexOf('cost');const stockI=headers.indexOf('stock_status');const descI=headers.indexOf('description');
  const photoI=headers.indexOf('photo_url');
  csvParsedRows=[];const errors=[];
  for(let i=1;i<lines.length;i++){
    const cols=lines[i].split(',').map(c=>c.replace(/"/g,'').trim());
    const name=cols[nameI]||'';const price=parseFloat(cols[priceI]||0);
    if(!name){errors.push(`Row ${i+1}: missing name`);continue;}
    if(!price||price<=0){errors.push(`Row ${i+1}: invalid price`);continue;}
    csvParsedRows.push({name,price,category:catI>=0?cols[catI]||'':'',unit:unitI>=0?cols[unitI]||'':'',sku:skuI>=0?cols[skuI]||'':'',cost:costI>=0?parseFloat(cols[costI]||0):0,stockStatus:stockI>=0&&cols[stockI]==='out_of_stock'?'out_of_stock':'in_stock',description:descI>=0?cols[descI]||'':'',photo:photoI>=0?cols[photoI]||'':''});
  }
  if(errors.length)showToast(errors.slice(0,3).join(' | ')+(errors.length>3?` +${errors.length-3} more`:''),'warn');
  if(!csvParsedRows.length){showToast('No valid rows found','error');return;}
  const preview=document.getElementById('csvPreview');
  preview.style.display='';
  document.getElementById('csvRowCount').textContent=`${csvParsedRows.length} products ready`;
  const tbl=document.getElementById('csvPreviewTable');
  tbl.querySelector('thead').innerHTML='<tr><th>Name</th><th>Price</th><th>Category</th><th>Unit</th><th>SKU</th><th>Stock</th></tr>';
  tbl.querySelector('tbody').innerHTML=csvParsedRows.map(r=>`<tr>
    <td style="font-size:12px;font-weight:600">${r.name}</td><td style="font-size:12px">${fmt(r.price)}</td>
    <td style="font-size:11px;color:var(--tx2)">${r.category||'—'}</td><td style="font-size:11px;color:var(--tx2)">${r.unit||'—'}</td>
    <td style="font-size:11px;color:var(--tx3)">${r.sku||'—'}</td>
    <td><span class="bdg ${r.stockStatus==='in_stock'?'bdg-grn':'bdg-red'}" style="font-size:10px">${r.stockStatus==='in_stock'?'In Stock':'OOS'}</span></td>
  </tr>`).join('');
  document.getElementById('csvImportBtn').disabled=false;
}

async function importCsvProducts() {
  if(!csvParsedRows.length){showToast('No rows to import','error');return;}
  const btn=document.getElementById('csvImportBtn');
  btn.disabled=true;btn.textContent='Importing...';
  let count=0;let skipped=0;
  try{
    for(const p of csvParsedRows){
      // Skip duplicates
      const dup=allProducts.find(x=>x.name.toLowerCase()===p.name.toLowerCase());
      if(dup){skipped++;continue;}
      await sfAdd('products',{...p,createdAt:new Date().toISOString(),createdBy:CU.uid,updatedAt:new Date().toISOString(),updatedBy:CU.uid});
      count++;
    }
    closeM('mCsvImport');
    showToast(`${count} products imported${skipped?` · ${skipped} skipped (duplicates)`:''} 🎉`,'success');
    await loadCachedData();loadProducts();
  }catch(e){showToast('Import failed: '+e.message,'error');btn.disabled=false;btn.textContent='Import Products';}
}

function _updateBadges(ordDocs) {
  const count=ordDocs.filter(d=>d.data().status==='Pending').length;
  const pb=document.getElementById('pendBadge');
  if(pb){pb.textContent=count;pb.style.display=count?'':'none';}
  if(isAdmin()){
    const pendBal=allOutlets.filter(o=>o.balanceStatus==='pending'&&o.openingBalance>0).length;
    const oab=document.getElementById('outletApvBadge');
    if(oab){oab.textContent=pendBal;oab.style.display=pendBal?'':'none';}
    const unassignedDeliveries=ordDocs.filter(d=>d.data().status==='Confirmed'&&!d.data().deliveryManId).length;
    const dab=document.getElementById('delivAdminBadge');
    if(dab){dab.textContent=unassignedDeliveries;dab.style.display=unassignedDeliveries?'':'none';}
  }
}

// Public wrapper — uses cached dash data when fresh, otherwise fetches
async function updateBadges() {
  const now=Date.now();
  if(_dashOrdDocs&&_dashTs&&(now-_dashTs)<_DASH_TTL){
    _updateBadges(_dashOrdDocs);
  } else {
    const pendDocs=await sfGet('orders');
    _updateBadges(pendDocs);
  }
}

function _updateSidebarStats(ordDocs, colDocs) {
  const strip=document.getElementById('sbStats');
  if(!strip)return;

  // Outlets: reps see their own + assigned; admin sees all
  const myOutlets=isAdmin()
    ? allOutlets
    : allOutlets.filter(o=>o.createdBy===CU.uid||o.assignedRepId===CU.uid);

  // Orders
  const myOrders=ordDocs.map(d=>d.data())
    .filter(o=>isAdmin()||o.createdBy===CU.uid);
  const activeOrders=myOrders.filter(o=>!['Cancelled','Delivered'].includes(o.status)).length;

  // Collections (total this month)
  const m=todayStr().slice(0,7);
  const myColTotal=colDocs.map(d=>d.data())
    .filter(c=>isAdmin()||c.createdBy===CU.uid)
    .filter(c=>c.date&&c.date.startsWith(m))
    .reduce((s,c)=>s+(c.amount||0),0);

  const elO=document.getElementById('sbStatOutlets');
  const elOrd=document.getElementById('sbStatOrders');
  const elC=document.getElementById('sbStatCol');
  if(elO)elO.textContent=myOutlets.length;
  if(elOrd)elOrd.textContent=activeOrders;
  if(elC)elC.textContent='RM'+Math.round(myColTotal).toLocaleString();
  strip.style.display=CU&&CU.role!=='delivery_man'?'block':'none';
}

async function updateSidebarStats() {
  const [ordDocs,colDocs]=await Promise.all([sfGet('orders'),sfGet('collections')]);
  _updateSidebarStats(ordDocs,colDocs);
}

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

// ═══════════════ LOCATION TRACKING ═══════════════
let _locationWatcher = null;
let _locationInterval = null;  // 5-min fallback timer for background pings

// SW → page: SW periodicsync fires → asks page to get GPS
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', event => {
    if (event.data && event.data.type === 'REQUEST_LOCATION') {
      if (CU && CU.role === 'sales_rep') _captureAndSaveLocation();
    }
  });
}

// Refresh when tab comes back into focus
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && CU && CU.role === 'sales_rep') {
    _captureAndSaveLocation();
  }
});

function _captureAndSaveLocation() {
  if (!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(
    pos => {
      _userLat = pos.coords.latitude;
      _userLng = pos.coords.longitude;
      _gpsGranted = true;
      saveUserLocation(pos);
    },
    () => {},
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
  );
}

function startLocationTracking() {
  if (!navigator.geolocation) return;
  // Admins are never tracked
  if (isAdmin()) return;

  // Immediate fix
  _captureAndSaveLocation();

  // Continuous watch — keeps running when screen locked on Android Chrome
  if (_locationWatcher) navigator.geolocation.clearWatch(_locationWatcher);
  _locationWatcher = navigator.geolocation.watchPosition(
    pos => {
      _userLat = pos.coords.latitude;
      _userLng = pos.coords.longitude;
      _gpsGranted = true;
      saveUserLocation(pos);
    },
    () => {},
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
  );

  // 5-minute forced ping — ensures location saves even when watchPosition
  // is throttled by the OS (app backgrounded, screen locked)
  if (_locationInterval) clearInterval(_locationInterval);
  _locationInterval = setInterval(_captureAndSaveLocation, 5 * 60 * 1000);

  // Register Periodic Background Sync (PWA installed on Android Chrome)
  _registerPeriodicLocationSync();

  // Persistent keepalive notification (prevents Android killing browser)
  _requestNotificationPermission();

  // Show green tracking dot in sidebar
  _showTrackingIndicator(true);
}

function stopLocationTracking() {
  if (_locationWatcher) { navigator.geolocation.clearWatch(_locationWatcher); _locationWatcher = null; }
  if (_locationInterval) { clearInterval(_locationInterval); _locationInterval = null; }
  _showTrackingIndicator(false);
  _dismissTrackingNotification();
}

// ── Register Periodic Background Sync ────────────────────────
async function _registerPeriodicLocationSync() {
  if (!('serviceWorker' in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    if (!('periodicSync' in reg)) return;
    const perm = await navigator.permissions.query({ name: 'periodic-background-sync' }).catch(() => ({ state: 'denied' }));
    if (perm.state !== 'granted') return;
    await reg.periodicSync.register('stfm-location-sync', { minInterval: 5 * 60 * 1000 });
    console.log('[LocationTracking] Periodic background sync registered');
  } catch(e) { console.warn('[LocationTracking] Periodic sync unavailable:', e.message); }
}

// ── Notification permission + persistent keepalive ───────────
async function _requestNotificationPermission() {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'default') {
    setTimeout(async () => {
      const result = await Notification.requestPermission().catch(() => 'denied');
      if (result === 'granted') _showTrackingNotification();
    }, 3000);
  } else if (Notification.permission === 'granted') {
    _showTrackingNotification();
  }
}

async function _showTrackingNotification() {
  if (!('serviceWorker' in navigator) || Notification.permission !== 'granted') return;
  try {
    const reg = await navigator.serviceWorker.ready;
    await reg.showNotification('STFM — Location Tracking Active', {
      body: 'Your location is being tracked for your shift. Do not close this notification.',
      icon: "data:image/png;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/4gHYSUNDX1BST0ZJTEUAAQEAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADb/2wBDAAUDBAQEAwUEBAQFBQUGBwwIBwcHBw8LCwkMEQ8SEhEPERETFhwXExQaFRERGCEYGh0dHx8fExciJCIeJBweHx7/2wBDAQUFBQcGBw4ICA4eFBEUHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh7/wAARCADiAN8DASIAAhEBAxEB/8QAHQABAAICAwEBAAAAAAAAAAAAAAcIBQYDBAkCAf/EAFkQAAEDAwEEBAYIDw0HBQAAAAEAAgMEBREGBxIhMRNBUWEIFCJxgZEyUnKCkqGx0hUXI0JDU1VWYpOVorLB0RgkJTU2N0Vjc3WUs8IWMzRUg4SjJ3TD4vH/xAAbAQEAAgMBAQAAAAAAAAAAAAAABAUCAwYBB//EAD8RAAEDAgMDCAgEBQQDAAAAAAEAAgMEEQUhMRJBUQYTYXGBkaHRFCIyUrHB4fAVIzNTNEJikvEkcrLSRIKi/9oADAMBAAIRAxEAPwC5aIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiL5mkjhifNK9scbGlz3uOA0DiST1BV22r7bKysnmtGjZnUtI0lklwAxLL/Z+1b+FzPVjr1TTNiF3KvxDEoKCPblPUN5U06t1vpbSrcXu7wQTYyKduZJT2eQ3Jx3ngouvnhD0MbnMsmnaioHISVcwi9O60Oz6wq+SySSyvlle6SR7i573nLnE8ySeZXyqySukd7OS4ar5WVkptCAwd58fJS1WbftaSvPi9FZadnUBBI4+svx8S46fb3riN4MtPZpm54h1M8fGHhRSi0ekS+8qv8bxC9+dKsfo7b7aK6dlLqS2vtbnHAqYnmWH3wxvNHwlMtNPDVU8dRTTRzQytD45I3BzXtPEEEcCFTXZtoa7a3vPilCDDSREGqq3NyyFvZ+E49TfkHFWzsNssmitKxUEEzKO2UTCXS1M2AMnLnuceAyST1DjwwrKklkeCX6cV2/J6vraqMvqR6g0doT8rdPxWbRRxdNtmz+hmdEy5VFY5pwTTUzi30F2AfRlcdNtw0BLL0c9ZXUh/rqN/wDpyt/pEXvBW5xWiBtzre8KS0WDsGsNL34hlov1BVyHlEyYCT4Bw74lnFtDg4XCmMkZINphuOhERF6s0RERERERERERERERERERERERERYyquodcTa7e0VFY0B0x+x0zTyLz2nqYOJ7h5Q4NVXmn0tpWvvdbI6VtJCXneODI/k1o6hlxA9K8LgBdanTMa0uJyGpUMeExryR1QdFWuYtjYGvuT2H2RPFsXmAw49uQOohQQue41lTcLhUV9ZIZampldLK8/XOcck+srgVBNKZXlxXyLE699dUOldpu6BuRERalXotx2W6Aueubv0UO9TW2Bw8brC3gzr3G9ryOrq5nqz2Nk+zm5a4uIeS+ks8L8VNXu8T+BHngXfE3mc8AbE6l1BpTZXpSCmZCyGNjSyjoYf95M4cz28+Lnnt6yQDLp6cOG2/Jq6TB8GEzfSqo7MQ47/p8dAu7LLpTZpo1gc6O322mGGN5yTyEZwOt7zj/wDAOFY9qO0O764uOZy6ltcLs01E13kt/Cf7Z/fyHIdecZrvV151lenXK7TZDctgp2E9HA09TR6snmfQMa872J8y8qKkyDZbk1eYxjrqv8iAbMQ8fp0K2mw3RFt07o+guEtHE+710Laied7AXsDxlsbfagAgHHM5Pm3q5Wy3XOAwXGgpayJwwWTwtkafQQvmwPZJYrfJHjcdSxluOwtGF3VcRsa1gaF9FpaaKGBsTBkAow1TsP0Zdw6S3xT2aoPEOpnb0ee9jsjHc0tWm1tBti2bAz0FwdqKzxDJDgZw1o9swnpGD3BIA5lWBRanUzDm3I9ChT4NTuO3DeN3FuXeNCok0Nt005eCymv0RslU7gJHO36d3v8AGW++GO9SxBNDUQsnglZLFIA5j2ODmuB6wRzCjbahshsuqo5a+1titd5PldKxuIpz2SNHWfbDj255KCrPqHW+y7UEtt35aYxPzNQVHlwSjPsgOw+2aQT29S0meSE2lFxxVc/FKvDHBla3aYdHj5j77VcFFpmzLaJZdcUP72PilyibmeikcC5v4TT9c3v9YC3NTGvDxdq6KCeOojEkRuCiIiyW5ERERERERERERFpetdS1zrzBo3Szo3X2qZvz1Dm7zLdB1zOHW7j5LTzJGeGM821fWlPonSstxcGSVsxMVFC76+QjmfwWjifQOZC6OxfS9RY9PPu14c+a/wB5cKqvml9mM8Wx92AeI7SeoBaXvLnbDe1V085lm9FjOerjwHDrPgM+C2zT1no7HbI6CiD3NBL5JZXb0k0h9lI9x4ucTxJUF+FNqzpqyl0fRy+RBiprt083kfU2HzAlxHe09SmzWeoKPS+ma2+VpzHTR5azODI88GsHeSQFSq83Gru92qrpXydJVVUrpZXdW8TnA7AOQHUAFGrZQxnNjf8ABUXKiubTU4pY8i7wH1811ERFUr52i3bY7ohuuNUOoqipNPQ0sfT1Jb7N7cgBrewnPPqC0lZXTGor3pm4OuFiuElFUujMbnta1wc04OC1wIPEDqWbC0OBdopVG+GOdrp23aDmFZzaDrnTuzGwQWW1UsD69sW7R0EfBsTep8h5gZ4+2cc95FX9R3u56ivE12u9U+pq5jxceAaOprR1NHUAurX1dVX1s1bW1ElRUzvL5ZZHZc9x6yVwLZPO6U8BwU7FcYlr3bI9Vg0b5/eSIiz2z/T8uqNY22yMYXMqJh05H1sTeMhz1eSDjvwFpALjYKriidK8MbqTZW/2fxTQaE0/BU56aO2U7ZM894RNys2vxjWsYGMAa1owAOQC/V0YFhZfa42bDA3gEREXqzRaptL0LadcWY0la0Q1kQJpKtrcvhcervaetvyEAja0WLmhwsVqmhjnjMcguCqR3a33/Q+qzTTmW33ShkD4pYncx1PYetpH6wRzCszsZ2k02trcaOs6OnvlMzM8I4Nmby6Rg7O0dRPYQuxtm0FDrbTp8XayO70gL6OU8N7tjcfau+I4PbmqVrrrnp6+w11G+SjuNDNkZGCx4JDmuHrBHnCqztUknFpXBuM3J2rsM4nffePFXoRa3s31bR6z0tT3imAjlP1OqgByYZRzb5uIIPWCFsitWuDhcLvYpWTMEjDcHMIiIvVsRERERCcc0WibdtRnTmzmulhk3Kut/edOc4ILwd4jvDA4+cBYveGNLjuWmpnbTxOldo0XUZUVUdq+3aKQ/VbBZsyRN5tdHG4YPYekk3T7kY6lYhQ54KtjbR6Qrr49mJbjU7jD/VRZA/PL/UFtu22+3nT+gKyssdJNLUPxG6oj4+KsPspSOfDkD1EgngFGgOxEZHanNUuFOMFE6smzc+7j1bh3KF/CQ1sL9qFunbfLvW+1yHpXNORLUYwT5mDLfOXdyiVCSTkkk9pRVEkhkcXFfOK6sfWTumfqfDgEREWCiIiIiIiIiIrO+DloSTT9lfqK6QGO53GMCKN48qCDmAewuOCR2Bo4HK1nYfsjmdPT6m1ZTGONhElJQSt8px5h8gPIdYaePb2GwKs6OmI9d3Yu95NYG6IiqnFj/KPmfkiIisl2qIiIiIiIiKuPhPaNbb7tDq2hixT1zuirGtHBswHkv98Ac97e1yscsLrmwQan0ncbHPgCqhLY3EewkHFjvQ4ArTURc6wtVZi9AK6ldFv1HX95KsewbWDtLa1hgqZi22XItp6kE+S1xPkSegnB7nHsVtlQqpglp55aaojMc0TzHIx3NrgcEHzFXC2L6kOp9ntvrZpOkq4G+K1Rzx6RmBk97m7rvfKHQS6xlc5ySryQ6kfuzHzH30rc0RFZLtkREREVbfCrvpqdT2+wxvzFQU5mlAP2STkD5mtB98rJKm2raj/ava7WFx3mV93bTMOecfSCJv5oChVzrMDRvXM8qZy2lbC3V5A7P82VqdnFr+gug7JbC0NfDRR9IAMeWRvP/OJWfc1rmlrgHNIwQRwIX6AAAAMAcgimNGyAF0UUYjYGDQCyhnaJsLtt0lkuGlJ4rXUu4upHg+LvP4OOMfoBHYAoR1JoXV2npHi6WGtjjb9njj6WIjt325A9OCrqIoktFG83GSoK7kxSVTttnqHo07vKyoMCDyIK/Vee4WGxXEl1wstuqyeZnpWPJ9YWJl2faGk9lpKzD3NGxvyBRjh7tzlRv5Gyg+rKO4/VUuX3BFJUTNggjfLK44axjS5x8wHFXPh2faGiOW6Ssp93Rsd8oKzlvt1ut8fR0FBS0jMY3YIWsHxBejD3b3LKPkbIT68o7BfyVT9KbI9b397HG2G10xwTNX5i4dzMb5Pox3qddnOyPTmkpIq6cG7XVnFtTOwBsZ7Y2cQ3znJ7CFIq4qqop6SnfU1U8UEMYy+SV4a1o7STwClRUkceepXQUHJ+jojt22nDefLRcqLVm7RtCOqOgGrLRvZxk1LQ34XL41stPPDUQMnp5Y5onjLHxuDmuHaCOakNc12hVxHPFL7Dgeo3XIiIsltREREREREREREVR/CCszbNtQuBiYGQ17W1rAB1vyH+t7Xn0rcPBOvJivF40/I87k8LauJp5BzDuv8ASQ5vwV2/C3t+H2C6tbzE1O849y5v+tR3sKrzb9q1jk3y1k0rqd49tvsc0D4RafQqc/lVXb8V83d/oMey0LvB3+VcFERXC+kIiIiLo6hrRbbBcbiSAKWllmyfwWF36lT/AGRU/je03TsT/KIro5DnrLPL/wBKtLtcm6HZjqN+cZt0rPhN3f1qs+wkB21vT4P22Q/+GRVtYbysH3quM5RO28QpozpceJHkrgoiKyXZrhrqqnoqOasqpWw08EbpZZHHgxrRkk+YBVR2o+EdepLlNR6acbdSsOG7rGmZ47XucCG554aMjtKsDtve+PZTqAscWk0waSOwvaCPUSvPW5EuuNUXHJMz/wBIqVQ0raqYsecgL5b1XysdU1PMFxDQ25sbE3NgL62y3Ld6ra7rmolMj7/dsnq+iM2B6A4BcX01tbfd+6/lGf560eNjpJGxsaXOcQGgdZKkjTWxjWd/tMdyt9sqpqeQkNka1oaSOBwXOG9x4ZHDIKsamlw2mtzjdesnwutdTSYbTENkabncNonryue1Y/6a2tvu/dfyjP8APT6a2tvu/dfyjP8APWwO8H/aEP6Gq/gxn/5F8O2B7QR/Q1Z+KYfkkUbawj3fB3ko+zhXuO/tk8lhqXajriepigbf7rmR4aP4Rn6z7pZ653u9XOFsNzvFxromu3msqap8rQ7tAcSM96/bdsO2gUddFUmxVsojdnd6Fozwxz3yupWU09HWTUdVE6GogkdFLG4YLHtOCD3ghUOMOpi9ophZts8iM+1clykdE17BTAhls7hwueHrLiWQt19vltpzT229XKihLi7o6erkjbk8zhpAyseipwbLmWPcw3abKTab6NVFNFUR6z1PuSsD2/wjJyIz2rk6G+ffnqb8oyftXHpsk2GjJ+1ALILjJsSq2SOaJDkSvokFLDJG1xGoG8+a6fQ3z789TflGT9qdDfPvz1N+UZP2ruItf4rWfuFbfQYeHifNdPob59+epvyjJ+1Ohvn356m/KMn7V3EwexPxWs/cKehQcPE+ayOymrvMG1m0UFRqK819PNBO58dVWPkaSI3Y4E4VilXPZsD9Oqxf+1qP8tysYvoWAyvlomvebkqfg7Q1kjRoHfIKI/Cqp+l2e0c4HGC5RknuMcg+UhV30jUeJ6ts1XnHQXCnlz7mRp/UrL+EyAdllQSOIq4CPhKq0bzHI2RvNpDh5wva3Ka647lP+XiTXjgD4q+yIOSK4X0hERERajtmaX7LdQgdVE4+ogqs+xKUQ7V9PPPI1Lm/Cjc39atVtAo3XHQt9oWDL57dOxnujGcfHhU70RWC36ysle526yC4QSOJ6miRufiyqysylY771XEcpTzeIU8p0y8CrwIiKzXbrStuf81F/wD7Bv8AmNXnvcf4wqf7V/yleiO2Gjlr9mOoKeBpdJ4m6QADJO5h5HqavPC7RuiulUx3PpXEeYnI+Iqzwcj0h46B8SocRtiDulg8HHzC59Nbn0bp9/tdu+fdOF6Q6TNAdL2v6FFhofE4vF9zlubox8S8z2Ocx7XscWuacgjmCt90ztb1jp+gbRW66VcMIJIZHPhgJ5kNIIGevGFuxOimklEsQvla1+k8etKmKaOp5+Nm2CACLgEWJO+wsb557l6DcEVEmbfdoLf6ZrfTIw/Kxc7PCE2gtGPozU+lkJ+WNVvoVX+0e9vmsfSagf8Aju72f9leZQjt12T1l6uEup9MRCWskA8co94NMpAxvsJ4b2AMjrxkceBgxvhE7Qm/01Uf4enPyxrmZ4R2v2kF13ld3GkpvmLVLh9RI3ZdEfDzUKuYa6IxTU77f+uXT7SxFdS1VBVOpa6mmpahnsopoyx7fODxC+aKNtTWwUweAZZGs59pA/WtxsvhJ3t00bb5RW65RNPEVVIGn0OYcDzlpVh9me0LS+0K3mno4Y4amNgfJQzBrhu59kw8ntz1jiOGQMjNW/DXxu2ZLt6x872XLR8m4zKGPkLSdA5tr9RvY9hWIi2FaNjAaKy+YHV420D4mqMr9p6i0xtMu1ntz53U0dNC9nTP33+U1pOTjtyrQKu+04Y2zXjvoqf9EKBj8EbKF5a0ArpK6hp6fmnRMAO1u6isYujPborvqfT1pqJJo4KyuEMpifuu3TjODgrvLjt/84Gkf71j/SC4fCADWxg8VqrWh0VjoS34hSb9IvSH/P34/wDeN+YvsbDtG/8AM3s/95/9VJ6L6j6JB7g7lajCqP8AbHctG0nss0vpq/QXu3m4PrIGuax09RvjDmlp4Y7CVvKItrI2sFmiwUqGnigbsxNAHQot8J+bo9mO59ur4WeoOd/pVX6GE1FdBTgZMsrWAecgKxHhaVjWaXstv3gHzVzpgO0MjLT/AJgUIbOaJ1x1/YKNrd4PuMBcPwWvDnfmgqqrPWnt1L55yj/OxQRj+kd/+VdkIiK4X0lERERfjgHNLXDIIwQqMamtrrRqG5WlwLfFKqWAZ7GuIB9QBV6FVbwlrIbZtHfXsYRBdIGTg9W+0bjx+a0++UDEGXYHcFyXK+nL6Zko/lPgfrZWR0Td237SNpvAIJq6SOR/c/HlD0OyPQswob8Fe/trNK1mnpXjprdMZIm/1UhJ+J+/8IKZFKhftxhyv8NqhVUrJeIz69/ivx7WvaWPaHNIwQRkEKpe3PYLdKW4z3bTNLLV29xLmshbvywDnuOYOLmjqcMkDnyybTagu9BYbPU3e6TGGjpmh0sgY55aCQOTQSeJHILTBto2cEfx/IPPQVHzFkZhE8ODtlw0++C11z6cOaXyhjxmDcA9x1B3hUSqNO3eCZ0LqYFzCQ4CQDB7CHYI9S4foLdf+Td6HtP61fAbUtl1xqo4n3SCeWVzWNMtum4knAGXR8Oa3GXTmnpR9VsNrk91SRn9SsGYxUnQtPYfNeQVVTMDzU0b7cAfk5ebhtFzHOil9GCvl1suI50NR6IyV6NTaJ0bNxl0nYnntNviz+iuu/Z5oV/PSVmHuaRg+QLYMXqvdb4rdzmIf0f/AF5ledLqGuHOhqh/0XfsXDIx8bt2RjmO54cMFeikmzHQMg8rS1vHuWlvyFRL4QuxrTtPpOe/2GmNH4qWmenDy9u64hu+zeyWkEjIzgjPpzbjUjTeRgtvsc/gvH1lXA0ySsaWjWxN7cbEZ261UNbtsb1NV6Z1nQ10Er2sglEpaDzaDh7fM5hcCtMlY6KV8b/ZMcWnzgrI6W/jhnuH/IrLE2tfRyHgLjszC2YuGuoZHjcNodYzBXpg0gtBByCMhV32qFzdtlxbnyXW2Fx9G6P2qwtN/wAPH7gfIq+7WR/611ffaYv0gvn3KD+AeoWKn8uI/wBQ+BWKXFQfy/0h/e0f6QXKuKg/l9pH+9Yv0guBwf8Ajo+tQav9Ptb/AMgrQBECL6yulREXXudbT263VNwq5BHT00TpZXn61rRkn1BF4SALlVn8KK8iv1/Da435jtlK1jh2SSeW783o11/BltJuG0tlc5hMdtpZJ89W+4dG0ep7j71R/qS6z3zUFfeKnIlrKh8xaTndDjkN9AwPQrGeC9p823RM97mj3Z7rPlhI49DHlrfzt8+YhU0P51Rtdq+b4cDiWMmbcCXdg0+SlxERXK+koiIiIos8JbTZvGg/orBHvVNok6fgOJhdgSD0eS7zMUprjqYYqmnkp542yRSsLHscODmkYIPoWErBIwtO9Ra2lbVQPhdo4Km+yTVH+yOuaK6SOIo3k09Z/YvIyfekNd71XLa5rmhzXBzSMgg8CFSraPpmbSOsK6ySBxijd0lM8/ZIXZ3D+o94Knnwb9cC9WAaZuE2bjbY/qBceM1OOA9LODT3bveq6ikLHGJy5DkzWuppn0E2Rvl17x27ltG3P+ai/wD9g3/MavPm4Syi4VOJZB9Vfyee0r0k1pZW6i0nc7IXiM1lO6NjyMhjseST5jgrz015pq56fv8AW01dSSQvjlIlYRxjdzOe48weRBGF0WFyMZUkP/mGXWCup2mR14Mmjm2F+IJNuuxWLs9xkorhFO+WUxg4eN4ngev0c1dfRO3bSNbpuklvlZLS3ARhs25TvkZI4Di9pYDwPPBwRy71RlfrXFud1xbnsOFZ1uGekPEjHbJ00uD8FInoXmXnqdwa61jcXBG7eMxcr0A+nVs6+7M/+Bm+an06tnX3Zn/wM3zVQDpH/bHfCTpH/bHfCUP8Fm/cH9v1Wv0av/cb/Yf+6v8A/Tq2dfdmf/AzfNUZbfttlgrtKTWGwOmnbVbvTzvjMeWghwYxp8okkDJIAA7c8Km9I/7Y74S/CSTkkk9pK9bgb3G0klxvsLfMrB9BVzNMc0o2TrZpBI4XLja/Uv2V7pJXyPOXPcXHzlZTSTHyXpjWNLjuO4Dnyx8pCxcbHySCONjnvPJrRkn0KfPBc2ZVt31HFfbjTltvopWySOI4Pe05bED1nOC7qAAHWFMxadkdM6Le4WA++CyxZ7fRzTN9p42QOvU9QGauJAC2CNpGCGgH1Kvu1zhtrqOHO0R/pqwqr3tgGNtUnfZoz/5CuDx/+Aeo2LC0cf8AuHzWIXFb/wCX2kf71i/SC5VxUP8AL7SP97RfpNXAYP8Ax0fWoFZ+l2t/5BWgREX1ldKihrwoNWC3adg0tSSfvq5YkqMHiyBp5e+cMeZrgpU1JeaDT1jqrxc5uipKVm+89Z6g0DrJOAB2lUv1lqCt1RqWtvlecS1L8tYDkRMHBrB3AADv4nrUKtm2GbI1K5nlNiQpqfmGn1n+A39+i/dGWCq1PqehsdHkPqpQ1zwP92wcXv8AQ0E/ErsWuiprbbaa30cYipqaJsUTB9a1owB6goq8G/QzrFY3aluUJbcblGBCxw4wwZyPS/g49wb15Uur2ih2GbR1Ky5M4aaSm5x49Z+fUN3miIimLpERERERERFGm3/QztV6ZFwt8W/d7a1z4mtHGaPm+PvPDI7xj64qsOnrvXWK9Ul4tk3RVdLIJI3dR6iCOsEEgjsJV6VWzwiNnTrRXS6ss0A+htS/NZEwf8PKT7PHtXH1E94xXVsB/UauM5TYU64rYPaGtujQ9inPZ/qu36x03BeKBwaT5FRCTl0MoHlMPyg9YIK+NZ6I0zq6NovdtZLMwbsdQwlkrB2Bw4kdxyO5VW2Xa3rtD6iFfAHTUU2GVtMDjpWDkR+E3JIPnHIlW909ebdf7PT3a1VLKikqG7zHt+MEdRB4EHkVup5mzts7VWeEYnDitPzcwBcNQd/T96FRDVeDZoyWYvZcLgAep8cLz69wLi/c0aP+6NZ+Ih+apyRSNgdPeVYfhdL7vifNQb+5o0f90az8RD81P3NGj/ujWfiIfmqckTYHE9580/C6X3fE+ag39zRo/wC6NZ+Ih+an7mjR/wB0az8RD81TkibA4nvPmn4XS+74nzUUad2B6EtUwlmZXXDBB6OaRrI/VG1pPmJKlCgo6WgpIqOhpoaamibuxxRMDWMHYAOAXOi9axrcwFvgpIKe/NtAv39+qKPte7Lbfq3Ugvkt6udBUCnbT4pi0DdaSeZGev4lIKLySNkjdl4uFlUU0VQ3YlFwoh+kXQffhqL8a39i7Vl2LW223233Y6kvNXJQ1DKiOOdzXNLmkHHLu6lKiKO2hp2m4YLqIMIowQQzxPmi+JpY4YXzTSMjjjaXPe84a0DiST1BcdwrKS30U1bXVMVNTQtL5JZXBrWDtJKrJto2rzaqc+y2F0tPZAfqjyC19WR2jmGdjeZ5nsGyedsLbnVeYnisOHx7TzcnQbz9OldTbntFdrG7C22yRwsdG8mPq8Yk4jpD3YyGjsJPXw7uwPZsdTV7dQXmD+BaWT6nG8cKuQHl3sB59RPDtx09jmyyt1fUx3S6skpbCx2S72L6rB9izsb2u9A45ItNQ0tNQ0cNHRwR09PAwMiijbhrGgYAAUOCF0zudk+/ouZwnDJsRn9OrNNw48OweK5hwREVmu5RERERERERERERcVZTU9ZSy0lVDHPBMwskjkblr2kYII6wuVEXhAIsVU/bRs0qdGV7rhbmST2Gd/1N/Emmcfsbz2djuvkePPF7LNoNz0Ndd6LeqbXO4Gqoy7g7q32djwPXjB6iLe19JS19FNRVtPHUU0zCyWKRoc17TzBBVadrmx2u08+W76bjmrrRkufAAXzUo+V7B28wOfWVVz0zonc5GuExXBZqCX0yh0Gdhu8x96KxGltQWnU1ojulmq2VNM/gccHMd1tcObXDsKyqpFo3VV70ldRcbJWGF5AEkbvKimb2Pb1jn3jPAhWV2cbX9O6pbFR1r22i6nh0Ez/qcp/q38j7k4Pn5qRBVtkydkVc4TyigrAGS+q/wPV5fFSQiIpi6NEREREREREWPvF8s1miMt2u1DQMHXUTtjz6zxUf3/bdpKkkdTWSOtv9XxAZSxFrM97nDOO9octb5WM9oqLUVtPT/qvA+PdqpQWl7QNpemdHMfFWVXjdxA8mipyHSZ6t7qYPPx7AVFt3vu2nXG9BabFWWOgecYjaadxb2mWQtcfeY8y+9K+D7VyvbUapvTIgTl0FEN97vPI4YB96fOo7qiR+UTe0qmmxWrqPUoYT/ucLDsvr95KP9ba31VtFu0dG5kxhc/FLbKQOc3PUSBxe7vPLjgBSRst2HFr4rrrZrXYw6O2sdkf9Vw5+5HDtJ4hS7pHR+nNKU5hsVrhpXOGHzcXSye6eckjuzgdQWabNE+Z0LHhz2ezA47vn7D3LyOkz25TcrXR8nhznpFc7nH+H1+HQvqGOOGJkMMbI42NDWMaMBoHIAdQX0vxwy0jJGRzHUoomfe7dT7QJhqu91BsFI8UYmfEQS6jEu87EYyQ53DGBwGQVJe/Y3K+qKgQW9W4N+G4E/AKWEUMaY1bqat1hpm01NwmLaGeSgu2Y2gVUxZUuY48PaQMfw+2KZ0jkEguFjSVjKppcwEWyz6vsdaIiLYpaIiIiIiIiIiIiIiIii3aRsYsWpXyXC0ObZrm7LnGNmYJnfhMHIn2ze3JBVfdZ6G1NpKVzb1bJGU+cNqovLgf2eWOXmdg9yuovmRjJY3RyMa9jhhzXDII7CFEmo2SZjIrnsR5N0tYS9nqO4jTtH+FUHRe1TWGl2sp6ev8AHqJuAKaszI0Dsa7O83zA47lLenfCB09VNYy+Wqttsp9k+HE8Q788HejdK2PVOxzQ98L5WW91qqHfZKBwjHwCCz4sqN774PN2ic51kv8AR1TeplXE6Iju3m7wPqCjhlTD7OYVS2lxzDsonbbR2/HPuUwWfaNoa6hvimp7cHO9iyeXoXn3smCtngmhnjEkEscrDycxwIPpCqTcdju0KjJxYxVNH11PUxuB9BIPxLEN0Zr22TF8Om7/AE8g4F9PTSZ9bAshVyt9pi3N5RV0WU9Mey4+R+Kugh4qn9JPtbpSOgOuGgdRZVEeojCzNHc9ucnkwt1V/wBSjcPje1ZitB/lKks5TNdkYH911ZY2KxmYzGzW4yk5L/FWbx9OF3YIIYG7sMUcTexjQB8SrpRW3wgLi4NNVc6Zh5vmqYYgPQDvfEs9b9lO0a4EO1FtFrIWE+VHBVTzZHZxLQD6Cs2zud7LD8FKixSST9Kld22b8VM9xuVutsJmuNfS0cYGS+eZsY9ZK1k7Q7FV1DqTTkdbqSracFlth342n8KZ2ImjzuWH09sX0VbJhU11PU3qq5ukr5d8E+5GGn05UhUdLTUdMymo6eGngYMMjiYGNaO4DgFuHOO1sPFWDDVye2Awf3H5AeKwtLSaguZEt5qY7bTnj4lQSFzz/aTkA9nBgbg/XOCzlNBDTQthp4mRRt9i1gwAuRFsAspTIwzpPEoulLabXKyuZLb6V7bgN2sDogfGBu7mH+28kY49XBd1EIB1WZaHahY+OyWeOqFVHa6Nk4nFR0jYWh3ShnRh+cey3CW57OCyCIgAGi8a0N0CIiL1ZIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiL//2Q==",
      tag: 'stfm-tracking-active',
      renotify: false,
      silent: true,
      requireInteraction: true,
    });
  } catch(e) {}
}

async function _dismissTrackingNotification() {
  if (!('serviceWorker' in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    (await reg.getNotifications({ tag: 'stfm-tracking-active' })).forEach(n => n.close());
    (await reg.getNotifications({ tag: 'stfm-location-paused' })).forEach(n => n.close());
  } catch(e) {}
}

// ── Sidebar tracking dot ──────────────────────────────────────
function _showTrackingIndicator(active) {
  let dot = document.getElementById('locationTrackingDot');
  if (!dot) {
    dot = document.createElement('span');
    dot.id = 'locationTrackingDot';
    dot.style.cssText = 'display:inline-flex;align-items:center;gap:4px;font-size:10px;color:var(--grn);font-weight:600;margin-left:6px;vertical-align:middle';
    const sbName = document.getElementById('sbName');
    if (sbName) sbName.insertAdjacentElement('afterend', dot);
  }
  dot.innerHTML = active ? '<span style="width:7px;height:7px;border-radius:50%;background:var(--grn);animation:pulse 2s infinite;display:inline-block"></span>' : '';
  dot.style.display = active ? '' : 'none';
}

let _lastSavedLat=null,_lastSavedLng=null,_lastSavedTs=0;
const _LOC_MIN_DIST=0.0002; // ~20m threshold — skip write if user barely moved
const _LOC_MIN_MS=30000;    // min 30s between writes (was 60s) for faster live tracking

async function saveUserLocation(pos) {
  if (!CU || !CU.uid) return;
  if (isAdmin()) return;  // admins never tracked
  const lat=pos.coords.latitude, lng=pos.coords.longitude;
  const now=Date.now();
  // Skip if location hasn't changed meaningfully and was written recently
  if(_lastSavedLat!==null && (now-_lastSavedTs)<_LOC_MIN_MS) {
    const dLat=Math.abs(lat-_lastSavedLat), dLng=Math.abs(lng-_lastSavedLng);
    if(dLat<_LOC_MIN_DIST && dLng<_LOC_MIN_DIST) return;
  }
  try {
    await window.__SF.updateDoc(rootDocRef('users', CU.uid), {
      lastLat: lat,
      lastLng: lng,
      lastLocationAt: new Date().toISOString(),
      lastAccuracy: Math.round(pos.coords.accuracy),
    });
    _lastSavedLat=lat; _lastSavedLng=lng; _lastSavedTs=now;
    navigator.serviceWorker?.controller?.postMessage({
      type: 'LOCATION_UPDATE', lat, lng,
    });
  } catch(e) { /* silent */ }
}

// ── Live Rep Locations — real-time onSnapshot listener ─────────────────
let _repLocUnsub = null;          // active Firestore listener
let _repLocAgeTimer = null;       // interval that ticks the "X min ago" labels
let _repLocLastData = [];         // cached field user data for age-ticker re-renders

function openRepLocations() {
  if(!isAdmin()) { showToast('Admin only','error'); return; }
  closeSidebar(); // ensure sidebar and its backdrop don't block the modal close button
  _startRepLocationsListener();
  openM('mRepLocations');
}

function closeRepLocations() {
  _stopRepLocationsListener();
  closeM('mRepLocations');
}

function _startRepLocationsListener() {
  _stopRepLocationsListener(); // clean up any existing listener

  const list = document.getElementById('repLocationsList');
  if(!list) return;
  list.innerHTML='<div style="font-size:13px;color:var(--tx3);padding:14px 0">Connecting to live feed…</div>';

  // Update the modal header to show LIVE badge
  const ttl = document.querySelector('#mRepLocations .mttl');
  if(ttl) ttl.innerHTML='📍 Sales Rep Locations <span style="display:inline-flex;align-items:center;gap:4px;font-size:10px;font-weight:700;color:var(--grn);background:rgba(34,197,94,.12);border:1px solid rgba(34,197,94,.25);border-radius:6px;padding:2px 7px;margin-left:6px;vertical-align:middle"><span style="width:6px;height:6px;border-radius:50%;background:var(--grn);animation:pulse 2s infinite;display:inline-block"></span>LIVE</span>';

  try {
    const { onSnapshot, query, collection } = window.__SF;
    const usersRef = rootCol('users');
    _repLocUnsub = onSnapshot(usersRef, snap => {
      let fieldUsers = snap.docs.map(d=>d.data())
        .filter(u=>['sales_rep','delivery_man'].includes(u.role) && u.status==='active');
      if(isOwner() && _ownerZoneFilter) {
        fieldUsers = fieldUsers.filter(u=>u.zoneId===_ownerZoneFilter);
      } else if(!isOwner() && CU.zoneId) {
        fieldUsers = fieldUsers.filter(u=>u.zoneId===CU.zoneId);
      }
      _repLocLastData = fieldUsers;
      _renderRepLocationsList(fieldUsers);
      _updateRepLocationsBadge(fieldUsers);
    }, err => {
      if(list) list.innerHTML=`<div style="color:var(--red);font-size:13px;padding:14px">Live feed error: ${err.message}</div>`;
      console.error('[repLocations live]', err);
    });
  } catch(e) {
    // Fallback: onSnapshot not available, do a one-time read
    console.warn('[repLocations] onSnapshot unavailable, falling back to one-time read');
    refreshRepLocations();
    return;
  }

  // Age ticker — re-renders time labels every 30s without hitting Firestore
  _repLocAgeTimer = setInterval(() => {
    if(_repLocLastData.length) _renderRepLocationsList(_repLocLastData);
  }, 30000);
}

function _stopRepLocationsListener() {
  if(_repLocUnsub) { _repLocUnsub(); _repLocUnsub = null; }
  if(_repLocAgeTimer) { clearInterval(_repLocAgeTimer); _repLocAgeTimer = null; }
  _repLocLastData = [];
  // Reset header
  const ttl = document.querySelector('#mRepLocations .mttl');
  if(ttl) ttl.textContent = '📍 Sales Rep Locations';
}

function _renderRepLocationsList(fieldUsers) {
  const list = document.getElementById('repLocationsList');
  if(!list) return;

  if(!fieldUsers.length) {
    list.innerHTML='<div style="color:var(--tx3);font-size:13px;padding:20px;text-align:center">No field users found in this zone</div>';
    return;
  }

  const now = Date.now();
  // Sort: recently updated first
  const sorted = [...fieldUsers].sort((a,b)=>{
    const aT = a.lastLocationAt ? new Date(a.lastLocationAt).getTime() : 0;
    const bT = b.lastLocationAt ? new Date(b.lastLocationAt).getTime() : 0;
    return bT - aT;
  });

  // "Open All on Map" button — builds a multi-stop Google Maps URL
  const withLoc = sorted.filter(u=>u.lastLat&&u.lastLng);
  const allMapBtn = withLoc.length >= 2
    ? `<a href="https://maps.google.com/maps?q=${withLoc.map(u=>`${u.lastLat},${u.lastLng}`).join('+')}+to+" target="_blank" style="display:inline-flex;align-items:center;gap:6px;padding:7px 14px;background:var(--acc);color:#fff;border-radius:var(--r2);font-size:11px;font-weight:700;text-decoration:none;margin-bottom:12px">🗺️ Open All on Map</a>`
    : '';

  const activeCount = withLoc.filter(u => u.lastLocationAt && (now - new Date(u.lastLocationAt).getTime()) < 15*60*1000).length;
  const summaryBar = `<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;flex-wrap:wrap;gap:6px">
    <div style="font-size:12px;color:var(--tx2)">
      <span style="color:var(--grn);font-weight:700">${activeCount}</span> active now ·
      <span style="font-weight:700">${fieldUsers.length}</span> total reps
    </div>
    ${allMapBtn}
  </div>`;

  list.innerHTML = summaryBar + sorted.map(u => {
    const hasLoc = u.lastLat && u.lastLng;
    const locAge = hasLoc && u.lastLocationAt ? Math.round((now - new Date(u.lastLocationAt).getTime())/60000) : null;
    const fresh = locAge !== null && locAge < 15;
    const warn  = locAge !== null && locAge < 60;
    const dotColor = fresh ? 'var(--grn)' : warn ? 'var(--ylw)' : 'var(--tx3)';
    const roleLabel = {sales_rep:'Sales Rep',delivery_man:'Delivery Man'}[u.role]||u.role;
    const roleBg = {sales_rep:'var(--blu)',delivery_man:'var(--grn)'}[u.role]||'var(--tx3)';
    const mapsUrl = `https://www.google.com/maps/dir/?api=1&destination=${u.lastLat},${u.lastLng}&travelmode=driving`;
    const gmapsView = `https://maps.google.com/?q=${u.lastLat},${u.lastLng}`;
    const zoneName_ = u.zoneName || u.zoneId || '—';
    const ageLabel = locAge===null ? '' : locAge===0 ? 'Just now' : locAge<60 ? `${locAge}m ago` : `${Math.round(locAge/60)}h ago`;
    const locTimeStr = u.lastLocationAt ? new Date(u.lastLocationAt).toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',hour12:false}) : '';
    return `
    <div style="background:var(--s2);border:1px solid ${fresh?'rgba(34,197,94,.3)':'var(--bdr)'};border-radius:var(--r);padding:14px;margin-bottom:10px;transition:border-color 0.3s">
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:${hasLoc?'10px':'0'}">
        <div style="position:relative">
          <div class="ava" style="background:${roleBg};width:42px;height:42px;flex-shrink:0">${u.name[0].toUpperCase()}</div>
          <span style="position:absolute;bottom:0;right:0;width:10px;height:10px;border-radius:50%;background:${hasLoc?dotColor:'var(--tx3)'};border:2px solid var(--s2)${fresh?';animation:pulse 2s infinite':''}"></span>
        </div>
        <div style="flex:1;min-width:0">
          <div style="font-weight:700;font-size:13px">${u.name}</div>
          <div style="font-size:11px;color:var(--tx3)">${roleLabel}${isOwner()?' · '+zoneName_:''}</div>
          ${!hasLoc?'<div style="font-size:11px;color:var(--tx3);margin-top:2px">📍 Location not shared yet</div>':''}
        </div>
        <div style="text-align:right;flex-shrink:0">
          ${hasLoc&&locAge!==null?`
            <div style="font-size:11px;font-weight:700;color:${dotColor}">${ageLabel}</div>
            ${locTimeStr?`<div style="font-size:10px;color:var(--tx3)">${locTimeStr}</div>`:''}
          `:''}
        </div>
      </div>
      ${hasLoc?`
      <div style="background:var(--s1);border:1px solid var(--bdr);border-radius:var(--r2);padding:10px 12px">
        <div style="font-size:11px;color:var(--tx3);margin-bottom:7px">
          ${u.lastLat.toFixed(6)}, ${u.lastLng.toFixed(6)}
          ${u.lastAccuracy?`<span style="margin-left:6px">±${u.lastAccuracy}m</span>`:''}
        </div>
        <div style="display:flex;gap:7px">
          <a href="${gmapsView}" target="_blank" style="flex:1;text-align:center;padding:7px;background:var(--s2);border:1px solid var(--bdr);border-radius:var(--r2);font-size:11px;font-weight:600;color:var(--tx);text-decoration:none">🗺️ View</a>
          <a href="${mapsUrl}" target="_blank" style="flex:1;text-align:center;padding:7px;background:var(--acc);border-radius:var(--r2);font-size:11px;font-weight:700;color:#fff;text-decoration:none">🚗 Navigate</a>
        </div>
      </div>`:''}
    </div>`;
  }).join('');
}

// Update sidebar button badge with active rep count
function _updateRepLocationsBadge(fieldUsers) {
  const now = Date.now();
  const activeCount = fieldUsers.filter(u =>
    u.lastLat && u.lastLng && u.lastLocationAt &&
    (now - new Date(u.lastLocationAt).getTime()) < 15*60*1000
  ).length;
  let badge = document.getElementById('repLocBadge');
  if(!badge) {
    const btn = document.querySelector('button[onclick="openRepLocations()"]');
    if(btn) {
      badge = document.createElement('span');
      badge.id = 'repLocBadge';
      badge.style.cssText='display:inline-flex;align-items:center;justify-content:center;background:var(--grn);color:#fff;border-radius:50%;font-size:10px;font-weight:700;width:18px;height:18px;margin-left:auto;flex-shrink:0';
      btn.appendChild(badge);
    }
  }
  if(badge) {
    badge.textContent = activeCount;
    badge.style.display = activeCount > 0 ? 'inline-flex' : 'none';
  }
}

// Legacy one-shot fallback (kept for compatibility)
async function refreshRepLocations() {
  const list = document.getElementById('repLocationsList');
  if(!list) return;
  list.innerHTML='<div style="font-size:13px;color:var(--tx3);padding:14px 0">Refreshing…</div>';
  try {
    const uSnap = await window.__SF.getDocs(rootCol('users'));
    let fieldUsers = uSnap.docs.map(d=>d.data())
      .filter(u=>['sales_rep','delivery_man'].includes(u.role) && u.status==='active');
    if(isOwner() && _ownerZoneFilter) {
      fieldUsers = fieldUsers.filter(u=>u.zoneId===_ownerZoneFilter);
    } else if(!isOwner() && CU.zoneId) {
      fieldUsers = fieldUsers.filter(u=>u.zoneId===CU.zoneId);
    }
    _repLocLastData = fieldUsers;
    _renderRepLocationsList(fieldUsers);
    _updateRepLocationsBadge(fieldUsers);
  } catch(e) {
    if(list) list.innerHTML=`<div style="color:var(--red);font-size:13px;padding:14px">Error: ${e.message}</div>`;
  }
}

// ═══════════════ ROUTES — ACCORDION TREE ═══════════════
const _routeOpen={rep:null, route:null};

async function loadRoutes() {
  await loadCachedData();
  const srch=(document.getElementById('routeSrch')?.value||'').toLowerCase();
  const tree=document.getElementById('routeTree');
  if(!tree)return;

  let visibleRoutes=allRoutes.filter(r=>{
    if(!isAdmin()){
      return r.repId===CU.uid||allOutlets.some(o=>o.routeId===r.id&&(o.createdBy===CU.uid||o.assignedRepId===CU.uid));
    }
    return true;
  }).filter(r=>!srch||r.name.toLowerCase().includes(srch)||(r.description||'').toLowerCase().includes(srch));

  const routeOutletMap={};
  allOutlets.forEach(o=>{if(o.routeId){if(!routeOutletMap[o.routeId])routeOutletMap[o.routeId]=[];routeOutletMap[o.routeId].push(o);}});

  function routeOutletList(routeId){
    const outs=routeOutletMap[routeId]||[];
    if(!outs.length)return'<div style="font-size:12px;color:var(--tx3);padding:4px">No outlets on this route</div>';
    return outs.map(o=>`<div class="oc-mini" onclick="viewOutlet('${o.id}')">
      <div class="oc-mini-ava" style="background:${o.color||'var(--acc)'}">${o.name[0]}</div>
      <div class="oc-mini-info">
        <div class="oc-mini-name">${o.name}</div>
        <div class="oc-mini-sub">${o.type}${o.area?' · '+o.area:''}</div>
      </div>
      <div class="oc-mini-btns" onclick="event.stopPropagation()">
        <button class="btn btn-primary btn-xs" onclick="openNewOrder('${o.id}')">📦</button>
        ${o.phone?`<button class="btn btn-grn btn-xs" onclick="openWhatsApp('${o.id}')">💬</button>`:''}
      </div>
    </div>`).join('');
  }

  if(!isAdmin()){
    if(!visibleRoutes.length){
      tree.innerHTML=`<div style="text-align:center;padding:40px;color:var(--tx3)"><div style="font-size:40px;margin-bottom:12px">🗺️</div><div style="font-size:14px;font-weight:600;margin-bottom:16px">No routes yet</div>${!isDeliveryMan()?'<button class="btn btn-primary btn-sm" onclick="openNewRoute()">+ Add Route</button>':''}</div>`;return;
    }
    tree.innerHTML=visibleRoutes.map(r=>{
      const outs=routeOutletMap[r.id]||[];
      const isOpen=_routeOpen.route===r.id;
      const canEdit=!isDeliveryMan()&&(r.repId===CU.uid||!r.repId);
      return`<div class="tree-l2" id="rtl2-${r.id}">
        <div class="tree-hdr2 ${isOpen?'open':''}" onclick="toggleRouteNode('${r.id}')">
          <span class="tree-chevron">▶</span><span style="font-size:16px">🗺️</span>
          <div style="flex:1">
            <div style="font-size:13px;font-weight:700">${r.name}</div>
            ${r.description?`<div style="font-size:10px;color:var(--tx3)">${r.description}</div>`:''}
            <div style="font-size:10px;color:var(--tx3)">${outs.length} outlet${outs.length!==1?'s':''}</div>
          </div>
          ${canEdit?`<div onclick="event.stopPropagation();editRoute('${r.id}')" style="cursor:pointer;color:var(--tx3);padding:4px 8px;font-size:13px" title="Edit route">✏️</div>`:''}
        </div>
        <div class="tree-body2 ${isOpen?'open':''}" id="rtbody2-${r.id}">${routeOutletList(r.id)}</div>
      </div>`;
    }).join('')+
    (!isDeliveryMan()?`<div style="text-align:center;margin-top:12px"><button class="btn btn-primary btn-sm" onclick="openNewRoute()">+ Add Route</button></div>`:'');
    return;
  }

  const reps=allUsers.filter(u=>u.role==='sales_rep');
  const routesByRep={};
  visibleRoutes.forEach(r=>{const key=r.repId||'__unassigned__';if(!routesByRep[key])routesByRep[key]=[];routesByRep[key].push(r);});

  let html=reps.filter(rep=>routesByRep[rep.uid]?.length||(srch?rep.name.toLowerCase().includes(srch):true)).map(rep=>{
    const routes=routesByRep[rep.uid]||[];
    const isRepOpen=_routeOpen.rep===rep.uid;
    const totalOutlets=routes.reduce((s,r)=>(routeOutletMap[r.id]||[]).length+s,0);
    return`<div class="tree-node" id="rtrep-${rep.uid}">
      <div class="tree-hdr ${isRepOpen?'open':''}" onclick="toggleRouteRep('${rep.uid}')">
        <span class="tree-chevron">▶</span>
        <div class="ava ava-sm" style="background:var(--blu);flex-shrink:0">${rep.name[0]}</div>
        <div style="flex:1"><div style="font-size:13px;font-weight:700">${rep.name}</div>
        <div style="font-size:10px;color:var(--tx3)">${routes.length} route${routes.length!==1?'s':''} · ${totalOutlets} outlet${totalOutlets!==1?'s':''}</div></div>
        <span style="font-size:11px;color:var(--tx3)">${rep.phone||''}</span>
      </div>
      <div class="tree-body ${isRepOpen?'open':''}" id="rtrepbody-${rep.uid}">
        ${routes.length?routes.map(r=>{
          const outs=routeOutletMap[r.id]||[];
          const isOpen=_routeOpen.route===r.id;
          return`<div class="tree-l2" id="rtl2-${r.id}">
            <div class="tree-hdr2 ${isOpen?'open':''}" onclick="toggleRouteNode('${r.id}')">
              <span class="tree-chevron">▶</span><span style="font-size:15px">🗺️</span>
              <div style="flex:1"><div style="font-size:12px;font-weight:700">${r.name}</div>
              ${r.description?`<div style="font-size:10px;color:var(--tx3)">${r.description}</div>`:''}
              <div style="font-size:10px;color:var(--tx3)">${outs.length} outlet${outs.length!==1?'s':''}</div></div>
              <div onclick="event.stopPropagation();editRoute('${r.id}')" style="cursor:pointer;color:var(--tx3);padding:4px 6px;font-size:11px">✏️</div>
              <div onclick="event.stopPropagation();delRoute('${r.id}')" style="cursor:pointer;color:var(--red);padding:4px 6px;font-size:11px">🗑</div>
            </div>
            <div class="tree-body2 ${isOpen?'open':''}" id="rtbody2-${r.id}">${routeOutletList(r.id)}</div>
          </div>`;
        }).join(''):'<div style="font-size:12px;color:var(--tx3);padding:6px">No routes assigned</div>'}
      </div>
    </div>`;
  }).join('');

  if(routesByRep['__unassigned__']?.length){
    const unasRoutes=routesByRep['__unassigned__'];
    const isOpen=_routeOpen.rep==='__unassigned__';
    html+=`<div class="tree-node" id="rtrep-__unassigned__">
      <div class="tree-hdr ${isOpen?'open':''}" onclick="toggleRouteRep('__unassigned__')">
        <span class="tree-chevron">▶</span><span style="font-size:18px">⚠️</span>
        <div style="flex:1;font-size:13px;font-weight:700">Unassigned Routes (${unasRoutes.length})</div>
      </div>
      <div class="tree-body ${isOpen?'open':''}" id="rtrepbody-__unassigned__">
        ${unasRoutes.map(r=>{
          const outs=routeOutletMap[r.id]||[];
          const isRouteOpen=_routeOpen.route===r.id;
          return`<div class="tree-l2" id="rtl2-${r.id}">
            <div class="tree-hdr2 ${isRouteOpen?'open':''}" onclick="toggleRouteNode('${r.id}')">
              <span class="tree-chevron">▶</span><span style="font-size:15px">🗺️</span>
              <div style="flex:1"><div style="font-size:12px;font-weight:700">${r.name}</div>
              <div style="font-size:10px;color:var(--tx3)">${outs.length} outlet${outs.length!==1?'s':''}</div></div>
              <div onclick="event.stopPropagation();editRoute('${r.id}')" style="cursor:pointer;color:var(--tx3);padding:4px 6px;font-size:11px">✏️</div>
            </div>
            <div class="tree-body2 ${isRouteOpen?'open':''}" id="rtbody2-${r.id}">${routeOutletList(r.id)}</div>
          </div>`;
        }).join('')}
      </div>
    </div>`;
  }

  if(!isDeliveryMan()) html+=`<div style="text-align:center;margin-top:10px"><button class="btn btn-primary btn-sm" onclick="openNewRoute()">+ Add Route</button></div>`;
  tree.innerHTML=html||'<div style="text-align:center;padding:30px;color:var(--tx3)">No routes found</div>';
}

function toggleRouteRep(repUid){
  const wasOpen=_routeOpen.rep===repUid;
  document.querySelectorAll('[id^="rtrep-"]').forEach(n=>{n.querySelector('.tree-hdr')?.classList.remove('open');n.querySelector('.tree-body')?.classList.remove('open');});
  _routeOpen.route=null;
  if(!wasOpen){
    _routeOpen.rep=repUid;
    const hdr=document.querySelector(`#rtrep-${CSS.escape(repUid)} .tree-hdr`);
    const body=document.getElementById(`rtrepbody-${repUid}`);
    if(hdr)hdr.classList.add('open');if(body)body.classList.add('open');
  } else { _routeOpen.rep=null; }
}

function toggleRouteNode(routeId){
  const wasOpen=_routeOpen.route===routeId;
  document.querySelectorAll('[id^="rtl2-"]').forEach(n=>{n.querySelector('.tree-hdr2')?.classList.remove('open');n.querySelector('.tree-body2')?.classList.remove('open');});
  if(!wasOpen){
    _routeOpen.route=routeId;
    const hdr=document.querySelector(`#rtl2-${CSS.escape(routeId)} .tree-hdr2`);
    const body=document.getElementById(`rtbody2-${routeId}`);
    if(hdr)hdr.classList.add('open');if(body)body.classList.add('open');
  } else { _routeOpen.route=null; }
}

function viewRouteOutlets(routeId) {
  const r=allRoutes.find(x=>x.id===routeId);if(!r)return;
  const assignedRep=allUsers.find(u=>u.uid===r.repId);
  const assignedDeliv=allUsers.find(u=>u.uid===r.delivManId);
  const outlets=allOutlets.filter(o=>o.routeId===routeId);

  document.getElementById('mRDTitle').textContent=`🗺️ ${r.name}`;
  document.getElementById('mRDSub').textContent=r.description||'';
  const editBtn=document.getElementById('mRDEditBtn');
  const canEditRoute=isAdmin()||(isSalesRep()&&(r.repId===CU.uid||!r.repId));
  if(editBtn&&canEditRoute){editBtn.style.display='';editBtn.setAttribute('onclick',`closeM('mRouteDetail');editRoute('${routeId}')`);}

  document.getElementById('mRDBody').innerHTML=`
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px">
      <div style="background:var(--s2);border:1px solid var(--bdr);border-radius:var(--r2);padding:12px">
        <div style="font-size:10px;color:var(--tx3);font-weight:600;text-transform:uppercase;letter-spacing:.4px;margin-bottom:5px">Sales Rep</div>
        ${assignedRep?`<div style="display:flex;align-items:center;gap:8px">
          <div class="ava ava-sm" style="background:var(--blu)">${assignedRep.name[0]}</div>
          <div><div style="font-size:13px;font-weight:700">${assignedRep.name}</div><div style="font-size:11px;color:var(--tx3)">${assignedRep.phone||assignedRep.email}</div></div>
        </div>`:`<span style="color:var(--tx3);font-size:12px">Unassigned</span>`}
      </div>
      <div style="background:var(--s2);border:1px solid var(--bdr);border-radius:var(--r2);padding:12px">
        <div style="font-size:10px;color:var(--tx3);font-weight:600;text-transform:uppercase;letter-spacing:.4px;margin-bottom:5px">Delivery Man</div>
        ${assignedDeliv?`<div style="display:flex;align-items:center;gap:8px">
          <div class="ava ava-sm" style="background:var(--grn)">${assignedDeliv.name[0]}</div>
          <div><div style="font-size:13px;font-weight:700">${assignedDeliv.name}</div><div style="font-size:11px;color:var(--tx3)">${assignedDeliv.phone||assignedDeliv.email}</div></div>
        </div>`:`<span style="color:var(--tx3);font-size:12px">Unassigned</span>`}
      </div>
    </div>
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
      <div style="font-family:'Syne',sans-serif;font-size:13px;font-weight:700">🏪 Outlets on this route <span style="color:var(--acc)">(${outlets.length})</span></div>
    </div>
    ${outlets.length?`<div style="display:flex;flex-direction:column;gap:8px">
      ${outlets.map(o=>`<div style="background:var(--s2);border:1px solid var(--bdr);border-radius:var(--r2);padding:11px 13px;display:flex;align-items:center;justify-content:space-between;gap:10px">
        <div style="display:flex;align-items:center;gap:9px;flex:1;min-width:0">
          <div class="ava ava-sm" style="background:${o.color||'var(--acc)'};flex-shrink:0">${o.name[0]}</div>
          <div style="min-width:0">
            <div style="font-size:13px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${o.name}</div>
            <div style="font-size:11px;color:var(--tx3)">${o.type}${o.area?' · '+o.area:''}</div>
          </div>
        </div>
        <div style="display:flex;gap:5px;flex-shrink:0">
          <button class="btn btn-primary btn-xs" onclick="closeM('mRouteDetail');openNewOrder('${o.id}')">📦</button>
          ${o.phone?`<button class="btn btn-grn btn-xs" onclick="openWhatsApp('${o.id}')">💬</button>`:''}
          ${o.lat&&o.lng?`<button class="btn btn-blu btn-xs" onclick="openDirections('${o.id}')">🗺️</button>`:''}
        </div>
      </div>`).join('')}
    </div>`:`<div style="text-align:center;padding:30px;color:var(--tx3);font-size:13px">No outlets assigned to this route yet</div>`}
  `;
  openM('mRouteDetail');
}

function openNewRoute() {
  if(isDeliveryMan()){showToast('Access denied','error');return;}
  document.getElementById('mRouteTitle').textContent='🗺️ Add Route';
  document.getElementById('rEditId').value='';
  document.getElementById('rName').value='';
  document.getElementById('rDesc').value='';
  _populateRouteUserDropdown('rRep','sales_rep', isAdmin()?'':(CU.uid));
  _populateRouteUserDropdown('rDelivMan','delivery_man','');
  // Hide rep/delivery dropdowns for sales rep (auto-assigned to themselves)
  const rRepRow=document.getElementById('rRepRow');
  if(rRepRow)rRepRow.style.display=isAdmin()?'':'none';
  openM('mRoute');
}

async function editRoute(id) {
  if(isDeliveryMan()){showToast('Access denied','error');return;}
  const r=allRoutes.find(x=>x.id===id);if(!r)return;
  // Sales rep can only edit their own routes
  if(!isAdmin()&&r.repId!==CU.uid){showToast('You can only edit your own routes','error');return;}
  document.getElementById('mRouteTitle').textContent='✏️ Edit Route';
  document.getElementById('rEditId').value=id;
  document.getElementById('rName').value=r.name||'';
  document.getElementById('rDesc').value=r.description||'';
  _populateRouteUserDropdown('rRep','sales_rep',r.repId||'');
  _populateRouteUserDropdown('rDelivMan','delivery_man',r.delivManId||'');
  const rRepRow=document.getElementById('rRepRow');
  if(rRepRow)rRepRow.style.display=isAdmin()?'':'none';
  openM('mRoute');
}

function _populateRouteUserDropdown(selectId, role, selectedUid) {
  const el=document.getElementById(selectId);if(!el)return;
  const users=allUsers.filter(u=>u.role===role&&u.status!=='disabled');
  el.innerHTML='<option value="">Unassigned</option>'+
    users.map(u=>`<option value="${u.uid}" ${u.uid===selectedUid?'selected':''}>${u.name}</option>`).join('');
}

async function saveRoute() {
  if(isDeliveryMan()){showToast('Access denied','error');return;}
  const name=document.getElementById('rName').value.trim();
  if(!name){showToast('Route name required','error');return;}
  const editId=document.getElementById('rEditId').value;
  // Sales rep: auto-assign to themselves; admin: use dropdown
  const repIdVal=isAdmin()?(document.getElementById('rRep')?.value||null):CU.uid;
  const delivManIdVal=isAdmin()?(document.getElementById('rDelivMan')?.value||null):null;
  const data={
    name,
    description:document.getElementById('rDesc').value.trim(),
    repId:repIdVal,
    delivManId:delivManIdVal,
    updatedAt:new Date().toISOString(),
  };
  try{
    if(editId){
      await sfUpdate('routes',editId,data);
      showToast('Route updated','success');
    } else {
      data.createdBy=CU.uid;data.createdAt=new Date().toISOString();
      await sfAdd('routes',data);
      showToast(`Route "${name}" created 🗺️`,'success');
    }
    closeM('mRoute');
    await loadCachedData();
    loadRoutes();
  }catch(e){showToast('Error saving route: '+e.message,'error');}
}

async function delRoute(id) {
  if(!isAdmin())return;
  const r=allRoutes.find(x=>x.id===id);
  const outletCount=allOutlets.filter(o=>o.routeId===id).length;
  if(outletCount>0){showToast(`Cannot delete — ${outletCount} outlet(s) are on this route. Reassign them first.`,'error');return;}
  const label=r?r.name:`Route ${id}`;
  if(isStrictAdmin()){
    if(!await _customConfirm(`Route "${label}" will be permanently deleted.`, {title:'Delete Route',okText:'Delete',cancelText:'Cancel',danger:true,icon:'🗑️'}))return;
    await sfDelete('routes',id);
    showToast('Route deleted','warn');
    await loadCachedData();loadRoutes();
  } else {
    await requestDeleteApproval('route',id,label);
  }
}

// ═══════════════ DELIVERIES (Admin View) ═══════════════
async function loadDeliveries() {
  if(!isAdmin()){showToast('Access denied','error');return;}
  const srch=(document.getElementById('delivAdminSrch')?.value||'').toLowerCase();
  const statusF=document.getElementById('delivAdminStatus')?.value||'';
  const delivManF=document.getElementById('delivManFilter')?.value||'';

  // Populate delivery man filter
  const dmSel=document.getElementById('delivManFilter');
  if(dmSel&&dmSel.options.length<=1){
    allUsers.filter(u=>u.role==='delivery_man').forEach(u=>{
      const o=document.createElement('option');o.value=u.uid;o.textContent=u.name;dmSel.appendChild(o);
    });
  }

  const {where}=window.__SF;
  const ordDocs=await sfGet('orders');
  let orders=ordDocs.map(d=>({_docId:d.id,...d.data()}))
    .filter(o=>['Confirmed','Assigned','In Transit','Delivered','Failed'].includes(o.status));

  if(srch)orders=orders.filter(o=>(o.id||o._docId).toLowerCase().includes(srch)||outletName(o.outletId).toLowerCase().includes(srch));
  if(statusF==='Confirmed')orders=orders.filter(o=>o.status==='Confirmed'&&!o.deliveryManId);
  else if(statusF)orders=orders.filter(o=>o.status===statusF);
  if(delivManF)orders=orders.filter(o=>o.deliveryManId===delivManF);
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
    const dm=o.deliveryManId?allUsers.find(u=>u.uid===o.deliveryManId):null;
    return`<tr>
      <td><span style="font-family:'Syne',sans-serif;font-weight:700;font-size:12px">${o.id||o._docId}</span></td>
      <td style="font-size:12px">${outletName(o.outletId)}</td>
      <td style="font-size:11px;color:var(--tx2)">${outlet.route?`<span class="bdg bdg-pur" style="font-size:10px">🗺️ ${outlet.route}</span>`:'—'}</td>
      <td><span style="font-family:'Syne',sans-serif;font-weight:700;color:var(--acc)">${fmt(o.total)}</span></td>
      <td style="font-size:12px">${dm?`<div style="display:flex;align-items:center;gap:6px"><div class="ava ava-sm" style="background:var(--grn)">${dm.name[0]}</div>${dm.name}</div>`:'<span style="color:var(--tx3)">Unassigned</span>'}</td>
      <td><span class="bdg ${sBadge[o.status]||'bdg-gry'}">${o.status}</span></td>
      <td>
        <div style="display:flex;gap:5px;flex-wrap:wrap">
          ${o.status==='Confirmed'?`<button class="btn btn-ylw btn-xs" onclick="openAssignDelivery('${o._docId}')">🚚 Assign</button>`:''}
          ${o.status==='Assigned'?`<button class="btn btn-blu btn-xs" onclick="openAssignDelivery('${o._docId}')">✏️ Reassign</button>`:''}
          ${o.status==='In Transit'?`<button class="btn btn-grn btn-xs" onclick="markDelivered('${o._docId}')">✓ Done</button>`:''}
          ${['Assigned','In Transit'].includes(o.status)?`<button class="btn btn-red btn-xs" onclick="markDeliveryFailed('${o._docId}')">✕ Fail</button>`:''}
          ${o.status==='Failed'?`<button class="btn btn-ylw btn-xs" onclick="reopenFailedDelivery('${o._docId}')">🔄 Reopen</button>`:''}
          <button class="btn btn-ghost btn-xs" onclick="viewOrder('${o._docId}')">👁</button>
        </div>
      </td>
    </tr>`;
  }).join('')||'<tr><td colspan="7" style="text-align:center;padding:24px;color:var(--tx3)">No deliveries found</td></tr>';

  // Update badge
  const unassigned=orders.filter(o=>o.status==='Confirmed'&&!o.deliveryManId).length;
  const badge=document.getElementById('delivAdminBadge');
  if(badge){badge.textContent=unassigned;badge.style.display=unassigned?'':'none';}
}

async function openAssignDelivery(ordDocId) {
  if(!isAdmin()&&CU.role!=='sales_rep'){showToast('Access denied','error');return;}
  // Fetch single order doc + users in parallel (was: full collection scan)
  const [ordSnap, uSnap] = await Promise.all([
    window.__SF.getDoc(docRef('orders', ordDocId)),
    _fetchUsers()                          // zone-filtered for non-owners
  ]);
  if(!ordSnap.exists()){showToast('Order not found','error');return;}
  allUsers = uSnap.docs.map(d=>({...d.data()}));
  const o = {_docId: ordSnap.id, ...ordSnap.data()};
  const outlet=allOutlets.find(x=>x.id===o.outletId)||{name:'Unknown'};
  document.getElementById('assignDeliveryOrderInfo').innerHTML=`
    <div style="font-weight:700;font-size:13px;margin-bottom:4px">📦 ${o.id||o._docId}</div>
    <div style="font-size:12px;color:var(--tx2)">Outlet: ${outlet.name}${outlet.route?' · 🗺️ '+outlet.route:''}</div>
    <div style="font-size:12px;color:var(--acc);font-weight:700">Total: ${fmt(o.total)}</div>`;
  document.getElementById('assignDelivOrderId').value=ordDocId;
  document.getElementById('assignDelivDate').value=todayStr();
  document.getElementById('assignDelivNotes').value=o.deliveryNotes||'';
  // Populate delivery men dropdown
  const sel=document.getElementById('assignDelivMan');
  const delivMen=allUsers.filter(u=>u.role==='delivery_man'&&u.status!=='disabled');
  if(!delivMen.length){
    showToast('No delivery men found. Add a delivery man user first.','warn');
  }
  sel.innerHTML='<option value="">Select delivery man...</option>'+
    delivMen.map(u=>`<option value="${u.uid}" ${u.uid===o.deliveryManId?'selected':''}>${u.name}${u.phone?' — '+u.phone:''}</option>`).join('');
  openM('mAssignDelivery');
}

async function saveDeliveryAssignment() {
  const ordDocId=document.getElementById('assignDelivOrderId').value;
  const delivManId=document.getElementById('assignDelivMan').value;
  if(!delivManId){showToast('Select a delivery man','error');return;}
  // Get name from the dropdown option text (safe — allUsers may be stale)
  const sel=document.getElementById('assignDelivMan');
  const selectedOption=sel.options[sel.selectedIndex];
  const delivManName=selectedOption?selectedOption.text.split(' — ')[0]:'';
  // Also try allUsers in case it's fresh
  const delivMan=allUsers.find(u=>u.uid===delivManId);
  const finalName=delivMan?.name||delivManName||'';
  try {
    await sfUpdate('orders',ordDocId,{
      status:'Assigned',
      deliveryManId,
      deliveryManName:finalName,
      deliveryDate:document.getElementById('assignDelivDate').value,
      deliveryNotes:document.getElementById('assignDelivNotes').value,
      assignedAt:new Date().toISOString(),
      assignedBy:CU.uid,
    });
    showToast(`Order assigned to ${finalName||'delivery man'} 🚚`,'success');
    closeM('mAssignDelivery');
    // Refresh both views
    loadDeliveries();
    loadOrders();
    updateBadges();
  } catch(e) {
    showToast('Failed to assign: '+e.message,'error');
  }
}

async function markDelivered(ordDocId) {
  if(!await _customConfirm('Mark this order as delivered?', {title:'Confirm Delivery',okText:'Mark Delivered',cancelText:'Cancel',icon:'🚚'}))return;
  await sfUpdate('orders',ordDocId,{
    status:'Delivered',
    deliveredAt:new Date().toISOString(),
    deliveredBy:CU.uid,
  });
  showToast('Order marked as Delivered ✅','success');
  invalidateDashCache();loadDeliveries();renderDashboard();
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
  if(!await _customConfirm('Reopen this failed delivery?\n\nIt will go back to Confirmed status and can be reassigned.', {title:'Reopen Delivery',okText:'Reopen',cancelText:'Cancel',icon:'🔄'}))return;
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
  if(!await _customConfirm('Confirm this order was successfully delivered?', {title:'Confirm Delivery',okText:'Yes, Delivered ✅',cancelText:'Cancel',icon:'📬'}))return;
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

// ═══════════════ QR SCANNER ═══════════════
let _qrStream=null;
let _qrInterval=null;

function openQRScanner() {
  openM('mQRScan');
  document.getElementById('qrManualCode').value='';
  document.getElementById('qrScanStatus').textContent='Starting camera…';
  _startQRCamera();
}

async function _startQRCamera() {
  try {
    _qrStream=await navigator.mediaDevices.getUserMedia({video:{facingMode:'environment',width:640,height:640},audio:false});
    const vid=document.getElementById('qrVideo');
    vid.srcObject=_qrStream;
    await vid.play();
    document.getElementById('qrScanStatus').textContent='Scanning — point at outlet QR code';
    // Poll frames for QR decode using BarcodeDetector if available
    if('BarcodeDetector' in window){
      const bd=new BarcodeDetector({formats:['qr_code']});
      _qrInterval=setInterval(async()=>{
        try{
          const codes=await bd.detect(vid);
          if(codes.length){
            const raw=codes[0].rawValue;
            closeQRScanner();
            _handleQRResult(raw);
          }
        }catch(e){}
      },400);
    } else {
      document.getElementById('qrScanStatus').textContent='Auto-scan unavailable — enter code manually below';
    }
  } catch(e) {
    document.getElementById('qrScanStatus').textContent='Camera access denied — use manual entry below';
  }
}

function closeQRScanner() {
  if(_qrInterval){clearInterval(_qrInterval);_qrInterval=null;}
  if(_qrStream){_qrStream.getTracks().forEach(t=>t.stop());_qrStream=null;}
  closeM('mQRScan');
}

function handleQRManual() {
  const raw=document.getElementById('qrManualCode').value.trim();
  if(!raw){showToast('Enter an outlet code or URL','warn');return;}
  closeQRScanner();
  _handleQRResult(raw);
}

function _handleQRResult(raw) {
  // Handle full URL ?oc=ID or plain outlet ID
  let outletId=raw;
  try {
    const url=new URL(raw);
    outletId=url.searchParams.get('oc')||raw;
  } catch(e){}
  const outlet=allOutlets.find(o=>o.id===outletId);
  if(outlet){
    goPage('orders');
    setTimeout(()=>openNewOrder(outletId),400);
  } else {
    showToast('QR code not recognised — outlet not found','error');
  }
}

// ═══════════════ NON-PRODUCTIVE VISIT ═══════════════
function openNPVisit(preselectedOutletId=null) {
  // Populate outlets
  const visibleOutlets=isAdmin()?allOutlets:allOutlets.filter(o=>o.createdBy===CU.uid||o.assignedRepId===CU.uid);
  const sel=document.getElementById('npOutlet');
  sel.innerHTML='<option value="">Select outlet...</option>'+
    visibleOutlets.map(o=>`<option value="${o.id}">${o.name}</option>`).join('');
  if(preselectedOutletId)sel.value=preselectedOutletId;
  document.getElementById('npDate').value=todayStr();
  document.getElementById('npNotes').value='';
  document.getElementById('npReason').value='';
  document.getElementById('npPhotoData').value='';
  const prev=document.getElementById('npPhotoPreview');
  if(prev){prev.innerHTML='📷';prev.style.border='2px dashed var(--bdr)';}
  openM('mNPVisit');
}

function previewNPPhoto(input) {
  const file=input.files[0];if(!file)return;
  if(file.size>10*1024*1024){showToast('Photo too large (max 10MB)','error');return;}
  const reader=new FileReader();
  reader.onload=e=>{
    // Compress to max ~700KB so it fits in Firestore document (1MB limit)
    const img=new Image();
    img.onload=()=>{
      const canvas=document.createElement('canvas');
      let w=img.width,h=img.height;
      const maxDim=1200;
      if(w>maxDim||h>maxDim){const s=maxDim/Math.max(w,h);w=Math.round(w*s);h=Math.round(h*s);}
      canvas.width=w;canvas.height=h;
      canvas.getContext('2d').drawImage(img,0,0,w,h);
      const compressed=canvas.toDataURL('image/jpeg',0.75);
      document.getElementById('npPhotoData').value=compressed;
      const prev=document.getElementById('npPhotoPreview');
      if(prev){prev.innerHTML=`<img src="${compressed}" style="width:100%;height:100%;object-fit:cover;border-radius:8px">`;prev.style.border='2px solid var(--grn)';}
    };
    img.src=e.target.result;
  };
  reader.readAsDataURL(file);
}

async function saveNPVisit() {
  const outletId=document.getElementById('npOutlet').value;
  const reason=document.getElementById('npReason').value;
  if(!outletId){showToast('Select an outlet','error');return;}
  if(!reason){showToast('Select a reason','error');return;}
  const data={
    outletId,
    outletName:outletName(outletId),
    reason,
    notes:document.getElementById('npNotes').value.trim(),
    photo:document.getElementById('npPhotoData').value,
    date:document.getElementById('npDate').value,
    createdBy:CU.uid,
    createdByName:CU.name,
    createdAt:window.__SF.serverTimestamp(),
    zoneId:CU.zoneId||null,
    type:'non_productive'
  };
  try{
    await sfAdd('visits',data);
    closeM('mNPVisit');
    showToast('Non-productive visit logged 📝','success');
  }catch(e){showToast('Error saving visit: '+e.message,'error');}
}

// ═══════════════ SALES TARGET ═══════════════
let MONTHLY_TARGET_DYNAMIC = 500000; // overridden by Firestore

async function loadSalesTarget() {
  try {
    const m=todayStr().slice(0,7);
    const targetId=`__all__-${m}`;
    const snap=await window.__SF.getDoc(docRef('targets',targetId));
    if(snap.exists()){ MONTHLY_TARGET_DYNAMIC=snap.data().amount||500000; }
    // Rerender ring if dashboard is active
    const rd=document.getElementById('ringDash');
    if(rd){ _refreshTargetRing(); }
  } catch(e){}
}

function _refreshTargetRing() {
  const rTarget=document.getElementById('rTarget');
  if(rTarget)rTarget.textContent=fmt(MONTHLY_TARGET_DYNAMIC);
  // Recompute pct from existing rAchieved value
  const rAch=document.getElementById('rAchieved');
  if(!rAch)return;
  const achieved=parseFloat(rAch.textContent.replace(/[^\d.]/g,''))||0;
  const pct=Math.min(100,Math.round(achieved/Math.max(MONTHLY_TARGET_DYNAMIC,1)*100));
  const offset=289-(pct/100)*289;
  const rd=document.getElementById('ringDash');if(rd)rd.setAttribute('stroke-dashoffset',offset);
  const rp=document.getElementById('ringPct');if(rp)rp.textContent=pct+'%';
}

function openSetTarget() {
  if(!isAdmin()){showToast('Admin only','error');return;}
  // Populate user dropdown
  const sel=document.getElementById('targetForUser');
  sel.innerHTML='<option value="__all__">Overall (All Reps Combined)</option>'+
    allUsers.filter(u=>u.role==='sales_rep').map(u=>`<option value="${u.uid}">${u.name}</option>`).join('');
  document.getElementById('targetMonth').value=todayStr().slice(0,7);
  document.getElementById('targetAmount').value='';
  document.getElementById('currentTargetInfo').style.display='none';
  loadCurrentTarget();
  openM('mSalesTarget');
}

async function loadCurrentTarget() {
  const userId=document.getElementById('targetForUser')?.value||'__all__';
  const month=document.getElementById('targetMonth')?.value||todayStr().slice(0,7);
  const targetId=`${userId}-${month}`;
  const info=document.getElementById('currentTargetInfo');
  try{
    const snap=await window.__SF.getDoc(docRef('targets',targetId));
    if(snap.exists()){
      const d=snap.data();
      info.style.display='';
      info.textContent=`Current target: ${fmt(d.amount)} (set by ${d.setByName||'Admin'})`;
      document.getElementById('targetAmount').value=d.amount;
    } else {
      info.style.display='';
      info.textContent='No target set for this period.';
    }
  }catch(e){info.style.display='none';}
}

async function saveSalesTarget() {
  if(!isAdmin())return;
  const userId=document.getElementById('targetForUser').value;
  const month=document.getElementById('targetMonth').value;
  const amount=parseFloat(document.getElementById('targetAmount').value);
  if(!month){showToast('Select a month','error');return;}
  if(!amount||amount<=0){showToast('Enter a valid target amount','error');return;}
  const targetId=`${userId}-${month}`;
  const targetUser=userId==='__all__'?'All Reps':allUsers.find(u=>u.uid===userId)?.name||userId;
  try{
    const _tdata={userId,month,amount,setBy:CU.uid,setByName:CU.name,targetFor:targetUser,updatedAt:new Date().toISOString()};
    await window.__SF.setDoc(docRef('targets',targetId),_tdata);
    if(CU&&CU.zoneId&&!isOwner()){
      try{await window.__SF.setDoc(rootDocRef('targets',targetId),{..._tdata,_zoneId:CU.zoneId});}catch(e){}
    }
    if(userId==='__all__'&&month===todayStr().slice(0,7)){
      MONTHLY_TARGET_DYNAMIC=amount;
      _refreshTargetRing();
    }
    closeM('mSalesTarget');
    showToast(`Target ${fmt(amount)} set for ${targetUser} — ${month} 🎯`,'success');
  }catch(e){showToast('Error saving target: '+e.message,'error');}
}

// ═══════════════ REP MONITORING (admin only) ═══════════════
let _monTab='overview';
let _monGen=0;
function switchMonTab(tab,el){
  _monTab=tab;
  document.querySelectorAll('#pageMonitoring .rtab').forEach(x=>x.classList.remove('active'));
  if(el)el.classList.add('active');
  loadMonitoring();
}

async function loadMonitoring() {
  if(!isAdmin()){showToast('Admin only','error');return;}
  // Populate rep filter on first load
  const repSel=document.getElementById('monRepFilter');
  if(repSel&&repSel.options.length===1){
    allUsers.filter(u=>u.role==='sales_rep').forEach(u=>{
      const o=document.createElement('option');o.value=u.uid;o.textContent=u.name;repSel.appendChild(o);
    });
  }
  const repFilter=document.getElementById('monRepFilter')?.value||'';
  const periodVal=document.getElementById('monPeriod')?.value||'today';
  const todayStr=new Date().toISOString().split('T')[0];
  // ★ FIX: days/cutStr/periodLabel hoisted — all tab branches need them
  const days = periodVal==='today' ? 1 : (parseInt(periodVal)||30);
  let cutStr;
  if(periodVal==='today'){
    cutStr=todayStr;
  } else {
    const cutoff=new Date();cutoff.setDate(cutoff.getDate()-days);
    cutStr=cutoff.toISOString().split('T')[0];
  }
  const periodLabel = periodVal==='today'?'Today':days===7?'Last 7 days':days===30?'Last 30 days':`Last ${days} days`;

  const {where}=window.__SF;
  const reps=repFilter
    ?allUsers.filter(u=>u.uid===repFilter)
    :allUsers.filter(u=>u.role==='sales_rep');

  const content=document.getElementById('monContent');
  if(!content)return;
  content.innerHTML='<div style="text-align:center;padding:20px;color:var(--tx3)">Loading…</div>';

  const gen=++_monGen;
  try {
  if(_monTab==='overview') {
    // Load all data in parallel
    const [ordDocs,colDocs,attDocs,visitDocs]=await Promise.all([
      sfGet('orders'),sfGet('collections'),sfGet('attendance'),sfGet('visits')
    ]);
    const orders=ordDocs.map(d=>({id:d.id,...d.data()})).filter(o=>o.date>=cutStr);
    const cols=colDocs.map(d=>d.data()).filter(c=>c.date>=cutStr);
    const att=attDocs.map(d=>d.data()).filter(a=>a.date>=cutStr);
    const visits=visitDocs.map(d=>({id:d.id,...d.data()})).filter(v=>v.date>=cutStr);

    const overviewHtml=reps.map(rep=>{
      const myOrders=orders.filter(o=>o.createdBy===rep.uid);
      const myCol=cols.filter(c=>c.createdBy===rep.uid).reduce((s,c)=>s+(c.amount||0),0);
      const myAtt=att.filter(a=>a.userId===rep.uid).length;
      const myNP=visits.filter(v=>v.createdBy===rep.uid).length;
      const myOutlets=allOutlets.filter(o=>o.createdBy===rep.uid||o.assignedRepId===rep.uid).length;
      const lastOrder=myOrders.sort((a,b)=>b.date?.localeCompare(a.date||''))[0];
      const lastAtt=att.filter(a=>a.userId===rep.uid).sort((a,b)=>b.date.localeCompare(a.date))[0];
      return`<div style="background:var(--s1);border:1px solid var(--bdr);border-radius:var(--r);padding:16px;margin-bottom:12px">
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:14px">
          <div class="ava" style="background:var(--blu)">${rep.name[0]}</div>
          <div style="flex:1">
            <div style="font-family:'Syne',sans-serif;font-size:14px;font-weight:700">${rep.name}</div>
            <div style="font-size:11px;color:var(--tx3)">${rep.phone||rep.email}</div>
          </div>
          <span class="bdg ${rep.status==='active'?'bdg-grn':'bdg-red'}" style="font-size:10px">${rep.status||'active'}</span>
        </div>
        <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:8px;margin-bottom:10px">
          <div style="background:var(--s2);border-radius:var(--r2);padding:9px;text-align:center;cursor:pointer" onclick="document.getElementById('monRepFilter').value='${rep.uid}';_monTab='orders';document.querySelectorAll('#pageMonitoring .rtab')[2].click()">
            <div style="font-family:'Syne',sans-serif;font-size:18px;font-weight:800;color:var(--acc)">${myOrders.length}</div>
            <div style="font-size:9px;color:var(--tx3)">Orders</div>
          </div>
          <div style="background:var(--s2);border-radius:var(--r2);padding:9px;text-align:center">
            <div style="font-family:'Syne',sans-serif;font-size:14px;font-weight:800;color:var(--grn)">${fmt(myCol).replace('RM','')}</div>
            <div style="font-size:9px;color:var(--tx3)">Collected</div>
          </div>
          <div style="background:var(--s2);border-radius:var(--r2);padding:9px;text-align:center">
            <div style="font-family:'Syne',sans-serif;font-size:18px;font-weight:800;color:var(--blu)">${myAtt}</div>
            <div style="font-size:9px;color:var(--tx3)">Days Present</div>
          </div>
          <div style="background:var(--s2);border-radius:var(--r2);padding:9px;text-align:center;cursor:pointer" onclick="document.getElementById('monRepFilter').value='${rep.uid}';_monTab='npvisits';document.querySelectorAll('#pageMonitoring .rtab')[1].click()">
            <div style="font-family:'Syne',sans-serif;font-size:18px;font-weight:800;color:var(--ylw)">${myNP}</div>
            <div style="font-size:9px;color:var(--tx3)">NP Visits</div>
          </div>
          <div style="background:var(--s2);border-radius:var(--r2);padding:9px;text-align:center">
            <div style="font-family:'Syne',sans-serif;font-size:18px;font-weight:800;color:var(--pur)">${myOutlets}</div>
            <div style="font-size:9px;color:var(--tx3)">Outlets</div>
          </div>
        </div>
        <div style="display:flex;gap:16px;font-size:11px;color:var(--tx3)">
          <span>Last order: <strong style="color:var(--tx2)">${lastOrder?.date||'—'}</strong></span>
          <span>Last check-in: <strong style="color:var(--tx2)">${lastAtt?.date||'—'}</strong></span>
        </div>
      </div>`;
    }).join('')||'<div style="text-align:center;padding:30px;color:var(--tx3)">No sales reps found</div>';
    if(gen!==_monGen)return;
    content.innerHTML=overviewHtml;

  } else if(_monTab==='npvisits') {
    const visitDocs=await sfGet('visits');
    if(gen!==_monGen)return;
    let visits=visitDocs.map(d=>({id:d.id,...d.data()})).filter(v=>v.date>=cutStr);
    if(repFilter)visits=visits.filter(v=>v.createdBy===repFilter);
    visits.sort((a,b)=>(b.date||'').localeCompare(a.date||''));
    const _reasons={};visits.forEach(v=>{if(v.reason){if(!_reasons[v.reason])_reasons[v.reason]=0;_reasons[v.reason]++;}});
    const _topR=Object.entries(_reasons).sort((a,b)=>b[1]-a[1]).slice(0,5);
    content.innerHTML=`
      <div class="sgrid" style="grid-template-columns:repeat(3,1fr);margin-bottom:14px">
        ${statC('📝','Total Visits',visits.length,periodLabel,'#a855f7')}
        ${statC('🏪','Unique Outlets',[...new Set(visits.map(v=>v.outletId))].length,'Different outlets','#22c55e')}
        ${statC('👤','Reps Active',[...new Set(visits.map(v=>v.createdBy))].length,'With NP visits','#3b82f6')}
      </div>
      ${_topR.length?`<div class="card" style="margin-bottom:14px"><div class="card-hdr"><div class="card-ttl">📊 Top Reasons</div></div>
        <div style="display:flex;flex-wrap:wrap;gap:7px;padding:4px 0">
          ${_topR.map(([r,c])=>`<div style="background:var(--s2);border-radius:var(--r2);padding:7px 12px;font-size:12px"><span style="font-weight:700;color:var(--ylw)">${c}×</span> ${r}</div>`).join('')}
        </div></div>`:''}
      <div class="card"><div class="card-hdr"><div class="card-ttl">📝 NP Visits — ${periodLabel} (${visits.length})</div><span style="font-size:11px;color:var(--tx3)">${cutStr} → ${todayStr}</span></div>
        <div class="twrap"><table><thead><tr><th>Date</th><th>Rep</th><th>Outlet</th><th>Reason</th><th>Notes</th><th>Photo</th>${isStrictAdmin()?'<th>Del</th>':''}</tr></thead>
          <tbody>${visits.map(v=>`<tr>
            <td style="font-size:12px">${v.date||'—'}</td>
            <td style="font-size:12px;font-weight:600">${v.createdByName||'—'}</td>
            <td style="font-size:12px">${v.outletName||outletName(v.outletId)}</td>
            <td><span class="bdg bdg-ylw" style="font-size:10px">${v.reason||'—'}</span></td>
            <td style="font-size:11px;color:var(--tx3);max-width:200px">${v.notes||'—'}</td>
            <td>${v.photo?`<img src="${v.photo}" style="width:42px;height:42px;object-fit:cover;border-radius:6px;cursor:pointer" onclick="viewPhoto('${v.photo}')">`:'—'}</td>
            ${isStrictAdmin()?`<td><button class="btn btn-red btn-xs" onclick="deleteNPVisit('${v.id}','${(v.outletName||v.createdByName||'visit').replace(/'/g,"\\'")}');loadMonitoring()">🗑</button></td>`:''}`).join('')||`<tr><td colspan="${isStrictAdmin()?7:6}" style="text-align:center;padding:20px;color:var(--tx3)">No NP visits in this period</td></tr>`}
          </tbody></table></div></div>`;
  } else if(_monTab==='orders') {
    const ordDocs=await sfGet('orders');
    if(gen!==_monGen)return;
    let orders=ordDocs.map(d=>({_docId:d.id,...d.data()})).filter(o=>o.date>=cutStr);
    if(repFilter)orders=orders.filter(o=>o.createdBy===repFilter);
    orders.sort((a,b)=>(b.date||'').localeCompare(a.date||''));
    const sBadge={Pending:'bdg-ylw',Confirmed:'bdg-blu',Delivered:'bdg-grn',Cancelled:'bdg-red',Assigned:'bdg-ylw','In Transit':'bdg-acc'};
    content.innerHTML=`<div class="card"><div class="card-hdr"><div class="card-ttl">📦 Orders (${orders.length})</div></div>
      <div class="twrap"><table><thead><tr><th>Order #</th><th>Date</th><th>Rep</th><th>Outlet</th><th>Total</th><th>Status</th></tr></thead>
        <tbody>${orders.map(o=>`<tr>
          <td style="font-family:'Syne',sans-serif;font-weight:700;font-size:12px">${o.id||o._docId}</td>
          <td style="font-size:12px">${o.date||'—'}</td>
          <td style="font-size:12px;color:var(--tx2)">${o.createdByName||userName(o.createdBy)}</td>
          <td style="font-size:12px">${outletName(o.outletId)}</td>
          <td style="font-family:'Syne',sans-serif;font-weight:700;color:var(--acc)">${fmt(o.total)}</td>
          <td><span class="bdg ${sBadge[o.status]||'bdg-gry'}">${o.status}</span></td>
        </tr>`).join('')||'<tr><td colspan="6" style="text-align:center;padding:20px;color:var(--tx3)">No orders in this period</td></tr>'}
        </tbody></table></div></div>`;

  } else if(_monTab==='attendance') {
    const attDocs=await sfGet('attendance');
    if(gen!==_monGen)return;
    let att=attDocs.map(d=>d.data()).filter(a=>a.date>=cutStr);
    if(repFilter)att=att.filter(a=>a.userId===repFilter);
    att.sort((a,b)=>b.date.localeCompare(a.date));
    const photoThumb=(src)=>src?`<img src="${src}" style="width:36px;height:36px;object-fit:cover;border-radius:5px;cursor:pointer" onclick="viewPhoto('${src}')">`:'—';
    content.innerHTML=`<div class="card"><div class="card-hdr"><div class="card-ttl">⏰ Attendance (${att.length} records)</div></div>
      <div class="twrap"><table><thead><tr><th>Date</th><th>Rep</th><th>Check In</th><th>Photo</th><th>Check Out</th><th>Photo</th><th>Hours</th></tr></thead>
        <tbody>${att.map(r=>`<tr>
          <td style="font-size:12px">${r.date}</td>
          <td style="font-size:12px;font-weight:600">${r.userName||'—'}</td>
          <td>${r.checkInTime||'—'}</td>
          <td>${photoThumb(r.checkInPhoto)}</td>
          <td>${r.checkOutTime||'—'}</td>
          <td>${photoThumb(r.checkOutPhoto)}</td>
          <td style="font-size:12px">${r.checkInTime&&r.checkOutTime?calcH(r.checkInTime,r.checkOutTime):'—'}</td>
        </tr>`).join('')||'<tr><td colspan="7" style="text-align:center;padding:20px;color:var(--tx3)">No attendance records in this period</td></tr>'}
        </tbody></table></div></div>`;
  }
  } catch(e) {
    console.error('loadMonitoring error:',e);
    if(gen===_monGen)content.innerHTML='<div style="text-align:center;padding:20px;color:var(--red)">⚠️ Failed to load data. Please try again.</div>';
  }
}

// ═══════════════ OUTLET STRUCTURE (admin only) ═══════════════
async function loadOutletStructure() {
  if(!isAdmin()){showToast('Admin only','error');return;}
  await loadCachedData();
  const srch=(document.getElementById('osSrch')?.value||'').toLowerCase();
  const content=document.getElementById('outletStructureContent');
  if(!content)return;

  // Build hierarchy: Sales Reps → their Routes → their Outlets
  const reps=allUsers.filter(u=>u.role==='sales_rep');

  // Also handle unassigned outlets (no rep)
  const getRepOutlets=(repId)=>allOutlets.filter(o=>o.createdBy===repId||o.assignedRepId===repId);
  const getRepRoutes=(repId)=>{
    const repOutletIds=new Set(getRepOutlets(repId).map(o=>o.routeId).filter(Boolean));
    return allRoutes.filter(r=>r.repId===repId||repOutletIds.has(r.id));
  };

  const matchSearch=(text)=>!srch||text.toLowerCase().includes(srch);

  let html='';

  // Section per rep
  for(const rep of reps){
    const repOutlets=getRepOutlets(rep.uid);
    const repRoutes=getRepRoutes(rep.uid);
    if(srch&&!matchSearch(rep.name)&&!repOutlets.some(o=>matchSearch(o.name))&&!repRoutes.some(r=>matchSearch(r.name)))continue;
    html+=`<div style="background:var(--s1);border:1px solid var(--bdr);border-radius:var(--r);margin-bottom:14px;overflow:hidden">
      <!-- Rep header -->
      <div style="background:var(--s2);padding:14px 16px;display:flex;align-items:center;gap:12px;border-bottom:1px solid var(--bdr)">
        <div class="ava" style="background:var(--blu);width:36px;height:36px;flex-shrink:0">${rep.name[0]}</div>
        <div style="flex:1">
          <div style="font-family:'Syne',sans-serif;font-size:14px;font-weight:700">${rep.name}</div>
          <div style="font-size:11px;color:var(--tx3)">${rep.phone||rep.email} · ${repOutlets.length} outlet${repOutlets.length!==1?'s':''} · ${repRoutes.length} route${repRoutes.length!==1?'s':''}</div>
        </div>
        <span class="bdg bdg-blu" style="font-size:10px">Sales Rep</span>
      </div>
      <!-- Routes under this rep -->
      <div style="padding:12px 14px">`;

    if(!repRoutes.length){
      html+=`<div style="font-size:12px;color:var(--tx3);padding:6px 0">No routes assigned</div>`;
    } else {
      for(const route of repRoutes){
        const routeOutlets=allOutlets.filter(o=>o.routeId===route.id&&(o.createdBy===rep.uid||o.assignedRepId===rep.uid||route.repId===rep.uid));
        if(srch&&!matchSearch(route.name)&&!routeOutlets.some(o=>matchSearch(o.name)))continue;
        html+=`<div style="margin-bottom:10px">
          <div style="display:flex;align-items:center;gap:8px;padding:8px 10px;background:var(--s2);border-radius:var(--r2);margin-bottom:6px;cursor:pointer" onclick="viewRouteOutlets('${route.id}')">
            <span style="font-size:14px">🗺️</span>
            <div style="flex:1;font-size:13px;font-weight:700">${route.name}</div>
            <span class="bdg bdg-gry" style="font-size:10px">${routeOutlets.length} outlets</span>
          </div>
          <div style="padding-left:18px;display:flex;flex-direction:column;gap:4px">
            ${routeOutlets.map(o=>`
              <div style="display:flex;align-items:center;gap:9px;padding:7px 10px;background:var(--s3);border-radius:var(--r2)">
                <div style="width:8px;height:8px;border-radius:50%;background:${o.color||'var(--acc)'};flex-shrink:0"></div>
                <div style="flex:1;min-width:0">
                  <div style="font-size:12px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${o.name}</div>
                  <div style="font-size:10px;color:var(--tx3)">${o.type}${o.area?' · '+o.area:''}</div>
                </div>
                <div style="display:flex;gap:4px">
                  <button class="btn btn-primary btn-xs" onclick="openNewOrder('${o.id}')">📦</button>
                  ${o.phone?`<button class="btn btn-grn btn-xs" onclick="openWhatsApp('${o.id}')">💬</button>`:''}
                </div>
              </div>`).join('')||'<div style="font-size:11px;color:var(--tx3);padding:4px 0">No outlets on this route</div>'}
          </div>
        </div>`;
      }
    }
    html+=`</div></div>`;
  }

  // Unassigned outlets (no rep, no route)
  const unassigned=allOutlets.filter(o=>!o.assignedRepId&&!o.createdBy);
  if(unassigned.length>0){
    html+=`<div style="background:var(--s1);border:1px dashed var(--bdr);border-radius:var(--r);padding:14px;margin-bottom:14px">
      <div style="font-size:13px;font-weight:700;color:var(--tx3);margin-bottom:10px">⚠️ Unassigned Outlets (${unassigned.length})</div>
      <div style="display:flex;flex-wrap:wrap;gap:6px">
        ${unassigned.map(o=>`<span class="bdg bdg-gry">🏪 ${o.name}</span>`).join('')}
      </div></div>`;
  }

  content.innerHTML=html||'<div style="text-align:center;padding:40px;color:var(--tx3)">No data found</div>';
}
// ═══════════════ ZONE MANAGEMENT (Owner only) ═══════════════
async function loadZones() {
  if(!isOwner()){showToast('Owner app only','error');return;}
  const docs=await sfGet('zones');
  allZones=docs.map(d=>({id:d.id,...d.data()}));
  const grid=document.getElementById('zonesGrid');
  if(!grid)return;

  const allUserDocs=await window.__SF.getDocs(col('users'));
  const allU=allUserDocs.docs.map(d=>d.data());

  if(!allZones.length){
    grid.innerHTML=`<div style="grid-column:1/-1;text-align:center;padding:40px;color:var(--tx3)">
      <div style="font-size:40px;margin-bottom:12px">🗂️</div>
      <div style="font-size:14px;font-weight:600">No zones created yet</div>
      <div style="font-size:12px;margin-top:6px">Create a zone, then download its app to deploy for that team</div>
    </div>`;
    return;
  }

  grid.innerHTML=allZones.map(z=>{
    const members=allU.filter(u=>u.zoneId===z.id&&!u.isOwner);
    const admins=members.filter(u=>u.role==='admin');
    const reps=members.filter(u=>u.role==='sales_rep');
    const deliv=members.filter(u=>u.role==='delivery_man');
    return`<div style="background:var(--s1);border:1px solid var(--bdr);border-radius:var(--r);padding:16px">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:10px">
        <div style="flex:1;min-width:0">
          <div style="font-family:'Syne',sans-serif;font-size:15px;font-weight:700">${z.name}</div>
          ${z.description?`<div style="font-size:11px;color:var(--tx3);margin-top:2px">${z.description}</div>`:''}
          <div style="font-size:10px;color:var(--tx3);margin-top:3px;font-family:monospace">ID: ${z.id}</div>
        </div>
        <div style="display:flex;gap:5px;flex-shrink:0">
          <button class="btn btn-ghost btn-xs" onclick="editZone('${z.id}')">✏️</button>
          <button class="btn btn-red btn-xs" onclick="deleteZone('${z.id}','${z.name.replace(/'/g,'')}')">🗑</button>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-bottom:12px">
        <div style="background:var(--s2);border-radius:var(--r2);padding:8px;text-align:center">
          <div style="font-family:'Syne',sans-serif;font-size:18px;font-weight:800;color:var(--acc)">${admins.length}</div>
          <div style="font-size:9px;color:var(--tx3)">Admins</div>
        </div>
        <div style="background:var(--s2);border-radius:var(--r2);padding:8px;text-align:center">
          <div style="font-family:'Syne',sans-serif;font-size:18px;font-weight:800;color:var(--blu)">${reps.length}</div>
          <div style="font-size:9px;color:var(--tx3)">Sales Reps</div>
        </div>
        <div style="background:var(--s2);border-radius:var(--r2);padding:8px;text-align:center">
          <div style="font-family:'Syne',sans-serif;font-size:18px;font-weight:800;color:var(--grn)">${deliv.length}</div>
          <div style="font-size:9px;color:var(--tx3)">Delivery</div>
        </div>
      </div>
      ${members.length?`<div style="display:flex;flex-wrap:wrap;gap:5px;margin-bottom:12px">
        ${members.slice(0,6).map(u=>`<div style="display:flex;align-items:center;gap:4px;background:var(--s2);border-radius:20px;padding:3px 8px">
          <div class="ava" style="width:16px;height:16px;font-size:8px;background:${{admin:'var(--acc)',sub_admin:'var(--pur)',sales_rep:'var(--blu)',delivery_man:'var(--grn)'}[u.role]||'var(--tx3)'}">${u.name[0]}</div>
          <span style="font-size:10px">${u.name.split(' ')[0]}</span>
        </div>`).join('')}${members.length>6?`<span style="font-size:10px;color:var(--tx3);padding:3px 6px">+${members.length-6} more</span>`:''}
      </div>`:'<div style="font-size:11px;color:var(--tx3);margin-bottom:10px">No members assigned yet</div>'}
      <div style="background:var(--s2);border:1px solid var(--bdr);border-radius:var(--r2);padding:8px 12px;font-size:10px;color:var(--tx3);text-align:center">
        🗂️ Firestore path: <code style="color:var(--acc)">zones/${z.id}/...</code>
      </div>
    </div>`;
  }).join('');
}

function openNewZone() {
  if(!isOwner()){showToast('Owner app only','error');return;}
  document.getElementById('mZoneTitle').textContent='🗂️ Create Zone';
  document.getElementById('zEditId').value='';
  document.getElementById('zName').value='';
  document.getElementById('zDesc').value='';
  openM('mZone');
}

async function editZone(id) {
  if(!isOwner()){showToast('Owner app only','error');return;}
  const z=allZones.find(x=>x.id===id);if(!z)return;
  document.getElementById('mZoneTitle').textContent='✏️ Edit Zone';
  document.getElementById('zEditId').value=id;
  document.getElementById('zName').value=z.name||'';
  document.getElementById('zDesc').value=z.description||'';
  openM('mZone');
}

async function saveZone() {
  if(!isOwner()){showToast('Owner app only','error');return;}
  const name=document.getElementById('zName').value.trim();
  if(!name){showToast('Zone name required','error');return;}
  const editId=document.getElementById('zEditId').value;
  const data={name,description:document.getElementById('zDesc').value.trim(),updatedAt:new Date().toISOString()};
  try{
    if(editId){
      await window.__SF.updateDoc(docRef('zones',editId),data);
      const uSnap=await window.__SF.getDocs(rootCol('users'));
      const batch=uSnap.docs.filter(d=>d.data().zoneId===editId);
      await Promise.all(batch.map(d=>window.__SF.updateDoc(rootDocRef('users',d.id),{zoneName:name})));
      showToast('Zone updated ✅','success');
    } else {
      data.createdBy=CU.uid;data.createdAt=new Date().toISOString();
      await window.__SF.addDoc(rootCol('zones'),data);
      showToast(`Zone "${name}" created 🗂️ — download its app below`,'success');
    }
    closeM('mZone');
    await loadCachedData();
    loadZones();
  }catch(e){showToast('Error: '+e.message,'error');}
}

async function deleteZone(id,name) {
  if(!isOwner()){showToast('Owner app only','error');return;}
  const uSnap=await window.__SF.getDocs(rootCol('users'));
  const members=uSnap.docs.filter(d=>d.data().zoneId===id&&!d.data().isOwner);
  if(members.length>0){
    showToast(`Cannot delete — ${members.length} user(s) assigned to "${name}". Reassign first.`,'error');
    return;
  }
  if(!await _customConfirm(`Delete zone "${name}"?\n\nZone data in Firestore (zones/${id}/...) is NOT deleted. This cannot be undone.`, {title:'Delete Zone',okText:'Delete',cancelText:'Cancel',danger:true,icon:'⚠️'}))return;
  try{
    await window.__SF.deleteDoc(rootDocRef('zones',id));
    showToast('Zone deleted','warn');
    await loadCachedData();
    loadZones();
  }catch(e){showToast('Error: '+e.message,'error');}
}

async function reassignUserZone(uid, uName) {
  if(!isOwner()){showToast('Owner app only','error');return;}
  const zoneOptions=allZones.map((z,i)=>`${i+1}. ${z.name}`).join('\n');
  const choice=prompt(`Reassign "${uName}" to zone:\n\n${zoneOptions}\n\nEnter zone number (or 0 to remove zone):`);
  if(choice===null)return;
  const idx=parseInt(choice)-1;
  let newZoneId=null,newZoneName=null;
  if(choice!=='0'&&idx>=0&&idx<allZones.length){
    newZoneId=allZones[idx].id;
    newZoneName=allZones[idx].name;
  }
  await window.__SF.updateDoc(rootDocRef('users',uid),{zoneId:newZoneId,zoneName:newZoneName});
  showToast(`${uName} reassigned to ${newZoneName||'no zone'}`,'success');
  await loadCachedData();
  loadUsers();
}


// ═══════════════ DATA MIGRATION TOOL (Owner only) ═══════════════
// Reads from root Firestore collections and copies into zones/ZONE_ID/ subcollections

const MIGRABLE_COLLECTIONS = [
  { key:'outlets',     label:'Outlets 🏪',     icon:'🏪' },
  { key:'orders',      label:'Orders 📦',      icon:'📦' },
  { key:'collections', label:'Collections 💰', icon:'💰' },
  { key:'routes',      label:'Routes 🗺️',      icon:'🗺️' },
  { key:'attendance',  label:'Attendance ⏰',  icon:'⏰' },
  { key:'visits',      label:'NP Visits 📝',   icon:'📝' },
  { key:'products',    label:'Products 🛒',    icon:'🛒' },
  { key:'broadcasts',  label:'Broadcasts 📢',  icon:'📢' },
  { key:'targets',     label:'Sales Targets 🎯',icon:'🎯' },
  { key:'deleteRequests',label:'Delete Requests 🗑',icon:'🗑' },
];

// rootCol/rootDocRef/zoneColRef/zoneDocRef defined at top of file — no duplicate needed

let _migrationState = {
  running: false,
  zoneId: null,
  zoneName: null,
  totals: {},
  done: {},
  errors: {},
  skipped: {},
};

async function openMigrationTool() {
  if(!isOwner()) { showToast('Owner only','error'); return; }
  await loadCachedData();
  if(!allZones.length) {
    showToast('Create at least one zone first in 🗂️ Zones','warn');
    goPage('zones');
    return;
  }

  // Populate zone selector
  const zSel = document.getElementById('migZoneSelect');
  if(zSel) {
    zSel.innerHTML = '<option value="">Choose a zone...</option>' +
      allZones.map(z=>`<option value="${z.id}">${z.name}</option>`).join('');
  }

  // Pre-scan root collections to show counts
  _migLog('Scanning existing root data...');
  document.getElementById('migProgress').style.display='none';
  document.getElementById('migStartBtn').disabled=true;
  document.getElementById('migZoneSelect').value='';

  openM('mMigration');
  await _migScan();
}

async function _migScan() {
  const scanEl = document.getElementById('migScanResults');
  if(!scanEl) return;
  scanEl.innerHTML = '<div style="color:var(--tx3);font-size:12px">Scanning...</div>';
  let rows = '';
  let total = 0;
  for(const c of MIGRABLE_COLLECTIONS) {
    try {
      const snap = await window.__SF.getDocs(rootCol(c.key));
      const count = snap.docs.length;
      _migrationState.totals[c.key] = count;
      total += count;
      rows += `<div style="display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid var(--bdr);font-size:12px">
        <span>${c.icon} ${c.label}</span>
        <span style="font-weight:700;color:${count>0?'var(--acc)':'var(--tx3)'}">${count} record${count!==1?'s':''}</span>
      </div>`;
    } catch(e) {
      rows += `<div style="font-size:12px;color:var(--red);padding:5px 0">${c.icon} ${c.label}: Error — ${e.message}</div>`;
    }
  }
  scanEl.innerHTML = rows +
    `<div style="display:flex;justify-content:space-between;padding:8px 0;font-size:13px;font-weight:700;border-top:2px solid var(--bdr);margin-top:4px">
      <span>Total records</span><span style="color:var(--acc)">${total}</span>
    </div>`;

  const startBtn = document.getElementById('migStartBtn');
  if(startBtn) startBtn.disabled = (total === 0);
  if(total === 0) _migLog('No root data found — nothing to migrate.');
  else _migLog(`Found ${total} records across ${MIGRABLE_COLLECTIONS.length} collections. Select a zone and click Start.`);
}

function _migLog(msg, type='info') {
  const el = document.getElementById('migLog');
  if(!el) return;
  const colors = { info:'var(--tx2)', success:'var(--grn)', error:'var(--red)', warn:'var(--ylw)' };
  const now = new Date().toLocaleTimeString('en-GB');
  el.innerHTML += `<div style="font-size:11px;color:${colors[type]||'var(--tx2)'};padding:2px 0">[${now}] ${msg}</div>`;
  el.scrollTop = el.scrollHeight;
}

function _migUpdateBar(pct, label) {
  const bar = document.getElementById('migBar');
  const pctEl = document.getElementById('migBarPct');
  const labelEl = document.getElementById('migBarLabel');
  if(bar) bar.style.width = pct+'%';
  if(pctEl) pctEl.textContent = Math.round(pct)+'%';
  if(labelEl) labelEl.textContent = label;
}

async function startMigration() {
  if(_migrationState.running) { showToast('Migration already running','warn'); return; }
  const zoneId = document.getElementById('migZoneSelect')?.value;
  if(!zoneId) { showToast('Select a zone first','warn'); return; }
  const zone = allZones.find(z=>z.id===zoneId);
  if(!zone) { showToast('Zone not found','error'); return; }

  const confirmed = await _customConfirm(
    `All root data will be COPIED into zone "${zone.name}".\n\n• Original root data is NOT deleted (safe to undo)\n• Existing zone records with the same ID will be overwritten\n• This may take a minute`,
    {title:`Migrate to "${zone.name}"`,okText:'Start Migration',cancelText:'Cancel',icon:'🚀'}
  );
  if(!confirmed) return;

  _migrationState.running = true;
  _migrationState.zoneId = zoneId;
  _migrationState.zoneName = zone.name;
  _migrationState.done = {};
  _migrationState.errors = {};

  document.getElementById('migStartBtn').disabled = true;
  document.getElementById('migZoneSelect').disabled = true;
  document.getElementById('migProgress').style.display = '';
  _migLog(`▶ Starting migration to zone "${zone.name}" (${zoneId})`, 'info');

  let totalDone = 0;
  const totalAll = Object.values(_migrationState.totals).reduce((s,v)=>s+v, 0);

  for(const c of MIGRABLE_COLLECTIONS) {
    const count = _migrationState.totals[c.key] || 0;
    if(count === 0) {
      _migLog(`⏭ ${c.label}: skipped (empty)`, 'info');
      continue;
    }
    _migLog(`📋 Migrating ${c.label} (${count} records)...`, 'info');
    _migUpdateBar((totalDone/Math.max(totalAll,1))*100, `Migrating ${c.label}...`);

    try {
      const snap = await window.__SF.getDocs(rootCol(c.key));
      let colDone = 0;
      let colErrors = 0;

      // Batch writes — Firestore batch limit is 500 ops
      const BATCH_SIZE = 400;
      let batch = window.__SF.writeBatch ? window.__SF.writeBatch(db()) : null;
      let batchCount = 0;

      for(const docSnap of snap.docs) {
        const data = docSnap.data();
        const destRef = zoneDocRef(zoneId, c.key, docSnap.id);
        try {
          if(batch) {
            batch.set(destRef, data);
            batchCount++;
            if(batchCount >= BATCH_SIZE) {
              await batch.commit();
              batch = window.__SF.writeBatch(db());
              batchCount = 0;
            }
          } else {
            await window.__SF.setDoc(destRef, data);
          }
          colDone++;
        } catch(e) {
          colErrors++;
          _migLog(`  ⚠ ${c.key}/${docSnap.id}: ${e.message}`, 'warn');
        }
      }

      // Commit remaining batch
      if(batch && batchCount > 0) {
        await batch.commit();
      }

      totalDone += colDone;
      _migrationState.done[c.key] = colDone;
      _migrationState.errors[c.key] = colErrors;
      _migLog(`✅ ${c.label}: ${colDone} copied${colErrors>0?`, ${colErrors} errors`:''}`, colErrors>0?'warn':'success');
    } catch(e) {
      _migLog(`❌ ${c.label} FAILED: ${e.message}`, 'error');
      _migrationState.errors[c.key] = -1;
    }
    _migUpdateBar((totalDone/Math.max(totalAll,1))*100, `Done: ${c.label}`);
  }

  // Done
  _migrationState.running = false;
  _migUpdateBar(100, 'Migration complete ✅');
  _migLog('', 'info');
  _migLog(`════ Migration complete ════`, 'success');
  _migLog(`Zone: ${zone.name} (${zoneId})`, 'success');
  _migLog(`Total copied: ${totalDone} records`, 'success');
  _migLog(`Root data untouched — safe to verify zone app before deleting root data`, 'info');
  _migLog('', 'info');
  _migLog('Next steps:', 'info');
  _migLog('1. Download the zone app from 🗂️ Zones page', 'info');
  _migLog('2. Open the zone app and verify all data is present', 'info');
  _migLog('3. Once confirmed, you can delete root data manually in Firebase Console if needed', 'info');

  document.getElementById('migStartBtn').textContent = '✅ Done';
  document.getElementById('migZoneSelect').disabled = false;
  showToast(`Migration to "${zone.name}" complete — ${totalDone} records copied 🎉`, 'success');
}

// ═══════════════ FIRESTORE LIMIT POLYFILL ═══════════════
// The inline index.html script doesn't expose `limit` in __SF.
// Patch it here so loadNotifHistory (defined inline) works correctly.
document.addEventListener('DOMContentLoaded', () => {
  // Wait one tick to ensure __SF is set
  setTimeout(() => {
    if(window.__SF && !window.__SF.limit) {
      // Re-expose limit from Firestore module globals if available
      // Fallback: override loadNotifHistory to avoid using limit
      window.loadNotifHistory = async function() {
        const e = document.getElementById('notifHistoryList');
        if(!e) return;
        e.innerHTML = '<div style="text-align:center;padding:20px;color:var(--tx3);font-size:13px">Loading...</div>';
        try {
          const {getDocs, query, collection, orderBy, db} = window.__SF;
          // Use query without limit — orderBy sentAt desc, then slice
          const q = query(collection(db, 'notification_history'), orderBy('sentAt','desc'));
          const snap = await getDocs(q);
          if(snap.empty) { e.innerHTML='<div style="text-align:center;padding:30px;color:var(--tx3);font-size:13px">📭 No notifications sent yet — send your first one above!</div>'; return; }
          const docs = snap.docs.slice(0,30);
          const esc = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
          let html = '<div style="display:grid;gap:10px">';
          docs.forEach(d => {
            const t = d.data();
            const dt = (t.sentAt?.toDate ? t.sentAt.toDate() : new Date()).toLocaleString('en-MY',{dateStyle:'medium',timeStyle:'short'});
            const urgent = t.priority==='urgent';
            const targetLabel = t.target==='all'?'👥 All Users':t.target==='specific'?'🎯 Specific User':t.target==='sales_rep'?'🧑‍💼 Sales Reps':t.target==='delivery_man'?'🚚 Delivery Men':t.target==='admin'?'👑 Admins':t.target;
            html += `<div style="background:var(--s2);border:1px solid var(--bdr);border-radius:12px;padding:14px;display:flex;gap:12px;align-items:flex-start">
              <div style="font-size:22px;flex-shrink:0">${urgent?'🚨':'📢'}</div>
              <div style="flex:1;min-width:0">
                <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:4px">
                  <span style="font-size:13px;font-weight:700;color:var(--tx)">${esc(t.title)}</span>
                  ${urgent?'<span style="background:#ef444420;color:#ef4444;font-size:10px;font-weight:700;padding:2px 7px;border-radius:20px;border:1px solid #ef444440">URGENT</span>':''}
                </div>
                <div style="font-size:12px;color:var(--tx2);margin-bottom:8px;line-height:1.5">${esc(t.message)}</div>
                <div style="display:flex;gap:10px;flex-wrap:wrap;font-size:10px;color:var(--tx3)">
                  <span>${targetLabel}</span>
                  ${t.tokenCount?`<span>📱 ${t.tokenCount} device(s)</span>`:''}
                  ${t.zone?`<span>📍 ${esc(t.zone)}</span>`:''}
                  <span>👤 ${esc(t.sentByName||'Admin')}</span>
                  <span>🕐 ${dt}</span>
                  ${t.status==='partial'?'<span style="color:var(--ylw)">⚠️ partial</span>':''}
                </div>
              </div>
            </div>`;
          });
          html += '</div>';
          e.innerHTML = html;
        } catch(err) {
          console.error('loadNotifHistory:', err);
          e.innerHTML = '<div style="text-align:center;padding:30px;color:var(--tx3);font-size:13px">📭 No notifications sent yet — send your first one above!</div>';
        }
      };
    }
  }, 0);
});
function openUserProfile() {
  if(!CU) return;
  document.getElementById('upName').value = CU.name || '';
  document.getElementById('upPhone').value = CU.phone || '';
  document.getElementById('upEmail').value = CU.email || '';
  document.getElementById('upNameDisplay').textContent = CU.name || '—';
  const roleLabels = {admin:isOwner()?'Owner / Super Admin':'Administrator',sub_admin:'Sub Admin',sales_rep:'Sales Rep',delivery_man:'Delivery Man'};
  document.getElementById('upRoleDisplay').textContent = roleLabels[CU.role] || CU.role || '—';
  const ava = document.getElementById('upAva');
  if(ava){
    if(CU.photoURL){ ava.innerHTML=`<img src="${CU.photoURL}" style="width:100%;height:100%;object-fit:cover">`; }
    else { ava.textContent=(CU.name||'U')[0].toUpperCase(); }
  }
  const coverImg=document.getElementById('upCoverImg');
  const coverEmpty=document.getElementById('upCoverEmpty');
  if(CU.coverPhoto && coverImg){
    coverImg.src=CU.coverPhoto; coverImg.style.display='';
    if(coverEmpty) coverEmpty.style.display='none';
  } else if(coverImg){
    coverImg.style.display='none';
    if(coverEmpty) coverEmpty.style.display='';
  }
  openM('mUserProfile');
}

async function saveUserProfile() {
  const name=(document.getElementById('upName')?.value||'').trim();
  const phone=(document.getElementById('upPhone')?.value||'').trim();
  if(!name){showToast('Name is required','error');return;}
  const btn=document.getElementById('upSaveBtn');
  if(btn){btn.disabled=true;btn.textContent='Saving…';}
  try {
    await window.__SF.updateDoc(rootDocRef('users',CU.uid),{name,phone});
    CU.name=name; CU.phone=phone;
    document.getElementById('sbName').textContent=name;
    const sbAva=document.getElementById('sbAva');
    if(sbAva && !CU.photoURL) sbAva.textContent=name[0].toUpperCase();
    closeM('mUserProfile');
    showToast('Profile updated ✅','success');
  } catch(e){ showToast('Error saving profile: '+e.message,'error'); }
  finally { if(btn){btn.disabled=false;btn.textContent='💾 Save Profile';} }
}

async function onUserPhotoFile(type, input) {
  const file=input.files&&input.files[0]; if(!file)return;
  const progressId=type==='avatar'?'upAvatarProgress':'upCoverProgress';
  const prog=document.getElementById(progressId);
  if(prog)prog.style.display='';
  try {
    const {storageRef,uploadBytes,getDownloadURL,storage}=window.__SF;
    const path=`users/${CU.uid}/${type}_${Date.now()}`;
    const ref=storageRef(storage, path);
    await uploadBytes(ref, file);
    const url=await getDownloadURL(ref);
    const field=type==='avatar'?'photoURL':'coverPhoto';
    await window.__SF.updateDoc(rootDocRef('users',CU.uid),{[field]:url});
    CU[field]=url;
    if(type==='avatar'){
      const ava=document.getElementById('upAva');
      if(ava) ava.innerHTML=`<img src="${url}" style="width:100%;height:100%;object-fit:cover;border-radius:inherit">`;
      const sbAva=document.getElementById('sbAva');
      if(sbAva) sbAva.innerHTML=`<img src="${url}" style="width:100%;height:100%;object-fit:cover;border-radius:inherit">`;
    } else {
      const img=document.getElementById('upCoverImg');
      if(img){img.src=url; img.style.display='';}
      const emp=document.getElementById('upCoverEmpty');
      if(emp) emp.style.display='none';
    }
    showToast(type==='avatar'?'Profile photo updated ✅':'Cover photo updated ✅','success');
  } catch(e){ showToast('Upload failed: '+e.message,'error'); }
  finally { if(prog)prog.style.display='none'; input.value=''; }
}

// ═══════════════ NP VISIT — CAMERA CAPTURE ═══════════════
function captureNPPhoto() {
  // Trigger the hidden file input (which also supports camera on mobile)
  const inp=document.getElementById('npPhotoFile');
  if(inp) inp.click();
}

// ═══════════════ ACCOUNT RECOVERY FIX (orphan auth account) ═══════════════
window._doRecoveryFix = async function(orphanUid, orphanEmail) {
  const name=(document.getElementById('_rName')?.value||'').trim();
  const role=document.getElementById('_rRole')?.value||'sales_rep';
  const phone=(document.getElementById('_rPhone')?.value||'').trim();
  const adminEmail=(document.getElementById('_rAdminEmail')?.value||'').trim();
  const adminPwd=document.getElementById('_rAdminPwd')?.value||'';
  if(!name||!role){showToast('Name and role are required','error');return;}
  if(!adminEmail||!adminPwd){showToast('Admin email and password are required','error');return;}
  const btn=document.getElementById('_rFixBtn');
  if(btn){btn.disabled=true;btn.textContent='⏳ Fixing…';}
  try {
    // Re-auth as admin to verify credentials
    const cred=await window.__SF.signInWithEmailAndPassword(window.__SF.auth,adminEmail,adminPwd);
    if(!cred||!cred.user){throw new Error('Admin sign-in failed');}
    // Verify the signed-in account is actually an admin
    const adminDoc=await window.__SF.getDoc(rootDocRef('users',cred.user.uid));
    if(!adminDoc.exists()||!['admin','sub_admin'].includes(adminDoc.data().role)){
      throw new Error('Signed-in account is not an admin');
    }
    // Write the missing user profile
    await window.__SF.setDoc(rootDocRef('users',orphanUid),{
      uid:orphanUid, name, email:orphanEmail, role, phone,
      status:'active', createdAt:new Date().toISOString(),
      zoneId:null, zoneName:null, createdBy:cred.user.uid, createdByNote:'recovery'
    });
    document.getElementById('_recoveryCard')?.remove();
    showToast(`Profile created for ${name}. Please sign in again.`,'success');
    // Sign out so the orphan user must log in fresh
    await window.__SF.signOut(window.__SF.auth);
  } catch(e){
    showToast('Recovery failed: '+e.message,'error');
    if(btn){btn.disabled=false;btn.textContent='✅ Create Profile & Fix Account';}
  }
};

document.addEventListener('DOMContentLoaded',()=>{
  const lpwd=document.getElementById('lpwd');
  if(lpwd)lpwd.addEventListener('keydown',e=>{if(e.key==='Enter')doLogin();});
  // ★ Boot guard: if Firebase resolved before app.js loaded, appReady already fired
  if(window.__firebaseReady && window.__pendingUser && typeof bootApp==='function'){
    window.__currentUser=window.__pendingUser;
    window.__pendingUser=null;
    bootApp();
  }
});
