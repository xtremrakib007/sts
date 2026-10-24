
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

