const { canonicalPostUrl, selectSnapshot } = require('../content/post-metrics');
function collectImagePosts() {
  const selector = 'article, [role="article"], [data-pressable-container="true"]';
  return [...document.querySelectorAll(selector)].map(root => {
    const own = element => element.closest(selector) === root;
    const clone = root.cloneNode(true); clone.querySelectorAll(selector).forEach(el => el.remove());
    const textElements = [...root.querySelectorAll('[data-ad-preview="message"], [data-lexical-text="true"]')].filter(own);
    const images = [...root.querySelectorAll('img')].filter(own).filter(img => {
      const box = img.getBoundingClientRect();
      return img.complete && img.naturalWidth >= 200 && img.naturalHeight >= 120 && box.width >= 100 && box.height >= 100 && !/profile picture|avatar/i.test(img.alt || '') && !img.closest('a[href*="photo.php?fbid="][aria-label*="profile" i]');
    }).map(img => ({ src: img.currentSrc || img.src, width: img.naturalWidth, height: img.naturalHeight }));
    return { text: textElements.length ? textElements.map(el => el.innerText).join('\n') : clone.textContent || '', links: [...root.querySelectorAll('a[href]')].filter(own).map(el => el.href), images };
  });
}
async function verifyImagePost(page, { text, platform, postUrl }, count = 1) {
  const url = canonicalPostUrl(postUrl, platform);
  if (!url) throw new Error('Image publication has no supported public permalink; review before retrying');
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 35000 });
  await page.waitForSelector('article, [role="article"], [data-pressable-container="true"]', { timeout: 15000 });
  for (let attempt = 0; attempt < 4; attempt++) {
    const snapshots = await page.evaluate(collectImagePosts);
    const post = selectSnapshot(snapshots, { text, platform }, url);
    if (post?.images?.length >= count) return { postUrl: url, verifiedMediaCount: post.images.length, mediaVerifiedAt: Date.now() };
    if (attempt < 3) await new Promise(resolve => setTimeout(resolve, 2000));
  }
  throw new Error('Submitted caption and image could not both be verified on the public post; review before retrying');
}
module.exports = { verifyImagePost, collectImagePosts };
