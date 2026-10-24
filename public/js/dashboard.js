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

