function statC(n,a,r,d,v,e=""){return`<div class="scard" ${e?`onclick="${e}" style="cursor:pointer"`:""} title="${e?"Click to view details":""}">
    <div class="sc-bg" style="background:${v}"></div>
    <div class="sc-ico">${n}</div>
    <div class="sc-lbl">${a}</div>
    <div class="sc-val">${r}</div>
    <div class="sc-chg neu">${d}</div>
  </div>`}function _renderDashboard(n,a,r){if(!CU)return;const d=todayStr(),v=d.slice(0,7),e=n.map(t=>({id:t.id,...t.data()})).filter(t=>isAdmin()||t.createdBy===CU.uid),l=a.map(t=>t.data()).filter(t=>isAdmin()||t.createdBy===CU.uid),p=e.filter(t=>t.status!=="Cancelled").reduce((t,s)=>t+(s.total||0),0),x=e.filter(t=>t.date===d&&t.status!=="Cancelled").reduce((t,s)=>t+(s.total||0),0),g=e.filter(t=>t.status==="Pending").length,h=l.reduce((t,s)=>t+(s.amount||0),0),y=isAdmin()?r:r.filter(t=>t.data().userId===CU.uid),f=y.map(t=>t.data()).find(t=>t.date===d&&t.userId===CU.uid),b=y.filter(t=>t.data().month===v&&(isAdmin()?!0:t.data().userId===CU.uid)).length,m=document.getElementById("dashStats");m&&(m.innerHTML=statC("\u{1F4B5}","Today Sales",fmt(x),"Today's orders","#22c55e","goPage('orders')")+statC("\u{1F4E6}","Total Sales",fmt(p),"Active orders","#3b82f6","goPage('orders')")+statC("\u{1F4B0}","Collected",fmt(h),"All payments","#22c55e","goPage('collection')")+statC("\u23F3","Pending",g,"Awaiting approval","#f59e0b","goPage('orders')"));const o=["Mon","Tue","Wed","Thu","Fri","Sat","Sun"],c=o.map((t,s)=>{const i=new Date;i.setDate(i.getDate()-6+s);const k=i.toISOString().split("T")[0];return e.filter(u=>u.date===k&&u.status!=="Cancelled").reduce((u,M)=>u+(M.total||0),0)}),D=Math.max(...c,1);document.getElementById("wkChart").innerHTML=c.map((t,s)=>`<div class="bcol-w ${s===6?"bactive":""}"><div class="bcol" data-v="${fmt(t)}" style="height:${Math.max(5,t/D*100)}px"></div><div class="blbl">${o[s]}</div></div>`).join("");const C=Math.min(100,Math.round(p/Math.max(MONTHLY_TARGET_DYNAMIC,1)*100)),_=289-C/100*289,$=document.getElementById("ringDash");$&&$.setAttribute("stroke-dashoffset",_);const S=document.getElementById("ringPct");S&&(S.textContent=C+"%");const z=document.getElementById("rTarget");z&&(z.textContent=fmt(MONTHLY_TARGET_DYNAMIC));const T=document.getElementById("rAchieved");T&&(T.textContent=fmt(p));const I=document.getElementById("dashActivity");if(I){const t=f?`<div style="background:rgba(34,197,94,.07);border:1px solid rgba(34,197,94,.2);border-radius:var(--r2);padding:12px;margin-bottom:10px;cursor:pointer" onclick="goPage('attendance')">
        <div style="font-size:12px;font-weight:700;color:var(--grn);margin-bottom:4px">\u2705 Checked In Today</div>
        <div style="font-size:11px;color:var(--tx2)">In: ${f.checkInTime||"\u2014"} \xB7 Out: ${f.checkOutTime||"Still working"}</div>
      </div>`:`<div style="background:rgba(245,158,11,.07);border:1px solid rgba(245,158,11,.2);border-radius:var(--r2);padding:12px;margin-bottom:10px;cursor:pointer" onclick="goPage('attendance')">
        <div style="font-size:12px;font-weight:700;color:var(--ylw);margin-bottom:4px">\u23F0 Not Checked In Yet</div>
        <div style="font-size:11px;color:var(--tx2)">Remember to check in today!</div>
      </div>`,s=e.slice(-4).reverse().map(i=>`
      <div style="display:flex;align-items:center;gap:12px;padding:8px 0;border-bottom:1px solid rgba(30,45,69,.4);cursor:pointer" onclick="goPage('orders')">
        <div style="width:7px;height:7px;border-radius:50%;background:${i.status==="Delivered"?"var(--grn)":i.status==="Confirmed"?"var(--blu)":i.status==="Pending"?"var(--ylw)":"var(--red)"};flex-shrink:0"></div>
        <div style="flex:1;font-size:12px;color:var(--tx2)">${i.id} \xB7 ${outletName(i.outletId)}</div>
        <div style="font-size:11px;font-weight:700;color:var(--acc)">${fmt(i.total||0)}</div>
      </div>`).join("");I.innerHTML=t+(s||'<div style="color:var(--tx3);font-size:12px">No recent orders</div>')}const A=document.getElementById("dashTopOutlets"),w=allOutlets.map(t=>({...t,s:e.filter(s=>s.outletId===t.id&&s.status!=="Cancelled").reduce((s,i)=>s+(i.total||0),0)})).filter(t=>t.s>0).sort((t,s)=>s.s-t.s).slice(0,4);A&&(A.innerHTML=w.map(t=>`<div style="margin-bottom:11px;cursor:pointer" onclick="goPage('outlets')">
    <div style="display:flex;justify-content:space-between;margin-bottom:4px"><span style="font-size:12px;font-weight:600">${t.name}</span><span style="font-family:'Syne',sans-serif;font-size:12px;font-weight:700;color:var(--acc)">${fmt(t.s)}</span></div>
    <div class="pgbar"><div class="pgfill" style="width:${w[0].s?Math.round(t.s/w[0].s*100):0}%"></div></div>
  </div>`).join("")||'<div style="color:var(--tx3);font-size:12px">No outlet sales yet</div>');const P=document.getElementById("pendingApprovalsSection");P&&(P.style.display="none"),_renderOwnerZoneSummary()}async function _renderOwnerZoneSummary(){const n=document.getElementById("ownerZoneSummary");if(n){if(!isOwner()){n.style.display="none";return}if(!allZones.length){n.style.display="none";return}n.style.display="",n.innerHTML=`<div style="font-family:'Syne',sans-serif;font-size:14px;font-weight:700;margin-bottom:12px;color:var(--tx)">\u{1F451} All Zones Overview</div>
    <div style="font-size:12px;color:var(--tx3);margin-bottom:10px">Loading zone data...</div>`;try{const a=await Promise.all(allZones.map(async e=>{const[l,p,x]=await Promise.all([window.__SF.getDocs(zoneColRef(e.id,"orders")),window.__SF.getDocs(zoneColRef(e.id,"collections")),window.__SF.getDocs(zoneColRef(e.id,"outlets"))]),g=l.docs.map(o=>o.data()),h=p.docs.map(o=>o.data()),y=g.filter(o=>o.status!=="Cancelled").reduce((o,c)=>o+(c.total||0),0),f=h.reduce((o,c)=>o+(c.amount||0),0),b=g.filter(o=>o.status==="Pending").length,m=x.docs.length;return{z:e,sales:y,collected:f,pending:b,outlets:m}})),r=a.reduce((e,l)=>e+l.sales,0),d=a.reduce((e,l)=>e+l.collected,0),v=a.reduce((e,l)=>e+l.pending,0);n.innerHTML=`
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;flex-wrap:wrap;gap:8px">
        <div style="font-family:'Syne',sans-serif;font-size:14px;font-weight:700;color:var(--tx)">\u{1F451} All Zones Overview</div>
        <div style="display:flex;gap:10px;flex-wrap:wrap">
          <span style="font-size:11px;color:var(--tx3)">Total Sales: <strong style="color:var(--acc)">${fmt(r)}</strong></span>
          <span style="font-size:11px;color:var(--tx3)">Collected: <strong style="color:var(--grn)">${fmt(d)}</strong></span>
          <span style="font-size:11px;color:var(--tx3)">Pending: <strong style="color:var(--ylw)">${v}</strong></span>
        </div>
      </div>
      <div style="display:flex;flex-direction:column;gap:8px">
        ${a.map(e=>`
          <div style="background:var(--s2);border:1px solid var(--bdr);border-radius:var(--r2);padding:11px 14px;display:flex;align-items:center;gap:12px;flex-wrap:wrap">
            <div style="flex:1;min-width:130px">
              <div style="font-size:13px;font-weight:700">${e.z.name}</div>
              <div style="font-size:10px;color:var(--tx3)">${e.outlets} outlet${e.outlets!==1?"s":""}</div>
            </div>
            <div style="display:flex;gap:14px;flex-wrap:wrap">
              <div style="text-align:center"><div style="font-family:'Syne',sans-serif;font-size:14px;font-weight:800;color:var(--acc)">${fmt(e.sales)}</div><div style="font-size:9px;color:var(--tx3)">Sales</div></div>
              <div style="text-align:center"><div style="font-family:'Syne',sans-serif;font-size:14px;font-weight:800;color:var(--grn)">${fmt(e.collected)}</div><div style="font-size:9px;color:var(--tx3)">Collected</div></div>
              <div style="text-align:center"><div style="font-family:'Syne',sans-serif;font-size:14px;font-weight:800;color:var(--ylw)">${e.pending}</div><div style="font-size:9px;color:var(--tx3)">Pending</div></div>
            </div>
          </div>`).join("")}
      </div>`}catch(a){n.innerHTML=`<div style="font-size:12px;color:var(--red)">\u26A0\uFE0F Failed to load zone summary: ${a.message}</div>`}}}let _dashOrdDocs=null,_dashColDocs=null,_dashAttDocs=null,_dashTs=0;const _DASH_TTL=12e3;function invalidateDashCache(){_dashTs=0}async function renderDashboard(){if(!CU)return;const n=Date.now();(!_dashTs||n-_dashTs>_DASH_TTL)&&([_dashOrdDocs,_dashColDocs,_dashAttDocs]=await Promise.all([sfGet("orders"),sfGet("collections"),sfGet("attendance")]),_dashTs=Date.now()),_renderDashboard(_dashOrdDocs,_dashColDocs,_dashAttDocs)}
