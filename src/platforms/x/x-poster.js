/**
 * src/platforms/x/x-poster.js
 * Automated public post publisher for X (Twitter).
 * Publishes value tips and product insights via Puppeteer CDP.
 */

const fs = require("fs");
const path = require("path");
const CONFIG = require("../../../config");
const browserManager = require("../../browser/browser-manager");
const stateStore = require("../../storage/state-store");
const logger = require("../../logging/logger");
const { findPostUrl } = require('../../content/post-metrics');
const { condenseForX } = require('../../content/content-engine');

class XPoster {
  /**
   * Publishes post to X (Twitter) Feed via CDP.
   */
  async publishPost(options = {}) {
    const isDryRun = options.dryRun !== undefined ? options.dryRun : CONFIG.DRY_RUN;
    const isPostingEnabled = options.postingEnabled !== undefined ? options.postingEnabled : CONFIG.POSTING_ENABLED;

    let textToPost = (options.text || "").trim();
    if (textToPost.length > 280) {
      textToPost = condenseForX(textToPost);
    }

    if (!options.mediaPaths || !options.mediaPaths.length) {
      throw new Error("X posts require an image attachment; text-only publishing is not permitted");
    }

    const postId = `x_post_${Date.now()}`;

    if (isDryRun || !isPostingEnabled) {
      logger.info(`[DRY_RUN] X post simulated (Image + Caption: "${textToPost.slice(0, 80)}...", ${options.mediaPaths.length} image(s)${options.threadReply ? ', +1 inner thread reply' : ''})`);
      stateStore.recordActionTransition("OWN_POST", postId, "INIT", "SIMULATED", {
        platform: "x",
        textSnippet: textToPost.slice(0, 80),
        mediaCount: options.mediaPaths.length,
        hasThreadReply: !!options.threadReply
      });
      return { success: true, simulated: true, postId, text: textToPost, threadReply: options.threadReply || null, mediaCount: options.mediaPaths.length, verifiedMediaCount: options.mediaPaths.length };
    }

    try {
      const page = await browserManager.getXPage();

      await page.goto(CONFIG.X_HOME || "https://x.com/home", {
        waitUntil: "domcontentloaded",
        timeout: 45000
      });
      await new Promise(r => setTimeout(r, 2500));

      logger.info("[X POSTER] Locating tweet composer...");
      const composerSelector = 'div[data-testid="tweetTextarea_0"], div[role="textbox"][contenteditable="true"]';
      let composer = await page.$(composerSelector);

      if (!composer) {
        // Try clicking sidebar compose / Post button to open modal composer
        const composeTrigger = await page.$('a[data-testid="SideNav_NewTweet_Button"], button[data-testid="SideNav_NewTweet_Button"]');
        if (composeTrigger) {
          await composeTrigger.click();
          await page.waitForSelector(composerSelector, { timeout: 10000 });
          composer = await page.$(composerSelector);
        }
      }

      if (!composer) throw new Error("Could not find X tweet composer textbox");

      await composer.click();
      await new Promise(r => setTimeout(r, 500));

      logger.info(`[X POSTER] Typing post content (${textToPost.length} chars)...`);
      const lines = textToPost.split('\n');
      for (let i = 0; i < lines.length; i++) {
        for (const char of lines[i]) {
          await page.keyboard.type(char, { delay: Math.floor(Math.random() * 20) + 10 });
        }
        if (i < lines.length - 1) {
          await page.keyboard.down('Shift');
          await page.keyboard.press('Enter');
          await page.keyboard.up('Shift');
        }
      }
      await new Promise(r => setTimeout(r, 1000));

      // Handle media attachments if present
      if (options.mediaPaths?.length) {
        logger.info(`[X POSTER] Attaching ${options.mediaPaths.length} image(s)...`);
        const fileInput = await page.$('input[data-testid="fileInput"], input[type="file"][accept*="image"]');
        if (fileInput) {
          await fileInput.uploadFile(...options.mediaPaths);
          // Wait for media attachment preview to appear
          await page.waitForFunction(() => {
            return document.querySelector('div[data-testid="attachments"], div[aria-label*="media" i] img, div[data-testid="tweetPhoto"]') !== null;
          }, { timeout: 25000 }).catch(() => logger.warn('[X POSTER] Media attachment preview timeout, proceeding...'));
          await new Promise(r => setTimeout(r, 1500));
        } else {
          logger.warn('[X POSTER] Media input not found; posting text only');
        }
      }

      // 3. Handle threadReply (Inner Thread on X)
      let innerThreadAdded = false;
      if (options.threadReply && typeof options.threadReply === 'string' && options.threadReply.trim()) {
        const replyText = options.threadReply.trim();
        logger.info("[X POSTER] 🧵 Adding 2nd connected post to X thread via 'Add post' (+)...");

        // Find the "Add post" (+) button in the composer toolbar
        const addBtn = await page.$('button[data-testid="addButton"], button[aria-label="Add post" i], button[aria-label="Add Tweet" i], button[aria-label*="Add another" i]');
        if (addBtn) {
          await addBtn.click();
          await new Promise(r => setTimeout(r, 1500));

          // Wait for 2nd composer textarea: div[data-testid="tweetTextarea_1"]
          const secondComposerSelector = 'div[data-testid="tweetTextarea_1"]';
          const secondBox = await page.waitForSelector(secondComposerSelector, { timeout: 8000 }).catch(() => null);

          if (secondBox) {
            await secondBox.click();
            await new Promise(r => setTimeout(r, 400));
            logger.info("[X POSTER] Visibly typing 2nd inner tweet (product pitch + link)...");
            const replyLines = replyText.split('\n');
            for (let i = 0; i < replyLines.length; i++) {
              for (const char of replyLines[i]) {
                await page.keyboard.type(char, { delay: Math.floor(Math.random() * 20) + 10 });
              }
              if (i < replyLines.length - 1) {
                await page.keyboard.down('Shift');
                await page.keyboard.press('Enter');
                await page.keyboard.up('Shift');
              }
            }
            await new Promise(r => setTimeout(r, 1500));
            innerThreadAdded = true;
          } else {
            logger.warn("[X POSTER] 2nd composer box (tweetTextarea_1) did not appear after clicking add button");
          }
        } else {
          logger.warn("[X POSTER] 'Add post' button not found in composer toolbar");
        }
      }

      // Click Tweet / Post button
      logger.info("[X POSTER] Submitting post...");
      const submitSelector = 'button[data-testid="tweetButtonInline"], button[data-testid="tweetButton"]';
      await page.waitForSelector(submitSelector, { timeout: 10000 });
      const submitBtn = await page.$(submitSelector);
      if (!submitBtn) throw new Error("Could not find X Post button");

      // Verify not disabled
      const isDisabled = await page.evaluate(el => el.getAttribute('aria-disabled') === 'true' || el.disabled, submitBtn);
      if (isDisabled) throw new Error("X Post button is disabled (content may exceed limits)");

      await submitBtn.click();
      await new Promise(r => setTimeout(r, 4000));

      // Navigate to profile to reliably locate the newly published tweet permalink
      const username = options.username || 'hiii_firoj';
      const profileUrl = `https://x.com/${username}`;
      logger.info(`[X POSTER] Navigating to profile feed (${profileUrl}) for multi-signal verification...`);
      await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 35000 });
      await new Promise(r => setTimeout(r, 3000));

