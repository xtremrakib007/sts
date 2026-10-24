// ═══════════════ ROUTES — ACCORDION TREE ═══════════════
const _routeOpen={rep:null, route:null};

async function loadRoutes() {
  await loadCachedData();
  const srch=(document.getElementById('routeSrch')?.value||'').toLowerCase();
  const tree=document.getElementById('routeTree');
  if(!tree)return;

  let visibleRoutes=allRoutes.filter(r=>{
    if(!isAdmin()){
      return r.repId===CU.uid||allOutlets.some(o=>o.routeId===r.id&&(o.createdBy===CU.uid||o.assignedRepId===CU.uid));
    }
    return true;
  }).filter(r=>!srch||r.name.toLowerCase().includes(srch)||(r.description||'').toLowerCase().includes(srch));

  const routeOutletMap={};
  allOutlets.forEach(o=>{if(o.routeId){if(!routeOutletMap[o.routeId])routeOutletMap[o.routeId]=[];routeOutletMap[o.routeId].push(o);}});

  function routeOutletList(routeId){
    const outs=routeOutletMap[routeId]||[];
    if(!outs.length)return'<div style="font-size:12px;color:var(--tx3);padding:4px">No outlets on this route</div>';
    return outs.map(o=>`<div class="oc-mini" onclick="viewOutlet('${o.id}')">
      <div class="oc-mini-ava" style="background:${o.color||'var(--acc)'}">${o.name[0]}</div>
      <div class="oc-mini-info">
        <div class="oc-mini-name">${o.name}</div>
        <div class="oc-mini-sub">${o.type}${o.area?' · '+o.area:''}</div>
      </div>
      <div class="oc-mini-btns" onclick="event.stopPropagation()">
        <button class="btn btn-primary btn-xs" onclick="openNewOrder('${o.id}')">📦</button>
        ${o.phone?`<button class="btn btn-grn btn-xs" onclick="openWhatsApp('${o.id}')">💬</button>`:''}
      </div>
    </div>`).join('');
  }

  if(!isAdmin()){
    if(!visibleRoutes.length){
      tree.innerHTML=`<div style="text-align:center;padding:40px;color:var(--tx3)"><div style="font-size:40px;margin-bottom:12px">🗺️</div><div style="font-size:14px;font-weight:600;margin-bottom:16px">No routes yet</div>${!isDeliveryMan()?'<button class="btn btn-primary btn-sm" onclick="openNewRoute()">+ Add Route</button>':''}</div>`;return;
    }
    tree.innerHTML=visibleRoutes.map(r=>{
      const outs=routeOutletMap[r.id]||[];
      const isOpen=_routeOpen.route===r.id;
      const canEdit=!isDeliveryMan()&&(r.repId===CU.uid||!r.repId);
      return`<div class="tree-l2" id="rtl2-${r.id}">
        <div class="tree-hdr2 ${isOpen?'open':''}" onclick="toggleRouteNode('${r.id}')">
          <span class="tree-chevron">▶</span><span style="font-size:16px">🗺️</span>
          <div style="flex:1">
            <div style="font-size:13px;font-weight:700">${r.name}</div>
            ${r.description?`<div style="font-size:10px;color:var(--tx3)">${r.description}</div>`:''}
            <div style="font-size:10px;color:var(--tx3)">${outs.length} outlet${outs.length!==1?'s':''}</div>
          </div>
          ${canEdit?`<div onclick="event.stopPropagation();editRoute('${r.id}')" style="cursor:pointer;color:var(--tx3);padding:4px 8px;font-size:13px" title="Edit route">✏️</div>`:''}
        </div>
        <div class="tree-body2 ${isOpen?'open':''}" id="rtbody2-${r.id}">${routeOutletList(r.id)}</div>
      </div>`;
    }).join('')+
    (!isDeliveryMan()?`<div style="text-align:center;margin-top:12px"><button class="btn btn-primary btn-sm" onclick="openNewRoute()">+ Add Route</button></div>`:'');
    return;
  }

  const reps=allUsers.filter(u=>u.role==='sales_rep');
  const routesByRep={};
  visibleRoutes.forEach(r=>{const key=r.repId||'__unassigned__';if(!routesByRep[key])routesByRep[key]=[];routesByRep[key].push(r);});

  let html=reps.filter(rep=>routesByRep[rep.uid]?.length||(srch?rep.name.toLowerCase().includes(srch):true)).map(rep=>{
    const routes=routesByRep[rep.uid]||[];
    const isRepOpen=_routeOpen.rep===rep.uid;
    const totalOutlets=routes.reduce((s,r)=>(routeOutletMap[r.id]||[]).length+s,0);
    return`<div class="tree-node" id="rtrep-${rep.uid}">
      <div class="tree-hdr ${isRepOpen?'open':''}" onclick="toggleRouteRep('${rep.uid}')">
        <span class="tree-chevron">▶</span>
        <div class="ava ava-sm" style="background:var(--blu);flex-shrink:0">${rep.name[0]}</div>
        <div style="flex:1"><div style="font-size:13px;font-weight:700">${rep.name}</div>
        <div style="font-size:10px;color:var(--tx3)">${routes.length} route${routes.length!==1?'s':''} · ${totalOutlets} outlet${totalOutlets!==1?'s':''}</div></div>
        <span style="font-size:11px;color:var(--tx3)">${rep.phone||''}</span>
      </div>
      <div class="tree-body ${isRepOpen?'open':''}" id="rtrepbody-${rep.uid}">
        ${routes.length?routes.map(r=>{
          const outs=routeOutletMap[r.id]||[];
          const isOpen=_routeOpen.route===r.id;
          return`<div class="tree-l2" id="rtl2-${r.id}">
            <div class="tree-hdr2 ${isOpen?'open':''}" onclick="toggleRouteNode('${r.id}')">
              <span class="tree-chevron">▶</span><span style="font-size:15px">🗺️</span>
              <div style="flex:1"><div style="font-size:12px;font-weight:700">${r.name}</div>
              ${r.description?`<div style="font-size:10px;color:var(--tx3)">${r.description}</div>`:''}
              <div style="font-size:10px;color:var(--tx3)">${outs.length} outlet${outs.length!==1?'s':''}</div></div>
              <div onclick="event.stopPropagation();editRoute('${r.id}')" style="cursor:pointer;color:var(--tx3);padding:4px 6px;font-size:11px">✏️</div>
              <div onclick="event.stopPropagation();delRoute('${r.id}')" style="cursor:pointer;color:var(--red);padding:4px 6px;font-size:11px">🗑</div>
            </div>
            <div class="tree-body2 ${isOpen?'open':''}" id="rtbody2-${r.id}">${routeOutletList(r.id)}</div>
          </div>`;
        }).join(''):'<div style="font-size:12px;color:var(--tx3);padding:6px">No routes assigned</div>'}
      </div>
    </div>`;
  }).join('');

  if(routesByRep['__unassigned__']?.length){
    const unasRoutes=routesByRep['__unassigned__'];
    const isOpen=_routeOpen.rep==='__unassigned__';
    html+=`<div class="tree-node" id="rtrep-__unassigned__">
      <div class="tree-hdr ${isOpen?'open':''}" onclick="toggleRouteRep('__unassigned__')">
        <span class="tree-chevron">▶</span><span style="font-size:18px">⚠️</span>
        <div style="flex:1;font-size:13px;font-weight:700">Unassigned Routes (${unasRoutes.length})</div>
      </div>
      <div class="tree-body ${isOpen?'open':''}" id="rtrepbody-__unassigned__">
        ${unasRoutes.map(r=>{
          const outs=routeOutletMap[r.id]||[];
          const isRouteOpen=_routeOpen.route===r.id;
          return`<div class="tree-l2" id="rtl2-${r.id}">
            <div class="tree-hdr2 ${isRouteOpen?'open':''}" onclick="toggleRouteNode('${r.id}')">
              <span class="tree-chevron">▶</span><span style="font-size:15px">🗺️</span>
              <div style="flex:1"><div style="font-size:12px;font-weight:700">${r.name}</div>
              <div style="font-size:10px;color:var(--tx3)">${outs.length} outlet${outs.length!==1?'s':''}</div></div>
              <div onclick="event.stopPropagation();editRoute('${r.id}')" style="cursor:pointer;color:var(--tx3);padding:4px 6px;font-size:11px">✏️</div>
            </div>
            <div class="tree-body2 ${isRouteOpen?'open':''}" id="rtbody2-${r.id}">${routeOutletList(r.id)}</div>
          </div>`;
        }).join('')}
      </div>
    </div>`;
  }

  if(!isDeliveryMan()) html+=`<div style="text-align:center;margin-top:10px"><button class="btn btn-primary btn-sm" onclick="openNewRoute()">+ Add Route</button></div>`;
  tree.innerHTML=html||'<div style="text-align:center;padding:30px;color:var(--tx3)">No routes found</div>';
}

