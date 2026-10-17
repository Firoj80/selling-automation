const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateProduct } = require('../src/content/product-config');
const { activePlatforms } = require('../src/content/publishing-settings');
const { ContentScheduler } = require('../src/content/content-scheduler');
const { syncQueue } = require('../src/content/content-queue');

test('X pause preserves its queue and feature while other platforms use one-hour intervals', async () => {
  const product = validateProduct({ ...structuredClone(require('../product.example.json')), publishing: { disabled_platforms: ['x'] } });
  product.strategy.post_frequency_hours = 1;
  const now = Date.now();
  const state = { posts: ['x', 'threads', 'facebook'].map((platform, i) => ({ id: `${i}`, platform, status: 'pending', type: 'value', text: 'Check the largest folders first.', scheduledAt: 0 })), createdAt: 0, nextPostAt: 0 };
  state.posts.push({ ...state.posts[1], id: 'next-threads' });
  const paused = structuredClone(state.posts[0]);
  const sent = [];
  const scheduler = new ContentScheduler({ product, state, now: () => now, persist: () => {}, publish: async post => { sent.push(post.platform); return { success: true, verified: true }; } });
  assert.equal((await scheduler.tick({ dryRun: false })).post.platform, 'threads');
  assert.equal((await scheduler.tick({ dryRun: false })).post.platform, 'facebook');
  assert.equal((await scheduler.tick({ dryRun: false })).status, 'waiting');
  assert.deepEqual(sent, ['threads', 'facebook']);
  assert.deepEqual(state.posts[0], paused);
  assert.equal(scheduler.getNextPostTime().getTime(), now + 3600000);
  syncQueue(state, product);
  assert.equal(state.nextPostAt, now + 3600000);
  assert.deepEqual(activePlatforms(product), ['threads', 'facebook', 'instagram']);
  assert.equal(typeof require('../src/platforms/x/x-poster').publishPost, 'function');
  product.publishing.disabled_platforms = [];
  assert.equal((await scheduler.tick({ dryRun: false })).post.platform, 'x');
});

test('paused X is rejected before either central or direct live publishing opens a browser', async t => {
  const product = validateProduct({ ...structuredClone(require('../product.example.json')), publishing: { disabled_platforms: ['x'] } });
  await assert.rejects(require('../src/content/content-cli').publish({ platform: 'x' }, product), /disabled/);
  t.mock.method(require('../src/content/product-config'), 'loadProduct', () => ({ product, copy: '' }));
  t.mock.method(require('../src/browser/browser-manager'), 'getXPage', () => assert.fail('Disabled X must not open the browser'));
  const config = require('../config');
  const previousApproval = config.APPROVAL_MODE; config.APPROVAL_MODE = false;
  t.after(() => { config.APPROVAL_MODE = previousApproval; });
  const result = await require('../src/platforms/x/x-poster').publishPost({ text: 'A useful tip.', mediaPaths: ['unused.png'], username: 'seller', dryRun: false, postingEnabled: true });
  assert.equal(result.success, false);
  assert.equal(result.submitted, false);
  assert.match(result.reason, /disabled/);
});

test('disabled platform settings reject typos, duplicates and malformed values', () => {
  for (const value of [null, { disabled_platforms: null }, { disabled_platforms: ['twitter'] }, { disabled_platforms: ['x', 'x'] }, { enabled: false }]) {
    assert.throws(() => validateProduct({ ...structuredClone(require('../product.example.json')), publishing: value }), /publishing/);
  }
});

test('pausing an unreachable publisher immediately removes it from connectivity checks', async () => {
  const { RuntimeConnectivity } = require('../src/content/runtime-connectivity');
  let requests = 0;
  const monitor = new RuntimeConnectivity({ platforms: ['threads', 'x'], now: () => 0, check: async platforms => { requests++; return { online: !platforms.includes('x'), platforms: [] }; } });
  assert.equal((await monitor.poll()).online, false);
  monitor.platforms = ['threads'];
  assert.equal((await monitor.poll()).resumed, true);
  assert.equal(requests, 2);
});
