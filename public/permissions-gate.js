// ═══════════════════════════════════════════════════════════════
// STFM — Comprehensive Device Permissions Gate
// ───────────────────────────────────────────────────────────────
// Shows a full-screen permission onboarding screen once per
// session. Requests: Camera, Microphone, Location, Notifications,
// Persistent Storage. Replaces the inline GPS check in bootApp.
//
// HOW TO INTEGRATE:
//   1. Add this whole block to app.js (anywhere above bootApp).
//   2. In bootApp, REPLACE the block:
//        const gpsOk = await requestGPSPermission();
//        if (!gpsOk && !isAdmin()) { ... long inline HTML ... return; }
//      WITH:
//        const permsOk = await showPermissionsGate();
//        if (!permsOk) return; // user tapped Sign Out
//   3. Add the CSS block below to app.css.
// ═══════════════════════════════════════════════════════════════

// Permissions asked once per session; key cleared on logout.
const PERMS_KEY = 'stfm_perms_done';

const PERM_DEFS = [
  {
    id:     'location',
    icon:   '📍',
    label:  'Location',
    reason: 'Required for GPS tracking, outlet sorting, and field visit logging.',
    grant:  async () => {
      return new Promise(resolve => {
        if (!navigator.geolocation) { resolve('denied'); return; }
        navigator.geolocation.getCurrentPosition(
          pos => {
            _userLat = pos.coords.latitude;
            _userLng = pos.coords.longitude;
            _gpsGranted = true;
            resolve('granted');
          },
          () => resolve('denied'),
          { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 }
        );
      });
    },
    // Location is required only for field users
    required: () => !isAdmin(),
  },
  {
    id:     'camera',
    icon:   '📷',
    label:  'Camera',
    reason: 'Used for selfie check-in/out, product photos, and QR outlet scanning.',
    grant:  async () => {
      try {
        const s = await navigator.mediaDevices.getUserMedia({ video: true });
        s.getTracks().forEach(t => t.stop()); // release immediately
        return 'granted';
      } catch { return 'denied'; }
    },
    required: () => true,
  },
  {
    id:     'microphone',
    icon:   '🎙️',
    label:  'Microphone',
    reason: 'Optional — may be used for voice notes in future updates.',
    grant:  async () => {
      try {
        const s = await navigator.mediaDevices.getUserMedia({ audio: true });
        s.getTracks().forEach(t => t.stop());
        return 'granted';
      } catch { return 'denied'; }
    },
    required: () => false,
  },
  {
    id:     'notifications',
    icon:   '🔔',
    label:  'Notifications',
    reason: 'Receive order alerts, delivery updates, and broadcast messages.',
    grant:  async () => {
      if (!('Notification' in window)) return 'unsupported';
      if (Notification.permission === 'granted') return 'granted';
      const r = await Notification.requestPermission().catch(() => 'denied');
      return r === 'granted' ? 'granted' : 'denied';
    },
    required: () => false,
  },
  {
    id:     'storage',
    icon:   '💾',
    label:  'Storage',
    reason: 'Keeps app data and offline cache persistent on this device.',
    grant:  async () => {
      if (!navigator.storage || !navigator.storage.persist) return 'unsupported';
      const granted = await navigator.storage.persist().catch(() => false);
      return granted ? 'granted' : 'denied';
    },
    required: () => false,
  },
];

/**
 * Shows the permission gate screen. Returns true to continue boot,
 * false if the user chose to sign out (only when location denied for field users).
 * Skips the screen entirely if already shown this session.
 */
