// ═══════════════ OUTLETS — ACCORDION TREE ═══════════════
// State: which rep-node and route-node are open
const _outletOpen={rep:null, route:null};

// Outlets view: 'near' (all roles, nearest first) or 'group' (by rep/route).
let _outletView=(()=>{try{return localStorage.getItem('stsb-outlet-view')||'near';}catch(e){return 'near';}})();
let _outletNearLimit=60, _outletLocAt=0, _outletLocBusy=false, _outletLocErr=false;

function setOutletView(v){
  _outletView=v; _outletNearLimit=60;
  try{localStorage.setItem('stsb-outlet-view',v);}catch(e){}
  loadOutlets();
}

// Current position for the Nearby list (any role, also admins), at most
// every 2 minutes unless asked; redraws the page when it arrives.
function _outletLocate(force){
  if(_outletLocBusy)return;
  if(!force&&_userLat&&_userLng&&Date.now()-_outletLocAt<120000)return;
  _outletLocBusy=true;
  _getPositionNative().then(pos=>{
    _userLat=pos.coords.latitude; _userLng=pos.coords.longitude; _gpsGranted=true;
    _outletLocAt=Date.now(); _outletLocErr=false;
  }).catch(()=>{ _outletLocErr=!_userLat; }).finally(()=>{
    _outletLocBusy=false;
    if(document.getElementById('pageOutlets')?.classList.contains('active'))loadOutlets();
  });
}
function outletRelocate(){ _outletLocErr=false; _outletLocate(true); loadOutlets(); }

