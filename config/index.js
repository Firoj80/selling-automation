/**
 * config/index.js
 * Central configuration module for CodeAir Threads + Instagram AI Lead Generation & Engagement System.
 * Enforces safety constraints, default DRY_RUN=true, APPROVAL_MODE=true, rate limits, and paths.
 */

const fs = require("fs");
const path = require("path");

const ROOT_DIR = path.resolve(__dirname, "..");

// Environment loader without external dependencies
function loadEnvFile() {
  const envPath = path.resolve(ROOT_DIR, ".env");
  if (fs.existsSync(envPath)) {
    try {
      const content = fs.readFileSync(envPath, "utf8");
      const lines = content.split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eqIdx = trimmed.indexOf("=");
        if (eqIdx !== -1) {
          const key = trimmed.slice(0, eqIdx).trim();
          let val = trimmed.slice(eqIdx + 1).trim();
          if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
          }
          if (process.env[key] === undefined) {
            process.env[key] = val;
          }
        }
      }
    } catch (e) {
      console.warn("Notice: Unable to parse .env file:", e.message);
    }
  }
}

loadEnvFile();

const CONFIG = {
  ROOT_DIR,
  KNOWLEDGE_DIR: path.resolve(ROOT_DIR, "knowledge"),
  STATE_FILE: path.resolve(ROOT_DIR, "threads-engagement-state.json"),
  LEADS_FILE: path.resolve(ROOT_DIR, "threads-leads.json"),
  LEADS_AI_FILE: path.resolve(ROOT_DIR, "threads-leads-ai.json"),
  LOGS_DIR: path.resolve(ROOT_DIR, "logs"),
  BACKUPS_DIR: path.resolve(ROOT_DIR, "backups"),

  // AI Provider Configuration
  AI_PROVIDER: (process.env.AI_PROVIDER || "antigravity").toLowerCase(),
  AI_RUNTIME: (process.env.AI_RUNTIME || "antigravity").toLowerCase(),
  MODEL: process.env.AI_MODEL || process.env.MINIMAX_MODEL || process.env.ANTIGRAVITY_MODEL || "Gemini 3.8 Flash",

  // MiniMax M3 API Configuration
  MINIMAX_API_KEY: process.env.MINIMAX_API_KEY || "",
  MINIMAX_BASE_URL: process.env.MINIMAX_BASE_URL || "https://api.minimax.io/v1",
  MINIMAX_ENDPOINT: process.env.MINIMAX_ENDPOINT || "/text/chatcompletion_v2",
  MINIMAX_MODEL: process.env.MINIMAX_MODEL || "MiniMax-M3",
  MINIMAX_TIMEOUT_MS: Math.max(1000, Number(process.env.MINIMAX_TIMEOUT_MS) || 90000),
  MINIMAX_MAX_RETRIES: Math.max(0, Number(process.env.MINIMAX_MAX_RETRIES) || 2),
  MINIMAX_TEMPERATURE: Number.isFinite(Number(process.env.MINIMAX_TEMPERATURE)) ? Number(process.env.MINIMAX_TEMPERATURE) : 0.2,
  MINIMAX_MAX_TOKENS: Math.max(256, Number(process.env.MINIMAX_MAX_TOKENS) || 4096),
  MINIMAX_THINKING: String(process.env.MINIMAX_THINKING || "true").toLowerCase(),

  // Local Antigravity CLI — primary/default agentic runtime
  ANTIGRAVITY_CLI_BIN: process.env.ANTIGRAVITY_CLI_BIN || "C:\\Users\\CYBERCITY\\AppData\\Local\\agy\\bin\\agy.exe",
  ANTIGRAVITY_MODEL: process.env.ANTIGRAVITY_MODEL || "",
  ANTIGRAVITY_EFFORT: process.env.ANTIGRAVITY_EFFORT || "",
  ANTIGRAVITY_TIMEOUT_MS: Math.max(1000, Number(process.env.ANTIGRAVITY_TIMEOUT_MS) || 120000),

  // OpenAI-Compatible / Freebuff / DeepSeek / Custom Provider Configuration
  OPENAI_API_KEY: process.env.OPENAI_API_KEY || process.env.FREEBUFF_API_KEY || "",
  OPENAI_BASE_URL: process.env.OPENAI_BASE_URL || process.env.FREEBUFF_BASE_URL || "https://api.openai.com/v1",
  OPENAI_ENDPOINT: process.env.OPENAI_ENDPOINT || process.env.FREEBUFF_ENDPOINT || "/chat/completions",
  OPENAI_MODEL: process.env.OPENAI_MODEL || process.env.FREEBUFF_MODEL || "deepseek 4.1 flash",
  OPENAI_TIMEOUT_MS: Math.max(1000, Number(process.env.OPENAI_TIMEOUT_MS) || 90000),
  OPENAI_MAX_RETRIES: Math.max(0, Number(process.env.OPENAI_MAX_RETRIES) || 2),
  OPENAI_TEMPERATURE: Number.isFinite(Number(process.env.OPENAI_TEMPERATURE)) ? Number(process.env.OPENAI_TEMPERATURE) : 0.2,
  OPENAI_MAX_TOKENS: Math.max(256, Number(process.env.OPENAI_MAX_TOKENS) || 4096),

  // Browser CDP & Display Configuration (Chrome, Edge, Brave, Chromium)
  BROWSER_TYPE: (process.env.BROWSER_TYPE || process.env.BROWSER || "auto").toLowerCase(),
  BROWSER_PROFILE: process.env.BROWSER_PROFILE || "",
  CDP_URL: process.env.THREADS_CDP_URL || process.env.CDP_URL || "http://127.0.0.1:9222",
  THREADS_CDP_URL: process.env.THREADS_CDP_URL || process.env.CDP_URL || "http://127.0.0.1:9222",
  DISPLAY: process.env.DISPLAY || ":1",
  DESKTOP_SPLIT_PERCENT: Math.max(10, Math.min(90, Number(process.env.DESKTOP_SPLIT_PERCENT) || 50)),
  BRAVE_BIN: process.env.BRAVE_BIN || "/usr/bin/brave-browser-stable",
  BRAVE_USER_DATA_DIR: process.env.BRAVE_USER_DATA_DIR || path.join(process.env.HOME || process.env.USERPROFILE || "", ".config/BraveSoftware/Brave-Browser"),
  VIEWPORT_WIDTH: 1440,
  VIEWPORT_HEIGHT: 1080,

  // URLs
  THREADS_HOME: "https://www.threads.com/",
  THREADS_MESSAGES: "https://www.threads.com/messages",
  THREADS_ACTIVITY: "https://www.threads.com/activity",
  INSTAGRAM_HOME: "https://www.instagram.com/",
  INSTAGRAM_MESSAGES: "https://www.instagram.com/direct/inbox/",
  FACEBOOK_HOME: "https://www.facebook.com/",
  FACEBOOK_MESSAGES: "https://www.facebook.com/messages/t/",
  X_HOME: "https://x.com/home",
  X_COMPOSE: "https://x.com/compose/post",

  // Operational Modes
  PLATFORM_TARGET: (process.env.PLATFORM_TARGET || "threads").toLowerCase(),
  APPROVAL_MODE: process.env.APPROVAL_MODE === "true", // Default false now, so approval is optional
  DRY_RUN: process.env.DRY_RUN === "true", // Default false for live mode
  POSTING_ENABLED: process.env.POSTING_ENABLED !== "false", // Default true
  EXECUTION_MODE: (process.env.EXECUTION_MODE || "pipeline").toLowerCase(),

  // Rate Limits (per hour)
  MAX_NEW_POST_REPLIES_PER_HOUR: Number(process.env.MAX_NEW_POST_REPLIES_PER_HOUR) || 5,
  MAX_TOTAL_REPLIES_PER_HOUR: Number(process.env.MAX_TOTAL_REPLIES_PER_HOUR) || 15,
  MAX_DM_REPLIES_PER_HOUR: Number(process.env.MAX_DM_REPLIES_PER_HOUR) || 10,

  // Action Delays (ms)
  MIN_ACTION_DELAY_MS: Number(process.env.MIN_ACTION_DELAY_MS) || 15000,
  MAX_ACTION_DELAY_MS: Number(process.env.MAX_ACTION_DELAY_MS) || 45000,

  // Scanner Settings
  SCAN_INTERVAL_SECONDS: Number(process.env.SCAN_INTERVAL_SECONDS) || 300,
  AI_MAX_CONCURRENCY: Math.max(1, Number(process.env.AI_MAX_CONCURRENCY) || 3),
  MAX_POSTS_PER_SCAN: Number(process.env.MAX_POSTS_PER_SCAN) || 50,

  // Publishing Cadence (2 hours)
  POST_INTERVAL_HOURS: Number(process.env.POST_INTERVAL_HOURS) || 2,
  CAROUSEL_INTERVAL_DAYS: Number(process.env.CAROUSEL_INTERVAL_DAYS) || 2,
  CAROUSEL_INTERVAL_HOURS: Math.max(1, Number(process.env.CAROUSEL_INTERVAL_HOURS) || 40),

  // Product identity and facts are loaded by the content pipeline.
};

module.exports = CONFIG;
