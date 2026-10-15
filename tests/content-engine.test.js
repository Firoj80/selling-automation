const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { validateProduct } = require('../src/content/product-config');
const { ContentEngine, validatePost } = require('../src/content/content-engine');
const { ContentScheduler } = require('../src/content/content-scheduler');
const { setup } = require('../src/agent/setup-engine');
const example = require('./fixtures/product.json');
const product = validateProduct(example);
function fixture() {
  const state = { cursor: 0, nextPostAt: 0, posts: product.strategy.platforms.map((platform, i) => ({ id: `p${i}`, text: 'Ask your audience which problem takes the most time.', type: 'value', platform, status: 'pending' })) };
  let time = 100;
  let calls = 0;
  const scheduler = new ContentScheduler({ product, state, persist: () => {}, now: () => time, publish: async () => { calls++; return { success: true, verified: true }; } });
  return { state, scheduler, calls: () => calls, advance: () => { time += 10800000; } };
}
test('rejects invalid product input and unsupported platform rotation', () => {
  for (const change of [{ platforms: ['linkedin'] }, { platforms: ['tiktok'] }, { platforms: ['threads', 'threads'] }, { post_frequency_hours: 0 }, { view_threshold_to_sell: -1 }, { product_mention_ratio: 'anything' }]) {
    assert.throws(() => validateProduct({ ...example, strategy: change }), /Invalid product/);
  }
  assert.throws(() => validateProduct({ ...example, product: { ...example.product, sales_url: 'javascript:alert(1)' } }));
  assert.equal(validateProduct({ ...example, strategy: { product_mention_ratio: '1 in 10 posts' } }).strategy.product_mention_ratio, '1 in 10 posts');
  assert.throws(() => validateProduct({ ...example, product: { ...example.product, description: 12 } }));
});
test('rejects promotional, malformed and overlong content', () => {
  for (const text of ['Get my ebook', product.product.name, 'Link in bio', 'https://example.com', 'a'.repeat(451)]) assert.throws(() => validatePost({ platform: 'threads', type: 'value', text }, product));
});

test('prelaunch product accepts a missing sales URL and permits educational content only', async () => {
  const { ContentTracker } = require('../src/content/content-tracker');
  const { ProductReplyEngine } = require('../src/engagement/product-reply-engine');
  for (const url of ['', undefined]) {
    const prelaunch = validateProduct({ ...example, product: { ...example.product, sales_url: url } });
    assert.doesNotThrow(() => validatePost({ platform: 'threads', type: 'value', text: 'Ask your audience which task takes the most time.' }, prelaunch));
    assert.throws(() => validatePost({ platform: 'threads', type: 'product', text: `Try ${prelaunch.product.name}` }, prelaunch), /sales URL/);
    const tracker = new ContentTracker({ product: prelaunch, state: { posts: [] } });
    tracker.publishedPosts = () => Array.from({ length: 60 }, () => ({ type: 'value' }));
    tracker.getTotalViews = () => 100000;
    assert.equal(tracker.shouldStartSelling(), false);
    const generator = new ContentEngine({ ai: { callAi: async () => { throw new Error('Must not call AI'); } } });
    await assert.rejects(generator.generateProductPost(prelaunch, { platform: 'threads' }), /sales URL/);
    const replies = new ProductReplyEngine({ ai: { callAi: async () => ({ action: 'reply', relevant: true, intent: 'purchase_request', request_quote: 'send me the link', response: '' }) } });
    const decision = await replies.generate({ product: prelaunch, copy: '', item: { kind: 'reply', platform: 'threads', text: 'Please send me the link', context: prelaunch.product.name } });
    assert.equal(decision.action, 'review');
    assert.match(decision.reason, /not configured/);
    const ambiguous = await replies.generate({ product: prelaunch, copy: '', item: { kind: 'reply', platform: 'threads', text: 'Please send me the link', context: 'An unrelated conversation' } });
    assert.equal(ambiguous.action, 'review');
    assert.match(ambiguous.reason, /context/);
  }
});
test('preview does not publish or consume the queue', async () => {
  const f = fixture();
  const before = JSON.stringify(f.state);
  assert.equal((await f.scheduler.tick()).status, 'preview');
  assert.equal(f.calls(), 0);
  assert.equal(JSON.stringify(f.state), before);
});
test('persists cadence and rotates after verified publication', async () => {
  const f = fixture();
  assert.equal((await f.scheduler.tick({ dryRun: false })).status, 'published');
  assert.equal(f.scheduler.getNextPlatform(), 'facebook');
  assert.equal((await f.scheduler.tick({ dryRun: false })).status, 'waiting');
  f.advance();
  assert.equal((await f.scheduler.tick({ dryRun: false })).status, 'published');
  assert.equal(f.scheduler.getNextPlatform(), null);
  assert.equal(f.calls(), 2);
});
test('failed, simulated and interrupted submissions cannot automatically retry', async () => {
  for (const result of [{ success: false }, { success: true, simulated: true }, { success: true, verified: false }]) {
    const f = fixture();
    f.scheduler.publish = async () => result;
    await assert.rejects(f.scheduler.tick({ dryRun: false }), /review/);
    assert.equal(f.state.cursor, 0);
    await assert.rejects(f.scheduler.tick({ dryRun: false }), /reconcile/);
  }
  const f = fixture();
  f.state.posts[0].status = 'publishing';
  await assert.rejects(f.scheduler.tick({ dryRun: false }), /reconcile/);
});
test('AI batches produce 50 distinct posts with platform rotation', async () => {
  let i = 0;
  const engine = new ContentEngine({ ai: { callAi: async () => ({ posts: Array.from({ length: 1 }, () => {
    const n = i++;
    return { platform: product.strategy.platforms[n % product.strategy.platforms.length], type: 'value', text: `Audience research exercise ${n}: ask one person which task takes the most time.` };
  }) }) } });
  const posts = await engine.generateContentQueue(product, 'Source content');
  assert.equal(posts.length, 50);
  assert.equal(new Set(posts.map(p => p.text)).size, 50);
});

