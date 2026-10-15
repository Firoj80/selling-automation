const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { validateProduct } = require('../src/content/product-config');
const { validatePost, ContentEngine } = require('../src/content/content-engine');
const { ContentHumanizer } = require('../src/content/content-humanizer');
const { ContentScheduler } = require('../src/content/content-scheduler');
const { rehumanize } = require('../src/content/rehumanize-queue');
const { save } = require('../src/content/content-store');
const { rulesRevision } = require('../src/content/writing-rules');
const product = validateProduct(require('./fixtures/product.json'));
const draft = text => ({ id: 'value-1', platform: 'threads', type: 'value', status: 'pending', text });
const writing = { enabled: true, instructions: 'Write naturally.' };
function editor(text, review = true) { return { callAi: async (prompt, options) => options.taskType === 'CONTENT_EDIT_REVIEW' ? { faithful: review } : { text, facts_preserved: true } }; }

test('the supplied example is rewritten without em dashes while keeping its numeric token', async () => {
  const original = 'To post consistently without burnout, set a steady schedule—like every 3 hours—focused purely on teaching.  Review which topics get engagement.';
  const clean = 'To post consistently without burnout, set a steady schedule, like every 3 hours, focused purely on teaching. Review which topics get engagement.';
  const result = await new ContentHumanizer({ writing, ai: editor(clean) }).edit(draft(original), product, validatePost);
  assert.equal(result.text, clean); assert.equal(result.writing.status, 'edited');
  assert.equal(result.writing.rulesRevision, rulesRevision(product));
});

test('punctuation violations include the repair reason in the next rewrite attempt', async () => {
  const prompts = [];
  const ai = { callAi: async (prompt, options) => {
    prompts.push(prompt);
    if (options.taskType === 'CONTENT_EDIT_REVIEW') return { faithful: true };
    return { text: prompts.length === 1 ? 'Ask one question—then listen.' : 'Ask one question, then listen.', facts_preserved: true };
  } };
  const result = await new ContentHumanizer({ writing, ai }).edit(draft('Ask one question, then listen.'), product, validatePost);
  assert.equal(result.writing.status, 'edited'); assert.ok(prompts[1].includes('replace em dashes'));
});

test('failed editing holds the original, and explicit fallback still cannot retain an em dash', async () => {
  for (const policy of ['hold_for_review', 'validated_original']) {
    const result = await new ContentHumanizer({ writing: { ...writing, settings: { fallback_policy: policy } }, ai: editor('Ask 99 people.') }).edit(draft('Ask one question—then listen.'), product, validatePost);
    assert.equal(result.status, 'needs_edit'); assert.equal(result.text, 'Ask one question—then listen.');
  }
  const normal = await new ContentHumanizer({ writing, ai: editor('Ask 99 people.') }).edit(draft('Ask one question, then listen.'), product, validatePost);
  assert.equal(normal.status, 'needs_edit');
});

test('disabled Humanizer still enforces punctuation, and final validation rejects repeated spaces', async () => {
  const ai = { callAi: () => assert.fail('Editing is disabled') };
  const result = await new ContentHumanizer({ writing: { enabled: false }, ai }).edit(draft('Choose a topic—then explain it.'), product, validatePost);
  assert.equal(result.status, 'needs_edit');
  assert.throws(() => validatePost(draft('Choose  a topic.'), product), /repeated spaces/);
  assert.throws(() => validatePost(draft('Choose a topic—then explain it.'), product), /em dashes/);
});

