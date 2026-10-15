const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { validateProduct } = require('../src/content/product-config');
const { learningSettings } = require('../src/content/learning-config');
const { pilotAssignments, ContentPlanner } = require('../src/content/content-planner');
const { pilotCalendar, localDate } = require('../src/content/content-calendar');
const { changeQueue, pendingPosts } = require('../src/content/content-queue');
const { ContentScheduler } = require('../src/content/content-scheduler');
const { ContentTracker } = require('../src/content/content-tracker');
const { save, withLock } = require('../src/content/content-store');
const { submitQueue, processQueueRequests, queueCommand } = require('../src/content/queue-management');
const { ensureIdentity } = require('../src/content/config-management');
const NOW = Date.parse('2026-10-03T08:00:00Z'), DAY = 86400000;
function product(extra = {}) { return validateProduct({ ...structuredClone(require('./fixtures/product.json')), schedule: { timezone: 'UTC', local_times: ['10:00', '13:00', '17:00', '19:00'] }, ...extra }); }
function draft(id, platform, time = NOW + 2 * 3600000) { return { id, platform, text: `Ask your audience about task ${id}.`, type: 'value', status: 'pending', scheduledAt: time, batch: 0, experimentId: 'pilot' }; }
function state(posts, p = product()) { return { posts, cursor: 0, nextPostAt: posts[0]?.scheduledAt ?? NOW, calendar: [], learning: { batch: 0, phase: 'pilot', settings: learningSettings(p), endAt: NOW + 30 * DAY, reports: [] } }; }
function published(id, platform, views = 10000) {
  const p = draft(id, platform);
  const url = platform === 'threads' ? `https://www.threads.com/@seller/post/${id}` : `https://www.facebook.com/seller/posts/${id}`;
  return { ...p, status: 'published', publishedAt: NOW - 2 * DAY, result: { verified: true, postUrl: url }, metrics: { source: 'browser', postUrl: url, views }, observations: [{ source: 'browser', postUrl: url, views, observedAt: NOW - DAY }] };
}

test('unequal pilot counts produce exact quantities with a partial last day', () => {
  const p = product({ pilot: { posts_per_platform: { threads: 21, facebook: 7 } } });
  const settings = learningSettings(p), plan = pilotAssignments(p, settings);
  assert.equal(settings.pilot_posts, 28); assert.equal(settings.pilot_days, 6);
  assert.deepEqual(Object.fromEntries(p.strategy.platforms.map(platform => [platform, plan.filter(a => a.platform === platform).length])), { threads: 21, facebook: 7 });
  const calendar = pilotCalendar(settings, NOW, 3, plan);
  assert.equal(calendar.slots.length, 28);
  assert.equal(pilotCalendar(settings, NOW).slots.length, 28);
  assert.equal(localDate(calendar.slots.at(-1), 'UTC'), '2026-10-09');
  for (let i = 1; i < calendar.slots.length; i++) assert.ok(calendar.slots[i] >= calendar.slots[i - 1]);
});

test('pilot size is independent of selling minimum and invalid schedule settings fail', () => {
  const p = product({ pilot: { posts_per_platform: { threads: 30 } }, selling: { platforms: { threads: { minimum_value_posts: 25, minimum_views: 30000 } } } });
  assert.equal(learningSettings(p).pilot_counts.threads, 30);
  assert.equal(require('../src/content/campaign-settings').sellingSettings(p, 'threads').minimum_value_posts, 25);
  for (const extra of [{ selling: null }, { selling: { defaults: null } }, { pilot: null }, { schedule: null }, { pilot: { posts_per_platform: { threads: 0 } } }, { selling: { platforms: { threads: { minimum_views: -1 } } } }, { schedule: { local_times: ['10:00', '10:10'], minimum_gap_minutes: 30 } }]) assert.throws(() => product(extra));
});

test('rescheduling preserves text and uses actual time/platform instead of cursor position', async () => {
  const p = product(), s = state([draft('1', 'threads'), draft('2', 'threads', NOW + 5 * 3600000)], p);
  const updated = changeQueue(s, p, { kind: 'reschedule', id: '2', at: '2026-10-03T09:00:00Z' }, NOW).state;
  assert.equal(updated.posts[1].text, s.posts[1].text);
  assert.equal(updated.cursor, 1);
  const sent = [];
  const scheduler = new ContentScheduler({ product: p, state: updated, now: () => NOW + 3600000, persist: () => {}, publish: async post => { sent.push(post.id); return { success: true, verified: true }; } });
  await scheduler.tick({ dryRun: false });
  assert.deepEqual(sent, ['2']); assert.equal(updated.cursor, 0);
  assert.equal(updated.calendar.find(a => a.id === '2').scheduledAt, '2026-10-03T09:00:00.000Z');
});

