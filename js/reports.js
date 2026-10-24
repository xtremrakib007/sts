// ═══════════════ REPORTS ═══════════════
let activeRpt='sales';
function switchRpt(t,el){activeRpt=t;document.querySelectorAll('.rtab').forEach(x=>x.classList.remove('active'));el.classList.add('active');renderReports();}

async function renderReports() {
  const periodVal=document.getElementById('rptPeriod')?.value||'today';
  const cutStr=periodVal==='today'?todayStr():(()=>{const d=new Date();d.setDate(d.getDate()-(parseInt(periodVal)||30));return d.toISOString().split('T')[0];})();
  const periodLbl=periodVal==='today'?'Today':'Last '+periodVal+' Days';

  if(activeRpt==='npvisits'){ await renderNPVisitsRpt(cutStr,periodLbl); return; }

  const [ordSnp,colSnp,attSnp]=await Promise.all([
    sfGet('orders').then(docs=>({docs})),
    sfGet('collections').then(docs=>({docs})),
    sfGet('attendance').then(docs=>({docs}))
  ]);
  const allOrders=ordSnp.docs.map(d=>({id:d.id,...d.data()}));
  const allCols=colSnp.docs.map(d=>d.data());
  const allAtt=attSnp.docs.map(d=>d.data());
  const myOrders=isAdmin()?allOrders:allOrders.filter(o=>o.createdBy===CU.uid);
  const myCols=isAdmin()?allCols:allCols.filter(c=>c.createdBy===CU.uid);
  const myAtt=allAtt.filter(a=>isAdmin()||a.userId===CU.uid);
  const myOutletIds=isAdmin()?null:allOutlets.filter(o=>o.createdBy===CU.uid||o.assignedRepId===CU.uid).map(o=>o.id);

  if(activeRpt==='sales')renderSalesRpt(myOrders.filter(o=>o.date>=cutStr),periodLbl);
  else if(activeRpt==='collection')renderColRpt(myCols.filter(c=>c.date>=cutStr),periodLbl);
  else if(activeRpt==='attendance')renderAttRpt(myAtt.filter(a=>a.date>=cutStr),periodLbl);
  else if(activeRpt==='outlets'){
    const filtOrders=myOrders.filter(o=>o.date>=cutStr);
    const visibleOutlets=myOutletIds?allOutlets.filter(o=>myOutletIds.includes(o.id)):allOutlets;
    renderOutletRpt(filtOrders,visibleOutlets,cutStr,periodLbl);
  }
}

function renderSalesRpt(orders) {
  const total=orders.filter(o=>o.status!=='Cancelled').reduce((s,o)=>s+o.total,0);
  const delivered=orders.filter(o=>o.status==='Delivered').reduce((s,o)=>s+o.total,0);
  const pending=orders.filter(o=>o.status==='Pending').length;
  const cancelled=orders.filter(o=>o.status==='Cancelled').length;
  const wkData={};
  orders.forEach(o=>{const d=new Date(o.date);const wk='W'+Math.ceil(d.getDate()/7)+' '+d.toLocaleString('default',{month:'short'});if(!wkData[wk])wkData[wk]={l:wk,t:0};if(o.status!=='Cancelled')wkData[wk].t+=o.total;});
  const wks=Object.values(wkData).slice(-6);const maxW=Math.max(...wks.map(x=>x.t),1);
  document.getElementById('rptContent').innerHTML=`
    <div class="sgrid">${statC('💵','Total Sales',fmt(total),'','#22c55e')+statC('✅','Delivered',fmt(delivered),'','#22c55e')+statC('⏳','Pending',pending,'','#f59e0b')+statC('❌','Cancelled',cancelled,'','#ef4444')}</div>
    <div class="card"><div class="card-hdr"><div class="card-ttl">📊 Sales by Week</div></div>
      <div class="bchart" style="height:140px">${wks.map(w=>`<div class="bcol-w"><div class="bcol" data-v="${fmt(w.t)}" style="height:${Math.max(6,(w.t/maxW)*130)}px"></div><div class="blbl">${w.l}</div></div>`).join('')}</div>
    </div>
    <div class="card" style="margin-top:18px"><div class="card-hdr"><div class="card-ttl">📦 Status Breakdown</div></div>
      <div style="display:flex;gap:14px;flex-wrap:wrap;margin-top:6px">
        ${['Delivered','Confirmed','Pending','Cancelled'].map(s=>{const c=orders.filter(o=>o.status===s).length;const p=orders.length?Math.round(c/orders.length*100):0;const cl={Delivered:'var(--grn)',Confirmed:'var(--blu)',Pending:'var(--ylw)',Cancelled:'var(--red)'}[s];return`<div style="flex:1;min-width:100px;background:var(--s2);border-radius:var(--r);padding:13px;text-align:center"><div style="font-family:'Syne',sans-serif;font-size:22px;font-weight:800;color:${cl}">${c}</div><div style="font-size:12px;color:var(--tx2);margin:3px 0">${s}</div><div class="pgbar"><div class="pgfill" style="width:${p}%;background:${cl}"></div></div><div style="font-size:10px;color:var(--tx3);margin-top:3px">${p}%</div></div>`;}).join('')}
      </div>
    </div>`;
}

