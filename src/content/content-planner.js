const { HOUR, nextSlots } = require('./content-calendar');
const { analyzeContent } = require('./content-analytics');
const { validatePost } = require('./content-engine');
const HOOKS = ['practical-tip', 'common-mistake'];
const timing = require('./interval-schedule');
function pilotAssignments(product, settings) {
  const plan = [], platforms = product.strategy.platforms;
  for (let round = 0; round < Math.max(...Object.values(settings.pilot_counts)); round++) {
    platforms.forEach((platform, i) => {
      if (round < settings.pilot_counts[platform]) plan.push(assignments(product, 1, round * platforms.length + i)[0]);
    });
  }
  return plan;
}
function assignments(product, count, offset = 0, report = null) {
  const platforms = product.strategy.platforms;
  return Array.from({ length: count }, (_, i) => {
    const index = offset + i;
    const platform = platforms[index % platforms.length];
    const round = Math.floor(index / platforms.length);
    // Repeat two topics in the pilot; reserve 20% of adaptive slots for exploration.
    const balancedTopic = round % Math.min(2, product.product.key_topics.length);
    const preferred = report?.platforms[platform]?.preferredTopic;
    const exploring = !!report && Math.floor(i / platforms.length) % 5 === 4;
    const topicIndex = !exploring && Number.isInteger(preferred) ? preferred : (report ? round % product.product.key_topics.length : balancedTopic);
    const hasMedia = platform === 'instagram' || require('./media-settings').mediaSettings(product).enabled;
    const platformIndex = round + 1;
    const recommendation = (platformIndex % 2 === 0) && (platformIndex % 5 !== 0);
    return { platform, topicIndex, topic: product.product.key_topics[topicIndex], hookId: HOOKS[Math.floor(round / 2) % HOOKS.length], format: hasMedia ? 'media' : 'text', recommendation,
      ...(hasMedia ? { media: { required: true, status: 'pending', attempts: 0, textHash: '' } } : {}),
      mode: exploring ? 'explore' : Number.isInteger(preferred) ? 'promising' : 'balanced', sourceRefs: [`product.key_topics[${topicIndex}]`] };
  });
}
class ContentPlanner {
  constructor({ product, copy, state, engine, learning, externalLearning, persist, now = () => Date.now() }) { Object.assign(this, { product, copy, state, engine, learning, externalLearning, persist, now }); }
  readiness() {
    const l = this.state.learning;
    if (!l) return { status: 'disabled' };
    if (this.now() >= timing.campaignEnd(this.product, this.state) || this.state.posts.length >= l.settings.max_campaign_posts) return { status: 'complete' };
    if (this.state.posts.some(p => p.status === 'pending')) return { status: 'pending_posts' };
    const lastBatch = this.state.posts.filter(p => p.batch === l.batch);
    if (lastBatch.some(p => !['published', 'missed'].includes(p.status))) return { status: 'needs_review' };
    const readyAt = Math.max(...lastBatch.map(p => (p.publishedAt ?? p.scheduledAt) + l.settings.observation_age_hours * HOUR));
    return this.now() < readyAt ? { status: 'observing', readyAt } : { status: 'ready' };
  }
  plan() {
    const readiness = this.readiness();
    const l = this.state.learning;
    if (readiness.status !== 'ready') return readiness;
    const report = analyzeContent(this.state, l.settings, this.now());
    const count = Math.min(l.settings.next_batch_size, l.settings.max_campaign_posts - this.state.posts.length);
    const planned = assignments(this.product, count, this.state.posts.length, report);
    const slots = timing.isInterval(this.product) ? timing.intervalSlots(this.product, this.now(), planned, this.state).filter(t => t < timing.campaignEnd(this.product, this.state)) : nextSlots(l.settings, this.now(), count, l.endAt, this.product.strategy.platforms.length);
    if (!slots.length) return { status: 'complete' };
    return { status: 'ready', report, slots, assignments: assignments(this.product, slots.length, this.state.posts.length, report), batch: l.batch + 1 };
  }
  async replenish() {
    const plan = this.plan();
    if (plan.status !== 'ready') return plan;
    let explanation;
    try { explanation = await this.learning.explain(plan.report); }
    catch (err) { explanation = { unavailable: err.message }; }
    const learned = this.externalLearning?.snapshot();
    if (learned) for (const assignment of plan.assignments.filter(a => a.mode === 'explore')) {
      const patterns = [...learned.insights.hooks, ...learned.insights.formats, ...(learned.insights.painPoints || [])].filter(p => p.platforms.includes(assignment.platform));
      if (patterns.length) {
        const pattern = patterns[(plan.batch - 1) % patterns.length];
        assignment.learnedPattern = pattern;
        assignment.insightRevision = learned.revision;
        assignment.sourceIds = pattern.evidenceIds;
      }
    }
    const posts = await this.engine.generateContentQueue(this.product, this.copy, plan.slots.length, { plan: plan.assignments, previousTexts: this.state.posts.map(p => p.text), learned });
    if (posts.length !== plan.slots.length) throw new Error('Incomplete adaptive batch');
    const previous = new Set(this.state.posts.map(p => p.text.trim().toLowerCase().replace(/\s+/g, ' ')));
    const offset = this.state.posts.length;
    const appended = posts.map((post, i) => {
      validatePost(post, this.product, { style: post.status !== 'needs_edit' });
      if (post.type !== 'value' || post.platform !== plan.assignments[i].platform) throw new Error('Adaptive draft must match the value slot');
      const key = post.text.trim().toLowerCase().replace(/\s+/g, ' ');
      if (previous.has(key)) throw new Error('Adaptive batch contains duplicate content');
      previous.add(key);
      return { ...post, ...plan.assignments[i], id: `value-${offset + i + 1}`, status: post.status === 'needs_edit' ? 'needs_edit' : 'pending', scheduledAt: plan.slots[i], batch: plan.batch, experimentId: this.state.learning.experimentId };
    });
    // Commit queue, report and batch version together in the existing atomic state write.
    const next = JSON.parse(JSON.stringify(this.state));
    next.posts.push(...appended);
    next.calendar.push(...appended.map(p => ({ id: p.id, platform: p.platform, scheduledAt: new Date(p.scheduledAt).toISOString() })));
    next.nextPostAt = appended[0].scheduledAt;
    next.learning.phase = 'adaptive';
    next.learning.batch = plan.batch;
    next.learning.reports.push({ ...plan.report, batch: plan.batch, explanation, assignments: plan.assignments });
    this.persist(next);
    Object.assign(this.state, next);
    return { status: 'replenished', batch: plan.batch, count: appended.length };
  }
}
module.exports = { ContentPlanner, assignments, pilotAssignments };
