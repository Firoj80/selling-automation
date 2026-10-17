/**
 * src/platforms/facebook/facebook-poster.js
 * Automated public post publisher for Facebook Profile.
 * Publishes prepared product captions and images via CDP.
 */

const fs = require("fs");
const path = require("path");
const CONFIG = require("../../../config");
const browserManager = require("../../browser/browser-manager");
const stateStore = require("../../storage/state-store");
const logger = require("../../logging/logger");
const { findPostUrl } = require('../../content/post-metrics');

class FacebookPoster {
  /**
   * Publishes prepared content to the Facebook profile.
   */
  async publishPost(options = {}) {
    const isDryRun = options.dryRun !== undefined ? options.dryRun : CONFIG.DRY_RUN;
    const isPostingEnabled = options.postingEnabled !== undefined ? options.postingEnabled : CONFIG.POSTING_ENABLED;

    const textToPost = (options.text || "").trim();

    if (!options.mediaPaths || !options.mediaPaths.length) {
      throw new Error("Facebook posts require an image attachment; text-only publishing is not permitted");
    }

    if (!textToPost) throw new Error('Prepared caption is required');
    const postId = `fb_post_${Date.now()}`;

    if (isDryRun || !isPostingEnabled) {
      logger.info(`[DRY_RUN] Facebook post simulated (Image + Caption: "${textToPost.slice(0, 80)}...", ${options.mediaPaths.length} image(s))`);
      stateStore.recordActionTransition("OWN_POST", postId, "INIT", "SIMULATED", {
        platform: "facebook",
        textSnippet: textToPost.slice(0, 80),
        mediaCount: options.mediaPaths.length
      });
      return { success: true, simulated: true, postId, text: textToPost, mediaCount: options.mediaPaths.length, verifiedMediaCount: options.mediaPaths.length };
    }

    let submitted = false;
    try {
      const page = await browserManager.getFacebookPage();
      
      // Navigate to the home feed instead of the profile (often simpler and avoids audience prompts)
      await page.goto("https://www.facebook.com/", {
        waitUntil: "domcontentloaded",
        timeout: 45000
      });
      await new Promise(r => setTimeout(r, 2500));

      logger.info("[FACEBOOK POSTER] Clicking 'What's on your mind?' post creator...");
      let postTrigger = await page.$("div[role='button'][tabindex='0'][aria-label*='mind' i], div[aria-label*='Create a post' i]");
      if (postTrigger) {
        await postTrigger.click();
      } else {
        const clicked = await page.evaluate(() => {
          const els = Array.from(document.querySelectorAll('span, div[role="button"]'));
          const target = els.find(el => el.innerText && (el.innerText.match(/What's on your mind/i) || el.innerText.match(/Create Post/i)));
          if (target) { target.click(); return true; }
          // Hard fallback: just find the first thing that looks like a post entry box on a profile
          const fallback = document.querySelector('div[role="region"][aria-label="Create a post"] div[role="button"]');
          if (fallback) { fallback.click(); return true; }
          return false;
        });
        if (!clicked) throw new Error("Could not find 'What's on your mind?' post creator trigger on Facebook profile");
      }
      
      await new Promise(r => setTimeout(r, 2000));

      const composer = await require('../composer-ready').waitForComposerReady(page, { platform: 'facebook' });
      await require('../composer-text').writeComposerText(page, composer, textToPost);

      if (options.mediaPaths?.length) {
        logger.info(`[FACEBOOK POSTER] Attaching ${options.mediaPaths.length} prepared image(s)...`);
        await require('../composer-ready').waitForComposerReady(page, { platform: 'facebook' });
        await require('../media-upload').attachImages(page, options.mediaPaths);
      }

      await require('../composer-text').assertComposerText(page, composer, textToPost);

      // Find Post button inside modal and handle Next -> Post flows
      logger.info("[FACEBOOK POSTER] Submitting post (handling Next/Post steps)...");
      for (let attempt = 0; attempt < 8; attempt++) {
        const handle = await page.evaluateHandle(() => {
          const dialogs = [...document.querySelectorAll('[role="dialog"]')].filter(el => el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0);
          const scope = dialogs[dialogs.length - 1];
          if (!scope) return null;
          return [...scope.querySelectorAll('button, [role="button"]')].find(el => {
            const text = (el.innerText || el.getAttribute('aria-label') || '').trim().toLowerCase();
            return ['next', 'post', 'publish'].includes(text) && !el.disabled && el.getAttribute('aria-disabled') !== 'true' && el.getBoundingClientRect().width > 0;
          }) || null;
        });
        const button = handle.asElement();
        if (!button) { await handle.dispose(); await new Promise(resolve => setTimeout(resolve, 1000)); continue; }
        const action = await page.evaluate(el => (el.innerText || el.getAttribute('aria-label') || '').trim().toLowerCase(), button);
        try {
          if (action !== 'next') { await options.onSubmission?.(); submitted = true; }
          await button.click();
        } finally { await handle.dispose(); }
        if (submitted) break;
        await new Promise(resolve => setTimeout(resolve, 1500));
      }
      if (!submitted) throw new Error('Facebook Post button was unavailable; nothing was submitted');

      logger.info("[FACEBOOK POSTER] Form submitted, awaiting confirmation...");
      await new Promise(r => setTimeout(r, 5000));

      // Verify the composer modal is closed
      await page.waitForFunction(() => {
        return !document.querySelector('div[role="dialog"] [contenteditable="true"]');
      }, { timeout: 15000 });

      // Navigate to the user's authenticated profile feed where own posts appear chronologically
      const username = options.username || 'hiiifiroj';
      const profileUrl = `https://www.facebook.com/${username}`;
      logger.info(`[FACEBOOK POSTER] Navigating to profile feed (${profileUrl}) for multi-signal live post verification...`);
      await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 35000 });
      await new Promise(r => setTimeout(r, 3000));

      const snippet = textToPost.replace(/https?:\/\/[^\s]+/g, "").slice(0, 35).trim();
      let postUrl = null;

      for (let attempt = 1; attempt <= 6; attempt++) {
        if (attempt === 3) {
          await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
          await new Promise(r => setTimeout(r, 2500));
        }

        const found = await page.evaluate((snip) => {
          const cleanSnip = snip.toLowerCase().replace(/[^a-z0-9]/g, "");
          const text = (document.body.innerText || "").toLowerCase().replace(/[^a-z0-9]/g, "");
          return text.includes(cleanSnip);
        }, snippet);

        if (found) {
          logger.info(`[FACEBOOK POSTER] ✅ Post verified present on ${profileUrl} DOM (attempt ${attempt}/6)!`);
          postUrl = await findPostUrl(page, { text: textToPost, platform: 'facebook' }).catch(() => null);
          if (!postUrl) {
            // Also search for any post/photo link near the snippet
            const foundUrl = await page.evaluate((snip) => {
              const cleanSnip = snip.toLowerCase().replace(/[^a-z0-9]/g, "");
              const anchors = Array.from(document.querySelectorAll('a[href*="/posts/"], a[href*="/photo/?fbid="], a[href*="/photo.php?fbid="], a[href*="story_fbid="]'));
              for (const a of anchors) {
                let p = a;
                for (let i = 0; i < 8; i++) {
                  if (!p) break;
                  const c = (p.innerText || '').toLowerCase().replace(/[^a-z0-9]/g, "");
                  if (c.includes(cleanSnip)) return a.href;
                  p = p.parentElement;
                }
              }
              return null;
            }, snippet);
            if (foundUrl) {
              postUrl = require('../../content/post-metrics').canonicalPostUrl(foundUrl, 'facebook');
            }
          }
          if (postUrl) break;
        }

        await page.evaluate(() => window.scrollBy({ top: 400, left: 0, behavior: "smooth" }));
        await new Promise(r => setTimeout(r, 2000));
      }

      if (options.mediaPaths?.length && !postUrl) {
        throw new Error('Image post submitted but its public post URL could not be verified; review the Facebook profile before retrying');
      }

      const mediaVerification = await require('../verify-image-post').verifyImagePost(page, { text: textToPost, platform: 'facebook', postUrl }, options.mediaPaths.length);

      logger.info("✅ Post published successfully on Facebook public profile!");
      stateStore.recordActionTransition("OWN_POST", postId, "INIT", "VERIFIED_PUBLISHED", {
        platform: "facebook",
        publishedAt: new Date().toISOString(),
        textSnippet: textToPost.slice(0, 80)
      });
      stateStore.saveState();

      return { success: true, verified: true, postId, postUrl, text: textToPost, mediaCount: options.mediaPaths?.length || 0, ...mediaVerification };
    } catch (err) {
      logger.error(`Failed to publish post on Facebook: ${err.message}`);
      return { success: false, verified: false, submitted, reason: err.message };
    }
  }
}

const facebookPoster = new FacebookPoster();
module.exports = facebookPoster;
module.exports.facebookPoster = facebookPoster;
module.exports.FacebookPoster = FacebookPoster;
module.exports.publishFacebookPost = (opts) => facebookPoster.publishPost(opts);
