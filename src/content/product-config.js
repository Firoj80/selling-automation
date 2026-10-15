const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PLATFORMS = ['threads', 'facebook', 'x', 'instagram'];
function validateProduct(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid product.json: expected an object');
  const data = JSON.parse(JSON.stringify(input));
  const errors = [];
  if (data.product_id !== undefined && (typeof data.product_id !== 'string' || !/^[a-zA-Z0-9_-]{8,80}$/.test(data.product_id))) errors.push('product_id must be a stable identifier of 8 to 80 letters, digits, underscores or hyphens');
  if (data.config_version !== undefined && data.config_version !== 1) errors.push('Unsupported config_version');
  if (data.seller?.usernames !== undefined) {
    const names = data.seller.usernames;
    if (!names || typeof names !== 'object' || Array.isArray(names) || Object.entries(names).some(([key, value]) => !PLATFORMS.includes(key) || typeof value !== 'string' || !value.trim() || /\s/.test(value))) errors.push('seller.usernames must map supported platforms to nonempty handles without whitespace');
  }
  for (const accObj of [data.target_accounts, data.writing?.target_accounts]) {
    if (accObj !== undefined) {
      if (!accObj || typeof accObj !== 'object' || Array.isArray(accObj) || Object.entries(accObj).some(([key, value]) => !['x', 'threads'].includes(key) || typeof value !== 'string' || !value.trim() || /\s/.test(value.replace(/^@/, '')))) {
        errors.push('target_accounts must map "x" or "threads" to nonempty handles without whitespace');
      } else {
        for (const [k, v] of Object.entries(accObj)) {
          accObj[k] = v.trim().replace(/^@/, '');
        }
      }
    }
  }
  for (const section of ['seller', 'product', 'strategy']) {
    if (data[section] !== undefined && (!data[section] || typeof data[section] !== 'object' || Array.isArray(data[section]))) errors.push(`${section} must be an object`);
  }
  for (const [section, fields] of Object.entries({ seller: ['name', 'username'], product: ['name', 'type', 'price'] })) {
    for (const field of fields) {
      if (typeof data?.[section]?.[field] !== 'string' || !data[section][field].trim()) errors.push(`${section}.${field} must be a nonempty string`);
    }
  }
  if (data.product?.sales_url !== undefined && data.product.sales_url !== '') {
    try { if (typeof data.product.sales_url !== 'string' || !['https:', 'http:'].includes(new URL(data.product.sales_url).protocol)) throw new Error(); } catch { errors.push('product.sales_url must be empty or an HTTP(S) URL'); }
  }
  if (!Array.isArray(data?.product?.key_topics) || !data.product.key_topics.length || data.product.key_topics.some(t => typeof t !== 'string' || !t.trim())) errors.push('product.key_topics must contain nonempty strings');
  for (const [section, field] of [['product', 'description'], ['product', 'target_audience'], ['seller', 'bio_style']]) {
    if (data?.[section]?.[field] !== undefined && typeof data[section][field] !== 'string') errors.push(`${section}.${field} must be a string`);
  }
  data.strategy = { platforms: ['threads'], post_frequency_hours: 3, value_posts_before_selling: 15, view_threshold_to_sell: 20000, product_mention_ratio: '1 in 5 posts', ...data.strategy };
  const s = data.strategy;
  if (!Array.isArray(s.platforms) || !s.platforms.length || s.platforms.some(p => !PLATFORMS.includes(p)) || new Set(s.platforms).size !== s.platforms.length) errors.push('strategy.platforms must contain unique entries from threads, facebook, x, instagram');
  if (!Number.isFinite(s.post_frequency_hours) || s.post_frequency_hours < 1) errors.push('strategy.post_frequency_hours must be at least 1');
  for (const field of ['value_posts_before_selling', 'view_threshold_to_sell']) if (!Number.isSafeInteger(s[field]) || s[field] < 0) errors.push(`strategy.${field} must be a nonnegative integer`);
  if (s.view_thresholds_per_platform !== undefined && (!s.view_thresholds_per_platform || typeof s.view_thresholds_per_platform !== 'object' || Array.isArray(s.view_thresholds_per_platform) || Object.entries(s.view_thresholds_per_platform).some(([key, value]) => !PLATFORMS.includes(key) || !Number.isSafeInteger(value) || value < 0))) errors.push('strategy.view_thresholds_per_platform must contain nonnegative integer thresholds for supported platforms');
  if (typeof s.product_mention_ratio !== 'string' || !/^1 in (?:[2-9]|[1-9]\d+) posts$/.test(s.product_mention_ratio)) errors.push('strategy.product_mention_ratio must be "1 in N posts" (N >= 2)');
  if (errors.length) throw new Error(`Invalid product.json:\n- ${errors.join('\n- ')}`);
  // Validate new options without injecting defaults into legacy fingerprints.
  const { learningSettings, writingSettings } = require('./learning-config');
  learningSettings(data);
  writingSettings(data);
  require('./campaign-settings').sellingSettings(data, s.platforms[0]);
  require('../knowledge/research-settings').researchSettings(data);
  require('../knowledge/content-observer').observerSettings(data);
  require('./media-settings').mediaSettings(data);
  require('./media-settings').rollingSettings(data);
  return data;
}
function loadProduct(root) {
  const product = validateProduct(JSON.parse(fs.readFileSync(path.join(root, 'product.json'), 'utf8').replace(/^\uFEFF/, '')));
  const copyPath = path.join(root, 'product-copy.md');
  const copy = fs.existsSync(copyPath) ? fs.readFileSync(copyPath, 'utf8').trim() : '';
  if ((!copy || copy.includes('<!-- PRODUCT_COPY_TEMPLATE -->')) && !product.product.description?.trim()) throw new Error('Add product.description or replace the product-copy.md template with actual content.');
  return { product, copy: copy.includes('<!-- PRODUCT_COPY_TEMPLATE -->') ? '' : copy };
}
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
function fingerprint(product, copy) { return product.product_id ? digest({ product_id: product.product_id }) : digest({ product, copy }); }
function revisions(product, copy) {
  const { sales_url, ...facts } = product.product;
  return { facts: digest({ facts, copy }), research: digest({ topics: facts.key_topics, audience: facts.target_audience }), writing: digest(product.writing || {}), config: digest({ product, copy }) };
}
module.exports = { PLATFORMS, validateProduct, loadProduct, fingerprint, revisions };
