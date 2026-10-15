const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { save, withLock } = require('../src/content/content-store');
const { loadProduct, fingerprint, revisions, validateProduct } = require('../src/content/product-config');
const { ensureIdentity, checkCampaignFacts, submitChange, processChanges } = require('../src/content/config-management');
const { inspect } = require('../src/content/content-recovery');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meta-config-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const product = structuredClone(require('./fixtures/product.json'));
  product.product.description = 'A practical content planning product.';
  save(path.join(root, 'product.json'), product);
  const loaded = loadProduct(root);
  const fp = fingerprint(loaded.product, loaded.copy);
  const posts = [{ id: 'p1', text: 'Keep this exact draft.', platform: 'threads', status: 'needs_review', attemptedAt: 123, result: { reason: 'Unknown submission result' } }];
  save(path.join(root, 'private/product-content.json'), { fingerprint: fp, posts });
  save(path.join(root, 'private/product-generation.json'), { version: 1, fingerprint: fp, posts });
  save(path.join(root, 'private/product-engagement.json'), { fingerprint: fp, turns: {}, optOuts: { 'threads:someone': { at: 1 } } });
  save(path.join(root, 'knowledge/learning/swipe_file.json'), { fingerprint: fp, records: [{ content: 'Retain evidence' }] });
  save(path.join(root, 'knowledge/product/learned_insights.json'), { fingerprint: fp, insights: { hooks: [] }, revision: 'existing-revision' });
  return { root, posts };
}
const read = (root, file) => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));

test('migration preserves drafts, evidence, opt-outs and identity through URL edits', async t => {
  const { root, posts } = fixture(t);
  const loaded = await withLock(root, () => ensureIdentity(root));
  const identity = fingerprint(loaded.product, loaded.copy);
  assert.deepEqual(read(root, 'private/product-content.json').posts, posts);
  assert.equal(read(root, 'private/product-engagement.json').optOuts['threads:someone'].at, 1);
  assert.equal(read(root, 'knowledge/learning/swipe_file.json').records[0].content, 'Retain evidence');
  assert.equal(read(root, 'knowledge/product/learned_insights.json').revision, 'existing-revision');
  const result = await submitChange(root, 'product.sales_url', 'https://example.com/new');
  assert.equal(result.status, 'applied');
  const latest = loadProduct(root);
  assert.equal(fingerprint(latest.product, latest.copy), identity);
  assert.equal(read(root, 'private/product-content.json').fingerprint, identity);
  assert.deepEqual(read(root, 'private/product-content.json').posts, posts);
  assert.equal(ensureIdentity(root).product.product_id, loaded.product.product_id);
  assert.equal(read(root, 'private/config-migration.json').status, 'complete');
});

test('migration refuses mismatched history without rewriting product or drafts', t => {
  const { root } = fixture(t);
  save(path.join(root, 'private/product-content.json'), { fingerprint: 'other-product', posts: [] });
  const before = fs.readFileSync(path.join(root, 'product.json'), 'utf8');
  assert.throws(() => ensureIdentity(root), /do not match/);
  assert.equal(fs.readFileSync(path.join(root, 'product.json'), 'utf8'), before);
  assert.equal(read(root, 'private/product-content.json').fingerprint, 'other-product');
});

test('interrupted migration resumes from journal and rejects unrelated concurrent edits', t => {
  const { root } = fixture(t);
  ensureIdentity(root);
  const journal = read(root, 'private/config-migration.json');
  journal.status = 'pending';
  const entry = journal.entries.find(e => e.file === 'private/product-content.json');
  fs.writeFileSync(path.join(root, entry.file), entry.before);
  save(path.join(root, 'private/config-migration.json'), journal);
  ensureIdentity(root);
  assert.equal(fs.readFileSync(path.join(root, entry.file), 'utf8'), entry.after);
  save(path.join(root, 'private/config-migration.json'), journal);
  save(path.join(root, entry.file), { unrelated: true });
  assert.throws(() => ensureIdentity(root), /Migration conflict/);
  assert.deepEqual(read(root, entry.file), { unrelated: true });
});

test('queued settings apply only between actions and stale revisions are rejected', async t => {
  const { root } = fixture(t);
  ensureIdentity(root);
  await withLock(root, async () => {
    const first = await submitChange(root, 'strategy.view_threshold_to_sell', 25000);
    const second = await submitChange(root, 'strategy.view_threshold_to_sell', 30000);
    assert.equal(first.status, 'pending');
    assert.equal(second.status, 'pending');
    assert.equal(loadProduct(root).product.strategy.view_threshold_to_sell, 20000);
    const results = processChanges(root);
    assert.deepEqual(results.map(r => r.status).sort(), ['applied', 'rejected']);
    assert.ok([25000, 30000].includes(loadProduct(root).product.strategy.view_threshold_to_sell));
    assert.equal(inspect(root).lock.status, 'active');
  });
});

