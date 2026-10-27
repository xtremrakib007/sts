// ═══════════════ CUSTOM CONFIRM MODAL (replaces all native confirm() dialogs) ═══════════════
function _customConfirm(message, { title = 'Confirm', okText = 'OK', cancelText = 'Cancel', danger = false, icon = '❓' } = {}) {
  return new Promise((resolve) => {
    document.getElementById('_customConfirmModal')?.remove();
    const modal = document.createElement('div');
    modal.id = '_customConfirmModal';
    modal.style.cssText = [
      'position:fixed','inset:0','z-index:99999',
      'display:flex','align-items:center','justify-content:center',
      'background:rgba(0,0,0,0.5)','backdrop-filter:blur(3px)',
      'padding:20px','box-sizing:border-box'
    ].join(';');
    modal.innerHTML = `
      <div style="
        background:var(--bg,#fff);border-radius:18px;padding:28px 22px 20px;
        max-width:320px;width:100%;box-shadow:0 12px 40px rgba(0,0,0,0.22);
        font-family:'Syne',sans-serif;text-align:center;
        animation:_ccSlide .18s cubic-bezier(.34,1.56,.64,1) both;
      ">
        <div style="font-size:36px;margin-bottom:10px;line-height:1">${icon}</div>
        <div style="font-size:15px;font-weight:700;color:var(--tx,#111);margin-bottom:8px">${title}</div>
        <div style="font-size:13px;color:var(--tx2,#666);line-height:1.65;margin-bottom:22px;white-space:pre-line">${message}</div>
        <div style="display:flex;gap:10px">
          <button id="_ccCancel" style="
            flex:1;padding:12px 8px;border-radius:10px;
            border:1px solid var(--bdr,#ddd);background:var(--s2,#f4f4f4);
            color:var(--tx2,#555);font-size:13px;font-weight:600;cursor:pointer;
            font-family:'Syne',sans-serif;
          ">${cancelText}</button>
          <button id="_ccOk" style="
            flex:1;padding:12px 8px;border-radius:10px;border:none;
            background:${danger ? 'linear-gradient(135deg,#ef4444,#b91c1c)' : 'linear-gradient(135deg,#22c55e,#15803d)'};
            color:#fff;font-size:13px;font-weight:700;cursor:pointer;
            font-family:'Syne',sans-serif;
          ">${okText}</button>
        </div>
      </div>
      <style>
        @keyframes _ccSlide {
          from { transform:translateY(24px) scale(.97); opacity:0; }
          to   { transform:translateY(0)     scale(1);   opacity:1; }
        }
      </style>`;
    document.body.appendChild(modal);
    const cleanup = (result) => { modal.remove(); resolve(result); };
    modal.querySelector('#_ccOk').onclick     = () => cleanup(true);
    modal.querySelector('#_ccCancel').onclick  = () => cleanup(false);
    modal.addEventListener('click', e => { if (e.target === modal) cleanup(false); });
  });
}

// ═══════════════ CLOCK ═══════════════
let clockIv;
function startClock() {
  clearInterval(clockIv);
  clockIv = setInterval(()=>{
    const now=new Date();
    const ts=now.toLocaleTimeString('en-US',{hour12:false});
    document.getElementById('liveClock').textContent=ts;
    const ae=document.getElementById('attClk');
    if(ae)ae.textContent=ts;
    const ad=document.getElementById('attDateStr');
    if(ad)ad.textContent=now.toLocaleDateString('en-US',{weekday:'long',year:'numeric',month:'long',day:'numeric'});
    updateLiveHours();
  },1000);
}