test('a protected price or URL is never changed to satisfy style checks', async () => {
  const p = structuredClone(product); p.product.sales_url = 'https://example.com/—';
  const post = { ...draft(`${p.product.name} costs ${p.product.price}. ${p.product.sales_url}`), type: 'product' };
  const edited = `${p.product.name} costs ${p.product.price}. https://example.com/buy`;
  const result = await new ContentHumanizer({ writing, ai: editor(edited) }).edit(post, p, validatePost);
  assert.equal(result.status, 'needs_edit'); assert.equal(result.text, post.text);
  const p2 = structuredClone(product); p2.product.price = '$19';
  const original = { ...draft(`${p2.product.name} costs $19. ${p2.product.sales_url}`), type: 'product' };
  const changed = await new ContentHumanizer({ writing, ai: editor(original.text.replace('$19', '€19')) }).edit(original, p2, validatePost);
  assert.equal(changed.status, 'needs_edit');
});

test('generation saves a failed rewrite before advancing and reports saved versus ready counts', async () => {
  let generated = 0, saved = 0;
  const events = [];
  const ai = { callAi: async (prompt, options) => {
    if (options.taskType === 'CONTENT_GENERATION') {
      if (generated) assert.equal(saved, 1);
      const n = generated++;
      return { posts: [{ ...draft(`Teaching exercise ${n}—explain one task.`), platform: n ? 'facebook' : 'threads' }] };
    }
    return { text: 'Changed 99 facts.', facts_preserved: true };
  } };
  const engine = new ContentEngine({ ai, humanizer: new ContentHumanizer({ writing, ai }), onProgress: event => events.push(event) });
  const posts = await engine.generateContentQueue(product, '', 2, { onAccepted: drafts => { saved = drafts.length; } });
  assert.equal(posts.length, 2); assert.ok(posts.every(p => p.status === 'needs_edit'));
  assert.equal(events.at(-1).saved, 2); assert.equal(events.at(-1).ready, 0); assert.equal(events.at(-1).needsEdit, 2);
});

test('old pending content failing the current rules is held before a browser submission', async () => {
  const state = { posts: [draft('Teach one task—then ask a question.')], cursor: 0, nextPostAt: 0 };
  const scheduler = new ContentScheduler({ product, state, persist: () => {}, publish: () => assert.fail('Must not submit'), now: () => 100 });
  assert.equal((await scheduler.tick({ dryRun: false })).status, 'held');
  assert.equal(state.posts[0].status, 'needs_edit'); assert.equal(state.posts[0].attemptedAt, undefined);
});

function workspace(t, checkpoint = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meta-humanizer-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  save(path.join(root, 'product.json'), product);
  const state = { posts: [draft('Teach one task—then ask a question.'), { ...draft('Leave my authored text.'), id: 'manual', manuallyEdited: true }, { ...draft('Historical text.'), id: 'published', status: 'published', attemptedAt: 1 }], cursor: 0, nextPostAt: 100, calendar: [] };
  state.posts[0].scheduledAt = 5000;
  const file = path.join(root, 'private', checkpoint ? 'product-generation.json' : 'product-content.json');
  save(file, state);
  return { root, state, file };
}

test('rehumanizing saved drafts preserves IDs, times, manual edits and published history', async t => {
  const f = workspace(t);
  const result = await rehumanize(f.root, ['--pending'], { ai: editor('Teach one task, then ask a question.'), onProgress: () => {} });
  assert.equal(result.processed, 1); assert.equal(result.needsEdit, 0);
  const state = JSON.parse(fs.readFileSync(f.file));
  assert.equal(state.posts[0].id, 'value-1'); assert.equal(state.posts[0].scheduledAt, 5000);
  assert.equal(state.posts[0].revisions[0].text, f.state.posts[0].text);
  assert.deepEqual(state.posts.slice(1), f.state.posts.slice(1));
});

test('preview calls no AI and writes no state; attempted posts cannot be rehumanized', async t => {
  const f = workspace(t), before = fs.readFileSync(f.file, 'utf8');
  assert.equal((await rehumanize(f.root, ['--pending', '--preview'], { ai: { callAi: () => assert.fail('Preview') } })).status, 'preview');
  assert.equal(fs.readFileSync(f.file, 'utf8'), before);
  await assert.rejects(rehumanize(f.root, ['published'], { ai: editor('Historical text.') }), /unattempted/);
});