async function loadOutlets() {
  await loadCachedData();
  const addBtn=document.getElementById('addOutletBtn');
  if(addBtn)addBtn.style.display=isDeliveryMan()?'none':'';
  const srch=(document.getElementById('outSrch')?.value||'').toLowerCase();

  // Pending balances (admin)
  if(isAdmin()){
    const pending=allOutlets.filter(o=>o.balanceStatus==='pending'&&o.openingBalance>0);
    document.getElementById('pendingBalancesSection').style.display=pending.length?'':'none';
    document.getElementById('pendingBalancesList').innerHTML=pending.map(o=>`
      <div class="apv-card">
        <div class="apv-info">
          <div class="apv-title">${o.name} <span class="bdg bdg-ylw" style="margin-left:6px">Pending Balance</span></div>
          <div class="apv-sub">Opening Balance: ${fmt(o.openingBalance)} · Type: ${o.type} · Area: ${o.area||'—'}</div>
        </div>
        <div class="apv-actions">
          <button class="btn btn-grn btn-xs" onclick="approveBalance('${o.id}')">✓ Approve</button>
          <button class="btn btn-red btn-xs" onclick="rejectBalance('${o.id}')">✕ Reject</button>
        </div>
      </div>`).join('');
    const outletApvBadge=document.getElementById('outletApvBadge');
    if(outletApvBadge){outletApvBadge.textContent=pending.length;outletApvBadge.style.display=pending.length?'':'none';}
  }

  // Load order/collection stats lazily
  const [ordDocs2,colDocs2]=await Promise.all([sfGet('orders'),sfGet('collections')]);
  const orders=ordDocs2.map(d=>d.data());
  const cols=colDocs2.map(d=>d.data());

  const tree=document.getElementById('outletTree');
  if(!tree)return;

  // ★ Distance-sort outlets if GPS available
  function distKm(o){
    if(!_gpsGranted||!_userLat||!_userLng||!o.lat||!o.lng)return Infinity;
    return haversineKm(_userLat,_userLng,Number(o.lat),Number(o.lng));
  }
  function fmtDist(km){
    if(km===Infinity)return '';
    if(km<1)return `${Math.round(km*1000)}m`;
    return `${km.toFixed(1)}km`;
  }

  // Outlet card: signboard photo, name, area, due and distance, with the
  // four field actions (Order, Direction, WhatsApp, NP Visit) and a ⋮ menu.
  function buildOutletCard(o,i){
    const oOrders=orders.filter(x=>x.outletId===o.id&&x.status!=='Cancelled').reduce((s,x)=>s+(Number(x.total)||0),0);
    const oCol=cols.filter(x=>x.outletId===o.id).reduce((s,x)=>s+(Number(x.amount)||0),0);
    const due=Math.max(0,oOrders-oCol+(o.balanceStatus==='approved'?Number(o.openingBalance)||0:0));
    const km=distKm(o);
    const sign=o.signboardPhoto||'';
    const cover=o.coverPhoto||o.interiorPhoto||sign;
    const rep=allUsers.find(u=>u.uid===(o.assignedRepId||o.createdBy));
    const thumbSrc=sign||cover;
    const thumb=thumbSrc?`<img src="${escH(thumbSrc)}" alt="" loading="lazy">`:`<span>${escH((o.name||'?')[0].toUpperCase())}</span>`;
    const info=(ico,cls,label,val,valCls='')=>`<div class="olx-info"><div class="olx-ico ${cls}">${ico}</div><div class="olx-iv"><div class="olx-lbl">${label}</div><div class="olx-val ${valCls}">${val}</div></div></div>`;
    return`<div class="ol-card olx" onclick="viewOutlet('${o.id}')">
      <div class="olx-cover${cover?' has':''}" ${cover?`onclick="event.stopPropagation();openOutletPhoto('${o.id}','cover')" role="button" aria-label="View cover photo"`:''}>
        ${cover?`<img src="${escH(cover)}" alt="" loading="lazy"><span class="olx-zoom">⤢</span>`:''}
      </div>
      <div class="olx-head">
        <div class="olx-thumb" ${thumbSrc?`onclick="event.stopPropagation();openOutletPhoto('${o.id}','${sign?'sign':'cover'}')" role="button" aria-label="View photo"`:''}>${thumb}</div>
        <div class="olx-title">
          <div class="ol-name">${escH(o.name)}</div>
          <div class="olx-meta"><span class="olx-status ${due>0?'due':'ok'}">${due>0?'Due '+fmt(due):'Settled'}</span>
            ${km!==Infinity?`<span class="ol-dist">📍 ${fmtDist(km)}</span>`:`<span class="olx-nopin">No location</span>`}</div>
        </div>
      </div>
      <div class="olx-grid">
        ${info('▦','gray','Category',escH(o.category||o.type||'—'))}
        ${info('👤','teal','Rep name',escH(rep?.name||o.createdByName||'—'))}
        ${info('📍','red','Route',escH(o.route||'—'))}
        ${info('$','gold','Due',fmt(due),due>0?'neg':'pos')}
      </div>
      <div class="olx-actions" onclick="event.stopPropagation()">
        ${isDeliveryMan()?'':`<button class="olx-btn ord" onclick="openNewOrder('${o.id}')">Order</button>`}
        <button class="olx-btn wa${o.phone?'':' off'}" onclick="${o.phone?`openWhatsApp('${o.id}')`:"showToast('No phone number saved','warn')"}">WhatsApp</button>
        <button class="olx-btn dir${o.lat&&o.lng?'':' off'}" onclick="${o.lat&&o.lng?`openDirections('${o.id}')`:"showToast('No location pinned for this outlet','warn')"}">Direction</button>
        ${isDeliveryMan()?'':`<button class="olx-btn np" onclick="openNPVisit('${o.id}')" title="NP Visit">📄 NP</button>`}
        ${isAdmin()?`<button class="olx-btn del" onclick="delOutlet('${o.id}')" title="Delete outlet" aria-label="Delete outlet">🗑️</button>`:''}
        <button class="olx-btn more" onclick="openOutletMenu('${o.id}',this)" aria-label="More options">⋮</button>
      </div>
    </div>`;
  }

  // ── View switch (every role): Nearby = all outlets you can see, nearest
  // first from your current location; or the grouped view below.
  const fresh=_userLat&&_userLng;
  const ago=_outletLocAt?Math.max(0,Math.round((Date.now()-_outletLocAt)/60000)):null;
  const locLine=_outletView!=='near'?''
    :fresh?`<span class="ol-loc ok">📍 Nearest first${ago!==null?` · location ${ago?ago+' min ago':'just now'}`:''}</span><button class="ol-loc-btn" onclick="outletRelocate()">↻ Update</button>`
    :_outletLocErr?`<span class="ol-loc err">📍 Location is off — turn on GPS to sort by distance</span><button class="ol-loc-btn" onclick="outletRelocate()">Retry</button>`
    :'<span class="ol-loc">📍 Finding your location…</span>';
  const viewBar=`<div class="ol-viewbar"><div class="ol-seg">
      <button class="${_outletView==='near'?'on':''}" onclick="setOutletView('near')">📍 Nearby</button>
      <button class="${_outletView==='group'?'on':''}" onclick="setOutletView('group')">🗂️ ${isAdmin()?'By rep & route':isDeliveryMan()?'My deliveries':'By route'}</button>
    </div><div class="ol-locrow">${locLine}</div></div>`;

  if(_outletView==='near'){
    const q=srch.trim();
    let base=allOutlets;
    if(isDeliveryMan()){ // only today's working stops (see _dmActiveOutletIds)
      try{const myO=await sfGet('orders',[window.__SF.where('deliveryManId','==',CU.uid)]);const ids=_dmActiveOutletIds(myO.map(d=>d.data()));base=allOutlets.filter(o=>ids.has(o.id));}catch(e){}
    }
    const list=base.filter(o=>!q||[o.name,o.area,o.route,o.address,o.phone,o.type].some(v=>String(v||'').toLowerCase().includes(q)));
    const withKm=list.map(o=>({o,km:distKm(o)})).sort((x,y)=>(x.km-y.km)||String(x.o.name||'').localeCompare(String(y.o.name||'')));
    const shown=withKm.slice(0,_outletNearLimit);
    tree.innerHTML=viewBar+(shown.length
      ?`<div class="ol-count">${list.length} outlet${list.length!==1?'s':''}${q?` matching “${escH(q)}”`:''}</div><div class="ol-grid">${shown.map((x,i)=>buildOutletCard(x.o,i)).join('')}</div>`+
        (withKm.length>shown.length?`<button class="btn btn-ghost" style="width:100%;margin-top:12px" onclick="_outletNearLimit+=60;loadOutlets()">Show more (${withKm.length-shown.length} further away)</button>`:'')
      :'<div style="text-align:center;padding:30px;color:var(--tx3)">No outlets found</div>');
    _outletLocate(false);
    return;
  }

  // Sort helper: by distance (pinned outlets first, then by km)
  function sortByDist(arr){
    return [...arr].sort((a,b)=>{
      const da=distKm(a),db=distKm(b);
      return da-db;
    });
  }

  // Delivery man: flat list of their outlets sorted by distance
  if(isDeliveryMan()){
    const {where:wdm}=window.__SF;
    let allowedIds=new Set();
    try{const myO=await sfGet('orders',[wdm('deliveryManId','==',CU.uid)]);allowedIds=_dmActiveOutletIds(myO.map(d=>d.data()));}catch(e){}
    const myOutlets=sortByDist(allOutlets.filter(o=>allowedIds.has(o.id)));
    tree.innerHTML=viewBar+(myOutlets.length
      ?`<div class="ol-grid">${myOutlets.map((o,i)=>buildOutletCard(o,i)).join('')}</div>`
      :'<div style="text-align:center;padding:30px;color:var(--tx3)">No deliveries assigned right now.<br><span style="font-size:12px">Outlets that still owe money are in your dashboard’s dues list.</span></div>');
    return;
  }

  // For sales rep: route → outlets (2 levels)
  if(!isAdmin()){
    const myOutlets=allOutlets.filter(o=>o.createdBy===CU.uid||o.assignedRepId===CU.uid);
    const myRouteIds=[...new Set(myOutlets.map(o=>o.routeId).filter(Boolean))];
    const myRoutes=allRoutes.filter(r=>myRouteIds.includes(r.id)||r.repId===CU.uid);
    if(!myRoutes.length&&!myOutlets.length){
      tree.innerHTML=viewBar+'<div style="text-align:center;padding:30px;color:var(--tx3)">No outlets or routes assigned yet</div>';return;
    }
    // Build route folders
    const html=myRoutes.map((r,ri)=>{
      const routeOutlets=sortByDist(myOutlets.filter(o=>o.routeId===r.id).filter(o=>!srch||o.name.toLowerCase().includes(srch)||r.name.toLowerCase().includes(srch)));
      const isOpen=_outletOpen.route===r.id;
      return`<div class="tree-l2" id="otl2-${r.id}">
        <div class="tree-hdr2 ${isOpen?'open':''}" onclick="toggleOutletRoute('${r.id}')">
          <span class="tree-chevron">▶</span>
          <span style="font-size:16px">🗺️</span>
          <div style="flex:1">
            <div style="font-size:13px;font-weight:700">${r.name}</div>
            <div style="font-size:10px;color:var(--tx3)">${routeOutlets.length} outlet${routeOutlets.length!==1?'s':''}</div>
          </div>
          ${isAdmin()?`<button class="btn btn-ghost btn-xs" onclick="event.stopPropagation();editRoute('${r.id}')">✏️</button>`:''}
        </div>
        <div class="tree-body2 ${isOpen?'open':''}" id="otbody2-${r.id}">
          ${routeOutlets.length?routeOutlets.map((o,i)=>buildOutletCard(o,i)).join(''):'<div style="font-size:12px;color:var(--tx3);padding:6px">No outlets on this route</div>'}
        </div>
      </div>`;
    }).join('');
    // Unrouted outlets sorted by distance
    const unrouted=sortByDist(myOutlets.filter(o=>!o.routeId).filter(o=>!srch||o.name.toLowerCase().includes(srch)));
    tree.innerHTML=viewBar+html+(unrouted.length?`<div class="tree-l2"><div class="tree-hdr2" onclick="toggleOutletRoute('__unrouted__')"><span class="tree-chevron">▶</span><span style="font-size:16px">⚠️</span><div style="flex:1"><div style="font-size:13px;font-weight:700">Unassigned to Route</div><div style="font-size:10px;color:var(--tx3)">${unrouted.length} outlet${unrouted.length!==1?'s':''}</div></div></div><div class="tree-body2" id="otbody2-__unrouted__">${unrouted.map((o,i)=>buildOutletCard(o,i)).join('')}</div></div>`:'');
    return;
  }

  // Admin: rep → route → outlets (3 levels)
  // Owner with a zone picked: only that zone's reps.
  const reps=allUsers.filter(u=>u.role==='sales_rep'&&u.status!=='disabled'&&(!isOwner()||!_ownerZoneFilter||u.zoneId===_ownerZoneFilter));
  const repIds=new Set(reps.map(u=>u.uid));
  const allSrchOutlets=allOutlets.filter(o=>!srch||o.name.toLowerCase().includes(srch)||(o.route||'').toLowerCase().includes(srch));

  let html=reps.map((rep,ri)=>{
    const repOutlets=allSrchOutlets.filter(o=>o.createdBy===rep.uid||o.assignedRepId===rep.uid);
    if(srch&&!repOutlets.length&&!rep.name.toLowerCase().includes(srch))return'';
    const repRouteIds=[...new Set(repOutlets.map(o=>o.routeId).filter(Boolean))];
    const repRoutes=allRoutes.filter(r=>repRouteIds.includes(r.id)||r.repId===rep.uid);
    const isRepOpen=_outletOpen.rep===rep.uid;
    return`<div class="tree-node" id="otrep-${rep.uid}">
      <div class="tree-hdr ${isRepOpen?'open':''}" onclick="toggleOutletRep('${rep.uid}')">
        <span class="tree-chevron">▶</span>
        <div class="ava ava-sm" style="background:var(--blu);flex-shrink:0">${rep.name[0]}</div>
        <div style="flex:1">
          <div style="font-size:13px;font-weight:700">${rep.name}</div>
          <div style="font-size:10px;color:var(--tx3)">${repOutlets.length} outlet${repOutlets.length!==1?'s':''} · ${repRoutes.length} route${repRoutes.length!==1?'s':''}</div>
        </div>
        <span class="bdg bdg-blu" style="font-size:10px">${rep.phone||''}</span>
      </div>
      <div class="tree-body ${isRepOpen?'open':''}" id="otrepbody-${rep.uid}">
        ${repRoutes.map(r=>{
          const routeOutlets=sortByDist(repOutlets.filter(o=>o.routeId===r.id));
          const isOpen=_outletOpen.route===r.id;
          return`<div class="tree-l2" id="otl2-${r.id}">
            <div class="tree-hdr2 ${isOpen?'open':''}" onclick="toggleOutletRoute('${r.id}')">
              <span class="tree-chevron">▶</span>
              <span style="font-size:15px">🗺️</span>
              <div style="flex:1">
                <div style="font-size:12px;font-weight:700">${r.name}</div>
                <div style="font-size:10px;color:var(--tx3)">${routeOutlets.length} outlet${routeOutlets.length!==1?'s':''}</div>
              </div>
              <div onclick="event.stopPropagation();editRoute('${r.id}')" style="font-size:11px;cursor:pointer;color:var(--tx3);padding:4px 6px">✏️</div>
            </div>
            <div class="tree-body2 ${isOpen?'open':''}" id="otbody2-${r.id}">
              ${routeOutlets.length?routeOutlets.map((o,i)=>buildOutletCard(o,i)).join(''):'<div style="font-size:12px;color:var(--tx3);padding:6px">No outlets on this route</div>'}
            </div>
          </div>`;
        }).join('')}
        ${repOutlets.filter(o=>!o.routeId).length?`<div style="font-size:11px;color:var(--ylw);padding:6px">⚠️ ${repOutlets.filter(o=>!o.routeId).length} outlet(s) not assigned to a route</div>`:''}
        ${!repRoutes.length?'<div style="font-size:12px;color:var(--tx3);padding:6px">No routes assigned</div>':''}
      </div>
    </div>`;
  }).join('');

  // Outlets under no listed rep: none assigned, added by an admin, or the
  // rep is in another zone / no longer active. Listed so none go missing.
  const orphans=allSrchOutlets.filter(o=>!repIds.has(o.assignedRepId)&&!repIds.has(o.createdBy));
  if(orphans.length){
    const isOrphanOpen=_outletOpen.rep==='__orphan__';
    html+=`<div class="tree-node" id="otrep-__orphan__">
      <div class="tree-hdr ${isOrphanOpen?'open':''}" onclick="toggleOutletRep('__orphan__')">
        <span class="tree-chevron">▶</span><span style="font-size:16px">⚠️</span>
        <div style="flex:1">
          <div style="font-size:13px;font-weight:700;color:var(--ylw)">Outlets without a rep (${orphans.length})</div>
          <div style="font-size:10px;color:var(--tx3)">No sales rep of this zone assigned — tap Assign to set one</div>
        </div>
        <span class="bdg bdg-ylw" style="font-size:10px">${orphans.length}</span>
      </div>
      <div class="tree-body ${isOrphanOpen?'open':''}" id="otrepbody-__orphan__">
        ${orphans.map(o=>`
          <div class="oc-mini" style="border-left:3px solid var(--ylw)">
            <div class="oc-mini-ava" style="background:${o.color||'var(--ylw)'}">${o.name[0]}</div>
            <div class="oc-mini-info" style="cursor:pointer" onclick="viewOutlet('${o.id}')">
              <div class="oc-mini-name">${o.name}</div>
              <div class="oc-mini-sub">${o.type||''}${o.area?' · '+o.area:''}${o.route?' · 🗺️ '+o.route:''}</div>
            </div>
            <div class="oc-mini-btns" onclick="event.stopPropagation()">
              <button class="btn btn-ylw btn-xs" onclick="adminAssignRep('${o.id}')">👤 Assign</button>
              <button class="btn btn-primary btn-xs" onclick="openNewOrder('${o.id}')">📦</button>
            </div>
          </div>`).join('')}
      </div>
    </div>`;
  }

  tree.innerHTML=viewBar+html||'<div style="text-align:center;padding:30px;color:var(--tx3)">No outlets found</div>';
}

