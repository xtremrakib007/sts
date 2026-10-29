// ═══════════════ MY ADVANCES (staff) ═══════════════
// Staff request a salary / cash advance or a loan here; an ERP admin
// approves it, pays it out and deducts it from salary each month
// (ERP → Staff Advances). Logic shared with the ERP: js/advance-core.js.
const ADV_COL = 'stsb_staff_advances';
const ADV_BADGE = { pending: 'bdg-ylw', approved: 'bdg-blu', active: 'bdg-blu', settled: 'bdg-grn', rejected: 'bdg-red', cancelled: 'bdg-gry' };
let _myAdvances = [];

const _monthLabel = (ym) => { const [y, m] = String(ym).split('-').map(Number); return new Date(y, m - 1, 1).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' }); };

async function loadMyAdvances() {
  const box = document.getElementById('advList');
  if (!box) return;
  box.innerHTML = '<div style="text-align:center;padding:30px;color:var(--tx3)">Loading…</div>';
  try {
    const { collection, query, where, getDocs } = window.__SF;
    const snap = await getDocs(query(collection(db(), ADV_COL), where('uid', '==', CU.uid)));
    _myAdvances = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => String(b.requestedAt || '').localeCompare(String(a.requestedAt || '')));
  } catch (e) {
    box.innerHTML = `<div style="text-align:center;padding:30px;color:var(--red)">Could not load advances: ${escH(e.message)}</div>`;
    return;
  }
  const s = staffAdvanceSummary(_myAdvances);
  document.getElementById('advSummary').innerHTML = `
    <div class="cs-card"><div class="cs-v" style="color:var(--red)">${fmt(s.balance)}</div><div class="cs-l">Balance to repay</div></div>
    <div class="cs-card"><div class="cs-v" style="color:var(--blu)">${s.next ? fmt(s.next.amount) : '—'}</div><div class="cs-l">${s.next ? 'Next deduction · ' + _monthLabel(s.next.month) : 'Next deduction'}</div></div>
    <div class="cs-card"><div class="cs-v" style="color:var(--ylw)">${s.pending}</div><div class="cs-l">Waiting approval</div></div>`;
  box.innerHTML = _myAdvances.length ? _myAdvances.map(_advCard).join('')
    : '<div style="text-align:center;padding:40px 20px;color:var(--tx3)">No advances yet.<br>Tap <strong>+ Request</strong> to ask for a salary or cash advance.</div>';
}

function _advCard(a) {
  const t = advanceTotals(a);
  const sched = (a.schedule || []);
  const done = sched.filter(e => e.status === 'deducted').length;
  const pct = t.principal ? Math.round(t.repaid / t.principal * 100) : 0;
  const amount = a.approvedAmount ?? a.amount;
  const plan = a.startMonth ? `${sched.length} × monthly from ${_monthLabel(a.startMonth)}` : `${a.instalments} month${a.instalments > 1 ? 's' : ''} requested`;
  return `<div class="card adv-card">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px">
      <div><div style="font-weight:800;font-size:15px">${escH(ADVANCE_TYPES[a.type] || 'Advance')}</div>
        <div style="font-size:11px;color:var(--tx3)">${a.requestedAt ? fmtD(a.requestedAt) : ''} · ${escH(plan)}</div></div>
      <span class="bdg ${ADV_BADGE[a.status] || 'bdg-gry'}">${escH(ADVANCE_STATUS[a.status] || a.status)}</span>
    </div>
    <div style="display:flex;justify-content:space-between;align-items:baseline;margin-top:10px">
      <div style="font-size:20px;font-weight:800">${fmt(amount)}</div>
      ${['active', 'settled'].includes(a.status) ? `<div style="font-size:12px;color:var(--tx2)">Balance <strong style="color:${t.balance ? 'var(--red)' : 'var(--grn)'}">${fmt(t.balance)}</strong></div>` : ''}
    </div>
    ${a.approvedAmount != null && a.approvedAmount !== a.amount ? `<div style="font-size:11px;color:var(--tx3)">You asked for ${fmt(a.amount)}</div>` : ''}
    ${['active', 'settled'].includes(a.status) ? `<div class="adv-bar"><span style="width:${pct}%"></span></div>
      <div style="font-size:11px;color:var(--tx3)">${done} of ${sched.length} deductions done · repaid ${fmt(t.repaid)}</div>` : ''}
    ${a.reason ? `<div style="font-size:12px;color:var(--tx2);margin-top:8px">“${escH(a.reason)}”</div>` : ''}
    ${a.adminNote ? `<div style="font-size:12px;margin-top:6px;color:${a.status === 'rejected' ? 'var(--red)' : 'var(--tx2)'}">Admin: ${escH(a.adminNote)}</div>` : ''}
    ${sched.length && a.status !== 'pending' ? `<details style="margin-top:8px"><summary style="font-size:12px;color:var(--acc);cursor:pointer">Deduction plan</summary>
      ${sched.map(e => `<div style="display:flex;justify-content:space-between;font-size:12px;padding:4px 0;border-bottom:1px dashed var(--bdr2)">
        <span>${_monthLabel(e.month)}</span><span>${fmt(e.deducted ?? e.amount)} · ${e.status === 'deducted' ? '✅ deducted' : e.status === 'covered' ? '— not needed' : 'due'}</span></div>`).join('')}
    </details>` : ''}
    ${a.status === 'pending' ? `<div style="text-align:right;margin-top:10px"><button class="btn btn-ghost btn-sm" onclick="cancelMyAdvance('${a.id}')">Cancel request</button></div>` : ''}
  </div>`;
}

