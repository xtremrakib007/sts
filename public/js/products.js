// ═══════════════ PRODUCTS ═══════════════
// ═══════════════ ZONE PRODUCT PRICE OVERRIDE ═══════════════

// Owner can set overrides for any specific zone when viewing it via zone filter
async function openZonePriceOverrideForZone(productId, zoneId) {
  const p=allProducts.find(x=>x.id===productId);
  if(!p)return;
  let ov={};
  try{
    const s=await window.__SF.getDoc(window.__SF.doc(db(),`zones/${zoneId}/productOverrides/${productId}`));
    if(s.exists())ov=s.data();
  }catch(e){}
  const zName=(allZones.find(z=>z.id===zoneId)||{}).name||zoneId;
  document.getElementById('zpoProductId').value=productId+'|'+zoneId; // encode zoneId
  document.getElementById('zpoProductName').textContent=p.name+' ('+zName+')';
  document.getElementById('zpoBasePrice').textContent=`Master price: ${fmt(p.price)}`;
  document.getElementById('zpoPrice').value=ov.price??p.price??'';
  document.getElementById('zpoCost').value=ov.cost??p.cost??'';
  document.getElementById('zpoStock').value=ov.stockStatus??p.stockStatus??'in_stock';
  openM('mZonePriceOverride');
}

async function openZonePriceOverride(productId) {
  if(!isAdmin()||isOwner())return;
  const p=allProducts.find(x=>x.id===productId);
  if(!p){showToast('Product not found','error');return;}
  let ov={};
  try{
    const s=await window.__SF.getDoc(window.__SF.doc(db(),`zones/${CU.zoneId}/productOverrides/${productId}`));
    if(s.exists())ov=s.data();
  }catch(e){}
  document.getElementById('zpoProductId').value=productId;
  document.getElementById('zpoProductName').textContent=p.name;
  document.getElementById('zpoBasePrice').textContent=`Master price: ${fmt(p.price)}`;
  document.getElementById('zpoPrice').value=ov.price??p.price??'';
  document.getElementById('zpoCost').value=ov.cost??p.cost??'';
  document.getElementById('zpoStock').value=ov.stockStatus??p.stockStatus??'in_stock';
  openM('mZonePriceOverride');
}

async function saveZonePriceOverride() {
  const rawId=document.getElementById('zpoProductId').value;
  // rawId may be "productId" or "productId|zoneId" (when owner sets for a specific zone)
  const [productId, encodedZone] = rawId.includes('|') ? rawId.split('|') : [rawId, null];
  const zid = encodedZone || CU.zoneId;
  const price=parseFloat(document.getElementById('zpoPrice').value);
  const cost=parseFloat(document.getElementById('zpoCost').value)||0;
  const stockStatus=document.getElementById('zpoStock').value;
  if(!productId){showToast('Error: no product','error');return;}
  if(!zid){showToast('Error: no zone','error');return;}
  if(!price||price<=0){showToast('Enter a valid price','error');return;}
  try{
    const now=new Date().toISOString();
    const ovRef=window.__SF.doc(db(),`zones/${zid}/productOverrides/${productId}`);
    await window.__SF.setDoc(ovRef,{price,cost,stockStatus,updatedAt:now,updatedBy:CU.uid,updatedByName:CU.name},{merge:true});
    const zpRef=window.__SF.doc(db(),`zones/${zid}/products/${productId}`);
    await window.__SF.setDoc(zpRef,{price,cost,stockStatus,updatedAt:now},{merge:true});
    showToast('Zone price saved ✅','success');
    closeM('mZonePriceOverride');
    invalidateCache();await loadCachedData(true);loadProducts();
  }catch(e){showToast('Save failed: '+e.message,'error');}
}

async function clearZonePriceOverride() {
  const rawId=document.getElementById('zpoProductId').value;
  const [productId, encodedZone] = rawId.includes('|') ? rawId.split('|') : [rawId, null];
  const zid = encodedZone || CU.zoneId;
  if(!productId||!zid)return;
  if(!confirm('Remove zone override? Product will use master catalog price/stock.'))return;
  try{
    await window.__SF.deleteDoc(window.__SF.doc(db(),`zones/${zid}/productOverrides/${productId}`));
    const master=allProducts.find(x=>x.id===productId);
    if(master){
      const zpRef=window.__SF.doc(db(),`zones/${zid}/products/${productId}`);
      await window.__SF.setDoc(zpRef,{price:master.price,cost:master.cost||0,stockStatus:master.stockStatus||'in_stock'},{merge:true});
    }
    showToast('Zone override removed','info');
    closeM('mZonePriceOverride');
    invalidateCache();await loadCachedData(true);loadProducts();
  }catch(e){showToast('Error: '+e.message,'error');}
}