// Full-screen outlet photo (cover / signboard), tap or ✕ to close.
function openOutletPhoto(id,which){
  const o=allOutlets.find(x=>x.id===id); if(!o)return;
  const photos=[];
  const cover=o.coverPhoto||o.interiorPhoto;
  if(cover)photos.push(['cover','Cover photo',cover]);
  if(o.signboardPhoto)photos.push(['sign','Signboard',o.signboardPhoto]);
  if(!photos.length)return;
  let idx=Math.max(0,photos.findIndex(p=>p[0]===which));
  document.getElementById('olPhotoView')?.remove();
  const ov=document.createElement('div');
  ov.id='olPhotoView';ov.className='olpv';
  const draw=()=>{
    const [,label,src]=photos[idx];
    ov.innerHTML=`<div class="olpv-top"><div><div class="olpv-name">${escH(o.name)}</div><div class="olpv-lbl">${label}</div></div>
        <button class="olpv-x" aria-label="Close">✕</button></div>
      <img class="olpv-img" src="${escH(src)}" alt="${escH(label)}">
      ${photos.length>1?`<div class="olpv-tabs">${photos.map((p,i)=>`<button data-i="${i}" class="${i===idx?'on':''}">${p[1]}</button>`).join('')}</div>`:''}`;
    ov.querySelectorAll('.olpv-tabs button').forEach(b=>b.onclick=e=>{e.stopPropagation();idx=+b.dataset.i;draw();});
    ov.querySelector('.olpv-img').onclick=e=>e.stopPropagation();
  };
  const close=()=>{ov.remove();document.removeEventListener('keydown',onKey);};
  const onKey=e=>{if(e.key==='Escape')close();};
  ov.onclick=close;
  document.addEventListener('keydown',onKey);
  draw();
  document.body.appendChild(ov);
}

// ⋮ menu on an outlet card. Everyone gets view/edit/QR/call; admins also
// get assign rep, opening balance decisions, order history and delete.
function openOutletMenu(id,btn){
  document.getElementById('olMenu')?.remove();
  const o=allOutlets.find(x=>x.id===id); if(!o)return;
  const items=[
    ['👁️','View details',`viewOutlet('${id}')`],
    ['✏️','Edit outlet',`editOutlet('${id}')`],
    ['🔳','Outlet QR code',`viewOutletQR('${id}')`],
  ];
  if(o.phone)items.push(['📞','Call',`location.href='tel:${String(o.phone).replace(/[^0-9+]/g,'')}'`]);
  if(isAdmin()){
    items.push(['👤','Assign sales rep',`adminAssignRep('${id}')`]);
    items.push(['🧾','Orders & invoices',`outletOrderHistory('${id}')`]);
    items.push(['💰','Collect payment',`openNewCollection('${id}')`]);
    if(o.balanceStatus==='pending'&&o.openingBalance>0){
      items.push(['✅','Approve opening balance',`approveBalance('${id}')`]);
      items.push(['✕','Reject opening balance',`rejectBalance('${id}')`]);
    }
    items.push(['🗑','Delete outlet',`delOutlet('${id}')`,'danger']);
  }
  const m=document.createElement('div');
  m.id='olMenu';m.className='ol-menu';
  m.innerHTML=`<div class="ol-menu-sheet" onclick="event.stopPropagation()">
    <div class="ol-menu-title">${escH(o.name)}</div>
    ${items.map(([ic,l,fn,cls])=>`<button class="${cls||''}" onclick="document.getElementById('olMenu').remove();${fn}">${ic}<span>${l}</span></button>`).join('')}
    <button class="ol-menu-cancel" onclick="document.getElementById('olMenu').remove()">Cancel</button>
  </div>`;
  m.onclick=()=>m.remove();
  document.body.appendChild(m);
}

// Admin shortcut: the orders page filtered to one outlet.
function outletOrderHistory(id){
  const o=allOutlets.find(x=>x.id===id);
  goPage('orders');
  setTimeout(()=>{const s=document.getElementById('ordSrch');if(s&&o){s.value=o.name;s.dispatchEvent(new Event('input'));}},300);
}

function toggleOutletRep(repUid){
  const wasOpen=_outletOpen.rep===repUid;
  // Close all reps
  document.querySelectorAll('[id^="otrep-"]').forEach(n=>{
    n.querySelector('.tree-hdr')?.classList.remove('open');
    n.querySelector('.tree-body')?.classList.remove('open');
  });
  _outletOpen.route=null;
  if(!wasOpen){
    _outletOpen.rep=repUid;
    const hdr=document.querySelector(`#otrep-${CSS.escape(repUid)} .tree-hdr`);
    const body=document.getElementById(`otrepbody-${repUid}`);
    if(hdr)hdr.classList.add('open');
    if(body)body.classList.add('open');
  } else {
    _outletOpen.rep=null;
  }
}

function toggleOutletRoute(routeId){
  const wasOpen=_outletOpen.route===routeId;
  // Close all routes
  document.querySelectorAll('[id^="otl2-"]').forEach(n=>{
    n.querySelector('.tree-hdr2')?.classList.remove('open');
    n.querySelector('.tree-body2')?.classList.remove('open');
  });
  if(!wasOpen){
    _outletOpen.route=routeId;
    const hdr=document.querySelector(`#otl2-${CSS.escape(routeId)} .tree-hdr2`);
    const body=document.getElementById(`otbody2-${routeId}`);
    if(hdr)hdr.classList.add('open');
    if(body)body.classList.add('open');
  } else {
    _outletOpen.route=null;
  }
}

// ── Admin: assign a rep to an outlet that has none ──
async function adminAssignRep(outletId) {
  if(!isAdmin()){showToast('Admin only','error');return;}
  const o=allOutlets.find(x=>x.id===outletId);if(!o)return;
  const reps=allUsers.filter(u=>u.role==='sales_rep'&&u.status!=='disabled');
  if(!reps.length){showToast('No active sales reps found','warn');return;}
  const list=reps.map((u,i)=>(i+1)+') '+u.name+(u.phone?' ('+u.phone+')':'')).join(', ');
  const num=window.prompt('Assign "'+o.name+'" to rep. Options: '+list+'. Enter number 1-'+reps.length+':');
  if(!num)return;
  const idx=parseInt(num,10)-1;
  if(isNaN(idx)||idx<0||idx>=reps.length){showToast('Invalid - enter 1 to '+reps.length,'warn');return;}
  const rep=reps[idx];
  try{
    await sfUpdate('outlets',outletId,{assignedRepId:rep.uid,assignedRepName:rep.name});
    showToast('"'+o.name+'" assigned to '+rep.name+' OK','success');
    await loadCachedData();
    loadOutlets();
  }catch(e){showToast('Error: '+e.message,'error');}
}

async function openNewOutlet() {
  // Ensure routes and users are loaded before populating dropdowns
  // try/catch so a Firestore error never silently blocks the modal from opening
  // loadCachedData not needed here — cache is kept fresh by invalidateCache() on writes
  document.getElementById('mOutletTitle').textContent='🏪 Add Outlet';
  document.getElementById('oEditId').value='';
  ['oName','oArea','oCon','oPhn','oLotNum','oAddr','oROC','oCategoryOthers','oCreditCustomDays'].forEach(id=>{const el=document.getElementById(id);if(el)el.value='';});
  const oEthEl=document.getElementById('oEthnicity');if(oEthEl)oEthEl.value='';
  const oCatEl=document.getElementById('oCategory');if(oCatEl)oCatEl.value='';
  document.getElementById('oCategoryOthersRow').style.display='none';
  // Reset payment type radios
  document.getElementById('oTypeCash').checked=false;
  document.getElementById('oTypeCredit').checked=false;
  document.getElementById('oCreditFields').style.display='none';
  const oCTEl=document.getElementById('oCreditTerm');if(oCTEl)oCTEl.value='';
  const oCLEl=document.getElementById('oCreditLimit');if(oCLEl)oCLEl.value='';
  document.getElementById('oCreditCustomDaysRow').style.display='none';
  clearOutletLocation();
  clearOutletPhoto('signboard');
  clearOutletPhoto('cover');
  cancelOutletCamera();
  _populateRouteDropdown('oRoute','');
  _populateOutletRepDropdown('');
  // Admin sees rep assignment field; reps do not
  const oRepRow=document.getElementById('oRepRow');
  if(oRepRow)oRepRow.style.display=isAdmin()?'':'none';
  // Unlock name field for new outlet
  const nameEl=document.getElementById('oName');
  if(nameEl){nameEl.readOnly=false;nameEl.style.background='';nameEl.style.color='';nameEl.title='';}
  const lockBadge=document.getElementById('oNameLockBadge');
  if(lockBadge)lockBadge.style.display='none';
  openM('mOutlet');
}

function _populateOutletRepDropdown(selectedUid) {
  const el=document.getElementById('oAssignedRep');if(!el)return;
  const reps=allUsers.filter(u=>u.role==='sales_rep'&&u.status!=='disabled'&&(!isOwner()||!_ownerZoneFilter||u.zoneId===_ownerZoneFilter||u.uid===selectedUid));
  el.innerHTML='<option value="">Unassigned</option>'+
    reps.map(u=>`<option value="${u.uid}" ${u.uid===selectedUid?'selected':''}>${u.name}</option>`).join('');
}

