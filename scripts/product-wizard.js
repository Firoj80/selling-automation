/**
 * scripts/product-wizard.js
 *
 * Interactive terminal wizard for setting up or updating product.json.
 * Run via: node scripts/product-wizard.js
 * Or via:  npm run content:setup  (auto-invoked when product.json is missing/incomplete)
 *
 * Features:
 *  - Collects all product details interactively
 *  - Sales URL is optional — can be added later with: node threads-agent.js set-url <URL>
 *  - Per-platform view thresholds (same value applied to all platforms)
 *  - Validates all inputs before saving
 *  - Preserves existing values as defaults on re-run
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const ROOT = path.resolve(__dirname, '..');
const PRODUCT_FILE = path.join(ROOT, 'product.json');
const PRODUCT_COPY_FILE = path.join(ROOT, 'product-copy.md');
const VALID_PLATFORMS = ['threads', 'facebook', 'x', 'instagram'];

// ─── Readline helpers ─────────────────────────────────────────────────────────

function createRl() {
  return readline.createInterface({ input: process.stdin, output: process.stdout });
}

function ask(rl, question) {
  return new Promise(resolve => rl.question(question, answer => resolve(answer.trim())));
}

async function askRequired(rl, question, defaultVal = '') {
  while (true) {
    const hint = defaultVal ? ` [${defaultVal}]` : ' (required)';
    const answer = await ask(rl, `${question}${hint}: `);
    const result = answer || defaultVal;
    if (result.trim()) return result.trim();
    console.log('  ⚠  This field is required. Please enter a value.');
  }
}

async function askOptional(rl, question, defaultVal = '') {
  const hint = defaultVal ? ` [${defaultVal}]` : ' (optional, press Enter to skip)';
  const answer = await ask(rl, `${question}${hint}: `);
  return answer || defaultVal;
}

async function askTopics(rl, existing = []) {
  console.log('\n  Enter content topics one per line (press Enter on empty line to finish).');
  console.log('  These become your post pillars — e.g. "How to write better hooks".');
  if (existing.length) {
    console.log(`  Current topics: ${existing.map((t, i) => `\n    ${i + 1}. ${t}`).join('')}`);
    const keep = await ask(rl, '  Keep existing topics? [Y/n]: ');
    if (!keep || keep.toLowerCase() === 'y') return existing;
  }
  const topics = [];
  for (let i = 1; i <= 8; i++) {
    const topic = await ask(rl, `  Topic ${i}: `);
    if (!topic) break;
    topics.push(topic);
  }
  if (!topics.length) throw new Error('At least one content topic is required.');
  return topics;
}

async function askPlatforms(rl, existing = ['threads', 'facebook']) {
  const hint = existing.join(', ');
  const answer = await ask(rl, `  Platforms (comma-separated: threads, facebook, x, instagram) [${hint}]: `);
  if (!answer) return existing;
  const chosen = answer.split(',').map(p => p.trim().toLowerCase()).filter(Boolean);
  const invalid = chosen.filter(p => !VALID_PLATFORMS.includes(p));
  if (invalid.length) throw new Error(`Invalid platforms: ${invalid.join(', ')}. Use: threads, facebook, x, instagram`);
  if (!chosen.length) throw new Error('At least one platform is required.');
  return [...new Set(chosen)];
}

function isValidUrl(str) {
  if (!str) return true; // Optional
  try {
    const u = new URL(str);
    return ['http:', 'https:'].includes(u.protocol);
  } catch { return false; }
}

// ─── Load existing data as defaults ──────────────────────────────────────────

function loadExisting() {
  try {
    if (fs.existsSync(PRODUCT_FILE)) {
      return JSON.parse(fs.readFileSync(PRODUCT_FILE, 'utf8'));
    }
  } catch {}
  return null;
}

function loadExistingCopy() {
  try {
    if (fs.existsSync(PRODUCT_COPY_FILE)) {
      const content = fs.readFileSync(PRODUCT_COPY_FILE, 'utf8');
      if (!content.includes('<!-- PRODUCT_COPY_TEMPLATE -->')) return content.trim();
    }
  } catch {}
  return '';
}

// ─── Build product.json structure ────────────────────────────────────────────

function buildProductJson(answers) {
  const platforms = answers.platforms;
  // Build per-platform view thresholds
  const viewThresholds = {};
  for (const platform of platforms) {
    viewThresholds[platform] = answers.viewThreshold;
  }

  return {
    seller: {
      name: answers.sellerName,
      username: answers.sellerUsername,
      bio_style: answers.bioStyle || `Sharing practical tips about ${answers.topics[0]}.`
    },
    product: {
      name: answers.productName,
      type: answers.productType,
      price: answers.price,
      sales_url: answers.salesUrl || '',
      description: answers.description,
      target_audience: answers.targetAudience,
      key_topics: answers.topics
    },
    strategy: {
      platforms,
      post_frequency_hours: answers.postFrequencyHours,
      value_posts_before_selling: answers.valuePostsBeforeSelling,
      view_threshold_to_sell: answers.viewThreshold,
      view_thresholds_per_platform: viewThresholds,
      product_mention_ratio: `1 in ${answers.productMentionEvery} posts`
    },
    learning: {
      enabled: true,
      pilot_posts: 20 * platforms.length,
      pilot_days: 5,
      pilot_posts_per_day: 4 * platforms.length,
      pilot_timezone: 'Asia/Kolkata',
      pilot_local_times: ['10:30', '13:00', '17:00', '19:00'],
      next_batch_size: 5 * platforms.length,
      exploration_fraction: 0.2,
      max_campaign_posts: 180
    },
    writing: {
      humanizer_enabled: true,
      voice_examples_file: 'knowledge/voice.md',
      preserve_facts: true
    },
    external_learning: {
      enabled: true,
      minimum_likes: 50,
      minimum_comments: 10
    }
  };
}

// ─── Main wizard ──────────────────────────────────────────────────────────────

async function runWizard() {
  const existing = loadExisting();
  const ex = existing || {};

  console.log('\n' + '═'.repeat(52));
  console.log('  🚀  META AUTOMATION — PRODUCT SETUP WIZARD');
  console.log('═'.repeat(52));
  if (existing) {
    console.log('  ℹ  Existing product.json found. Press Enter to keep current values.');
  }
  console.log('  💡  Sales URL is optional — you can add it later.');
  console.log('═'.repeat(52) + '\n');

  const rl = createRl();

  try {
    // ── Seller Info ──────────────────────────────────────────
    console.log('  📋  SELLER INFO');
    console.log('  ' + '─'.repeat(48));
    const sellerName = await askRequired(rl, '  Your display name', ex.seller?.name);
    const sellerUsername = await askRequired(rl, '  Your username (no @)', ex.seller?.username);
    const bioStyle = await askOptional(rl, '  Your writing style / brand voice', ex.seller?.bio_style);

    // ── Product Info ─────────────────────────────────────────
    console.log('\n  📦  PRODUCT INFO');
    console.log('  ' + '─'.repeat(48));
    const productName = await askRequired(rl, '  Product name', ex.product?.name);
    const productType = await askRequired(rl, '  Product type (e.g. ebook, course, template)', ex.product?.type || 'digital ebook');
    const price = await askRequired(rl, '  Price (e.g. $29)', ex.product?.price);

    let salesUrl = '';
    while (true) {
      salesUrl = await askOptional(rl, '  Gumroad / store URL (leave blank to add later)', ex.product?.sales_url);
      if (!salesUrl || isValidUrl(salesUrl)) break;
      console.log('  ⚠  That doesn\'t look like a valid URL (must start with https://). Try again or press Enter to skip.');
    }

    const description = await askRequired(rl, '  Short product description', ex.product?.description);
    const targetAudience = await askRequired(rl, '  Target audience (who is this for?)', ex.product?.target_audience);

    // ── Topics ───────────────────────────────────────────────
    console.log('\n  🎯  CONTENT TOPICS');
    console.log('  ' + '─'.repeat(48));
    const topics = await askTopics(rl, ex.product?.key_topics);

    // ── Platforms ─────────────────────────────────────────────
    console.log('\n  🌐  PLATFORMS');
    console.log('  ' + '─'.repeat(48));
    const platforms = await askPlatforms(rl, ex.strategy?.platforms);

    // ── Strategy ─────────────────────────────────────────────
    console.log('\n  📊  SELLING STRATEGY');
    console.log('  ' + '─'.repeat(48));

    const postFreqRaw = await askOptional(rl, '  Post every N hours', String(ex.strategy?.post_frequency_hours || 3));
    const postFrequencyHours = Math.max(1, parseInt(postFreqRaw) || 3);

    const vpbsRaw = await askOptional(rl, '  Value posts required before first product post', String(ex.strategy?.value_posts_before_selling || 10));
    const valuePostsBeforeSelling = Math.max(1, parseInt(vpbsRaw) || 10);

    const vtRaw = await askOptional(rl, '  Views per platform to unlock product posts (e.g. 20000)', String(ex.strategy?.view_threshold_to_sell || 20000));
    const viewThreshold = Math.max(0, parseInt(vtRaw) || 20000);

    const pmeRaw = await askOptional(rl, '  Product post frequency: 1 in every N posts', String(ex.strategy?.product_mention_ratio?.match(/\d+/)?.[0] || 5));
    const productMentionEvery = Math.max(2, parseInt(pmeRaw) || 5);

    rl.close();

    // ── Build & Save ─────────────────────────────────────────
    const answers = { sellerName, sellerUsername, bioStyle, productName, productType, price, salesUrl, description, targetAudience, topics, platforms, postFrequencyHours, valuePostsBeforeSelling, viewThreshold, productMentionEvery };
    const productJson = buildProductJson(answers);

    // Ensure private/ dir exists
    fs.mkdirSync(path.join(ROOT, 'private'), { recursive: true });
    fs.writeFileSync(PRODUCT_FILE, JSON.stringify(productJson, null, 2), 'utf8');

    // Write product-copy.md if it doesn't have real content
    const existingCopy = loadExistingCopy();
    if (!existingCopy) {
      const copy = `# ${productName}\n\nSeller: ${sellerName}\nPrice: ${price}\nFormat: ${productType}\nPurchase link: ${salesUrl || 'not yet available'}\n\n## Product description\n\n${description}\n\n## Who it is for\n\n${targetAudience}\n\n## Key topics\n\n${topics.map(t => `- ${t}`).join('\n')}\n`;
      fs.writeFileSync(PRODUCT_COPY_FILE, copy, 'utf8');
      console.log('\n  ✅  Created product-copy.md — edit this to add detailed marketing copy.\n');
    }

    console.log('\n' + '═'.repeat(52));
    console.log('  ✅  PRODUCT SAVED SUCCESSFULLY!');
    console.log('═'.repeat(52));
    console.log(`  Product  : ${productName} (${price})`);
    console.log(`  Platforms: ${platforms.join(', ')}`);
    console.log(`  Selling  : After ${valuePostsBeforeSelling} value posts + ${viewThreshold.toLocaleString()} views per platform`);
    if (!salesUrl) {
      console.log('\n  ⚠  No sales URL set yet. Product posts will be held until you run:');
      console.log('     node threads-agent.js set-url https://your-gumroad-link.com');
    }
    console.log('═'.repeat(52) + '\n');

    return productJson;

  } catch (err) {
    rl.close();
    throw err;
  }
}

module.exports = { runWizard };

if (require.main === module) {
  runWizard()
    .then(() => process.exit(0))
    .catch(err => { console.error('\n❌', err.message); process.exit(1); });
}
