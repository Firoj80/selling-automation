const { rollingSettings, mediaSettings } = require('./media-settings');
const { assignments } = require('./content-planner');
const { analyzeContent } = require('./content-analytics');
const timing = require('./interval-schedule');
const { syncQueue } = require('./content-queue');
const { publishingEnabled } = require('./publishing-settings');
class RollingContent {
  constructor({ product, copy, state, engine, media, externalLearning, persist, now = () => Date.now() }) { Object.assign(this, { product, copy, state, engine, media, externalLearning, persist, now }); }
  commit() { if (timing.isInterval(this.product)) timing.projectQueue(this.state, this.product, this.now()); syncQueue(this.state, this.product); this.persist(this.state); }
  initialize() {
    if (!rollingSettings(this.product).enabled || this.state.rollingContent) return;
    this.state.rollingContent = { enabledAt: this.now(), baselineIds: this.state.posts.map(p => p.id), baselinePublishedIds: this.state.posts.filter(p => p.status === 'published').map(p => p.id), jobs: [] };
    this.commit();
  }
  discover() {
    this.initialize();
    const rolling = this.state.rollingContent;
    if (!rollingSettings(this.product).enabled || !rolling) return;
    let changed = false;
    for (const post of this.state.posts) {
      if (post.status !== 'published' || !post.result?.success || !post.result?.verified || post.result.simulated || rolling.baselinePublishedIds.includes(post.id) || rolling.jobs.some(j => j.triggerId === post.id) || !publishingEnabled(this.product, post.platform, this.state)) continue;
      rolling.jobs.push({ triggerId: post.id, platform: post.platform, status: 'queued', attempts: 0, createdAt: this.now() }); changed = true;
    }
    if (changed) this.commit();
  }
  async tick() {
    if (!rollingSettings(this.product).enabled && !mediaSettings(this.product).enabled) return { status: 'disabled' };
    this.discover();
    if (this.state.posts.some(p => ['publishing', 'needs_review'].includes(p.status) && !this.state.recovery?.platformHolds?.[p.platform])) return { status: 'blocked' };
    if (this.media.active) return { status: 'waiting', reason: 'Image preparation is running in background' };
    if (this.now() >= timing.campaignEnd(this.product, this.state)) return { status: 'complete' };
    // Handle due posts first. Preparation runs only with at least five minutes free.
    if (timing.candidates(this.state, this.product).some(c => c.due <= this.now() + 5 * 60000)) return { status: 'waiting' };
    const repair = this.state.posts.find(p => publishingEnabled(this.product, p.platform, this.state) && p.media?.required && !['published', 'publishing', 'needs_review', 'held', 'missed'].includes(p.status) && p.media.status !== 'text_only' && !require('./content-media').validMedia(p, this.media.root) && (p.media.attempts || 0) < mediaSettings(this.product).max_attempts && this.now() >= (p.media.nextAttemptAt || 0));
    if (repair) { await this.media.prepare(repair, this.product, () => this.commit()); return { status: 'media_prepared', id: repair.id, media: repair.media.status }; }
    if (!rollingSettings(this.product).enabled) return { status: 'disabled' };
    const job = this.state.rollingContent.jobs.find(j => publishingEnabled(this.product, j.platform, this.state) && ['queued', 'generating', 'error'].includes(j.status) && j.attempts < 3 && this.now() >= (j.nextAttemptAt || 0));
    if (!job) return { status: 'idle' };
    const cap = this.state.learning?.settings.max_campaign_posts || 180;
    if (this.state.posts.length >= cap) { job.status = 'capped'; this.commit(); return { status: 'complete', reason: 'Campaign post limit reached' }; }
    job.status = 'generating'; job.attempts++; this.commit();
    try {
      const report = this.state.learning ? analyzeContent(this.state, this.state.learning.settings, this.now()) : null;
      const assignment = assignments(this.product, 1, this.state.posts.length, report)[0];
      assignment.platform = job.platform;
      const platformPosts = this.state.posts.filter(p => p.platform === job.platform).length;
      assignment.recommendation = ((platformPosts + 1) % 2 === 0) && ((platformPosts + 1) % 5 !== 0);
      // Instagram (and any media-required platform) must have media set in the
      // assignment so generateContentQueue includes it in the accepted draft.
      // Without this the engine validates the post as text-only and throws.
      if (job.platform === 'instagram' || require('./media-settings').mediaSettings(this.product).enabled) {
        assignment.media = { required: true, status: 'pending', attempts: 0, textHash: '' };
      }
      const preferred = report?.platforms[job.platform]?.preferredTopic;
      if (Number.isInteger(preferred)) { assignment.topicIndex = preferred; assignment.topic = this.product.product.key_topics[preferred]; }
      const learned = this.externalLearning?.snapshot();
      if (learned && Math.floor(this.state.posts.length / this.product.strategy.platforms.length) % 5 === 4) {
        const patterns = [...learned.insights.hooks, ...learned.insights.formats].filter(p => p.platforms.includes(job.platform));
        if (patterns.length) { assignment.mode = 'explore'; assignment.learnedPattern = patterns[0]; assignment.insightRevision = learned.revision; assignment.sourceIds = patterns[0].evidenceIds; }
      }
      const id = `rolling-${job.triggerId}`;
      await this.engine.generateContentQueue(this.product, this.copy, 1, { plan: [assignment], previousTexts: this.state.posts.map(p => p.text), learned,
        onAccepted: drafts => {
          if (this.state.posts.some(p => p.id === id)) throw new Error('Rolling draft already exists');
          const tail = Math.max(this.now() - timing.intervalMs(this.product), ...this.state.posts.filter(p => p.platform === job.platform && ['pending', 'needs_media', 'needs_edit', 'held'].includes(p.status)).map(p => p.scheduledAt || 0));
          const post = { ...drafts[0], id, scheduledAt: tail + timing.intervalMs(this.product), batch: this.state.learning?.batch || 0, experimentId: this.state.learning?.experimentId, triggerId: job.triggerId, generatedAt: this.now() };
          this.state.posts.push(post); job.draftId = id; job.status = 'saved'; this.commit();
        } });
      const post = this.state.posts.find(p => p.id === job.draftId);
      if (post.media?.required) await this.media.prepare(post, this.product, () => this.commit());
      return { status: 'prepared', platform: job.platform, id: post.id, media: post.media?.status || 'disabled' };
    } catch (err) {
      // A checkpointed draft is never regenerated even if later image preparation fails.
      job.status = job.draftId ? 'saved' : 'error'; job.error = err.message; job.nextAttemptAt = this.now() + 15 * 60000; this.commit();
      return { status: 'preparation_error', platform: job.platform, reason: err.message };
    }
  }
}
module.exports = { RollingContent };
