const { canonicalPostUrl, parseMetrics } = require('../content/post-metrics');

function dmUrl(raw) {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || !['www.threads.com', 'threads.com'].includes(url.hostname) || url.port || url.username || url.password) return null;
    const match = url.pathname.match(/^\/messages\/t\/([\w-]+)\/?$/);
    return match ? `https://www.threads.com/messages/t/${match[1]}` : null;
  } catch { return null; }
}

// Read only visible post containers. Keep nested replies out of a parent's text.
function collectPublicMessages(context = {}) {
  const selector = 'article, [role="article"], [data-pressable-container="true"], [role="main"] [aria-posinset]';
  return Array.from(document.querySelectorAll(selector)).filter(root => root.getClientRects().length).map(root => {
    const own = el => el.closest(selector) === root;
    const links = Array.from(root.querySelectorAll('a[href]')).filter(own).map(el => el.href);
    const fields = Array.from(root.querySelectorAll('[data-ad-preview="message"], [data-lexical-text="true"]')).filter(own);
    const clone = root.cloneNode(true);
    clone.querySelectorAll(`${selector}, button, [role="button"], a, time`).forEach(el => el.remove());
    const labels = Array.from(root.querySelectorAll('button, [role="button"], a, [aria-label]')).filter(el => own(el) && el.getClientRects().length && !el.querySelector(selector)).flatMap(el => {
      const label = el.getAttribute('aria-label') || '';
      const icon = el.querySelector('svg title, svg[aria-label], svg[title]');
      const action = icon?.getAttribute('aria-label') || icon?.getAttribute('title') || icon?.textContent || '';
      const count = (el.innerText || '').trim();
      const explicit = /^(?:like|reply|repost|share)$/i.test(action) && /^\d[\d,.]*\s*[KMB]?$/i.test(count) ? `${count} ${action === 'Like' ? 'likes' : action}` : '';
      const people = label.match(/^(?:Like|Reactions?):\s*(\d[\d,.]*\s*[KMB]?)\s+people$/i);
      return [label, el.innerText || '', explicit, people ? `${people[1]} likes` : '', ...label.split(/,\s+(?=\d)/)];
    });
    const displayedDate = Array.from(root.querySelectorAll('a[href]')).filter(own).map(a => a.innerText.trim()).find(t => /^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(t));
    const time = root.querySelector('time[datetime]')?.getAttribute('datetime') || displayedDate;
    const age = (root.getAttribute('aria-label') || '').match(/(\d+)\s+(minutes?|hours?|days?|weeks?|months?|years?) ago$/i);
    const ageUnit = age?.[2].toLowerCase().replace(/s$/, '');
    const ageMs = age && Number(age[1]) * ({ minute: 60000, hour: 3600000, day: 86400000, week: 604800000, month: 2592000000, year: 31536000000 }[ageUnit] || 0);
    const authorLink = root.querySelector('[data-testid="User-Name"] a[href], h3 a[href], [role="heading"] a[href]') || Array.from(root.querySelectorAll('a[href]')).find(a => {
      try { const u = new URL(a.href); return /(^|\.)facebook\.com$/.test(u.hostname) && (/^\/[^/]+\/?$/.test(u.pathname) && !/^\/(search|reel|stories|watch|groups)\/?$/.test(u.pathname) || u.pathname === '/profile.php'); } catch { return false; }
    });
    const replyTo = (root.innerText || '').match(/(?:replying to|in reply to)\s+@([\w.]+)/i)?.[1] || null;
    return { links, labels, authorUrl: authorLink?.href || null, replyTo,
      discussionContainer: !!root.closest('[data-testid="replies"], [aria-label="Replies"], [aria-label="Comments"], [data-pagelet="threads_post_page_{n}"]'),
      publishedAt: time && Number.isFinite(Date.parse(time)) ? Date.parse(time) : ageMs ? Date.now() - ageMs : null,
      text: (fields.length ? fields.map(el => el.innerText).join('\n') : clone.textContent).trim() };
  }).filter(row => row.text);
}

// Direction must be explicit. Never infer it from bubble color or screen position.
function collectDmConversation() {
  const rows = Array.from(document.querySelectorAll('[data-message-id], [data-testid="message"]'));
  return rows.filter(row => row.getClientRects().length && !row.parentElement?.closest('[data-message-id], [data-testid="message"]')).map(row => {
    const label = row.getAttribute('aria-label') || '';
    const outgoing = row.getAttribute('data-is-outgoing');
    const direction = outgoing === 'true' || /^you (?:sent|said)/i.test(label) ? 'outgoing' : outgoing === 'false' || /^message from /i.test(label) ? 'incoming' : 'unknown';
    const username = row.getAttribute('data-sender') || label.match(/^message from @?([\w.]+)/i)?.[1] || '';
    const field = row.querySelector('[data-message-text], [data-testid="message-text"]');
    return { id: row.getAttribute('data-message-id') || row.id || '', direction, username,
      text: (field ? field.innerText : row.innerText || '').trim() };
  });
}

