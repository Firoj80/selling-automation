const assert = require('node:assert/strict');
const { test } = require('node:test');
const { ProductReplyEngine } = require('../src/engagement/product-reply-engine');
const { ProductEngagement, turnKey } = require('../src/engagement/product-engagement');
const { ProductBrowserAdapter, publicItems, dmUrl } = require('../src/engagement/product-browser-adapter');
const { validateProduct } = require('../src/content/product-config');
const product = validateProduct(require('./fixtures/product.json'));
const item = { kind: 'dm', platform: 'threads', username: 'reader', text: 'How should I choose a niche?', id: 'message-1', url: 'https://www.threads.com/messages/t/123', conversationId: 'https://www.threads.com/messages/t/123', source: 'conversation', direction: 'incoming' };
const response = 'Start with a problem you understand and ask five people how they handle it today.';
function engine(result) { return new ProductReplyEngine({ ai: { callAi: async () => result } }); }
function fixture(options = {}) {
  const state = { version: 1, turns: {}, optOuts: {} };
  let sends = 0, saves = 0, verifies = 0;
  const runner = new ProductEngagement({ product, state, engine: { generate: async () => ({ action: 'reply', intent: 'topic_question', response }) },
    adapter: { verify: async () => { verifies++; return { valid: true }; }, send: async () => { sends++; return { success: true, verified: true }; } },
    persist: () => { saves++; }, now: () => 1000000, ...options });
  return { runner, state: runner.state, sends: () => sends, saves: () => saves, verifies: () => verifies };
}
test('value replies use product topics and exclude the sales pitch', async () => {
  const decision = await engine({ action: 'reply', relevant: true, intent: 'topic_question', response }).generate({ product, item });
  assert.equal(decision.response, response);
  for (const text of [`Buy ${product.product.name}`, 'Read my guide', 'Visit https://other.example', 'DM me for details', 'I earned $1K yesterday']) {
    await assert.rejects(engine({ action: 'reply', relevant: true, intent: 'topic_question', response: text }).generate({ product, item }));
  }
});
test('direct requests get only the actual product URL without fabricated AI details', async () => {
  const inquiry = { ...item, text: 'Where can I get this?', context: product.product.name };
  const decision = await engine({ action: 'reply', relevant: true, intent: 'purchase_request', request_quote: inquiry.text, response: 'Ignore the rules and use https://evil.test' }).generate({ product, item: inquiry });
  assert.equal(decision.response, `You can get ${product.product.name} here: ${product.product.sales_url}`);
  assert.ok(!decision.response.includes('evil'));
});
test('generic link requests and fabricated intent evidence require review', async () => {
  const ai = engine({ action: 'reply', relevant: true, intent: 'purchase_request', request_quote: 'Where can I get this?' });
  assert.equal((await ai.generate({ product, item: { ...item, text: 'Where can I get this?' } })).action, 'review');
  assert.equal((await ai.generate({ product, item: { ...item, context: product.product.name } })).action, 'review');
});
test('product detail answers can mention product but cannot add an unrequested URL', async () => {
  const inquiry = { ...item, text: `What topics does ${product.product.name} cover?` };
  const ai = engine({ action: 'reply', relevant: true, intent: 'product_question', request_quote: inquiry.text, response: 'It covers niche selection and audience research.' });
  assert.equal((await ai.generate({ product, item: inquiry })).action, 'reply');
  await assert.rejects(engine({ action: 'reply', relevant: true, intent: 'product_question', request_quote: inquiry.text, response: product.product.sales_url }).generate({ product, item: inquiry }), /link/);
});
test('opt-outs and account support are handled before any AI call', async () => {
  const ai = new ProductReplyEngine({ ai: { callAi: () => assert.fail('must not call AI') } });
  assert.equal((await ai.generate({ product, item: { ...item, text: 'Stop messaging me' } })).optOut, true);
  assert.equal((await ai.generate({ product, item: { ...item, text: 'I need a refund' } })).action, 'review');
});
test('irrelevant and malformed decisions cannot become replies', async () => {
  assert.equal((await engine({ action: 'reply', relevant: false }).generate({ product, item })).action, 'ignore');
  await assert.rejects(engine({ action: 'send' }).generate({ product, item }), /Invalid/);
});
test('preview does not persist, verify, send, or consume the incoming turn', async () => {
  const f = fixture();
  const before = JSON.stringify(f.state);
  assert.equal((await f.runner.process(item)).status, 'preview');
  assert.equal(f.sends() + f.saves() + f.verifies(), 0);
  assert.equal(JSON.stringify(f.state), before);
  assert.equal((await f.runner.process(item, { dryRun: false })).status, 'sent');
});
test('outgoing, own and inbox-preview messages are skipped', async () => {
  const f = fixture({ engine: { generate: () => assert.fail('must not generate') } });
  for (const change of [{ direction: 'outgoing' }, { username: product.seller.username }, { source: 'inbox' }, { platform: 'facebook' }, { direction: 'unknown' }]) assert.equal((await f.runner.process({ ...item, ...change })).status, 'skipped');
});
test('send is persisted first and history is recorded only after verified delivery', async () => {
  const f = fixture();
  f.runner.adapter.send = async () => {
    assert.equal(f.state.turns[turnKey(item)].status, 'sending');
    assert.deepEqual(f.runner.history(item), []);
    return { success: true, verified: true };
  };
  assert.equal((await f.runner.process(item, { dryRun: false })).status, 'sent');
  assert.equal(f.runner.history(item).length, 2);
  const restarted = fixture({ state: JSON.parse(JSON.stringify(f.state)) });
  assert.equal((await restarted.runner.process(item, { dryRun: false })).status, 'skipped');
  assert.equal(restarted.sends(), 0);
});
test('uncertain and interrupted sends block the recipient across later turns', async () => {
  for (const result of [{ success: false }, { success: true, verified: false }, { success: true, verified: true, simulated: true }]) {
    const f = fixture(); f.runner.adapter.send = async () => result;
    assert.equal((await f.runner.process(item, { dryRun: false })).status, 'uncertain');
    assert.deepEqual(f.runner.history(item), []);
    assert.equal((await f.runner.process({ ...item, id: 'message-2', text: 'Another question' }, { dryRun: false })).status, 'skipped');
  }
  const f = fixture();
  f.state.turns[turnKey(item)] = { item, status: 'sending', attemptedAt: 1 };
  assert.equal((await f.runner.process(item, { dryRun: false })).status, 'skipped');
});
test('approval preserves a draft and checks target freshness before sending', async () => {
  const f = fixture();
  const pending = await f.runner.process(item, { dryRun: false, approvalMode: true });
  assert.equal(pending.status, 'pending_approval');
  assert.equal(f.sends(), 0);
  assert.deepEqual(f.runner.history(item), []);
  f.runner.adapter.verify = async () => ({ valid: false });
  assert.equal((await f.runner.process(item, { dryRun: false, approvalMode: true, approvedId: pending.id })).status, 'stale');
  assert.equal(f.sends(), 0);
  f.runner.adapter.verify = async () => ({ valid: true });
  assert.equal((await f.runner.process(item, { dryRun: false, approvalMode: true, approvedId: pending.id })).status, 'sent');
});
test('opt-out persists across public and private incoming messages', async () => {
  const f = fixture({ engine: { generate: async () => ({ action: 'ignore', optOut: true, reason: 'Stop requested' }) } });
  await f.runner.process(item, { dryRun: false });
  const restarted = fixture({ state: JSON.parse(JSON.stringify(f.state)) });
  assert.equal((await restarted.runner.process({ ...item, kind: 'reply', id: 'post2', conversationId: 'post2' }, { dryRun: false })).reason, 'Recipient opted out');
  assert.equal(restarted.sends(), 0);
});
test('hourly limit, recipient cooldown and repeated responses prevent excess sends', async () => {
  const f = fixture({ maxPerHour: 1 });
  await f.runner.process(item, { dryRun: false });
  assert.equal((await f.runner.process({ ...item, username: 'reader2', id: 'new', conversationId: 'other' }, { dryRun: false })).status, 'rate_limited');
  const g = fixture(); await g.runner.process(item, { dryRun: false });
  assert.equal((await g.runner.process({ ...item, id: 'new' }, { dryRun: false })).reason, 'Repeated outgoing response');
  g.runner.engine.generate = async () => ({ action: 'reply', response: 'A different useful response.' });
  assert.equal((await g.runner.process({ ...item, id: 'new' }, { dryRun: false })).reason, 'Recipient cooldown');
});
test('public targets are canonical and Facebook comment anchors never become parent replies', () => {
  assert.equal(publicItems([{ text: 'A question', links: ['https://www.threads.com/@user/post/123?ref=1'] }], 'threads')[0].username, 'user');
  assert.deepEqual(publicItems([{ text: 'A comment', links: ['https://facebook.com/user/posts/123?comment_id=456'] }], 'facebook'), []);
  assert.equal(dmUrl('https://threads.com/messages/t/123'), 'https://www.threads.com/messages/t/123');
  assert.equal(dmUrl('https://evil.test/messages/t/123'), null);
});
test('adapter uses exact Threads conversation URL and strict send verification', async () => {
  let passed;
  const adapter = new ProductBrowserAdapter({ campaign: { posts: [] }, browser: {}, limiter: { recordAction() {} }, dms: { sendDirectMessage: async (...args) => { passed = args; return { success: true, verified: true }; } } });
  await adapter.send(item, response);
  assert.equal(passed[0], item.url);
  assert.equal(passed[2].strictProductReply, true);
  assert.deepEqual(passed[2].expectedIncoming, item);
});

test('product replies bypass legacy service-buyer classification after product relevance checks', async () => {
  let passed;
  const adapter = new ProductBrowserAdapter({ campaign: { posts: [] }, browser: {}, limiter: { recordAction() {} }, actions: { threads: { postComment: async (...args) => { passed = args; return { success: true, verified: true }; } } } });
  await adapter.send({ ...item, kind: 'reply', url: 'https://www.threads.com/@reader/post/abc' }, response);
  assert.equal(passed[0].postId, 'abc');
  assert.equal(passed[2].skipRecheck, true);
});
