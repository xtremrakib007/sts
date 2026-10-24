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
  const deviceLock=document.getElementById('uDeviceLock')?.checked!==false;
  if(!name||!email||!pwd){showToast('Name, email and password required','error');return;}
  if(pwd.length<6){showToast('Password must be at least 6 characters','error');return;}

  // Determine zoneId: owner picks from dropdown; zone admin assigns their own zone
  const uZoneSel=document.getElementById('uZone');
  const assignedZoneId=isOwner()?(uZoneSel?.value||null):(CU.zoneId||null);
  const assignedZone=allZones.find(z=>z.id===assignedZoneId);

  const saveBtn=document.querySelector('#mUser .btn-primary');
  if(saveBtn){saveBtn.disabled=true;saveBtn.textContent='⏳ Creating...';}

  try {
    // ── Use secondary Firebase app so admin stays logged in ──
    // createUserWithEmailAndPassword on the main auth auto-signs in the new
    // user and kicks the admin out. createUserSafe uses a separate auth
    // instance that is immediately signed out after creation.
    const cred=await window.__SF.createUserSafe(email,pwd);

    // Users always stored at root — use rootDocRef
    await window.__SF.setDoc(rootDocRef('users',cred.user.uid),{
      uid:cred.user.uid,
      name,
      email,
      role,
      phone,
      status:'active',
      deviceLock:deviceLock,
      zoneId:assignedZoneId||null,
      zoneName:assignedZone?.name||null,
      createdBy:CU.uid,
      createdAt:new Date().toISOString()
    });

    closeM('mUser');
    showToast(`✅ User ${name} created as ${role.replace('_',' ')}. Admin session unchanged.`,'success');
    await loadCachedData();
    loadUsers();
  } catch(err) {
    const msgs={
      'auth/email-already-in-use':'That email is already registered.',
      'auth/weak-password':'Password is too weak (min 6 characters).',
      'auth/invalid-email':'Invalid email address.',
      'auth/network-request-failed':'Network error — check your connection.'
    };
    showToast(msgs[err.code]||err.message,'error');
  } finally {
    if(saveBtn){saveBtn.disabled=false;saveBtn.textContent='Create User';}
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
  if(!confirm(`⚠️ PERMANENTLY DELETE user "${name}"?\n\nThis removes their profile from the system. Their Firebase Auth account must be deleted separately in Firebase Console.\n\nThis cannot be undone!`))return;
  try{
    await window.__SF.deleteDoc(rootDocRef('users',uid));
    showToast(`User "${name}" deleted from system`,'warn');
    await loadCachedData();loadUsers();
  }catch(e){showToast('Failed to delete user: '+e.message,'error');}
}

async function deleteOrder(docId, label, zoneId) {
  if(!isStrictAdmin()){showToast('Superadmin only','error');return;}
  if(!confirm('⚠️ PERMANENTLY DELETE ' + label + '? This cannot be undone.'))return;
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
  if(!confirm('⚠️ DELETE attendance record for ' + label + '? This cannot be undone.'))return;
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
  if(!confirm(`⚠️ DELETE NP visit record for ${label}? This cannot be undone.`))return;
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

