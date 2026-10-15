// Keep metrics scoped to the published post, never the entire feed or its replies.
function canonicalPostUrl(raw, platform) {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    const host = url.hostname.toLowerCase().replace(/^www\./, '').replace(/^m\./, '');
    if (platform === 'threads' && ['threads.com', 'threads.net'].includes(host)) {
      const match = url.pathname.match(/^\/@([^/]+)\/post\/([\w-]+)\/?$/);
      return match ? `https://www.threads.com/@${match[1]}/post/${match[2]}` : null;
    }

    if (platform === 'facebook' && host === 'facebook.com') {
      const match = url.pathname.match(/^\/([^/]+)\/posts\/([\w.:-]+)\/?$/);
      if (match) return `https://www.facebook.com/${match[1]}/posts/${match[2]}`;
      if (url.pathname.match(/^\/photo(?:\.php)?\/?$/) && url.searchParams.get('fbid')) {
        return `https://www.facebook.com/photo/?fbid=${url.searchParams.get('fbid')}`;
      }
      const userPhotoMatch = url.pathname.match(/^\/([^/]+)\/photos\/(?:[a-zA-Z0-9.-]+\/)?(\d+)\/?$/);
      if (userPhotoMatch) {
        return `https://www.facebook.com/photo/?fbid=${userPhotoMatch[2]}`;
      }
      if (['/permalink.php', '/story.php'].includes(url.pathname)) {
        const storyFbid = url.searchParams.get('story_fbid');
        const id = url.searchParams.get('id');
        if (storyFbid && id && /^[\w.:-]+$/.test(storyFbid) && /^\d+$/.test(id)) {
          return `https://www.facebook.com/permalink.php?story_fbid=${storyFbid}&id=${id}`;
        }
        if (storyFbid && /^[\w.:-]+$/.test(storyFbid)) {
          return `https://www.facebook.com/permalink.php?story_fbid=${storyFbid}`;
        }
      }
    }

    if (platform === 'x' && ['x.com', 'twitter.com'].includes(host)) {
      const match = url.pathname.match(/^\/([^/]+)\/status\/(\d+)\/?$/);
      return match ? `https://x.com/${match[1]}/status/${match[2]}` : null;
    }

    if (platform === 'instagram' && host === 'instagram.com') {
      const match = url.pathname.match(/^(?:\/[^/]+)?\/(?:p|reel)\/([\w-]+)\/?$/);
      return match ? `https://www.instagram.com/p/${match[1]}/` : null;
    }
  } catch { /* Unknown URL is not a post identity. */ }
  return null;
}

