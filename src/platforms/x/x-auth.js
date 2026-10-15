/**
 * src/platforms/x/x-auth.js
 * Verifies that the existing browser session is authenticated on X (Twitter).
 * Does NOT automate login, does NOT ask for passwords, does NOT save credentials.
 */

const CONFIG = require("../../../config");
const browserManager = require("../../browser/browser-manager");
const logger = require("../../logging/logger");

async function checkXAuth(options = { printResult: true }) {
  let browser = null;
  try {
    browser = await browserManager.connect();
    const page = await browserManager.getXPage();

    if (!page.url().includes("x.com") && !page.url().includes("twitter.com")) {
      await page.goto(CONFIG.X_HOME || "https://x.com/home", {
        waitUntil: "domcontentloaded",
        timeout: 60000
      });
      await new Promise(r => setTimeout(r, 2500));
    }

    const authInfo = await page.evaluate(() => {
      const url = location.href;
      const title = document.title || "";

      const isLoginPage = url.includes("/login") || url.includes("/i/flow/login") || title.toLowerCase().includes("log in to x") || title.toLowerCase().includes("sign in to x");
      const hasAccountSwitcher = Boolean(document.querySelector('div[data-testid="SideNav_AccountSwitcher_Button"], button[data-testid="SideNav_AccountSwitcher_Button"]'));
      const hasTweetButton = Boolean(document.querySelector('a[data-testid="SideNav_NewTweet_Button"], button[data-testid="tweetButtonInline"]'));
      const hasProfileNav = Boolean(document.querySelector('a[data-testid="AppTabBar_Profile_Link"]'));

      const isAuthenticated = !isLoginPage && (hasAccountSwitcher || hasTweetButton || hasProfileNav);

      return {
        url,
        title,
        isAuthenticated,
        hasAccountSwitcher,
        hasTweetButton,
        hasProfileNav
      };
    });

    if (options.printResult) {
      if (authInfo.isAuthenticated) {
        console.log("\n==============================================");
        console.log("             X (TWITTER) AUTHENTICATED");
        console.log("==============================================");
        console.log(`✓ CDP Connected: ${CONFIG.CDP_URL}`);
        console.log(`✓ Page URL     : ${authInfo.url}`);
        console.log("✓ Session      : Active authenticated account detected");
        console.log("==============================================\n");
      } else {
        console.log("\n==============================================");
        console.log("        X AUTHENTICATION REQUIRED");
        console.log("==============================================");
        console.log("❌ X session is not authenticated.");
        console.log("Please open x.com in your browser and log in manually, then retry.\n");
        console.log("==============================================\n");
      }
    }

    logger.info("X auth check", { isAuthenticated: authInfo.isAuthenticated });
    return authInfo;
  } catch (err) {
    if (options.printResult) {
      console.error(`❌ Connection failed for X: ${err.message}\n`);
    }
    logger.error("X auth check failed", err);
    return {
      url: null,
      title: null,
      isAuthenticated: false,
      error: err.message
    };
  }
}

module.exports = {
  checkXAuth
};
