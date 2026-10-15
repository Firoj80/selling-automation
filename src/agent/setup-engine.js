const fs = require('fs');
const path = require('path');
const { loadProduct, fingerprint, revisions } = require('../content/product-config');
const { ContentEngine } = require('../content/content-engine');
const { save, withLock } = require('../content/content-store');
const { learningSettings } = require('../content/learning-config');
const { loadWriting, ContentHumanizer } = require('../content/content-humanizer');
const { pilotCalendar } = require('../content/content-calendar');
const { pilotAssignments } = require('../content/content-planner');
async function setup(root, { engine, now = Date.now(), clock = () => Date.now(), researchRunner } = {}) {
  const startedAt = clock();
  return withLock(root, async () => {
    const { product, copy } = require('../content/config-management').ensureIdentity(root);
    require('../content/config-management').checkCampaignFacts(root, product, copy);
    const file = path.join(root, 'private', 'product-content.json');
    if (fs.existsSync(file)) throw new Error('Content setup already exists. Archive private/product-content.json before creating a new campaign; retain it to preserve publication history.');
    const settings = learningSettings(product);
    let writing = loadWriting(root, product);
    const targetAccounts = product.target_accounts || product.writing?.target_accounts;
    const { TargetAccountAnalyzer } = require('../knowledge/target-account-analyzer');
    if (targetAccounts && (targetAccounts.x || targetAccounts.threads)) {
      const analyzer = new TargetAccountAnalyzer({ root, ai: engine?.ai });
      if (!analyzer.isAnalyzed(targetAccounts)) {
        await analyzer.analyzeAndApply({ targetAccounts, product });
        writing = loadWriting(root, product);
      }
    }
    const checkpointFile = path.join(root, 'private', 'product-generation.json');
    const checkpoint = fs.existsSync(checkpointFile) ? JSON.parse(fs.readFileSync(checkpointFile, 'utf8')) : null;
    const identity = fingerprint(product, copy);
    if (checkpoint && (checkpoint.version !== 1 || checkpoint.fingerprint !== identity || checkpoint.settings.enabled !== settings.enabled || checkpoint.settings.pilot_posts !== settings.pilot_posts || JSON.stringify(checkpoint.settings.pilot_counts || Object.fromEntries(product.strategy.platforms.map(p => [p, 20]))) !== JSON.stringify(settings.pilot_counts) || JSON.stringify(checkpoint.writing) !== JSON.stringify(writing))) throw new Error('Saved drafts belong to different product, quantity or writing settings. Preserve private/product-generation.json and review those changes before resuming.');
    const { researchSettings } = require('../knowledge/research-settings');
    const { ResearchRunner, researchScope, applyInitialInsights } = require('../knowledge/research-runner');
    const researchOptions = researchSettings(product);
    let research = checkpoint?.research;
    if (!researchOptions.enabled) research = { status: 'disabled', learned: null, scope: researchScope(product), supportedPlatforms: [] };
    else if (!research || research.scope !== researchScope(product) || !['ready', 'partial'].includes(research.status) || research.status === 'partial' && !researchOptions.allow_partial) {
      try { research = await (researchRunner || new ResearchRunner({ root, product, copy, ai: engine?.ai })).run(); }
      finally { if (!researchRunner) require('../browser/browser-manager').disconnect(); }
      if (!['ready', 'partial'].includes(research.status)) throw new Error(`Initial research is ${research.status}. No new content was generated. Run node threads-agent.js research --status, then research --resume. ${JSON.stringify(research.platforms || research.reason || {})}`);
    }
    if (!engine) {
      engine = new ContentEngine({ targetStyle: TargetAccountAnalyzer.loadTargetStyle(root) });
      engine.humanizer = new ContentHumanizer({ ai: engine.ai, writing });
    } else {
      engine.targetStyle ||= TargetAccountAnalyzer.loadTargetStyle(root);
      if (engine.humanizer) engine.humanizer.writing = writing;
    }
    const plan = (checkpoint?.research?.scope === research.scope && checkpoint?.research?.status === research.status ? checkpoint?.plan : null) || applyInitialInsights(settings.enabled ? pilotAssignments(product, settings) : require('../content/content-planner').assignments(product, 50), research.learned, research.supportedPlatforms || []);
    const saveCheckpoint = drafts => save(checkpointFile, { version: 1, fingerprint: identity, configRevisions: revisions(product, copy), settings, writing, research, plan, updatedAt: Date.now(), posts: drafts });
    if (require('../content/media-settings').mediaSettings(product).enabled) {
      engine.mediaEngine ||= new (require('../content/content-media').ContentMedia)({ root, ai: engine.ai });
      for (const draft of checkpoint?.posts || []) if (draft.media?.required) await engine.mediaEngine.prepare(draft, product, () => saveCheckpoint(checkpoint.posts));
    }
    saveCheckpoint(checkpoint?.posts || []); // Pin research/assignments before the first generation call.
    const posts = await engine.generateContentQueue(product, copy, settings.enabled ? settings.pilot_posts : 50, {
      plan, learned: research.learned, initialPosts: checkpoint?.posts || [], onAccepted: saveCheckpoint
    });
    // Preparation may cross a day boundary. Allocate dates only after drafts are saved.
    const preparedAt = now + Math.max(0, clock() - startedAt);
    const timing = require('../content/interval-schedule');
    const pilot = settings.enabled ? timing.isInterval(product) ? { slots: timing.intervalSlots(product, preparedAt, plan), endAt: product.schedule?.end_date ? require('../content/content-calendar').atLocal(product.schedule.end_date, '23:59', settings.pilot_timezone) : preparedAt + 365 * 86400000 } : pilotCalendar(settings, preparedAt, product.strategy.platforms.length, plan) : null;
    const experimentId = `pilot-${now}`;
    if (pilot) {
      if (posts.length !== settings.pilot_posts) throw new Error(`Pilot setup requires exactly ${settings.pilot_posts} valid posts`);
      posts.forEach((post, i) => Object.assign(post, plan[i], { scheduledAt: pilot.slots[i], batch: 0, experimentId }));
    }
    const interval = product.strategy.post_frequency_hours * 3600000;
    const state = { version: 2, fingerprint: fingerprint(product, copy), configRevisions: revisions(product, copy), createdAt: now, initialResearch: { status: research.status, scope: research.scope, revision: research.learned?.revision || null, supportedPlatforms: research.supportedPlatforms || [] }, nextPostAt: pilot?.slots[0] ?? preparedAt, cursor: 0, posts, writing,
      calendar: posts.map((p, i) => ({ id: p.id, platform: p.platform, scheduledAt: new Date(p.scheduledAt ?? now + i * interval).toISOString() })),
      ...(pilot ? { learning: { experimentId, phase: 'pilot', batch: 0, settings, endAt: pilot.endAt, reports: [], nextMetricsAt: now } } : {}) };
    const knowledgeDir = path.join(root, 'knowledge', 'product');
    fs.mkdirSync(knowledgeDir, { recursive: true });
    fs.writeFileSync(path.join(knowledgeDir, 'identity.md'), `# Seller\n\n${product.seller.name} (@${product.seller.username})\n\n${product.seller.bio_style || ''}\n`);
    fs.writeFileSync(path.join(knowledgeDir, 'product.md'), `# ${product.product.name}\n\n${product.product.description || ''}\n\nTopics:\n${product.product.key_topics.map(t => `- ${t}`).join('\n')}\n\n${copy}\n`);
    fs.writeFileSync(path.join(knowledgeDir, 'strategy.md'), `# Content strategy\n\nStart with educational value posts. Product mentions require both ${product.strategy.value_posts_before_selling} published value posts and ${product.strategy.view_threshold_to_sell} observed views. Product cadence: ${product.strategy.product_mention_ratio}. Never fabricate results.\n\nPlatforms: ${product.strategy.platforms.join(', ')}\nCadence: ${product.strategy.post_frequency_hours} hours\n\nSuggested bio: ${product.seller.bio_style || `Sharing practical tips about ${product.product.key_topics[0]}.`}\n`);
    if (pilot) fs.appendFileSync(path.join(knowledgeDir, 'strategy.md'), timing.isInterval(product)
      ? `\nInterval schedule: one post per platform every ${product.strategy.post_frequency_hours} hours after its last verified publication. Pilot quantities ${JSON.stringify(settings.pilot_counts)}. Observe for ${settings.observation_age_hours} hours before adapting. Maximum ${settings.max_campaign_posts} posts.\n`
      : `\nCalendar: ${settings.pilot_days} days, up to ${settings.pilot_local_times.length} posts/day/platform; quantities ${JSON.stringify(settings.pilot_counts)} (${settings.pilot_local_times.join(', ')} ${settings.pilot_timezone}). Observe for ${settings.observation_age_hours} hours before adapting. Maximum ${settings.max_campaign_posts} slots; ends ${new Date(pilot.endAt).toISOString()}.\n`);
    save(file, state);
    return state;
  });
}
module.exports = { setup };
