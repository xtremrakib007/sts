// ═══════════════ STAFF ADVANCES: shared logic ═══════════════
// Used by the Sales App (js/advances.js), the ERP portal (vendor copy) and
// the unit tests. An advance (salary advance, cash advance, loan) is paid
// back in monthly salary deductions; cash/bank repayments also reduce it.
//
// Document: stsb_staff_advances/{id}
//   uid, staffName, staffRole, zoneId, type, amount, reason, instalments,
//   status: pending → approved → active → settled   (or rejected / cancelled)
//   approvedAmount, startMonth 'YYYY-MM',
//   schedule:   [{ month, amount, status: 'due' | 'deducted', at, by }]
//   repayments: [{ date, amount, method: 'salary' | 'cash' | 'bank', month?, note, by, byName }]
//   repaid, balance
(function (root) {
  const ADVANCE_TYPES = {
    salary: 'Salary advance',
    cash: 'Cash advance',
    loan: 'Staff loan',
    other: 'Other advance',
  };
  const ADVANCE_STATUS = {
    pending: 'Waiting approval',
    approved: 'Approved — to be paid out',
    active: 'Repaying',
    settled: 'Fully repaid',
    rejected: 'Rejected',
    cancelled: 'Cancelled',
  };
  const MAX_INSTALMENTS = 24;

  const cents = (n) => Math.round((Number(n) || 0) * 100);
  const rm = (c) => c / 100;

  // 'YYYY-MM' n months after ym.
  function addMonths(ym, n) {
    const [y, m] = String(ym).split('-').map(Number);
    const d = new Date(Date.UTC(y, m - 1 + n, 1));
    return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
  }

  function monthOf(date) {
    const d = date instanceof Date ? date : new Date(date || Date.now());
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  }

  // Equal monthly instalments; the cents left over go on the last one.
  function advanceSchedule(amount, instalments, startMonth) {
    const total = cents(amount);
    const n = Math.max(1, Math.min(MAX_INSTALMENTS, Math.floor(Number(instalments) || 1)));
    const each = Math.floor(total / n);
    return Array.from({ length: n }, (_, i) => ({
      month: addMonths(startMonth, i),
      amount: rm(i === n - 1 ? total - each * (n - 1) : each),
      status: 'due',
    }));
  }

  function advanceTotals(a) {
    const principal = cents(a.approvedAmount ?? a.amount);
    const repaid = (a.repayments || []).reduce((s, r) => s + cents(r.amount), 0);
    return { principal: rm(principal), repaid: rm(repaid), balance: rm(Math.max(0, principal - repaid)) };
  }

  // Instalments still to deduct, sized to what is actually owed: a cash
  // repayment shrinks the last instalments first.
  function dueInstalments(a) {
    if (a.status !== 'active') return [];
    let left = cents(advanceTotals(a).balance);
    const due = (a.schedule || []).map((e, i) => ({ ...e, index: i })).filter((e) => e.status === 'due');
    const out = [];
    // Fill from the earliest month; later months take whatever is left.
    for (const e of due) {
      const amt = Math.min(cents(e.amount), left);
      left -= amt;
      if (amt > 0) out.push({ ...e, amount: rm(amt) });
    }
    // Rounding or an edited amount can leave a remainder: add it to the last one.
    if (left > 0 && out.length) out[out.length - 1].amount = rm(cents(out[out.length - 1].amount) + left);
    else if (left > 0) out.push({ month: (due[0] && due[0].month) || monthOf(), amount: rm(left), status: 'due', index: -1 });
    return out;
  }

  // Deductions to take from salary in a month, across all advances.
  function deductionsForMonth(advances, month) {
    const rows = [];
    for (const a of advances) {
      const e = dueInstalments(a).find((x) => x.month <= month);
      if (e) rows.push({ advance: a, entry: e, overdue: e.month < month });
    }
    return rows;
  }

  function _settle(a, schedule, repayments) {
    const t = advanceTotals({ ...a, repayments });
    const settled = t.balance <= 0;
    return {
      schedule: settled ? schedule.map((e) => (e.status === 'due' ? { ...e, status: 'covered' } : e)) : schedule,
      repayments,
      repaid: t.repaid,
      balance: t.balance,
      status: settled ? 'settled' : a.status,
      ...(settled ? { settledAt: new Date().toISOString() } : {}),
    };
  }

  // Patch for marking one month's instalment deducted from salary.
  function applySalaryDeduction(a, month, by) {
    const e = dueInstalments(a).find((x) => x.month <= month);
    if (!e) throw new Error('Nothing due for ' + month);
    const at = new Date().toISOString();
    const schedule = (a.schedule || []).map((s, i) => (i === e.index ? { ...s, status: 'deducted', deducted: e.amount, at, by: by.uid } : s));
    const repayments = [...(a.repayments || []), { date: at.slice(0, 10), amount: e.amount, method: 'salary', month: e.month, by: by.uid, byName: by.name || '' }];
    return _settle(a, schedule, repayments);
  }

  // Patch for a cash / bank repayment of any amount up to the balance.
  function applyRepayment(a, amount, method, by, note, date) {
    const amt = rm(cents(amount));
    if (!(amt > 0)) throw new Error('Enter an amount');
    if (cents(amt) > cents(advanceTotals(a).balance)) throw new Error('More than the balance of RM ' + advanceTotals(a).balance.toFixed(2));
    const repayments = [...(a.repayments || []), { date: date || new Date().toISOString().slice(0, 10), amount: amt, method, note: note || '', by: by.uid, byName: by.name || '' }];
    return _settle(a, a.schedule || [], repayments);
  }

  // A staff member's running totals across their advances.
  function staffAdvanceSummary(advances) {
    const live = advances.filter((a) => a.status === 'active' || a.status === 'approved');
    const balance = live.reduce((s, a) => s + cents(advanceTotals(a).balance), 0);
    const next = advances.flatMap((a) => dueInstalments(a)).sort((x, y) => (x.month < y.month ? -1 : 1))[0] || null;
    return { balance: rm(balance), pending: advances.filter((a) => a.status === 'pending').length, next };
  }

  const api = { ADVANCE_TYPES, ADVANCE_STATUS, MAX_INSTALMENTS, addMonths, monthOf, advanceSchedule, advanceTotals,
    dueInstalments, deductionsForMonth, applySalaryDeduction, applyRepayment, staffAdvanceSummary };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  Object.assign(root, api);
})(typeof window !== 'undefined' ? window : globalThis);