// ═══════════════ MERGE DUPLICATE PRODUCTS ═══════════════

let _mergeGroups=[];

async function openMergeProducts() {
  if(!isAdmin()){showToast('Admin only','error');return;}
  const body=document.getElementById('mMergeBody');
  if(!body)return;
  body.innerHTML='<div style="text-align:center;padding:30px;color:var(--tx3)">🔍 Scanning for duplicate products…</div>';
  openM('mMergeProducts');
  await scanMergeProducts();
}

async function scanMergeProducts() {
  const body = document.getElementById('mMergeBody');
  try {
    // ── Step 1: collect all products from root + zone subcollections ──────────
    // Key: docId → best product data. We track all sources per doc ID.
    const rootMap  = {}; // docId → data (from root products)
    const zoneMap  = {}; // "zoneId::docId" → data (from zone subcollections, legacy)

    // Fire root + ALL zone reads simultaneously
    const zonesToScan = isOwner() ? allZones : allZones.filter(z => z.id === CU.zoneId);
    const [rootSnap, ...zoneSnaps] = await Promise.all([
      window.__SF.getDocs(rootCol('products')),
      ...zonesToScan.map(z =>
        window.__SF.getDocs(window.__SF.collection(db(), `zones/${z.id}/products`))
          .catch(() => ({ docs: [] }))
      )
    ]);
    rootSnap.docs.forEach(d => {
      rootMap[d.id] = { id: d.id, ...d.data(), _source: 'root' };
    });
    zoneSnaps.forEach((zSnap, zi) => {
      const z = zonesToScan[zi];
      (zSnap.docs || []).forEach(d => {
        if (!rootMap[d.id]) {
          const key = `${z.id}::${d.id}`;
          zoneMap[key] = { id: d.id, ...d.data(), _source: 'zone', _zoneId: z.id, _zoneName: z.name || z.id, _legacyKey: key };
        }
      });
    });

    // ── Step 2: merge into one pool and group by normalised name ──────────────
    const allPool = [...Object.values(rootMap), ...Object.values(zoneMap)];
    const byName  = {};
    allPool.forEach(p => {
      const k = (p.name || '').toLowerCase().trim();
      if (!byName[k]) byName[k] = [];
      byName[k].push(p);
    });

    // ── Step 3: keep only groups with more than one distinct doc ──────────────
    _mergeGroups = Object.entries(byName)
      .filter(([, g]) => g.length > 1)
      .map(([name, group]) => ({ name, group }));

    if (!_mergeGroups.length) {
      body.innerHTML = `<div style="text-align:center;padding:30px;color:var(--tx3)">
        ✅ No duplicate products found.<br>
        <span style="font-size:11px">Scanned ${allPool.length} product(s) across root catalog${zonesToScan.length ? ' + ' + zonesToScan.length + ' zone(s)' : ''}.</span>
      </div>`;
      return;
    }

    // ── Step 4: render picker UI ──────────────────────────────────────────────
    body.innerHTML = `
      <div style="font-size:12px;color:var(--tx2);margin-bottom:14px">
        Found <strong>${_mergeGroups.length}</strong> duplicate group(s) across ${allPool.length} total products.
        Select the <strong>master</strong> to keep for each group — others will be removed and their zone pricing preserved as overrides.
      </div>
      ${_mergeGroups.map((g, gi) => `
        <div style="background:var(--s2);border:1px solid var(--bdr);border-radius:10px;padding:14px;margin-bottom:12px">
          <div style="font-family:'Syne',sans-serif;font-size:13px;font-weight:700;margin-bottom:10px">
            📦 ${g.name}
            <span style="font-size:10px;color:var(--tx3);font-weight:400">(${g.group.length} copies)</span>
          </div>
          ${g.group.map((p, pi) => `
            <label style="display:flex;align-items:center;gap:10px;padding:8px;border-radius:8px;border:1px solid var(--bdr);background:var(--s1);margin-bottom:6px;cursor:pointer">
              <input type="radio" name="mg_${gi}" value="${pi}" ${pi === 0 ? 'checked' : ''} style="accent-color:var(--acc);flex-shrink:0">
              <div style="flex:1;min-width:0">
                <div style="font-size:12px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${p.name}</div>
                <div style="font-size:10px;color:var(--tx3)">
                  ${p._source === 'root' ? '🌐 Global Catalog' : '📍 Zone: ' + p._zoneName}
                  · RM ${(p.price || 0).toFixed(2)} · ${p.stockStatus === 'out_of_stock' ? '❌ Out of Stock' : '✅ In Stock'}
                  ${p.sku ? '· SKU: ' + p.sku : ''}
                </div>
              </div>
              <span style="font-size:10px;font-weight:700;padding:2px 6px;border-radius:4px;background:${p._source === 'root' ? 'rgba(34,197,94,0.15)' : 'rgba(245,158,11,0.15)'};color:${p._source === 'root' ? 'var(--grn)' : 'var(--ylw)'}">
                ${p._source === 'root' ? '✅ Global' : '⚠️ Zone only'}
              </span>
            </label>
          `).join('')}
        </div>
      `).join('')}
      <div style="display:flex;justify-content:flex-end;padding-top:4px">
        <button class="btn btn-primary btn-sm" onclick="executeMergeAll()">🔀 Merge All Groups</button>
      </div>`;

  } catch(e) {
    body.innerHTML = `<div style="text-align:center;padding:24px;color:var(--red)">❌ Error scanning products: ${e.message}</div>`;
    console.error('[scanMergeProducts]', e);
  }
}

