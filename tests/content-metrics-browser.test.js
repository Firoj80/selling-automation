// Offline DOM integration tests: launches a fresh headless browser, never a user session.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { test } = require('node:test');
const { collectPostSnapshots, selectSnapshot, parseMetrics, findPostUrl } = require('../src/content/post-metrics');
const { collectDmConversation, collectPublicMessages, publicItems, discussionItems } = require('../src/engagement/product-browser-adapter');
const executablePath = process.env.CONTENT_TEST_BROWSER || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/chromium', '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
].find(file => fs.existsSync(file));

test('research extracts visible discussion context, dates and separate Facebook comment evidence', { skip: !executablePath }, async () => {
  const { default: puppeteer } = await import('puppeteer-core');
  const browser = await puppeteer.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<div aria-label="Replies"><article><a href="https://www.threads.com/@reader/post/2">Permalink</a><p data-lexical-text="true">How can I organize my teaching topics?</p><time datetime="2026-10-03T08:00:00Z"></time></article></div><article><a href="https://www.threads.com/@other/post/3">Suggested</a><p data-lexical-text="true">Unrelated suggested post</p></article>');
    const rows = await page.evaluate(collectPublicMessages);
    const comments = discussionItems(rows, 'threads', { url: 'https://www.threads.com/@owner/post/1', username: 'owner', text: 'Plan teaching topics' });
    assert.equal(comments.length, 1);
    assert.equal(comments[0].publishedAt, Date.parse('2026-10-03T08:00:00Z'));
    await page.setContent('<div aria-label="Comments"><div role="article"><h3><a href="https://www.facebook.com/reader">Reader</a></h3><a href="https://www.facebook.com/owner/posts/123?comment_id=456">Permalink</a><p data-ad-preview="message">How should I plan posts?</p></div></div>');
    const fb = discussionItems(await page.evaluate(collectPublicMessages), 'facebook', { url: 'https://www.facebook.com/owner/posts/123', username: 'owner', text: 'Plan posts' });
    assert.equal(fb.length, 1);
    assert.equal(fb[0].username, 'reader');
    assert.equal(fb[0].url, 'https://www.facebook.com/owner/posts/123?comment_id=456');
  } finally { await browser.close(); }
});

test('real DOM extraction isolates each platform post and ignores nested replies', { skip: !executablePath }, async () => {
  const { default: puppeteer } = await import('puppeteer-core');
  const browser = await puppeteer.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage();
    for (const platform of ['threads', 'facebook']) {
      const url = { threads: 'https://www.threads.com/@seller/post/abc', facebook: 'https://www.facebook.com/seller/posts/123' }[platform];
      const tag = platform === 'threads' ? 'div data-pressable-container="true"' : platform === 'facebook' ? 'div role="article"' : 'article';
      const end = 'div';
      const body = platform === 'threads' ? 'data-lexical-text="true"' : 'data-ad-preview="message"';
      await page.setContent(`<${tag}>
        <p ${body}>Ask your audience what takes the most time.</p>
        <a href="${url}">Timestamp</a>
        <div role="group" aria-label="2 replies, 3 reposts, 12 likes, 20,000 views"></div>
        <button aria-label="20,000 views">20K views</button>
        <${tag}><p ${body}>A reply with its own engagement</p><a href="https://www.threads.com/@other/post/99">Reply</a><button aria-label="900K views">900K views</button></${end}>
      </${end}>
      <${tag}><p ${body}>A different post</p><a href="https://www.threads.com/@other/post/88">Timestamp</a><button>500K views</button></${end}>`);
      const post = { platform, text: 'Ask your audience what takes the most time.' };
      const snapshots = await page.evaluate(collectPostSnapshots);
      const snapshot = selectSnapshot(snapshots, post, url);
      assert.ok(snapshot, platform);
      assert.equal(parseMetrics(snapshot.labels).views, 20000, platform);
      assert.equal(parseMetrics(snapshot.labels).comments, 2, platform);
      assert.equal(await findPostUrl(page, post), url, platform);
      assert.ok(!snapshot.text.includes('A reply'), platform);
    }
    await page.setContent('<article><p data-lexical-text="true">A useful tip.</p><a href="https://www.threads.com/@seller/post/123">Time</a><button>Like</button></article>');
    const snapshot = selectSnapshot(await page.evaluate(collectPostSnapshots), { platform: 'threads', text: 'A useful tip.' }, 'https://www.threads.com/@seller/post/123');
    assert.equal(parseMetrics(snapshot.labels).views, null);
    await page.setContent('<article><p data-lexical-text="true">Learn from your audience. Creator Monetization Playbook: example.com/your-product</p><a href="https://www.threads.com/@seller/post/123">Time</a></article>');
    assert.equal(await findPostUrl(page, { platform: 'threads', text: 'Learn from your audience. Creator Monetization Playbook: https://example.com/your-product' }), null, 'A changed URL label must not match the full saved text');
  } finally { await browser.close(); }
});

