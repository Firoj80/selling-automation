const { canonicalPostUrl, findPostUrl } = require('./post-metrics');
async function verifySavedPublication({ post, product }) {
  const browser = require('../browser/browser-manager');
  const username = product.seller.usernames?.[post.platform] || product.seller.username;
  const profiles = { threads: `https://www.threads.com/@${username}`, facebook: `https://www.facebook.com/${username}`, x: `https://x.com/${username}`, instagram: `https://www.instagram.com/${username}/` };
  const page = await (await browser.connect()).newPage();
  try {
  const urls = [];
  const saved = canonicalPostUrl(post.result?.postUrl, post.platform);
  if (saved) urls.push(saved);
  await page.goto(profiles[post.platform], { waitUntil: 'domcontentloaded', timeout: 35000 });
  await page.waitForSelector('a[href]', { timeout: 15000 });
  const match = await findPostUrl(page, { text: post.result?.text || post.publication?.text || post.text, platform: post.platform, username });
  if (match) urls.push(match);
  if (['x', 'instagram'].includes(post.platform)) {
    const links = await page.evaluate(() => [...document.querySelectorAll('a[href]')].map(a => a.href));
    urls.push(...links.map(link => canonicalPostUrl(link, post.platform)).filter(Boolean).slice(0, 6));
  }
  for (const postUrl of [...new Set(urls)]) {
    try {
      const input = { text: post.result?.text || post.publication?.text || post.text, platform: post.platform, username, postUrl };
      const evidence = ['x', 'instagram'].includes(post.platform)
        ? await require('../platforms/visual-publication').verifyVisualPublication(page, input)
        : await require('../platforms/verify-image-post').verifyImagePost(page, input);
      if (post.platform === 'threads' && (post.publication?.threadReply || post.threadReply)) await require('../platforms/threads/verify-product-reply').verifyProductReply(page, { postUrl, text: post.publication?.threadReply || post.threadReply, username });
      return { ...evidence, verified: true };
    } catch { /* A missing or ambiguous result never authorizes a resend. */ }
  }
  return null;
  } finally { await page.close().catch(() => {}); }
}
module.exports = { verifySavedPublication };
