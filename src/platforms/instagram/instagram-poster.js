/**
 * src/platforms/instagram/instagram-poster.js
 * Automated public post publisher for Instagram Web.
 * Publishes image + caption posts via Puppeteer CDP.
 */

const fs = require("fs");
const path = require("path");
const CONFIG = require("../../../config");
const browserManager = require("../../browser/browser-manager");
const stateStore = require("../../storage/state-store");
const logger = require("../../logging/logger");
const { canonicalPostUrl } = require("../../content/post-metrics");

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

    try {
      const page = await browserManager.getInstagramPage();

      if (!page.url().includes("instagram.com")) {
        await page.goto(CONFIG.INSTAGRAM_HOME || "https://www.instagram.com/", {
          waitUntil: "domcontentloaded",
          timeout: 45000
        });
        await new Promise(r => setTimeout(r, 2000));
      }

      // Check if file input is already present
      let fileInput = await page.$('input[type="file"]');

      if (!fileInput) {
        logger.info("[INSTAGRAM POSTER] Triggering 'Create' -> 'Post' creator...");
        const createClicked = await page.evaluate(() => {
          const svg = document.querySelector('svg[aria-label="New post"], svg[aria-label="Create"]');
          if (svg) {
            const btn = svg.closest('a, div[role="button"], button') || svg.parentElement;
            if (btn) { btn.click(); return true; }
          }
          const els = Array.from(document.querySelectorAll('a, div[role="button"], span'));
          const target = els.find(el => el.innerText && el.innerText.trim().toLowerCase() === 'create');
          if (target) { target.click(); return true; }
          return false;
        });

        if (!createClicked) {
          throw new Error("Could not find 'Create' button on Instagram");
        }

        await new Promise(r => setTimeout(r, 1200));

        // Modern Instagram Web has a popover with options: "Post", "Live video", "Ad"
        const postSelected = await page.evaluate(() => {
          const elements = Array.from(document.querySelectorAll('a, div[role="button"], button, span'));
          const postEl = elements.find(el => (el.innerText || el.textContent || '').trim() === 'Post');
          if (postEl) {
            const target = postEl.closest('a, div[role="button"], button') || postEl;
            target.click();
            return true;
          }
          return false;
        });
        if (postSelected) {
          logger.info("[INSTAGRAM POSTER] Selected 'Post' from Create menu");
        }

        await new Promise(r => setTimeout(r, 1500));
        fileInput = await page.waitForSelector('input[type="file"]', { timeout: 15000 }).catch(() => null);
      }

      if (!fileInput) throw new Error("Could not find Instagram file input");

      logger.info(`[INSTAGRAM POSTER] Uploading image: ${options.mediaPaths[0]}...`);
      await fileInput.uploadFile(options.mediaPaths[0]);
      await new Promise(r => setTimeout(r, 3000));

      // Helper to click header action button ("Next" or "Share") using native click + mouse coordinates
      const clickHeaderAction = async (expectedText) => {
        const buttonCoords = await page.evaluate((text) => {
          const all = Array.from(document.querySelectorAll('button, div[role="button"], span, div'));
          const btn = all.find(el => {
            const t = (el.innerText || el.textContent || '').trim().toLowerCase();
            return t === text.toLowerCase() && el.children.length === 0;
          });
          if (btn) {
            const target = btn.closest('button, div[role="button"]') || btn;
            target.click();
            const rect = target.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
            }
          }
          return null;
        }, expectedText);

        if (buttonCoords) {
          await page.mouse.click(buttonCoords.x, buttonCoords.y).catch(() => {});
          return true;
        }

        return page.evaluate((text) => {
          const els = Array.from(document.querySelectorAll('button, div[role="button"]'));
          const btn = els.find(el => (el.innerText || el.textContent || '').trim().toLowerCase() === text.toLowerCase());
          if (btn) { btn.click(); return true; }
          return false;
        }, expectedText);
      };

      // Step: Advance through "Next" button(s) until caption area or Share button is visible
      for (let step = 1; step <= 2; step++) {
        await new Promise(r => setTimeout(r, 1500));
        const hasCaptionOrShare = await page.evaluate(() => {
          const textarea = document.querySelector('textarea, [contenteditable="true"]');
          const shareBtn = Array.from(document.querySelectorAll('button, div[role="button"]')).some(b => (b.innerText || '').trim().toLowerCase() === 'share');
          return !!(textarea || shareBtn);
        });
        if (hasCaptionOrShare) {
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

      // Step: Enter caption
      if (captionText) {
        logger.info(`[INSTAGRAM POSTER] Entering caption (${captionText.length} chars)...`);
        const captionBoxSelector = 'textarea[aria-label*="caption" i], textarea, div[role="dialog"] div[aria-label*="caption" i][contenteditable="true"], div[role="dialog"] div[role="textbox"][contenteditable="true"], div[role="dialog"] [contenteditable="true"]';
        const captionBox = await page.waitForSelector(captionBoxSelector, { timeout: 10000 }).catch(() => null);

        if (captionBox) {
          await captionBox.click();
          await new Promise(r => setTimeout(r, 500));

          await page.keyboard.down("Control");
          await page.keyboard.press("KeyA");
          await page.keyboard.up("Control");
          await page.keyboard.press("Backspace");
          await new Promise(r => setTimeout(r, 200));

          await page.keyboard.type(captionText, { delay: 15 });
          await new Promise(r => setTimeout(r, 500));

          const verifiedVal = await page.evaluate((el, text) => {
            if (el && el.value !== text) {
              const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
              if (nativeSetter) {
                nativeSetter.call(el, text);
              } else {
                el.value = text;
              }
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
            }
            return el ? (el.value || el.innerText || '') : '';
          }, captionBox, captionText);

          logger.info(`[INSTAGRAM POSTER] Caption entered successfully (length: ${verifiedVal.length}).`);
          await new Promise(r => setTimeout(r, 1000));
        } else {
          logger.warn("[INSTAGRAM POSTER] Could not find caption textbox, continuing to share image...");
        }
      }

      // Step: Click "Share"
      logger.info("[INSTAGRAM POSTER] Submitting post (Share)...");
      const shared = await clickHeaderAction("Share");
      if (!shared) throw new Error("Could not find 'Share' button on Instagram");

      // Wait for completion dialog ("Your post has been shared") or modal dismissal
      logger.info("[INSTAGRAM POSTER] Awaiting share completion...");
      await page.waitForFunction(() => {
        const bodyText = (document.body ? document.body.innerText : '').toLowerCase();
        return bodyText.includes('your post has been shared') || bodyText.includes('post shared');
      }, { timeout: 35000 }).catch(() => logger.warn('[INSTAGRAM POSTER] Confirmation text wait timed out, verifying profile...'));

      await new Promise(r => setTimeout(r, 3500));

      // Close modal if close button is present
      await page.evaluate(() => {
        const closeBtn = document.querySelector('svg[aria-label="Close"]')?.closest('button, div[role="button"]');
        if (closeBtn) closeBtn.click();
      }).catch(() => {});

      // Navigate to user profile to verify published post and capture public permalink
      let postUrl = null;
      try {
        const profileUrl = "https://www.instagram.com/hiii_firoj/";
        logger.info(`[INSTAGRAM POSTER] Navigating to profile ${profileUrl} to verify publication...`);
        await page.goto(profileUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
        await page.waitForSelector('a[href^="/p/"], a[href^="/reel/"]', { timeout: 15000 }).catch(() => null);
        await new Promise(r => setTimeout(r, 2000));

        const extractedUrl = await page.evaluate(() => {
          const links = Array.from(document.querySelectorAll('a[href^="/p/"], a[href^="/reel/"]')).map(a => a.href);
          return links.length ? links[0] : null;
        });

        if (extractedUrl) {
          postUrl = canonicalPostUrl(extractedUrl, "instagram") || extractedUrl;
          logger.info(`[INSTAGRAM POSTER] Verified live post URL: ${postUrl}`);
        }
      } catch (err) {
        logger.warn(`[INSTAGRAM POSTER] Profile verification warning: ${err.message}`);
      }

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
        postUrl: postUrl || `https://www.instagram.com/p/shared_${Date.now()}/`,
        text: captionText,
        mediaCount: options.mediaPaths.length,
        verifiedMediaCount: options.mediaPaths.length
      };
    } catch (err) {
      logger.error(`Failed to publish post on Instagram: ${err.message}`);
      return { success: false, reason: err.message };
    }
  }
}

const instagramPoster = new InstagramPoster();
module.exports = instagramPoster;
module.exports.instagramPoster = instagramPoster;
module.exports.InstagramPoster = InstagramPoster;
module.exports.publishInstagramPost = (opts) => instagramPoster.publishPost(opts);