test('engagement DOM reader separates incoming, outgoing, hidden and unknown messages', { skip: !executablePath }, async () => {
  const { default: puppeteer } = await import('puppeteer-core');
  const browser = await puppeteer.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <div data-message-id="1" data-is-outgoing="false" data-sender="reader"><span data-message-text>Where can I get this?</span></div>
      <div data-message-id="2" data-is-outgoing="true"><span data-message-text>Our previous response</span></div>
      <div data-message-id="3"><span data-message-text>Unknown direction</span></div>
      <div data-message-id="4" aria-label="Message from reader"><span data-message-text>A new question</span></div>
      <div style="display:none" data-message-id="5" data-is-outgoing="false" data-sender="reader">Hidden</div>
      <div contenteditable="true">Unsent draft</div>`);
    const messages = await page.evaluate(collectDmConversation);
    assert.deepEqual(messages.map(message => message.direction), ['incoming', 'outgoing', 'unknown', 'incoming']);
    assert.equal(messages.at(-1).id, '4');
    assert.equal(messages.at(-1).username, 'reader');
    assert.ok(!messages.some(message => message.text === 'Unsent draft'));
    await page.setContent(`<article><a href="https://www.threads.com/@owner/post/1">Owner</a><p data-lexical-text="true">Parent content</p>
      <article><a href="https://www.threads.com/@reader/post/2">Reader</a><p data-lexical-text="true">How do I choose a niche?</p></article>
      <button>12 replies</button><button style="display:none">900 likes</button></article>`);
    const items = publicItems(await page.evaluate(collectPublicMessages), 'threads');
    assert.equal(items.length, 2);
    assert.equal(items[0].text, 'Parent content');
    assert.equal(items[1].username, 'reader');
    assert.equal(items[1].text, 'How do I choose a niche?');
    assert.equal(items[0].metrics.comments, 12);
    assert.equal(items[0].metrics.likes, null);
    assert.equal(items[1].metrics.comments, null);
  } finally { await browser.close(); }
});

test('current Threads SVG counts and Facebook unmarked cards are scoped safely', { skip: !executablePath }, async () => {
  const puppeteer = require('puppeteer-core');
  const browser = await puppeteer.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<div data-pressable-container="true"><a href="https://www.threads.com/@reader/post/abc">Time</a><span data-lexical-text="true">Plan your teaching topics.</span><div role="button"><svg><title>Like</title></svg><span>1.2K</span></div><div role="button"><svg title="Reply"></svg><span>12</span></div><div role="button"><svg title="Like"></svg></div></div>');
    const items = publicItems(await page.evaluate(collectPublicMessages), 'threads');
    assert.equal(items[0].metrics.likes, 1200);
    assert.equal(items[0].metrics.comments, 12);
    await page.setContent('<div data-pagelet="threads_post_page_{n}"><div data-pressable-container="true"><a href="https://www.threads.com/@reader/post/reply">02/18/25</a><span data-lexical-text="true">How should I plan topics?</span></div></div>');
    const dated = await page.evaluate(collectPublicMessages);
    assert.equal(dated[0].publishedAt, Date.parse('02/18/25'));
    assert.equal(dated[0].discussionContainer, true);
    await page.setContent('<div role="dialog"><a href="https://www.facebook.com/notification/posts/99">Notification</a></div><div role="main"><div aria-posinset="1"><a href="https://www.facebook.com/reader">Reader</a><a href="https://www.facebook.com/reel/123">Time</a><div data-ad-preview="message">A specific teaching example.</div><div role="button" aria-label="Like: 349 people">349</div></div><div aria-posinset="2"><a href="https://www.facebook.com/other/posts/456">Time</a><div data-ad-preview="message">Another example.</div><button>10 comments</button></div></div>');
    const rows = await page.evaluate(collectPublicMessages);
    const research = publicItems(rows, 'facebook', '', true);
    assert.equal(research.length, 2);
    assert.equal(research[0].username, 'reader');
    assert.equal(research[0].metrics.likes, 349);
    assert.equal(research[1].metrics.comments, 10);
    assert.equal(publicItems(rows, 'facebook').length, 1, 'reels remain excluded from engagement collection');
    assert.ok(!research.some(i => i.url.includes('notification')));
  } finally { await browser.close(); }
});

test('discussion readiness accepts Facebook comments without post fields and identifies empty or blocked pages', { skip: !executablePath }, async () => {
  const puppeteer = require('puppeteer-core');
  const { publicPageState } = require('../src/engagement/product-browser-adapter');
  const browser = await puppeteer.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<main><div role="article" aria-label="Comment by Reader"><a href="https://www.facebook.com/reader">Reader</a><p>How can I plan educational posts?</p><a href="https://www.facebook.com/owner/posts/123?comment_id=456">Time</a></div></main>');
    assert.equal(await page.evaluate(publicPageState, true), 'ready');
    assert.equal(await page.evaluate(publicPageState, false), false);
    assert.equal(discussionItems(await page.evaluate(collectPublicMessages), 'facebook', { url: 'https://www.facebook.com/owner/posts/123', username: 'owner', text: 'Plan posts' }).length, 1);
    await page.setContent('<main><div role="article" aria-label="Comment by Reader 3 years ago"><a href="https://www.facebook.com/reader">Reader</a><p>How can I plan posts?</p></div></main>');
    assert.ok((await page.evaluate(collectPublicMessages))[0].publishedAt < Date.now() - 30 * 86400000, 'Old comments must not count as fresh evidence');
    await page.setContent('<main>No results for this search</main>');
    assert.equal(await page.evaluate(publicPageState), 'empty');
    await page.setContent('<main>Log in to continue</main>');
    assert.equal(await page.evaluate(publicPageState), 'login_required');
    await page.setContent('<main>Something went wrong. Try reloading.</main>');
    assert.equal(await page.evaluate(publicPageState), 'unavailable');
  } finally { await browser.close(); }
});

test('internal results panes scroll', { skip: !executablePath }, async () => {
  const puppeteer = require('puppeteer-core');
  const { scrollResearchResults } = require('../src/engagement/product-browser-adapter');
  const browser = await puppeteer.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<div role="main" style="height:300px;overflow-y:auto"><div style="height:2000px">Results</div></div>');
    assert.equal(await page.evaluate(scrollResearchResults), true);
    assert.ok(await page.evaluate(() => document.querySelector('[role="main"]').scrollTop > 0));
  } finally { await browser.close(); }
});