async function executeMergeAll() {
  if (!isAdmin()) return;
  const body = document.getElementById('mMergeBody');

  // Snapshot radio selections BEFORE touching DOM
  const keepIdxByGroup = _mergeGroups.map((_, gi) => {
    const sel = document.querySelector(`input[name="mg_${gi}"]:checked`);
    return sel ? parseInt(sel.value) : 0;
  });

  const total = _mergeGroups.length;
  let merged = 0, errors = 0;

  body.innerHTML = `
    <div style="padding:8px 0">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <span style="font-size:13px;font-weight:600;color:var(--tx2)" id="_mpLabel">Building merge plan…</span>
        <span style="font-size:12px;font-weight:700;color:var(--acc)" id="_mpPct">0%</span>
      </div>
      <div style="background:var(--s2);border-radius:20px;height:10px;overflow:hidden;border:1px solid var(--bdr);margin-bottom:8px">
        <div id="_mpBar" style="height:100%;background:linear-gradient(90deg,var(--acc),#15803d);border-radius:20px;width:0%;transition:width .15s ease"></div>
      </div>
      <div style="font-size:11px;color:var(--tx3);text-align:center" id="_mpSub">0 / ${total} groups</div>
    </div>`;

  const setProgress = (done, label) => {
    const pct = Math.round((done / total) * 100);
    const g = id => document.getElementById(id);
    if(g('_mpBar')) g('_mpBar').style.width = pct + '%';
    if(g('_mpPct')) g('_mpPct').textContent = pct + '%';
    if(g('_mpLabel')) g('_mpLabel').textContent = label || 'Merging…';
    if(g('_mpSub')) g('_mpSub').textContent = `${done} / ${total} groups`;
  };

  // Phase 1: promote zone-only masters to root (sequential — creates new IDs)
  const canonicalIds = new Array(total);
  const now = new Date().toISOString();
  for (let gi = 0; gi < total; gi++) {
    const master = _mergeGroups[gi].group[keepIdxByGroup[gi]];
    if (master._source === 'root') {
      canonicalIds[gi] = master.id;
    } else {
      try {
        const { id: _x, _source, _zoneId, _zoneName, _legacyKey, ...masterData } = master;
        const newRef = window.__SF.doc(window.__SF.collection(db(), 'products'));
        await window.__SF.setDoc(newRef, { ...masterData, promotedAt: now });
        canonicalIds[gi] = newRef.id;
      } catch(e) { console.error('[promote]', gi, e); canonicalIds[gi] = master.id; errors++; }
    }
    if (gi % 20 === 0) { setProgress(0, `Promoting masters… ${gi}/${total}`); await new Promise(r=>setTimeout(r,0)); }
  }

  setProgress(0, 'Writing batches…');
  await new Promise(r => setTimeout(r, 0));

  // Phase 2: batch all overrides + deletes (Firestore writeBatch = 1 round-trip per 400 ops)
  const MAX_BATCH = 400;
  let batch = window.__SF.writeBatch(db());
  let batchOps = 0, batchCount = 0;

  const flushBatch = async () => {
    if (!batchOps) return;
    await batch.commit();
    batchCount++;
    batch = window.__SF.writeBatch(db());
    batchOps = 0;
    await new Promise(r => setTimeout(r, 0)); // yield to browser per batch
  };

  for (let gi = 0; gi < total; gi++) {
    const g = _mergeGroups[gi];
    const master = g.group[keepIdxByGroup[gi]];
    const dupes = g.group.filter((_, i) => i !== keepIdxByGroup[gi]);
    const canonicalId = canonicalIds[gi];
    try {
      for (const dup of dupes) {
        if (dup._zoneId) {
          batch.set(
            window.__SF.doc(db(), `zones/${dup._zoneId}/productOverrides/${canonicalId}`),
            { price: dup.price ?? master.price, cost: dup.cost ?? 0,
              stockStatus: dup.stockStatus ?? 'in_stock', mergedFrom: dup.id, mergedAt: now },
            { merge: true }
          );
          batch.delete(window.__SF.doc(db(), `zones/${dup._zoneId}/products/${dup.id}`));
          batchOps += 2;
        } else {
          batch.delete(window.__SF.doc(db(), 'products', dup.id));
          batchOps++;
        }
        if (batchOps >= MAX_BATCH) await flushBatch();
      }
      merged++;
    } catch(e) { console.error('[batch build]', gi, e); errors++; }
    if (gi % 50 === 0) { setProgress(gi, `Batching… ${batchCount} committed`); }
  }
  try { await flushBatch(); } catch(e) { console.error('[flush]', e); errors++; }

  setProgress(total, 'Done!');
  invalidateCache();

  body.innerHTML = `
    <div style="text-align:center;padding:30px">
      <div style="font-size:36px;margin-bottom:12px">${errors ? '⚠️' : '✅'}</div>
      <div style="font-family:'Syne',sans-serif;font-size:16px;font-weight:700;margin-bottom:8px">Merge Complete</div>
      <div style="font-size:12px;color:var(--tx2);line-height:1.6">
        ${merged} group(s) merged · ${batchCount} Firestore batch(es)${errors ? ` · ${errors} error(s)` : ''}.<br>
        Zone pricing preserved as overrides.
      </div>
      <button class="btn btn-primary btn-sm" style="margin-top:16px"
        onclick="closeM('mMergeProducts');loadCachedData(true).then(loadProducts)">✓ Done</button>
    </div>`;
}


