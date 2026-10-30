// ═══════════════ LOCATION TRACKING ═══════════════
let _locationWatcher = null;
let _locationInterval = null;  // 5-min fallback timer for background pings
let _locationRetryTimer = null; // retry after GPS error

// ── Capacitor native geolocation (APK) vs browser fallback ──────────────────
// On Android APK, navigator.geolocation can return stale cached positions or
// silently fail. Capacitor's native plugin is far more reliable in the APK.
function _isCapacitor() {
  return !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
}

async function _getPositionNative() {
  // Use Capacitor Geolocation plugin if available (APK)
  if (_isCapacitor() && window.Capacitor.Plugins && window.Capacitor.Plugins.Geolocation) {
    const { Geolocation } = window.Capacitor.Plugins;
    const pos = await Geolocation.getCurrentPosition({
      enableHighAccuracy: true,
      timeout: 15000,
    });
    return pos; // same shape as browser GeolocationPosition
  }
  // Browser fallback (PWA / web)
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true,
      timeout: 15000,
      maximumAge: 0,
    });
  });
}

// ── Field user check — tracks both sales_rep AND delivery_man ───────────────
function _isFieldUser() {
  return CU && (CU.role === 'sales_rep' || CU.role === 'delivery_man');
}

// SW → page: SW periodicsync fires → asks page to get GPS
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', event => {
    if (event.data && event.data.type === 'REQUEST_LOCATION') {
      if (_isFieldUser()) _captureAndSaveLocation();
    }
  });
}

// Refresh when tab/app comes back into focus
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && _isFieldUser()) {
    _captureAndSaveLocation();
  }
});

// ── App resume event (Capacitor) ─────────────────────────────────────────────
// Fires when user switches back to the APK from another app
document.addEventListener('resume', () => {
  if (_isFieldUser()) {
    console.log('[Location] App resumed — capturing location');
    _captureAndSaveLocation();
  }
});

async function _captureAndSaveLocation() {
  if (!_isFieldUser()) return;
  try {
    const pos = await _getPositionNative();
    _userLat = pos.coords.latitude;
    _userLng = pos.coords.longitude;
    _gpsGranted = true;
    saveUserLocation(pos);
    // Clear any pending retry since we succeeded
    if (_locationRetryTimer) { clearTimeout(_locationRetryTimer); _locationRetryTimer = null; }
  } catch(e) {
    console.warn('[Location] GPS capture failed:', e.message || e.code);
    // Retry after 60s if GPS failed (e.g. no signal, permission revoked mid-session)
    if (!_locationRetryTimer) {
      _locationRetryTimer = setTimeout(() => {
        _locationRetryTimer = null;
        _captureAndSaveLocation();
      }, 60000);
    }
  }
}

// ── requestGPSPermission — called by bootApp before starting tracking ─────────
// Returns true  → permission granted (or already known-granted)
// Returns false → denied or unavailable
// For admins this always returns true (they are never tracked).
// Timeout of 8s — if user doesn't respond, we fail open so the app doesn't hang.
async function requestGPSPermission() {
  if (isAdmin()) return true;
  if (!navigator.geolocation) return false;

  // Check Permissions API first (avoids a visible prompt if already decided)
  if (navigator.permissions) {
    try {
      const status = await navigator.permissions.query({ name: 'geolocation' });
      if (status.state === 'granted')  { _gpsGranted = true;  return true; }
      if (status.state === 'denied')   { _gpsGranted = false; return false; }
      // state === 'prompt' → fall through to actually ask
    } catch(e) { /* permissions API not supported — ask directly */ }
  }

  // Actually request GPS with an 8-second timeout
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(true), 8000); // fail open after 8s
    navigator.geolocation.getCurrentPosition(
      () => { clearTimeout(timer); _gpsGranted = true;  resolve(true); },
      () => { clearTimeout(timer); _gpsGranted = false; resolve(false); },
      { enableHighAccuracy: false, timeout: 7000, maximumAge: 60000 }
    );
  });
}