test('editing keeps revision history and manually authored value text cannot become a pitch', async () => {
  const p = product(), original = state([draft('1', 'threads', NOW)], p);
  const updated = changeQueue(original, p, { kind: 'edit', id: '1', text: 'Ask one clear question today.' }, NOW).state;
  assert.equal(updated.posts[0].revisions[0].text, original.posts[0].text);
  const scheduler = new ContentScheduler({ product: p, state: updated, persist: () => {}, now: () => NOW,
    tracker: { refresh: async () => {}, shouldPublishProductForPlatform: () => true }, engine: { generateProductPost: () => assert.fail('Must preserve manual edit') },
    publish: async post => { assert.equal(post.text, 'Ask one clear question today.'); return { success: true, verified: true }; } });
  await scheduler.tick({ dryRun: false });
});

test('published and uncertain posts cannot be edited, moved or caught up', () => {
  const p = product();
  for (const status of ['published', 'publishing', 'needs_review']) {
    const s = state([{ ...draft('1', 'threads'), status, attemptedAt: NOW - 1 }], p);
    for (const operation of [{ kind: 'edit', id: '1', text: 'A changed draft.' }, { kind: 'reschedule', id: '1', at: '2026-10-04T10:00:00Z' }]) assert.throws(() => changeQueue(s, p, operation, NOW), /unattempted/);
    assert.deepEqual(changeQueue(s, p, { kind: 'catch-up' }, NOW).changes, []);
  }
});

test('catch-up preserves future reservations, includes one missed post and is restart-idempotent', () => {
  const p = product(), s = state([draft('old', 'threads', NOW - DAY), draft('future', 'threads', NOW + 2 * 3600000)], p);
  const result = changeQueue(s, p, { kind: 'catch-up' }, NOW);
  assert.equal(result.changes.length, 1);
  assert.equal(result.state.posts[0].scheduledAt, Date.parse('2026-10-03T13:00:00Z'));
  assert.equal(result.state.posts[1].scheduledAt, s.posts[1].scheduledAt);
  assert.deepEqual(pendingPosts(result.state).map(p => p.id), ['future', 'old']);
  assert.equal(result.state.posts[0].text, s.posts[0].text);
  assert.deepEqual(changeQueue(result.state, p, { kind: 'catch-up' }, NOW).changes, []);
});

test('catch-up respects daily limits and holds drafts that do not fit before campaign end', () => {
  const p = product(), s = state(Array.from({ length: 6 }, (_, i) => draft(String(i), 'threads', NOW - DAY)), p);
  s.learning.endAt = Date.parse('2026-10-03T20:00:00Z');
  const result = changeQueue(s, p, { kind: 'catch-up' }, NOW);
  assert.equal(result.state.posts.filter(p => p.status === 'pending').length, 4);
  assert.equal(result.state.posts.filter(p => p.status === 'held').length, 2);
  assert.ok(result.state.posts.every((p, i) => p.text === s.posts[i].text));
});

test('bulk schedule and explicit extension retain all generated drafts', () => {
  const p = product(), s = state([draft('1', 'threads'), draft('2', 'threads'), draft('3', 'facebook')], p);
  const before = JSON.stringify(s);
  const proposed = changeQueue(s, p, { kind: 'reschedule-all', from: '2026-10-05' }, NOW);
  assert.equal(JSON.stringify(s), before);
  assert.equal(proposed.state.posts[0].scheduledAt, Date.parse('2026-10-05T10:00:00Z'));
  assert.equal(proposed.state.posts[1].scheduledAt, Date.parse('2026-10-05T13:00:00Z'));
  assert.deepEqual(proposed.state.posts.map(p => p.text), s.posts.map(p => p.text));
  assert.equal(changeQueue(s, p, { kind: 'extend', until: '2026-12-01T00:00:00Z' }, NOW).state.learning.endAt, Date.parse('2026-12-01T00:00:00Z'));
});

test('single-post rescheduling rejects collisions, naive timestamps and campaign overflow', () => {
  const p = product(), s = state([draft('1', 'threads'), draft('2', 'threads', NOW + 5 * 3600000)], p);
  for (const at of ['2026-10-03T10:10:00Z', '2026-10-03T11:00:00', '2026-12-01T00:00:00Z', '2027-02-30T10:00:00Z']) assert.throws(() => changeQueue(s, p, { kind: 'reschedule', id: '2', at }, NOW));
});