/* ── Outlet form UI helpers ─────────────────────── */
function onOutletCategoryChange(){
  const val=document.getElementById('oCategory')?.value;
  document.getElementById('oCategoryOthersRow').style.display=val==='others'?'':'none';
}
function onOutletPayTypeChange(){
  const isCr=document.getElementById('oTypeCredit')?.checked;
  document.getElementById('oCreditFields').style.display=isCr?'':'none';
  const oCTEl=document.getElementById('oCreditTerm');if(oCTEl&&!isCr)oCTEl.value='';
  if(!isCr){const el=document.getElementById('oCreditCustomDaysRow');if(el)el.style.display='none';}
}
document.addEventListener('change',function(e){
  if(e.target&&e.target.id==='oCreditTerm'){
    document.getElementById('oCreditCustomDaysRow').style.display=e.target.value==='custom'?'':'none';
  }
});

/* ── Outlet photo helpers ─────────────────────── */
let _oPhotoCamStream=null;
let _oPhotoCamTarget=null; // 'signboard' | 'cover'

function clearOutletPhoto(which){
  // 'cover' is an alias for 'interior' (HTML uses 'cover', legacy JS uses 'interior')
  const key=which==='signboard'?'signboard':'cover';
  if(key==='signboard'){
    // Reset avatar back to default icon
    const ava=document.getElementById('oSignboardAva');
    if(ava){ava.innerHTML='🏬';ava.style.background='';}
    // Hide preview, show empty state
    const preview=document.getElementById('oSignboardPhotoPreview');
    if(preview)preview.style.display='none';
    const empty=document.getElementById('oSignboardEmpty');
    if(empty)empty.style.display='';
    const hint=document.getElementById('oSignboardHint');
    if(hint){hint.style.display='';hint.textContent='Required — take a photo or upload from gallery';}
  } else {
    // Reset cover banner
    const img=document.getElementById('oCoverImg');
    if(img){img.src='';img.style.display='none';}
    const emp=document.getElementById('oCoverEmpty');
    if(emp)emp.style.display='';
  }
}

function onOutletPhotoFile(which,input){
  const file=input.files&&input.files[0];if(!file)return;
  const img=new Image();
  const objUrl=URL.createObjectURL(file);
  img.onload=function(){
    const maxW=1024,maxH=1024;
    let w=img.naturalWidth,h=img.naturalHeight;
    if(w>maxW||h>maxH){const s=Math.min(maxW/w,maxH/h);w=Math.round(w*s);h=Math.round(h*s);}
    const canvas=document.createElement('canvas');canvas.width=w;canvas.height=h;
    canvas.getContext('2d').drawImage(img,0,0,w,h);
    const dataUrl=canvas.toDataURL('image/jpeg',0.78);
    URL.revokeObjectURL(objUrl);
    _setOutletPhoto(which,dataUrl);
  };
  img.onerror=function(){
    URL.revokeObjectURL(objUrl);
    const reader=new FileReader();
    reader.onload=function(e){_setOutletPhoto(which,e.target.result);};
    reader.readAsDataURL(file);
  };
  img.src=objUrl;
  input.value='';
}

// Pick photo from gallery using Capacitor Camera plugin (Android app) or file input (PWA)
async function pickOutletPhotoFromGallery(which){
  const isCapacitor=!!(window.Capacitor&&window.Capacitor.isNativePlatform&&window.Capacitor.isNativePlatform());
  if(isCapacitor){
    try{
      const {Camera,CameraSource,CameraResultType}=window.Capacitor.Plugins;
      const photo=await Camera.getPhoto({resultType:CameraResultType.DataUrl,source:CameraSource.Photos,quality:80,width:1024});
      if(photo&&photo.dataUrl) _setOutletPhoto(which,photo.dataUrl);
    }catch(e){
      if(e&&e.message&&e.message.toLowerCase().includes('cancel'))return;
      showToast('Could not open gallery: '+e.message,'error');
    }
  } else {
    // PWA fallback — trigger hidden file input
    const inputId=which==='signboard'?'oSignboardFileInput':'oCoverFileInput';
    const el=document.getElementById(inputId);
    if(el)el.click();
  }
}

function _setOutletPhoto(which,dataUrl){
  const key=which==='signboard'?'signboard':'cover';
  if(key==='signboard'){
    // Update avatar thumbnail
    const ava=document.getElementById('oSignboardAva');
    if(ava) ava.innerHTML=`<img src="${dataUrl}" style="width:100%;height:100%;object-fit:cover;border-radius:inherit">`;
    // Show full preview card
    const preview=document.getElementById('oSignboardPhotoPreview');
    const previewImg=document.getElementById('oSignboardPhotoImg');
    if(previewImg){previewImg.src=dataUrl;}
    if(preview)preview.style.display='';
    // Shrink empty state to just action buttons (keep camera/gallery accessible)
    const hint=document.getElementById('oSignboardHint');
    if(hint)hint.style.display='none';
  } else {
    // Show photo in the cover banner
    const img=document.getElementById('oCoverImg');
    if(img){img.src=dataUrl;img.style.display='';}
    const emp=document.getElementById('oCoverEmpty');
    if(emp)emp.style.display='none';
  }
}

async function captureOutletPhoto(which){
  const isCapacitor=!!(window.Capacitor&&window.Capacitor.isNativePlatform&&window.Capacitor.isNativePlatform());
  if(isCapacitor){
    try{
      const {Camera,CameraSource,CameraResultType}=window.Capacitor.Plugins;
      const photo=await Camera.getPhoto({resultType:CameraResultType.DataUrl,source:CameraSource.Camera,quality:80,width:1024,correctOrientation:true});
      if(photo&&photo.dataUrl) _setOutletPhoto(which,photo.dataUrl);
    }catch(e){
      if(e&&e.message&&e.message.toLowerCase().includes('cancel'))return;
      showToast('Could not open camera: '+e.message,'error');
    }
    return;
  }
  // PWA: use in-page video camera
  _oPhotoCamTarget=which;
  const wrap=document.getElementById('oPhotoCamWrap');
  const lbl=document.getElementById('oPhotoCamLabel');
  const video=document.getElementById('oPhotoCamVideo');
  if(!wrap||!video)return;
  if(lbl)lbl.textContent=which==='signboard'?'📷 Capture Signboard Photo':'📷 Capture Cover Photo';
  try{
    _oPhotoCamStream=await navigator.mediaDevices.getUserMedia({video:{facingMode:'environment'},audio:false});
    video.srcObject=_oPhotoCamStream;
    wrap.style.display='';
    wrap.scrollIntoView({behavior:'smooth',block:'nearest'});
  }catch(err){
    showToast('Camera access denied: '+err.message,'error');
  }
}

function snapOutletPhoto(){
  const video=document.getElementById('oPhotoCamVideo');
  const canvas=document.getElementById('oPhotoCamCanvas');
  if(!video||!canvas)return;
  canvas.width=video.videoWidth||640;
  canvas.height=video.videoHeight||480;
  canvas.getContext('2d').drawImage(video,0,0);
  // Compress to ~1024px wide at 78% quality for fast saves
  const offscreen=document.createElement('canvas');
  const maxW=1024;const scale=Math.min(1,maxW/canvas.width);
  offscreen.width=Math.round(canvas.width*scale);
  offscreen.height=Math.round(canvas.height*scale);
  offscreen.getContext('2d').drawImage(canvas,0,0,offscreen.width,offscreen.height);
  const dataUrl=offscreen.toDataURL('image/jpeg',0.78);
  _setOutletPhoto(_oPhotoCamTarget,dataUrl);
  cancelOutletCamera();
}

function cancelOutletCamera(){
  if(_oPhotoCamStream){_oPhotoCamStream.getTracks().forEach(t=>t.stop());_oPhotoCamStream=null;}
  const wrap=document.getElementById('oPhotoCamWrap');
  if(wrap)wrap.style.display='none';
  const video=document.getElementById('oPhotoCamVideo');
  if(video)video.srcObject=null;
  _oPhotoCamTarget=null;
}