function parseCount(raw) {
  const text = String(raw).trim();
  const match = text.match(/^(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?\s*([KMB])?$/i);
  if (!match || (match[2] && !match[3])) return null;
  const value = Number(match[1].replace(/,/g, '') + (match[2] || '')) * ({ k: 1000, m: 1000000, b: 1000000000 }[match[3]?.toLowerCase()] || 1);
  return Number.isSafeInteger(Math.round(value)) ? Math.round(value) : null;
}

function parseMetrics(labels) {
  const result = { views: null, likes: null, comments: null, shares: null };
  const names = { views: 'views?|impressions?', likes: 'likes?|reactions?', comments: 'comments?|replies|reply', shares: 'shares?|reposts?' };
  const number = '(\\d[\\d,.]*\\s*[KMB]?)';
  for (const [field, name] of Object.entries(names)) {
    const values = new Set();
    for (const label of labels) {
      // Anchored labels avoid interpreting prose such as "get 20K views" as metrics.
      const text = String(label).trim();
      const match = text.match(new RegExp(`^${number}\\s+(?:${name})(?:[.,])?$`, 'i')) || text.match(new RegExp(`^(?:${name})[:\\s]+${number}$`, 'i'));
      if (match) { const value = parseCount(match[1]); if (value !== null) values.add(value); }
    }
    // Conflicting labels are ambiguous, rather than evidence of the larger number.
    if (values.size === 1) result[field] = [...values][0];
  }
  return result;
}

// This function executes in the browser and must not depend on module closures.
function collectPostSnapshots() {
  const selector = 'article, [role="article"], [data-pressable-container="true"]';
  return Array.from(document.querySelectorAll(selector)).map(root => {
    const own = element => element.closest(selector) === root;
    const links = Array.from(root.querySelectorAll('a[href]')).filter(own).map(el => el.href);
    const textElements = Array.from(root.querySelectorAll('[data-ad-preview="message"], [data-lexical-text="true"]')).filter(own);
    // Exclude nested posts/replies from text matching as well as from counts.
    const clone = root.cloneNode(true);
    clone.querySelectorAll(selector).forEach(el => el.remove());
    const text = textElements.length ? textElements.map(el => el.innerText).join('\n') : clone.textContent;
    const labels = Array.from(root.querySelectorAll('button, [role="button"], a, [aria-label]')).filter(own).flatMap(el => {
      if (el.querySelector(selector)) return [];
      const accessible = el.getAttribute('aria-label') || '';
      return [accessible, el.innerText || '', ...accessible.split(/,\s+(?=\d)/)];
    });
    return { text: text || '', links, labels };
  });
}

function selectSnapshot(snapshots, post, url = null) {
  const normalize = value => value.replace(/\s+/g, ' ').trim();
  const clean = val => String(val || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const expected = normalize(post.text);
  if (!expected) return null;
  const cleanExpected = clean(expected);
  const matches = snapshots.filter(s => {
    const text = normalize(s.text);
    const cleanText = clean(text);
    const textMatches = text.includes(expected) || (cleanExpected && cleanText.includes(cleanExpected));
    return textMatches && (!url || s.links.some(link => canonicalPostUrl(link, post.platform) === url));
  });
  // Choose the smallest matching container; avoid a parent that also includes other posts.
  return matches.sort((a, b) => a.text.length - b.text.length)[0] || null;
}

async function findPostUrl(page, post) {
  let snapshots = await page.evaluate(collectPostSnapshots);
  let snapshot = selectSnapshot(snapshots, post);
  if (!snapshot && post.platform === 'threads') {
    snapshots = await page.evaluate(require('../platforms/threads/threads-post-evidence').collectThreadsEvidence, { text: post.text, username: post.username });
    if (snapshots.length !== 1) return null;
    snapshot = selectSnapshot(snapshots, post);
  }
  if (!snapshot) return null;
  const urls = [...new Set(snapshot.links.map(link => canonicalPostUrl(link, post.platform)).filter(Boolean))];
  if (post.platform === 'threads' && post.username && urls.some(url => new URL(url).pathname.split('/')[1].toLowerCase() !== '@' + post.username.replace(/^@/, '').toLowerCase())) return null;
  return urls.length === 1 ? urls[0] : null;
}

class BrowserMetricsReader {
  constructor({ browser } = {}) { this.browser = browser || require('../browser/browser-manager'); }
  async read(post) {
    const url = canonicalPostUrl(post.result?.postUrl, post.platform);
    if (!url) throw new Error('No supported published post URL; metrics unavailable');
    const method = { threads: 'getThreadsPage', facebook: 'getFacebookPage', x: 'getXPage', instagram: 'getInstagramPage' }[post.platform];
    const page = await this.browser[method]();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 35000 });
    await page.waitForSelector(post.platform === 'threads' ? 'a[href*="/post/"]' : 'article, [role="article"], [data-pressable-container="true"]', { timeout: 15000 });
    let snapshot;
    // SPA metrics often appear after the article shell. Give labels time to load.
    for (let attempt = 0; attempt < 3; attempt++) {
      const snapshots = await page.evaluate(collectPostSnapshots);
      if (post.platform === 'threads') snapshots.push(...await page.evaluate(require('../platforms/threads/threads-post-evidence').collectThreadsEvidence, { text: post.text, postUrl: url }));
      snapshot = selectSnapshot(snapshots, post, url);
      if (snapshot && parseMetrics(snapshot.labels).views !== null) break;
      if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 1000));
    }
    if (!snapshot) throw new Error('Published post could not be identified in the live page');
    return { ...parseMetrics(snapshot.labels), source: 'browser', postUrl: url };
  }
}
module.exports = { canonicalPostUrl, parseCount, parseMetrics, collectPostSnapshots, selectSnapshot, findPostUrl, BrowserMetricsReader };
