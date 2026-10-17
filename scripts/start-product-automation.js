const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const root = path.resolve(__dirname, '..');
fs.mkdirSync(path.join(root, 'logs'), { recursive: true });
const logFile = path.join(root, 'logs', 'startup.log');
const log = fs.createWriteStream(logFile, { flags: 'a' });
function write(text) { process.stdout.write(text); log.write(text); }
function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, stdio: ['inherit', 'pipe', 'pipe'] });
    child.stdout.on('data', chunk => write(chunk.toString()));
    child.stderr.on('data', chunk => write(chunk.toString()));
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`Command stopped (${code ?? 'interrupted'}): node ${args.join(' ')}`)));
  });
}
async function main() {
  write(`\n=== Automation startup ${new Date().toISOString()} ===\nLog: ${logFile}\n`);
  if (!fs.existsSync(path.join(root, 'product.json'))) throw new Error('Missing product.json. Run node scripts/product-wizard.js first.');
  await run(['threads-agent.js', 'settings', 'validate']);
  const recoveryTools = require('../src/content/content-recovery');
  const recovery = recoveryTools.inspect(root);
  if (recovery.posts.length) throw new Error('Saved publication requires review. Run node threads-agent.js recover --inspect and reconcile against the platform before starting.');
  if (recovery.lock.status === 'stale') write(JSON.stringify(recoveryTools.recoverStaleLock(root)) + '\n');
  else if (recovery.lock.status !== 'absent') throw new Error('Automation is already running or lock ownership cannot be verified. Run recover --inspect.');
  await run(['scripts/launch-browser-cdp.js']);
  write('Using saved browser logins. Keep the browser open.\n');
  const { product } = require('../src/content/product-config').loadProduct(root);
  const media = require('../src/content/media-settings').mediaSettings(product);
  const rolling = require('../src/content/media-settings').rollingSettings(product);
  write(`New content images: ${media.enabled ? `${media.width}x${media.height} ${media.provider === 'antigravity' ? 'Antigravity AI images' : 'PNG cards'}` : 'disabled'}. Rolling preparation: ${rolling.enabled ? 'one replacement per verified platform publication' : 'disabled'}.\n`);
  if (!fs.existsSync(path.join(root, 'private/product-content.json'))) {
    await run(['threads-agent.js', 'setup']);
    if (!fs.existsSync(path.join(root, 'private/product-content.json'))) throw new Error('Setup has not created a campaign. Check the generation output above.');
  }
  await run(['threads-agent.js', 'start', '--engage', ...process.argv.slice(2)]);
}
main().catch(err => { write(`\n${err.message}\nSaved state is preserved. See ${logFile}\n`); process.exitCode = 1; }).finally(() => log.end());
