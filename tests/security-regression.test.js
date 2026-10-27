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
  assert.match(rules, /allow create: if isSuperAdmin\(\)[\s\S]*request\.resource\.data\.get\('role',''\) in \['sub_admin','sales_rep','delivery_man'\]/);
  assert.match(rules, /request\.resource\.data\.get\('zone',''\) == userDoc\(\)\.zone/);
  assert.match(rules, /resource\.data\.get\('role',''\) != 'super_admin'/);
  assert.match(rules, /request\.auth\.uid != userId[\s\S]*resource\.data\.get\('role',''\) != 'super_admin'/);
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


test('ERP zone admins cannot create or promote super admins or change users across zones', () => {
  const rules = read('STSB-ERP/firestore.rules');
  const start = rules.indexOf('match /users/{userId} {');
  const end = rules.indexOf('//  config — company profile', start);
  assert.ok(start >= 0 && end > start, 'ERP users rule block exists');
  const block = rules.slice(start, end);
  assert.match(block, /request\.resource\.data\.get\('role',''\) in \['sub_admin','sales_rep','delivery_man'\]/);
  assert.match(block, /request\.resource\.data\.get\('zone',''\) == userDoc\(\)\.zone/);
  assert.match(block, /request\.resource\.data\.get\('zone',''\) == resource\.data\.get\('zone',''\)/);
  assert.match(block, /resource\.data\.get\('role',''\) != 'super_admin'/);
});



test('ERP attendance records cannot change their owner during update', () => {
  const rules = read('STSB-ERP/firestore.rules');
  const start = rules.indexOf('match /attendance/{recordId} {');
  const end = rules.indexOf('//  fcmTokens', start);
  assert.ok(start >= 0 && end > start, 'attendance rule block exists');
  const block = rules.slice(start, end);
  assert.match(block, /resource\.data\.uid == request\.auth\.uid[\s\S]*request\.resource\.data\.uid == resource\.data\.uid/);
});

test('ERP FCM tokens can only be written by their owning user', () => {
  const rules = read('STSB-ERP/firestore.rules');
  const start = rules.indexOf('match /fcmTokens/{tokenId} {');
  const end = rules.indexOf('//  stsb_* prefixed collections', start);
  assert.ok(start >= 0 && end > start, 'ERP FCM token rule block exists');
  const block = rules.slice(start, end);
  assert.match(block, /allow create, update: if isKnownUser\(\) && request\.auth\.uid == tokenId/);
  assert.match(block, /allow delete: if isSuperAdmin\(\) \|\| \(isKnownUser\(\) && request\.auth\.uid == tokenId\)/);
  assert.doesNotMatch(block, /allow write: if isKnownUser\(\)/);
});

test('service worker precaches the actual hosted bundle and refreshes its cache version', () => {
  const sw = read('sw.js');
  assert.match(sw, /const CACHE_VERSION = 'stfm-v11'/);
  assert.match(sw, /'\/js\/app\.min\.js'/);
  assert.doesNotMatch(sw, /'\/app\.js'/);
});


test('root delete requests require an internal requester and valid pending request data', () => {
  const rules = read('firestore.rules');
  const start = rules.indexOf('match /deleteRequests/{reqId} {');
  const end = rules.indexOf('// DEVICE APPROVAL', start);
  assert.ok(start >= 0 && end > start, 'root deleteRequests rule block exists');
  const block = rules.slice(start, end);
  assert.match(block, /allow create: if isSignedIn\(\)[\s\S]*isStfmUser\(\)/);
  assert.match(block, /get\('requestedBy', ''\) == request\.auth\.uid/);
  assert.match(block, /get\('status', ''\) == 'pending'/);
  assert.match(block, /'outlet', 'order', 'collection', 'product', 'route', 'broadcast'/);
  assert.match(block, /get\('reason', ''\) is string[\s\S]*get\('reason', ''\)\.size\(\) > 0/);
  assert.match(block, /get\('_zoneId', ud\(\)\.get\('zoneId', ''\)\) == ud\(\)\.get\('zoneId', ''\)/);
});


test('delivery staff updates are limited to valid status transitions and actual app fields', () => {
  const rules = read('firestore.rules');
  const start = rules.indexOf('match /orders/{orderId} {');
  const end = rules.indexOf('match /outlets/{outletId} {', start);
  assert.ok(start >= 0 && end > start, 'root orders rule block exists');
  const block = rules.slice(start, end);
  assert.match(block, /resource\.data\.deliveryManId == request\.auth\.uid/);
  assert.match(block, /resource\.data\.get\('status', ''\) == 'Assigned'[\s\S]*request\.resource\.data\.get\('status', ''\) == 'In Transit'/);
  assert.match(block, /resource\.data\.get\('status', ''\) == 'In Transit'[\s\S]*request\.resource\.data\.get\('status', ''\) in \['Delivered', 'Failed'\]/);
  assert.match(block, /'inTransitAt','inTransitBy'[\s\S]*'deliveredAt','deliveredBy'[\s\S]*'failureReason','failedAt','failedBy'/);
  assert.match(block, /request\.resource\.data\.inTransitBy == request\.auth\.uid/);
  assert.match(block, /request\.resource\.data\.deliveredBy == request\.auth\.uid/);
  assert.match(block, /request\.resource\.data\.failedBy == request\.auth\.uid/);
});
