const fs = require('fs');
const path = require('path');
function inspect(root) {
  const lockFile = path.join(root, 'private/product-content.lock');
  let lock = { status: 'absent' };
  if (fs.existsSync(lockFile)) {
    try {
      const raw = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
      const pid = typeof raw === 'number' ? raw : raw.pid;
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid lock owner');
      try { process.kill(pid, 0); lock = { status: 'active', pid }; }
      catch (err) { lock = { status: err.code === 'ESRCH' ? 'stale' : 'unknown', pid }; }
    } catch { lock = { status: 'unknown' }; }
  }
  const file = path.join(root, 'private/product-content.json');
  const state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
  const posts = (state?.posts || []).filter(p => ['publishing', 'needs_review'].includes(p.status)).map(p => ({ id: p.id, platform: p.platform, status: p.status, attemptedAt: p.attemptedAt, postUrl: p.result?.postUrl, reason: p.result?.reason, action: 'Reconcile the platform result before any retry; no status changed.' }));
  return { status: posts.length || lock.status !== 'absent' ? 'review_required' : 'no_uncertain_posts', lock, posts, message: 'Inspection only. Drafts, publication attempts and locks were preserved.' };
}
function recoverStaleLock(root) {
  return require('./content-store').lockGuard(root, () => {
    const report = inspect(root);
    if (report.lock.status === 'absent') return { status: 'no_lock', message: 'No lock needed recovery.' };
    if (report.lock.status !== 'stale') throw new Error('Lock owner is active or cannot be verified. The lock was preserved.');
    const file = path.join(root, 'private/product-content.lock');
    const archived = `${file}.stale-${Date.now()}-${require('crypto').randomUUID()}`;
    fs.renameSync(file, archived);
    return { status: 'stale_lock_archived', archived, message: 'Stopped owner verified. Publication statuses and attempts were preserved.' };
  });
}
function reconcile(root, { id, action = 'requeue', postUrl = null }) {
  return require('./content-store').lockGuard(root, () => {
    const file = path.join(root, 'private/product-content.json');
    if (!fs.existsSync(file)) throw new Error('State file does not exist');
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    const post = (state.posts || []).find(p => p.id === id);
    if (!post) throw new Error(`Post ${id} not found`);
    if (!['publishing', 'needs_review'].includes(post.status)) {
      throw new Error(`Post ${id} has status ${post.status}; only publishing or needs_review posts can be reconciled.`);
    }

    post.revisions ||= [];
    post.revisions.push({
      action: `reconcile_${action}`,
      at: Date.now(),
      previousStatus: post.status,
      reason: post.result?.reason || null
    });

    if (action === 'published') {
      if (!postUrl) throw new Error('A published postUrl is required when reconciling as published');
      post.status = 'published';
      post.publishedAt = Date.now();
      post.result = { ...(post.result || {}), success: true, verified: true, postUrl };
    } else if (action === 'discard') {
      post.status = 'held';
      post.holdReason = 'Reconciled as discarded';
    } else {
      post.status = 'pending';
      delete post.attemptedAt;
      delete post.result;
    }

    require('./content-queue').syncQueue(state);
    require('./content-store').save(file, state);
    return {
      status: 'reconciled',
      id: post.id,
      postStatus: post.status,
      action,
      message: `Post ${post.id} successfully reconciled as ${post.status}.`
    };
  });
}
function autoRecover(root) {
  let stale = { status: 'no_lock' };
  try {
    stale = recoverStaleLock(root);
  } catch (err) {
    stale = { status: 'skipped', reason: err.message };
  }
  const report = inspect(root);
  const reconciled = [];
  for (const post of report.posts) {
    try {
      reconciled.push(reconcile(root, { id: post.id, action: 'requeue' }));
    } catch (err) {
      reconciled.push({ id: post.id, status: 'error', reason: err.message });
    }
  }
  return { status: 'auto_recovered', staleLock: stale, reconciled };
}
module.exports = { inspect, recoverStaleLock, reconcile, autoRecover };
