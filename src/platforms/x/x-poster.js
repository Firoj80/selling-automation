const CONFIG = require('../../../config');
const browserManager = require('../../browser/browser-manager');
const stateStore = require('../../storage/state-store');
const logger = require('../../logging/logger');
const { condenseForX } = require('../../content/content-engine');
const { canonicalPostUrl } = require('../../content/post-metrics');
const { writeComposerText, assertComposerText } = require('../composer-text');
const { collectVisualPublication, verifyVisualPublication, profilePermalinks } = require('../visual-publication');
function xMediaReady(count) {
  const dialog = document.querySelector('[role="dialog"] [data-testid="tweetTextarea_0"]')?.closest('[role="dialog"]');
  // The character counter is also a progressbar; only attachment progress matters.
  if (!dialog || dialog.querySelector('[data-testid="attachments"] [role="progressbar"]')) return false;
  return [...dialog.querySelectorAll('[data-testid="attachments"] img, [data-testid="tweetPhoto"] img')].filter(img => img.complete && img.naturalWidth >= 200).length >= count;
}
class XPoster {
  async publishPost(options = {}) {
    const text = condenseForX((options.text || '').trim());
    if (!text) throw new Error('X caption is required');
    if (!options.mediaPaths?.length) throw new Error('X posts require an image attachment');
    const postId = `x_post_${Date.now()}`;
    if ((options.dryRun ?? CONFIG.DRY_RUN) || !(options.postingEnabled ?? CONFIG.POSTING_ENABLED)) return { success: true, simulated: true, postId, text, threadReply: options.threadReply || null, mediaCount: options.mediaPaths.length, verifiedMediaCount: options.mediaPaths.length };
    let submitted = false;
    try {
      const { product } = require('../../content/product-config').loadProduct(CONFIG.ROOT_DIR);
      if (!require('../../content/publishing-settings').publishingEnabled(product, 'x')) throw new Error('X publishing is disabled in product settings');
      if (CONFIG.APPROVAL_MODE) throw new Error('Approval mode prevents live publication');
      const username = options.username?.replace(/^@/, '');
      if (!username || !/^[\w]+$/.test(username)) throw new Error('A configured X username is required');
      const page = await browserManager.getXPage();
      const before = new Set(await profilePermalinks(page, 'x', username));
      await page.goto('https://x.com/compose/post', { waitUntil: 'domcontentloaded', timeout: 35000 });
      const editor = await require('../composer-ready').waitForComposerReady(page, { platform: 'x' });
      await writeComposerText(page, editor, text);
      const root = '[role="dialog"]';
      const input = await page.$(`${root} input[data-testid="fileInput"], ${root} input[type="file"][accept*="image"]`);
      if (!input) throw new Error('X image file input not found; submission blocked');
      await input.uploadFile(...options.mediaPaths);
      await page.waitForFunction(xMediaReady, { timeout: 30000 }, options.mediaPaths.length);
      let replyEditor;
      if (options.threadReply?.trim()) {
        const add = await page.$(`${root} button[data-testid="addButton"]`);
        if (!add) throw new Error('X Add post button unavailable; submission blocked');
        await add.click();
        replyEditor = await require('../composer-ready').waitForComposerReady(page, { platform: 'x', editorIndex: 1 });
        await writeComposerText(page, replyEditor, options.threadReply.trim());
      }
      await assertComposerText(page, editor, text);
      if (replyEditor) await assertComposerText(page, replyEditor, options.threadReply.trim());
      const submit = await page.$(`${root} button[data-testid="tweetButton"]`);
      if (!submit || await page.evaluate(el => el.disabled || el.getAttribute('aria-disabled') === 'true', submit)) throw new Error('X Post button is unavailable or disabled');
      logger.info(`[X POSTER] Submitting verified caption (${text.length} chars) and ${options.mediaPaths.length} image(s)`);
      await options.onSubmission?.();
      submitted = true;
      await submit.click();
      await page.waitForFunction(() => !document.querySelector('[role="dialog"] [data-testid="tweetTextarea_0"]'), { timeout: 30000 });
      for (let attempt = 0; attempt < 3; attempt++) {
        const candidates = (await profilePermalinks(page, 'x', username)).filter(url => !before.has(url) && new URL(url).pathname.split('/')[1].toLowerCase() === username.toLowerCase());
        for (const postUrl of candidates.slice(0, 6)) {
          try {
            const evidence = await verifyVisualPublication(page, { platform: 'x', text, username, postUrl, count: options.mediaPaths.length });
            if (options.threadReply) {
              const replies = await page.evaluate(collectVisualPublication, { platform: 'x', text: options.threadReply.trim(), username });
              if (!replies.some(e => e.links.some(link => canonicalPostUrl(link, 'x') && canonicalPostUrl(link, 'x') !== postUrl))) throw new Error('Connected reply was not verified');
            }
            stateStore.recordActionTransition('OWN_POST', postId, 'SUBMITTED', 'VERIFIED_PUBLISHED', { platform: 'x', postUrl });
            return { success: true, verified: true, postId, text, threadReply: options.threadReply || null, mediaCount: options.mediaPaths.length, ...evidence };
          } catch (err) { logger.warn('[X POSTER] Candidate verification: ' + err.message); }
        }
        if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 2000));
      }
      throw new Error('No new X post with the complete intended caption and image was verified');
    } catch (err) {
      logger.error('[X POSTER] ' + err.message);
      return { success: false, verified: false, submitted, reason: err.message };
    }
  }
}
const xPoster = new XPoster();
module.exports = xPoster;
module.exports.xPoster = xPoster;
module.exports.XPoster = XPoster;
module.exports.publishXPost = options => xPoster.publishPost(options);
module.exports.xMediaReady = xMediaReady;
