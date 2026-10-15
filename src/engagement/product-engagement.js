const crypto = require('crypto');
const { normalize } = require('./product-reply-engine');
function turnKey(item) {
  return crypto.createHash('sha256').update(JSON.stringify([item.platform, item.kind, item.conversationId, item.id, normalize(item.text)])).digest('hex').slice(0, 24);
}
function participantKey(item) { return `${item.platform}:${normalize(item.username).replace(/^@/, '')}`; }
class ProductEngagement {
  constructor({ product, copy = '', state, engine, adapter, observer, persist = () => {}, now = () => Date.now(), maxPerHour = 5, cooldownMs = 10 * 60000 }) {
    Object.assign(this, { product, copy, state, engine, adapter, observer, persist, now, maxPerHour, cooldownMs });
    if (state.version !== 1 || !state.turns || !state.optOuts) throw new Error('Invalid product engagement state');
  }
  history(item) {
    return Object.values(this.state.turns).filter(turn => turn.status === 'sent' && turn.item.platform === item.platform && turn.item.conversationId === item.conversationId)
      .flatMap(turn => [{ sender: turn.item.username, text: turn.item.text }, { sender: 'seller', text: turn.response }]);
  }
  async process(item, { dryRun = true, approvalMode = false, approvedId = null } = {}) {
    if (!item || !['reply', 'dm'].includes(item.kind) || !this.product.strategy.platforms.includes(item.platform) || typeof item.text !== 'string' || !item.text.trim() || !item.id || !item.conversationId || !item.username) return { status: 'skipped', reason: 'Incomplete incoming message identity' };
    if (item.kind === 'dm' && (item.platform !== 'threads' || item.direction !== 'incoming' || item.source !== 'conversation')) return { status: 'skipped', reason: 'DM requires a verified incoming conversation message' };
    if (item.direction === 'outgoing' || normalize(item.username).replace(/^@/, '') === normalize(require('../content/campaign-settings').accountUsername(this.product, item.platform)).replace(/^@/, '')) return { status: 'skipped', reason: 'Own message' };
    const key = turnKey(item);
    const participant = participantKey(item);
    if (this.state.optOuts[participant]) return { status: 'skipped', reason: 'Recipient opted out' };
    const existing = this.state.turns[key];
    if (existing && existing.status !== 'pending_approval') return { status: 'skipped', id: key, reason: `Already ${existing.status}; no automatic retry` };
    if (existing && approvedId !== key) return { status: 'pending_approval', id: key, response: existing.response };
    if (approvedId && (!existing || approvedId !== key)) throw new Error('No matching pending approval');
    const decision = existing ? { action: 'reply', response: existing.response, intent: existing.intent } : await this.engine.generate({ product: this.product, copy: this.copy, item, history: this.history(item) });
    if (dryRun) return { status: 'preview', id: key, decision };
    if (decision.optOut) this.state.optOuts[participant] = { at: this.now(), reason: decision.reason };
    if (decision.action !== 'reply') {
      this.state.turns[key] = { item, status: decision.action === 'review' ? 'needs_review' : 'ignored', reason: decision.reason, ...(decision.draft ? { draft: decision.draft } : {}), at: this.now() };
      this.persist(this.state);
      return { id: key, status: this.state.turns[key].status, reason: decision.reason };
    }
    const previous = Object.values(this.state.turns);
    try { require('../content/writing-rules').validateStyle(decision.response, this.product); }
    catch (err) {
      this.state.turns[key] = { item, response: decision.response, intent: decision.intent, status: 'needs_review', reason: err.message, at: this.now() };
      this.persist(this.state);
      return { id: key, status: 'needs_review', reason: err.message };
    }
    if (previous.some(turn => turn.status === 'sent' && turn.item.conversationId === item.conversationId && turn.item.platform === item.platform && normalize(turn.response) === normalize(decision.response))) return { status: 'skipped', reason: 'Repeated outgoing response' };
    // Any uncertain send blocks the recipient, not just the exact message turn.
    if (previous.some(turn => participantKey(turn.item) === participant && ['sending', 'uncertain'].includes(turn.status))) return { status: 'skipped', reason: 'Recipient has an unresolved send' };
    if (approvalMode && approvedId !== key) {
      this.state.turns[key] = { item, response: decision.response, intent: decision.intent, status: 'pending_approval', at: this.now() };
      this.persist(this.state);
      return { status: 'pending_approval', id: key, response: decision.response };
    }
    const attempted = previous.filter(turn => Number.isFinite(turn.attemptedAt));
    if (attempted.filter(turn => this.now() - turn.attemptedAt < 3600000).length >= this.maxPerHour) return { status: 'rate_limited', reason: 'Product engagement hourly limit' };
    if (attempted.some(turn => participantKey(turn.item) === participant && this.now() - turn.attemptedAt < this.cooldownMs)) return { status: 'rate_limited', reason: 'Recipient cooldown' };
    // Re-read exact target before recording a send attempt. Never act on inbox snippets.
    const check = await this.adapter.verify(item);
    if (!check?.valid) return { status: 'stale', reason: check?.reason || 'Incoming message changed' };
    this.state.turns[key] = { item, response: decision.response, intent: decision.intent, status: 'sending', attemptedAt: this.now() };
    this.persist(this.state);
    let result;
    try { result = await this.adapter.send(item, decision.response); } catch (err) { result = { success: false, reason: err.message }; }
    const sent = result?.success && result.verified && !result.simulated && !result.dryRun;
    Object.assign(this.state.turns[key], { status: sent ? 'sent' : 'uncertain', result: result || null, completedAt: this.now() });
    this.persist(this.state);
    return { status: this.state.turns[key].status, id: key, reason: result?.reason };
  }
  async cycle(options = {}) {
    const { items, observations = [], errors = [] } = await this.adapter.scan(this.product, { activePlatform: options.activePlatform });
    const results = [];
    for (const item of items.slice(0, 10)) {
      try { results.push(await this.process(item, options)); } catch (err) { results.push({ status: 'error', reason: err.message }); }
    }
    let observation;
    try { observation = await this.observer?.observe(observations, { dryRun: options.dryRun !== false }); }
    catch (err) { errors.push({ kind: 'observation', reason: err.message }); }
    return { results, errors, ...(observation ? { observation } : {}) };
  }
}
module.exports = { ProductEngagement, turnKey };
