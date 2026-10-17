const fs = require('fs');
const path = require('path');
const { loadProduct, fingerprint } = require('./product-config');
const { save, withLock } = require('./content-store');
const { ContentScheduler } = require('./content-scheduler');
const { ContentTracker } = require('./content-tracker');
const { ContentEngine } = require('./content-engine');
const { BrowserMetricsReader } = require('./post-metrics');
const { ContentPlanner } = require('./content-planner');
const { ContentLearning } = require('./content-learning');
const { ContentHumanizer, loadWriting } = require('./content-humanizer');
const { SwipeStore } = require('../knowledge/swipe-store');
const { ContentObserver, observerSettings } = require('../knowledge/content-observer');
const { LearningEngine } = require('../knowledge/learning-engine');
const management = require('./config-management');
async function publish(post, product, onSubmission) {
  if (!require('./publishing-settings').publishingEnabled(product, post.platform)) throw new Error(`Publishing is disabled for ${post.platform}`);
  let postToPublish = { ...post };
  if (['threads', 'x'].includes(postToPublish.platform) && postToPublish.type === 'product') {
    if (!postToPublish.threadReply) {
      postToPublish.threadReply = require('./content-engine').formatProductThreadReply(product);
      if (product.product?.sales_url && postToPublish.text.includes(product.product.sales_url)) {
        postToPublish.text = postToPublish.text.replace(product.product.sales_url, '').replace(/\s*(?:👉|link|check out:?|visit:?)\s*$/i, '').trim();
      }
    }
  }
  if (postToPublish.platform === 'instagram' && postToPublish.type === 'product') {
    postToPublish.text = require('./content-engine').formatProductForInstagram(postToPublish.text, product);
  }
  require('./content-engine').validatePost(postToPublish, product);
  const CONFIG = require('../../config');
  if (CONFIG.DRY_RUN || !CONFIG.POSTING_ENABLED || CONFIG.APPROVAL_MODE) throw new Error('Live publishing is disabled by configuration');
  const limiter = require('../safety/rate-limiter');
  const gate = limiter.canPerform('OWN_POST', postToPublish.platform);
  if (!gate.allowed) throw new Error(gate.reason);
  const username = product.seller.usernames?.[postToPublish.platform] || product.seller.username;
  const isInstagram = postToPublish.platform === 'instagram';
  const isX = postToPublish.platform === 'x';
  if (!postToPublish.media?.path || postToPublish.media?.status !== 'ready') {
    throw new Error(`All platforms require an image attachment; text-only publishing is not permitted on ${postToPublish.platform}`);
  }
  if (postToPublish.media?.required && postToPublish.media.status !== 'text_only' && !require('./content-media').validMedia(postToPublish, path.resolve(__dirname, '../..'))) throw new Error('Required image is missing, invalid or does not match the caption');
  const textToSend = isX && postToPublish.text.length > 280 ? require('./content-engine').condenseForX(postToPublish.text) : postToPublish.text;
  const options = { text: textToSend, onSubmission, ...(postToPublish.threadReply ? { threadReply: postToPublish.threadReply } : {}), pillar: `product_${postToPublish.type}`, format: postToPublish.media?.status === 'ready' ? 'MEDIA' : 'TEXT_ONLY', username: username,
    ...(postToPublish.media?.status === 'ready' ? { mediaPaths: [postToPublish.media.path] } : {}) };
  const poster = require(`../platforms/${postToPublish.platform}/${postToPublish.platform}-poster`);
  const result = postToPublish.platform === 'threads' ? await poster.publishEngagingPost(options) : await poster.publishPost(options);
  if (postToPublish.media?.status === 'ready' && result?.success && (!result.postUrl || !(result.verifiedMediaCount >= 1))) return { ...result, success: false, verified: false, reason: 'Image publication needs review: caption, image and public permalink were not all verified' };
  if (result?.success && result.verified && !result.simulated) limiter.recordAction('OWN_POST', postToPublish.platform, postToPublish.id);
  return result;
}
async function run(command, args = [], root = path.resolve(__dirname, '../..'), runtime = {}) {
  if (command === 'status') command = 'content-status';
  if (command === 'auth') {
    const target = (args[0] || 'all').toLowerCase();
    const results = {};
    if (['all', 'threads'].includes(target)) results.threads = await require('../platforms/threads/threads-auth').checkThreadsAuth();
    if (['all', 'facebook'].includes(target)) results.facebook = await require('../platforms/facebook/facebook-auth').checkFacebookAuth();
    if (['all', 'x'].includes(target)) results.x = await require('../platforms/x/x-auth').checkXAuth();
    if (['all', 'instagram'].includes(target)) results.instagram = await require('../platforms/instagram/instagram-auth').checkInstagramAuth();
    return results;
  }
  if (command === 'images') { const result = await require('./images-cli').imagesCommand(root, args); console.log(JSON.stringify(result, null, 2)); return result; }
  if (command === 'research') {
    if (args.length !== 1 || !['--status', '--resume'].includes(args[0])) throw new Error('Supported: research --status | --resume');
    const action = async () => {
      const loaded = args[0] === '--resume' ? management.ensureIdentity(root) : loadProduct(root);
      const runner = new (require('../knowledge/research-runner').ResearchRunner)({ root, ...loaded });
      const result = args[0] === '--status' ? runner.status() : await runner.run();
      const { learned, ...summary } = result;
      console.log(JSON.stringify(summary, null, 2));
      return summary;
    };
    if (args[0] === '--status') return action();
    try { return await withLock(root, action); }
    finally { require('../browser/browser-manager').disconnect(); }
  }
  if (command === 'queue') {
    const result = await require('./queue-management').queueCommand(root, args);
    console.log(JSON.stringify(result, null, 2));
    if (result.status === 'rejected') throw new Error(result.reason);
    return result;
  }
  if (['analyze-style', 'analyze-account'].includes(command)) {
    const { loadProduct } = require('./product-config');
    const { TargetAccountAnalyzer } = require('../knowledge/target-account-analyzer');
    const { product } = loadProduct(root);
    let x = null;
    let threads = null;
    let force = false;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--x' && args[i + 1]) { x = args[++i]; }
      else if (args[i] === '--threads' && args[i + 1]) { threads = args[++i]; }
      else if (args[i] === '--force') { force = true; }
    }
    const targetAccounts = {
      x: x || product.target_accounts?.x || product.writing?.target_accounts?.x || '',
      threads: threads || product.target_accounts?.threads || product.writing?.target_accounts?.threads || ''
    };
    if (!targetAccounts.x && !targetAccounts.threads) {
      throw new Error('Please provide target accounts: node threads-agent.js analyze-style --x <handle> --threads <handle>, or configure "target_accounts" in product.json.');
    }
    const analyzer = new TargetAccountAnalyzer({ root });
    const result = await analyzer.analyzeAndApply({ targetAccounts, product, force });
    const summary = {
      status: 'analyzed',
      target_accounts: result.target_accounts,
      content_types: result.content_types,
      hook_patterns: result.hook_patterns,
      tone: result.tone,
      formatting: result.formatting,
      reply_style: result.reply_style,
      rules_to_follow: result.rules_to_follow,
      rules_to_avoid: result.rules_to_avoid,
      voice_markdown_chars: result.voice_markdown?.length || 0,
      analyzed_at: result.analyzed_at
    };
    console.log(JSON.stringify(summary, null, 2));
    return summary;
  }
  if (!['setup', 'start', 'content-status', 'content-engage', 'learn', 'set-url', 'settings', 'recover'].includes(command)) throw new Error(`Unsupported command: ${command}. No publishing action was taken.`);
  if (command === 'settings' || command === 'set-url' || command === 'recover') {
    let result;
    if (command === 'settings') result = await management.settingsCommand(root, args);
    else if (command === 'set-url') {
      if (args.length !== 1) throw new Error('Usage: set-url HTTP(S)_URL');
      result = await management.submitChange(root, 'product.sales_url', args[0]);
    } else {
      const recovery = require('./content-recovery');
      if (args.length === 1 && args[0] === '--inspect') {
        result = recovery.inspect(root);
      } else if (args.length === 1 && args[0] === '--stale-lock') {
        result = recovery.recoverStaleLock(root);
      } else if (args.length === 1 && args[0] === '--auto') {
        result = await recovery.autoRecover(root);
      } else if (args[0] === '--reconcile') {
        const id = args[1];
        if (!id) throw new Error('Usage: recover --reconcile POST_ID [--requeue|--discard|--published URL]');
        const opt = args[2] || '--requeue';
        if (opt === '--published') {
          const url = args[3];
          if (!url) throw new Error('Usage: recover --reconcile POST_ID --published URL');
          result = recovery.reconcile(root, { id, action: 'published', postUrl: url });
        } else if (opt === '--discard') {
          result = recovery.reconcile(root, { id, action: 'discard' });
        } else if (opt === '--requeue' || opt === '--reset') {
          result = recovery.reconcile(root, { id, action: 'requeue' });
        } else {
          throw new Error('Supported reconcile options: --requeue, --discard, --published URL');
        }
      } else {
        throw new Error('Supported: recover --inspect | --stale-lock | --auto | --reconcile POST_ID [--requeue|--discard|--published URL]');
      }
    }
    console.log(JSON.stringify(result, null, 2));
    if (result.status === 'rejected') throw new Error(result.reason);
    return result;
  }
  if (command === 'learn') {
    if (args.length > 1 || args.some(a => !['--status', '--dry-run'].includes(a))) throw new Error('Supported: learn [--status|--dry-run]');
    const action = async () => {
      if (!args.length) {
        const loaded = management.ensureIdentity(root);
        management.checkCampaignFacts(root, loaded.product, loaded.copy);
      }
      const { product, copy } = loadProduct(root);
      const store = new SwipeStore({ root, fingerprint: fingerprint(product, copy) });
      const learning = new LearningEngine({ root, store, ai: args.length ? undefined : require('../ai/ai-runtime') });
      const result = args.length ? learning.preview() : observerSettings(product).enabled ? await learning.synthesize() : { status: 'disabled' };
      console.log(JSON.stringify(result, null, 2));
      return result;
    };
    return args.length ? action() : withLock(root, action);
  }
  const engagementOnly = command === 'content-engage';
  const allowed = command === 'setup' ? [] : command === 'content-status' ? ['--refresh'] : engagementOnly ? ['--dry-run', '--once'] : ['--dry-run', '--once', '--engage'];
  const approvalArg = engagementOnly ? args.find(a => /^--approve=[a-f0-9]{24}$/.test(a)) : null;
  if (args.some(a => !allowed.includes(a) && a !== approvalArg)) throw new Error(`Supported flags for ${command}: ${allowed.join(', ') || 'none'}${engagementOnly ? ', --approve=ID' : ''}`);
  if (command === 'setup') {
    const state = await require('../agent/setup-engine').setup(root);
    console.log(`Setup saved ${state.posts.length} posts: ${state.posts.filter(p => p.status === 'pending').length} ready, ${state.posts.filter(p => p.status === 'needs_edit').length} need editing. Review private/product-content.json, then run node threads-agent.js start --dry-run.`);
    return;
  }
  const CONFIG = require('../../config');
  const dryRun = args.includes('--dry-run') || CONFIG.DRY_RUN || !CONFIG.POSTING_ENABLED;
  if (command === 'start' && !dryRun && CONFIG.APPROVAL_MODE) throw new Error('APPROVAL_MODE is enabled. Use --dry-run to review the queue; enable autonomous publishing in configuration before starting live content.');
  const action = async () => {
    if (!dryRun && command !== 'content-status') management.ensureIdentity(root);
    const { product, copy } = loadProduct(root);
    if (!dryRun && command !== 'content-status') management.checkCampaignFacts(root, product, copy);
    const file = path.join(root, 'private', 'product-content.json');
    if (!fs.existsSync(file)) throw new Error('Run node threads-agent.js setup first.');
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (![1, 2].includes(state.version)) throw new Error('Content state is incompatible. Preserve its publication history and inspect the state version.');
    if (state.fingerprint !== fingerprint(product, copy)) console.warn('[Warning] Product inputs changed. System will use the new details, but old value posts remain.');
    const persist = data => save(file, data);
    const readBrowser = command === 'content-status' ? args.includes('--refresh') : !dryRun;
    const tracker = new ContentTracker({ product, state, persist, reader: readBrowser ? new BrowserMetricsReader() : undefined });
    if (command === 'content-status') {
      try {
        if (readBrowser) await tracker.refresh({ force: true });
        const timing = require('./interval-schedule');
        const schedule = { mode: product.schedule?.mode || 'calendar', intervalHours: product.strategy.post_frequency_hours,
          platforms: Object.fromEntries(product.strategy.platforms.map(platform => { const last = timing.lastPublished(state, platform); const next = timing.isInterval(product) ? timing.candidates(state, product).find(c => c.post.platform === platform)?.due : state.posts.find(p => p.platform === platform && p.status === 'pending')?.scheduledAt; return [platform, { lastPublishedAt: last === null ? null : new Date(last).toISOString(), nextPostAt: Number.isFinite(next) ? new Date(Math.max(Date.now(), next)).toISOString() : null }]; })) };
        console.log(JSON.stringify({ ...tracker.summary(), schedule, preparation: { media: require('./media-settings').mediaSettings(product), rolling: require('./media-settings').rollingSettings(product), jobs: state.rollingContent?.jobs || [] }, queue: { saved: state.posts.length, ready: state.posts.filter(p => p.status === 'pending').length, needsEdit: state.posts.filter(p => p.status === 'needs_edit').length, needsMedia: state.posts.filter(p => p.status === 'needs_media').length }, posts: tracker.publishedPosts().map(p => ({ id: p.id, platform: p.platform, postUrl: p.result?.postUrl || null, metrics: p.metrics || null, metricsError: p.metricsError || null })) }, null, 2));
      } finally { if (readBrowser) require('../browser/browser-manager').disconnect(); }
      return;
    }
    const engagementEnabled = engagementOnly || (args.includes('--engage') && !dryRun);
    const ai = !dryRun ? require('../ai/ai-runtime') : undefined;
    const store = new SwipeStore({ root, fingerprint: fingerprint(product, copy) });
    const externalEnabled = observerSettings(product).enabled && state.fingerprint === store.fingerprint;
    const externalLearning = externalEnabled ? new LearningEngine({ root, store, ai }) : null;
    const observer = externalEnabled ? new ContentObserver({ product, copy, campaign: state, store, ai }) : null;
    const engagement = engagementEnabled ? require('../engagement/product-engagement-runtime').createEngagement({ root, product, copy, campaign: state, observer }) : null;
    const currentWriting = loadWriting(root, product);
    const engine = dryRun ? undefined : new ContentEngine({ ai, humanizer: new ContentHumanizer({ ai, writing: currentWriting }) });
    if (engagement) engagement.engine.writing = currentWriting;
    const planner = state.learning ? new ContentPlanner({ product, copy, state, engine, learning: dryRun ? undefined : new ContentLearning({ ai }), externalLearning, persist }) : null;
    const media = dryRun ? null : new (require('./background-media').BackgroundMedia)(new (require('./content-media').ContentMedia)({ root, ai }));
    const rolling = dryRun || engagementOnly ? null : new (require('./rolling-content').RollingContent)({ product, copy, state, engine, media, externalLearning, persist });
    if (rolling) rolling.initialize();
    const scheduler = new ContentScheduler({ product, state, persist, publish, tracker, engine, planner, copy, mediaRoot: root });
    let stopped = false;
    let wake;
    const pause = ms => new Promise(resolve => { const timer = setTimeout(resolve, ms); wake = () => { clearTimeout(timer); resolve(); }; });
    const connectivity = dryRun ? null : runtime.connectivity || new (require('./runtime-connectivity').RuntimeConnectivity)({ platforms: require('./publishing-settings').activePlatforms(product, state) });
    const stop = () => { stopped = true; if (wake) wake(); };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    console.log(`Content mode: ${product.product.name}; publishing: ${require('./publishing-settings').activePlatforms(product, state).join(', ') || 'paused'}; disabled: ${require('./publishing-settings').disabledPlatforms(product).join(', ') || 'none'}; ${dryRun ? 'PREVIEW' : 'LIVE'}.`);
    console.log(JSON.stringify({ selling: tracker.getSellingStatus() }));
    try {
      if (approvalArg) {
        const id = approvalArg.slice('--approve='.length);
        const pending = engagement.state.turns[id];
        if (!pending || pending.status !== 'pending_approval') throw new Error('No matching pending product engagement approval');
        console.log(JSON.stringify(await engagement.process(pending.item, { dryRun, approvalMode: CONFIG.APPROVAL_MODE, approvedId: id }), null, 2));
        return;
      }
      let nextEngagementAt = 0;
      let engagementCycleStart = Date.now();
      let lastHeldMessage;
      
      while (!stopped) {
        if (rolling) media.poll(state, () => scheduler.commit());
        if (!dryRun) {
          const changes = management.processChanges(root);
          for (const change of changes) console.log(JSON.stringify({ settings: change }));
          if (changes.some(change => change.status === 'applied')) {
            const latest = loadProduct(root);
            // All runtime components share this product object.
            Object.assign(product, latest.product);
            const latestWriting = loadWriting(root, product);
            if (engine) engine.humanizer.writing = latestWriting;
            if (engagement) engagement.engine.writing = latestWriting;
          }
          for (const change of require('./queue-management').processQueueRequests(root, state)) console.log(JSON.stringify({ queue: change }));
        }
        if (connectivity) {
          connectivity.platforms = require('./publishing-settings').activePlatforms(product, state);
          const network = await connectivity.poll();
          if (!network.online) {
            if (network.changed) console.log('[Connectivity] Offline; publication, engagement and AI preparation paused. Pending posts are preserved.');
            if (args.includes('--once')) { console.log(JSON.stringify({ status: 'offline', platforms: network.platforms })); break; }
            await pause(1000); wake = null;
            continue;
          }
          if (stopped) break;
          if (network.changed && !engagementOnly) {
            const resumed = require('./interval-schedule').resumeIntervalQueue(state, product, Date.now());
            if (resumed.status !== 'unchanged') { scheduler.commit(); console.log('[Schedule] ' + JSON.stringify(resumed)); }
          }
        }
        // Synthesize during idle time or before replenishment; never ahead of a due post.
        if (!dryRun && externalLearning && (engagementOnly || !require('./interval-schedule').hasDuePosts(state, product, Date.now())) && (engagementOnly || !state.posts.some(p => p.status === 'pending') || state.nextPostAt > Date.now() + 5 * 60000)) {
          const learned = await externalLearning.maybeLearn(state).catch(err => ({ status: 'error', reason: err.message }));
          if (['learned', 'error'].includes(learned.status)) console.log(JSON.stringify({ learning: learned }));
        }
        const result = engagementOnly ? { status: 'engagement' } : await scheduler.tick({ dryRun });
        const heldMessage = result.status === 'held' ? JSON.stringify(result) : null;
        if ((!['waiting', 'observing', 'engagement'].includes(result.status) && !(engagement && result.status === 'complete') && (!heldMessage || heldMessage !== lastHeldMessage)) || args.includes('--once') || dryRun) console.log(JSON.stringify(result, null, 2));
        lastHeldMessage = heldMessage;
        // Finish one due publication per platform before starting slow background work.
        if (!engagementOnly && !dryRun && !args.includes('--once') && ['published', 'held', 'retry_scheduled'].includes(result.status) && require('./interval-schedule').hasDuePosts(state, product, Date.now())) continue;
        if (rolling && !stopped) {
          const prepared = await rolling.tick().catch(err => ({ status: 'preparation_error', reason: err.message }));
          if (!['waiting', 'idle', 'disabled', 'complete', 'blocked'].includes(prepared.status)) console.log('[Preparation] ' + JSON.stringify(prepared));
        }
        if (engagement && Date.now() >= nextEngagementAt && !stopped) {
          const platforms = product.strategy.platforms.filter(platform => !state.recovery?.platformHolds?.[platform]);
          if (!platforms.length) { await pause(1000); continue; }
          const cycleElapsedMs = Date.now() - engagementCycleStart;
          const PLATFORM_DURATION = 3 * 60000;
          const REST_DURATION = 5 * 60000;
          const TOTAL_ACTIVE = platforms.length * PLATFORM_DURATION;
          
          if (cycleElapsedMs >= TOTAL_ACTIVE) {
            console.log(`[ENGAGEMENT] All platforms scanned for ${platforms.length * 3} minutes. Resting for 5 minutes...`);
            if (cycleElapsedMs >= TOTAL_ACTIVE + REST_DURATION) {
              engagementCycleStart = Date.now(); // Restart cycle
              nextEngagementAt = Date.now();
            } else {
              nextEngagementAt = engagementCycleStart + TOTAL_ACTIVE + REST_DURATION; // Wake up after rest
            }
          } else {
            const platformIndex = Math.floor(cycleElapsedMs / PLATFORM_DURATION);
            const activePlatform = platforms[platformIndex];
            console.log(`[ENGAGEMENT] Focusing on platform: ${activePlatform} (${Math.floor((cycleElapsedMs % PLATFORM_DURATION) / 60000)}/3 mins elapsed in this block)`);
            console.log(JSON.stringify(await engagement.cycle({ dryRun, approvalMode: CONFIG.APPROVAL_MODE, activePlatform }).catch(err => ({ status: 'engagement_error', reason: err.message })), null, 2));
            nextEngagementAt = Date.now() + 2.5 * 60000; // Check the active platform every 2.5 mins
          }
        }
        if (dryRun || args.includes('--once') || (result.status === 'complete' && !engagement)) break;
        await pause(1000);
        wake = null;
      }
    } finally {
      if (rolling) await media.drain(state, () => scheduler.commit());
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
      if (!dryRun || engagementOnly) require('../browser/browser-manager').disconnect();
    }
  };
  return command === 'content-status' && !args.includes('--refresh') ? action() : withLock(root, action);
}
module.exports = { run, publish };