async function renderNPVisitsRpt(cutStr) {
  document.getElementById('rptContent').innerHTML=`<div style="text-align:center;padding:40px;color:var(--tx3)">⏳ Loading NP Visits...</div>`;
  const {where:wv}=window.__SF;
  const visitDocs=isAdmin()?await sfGet('visits'):await sfGet('visits',[wv('createdBy','==',CU.uid)]);
  const today=todayStr();
  // cutStr defaults to today — shows only today's visits by default
  const effectiveCut = cutStr || today;
  const showingToday = effectiveCut === today;
  const visits=visitDocs.map(d=>({id:d.id,...d.data()}))
    .filter(v=>v.date>=effectiveCut && v.date<=today)
    .sort((a,b)=>(b.date||'').localeCompare(a.date||''));
  const reasons={};
  visits.forEach(v=>{if(v.reason){if(!reasons[v.reason])reasons[v.reason]=0;reasons[v.reason]++;}});
  const topReasons=Object.entries(reasons).sort((a,b)=>b[1]-a[1]);
  const periodTxt=showingToday?'Today':effectiveCut===today?'Today':`${effectiveCut} → ${today}`;
  document.getElementById('rptContent').innerHTML=`
    <div style="display:flex;justify-content:flex-end;margin-bottom:10px;gap:6px">
      <button class="btn btn-${showingToday?'primary':'ghost'} btn-sm" onclick="renderNPVisitsRpt('${today}')">📅 Today</button>
      <button class="btn btn-${!showingToday?'primary':'ghost'} btn-sm" onclick="renderNPVisitsRpt(new Date(Date.now()-29*86400000).toISOString().split('T')[0])">📆 Last 30 Days</button>
    </div>
    <div class="sgrid" style="grid-template-columns:repeat(3,1fr)">
      ${statC('📝','Total Visits',visits.length,periodTxt,'#a855f7')+
        statC('🏪','Unique Outlets',[...new Set(visits.map(v=>v.outletId))].length,'Different outlets','#22c55e')+
        statC('👤','Reps Active',[...new Set(visits.map(v=>v.createdBy))].length,'With NP visits','#3b82f6')}
    </div>
    ${topReasons.length?`<div class="card" style="margin-top:14px"><div class="card-hdr"><div class="card-ttl">📊 By Reason</div></div>
      <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:6px">
        ${topReasons.map(([r,c])=>`<div style="background:var(--s2);border-radius:var(--r2);padding:8px 13px;font-size:12px"><span style="font-weight:700;color:var(--pur)">${c}×</span> ${r}</div>`).join('')}
      </div></div>`:''}
    <div class="card" style="margin-top:14px"><div class="card-hdr"><div class="card-ttl">📋 Visit Log</div><span style="font-size:11px;color:var(--tx3)">${periodTxt}</span></div>
      <div class="twrap"><table><thead><tr><th>Date</th><th>Outlet</th><th>Reason</th><th>Rep</th><th>Notes</th><th>Photo</th>${isStrictAdmin()?'<th>Del</th>':''}</tr></thead>
        <tbody>${visits.map(v=>`<tr>
          <td style="font-size:12px">${v.date||'—'}</td>
          <td style="font-size:12px;font-weight:600">${v.outletName||outletName(v.outletId)}</td>
          <td><span class="bdg bdg-pur" style="font-size:10px">${v.reason||'—'}</span></td>
          <td style="font-size:11px;color:var(--tx2)">${v.createdByName||'—'}</td>
          <td style="font-size:11px;color:var(--tx3);max-width:180px">${v.notes||'—'}</td>
          <td>${v.photo?`<img src="${v.photo}" style="width:40px;height:40px;object-fit:cover;border-radius:6px;cursor:pointer" onclick="viewPhoto('${v.photo}')">`:'—'}</td>
          ${isStrictAdmin()?`<td><button class="btn btn-red btn-xs" onclick="deleteNPVisit('${v.id}','${(v.outletName||'outlet').replace(/'/g,"\\'")}')">🗑</button></td>`:''}`).join('')||`<tr><td colspan="${isStrictAdmin()?7:6}" style="text-align:center;padding:20px;color:var(--tx3)">No visits recorded</td></tr>`}
        </tbody></table></div>
    </div>`;
}
function renderColRpt(cols) {
  const total=cols.reduce((s,c)=>s+c.amount,0);
  const cash=cols.filter(c=>c.mode==='Cash').reduce((s,c)=>s+c.amount,0);
  const digital=cols.filter(c=>c.mode!=='Cash').reduce((s,c)=>s+c.amount,0);
  const byOu={};allOutlets.forEach(o=>{byOu[o.id]={n:o.name,t:0};});
  cols.forEach(c=>{if(byOu[c.outletId])byOu[c.outletId].t+=c.amount;});
  const top=Object.values(byOu).sort((a,b)=>b.t-a.t).filter(o=>o.t>0);
  document.getElementById('rptContent').innerHTML=`
    <div class="sgrid" style="grid-template-columns:repeat(3,1fr)">${statC('💰','Total',fmt(total),'','#22c55e')+statC('💵','Cash',fmt(cash),'','#22c55e')+statC('📱','Digital',fmt(digital),'','#3b82f6')}</div>
    <div class="card"><div class="card-hdr"><div class="card-ttl">🏪 By Outlet</div></div>
      ${top.map(o=>`<div style="margin-bottom:12px"><div style="display:flex;justify-content:space-between;margin-bottom:4px"><span style="font-size:13px;font-weight:600">${o.n}</span><span style="font-family:'Syne',sans-serif;font-weight:700;color:var(--grn)">${fmt(o.t)}</span></div><div class="pgbar"><div class="pgfill" style="width:${top[0].t?Math.round(o.t/top[0].t*100):0}%;background:#22c55e"></div></div></div>`).join('')||'<div style="color:var(--tx3)">No data</div>'}
    </div>`;
}