test('live progress counts accepted posts and waits for Humanizer review before the next draft', async () => {
  const { ContentHumanizer } = require('../src/content/content-humanizer');
  const stages = [], calls = [];
  let releaseEdit, enteredEdit;
  const blocked = new Promise(resolve => { releaseEdit = resolve; });
  const editing = new Promise(resolve => { enteredEdit = resolve; });
  let generated = 0;
  const ai = { callAi: async (prompt, { taskType }) => {
    calls.push(taskType);
    if (taskType === 'CONTENT_GENERATION') {
      const platform = product.strategy.platforms[generated++];
      return { posts: [{ platform, type: 'value', text: generated === 1 ? 'Ask a specific audience question.' : 'Collect recurring audience questions.' }] };
    }
    if (taskType === 'CONTENT_EDIT') {
      if (generated === 1) { enteredEdit(); await blocked; }
      return { text: generated === 1 ? 'Ask your audience a specific question.' : 'Collect the questions your audience keeps asking.', facts_preserved: true };
    }
    return { faithful: true };
  } };
  const humanizer = new ContentHumanizer({ ai, writing: { enabled: true, instructions: 'Edit naturally.' } });
  const engine = new ContentEngine({ ai, humanizer, onProgress: event => stages.push(event) });
  const pending = engine.generateContentQueue(product, '', 2);
  await editing;
  assert.equal(generated, 1);
  assert.deepEqual(stages.map(e => e.stage), ['Generating', 'Humanizing']);
  assert.ok(stages.every(e => e.completed === 0));
  releaseEdit();
  const posts = await pending;
  assert.deepEqual(calls, ['CONTENT_GENERATION', 'CONTENT_EDIT', 'CONTENT_EDIT_REVIEW', 'CONTENT_GENERATION', 'CONTENT_EDIT', 'CONTENT_EDIT_REVIEW']);
  assert.deepEqual(stages.filter(e => e.stage === 'Complete').map(e => [e.completed, e.total]), [[1, 2], [2, 2]]);
  assert.ok(posts.every(p => p.writing.status === 'edited'));
});

test('progress identifies original fallback without claiming it was humanized', async () => {
  const { ContentHumanizer } = require('../src/content/content-humanizer');
  const stages = [];
  const ai = { callAi: async (prompt, { taskType }) => taskType === 'CONTENT_GENERATION'
    ? { posts: [{ platform: 'threads', type: 'value', text: 'Ask your audience a question.' }] }
    : { text: 'Ask 500 people a question.', facts_preserved: true } };
  const engine = new ContentEngine({ ai, humanizer: new ContentHumanizer({ ai, writing: { enabled: true, settings: { fallback_policy: 'validated_original' } } }), onProgress: e => stages.push(e) });
  await engine.generateContentQueue(product, '', 1);
  assert.equal(stages.at(-1).completed, 1);
  assert.equal(stages.at(-1).detail, 'Original retained: Humanizer checks failed');
});
test('invalid AI output fails without saving a campaign', async () => {
  const engine = new ContentEngine({ ai: { callAi: async () => ({ posts: [] }) } });
  await assert.rejects(engine.generateContentQueue(product, ''), /only 0\/50/);
});