// ═══════════════ PAGE NAV ═══════════════
const PAGE_META={
  dashboard:{title:'Dashboard',sub:'Overview of your sales performance'},
  attendance:{title:'Attendance',sub:'Daily check-in / check-out with selfie'},
  orders:{title:'Orders',sub:'Manage customer orders'},
  outlets:{title:'Outlets',sub:'Manage customer outlets'},
  routes:{title:'Routes',sub:'Manage delivery routes — outlets must belong to a route'},
  collection:{title:'Collection',sub:'Track payment collections'},
  reports:{title:'Reports',sub:'Analytics & business insights'},
  users:{title:'Users',sub:'Manage sales representatives & admins'},
  products:{title:'Products',sub:'Manage product catalogue, stock & pricing'},
  delivery:{title:'My Deliveries',sub:'Orders assigned to you for delivery'},
  deliveries:{title:'Delivery Management',sub:'Assign and track all deliveries'},
  monitoring:{title:'Rep Monitoring',sub:'Track rep activity, NP visits, orders & attendance'},
  zones:{title:'Zone Management',sub:'Manage zones — scope data access by region or territory'},
  outletstructure:{title:'Outlet Structure',sub:'Sales rep → route → outlets hierarchy'},
};
function goPage(pg) {
  if((pg==='users'||pg==='products')&&!isAdmin()){showToast('Access denied','error');return;}
  if(pg==='deliveries'&&!isAdmin()){showToast('Access denied','error');return;}
  if(pg==='delivery'&&CU.role!=='delivery_man'&&!isAdmin()){showToast('Access denied','error');return;}
  // Zone guard: non-owner without zone can only access zones page + dashboard
  if(!isOwner()&&!CU.zoneId&&pg!=='dashboard'&&pg!=='zones'){
    showToast('You have no zone assigned. Contact the Owner.','error');return;
  }
  // ★ Persist last page across accidental exits
  try{sessionStorage.setItem('stfm_lastPage',pg);}catch(e){}
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.nitem').forEach(n=>n.classList.remove('active'));
  const pel=document.getElementById('page'+pg.charAt(0).toUpperCase()+pg.slice(1));
  if(pel)pel.classList.add('active');
  const nitems=[...document.querySelectorAll('.nitem')];
  const ni=nitems.find(n=>{const t=n.textContent.toLowerCase().trim();return t.startsWith(pg.slice(0,4));});
  if(ni)ni.classList.add('active');
  document.getElementById('tbTitle').textContent=PAGE_META[pg]?.title||pg;
  document.getElementById('tbSub').textContent=PAGE_META[pg]?.sub||'';
  if(pg==='dashboard')renderDashboard();
  if(pg==='attendance'){checkTodayAttendance();loadAttHistory();}
  if(pg==='orders')loadOrders();
  if(pg==='outlets')loadOutlets();
  if(pg==='routes')loadRoutes();
  if(pg==='collection')loadCollections();
  if(pg==='reports')renderReports();
  if(pg==='users')loadUsers();
  if(pg==='products')loadProducts();
  if(pg==='delivery')loadMyDeliveries();
  if(pg==='deliveries')loadDeliveries();
  if(pg==='monitoring')loadMonitoring();
  if(pg==='outletstructure')loadOutletStructure();
  if(pg==='zones')loadZones();
  // Update zone bar visibility for owner
  _updateOwnerZoneBar(pg);
  // close mobile sidebar
  closeSidebar();
}

function openM(id){const el=document.getElementById(id);if(!el)return;el.style.removeProperty('display');el.classList.add('show');}
function closeM(id){const el=document.getElementById(id);if(!el)return;el.classList.remove('show');el.style.setProperty('display','none');}

function openSidebar(){
  document.getElementById('sidebar').classList.add('open');
  document.getElementById('sidebarBackdrop').classList.add('show');
  document.body.style.overflow='hidden';
}
function closeSidebar(){
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebarBackdrop').classList.remove('show');
  document.body.style.overflow='';
}

// ═══════════════ ANDROID BACK BUTTON (Capacitor) ═══════════════
window.addEventListener('load',()=>{
  if(!window.Capacitor?.isNativePlatform?.())return;
  const {App}=window.Capacitor.Plugins;
  App.addListener('backButton',()=>{
    // If a modal is open, close it first
    const openModal=document.querySelector('.modal.show,.moverlay.show');
    if(openModal){openModal.classList.remove('show');return;}
    // If sidebar is open, close it
    if(document.getElementById('sidebar')?.classList.contains('open')){closeSidebar();return;}
    // If not on dashboard, go back to dashboard
    const activePage=document.querySelector('.page.active');
    if(activePage&&activePage.id!=='pageDashboard'){goPage('dashboard');return;}
    // On dashboard — do nothing (prevent app close)
  });
});