function renderAttRpt(att) {
  const m=todayStr().slice(0,7);
  const thisM=att.filter(a=>a.month===m);
  const present=thisM.length;
  const totalMins=thisM.filter(a=>a.checkInTime&&a.checkOutTime).reduce((s,a)=>s+calcMins(a.checkInTime,a.checkOutTime),0);
  document.getElementById('rptContent').innerHTML=`
    <div class="sgrid" style="grid-template-columns:repeat(3,1fr)">${statC('✅','Present Days',present,'This month','#22c55e')+statC('⏱','Total Hours',`${Math.floor(totalMins/60)}h`,'','#3b82f6')+statC('📊','Avg/Day',`${Math.floor(totalMins/Math.max(present,1)/60)}h ${Math.floor(totalMins/Math.max(present,1)%60)}m`,'','#22c55e')}</div>
    <div class="card"><div class="card-hdr"><div class="card-ttl">📋 This Month Log</div></div>
      <div class="twrap"><table><thead><tr><th>Date</th><th>Rep</th><th>In</th><th>Out</th><th>Hrs</th></tr></thead>
        <tbody>${thisM.sort((a,b)=>b.date.localeCompare(a.date)).map(r=>`<tr>
          <td style="font-size:12px">${r.date}</td><td style="font-size:12px">${r.userName||'—'}</td>
          <td style="font-size:12px">${r.checkInTime||'—'}</td><td style="font-size:12px">${r.checkOutTime||'—'}</td>
          <td style="font-size:12px">${r.checkInTime&&r.checkOutTime?`${Math.floor(calcMins(r.checkInTime,r.checkOutTime)/60)}h ${calcMins(r.checkInTime,r.checkOutTime)%60}m`:'—'}</td>
        </tr>`).join('')||'<tr><td colspan="5" style="text-align:center;color:var(--tx3);padding:16px">No records</td></tr>'}
        </tbody></table></div>
    </div>`;
}

