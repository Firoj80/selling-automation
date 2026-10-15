const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readDocument, saveDocument } = require('../src/content/config-documents');
const { withLock, save } = require('../src/content/content-store');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'selling-gui-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  save(path.join(root, 'product.json'), structuredClone(require('../product.example.json')));
  return root;
}
test('GUI validates four-platform settings, saves backups and rejects stale edits', async t => {
  const root = fixture(t), original = readDocument(root, 'product');
  const invalid = structuredClone(original.data); invalid.strategy.platforms = ['linkedin'];
  await assert.rejects(saveDocument(root, 'product', invalid, original.revision), /Invalid product/);
  const next = structuredClone(original.data); next.strategy.post_frequency_hours = 4;
  const result = await saveDocument(root, 'product', next, original.revision);
  assert.deepEqual(result.data.strategy.platforms, ['x', 'threads', 'facebook', 'instagram']);
  assert.equal(fs.readdirSync(path.join(root, 'private/config-backups')).length, 1);
  await assert.rejects(saveDocument(root, 'product', original.data, original.revision), /Reload/);
});
test('GUI cannot write while the campaign lock is held', async t => {
  const root = fixture(t), original = readDocument(root, 'product');
  await withLock(root, async () => {
    await assert.rejects(saveDocument(root, 'product', original.data, original.revision), /locked/);
  });
});
test('existing campaign protects facts, identity, platform selection, source copy and voice', async t => {
  const root = fixture(t);
  const original = readDocument(root, 'product'); original.data.product_id = 'gui-test-product';
  save(path.join(root, 'product.json'), original.data);
  save(path.join(root, 'private/product-content.json'), { posts: [] });
  for (const modify of [p => p.product.price = '$99', p => p.strategy.platforms = ['x'], p => p.product_id = 'other-product']) {
    const current = readDocument(root, 'product'), next = structuredClone(current.data); modify(next);
    await assert.rejects(saveDocument(root, 'product', next, current.revision), /not editable/);
  }
  for (const kind of ['copy', 'voice']) await assert.rejects(saveDocument(root, kind, 'changed', readDocument(root, kind).revision), /archiving/);
  const current = readDocument(root, 'product'); current.data.strategy.post_frequency_hours = 3;
  assert.equal((await saveDocument(root, 'product', current.data, current.revision)).data.strategy.post_frequency_hours, 3);
});
