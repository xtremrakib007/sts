// ═══════════════════════════════════════════════════════════════
// Collection dues reminder: pure logic (tested in tests/dues-reminder.test.js)
//
// The super admin sets it in ERP → Settings → Dues reminder
// (stsb_config/duesReminder). An hourly job sends each salesman a push
// listing their outlets that still owe money, every N days at the set
// hour (Malaysia time), and the owner a summary.
// ═══════════════════════════════════════════════════════════════
const TZ_OFFSET_HOURS = 8; // Asia/Kuala_Lumpur, no daylight saving

const n = (v) => Number(v) || 0;
const r2 = (v) => Math.round(v * 100) / 100;

// What an order still counts for: its delivered value (after a partial
// delivery) less goods returned on credit notes. Same as the Sales App.
function orderAmountDue(o) {
  const base = o.deliveredTotal != null ? n(o.deliveredTotal) : n(o.total);
  return Math.max(0, base - n(o.returnedTotal));
}

// The salesman responsible for an outlet.
function outletRep(o) {
  return o.assignedRepId || o.repId || o.assignedTo || o.createdBy || null;
}

// Outstanding per outlet: orders (not cancelled) − collections + approved
// opening balance. Returns only outlets that owe at least minDue.
function computeOutletDues({ outlets, orders, collections }, minDue = 0.01) {
  const owed = {}, paid = {}, oldest = {};
  for (const o of orders) {
    if (!o.outletId || o.status === 'Cancelled') continue;
    owed[o.outletId] = (owed[o.outletId] || 0) + orderAmountDue(o);
    const d = o.date || (o.createdAt && String(o.createdAt).slice(0, 10));
    if (d && (!oldest[o.outletId] || d < oldest[o.outletId])) oldest[o.outletId] = d;
  }
  for (const c of collections) {
    if (c.outletId) paid[c.outletId] = (paid[c.outletId] || 0) + n(c.amount);
  }
  const out = [];
  for (const o of outlets) {
    const opening = o.balanceStatus === 'approved' ? n(o.openingBalance) : 0;
    const due = r2(Math.max(0, (owed[o.id] || 0) - (paid[o.id] || 0) + opening));
    if (due >= Math.max(0.01, n(minDue))) {
      out.push({ outletId: o.id, name: o.name || o.id, repId: outletRep(o), zoneId: o.zoneId || o._zoneId || null,
        phone: o.phone || '', due, firstOrderDate: oldest[o.id] || null });
    }
  }
  return out.sort((a, b) => b.due - a.due);
}

// Local (Malaysia) calendar date and hour for a UTC instant.
function localParts(date) {
  const t = new Date(date.getTime() + TZ_OFFSET_HOURS * 3600e3);
  return { day: t.toISOString().slice(0, 10), hour: t.getUTCHours() };
}

const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400e3);

// Whether the hourly job should send now. Sends once on a due day, at or
// after the set hour; then waits everyDays calendar days.
function isReminderDue(cfg, now = new Date()) {
  if (!cfg || !cfg.enabled) return false;
  const every = Math.max(1, Math.floor(n(cfg.everyDays) || 1));
  const { day, hour } = localParts(now);
  if (hour < Math.min(23, Math.max(0, Math.floor(n(cfg.hour))))) return false;
  if (!cfg.lastSentDay) return true;
  return daysBetween(cfg.lastSentDay, day) >= every;
}

const fmtRM = (v) => 'RM ' + n(v).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// One push per salesman: how many outlets owe, the total and the largest.
function buildRepReminders(dues, maxListed = 3) {
  const byRep = {};
  for (const d of dues) {
    if (!d.repId) continue;
    (byRep[d.repId] = byRep[d.repId] || []).push(d);
  }
  return Object.entries(byRep).map(([repId, list]) => {
    const total = r2(list.reduce((s, d) => s + d.due, 0));
    const top = list.slice(0, maxListed).map((d) => `${d.name} ${fmtRM(d.due)}`).join(', ');
    const more = list.length > maxListed ? ` +${list.length - maxListed} more` : '';
    return {
      repId, zoneId: list[0].zoneId, outlets: list.length, total,
      title: `💰 Collection reminder: ${fmtRM(total)} due`,
      body: `${list.length} outlet${list.length > 1 ? 's' : ''} to collect: ${top}${more}`,
    };
  });
}

function buildOwnerSummary(dues, reminders) {
  const total = r2(dues.reduce((s, d) => s + d.due, 0));
  return {
    title: `💰 Dues reminder sent to ${reminders.length} salesm${reminders.length === 1 ? 'an' : 'en'}`,
    body: `${dues.length} outlet${dues.length === 1 ? '' : 's'} owe ${fmtRM(total)} in total.`,
    total,
  };
}

module.exports = { orderAmountDue, outletRep, computeOutletDues, localParts, isReminderDue, buildRepReminders, buildOwnerSummary, TZ_OFFSET_HOURS };
