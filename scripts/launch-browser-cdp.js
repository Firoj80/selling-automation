/**
 * scripts/launch-browser-cdp.js
 * Launches browser (Microsoft Edge, Chrome, Brave) with Chrome DevTools Protocol (CDP) on port 9222.
 * Preserves user profile, extensions, and logged-in accounts across sessions.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { spawn, execSync } = require('child_process');

// Load environment variables if not already loaded
function loadEnv() {
  const envPath = path.resolve(__dirname, '..', '.env');
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq !== -1) {
        const key = trimmed.slice(0, eq).trim();
        let val = trimmed.slice(eq + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        if (process.env[key] === undefined) process.env[key] = val;
      }
    }
  }
}
loadEnv();

const CDP_PORT = 9222;
const CDP_URL = `http://127.0.0.1:${CDP_PORT}`;

function isCdpActive(timeoutMs = 1500) {
  return new Promise(resolve => {
    const req = http.get({
      hostname: '127.0.0.1',
      port: CDP_PORT,
      path: '/json/version',
      timeout: timeoutMs
    }, res => {
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function findBrowserExecutable(browserType = 'edge') {
  const isWin = process.platform === 'win32';
  const isMac = process.platform === 'darwin';

  if (browserType === 'edge') {
    if (isWin) {
      const candidates = [
        path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        path.join(process.env['LOCALAPPDATA'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe')
      ];
      return candidates.find(fs.existsSync) || null;
    }
    if (isMac) {
      const p = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
      return fs.existsSync(p) ? p : null;
    }
    return 'microsoft-edge';
  }

  if (browserType === 'chrome') {
    if (isWin) {
      const candidates = [
        path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(process.env['LOCALAPPDATA'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe')
      ];
      return candidates.find(fs.existsSync) || null;
    }
    if (isMac) {
      const p = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
      return fs.existsSync(p) ? p : null;
    }
    return 'google-chrome';
  }

  if (browserType === 'brave') {
    if (isWin) {
      const candidates = [
        path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
        path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
        path.join(process.env['LOCALAPPDATA'] || '', 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe')
      ];
      return candidates.find(fs.existsSync) || null;
    }
    if (isMac) {
      const p = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
      return fs.existsSync(p) ? p : null;
    }
    return 'brave-browser';
  }

  return null;
}

function getBrowserUserDataDir(browserType = 'edge') {
  const isWin = process.platform === 'win32';
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');

  if (browserType === 'edge') {
    if (isWin) return path.join(localAppData, 'Microsoft', 'Edge', 'AutomationData');
    return path.join(os.homedir(), '.config', 'microsoft-edge');
  }
  if (browserType === 'chrome') {
    if (isWin) return path.join(localAppData, 'Google', 'Chrome', 'User Data');
    return path.join(os.homedir(), '.config', 'google-chrome');
  }
  if (browserType === 'brave') {
    if (isWin) return path.join(localAppData, 'BraveSoftware', 'Brave-Browser', 'User Data');
    return path.join(os.homedir(), '.config', 'BraveSoftware', 'Brave-Browser');
  }
  return path.join(os.homedir(), '.browser-automation-profile');
}

async function launchBrowser({ browserType = process.env.BROWSER_TYPE || 'edge', profile = process.env.BROWSER_PROFILE || 'Default' } = {}) {
  const active = await isCdpActive();
  if (active) {
    console.log(`[Browser] CDP is already active at ${CDP_URL}.`);
    return { status: 'already_running', cdpUrl: CDP_URL };
  }

  const binary = findBrowserExecutable(browserType);
  if (!binary) {
    throw new Error(`Could not find ${browserType} browser executable on this system. Please check your installation.`);
  }

  const userDataDir = getBrowserUserDataDir(browserType);
  console.log(`[Browser] Launching ${browserType.toUpperCase()} with CDP on port ${CDP_PORT}...`);
  console.log(`[Browser] Executable: ${binary}`);
  console.log(`[Browser] Profile Directory: ${profile}`);
  console.log(`[Browser] User Data: ${userDataDir}`);

  const urls = [
    'https://www.threads.com/',
    'https://www.facebook.com/',
    'https://x.com/',
    'https://www.instagram.com/'
  ];

  const args = [
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${userDataDir}`,
    `--profile-directory=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    ...urls
  ];

  const child = spawn(binary, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: false
  });
  child.unref();

  // Wait for CDP to respond
  console.log('[Browser] Waiting for CDP endpoint to respond...');
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 800));
    const alive = await isCdpActive(800);
    if (alive) {
      console.log(`[Browser] SUCCESS: ${browserType.toUpperCase()} is running with CDP attached at ${CDP_URL}!`);
      console.log('📌 Tabs opened: Threads, Facebook, X, Instagram');
      console.log('👉 Please log in to your accounts in the opened Edge browser window.');
      return { status: 'launched', cdpUrl: CDP_URL, binary, profile };
    }
  }

  throw new Error(`Browser launched but CDP did not become reachable at ${CDP_URL}. Ensure all existing background ${browserType} processes are closed, then retry.`);
}

if (require.main === module) {
  const browserType = (process.argv[2] || process.env.BROWSER_TYPE || 'edge').replace(/^--/, '').toLowerCase();
  launchBrowser({ browserType })
    .then(() => process.exit(0))
    .catch(err => {
      console.error('[Browser Error]', err.message);
      process.exit(1);
    });
}

module.exports = { launchBrowser, isCdpActive, findBrowserExecutable, getBrowserUserDataDir };
