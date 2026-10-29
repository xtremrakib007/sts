const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const A = require('../js/advance-core.js');

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const by = { uid: 'adm', name: 'Admin' };

const active = (amount, n, start = '2026-11') => ({
  status: 'active', amount, approvedAmount: amount, startMonth: start,
  schedule: A.advanceSchedule(amount, n, start), repayments: [],
});

test('schedule splits into equal monthly instalments, cents on the last', () => {
  const s = A.advanceSchedule(1000, 3, '2026-11');
  assert.deepEqual(s.map((e) => e.month), ['2026-11', '2026-12', '2027-01']);
  assert.deepEqual(s.map((e) => e.amount), [333.33, 333.33, 333.34]);
  assert.equal(A.advanceSchedule(500, 1, '2026-12')[0].amount, 500);
  assert.equal(A.advanceSchedule(100, 99, '2026-01').length, A.MAX_INSTALMENTS);
});

test('monthly deduction lowers the balance and settles on the last one', () => {
  let a = active(600, 3);
  assert.deepEqual(A.deductionsForMonth([a], '2026-10'), [], 'nothing before the first month');
  for (const m of ['2026-11', '2026-12']) {
    const [row] = A.deductionsForMonth([a], m);
    assert.equal(row.entry.amount, 200);
    a = { ...a, ...A.applySalaryDeduction(a, m, by) };
  }
  assert.equal(a.balance, 200);
  assert.equal(a.status, 'active');
  a = { ...a, ...A.applySalaryDeduction(a, '2027-01', by) };
  assert.equal(a.balance, 0);
  assert.equal(a.status, 'settled');
  assert.deepEqual(A.deductionsForMonth([a], '2027-02'), []);
  assert.equal(a.repayments.length, 3);
  assert.ok(a.repayments.every((r) => r.method === 'salary'));
});

test('a missed month shows as overdue and is taken first', () => {
  const a = active(300, 3, '2026-09');
  const [row] = A.deductionsForMonth([a], '2026-11');
  assert.equal(row.entry.month, '2026-09');
  assert.equal(row.overdue, true);
});

test('a cash repayment shortens the last deductions', () => {
  let a = active(900, 3);
  a = { ...a, ...A.applyRepayment(a, 400, 'cash', by, 'receipt 12', '2026-11-05') };
  assert.equal(a.balance, 500);
  assert.deepEqual(A.dueInstalments(a).map((e) => [e.month, e.amount]), [['2026-11', 300], ['2026-12', 200]]);
  assert.throws(() => A.applyRepayment(a, 600, 'cash', by), /More than the balance/);
  a = { ...a, ...A.applyRepayment(a, 500, 'bank', by) };
  assert.equal(a.status, 'settled');
  assert.ok(a.schedule.every((e) => e.status === 'covered'));
});

test('approved but not paid out: no deductions yet; summary counts it', () => {
  const a = { ...active(300, 3), status: 'approved' };
  assert.deepEqual(A.deductionsForMonth([a], '2027-06'), []);
  const s = A.staffAdvanceSummary([a, { status: 'pending', amount: 50 }, active(200, 2, '2026-12')]);
  assert.equal(s.balance, 500);
  assert.equal(s.pending, 1);
  assert.deepEqual([s.next.month, s.next.amount], ['2026-12', 100]);
});

test('Sales App and ERP are wired to the staff advances collection', () => {
  const build = read('build.js');
  assert.match(build, /'js\/advance-core\.js',\n  'js\/advances\.js',\n  'js\/boot\.js'/);
  assert.match(build, /'js\/advance-core\.js': 'vendor\/advance-core\.js'/);
  assert.match(read('js/advances.js'), /stsb_staff_advances/);
  const portal = read('public/portal/index.html');
  assert.match(portal, /src="\/vendor\/advance-core\.js"/);
  assert.match(portal, /collection\(_db, C\('staff_advances'\)\)/);
  const rules = read('firestore.rules');
  const block = rules.slice(rules.indexOf('function validAdvanceRequest()'), rules.indexOf('match /stsb_suppliers/'));
  assert.match(block, /d\.uid == request\.auth\.uid/);
  assert.match(block, /d\.status == 'pending'/);
  assert.match(block, /affectedKeys\(\)\.hasOnly\(\['status', 'cancelledAt'\]\)/);
});