async function loadProducts() {
  if(!isAdmin()){showToast('Access denied','error');return;}
  // Role-based toolbar
  const _mb=document.getElementById('btnMergeProducts');
  const _ab=document.getElementById('btnAddProduct');
  const _zb=document.getElementById('zoneProductBanner');
  if(_mb) _mb.style.display='';           // visible for all admins
  if(_ab) _ab.style.display=isOwner()?'':'none'; // only owner adds to global catalog
  if(_zb) _zb.style.display=(!isOwner()&&CU.zoneId)?'':'none';
  // Force fresh: ensures zone overrides for the current zone filter are applied
  await loadCachedData(true);
  const srch=(document.getElementById('prodSrch')?.value||'').toLowerCase();
  const catF=document.getElementById('prodCatFilter')?.value||'';
  const stockF=document.getElementById('prodStockFilter')?.value||'';
  const cats=[...new Set(allProducts.map(p=>p.category).filter(Boolean))].sort();
  const catSel=document.getElementById('prodCatFilter');
  if(catSel){const prev=catSel.value;catSel.innerHTML='<option value="">All Categories</option>'+cats.map(c=>`<option value="${c}">${c}</option>`).join('');catSel.value=prev;}
  const dl=document.getElementById('catList');
  if(dl)dl.innerHTML=cats.map(c=>`<option value="${c}">`).join('');
  let prods=allProducts.filter(p=>{
    const ms=!srch||p.name.toLowerCase().includes(srch)||(p.sku||'').toLowerCase().includes(srch)||(p.category||'').toLowerCase().includes(srch);
    const mc=!catF||p.category===catF;
    const mst=!stockF||p.stockStatus===stockF;
    return ms&&mc&&mst;
  });
  const grid=document.getElementById('productsGrid');
  if(!prods.length){
    grid.innerHTML=`<div style="grid-column:1/-1;color:var(--tx3);font-size:13px;padding:30px;text-align:center">${allProducts.length?'No products match filters.':'No products yet. Add your first product or import via CSV.'}</div>`;
    return;
  }
  grid.innerHTML=prods.map(p=>{
    const inStock=p.stockStatus!=='out_of_stock';
    const imgHtml=p.photo?`<img src="${p.photo}" style="width:100%;height:110px;object-fit:cover;border-radius:10px 10px 0 0;display:block" alt="${p.name}">`
      :`<div style="width:100%;height:110px;background:var(--s2);border-radius:10px 10px 0 0;display:flex;align-items:center;justify-content:center;font-size:40px">📦</div>`;
    return`<div style="background:var(--s1);border:1px solid var(--bdr);border-radius:var(--r);overflow:hidden;transition:var(--tr)" class="scard">
      <div style="position:relative">${imgHtml}<div style="position:absolute;top:7px;right:7px"><span class="bdg ${inStock?'bdg-grn':'bdg-red'}" style="font-size:10px">${inStock?'In Stock':'Out of Stock'}</span></div></div>
      <div style="padding:12px">
        <div style="font-family:'Syne',sans-serif;font-size:13px;font-weight:700;margin-bottom:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${p.name}</div>
        ${p.category?`<div style="font-size:10px;color:var(--tx3);margin-bottom:6px">${p.category}${p.unit?' · '+p.unit:''}</div>`:''}
        ${p.sku?`<div style="font-size:10px;color:var(--tx3);margin-bottom:4px">SKU: ${p.sku}</div>`:''}
        <div style="display:flex;justify-content:space-between;align-items:center;margin-top:8px">
          <div style="font-family:'Syne',sans-serif;font-size:16px;font-weight:800;color:var(--acc)">${fmt(p.price)}</div>
          ${p.cost?`<div style="font-size:10px;color:var(--tx3)">Cost: ${fmt(p.cost)}</div>`:''}
        </div>
        <div style="display:flex;gap:6px;margin-top:10px">
          ${isOwner() && !_ownerZoneFilter
            ? `<button class="btn btn-ghost btn-xs" style="flex:1" onclick="editProduct('${p.id}')">✏️ Edit</button>
               <button class="btn ${inStock?'btn-red':'btn-grn'} btn-xs" onclick="toggleStock('${p.id}','${p.stockStatus}')">${inStock?'📵 OOS':'✅ Stock'}</button>
               <button class="btn btn-red btn-xs" onclick="deleteProduct('${p.id}')">🗑</button>`
            : isOwner() && _ownerZoneFilter
            ? `<button class="btn btn-ghost btn-xs" style="flex:1" onclick="editProduct('${p.id}')">✏️ Edit</button>
               <button class="btn btn-primary btn-xs" onclick="openZonePriceOverrideForZone('${p.id}','${_ownerZoneFilter}')">💱 Zone Price</button>
               <button class="btn ${inStock?'btn-red':'btn-grn'} btn-xs" onclick="toggleStock('${p.id}','${p.stockStatus}')">${inStock?'📵 OOS':'✅ Stock'}</button>`
            : `<button class="btn btn-primary btn-xs" style="flex:1" onclick="openZonePriceOverride('${p.id}')">💱 Zone Price</button>
               <button class="btn ${inStock?'btn-red':'btn-grn'} btn-xs" onclick="toggleStock('${p.id}','${p.stockStatus}')">${inStock?'📵 OOS':'✅ Stock'}</button>`
          }
        </div>
        ${p._zoneOverride
          ? `<div style="font-size:10px;color:var(--ylw);margin-top:4px;text-align:right">💱 Zone price override active</div>`
          : (isOwner()&&_ownerZoneFilter&&!p._zoneOverride)
            ? `<div style="font-size:10px;color:var(--tx3);margin-top:4px;text-align:right">🌐 Global price</div>`
            : ''}
      </div>
    </div>`;
  }).join('');
}