test('generation resumes accepted drafts and saves the next one before advancing', async () => {
  const first = { id: 'value-1', platform: 'threads', type: 'value', text: 'Ask your audience what takes the most time.', status: 'pending' };
  let calls = 0;
  const events = [], saved = [];
  const engine = new ContentEngine({ onProgress: e => events.push(e), ai: { callAi: async () => { calls++; return { posts: [{ platform: 'facebook', type: 'value', text: 'Collect recurring audience questions.' }] }; } } });
  const posts = await engine.generateContentQueue(product, '', 2, { initialPosts: [first], onAccepted: drafts => saved.push(drafts) });
  assert.equal(calls, 1);
  assert.equal(posts[0].text, first.text);
  assert.equal(events[0].stage, 'Resumed');
  assert.equal(events[0].completed, 1);
  assert.equal(saved[0].length, 2);
  await assert.rejects(engine.generateContentQueue(product, '', 2, { initialPosts: [first], onAccepted: () => { throw new Error('Disk unavailable'); } }), /Disk unavailable/);
  assert.equal(calls, 2); // Persistence failure must stop instead of retrying AI.
});

test('Humanizer reports missing schema fields separately and explains the repair on retry', async () => {
  const { ContentHumanizer } = require('../src/content/content-humanizer');
  const prompts = [], stages = [];
  const humanizer = new ContentHumanizer({ writing: { enabled: true }, ai: { callAi: async prompt => { prompts.push(prompt); return { text: 'Ask an audience question.' }; } } });
  const result = await humanizer.edit({ platform: 'threads', type: 'value', text: 'Ask an audience question.' }, product, validatePost, { onStage: (stage, reason) => stages.push({ stage, reason }) });
  assert.match(result.writing.reason, /missing the boolean facts_preserved/);
  assert.ok(prompts[1].includes('previousValidationError'));
  assert.ok(prompts[1].includes('missing the boolean facts_preserved'));
  assert.equal(stages.at(-2).stage, 'Humanizer rejected');
});

test('setup preserves generated drafts after failure and passes them to the next setup run', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'product-resume-test-'));
  try {
    fs.writeFileSync(path.join(root, 'product.json'), JSON.stringify({ ...example, research: { enabled: false }, learning: { enabled: false } }));
    const first = fixture().state.posts[0];
    await assert.rejects(setup(root, { engine: { generateContentQueue: async (p, c, n, options) => { await options.onAccepted([first]); throw new Error('Interrupted'); } } }), /Interrupted/);
    assert.equal(fs.existsSync(path.join(root, 'private', 'product-content.json')), false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'private', 'product-generation.json'))).posts.length, 1);
    const completed = await setup(root, { engine: { generateContentQueue: async (p, c, n, options) => { assert.equal(options.initialPosts[0].text, first.text); return fixture().state.posts; } } });
    assert.equal(completed.posts[0].text, first.text);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('setup preserves existing knowledge and refuses to overwrite campaign history', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'product-content-test-'));
  try {
    fs.writeFileSync(path.join(root, 'product.json'), JSON.stringify({ ...example, research: { enabled: false }, learning: { enabled: false } }));
    fs.mkdirSync(path.join(root, 'knowledge'));
    fs.writeFileSync(path.join(root, 'knowledge', 'founder.md'), 'Existing identity');
    const engine = { generateContentQueue: async () => fixture().state.posts };
    const result = await setup(root, { engine, now: 100 });
    assert.equal(result.calendar[1].scheduledAt, new Date(10800100).toISOString());
    assert.equal(fs.readFileSync(path.join(root, 'knowledge', 'founder.md'), 'utf8'), 'Existing identity');
    assert.ok(fs.existsSync(path.join(root, 'knowledge', 'product', 'identity.md')));
    await assert.rejects(setup(root, { engine }), /already exists/);
    assert.equal(fs.existsSync(path.join(root, 'private', 'product-content.lock')), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
