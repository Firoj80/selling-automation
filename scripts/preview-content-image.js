// Render a local preview only. Saved queue entries and social accounts are unchanged.
const fs = require('fs');
const path = require('path');
const { ContentMedia, sourceBrief } = require('../src/content/content-media');
async function main() {
  const root = path.resolve(__dirname, '..');
  const { product } = require('../src/content/product-config').loadProduct(root);
  product.content_media = { ...product.content_media, provider: 'card' };
  const state = JSON.parse(fs.readFileSync(path.join(root, 'private/product-content.json'), 'utf8'));
  const source = process.argv[2] ? state.posts.find(p => p.id === process.argv[2]) : state.posts.find(p => p.status === 'pending');
  if (!source) throw new Error('No matching draft. Usage: node scripts/preview-content-image.js [POST_ID]');
  const preview = { ...source, id: `preview-${source.id}`, media: { required: true } };
  const media = new ContentMedia({ root, ai: { callAi: async () => sourceBrief(source.text) } });
  try {
    await media.prepare(preview, product, () => {});
    if (preview.media.status !== 'ready') throw new Error(preview.media.error);
    console.log(`Preview only; queue unchanged: ${preview.media.path}`);
  } finally { require('../src/browser/browser-manager').disconnect(); }
}
main().catch(err => { console.error(err.message); process.exitCode = 1; });