function openNewProduct() {
  document.getElementById('mProductTitle').textContent='🛒 Add Product';
  document.getElementById('pEditId').value='';
  ['pName','pSku','pCat','pUnit','pDesc'].forEach(id=>document.getElementById(id).value='');
  document.getElementById('pPrice').value='';
  document.getElementById('pCost').value='';
  document.getElementById('pStock').value='in_stock';
  document.getElementById('prodPhotoData').value='';
  const prev=document.getElementById('prodPhotoPreview');
  prev.innerHTML='📦';prev.style.cssText='width:80px;height:80px;border-radius:10px;background:var(--s2);border:2px dashed var(--bdr);display:flex;align-items:center;justify-content:center;font-size:28px;overflow:hidden;flex-shrink:0';
  openM('mProduct');
}

async function editProduct(id) {
  const p=allProducts.find(x=>x.id===id);if(!p)return;
  document.getElementById('mProductTitle').textContent='✏️ Edit Product';
  document.getElementById('pEditId').value=id;
  document.getElementById('pName').value=p.name||'';
  document.getElementById('pSku').value=p.sku||'';
  document.getElementById('pCat').value=p.category||'';
  document.getElementById('pUnit').value=p.unit||'';
  document.getElementById('pPrice').value=p.price||'';
  document.getElementById('pCost').value=p.cost||'';
  document.getElementById('pStock').value=p.stockStatus||'in_stock';
  document.getElementById('pDesc').value=p.description||'';
  document.getElementById('prodPhotoData').value=p.photo||'';
  const prev=document.getElementById('prodPhotoPreview');
  if(p.photo){prev.innerHTML=`<img src="${p.photo}" style="width:100%;height:100%;object-fit:cover">`;prev.style.border='2px solid var(--grn)';}
  else{prev.innerHTML='📦';prev.style.cssText='width:80px;height:80px;border-radius:10px;background:var(--s2);border:2px dashed var(--bdr);display:flex;align-items:center;justify-content:center;font-size:28px;overflow:hidden;flex-shrink:0';}
  openM('mProduct');
}

