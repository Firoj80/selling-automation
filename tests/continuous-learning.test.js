const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('node:test');
const { SwipeStore, DAY } = require('../src/knowledge/swipe-store');
const { ContentObserver } = require('../src/knowledge/content-observer');
const { LearningEngine, similar } = require('../src/knowledge/learning-engine');
const { learningSettings } = require('../src/content/learning-config');
const { pilotCalendar } = require('../src/content/content-calendar');
const { assignments, ContentPlanner } = require('../src/content/content-planner');
const { ContentEngine } = require('../src/content/content-engine');
const { ContentScheduler } = require('../src/content/content-scheduler');
const { ContentHumanizer } = require('../src/content/content-humanizer');
const { validatePost } = require('../src/content/content-engine');
const { withLock } = require('../src/content/content-store');
const product = require('./fixtures/product.json');
const NOW = Date.parse('2026-09-29T00:00:00Z');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'content-learning-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new SwipeStore({ root, fingerprint: 'test', now: () => NOW });
  return { root, store };
}
function item(n, changes = {}) {
  return { kind: 'reply', source: 'post', direction: 'incoming', platform: 'threads', username: `author${n}`, url: `https://www.threads.com/@author${n}/post/${n}`,
    text: `Audience research method ${n}: collect specific questions before deciding what to write next.`, observedAt: NOW, metrics: { likes: 100, comments: null, views: null, shares: null }, ...changes };
}
function seed(store) { for (let n = 1; n <= 8; n++) store.add(item(n), 0); }
function answer(store) { return { hooks: [{ pattern: 'Open with a concrete audience question, then offer a small action.', limitation: 'Account size and exposure are unknown.', evidenceIds: store.read().records.slice(0, 2).map(r => r.id) }], formats: [], painPoints: [] }; }

test('pilot has 20 posts per platform and preserves all configured local times', () => {
  const settings = learningSettings(product);
  assert.deepEqual(settings.pilot_local_times, ['10:30', '13:00', '17:00', '19:00']);
  const { slots } = pilotCalendar(settings, NOW, 2);
  const plan = assignments(product, slots.length);
  assert.equal(slots.length, 40);
  for (const platform of product.strategy.platforms) assert.equal(plan.filter(p => p.platform === platform).length, 20);
  assert.equal(new Set(slots).size, 20);
  assert.equal(new Date(slots[0]).toISOString(), '2026-09-30T05:00:00.000Z');
  const custom = learningSettings({ ...product, learning: { pilot_local_times: ['08:00', '11:00', '15:00', '22:00'] } });
  assert.equal(new Date(pilotCalendar(custom, NOW, 2).slots[0]).toISOString(), '2026-09-30T02:30:00.000Z');
});

test('generator completes 40 drafts and same-time platform slots are not delayed two hours', async () => {
  let n = 0;
  const engine = new ContentEngine({ ai: { callAi: async () => ({ posts: [{ type: 'value', platform: product.strategy.platforms[n % product.strategy.platforms.length], text: `Audience exercise ${++n}: ask a focused question.` }] }) } });
  const posts = await engine.generateContentQueue(product, '', 40);
  const state = { cursor: 0, nextPostAt: NOW, posts: posts.map(p => ({ ...p, scheduledAt: NOW })), learning: { endAt: NOW + DAY, settings: learningSettings(product) } };
  const scheduler = new ContentScheduler({ product, state, now: () => NOW, persist: () => {}, publish: async () => ({ success: true, verified: true }) });
  for (let i = 0; i < 2; i++) assert.equal((await scheduler.tick({ dryRun: false })).status, 'published');
  assert.equal(state.cursor, 2);
});

test('observer filters private, own, unknown metrics and unrelated content; preview performs no AI or write', async t => {
  const { store } = fixture(t);
  let calls = 0;
  const observer = new ContentObserver({ product, store, campaign: { posts: [] }, now: () => NOW,
    ai: { callAi: async prompt => { calls++; const input = JSON.parse(prompt.split('\n').at(-1)); return { relevant: !input.excerpt.includes('unrelated'), topicIndex: 0 }; } } });
  const items = [item(1, { kind: 'dm' }), item(2, { username: product.seller.username }), item(3, { metrics: { likes: null, comments: null } }), item(4, { text: 'unrelated' }), item(5)];
  await observer.observe(items, { dryRun: true });
  assert.equal(calls, 0);
  assert.equal(fs.existsSync(store.file), false);
  assert.equal((await observer.observe(items)).saved, 1);
  assert.equal(calls, 2);
  assert.equal((await observer.observe(items)).saved, 0);
  assert.equal(calls, 2);
});