async function editOutlet(id) {
  const o=allOutlets.find(x=>x.id===id);if(!o)return;
  // Sales rep can only edit their own outlets
  if(!isAdmin() && o.createdBy !== CU.uid){showToast('You can only edit your own outlets','error');return;}
  document.getElementById('mOutletTitle').textContent='✏️ Edit Outlet';
  document.getElementById('oEditId').value=id;
  document.getElementById('oName').value=o.name;
  // Category
  const oCatEl=document.getElementById('oCategory');
  if(oCatEl){oCatEl.value=o.category||'';}
  const othersRow=document.getElementById('oCategoryOthersRow');
  if(othersRow)othersRow.style.display=o.category==='others'?'':'none';
  const oCOEl=document.getElementById('oCategoryOthers');if(oCOEl)oCOEl.value=o.categoryOthers||'';
  // Payment type
  const payType=o.paymentType||'cash';
  const cashRadio=document.getElementById('oTypeCash');
  const creditRadio=document.getElementById('oTypeCredit');
  if(cashRadio)cashRadio.checked=payType==='cash';
  if(creditRadio)creditRadio.checked=payType==='credit';
  document.getElementById('oCreditFields').style.display=payType==='credit'?'':'none';
  const oCTEl=document.getElementById('oCreditTerm');if(oCTEl)oCTEl.value=o.creditTerm||'';
  const oCLEl=document.getElementById('oCreditLimit');if(oCLEl)oCLEl.value=o.creditLimit||'';
  const customDaysRow=document.getElementById('oCreditCustomDaysRow');
  if(customDaysRow)customDaysRow.style.display=o.creditTerm==='custom'?'':'none';
  const oCCDEl=document.getElementById('oCreditCustomDays');if(oCCDEl)oCCDEl.value=o.creditCustomDays||'';
  // Other fields
  document.getElementById('oArea').value=o.area||'';
  document.getElementById('oCon').value=o.contact||'';
  document.getElementById('oPhn').value=o.phone||'';
  // Split stored address back into lot/unit + street body
  // Lot patterns: "No 56", "Unit 3A", "Lot 7", "PT 1234", or leading digits
  const savedAddr=o.address||'';
  const lotMatch=savedAddr.match(/^(No\.?\s*\S[^,]*|Unit\s+[^,]+|Lot\s+[^,]+|PT\s+[^,]+|\d+[^,]*),\s*/i);
  const lotEl2=document.getElementById('oLotNum');
  const addrEl2=document.getElementById('oAddr');
  if(lotMatch&&lotEl2){
    lotEl2.value=lotMatch[1].trim();
    if(addrEl2) addrEl2.value=savedAddr.slice(lotMatch[0].length).trim();
  } else {
    if(lotEl2) lotEl2.value='';
    if(addrEl2) addrEl2.value=savedAddr;
  }
  const oROCEl=document.getElementById('oROC');if(oROCEl)oROCEl.value=o.roc||'';
  const oEthEl=document.getElementById('oEthnicity');if(oEthEl)oEthEl.value=o.ethnicity||'';
  _populateRouteDropdown('oRoute', o.routeId||o.route||'');
  _populateOutletRepDropdown(o.assignedRepId||'');
  const oRepRow=document.getElementById('oRepRow');
  if(oRepRow)oRepRow.style.display=isAdmin()?'':'none';

  // Photos
  clearOutletPhoto('signboard');clearOutletPhoto('cover');cancelOutletCamera();
  if(o.signboardPhoto){
    const ava=document.getElementById('oSignboardAva');
    if(ava) ava.innerHTML=`<img src="${o.signboardPhoto}" style="width:100%;height:100%;object-fit:cover;border-radius:inherit">`;
    const preview=document.getElementById('oSignboardPhotoPreview');
    const previewImg=document.getElementById('oSignboardPhotoImg');
    if(previewImg) previewImg.src=o.signboardPhoto;
    if(preview) preview.style.display='';
    const hint=document.getElementById('oSignboardHint');
    if(hint) hint.style.display='none';
  }
  if(o.coverPhoto||o.interiorPhoto){
    const coverSrc=o.coverPhoto||o.interiorPhoto;
    const img=document.getElementById('oCoverImg');
    if(img){img.src=coverSrc;img.style.display='';}
    const emp=document.getElementById('oCoverEmpty');
    if(emp) emp.style.display='none';
  }

  // Lock outlet name for non-strict-admin
  const nameEl=document.getElementById('oName');
  if(nameEl){
    const isLocked=CU&&CU.role==='sales_rep';
    nameEl.readOnly=isLocked;
    nameEl.style.background=isLocked?'var(--s3)':'';
    nameEl.style.color=isLocked?'var(--tx3)':'';
    nameEl.title=isLocked?'Outlet name can only be changed by Admin':'';
    // Show/hide lock badge
    let lockBadge=document.getElementById('oNameLockBadge');
    if(!lockBadge){
      lockBadge=document.createElement('div');
      lockBadge.id='oNameLockBadge';
      lockBadge.style.cssText='font-size:10px;color:var(--ylw);margin-top:4px;display:flex;align-items:center;gap:4px';
      nameEl.parentNode.insertBefore(lockBadge,nameEl.nextSibling);
    }
    lockBadge.style.display=isLocked?'flex':'none';
    lockBadge.innerHTML='🔒 Outlet name is locked — only Admin can change it';
  }

  // Restore saved location
  const latEl=document.getElementById('oLat');
  const lngEl=document.getElementById('oLng');
  if(latEl) latEl.value=o.lat||'';
  if(lngEl) lngEl.value=o.lng||'';
  if(o.lat&&o.lng){
    const d=document.getElementById('outletLocDisplay');
    if(d) d.innerHTML=`<span style="color:var(--grn)">✅ ${Number(o.lat).toFixed(6)}, ${Number(o.lng).toFixed(6)}</span>`;
    const clr=document.getElementById('clearLocBtn');if(clr)clr.style.display='inline-flex';
  } else {
    clearOutletLocation();
  }
  openM('mOutlet');
}

async function saveOutlet() {
  try {
    const nameEl=document.getElementById('oName');
    const editId=document.getElementById('oEditId').value;
    const existing=editId?allOutlets.find(o=>o.id===editId):null;
    const isSalesRep=CU&&CU.role==='sales_rep';
    const name=isSalesRep&&existing?existing.name:(nameEl?nameEl.value.trim():'');
    const category=document.getElementById('oCategory')?.value||'';
    const categoryOthers=category==='others'?(document.getElementById('oCategoryOthers')?.value.trim()||''):'';
    const paymentType=document.querySelector('input[name="oPayType"]:checked')?.value||'';
    const creditTerm=paymentType==='credit'?(document.getElementById('oCreditTerm')?.value||''):'';
    const creditLimit=paymentType==='credit'?(parseFloat(document.getElementById('oCreditLimit')?.value)||0):0;
    const creditCustomDays=creditTerm==='custom'?(parseInt(document.getElementById('oCreditCustomDays')?.value)||0):0;
    const area=document.getElementById('oArea').value.trim();
    const contact=document.getElementById('oCon').value.trim();
    const phone=document.getElementById('oPhn').value.trim();
    const lotNum=document.getElementById('oLotNum')?.value.trim()||'';
    const addrBody=document.getElementById('oAddr')?.value.trim()||'';
    // Combine into full address: "No 56, Jalan X, Taman Y, 31450 Ipoh, Perak, Malaysia"
    const address=[lotNum,addrBody].filter(Boolean).join(', ');
    const roc=document.getElementById('oROC')?.value.trim()||'';
    const ethnicity=document.getElementById('oEthnicity')?.value||'';
    // Signboard photo — read from new preview img or fallback to avatar img
    const signboardPreviewImg=document.getElementById('oSignboardPhotoImg');
    const signboardAva=document.getElementById('oSignboardAva');
    const signboardAvaImg=signboardAva?signboardAva.querySelector('img'):null;
    const _sbSrc=(signboardPreviewImg&&signboardPreviewImg.src&&signboardPreviewImg.src!==window.location.href&&signboardPreviewImg.src!=='')?signboardPreviewImg.src:
                  (signboardAvaImg&&signboardAvaImg.src&&!signboardAvaImg.src.endsWith(window.location.href))?signboardAvaImg.src:'';
    const signboardPhoto=_sbSrc||'';
    const interiorImg=document.getElementById('oCoverImg');
    const interiorPhoto=(interiorImg&&interiorImg.src&&!interiorImg.src.endsWith(window.location.href))?interiorImg.src:'';

    if(!name){showToast('Outlet name is required','error');return;}
    if(!category){showToast('Select a category','error');return;}
    if(category==='others'&&!categoryOthers){showToast('Please specify the category','error');return;}
    if(!paymentType){showToast('Select payment type (Cash or Credit)','error');return;}
    if(paymentType==='credit'){
      if(!creditTerm){showToast('Select credit term','error');return;}
      if(creditTerm==='custom'&&!creditCustomDays){showToast('Enter custom credit days','error');return;}
      if(!creditLimit){showToast('Enter credit limit amount','error');return;}
    }
    if(!area){showToast('Area/Zone is required','error');return;}
    if(!phone){showToast('Phone number is required','error');return;}
    if(!contact){showToast('Contact person name is required','error');return;}
    if(!address){showToast('Address is required — enter lot/unit no and street','error');return;}
    if(!signboardPhoto){showToast('Signboard photo is required','error');return;}

    const routeEl=document.getElementById('oRoute');
    const routeId=routeEl?routeEl.value:'';
    if(!routeId){showToast('Select a route (create routes first under Routes)','warn');return;}
    const selectedRoute=allRoutes.find(r=>r.id===routeId);
    const routeNameVal=selectedRoute?selectedRoute.name:'';
    const rawLat=document.getElementById('oLat')?.value;
    const rawLng=document.getElementById('oLng')?.value;

    // type is now derived from category for backward compat
    const typeLegacy=category;

    const data={
      name, category, categoryOthers, type:typeLegacy,
      paymentType, creditTerm, creditLimit, creditCustomDays,
      area, routeId, route:routeNameVal, contact, phone, address, roc, ethnicity,
      signboardPhoto, coverPhoto: interiorPhoto,
      assignedRepId:isAdmin()?(document.getElementById('oAssignedRep')?.value||''):CU.uid,
      assignedRepName:isAdmin()?((allUsers.find(u=>u.uid===document.getElementById('oAssignedRep')?.value)||{}).name||''):CU.name,
      color:COLORS[allOutlets.length%COLORS.length],
      lat:rawLat?parseFloat(rawLat):null, lng:rawLng?parseFloat(rawLng):null, zoneId:CU.zoneId||null,
    };

    if(editId){
      if(existing&&isSalesRep&&name!==existing.name){showToast('Outlet name cannot be changed. Contact Admin.','error');return;}
      // Credit outlets: flag for approval if not already approved or if credit fields changed
      if(paymentType==='credit'){
        const creditChanged=!existing||existing.paymentType!=='credit'||existing.creditLimit!==creditLimit||existing.creditTerm!==creditTerm;
        if(creditChanged&&!isAdmin()){data.creditStatus='pending';data.creditRequestedBy=CU.uid;}
        else if(isAdmin()){data.creditStatus='approved';data.creditApprovedBy=CU.uid;}
      } else {
        data.creditStatus='none';
      }
      await sfUpdate('outlets',editId,data);
      showToast('Outlet updated','success');
    } else {
      data.createdBy=CU.uid;data.createdByName=CU.name;data.createdAt=new Date().toISOString();
      if(paymentType==='credit'){
        data.creditStatus=isAdmin()?'approved':'pending';
        if(isAdmin())data.creditApprovedBy=CU.uid;
      } else {
        data.creditStatus='none';
      }
      // Keep legacy openingBalance as 0 for compat
      data.openingBalance=0;data.balanceStatus='none';
      await sfAdd('outlets',data);
      const msg=paymentType==='credit'&&!isAdmin()?'Outlet added — credit terms pending admin approval.':'Outlet added';
      showToast(msg,'success');
      // 🔔 Notify admins if credit approval needed
      if(paymentType==='credit'&&!isAdmin()) notifyAdmins('🏦 Credit Approval Needed',`${CU.name} added outlet "${name}" — credit terms pending approval`,{tag:'credit-pending'});
    }
    closeM('mOutlet');
    await loadCachedData();
    loadOutlets();updateBadges();updateSidebarStats();
  } catch(e) {
    console.error('saveOutlet error:',e);
    showToast('Error saving outlet: '+e.message,'error');
  }
}

