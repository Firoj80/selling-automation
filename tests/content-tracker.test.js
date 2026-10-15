const assert = require('node:assert/strict');
const { test } = require('node:test');
const { ContentTracker } = require('../src/content/content-tracker');
const { ContentScheduler } = require('../src/content/content-scheduler');
const { ContentEngine, validatePost } = require('../src/content/content-engine');
const { canonicalPostUrl, parseCount, parseMetrics, selectSnapshot, BrowserMetricsReader } = require('../src/content/post-metrics');
const { validateProduct } = require('../src/content/product-config');
const product = validateProduct({ ...require('./fixtures/product.json'), strategy: { platforms: ['threads'], value_posts_before_selling: 2, view_threshold_to_sell: 20000, product_mention_ratio: '1 in 5 posts' } });
function published(id, views = 10000, type = 'value') {
  const postUrl = `https://www.threads.com/@seller/post/${id}`;
  return { id: String(id), platform: 'threads', type, text: `Useful audience advice ${id}`, status: 'published', result: { success: true, verified: true, postUrl },
    metrics: { source: 'browser', postUrl, views, likes: 1, comments: 2, shares: null, observedAt: 1 } };
}
function tracker(posts, options = {}) { return new ContentTracker({ product, state: { posts }, ...options }); }

test('parses exact and abbreviated counts without guessing ambiguous locales', () => {
  for (const [input, expected] of [['20,000', 20000], ['1.2K', 1200], ['3M', 3000000], ['0', 0], ['1,2K', null], ['-2', null], ['1.234', null], ['many', null]]) assert.equal(parseCount(input), expected);
  assert.deepEqual(parseMetrics(['20K views', 'Likes: 12', '3 replies', '2 reposts']), { views: 20000, likes: 12, comments: 3, shares: 2 });
  assert.equal(parseMetrics(['Get 20K views', 'views', '20000', '2 mil visualizaciones']).views, null);
  assert.equal(parseMetrics(['20 views', '30 views']).views, null);
});
test('canonicalizes supported permalinks and rejects unrelated URLs', () => {
  assert.equal(canonicalPostUrl('https://www.threads.com/@seller/post/123?tracking=1', 'threads'), 'https://www.threads.com/@seller/post/123');
  assert.equal(canonicalPostUrl('https://threads.net/@seller/post/abc?x=1', 'threads'), 'https://www.threads.com/@seller/post/abc');
  assert.equal(canonicalPostUrl('https://m.facebook.com/story.php?id=123&story_fbid=456', 'facebook'), 'https://www.facebook.com/permalink.php?story_fbid=456&id=123');
  for (const url of ['http://threads.com/@seller/post/1', 'https://threads.com.evil.test/@seller/post/1', 'https://threads.com/home', 'https://threads.com:9000/@seller/post/1', 'https://a@threads.com/@seller/post/1']) assert.equal(canonicalPostUrl(url, 'threads'), null);
});
test('matches both post text and permalink, excluding replies and other posts', () => {
  const p = published(1);
  const snapshots = [
    { text: p.text, links: ['https://www.threads.com/@other/post/2'], labels: ['1M views'] },
    { text: 'Reply to a post', links: [p.result.postUrl], labels: ['100K views'] },
    { text: p.text, links: [p.result.postUrl], labels: ['10 views'] }
  ];
  assert.deepEqual(selectSnapshot(snapshots, p, p.result.postUrl).labels, ['10 views']);
});
test('requires both thresholds at the boundary', () => {
  assert.equal(tracker([published(1, 50000)]).shouldStartSelling(), false);
  assert.equal(tracker([published(1, 10000), published(2, 9999)]).shouldStartSelling(), false);
  assert.equal(tracker([published(1), published(2)]).shouldStartSelling(), true);
});
test('unknown, simulated, unverified and duplicate posts do not inflate views', () => {
  const a = published(1);
  const b = published(2); b.result.simulated = true;
  const c = published(3); c.result.verified = false;
  const d = published(4); d.status = 'needs_review';
  const e = published(5); e.metrics.source = 'guess';
  const f = published(6); f.metrics.postUrl = a.result.postUrl;
  const g = published(7); g.metrics.views = null;
  const t = tracker([a, structuredClone(a), b, c, d, e, f, g]);
  assert.equal(t.getTotalViews(), 10000);
  assert.equal(t.shouldStartSelling(), false);
});
test('repeated refresh replaces counts, persists, throttles and retains known values on failure', async () => {
  const p = published(1);
  let calls = 0, saves = 0, now = 100;
  const t = tracker([p], { now: () => now, persist: () => saves++, reader: { read: async () => { calls++; return { source: 'browser', postUrl: p.result.postUrl, views: 12000 }; } } });
  await t.refresh(); await t.refresh();
  assert.equal(calls, 1);
  assert.equal(t.getTotalViews(), 12000);
  await t.refresh({ force: true });
  assert.equal(t.getTotalViews(), 12000);
  assert.equal(saves, 2);
  now += 900000;
  t.reader.read = async () => { throw new Error('Login required'); };
  await t.refresh();
  assert.equal(t.getTotalViews(), 12000);
  assert.equal(p.metricsError, 'Login required');
  t.reader.read = async () => ({ source: 'browser', postUrl: p.result.postUrl, views: null });
  await t.refresh({ force: true });
  assert.equal(t.getTotalViews(), 12000);
});
test('invalid or misattributed metric results cannot replace trusted counts', async () => {
  const p = published(1);
  for (const result of [{ source: 'browser', postUrl: p.result.postUrl, views: -1 }, { source: 'browser', postUrl: 'https://www.threads.com/@seller/post/99', views: 100000 }, { source: 'ai', postUrl: p.result.postUrl, views: 100000 }]) {
    const t = tracker([p], { reader: { read: async () => result } });
    await t.refresh({ force: true });
    assert.equal(t.getTotalViews(), 10000);
    assert.ok(p.metricsError);
  }
});
test('ratio survives restart and requires four value posts after each product post', () => {
  const posts = [published(1), published(2), published(3, 0, 'product')];
  for (let i = 0; i < 4; i++) {
    assert.equal(tracker(JSON.parse(JSON.stringify(posts))).shouldPublishProduct(), false);
    posts.push(published(i + 4, 0));
  }
  assert.equal(tracker(posts).shouldPublishProduct(), true);
});
test('browser reader uses platform-specific page and scopes metrics to matching permalink', async () => {
  for (const platform of ['threads', 'facebook']) {
    const url = { threads: 'https://www.threads.com/@seller/post/abc', facebook: 'https://www.facebook.com/seller/posts/123' }[platform];
    let visited;
    const page = { goto: async target => { visited = target; }, waitForSelector: async () => {}, evaluate: async () => [{ text: 'A practical tip', links: [url], labels: ['20K views', '10 likes'] }] };
    const method = { threads: 'getThreadsPage', facebook: 'getFacebookPage' }[platform];
    const reader = new BrowserMetricsReader({ browser: { [method]: async () => page } });
    assert.equal((await reader.read({ platform, text: 'A practical tip', result: { postUrl: url } })).views, 20000);
    assert.equal(visited, url);
  }
});
test('product generation retries invalid links and rejects duplicate pitches', async () => {
  let calls = 0;
  const text = `Ask your audience about their goals. ${product.product.name} offers more detail. ${product.product.sales_url}`;
  const engine = new ContentEngine({ ai: { callAi: async () => { calls++; return { type: 'product', platform: 'threads', text: calls === 1 ? 'Buy now https://wrong.test' : text }; } } });
  assert.equal((await engine.generateProductPost(product, { platform: 'threads' })).text, text);
  assert.equal(calls, 2);
  await assert.rejects(engine.generateProductPost(product, { platform: 'threads', previousPosts: [text] }), /repeats/);
  assert.throws(() => validatePost({ type: 'product', platform: 'threads', text: text + ' https://wrong.test' }, product), /exact sales URL/);
});
test('scheduler previews without browser or AI and publishes product only when eligible', async () => {
  const state = { posts: [published(1), published(2), { id: '3', platform: 'threads', text: 'Ask your audience what they need.', type: 'value', status: 'pending' }], cursor: 2, nextPostAt: 0 };
  let reads = 0, generations = 0, publishes = 0;
  const t = tracker(state.posts, { state, reader: { read: async post => { reads++; return post.metrics; } } });
  const engine = { generateProductPost: async () => { generations++; return { type: 'product', platform: 'threads', text: `Learn from your audience. ${product.product.name}: ${product.product.sales_url}` }; } };
  const scheduler = new ContentScheduler({ product, state, tracker: t, engine, persist: () => {}, publish: async post => { publishes++; assert.equal(post.type, 'product'); return { success: true, verified: true }; } });
  const before = JSON.stringify(state);
  assert.equal((await scheduler.tick()).plannedType, 'product');
  assert.equal(JSON.stringify(state), before);
  assert.equal(reads + generations + publishes, 0);
  assert.equal((await scheduler.tick({ dryRun: false })).post.type, 'product');
  assert.equal(generations, 1);
  assert.equal(publishes, 1);
  assert.equal(state.posts[2].valueText, 'Ask your audience what they need.');
});
test('generation failure leaves pending slot intact and never publishes', async () => {
  const state = { posts: [published(1), published(2), { id: '3', platform: 'threads', text: 'A useful tip.', type: 'value', status: 'pending' }], cursor: 2, nextPostAt: 0 };
  const t = tracker(state.posts, { state, reader: { read: async post => post.metrics } });
  const scheduler = new ContentScheduler({ product, state, tracker: t, engine: { generateProductPost: async () => { throw new Error('AI unavailable'); } }, persist: () => {}, publish: async () => assert.fail('must not publish') });
  await assert.rejects(scheduler.tick({ dryRun: false }), /AI unavailable/);
  assert.equal(state.posts[2].status, 'pending');
  assert.equal(state.posts[2].type, 'value');
});