test('store deduplicates URLs and normalized content, expires records and isolates products', t => {
  const { root, store } = fixture(t);
  assert.equal(store.add(item(1), 0), true);
  assert.equal(store.add(item(1), 0), false);
  assert.equal(store.add(item(2, { text: item(1).text.toUpperCase() }), 0), false);
  assert.equal(new SwipeStore({ root, fingerprint: 'test', now: () => NOW + 31 * DAY }).read().records.length, 0);
  assert.throws(() => new SwipeStore({ root, fingerprint: 'other' }).read(), /different product/);
  fs.writeFileSync(store.file, '{broken');
  assert.throws(() => store.read());
  assert.equal(fs.readFileSync(store.file, 'utf8'), '{broken');
});

test('synthesis requires diverse evidence, validates IDs, deduplicates revisions and retains valid snapshot after failure', async t => {
  const { root, store } = fixture(t);
  let calls = 0;
  const ai = { callAi: async () => { calls++; return answer(store); } };
  const learning = new LearningEngine({ root, store, ai, now: () => NOW });
  assert.equal((await learning.synthesize()).status, 'insufficient_evidence');
  assert.equal(calls, 0);
  seed(store);
  assert.equal((await learning.synthesize()).status, 'learned');
  const revision = learning.snapshot().revision;
  assert.ok(fs.readFileSync(learning.markdown, 'utf8').includes('https://www.threads.com/@author1/post/1'));
  assert.equal((await learning.synthesize()).status, 'unchanged');
  assert.equal(calls, 1);
  store.add(item(9), 0);
  ai.callAi = async () => ({ hooks: [{ ...answer(store).hooks[0], evidenceIds: ['fake', 'other'] }], formats: [], painPoints: [] });
  await assert.rejects(learning.synthesize(), /evidence/);
  assert.equal(learning.snapshot().revision, revision);
  assert.equal(similar('Audience research method 1: collect specific questions before deciding what to write next.', [item(1).text]), true);
});

test('pilot trigger waits for observation maturity and weekly trigger survives restart', async t => {
  const { root, store } = fixture(t);
  seed(store);
  const ai = { callAi: async () => answer(store) };
  const learning = new LearningEngine({ root, store, ai, now: () => NOW });
  const campaign = { learning: { settings: { observation_age_hours: 24 } }, posts: [{ batch: 0, status: 'pending', scheduledAt: NOW - DAY }] };
  assert.equal((await learning.maybeLearn(campaign)).status, 'pilot_running');
  Object.assign(campaign.posts[0], { status: 'published', publishedAt: NOW });
  assert.equal((await learning.maybeLearn(campaign)).status, 'observing');
  campaign.posts[0].publishedAt = NOW - DAY;
  assert.equal((await learning.maybeLearn(campaign)).status, 'learned');
  store.add(item(9), 0);
  const restarted = new LearningEngine({ root, store, ai, now: () => NOW + DAY });
  assert.equal((await restarted.maybeLearn(campaign)).status, 'waiting');
  const weekly = new LearningEngine({ root, store, ai, now: () => NOW + 7 * DAY });
  assert.equal((await weekly.maybeLearn(campaign)).status, 'learned');
});

test('adaptive planner creates 10 slots, applies patterns only to exploration, and commits after generation', async () => {
  const settings = learningSettings(product);
  const posts = assignments(product, 40).map((p, i) => ({ ...p, id: `old${i}`, type: 'value', text: `Original question ${i}`, batch: 0, status: 'published', scheduledAt: NOW - 2 * DAY, publishedAt: NOW - 2 * DAY }));
  const state = { cursor: 40, posts, calendar: [], learning: { settings, endAt: NOW + 20 * DAY, batch: 0, phase: 'pilot', reports: [] } };
  let received;
  const pattern = { pattern: 'Ask a practical question', limitation: 'Hypothesis', platforms: ['threads', 'facebook'], evidenceIds: ['a', 'b'] };
  const planner = new ContentPlanner({ product, state, now: () => NOW, persist: () => {}, learning: { explain: async () => ({}) },
    externalLearning: { snapshot: () => ({ revision: 'revision1', insights: { hooks: [pattern], formats: [] }, sources: [] }) },
    engine: { generateContentQueue: async (p, c, n, options) => { received = options; return options.plan.map((a, i) => ({ platform: a.platform, type: 'value', text: `New audience question ${i}` })); } } });
  assert.equal((await planner.replenish()).count, 10);
  assert.equal(received.plan.filter(p => p.learnedPattern).length, 2);
  assert.deepEqual(received.plan.filter(p => p.learnedPattern).map(p => p.platform), product.strategy.platforms);
  assert.equal(state.learning.phase, 'adaptive');
  assert.equal(state.posts.length, 50);
});

