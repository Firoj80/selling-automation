const { validatePost } = require('./content-engine');
const { learningSettings } = require('./learning-config');
const { localDate, addDays, atLocal } = require('./content-calendar');
const timing = require('./interval-schedule');

function pendingPosts(state) {
  return state.posts.filter(p => p.status === 'pending').sort((a, b) => (a.scheduledAt ?? state.nextPostAt) - (b.scheduledAt ?? state.nextPostAt) || state.posts.indexOf(a) - state.posts.indexOf(b));
}
function syncQueue(state) {
  const next = pendingPosts(state)[0];
  const uncertain = state.posts.find(p => ['publishing', 'needs_review'].includes(p.status));
  state.cursor = uncertain ? state.posts.indexOf(uncertain) : next ? state.posts.indexOf(next) : state.posts.length; // Compatibility projection only.
  if (next && Number.isFinite(next.scheduledAt)) state.nextPostAt = next.scheduledAt;
  state.calendar = state.posts.filter(p => Number.isFinite(p.scheduledAt)).map(p => ({ id: p.id, platform: p.platform, scheduledAt: new Date(p.scheduledAt).toISOString() }));
}
function schedulePolicy(product, state, useDefaults = false) {
  return useDefaults || !state.learning ? learningSettings(product) : { minimum_gap_minutes: 30, ...state.learning.settings };
}
function editablePost(post) {
  if (!post || !['pending', 'held', 'missed', 'needs_edit', 'needs_media'].includes(post.status) || post.attemptedAt != null || post.result) throw new Error('Only unattempted pending, held, missed, needs-media or needs-edit drafts can be changed. Reconcile uncertain publications first.');
}
function history(post, action, now) {
  post.revisions ||= [];
  post.revisions.push({ action, at: now, text: post.text, type: post.type, writing: post.writing, scheduledAt: post.scheduledAt, status: post.status });
}
function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error('Use an ISO date/time with timezone, e.g. 2026-10-05T17:00:00+05:30');
  if (new Date(`${value.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) !== value.slice(0, 10)) throw new Error('Invalid calendar date');
  return Date.parse(value);
}
function reservations(state, excluded = new Set()) {
  return state.posts.filter(p => !excluded.has(p.id) && ['pending', 'publishing', 'needs_review', 'published'].includes(p.status)).map(p => ({ platform: p.platform, time: p.status === 'published' ? p.publishedAt : p.scheduledAt })).filter(p => Number.isFinite(p.time));
}
function available(time, platform, booked, settings) {
  const same = booked.filter(p => p.platform === platform);
  const date = localDate(time, settings.pilot_timezone);
  return !same.some(p => Math.abs(p.time - time) < (settings.minimum_gap_minutes ?? 30) * 60000) && same.filter(p => localDate(p.time, settings.pilot_timezone) === date).length < settings.pilot_local_times.length;
}
function allocate(post, after, endAt, booked, settings) {
  for (let day = 0; day < 370; day++) {
    const date = addDays(localDate(after, settings.pilot_timezone), day);
    for (const time of settings.pilot_local_times) {
      let slot; try { slot = atLocal(date, time, settings.pilot_timezone); } catch { continue; } // DST gap: next valid slot.
      if (slot <= after) continue;
      if (slot >= endAt) return null;
      if (available(slot, post.platform, booked, settings)) { booked.push({ platform: post.platform, time: slot }); return slot; }
    }
  }
  return null;
}
function initializeTimes(state, product) {
  for (const [i, post] of state.posts.entries()) {
    if (!Number.isFinite(post.scheduledAt)) {
      const calendar = state.calendar?.find(item => item.id === post.id);
      post.scheduledAt = calendar ? Date.parse(calendar.scheduledAt) : state.nextPostAt + Math.max(0, i - state.cursor) * product.strategy.post_frequency_hours * 3600000;
    }
  }
}
function changeQueue(state, product, operation, now = Date.now()) {
  const next = structuredClone(state), changes = [];
  if (!Array.isArray(next.posts) || new Set(next.posts.map(p => p.id)).size !== next.posts.length) throw new Error('Queue requires unique post IDs');
  initializeTimes(next, product);
  const settings = schedulePolicy(product, next, operation.kind === 'reschedule-all');
  const endAt = timing.campaignEnd(product, next);
  const post = next.posts.find(p => p.id === operation.id);
  const record = p => changes.push({ id: p.id, platform: p.platform, before: state.posts.find(old => old.id === p.id), after: structuredClone(p) });
  if (operation.kind === 'retry-media') {
    editablePost(post);
    if (!post.media?.required) throw new Error('This draft has no required image; existing text-only drafts are preserved');
    history(post, 'retry-media', now);
    post.media = { required: true, status: 'pending', attempts: 0, textHash: require('./content-media').textHash(post.text) };
    if (post.status === 'pending') post.status = 'needs_media';
    record(post);
  } else if (operation.kind === 'edit') {
    editablePost(post);
    const validated = validatePost({ ...post, text: operation.text }, product);
    history(post, 'edit', now);
    Object.assign(post, { text: validated.text, manuallyEdited: true, writing: { status: 'manual_edit' }, contentRevision: (post.contentRevision || 0) + 1, validation: { status: 'valid', at: now } });
    post.validation.rulesRevision = require('./writing-rules').rulesRevision(product);
    if (post.status === 'needs_edit') { post.status = post.editingResumeStatus || 'pending'; delete post.editingResumeStatus; }
    if (post.media?.required) {
      post.media = { required: true, status: 'pending', attempts: 0, textHash: require('./content-media').textHash(post.text) };
      if (post.status === 'pending') post.status = 'needs_media';
    }
    record(post);
  } else if (operation.kind === 'hold') {
    editablePost(post); history(post, 'hold', now); post.status = 'held'; post.holdReason = 'Held by user'; record(post);
  } else if (operation.kind === 'reschedule') {
    editablePost(post);
    validatePost(post, product);
    const time = timestamp(operation.at);
    if (time <= now || time >= endAt) throw new Error('Choose a future time before campaign end; extend the end date explicitly if needed.');
    if (timing.isInterval(product)) {
      const last = timing.lastPublished(next, post.platform);
      if (last !== null && time < last + timing.intervalMs(product)) throw new Error('Time conflicts with the platform posting interval');
    } else if (!available(time, post.platform, reservations(next, new Set([post.id])), settings)) throw new Error('Time conflicts with platform spacing or daily posting limit');
    history(post, 'reschedule', now);
    Object.assign(post, { scheduledAt: time, status: 'pending', scheduleRevision: (post.scheduleRevision || 0) + 1 });
    if (timing.isInterval(product)) post.notBefore = time;
    delete post.holdReason; record(post);
    delete post.editingResumeStatus;
  } else if (['catch-up', 'reschedule-all'].includes(operation.kind)) {
    let after = now;
    if (operation.kind === 'reschedule-all') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(operation.from || '')) throw new Error('Use --from YYYY-MM-DD');
      after = Math.max(now, atLocal(operation.from, '00:00', settings.pilot_timezone) - 1);
    }
    const targets = pendingPosts(next).filter(p => operation.kind === 'reschedule-all' || p.scheduledAt + (settings.slot_grace_minutes ?? 30) * 60000 <= now);
    const booked = reservations(next, new Set(targets.map(p => p.id)));
    for (const p of targets) {
      editablePost(p);
      const last = timing.isInterval(product) ? timing.lastPublished(next, p.platform) : null;
      const prior = booked.filter(b => b.platform === p.platform).map(b => b.time);
      const time = timing.isInterval(product) ? Math.max(after + 1, last === null ? after + 1 : last + timing.intervalMs(product), prior.length ? Math.max(...prior) + timing.intervalMs(product) : 0) : allocate(p, after, endAt, booked, settings);
      if (timing.isInterval(product)) booked.push({ platform: p.platform, time });
      history(p, operation.kind, now);
      if (time === null || time >= endAt) { p.status = 'held'; p.holdReason = 'No available slot before campaign end'; }
      else { p.scheduledAt = time; if (timing.isInterval(product) && operation.kind === 'reschedule-all') p.notBefore = time; p.scheduleRevision = (p.scheduleRevision || 0) + 1; }
      record(p);
    }
    if (operation.kind === 'reschedule-all' && next.learning) {
      for (const key of ['pilot_timezone', 'pilot_local_times', 'minimum_gap_minutes']) next.learning.settings[key] = settings[key];
    }
  } else if (operation.kind === 'update-links') {
    if (typeof operation.from !== 'string' || !/^https?:\/\//.test(operation.from) || !product.product.sales_url) throw new Error('Provide the old URL and configure the new sales URL first');
    for (const p of next.posts.filter(p => ['pending', 'held', 'missed', 'needs_media'].includes(p.status) && p.type === 'product')) {
      editablePost(p);
      const text = p.text.replace(/https?:\/\/[^\s]+/g, url => url === operation.from ? product.product.sales_url : url);
      if (text === p.text) continue;
      validatePost({ ...p, text }, product); history(p, 'update-links', now);
      p.text = text; p.contentRevision = (p.contentRevision || 0) + 1;
      if (p.media?.required) { p.media = { required: true, status: 'pending', attempts: 0, textHash: require('./content-media').textHash(text) }; if (p.status === 'pending') p.status = 'needs_media'; }
      record(p);
    }
  } else if (operation.kind === 'extend') {
    const end = timestamp(operation.until);
    if (!next.learning || end <= now || end <= endAt) throw new Error('Campaign extension must be later than the current end and now');
    next.learning.endAt = end;
    changes.push({ beforeEndAt: endAt, afterEndAt: end });
  } else if (operation.kind === 'clone-to-platforms') {
    const targetPlatforms = Array.isArray(operation.platforms) && operation.platforms.length ? operation.platforms : ['x', 'instagram'];
    const invalid = targetPlatforms.filter(p => !['x', 'instagram', 'threads', 'facebook'].includes(p));
    if (invalid.length) throw new Error(`Invalid target platforms: ${invalid.join(', ')}`);
    const pending = next.posts.filter(p => ['pending', 'needs_media'].includes(p.status));
    if (!pending.length) throw new Error('No pending posts available to clone');

    const existingIds = new Set(next.posts.map(p => p.id));
    const intervalMs = timing.isInterval(product) ? timing.intervalMs(product) : 3 * 3600000;

    for (const targetPlatform of targetPlatforms) {
      const sources = pending.filter(p => p.platform !== targetPlatform);
      let currentSched = Math.max(now, ...next.posts.filter(p => p.platform === targetPlatform).map(p => p.scheduledAt || 0));
      if (currentSched <= now) currentSched = now + intervalMs;

      for (let i = 0; i < sources.length; i++) {
        const src = sources[i];
        let newId = `${src.id}-${targetPlatform}`;
        let suffix = 1;
        while (existingIds.has(newId)) {
          newId = `${src.id}-${targetPlatform}-${suffix++}`;
        }
        existingIds.add(newId);

        let postText = src.text;
        if (targetPlatform === 'x' && postText.length > 280) {
          postText = require('./content-engine').condenseForX(postText);
        }

        const cloned = {
          ...structuredClone(src),
          id: newId,
          platform: targetPlatform,
          text: postText,
          scheduledAt: currentSched,
          status: 'pending',
          revisions: [{ action: 'clone-to-platforms', fromPlatform: src.platform, at: now }]
        };

        if (targetPlatform === 'instagram' || src.media?.required) {
          cloned.media = {
            required: true,
            status: src.media?.status === 'ready' && src.media?.path ? 'ready' : 'pending',
            attempts: 0,
            textHash: require('./content-media').textHash(postText),
            ...(src.media?.path ? { path: src.media.path, width: src.media.width, height: src.media.height, fileHash: src.media.fileHash } : {})
          };
          if (cloned.media.status !== 'ready') {
            cloned.status = 'needs_media';
          }
        }

        currentSched += intervalMs;
        next.posts.push(cloned);
        changes.push({ id: cloned.id, platform: cloned.platform, action: 'created', sourceId: src.id });
      }
    }
  } else throw new Error('Unsupported queue operation');
  syncQueue(next);
  return { state: next, changes };
}
module.exports = { pendingPosts, syncQueue, schedulePolicy, changeQueue, timestamp };