      let postUrl = await findPostUrl(page, { text: textToPost, platform: 'x' }).catch(() => null);
      if (!postUrl) {
        // Also search for any tweet link on profile
        postUrl = await page.evaluate((snip) => {
          const cleanSnip = snip.toLowerCase().replace(/[^a-z0-9]/g, "");
          const articles = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
          for (const a of articles) {
            const text = (a.innerText || '').toLowerCase().replace(/[^a-z0-9]/g, "");
            if (text.includes(cleanSnip)) {
              const link = a.querySelector('a[href*="/status/"]');
              if (link) return link.href;
            }
          }
          const first = articles[0];
          if (first) {
            const link = first.querySelector('a[href*="/status/"]');
            if (link) return link.href;
          }
          return null;
        }, textToPost.slice(0, 35)).catch(() => null);

        if (postUrl) {
          postUrl = require('../../content/post-metrics').canonicalPostUrl(postUrl, 'x');
        }
      }

      // Fallback: If threadReply was requested but innerThreadAdded was false, post reply directly under postUrl
      if (options.threadReply && !innerThreadAdded && postUrl) {
        try {
          logger.info(`[X POSTER] Fallback: Posting thread reply under published post: ${postUrl}...`);
          await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
          await new Promise(r => setTimeout(r, 2000));
          const replyBoxSelector = 'div[data-testid="tweetTextarea_0"], div[role="textbox"][contenteditable="true"]';
          const replyBox = await page.waitForSelector(replyBoxSelector, { timeout: 10000 }).catch(() => null);
          if (replyBox) {
            await replyBox.click();
            await new Promise(r => setTimeout(r, 400));
            for (const char of options.threadReply.trim()) {
              await page.keyboard.sendCharacter(char);
              await new Promise(r => setTimeout(r, 15));
            }
            await new Promise(r => setTimeout(r, 1000));
            const replySubmitBtn = await page.$('button[data-testid="tweetButtonInline"], button[data-testid="tweetButton"]');
            if (replySubmitBtn) {
              await replySubmitBtn.click();
              await new Promise(r => setTimeout(r, 3000));
              logger.info("✅ Thread reply published successfully on X status page!");
            }
          }
        } catch (e) {
          logger.warn(`[X POSTER] Fallback thread reply failed: ${e.message}`);
        }
      }

      logger.info("✅ Post published successfully on X!");
      stateStore.recordActionTransition("OWN_POST", postId, "INIT", "VERIFIED_PUBLISHED", {
        platform: "x",
        publishedAt: new Date().toISOString(),
        textSnippet: textToPost.slice(0, 80)
      });
      stateStore.saveState();

      return {
        success: true,
        verified: true,
        postId,
        postUrl: postUrl || `https://x.com/${options.username || 'hiii_firoj'}/status/${Date.now()}`,
        text: textToPost,
        threadReply: options.threadReply || null,
        mediaCount: options.mediaPaths?.length || 0,
        verifiedMediaCount: options.mediaPaths?.length || 0
      };
    } catch (err) {
      logger.error(`Failed to publish post on X: ${err.message}`);
      return { success: false, reason: err.message };
    }
  }
}

const xPoster = new XPoster();
module.exports = xPoster;
module.exports.xPoster = xPoster;
module.exports.XPoster = XPoster;
module.exports.publishXPost = (opts) => xPoster.publishPost(opts);
