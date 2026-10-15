const { canonicalPostUrl } = require('../content/post-metrics');
// Browser-side evidence. Never accept a confirmation toast or an unrelated post.
function collectVisualPublication({ platform, text, username, postUrl }) {
  const normalize = value => String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  const expected = normalize(text), author = username.replace(/^@/, '').toLowerCase();
  if (platform === 'instagram') {
    const identity = raw => { try { const u = new URL(raw); if (!['www.instagram.com', 'instagram.com'].includes(u.hostname)) return null; const m = u.pathname.match(/^(?:\/[^/]+)?\/(?:p|reel)\/([\w-]+)\/?$/); return m ? `https://www.instagram.com/p/${m[1]}/` : null; } catch { return null; } };
    const found = [];
    for (const caption of document.querySelectorAll('h1, span')) {
      if (!caption.getClientRects().length || normalize(caption.innerText) !== expected) continue;
      for (let root = caption.parentElement; root && !['BODY', 'HTML'].includes(root.tagName); root = root.parentElement) {
        const links = [...root.querySelectorAll('a[href]')];
        const ids = new Set(links.map(a => identity(a.href)).filter(Boolean));
        if (ids.size > 1) break;
        if (!ids.has(postUrl)) continue;
        const owner = links.some(a => new URL(a.href).pathname.replace(/^\//, '').replace(/\/$/, '').toLowerCase() === author);
        const images = [...root.querySelectorAll('img')].filter(img => { const r = img.getBoundingClientRect(); return img.complete && img.naturalWidth >= 200 && img.naturalHeight >= 120 && r.width >= 100 && r.height >= 100 && !/profile picture|avatar/i.test(img.alt || ''); });
        if (owner && images.length) { found.push({ images: images.length, links: [postUrl] }); break; }
      }
    }
    return found;
  }
  const roots = platform === 'x' ? document.querySelectorAll('article[data-testid="tweet"]') : document.querySelectorAll('article, [role="dialog"]');
  return [...roots].flatMap(root => {
    if (!root.getClientRects().length) return [];
    const caption = platform === 'x' ? root.querySelector('[data-testid="tweetText"]') : root.querySelector('h1');
    if (!caption || normalize(caption.innerText) !== expected) return [];
    const authorLink = [...root.querySelectorAll('a[href]')].some(a => {
      try { const u = new URL(a.href); return u.pathname.replace(/^\//, '').replace(/\/$/, '').toLowerCase() === author; } catch { return false; }
    });
    if (!authorLink) return [];
    const images = [...root.querySelectorAll(platform === 'x' ? '[data-testid="tweetPhoto"] img' : 'img')].filter(img => {
      if (platform === 'x' && postUrl && !img.closest('a[href]')?.href.startsWith(postUrl + '/photo/')) return false;
      const rect = img.getBoundingClientRect();
      return img.complete && img.naturalWidth >= 200 && img.naturalHeight >= 120 && rect.width >= 100 && rect.height >= 100 && !/avatar|profile picture/i.test(img.alt || '');
    });
    const time = root.querySelector('time[datetime]');
    return [{ images: images.length, publishedAt: time ? Date.parse(time.dateTime) : null,
      links: [...root.querySelectorAll('a[href]')].map(a => a.href) }];
  });
}
async function verifyVisualPublication(page, { platform, text, username, postUrl, count = 1 }) {
  const url = canonicalPostUrl(postUrl, platform);
  if (!url) throw new Error('No observed public permalink; publication requires review');
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 35000 });
  await page.waitForFunction((kind) => !!document.querySelector(kind === 'x' ? 'article[data-testid="tweet"] [data-testid="tweetText"]' : 'main, article, [role="dialog"]'), { timeout: 15000 }, platform);
  for (let attempt = 0; attempt < 4; attempt++) {
    const evidence = await page.evaluate(collectVisualPublication, { platform, text, username, postUrl: url });
    if (evidence.some(e => e.images >= count && (platform !== 'x' || e.links.some(link => canonicalPostUrl(link, platform) === url)))) {
      return { postUrl: url, verifiedMediaCount: count, mediaVerifiedAt: Date.now() };
    }
    if (attempt < 3) await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error('Complete caption, author and image were not verified together; publication requires review');
}
async function profilePermalinks(page, platform, username) {
  const profile = platform === 'x' ? `https://x.com/${username}` : `https://www.instagram.com/${username}/`;
  await page.goto(profile, { waitUntil: 'networkidle2', timeout: 35000 });
  const links = await page.evaluate(() => [...document.querySelectorAll('a[href]')].map(a => a.href));
  return [...new Set(links.map(link => canonicalPostUrl(link, platform)).filter(Boolean))];
}
module.exports = { collectVisualPublication, verifyVisualPublication, profilePermalinks };