test('Threads eligibility cannot unlock Facebook and each platform has its own pitch spacing', async () => {
  const p = product({ selling: { defaults: { minimum_value_posts: 2, minimum_views: 20000 }, platforms: { threads: { one_product_post_every: 3 } } } });
  const s = { posts: [published('1', 'threads'), published('2', 'threads'), draft('3', 'facebook', NOW)], cursor: 2, nextPostAt: NOW };
  const tracker = new ContentTracker({ product: p, state: s, now: () => NOW }); tracker.refresh = async () => {};
  assert.equal(tracker.shouldPublishProductForPlatform('threads'), true);
  assert.equal(tracker.shouldPublishProductForPlatform('facebook'), false);
  const scheduler = new ContentScheduler({ product: p, state: s, tracker, now: () => NOW, persist: () => {}, engine: { generateProductPost: () => assert.fail('Facebook is not eligible') }, publish: async post => { assert.equal(post.type, 'value'); return { success: true, verified: true }; } });
  assert.equal((await scheduler.tick()).plannedType, 'value');
  await scheduler.tick({ dryRun: false });
  const pitch = published('4', 'facebook', 0); pitch.type = 'product'; s.posts.push(pitch);
  assert.equal(tracker.shouldPublishProductForPlatform('facebook'), false);
  s.posts.push(published('5', 'facebook'), published('6', 'facebook'));
  assert.equal(tracker.shouldPublishProductForPlatform('facebook'), false);
  assert.equal(tracker.shouldPublishProductForPlatform('threads'), true);
});

test('pilot selling gate requires that platforms own published pilot and mature observations', () => {
  const p = product({ pilot: { posts_per_platform: { threads: 2, facebook: 2 } }, selling: { defaults: { minimum_value_posts: 2, minimum_views: 1 } }, learning: { minimum_mature_posts_per_platform: 2 } });
  const s = state([published('1', 'threads'), published('2', 'threads'), draft('3', 'facebook')], p);
  const tracker = new ContentTracker({ product: p, state: s, now: () => NOW });
  assert.equal(tracker.shouldStartSellingOnPlatform('threads'), true);
  assert.equal(tracker.shouldStartSellingOnPlatform('facebook'), false);
  s.posts[0].observations = [];
  assert.equal(tracker.shouldStartSellingOnPlatform('threads'), false);
});

test('raised criteria hold a manually edited pitch without losing its text', async () => {
  const p = product(), post = { ...draft('1', 'threads', NOW), type: 'product', text: `${p.product.name}: ${p.product.sales_url}`, manuallyEdited: true };
  const s = { posts: [post], cursor: 0, nextPostAt: NOW };
  const tracker = new ContentTracker({ product: p, state: s }); tracker.refresh = async () => {};
  const scheduler = new ContentScheduler({ product: p, state: s, tracker, now: () => NOW, persist: () => {}, publish: () => assert.fail('Ineligible') });
  assert.equal((await scheduler.tick()).plannedType, 'held');
  assert.equal((await scheduler.tick({ dryRun: false })).status, 'held');
  assert.equal(s.posts[0].text, post.text);
});

test('URL replacement touches exact pending product links and preserves published text', () => {
  const p = product(), old = p.product.sales_url;
  const a = { ...draft('1', 'threads'), type: 'product', text: `${p.product.name}: ${old}` };
  const b = { ...a, id: '2', status: 'published', attemptedAt: 1 };
  p.product.sales_url = 'https://example.com/new';
  const s = state([a, b], p), result = changeQueue(s, p, { kind: 'update-links', from: old }, NOW);
  assert.equal(result.changes.length, 1);
  assert.ok(result.state.posts[0].text.endsWith(p.product.sales_url));
  assert.equal(result.state.posts[1].text, b.text);
});

test('planner does not replenish when cursor is exhausted but rescheduled drafts remain', () => {
  const p = product(), s = state([draft('1', 'threads')], p); s.cursor = 1;
  assert.equal(new ContentPlanner({ product: p, state: s, now: () => NOW }).readiness().status, 'pending_posts');
});

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meta-queue-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  save(path.join(root, 'product.json'), product()); ensureIdentity(root);
  const s = state([draft('1', 'threads', Date.now() + DAY)]);
  save(path.join(root, 'private/product-content.json'), s);
  return { root, s };
}
test('management queues changes while running and updates the shared state only when consumed', async t => {
  const { root, s } = workspace(t);
  await withLock(root, async () => {
    const request = await submitQueue(root, { kind: 'edit', id: '1', text: 'Ask a useful question.' });
    assert.equal(request.status, 'pending'); assert.notEqual(s.posts[0].text, 'Ask a useful question.');
    assert.equal(processQueueRequests(root, s)[0].status, 'applied');
    assert.equal(s.posts[0].text, 'Ask a useful question.');
    assert.equal(processQueueRequests(root, s).length, 0);
  });
});
test('concurrent publication invalidates a stale edit request', async t => {
  const { root, s } = workspace(t);
  await withLock(root, async () => {
    await submitQueue(root, { kind: 'edit', id: '1', text: 'Ask a useful question.' });
    s.posts[0].status = 'publishing'; s.posts[0].attemptedAt = Date.now();
    save(path.join(root, 'private/product-content.json'), s);
    assert.equal(processQueueRequests(root, s)[0].status, 'rejected');
    assert.equal(s.posts[0].status, 'publishing');
  });
});
test('preview writes nothing and invalid CLI flags cannot mutate the queue', async t => {
  const { root } = workspace(t), file = path.join(root, 'private/product-content.json');
  const before = fs.readFileSync(file, 'utf8');
  const date = new Date(Date.now() + 3 * DAY).toISOString().slice(0, 10);
  assert.equal((await queueCommand(root, ['reschedule', '--pending', '--from', date, '--preview'])).status, 'preview');
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(fs.existsSync(path.join(root, 'private/management')), false);
  await assert.rejects(queueCommand(root, ['catch-up', '--oops']), /Supported/);
});