function renderOutletRpt(orders,visibleOutlets,cutStr,periodLbl) {
  const today=todayStr();
  const lbl=periodLbl||'Today';
  const outlets=visibleOutlets||allOutlets;
  const rpt=outlets.map(o=>({...o,c:orders.filter(x=>x.outletId===o.id).length,s:orders.filter(x=>x.outletId===o.id&&x.status!=='Cancelled').reduce((t,x)=>t+x.total,0)})).sort((a,b)=>b.s-a.s);

  // New outlets added within the selected period
  const newOutlets=outlets.filter(o=>{
    const d=(o.createdAt||'').slice(0,10);
    return d>=(cutStr||today)&&d<=today;
  });

  // Per-rep breakdown of new outlets
  const repMap={};
  newOutlets.forEach(o=>{
    const uid=o.createdBy||'unknown';
    const name=o.createdByName||'Unknown Rep';
    if(!repMap[uid]) repMap[uid]={name,count:0,outlets:[]};
    repMap[uid].count++;
    repMap[uid].outlets.push(o);
  });
  const repRows=Object.values(repMap).sort((a,b)=>b.count-a.count);

  // Scroll targets — IDs for each card
  const scrollTo=id=>`document.getElementById('${id}')?.scrollIntoView({behavior:'smooth',block:'start'})`;

  document.getElementById('rptContent').innerHTML=`
    <div class="sgrid" style="grid-template-columns:repeat(2,1fr)">
      ${statC('🏪','Total Outlets',outlets.length,'All registered',  '#a855f7',scrollTo('orpt-perf'))}
      ${statC('🆕','New ('+lbl+')',newOutlets.length,'Added',         '#3b82f6',scrollTo('orpt-new'))}
      ${statC('📦','Active',rpt.filter(o=>o.c>0).length,'With orders','#22c55e',scrollTo('orpt-perf'))}
      ${statC('💵','Avg Sales',fmt(rpt.reduce((s,o)=>s+o.s,0)/Math.max(rpt.length,1)),'per outlet','#f59e0b',scrollTo('orpt-perf'))}
    </div>

    <!-- New Outlets card with per-rep breakdown -->
    <div class="card" id="orpt-new" style="margin-bottom:14px">
      <div class="card-hdr">
        <div class="card-ttl">🆕 New Outlets — ${lbl}</div>
        <span style="font-size:11px;color:var(--tx3)">${newOutlets.length} outlet${newOutlets.length!==1?'s':''}</span>
      </div>
      ${newOutlets.length===0
        ? `<div style="color:var(--tx3);font-size:12px;padding:8px 0">No new outlets in this period</div>`
        : `<!-- Per-rep summary -->
           <div style="display:flex;flex-direction:column;gap:0">
             ${repRows.map(rep=>`
               <details style="border-bottom:1px solid var(--bdr)">
                 <summary style="display:flex;align-items:center;gap:10px;padding:9px 2px;cursor:pointer;list-style:none;outline:none">
                   <div style="width:30px;height:30px;border-radius:8px;background:var(--s3);display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:800;color:var(--tx2);flex-shrink:0">${rep.name[0]}</div>
                   <div style="flex:1;min-width:0">
                     <div style="font-size:13px;font-weight:700">${rep.name}</div>
                     <div style="font-size:10px;color:var(--tx3)">Added ${rep.count} outlet${rep.count!==1?'s':''}</div>
                   </div>
                   <span style="font-family:'Syne',sans-serif;font-size:16px;font-weight:800;color:var(--blu)">${rep.count}</span>
                 </summary>
                 <div style="padding:4px 0 10px 40px;display:flex;flex-direction:column;gap:5px">
                   ${rep.outlets.map(o=>`
                     <div style="display:flex;align-items:center;gap:8px;cursor:pointer" onclick="viewOutlet('${o.id}')">
                       <div style="width:28px;height:28px;border-radius:7px;overflow:hidden;flex-shrink:0;background:${o.color||'#22c55e'};display:flex;align-items:center;justify-content:center;font-weight:800;color:#fff;font-size:11px">
                         ${o.signboardPhoto?`<img src="${o.signboardPhoto}" style="width:100%;height:100%;object-fit:cover">`:`${o.name[0]}`}
                       </div>
                       <div style="flex:1;min-width:0">
                         <div style="font-size:12px;font-weight:600">${o.name}</div>
                         <div style="font-size:10px;color:var(--tx3)">${o.type}${o.area?' · '+o.area:''}</div>
                       </div>
                       <span style="font-size:10px;color:var(--tx3);flex-shrink:0">${(o.createdAt||'').slice(0,10)}</span>
                     </div>`).join('')}
                 </div>
               </details>`).join('')}
           </div>`}
    </div>

    <!-- Performance table -->
    <div class="card" id="orpt-perf">
      <div class="card-hdr">
        <div class="card-ttl">🏆 Performance</div>
        <span style="font-size:11px;color:var(--tx3)">${lbl}</span>
      </div>
      <div class="twrap"><table><thead><tr><th>Outlet</th><th>Type</th><th>Orders</th><th>Sales</th><th>Rank</th></tr></thead>
        <tbody>${rpt.map((o,i)=>`<tr style="cursor:pointer" onclick="viewOutlet('${o.id}')">
          <td><div style="display:flex;align-items:center;gap:7px">
            <div style="width:26px;height:26px;border-radius:6px;overflow:hidden;flex-shrink:0;background:${o.color||'#22c55e'};display:flex;align-items:center;justify-content:center;font-weight:800;color:#fff;font-size:11px">
              ${o.signboardPhoto?`<img src="${o.signboardPhoto}" style="width:100%;height:100%;object-fit:cover">`:`${o.name[0]}`}
            </div>
            <span style="font-weight:600;font-size:13px">${o.name}</span>
          </div></td>
          <td><span class="bdg bdg-blu">${o.type}</span></td>
          <td>${o.c}</td>
          <td><span style="font-family:'Syne',sans-serif;font-weight:700;color:var(--acc)">${fmt(o.s)}</span></td>
          <td>${['🥇','🥈','🥉'][i]||'#'+(i+1)}</td>
        </tr>`).join('')}
        </tbody></table></div>
    </div>`;
}

