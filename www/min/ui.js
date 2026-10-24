function _customConfirm(e,{title:s="Confirm",okText:r="OK",cancelText:n="Cancel",danger:o=!1,icon:d="\u2753"}={}){return new Promise(l=>{document.getElementById("_customConfirmModal")?.remove();const t=document.createElement("div");t.id="_customConfirmModal",t.style.cssText=["position:fixed","inset:0","z-index:99999","display:flex","align-items:center","justify-content:center","background:rgba(0,0,0,0.5)","backdrop-filter:blur(3px)","padding:20px","box-sizing:border-box"].join(";"),t.innerHTML=`
      <div style="
        background:var(--bg,#fff);border-radius:18px;padding:28px 22px 20px;
        max-width:320px;width:100%;box-shadow:0 12px 40px rgba(0,0,0,0.22);
        font-family:'Syne',sans-serif;text-align:center;
        animation:_ccSlide .18s cubic-bezier(.34,1.56,.64,1) both;
      ">
        <div style="font-size:36px;margin-bottom:10px;line-height:1">${d}</div>
        <div style="font-size:15px;font-weight:700;color:var(--tx,#111);margin-bottom:8px">${s}</div>
        <div style="font-size:13px;color:var(--tx2,#666);line-height:1.65;margin-bottom:22px;white-space:pre-line">${e}</div>
        <div style="display:flex;gap:10px">
          <button id="_ccCancel" style="
            flex:1;padding:12px 8px;border-radius:10px;
            border:1px solid var(--bdr,#ddd);background:var(--s2,#f4f4f4);
            color:var(--tx2,#555);font-size:13px;font-weight:600;cursor:pointer;
            font-family:'Syne',sans-serif;
          ">${n}</button>
          <button id="_ccOk" style="
            flex:1;padding:12px 8px;border-radius:10px;border:none;
            background:${o?"linear-gradient(135deg,#ef4444,#b91c1c)":"linear-gradient(135deg,#22c55e,#15803d)"};
            color:#fff;font-size:13px;font-weight:700;cursor:pointer;
            font-family:'Syne',sans-serif;
          ">${r}</button>
        </div>
      </div>
      <style>
        @keyframes _ccSlide {
          from { transform:translateY(24px) scale(.97); opacity:0; }
          to   { transform:translateY(0)     scale(1);   opacity:1; }
        }
      </style>`,document.body.appendChild(t);const i=a=>{t.remove(),l(a)};t.querySelector("#_ccOk").onclick=()=>i(!0),t.querySelector("#_ccCancel").onclick=()=>i(!1),t.addEventListener("click",a=>{a.target===t&&i(!1)})})}let clockIv;function startClock(){clearInterval(clockIv),clockIv=setInterval(()=>{const e=new Date,s=e.toLocaleTimeString("en-US",{hour12:!1});document.getElementById("liveClock").textContent=s;const r=document.getElementById("attClk");r&&(r.textContent=s);const n=document.getElementById("attDateStr");n&&(n.textContent=e.toLocaleDateString("en-US",{weekday:"long",year:"numeric",month:"long",day:"numeric"})),updateLiveHours()},1e3)}const PAGE_META={dashboard:{title:"Dashboard",sub:"Overview of your sales performance"},attendance:{title:"Attendance",sub:"Daily check-in / check-out with selfie"},orders:{title:"Orders",sub:"Manage customer orders"},outlets:{title:"Outlets",sub:"Manage customer outlets"},routes:{title:"Routes",sub:"Manage delivery routes \u2014 outlets must belong to a route"},collection:{title:"Collection",sub:"Track payment collections"},reports:{title:"Reports",sub:"Analytics & business insights"},users:{title:"Users",sub:"Manage sales representatives & admins"},products:{title:"Products",sub:"Manage product catalogue, stock & pricing"},delivery:{title:"My Deliveries",sub:"Orders assigned to you for delivery"},deliveries:{title:"Delivery Management",sub:"Assign and track all deliveries"},monitoring:{title:"Rep Monitoring",sub:"Track rep activity, NP visits, orders & attendance"},zones:{title:"Zone Management",sub:"Manage zones \u2014 scope data access by region or territory"},outletstructure:{title:"Outlet Structure",sub:"Sales rep \u2192 route \u2192 outlets hierarchy"}};function goPage(e){if((e==="users"||e==="products")&&!isAdmin()){showToast("Access denied","error");return}if(e==="deliveries"&&!isAdmin()){showToast("Access denied","error");return}if(e==="delivery"&&CU.role!=="delivery_man"&&!isAdmin()){showToast("Access denied","error");return}if(!isOwner()&&!CU.zoneId&&e!=="dashboard"&&e!=="zones"){showToast("You have no zone assigned. Contact the Owner.","error");return}try{sessionStorage.setItem("stfm_lastPage",e)}catch{}document.querySelectorAll(".page").forEach(o=>o.classList.remove("active")),document.querySelectorAll(".nitem").forEach(o=>o.classList.remove("active"));const s=document.getElementById("page"+e.charAt(0).toUpperCase()+e.slice(1));s&&s.classList.add("active");const n=[...document.querySelectorAll(".nitem")].find(o=>o.textContent.toLowerCase().trim().startsWith(e.slice(0,4)));n&&n.classList.add("active"),document.getElementById("tbTitle").textContent=PAGE_META[e]?.title||e,document.getElementById("tbSub").textContent=PAGE_META[e]?.sub||"",e==="dashboard"&&renderDashboard(),e==="attendance"&&(checkTodayAttendance(),loadAttHistory()),e==="orders"&&loadOrders(),e==="outlets"&&loadOutlets(),e==="routes"&&loadRoutes(),e==="collection"&&loadCollections(),e==="reports"&&renderReports(),e==="users"&&loadUsers(),e==="products"&&loadProducts(),e==="delivery"&&loadMyDeliveries(),e==="deliveries"&&loadDeliveries(),e==="monitoring"&&loadMonitoring(),e==="outletstructure"&&loadOutletStructure(),e==="zones"&&loadZones(),_updateOwnerZoneBar(e),closeSidebar()}function openM(e){document.getElementById(e).classList.add("show")}function closeM(e){document.getElementById(e).classList.remove("show")}function openSidebar(){document.getElementById("sidebar").classList.add("open"),document.getElementById("sidebarBackdrop").classList.add("show"),document.body.style.overflow="hidden"}function closeSidebar(){document.getElementById("sidebar").classList.remove("open"),document.getElementById("sidebarBackdrop").classList.remove("show"),document.body.style.overflow=""}