function _populateRouteDropdown(selectId, selectedVal) {
  const el=document.getElementById(selectId);
  if(!el)return;
  el.innerHTML='<option value="">Select route...</option>'+
    allRoutes.map(r=>`<option value="${r.id}" ${r.id===selectedVal?'selected':''}>${r.name}</option>`).join('');
}

// ── Outlet location helpers ──
function pinOutletLocation() {
  if(!navigator.geolocation){showToast('Geolocation not supported','error');return;}
  showToast('Getting GPS location…','info');
  navigator.geolocation.getCurrentPosition(pos=>{
    const lat=pos.coords.latitude.toFixed(6);
    const lng=pos.coords.longitude.toFixed(6);
    const acc=Math.round(pos.coords.accuracy);
    const latEl=document.getElementById('oLat');
    const lngEl=document.getElementById('oLng');
    if(latEl)latEl.value=lat;
    if(lngEl)lngEl.value=lng;
    const d=document.getElementById('outletLocDisplay');
    if(d)d.innerHTML=`<span style="color:var(--grn)">✅ ${lat}, ${lng}</span><span style="font-size:10px;color:var(--tx3);margin-left:6px">(±${acc}m)</span>`;
    const clr=document.getElementById('clearLocBtn');if(clr)clr.style.display='inline-flex';
    showToast('Location pinned ✅','success');
  },err=>{
    showToast('Could not get location. Enable GPS and try again.','error');
    console.warn('GPS error',err.message);
  },{enableHighAccuracy:true,timeout:12000,maximumAge:0});
}

function clearOutletLocation() {
  const latEl=document.getElementById('oLat');if(latEl)latEl.value='';
  const lngEl=document.getElementById('oLng');if(lngEl)lngEl.value='';
  const d=document.getElementById('outletLocDisplay');if(d)d.textContent='Not pinned yet';
  const clr=document.getElementById('clearLocBtn');if(clr)clr.style.display='none';
}

async function autoFillAddress() {
  if(!navigator.geolocation){showToast('Geolocation not supported','error');return;}
  showToast('Getting location…','info');
  navigator.geolocation.getCurrentPosition(async pos=>{
    const lat=pos.coords.latitude;
    const lng=pos.coords.longitude;
    // Pin coordinates
    const latEl=document.getElementById('oLat');if(latEl)latEl.value=lat.toFixed(6);
    const lngEl=document.getElementById('oLng');if(lngEl)lngEl.value=lng.toFixed(6);
    const d=document.getElementById('outletLocDisplay');
    const acc=Math.round(pos.coords.accuracy);
    if(d)d.innerHTML=`<span style="color:var(--grn)">✅ ${lat.toFixed(6)}, ${lng.toFixed(6)}</span><span style="font-size:10px;color:var(--tx3);margin-left:6px">(±${acc}m)</span>`;
    const clr=document.getElementById('clearLocBtn');if(clr)clr.style.display='inline-flex';
    try {
      // zoom=18 = building level; addressdetails=1 gives structured fields; namedetails=1 gives building name
      const url=`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&addressdetails=1&namedetails=1&zoom=18`;
      const resp=await fetch(url,{headers:{'Accept-Language':'en','User-Agent':'STSB-App'}});
      const json=await resp.json();
      if(json&&json.address){
        const a=json.address;

        // ── Lot / unit number ──────────────────────────────────────────────
        // OSM may have it in house_number; also check top-level name for "No X / Lot X / PT X"
        let lotNum=a.house_number||'';
        if(!lotNum){
          const topName=json.name||(json.namedetails&&json.namedetails.name)||'';
          if(/^(No\.?\s*\d|Lot\s*\d|PT\s*\d|Unit\s*\d|\d)/i.test(topName)) lotNum=topName;
        }
        // Only fill lot field if OSM returned something AND field is currently empty
        const lotEl=document.getElementById('oLotNum');
        if(lotEl&&lotNum&&!lotEl.value) lotEl.value=lotNum;

        // ── Street ────────────────────────────────────────────────────────
        const road=a.road||a.street||a.pedestrian||a.path||'';
        // ── Estate / taman / suburb ───────────────────────────────────────
        const suburb=a.neighbourhood||a.suburb||a.quarter||a.residential||a.village||a.hamlet||'';
        // ── Postcode + city ───────────────────────────────────────────────
        const city=a.city||a.town||a.municipality||a.county||'';
        const postcodeCity=[a.postcode,city].filter(Boolean).join(' ');
        // ── State, Country ────────────────────────────────────────────────
        const tail=[a.state,a.country].filter(Boolean).join(', ');

        const addrBody=[road,suburb,postcodeCity,tail].filter(Boolean).join(', ');
        const addrEl=document.getElementById('oAddr');
        if(addrEl) addrEl.value=addrBody||json.display_name||'';

        const gotLot=!!(lotEl&&lotEl.value);
        showToast(gotLot?'Address & lot filled ✅':'Address filled — enter lot/unit no manually ✅','success');
      } else {
        showToast('Location pinned. Address not found — enter manually.','warn');
      }
    } catch(e){
      console.warn('[autoFillAddress]',e.message);
      showToast('Location pinned. Could not fetch address.','warn');
    }
  },err=>{
    showToast('Could not get location. Enable GPS.','error');
  },{enableHighAccuracy:true,timeout:15000,maximumAge:0});
}

function openWhatsApp(outletId) {
  const o=allOutlets.find(x=>x.id===outletId);if(!o||!o.phone)return;
  const raw=o.phone.replace(/\D/g,'');
  const intl=raw.startsWith('0')?'6'+raw:raw.startsWith('60')?raw:'60'+raw;
  const msg=encodeURIComponent(`Hello ${o.name}, I am your sales rep from Sairah Trading. I would like to assist with your order.`);
  const waUrl=`https://wa.me/${intl}?text=${msg}`;
  const wabUrl=`https://wa.me/${intl}?text=${msg}`;

  // Show a small picker modal
  const existing=document.getElementById('waPickerModal');
  if(existing)existing.remove();
  const el=document.createElement('div');
  el.id='waPickerModal';
  el.style.cssText='position:fixed;inset:0;z-index:9000;background:rgba(0,0,0,.65);display:flex;align-items:flex-end;justify-content:center;backdrop-filter:blur(4px)';
  el.innerHTML=`
    <div style="background:var(--s1);border:1px solid var(--bdr);border-radius:20px 20px 0 0;width:100%;max-width:480px;padding:20px 20px calc(20px + env(safe-area-inset-bottom,0px));animation:slideUpBanner .25s ease">
      <div style="font-family:'Syne',sans-serif;font-size:15px;font-weight:700;margin-bottom:4px;text-align:center">💬 Open in WhatsApp</div>
      <div style="font-size:12px;color:var(--tx2);text-align:center;margin-bottom:18px">${o.name} · ${o.phone}</div>
      <div style="display:flex;flex-direction:column;gap:10px">
        <button onclick="window.open('${waUrl}','_blank');document.getElementById('waPickerModal').remove()"
          style="display:flex;align-items:center;gap:13px;padding:14px 16px;background:var(--s2);border:1px solid var(--bdr);border-radius:var(--r);cursor:pointer;color:var(--tx);font-size:14px;font-weight:600;transition:var(--tr)"
          onmouseover="this.style.borderColor='#25D366'" onmouseout="this.style.borderColor='var(--bdr)'">
          <span style="font-size:26px">💬</span>
          <div style="text-align:left"><div>WhatsApp</div><div style="font-size:11px;color:var(--tx3);font-weight:400">Standard personal/business chat</div></div>
        </button>
        <button onclick="window.open('whatsapp://send?phone=${intl}&text=${msg}','_blank');setTimeout(()=>{if(document.hidden===false)window.open('${waUrl}','_blank')},1500);document.getElementById('waPickerModal').remove()"
          style="display:flex;align-items:center;gap:13px;padding:14px 16px;background:var(--s2);border:1px solid var(--bdr);border-radius:var(--r);cursor:pointer;color:var(--tx);font-size:14px;font-weight:600;transition:var(--tr)"
          onmouseover="this.style.borderColor='#128C7E'" onmouseout="this.style.borderColor='var(--bdr)'">
          <span style="font-size:26px">🏢</span>
          <div style="text-align:left"><div>WhatsApp Business</div><div style="font-size:11px;color:var(--tx3);font-weight:400">For business accounts & catalogues</div></div>
        </button>
        <button onclick="document.getElementById('waPickerModal').remove()"
          style="padding:12px;background:transparent;border:1px solid var(--bdr);border-radius:var(--r2);cursor:pointer;color:var(--tx2);font-size:13px;font-weight:600">
          Cancel
        </button>
      </div>
    </div>`;
  el.addEventListener('click',e=>{if(e.target===el)el.remove();});
  document.body.appendChild(el);
}