test('a prepared pitch reverts to its value draft if refreshed views fall below the gate', async () => {
  const state = { posts: [published(1), published(2), { id: '3', platform: 'threads', text: `${product.product.name}: ${product.product.sales_url}`, valueText: 'A useful tip.', type: 'product', status: 'pending' }], cursor: 2, nextPostAt: 0 };
  const t = tracker(state.posts, { state, reader: { read: async post => ({ ...post.metrics, views: 0 }) } });
  const scheduler = new ContentScheduler({ product, state, tracker: t, persist: () => {}, publish: async post => { assert.equal(post.type, 'value'); assert.equal(post.text, 'A useful tip.'); return { success: true, verified: true }; } });
  await scheduler.tick({ dryRun: false });
  assert.equal(state.cursor, 3);
  assert.equal(state.posts[2].type, 'value');
});

test('persisted sequence spaces product posts across consecutive scheduler restarts', async () => {
  let state = { posts: [published(1), published(2), ...Array.from({ length: 11 }, (_, i) => ({ id: String(i + 3), platform: 'threads', text: `Audience tip ${i}.`, type: 'value', status: 'pending' }))], cursor: 2, nextPostAt: 0 };
  const types = [];
  for (let i = 0; i < 11; i++) {
    state.nextPostAt = 0;
    const t = tracker(state.posts, { state, reader: { read: async post => ({ source: 'browser', postUrl: post.result.postUrl, views: 10000 }) } });
    const scheduler = new ContentScheduler({ product, state, tracker: t, persist: () => {},
      engine: { generateProductPost: async () => ({ type: 'product', platform: 'threads', text: `Tip ${i}. ${product.product.name}: ${product.product.sales_url}` }) },
      publish: async post => { types.push(post.type); return { success: true, verified: true, postUrl: `https://www.threads.com/@seller/post/${post.id}` }; } });
    await scheduler.tick({ dryRun: false });
    state = JSON.parse(JSON.stringify(state));
  }
  assert.deepEqual(types, ['product', 'value', 'value', 'value', 'value', 'product', 'value', 'value', 'value', 'value', 'product']);
});