test('interrupted applied request is acknowledged without replay', t => {
  const { root } = fixture(t);
  const { product, copy } = ensureIdentity(root);
  const expectedRevision = revisions(product, copy).config;
  product.product.sales_url = 'https://example.com/new';
  save(path.join(root, 'product.json'), product);
  const id = require('crypto').randomUUID();
  save(path.join(root, `private/management/${id}.json`), { id, status: 'applying', key: 'product.sales_url', value: product.product.sales_url, expectedRevision, targetRevision: revisions(product, copy).config });
  assert.equal(processChanges(root)[0].status, 'applied');
  assert.equal(processChanges(root).length, 0);
});

test('product fact changes require draft review but URL and thresholds do not', t => {
  const { root } = fixture(t);
  const { product, copy } = ensureIdentity(root);
  product.product.sales_url = 'https://example.com/new';
  product.strategy.view_threshold_to_sell = 90000;
  assert.doesNotThrow(() => checkCampaignFacts(root, product, copy));
  product.product.price = '$999';
  assert.throws(() => checkCampaignFacts(root, product, copy), /facts changed/);
});

test('inspection and reset helper preserve uncertain submissions and active locks', async t => {
  const { root, posts } = fixture(t);
  await withLock(root, async () => {
    const before = fs.readFileSync(path.join(root, 'private/product-content.lock'), 'utf8');
    const result = inspect(root);
    assert.equal(result.lock.status, 'active');
    assert.equal(result.posts[0].status, 'needs_review');
    assert.equal(fs.readFileSync(path.join(root, 'private/product-content.lock'), 'utf8'), before);
    assert.deepEqual(read(root, 'private/product-content.json').posts, posts);
  });
});

test('analysis and unknown commands cannot reach the scheduler', async t => {
  const { root } = fixture(t);
  const { run } = require('../src/content/content-cli');
  for (const command of ['scan', 'analyze', 'typo']) await assert.rejects(run(command, [], root), /Unsupported command/);
  assert.equal(fs.existsSync(path.join(root, 'private/product-content.lock')), false);
});

test('invalid thresholds and unsupported setting paths are rejected', async t => {
  const { root } = fixture(t);
  ensureIdentity(root);
  await assert.rejects(async () => submitChange(root, 'strategy.view_thresholds_per_platform.threads', -1), /nonnegative/);
  await assert.rejects(async () => submitChange(root, '__proto__.polluted', true), /not editable/);
  const product = loadProduct(root).product;
  product.seller.usernames = { threads: 'different_handle', facebook: 'another_handle' };
  assert.doesNotThrow(() => validateProduct(product));
  product.seller.usernames.threads = 'bad handle';
  assert.throws(() => validateProduct(product), /handles/);
});

test('stale-lock recovery archives only a stopped owner and preserves publication evidence', async t => {
  const { root, posts } = fixture(t);
  const { recoverStaleLock } = require('../src/content/content-recovery');
  await withLock(root, async () => {
    assert.throws(() => recoverStaleLock(root), /active or cannot be verified/);
    assert.equal(inspect(root).lock.status, 'active');
  });
  const child = require('child_process').spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  assert.equal(child.status, 0);
  save(path.join(root, 'private/product-content.lock'), Number(child.stdout));
  const result = recoverStaleLock(root);
  assert.equal(result.status, 'stale_lock_archived');
  assert.equal(fs.existsSync(result.archived), true);
  assert.deepEqual(read(root, 'private/product-content.json').posts, posts);
  assert.equal(inspect(root).lock.status, 'absent');
});

test('settings command migrates an offline legacy product before applying a URL change', async t => {
  const { root } = fixture(t);
  assert.equal((await submitChange(root, 'product.sales_url', 'https://example.com/buy')).status, 'applied');
  assert.ok(loadProduct(root).product.product_id);
});

test('older ignored-only engagement history is retained but pending replies cannot be rebound', t => {
  const { root } = fixture(t);
  const file = path.join(root, 'private/product-engagement.json');
  const history = { version: 1, fingerprint: 'old-inputs', turns: { one: { status: 'pending_approval', response: 'Older product reply' } }, optOuts: { 'threads:person': { at: 1 } } };
  save(file, history);
  assert.throws(() => ensureIdentity(root), /do not match/);
  history.turns.one = { status: 'ignored', reason: 'Unrelated discussion', at: 1 };
  save(file, history);
  ensureIdentity(root);
  const migrated = read(root, 'private/product-engagement.json');
  assert.deepEqual(migrated.turns, history.turns);
  assert.deepEqual(migrated.optOuts, history.optOuts);
  assert.equal(migrated.migration.previousFingerprint, 'old-inputs');
});