test('each rehumanized draft is persisted before editing the next draft', async t => {
  const f = workspace(t, true);
  f.state.posts[1].manuallyEdited = false; save(f.file, f.state);
  let edits = 0;
  const ai = { callAi: async (prompt, options) => {
    if (options.taskType === 'CONTENT_EDIT_REVIEW') return { faithful: true };
    if (edits++) assert.equal(JSON.parse(fs.readFileSync(f.file)).posts[0].writing.status, 'edited');
    return { text: edits === 1 ? 'Teach one task, then ask a question.' : 'Leave this authored text.', facts_preserved: true };
  } };
  assert.equal((await rehumanize(f.root, ['--pending'], { ai, onProgress: () => {} })).processed, 2);
});

test('AI replies undergo editing and failed edits become review decisions', async () => {
  const { ProductReplyEngine } = require('../src/engagement/product-reply-engine');
  const item = { platform: 'threads', kind: 'reply', text: 'How can I plan topics?' };
  const ai = { callAi: async (prompt, options) => options.taskType === 'REPLY_GENERATION' ? { action: 'reply', relevant: true, intent: 'topic_question', response: 'Pick one topic—then explain it.' } : options.taskType === 'CONTENT_EDIT_REVIEW' ? { faithful: true } : { text: 'Pick one topic, then explain it.', facts_preserved: true } };
  const result = await new ProductReplyEngine({ ai, writing }).generate({ product, copy: '', item });
  assert.equal(result.action, 'reply'); assert.ok(!result.response.includes('—'));
  ai.callAi = async (prompt, options) => options.taskType === 'REPLY_GENERATION' ? { action: 'reply', relevant: true, intent: 'topic_question', response: 'Pick one topic—then explain it.' } : { text: 'Pick 99 topics.', facts_preserved: true };
  assert.equal((await new ProductReplyEngine({ ai, writing }).generate({ product, copy: '', item })).action, 'review');
});

test('a clean-looking rewrite with a failed fact review remains blocked', async () => {
  const result = await new ContentHumanizer({ writing, ai: editor('Teach one task, then ask a question.', false) }).edit(draft('Teach one task—then ask a question.'), product, validatePost);
  assert.equal(result.status, 'needs_edit'); assert.ok(result.writing.reason.includes('fidelity'));
});

test('rewriting a held draft preserves the user hold after a failed attempt and successful repair', async t => {
  const f = workspace(t); f.state.posts[0].status = 'held'; save(f.file, f.state);
  await rehumanize(f.root, ['value-1'], { ai: editor('Invented 99 facts.'), onProgress: () => {} });
  assert.equal(JSON.parse(fs.readFileSync(f.file)).posts[0].status, 'needs_edit');
  await rehumanize(f.root, ['value-1'], { ai: editor('Teach one task, then ask a question.'), onProgress: () => {} });
  assert.equal(JSON.parse(fs.readFileSync(f.file)).posts[0].status, 'held');
});

test('resuming bulk repair skips drafts already edited under the current rules', async t => {
  const f = workspace(t);
  await rehumanize(f.root, ['--pending'], { ai: editor('Teach one task, then ask a question.'), onProgress: () => {} });
  const result = await rehumanize(f.root, ['--pending'], { ai: { callAi: () => assert.fail('Already edited') }, onProgress: () => {} });
  assert.equal(result.processed, 0);
});

test('AI metadata cannot falsely mark a generated post as humanized', async () => {
  const ai = { callAi: async () => ({ posts: [{ text: 'Teach one task.', type: 'value', platform: 'threads', writing: { status: 'edited' }, result: { verified: true } }] }) };
  const posts = await new ContentEngine({ ai, onProgress: () => {} }).generateContentQueue(product, '', 1);
  assert.equal(posts[0].writing, undefined); assert.equal(posts[0].result, undefined);
});
