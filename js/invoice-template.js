// ═══════════════ SALES INVOICE TEMPLATE ═══════════════
// One printable invoice layout for the Sales App and the ERP portal (the
// portal loads this file from /vendor/). renderSalesInvoice(inv) returns
// self-contained HTML (inline styles only) so it prints, converts to PDF
// and shares the same everywhere. Company details come from the company
// profile (ERP → Settings), falling back to the defaults below.
(function (global) {
  'use strict';

  var DEFAULT_COMPANY = {
    name: 'SAIRAH TRADING (PERAK) SDN BHD',
    branchName: 'ST FRESH MART',
    address: 'BLOCK C & D, LOT 109116, HALA PERUSAHAAN MENGLEMBU 1, KAWASAN PERINDUSTRIAN MENGLEMBU, 31450 IPOH, PERAK, MALAYSIA',
    phone: '0102747874',
    email: 'sairahtradingperak@gmail.com',
    chequePayee: 'SAIRAH TRADING SDN BHD',
    bankAcc: '3817996519',
    bankName: 'PUBLIC BANK',
    terms: 'Goods sold are neither returnable nor refundable.',
    logo: 'data:image/jpeg;base64,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',
  };

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function num(n) { n = Number(n); return isFinite(n) ? n : 0; }
  function money(n) { return num(n).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function qty(n) { n = num(n); return Number.isInteger(n) ? String(n) : String(Math.round(n * 1000) / 1000); }

  var ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve',
    'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  var TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  function below1000(n) {
    var out = [];
    if (n >= 100) { out.push(ONES[Math.floor(n / 100)] + ' Hundred'); n %= 100; }
    if (n >= 20) { out.push(TENS[Math.floor(n / 10)] + (n % 10 ? ' ' + ONES[n % 10] : '')); }
    else if (n > 0) out.push(ONES[n]);
    return out.join(' ');
  }
  // 254 → "Two Hundred Fifty Four only"; 12.5 → "Twelve and Fifty Sen only"
  function amountInWords(amount) {
    var a = Math.round(Math.abs(num(amount)) * 100), whole = Math.floor(a / 100), sen = a % 100;
    var scales = [[1e9, 'Billion'], [1e6, 'Million'], [1e3, 'Thousand']], parts = [], n = whole;
    scales.forEach(function (s) { if (n >= s[0]) { parts.push(below1000(Math.floor(n / s[0])) + ' ' + s[1]); n %= s[0]; } });
    if (n) parts.push(below1000(n));
    var words = parts.join(' ') || 'Zero';
    if (sen) words += ' and ' + below1000(sen) + ' Sen';
    return words + ' only';
  }

  // Order/invoice lines → printed rows. A line with cartons and loose
  // pieces prints as two rows (CTN at the carton price, then PCS).
  function invoiceRows(items) {
    var rows = [];
    (items || []).forEach(function (it) {
      var name = it.name || '', unit = String(it.unit || 'PCS').toUpperCase();
      var ctnQty = num(it.ctnQty), ctnSize = num(it.ctnSize), pcsQty = num(it.pcsQty);
      if (ctnQty > 0 && ctnSize > 0) {
        var ctnPrice = num(it.ctnPrice) || num(it.price) * ctnSize;
        rows.push({ desc: name, qty: ctnQty, unit: 'CTN', price: ctnPrice, total: ctnQty * ctnPrice });
        if (pcsQty > 0) rows.push({ desc: name, qty: pcsQty, unit: unit === 'CTN' ? 'PCS' : unit, price: num(it.price), total: pcsQty * num(it.price) });
      } else {
        var q = pcsQty > 0 ? pcsQty : num(it.qty);
        rows.push({ desc: name, qty: q, unit: unit, price: num(it.price), total: q * num(it.price) });
      }
    });
    return rows;
  }

  function renderSalesInvoice(inv) {
    var c = {}, k;
    for (k in DEFAULT_COMPANY) c[k] = DEFAULT_COMPANY[k];
    var src = inv.company || {};
    for (k in src) if (src[k] != null && src[k] !== '') c[k] = src[k];
    if (!src.address && (src.addr1 || src.city)) {
      c.address = [src.addr1, src.addr2, [src.postcode, src.city].filter(Boolean).join(' '), src.state, 'MALAYSIA'].filter(Boolean).join(', ');
    }
    var rows = invoiceRows(inv.items);
    var subtotal = rows.reduce(function (s, r) { return s + r.total; }, 0);
    var sst = num(inv.sst), transport = num(inv.transport);
    // Discount is whatever separates the line values from the invoice total
    // (line and order discounts together), so the summary always adds up.
    var total = inv.total != null ? num(inv.total) : subtotal + sst + transport;
    var discount = Math.max(0, Math.round((subtotal + sst + transport - total) * 100) / 100);
    var paid = num(inv.paid), cashReturn = num(inv.cashReturn);
    var due = Math.max(0, Math.round((total - paid) * 100) / 100);
    var cell = 'border:1px solid #111;padding:5px 7px;';
    var info = function (label, value) { return '<div style="margin:3px 0"><strong>' + label + ':</strong> ' + esc(value || '—') + '</div>'; };
    var sumRow = function (label, value, bold) {
      return '<tr><td style="padding:2px 0;font-weight:' + (bold ? 800 : 700) + '">' + label + '</td><td style="padding:2px 0;text-align:right;' + (bold ? 'font-weight:800' : '') + '">' + money(value) + '</td></tr>';
    };
    var terms = [];
    if (c.chequePayee || c.bankAcc) {
      terms.push('All cheques should be crossed and made payable to, <strong>' + esc(c.chequePayee || c.name) + '</strong>' +
        (c.bankAcc ? '<div style="margin:3px 0 0 14px;font-weight:700">' + esc(c.bankAcc) + '</div>' : '') +
        (c.bankName ? '<div style="margin:3px 0 0 14px;font-weight:700">' + esc(c.bankName) + '</div>' : ''));
    }
    String(c.terms || '').split(/\n+/).filter(function (t) { return t.trim(); }).forEach(function (t) { terms.push(esc(t.trim())); });

    return '<div class="sales-invoice" style="background:#fff;color:#111;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.35;padding:22px 24px;max-width:800px;margin:0 auto">' +
      '<div style="display:flex;align-items:flex-start;gap:12px">' +
        '<div style="width:96px;flex-shrink:0">' + (c.logo ? '<img src="' + esc(c.logo) + '" alt="" style="max-width:96px;max-height:80px">' : '') + '</div>' +
        '<div style="flex:1;text-align:center">' +
          '<div style="font-size:17px;font-weight:800">' + esc(c.name) + '</div>' +
          (c.branchName ? '<div style="font-size:13px;font-weight:700;margin-top:3px">' + esc(c.branchName) + '</div>' : '') +
          '<div style="margin-top:3px">' + esc(c.address) + '</div>' +
          (c.phone ? '<div>Phone ' + esc(c.phone) + '</div>' : '') +
          (c.email ? '<div>Email ' + esc(c.email) + '</div>' : '') +
          (c.regNo || c.tin || c.sstNo ? '<div style="font-size:11px;margin-top:2px">' + [c.regNo ? 'Reg. No. ' + esc(c.regNo) : '', c.tin ? 'TIN ' + esc(c.tin) : '', c.sstNo ? 'SST ' + esc(c.sstNo) : ''].filter(Boolean).join(' · ') + '</div>' : '') +
        '</div>' +
        '<div style="width:96px;flex-shrink:0;text-align:center">' + (inv.qrSvg ? '<div style="width:92px;margin:0 auto">' + inv.qrSvg + '</div><div style="font-size:9px;margin-top:2px">Scan for E-Invoice</div>' : '') + '</div>' +
      '</div>' +
      '<div style="border-top:3px double #111;margin-top:12px"></div>' +
      '<div style="text-align:center;font-size:15px;font-weight:800;padding:8px 0">' + esc(inv.title || 'Sales Invoice') + '</div>' +
      '<div style="border-top:1.5px solid #111;margin-bottom:10px"></div>' +
      '<div style="display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap">' +
        '<div>' + info('Customer Id', inv.customer && inv.customer.id) + info('Customer Name', inv.customer && inv.customer.name) +
          info('Customer Address', inv.customer && inv.customer.address) + info('Customer Mobile', inv.customer && inv.customer.mobile) + '</div>' +
        '<div style="min-width:45%">' + info('Sales by', inv.salesBy) + info(inv.title === 'Sales Order' ? 'Order No.' : 'Invoice No.', inv.number) +
          info('Sales Date', inv.date) + (inv.orderRef ? info('Order Ref.', inv.orderRef) : '') + '</div>' +
      '</div>' +
      '<table style="width:100%;border-collapse:collapse;margin-top:12px;font-size:12px"><thead><tr>' +
        '<th style="' + cell + 'width:34px;text-align:left">Sl.</th><th style="' + cell + 'text-align:left">Description</th>' +
        '<th style="' + cell + 'width:56px;text-align:right">Qnty</th><th style="' + cell + 'width:50px;text-align:center">Unit</th>' +
        '<th style="' + cell + 'width:78px;text-align:right">Unit Price</th><th style="' + cell + 'width:82px;text-align:right">Total</th></tr></thead><tbody>' +
        rows.map(function (r, i) {
          return '<tr><td style="' + cell + 'text-align:center">' + (i + 1) + '</td><td style="' + cell + '">' + esc(r.desc) + '</td>' +
            '<td style="' + cell + 'text-align:right">' + qty(r.qty) + '</td><td style="' + cell + 'text-align:center">' + esc(r.unit) + '</td>' +
            '<td style="' + cell + 'text-align:right">' + money(r.price) + '</td><td style="' + cell + 'text-align:right">' + money(r.total) + '</td></tr>';
        }).join('') +
      '</tbody></table>' +
      '<div style="display:flex;justify-content:flex-end;margin-top:10px"><table style="width:280px;border-collapse:collapse;font-size:12px">' +
        sumRow('Sub Total', subtotal) + sumRow('SST', sst) + sumRow('Discount', discount) + sumRow('Transport Cost', transport) +
        '<tr><td colspan="2" style="border-top:1.5px solid #111;padding:0"></td></tr>' +
        sumRow('Total', total, true) + sumRow('Paid', paid) + sumRow('Due', due, true) + sumRow('Cash Return', cashReturn) +
      '</table></div>' +
      '<div style="margin-top:12px"><strong>In Word:</strong> ' + esc(amountInWords(total)) + '</div>' +
      (inv.notes ? '<div style="margin-top:8px"><strong>Notes:</strong> ' + esc(inv.notes) + '</div>' : '') +
      (terms.length ? '<ol style="margin:12px 0 0;padding-left:16px;font-size:11px">' + terms.map(function (t) { return '<li style="margin-bottom:6px">' + t + '</li>'; }).join('') + '</ol>' : '') +
      '<div style="display:flex;justify-content:space-between;margin-top:56px">' +
        '<div style="width:190px;border-top:1.5px solid #111;text-align:center;padding-top:4px">Received by</div>' +
        '<div style="width:190px;border-top:1.5px solid #111;text-align:center;padding-top:4px">Authorized by</div>' +
      '</div>' +
    '</div>';
  }

  global.renderSalesInvoice = renderSalesInvoice;
  global.invoiceAmountInWords = amountInWords;
  global.invoiceRows = invoiceRows;
  global.INVOICE_DEFAULT_COMPANY = DEFAULT_COMPANY;
  if (typeof module === 'object' && module.exports) module.exports = { renderSalesInvoice: renderSalesInvoice, amountInWords: amountInWords, invoiceRows: invoiceRows, DEFAULT_COMPANY: DEFAULT_COMPANY };
})(typeof window !== 'undefined' ? window : globalThis);
