const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { save, withLock } = require('../src/content/content-store');
const { autoRecover } = require('../src/content/content-recovery');
function fixture(t, changes = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'startup-recovery-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const product = structuredClone(require('../product.example.json'));
  save(path.join(root, 'product.json'), product);
  const state = { version: 2, createdAt: 0, nextPostAt: 0, posts: [
    { id: 'failed', platform: 'facebook', text: 'Check the largest folders first.', type: 'value', status: 'needs_review', attemptedAt: 100, result: { success: false, reason: 'Detached frame' }, ...changes },
    { id: 'next', platform: 'threads', text: 'Check your unused folders.', type: 'value', status: 'pending', scheduledAt: 0 }
  ] };
  save(path.join(root, 'private/product-content.json'), state);
  return { root, product, read: () => JSON.parse(fs.readFileSync(path.join(root, 'private/product-content.json'))) };
}
test('startup automatically retries only confirmed pre-submission failures and preserves a backup', async t => {
  const f = fixture(t, { submission: { version: 1, state: 'preparing' } });
  const result = await autoRecover(f.root, { verify: () => assert.fail('Pre-submit failures need no browser'), now: () => 500 });
  assert.equal(result.status, 'ready');
  const post = f.read().posts[0];
  assert.equal(post.status, 'pending');
  assert.equal(post.result, undefined);
  assert.equal(post.attemptedAt, undefined);
  assert.equal(post.revisions[0].previous.result.reason, 'Detached frame');
  assert.equal(fs.readdirSync(path.join(f.root, 'private/config-backups')).length, 1);
});
test('startup confirms already-published posts instead of requeuing them', async t => {
  const f = fixture(t, { submission: { version: 1, state: 'may_have_submitted' } });
  await autoRecover(f.root, { verify: async () => ({ verified: true, verifiedMediaCount: 1, postUrl: 'https://www.facebook.com/seller/posts/123' }), now: () => 500 });
  assert.equal(f.read().posts[0].status, 'published');
  assert.equal(f.read().posts[0].result.postUrl, 'https://www.facebook.com/seller/posts/123');
});
test('unverifiable submissions pause only their platform and permit other platforms to continue', async t => {
  const f = fixture(t);
  const result = await autoRecover(f.root, { verify: async () => null, now: () => 500 });
  assert.equal(result.status, 'ready_with_paused_platforms');
  assert.deepEqual(result.heldPlatforms, ['facebook']);
  const state = f.read();
  assert.equal(state.posts[0].status, 'needs_review');
  assert.ok(state.recovery.platformHolds.facebook);
  const scheduler = new (require('../src/content/content-scheduler').ContentScheduler)({ product: f.product, state, now: () => 500, persist: () => {}, publish: async post => { assert.equal(post.platform, 'threads'); return { success: true, verified: true }; } });
  assert.equal((await scheduler.tick({ dryRun: false })).post.platform, 'threads');
});
test('recovery does not change files belonging to an active worker', async t => {
  const f = fixture(t), before = f.read();
  await withLock(f.root, async () => await assert.rejects(autoRecover(f.root, { verify: async () => null }), /active/));
  assert.deepEqual(f.read(), before);
});
test('the durable submit checkpoint takes precedence over contradictory submitted=false output', async t => {
  const f = fixture(t, { submission: { version: 1, state: 'may_have_submitted' }, result: { submitted: false } });
  const result = await autoRecover(f.root, { verify: async () => null });
  assert.deepEqual(result.heldPlatforms, ['facebook']);
  assert.equal(f.read().posts[0].status, 'needs_review');
});
test('an existing publication cannot be reused as proof of a different submission', async t => {
  const f = fixture(t);
  const state = f.read();
  state.posts.push({ id: 'old', platform: 'facebook', status: 'published', publishedAt: 1, result: { success: true, verified: true, postUrl: 'https://www.facebook.com/seller/posts/123' } });
  save(path.join(f.root, 'private/product-content.json'), state);
  const result = await autoRecover(f.root, { verify: async () => ({ verified: true, verifiedMediaCount: 1, postUrl: 'https://www.facebook.com/seller/posts/123' }) });
  assert.deepEqual(result.heldPlatforms, ['facebook']);
  assert.equal(f.read().posts[0].status, 'needs_review');
});
test('the scheduler persists a submit checkpoint before executing an outbound action', async () => {
  const product = structuredClone(require('./fixtures/product.json'));
  const state = { createdAt: 0, nextPostAt: 0, posts: [{ id: 'test', platform: 'threads', status: 'pending', type: 'value', text: 'Check the largest folders first.' }] };
  const writes = [];
  const scheduler = new (require('../src/content/content-scheduler').ContentScheduler)({ product, state, now: () => 500, persist: () => writes.push(state.posts[0].submission?.state), publish: async (_, __, onSubmission) => { assert.equal(writes[writes.length - 1], 'preparing'); onSubmission(); assert.equal(writes[writes.length - 1], 'may_have_submitted'); throw new Error('Connection lost after click'); } });
  await assert.rejects(scheduler.tick({ dryRun: false }), /review/);
  assert.equal(state.posts[0].submission.state, 'may_have_submitted');
});
