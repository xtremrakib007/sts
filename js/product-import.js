// ═══════════════ PRODUCT IMPORT + PRICE MARGIN (ERP) ═══════════════
// Reads a product sheet (our export, or a stock-system export with
// Product / SKU / Barcode / Category / UOM / Purchase Price / Status …)
// into an import plan. Used by the ERP portal (vendor copy) and tests.
//
// • A "<name> (Single)" row is the loose unit of the "<name>" bulk row:
//   the two become one product with a unit price and a carton price.
// • With no selling price in the sheet, prices come from the purchase
//   price and a margin rule (markup on cost, or margin on price).
(function (root) {
  const num = (x) => { const n = parseFloat(String(x ?? '').replace(/[^0-9.\-]/g, '')); return isFinite(n) ? n : 0; };
  const r2 = (n) => Math.round(n * 100) / 100;
  const SINGLE_RE = /\s*\((single|pcs|unit|loose)\)\s*$/i;

  // Header text → field. Stock-system columns we do not import map to null.
  function productField(h) {
    const k = String(h || '').toLowerCase().replace(/[^a-z%]/g, '');
    if (/^(name|product|productname|item|itemname|description1)$/.test(k)) return 'name';
    if (/^(sku|code|itemcode|productcode)$/.test(k)) return 'sku';
    if (/^(barcode|ean|upc)$/.test(k)) return 'barcode';
    if (/^(category|cat|group)$/.test(k)) return 'category';
    if (/^(unit|uom)$/.test(k)) return 'unit';
    if (/^(price|pricerm|sellingprice|unitprice|pcsprice|retailprice)$/.test(k)) return 'price';
    if (/^(cost|costrm|costprice|purchaseprice|purchasepricerm)$/.test(k)) return 'cost';
    if (/^(pcspercarton|ctnsize|cartonsize|pcsperctn|packsize)$/.test(k)) return 'ctnSize';
    if (/^(cartonprice|cartonpricerm|ctnprice|ctnpricerm)$/.test(k)) return 'ctnPrice';
    if (/^(maxdiscount%?|maxdiscount|discountlimit|maxdisc%?)$/.test(k)) return 'maxDiscount';
    if (/^(instockyesno|instock|stock|status)$/.test(k)) return 'stockStatus';
    if (/^(notes|note|remarks|description)$/.test(k)) return 'notes';
    return null;
  }

  // Units in a carton from the product name: "1CTN=20PKT" → 20,
  // "1.5LX12" → 12, "150g*10*8Pkt" → 80, "500 KG X 25" → 25.
  function packSize(name) {
    const s = String(name || '');
    const eq = s.match(/1\s*ctn\s*=\s*(\d+(?:\.\d+)?)/i);
    if (eq) return num(eq[1]);
    const mult = [...s.matchAll(/[x×*]\s*(\d+)(?![\d.]*\s*(?:ml|l|g|kg|gm)\b)/gi)].map((m) => num(m[1])).filter((n) => n > 1);
    return mult.length ? mult.reduce((a, b) => a * b, 1) : 0;
  }

  // Selling price from cost. mode 'markup': cost × (1 + pct%);
  // 'margin': cost ÷ (1 − pct%). round: 0.01 / 0.05 / 0.10 (rounded up).
  function priceFromCost(cost, rule) {
    const c = num(cost), p = num(rule && rule.pct);
    if (!(c > 0)) return 0;
    let v = rule && rule.mode === 'margin' ? (p >= 100 ? 0 : c / (1 - p / 100)) : c * (1 + p / 100);
    const step = num(rule && rule.round) || 0.01;
    v = Math.ceil(r2(v / step) - 1e-9) * step;
    return r2(v);
  }

  const isOut = (st) => ['no', 'n', 'false', '0', 'out', 'out_of_stock', 'out of stock'].includes(st);
  const stockOf = (v, match) => {
    const st = String(v.stockStatus ?? '').trim().toLowerCase();
    return isOut(st) ? 'out_of_stock' : st ? 'in_stock' : (match?.stockStatus || 'in_stock');
  };

  // rows: [headerRow, ...dataRows] (arrays). existing: current products.
  // rule: { pct, mode, round, apply } — apply 'missing' prices only rows
  // without a selling price; 'all' re-prices every row from its cost.
  function buildImportPlan(rows, existing, rule) {
    const fields = (rows[0] || []).map(productField);
    if (!fields.includes('name')) return { error: 'The first row must have headers incl. "Name" or "Product" — download the template' };
    const hasPrice = fields.includes('price') || fields.includes('ctnPrice');
    if (!hasPrice && !fields.includes('cost')) return { error: 'The sheet needs a selling "Price" or a "Purchase Price" column' };
    const errors = [];
    const recs = [];
    rows.slice(1).forEach((r, i) => {
      const v = {}; fields.forEach((f, j) => { if (f && v[f] == null) v[f] = r[j]; });
      const name = String(v.name ?? '').trim().replace(/^'/, '');
      if (!name) { if (r.some((x) => String(x ?? '').trim())) errors.push(`Row ${i + 2}: no name`); return; }
      recs.push({ line: i + 2, name, single: SINGLE_RE.test(name), base: name.replace(SINGLE_RE, '').trim(), v });
    });

    // Pair each "(Single)" row with its bulk row.
    const bulkByBase = new Map(recs.filter((x) => !x.single).map((x) => [x.base.toLowerCase(), x]));
    const items = [];
    const pairedSingles = new Set();
    for (const x of recs) {
      if (x.single) continue;
      const s = recs.find((y) => y.single && y.base.toLowerCase() === x.base.toLowerCase());
      if (s) pairedSingles.add(s);
      items.push({ bulk: x, single: s || null });
    }
    for (const s of recs) if (s.single && !pairedSingles.has(s) && !bulkByBase.has(s.base.toLowerCase())) items.push({ bulk: null, single: s });

    const bySku = new Map(), byName = new Map();
    existing.forEach((p) => {
      [p.sku, p.singleSku, p.barcode, p.singleBarcode].filter(Boolean).forEach((k) => bySku.set(String(k).toLowerCase(), p));
      byName.set(String(p.name || '').toLowerCase().trim(), p);
    });
    const plan = [], seen = new Set();
    for (const it of items) {
      const b = it.bulk, s = it.single, head = b || s, v = head.v, sv = s ? s.v : {};
      const name = head.base;
      const sku = String(v.sku ?? '').trim().replace(/^'/, '');
      const barcode = String(v.barcode ?? '').trim().replace(/^'/, '');
      const singleSku = s && b ? String(sv.sku ?? '').trim().replace(/^'/, '') : '';
      const singleBarcode = s && b ? String(sv.barcode ?? '').trim().replace(/^'/, '') : '';
      const key = (sku || name).toLowerCase();
      if (seen.has(key)) { errors.push(`Row ${head.line} (${name}): duplicate in the file`); continue; }
      seen.add(key);
      const match = [sku, singleSku, barcode, singleBarcode].filter(Boolean).map((k) => bySku.get(k.toLowerCase())).find(Boolean) || byName.get(name.toLowerCase());

      const bulkUnit = String((b ? v.unit : '') || '').trim().toUpperCase();
      const looseUnit = String((s ? sv.unit : b ? v.unit : '') || '').trim();
      const bulkCost = b ? num(v.cost) : 0, unitCost = s ? num(sv.cost) : 0;
      // Pack size: the sheet's column, the name, else the price ratio of the pair.
      const explicitSize = num(v.ctnSize);
      let size = explicitSize || packSize(name);
      if (!size && bulkCost > 0 && unitCost > 0) size = Math.round(bulkCost / unitCost);
      const soldByCarton = !!b && (!!s || bulkUnit === 'CTN') && size > 1;

      let cost, ctnCost, unit, ctnSize;
      if (explicitSize > 0 && !soldByCarton) {
        // Our own template: a unit row with its pieces per carton.
        ctnSize = explicitSize; cost = num(v.cost); ctnCost = 0;
        unit = String(v.unit ?? '').trim() || (match?.unit || 'pcs');
      } else if (soldByCarton) {
        ctnSize = size; ctnCost = bulkCost || r2(unitCost * size);
        cost = unitCost || (ctnCost ? r2(ctnCost / size) : 0);
        unit = s ? (looseUnit || 'pcs') : 'pcs';
      } else {
        ctnSize = 0; ctnCost = 0; cost = num(v.cost); unit = String(v.unit ?? '').trim() || (match?.unit || 'pcs');
      }
      if (!fields.includes('cost') && match) { cost = num(match.cost); ctnCost = num(match.ctnCost) || r2(cost * ctnSize); }

      const sheetPrice = num(s && b ? sv.price : v.price), sheetCtnPrice = num(b ? v.ctnPrice : 0) || (soldByCarton && b && !s ? num(v.price) : 0);
      const useRule = rule && (rule.apply === 'all' || (!sheetPrice && !sheetCtnPrice));
      let price, ctnPrice;
      if (useRule) {
        price = priceFromCost(cost, rule);
        ctnPrice = ctnSize ? (ctnCost ? priceFromCost(ctnCost, rule) : r2(price * ctnSize)) : 0;
      } else {
        price = sheetPrice || (sheetCtnPrice && ctnSize ? r2(sheetCtnPrice / ctnSize) : 0);
        ctnPrice = ctnSize ? (sheetCtnPrice || r2(price * ctnSize)) : 0;
      }
      if (!(price > 0)) { errors.push(`Row ${head.line} (${name}): no selling price and no purchase price to work it out from`); continue; }

      plan.push({
        id: match ? match.id : null, before: match || null, line: head.line, paired: !!(b && s), fromMargin: !!useRule,
        data: {
          name, sku: sku || singleSku, barcode, category: String(v.category ?? (match?.category || 'General')).trim() || 'General',
          unit, price, cost, ctnSize, ctnPrice, ctnCost,
          ...(singleSku ? { singleSku } : {}), ...(singleBarcode ? { singleBarcode } : {}),
          maxDiscount: v.maxDiscount != null && v.maxDiscount !== '' ? num(v.maxDiscount) : num(match?.maxDiscount),
          stockStatus: stockOf(b ? v : sv, match),
          notes: String(v.notes ?? (match?.notes || match?.description || '')).trim(),
        },
      });
    }
    return { plan, errors, hasPrice, singles: pairedSingles.size };
  }

  // New prices for existing products from their cost (bulk margin tool).
  function repriceByMargin(products, rule) {
    return products.filter((p) => num(p.cost) > 0).map((p) => {
      const size = num(p.ctnSize), ctnCost = num(p.ctnCost) || r2(num(p.cost) * size);
      const price = priceFromCost(p.cost, rule);
      return { id: p.id, name: p.name, category: p.category, cost: num(p.cost), oldPrice: num(p.price), price,
        ctnSize: size, oldCtnPrice: num(p.ctnPrice), ctnPrice: size ? priceFromCost(ctnCost, rule) : 0 };
    });
  }

  const api = { productField, packSize, priceFromCost, buildImportPlan, repriceByMargin };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.ProductImport = api;
})(typeof window !== 'undefined' ? window : globalThis);
