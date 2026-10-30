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

// Shared GPS Globals
let _userLat  = null;
let _userLng  = null;
let _gpsGranted = false;

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

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

// Which outlets each role sees in the Sales App (every page uses
// allOutlets): admins all; a sales rep only their own (assigned to them,
// or created by them when no one is assigned); a delivery man only the
// outlets on orders assigned to him. Storemen don't use the Sales App.
function _scopeOutlets(list, orders) {
  if (!CU || isAdmin()) return list;
  const me = CU.uid;
  if (CU.role === 'sales_rep') {
    return list.filter(o => o.assignedRepId ? o.assignedRepId === me : (o.createdBy === me || o.repId === me || o.assignedTo === me));
  }
  if (CU.role === 'delivery_man') {
    const ids = new Set((orders || []).filter(o => o.deliveryManId === me).map(o => o.outletId));
    return list.filter(o => ids.has(o.id));
  }
  return [];
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

// The owner normally writes to root. With a zone picked in the Zone View
// bar, the owner works on that zone's copy (what the page shows), so new
// and edited docs go to the zone and are mirrored to root like a zone
// user's. Products stay in the global (root) catalogue.
function _ownerWriteZone(colName) {
  return isOwner() && _ownerZoneFilter && MIRROR_COLS.has(colName) && colName !== 'products' ? _ownerZoneFilter : null;
}
const _zoneName = (zid) => (allZones.find(z=>z.id===zid)||{}).name||zid;

// addDoc with mirror: returns the zone doc ref (primary)
async function sfAdd(colName, data) {
  const oz = _ownerWriteZone(colName);
  if(oz){
    const zData = {...data, zoneId: data.zoneId || oz};
    const added = await window.__SF.addDoc(window.__SF.collection(db(), `zones/${oz}/${colName}`), zData);
    try {
      await window.__SF.setDoc(rootDocRef(colName, added.id), {...zData, _zoneId: oz, _zoneName: _zoneName(oz)});
    } catch(e){ console.warn('[mirror] owner addDoc root failed:', e.message); }
    invalidateCache();
    return added;
  }
  const zoneRef = col(colName);
  const docAdded = await window.__SF.addDoc(zoneRef, data);
  if(CU && CU.zoneId && !isOwner() && MIRROR_COLS.has(colName)){
    try {
      await window.__SF.setDoc(rootDocRef(colName, docAdded.id), {...data, _zoneId: CU.zoneId, _zoneName: _zoneName(CU.zoneId)});
    } catch(e){ console.warn('[mirror] addDoc root failed:', e.message); }
  }
  invalidateCache();
  return docAdded;
}

// Owner edits and deletes reach both copies: root, and the zone the doc
// belongs to (the picked zone, or the zone recorded on the root copy).
async function _ownerDocZone(colName, docId) {
  const oz = _ownerWriteZone(colName);
  if(oz) return oz;
  if(!isOwner() || !MIRROR_COLS.has(colName) || colName === 'products') return null;
  try {
    const s = await window.__SF.getDoc(rootDocRef(colName, docId));
    return s.exists() ? (s.data()._zoneId || s.data().zoneId || null) : null;
  } catch(e){ return null; }
}

// updateDoc with mirror
async function sfUpdate(colName, docId, data) {
  if(isOwner()){
    const zid = await _ownerDocZone(colName, docId);
    if(zid){
      const zRef = window.__SF.doc(db(), `zones/${zid}/${colName}`, docId);
      let done = false;
      try { await window.__SF.updateDoc(zRef, data); done = true; } catch(e){ if(e.code !== 'not-found') throw e; }
      try { await window.__SF.updateDoc(rootDocRef(colName, docId), data); done = true; }
      catch(e){ if(!done) throw e; }
      invalidateCache();
      return;
    }
  }
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
  const ozid = isOwner() ? await _ownerDocZone(colName, docId) : null;
  if(ozid){
    await window.__SF.deleteDoc(window.__SF.doc(db(), `zones/${ozid}/${colName}`, docId));
  }
  await window.__SF.deleteDoc(docRef(colName, docId));
  if(CU && CU.zoneId && !isOwner() && MIRROR_COLS.has(colName)){
    try {
      await window.__SF.deleteDoc(rootDocRef(colName, docId));
    } catch(e){ console.warn('[mirror] deleteDoc root failed:', e.message); }
  }
  invalidateCache();
}

// Whole-collection reads are shared for a short time, so moving between
// pages does not download the same collections again. Any write through
// sfAdd/sfUpdate/sfDelete, and live order changes, clear it.
const _sfMemo = new Map();
const _SF_MEMO_MS = 30000;
function _sfMemoSet(colName, docs) { _sfMemo.set(_zoneReadPath(colName), { t: Date.now(), docs }); }

async function sfGet(colName, constraints=[]) {
  try {
    const {getDocs, query} = window.__SF;
    const key = constraints.length ? null : _zoneReadPath(colName);
    const hit = key && _sfMemo.get(key);
    if (hit && Date.now() - hit.t < _SF_MEMO_MS) return hit.docs;
    const ref = colR(colName); // colR respects _ownerZoneFilter for reads
    const q = constraints.length ? query(ref, ...constraints) : ref;
    const snap = await getDocs(q);
    if (key) _sfMemo.set(key, { t: Date.now(), docs: snap.docs });
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
function escH(s) { return String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
function fmt(n) { return 'RM '+Number(n||0).toLocaleString('en-MY',{minimumFractionDigits:2,maximumFractionDigits:2}); }
function fmtD(d) { if(!d) return '—'; const dt=d.toDate?d.toDate():new Date(d); return dt.toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'}); }
function fmtT(d) { if(!d) return '--:--'; const dt=d.toDate?d.toDate():new Date(d); return dt.toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',hour12:false}); }
function todayStr() { return new Date().toISOString().split('T')[0]; }
function uid6() { return Date.now().toString(36).toUpperCase()+Math.random().toString(36).slice(2,5).toUpperCase(); }
function isAdmin() { return CU && (CU.role==='admin'||CU.role==='sub_admin'); }
function isStrictAdmin() { return CU && CU.role==='admin'; }
function isDeliveryMan() { return CU && CU.role==='delivery_man'; }
function isOwner() { return CU && CU.role==='admin' && CU.isOwner===true; }


