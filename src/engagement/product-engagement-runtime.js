const fs = require('fs');
const path = require('path');
const { save } = require('../content/content-store');
const { ProductEngagement } = require('./product-engagement');
const { ProductReplyEngine } = require('./product-reply-engine');
const { ProductBrowserAdapter } = require('./product-browser-adapter');
function createEngagement({ root, product, copy, campaign, observer }) {
  const file = path.join(root, 'private', 'product-engagement.json');
  const state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { version: 1, fingerprint: campaign.fingerprint, turns: {}, optOuts: {} };
  if (state.fingerprint !== campaign.fingerprint) throw new Error('Product engagement belongs to different product inputs. Archive its state before starting the new campaign.');
  const runner = new ProductEngagement({ product, copy, state, observer, engine: new ProductReplyEngine({ writing: campaign.writing }), adapter: new ProductBrowserAdapter({ campaign }), persist: data => save(file, data) });
  return runner;
}
module.exports = { createEngagement };