function publicItems(rows, platform, context = '', research = false) {
  const seen = new Set();
  return rows.flatMap(row => {
    const urls = [...new Set(row.links.map(link => research ? require('../knowledge/evidence-url').evidenceUrl(link, platform) : canonicalPostUrl(link, platform)).filter(Boolean))];
    if (urls.length !== 1 || seen.has(urls[0])) return [];
    // Facebook comment anchors need a distinct reply executor; never redirect them to a parent post.
    if (platform === 'facebook' && row.links.some(link => /[?&](?:comment_id|reply_comment_id)=/.test(link))) return [];
    const url = urls[0];
    const parsed = new URL(url);
    let username = platform === 'facebook' && parsed.pathname === '/permalink.php' ? parsed.searchParams.get('id') : parsed.pathname.split('/')[1].replace(/^@/, '');
    if (platform === 'facebook' && /^\/(reel|groups)\//.test(parsed.pathname)) {
      if (!row.authorUrl) return [];
      const author = new URL(row.authorUrl);
      username = author.pathname === '/profile.php' ? author.searchParams.get('id') : author.pathname.split('/')[1];
      if (!username || ['groups', 'reel', 'stories', 'search'].includes(username)) return [];
    }
    seen.add(url);
    return [{ kind: 'reply', platform, username, text: row.text, url, id: url, conversationId: url, context, source: 'post', direction: 'incoming', metrics: parseMetrics(row.labels || []), publishedAt: row.publishedAt ?? null, observedAt: Date.now() }];
  });
}

function scrollResearchResults() {
  const main = document.querySelector('main,[role="main"]');
  const candidates = main ? [main, ...main.querySelectorAll('div')].filter(e => e.getClientRects().length && e.clientHeight > 200 && e.scrollHeight > e.clientHeight + 40 && /auto|scroll/.test(getComputedStyle(e).overflowY)) : [];
  let ancestor = main?.parentElement;
  while (ancestor) {
    if (ancestor.clientHeight > 200 && ancestor.scrollHeight > ancestor.clientHeight + 40 && /auto|scroll/.test(getComputedStyle(ancestor).overflowY)) candidates.push(ancestor);
    ancestor = ancestor.parentElement;
  }
  const target = candidates.sort((a, b) => b.clientHeight - a.clientHeight)[0] || document.scrollingElement;
  if (!target) return false;
  const before = target.scrollTop;
  target.scrollTop += target.clientHeight * 0.85;
  return target.scrollTop > before;
}

