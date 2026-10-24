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