function previewProdPhoto(input) {
  const file=input.files[0];if(!file)return;
  if(file.size>10*1024*1024){showToast('Image too large (max 10MB)','error');return;}
  const reader=new FileReader();
  reader.onload=e=>{
    document.getElementById('prodPhotoData').value=e.target.result;
    const prev=document.getElementById('prodPhotoPreview');
    prev.innerHTML=`<img src="${e.target.result}" style="width:100%;height:100%;object-fit:cover">`;
    prev.style.border='2px solid var(--grn)';
  };
  reader.readAsDataURL(file);
}

async function saveProduct() {
  const name=document.getElementById('pName').value.trim();
  const price=parseFloat(document.getElementById('pPrice').value);
  if(!name){showToast('Product name is required','error');return;}
  if(!price||price<=0){showToast('Enter a valid price','error');return;}
  const editId=document.getElementById('pEditId').value;
  // Duplicate check — name must be unique (case-insensitive), excluding current record
  const nameLower=name.toLowerCase();
  const dup=allProducts.find(p=>p.name.toLowerCase()===nameLower&&p.id!==editId);
  if(dup){showToast(`Product "${dup.name}" already exists. Use a unique name.`,'error');return;}
  const data={name,price,
    sku:document.getElementById('pSku').value.trim(),
    category:document.getElementById('pCat').value.trim(),
    unit:document.getElementById('pUnit').value.trim(),
    cost:parseFloat(document.getElementById('pCost').value)||0,
    stockStatus:document.getElementById('pStock').value,
    description:document.getElementById('pDesc').value.trim(),
    photo:document.getElementById('prodPhotoData').value,
    updatedAt:new Date().toISOString(),updatedBy:CU.uid
  };
  try{
    let savedId = editId;
    if(editId){
      await sfUpdate('products',editId,data);
      showToast(`${name} updated ✅`,'success');
    } else {
      data.createdAt=new Date().toISOString();data.createdBy=CU.uid;
      const newRef = await sfAdd('products',data);
      savedId = newRef?.id || editId;
      showToast(`${name} added 🛒`,'success');
    }
    // Owner: broadcast new/updated product to ALL zone subcollections
    // so every zone's sales reps can see it immediately
    if(isOwner() && allZones.length) {
      const broadcastData = {...data, _globalProduct:true, updatedAt:new Date().toISOString()};
      await Promise.all(allZones.map(z =>
        window.__SF.setDoc(
          window.__SF.doc(db(), `zones/${z.id}/products/${savedId}`),
          broadcastData, {merge:true}
        ).catch(()=>{}) // fail silently per zone
      ));
    }
    closeM('mProduct');
    invalidateCache();await loadCachedData(true);loadProducts();
  }catch(e){showToast('Error saving product: '+e.message,'error');}
}

async function toggleStock(id,currentStatus) {
  if(!isAdmin())return;
  const newStatus=currentStatus==='out_of_stock'?'in_stock':'out_of_stock';
  if(isOwner()) {
    // Owner updates root + broadcast to all zones
    await sfUpdate('products',id,{stockStatus:newStatus});
    if(allZones.length) {
      await Promise.all(allZones.map(z =>
        window.__SF.setDoc(window.__SF.doc(db(),`zones/${z.id}/products/${id}`),{stockStatus:newStatus},{merge:true}).catch(()=>{})
      ));
    }
  } else {
    // Zone admin: update their zone's copy directly
    await window.__SF.setDoc(
      window.__SF.doc(db(),`zones/${CU.zoneId}/productOverrides/${id}`),
      {stockStatus:newStatus, updatedAt:new Date().toISOString(), updatedBy:CU.uid},{merge:true}
    );
  }
  showToast(newStatus==='in_stock'?'Marked as In Stock ✅':'Marked as Out of Stock ❌','info');
  await loadCachedData();loadProducts();
}

async function deleteProduct(id) {
  if(!isAdmin())return;
  const p=allProducts.find(x=>x.id===id);
  const label=p?p.name:`Product ${id}`;
  if(isStrictAdmin()){
    if(!confirm(`Delete "${label}"? This cannot be undone.`))return;
    await sfDelete('products',id);
    showToast('Product deleted','warn');
    await loadCachedData();loadProducts();
  } else {
    await requestDeleteApproval('product',id,label);
  }
}

