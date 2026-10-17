const fs = require('fs');
const path = require('path');
const { withLock, save } = require('./content-store');
const { canonicalPostUrl } = require('./post-metrics');
const uncertain = post => ['publishing', 'needs_review'].includes(post.status);
async function autoRecover(root, { verify = require('./verify-saved-publication').verifySavedPublication, now = () => Date.now() } = {}) {
  const recovery = require('./content-recovery');
  const before = recovery.inspect(root);
  if (!['absent', 'stale'].includes(before.lock.status)) throw new Error('Recovery cannot run while automation is active or lock ownership is unknown');
  const staleLock = before.lock.status === 'stale' ? recovery.recoverStaleLock(root) : { status: 'no_lock' };
  return withLock(root, async () => {
    const file = path.join(root, 'private/product-content.json');
    if (!fs.existsSync(file)) return { status: 'no_campaign', staleLock, reconciled: [], heldPlatforms: [] };
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    const { product } = require('./product-config').loadProduct(root);
    const pending = state.posts.filter(uncertain);
    if (!pending.length) return { status: 'ready', staleLock, reconciled: [], heldPlatforms: [] };
    save(path.join(root, 'private/config-backups', `auto-recovery-${now()}-${require('crypto').randomUUID()}.json`), state);
    const reconciled = [], holds = {};
    for (const post of pending) {
      const preparing = post.submission?.version === 1 && post.submission.state === 'preparing' && post.result?.submitted !== true;
      const beforeClick = post.result?.submitted === false && post.submission?.state !== 'may_have_submitted';
      const original = { status: post.status, result: post.result, submission: post.submission, attemptedAt: post.attemptedAt };
      let evidence, reason;
      if (!preparing && !beforeClick) {
        try { evidence = await verify({ post, product }); }
        catch (err) { reason = err.message; }
        const observedUrl = canonicalPostUrl(evidence?.postUrl, post.platform);
        if (observedUrl && state.posts.some(other => other.id !== post.id && other.status === 'published' && canonicalPostUrl(other.result?.postUrl, post.platform) === observedUrl)) {
          evidence = null; reason = 'Matching permalink is already recorded for another post; this attempt remains uncertain';
        }
      }
      if (preparing || beforeClick) {
        post.status = 'pending'; delete post.result; delete post.submission; delete post.attemptedAt;
        post.revisions ||= []; post.revisions.push({ action: 'auto_requeue_before_submission', at: now(), previous: original });
        reconciled.push({ id: post.id, platform: post.platform, action: 'requeued', reason: 'No submit action was attempted' });
      } else if (evidence?.verified && canonicalPostUrl(evidence.postUrl, post.platform) && evidence.verifiedMediaCount >= 1) {
        post.status = 'published'; post.publishedAt = evidence.publishedAt || now();
        post.result = { ...post.result, ...evidence, success: true, verified: true };
        post.submission = { version: 1, state: 'confirmed', at: now() };
        post.revisions ||= []; post.revisions.push({ action: 'auto_confirm_published', at: now(), previous: original });
        reconciled.push({ id: post.id, platform: post.platform, action: 'confirmed_published', postUrl: evidence.postUrl });
      } else {
        post.status = 'needs_review';
        const hold = holds[post.platform] ||= { postIds: [], reason: reason || 'Publication could not be verified; this platform is paused to avoid duplicate sends', checkedAt: now() };
        hold.postIds.push(post.id);
        reconciled.push({ id: post.id, platform: post.platform, action: 'platform_paused', reason: hold.reason });
      }
    }
    state.recovery = { ...state.recovery, platformHolds: holds, lastRunAt: now() };
    if (require('./interval-schedule').isInterval(product)) require('./interval-schedule').projectQueue(state, product, now());
    require('./content-queue').syncQueue(state, product);
    save(file, state);
    return { status: Object.keys(holds).length ? 'ready_with_paused_platforms' : 'ready', staleLock, reconciled, heldPlatforms: Object.keys(holds) };
  });
}
module.exports = { autoRecover };
