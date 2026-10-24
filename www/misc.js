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
  if(!confirm(`Delete zone "${name}"? Zone data in Firestore (zones/${id}/...) is NOT deleted. This cannot be undone.`))return;
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

  const confirmed = confirm(
    `Migrate ALL root data into zone "${zone.name}"?\n\n` +
    `• All records will be COPIED into zones/${zoneId}/...\n` +
    `• Original root data is NOT deleted (safe to undo)\n` +
    `• Existing records in the zone with the same ID will be overwritten\n\n` +
    `This may take a minute. Continue?`
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
  await _uploadUserPhoto(type, file);
  input.value='';
}

// Capacitor: pick from gallery or camera for profile/cover photo
async function pickUserPhoto(type, source) {
  const isCapacitor=!!(window.Capacitor?.isNativePlatform?.());
  if(isCapacitor){
    try{
      const {Camera,CameraSource,CameraResultType}=window.Capacitor.Plugins;
      const src=source==='camera'?CameraSource.Camera:CameraSource.Photos;
      const photo=await Camera.getPhoto({resultType:CameraResultType.Blob,source:src,quality:85,width:1024,correctOrientation:true});
      if(photo&&photo.blob) await _uploadUserPhoto(type, photo.blob);
    }catch(e){
      if(e&&e.message&&e.message.toLowerCase().includes('cancel'))return;
      showToast('Could not open '+(source==='camera'?'camera':'gallery')+': '+e.message,'error');
    }
  } else {
    // PWA fallback — trigger file input
    const inputId=type==='avatar'?'upPhotoFile':'upCoverFile';
    const el=document.getElementById(inputId);
    if(el)el.click();
  }
}

async function _uploadUserPhoto(type, fileOrBlob) {
  const progressId=type==='avatar'?'upAvatarProgress':'upCoverProgress';
  const prog=document.getElementById(progressId);
  if(prog)prog.style.display='';
  try {
    const {storageRef,uploadBytes,getDownloadURL,storage}=window.__SF;
    const path=`users/${CU.uid}/${type}_${Date.now()}`;
    const ref=storageRef(storage, path);
    await uploadBytes(ref, fileOrBlob);
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
  finally { if(prog)prog.style.display='none'; }
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
