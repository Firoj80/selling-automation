const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PLATFORMS, validateProduct } = require('../src/content/product-config');

test('example settings and platform registry expose exactly four publishers', () => {
  const expected = ['facebook', 'instagram', 'threads', 'x'];
  assert.deepEqual([...PLATFORMS].sort(), expected);
  assert.deepEqual(Object.keys(require('../config/social-platforms.json').platforms).sort(), expected);
  assert.deepEqual([...validateProduct(require('../product.example.json')).strategy.platforms].sort(), expected);
  for (const platform of expected) {
    const publisher = require(`../src/platforms/${platform}/${platform}-poster`);
    assert.equal(typeof publisher[platform === 'threads' ? 'publishEngagingPost' : 'publishPost'], 'function');
  }
  assert.equal(typeof require('../src/platforms/threads/threads-actions').postComment, 'function');
});

test('browser tab initialization opens all four supported platforms', async () => {
  const manager = require('../src/browser/browser-manager');
  const original = { browser: manager.browser };
  const calls = [];
  try {
    manager.browser = { connected: true };
    for (const platform of ['Threads', 'Facebook', 'X', 'Instagram']) {
      const key = `get${platform}Page`; original[key] = manager[key];
      manager[key] = async () => { calls.push(platform); return platform; };
    }
    assert.deepEqual(await manager.ensureAllPlatformTabs(), { threadsPage: 'Threads', facebookPage: 'Facebook', xPage: 'X', instagramPage: 'Instagram' });
    assert.deepEqual(calls, ['Threads', 'Facebook', 'X', 'Instagram']);
    assert.equal(manager.getLinkedInPage, undefined);
  } finally { Object.assign(manager, original); }
});
