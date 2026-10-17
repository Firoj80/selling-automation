const { test } = require('node:test');
const assert = require('node:assert/strict');
const { RuntimeConnectivity, probeConnectivity } = require('../src/content/runtime-connectivity');

test('connectivity accepts HTTP responses but reports network failures without browser actions', async () => {
  let requests = 0;
  const ok = await probeConnectivity(['threads', 'facebook', 'x', 'instagram'], { fetchImpl: async (_, options) => { requests++; assert.equal(options.method, 'HEAD'); return { status: 403 }; } });
  assert.equal(ok.online, true);
  assert.equal(requests, 4);
  const offline = await probeConnectivity(['threads', 'x'], { fetchImpl: async url => { if (url.includes('x.com')) throw new Error('Network offline'); return { status: 200 }; } });
  assert.equal(offline.online, false);
  assert.equal(offline.platforms.find(p => p.platform === 'x').reachable, false);
});

test('offline-to-online transition fires once and ordinary restarts do not force early posts', async () => {
  let now = 0, online = false, calls = 0;
  const monitor = new RuntimeConnectivity({ platforms: ['x'], now: () => now, interval: 15000, check: async () => { calls++; return { online, platforms: [] }; } });
  assert.equal((await monitor.poll()).online, false);
  online = true;
  assert.equal((await monitor.poll()).online, false, 'Connectivity checks are bounded');
  now = 15000;
  assert.equal((await monitor.poll()).resumed, true);
  assert.equal((await monitor.poll()).resumed, false);
  assert.equal(calls, 2);
  now = 30000;
  assert.equal((await monitor.poll()).changed, false);
});

test('offline CLI cycle preserves overdue drafts without opening a browser or calling AI', async t => {
  const fs = require('fs'), os = require('os'), path = require('path');
  const { save } = require('../src/content/content-store');
  const { fingerprint } = require('../src/content/product-config');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'offline-runtime-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const product = { ...structuredClone(require('../product.example.json')), product_id: 'offline-runtime-test', writing: { humanizer_enabled: false }, external_learning: { enabled: false }, learning: { enabled: false }, content_media: { enabled: false } };
  const state = { version: 2, fingerprint: fingerprint(product, ''), createdAt: 0, nextPostAt: 0, cursor: 0, posts: product.strategy.platforms.map((platform, i) => ({ id: `draft-${i}`, platform, text: 'Check the largest folders first.', type: 'value', status: 'pending', scheduledAt: 0 })) };
  save(path.join(root, 'product.json'), product);
  save(path.join(root, 'private/product-content.json'), state);
  const config = require('../config');
  const previous = { DRY_RUN: config.DRY_RUN, POSTING_ENABLED: config.POSTING_ENABLED, APPROVAL_MODE: config.APPROVAL_MODE };
  Object.assign(config, { DRY_RUN: false, POSTING_ENABLED: true, APPROVAL_MODE: false });
  t.after(() => Object.assign(config, previous));
  const browser = require('../src/browser/browser-manager');
  t.mock.method(browser, 'connect', () => assert.fail('Offline cycle must not open a browser'));
  t.mock.method(require('../src/ai/ai-runtime'), 'callAi', () => assert.fail('Offline cycle must not call AI'));
  await require('../src/content/content-cli').run('start', ['--once'], root, { connectivity: { poll: async () => ({ online: false, changed: true, platforms: [] }) } });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'private/product-content.json'))), state);
  assert.equal(fs.existsSync(path.join(root, 'private/product-content.lock')), false);
});
