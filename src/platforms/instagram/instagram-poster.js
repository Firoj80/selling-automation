/**
 * src/platforms/instagram/instagram-poster.js
 * Automated public post publisher for Instagram Web.
 * Publishes image + caption posts via Puppeteer CDP.
 */

const CONFIG = require("../../../config");
const browserManager = require("../../browser/browser-manager");
const stateStore = require("../../storage/state-store");
const logger = require("../../logging/logger");

const { writeComposerText, assertComposerText } = require('../composer-text');
const { profilePermalinks, verifyVisualPublication } = require('../visual-publication');
const INSTAGRAM_CAPTION_SELECTOR = 'textarea[aria-label*="caption" i], [contenteditable="true"][aria-label*="caption" i], [role="dialog"] textarea, [role="dialog"] [contenteditable="true"][role="textbox"]';
class InstagramPoster {
  /**
   * Publishes post to Instagram Feed via CDP.
   */
  async publishPost(options = {}) {
    const isDryRun = options.dryRun !== undefined ? options.dryRun : CONFIG.DRY_RUN;
    const isPostingEnabled = options.postingEnabled !== undefined ? options.postingEnabled : CONFIG.POSTING_ENABLED;

    if (!options.mediaPaths || !options.mediaPaths.length) {
      throw new Error("Instagram posts require an image attachment; text-only publishing is not supported by Instagram");
    }
    if (options.mediaPaths.length !== 1) throw new Error('Instagram publisher currently supports exactly one prepared image');

    const postId = `ig_post_${Date.now()}`;
    const captionText = (options.text || "").trim();

    if (isDryRun || !isPostingEnabled) {
      logger.info(`[DRY_RUN] Instagram post simulated (Image + Caption: "${captionText.slice(0, 80)}...", ${options.mediaPaths.length} image(s))`);
      stateStore.recordActionTransition("OWN_POST", postId, "INIT", "SIMULATED", {
        platform: "instagram",
        mediaPaths: options.mediaPaths,
        captionLength: captionText.length,
        captionSnippet: captionText.slice(0, 80)
      });
      return { success: true, simulated: true, postId, text: captionText, mediaCount: options.mediaPaths.length, verifiedMediaCount: options.mediaPaths.length };
    }

    let submitted = false;
    try {
      if (CONFIG.APPROVAL_MODE) throw new Error('Approval mode prevents live publication');
      const username = options.username?.replace(/^@/, '');
      if (!username || !/^[\w.]+$/.test(username)) throw new Error('A configured Instagram username is required');
      if (!captionText) throw new Error('Instagram caption is required');
      const page = await browserManager.getInstagramPage();
      const before = new Set(await profilePermalinks(page, 'instagram', username));

      if (!page.url().includes("instagram.com")) {
        await page.goto(CONFIG.INSTAGRAM_HOME || "https://www.instagram.com/", {
          waitUntil: "domcontentloaded",
          timeout: 45000
        });
        await new Promise(r => setTimeout(r, 2000));
      }

      logger.info("[INSTAGRAM POSTER] Waiting for Create and the media composer...");
      let fileInput = await require('./open-composer').openInstagramComposer(page);

      logger.info(`[INSTAGRAM POSTER] Uploading image: ${options.mediaPaths[0]}...`);
      fileInput = await require('../composer-ready').waitForComposerReady(page, { platform: 'instagram', phase: 'media' });
      await fileInput.uploadFile(options.mediaPaths[0]);
      await new Promise(r => setTimeout(r, 3000));

      // Click each header action once, supporting modal and full-page composers.
      const clickHeaderAction = text => require('../composer-action').clickVisibleAction(page, text);

      // Step: Advance through "Next" button(s) until caption area or Share button is visible
      for (let step = 1; step <= 2; step++) {
        await new Promise(r => setTimeout(r, 1500));
        const readyStep = await require('./composer-step').waitForInstagramStep(page);
        if (readyStep === 'caption') {
          logger.info("[INSTAGRAM POSTER] Caption/Share screen reached");
          break;
        }

        logger.info(`[INSTAGRAM POSTER] Advancing through step ${step} (Next)...`);
        const nextClicked = await clickHeaderAction("Next");
        if (!nextClicked && step === 1) {
          throw new Error("Could not find 'Next' button after image selection");
        }
        await new Promise(r => setTimeout(r, 2000));
      }

      const captionBoxSelector = INSTAGRAM_CAPTION_SELECTOR;
      const captionBox = await require('../composer-ready').waitForComposerReady(page, { platform: 'instagram' });
      if (!captionBox) throw new Error('Instagram caption editor unavailable; submission blocked');
      await writeComposerText(page, captionBox, captionText);
      await assertComposerText(page, captionBox, captionText);
      await page.waitForFunction(() => [...document.images].some(img => img.src.startsWith('blob:') && img.complete && img.naturalWidth >= 200), { timeout: 15000 });

      // Step: Click "Share"
      logger.info("[INSTAGRAM POSTER] Submitting post (Share)...");
      await options.onSubmission?.();
      submitted = true;
      const shared = await clickHeaderAction("Share");
      if (!shared) throw new Error("Could not find 'Share' button on Instagram");

      // Wait for completion dialog ("Your post has been shared") or modal dismissal
      logger.info("[INSTAGRAM POSTER] Awaiting share completion...");
      await page.waitForFunction(() => {
        const bodyText = (document.body ? document.body.innerText : '').toLowerCase();
        return bodyText.includes('your post has been shared') || bodyText.includes('post shared') ||
          (!location.pathname.startsWith('/create/') && !document.querySelector('textarea[aria-label*="caption" i], [contenteditable="true"][aria-label*="caption" i]'));
      }, { timeout: 60000 });

      await new Promise(r => setTimeout(r, 3500));

      // Close modal if close button is present
      await page.evaluate(() => {
        const closeBtn = document.querySelector('svg[aria-label="Close"]')?.closest('button, div[role="button"]');
        if (closeBtn) closeBtn.click();
      }).catch(() => {});

      let evidence;
      for (let attempt = 0; attempt < 3 && !evidence; attempt++) {
        const candidates = (await profilePermalinks(page, 'instagram', username)).filter(url => !before.has(url));
        for (const postUrl of candidates.slice(0, 6)) {
          try { evidence = await verifyVisualPublication(page, { platform: 'instagram', text: captionText, username, postUrl, count: options.mediaPaths.length }); break; }
          catch (err) { logger.warn('[INSTAGRAM POSTER] Candidate verification: ' + err.message); }
        }
        if (!evidence && attempt < 2) await new Promise(resolve => setTimeout(resolve, 2000));
      }
      if (!evidence) throw new Error('No new Instagram post with the complete intended caption and image was verified');
      const postUrl = evidence.postUrl;

      logger.info("✅ Post published successfully on Instagram (Image + Caption)!");
      stateStore.recordActionTransition("OWN_POST", postId, "INIT", "VERIFIED_PUBLISHED", {
        platform: "instagram",
        publishedAt: new Date().toISOString(),
        mediaCount: options.mediaPaths.length,
        captionLength: captionText.length
      });
      stateStore.saveState();

      return {
        success: true,
        verified: true,
        postId,
        postUrl,
        text: captionText,
        mediaCount: options.mediaPaths.length,
        ...evidence
      };
    } catch (err) {
      logger.error(`Failed to publish post on Instagram: ${err.message}`);
      return { success: false, verified: false, submitted, reason: err.message };
    }
  }
}

const instagramPoster = new InstagramPoster();
module.exports = instagramPoster;
module.exports.instagramPoster = instagramPoster;
module.exports.InstagramPoster = InstagramPoster;
module.exports.publishInstagramPost = (opts) => instagramPoster.publishPost(opts);
module.exports.INSTAGRAM_CAPTION_SELECTOR = INSTAGRAM_CAPTION_SELECTOR;
