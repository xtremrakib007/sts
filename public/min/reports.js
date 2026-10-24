let activeRpt="sales";function switchRpt(n,p){activeRpt=n,document.querySelectorAll(".rtab").forEach(c=>c.classList.remove("active")),p.classList.add("active"),renderReports()}async function renderReports(){const n=document.getElementById("rptPeriod")?.value||"today",p=n==="today"?todayStr():(()=>{const t=new Date;return t.setDate(t.getDate()-(parseInt(n)||30)),t.toISOString().split("T")[0]})(),c=n==="today"?"Today":"Last "+n+" Days";if(activeRpt==="npvisits"){await renderNPVisitsRpt(p,c);return}const[f,r,a]=await Promise.all([sfGet("orders").then(t=>({docs:t})),sfGet("collections").then(t=>({docs:t})),sfGet("attendance").then(t=>({docs:t}))]),e=f.docs.map(t=>({id:t.id,...t.data()})),l=r.docs.map(t=>t.data()),d=a.docs.map(t=>t.data()),o=isAdmin()?e:e.filter(t=>t.createdBy===CU.uid),s=isAdmin()?l:l.filter(t=>t.createdBy===CU.uid),v=d.filter(t=>isAdmin()||t.userId===CU.uid),i=isAdmin()?null:allOutlets.filter(t=>t.createdBy===CU.uid||t.assignedRepId===CU.uid).map(t=>t.id);if(activeRpt==="sales")renderSalesRpt(o.filter(t=>t.date>=p),c);else if(activeRpt==="collection")renderColRpt(s.filter(t=>t.date>=p),c);else if(activeRpt==="attendance")renderAttRpt(v.filter(t=>t.date>=p),c);else if(activeRpt==="outlets"){const t=o.filter(m=>m.date>=p),h=i?allOutlets.filter(m=>i.includes(m.id)):allOutlets;renderOutletRpt(t,h,p,c)}}function renderSalesRpt(n){const p=n.filter(d=>d.status!=="Cancelled").reduce((d,o)=>d+o.total,0),c=n.filter(d=>d.status==="Delivered").reduce((d,o)=>d+o.total,0),f=n.filter(d=>d.status==="Pending").length,r=n.filter(d=>d.status==="Cancelled").length,a={};n.forEach(d=>{const o=new Date(d.date),s="W"+Math.ceil(o.getDate()/7)+" "+o.toLocaleString("default",{month:"short"});a[s]||(a[s]={l:s,t:0}),d.status!=="Cancelled"&&(a[s].t+=d.total)});const e=Object.values(a).slice(-6),l=Math.max(...e.map(d=>d.t),1);document.getElementById("rptContent").innerHTML=`
    <div class="sgrid">${statC("\u{1F4B5}","Total Sales",fmt(p),"","#22c55e")+statC("\u2705","Delivered",fmt(c),"","#22c55e")+statC("\u23F3","Pending",f,"","#f59e0b")+statC("\u274C","Cancelled",r,"","#ef4444")}</div>
    <div class="card"><div class="card-hdr"><div class="card-ttl">\u{1F4CA} Sales by Week</div></div>
      <div class="bchart" style="height:140px">${e.map(d=>`<div class="bcol-w"><div class="bcol" data-v="${fmt(d.t)}" style="height:${Math.max(6,d.t/l*130)}px"></div><div class="blbl">${d.l}</div></div>`).join("")}</div>
    </div>
    <div class="card" style="margin-top:18px"><div class="card-hdr"><div class="card-ttl">\u{1F4E6} Status Breakdown</div></div>
      <div style="display:flex;gap:14px;flex-wrap:wrap;margin-top:6px">
        ${["Delivered","Confirmed","Pending","Cancelled"].map(d=>{const o=n.filter(i=>i.status===d).length,s=n.length?Math.round(o/n.length*100):0,v={Delivered:"var(--grn)",Confirmed:"var(--blu)",Pending:"var(--ylw)",Cancelled:"var(--red)"}[d];return`<div style="flex:1;min-width:100px;background:var(--s2);border-radius:var(--r);padding:13px;text-align:center"><div style="font-family:'Syne',sans-serif;font-size:22px;font-weight:800;color:${v}">${o}</div><div style="font-size:12px;color:var(--tx2);margin:3px 0">${d}</div><div class="pgbar"><div class="pgfill" style="width:${s}%;background:${v}"></div></div><div style="font-size:10px;color:var(--tx3);margin-top:3px">${s}%</div></div>`}).join("")}
      </div>
    </div>`}async function renderNPVisitsRpt(n){document.getElementById("rptContent").innerHTML='<div style="text-align:center;padding:40px;color:var(--tx3)">\u23F3 Loading NP Visits...</div>';const{where:p}=window.__SF,c=isAdmin()?await sfGet("visits"):await sfGet("visits",[p("createdBy","==",CU.uid)]),f=todayStr(),r=n||f,a=r===f,e=c.map(s=>({id:s.id,...s.data()})).filter(s=>s.date>=r&&s.date<=f).sort((s,v)=>(v.date||"").localeCompare(s.date||"")),l={};e.forEach(s=>{s.reason&&(l[s.reason]||(l[s.reason]=0),l[s.reason]++)});const d=Object.entries(l).sort((s,v)=>v[1]-s[1]),o=a||r===f?"Today":`${r} \u2192 ${f}`;document.getElementById("rptContent").innerHTML=`
    <div style="display:flex;justify-content:flex-end;margin-bottom:10px;gap:6px">
      <button class="btn btn-${a?"primary":"ghost"} btn-sm" onclick="renderNPVisitsRpt('${f}')">\u{1F4C5} Today</button>
      <button class="btn btn-${a?"ghost":"primary"} btn-sm" onclick="renderNPVisitsRpt(new Date(Date.now()-29*86400000).toISOString().split('T')[0])">\u{1F4C6} Last 30 Days</button>
    </div>
    <div class="sgrid" style="grid-template-columns:repeat(3,1fr)">
      ${statC("\u{1F4DD}","Total Visits",e.length,o,"#a855f7")+statC("\u{1F3EA}","Unique Outlets",[...new Set(e.map(s=>s.outletId))].length,"Different outlets","#22c55e")+statC("\u{1F464}","Reps Active",[...new Set(e.map(s=>s.createdBy))].length,"With NP visits","#3b82f6")}
    </div>
    ${d.length?`<div class="card" style="margin-top:14px"><div class="card-hdr"><div class="card-ttl">\u{1F4CA} By Reason</div></div>
      <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:6px">
        ${d.map(([s,v])=>`<div style="background:var(--s2);border-radius:var(--r2);padding:8px 13px;font-size:12px"><span style="font-weight:700;color:var(--pur)">${v}\xD7</span> ${s}</div>`).join("")}
      </div></div>`:""}
    <div class="card" style="margin-top:14px"><div class="card-hdr"><div class="card-ttl">\u{1F4CB} Visit Log</div><span style="font-size:11px;color:var(--tx3)">${o}</span></div>
      <div class="twrap"><table><thead><tr><th>Date</th><th>Outlet</th><th>Reason</th><th>Rep</th><th>Notes</th><th>Photo</th>${isStrictAdmin()?"<th>Del</th>":""}</tr></thead>
        <tbody>${e.map(s=>`<tr>
          <td style="font-size:12px">${s.date||"\u2014"}</td>
          <td style="font-size:12px;font-weight:600">${s.outletName||outletName(s.outletId)}</td>
          <td><span class="bdg bdg-pur" style="font-size:10px">${s.reason||"\u2014"}</span></td>
          <td style="font-size:11px;color:var(--tx2)">${s.createdByName||"\u2014"}</td>
          <td style="font-size:11px;color:var(--tx3);max-width:180px">${s.notes||"\u2014"}</td>
          <td>${s.photo?`<img src="${s.photo}" style="width:40px;height:40px;object-fit:cover;border-radius:6px;cursor:pointer" onclick="viewPhoto('${s.photo}')">`:"\u2014"}</td>
          ${isStrictAdmin()?`<td><button class="btn btn-red btn-xs" onclick="deleteNPVisit('${s.id}','${(s.outletName||"outlet").replace(/'/g,"\\'")}')">\u{1F5D1}</button></td>`:""}`).join("")||`<tr><td colspan="${isStrictAdmin()?7:6}" style="text-align:center;padding:20px;color:var(--tx3)">No visits recorded</td></tr>`}
        </tbody></table></div>
    </div>`}function renderColRpt(n){const p=n.reduce((e,l)=>e+l.amount,0),c=n.filter(e=>e.mode==="Cash").reduce((e,l)=>e+l.amount,0),f=n.filter(e=>e.mode!=="Cash").reduce((e,l)=>e+l.amount,0),r={};allOutlets.forEach(e=>{r[e.id]={n:e.name,t:0}}),n.forEach(e=>{r[e.outletId]&&(r[e.outletId].t+=e.amount)});const a=Object.values(r).sort((e,l)=>l.t-e.t).filter(e=>e.t>0);document.getElementById("rptContent").innerHTML=`
    <div class="sgrid" style="grid-template-columns:repeat(3,1fr)">${statC("\u{1F4B0}","Total",fmt(p),"","#22c55e")+statC("\u{1F4B5}","Cash",fmt(c),"","#22c55e")+statC("\u{1F4F1}","Digital",fmt(f),"","#3b82f6")}</div>
    <div class="card"><div class="card-hdr"><div class="card-ttl">\u{1F3EA} By Outlet</div></div>
      ${a.map(e=>`<div style="margin-bottom:12px"><div style="display:flex;justify-content:space-between;margin-bottom:4px"><span style="font-size:13px;font-weight:600">${e.n}</span><span style="font-family:'Syne',sans-serif;font-weight:700;color:var(--grn)">${fmt(e.t)}</span></div><div class="pgbar"><div class="pgfill" style="width:${a[0].t?Math.round(e.t/a[0].t*100):0}%;background:#22c55e"></div></div></div>`).join("")||'<div style="color:var(--tx3)">No data</div>'}
    </div>`}function renderAttRpt(n){const p=todayStr().slice(0,7),c=n.filter(a=>a.month===p),f=c.length,r=c.filter(a=>a.checkInTime&&a.checkOutTime).reduce((a,e)=>a+calcMins(e.checkInTime,e.checkOutTime),0);document.getElementById("rptContent").innerHTML=`
    <div class="sgrid" style="grid-template-columns:repeat(3,1fr)">${statC("\u2705","Present Days",f,"This month","#22c55e")+statC("\u23F1","Total Hours",`${Math.floor(r/60)}h`,"","#3b82f6")+statC("\u{1F4CA}","Avg/Day",`${Math.floor(r/Math.max(f,1)/60)}h ${Math.floor(r/Math.max(f,1)%60)}m`,"","#22c55e")}</div>
    <div class="card"><div class="card-hdr"><div class="card-ttl">\u{1F4CB} This Month Log</div></div>
      <div class="twrap"><table><thead><tr><th>Date</th><th>Rep</th><th>In</th><th>Out</th><th>Hrs</th></tr></thead>
        <tbody>${c.sort((a,e)=>e.date.localeCompare(a.date)).map(a=>`<tr>
          <td style="font-size:12px">${a.date}</td><td style="font-size:12px">${a.userName||"\u2014"}</td>
          <td style="font-size:12px">${a.checkInTime||"\u2014"}</td><td style="font-size:12px">${a.checkOutTime||"\u2014"}</td>
          <td style="font-size:12px">${a.checkInTime&&a.checkOutTime?`${Math.floor(calcMins(a.checkInTime,a.checkOutTime)/60)}h ${calcMins(a.checkInTime,a.checkOutTime)%60}m`:"\u2014"}</td>
        </tr>`).join("")||'<tr><td colspan="5" style="text-align:center;color:var(--tx3);padding:16px">No records</td></tr>'}
        </tbody></table></div>
    </div>`}function renderOutletRpt(n,p,c,f){const r=todayStr(),a=f||"Today",e=p||allOutlets,l=e.map(i=>({...i,c:n.filter(t=>t.outletId===i.id).length,s:n.filter(t=>t.outletId===i.id&&t.status!=="Cancelled").reduce((t,h)=>t+h.total,0)})).sort((i,t)=>t.s-i.s),d=e.filter(i=>{const t=(i.createdAt||"").slice(0,10);return t>=(c||r)&&t<=r}),o={};d.forEach(i=>{const t=i.createdBy||"unknown",h=i.createdByName||"Unknown Rep";o[t]||(o[t]={name:h,count:0,outlets:[]}),o[t].count++,o[t].outlets.push(i)});const s=Object.values(o).sort((i,t)=>t.count-i.count),v=i=>`document.getElementById('${i}')?.scrollIntoView({behavior:'smooth',block:'start'})`;document.getElementById("rptContent").innerHTML=`
    <div class="sgrid" style="grid-template-columns:repeat(2,1fr)">
      ${statC("\u{1F3EA}","Total Outlets",e.length,"All registered","#a855f7",v("orpt-perf"))}
      ${statC("\u{1F195}","New ("+a+")",d.length,"Added","#3b82f6",v("orpt-new"))}
      ${statC("\u{1F4E6}","Active",l.filter(i=>i.c>0).length,"With orders","#22c55e",v("orpt-perf"))}
      ${statC("\u{1F4B5}","Avg Sales",fmt(l.reduce((i,t)=>i+t.s,0)/Math.max(l.length,1)),"per outlet","#f59e0b",v("orpt-perf"))}
    </div>

    <!-- New Outlets card with per-rep breakdown -->
    <div class="card" id="orpt-new" style="margin-bottom:14px">
      <div class="card-hdr">
        <div class="card-ttl">\u{1F195} New Outlets \u2014 ${a}</div>
        <span style="font-size:11px;color:var(--tx3)">${d.length} outlet${d.length!==1?"s":""}</span>
      </div>
      ${d.length===0?'<div style="color:var(--tx3);font-size:12px;padding:8px 0">No new outlets in this period</div>':`<!-- Per-rep summary -->
           <div style="display:flex;flex-direction:column;gap:0">
             ${s.map(i=>`
               <details style="border-bottom:1px solid var(--bdr)">
                 <summary style="display:flex;align-items:center;gap:10px;padding:9px 2px;cursor:pointer;list-style:none;outline:none">
                   <div style="width:30px;height:30px;border-radius:8px;background:var(--s3);display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:800;color:var(--tx2);flex-shrink:0">${i.name[0]}</div>
                   <div style="flex:1;min-width:0">
                     <div style="font-size:13px;font-weight:700">${i.name}</div>
                     <div style="font-size:10px;color:var(--tx3)">Added ${i.count} outlet${i.count!==1?"s":""}</div>
                   </div>
                   <span style="font-family:'Syne',sans-serif;font-size:16px;font-weight:800;color:var(--blu)">${i.count}</span>
                 </summary>
                 <div style="padding:4px 0 10px 40px;display:flex;flex-direction:column;gap:5px">
                   ${i.outlets.map(t=>`
                     <div style="display:flex;align-items:center;gap:8px;cursor:pointer" onclick="viewOutlet('${t.id}')">
                       <div style="width:28px;height:28px;border-radius:7px;overflow:hidden;flex-shrink:0;background:${t.color||"#22c55e"};display:flex;align-items:center;justify-content:center;font-weight:800;color:#fff;font-size:11px">
                         ${t.signboardPhoto?`<img src="${t.signboardPhoto}" style="width:100%;height:100%;object-fit:cover">`:`${t.name[0]}`}
                       </div>
                       <div style="flex:1;min-width:0">
                         <div style="font-size:12px;font-weight:600">${t.name}</div>
                         <div style="font-size:10px;color:var(--tx3)">${t.type}${t.area?" \xB7 "+t.area:""}</div>
                       </div>
                       <span style="font-size:10px;color:var(--tx3);flex-shrink:0">${(t.createdAt||"").slice(0,10)}</span>
                     </div>`).join("")}
                 </div>
               </details>`).join("")}
           </div>`}
    </div>

    <!-- Performance table -->
    <div class="card" id="orpt-perf">
      <div class="card-hdr">
        <div class="card-ttl">\u{1F3C6} Performance</div>
        <span style="font-size:11px;color:var(--tx3)">${a}</span>
      </div>
      <div class="twrap"><table><thead><tr><th>Outlet</th><th>Type</th><th>Orders</th><th>Sales</th><th>Rank</th></tr></thead>
        <tbody>${l.map((i,t)=>`<tr style="cursor:pointer" onclick="viewOutlet('${i.id}')">
          <td><div style="display:flex;align-items:center;gap:7px">
            <div style="width:26px;height:26px;border-radius:6px;overflow:hidden;flex-shrink:0;background:${i.color||"#22c55e"};display:flex;align-items:center;justify-content:center;font-weight:800;color:#fff;font-size:11px">
              ${i.signboardPhoto?`<img src="${i.signboardPhoto}" style="width:100%;height:100%;object-fit:cover">`:`${i.name[0]}`}
            </div>
            <span style="font-weight:600;font-size:13px">${i.name}</span>
          </div></td>
          <td><span class="bdg bdg-blu">${i.type}</span></td>
          <td>${i.c}</td>
          <td><span style="font-family:'Syne',sans-serif;font-weight:700;color:var(--acc)">${fmt(i.s)}</span></td>
          <td>${["\u{1F947}","\u{1F948}","\u{1F949}"][t]||"#"+(t+1)}</td>
        </tr>`).join("")}
        </tbody></table></div>
    </div>`}
