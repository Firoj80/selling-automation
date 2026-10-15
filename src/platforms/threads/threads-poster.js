/** Threads publisher for prepared product captions and images. */

const fs = require("fs");
const path = require("path");
const CONFIG = require("../../../config");
const browserManager = require("../../browser/browser-manager");
const stateStore = require("../../storage/state-store");
const logger = require("../../logging/logger");
const { findPostUrl } = require('../../content/post-metrics');

async function captureDiagnosticScreenshot(page, prefix) {
  try {
    const dir = path.join(CONFIG.LOGS_DIR || path.resolve(__dirname, "../../../logs"), "screenshots");
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const file = path.join(dir, `${prefix}_${Date.now()}.png`);
    await page.screenshot({ path: file });
    logger.info(`Saved diagnostic screenshot to: ${file}`);
    return file;
  } catch (e) {
    logger.warn(`Failed capturing diagnostic screenshot: ${e.message}`);
    return null;
  }
}

class ThreadsPoster {

  async verifyPostOnProfile(page, postText, username = null) {
    const activeUsername = username || CONFIG.THREADS_USERNAME || "";
    const profileUrl = activeUsername ? `https://www.threads.com/@${activeUsername}` : "https://www.threads.com";
    logger.info(`[THREADS POSTER] Navigating to profile feed (${profileUrl}) for multi-signal live post verification...`);
    try {
      await page.goto(profileUrl, { waitUntil: "domcontentloaded", timeout: 35000 });
      await new Promise(r => setTimeout(r, 2500));

      for (let attempt = 1; attempt <= 6; attempt++) {
        if (attempt === 3) {
          logger.info(`[THREADS POSTER] Attempt 3: Performing cache-busting reload on ${profileUrl} for newly indexed post...`);
          await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
          await new Promise(r => setTimeout(r, 2500));
        }

        const postUrl = await findPostUrl(page, { text: postText, platform: 'threads', username: activeUsername }).catch(() => null);
        if (postUrl) {
          logger.info('[THREADS POSTER] Verified complete caption and author permalink: ' + postUrl);
          return { verified: true, postUrl, reason: 'Verified complete caption and author permalink on profile' };
        }

        await page.evaluate(() => window.scrollBy({ top: 300, left: 0, behavior: "smooth" }));
        await new Promise(r => setTimeout(r, 2000));
      }

      return { verified: false, reason: `Post not found on @${activeUsername} profile feed DOM after submission` };
    } catch (err) {
      return { verified: false, reason: `Profile verification navigation failed: ${err.message}` };
    }
  }

