const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { loadProduct, validateProduct, fingerprint, revisions } = require('./product-config');
const { save, withLock } = require('./content-store');

const files = ['product.json', 'private/product-content.json', 'private/product-generation.json', 'private/product-engagement.json', 'knowledge/learning/swipe_file.json', 'knowledge/product/learned_insights.json'];
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const journalPath = root => path.join(root, 'private/config-migration.json');

// Caller owns the campaign lock. Persist the entire migration intent before writes.
function ensureIdentity(root) {
  const journalFile = journalPath(root);
  let journal = fs.existsSync(journalFile) ? read(journalFile) : null;
  if (journal?.status === 'pending') {
    if (journal.version !== 1 || !Array.isArray(journal.entries) || journal.entries.some(e => !files.includes(e.file))) throw new Error('Invalid migration journal; preserve it for review');
    for (const entry of journal.entries) {
      const file = path.join(root, entry.file);
      if (!fs.existsSync(file)) throw new Error(`Migration file missing: ${entry.file}`);
      const current = fs.readFileSync(file, 'utf8');
      if (current !== entry.before && current !== entry.after) throw new Error(`Migration conflict: ${entry.file} changed; preserving all versions`);
    }
    for (const entry of journal.entries) save(path.join(root, entry.file), JSON.parse(entry.after));
    save(journalFile, { ...journal, status: 'complete', completedAt: Date.now() });
    return loadProduct(root);
  }
  const loaded = loadProduct(root);
  if (loaded.product.product_id) return loaded;
  const oldFingerprint = fingerprint(loaded.product, loaded.copy);
  const product = { ...loaded.product, product_id: randomUUID(), config_version: 1 };
  const identity = fingerprint(product, loaded.copy);
  const rev = revisions(product, loaded.copy);
  const entries = [];
  for (const relative of files) {
    const file = path.join(root, relative);
    if (!fs.existsSync(file)) continue;
    const before = fs.readFileSync(file, 'utf8');
    const data = JSON.parse(before.replace(/^\uFEFF/, ''));
    const ignoredHistoryOnly = relative === 'private/product-engagement.json' && data.version === 1 && data.turns && typeof data.turns === 'object' && !Array.isArray(data.turns) && data.optOuts && typeof data.optOuts === 'object' && !Array.isArray(data.optOuts) && Object.values(data.turns).every(turn => turn?.status === 'ignored' && !turn.response && !turn.attemptedAt && !turn.result);
    if (relative !== 'product.json' && data.fingerprint !== oldFingerprint && !ignoredHistoryOnly) throw new Error(`Cannot migrate ${relative}: product inputs do not match. Preserve and reconcile the existing data first.`);
    const next = relative === 'product.json' ? product : { ...data, fingerprint: identity, product_id: product.product_id, configRevisions: rev };
    if (ignoredHistoryOnly && data.fingerprint !== oldFingerprint) next.migration = { previousFingerprint: data.fingerprint, reason: 'Preserved ignored-only engagement history and opt-outs; no pending replies or submission attempts.' };
    entries.push({ file: relative, before, after: JSON.stringify(next, null, 2) + '\n' });
  }
  // The immutable backup also permits manual recovery after future configuration edits.
  const backupFile = path.join(root, 'private/config-backups', `${Date.now()}-${randomUUID()}.json`);
  journal = { version: 1, status: 'pending', createdAt: Date.now(), entries };
  save(backupFile, journal);
  save(journalFile, journal);
  return ensureIdentity(root);
}

function checkCampaignFacts(root, product, copy) {
  for (const relative of ['private/product-content.json', 'private/product-generation.json']) {
    const file = path.join(root, relative);
    if (!fs.existsSync(file)) continue;
    const state = read(file);
    if (state.fingerprint !== fingerprint(product, copy)) throw new Error('Campaign product identity differs; preserve and reconcile the existing data');
    if (state.configRevisions && state.configRevisions.facts !== revisions(product, copy).facts) throw new Error('Product facts changed. Existing drafts require review before publishing or resuming generation.');
  }
}