function openDirections(outletId) {
  const o=allOutlets.find(x=>x.id===outletId);if(!o)return;
  if(!o.lat||!o.lng){showToast('No location pinned for this outlet','warn');return;}
  const label=encodeURIComponent(o.name);
  window.open(`https://www.google.com/maps/dir/?api=1&destination=${o.lat},${o.lng}&destination_place_id=${label}&travelmode=driving`,'_blank');
}

// Outlet QR: made on the phone (no internet needed). It links to the web
// app, which opens the order form for this outlet (?oc=ID, js/boot.js);
// the in-app scanner (js/misc.js) reads the same link.
const OUTLET_QR_BASE = PUBLIC_APP_URL + '/';
function _outletQrUrl(outletId) { return `${OUTLET_QR_BASE}?oc=${encodeURIComponent(outletId)}`; }
function _outletQr(url) { const qr = qrcode(0, 'M'); qr.addData(url); qr.make(); return qr; }

function viewOutletQR(outletId) {
  const o=allOutlets.find(x=>x.id===outletId);if(!o)return;
  const url=_outletQrUrl(outletId);
  document.getElementById('mQRTitle').textContent=`📷 ${o.name}`;
  document.getElementById('mQRSubtitle').textContent=`Scan to open order for ${o.name}`;
  const box=document.getElementById('mQRCode');
  if(typeof qrcode!=='function'){box.innerHTML='<div style="padding:30px;color:var(--red)">QR maker not loaded — update the app</div>';}
  else box.innerHTML=`<div style="width:220px;height:220px;background:#fff;border-radius:8px;padding:6px;box-sizing:border-box">${_outletQr(url).createSvgTag({cellSize:4,margin:2,scalable:true})}</div>`;
  document.getElementById('mQRUrl').textContent=url;
  window.__currentQROutlet={id:outletId,name:o.name,route:o.route||'',url};
  openM('mOutletQR');
}

// A printable PNG card: outlet name, the QR and a short instruction.
function _outletQrCard(q) {
  const qr=_outletQr(q.url), n=qr.getModuleCount(), cell=Math.floor(560/(n+4)), size=cell*(n+4);
  const W=size+80, H=size+190, c=document.createElement('canvas'); c.width=W; c.height=H;
  const g=c.getContext('2d');
  g.fillStyle='#fff'; g.fillRect(0,0,W,H);
  g.fillStyle='#0d1117'; g.textAlign='center';
  g.font='bold 30px Arial, sans-serif'; g.fillText(String(q.name).slice(0,34),W/2,52);
  if(q.route){g.font='20px Arial, sans-serif'; g.fillStyle='#555'; g.fillText(String(q.route).slice(0,40),W/2,82);}
  const x0=40, y0=100;
  g.fillStyle='#0d1117';
  for(let r=0;r<n;r++)for(let col=0;col<n;col++) if(qr.isDark(r,col)) g.fillRect(x0+(col+2)*cell,y0+(r+2)*cell,cell,cell);
  g.fillStyle='#333'; g.font='20px Arial, sans-serif';
  g.fillText('Scan to order · Sairah Trading (STSB)',W/2,y0+size+45);
  return c.toDataURL('image/png');
}

async function downloadOutletQR() {
  const q=window.__currentQROutlet;if(!q)return;
  if(typeof qrcode!=='function'){showToast('QR maker not loaded — update the app','error');return;}
  const png=_outletQrCard(q);
  const name=`QR-${String(q.name).replace(/[^A-Za-z0-9_-]+/g,'-').replace(/^-|-$/g,'')||q.id}.png`;
  if(!_invNative()){ const a=document.createElement('a'); a.href=png; a.download=name; a.click(); return; }
  const fs=_invPlugin('Filesystem');
  if(!fs){_invNeedsUpdate('Saving the QR');return;}
  const data=png.split(',')[1];
  try {
    await fs.writeFile({path:'STSB/'+name,data,directory:'DOCUMENTS',recursive:true});
    showToast(`QR saved: Documents/STSB/${name}`,'success');
  } catch(e) {
    // Some Android versions block shared Documents: offer it via the share sheet.
    try {
      const r=await fs.writeFile({path:name,data,directory:'CACHE',recursive:true});
      const sh=_invPlugin('Share');
      if(sh) await sh.share({title:name,files:[r.uri],dialogTitle:'Save or send the QR'});
      else throw e;
    } catch(e2){ showToast('Could not save the QR: '+(e2.message||e2),'error'); }
  }
}

async function approveBalance(id) {
  if(!isAdmin()){showToast('Only admin can approve balances','error');return;}
  await sfUpdate('outlets',id,{balanceStatus:'approved',balanceApprovedBy:CU.uid,balanceApprovedAt:new Date().toISOString()});
  showToast('Opening balance approved ✅','success');
  await loadCachedData();loadOutlets();renderDashboard();updateBadges();
}

async function rejectBalance(id) {
  if(!isAdmin()){showToast('Only admin can manage balances','error');return;}
  await sfUpdate('outlets',id,{balanceStatus:'rejected',openingBalance:0});
  showToast('Opening balance rejected','warn');
  await loadCachedData();loadOutlets();updateBadges();
}

async function delOutlet(id) {
  if(!isAdmin()){showToast('Only admin can delete outlets','error');return;}
  const o=allOutlets.find(x=>x.id===id);
  const label=o?o.name:`Outlet ${id}`;
  if(isStrictAdmin()){
    if(!confirm(`Delete "${label}"? This cannot be undone.`))return;
    const _oZone=(o&&o._zoneId)||_ownerZoneFilter||((!isOwner()&&CU.zoneId)?CU.zoneId:null);
    await Promise.all([
      window.__SF.deleteDoc(window.__SF.doc(window.__SF.db,'outlets',id)).catch(()=>{}),
      _oZone?window.__SF.deleteDoc(window.__SF.doc(window.__SF.db,'zones',_oZone,'outlets',id)).catch(()=>{}):Promise.resolve()
    ]);
    showToast('Outlet deleted','warn');
    await loadCachedData();loadOutlets();
  } else {
    await requestDeleteApproval('outlet',id,label);
  }
}

