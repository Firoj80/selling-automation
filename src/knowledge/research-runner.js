const fs = require('fs');
const path = require('path');
const { save } = require('../content/content-store');
const { fingerprint } = require('../content/product-config');
const { researchSettings } = require('./research-settings');
const { SwipeStore, digest, textHash, DAY } = require('./swipe-store');
const { LearningEngine } = require('./learning-engine');
const { ContentObserver } = require('./content-observer');

function researchScope(product) {
  return digest(JSON.stringify({ name: product.product.name, description: product.product.description, audience: product.product.target_audience, topics: product.product.key_topics, platforms: product.strategy.platforms, seller: product.seller.usernames || product.seller.username }));
}
function searchQuery(topic, variant, platform) {
  const concepts = [
    [/self[ -]?host/i, 'self hosted automation'],
    [/content calendar/i, 'content calendar'],
    [/digital products?/i, 'digital product marketing'],
    [/\bAI\b.*(?:writ|voice|posts?)/i, 'AI content writing'],
    [/(?:comments?|DMs?).*(?:sales|conversations?)/i, 'social selling'],
    [/view count|reach.*selling/i, 'social media analytics'],
    [/warm audience|building.*audience/i, 'audience building'],
    [/automat.*social media|social media.*automat/i, 'social media automation']
  ];
  const concept = concepts.find(([pattern]) => pattern.test(topic))?.[1];
  if (platform === 'facebook' && concept) {
    const alternatives = {
      'social media automation': ['social media scheduling', 'automate social media posts', 'consistent content creation', 'social media content workflow', 'content creator burnout', 'batch social media content'],
      'digital product marketing': ['selling digital products', 'digital product marketing', 'digital product launch', 'promote digital products', 'digital products content strategy', 'digital product audience'],
      'audience building': ['grow social media audience', 'build audience before selling', 'content marketing for creators', 'social media audience engagement', 'build trust with followers', 'creator audience growth'],
      'AI content writing': ['AI social media content', 'AI writing social media posts', 'humanize AI content', 'AI content brand voice', 'AI content for creators', 'write natural social media posts'],
      'self hosted automation': ['self hosted social media automation', 'social media automation tools', 'automate content publishing', 'social media posting workflow', 'social media scheduling tools', 'build social media automation'],
      'content calendar': ['social media content calendar', 'plan social media content', 'content calendar for creators', 'batch content planning', 'educational social media posts', 'content planning digital products'],
      'social selling': ['sell digital products social media', 'social media sales conversations', 'turn comments into customers', 'sell without spam social media', 'digital product customer questions', 'social media DM sales'],
      'social media analytics': ['measure social media engagement', 'social media content performance', 'social media reach engagement', 'which content gets engagement', 'track social media post views', 'test social media content']
    };
    return alternatives[concept][variant % alternatives[concept].length];
  }
  const stop = new Set('how to on without being the a an and or so you your in not from why matters more than total for into automatically right way before with can it as of per'.split(' '));
  const words = topic.replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(w => w && !stop.has(w.toLowerCase()) && !(platform !== 'threads' && w.toLowerCase() === 'threads'));
  // Search concepts, rather than requiring the full writing brief to match verbatim.
  const base = concept || words.slice(0, 4).join(' ') || topic;
  const rotation = variant % 3;
  return `${base}${rotation === 1 ? ' tips' : rotation === 2 ? ' strategy' : ''}`;
}
class ResearchRunner {
  constructor({ root, product, copy = '', ai, adapter, now = () => Date.now(), onProgress = event => console.log(`[Research] ${JSON.stringify(event)}`) }) {
    Object.assign(this, { root, product, copy, ai, adapter, now, onProgress });
    this.settings = researchSettings(product);
    this.scope = researchScope(product);
    this.file = path.join(root, 'private/product-research.json');
    this.baseStore = new SwipeStore({ root, fingerprint: fingerprint(product, copy), now });
    this.store = { fingerprint: this.baseStore.fingerprint, read: () => ({ ...this.baseStore.read(), records: this.records() }),
      known: item => this.records().some(r => r.url === item.url || r.contentHash === textHash(item.text)),
      add: (item, topicIndex) => this.baseStore.add(item, topicIndex) };
    this.learning = new LearningEngine({ root, store: this.store, ai, now });
  }
  records() {
    return this.baseStore.read().records.filter(r => r.researchScope === this.scope && r.observedAt >= this.now() - this.settings.freshness_days * DAY && (r.publishedAt == null || r.publishedAt >= this.now() - this.settings.freshness_days * DAY));
  }
  status() {
    const records = this.records();
    const platforms = Object.fromEntries(this.product.strategy.platforms.map(platform => {
      const rows = records.filter(r => r.platform === platform);
      const authors = new Set(rows.map(r => r.author)).size;
      const usableRecords = [...new Set(rows.map(r => r.author))].reduce((count, author) => count + Math.min(2, rows.filter(r => r.author === author).length), 0);
      const discussions = rows.filter(r => r.recordType === 'comment').length;
      return [platform, { records: rows.length, usableRecords, authors, discussions, ready: usableRecords >= this.settings.minimum_records_per_platform && authors >= this.settings.minimum_authors_per_platform && discussions >= this.settings.minimum_discussions_per_platform,
        missing: { records: Math.max(0, this.settings.minimum_records_per_platform - usableRecords), authors: Math.max(0, Math.max(this.settings.minimum_authors_per_platform, Math.ceil(this.settings.minimum_records_per_platform / 2)) - authors), discussions: Math.max(0, this.settings.minimum_discussions_per_platform - discussions) } }];
    }));
    const snapshot = this.learning.snapshot();
    const covered = new Set(snapshot ? Object.values(snapshot.insights).flat().flatMap(p => p.platforms) : []);
    const allReady = Object.values(platforms).every(p => p.ready);
    const supported = this.product.strategy.platforms.filter(p => platforms[p].ready && covered.has(p));
    const ready = supported.length === this.product.strategy.platforms.length;
    return { status: !this.settings.enabled ? 'disabled' : ready ? 'ready' : this.settings.allow_partial && supported.length ? 'partial' : allReady ? 'needs_synthesis' : 'insufficient_evidence', platforms, supportedPlatforms: supported, revision: snapshot?.revision || null, scope: this.scope };
  }
  checkpoint() {
    if (!fs.existsSync(this.file)) return { version: 1, scope: this.scope, fingerprint: this.store.fingerprint, searches: {}, errors: [] };
    const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    if (data.version !== 1 || data.fingerprint !== this.store.fingerprint || data.scope !== this.scope) {
      // Preserve earlier research checkpoint as a historical record, but do not reuse its claims.
      save(`${this.file}.previous-${this.now()}.json`, data);
      return { version: 1, scope: this.scope, fingerprint: this.store.fingerprint, searches: {}, errors: [] };
    }
    return data;
  }
  async run() {
    try { return await this.collect(); }
    finally { await this.adapter?.browser?.closeResearch?.(); }
  }
  async collect() {
    if (!this.settings.enabled) return { status: 'disabled', learned: null };
    if (this.product.external_learning?.enabled === false) return { ...this.status(), status: 'blocked', reason: 'Initial research requires external_learning.enabled. Enable it or explicitly disable research.' };
    const initial = this.status();
    if (initial.status === 'ready') return { ...initial, learned: this.learning.snapshot() };
    if (!this.ai) this.ai = require('../ai/ai-runtime');
    this.learning.ai = this.ai;
    if (!this.adapter) this.adapter = new (require('../engagement/product-browser-adapter').ProductBrowserAdapter)({ campaign: { posts: [] } });
    const campaignFile = path.join(this.root, 'private/product-content.json');
    const campaign = fs.existsSync(campaignFile) ? JSON.parse(fs.readFileSync(campaignFile, 'utf8')) : { posts: [] };
    const observer = new ContentObserver({ product: this.product, copy: this.copy, store: this.store, ai: this.ai, campaign, now: this.now });
    const checkpoint = this.checkpoint();
    const relevanceContext = digest(JSON.stringify({ version: 2, product: this.product.product, copy: this.copy }));
    // Reuse completed verdicts for one day within the same research scope.
    // Failed AI requests never enter this map and remain retryable.
    observer.checked = new Map(Object.entries(checkpoint.relevanceContext === relevanceContext ? checkpoint.relevanceChecks || {} : {}).filter(([url, at]) =>
      /^https:\/\//.test(url) && Number.isFinite(at) && at <= this.now() && at > this.now() - DAY).slice(-1000));
    const runErrors = [];
    const recordError = error => { checkpoint.errors.push(error); runErrors.push(error); };
    const persist = () => save(this.file, { ...checkpoint, relevanceContext, relevanceChecks: Object.fromEntries(observer.checked), updatedAt: this.now(), progress: this.status() });
    for (const platform of this.product.strategy.platforms) {
      for (let search = 0; search < this.settings.max_searches_per_platform_per_run && !this.status().platforms[platform].ready; search++) {
        const index = checkpoint.searches[platform] || 0;
        const topics = this.product.product.key_topics;
        const topic = topics[index % topics.length];
        const variant = Math.floor(index / topics.length);
        const query = searchQuery(topic, variant, platform);
        this.onProgress({ platform, stage: 'searching', query, search: search + 1, budget: this.settings.max_searches_per_platform_per_run });
        try {
          const posts = await this.adapter.researchSearch(platform, query);
          this.onProgress({ platform, stage: 'posts_read', foundPosts: posts.length });
          const comments = [];
          const seller = require('../content/campaign-settings').accountUsername(this.product, platform).replace(/^@/, '').toLowerCase();
          const discussionParents = posts.filter(p => p.username?.replace(/^@/, '').toLowerCase() !== seller && (p.publishedAt == null || p.publishedAt >= this.now() - this.settings.freshness_days * DAY))
            .sort((a, b) => (b.metrics?.comments || 0) - (a.metrics?.comments || 0));
          for (const parent of discussionParents.slice(0, this.settings.max_discussions_per_search)) {
            this.onProgress({ platform, stage: 'reading_discussion', postUrl: parent.url });
            try { const found = await this.adapter.researchDiscussion(parent); comments.push(...found); this.onProgress({ platform, stage: 'discussion_read', foundComments: found.length }); }
            catch (err) { recordError({ platform, stage: 'discussion', reason: err.message, at: this.now() }); this.onProgress({ platform, stage: 'discussion_unavailable', reason: err.message }); }
          }
          // Reserve part of the fixed relevance budget for discussions.
          const max = this.settings.max_relevance_checks_per_search;
          comments.sort((a, b) => Number(/\?/.test(b.text)) - Number(/\?/.test(a.text)) || b.text.length - a.text.length);
          const result = await observer.observe([...comments.slice(0, Math.floor(max / 2)), ...posts], { allowComments: true, maxChecks: max, researchScope: this.scope, freshnessDays: this.settings.freshness_days, onProgress: event => {
            if (event.stage === 'relevance_checked') persist();
            this.onProgress({ platform, ...event });
          } });
          result.errors.forEach(reason => recordError({ platform, stage: 'relevance', reason, at: this.now() }));
          checkpoint.searches[platform] = index + 1;
          if (checkpoint.queryFailures) delete checkpoint.queryFailures[`${platform}:${index}`];
          this.onProgress({ platform, stage: 'collected', foundPosts: posts.length, foundComments: comments.length, withMetrics: posts.filter(p => p.metrics?.likes != null || p.metrics?.comments != null).length, checked: result.checked, rejected: result.rejected, relevanceErrors: result.errors.length, saved: result.saved, ...this.status().platforms[platform] });
        } catch (err) {
          recordError({ platform, stage: 'search', reason: err.message, at: this.now() });
          this.onProgress({ platform, stage: 'unavailable', reason: err.message });
          await this.adapter.browser?.resetResearchPage?.(platform);
          const key = `${platform}:${index}`;
          checkpoint.queryFailures ||= {};
          checkpoint.queryFailures[key] = (checkpoint.queryFailures[key] || 0) + 1;
          // A repeatedly broken query must not permanently block every later topic.
          const defer = (err.code === 'PUBLIC_PAGE_RENDER_FAILED' || checkpoint.queryFailures[key] >= 2)
            && !/CDP is not reachable|login_required|access_blocked/i.test(err.message);
          if (defer) { checkpoint.searches[platform] = index + 1; this.onProgress({ platform, stage: 'query_deferred', query, reason: err.message }); }
          checkpoint.errors = checkpoint.errors.slice(-50); persist();
          if (!defer) break;
        }
        checkpoint.errors = checkpoint.errors.slice(-50); persist();
      }
    }
    const collected = this.status();
    const allReady = Object.values(collected.platforms).every(p => p.ready);
    if (allReady || this.settings.allow_partial && Object.values(collected.platforms).some(p => p.ready)) {
      this.onProgress({ stage: 'synthesizing' });
      try { await this.learning.synthesize(); }
      catch (err) { recordError({ stage: 'synthesis', reason: err.message, at: this.now() }); }
    }
    const result = { ...this.status(), errors: runErrors, errorHistoryCount: checkpoint.errors.length };
    persist();
    this.onProgress({ stage: result.status, platforms: result.platforms });
    return { ...result, learned: ['ready', 'partial'].includes(result.status) ? this.learning.snapshot() : null };
  }
}
function applyInitialInsights(plan, learned, supportedPlatforms) {
  if (!learned) return plan;
  const counts = {};
  return plan.map(assignment => {
    const n = counts[assignment.platform] || 0; counts[assignment.platform] = n + 1;
    // Alternate an unmodified baseline and evidence-supported experiments.
    const patterns = [...learned.insights.hooks, ...learned.insights.formats, ...learned.insights.painPoints].filter(p => p.platforms.includes(assignment.platform));
    if (n % 2 === 0 || !supportedPlatforms.includes(assignment.platform) || !patterns.length) return { ...assignment, researchMode: 'baseline' };
    const pattern = patterns[Math.floor(n / 2) % patterns.length];
    return { ...assignment, mode: 'explore', researchMode: 'public-pattern', learnedPattern: pattern, sourceIds: pattern.evidenceIds, insightRevision: learned.revision };
  });
}
module.exports = { ResearchRunner, researchScope, applyInitialInsights, searchQuery };