const editable = /^(product\.sales_url|seller\.usernames\.(threads|facebook|x|instagram)|strategy\.(post_frequency_hours|view_threshold_to_sell|value_posts_before_selling|product_mention_ratio)|strategy\.view_thresholds_per_platform\.(threads|facebook|x|instagram)|selling\.(defaults|platforms\.(threads|facebook|x|instagram))\.(minimum_views|minimum_value_posts|one_product_post_every)|pilot\.posts_per_platform\.(threads|facebook|x|instagram)|schedule\.(mode|timezone|local_times|start_date|end_date|minimum_gap_minutes|overdue_policy)|learning\.max_campaign_posts)$/;
function changedProduct(product, key, value) {
  const researchKey = /^research\.(enabled|allow_partial|minimum_records_per_platform|minimum_authors_per_platform|minimum_discussions_per_platform|max_searches_per_platform_per_run|max_discussions_per_search|max_relevance_checks_per_search|freshness_days)$/.test(key);
  const writingKey = /^writing\.(humanizer_enabled|voice_examples_file|forbid_em_dash|fallback_policy)$/.test(key);
  const mediaKey = /^(content_media\.(enabled|max_attempts|retry_minutes|text_only_fallback|width|height|provider|image_fallback|image_timeout_seconds|max_requests_per_day)|rolling_content\.enabled)$/.test(key);
    if (!editable.test(key) && !researchKey && !writingKey && !mediaKey && !['publishing.disabled_platforms', 'publishing.promote_every_post'].includes(key)) throw new Error('This setting is not editable. See COMMANDS.md for settings commands; campaign facts and platform selection require a new campaign.');
  const next = structuredClone(product);
  const parts = key.split('.');
  let target = next;
  for (const part of parts.slice(0, -1)) target = target[part] ||= {};
  target[parts.at(-1)] = value;
  return validateProduct(next);
}

function applyChange(root, request, { product, copy }) {
  if (revisions(product, copy).config !== request.expectedRevision) throw new Error('Settings changed since this request. Inspect settings and submit again.');
  const next = changedProduct(product, request.key, request.value);
  save(path.join(root, 'product.json'), next);
  return next;
}

async function submitChange(root, key, value) {
  let loaded = loadProduct(root);
  changedProduct(loaded.product, key, value); // Reject invalid requests before queuing.
  if (!loaded.product.product_id) {
    await withLock(root, () => ensureIdentity(root));
    loaded = loadProduct(root);
  }
  const id = randomUUID();
  const request = { id, status: 'pending', key, value, expectedRevision: revisions(loaded.product, loaded.copy).config, createdAt: Date.now() };
  const file = path.join(root, 'private/management', `${id}.json`);
  save(file, request);
  return withLock(root, () => {
    // Identity migration must be explicit before queuing against a running legacy campaign.
    processChanges(root);
    return read(file);
  }).catch(err => {
    if (err.code === 'CAMPAIGN_LOCKED') return { id, status: 'pending', message: 'Queued. The running automation will apply this between actions; use settings request ID to check the result.' };
    throw err;
  });
}

// Only the runtime writer (or an offline lock owner) consumes requests.
function processChanges(root) {
  const dir = path.join(root, 'private/management');
  if (!fs.existsSync(dir)) return [];
  const results = [];
  for (const name of fs.readdirSync(dir).filter(name => /^[a-f0-9-]{36}\.json$/.test(name)).sort()) {
    const file = path.join(dir, name);
    const request = read(file);
    if (request.kind === 'queue') continue;
    if (!['pending', 'applying'].includes(request.status)) continue;
    try {
      const loaded = loadProduct(root);
      if (!loaded.product.product_id) throw new Error('Run settings migrate before changing settings');
      const next = changedProduct(loaded.product, request.key, request.value);
      const targetRevision = revisions(next, loaded.copy).config;
      if (request.status === 'applying' && revisions(loaded.product, loaded.copy).config === request.targetRevision) {
        // The product write succeeded before an interruption; acknowledge without replay.
      } else {
        if (request.status === 'applying' && request.targetRevision !== targetRevision) throw new Error('Interrupted settings request conflicts with current configuration');
        save(file, { ...request, status: 'applying', targetRevision });
        applyChange(root, request, loaded);
      }
      const result = { ...request, status: 'applied', completedAt: Date.now() };
      save(file, result);
      results.push(result);
    } catch (err) {
      const result = { ...request, status: 'rejected', reason: err.message, completedAt: Date.now() };
      save(file, result);
      results.push(result);
    }
  }
  return results;
}

async function settingsCommand(root, args) {
  const action = args[0] || 'show';
  if (action === 'migrate' && args.length === 1) return withLock(root, () => ({ status: 'migrated', product_id: ensureIdentity(root).product.product_id }));
  if (action === 'set' && args.length === 3) {
    const [, key, raw] = args;
    let value; try { value = JSON.parse(raw); } catch { value = raw; }
    return submitChange(root, key, value);
  }
  if (action === 'request' && args.length === 2 && /^[a-f0-9-]{36}$/.test(args[1])) return read(path.join(root, 'private/management', `${args[1]}.json`));
  if (['show', 'validate'].includes(action) && args.length <= 1) {
    const { product, copy } = loadProduct(root);
    return action === 'show' ? { product, revisions: revisions(product, copy) } : { status: 'valid', identityMigrated: !!product.product_id };
  }
  throw new Error('Supported: settings [show|validate|migrate|set KEY VALUE|request ID]');
}
module.exports = { ensureIdentity, checkCampaignFacts, submitChange, processChanges, settingsCommand, changedProduct };
