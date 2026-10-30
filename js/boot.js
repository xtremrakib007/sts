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
    // super_admin is the ERP's name for the owner account: same access here.
    if (CU.role === 'super_admin') CU = { ...CU, role: 'admin', isOwner: true, erpRole: 'super_admin' };

    // ★ Field staff work only in the Android app
    if (_fieldStaffBlockedOnWeb(CU)) {
      showNativeAppOnlyScreen();
      await window.__SF.signOut(window.__SF.auth).catch(() => {});
      return;
    }

    // ★ Storemen work in the ERP portal (picking, stock), not the Sales App
    if (CU.role === 'storeman') {
      showStoremanScreen();
      await window.__SF.signOut(window.__SF.auth).catch(() => {});
      return;
    }

    // ★ DEVICE APPROVAL GATE — enforce inside bootApp for sales_rep
    if (CU.role === 'sales_rep') {
      const allowed = await _enforceDeviceGate(CU);
      if (!allowed) { _hideSplash(); return; }
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

    // ★ Start the GPS check and the data load together — the GPS check can
    // take several seconds on a phone and used to hold up everything else.
    const gpsPromise = requestGPSPermission();
    // 1) Instant: last session's data from the on-device cache.
    // 2) Fresh: the server, then the screen is redrawn with it.
    const shownFromCache = await _bootLoad('cache').catch(() => false);
    const freshLoad = _bootLoad('server');

    // ★ GPS PERMISSION — required for field users (sales_rep, delivery_man) for tracking
    // Admins do NOT need GPS and must never be blocked by GPS denial
    const gpsOk = await gpsPromise;
    if(!gpsOk && !isAdmin()){
      _hideSplash();
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
          <div style="font-size:13px;color:var(--tx2);margin-bottom:20px;line-height:1.5">STSB needs your GPS location for outlet sorting and field tracking. Please allow location access.</div>
          <button onclick="location.reload()" style="background:linear-gradient(135deg,#22c55e,#15803d);color:#fff;border:none;padding:12px 28px;border-radius:10px;font-size:14px;font-weight:600;cursor:pointer;width:100%">📍 Allow Location & Retry</button>
          <button onclick="doLogout()" style="background:var(--s2);color:var(--tx2);border:1px solid var(--bdr);padding:10px 22px;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;margin-top:10px;width:100%">Sign Out</button>
        </div>`;
      return;
    }
    // First run on this device (nothing cached): wait for the server data.
    if (!shownFromCache) await freshLoad;
    else freshLoad.catch(e => console.warn('[boot] refresh failed:', e.message));
    _hideSplash();

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
      e.returnValue='Are you sure you want to leave STSB?';
      return e.returnValue;
    });

    // NEW: start real-time broadcast listener + location tracking + sales target
    startBroadcastListener();
    startOrdersLiveListener();
    try { startLocationTracking(); } catch (e) { console.warn('[Location] tracking failed to start:', e); }
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
    _hideSplash();
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
  _reloadActivePage();

  // If rep locations modal is open, restart the live listener under the new zone filter
  const repLocModal = document.getElementById('mRepLocations');
  if(repLocModal && repLocModal.classList.contains('show')) {
    _startRepLocationsListener();
  }
}

// Re-draw the page on screen with fresh data.
function _reloadActivePage() {
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
    liveLocations: ()=>window.__llReload&&window.__llReload(),
    advances:   ()=>typeof loadMyAdvances==='function'&&loadMyAdvances(),
  };
  if(reloaders[pg]) reloaders[pg]();
}

// ── Sync button (top bar): fresh data from the server for every page,
// a new location for field staff, and the latest app version if one is
// waiting (installed now unless an order or form is open).
let _syncing = false;
async function syncApp() {
  if (_syncing) return;
  if (!navigator.onLine) { showToast('No internet: showing saved data. Sync again when online.', 'warn'); return; }
  _syncing = true;
  const btn = document.getElementById('syncBtn');
  if (btn) btn.classList.add('spin');
  try {
    invalidateCache();
    invalidateDashCache();
    await loadCachedData(true);
    _reloadActivePage();
    updateBadges(); updateSidebarStats();
    if (typeof _isFieldUser === 'function' && _isFieldUser()) _captureAndSaveLocation();
    showToast('Synced ✅ — everything is up to date', 'success');
    if (isNativeApp() && _updater()) _otaCheck(true);
  } catch (e) {
    showToast('Sync failed: ' + e.message, 'error');
  } finally {
    _syncing = false;
    if (btn) btn.classList.remove('spin');
  }
}

// ── Show/hide zone bar + export buttons on every page transition ──
const _ZONE_BAR_PAGES = new Set(['dashboard','orders','outlets','collection','reports','monitoring','routes','users','attendance','products','deliveries','outletstructure','liveLocations']);
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
  _downloadCSV(rows, `STSB_Orders_${zoneLabel}_${todayStr()}.csv`);
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
  _downloadCSV(rows, `STSB_Outlets_${zoneLabel}_${todayStr()}.csv`);
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
  _downloadCSV(rows, `STSB_Collections_${zoneLabel}_${todayStr()}.csv`);
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

  _downloadCSV(ordRows, `STSB_Report_${activeRpt}_${zoneLabel}_${todayStr()}.csv`);
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
  _downloadCSV(rows, `STSB_NPVisits_Today_${zoneLabel}_${todayStr()}.csv`);
}

// ── Smart cache: skip Firestore if data is < TTL ms old ─────────────────────
let _cacheTs = 0;
const _CACHE_TTL = 8000; // 8 seconds — stale after writes that call invalidateCache()
function invalidateCache() { _cacheTs = 0; if (typeof _sfMemo !== 'undefined') _sfMemo.clear(); }

// Loads everything the first screen needs in one parallel round and draws
// it. source 'cache' reads the device's Firestore cache (instant, last
// session's data) and returns false when there is nothing cached yet;
// 'server' reads fresh data and redraws.
async function _bootLoad(source) {
  const fromCache = source === 'cache';
  const SF = window.__SF;
  if (fromCache && typeof SF.getDocsFromCache !== 'function') return false;
  const get = ref => (fromCache ? SF.getDocsFromCache(ref) : SF.getDocs(ref))
    .catch(e => { if (!fromCache) console.warn('[boot]', e.message); return { docs: [] }; });
  const names = ['outlets', 'orders', 'collections', 'attendance', 'routes', 'zones'];
  const [snaps, prSnap, uSnap, ovMap] = await Promise.all([
    Promise.all(names.map(n => get(colR(n)))),
    get(rootCol('products')),   // always the root global catalog
    get(_usersRef()),           // zone-filtered for non-owners
    fromCache ? Promise.resolve({}) : _loadZoneProductOverrides(),
  ]);
  const [ouDocs, ordDocs, colDocs, attDocs, rtDocs, znDocs] = snaps.map(s => s.docs);
  if (fromCache && !ouDocs.length && !prSnap.docs.length) return false;

  allZones    = znDocs.map(d=>({id:d.id,...d.data()}));
  allOutlets  = _scopeOutlets(ouDocs.map(d=>({id:d.id,...d.data()})), ordDocs.map(d=>d.data()));
  allUsers    = isOwner()
    ? uSnap.docs.map(d=>({...d.data()}))
    : uSnap.docs.map(d=>({...d.data()})).filter(u=>u.isOwner||u.zoneId===CU.zoneId||u.uid===CU.uid);
  allProducts = _applyProductOverrides(prSnap.docs, ovMap);
  allRoutes   = rtDocs.map(d=>({id:d.id,...d.data()}));
  if (!fromCache) {
    _cacheTs = Date.now();
    names.forEach((n, i) => _sfMemoSet(n, snaps[i].docs));
  }

  // Init zone bar + export buttons — allZones is populated
  if(isAdmin()) initOwnerZoneBar();
  _renderDashboard(ordDocs, colDocs, attDocs);
  _checkTodayAttendance(attDocs);
  _updateBadges(ordDocs);
  _updateSidebarStats(ordDocs, colDocs);
  return true;
}

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
  const _dmOrders = isDeliveryMan()
    ? (await sfGet('orders', [window.__SF.where('deliveryManId', '==', CU.uid)])).map(d => d.data()) : [];
  allOutlets = _scopeOutlets(ouDocs.map(d=>({id:d.id,...d.data()})), _dmOrders);
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

// ═══════════════ OVER-THE-AIR APP UPDATES (Android) ═══════════════
// The Android app runs the code bundled inside it. Each deploy also
// publishes that code as a checksummed package at /ota/ (see build.js);
// the app downloads it in the background with @capgo/capacitor-updater
// and switches to it on the next cold start, or when the rep returns to
// the app with nothing in progress. A package that fails to start is
// rolled back by the plugin and never retried. Native changes (new
// permissions or plugins) still need a new APK: those packages declare a
// higher minNativeBuild and the app asks the user to install the new APK.
const OTA_BASE = 'https://stfm-sales.web.app/ota/';
const OTA_PENDING_KEY = 'stfm_ota_pending';
const OTA_BAD_KEY = 'stfm_ota_bad';
let _otaBusy = false;

function isNativeApp() { return !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()); }
function _updater() { return window.Capacitor?.Plugins?.CapacitorUpdater || null; }
function _lsGet(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } }
function _lsSet(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }

async function startOtaUpdates() {
  const U = _updater();
  if (!isNativeApp() || !U) return;
  // Tell the plugin this bundle started fine — otherwise it rolls back.
  try { await U.notifyAppReady(); } catch (e) { console.warn('[OTA] notifyAppReady', e.message); }
  await _otaCleanup();
  _otaCheck(true); // cold start: nothing is in progress yet
  setInterval(() => _otaCheck(false), 30 * 60 * 1000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') _otaCheck(true);
  });
}

async function _otaCheck(applyIfSafe) {
  const U = _updater();
  if (!U || _otaBusy || !navigator.onLine) return;
  _otaBusy = true;
  try {
    const res = await fetch(OTA_BASE + 'latest.json?t=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) return;
    const m = await res.json();
    if (!m.version || m.version === window.__APP_VERSION) { _lsSet(OTA_PENDING_KEY, null); return; }
    if ((_lsGet(OTA_BAD_KEY) || []).includes(m.version)) return;

    const info = await window.Capacitor.Plugins.App.getInfo();
    if ((parseInt(info.build, 10) || 0) < (m.minNativeBuild || 0)) { _showApkUpdateBanner(m.apkUrl); return; }

    let pending = _lsGet(OTA_PENDING_KEY);
    if (!pending || pending.version !== m.version) {
      const bundle = await U.download({ url: new URL(m.url, OTA_BASE).href, version: m.version, checksum: m.checksum });
      pending = { id: bundle.id, version: m.version };
      _lsSet(OTA_PENDING_KEY, pending);
      console.log('[OTA] downloaded', m.version);
    }
    if (applyIfSafe && _safeToReload()) {
      console.log('[OTA] applying', pending.version);
      await U.set({ id: pending.id }); // reloads into the new code
    }
  } catch (e) {
    console.warn('[OTA] check failed:', e.message);
  } finally {
    _otaBusy = false;
  }
}

// Remember versions the plugin rolled back, and drop old downloads.
async function _otaCleanup() {
  const U = _updater();
  try {
    const [{ bundle: current }, { bundles }] = await Promise.all([U.current(), U.list()]);
    const pending = _lsGet(OTA_PENDING_KEY);
    for (const b of bundles || []) {
      if (b.status === 'error') {
        _lsSet(OTA_BAD_KEY, [...new Set([...(_lsGet(OTA_BAD_KEY) || []), b.version])].slice(-10));
        if (pending && pending.id === b.id) _lsSet(OTA_PENDING_KEY, null);
      }
      const keep = b.id === current.id || (pending && pending.id === b.id && b.status !== 'error');
      if (!keep) await U.delete({ id: b.id }).catch(() => {});
    }
  } catch (e) { console.warn('[OTA] cleanup', e.message); }
}

// Never reload over unsaved work: an open modal or an order being built.
function _safeToReload() {
  if (document.querySelector('.moverlay.show')) return false;
  const cat = document.getElementById('orderCatalog');
  if (cat && cat.style.display && cat.style.display !== 'none') return false;
  if (typeof ordItems !== 'undefined' && ordItems.length) return false;
  return true;
}

function _showApkUpdateBanner(apkUrl) {
  if (document.getElementById('apkUpdateBanner')) return;
  const bar = document.createElement('div');
  bar.id = 'apkUpdateBanner';
  bar.style.cssText = 'position:fixed;left:12px;right:12px;bottom:calc(12px + env(safe-area-inset-bottom));z-index:9998;' +
    'display:flex;align-items:center;gap:10px;background:var(--s1);border:1px solid var(--ylw);border-radius:12px;' +
    'padding:10px 12px;box-shadow:0 10px 30px rgba(0,0,0,.35);font-size:13px;color:var(--tx)';
  bar.innerHTML = '<span style="flex:1">📲 A new version of the STSB app must be installed. ' +
    (apkUrl ? '' : 'Ask your admin for the latest app.') + '</span>' +
    (apkUrl ? '<button class="btn btn-primary btn-sm" id="apkUpdateBtn">Download</button>' : '') +
    '<button class="btn btn-ghost btn-sm" onclick="this.parentNode.remove()">Later</button>';
  document.body.appendChild(bar);
  const btn = document.getElementById('apkUpdateBtn');
  if (btn) btn.onclick = () => window.open(apkUrl, '_system');
}

window.addEventListener('load', () => { startOtaUpdates(); });

// ═══════════════ FIELD STAFF: ANDROID APP ONLY ═══════════════
// Salesmen and delivery men must use the Android app; in a web browser
// they are signed out with instructions. Admins can still use the web.
function _fieldStaffBlockedOnWeb(user) {
  return !isNativeApp() && !!user && (user.role === 'sales_rep' || user.role === 'delivery_man');
}

function showStoremanScreen() {
  _hideSplash();
  document.getElementById('loader')?.classList.add('hidden');
  const app = document.getElementById('app');
  if (app) app.style.display = 'none';
  const login = document.getElementById('loginPage');
  if (login) login.style.display = 'none';
  const el = document.createElement('div');
  el.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;padding:24px;background:var(--bg)';
  el.innerHTML = '<div style="max-width:340px;text-align:center;background:var(--s1);border:1px solid var(--bdr);border-radius:20px;padding:28px 24px">' +
    '<div style="font-size:44px;margin-bottom:12px">🏬</div>' +
    '<div style="font-family:\'Syne\',sans-serif;font-size:17px;font-weight:800;margin-bottom:8px;color:var(--tx)">Storeman account</div>' +
    '<div style="font-size:13px;color:var(--tx2);line-height:1.6;margin-bottom:18px">Picking, packing and stock are in the ERP. Sign in there with the same email and password.</div>' +
    '<a class="btn btn-primary" style="width:100%;display:block;margin-bottom:8px" href="https://stfm-sales.web.app/portal" target="_system">Open the ERP</a>' +
    '<button class="btn btn-ghost" style="width:100%" onclick="location.reload()">Back to sign in</button></div>';
  document.body.appendChild(el);
}

function showNativeAppOnlyScreen() {
  _hideSplash();
  document.getElementById('loader')?.classList.add('hidden');
  const app = document.getElementById('app');
  if (app) app.style.display = 'none';
  const login = document.getElementById('loginPage');
  if (login) login.style.display = 'none';
  let el = document.getElementById('nativeOnlyScreen');
  if (!el) {
    el = document.createElement('div');
    el.id = 'nativeOnlyScreen';
    el.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;padding:24px;background:var(--bg)';
    el.innerHTML = '<div style="max-width:340px;text-align:center;background:var(--s1);border:1px solid var(--bdr);border-radius:20px;padding:28px 24px">' +
      '<div style="font-size:44px;margin-bottom:12px">📱</div>' +
      '<div style="font-family:\'Syne\',sans-serif;font-size:17px;font-weight:800;margin-bottom:8px;color:var(--tx)">Use the STSB app</div>' +
      '<div style="font-size:13px;color:var(--tx2);line-height:1.6;margin-bottom:18px">Sales and delivery work is done in the STSB Android app. The web version is for admins only.</div>' +
      '<button class="btn btn-primary" style="width:100%" onclick="location.reload()">Back to sign in</button></div>';
    document.body.appendChild(el);
  }
  el.style.display = 'flex';
}