function toggleRouteRep(repUid){
  const wasOpen=_routeOpen.rep===repUid;
  document.querySelectorAll('[id^="rtrep-"]').forEach(n=>{n.querySelector('.tree-hdr')?.classList.remove('open');n.querySelector('.tree-body')?.classList.remove('open');});
  _routeOpen.route=null;
  if(!wasOpen){
    _routeOpen.rep=repUid;
    const hdr=document.querySelector(`#rtrep-${CSS.escape(repUid)} .tree-hdr`);
    const body=document.getElementById(`rtrepbody-${repUid}`);
    if(hdr)hdr.classList.add('open');if(body)body.classList.add('open');
  } else { _routeOpen.rep=null; }
}

function toggleRouteNode(routeId){
  const wasOpen=_routeOpen.route===routeId;
  document.querySelectorAll('[id^="rtl2-"]').forEach(n=>{n.querySelector('.tree-hdr2')?.classList.remove('open');n.querySelector('.tree-body2')?.classList.remove('open');});
  if(!wasOpen){
    _routeOpen.route=routeId;
    const hdr=document.querySelector(`#rtl2-${CSS.escape(routeId)} .tree-hdr2`);
    const body=document.getElementById(`rtbody2-${routeId}`);
    if(hdr)hdr.classList.add('open');if(body)body.classList.add('open');
  } else { _routeOpen.route=null; }
}