async function showPermissionsGate() {
  // Already granted this session — skip screen but still run location
  if (sessionStorage.getItem(PERMS_KEY) === '1') {
    return await _reCheckLocation();
  }

  return new Promise(resolve => {
    // Render the gate over the loader (app shell already hidden at this point)
    const loader = document.getElementById('loader');
    loader.classList.remove('hidden');
    loader.style.display = 'flex';
    loader.style.flexDirection = 'column';
    loader.style.alignItems = 'center';
    loader.style.justifyContent = 'center';
    loader.style.background = 'var(--bg)';

    const state = {}; // id → 'idle' | 'loading' | 'granted' | 'denied' | 'unsupported'
    PERM_DEFS.forEach(p => { state[p.id] = 'idle'; });

    function renderCard(p) {
      const s = state[p.id];
      const badgeClass = s === 'granted' ? 'pg-badge granted'
                       : s === 'denied'  ? 'pg-badge denied'
                       : s === 'loading' ? 'pg-badge loading'
                       : 'pg-badge idle';
      const badgeText  = s === 'granted' ? '✓ Allowed'
                       : s === 'denied'  ? '✗ Denied'
                       : s === 'loading' ? '…'
                       : s === 'unsupported' ? '— N/A'
                       : 'Tap to allow';
      return `
        <div class="pg-card ${s}" id="pgcard-${p.id}" onclick="window.__pgGrant('${p.id}')">
          <div class="pg-card-left">
            <div class="pg-icon">${p.icon}</div>
            <div class="pg-card-text">
              <div class="pg-card-label">${p.label}${p.required() ? ' <span class="pg-req">Required</span>' : ''}</div>
              <div class="pg-card-reason">${p.reason}</div>
            </div>
          </div>
          <div class="${badgeClass}">${badgeText}</div>
        </div>`;
    }

    function renderAll() {
      const container = document.getElementById('pg-cards');
      if (!container) return;
      container.innerHTML = PERM_DEFS.map(renderCard).join('');
    }

    function updateContinueBtn() {
      const btn = document.getElementById('pg-continue-btn');
      if (!btn) return;
      const allHandled = PERM_DEFS.every(p =>
        state[p.id] !== 'idle' && state[p.id] !== 'loading'
      );
      btn.disabled = !allHandled;
      btn.textContent = allHandled ? 'Continue to STFM →' : 'Please review permissions above';
    }

    loader.innerHTML = `
      <div class="pg-wrap">
        <div class="pg-header">
          <div class="pg-logo">🏢</div>
          <div class="pg-title">App Permissions</div>
          <div class="pg-subtitle">STFM needs the following permissions to work correctly on your device.</div>
        </div>
        <div class="pg-cards" id="pg-cards">
          ${PERM_DEFS.map(renderCard).join('')}
        </div>
        <div class="pg-actions">
          <button class="pg-grant-all-btn" id="pg-grant-all-btn" onclick="window.__pgGrantAll()">
            Allow All Permissions
          </button>
          <button class="pg-continue-btn" id="pg-continue-btn" disabled onclick="window.__pgContinue()">
            Please review permissions above
          </button>
          <button class="pg-signout-btn" onclick="window.__pgSignOut()">Sign Out</button>
        </div>
      </div>`;

    // ── Per-permission grant handler ──
    window.__pgGrant = async (id) => {
      if (state[id] === 'loading' || state[id] === 'granted') return;
      const def = PERM_DEFS.find(p => p.id === id);
      if (!def) return;

      // Disable grant-all during individual request
      const gab = document.getElementById('pg-grant-all-btn');
      if (gab) gab.disabled = true;

      state[id] = 'loading';
      renderAll();

      state[id] = await def.grant();
      renderAll();
      updateContinueBtn();

      if (gab) gab.disabled = false;
    };

    // ── Grant all sequentially ──
    window.__pgGrantAll = async () => {
      const gab = document.getElementById('pg-grant-all-btn');
      if (gab) { gab.disabled = true; gab.textContent = 'Requesting…'; }

      for (const p of PERM_DEFS) {
        if (state[p.id] === 'granted') continue;
        state[p.id] = 'loading';
        renderAll();
        state[p.id] = await p.grant();
        renderAll();
      }
      updateContinueBtn();
      if (gab) { gab.disabled = false; gab.textContent = 'Allow All Permissions'; }
    };

    // ── Continue ──
    window.__pgContinue = () => {
      // Check if location denied for field users
      if (state.location === 'denied' && !isAdmin()) {
        // Show inline warning but allow user to proceed or sign out
        const warn = document.getElementById('pg-loc-warn');
        if (warn) { warn.style.display = 'block'; return; }
        const actions = document.querySelector('.pg-actions');
        if (actions) {
          const w = document.createElement('div');
          w.id = 'pg-loc-warn';
          w.className = 'pg-loc-warn';
          w.innerHTML = `⚠️ <strong>Location is required</strong> for field users. Please allow location or sign out.`;
          actions.insertBefore(w, actions.firstChild);
        }
        return;
      }

      sessionStorage.setItem(PERMS_KEY, '1');
      loader.innerHTML = ''; // clear
      resolve(true);
    };

    // ── Sign out ──
    window.__pgSignOut = async () => {
      sessionStorage.removeItem(PERMS_KEY);
      await doLogout();
      resolve(false);
    };
  });
}

// Re-run only location after a session resume (permissions already granted before)
async function _reCheckLocation() {
  if (_gpsGranted) return true; // already have coords this session
  const locDef = PERM_DEFS.find(p => p.id === 'location');
  const result = await locDef.grant();
  if (result === 'denied' && !isAdmin()) {
    // Show the full gate again so user can retry
    sessionStorage.removeItem(PERMS_KEY);
    return showPermissionsGate();
  }
  return true;
}

// Call this during logout to reset next-session prompt
function clearPermissionsGate() {
  sessionStorage.removeItem(PERMS_KEY);
}