function openAdvanceRequest() {
  document.getElementById('advType').value = 'salary';
  document.getElementById('advAmt').value = '';
  document.getElementById('advMonths').value = '1';
  document.getElementById('advReason').value = '';
  _advPreview();
  openM('mAdvance');
}

function _advPreview() {
  const amt = parseFloat(document.getElementById('advAmt').value) || 0;
  const n = parseInt(document.getElementById('advMonths').value, 10) || 1;
  const el = document.getElementById('advPreview');
  if (!el) return;
  if (!amt) { el.textContent = 'Enter an amount to see the monthly deduction.'; return; }
  const plan = advanceSchedule(amt, n, addMonths(monthOf(), 1));
  el.innerHTML = n === 1
    ? `Deducted from your salary in one go: <strong>${fmt(amt)}</strong> (admin sets the month).`
    : `About <strong>${fmt(plan[0].amount)}</strong> a month for ${n} months (admin confirms the plan).`;
}

async function saveAdvanceRequest() {
  const type = document.getElementById('advType').value;
  const amount = Math.round((parseFloat(document.getElementById('advAmt').value) || 0) * 100) / 100;
  const instalments = parseInt(document.getElementById('advMonths').value, 10) || 1;
  const reason = document.getElementById('advReason').value.trim();
  if (!(amount > 0)) { showToast('Enter the amount you need', 'error'); return; }
  if (amount > 100000) { showToast('Amount is too large', 'error'); return; }
  if (!reason) { showToast('Add a short reason', 'error'); return; }
  const btn = document.getElementById('advSaveBtn');
  btn.disabled = true;
  try {
    const { addDoc, collection } = window.__SF;
    await addDoc(collection(db(), ADV_COL), {
      uid: CU.uid, staffName: CU.name || '', staffRole: CU.role || '', zoneId: CU.zoneId || null,
      type, amount, instalments, reason: reason.slice(0, 500), status: 'pending', requestedAt: new Date().toISOString(),
    });
    closeM('mAdvance');
    showToast('Advance request sent ✅', 'success');
    notifyAdmins('💵 Advance request', `${CU.name} asked for ${fmt(amount)} (${ADVANCE_TYPES[type]})`, { tag: 'staff-advance' }).catch?.(() => {});
    loadMyAdvances();
  } catch (e) {
    showToast('Could not send: ' + e.message, 'error');
  } finally { btn.disabled = false; }
}

async function cancelMyAdvance(id) {
  if (!confirm('Cancel this advance request?')) return;
  try {
    const { updateDoc, doc } = window.__SF;
    await updateDoc(doc(db(), ADV_COL, id), { status: 'cancelled', cancelledAt: new Date().toISOString() });
    showToast('Request cancelled', 'success');
    loadMyAdvances();
  } catch (e) { showToast('Could not cancel: ' + e.message, 'error'); }
}