function startLocationTracking() {
  // Admins are never tracked
  if (isAdmin()) return;
  // Only track field users
  if (!_isFieldUser()) return;

  console.log('[Location] Starting location tracking for', CU.role);

  // Admins see "app last open" on Live Locations even before a GPS fix.
  _markSeen();

  // Immediate fix on start (asks for location permission in the APK first)
  _ensureNativePermission().then(_captureAndSaveLocation);

  // ── APK 1.5+: background tracking (a foreground service keeps sending
  // the location with the app closed or the phone locked; Android shows a
  // "sharing location" notification while it runs). Older APKs fall back
  // to the in-app watch below.
  if (_bgGeo()) {
    _startBackgroundWatch();
  } else
  // ── Capacitor APK: use native watch ─────────────────────────────────────
  if (_isCapacitor() && window.Capacitor.Plugins && window.Capacitor.Plugins.Geolocation) {
    const { Geolocation } = window.Capacitor.Plugins;
    // Clear previous watcher
    if (_locationWatcher !== null) {
      try { Promise.resolve(Geolocation.clearWatch({ id: _locationWatcher })).catch(() => {}); } catch (e) {}
      _locationWatcher = null;
    }
    // The native bridge returns the watch id directly for callback methods,
    // the npm wrapper returns a promise of it: accept either.
    let watch;
    try {
      watch = Promise.resolve(Geolocation.watchPosition(
      { enableHighAccuracy: true, timeout: 15000 },
      (pos, err) => {
        if (err) {
          console.warn('[Location] Native watch error:', err.message);
          return;
        }
        if (!pos) return;
        _userLat = pos.coords.latitude;
        _userLng = pos.coords.longitude;
        _gpsGranted = true;
        saveUserLocation(pos);
      }
    ));
    } catch (e) { watch = Promise.reject(e); }
    watch.then(watchId => {
      _locationWatcher = watchId;
      console.log('[Location] Native watcher started, id:', watchId);
    }).catch(e => {
      console.warn('[Location] Native watch failed, falling back to browser:', e.message);
      _startBrowserWatch();
    });
  } else {
    // ── Browser / PWA: use navigator.geolocation ────────────────────────
    _startBrowserWatch();
  }

  // 2-minute forced ping — ensures location saves even when watcher
  // is throttled by the OS (app backgrounded, screen locked)
  if (_locationInterval) clearInterval(_locationInterval);
  _locationInterval = setInterval(_captureAndSaveLocation, 2 * 60 * 1000);

  // Register Periodic Background Sync (PWA installed on Android Chrome)
  _registerPeriodicLocationSync();

  // Persistent keepalive notification (prevents Android killing browser)
  _requestNotificationPermission();

  // Show green tracking dot in sidebar
  _showTrackingIndicator(true);
}

async function _markSeen() {
  try { await window.__SF.updateDoc(rootDocRef('users', CU.uid), { lastSeen: new Date().toISOString() }); }
  catch (e) { console.warn('[Location] lastSeen write failed:', e.message); }
}

// APK: ask for location if it hasn't been granted yet, and tell the user
// once when it is off, since the admin can't see them without it.
let _gpsWarned = false;
async function _ensureNativePermission() {
  const G = _isCapacitor() && window.Capacitor.Plugins && window.Capacitor.Plugins.Geolocation;
  if (!G || !G.checkPermissions) return;
  try {
    let st = await G.checkPermissions();
    if (st.location !== 'granted' && st.coarseLocation !== 'granted') st = await G.requestPermissions();
    if (st.location !== 'granted' && st.coarseLocation !== 'granted' && !_gpsWarned) {
      _gpsWarned = true;
      showToast('📍 Location is off for STSB. Allow it in phone Settings → Apps → STSB → Location so your admin can see you.', 'warn');
    }
  } catch (e) { console.warn('[Location] permission check failed:', e.message); }
}

