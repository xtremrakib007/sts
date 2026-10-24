const _routeOpen={rep:null,route:null};async function loadRoutes(){await loadCachedData();const t=(document.getElementById("routeSrch")?.value||"").toLowerCase(),n=document.getElementById("routeTree");if(!n)return;let i=allRoutes.filter(e=>isAdmin()?!0:e.repId===CU.uid||allOutlets.some(r=>r.routeId===e.id&&(r.createdBy===CU.uid||r.assignedRepId===CU.uid))).filter(e=>!t||e.name.toLowerCase().includes(t)||(e.description||"").toLowerCase().includes(t));const o={};allOutlets.forEach(e=>{e.routeId&&(o[e.routeId]||(o[e.routeId]=[]),o[e.routeId].push(e))});function l(e){const r=o[e]||[];return r.length?r.map(s=>`<div class="oc-mini" onclick="viewOutlet('${s.id}')">
      <div class="oc-mini-ava" style="background:${s.color||"var(--acc)"}">${s.name[0]}</div>
      <div class="oc-mini-info">
        <div class="oc-mini-name">${s.name}</div>
        <div class="oc-mini-sub">${s.type}${s.area?" \xB7 "+s.area:""}</div>
      </div>
      <div class="oc-mini-btns" onclick="event.stopPropagation()">
        <button class="btn btn-primary btn-xs" onclick="openNewOrder('${s.id}')">\u{1F4E6}</button>
        ${s.phone?`<button class="btn btn-grn btn-xs" onclick="openWhatsApp('${s.id}')">\u{1F4AC}</button>`:""}
      </div>
    </div>`).join(""):'<div style="font-size:12px;color:var(--tx3);padding:4px">No outlets on this route</div>'}if(!isAdmin()){if(!i.length){n.innerHTML=`<div style="text-align:center;padding:40px;color:var(--tx3)"><div style="font-size:40px;margin-bottom:12px">\u{1F5FA}\uFE0F</div><div style="font-size:14px;font-weight:600;margin-bottom:16px">No routes yet</div>${isDeliveryMan()?"":'<button class="btn btn-primary btn-sm" onclick="openNewRoute()">+ Add Route</button>'}</div>`;return}n.innerHTML=i.map(e=>{const r=o[e.id]||[],s=_routeOpen.route===e.id,p=!isDeliveryMan()&&(e.repId===CU.uid||!e.repId);return`<div class="tree-l2" id="rtl2-${e.id}">
        <div class="tree-hdr2 ${s?"open":""}" onclick="toggleRouteNode('${e.id}')">
          <span class="tree-chevron">\u25B6</span><span style="font-size:16px">\u{1F5FA}\uFE0F</span>
          <div style="flex:1">
            <div style="font-size:13px;font-weight:700">${e.name}</div>
            ${e.description?`<div style="font-size:10px;color:var(--tx3)">${e.description}</div>`:""}
            <div style="font-size:10px;color:var(--tx3)">${r.length} outlet${r.length!==1?"s":""}</div>
          </div>
          ${p?`<div onclick="event.stopPropagation();editRoute('${e.id}')" style="cursor:pointer;color:var(--tx3);padding:4px 8px;font-size:13px" title="Edit route">\u270F\uFE0F</div>`:""}
        </div>
        <div class="tree-body2 ${s?"open":""}" id="rtbody2-${e.id}">${l(e.id)}</div>
      </div>`}).join("")+(isDeliveryMan()?"":'<div style="text-align:center;margin-top:12px"><button class="btn btn-primary btn-sm" onclick="openNewRoute()">+ Add Route</button></div>');return}const c=allUsers.filter(e=>e.role==="sales_rep"),u={};i.forEach(e=>{const r=e.repId||"__unassigned__";u[r]||(u[r]=[]),u[r].push(e)});let d=c.filter(e=>u[e.uid]?.length||(t?e.name.toLowerCase().includes(t):!0)).map(e=>{const r=u[e.uid]||[],s=_routeOpen.rep===e.uid,p=r.reduce((a,v)=>(o[v.id]||[]).length+a,0);return`<div class="tree-node" id="rtrep-${e.uid}">
      <div class="tree-hdr ${s?"open":""}" onclick="toggleRouteRep('${e.uid}')">
        <span class="tree-chevron">\u25B6</span>
        <div class="ava ava-sm" style="background:var(--blu);flex-shrink:0">${e.name[0]}</div>
        <div style="flex:1"><div style="font-size:13px;font-weight:700">${e.name}</div>
        <div style="font-size:10px;color:var(--tx3)">${r.length} route${r.length!==1?"s":""} \xB7 ${p} outlet${p!==1?"s":""}</div></div>
        <span style="font-size:11px;color:var(--tx3)">${e.phone||""}</span>
      </div>
      <div class="tree-body ${s?"open":""}" id="rtrepbody-${e.uid}">
        ${r.length?r.map(a=>{const v=o[a.id]||[],m=_routeOpen.route===a.id;return`<div class="tree-l2" id="rtl2-${a.id}">
            <div class="tree-hdr2 ${m?"open":""}" onclick="toggleRouteNode('${a.id}')">
              <span class="tree-chevron">\u25B6</span><span style="font-size:15px">\u{1F5FA}\uFE0F</span>
              <div style="flex:1"><div style="font-size:12px;font-weight:700">${a.name}</div>
              ${a.description?`<div style="font-size:10px;color:var(--tx3)">${a.description}</div>`:""}
              <div style="font-size:10px;color:var(--tx3)">${v.length} outlet${v.length!==1?"s":""}</div></div>
              <div onclick="event.stopPropagation();editRoute('${a.id}')" style="cursor:pointer;color:var(--tx3);padding:4px 6px;font-size:11px">\u270F\uFE0F</div>
              <div onclick="event.stopPropagation();delRoute('${a.id}')" style="cursor:pointer;color:var(--red);padding:4px 6px;font-size:11px">\u{1F5D1}</div>
            </div>
            <div class="tree-body2 ${m?"open":""}" id="rtbody2-${a.id}">${l(a.id)}</div>
          </div>`}).join(""):'<div style="font-size:12px;color:var(--tx3);padding:6px">No routes assigned</div>'}
      </div>
    </div>`}).join("");if(u.__unassigned__?.length){const e=u.__unassigned__,r=_routeOpen.rep==="__unassigned__";d+=`<div class="tree-node" id="rtrep-__unassigned__">
      <div class="tree-hdr ${r?"open":""}" onclick="toggleRouteRep('__unassigned__')">
        <span class="tree-chevron">\u25B6</span><span style="font-size:18px">\u26A0\uFE0F</span>
        <div style="flex:1;font-size:13px;font-weight:700">Unassigned Routes (${e.length})</div>
      </div>
      <div class="tree-body ${r?"open":""}" id="rtrepbody-__unassigned__">
        ${e.map(s=>{const p=o[s.id]||[],a=_routeOpen.route===s.id;return`<div class="tree-l2" id="rtl2-${s.id}">
            <div class="tree-hdr2 ${a?"open":""}" onclick="toggleRouteNode('${s.id}')">
              <span class="tree-chevron">\u25B6</span><span style="font-size:15px">\u{1F5FA}\uFE0F</span>
              <div style="flex:1"><div style="font-size:12px;font-weight:700">${s.name}</div>
              <div style="font-size:10px;color:var(--tx3)">${p.length} outlet${p.length!==1?"s":""}</div></div>
              <div onclick="event.stopPropagation();editRoute('${s.id}')" style="cursor:pointer;color:var(--tx3);padding:4px 6px;font-size:11px">\u270F\uFE0F</div>
            </div>
            <div class="tree-body2 ${a?"open":""}" id="rtbody2-${s.id}">${l(s.id)}</div>
          </div>`}).join("")}
      </div>
    </div>`}isDeliveryMan()||(d+='<div style="text-align:center;margin-top:10px"><button class="btn btn-primary btn-sm" onclick="openNewRoute()">+ Add Route</button></div>'),n.innerHTML=d||'<div style="text-align:center;padding:30px;color:var(--tx3)">No routes found</div>'}function toggleRouteRep(t){const n=_routeOpen.rep===t;if(document.querySelectorAll('[id^="rtrep-"]').forEach(i=>{i.querySelector(".tree-hdr")?.classList.remove("open"),i.querySelector(".tree-body")?.classList.remove("open")}),_routeOpen.route=null,n)_routeOpen.rep=null;else{_routeOpen.rep=t;const i=document.querySelector(`#rtrep-${CSS.escape(t)} .tree-hdr`),o=document.getElementById(`rtrepbody-${t}`);i&&i.classList.add("open"),o&&o.classList.add("open")}}function toggleRouteNode(t){const n=_routeOpen.route===t;if(document.querySelectorAll('[id^="rtl2-"]').forEach(i=>{i.querySelector(".tree-hdr2")?.classList.remove("open"),i.querySelector(".tree-body2")?.classList.remove("open")}),n)_routeOpen.route=null;else{_routeOpen.route=t;const i=document.querySelector(`#rtl2-${CSS.escape(t)} .tree-hdr2`),o=document.getElementById(`rtbody2-${t}`);i&&i.classList.add("open"),o&&o.classList.add("open")}}function viewRouteOutlets(t){const n=allRoutes.find(d=>d.id===t);if(!n)return;const i=allUsers.find(d=>d.uid===n.repId),o=allUsers.find(d=>d.uid===n.delivManId),l=allOutlets.filter(d=>d.routeId===t);document.getElementById("mRDTitle").textContent=`\u{1F5FA}\uFE0F ${n.name}`,document.getElementById("mRDSub").textContent=n.description||"";const c=document.getElementById("mRDEditBtn"),u=isAdmin()||isSalesRep()&&(n.repId===CU.uid||!n.repId);c&&u&&(c.style.display="",c.setAttribute("onclick",`closeM('mRouteDetail');editRoute('${t}')`)),document.getElementById("mRDBody").innerHTML=`
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px">
      <div style="background:var(--s2);border:1px solid var(--bdr);border-radius:var(--r2);padding:12px">
        <div style="font-size:10px;color:var(--tx3);font-weight:600;text-transform:uppercase;letter-spacing:.4px;margin-bottom:5px">Sales Rep</div>
        ${i?`<div style="display:flex;align-items:center;gap:8px">
          <div class="ava ava-sm" style="background:var(--blu)">${i.name[0]}</div>
          <div><div style="font-size:13px;font-weight:700">${i.name}</div><div style="font-size:11px;color:var(--tx3)">${i.phone||i.email}</div></div>
        </div>`:'<span style="color:var(--tx3);font-size:12px">Unassigned</span>'}
      </div>
      <div style="background:var(--s2);border:1px solid var(--bdr);border-radius:var(--r2);padding:12px">
        <div style="font-size:10px;color:var(--tx3);font-weight:600;text-transform:uppercase;letter-spacing:.4px;margin-bottom:5px">Delivery Man</div>
        ${o?`<div style="display:flex;align-items:center;gap:8px">
          <div class="ava ava-sm" style="background:var(--grn)">${o.name[0]}</div>
          <div><div style="font-size:13px;font-weight:700">${o.name}</div><div style="font-size:11px;color:var(--tx3)">${o.phone||o.email}</div></div>
        </div>`:'<span style="color:var(--tx3);font-size:12px">Unassigned</span>'}
      </div>
    </div>
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
      <div style="font-family:'Syne',sans-serif;font-size:13px;font-weight:700">\u{1F3EA} Outlets on this route <span style="color:var(--acc)">(${l.length})</span></div>
    </div>
    ${l.length?`<div style="display:flex;flex-direction:column;gap:8px">
      ${l.map(d=>`<div style="background:var(--s2);border:1px solid var(--bdr);border-radius:var(--r2);padding:11px 13px;display:flex;align-items:center;justify-content:space-between;gap:10px">
        <div style="display:flex;align-items:center;gap:9px;flex:1;min-width:0">
          <div class="ava ava-sm" style="background:${d.color||"var(--acc)"};flex-shrink:0">${d.name[0]}</div>
          <div style="min-width:0">
            <div style="font-size:13px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${d.name}</div>
            <div style="font-size:11px;color:var(--tx3)">${d.type}${d.area?" \xB7 "+d.area:""}</div>
          </div>
        </div>
        <div style="display:flex;gap:5px;flex-shrink:0">
          <button class="btn btn-primary btn-xs" onclick="closeM('mRouteDetail');openNewOrder('${d.id}')">\u{1F4E6}</button>
          ${d.phone?`<button class="btn btn-grn btn-xs" onclick="openWhatsApp('${d.id}')">\u{1F4AC}</button>`:""}
          ${d.lat&&d.lng?`<button class="btn btn-blu btn-xs" onclick="openDirections('${d.id}')">\u{1F5FA}\uFE0F</button>`:""}
        </div>
      </div>`).join("")}
    </div>`:'<div style="text-align:center;padding:30px;color:var(--tx3);font-size:13px">No outlets assigned to this route yet</div>'}
  `,openM("mRouteDetail")}function openNewRoute(){if(isDeliveryMan()){showToast("Access denied","error");return}document.getElementById("mRouteTitle").textContent="\u{1F5FA}\uFE0F Add Route",document.getElementById("rEditId").value="",document.getElementById("rName").value="",document.getElementById("rDesc").value="",_populateRouteUserDropdown("rRep","sales_rep",isAdmin()?"":CU.uid),_populateRouteUserDropdown("rDelivMan","delivery_man","");const t=document.getElementById("rRepRow");t&&(t.style.display=isAdmin()?"":"none"),openM("mRoute")}async function editRoute(t){if(isDeliveryMan()){showToast("Access denied","error");return}const n=allRoutes.find(o=>o.id===t);if(!n)return;if(!isAdmin()&&n.repId!==CU.uid){showToast("You can only edit your own routes","error");return}document.getElementById("mRouteTitle").textContent="\u270F\uFE0F Edit Route",document.getElementById("rEditId").value=t,document.getElementById("rName").value=n.name||"",document.getElementById("rDesc").value=n.description||"",_populateRouteUserDropdown("rRep","sales_rep",n.repId||""),_populateRouteUserDropdown("rDelivMan","delivery_man",n.delivManId||"");const i=document.getElementById("rRepRow");i&&(i.style.display=isAdmin()?"":"none"),openM("mRoute")}function _populateRouteUserDropdown(t,n,i){const o=document.getElementById(t);if(!o)return;const l=allUsers.filter(c=>c.role===n&&c.status!=="disabled");o.innerHTML='<option value="">Unassigned</option>'+l.map(c=>`<option value="${c.uid}" ${c.uid===i?"selected":""}>${c.name}</option>`).join("")}async function saveRoute(){if(isDeliveryMan()){showToast("Access denied","error");return}const t=document.getElementById("rName").value.trim();if(!t){showToast("Route name required","error");return}const n=document.getElementById("rEditId").value,i=isAdmin()?document.getElementById("rRep")?.value||null:CU.uid,o=isAdmin()&&document.getElementById("rDelivMan")?.value||null,l={name:t,description:document.getElementById("rDesc").value.trim(),repId:i,delivManId:o,updatedAt:new Date().toISOString()};try{n?(await sfUpdate("routes",n,l),showToast("Route updated","success")):(l.createdBy=CU.uid,l.createdAt=new Date().toISOString(),await sfAdd("routes",l),showToast(`Route "${t}" created \u{1F5FA}\uFE0F`,"success")),closeM("mRoute"),await loadCachedData(),loadRoutes()}catch(c){showToast("Error saving route: "+c.message,"error")}}async function delRoute(t){if(!isAdmin())return;const n=allRoutes.find(l=>l.id===t),i=allOutlets.filter(l=>l.routeId===t).length;if(i>0){showToast(`Cannot delete \u2014 ${i} outlet(s) are on this route. Reassign them first.`,"error");return}const o=n?n.name:`Route ${t}`;if(isStrictAdmin()){if(!confirm(`Delete route "${o}"? This cannot be undone.`))return;await sfDelete("routes",t),showToast("Route deleted","warn"),await loadCachedData(),loadRoutes()}else await requestDeleteApproval("route",t,o)}