async function viewOutlet(id) {
  const o=allOutlets.find(x=>x.id===id);if(!o)return;
  const [ordD,colD]=await Promise.all([sfGet('orders'),sfGet('collections')]);
  const oOrders=ordD.map(d=>({_docId:d.id,...d.data()})).filter(x=>x.outletId===id);
  const oCols=colD.map(d=>d.data()).filter(x=>x.outletId===id);
  const approvedBalance=o.balanceStatus==='approved'?Number(o.openingBalance)||0:0;
  const led=outletLedger(oOrders,oCols,approvedBalance);
  const totalSales=led.sales, totalPaid=led.paid;
  window.__odLedger={outletId:id,...led};
  const hasPinned=!!(o.lat&&o.lng);
  const hasPhone=!!o.phone;

  const _coverSrc = o.signboardPhoto || o.coverPhoto || o.interiorPhoto || '';
  document.getElementById('mODTitle').textContent=o.name;
  document.getElementById('mODBody').innerHTML=`
    ${_coverSrc ? `
    <!-- Signboard cover photo -->
    <div style="margin:-16px -16px 0 -16px;position:relative;height:185px;overflow:hidden;border-radius:16px 16px 0 0;background:var(--s2)">
      <img src="${_coverSrc}" style="width:100%;height:100%;object-fit:cover;display:block"
           onerror="this.parentElement.style.display='none'">
      <div style="position:absolute;inset:0;background:linear-gradient(to bottom,rgba(0,0,0,.08) 0%,rgba(0,0,0,.55) 100%)"></div>
      <!-- Outlet name overlay on cover -->
      <div style="position:absolute;bottom:12px;left:14px;right:14px">
        <div style="font-family:'Syne',sans-serif;font-size:18px;font-weight:800;color:#fff;text-shadow:0 1px 4px rgba(0,0,0,.5);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${o.name}</div>
        <div style="font-size:11px;color:rgba(255,255,255,.82)">${escH(o.category||o.type||'')}${o.area?' · '+o.area:''}${o.route?' · 🗺️ '+o.route:''}</div>
      </div>
    </div>` : ''}
    <!-- Header row -->
    <div style="display:flex;gap:11px;align-items:center;margin-bottom:14px;padding-bottom:14px;border-bottom:1px solid var(--bdr);${_coverSrc?'margin-top:12px':''}">
      <div class="oava" style="background:${o.color||COLORS[0]};width:48px;height:48px;border-radius:10px;font-size:18px;flex-shrink:0;overflow:hidden;padding:0">${o.signboardPhoto?`<img src="${o.signboardPhoto}" style="width:100%;height:100%;object-fit:cover;display:block">`:`${o.name[0]}`}</div>
      <div style="flex:1;min-width:0">
        <div style="font-family:'Syne',sans-serif;font-size:16px;font-weight:700">${o.name}</div>
        <div style="font-size:12px;color:var(--tx2)">${escH(o.category||o.type||'')}${o.ethnicity?' · 👥 '+o.ethnicity:''}${o.area?' · '+o.area:''}${o.route?' · 🗺️ '+o.route:''}</div>
        ${hasPhone?`<div style="font-size:11px;color:var(--tx3)">📞 ${o.phone}${o.contact?' · 👤 '+o.contact:''}</div>`:''}
      </div>
    </div>

    <!-- Action buttons -->
    <div style="display:flex;gap:7px;margin-bottom:14px;flex-wrap:wrap">
      <button class="btn btn-primary btn-sm" style="flex:1;min-width:100px" onclick="closeM('mOutletDetail');openNewOrder('${o.id}')">📦 New Order</button>
      ${hasPhone?`<button class="btn btn-grn btn-sm" style="flex:1;min-width:90px" onclick="openWhatsApp('${o.id}')">💬 WhatsApp</button>`:''}
      <button class="btn btn-blu btn-sm" style="flex:1;min-width:90px" onclick="openDirections('${o.id}')" title="${hasPinned?'Open directions':'No location pinned'}">🗺️ Direction</button>
      <button class="btn btn-ghost btn-sm" style="flex:1;min-width:70px" onclick="viewOutletQR('${o.id}')">📷 QR Code</button>
      ${isDeliveryMan()?'':`<button class="btn btn-ghost btn-sm" style="flex:1;min-width:70px" onclick="stsbSharePortalLink('${o.id}','whatsapp')" title="Send the shop its private link to see orders and balance">🔗 Customer link</button>`}
    </div>

    <!-- GPS pin info -->
    <div style="background:${hasPinned?'rgba(34,197,94,.07)':'rgba(34,197,94,.05)'};border:1px solid ${hasPinned?'rgba(34,197,94,.2)':'var(--bdr)'};border-radius:var(--r2);padding:9px 12px;margin-bottom:14px;font-size:12px;display:flex;align-items:center;gap:9px">
      <span style="font-size:18px">${hasPinned?'📍':'🔘'}</span>
      <div style="flex:1">
        ${hasPinned
          ? `<div style="font-weight:700;color:var(--grn);margin-bottom:2px">Location Pinned</div>
             <div style="color:var(--tx3)">${Number(o.lat).toFixed(6)}, ${Number(o.lng).toFixed(6)}</div>`
          : `<div style="font-weight:600;color:var(--tx2)">No location pin set</div>
             <div style="color:var(--tx3)">Edit outlet and tap "Pin Current Location" while at the outlet</div>`}
      </div>
      ${hasPinned?`<a href="https://www.google.com/maps?q=${o.lat},${o.lng}" target="_blank" style="font-size:11px;color:var(--blu);text-decoration:none;white-space:nowrap">🗺️ View</a>`:''}
    </div>

    <!-- Stats -->
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:9px;margin-bottom:14px">
      <button class="od-stat" data-tab="orders" onclick="_odTab('orders')"><div style="color:var(--acc)">${fmt(totalSales)}</div><span>Total Sales · ${led.orders.length} ›</span></button>
      <button class="od-stat" data-tab="payments" onclick="_odTab('payments')"><div style="color:var(--grn)">${fmt(totalPaid)}</div><span>Collected · ${led.payments.length} ›</span></button>
      <button class="od-stat" data-tab="pending" onclick="_odTab('pending')"><div style="color:var(--red)">${fmt(led.outstanding)}</div><span>Outstanding · ${led.pending.length} ›</span></button>
    </div>

    ${o.openingBalance>0?`<div style="background:${o.balanceStatus==='approved'?'rgba(34,197,94,.07)':'rgba(245,158,11,.07)'};border:1px solid ${o.balanceStatus==='approved'?'rgba(34,197,94,.2)':'rgba(245,158,11,.2)'};border-radius:var(--r2);padding:10px;margin-bottom:12px;font-size:12px">Opening Balance: ${fmt(o.openingBalance)} — <strong>${o.balanceStatus==='approved'?'✅ Approved':o.balanceStatus==='rejected'?'❌ Rejected':'⏳ Pending Admin Approval'}</strong></div>`:''}
    ${o.address?`<div style="background:var(--s2);border-radius:var(--r2);padding:10px;margin-bottom:12px;font-size:12px;color:var(--tx2)">📍 ${o.address}</div>`:''}

    <div id="odList"></div>
  `;
  _odTab(led.pending.length?'pending':'orders');
  openM('mOutletDetail');
}

// ── Outlet statement: what each order still owes ──
// An order counts for its delivered value less returns (same as dues).
// Payments tied to an order (delivery payments) go to that order first;
// the rest pay off the oldest orders (and the opening balance) first.
function outletLedger(orders, cols, opening) {
  const r2=v=>Math.round(v*100)/100;
  const due=o=>Math.max(0,(o.deliveredTotal!=null?Number(o.deliveredTotal):Number(o.total)||0)-(Number(o.returnedTotal)||0));
  const day=o=>o.date||(typeof o.createdAt==='string'?o.createdAt.slice(0,10):'');
  const live=orders.filter(o=>o.status!=='Cancelled'&&!o.appDeleted).sort((a,b)=>String(day(a)).localeCompare(String(day(b))));
  const lines=live.map(o=>({o,amount:r2(due(o)),paid:0}));
  if(opening>0) lines.unshift({opening:true,amount:r2(opening),paid:0});
  let free=0;
  for(const c of cols){
    const amt=Number(c.amount)||0; if(amt<=0) continue;
    const ln=c.orderId&&lines.find(l=>l.o&&(l.o.id===c.orderId||l.o._docId===c.orderId||l.o._docId===c.orderDocId));
    if(ln){const take=Math.min(amt,ln.amount-ln.paid);ln.paid+=take;free+=amt-take;} else free+=amt;
  }
  for(const ln of lines){ if(free<=0)break; const take=Math.min(free,ln.amount-ln.paid); ln.paid+=take; free-=take; }
  lines.forEach(l=>{l.paid=r2(l.paid);l.balance=r2(l.amount-l.paid);});
  const sales=r2(live.reduce((s,o)=>s+due(o),0)), paid=r2(cols.reduce((s,c)=>s+(Number(c.amount)||0),0));
  return {
    sales, paid, outstanding:r2(Math.max(0,sales+opening-paid)), credit:r2(free),
    orders:[...lines].filter(l=>l.o).reverse(),
    pending:lines.filter(l=>l.balance>0.009),
    payments:[...cols].sort((a,b)=>String(b.date||'').localeCompare(String(a.date||''))),
  };
}

const _OD_BADGE={Delivered:'grn',Pending:'ylw',Cancelled:'red',Failed:'red'};
function _odTab(tab){
  const L=window.__odLedger; const box=document.getElementById('odList'); if(!L||!box) return;
  document.querySelectorAll('#mOutletDetail .od-stat').forEach(b=>b.classList.toggle('on',b.dataset.tab===tab));
  const today=new Date();
  const ordRow=(l,showBal)=>{
    if(l.opening) return `<div class="od-row"><div style="flex:1"><div style="font-weight:700">Opening balance</div><div class="od-sub">Before the app</div></div>
      <div style="text-align:right"><div style="font-weight:800;color:var(--red)">${fmt(l.balance)}</div><div class="od-sub">of ${fmt(l.amount)}</div></div></div>`;
    const o=l.o, d=o.date||'', age=d?Math.max(0,Math.floor((today-new Date(d+'T00:00'))/86400000)):null;
    return `<div class="od-row" onclick="viewOrder('${o._docId}')" role="button">
      <div style="flex:1;min-width:0"><div style="font-weight:700;font-size:12px">${escH(o.invoiceNo||o.id||o._docId)} <span class="bdg bdg-${_OD_BADGE[o.status]||'blu'}" style="font-size:9px">${escH(o.status||'')}</span></div>
        <div class="od-sub">${escH(d||'—')}${showBal&&age!=null?` · ${age} day${age===1?'':'s'}`:''}${o.paymentMethod?` · ${escH(o.paymentMethod)}`:''}</div></div>
      <div style="text-align:right">${showBal
        ?`<div style="font-weight:800;color:var(--red)">${fmt(l.balance)}</div><div class="od-sub">${l.paid>0?`paid ${fmt(l.paid)} of `:''}${fmt(l.amount)}</div>`
        :`<div style="font-weight:800;color:var(--acc)">${fmt(l.amount)}</div><div class="od-sub">${l.balance>0.009?`<span style="color:var(--red)">due ${fmt(l.balance)}</span>`:'✅ paid'}</div>`}</div>
      <span style="color:var(--tx3);font-size:16px">›</span></div>`;
  };
  const head=t=>`<div style="font-size:11px;color:var(--tx3);font-weight:700;margin:2px 0 8px;letter-spacing:.5px">${t}</div>`;
  if(tab==='pending') box.innerHTML=head(`PENDING PAYMENT · ${L.pending.length} · ${fmt(L.outstanding)}`)+(L.pending.map(l=>ordRow(l,true)).join('')||'<div class="od-empty">Nothing outstanding ✅</div>')
    +(L.credit>0.009?`<div class="od-sub" style="margin-top:8px">Paid in advance: ${fmt(L.credit)}</div>`:'');
  else if(tab==='payments') box.innerHTML=head(`PAYMENTS · ${L.payments.length} · ${fmt(L.paid)}`)+(L.payments.map(c=>`<div class="od-row">
      <div style="flex:1;min-width:0"><div style="font-weight:700;font-size:12px">${escH(c.mode||c.method||'Payment')}${c.source==='delivery'?' · 🚚 on delivery':''}</div>
        <div class="od-sub">${escH(c.date||'—')}${c.createdByName?' · '+escH(c.createdByName):''}${c.orderId?' · '+escH(c.orderId):''}${c.paymentRef?' · ref '+escH(c.paymentRef):''}</div></div>
      <div style="font-weight:800;color:var(--grn)">${fmt(c.amount)}</div></div>`).join('')||'<div class="od-empty">No payments yet</div>');
  else box.innerHTML=head(`ORDER HISTORY · ${L.orders.length}`)+(L.orders.map(l=>ordRow(l,false)).join('')||'<div class="od-empty">No orders yet</div>');
}