// ── CSV / EXCEL IMPORT ──
function openCsvImport() {
  csvParsedRows=[];
  document.getElementById('csvPreview').style.display='none';
  document.getElementById('csvImportBtn').disabled=true;
  document.getElementById('csvFileInput').value='';
  openM('mCsvImport');
}

function downloadSampleCsv() {
  const rows=[
    ['name','price','category','unit','sku','cost','stock_status','description','photo_url'],
    ['Premium Rice 5kg','650','Grains','kg','RICE-5KG','480','in_stock','High quality premium rice',''],
    ['Cooking Oil 1L','180','Oils','L','OIL-1L','130','in_stock','Refined cooking oil',''],
    ['Sugar 1kg','120','Staples','kg','SUGAR-1KG','90','out_of_stock','White refined sugar','']
  ];
  const csv=rows.map(r=>r.map(c=>`"${c}"`).join(',')).join('\n');
  const a=document.createElement('a');
  a.href='data:text/csv;charset=utf-8,'+encodeURIComponent(csv);
  a.download='product_import_sample.csv';a.click();
}

function handleCsvDrop(e) {
  e.preventDefault();
  document.getElementById('csvDropzone').style.borderColor='var(--bdr)';
  const file=e.dataTransfer.files[0];
  if(file)handleCsvFile(file);
}

function handleCsvFile(file) {
  if(!file)return;
  const ext=file.name.split('.').pop().toLowerCase();
  if(ext==='csv'){
    const reader=new FileReader();
    reader.onload=e=>parseCsvText(e.target.result);
    reader.readAsText(file);
  } else if(ext==='xlsx'||ext==='xls'){
    if(window.XLSX){
      const reader=new FileReader();
      reader.onload=e=>{const wb=XLSX.read(e.target.result,{type:'binary'});const ws=wb.Sheets[wb.SheetNames[0]];parseCsvText(XLSX.utils.sheet_to_csv(ws));};
      reader.readAsBinaryString(file);
    } else {
      const s=document.createElement('script');
      s.src='https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
      s.onload=()=>{const reader=new FileReader();reader.onload=e=>{const wb=XLSX.read(e.target.result,{type:'binary'});const ws=wb.Sheets[wb.SheetNames[0]];parseCsvText(XLSX.utils.sheet_to_csv(ws));};reader.readAsBinaryString(file);};
      document.head.appendChild(s);
    }
  } else {
    showToast('Unsupported file type. Use .csv, .xlsx or .xls','error');
  }
}

