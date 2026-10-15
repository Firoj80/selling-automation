const { validatePost } = require('./content-engine');
const { pendingPosts, syncQueue, changeQueue, schedulePolicy } = require('./content-queue');
const timing = require('./interval-schedule');
class ContentScheduler {
  constructor({ product, state, persist, publish, tracker, engine, planner, copy = '', mediaRoot = require('path').resolve(__dirname, '../..'), now = () => Date.now() }) {
    if (!Array.isArray(state.posts) || !Number.isFinite(state.nextPostAt)) throw new Error('Invalid content state');
    Object.assign(this, { product, state, persist, publish, tracker, engine, planner, copy, mediaRoot, now });
  }
  selectPost() { return timing.isInterval(this.product) ? timing.candidates(this.state, this.product)[0]?.post || null : pendingPosts(this.state)[0] || null; }
  getNextPlatform() { return this.selectPost()?.platform || null; }
  getNextPostTime() { return new Date(timing.isInterval(this.product) ? timing.candidates(this.state, this.product)[0]?.due ?? this.state.nextPostAt : this.selectPost()?.scheduledAt ?? this.state.nextPostAt); }
  commit() { if (timing.isInterval(this.product)) timing.projectQueue(this.state, this.product, this.now()); syncQueue(this.state); this.persist(this.state); }
  initCatchup() {
    if (timing.isInterval(this.product)) return;
    if (!this.state.learning || !this.state.posts.some(p => p.status === 'pending' && Number.isFinite(p.scheduledAt) && p.scheduledAt + (this.state.learning.settings.slot_grace_minutes ?? 30) * 60000 <= this.now())) return;
    const result = changeQueue(this.state, this.product, { kind: 'catch-up' }, this.now());
    if (result.changes.length) { this.persist(result.state); Object.assign(this.state, result.state); }
  }
  eligible(post) { return !!this.tracker?.shouldPublishProductForPlatform(post.platform); }
  async tick({ dryRun = true } = {}) {
    const uncertain = this.state.posts.find(p => ['publishing', 'needs_review'].includes(p.status));
    if (uncertain) throw new Error(`Post ${uncertain.id} has status ${uncertain.status}; reconcile the platform result before retrying. Run node threads-agent.js recover --inspect.`);
    if (!dryRun) this.initCatchup();
    const learning = this.state.learning;
    if (learning && !dryRun && this.tracker && this.now() >= (learning.nextMetricsAt || 0)) {
      await this.tracker.refresh(); learning.nextMetricsAt = this.now() + 15 * 60000; this.commit();
    }
    let post = this.selectPost();
    if (!post) {
      if (this.state.posts.some(p => ['held', 'missed', 'needs_edit', 'needs_media'].includes(p.status))) return { status: 'held', reason: 'Saved drafts need editing, images or rescheduling; see queue list.' };
      if (require('./media-settings').rollingSettings(this.product).enabled) return { status: 'observing', reason: 'Rolling preparation replaces batch replenishment' };
      if (learning && this.planner) {
        if (dryRun) return this.planner.plan();
        if (this.now() < (this.nextPlanAttemptAt || 0)) return { status: 'waiting', nextAttemptAt: this.nextPlanAttemptAt };
        try { return await this.planner.replenish(); }
        catch (err) { this.nextPlanAttemptAt = this.now() + 15 * 60000; return { status: 'learning_error', reason: err.message, nextAttemptAt: this.nextPlanAttemptAt }; }
      }
      return { status: 'complete' };
    }
    if (learning && this.now() >= timing.campaignEnd(this.product, this.state)) {
      if (!dryRun) {
        for (const p of pendingPosts(this.state)) { p.status = 'held'; p.holdReason = 'Campaign ended; extend and reschedule to retain these drafts'; }
        this.commit();
      }
      return { status: 'held', reason: 'Campaign ended' };
    }
    const due = timing.isInterval(this.product) ? timing.candidates(this.state, this.product)[0].due : post.scheduledAt ?? this.state.nextPostAt;
    if (this.now() < due) return { status: 'waiting', nextPostAt: due };
    if (dryRun) {
      const eligible = this.eligible(post);
      const plannedType = post.type === 'product' && !eligible ? post.valueText && !post.manuallyEdited ? 'value' : 'held' : eligible && !post.manuallyEdited ? 'product' : post.type;
      return { status: 'preview', post, nextPostAt: due, expiredSlot: !timing.isInterval(this.product) && !!learning && this.now() > due + learning.settings.slot_grace_minutes * 60000, plannedType, engagement: this.tracker?.summary() };
    }
    if (this.tracker) await this.tracker.refresh();
    // Enforce spacing using actual publication times, including after a slow browser action.
    if (learning && !timing.isInterval(this.product)) {
      const policy = schedulePolicy(this.product, this.state);
      const { localDate } = require('./content-calendar');
      const today = localDate(this.now(), policy.pilot_timezone);
      const todaysPosts = this.state.posts.filter(p => p.platform === post.platform && p.status === 'published' && Number.isFinite(p.publishedAt) && localDate(p.publishedAt, policy.pilot_timezone) === today);
      if (todaysPosts.length >= policy.pilot_local_times.length) return { status: 'waiting', reason: 'Platform daily posting limit reached; overdue drafts will move to the next available day.' };
      const last = Math.max(0, ...this.state.posts.filter(p => p.platform === post.platform && p.status === 'published').map(p => p.publishedAt || 0));
      if (last && this.now() < last + (policy.minimum_gap_minutes ?? 30) * 60000) return { status: 'waiting', nextPostAt: last + (policy.minimum_gap_minutes ?? 30) * 60000 };
    }
    if (this.eligible(post) && !post.manuallyEdited && post.type !== 'product') {
      if (!this.engine) throw new Error('Product content generator is not configured');
      const generated = await this.engine.generateProductPost(this.product, { platform: post.platform, copy: this.copy,
        previousPosts: this.tracker.publishedPosts().filter(p => p.type === 'product').map(p => p.text) });
      if (generated.platform !== post.platform || generated.type !== 'product') throw new Error('Generated pitch does not match this platform slot');
      post = { ...post, text: generated.text, type: generated.type, writing: generated.writing, valueText: post.text, valueWriting: post.writing };
      if (generated.status === 'needs_edit') post.status = 'needs_edit';
      this.state.posts[this.state.posts.findIndex(p => p.id === post.id)] = post;
      this.commit();
      if (post.status === 'needs_edit') return { status: 'held', reason: 'Generated product draft requires editing', post };
    }
    if (post.type === 'product' && !this.eligible(post)) {
      if (!post.valueText || post.manuallyEdited) {
        post.status = 'held'; post.holdReason = 'Product draft is not eligible on this platform'; this.commit();
        return { status: 'held', post };
      }
      post.savedProductDrafts ||= [];
      post.savedProductDrafts.push({ text: post.text, writing: post.writing, at: this.now() });
      post.text = post.valueText; post.type = 'value'; post.writing = post.valueWriting; delete post.valueText; delete post.valueWriting;
      this.commit();
    }
    try {
      validatePost(post, this.product);
      post.validation = { status: 'valid', rulesRevision: require('./writing-rules').rulesRevision(this.product), at: this.now() };
    } catch (err) {
      post.status = 'needs_edit'; post.writing = { ...post.writing, status: 'needs_edit', reason: err.message }; this.commit();
      return { status: 'held', reason: err.message, post };
    }
    if (learning && this.now() >= timing.campaignEnd(this.product, this.state)) return { status: 'waiting', reason: 'Campaign ended during preparation' };
    if (post.media?.required && post.media.status !== 'text_only' && !require('./content-media').validMedia(post, this.mediaRoot)) {
      if (post.media.textHash !== require('./content-media').textHash(post.text)) post.media = { required: true, status: 'pending', attempts: 0, textHash: require('./content-media').textHash(post.text) };
      post.status = 'needs_media'; this.commit();
      return { status: 'held', reason: 'Caption image must be prepared before publishing', post };
    }
    post.status = 'publishing'; post.attemptedAt = this.now(); this.commit();
    let result;
    try { result = await this.publish(post, this.product); } catch (err) { result = { success: false, reason: err.message }; }
    if (!result?.success || !result.verified || result.simulated) {
      post.status = 'needs_review'; post.result = result || { reason: 'Empty publisher response' }; this.commit();
      throw new Error(`Publication requires review: ${post.result.reason || 'No verified live result'}. Reconcile before retrying.`);
    }
    post.status = 'published'; post.publishedAt = this.now(); post.result = result;
    if (!Number.isFinite(this.selectPost()?.scheduledAt)) this.state.nextPostAt = this.now() + this.product.strategy.post_frequency_hours * 3600000;
    this.commit();
    return { status: 'published', post };
  }
}
module.exports = { ContentScheduler };
