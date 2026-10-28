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

// What an order still counts for in the outlet balance: its delivered value
// (after a partial delivery) less goods returned on credit notes.
function _orderAmountDue(o){
  const base=o.deliveredTotal!=null?Number(o.deliveredTotal):Number(o.total);
  return Math.max(0,(base||0)-(Number(o.returnedTotal)||0));
}

// Pending balance state
let _pendingAmt = 0;

async function loadOutletPendingBalance(outletId) {
  const info=document.getElementById('pendingBalanceInfo');
  if(!outletId){info.style.display='none';return;}
  // Calculate outstanding: total orders - total collections + approved opening balance
  const [ordD,colD]=await Promise.all([sfGet('orders'),sfGet('collections')]);
  const outlet=allOutlets.find(o=>o.id===outletId)||{};
  const oOrders=ordD.map(d=>d.data()).filter(x=>x.outletId===outletId&&x.status!=='Cancelled').reduce((s,x)=>s+_orderAmountDue(x),0);
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
    if(!confirm('Delete this collection record?'))return;
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