function viewRouteOutlets(routeId) {
  const r=allRoutes.find(x=>x.id===routeId);if(!r)return;
  const assignedRep=allUsers.find(u=>u.uid===r.repId);
  const assignedDeliv=allUsers.find(u=>u.uid===r.delivManId);
  const outlets=allOutlets.filter(o=>o.routeId===routeId);

  document.getElementById('mRDTitle').textContent=`🗺️ ${r.name}`;
  document.getElementById('mRDSub').textContent=r.description||'';
  const editBtn=document.getElementById('mRDEditBtn');
  const canEditRoute=isAdmin()||(isSalesRep()&&(r.repId===CU.uid||!r.repId));
  if(editBtn&&canEditRoute){editBtn.style.display='';editBtn.setAttribute('onclick',`closeM('mRouteDetail');editRoute('${routeId}')`);}

  document.getElementById('mRDBody').innerHTML=`
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px">
      <div style="background:var(--s2);border:1px solid var(--bdr);border-radius:var(--r2);padding:12px">
        <div style="font-size:10px;color:var(--tx3);font-weight:600;text-transform:uppercase;letter-spacing:.4px;margin-bottom:5px">Sales Rep</div>
        ${assignedRep?`<div style="display:flex;align-items:center;gap:8px">
          <div class="ava ava-sm" style="background:var(--blu)">${assignedRep.name[0]}</div>
          <div><div style="font-size:13px;font-weight:700">${assignedRep.name}</div><div style="font-size:11px;color:var(--tx3)">${assignedRep.phone||assignedRep.email}</div></div>
        </div>`:`<span style="color:var(--tx3);font-size:12px">Unassigned</span>`}
      </div>
      <div style="background:var(--s2);border:1px solid var(--bdr);border-radius:var(--r2);padding:12px">
        <div style="font-size:10px;color:var(--tx3);font-weight:600;text-transform:uppercase;letter-spacing:.4px;margin-bottom:5px">Delivery Man</div>
        ${assignedDeliv?`<div style="display:flex;align-items:center;gap:8px">
          <div class="ava ava-sm" style="background:var(--grn)">${assignedDeliv.name[0]}</div>
          <div><div style="font-size:13px;font-weight:700">${assignedDeliv.name}</div><div style="font-size:11px;color:var(--tx3)">${assignedDeliv.phone||assignedDeliv.email}</div></div>
        </div>`:`<span style="color:var(--tx3);font-size:12px">Unassigned</span>`}
      </div>
    </div>
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
      <div style="font-family:'Syne',sans-serif;font-size:13px;font-weight:700">🏪 Outlets on this route <span style="color:var(--acc)">(${outlets.length})</span></div>
    </div>
    ${outlets.length?`<div style="display:flex;flex-direction:column;gap:8px">
      ${outlets.map(o=>`<div style="background:var(--s2);border:1px solid var(--bdr);border-radius:var(--r2);padding:11px 13px;display:flex;align-items:center;justify-content:space-between;gap:10px">
        <div style="display:flex;align-items:center;gap:9px;flex:1;min-width:0">
          <div class="ava ava-sm" style="background:${o.color||'var(--acc)'};flex-shrink:0">${o.name[0]}</div>
          <div style="min-width:0">
            <div style="font-size:13px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${o.name}</div>
            <div style="font-size:11px;color:var(--tx3)">${o.type}${o.area?' · '+o.area:''}</div>
          </div>
        </div>
        <div style="display:flex;gap:5px;flex-shrink:0">
          <button class="btn btn-primary btn-xs" onclick="closeM('mRouteDetail');openNewOrder('${o.id}')">📦</button>
          ${o.phone?`<button class="btn btn-grn btn-xs" onclick="openWhatsApp('${o.id}')">💬</button>`:''}
          ${o.lat&&o.lng?`<button class="btn btn-blu btn-xs" onclick="openDirections('${o.id}')">🗺️</button>`:''}
        </div>
      </div>`).join('')}
    </div>`:`<div style="text-align:center;padding:30px;color:var(--tx3);font-size:13px">No outlets assigned to this route yet</div>`}
  `;
  openM('mRouteDetail');
}

