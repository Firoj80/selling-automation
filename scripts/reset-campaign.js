const fs = require('fs');
const path = require('path');
const { loadProduct, fingerprint, revisions } = require('../src/content/product-config');

const root = path.resolve(__dirname, '..');

try {
  if (!fs.existsSync(path.join(root, 'product.json'))) process.exit(0);
  
  const { product, copy } = loadProduct(root);
  const currentFacts = revisions(product, copy).facts;
  
  let factsChanged = false;
  
  for (const relative of ['private/product-content.json', 'private/product-generation.json']) {
    const file = path.join(root, relative);
    if (!fs.existsSync(file)) continue;
    
    try {
      const state = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
      if (state.configRevisions && state.configRevisions.facts !== currentFacts) {
        factsChanged = true;
        break;
      }
    } catch (e) {}
  }
  
  if (factsChanged) {
    console.log("📦 Product facts changed. Archiving old campaign data to start fresh...");
    const backupDir = path.join(root, 'private', 'config-backups', 'reset-' + Date.now());
    fs.mkdirSync(backupDir, { recursive: true });
    
    const filesToReset = [
      'private/product-content.json',
      'private/product-generation.json',
      'private/product-engagement.json',
      'private/product-research.json',
      'private/config-migration.json'
    ];
    
    for (const relative of filesToReset) {
      const file = path.join(root, relative);
      if (fs.existsSync(file)) {
        fs.renameSync(file, path.join(backupDir, path.basename(file)));
      }
    }
    console.log("✅ Old campaign data archived to " + backupDir);
  }
} catch (err) {}