function parseCsvText(text) {
  const lines=text.trim().split('\n').filter(l=>l.trim());
  if(lines.length<2){showToast('File is empty or invalid','error');return;}
  const headers=lines[0].split(',').map(h=>h.replace(/"/g,'').trim().toLowerCase());
  const nameI=headers.indexOf('name');const priceI=headers.indexOf('price');
  if(nameI===-1||priceI===-1){showToast('CSV must have "name" and "price" columns','error');return;}
  const catI=headers.indexOf('category');const unitI=headers.indexOf('unit');const skuI=headers.indexOf('sku');
  const costI=headers.indexOf('cost');const stockI=headers.indexOf('stock_status');const descI=headers.indexOf('description');
  const photoI=headers.indexOf('photo_url');
  csvParsedRows=[];const errors=[];
  for(let i=1;i<lines.length;i++){
    const cols=lines[i].split(',').map(c=>c.replace(/"/g,'').trim());
    const name=cols[nameI]||'';const price=parseFloat(cols[priceI]||0);
    if(!name){errors.push(`Row ${i+1}: missing name`);continue;}
    if(!price||price<=0){errors.push(`Row ${i+1}: invalid price`);continue;}
    csvParsedRows.push({name,price,category:catI>=0?cols[catI]||'':'',unit:unitI>=0?cols[unitI]||'':'',sku:skuI>=0?cols[skuI]||'':'',cost:costI>=0?parseFloat(cols[costI]||0):0,stockStatus:stockI>=0&&cols[stockI]==='out_of_stock'?'out_of_stock':'in_stock',description:descI>=0?cols[descI]||'':'',photo:photoI>=0?cols[photoI]||'':''});
  }
  if(errors.length)showToast(errors.slice(0,3).join(' | ')+(errors.length>3?` +${errors.length-3} more`:''),'warn');
  if(!csvParsedRows.length){showToast('No valid rows found','error');return;}
  const preview=document.getElementById('csvPreview');
  preview.style.display='';
  document.getElementById('csvRowCount').textContent=`${csvParsedRows.length} products ready`;
  const tbl=document.getElementById('csvPreviewTable');
  tbl.querySelector('thead').innerHTML='<tr><th>Name</th><th>Price</th><th>Category</th><th>Unit</th><th>SKU</th><th>Stock</th></tr>';
  tbl.querySelector('tbody').innerHTML=csvParsedRows.map(r=>`<tr>
    <td style="font-size:12px;font-weight:600">${r.name}</td><td style="font-size:12px">${fmt(r.price)}</td>
    <td style="font-size:11px;color:var(--tx2)">${r.category||'—'}</td><td style="font-size:11px;color:var(--tx2)">${r.unit||'—'}</td>
    <td style="font-size:11px;color:var(--tx3)">${r.sku||'—'}</td>
    <td><span class="bdg ${r.stockStatus==='in_stock'?'bdg-grn':'bdg-red'}" style="font-size:10px">${r.stockStatus==='in_stock'?'In Stock':'OOS'}</span></td>
  </tr>`).join('');
  document.getElementById('csvImportBtn').disabled=false;
}

async function importCsvProducts() {
  if(!csvParsedRows.length){showToast('No rows to import','error');return;}
  const btn=document.getElementById('csvImportBtn');
  btn.disabled=true;btn.textContent='Importing...';
  let count=0;let skipped=0;
  try{
    for(const p of csvParsedRows){
      // Skip duplicates
      const dup=allProducts.find(x=>x.name.toLowerCase()===p.name.toLowerCase());
      if(dup){skipped++;continue;}
      await sfAdd('products',{...p,createdAt:new Date().toISOString(),createdBy:CU.uid,updatedAt:new Date().toISOString(),updatedBy:CU.uid});
      count++;
    }
    closeM('mCsvImport');
    showToast(`${count} products imported${skipped?` · ${skipped} skipped (duplicates)`:''} 🎉`,'success');
    await loadCachedData();loadProducts();
  }catch(e){showToast('Import failed: '+e.message,'error');btn.disabled=false;btn.textContent='Import Products';}
}

function _updateBadges(ordDocs) {
  const count=ordDocs.filter(d=>d.data().status==='Pending').length;
  const pb=document.getElementById('pendBadge');
  if(pb){pb.textContent=count;pb.style.display=count?'':'none';}
  if(isAdmin()){
    const pendBal=allOutlets.filter(o=>o.balanceStatus==='pending'&&o.openingBalance>0).length;
    const oab=document.getElementById('outletApvBadge');
    if(oab){oab.textContent=pendBal;oab.style.display=pendBal?'':'none';}
    const unassignedDeliveries=ordDocs.filter(d=>d.data().status==='Confirmed'&&!d.data().deliveryManId).length;
    const dab=document.getElementById('delivAdminBadge');
    if(dab){dab.textContent=unassignedDeliveries;dab.style.display=unassignedDeliveries?'':'none';}
  }
}

// Public wrapper — uses cached dash data when fresh, otherwise fetches
async function updateBadges() {
  const now=Date.now();
  if(_dashOrdDocs&&_dashTs&&(now-_dashTs)<_DASH_TTL){
    _updateBadges(_dashOrdDocs);
  } else {
    const pendDocs=await sfGet('orders');
    _updateBadges(pendDocs);
  }
}

function _updateSidebarStats(ordDocs, colDocs) {
  const strip=document.getElementById('sbStats');
  if(!strip)return;

  // Outlets: reps see their own + assigned; admin sees all
  const myOutlets=isAdmin()
    ? allOutlets
    : allOutlets.filter(o=>o.createdBy===CU.uid||o.assignedRepId===CU.uid);

  // Orders
  const myOrders=ordDocs.map(d=>d.data())
    .filter(o=>isAdmin()||o.createdBy===CU.uid);
  const activeOrders=myOrders.filter(o=>!['Cancelled','Delivered'].includes(o.status)).length;

  // Collections (total this month)
  const m=todayStr().slice(0,7);
  const myColTotal=colDocs.map(d=>d.data())
    .filter(c=>isAdmin()||c.createdBy===CU.uid)
    .filter(c=>c.date&&c.date.startsWith(m))
    .reduce((s,c)=>s+(c.amount||0),0);

  const elO=document.getElementById('sbStatOutlets');
  const elOrd=document.getElementById('sbStatOrders');
  const elC=document.getElementById('sbStatCol');
  if(elO)elO.textContent=myOutlets.length;
  if(elOrd)elOrd.textContent=activeOrders;
  if(elC)elC.textContent='RM'+Math.round(myColTotal).toLocaleString();
  strip.style.display=CU&&CU.role!=='delivery_man'?'block':'none';
}

async function updateSidebarStats() {
  const [ordDocs,colDocs]=await Promise.all([sfGet('orders'),sfGet('collections')]);
  _updateSidebarStats(ordDocs,colDocs);
}