// ── Background tracking (APK 1.5+: @capacitor-community/background-geolocation)
let _bgWatcherId = null, _bgStarting = false, _bgStopAsked = false;
function _bgGeo() {
  const C = window.Capacitor;
  if (!C || !C.isNativePlatform || !C.isNativePlatform() || !C.isPluginAvailable || !C.isPluginAvailable('BackgroundGeolocation')) return null;
  return C.Plugins.BackgroundGeolocation || (C.registerPlugin ? C.registerPlugin('BackgroundGeolocation') : null);
}
function _startBackgroundWatch() {
  const BG = _bgGeo(); if (!BG || _bgWatcherId || _bgStarting) return;
  _bgStarting = true; _bgStopAsked = false;
  BG.addWatcher({
    backgroundTitle: 'STSB is sharing your location',
    backgroundMessage: 'Your office sees your location while you work. It stops when you sign out.',
    requestPermissions: true,
    stale: false,
    distanceFilter: 20, // metres between updates
  }, (loc, err) => {
    if (err) {
      if (err.code === 'NOT_AUTHORIZED' && !_gpsWarned) {
        _gpsWarned = true;
        if (confirm('STSB needs your location to share it with the office while you work.\n\nOpen settings and allow Location?')) BG.openSettings();
      } else console.warn('[Location] background watch error:', err.message || err.code);
      return;
    }
    if (!loc) return;
    const pos = { coords: { latitude: loc.latitude, longitude: loc.longitude, accuracy: loc.accuracy }, timestamp: loc.time || Date.now() };
    _userLat = pos.coords.latitude; _userLng = pos.coords.longitude; _gpsGranted = true;
    saveUserLocation(pos);
  }).then(id => {
    _bgStarting = false;
    if (_bgStopAsked) { Promise.resolve(BG.removeWatcher({ id })).catch(() => {}); return; } // signed out meanwhile
    _bgWatcherId = id; console.log('[Location] background watcher started');
  }).catch(e => { _bgStarting = false; console.warn('[Location] background watch failed, using in-app watch:', e.message); _startNativeWatchFallback(); });
}
function _startNativeWatchFallback() {
  const G = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Geolocation;
  if (!G) { _startBrowserWatch(); return; }
  try {
    Promise.resolve(G.watchPosition({ enableHighAccuracy: true, timeout: 15000 }, (pos, err) => {
      if (err || !pos) return;
      _userLat = pos.coords.latitude; _userLng = pos.coords.longitude; _gpsGranted = true;
      saveUserLocation(pos);
    })).then(id => { _locationWatcher = id; }).catch(() => _startBrowserWatch());
  } catch (e) { _startBrowserWatch(); }
}

// With the app in the background Android slows the WebView's own network
// requests, so locations are then saved through the native HTTP client
// (Firestore REST, same rules: the user's own lastLat/lastLng fields).
let _idTok = null, _idTokAt = 0;
async function _idToken() {
  const u = window.__SF && window.__SF.auth && window.__SF.auth.currentUser;
  if (!u) return null;
  if (_idTok && Date.now() - _idTokAt < 45 * 60 * 1000) return _idTok;
  try { _idTok = await u.getIdToken(); _idTokAt = Date.now(); } catch (e) { /* keep the last one */ }
  return _idTok;
}
async function _saveLocationNative(fields) {
  const H = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.CapacitorHttp;
  const tok = await _idToken();
  if (!H || !tok) return false;
  const project = (window.__SF.db && window.__SF.db.app && window.__SF.db.app.options && window.__SF.db.app.options.projectId) || 'stfm-sales';
  const mask = Object.keys(fields).map(k => 'updateMask.fieldPaths=' + k).join('&');
  const val = v => typeof v === 'number' ? (Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v }) : { stringValue: String(v) };
  const r = await H.request({
    method: 'PATCH',
    url: `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents/users/${CU.uid}?${mask}&currentDocument.exists=true`,
    headers: { 'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json' },
    data: { fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, val(v)])) },
  });
  return r && r.status >= 200 && r.status < 300;
}