test('self-reply exclusion uses the handle for the incoming platform', async () => {
  const p = product(); p.seller.usernames = { threads: 'thread_user', facebook: 'fb_user' };
  const { ProductEngagement } = require('../src/engagement/product-engagement');
  const runner = new ProductEngagement({ product: p, state: { version: 1, turns: {}, optOuts: {} }, engine: { generate: () => assert.fail('Own message') } });
  const result = await runner.process({ kind: 'reply', platform: 'facebook', text: 'Own question', username: '@fb_user', id: '1', conversationId: '1', direction: 'incoming' });
  assert.equal(result.reason, 'Own message');
});

test('an applied queue request survives interruption before acknowledgement without replaying the edit', async t => {
  const { root, s } = workspace(t);
  const result = await submitQueue(root, { kind: 'edit', id: '1', text: 'A clear audience question.' });
  assert.equal(result.status, 'applied');
  const file = path.join(root, 'private/management', `${result.id}.json`);
  save(file, { ...result, status: 'pending' });
  assert.equal(processQueueRequests(root, s)[0].status, 'applied');
  assert.equal(s.posts[0].revisions.length, 1);
  assert.equal(s.posts[0].text, 'A clear audience question.');
});

test('setup uses uneven pilot assignments and resuming with new schedule retains accepted drafts', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meta-pilot-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const p = product({ research: { enabled: false }, pilot: { posts_per_platform: { threads: 3, facebook: 2 } }, writing: { humanizer_enabled: false } });
  save(path.join(root, 'product.json'), p);
  const { setup } = require('../src/agent/setup-engine');
  await assert.rejects(setup(root, { now: NOW, engine: { generateContentQueue: async (p, copy, count, options) => {
    assert.equal(count, 5);
    await options.onAccepted([{ ...draft('saved', options.plan[0].platform), text: 'Keep this accepted draft.' }]);
    throw new Error('Interrupted');
  } } }), /Interrupted/);
  const { loadProduct } = require('../src/content/product-config');
  const updated = loadProduct(root).product;
  updated.schedule.local_times = ['11:00', '15:00'];
  save(path.join(root, 'product.json'), updated);
  const campaign = await setup(root, { now: NOW, engine: { generateContentQueue: async (p, copy, count, options) => {
    assert.equal(options.initialPosts[0].text, 'Keep this accepted draft.');
    return options.plan.map((a, i) => i ? draft(`new-${i}`, a.platform) : options.initialPosts[0]);
  } } });
  assert.equal(campaign.posts.length, 5);
  assert.deepEqual(Object.fromEntries(['threads', 'facebook'].map(p => [p, campaign.posts.filter(post => post.platform === p).length])), { threads: 3, facebook: 2 });
  assert.equal(new Date(campaign.posts[0].scheduledAt).getUTCHours(), 11);
});

test('an uncertain submission remains blocked after rescheduling another draft and restarting', async () => {
  const p = product(), s = state([draft('1', 'threads', NOW), draft('2', 'threads', NOW + DAY)], p);
  const scheduler = new ContentScheduler({ product: p, state: s, persist: () => {}, now: () => NOW, publish: async () => ({ success: false, reason: 'Verification timed out' }) });
  await assert.rejects(scheduler.tick({ dryRun: false }), /review/);
  const moved = changeQueue(s, p, { kind: 'reschedule', id: '2', at: '2026-10-04T10:00:00Z' }, NOW).state;
  const restarted = new ContentScheduler({ product: p, state: JSON.parse(JSON.stringify(moved)), persist: () => {}, now: () => NOW + DAY, publish: () => assert.fail('Uncertain submission cannot retry') });
  await assert.rejects(restarted.tick({ dryRun: false }), /reconcile/);
  assert.equal(moved.posts[0].attemptedAt, NOW);
});
