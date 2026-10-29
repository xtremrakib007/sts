const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const D = require('../functions/dues-reminder.js');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const data = {
  outlets: [
    { id: 'o1', name: 'Kedai A', createdBy: 'rep1' },
    { id: 'o2', name: 'Kedai B', assignedRepId: 'rep2', createdBy: 'adm' },
    { id: 'o3', name: 'Kedai C', createdBy: 'rep1', balanceStatus: 'approved', openingBalance: 40 },
    { id: 'o4', name: 'Paid up', createdBy: 'rep1' },
  ],
  orders: [
    { outletId: 'o1', total: 100, status: 'Confirmed', date: '2026-10-01' },
    { outletId: 'o1', total: 50, status: 'Cancelled' },
    { outletId: 'o2', total: 80, deliveredTotal: 60, returnedTotal: 10, status: 'Delivered' },
    { outletId: 'o4', total: 20, status: 'Delivered' },
  ],
  collections: [{ outletId: 'o1', amount: 30 }, { outletId: 'o4', amount: 20 }],
};

test('outlet dues: orders − collections + approved opening, cancelled ignored', () => {
  const dues = D.computeOutletDues(data);
  assert.deepEqual(dues.map((d) => [d.outletId, d.due, d.repId]), [['o1', 70, 'rep1'], ['o2', 50, 'rep2'], ['o3', 40, 'rep1']]);
  assert.equal(dues[0].firstOrderDate, '2026-10-01');
  assert.deepEqual(D.computeOutletDues(data, 60).map((d) => d.outletId), ['o1'], 'minimum due filters small balances');
});

test('one reminder per salesman with total and top outlets', () => {
  const r = D.buildRepReminders(D.computeOutletDues(data));
  const rep1 = r.find((x) => x.repId === 'rep1');
  assert.equal(rep1.outlets, 2);
  assert.equal(rep1.total, 110);
  assert.match(rep1.title, /RM 110\.00 due/);
  assert.match(rep1.body, /2 outlets to collect: Kedai A RM 70\.00, Kedai C RM 40\.00/);
  const many = D.buildRepReminders(Array.from({ length: 5 }, (_, i) => ({ repId: 'x', name: 'O' + i, due: 10 })));
  assert.match(many[0].body, /\+2 more$/);
  assert.match(D.buildOwnerSummary(D.computeOutletDues(data), r).body, /3 outlets owe RM 160\.00/);
});

test('schedule: every N days at the set Malaysia hour, once per day', () => {
  const at = (iso) => new Date(iso);
  const cfg = { enabled: true, everyDays: 3, hour: 9 };
  assert.equal(D.isReminderDue({ ...cfg, enabled: false }, at('2026-11-01T02:00:00Z')), false, 'off');
  assert.equal(D.isReminderDue(cfg, at('2026-11-01T00:30:00Z')), false, '08:30 MYT is before 9');
  assert.equal(D.isReminderDue(cfg, at('2026-11-01T01:05:00Z')), true, '09:05 MYT, never sent');
  const sent = { ...cfg, lastSentDay: '2026-11-01' };
  assert.equal(D.isReminderDue(sent, at('2026-11-01T05:00:00Z')), false, 'already sent today');
  assert.equal(D.isReminderDue(sent, at('2026-11-03T05:00:00Z')), false, 'only 2 days later');
  assert.equal(D.isReminderDue(sent, at('2026-11-04T01:00:00Z')), true, '3 days later at 9am');
  assert.equal(D.localParts(at('2026-11-01T17:30:00Z')).day, '2026-11-02', 'MYT date rolls over at 16:00 UTC');
});

test('reminder is wired: hourly job, send-now trigger, ERP settings, app dues list', () => {
  const fn = read('functions/index.js');
  assert.match(fn, /exports\.duesReminderHourly = functions\.pubsub\.schedule\('every 60 minutes'\)\.timeZone\('Asia\/Kuala_Lumpur'\)/);
  assert.match(fn, /exports\.duesReminderRunNow = functions\.firestore\.document\(`\$\{erp\.erpCol\('config'\)\}\/duesReminder`\)\.onUpdate/);
  assert.match(fn, /screen: 'collection', type: 'dues_reminder'/);
  const portal = read('public/portal/index.html');
  assert.match(portal, /doc\(_db, C\('config'\), 'duesReminder'\)/);
  assert.match(portal, /runNowAt: new Date\(\)\.toISOString\(\)/);
  assert.match(read('js/collections.js'), /async function loadOutletDues\(\)/);
  assert.match(read('js/fcm.js'), /goPage\(screen\)/);
});
