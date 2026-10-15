const { randomUUID } = require('crypto');
const { validMedia, textHash } = require('./content-media');
const { mediaSettings } = require('./media-settings');
// The worker mutates an isolated draft. Only poll(), at the runtime boundary,
// applies its result to the coordinator's queue under the campaign lock.
class BackgroundMedia {
  constructor(media) { this.media = media; this.root = media.root; }
  async prepare(post, product, persist) {
    if (this.active || !post.media?.required || validMedia(post, this.root) || post.media.status === 'text_only') return;
    if (post.media.textHash !== textHash(post.text)) post.media = { required: true, attempts: 0, status: 'pending', textHash: textHash(post.text) };
    if ((post.media.attempts || 0) >= mediaSettings(product).max_attempts || Date.now() < (post.media.nextAttemptAt || 0)) return;
    const snapshot = structuredClone(post), token = randomUUID();
    post.media = { ...post.media, status: 'preparing', workerToken: token, attempts: (post.media.attempts || 0) + 1 };
    if (post.status === 'pending') post.status = 'needs_media';
    await persist();
    const active = { id: post.id, token, text: post.text, snapshot, done: false };
    this.active = active;
    active.promise = this.media.prepare(snapshot, structuredClone(product), () => {}).catch(err => { snapshot.media.status = 'failed'; snapshot.media.error = err.message; }).finally(() => { active.done = true; });
  }
  poll(state, persist) {
    const active = this.active;
    if (!active?.done) return;
    const post = state.posts.find(p => p.id === active.id);
    if (post?.text === active.text && post.media?.workerToken === active.token && !['published', 'publishing', 'needs_review'].includes(post.status)) {
      post.media = active.snapshot.media;
      if (post.status === 'needs_media' && active.snapshot.status === 'pending') post.status = 'pending';
      persist();
    }
    this.active = null;
  }
  async drain(state, persist) { if (this.active) await this.active.promise; this.poll(state, persist); }
}
module.exports = { BackgroundMedia };