  /**
   * Publishes a prepared caption and images on Threads.
   */
  async publishEngagingPost(options = {}) {
    const pillar = options.pillar || "product_value";
    const format = options.format || "MEDIA";

    // Captions and images are prepared by the content pipeline.

    let postText = (options.text || "").trim();
    if (options.dryRun === true || CONFIG.DRY_RUN || !CONFIG.POSTING_ENABLED) {
      return { success: true, simulated: true, text: postText, threadReply: options.threadReply || null };
    }
    if (postText.length > 450) {
      const truncated = postText.slice(0, 440);
      const lastSentence = truncated.lastIndexOf(".");
      const lastQuestion = truncated.lastIndexOf("?");
      const cutoff = Math.max(lastSentence, lastQuestion);
      postText = cutoff > 200 ? truncated.slice(0, cutoff + 1) : truncated.trim();
    }
    const ourPostId = `our_post_${Date.now()}`;

    stateStore.recordActionTransition("OWN_POST", ourPostId, "INIT", "PREPARING", {
      pillar,
      format,
      textSnippet: postText.slice(0, 60)
    });

    logger.info(`[THREADS POSTER] Preparing to publish post: Pillar=${pillar}, Format=${format}`, {
      pillar,
      format,
      textSnippet: postText.slice(0, 60)
    });

    if (!postText || !Array.isArray(options.mediaPaths) || !options.mediaPaths.length) throw new Error('Prepared caption and images are required');
    const mediaPaths = [...options.mediaPaths];

    const page = await browserManager.getThreadsPage();
    await page.bringToFront();

    // 2. Always ensure we are on Threads home, not on insights, an existing post, or comment thread
    const currentUrl = page.url();
    const isHome = /^https?:\/\/(www\.)?threads\.(com|net)\/?(\?.*)?$/i.test(currentUrl);
    if (!isHome) {
      logger.info(`[THREADS POSTER] Navigating from ${currentUrl} to Threads home...`);
      await page.goto(CONFIG.THREADS_HOME || "https://www.threads.com/", { waitUntil: "domcontentloaded", timeout: 45000 });
      await new Promise(r => setTimeout(r, 2500));
    }

    // 3. Click "New thread" button with hydration retry and multi-selector fallback
    let opened = null;
    for (let attempt = 1; attempt <= 10; attempt++) {
      // Check if composer dialog is already open
      const dialogOpen = await page.evaluate(() => {
        const dialog = document.querySelector('div[role="dialog"], [aria-modal="true"]');
        const textbox = dialog ? dialog.querySelector('div[contenteditable="true"]') : null;
        return !!(dialog && textbox);
      });
      if (dialogOpen) {
        opened = "composer_already_open";
        break;
      }

      opened = await page.evaluate(() => {
        // Strategy A: Interactive button/a/div matching "new thread" or "create"
        const candidates = [...document.querySelectorAll('button, div[role="button"], a')];
        const newThreadBtn = candidates.find(b => {
          const txt = (b.innerText || "").trim().toLowerCase();
          const aria = (b.getAttribute("aria-label") || "").trim().toLowerCase();
          const title = (b.getAttribute("title") || "").trim().toLowerCase();
          return (
            txt.includes("new thread") ||
            aria.includes("new thread") ||
            title.includes("new thread") ||
            aria === "create" ||
            aria === "create thread" ||
            aria === "create a thread" ||
            aria === "create a post" ||
            txt === "create"
          );
        });
        if (newThreadBtn) {
          newThreadBtn.click();
          return "clicked_new_thread";
        }

        // Strategy B: SVG icon with Create / New thread label
        const createIcons = [...document.querySelectorAll('svg')].filter(svg => {
          const aria = (svg.getAttribute("aria-label") || "").trim().toLowerCase();
          const title = (svg.querySelector("title")?.textContent || "").trim().toLowerCase();
          return (
            aria.includes("create") ||
            aria.includes("new thread") ||
            title.includes("create") ||
            title.includes("new thread")
          );
        });
        for (const icon of createIcons) {
          const parentBtn = icon.closest('button, div[role="button"], a');
          if (parentBtn) {
            parentBtn.click();
            return "clicked_create_icon";
          }
        }

        // Strategy C: Inline composer trigger ("What's new?") at top of home feed
        const inlineTrigger = document.querySelector('div[role="main"] [aria-placeholder*="What\'s new" i], div[role="main"] [placeholder*="What\'s new" i], div[role="main"] div[contenteditable="true"]');
        if (inlineTrigger) {
          inlineTrigger.click();
          return "clicked_inline_trigger";
        }

        return null;
      });

      if (opened) break;
      await new Promise(r => setTimeout(r, 1500));
    }

    if (!opened) {
      // Final check: did composer modal open anyway?
      const modalExists = await page.$('div[role="dialog"] [contenteditable="true"], [aria-modal="true"] [contenteditable="true"]');
      if (modalExists) {
        opened = "modal_detected";
      }
    }

    if (!opened) {
      stateStore.recordActionTransition("OWN_POST", ourPostId, "PREPARING", "FAILED", {
        reason: "Could not find New thread button in navigation"
      });
      await captureDiagnosticScreenshot(page, "own_post_new_thread_button_missing");
      throw new Error("Could not find 'New thread' button in Threads navigation");
    }

    stateStore.recordActionTransition("OWN_POST", ourPostId, "PREPARING", "OPENED", { pillar, format });
    await new Promise(r => setTimeout(r, 1500));

    // 4. If media assets exist, attach them via file input
    if (mediaPaths.length > 0) {
      logger.info(`[THREADS POSTER] Attaching ${mediaPaths.length} image(s) to composer...`);
      if (options.mediaPaths) {
        await require('../media-upload').attachImages(page, mediaPaths);
      } else {
      const fileInput = await page.$('input[type="file"]');
      if (fileInput) {
        await fileInput.uploadFile(...mediaPaths);
        // Wait for image upload and thumbnail rendering to complete
        logger.info("[THREADS POSTER] Waiting for image upload processing...");
        for (let waitSec = 0; waitSec < 10; waitSec++) {
          await new Promise(r => setTimeout(r, 1000));
          const isUploaded = await page.evaluate(() => {
            const hasImg = !!document.querySelector('div[role="dialog"] img, [aria-modal="true"] img');
            const isUploading = !!document.querySelector('[data-upload-state="uploading"], [aria-label*="loading" i]');
            return hasImg && !isUploading;
          });
          if (isUploaded) {
            logger.info("[THREADS POSTER] Media successfully mounted into composer.");
            break;
          }
        }
      } else {
        logger.warn("[THREADS POSTER] Could not find file input in composer; proceeding with text.");
      }
      }
    }

    // 5. Locate composer textbox strictly inside the active modal/dialog (never match page comment boxes)
    const textbox = await page.waitForSelector('div[role="dialog"] div[role="textbox"][contenteditable="true"], [aria-modal="true"] div[role="textbox"][contenteditable="true"], div[role="dialog"] [contenteditable="true"], [aria-modal="true"] [contenteditable="true"]', { timeout: 8000 });
    if (!textbox) {
      stateStore.recordActionTransition("OWN_POST", ourPostId, "OPENED", "FAILED", {
        reason: "Composer textbox did not open after clicking New thread"
      });
      throw new Error("Composer textbox did not open after clicking New thread");
    }

    // State Transition: TYPING
    stateStore.recordActionTransition("OWN_POST", ourPostId, "OPENED", "TYPING", { pillar, format });
    await textbox.focus();
    await new Promise(r => setTimeout(r, 400));
    // Clear any residual draft text completely
    await page.keyboard.down("Control");
    await page.keyboard.press("KeyA");
    await page.keyboard.up("Control");
    await page.keyboard.press("Backspace");
    await new Promise(r => setTimeout(r, 400));

    // 6. Type text visibly with human-like delays
    logger.info("[THREADS POSTER] Visibly typing post caption into composer...");
    for (const char of postText) {
      await page.keyboard.sendCharacter(char);
      await new Promise(r => setTimeout(r, Math.floor(Math.random() * 20) + 15));
    }

    await new Promise(r => setTimeout(r, 2000));

    // 6b. Native 2-Part Connected Thread: Add product details & link in second connected box
    if (options.threadReply && typeof options.threadReply === 'string' && options.threadReply.trim()) {
      const replyText = options.threadReply.trim();
      logger.info("[THREADS POSTER] 🧵 Adding 2nd connected post to thread via 'Add to thread'...");

      const addBtnHandle = await page.evaluateHandle(() => {
        const dialog = document.querySelector('div[role="dialog"], [aria-modal="true"]');
        if (!dialog) return null;
        const elements = Array.from(dialog.querySelectorAll('div[role="button"], button'));
        return elements.find(el => {
          const txt = (el.innerText || '').trim();
          const aria = (el.getAttribute('aria-label') || '').trim();
          return txt === 'Add to thread' || aria === 'Add to thread';
        }) || null;
      });

      if (addBtnHandle && addBtnHandle.asElement()) {
        const box = await addBtnHandle.boundingBox();
        if (box && box.width > 0 && box.height > 0) {
          await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        } else {
          await addBtnHandle.click();
        }

        const secondBoxAppeared = await page.waitForFunction(() => {
          const dialog = document.querySelector('div[role="dialog"], [aria-modal="true"]');
          if (!dialog) return false;
          const boxes = dialog.querySelectorAll('div[contenteditable="true"]');
          return boxes.length >= 2;
        }, { timeout: 8000 }).catch(() => null);

        if (secondBoxAppeared) {
          const secondBox = await page.evaluateHandle(() => {
            const dialog = document.querySelector('div[role="dialog"], [aria-modal="true"]');
            if (!dialog) return null;
            const boxes = dialog.querySelectorAll('div[contenteditable="true"]');
            return boxes[1] || null;
          });

          if (secondBox && secondBox.asElement()) {
            await secondBox.focus();
            await new Promise(r => setTimeout(r, 400));
            logger.info("[THREADS POSTER] Visibly typing 2nd inner thread (product pitch + link)...");
            for (const char of replyText) {
              await page.keyboard.sendCharacter(char);
              await new Promise(r => setTimeout(r, Math.floor(Math.random() * 20) + 15));
            }
            await new Promise(r => setTimeout(r, 1500));
          }
        } else {
          logger.warn("[THREADS POSTER] Second composer textbox did not appear after 'Add to thread' click; continuing with main thread.");
        }
      } else {
        logger.warn("[THREADS POSTER] Could not find 'Add to thread' button in modal dialog; continuing with main thread.");
      }
    }

    // State Transition: SUBMITTING
    stateStore.recordActionTransition("OWN_POST", ourPostId, "TYPING", "SUBMITTING", { pillar, format });
    logger.info("[THREADS POSTER] Submitting post via active composer Post button...");
    let postSubmitted = false;

    // Locate the Post button element handle in Puppeteer (must be in the composer modal with y > 200)
    const postHandle = await page.evaluateHandle(() => {
      const buttons = [...document.querySelectorAll('div[role="button"], button')];
      const matching = buttons.filter(b => {
        const txt = (b.innerText || "").trim().toLowerCase();
        const aria = (b.getAttribute("aria-label") || "").trim().toLowerCase();
        const isEnabled = !b.disabled && b.getAttribute("aria-disabled") !== "true";
        const r = b.getBoundingClientRect();
        return (txt === "post" || aria === "post") && isEnabled && r.y > 200 && r.width > 0;
      });
      return matching[matching.length - 1] || null;
    });

    if (postHandle && postHandle.asElement()) {
      logger.info("[THREADS POSTER] Found active Post button handle. Clicking via native mouse event...");
      const box = await postHandle.boundingBox();
      if (box && box.width > 0 && box.height > 0) {
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      } else {
        await postHandle.click();
      }
      postSubmitted = true;
    } else {
      // Fallback strategies
      for (let attempt = 0; attempt < 3; attempt++) {
        postSubmitted = await page.evaluate(() => {
          const buttons = [...document.querySelectorAll('div[role="button"], button')];
          const postBtns = buttons.filter(b => {
            const txt = (b.innerText || "").trim().toLowerCase();
            const isEnabled = !b.disabled && b.getAttribute("aria-disabled") !== "true";
            return txt === "post" && isEnabled;
          });
          const targetBtn = postBtns[postBtns.length - 1] || postBtns[0];
          if (targetBtn) {
            targetBtn.focus();
            targetBtn.click();
            return true;
          }
          return false;
        });
        if (postSubmitted) break;
        await new Promise(r => setTimeout(r, 1000));
      }
    }

    // State Transition: VERIFYING
    stateStore.recordActionTransition("OWN_POST", ourPostId, "SUBMITTING", "VERIFYING", { pillar, format });

    // 8. Strict Verification of Submission & Profile Presence
    let isModalDismissed = false;
    for (let check = 0; check < 20; check++) {
      await new Promise(r => setTimeout(r, 1000));
      const status = await page.evaluate(() => {
        const dialog = document.querySelector('div[role="dialog"], [aria-modal="true"]');
        const alert = document.querySelector('div[role="alert"], [data-toaster-view]');
        const alertText = alert ? (alert.innerText || "").toLowerCase() : "";
        const dialogText = dialog ? (dialog.innerText || "").toLowerCase() : "";

        // Strict error checks scoped only to the dialog and toast alerts (never searching entire public feed)
        const hasError = /\b(couldn'?t post|something went wrong|try again later|action blocked|rate limit)\b/i.test(alertText) ||
          (/\b(couldn'?t post|something went wrong|try again later|action blocked|rate limit)\b/i.test(dialogText) && !dialogText.includes("post"));

        // Composer modal is dismissed when the dialog is no longer in the DOM or hidden
        const isStillOpen = !!dialog && (dialog.offsetWidth > 0 || dialog.offsetHeight > 0);
        return { hasError, isStillOpen };
      });

      if (status.hasError) {
        break;
      }
      if (!status.isStillOpen) {
        isModalDismissed = true;
        break;
      }
    }

    // Give Threads backend a moment to process the newly submitted post
    if (isModalDismissed) {
      if (mediaPaths && mediaPaths.length > 0) {
        logger.info(`[THREADS POSTER] Monitoring in-flight media upload (${mediaPaths.length} attachments)...`);
        for (let upWait = 0; upWait < 15; upWait++) {
          const isStillUploading = await page.evaluate(() => {
            const text = (document.body.innerText || "").toLowerCase();
            const hasPostingToast = text.includes("posting...") || 
                                    text.includes("posting your thread") || 
                                    text.includes("finishing up") || 
                                    text.includes("uploading");
            const hasProgress = !!document.querySelector('[role="progressbar"], [data-upload-state="uploading"]');
            return hasPostingToast || hasProgress;
          });

          if (!isStillUploading) {
            logger.info(`[THREADS POSTER] In-flight media upload toast/progress cleared after ${upWait + 1}s.`);
            break;
          }
          await new Promise(r => setTimeout(r, 1000));
        }
        // Buffer for Threads server-side media transcoding and ingestion
        await new Promise(r => setTimeout(r, 4500));
      } else {
        await new Promise(r => setTimeout(r, 3500));
      }
    }

    if (!isModalDismissed) {
      stateStore.recordActionTransition("OWN_POST", ourPostId, "VERIFYING", "FAILED", {
        reason: "Composer modal failed to dismiss after Post click"
      });
      stateStore.recordActionTransition("OWN_POST", ourPostId, "FAILED", "DIAGNOSTIC", {
        reason: "Capturing diagnostic screenshot"
      });
      await captureDiagnosticScreenshot(page, "own_post_modal_stuck");
      await page.evaluate(() => {
        const buttons = [...document.querySelectorAll('div[role="button"], button')];
        const cancelBtn = buttons.find(b => ["cancel", "discard"].includes((b.innerText || "").trim().toLowerCase()));
        if (cancelBtn) cancelBtn.click();
      }).catch(() => {});
      await page.keyboard.press("Escape").catch(() => {});

      stateStore.recordOurPostAttemptFailure({
        pillar,
        format,
        reason: "Composer modal failed to dismiss after Post click",
        textSnippet: postText.slice(0, 50)
      });

      return {
        success: false,
        verified: false,
        reason: "Composer modal failed to dismiss after Post click",
        pillar,
        format
      };
    }

    // Secondary Strict Profile Feed Verification (Mandatory User Requirement)
    // Confirm the post actually rendered live on the authenticated profile feed DOM
    const profileVerify = await this.verifyPostOnProfile(page, postText, options.username);
    let mediaVerification = {};
    if (profileVerify.verified && options.mediaPaths?.length) {
      try { mediaVerification = await require('../verify-image-post').verifyImagePost(page, { text: postText, platform: 'threads', postUrl: profileVerify.postUrl }, options.mediaPaths.length); }
      catch (err) { profileVerify.verified = false; profileVerify.reason = err.message; }
    }

    if (!profileVerify.verified) {
      stateStore.recordActionTransition("OWN_POST", ourPostId, "VERIFYING", "FAILED", {
        reason: profileVerify.reason
      });
      stateStore.recordActionTransition("OWN_POST", ourPostId, "FAILED", "DIAGNOSTIC", {
        reason: "Capturing diagnostic screenshot"
      });

      logger.error(`[THREADS POSTER] Profile verification failed: ${profileVerify.reason}. Aborting state record.`);
      await captureDiagnosticScreenshot(page, "own_post_profile_missing");

      stateStore.recordOurPostAttemptFailure({
        pillar,
        format,
        reason: profileVerify.reason,
        textSnippet: postText.slice(0, 50)
      });

      // Smooth return to home feed
      await page.goto(CONFIG.THREADS_HOME, { waitUntil: "domcontentloaded", timeout: 35000 }).catch(() => {});

      return {
        success: false,
        verified: false,
        reason: profileVerify.reason,
        pillar,
        format
      };
    }

    // State Transition: VERIFIED_SUCCESS
    stateStore.recordActionTransition("OWN_POST", ourPostId, "VERIFYING", "VERIFIED_SUCCESS", {
      pillar,
      format,
      verificationReason: profileVerify.reason
    });

    logger.info(`[THREADS POSTER] Post submission verified on profile: ${profileVerify.reason}`);

    // 9. Record verified post into state
    stateStore.recordOurPost({
      id: ourPostId,
      text: postText,
      pillar,
      format,
      mediaCount: mediaPaths.length,
      mediaPaths,
      status: "VERIFIED_PUBLISHED",
      published: true,
      verifiedReason: profileVerify.reason,
      publishedAt: new Date().toISOString(),
      repliesTracked: [],
      threadReply: options.threadReply || null
    });

    if (format === "CAROUSEL") {
      stateStore.state.lastCarouselDate = new Date().toISOString();
    }

    stateStore.recordAction("OWN_POST_PUBLISHED", ourPostId, {
      pillar,
      format,
      mediaCount: mediaPaths.length,
      text: postText,
      verifiedReason: profileVerify.reason
    });
    stateStore.saveState();

    // Smooth return to home feed
    await page.goto(CONFIG.THREADS_HOME, { waitUntil: "domcontentloaded", timeout: 35000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 2000));

    logger.info(`✅ Successfully published & verified ${format} post on Threads [${pillar}]: "${postText.slice(0, 60)}..."`);
    return {
      success: true,
      live: true,
      verified: true,
      postId: ourPostId,
      postUrl: profileVerify.postUrl || null,
      ...mediaVerification,
      pillar,
      format,
      mediaCount: mediaPaths.length,
      text: postText
    };
  }
}

const threadsPoster = new ThreadsPoster();
module.exports = threadsPoster;