function _startBrowserWatch() {
  if (!navigator.geolocation) return;
  if (_locationWatcher !== null) {
    navigator.geolocation.clearWatch(_locationWatcher);
    _locationWatcher = null;
  }
  _locationWatcher = navigator.geolocation.watchPosition(
    pos => {
      _userLat = pos.coords.latitude;
      _userLng = pos.coords.longitude;
      _gpsGranted = true;
      saveUserLocation(pos);
    },
    err => {
      // Log the error but DO NOT silently swallow it — attempt recovery
      console.warn('[Location] Browser watch error code:', err.code, err.message);
      // PERMISSION_DENIED = 1, POSITION_UNAVAILABLE = 2, TIMEOUT = 3
      if (err.code === 1) {
        // Permission denied — stop trying, show user
        _showTrackingIndicator(false);
        showToast('Location permission denied. Please enable GPS in settings.', 'error');
      } else {
        // Timeout or unavailable — retry in 30s
        if (!_locationRetryTimer) {
          _locationRetryTimer = setTimeout(() => {
            _locationRetryTimer = null;
            _startBrowserWatch(); // restart the watcher
          }, 30000);
        }
      }
    },
    { enableHighAccuracy: true, timeout: 20000, maximumAge: 10000 }
  );
}

function stopLocationTracking() {
  // Background watcher (APK 1.5+): removing it ends the notification
  if (_bgStarting) _bgStopAsked = true;
  if (_bgWatcherId) {
    const BG = _bgGeo();
    if (BG) Promise.resolve(BG.removeWatcher({ id: _bgWatcherId })).catch(() => {});
    _bgWatcherId = null;
  }
  // Stop native Capacitor watcher
  if (_locationWatcher !== null) {
    if (_isCapacitor() && window.Capacitor.Plugins && window.Capacitor.Plugins.Geolocation) {
      try { Promise.resolve(window.Capacitor.Plugins.Geolocation.clearWatch({ id: _locationWatcher })).catch(() => {}); } catch (e) {}
    } else if (navigator.geolocation) {
      navigator.geolocation.clearWatch(_locationWatcher);
    }
    _locationWatcher = null;
  }
  if (_locationInterval) { clearInterval(_locationInterval); _locationInterval = null; }
  if (_locationRetryTimer) { clearTimeout(_locationRetryTimer); _locationRetryTimer = null; }
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
    await reg.showNotification('STSB — Location Tracking Active', {
      body: 'Your location is being tracked for your shift. Do not close this notification.',
      icon: "data:image/png;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/4gHYSUNDX1BST0ZJTEUAAQEAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEI=",
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

// ── saveUserLocation — writes to Firestore ────────────────────────────────────
let _lastSavedLat=null, _lastSavedLng=null, _lastSavedTs=0;
const _LOC_MIN_DIST = 0.00005; // ~5m — reduced from 20m so small movements register
const _LOC_MIN_MS   = 15000;   // min 15s between writes (reduced from 30s for faster updates)

async function saveUserLocation(pos) {
  if (!CU || !CU.uid) return;
  if (isAdmin()) return;  // admins never tracked
  const lat = pos.coords.latitude;
  const lng = pos.coords.longitude;
  const now = Date.now();

  // Skip only if BOTH: not moved meaningfully AND written very recently
  if (_lastSavedLat !== null && (now - _lastSavedTs) < _LOC_MIN_MS) {
    const dLat = Math.abs(lat - _lastSavedLat);
    const dLng = Math.abs(lng - _lastSavedLng);
    if (dLat < _LOC_MIN_DIST && dLng < _LOC_MIN_DIST) return;
  }

  try {
    const fields = {
      lastLat: lat,
      lastLng: lng,
      lastLocationAt: new Date().toISOString(),
      lastAccuracy: Math.round(pos.coords.accuracy || 0),
      lastSeen: new Date().toISOString(),
    };
    if (document.visibilityState !== 'hidden') _idToken(); // keep a fresh token for background saves
    const nativeDone = document.visibilityState === 'hidden' && _isCapacitor() && await _saveLocationNative(fields).catch(() => false);
    if (!nativeDone) await window.__SF.updateDoc(rootDocRef('users', CU.uid), fields);
    _lastSavedLat = lat;
    _lastSavedLng = lng;
    _lastSavedTs  = now;
    console.log('[Location] Saved:', lat.toFixed(5), lng.toFixed(5));
    // Notify service worker
    navigator.serviceWorker?.controller?.postMessage({
      type: 'LOCATION_UPDATE', lat, lng,
    });
  } catch(e) {
    console.warn('[Location] Firestore write failed:', e.message);
  }
}

// ── Live Rep Locations — real-time onSnapshot listener ─────────────────
let _repLocUnsub = null;
let _repLocAgeTimer = null;
let _repLocLastData = [];

function openRepLocations() {
  if(!isAdmin()) { showToast('Admin only','error'); return; }
  closeSidebar();
  _startRepLocationsListener();
  openM('mRepLocations');
}

function closeRepLocations() {
  _stopRepLocationsListener();
  closeM('mRepLocations');
}

function _startRepLocationsListener() {
  _stopRepLocationsListener();

  const list = document.getElementById('repLocationsList');
  if(!list) return;
  list.innerHTML='<div style="font-size:13px;color:var(--tx3);padding:14px 0">Connecting to live feed…</div>';

  const ttl = document.querySelector('#mRepLocations .mttl');
  if(ttl) ttl.innerHTML='📍 Sales Rep Locations <span style="display:inline-flex;align-items:center;gap:4px;font-size:10px;font-weight:700;color:var(--grn);background:rgba(34,197,94,.12);border:1px solid rgba(34,197,94,.25);border-radius:6px;padding:2px 7px;margin-left:6px;vertical-align:middle"><span style="width:6px;height:6px;border-radius:50%;background:var(--grn);animation:pulse 2s infinite;display:inline-block"></span>LIVE</span>';

  try {
    const { onSnapshot } = window.__SF;
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
    console.warn('[repLocations] onSnapshot unavailable, falling back to one-time read');
    refreshRepLocations();
    return;
  }

  _repLocAgeTimer = setInterval(() => {
    if(_repLocLastData.length) _renderRepLocationsList(_repLocLastData);
  }, 30000);
}

function _stopRepLocationsListener() {
  if(_repLocUnsub) { _repLocUnsub(); _repLocUnsub = null; }
  if(_repLocAgeTimer) { clearInterval(_repLocAgeTimer); _repLocAgeTimer = null; }
  _repLocLastData = [];
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
  const sorted = [...fieldUsers].sort((a,b)=>{
    const aT = a.lastLocationAt ? new Date(a.lastLocationAt).getTime() : 0;
    const bT = b.lastLocationAt ? new Date(b.lastLocationAt).getTime() : 0;
    return bT - aT;
  });

  const withLoc = sorted.filter(u=>u.lastLat&&u.lastLng);
  const allMapBtn = withLoc.length >= 2
    ? `<a href="https://maps.google.com/maps?q=${withLoc.map(u=>`${u.lastLat},${u.lastLng}`).join('+')}+to+" target="_blank" style="display:inline-flex;align-items:center;gap:6px;padding:7px 14px;background:var(--acc);color:#fff;border-radius:var(--r2);font-size:11px;font-weight:700;text-decoration:none;margin-bottom:12px">🗺️ Open All on Map</a>`
    : '';

  // "active" = updated within last 15 minutes
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
    const fresh  = locAge !== null && locAge < 15;
    const warn   = locAge !== null && locAge < 60;
    const dotColor = fresh ? 'var(--grn)' : warn ? 'var(--ylw)' : 'var(--tx3)';
    const roleLabel = {sales_rep:'Sales Rep',delivery_man:'Delivery Man'}[u.role]||u.role;
    const roleBg    = {sales_rep:'var(--blu)',delivery_man:'var(--grn)'}[u.role]||'var(--tx3)';
    const mapsUrl   = `https://www.google.com/maps/dir/?api=1&destination=${u.lastLat},${u.lastLng}&travelmode=driving`;
    const gmapsView = `https://maps.google.com/?q=${u.lastLat},${u.lastLng}`;
    const zoneName_ = u.zoneName || u.zoneId || '—';
    const ageLabel  = locAge===null ? '' : locAge===0 ? 'Just now' : locAge<60 ? `${locAge}m ago` : `${Math.round(locAge/60)}h ago`;
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