function openNewRoute() {
  if(isDeliveryMan()){showToast('Access denied','error');return;}
  document.getElementById('mRouteTitle').textContent='🗺️ Add Route';
  document.getElementById('rEditId').value='';
  document.getElementById('rName').value='';
  document.getElementById('rDesc').value='';
  _populateRouteUserDropdown('rRep','sales_rep', isAdmin()?'':(CU.uid));
  _populateRouteUserDropdown('rDelivMan','delivery_man','');
  // Hide rep/delivery dropdowns for sales rep (auto-assigned to themselves)
  const rRepRow=document.getElementById('rRepRow');
  if(rRepRow)rRepRow.style.display=isAdmin()?'':'none';
  openM('mRoute');
}

async function editRoute(id) {
  if(isDeliveryMan()){showToast('Access denied','error');return;}
  const r=allRoutes.find(x=>x.id===id);if(!r)return;
  // Sales rep can only edit their own routes
  if(!isAdmin()&&r.repId!==CU.uid){showToast('You can only edit your own routes','error');return;}
  document.getElementById('mRouteTitle').textContent='✏️ Edit Route';
  document.getElementById('rEditId').value=id;
  document.getElementById('rName').value=r.name||'';
  document.getElementById('rDesc').value=r.description||'';
  _populateRouteUserDropdown('rRep','sales_rep',r.repId||'');
  _populateRouteUserDropdown('rDelivMan','delivery_man',r.delivManId||'');
  const rRepRow=document.getElementById('rRepRow');
  if(rRepRow)rRepRow.style.display=isAdmin()?'':'none';
  openM('mRoute');
}

function _populateRouteUserDropdown(selectId, role, selectedUid) {
  const el=document.getElementById(selectId);if(!el)return;
  const users=allUsers.filter(u=>u.role===role&&u.status!=='disabled');
  el.innerHTML='<option value="">Unassigned</option>'+
    users.map(u=>`<option value="${u.uid}" ${u.uid===selectedUid?'selected':''}>${u.name}</option>`).join('');
}

async function saveRoute() {
  if(isDeliveryMan()){showToast('Access denied','error');return;}
  const name=document.getElementById('rName').value.trim();
  if(!name){showToast('Route name required','error');return;}
  const editId=document.getElementById('rEditId').value;
  // Sales rep: auto-assign to themselves; admin: use dropdown
  const repIdVal=isAdmin()?(document.getElementById('rRep')?.value||null):CU.uid;
  const delivManIdVal=isAdmin()?(document.getElementById('rDelivMan')?.value||null):null;
  const data={
    name,
    description:document.getElementById('rDesc').value.trim(),
    repId:repIdVal,
    delivManId:delivManIdVal,
    updatedAt:new Date().toISOString(),
  };
  try{
    if(editId){
      await sfUpdate('routes',editId,data);
      showToast('Route updated','success');
    } else {
      data.createdBy=CU.uid;data.createdAt=new Date().toISOString();
      await sfAdd('routes',data);
      showToast(`Route "${name}" created 🗺️`,'success');
    }
    closeM('mRoute');
    await loadCachedData();
    loadRoutes();
  }catch(e){showToast('Error saving route: '+e.message,'error');}
}

async function delRoute(id) {
  if(!isAdmin())return;
  const r=allRoutes.find(x=>x.id===id);
  const outletCount=allOutlets.filter(o=>o.routeId===id).length;
  if(outletCount>0){showToast(`Cannot delete — ${outletCount} outlet(s) are on this route. Reassign them first.`,'error');return;}
  const label=r?r.name:`Route ${id}`;
  if(isStrictAdmin()){
    if(!confirm(`Delete route "${label}"? This cannot be undone.`))return;
    await sfDelete('routes',id);
    showToast('Route deleted','warn');
    await loadCachedData();loadRoutes();
  } else {
    await requestDeleteApproval('route',id,label);
  }
}