function publicPageState(discussion = false) {
  if (!document.body) return false;
  const main = document.querySelector('main,[role="main"]');
  const text = main?.innerText || document.body.innerText || '';
  if (/log in to continue|log into facebook/i.test(text)) return 'login_required';
  if (/verify you are human|unusual activity|temporarily blocked/i.test(text)) return 'access_blocked';
  if (/no results|no posts found|nothing to see here/i.test(text)) return 'empty';
  if (/something went wrong|try reloading|page isn.t available|content isn.t available/i.test(text)) return 'unavailable';
  const visible = e => e.getClientRects().length;
  if (discussion && Array.from(document.querySelectorAll('[role="article"][aria-label^="Comment by"],[role="article"][aria-label^="Reply by"]')).some(visible)) return 'ready';
  if (discussion && /\/reel\//.test(location.pathname) && Array.from(document.querySelectorAll('video,[role="button"][aria-label*="comment" i]')).some(visible)) return 'ready';
  return Array.from(document.querySelectorAll('article,[role="article"],[data-pressable-container="true"],[role="main"] [aria-posinset]')).some(e => visible(e) && e.querySelector('[data-ad-preview="message"],[data-lexical-text="true"],a[href*="/post/"]')) ? 'ready' : false;
}

function discussionItems(rows, platform, parent) {
  const { evidenceUrl } = require('../knowledge/evidence-url');
  const seen = new Set();
  return rows.flatMap(row => {
    let items;
    if (platform === 'facebook') {
      const links = [...new Set(row.links.filter(link => /[?&](?:comment_id|reply_comment_id)=\d+/.test(link)).map(link => evidenceUrl(link, platform)).filter(Boolean))];
      if (links.length !== 1 || evidenceUrl(links[0].replace(/[?&]comment_id=\d+/, ''), platform) !== parent.url || !row.authorUrl) return [];
      let author; try { author = new URL(row.authorUrl); } catch { return []; }
      if (!['www.facebook.com', 'facebook.com', 'm.facebook.com'].includes(author.hostname)) return [];
      const username = author.pathname === '/profile.php' ? author.searchParams.get('id') : author.pathname.split('/').filter(Boolean)[0];
      if (!username || ['groups', 'posts', 'permalink.php'].includes(username)) return [];
      items = [{ kind: 'reply', platform, username, text: row.text, url: links[0], metrics: parseMetrics(row.labels || []), observedAt: Date.now(), publishedAt: row.publishedAt ?? null }];
    } else {
      if (!row.discussionContainer && row.conversationParent !== parent.url && row.replyTo?.toLowerCase() !== parent.username.toLowerCase().replace(/^@/, '')) return [];
      items = publicItems([row], platform);
    }
    return items.filter(item => item.url !== parent.url && !seen.has(item.url)).map(item => {
      seen.add(item.url);
      return { ...item, source: 'comment', direction: 'incoming', parentUrl: parent.url, context: parent.text, id: item.url, conversationId: parent.url };
    });
  });
}

class ProductBrowserAdapter {
  constructor({ campaign, browser, limiter, actions, dms } = {}) {
    this.campaign = campaign;
    this.browser = browser || require('../browser/browser-manager');
    this.limiter = limiter || require('../safety/rate-limiter');
    this.actions = actions;
    this.dms = dms;
    this.scanIndex = 0;
  }
  page(platform, research = false) {
    if (research && this.browser.getResearchPage) return this.browser.getResearchPage(platform);
    const method = { threads: 'getThreadsPage', facebook: 'getFacebookPage', instagram: 'getInstagramPage', x: 'getXPage' }[platform];
    if (!method || typeof this.browser[method] !== 'function') throw new Error(`Platform ${platform} does not support browser page access in adapter`);
    return this.browser[method]({ skipInitialNavigation: true });
  }
  async expandResearchText(page) {
    const controls = await page.$$('[role="main"] [data-ad-preview="message"] [role="button"], [role="main"] [data-ad-preview="message"] button');
    let expanded = 0;
    for (const control of controls) {
      if (expanded >= 6) break;
      if (await control.evaluate(e => e.getClientRects().length && /^See more$/i.test(e.innerText.trim())).catch(() => false)) {
        await control.click().catch(() => {});
        expanded++;
      }
    }
  }
  async readPublic(platform, url, context = '', research = false) {
    const page = await this.page(platform, research);
    await this.loadPublic(page, url);
    if (platform === 'facebook') {
      if (research) await this.expandResearchText(page);
      // Facebook initially masks timestamp permalinks as search URLs. Hover resolves them without clicking or sending anything.
      const links = await page.$$('[role="main"] [aria-posinset] a[href]');
      let resolved = 0;
      for (const link of links) {
        if (resolved >= 20) break;
        if (await link.evaluate(a => new URL(a.href).pathname === '/search/posts/').catch(() => false)) {
          await link.hover().catch(() => {});
          await new Promise(resolve => setTimeout(resolve, 250));
          resolved++;
        }
      }
    }
    return publicItems(await page.evaluate(collectPublicMessages), platform, context, research);
  }
  async loadPublic(page, url, { discussion = false } = {}) {

    for (let attempt = 0; attempt < 2; attempt++) {
      let navigationError;
      try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 35000 }); }
      catch (err) {
        navigationError = err;
        // Release a stuck navigation so subsequent DOM probes cannot hang behind it.
        let stopTimer;
        await Promise.race([
          (async () => { const session = await page.createCDPSession?.(); if (session) { try { await session.send('Page.stopLoading'); } finally { await session.detach(); } } })().catch(() => {}),
          new Promise(resolve => { stopTimer = setTimeout(resolve, 3000); })
        ]).finally(() => clearTimeout(stopTimer));
      }
      try {
        const handle = await page.waitForFunction(publicPageState, { timeout: 20000 }, discussion);
        const state = await handle?.jsonValue?.();
        await handle?.dispose?.();
        if (['login_required', 'access_blocked', 'unavailable'].includes(state)) {
          const error = new Error(`Public page reports ${state}: ${new URL(url).origin}${new URL(url).pathname}`);
          error.code = state.toUpperCase();
          throw error;
        }
        return;
      } catch (err) {
        if (['LOGIN_REQUIRED', 'ACCESS_BLOCKED'].includes(err.code)) throw err;
        if (attempt) {
          const failure = new Error(`Public page did not render readable posts after two attempts: ${navigationError?.message || err.message}`);
          failure.code = 'PUBLIC_PAGE_RENDER_FAILED';
          throw failure;
        }
      }
    }
  }
  async researchSearch(platform, query) {
    const q = encodeURIComponent(query);
    const url = { threads: `https://www.threads.com/search?q=${q}&serp_type=default`, facebook: `https://www.facebook.com/search/posts/?q=${q}` }[platform];
    if (!url) throw new Error('Unsupported research platform');
    const collected = new Map((await this.readPublic(platform, url, '', true)).map(item => [item.url, item]));
    const page = await this.page(platform, true);
    for (let pass = 0; pass < 2 && collected.size < 30; pass++) {
      await page.evaluate(scrollResearchResults);
      await new Promise(resolve => setTimeout(resolve, 1000));
      if (platform === 'facebook') {
        await this.expandResearchText(page);
        const links = await page.$$('[role="main"] [aria-posinset] a[href]');
        let hovered = 0;
        for (const link of links) {
          if (hovered >= 12) break;
          if (await link.evaluate(a => new URL(a.href).pathname === '/search/posts/').catch(() => false)) {
            await link.hover().catch(() => {});
            await new Promise(resolve => setTimeout(resolve, 250));
            hovered++;
          }
        }
      }
      for (const item of publicItems(await page.evaluate(collectPublicMessages), platform, '', true)) collected.set(item.url, item);
    }
    return [...collected.values()].slice(0, 30);
  }
  async researchDiscussion(parent) {
    if (require('../knowledge/evidence-url').evidenceUrl(parent.url, parent.platform) !== parent.url) throw new Error('Invalid public discussion parent');
    const page = await this.page(parent.platform, true);
    await this.loadPublic(page, parent.url, { discussion: true });
    if (parent.platform === 'facebook') {
      let rows = await page.evaluate(collectPublicMessages);
      if (!discussionItems(rows, parent.platform, parent).length) {
        const controls = await page.$$('[role="button"],button');
        for (const control of controls) {
          const open = await control.evaluate(e => {
            const label = e.getAttribute('aria-label') || '';
            const text = e.innerText.trim();
            return e.getClientRects().length && (/^(?:\d[\d,.]*\s*[KMB]?\s+)?comments$/i.test(label) || /^\d[\d,.]*\s*[KMB]?\s+comments$/i.test(text) || /^view (?:more|previous|all|\d+) comments?$/i.test(text));
          });
          if (open) { await control.click(); break; }
        }
        await page.waitForFunction(() => Array.from(document.querySelectorAll('[role="article"] a[href]')).some(a => /[?&](?:comment_id|reply_comment_id)=\d+/.test(a.href)), { timeout: 8000 }).catch(() => {});
      }
    }
    const comments = new Map();
    for (let pass = 0; pass < 3; pass++) {
      for (const item of discussionItems(await page.evaluate(collectPublicMessages, { parentUrl: parent.url }), parent.platform, parent)) comments.set(item.url, item);
      if (pass < 2 && comments.size < 20) { await page.evaluate(scrollResearchResults); await new Promise(resolve => setTimeout(resolve, 1000)); }
      else break;
    }
    return [...comments.values()].slice(0, 20);
  }
  async readDm(url) {
    const target = dmUrl(url);
    if (!target) throw new Error('Invalid Threads conversation URL');
    const page = await this.page('threads');
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 35000 });
    await page.waitForSelector('[data-message-id], [data-testid="message"]', { timeout: 10000 });
    const messages = await page.evaluate(collectDmConversation);
    const latest = messages.at(-1);
    if (!latest?.id || !latest.username || latest.direction !== 'incoming' || !latest.text) return null;
    return { ...latest, kind: 'dm', platform: 'threads', url: target, conversationId: target, source: 'conversation', context: messages.slice(-10, -1).map(m => `${m.direction}: ${m.text}`).join('\n') };
  }
  async scan(product, { activePlatform } = {}) {
    const items = [], errors = [], observations = [];
    const platformsToScan = activePlatform ? [activePlatform] : product.strategy.platforms;
    
    // Incoming conversations come first; at most three per cycle, rotating to prevent starvation.
    if (platformsToScan.includes('threads')) {
      try {
        const page = await this.page('threads');
        await page.goto('https://www.threads.com/messages', { waitUntil: 'domcontentloaded', timeout: 35000 });
        await page.waitForSelector('a[href*="/messages/t/"]', { timeout: 5000 }).catch(() => null);
        const links = await page.evaluate(() => Array.from(document.querySelectorAll('a[href*="/messages/t/"]')).map(a => a.href));
        const urls = [...new Set(links.map(dmUrl).filter(Boolean))];
        const offset = urls.length ? this.scanIndex % urls.length : 0;
        for (const url of [...urls.slice(offset), ...urls.slice(0, offset)].slice(0, 3)) {
          try { const item = await this.readDm(url); if (item) items.push(item); }
          catch (err) { errors.push({ platform: 'threads', kind: 'dm', reason: err.message }); }
        }
      } catch (err) { errors.push({ platform: 'threads', kind: 'dm', reason: err.message }); }
    }
    for (const platform of platformsToScan) {
      const posts = this.campaign.posts.filter(p => p.platform === platform && p.status === 'published' && p.result?.verified && p.result.postUrl).slice(-5);
      const own = posts.length ? posts[this.scanIndex % posts.length] : null;
      if (own) {
        try { items.push(...await this.readPublic(platform, own.result.postUrl, own.text)); }
        catch (err) { errors.push({ platform, kind: 'replies', reason: err.message }); }
      }
      const query = encodeURIComponent(product.product.key_topics[this.scanIndex % product.product.key_topics.length]);
      const searchUrl = { threads: `https://www.threads.com/search?q=${query}&serp_type=default`, facebook: `https://www.facebook.com/search/posts/?q=${query}` }[platform];
      if (searchUrl) {
        try {
          const found = await this.readPublic(platform, searchUrl);
          observations.push(...found.slice(0, 20).map(item => ({ ...item, topic: product.product.key_topics[this.scanIndex % product.product.key_topics.length] })));
          items.push(...found.slice(0, 3));
        }
        catch (err) { errors.push({ platform, kind: 'topics', reason: err.message }); }
      }
    }
    this.scanIndex++;
    const seen = new Set();
    const ownUrls = new Set(this.campaign.posts.filter(p => p.status === 'published').map(p => canonicalPostUrl(p.result?.postUrl, p.platform)).filter(Boolean));
    return { items: items.filter(item => { const key = `${item.platform}:${item.kind}:${item.id}`; if (seen.has(key) || (item.kind === 'reply' && ownUrls.has(item.url))) return false; seen.add(key); return true; }), observations: observations.filter(item => !ownUrls.has(item.url)), errors };
  }
  async verify(item) {
    const gate = this.limiter.canPerform(item.kind === 'dm' ? 'DM_REPLY' : 'NEW_POST_COMMENT', item.platform);
    if (!gate.allowed) return { valid: false, reason: gate.reason };
    if (item.kind === 'dm') {
      const latest = await this.readDm(item.url);
      return { valid: !!latest && latest.id === item.id && latest.username === item.username && latest.text === item.text, reason: 'Latest incoming message must still match' };
    }
    const url = canonicalPostUrl(item.url, item.platform);
    if (!url || url !== item.url) return { valid: false, reason: 'Invalid reply target URL' };
    const items = await this.readPublic(item.platform, url);
    return { valid: items.some(current => current.url === item.url && current.username === item.username && current.text === item.text), reason: 'Reply target must still match' };
  }
  async send(item, text) {
    let result;
    if (item.kind === 'dm') {
      if (item.platform !== 'threads' || !dmUrl(item.url)) throw new Error('Unsupported DM destination');
      const dms = this.dms || require('../platforms/threads/threads-dms');
      result = await dms.sendDirectMessage(item.url, text, { strictProductReply: true, expectedIncoming: item });
    } else {
      const actions = this.actions?.[item.platform] || require(`../platforms/${item.platform}/${item.platform}-actions`);
      const url = new URL(item.url);
      const postId = item.platform === 'facebook' && url.searchParams.has('story_fbid') ? url.searchParams.get('story_fbid') : url.pathname.split('/').pop();
      const post = { url: item.url, postId, username: item.username, text: item.text };
      // ProductReplyEngine already checks topic relevance; the legacy buyer/service
      // classifier would reject educational discussions that Phase 3 should answer.
      const options = { dryRun: false, postingEnabled: true, approvalMode: false, skipRecheck: true };
      result = await actions.postComment(post, text, options);
    }
    if (result?.success && result.verified && !result.simulated && !result.dryRun) this.limiter.recordAction(item.kind === 'dm' ? 'DM_REPLIED' : 'COMMENT_POSTED', item.platform, item.id);
    return result;
  }
}
module.exports = { ProductBrowserAdapter, collectPublicMessages, publicItems, discussionItems, collectDmConversation, dmUrl, publicPageState, scrollResearchResults };
