const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

test('ERP cross-project credentials use ADC, not a committed private key', () => {
  const source = read('STSB-ERP/functions/index.js');
  assert.match(source, /credential:\s*admin\.credential\.applicationDefault\(\)/);
  assert.doesNotMatch(source, /BEGIN PRIVATE KEY|private_key_id\s*:|credential\.cert\(/);
});

test('root user rules do not allow self-provisioning or self role escalation', () => {
  const rules = read('firestore.rules');
  const start = rules.indexOf('match /users/{uid} {');
  const end = rules.indexOf('// ZONES', start);
  assert.ok(start >= 0 && end > start, 'users rule block exists');
  const block = rules.slice(start, end);
  assert.doesNotMatch(block, /request\.auth\.uid\s*==\s*uid\s*\n\s*\)\s*\n\s*\);/);
  assert.match(block, /request\.auth\.uid != uid/);
  assert.match(block, /affectedKeys\(\)\.hasOnly\(\[/);
  assert.match(block, /request\.resource\.data\.get\('zoneId',''\) == resource\.data\.get\('zoneId',''\)/);
});

test('push queue cannot be written directly by signed-in clients', () => {
  const rules = read('firestore.rules');
  assert.match(rules, /match \/pushQueue\/{docId} \{\s*\/\/[^\n]*\n\s*allow create: if false;/);
});

test('ERP user self-updates are allowlisted and zone checks fail closed', () => {
  const rules = read('STSB-ERP/firestore.rules');
  assert.match(rules, /request\.resource\.data\.diff\(resource\.data\)\.affectedKeys\(\)\.hasOnly\(\[/);
  assert.match(rules, /docZone != null[\s\S]*docZone != ''[\s\S]*userDoc\(\)\.zone == docZone/);
  assert.doesNotMatch(rules, /allow create, update: if isERPUser\(\)\s*\|\|\s*\(isAuth\(\) && request\.auth\.uid == userId\)/);
});

test('build removes stale JavaScript source maps', () => {
  assert.match(read('build.js'), /file\.endsWith\('\.map'\)/);
});

test('manual deployment fallback cannot run on every push', () => {
  const workflow = read('.github/workflows/deploy.yaml');
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /^\s*push:/m);
});

test('Functions package engine matches configured Node 22 runtime', () => {
  const pkg = JSON.parse(read('functions/package.json'));
  assert.equal(pkg.engines.node, '22');
});