test('humanizer rejects added numbers and falls back to valid original', async () => {
  const original = { platform: 'threads', type: 'value', text: 'Ask your audience a specific question.' };
  const humanizer = new ContentHumanizer({ writing: { enabled: true, instructions: 'Edit naturally.', settings: { fallback_policy: 'validated_original' } }, ai: { callAi: async () => ({ text: 'Ask 500 people a question.', facts_preserved: true }) } });
  const result = await humanizer.edit(original, product, validatePost);
  assert.equal(result.text, original.text);
  assert.equal(result.writing.status, 'original_fallback');
});

test('manual synthesis shares the campaign lock and releases it on failure', async t => {
  const { root } = fixture(t);
  await assert.rejects(withLock(root, async () => withLock(root, async () => {})), /already locked/);
  assert.equal(fs.existsSync(path.join(root, 'private/product-content.lock')), false);
});

test('learn status and dry-run do not create files, acquire locks or initialize AI', async t => {
  const { root } = fixture(t);
  fs.writeFileSync(path.join(root, 'product.json'), JSON.stringify(product));
  const { run } = require('../src/content/content-cli');
  for (const flag of ['--status', '--dry-run']) {
    assert.equal((await run('learn', [flag], root)).status, 'insufficient_evidence');
    assert.deepEqual(fs.readdirSync(root), ['product.json']);
  }
  await assert.rejects(run('learn', ['--force'], root), /Supported/);
});

test('setup creates a full 40-post calendar without mutating custom times', async t => {
  const { root } = fixture(t);
  const configured = { ...product, learning: { pilot_local_times: ['07:00', '12:00', '16:00', '20:00'] } };
  fs.writeFileSync(path.join(root, 'product.json'), JSON.stringify({ ...configured, research: { enabled: false } }));
  const engine = { generateContentQueue: async (p, copy, n, options) => options.plan.map((a, i) => ({ ...a, id: `value-${i + 1}`, type: 'value', status: 'pending', text: `Useful question ${i}` })) };
  const state = await require('../src/agent/setup-engine').setup(root, { engine, now: NOW });
  assert.equal(state.posts.length, 40);
  assert.equal(state.calendar.length, 40);
  assert.deepEqual(state.learning.settings.pilot_local_times, configured.learning.pilot_local_times);
  assert.equal(state.posts.every(p => Number.isFinite(p.scheduledAt)), true);
  assert.equal(new Date(state.posts[0].scheduledAt).toISOString(), '2026-09-30T01:30:00.000Z');
});

test('copied source wording is rejected after Humanizer before a draft is accepted', async () => {
  let calls = 0;
  const source = 'Begin with the specific audience question that comes up most often.';
  const engine = new ContentEngine({ ai: { callAi: async () => ({ posts: [{ platform: 'threads', type: 'value', text: ++calls === 1 ? source : 'Ask someone what they wish they had known before starting.' }] }) } });
  const result = await engine.generateContentQueue(product, '', 1, { plan: [{ platform: 'threads', mode: 'explore' }], learned: { sources: [{ content: source }] } });
  assert.equal(calls, 2);
  assert.notEqual(result[0].text, source);
});

test('public observation failure does not turn a scan into a send or fail engagement', async () => {
  const { ProductEngagement } = require('../src/engagement/product-engagement');
  const runner = new ProductEngagement({ product, state: { version: 1, turns: {}, optOuts: {} },
    adapter: { scan: async () => ({ items: [], observations: [item(1)] }) }, observer: { observe: async () => { throw new Error('Corrupt swipe file'); } } });
  const result = await runner.cycle({ dryRun: false });
  assert.deepEqual(result.results, []);
  assert.equal(result.errors[0].kind, 'observation');
});

test('failed adaptive generation leaves the entire queue unchanged', async () => {
  const settings = learningSettings(product);
  const state = { cursor: 1, posts: [{ batch: 0, platform: 'threads', status: 'published', publishedAt: NOW - 2 * DAY }], calendar: [], learning: { settings, endAt: NOW + 5 * DAY, batch: 0, reports: [], phase: 'pilot' } };
  const before = JSON.stringify(state);
  const planner = new ContentPlanner({ product, state, now: () => NOW, persist: () => { throw new Error('Should not persist'); }, learning: { explain: async () => ({}) }, engine: { generateContentQueue: async () => { throw new Error('AI unavailable'); } } });
  await assert.rejects(planner.replenish(), /unavailable/);
  assert.equal(JSON.stringify(state), before);
});
