/**
 * threads-agent.js
 * Primary Unified Autonomous CLI Orchestrator for Meta Automation.
 *
 * Supported Commands:
 *   node threads-agent.js setup               - Interactive product wizard + generate content posts
 *   node threads-agent.js start               - Autonomous posting engine
 *   node threads-agent.js start --engage      - Autonomous posting AND engagement engine
 *   node threads-agent.js content-status      - Check performance metrics + per-platform selling status
 *   node threads-agent.js learn               - Self-learning from post performance
 *   node threads-agent.js set-url <URL>       - Add/update your product sales URL later
 */

if (require.main === module) {
  const command = (process.argv[2] || '').toLowerCase();

  if (['set-url', 'settings', 'recover', 'queue', 'research', 'images', 'auth', 'analyze-style', 'analyze-account'].includes(command)) {
    require('./src/content/content-cli').run(command, process.argv.slice(3)).catch(err => {
      console.error(err.message);
      process.exitCode = 1;
    });
  } else if (command === 'setup') {
    const fs = require('fs');
    const path = require('path');
    const productFile = path.resolve(__dirname, 'product.json');

    // Check if product.json is missing or has placeholder data
    let needsWizard = !fs.existsSync(productFile);
    if (!needsWizard) {
      try {
        const raw = fs.readFileSync(productFile, 'utf8').replace(/^\uFEFF/, '');
        const p = JSON.parse(raw);
        // Run wizard only if key product fields are missing or clearly unconfigured
        const hasName = p.product?.name && p.product.name.trim();
        const hasTopics = Array.isArray(p.product?.key_topics) && p.product.key_topics.length > 0;
        if (!hasName || !hasTopics) needsWizard = true;
      } catch { needsWizard = true; }
    }

    const runSetup = () => require('./src/content/content-cli').run('setup', process.argv.slice(3))
      .catch(err => { console.error(err.message); process.exitCode = 1; });

    if (needsWizard) {
      require('./scripts/product-wizard').runWizard()
        .then(runSetup)
        .catch(err => { console.error(err.message); process.exitCode = 1; });
    } else {
      console.log('📦 product.json found. Skipping wizard — generating content posts...');
      console.log('   (Re-run wizard anytime: node scripts/product-wizard.js)');
      runSetup();
    }

  // ── All other content commands ────────────────────────────────────────────
  } else if (['start', 'content-status', 'content-engage', 'learn', 'status'].includes(command)) {
    require('./src/content/content-cli').run(command, process.argv.slice(3)).catch(err => {
      console.error(err.message);
      process.exitCode = 1;
    });

  } else {
    console.log(`Unknown command or missing arguments.
Supported Commands:
  node threads-agent.js setup
  node threads-agent.js start
  node threads-agent.js start --engage
  node threads-agent.js content-status
  node threads-agent.js images status
  node threads-agent.js images preview --platform threads|facebook
  node threads-agent.js learn [--status|--dry-run]
  node threads-agent.js settings [show|validate|migrate|set KEY VALUE|request ID]
  node threads-agent.js queue list
  node threads-agent.js queue edit ID --file FILE
  node threads-agent.js queue reschedule ID --at ISO_TIME
  node threads-agent.js queue reschedule --pending --from YYYY-MM-DD --preview|--apply
  node threads-agent.js queue catch-up --preview|--apply
  node threads-agent.js queue rehumanize --pending [--include-manual] [--preview]
  node threads-agent.js research --status|--resume
  node threads-agent.js recover --inspect
  node threads-agent.js analyze-style [--x HANDLE] [--threads HANDLE] [--force]
  node threads-agent.js set-url https://your-sales-link.com
`);
    process.exitCode = 1;
  }
}
