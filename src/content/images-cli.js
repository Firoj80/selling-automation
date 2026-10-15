const fs = require('fs');
const path = require('path');
const { mediaSettings } = require('./media-settings');
const { loadProduct } = require('./product-config');
const { withLock } = require('./content-store');
async function imagesCommand(root, args) {
  const { product } = loadProduct(root);
  if (args[0] === 'status' && args.length === 1) {
    const dir = path.join(root, 'private', 'image-jobs');
    const jobs = fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => path.join(dir, e.name, 'job.json')).filter(fs.existsSync).map(file => {
      const j = JSON.parse(fs.readFileSync(file, 'utf8')); return { id: j.id, key: j.key, status: j.status, attempts: j.attempts, error: j.error, outputPath: j.status === 'ready' ? j.outputPath : undefined };
    }) : [];
    return { settings: mediaSettings(product), jobs };
  }
  if (args[0] === 'preview' && args.length === 3 && args[1] === '--platform' && product.strategy.platforms.includes(args[2])) {
    return withLock(root, async () => {
      const state = JSON.parse(fs.readFileSync(path.join(root, 'private', 'product-content.json'), 'utf8'));
      const source = state.posts.find(p => p.platform === args[2] && !['published', 'publishing', 'needs_review'].includes(p.status));
      if (!source) throw new Error('No unattempted saved caption for this platform');
      const post = { ...source, id: `photo-preview-${source.id}`, status: 'needs_media', media: { required: true } };
      const media = new (require('./content-media').ContentMedia)({ root, ai: require('../ai/ai-runtime') });
      const previewProduct = structuredClone(product); previewProduct.content_media = { ...product.content_media, provider: 'antigravity', image_fallback: 'hold' };
      await media.prepare(post, previewProduct, () => {});
      if (post.media.status !== 'ready') throw new Error(post.media.error || 'Image preview failed');
      return { status: 'preview', queueUnchanged: true, platform: post.platform, text: post.text, media: post.media };
    });
  }
  throw new Error('Usage: images status | images preview --platform threads|facebook. Retry draft images with queue retry-media POST_ID.');
}
module.exports = { imagesCommand };
