const fs = require('fs');
const path = require('path');
const { createHash, randomUUID } = require('crypto');
const { isDeepStrictEqual } = require('util');
const { withLock, save } = require('./content-store');
const { validateProduct, loadProduct } = require('./product-config');
const { changedProduct } = require('./config-management');

const documents = { product: 'product.json', copy: 'product-copy.md', voice: 'knowledge/voice.md' };
function readDocument(root, kind) {
  if (!documents[kind]) throw new Error('Unknown configuration document');
  const file = path.join(root, documents[kind]);
  const raw = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  return { data: kind === 'product' ? JSON.parse(raw.replace(/^\uFEFF/, '')) : raw,
    revision: createHash('sha256').update(raw).digest('hex') };
}
function changedKeys(before, after, prefix = '') {
  if (isDeepStrictEqual(before, after)) return [];
  if (before && after && typeof before === 'object' && typeof after === 'object' && !Array.isArray(before) && !Array.isArray(after)) {
    return [...new Set([...Object.keys(before), ...Object.keys(after)])].flatMap(key => changedKeys(before[key], after[key], prefix ? `${prefix}.${key}` : key));
  }
  return [{ key: prefix, value: after }];
}
async function saveDocument(root, kind, data, expectedRevision) {
  return withLock(root, () => {
    const current = readDocument(root, kind);
    if (!expectedRevision || current.revision !== expectedRevision) throw new Error('This document changed. Reload the page before saving.');
    const hasCampaign = ['product-content.json', 'product-generation.json'].some(name => fs.existsSync(path.join(root, 'private', name)));
    let next = data;
    if (kind === 'product') {
      next = validateProduct(data);
      if (hasCampaign) {
        const before = validateProduct(current.data);
        if (!before.product_id && !isDeepStrictEqual(before, next)) throw new Error('Run settings migrate before editing an existing campaign, then reload this page.');
        for (const change of changedKeys(before, next)) changedProduct(before, change.key, change.value);
      }
    } else {
      if (typeof data !== 'string') throw new Error('Document text must be a string');
      if (hasCampaign && data !== current.data) throw new Error('Copy and voice changes require archiving the existing campaign and generation checkpoint first.');
      if (kind === 'copy' && !data.trim() && !loadProduct(root).product.product.description?.trim()) throw new Error('Keep product copy or a product description.');
    }
    if (isDeepStrictEqual(current.data, next)) return current;
    const backup = path.join(root, 'private', 'config-backups', `gui-${Date.now()}-${randomUUID()}.json`);
    save(backup, { document: documents[kind], ...current });
    const file = path.join(root, documents[kind]);
    if (kind === 'product') save(file, next);
    else {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const temporary = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, next, 'utf8');
      fs.renameSync(temporary, file);
    }
    return readDocument(root, kind);
  });
}
module.exports = { readDocument, saveDocument };
