/**
 * src/platforms/instagram/instagram-auth.js
 * Verifies that the existing browser session is authenticated on Instagram.
 * Does NOT automate login, does NOT ask for passwords, does NOT save credentials.
 */

const CONFIG = require("../../../config");
const browserManager = require("../../browser/browser-manager");
const logger = require("../../logging/logger");

async function checkInstagramAuth(options = { printResult: true }) {
  let browser = null;
  try {
    browser = await browserManager.connect();
    const page = await browserManager.getInstagramPage();

    if (!page.url().includes("instagram.com")) {
      await page.goto(CONFIG.INSTAGRAM_HOME || "https://www.instagram.com/", {
        waitUntil: "domcontentloaded",
        timeout: 60000
      });
      await new Promise(r => setTimeout(r, 2500));
    }

    const authInfo = await page.evaluate(() => {
      const url = location.href;
      const title = document.title || "";

      const hasLoginForm = Boolean(document.querySelector('input[name="username"], input[name="password"]'));
      const isLoginPage = url.includes("/accounts/login") || (hasLoginForm && !document.querySelector('svg[aria-label="New post"], svg[aria-label="Create"]'));
      const hasNavElements = Boolean(document.querySelector('svg[aria-label="Home"], svg[aria-label="New post"], svg[aria-label="Create"], svg[aria-label="Explore"], a[href*="/direct/inbox/"]'));

      const isAuthenticated = !isLoginPage && hasNavElements;

      return {
        url,
        title,
        isAuthenticated,
        hasNavElements,
        hasLoginForm
      };
    });

    if (options.printResult) {
      if (authInfo.isAuthenticated) {
        console.log("\n==============================================");
        console.log("            INSTAGRAM AUTHENTICATED");
        console.log("==============================================");
        console.log(`✓ CDP Connected: ${CONFIG.CDP_URL}`);
        console.log(`✓ Page URL     : ${authInfo.url}`);
        console.log("✓ Session      : Active authenticated account detected");
        console.log("==============================================\n");
      } else {
        console.log("\n==============================================");
        console.log("     INSTAGRAM AUTHENTICATION REQUIRED");
        console.log("==============================================");
        console.log("❌ Instagram session is not authenticated.");
        console.log("Please open instagram.com in your browser and log in manually, then retry.\n");
        console.log("==============================================\n");
      }
    }

    logger.info("Instagram auth check", { isAuthenticated: authInfo.isAuthenticated });
    return authInfo;
  } catch (err) {
    if (options.printResult) {
      console.error(`❌ Connection failed for Instagram: ${err.message}\n`);
    }
    logger.error("Instagram auth check failed", err);
    return {
      url: null,
      title: null,
      isAuthenticated: false,
      error: err.message
    };
  }
}

module.exports = {
  checkInstagramAuth
};
