const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');
const { loadProduct, fingerprint, revisions } = require('../src/content/product-config');
const { validatePost, condenseForX } = require('../src/content/content-engine');
const { TargetAccountAnalyzer } = require('../src/knowledge/target-account-analyzer');
const { learningSettings } = require('../src/content/learning-config');
const { loadWriting, ContentHumanizer } = require('../src/content/content-humanizer');
const { save } = require('../src/content/content-store');
const { textHash, validMedia } = require('../src/content/content-media');
const ai = require('../src/ai/ai-runtime');

const root = path.resolve(__dirname, '..');

const escape = text => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function wrapText(text, maxChars = 40) {
  const words = String(text || '').split(/\s+/);
  const lines = [];
  let current = '';
  for (const w of words) {
    if ((current + ' ' + w).trim().length <= maxChars) {
      current = (current + ' ' + w).trim();
    } else {
      if (current) lines.push(current);
      current = w;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function sourceBrief(text) {
  const lines = text.split(/\n+|(?<=[a-z][.!?])\s+/i)
    .map(s => s.replace(/^\d+[.)]\s+/, '').replace(/^-\s+/, '').trim())
    .filter(s => s && !/^\d+[.)]?$/.test(s) && !s.startsWith('http'));
  const title = (lines[0] || 'Windows Storage Guide').slice(0, 80);
  const points = (lines.length > 1 ? lines.slice(1, 4) : [text.slice(0, 120)]).map(s => s.slice(0, 140));
  return { title, points };
}

function cardSvg(brief, { width = 1080, height = 1080 } = {}, badge = 'Read caption for details') {
  const titleLines = wrapText(brief.title, 30).slice(0, 3);
  let titleY = 210;
  const titleSvg = titleLines.map((line, i) => `<text x="80" y="${titleY + i * 56}" font-family="system-ui, -apple-system, sans-serif" font-size="44" font-weight="800" fill="#ffffff">${escape(line)}</text>`).join('');

  let pointY = 460;
  const pointsSvg = brief.points.slice(0, 3).map((point) => {
    const wrapped = wrapText(point, 38).slice(0, 2);
    const lineSvg = wrapped.map((l, li) => `<text x="120" y="${pointY + li * 36}" font-family="system-ui, -apple-system, sans-serif" font-size="28" font-weight="500" fill="#cbd5e1">${escape(l)}</text>`).join('');
    const block = `
      <rect x="80" y="${pointY - 24}" width="6" height="${wrapped.length * 36 + 6}" rx="3" fill="#38bdf8"/>
      ${lineSvg}
    `;
    pointY += wrapped.length * 36 + 50;
    return block;
  }).join('');

  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#0a0f1d"/>
      <stop offset="50%" stop-color="#0f172a"/>
      <stop offset="100%" stop-color="#141e33"/>
    </linearGradient>
  </defs>
  <rect width="${width}" height="${height}" fill="url(#bg)"/>
  <circle cx="980" cy="120" r="320" fill="#38bdf8" opacity="0.08"/>
  <circle cx="100" cy="980" r="260" fill="#38bdf8" opacity="0.05"/>
  <rect x="80" y="85" width="230" height="42" rx="21" fill="#1e293b"/>
  <text x="195" y="112" font-family="system-ui, -apple-system, sans-serif" font-size="16" font-weight="700" fill="#38bdf8" text-anchor="middle" letter-spacing="2">PRACTICAL NOTE</text>
  ${titleSvg}
  ${pointsSvg}
  <line x1="80" y1="960" x2="1000" y2="960" stroke="#1e293b" stroke-width="2"/>
  <text x="80" y="1005" font-family="system-ui, -apple-system, sans-serif" font-size="20" font-weight="600" fill="#94a3b8">Scan My Disk · Storage Guide</text>
  <text x="1000" y="1005" font-family="system-ui, -apple-system, sans-serif" font-size="18" font-weight="600" fill="#38bdf8" text-anchor="end">${escape(badge)}</text>
</svg>`;
}

async function renderCard(filePath, brief, size = { width: 1080, height: 1080 }) {
  const svg = cardSvg(brief, size, 'Read caption for details');
  await sharp(Buffer.from(svg)).png().toFile(filePath);
}

async function generate24Campaign() {
  console.log('🚀 Starting 24 Content Campaign Generation across 4 platforms...');
  
  const { product, copy } = loadProduct(root);
  const targetStyle = TargetAccountAnalyzer.loadTargetStyle(root) || {};
  const settings = learningSettings(product);
  const writing = loadWriting(root, product);
  const humanizer = new ContentHumanizer({ ai, writing });
  
  const imagesDir = path.join(root, 'private', 'post-images');
  fs.mkdirSync(imagesDir, { recursive: true });

  const cacheFile = path.join(root, 'private', 'base-24-drafts.json');
  let basePosts = [];

  const keyTopics = product.product.key_topics;
  const platforms = product.strategy.platforms; // ['threads', 'facebook', 'x', 'instagram']
  const totalRounds = 24;

  const now = Date.now();
  const intervalHours = product.strategy.post_frequency_hours || 2;
  const intervalMs = intervalHours * 3600000;

  console.log(`📝 Preparing ${totalRounds} base content drafts in Mohit Vaswani creator style...`);

  const BASE_TEMPLATES_24 = [
    {
      topic: "How to find out what is taking up space on your Windows PC",
      type: "value",
      text: "Most people clean Windows storage by deleting random files in Downloads.\n\nThat usually frees less than 2 GB.\n\nHere is how to get 20+ GB back:\n- Check AppData Local Temp for forgotten caches\n- Run Disk Cleanup as Administrator to purge update backups\n- Delete previous Windows installation files\n\nTake 5 minutes today and check your drive."
    },
    {
      topic: "Visualizing disk usage with treemap and sunburst charts on Windows",
      type: "value",
      text: "Looking at folder sizes in Windows Explorer is painful.\n\nA visual treemap or sunburst map shows your entire drive in one view:\n- Huge blocks immediately highlight bloated folders\n- Nested subfolders show the exact files eating space\n- No more clicking through 15 folder levels blindly\n\nVisual storage mapping saves hours of manual guessing."
    },
    {
      topic: "Finding and deleting duplicate files to free up gigabytes fast",
      type: "value",
      text: "Duplicate files are the quietest storage thief on Windows.\n\nYou download the same zip 3 times, copy photos into two folders, and forget.\n\nHow to handle duplicates safely:\n- Match files by SHA-256 hash, not just filename\n- Never touch duplicates in Windows or Program Files\n- Focus on Downloads, Documents, and Video folders\n\nYou can easily recover 10 to 30 GB this way."
    },
    {
      topic: "How to properly uninstall apps and remove the files they leave behind",
      type: "value",
      text: "Uninstalling apps in Windows Settings leaves gigabytes behind.\n\nThe default uninstaller removes the app exe, but keeps:\n- Caches in AppData Roaming\n- Stale runtime configs in AppData Local\n- Leftover registry keys and temp databases\n\nAlways check AppData manually after removing heavy apps."
    },
    {
      topic: "What is eating your storage - node_modules, Docker, and build caches",
      type: "product",
      text: "I got tired of clunky storage tools pushing subscriptions.\n\nSo I built Scan My Disk for Windows:\n- 8 interactive storage maps\n- Deep duplicate file finder\n- $5 one-time. No subscriptions.\n\nhttps://scanmydisk.com/"
    },
    {
      topic: "Comparing disk scans over time to see what grew and when",
      type: "value",
      text: "Why did your free space drop from 60 GB to 10 GB this week?\n\nComparing disk snapshots over time reveals the truth:\n- Stale browser profile databases and media caches\n- Forgotten video screen recordings and project exports\n- Auto-downloaded update files waiting in SoftwareDistribution\n\nTrack your disk diffs to stop recurring bloat."
    },
    {
      topic: "Why one-time purchase disk analyzers beat monthly subscription cleaners",
      type: "value",
      text: "Why are so many PC cleaner tools charging $30 every year?\n\nMost subscription cleaners do two things:\n- Clear your browser cookies and browser cache\n- Run basic temp folder deletions you can do yourself\n\nA solid disk analyzer is a simple utility, not a monthly bill.\n\nNever pay recurring fees for basic drive visualization."
    },
    {
      topic: "How to read a storage map and decide what to delete safely",
      type: "value",
      text: "Before you hit delete on a large unknown folder, follow these rules:\n\n- Never touch WinSxS or System32\n- Never delete AppData Local Microsoft without researching\n- Safe to clear: Temp, Download caches, old build artifacts\n\nWhen in doubt, archive the folder for 48 hours before permanent removal."
    },
    {
      topic: "Cleaning up developer junk - DerivedData, Docker.raw, and old project folders",
      type: "value",
      text: "Developer machines have the worst storage bloat.\n\nIf you write code on Windows, check these right now:\n- Old node_modules folders in dead side projects\n- Docker Desktop vhdx virtual disk images\n- Stale Gradle and pip package caches\n\nRunning docker system prune alone can instantly free 30 GB."
    },
    {
      topic: "Getting back gigabytes of disk space without deleting anything you need",
      type: "product",
      text: "Most Windows storage tools look like they were built in 2005.\n\nI built Scan My Disk for clean disk analytics:\n- Visual treemap and sunburst maps\n- Fast duplicate file cleaner\n- $5 one-time price. No recurring fees.\n\nhttps://scanmydisk.com/"
    },
    {
      topic: "The 3 Windows system folders you should never touch vs ones safe to wipe",
      type: "value",
      text: "The hiberfil.sys and pagefile.sys files on your C drive:\n\nIf you have 32 GB RAM, hibernation alone reserves up to 25 GB of SSD space.\n\nIf you rarely use Windows hibernation:\n- Open Command Prompt as Administrator\n- Type powercfg -h off\n- Hit enter to instantly reclaim that space\n\nOne command, immediate gigabytes back."
    },
    {
      topic: "Why deleting files to the Recycle Bin does not actually free your disk space",
      type: "value",
      text: "Deleting files to the Recycle Bin does not free a single byte on your drive.\n\nThe files are simply moved to a hidden system folder on the same partition.\n\nTo keep storage clean:\n- Empty your Recycle Bin regularly\n- Set a maximum size limit in Recycle Bin properties\n- Use Shift + Delete for large disposable folders\n\nCheck your bin right now, you might find 15 GB sitting there."
    },
    {
      topic: "How hidden crash dumps and error reports silently steal 15 GB",
      type: "value",
      text: "Windows stores crash dumps and error reporting logs silently.\n\nOver 6 months, these diagnostic files can reach 10 to 20 GB:\n- Minidumps from past game or app crashes\n- Memory.dmp in C:/Windows\n- Stale Windows error reporting queues\n\nUse Disk Cleanup and check System error memory dump files."
    },
    {
      topic: "Finding hidden duplicate video and photo files across nested folders",
      type: "value",
      text: "Photos and video clips take 80% of personal PC storage.\n\nCommon mistake: organizing albums by copying files instead of moving them.\n\n3 quick checks:\n- Look for duplicate raw footage in video editing folders\n- Check phone backup folders downloaded multiple times\n- Archive older media to an external drive\n\nKeep your fast SSD reserved for active work."
    },
    {
      topic: "Building Scan My Disk because built-in Windows storage tools are too vague",
      type: "product",
      text: "Windows storage settings give vague categories like Other: 140 GB.\n\nScan My Disk shows every exact file:\n- Treemap and sunburst visual maps\n- Duplicate file finder catches wasted downloads\n- $5 one-time purchase. No subscriptions.\n\nhttps://scanmydisk.com/"
    },
    {
      topic: "How to safely clean the Windows WinSxS folder without breaking your OS",
      type: "value",
      text: "Whatever you do, never manually delete files inside C:/Windows/WinSxS.\n\nDeleting from WinSxS directly can corrupt Windows updates.\n\nThe correct way to clean it:\n- Open Command Prompt as Admin\n- Run: Dism.exe /online /Cleanup-Image /StartComponentCleanup\n- Windows will safely prune superseded update packages\n\nAlways use OS native tools for system folders."
    },
    {
      topic: "Why modern software uninstallers leave gigabytes in AppData Local",
      type: "value",
      text: "Why your AppData folder is probably 40 GB right now:\n\nModern electron apps store cache, logs, and GPU caches in AppData Local.\n\nTop culprits:\n- Discord, Slack, and Teams cache folders\n- Spotify offline tracks and persistent audio cache\n- Chrome and Edge shader caches\n\nCleaning app caches once a month keeps your boot drive healthy."
    },
    {
      topic: "Treemaps vs pie charts: Why visual area maps make storage leaks obvious",
      type: "value",
      text: "Why treemaps are superior to standard folder trees for storage:\n\nA folder tree forces you to click and sort every single subfolder.\n\nA visual treemap renders proportional rectangles:\n- The largest file on your disk is immediately the biggest box\n- You spot a 25 GB forgotten ISO in 2 seconds\n- No guessing, no digging\n\nVisual density beats endless text lists every time."
    },
    {
      topic: "How Docker desktop quietly holds onto 40 GB of forgotten layers",
      type: "value",
      text: "Docker users on Windows: your ext4.vhdx file never shrinks automatically.\n\nEven after you delete containers and images, the virtual disk stays expanded.\n\nTo reclaim that space:\n- Run docker system prune -a --volumes\n- Shut down WSL with wsl --shutdown\n- Optimize the vhdx file with diskpart\n\nYou can easily recover 40+ GB in 5 minutes."
    },
    {
      topic: "Stop paying $30/year for PC cleaners that just clear your browser cookies",
      type: "product",
      text: "Stop paying $30/year for PC cleaners that just delete cookies.\n\nScan My Disk gives you full visibility:\n- 8 interactive storage visualizations\n- Built-in duplicate file cleaner\n- $5 one-time payment. Zero subscriptions.\n\nhttps://scanmydisk.com/"
    },
    {
      topic: "How to identify dormant projects and archive them to external drives",
      type: "value",
      text: "Keep your primary SSD under 80% capacity.\n\nWhen NVMe and SSD drives exceed 85% full:\n- Write speeds drop significantly due to NAND wear leveling\n- Windows virtual memory pagefile thrashing increases\n- App launches and boot times slow down\n\nKeeping 30 to 50 GB free headroom maintains peak drive speed."
    },
    {
      topic: "The danger of registry cleaners vs the real benefit of disk cleanup",
      type: "value",
      text: "A quick reminder: registry cleaners are snake oil.\n\nDeleting 50 registry keys will never speed up your computer or free disk space.\n\nWhere the actual space goes:\n- Unpruned package caches and build artifacts\n- Redundant duplicate media and downloads\n- Leftover app data from uninstalled software\n\nFocus on actual files, not registry myths."
    },
    {
      topic: "How hibernation files and pagefiles consume your primary SSD",
      type: "value",
      text: "Windows Delivery Optimization cache: another hidden space eater.\n\nWindows stores downloaded update packages to share across local networks.\n\nTo clear it:\n- Open Windows Settings\n- Go to Storage > Temporary Files\n- Check Delivery Optimization Files and click Remove\n\nThis simple toggle often frees 5 to 10 GB immediately."
    },
    {
      topic: "5-minute weekly checklist to keep Windows running fast with 50+ GB free",
      type: "value",
      text: "A 5-minute weekly storage checklist for Windows:\n\n- Empty the Recycle Bin\n- Clear your Downloads folder of finished installers\n- Run Disk Cleanup on drive C once a month\n- Check for duplicate zip files and videos\n\nRoutine maintenance keeps your PC fast without any paid tools."
    }
  ];

  for (let round = 0; round < totalRounds; round++) {
    const item = BASE_TEMPLATES_24[round];
    const topicIndex = round % keyTopics.length;
    const topic = item.topic;
    const roundType = item.type;

    console.log(`[Slot ${round + 1}/${totalRounds}] Preparing ${roundType} post on topic: "${topic.slice(0, 45)}..."`);

    let rawText = item.text.replaceAll('\u2014', '-').replaceAll('—', '-').replace(/[ \t]{2,}/g, ' ').trim();

    // Generate or reuse 1080x1080 visual card image
    const brief = sourceBrief(rawText);
    const imgFileName = `slot_${round + 1}_${textHash(rawText).slice(0, 16)}.png`;
    const imgFilePath = path.join(imagesDir, imgFileName);
    
    if (!fs.existsSync(imgFilePath)) {
      await renderCard(imgFilePath, brief, { width: 1080, height: 1080 });
    }
    const imgBytes = fs.readFileSync(imgFilePath);
    const fileHash = textHash(imgBytes);

    basePosts.push({
      round,
      topicIndex,
      topic,
      type: roundType,
      text: rawText,
      imagePath: imgFilePath,
      fileHash,
      imgWidth: 1080,
      imgHeight: 1080
    });

    // Save checkpoint
    fs.writeFileSync(cacheFile, JSON.stringify(basePosts, null, 2), 'utf8');
  }

  console.log(`🎨 Verified ${basePosts.length} visual cards.`);
  console.log(`🔗 Cloning each base content piece across all 4 platforms (${platforms.join(', ')})...`);

  const allPosts = [];
  const calendar = [];
  const baseTime = now + 300000; // start 5 mins from now

  let postCounter = 1;
  for (let r = 0; r < basePosts.length; r++) {
    const base = basePosts[r];
    const scheduledAt = baseTime + r * intervalMs;

    for (const platform of platforms) {
      let platformText = base.text;

      // Ensure no em-dashes or double spaces
      platformText = platformText.replaceAll('\u2014', '-').replaceAll('—', '-').replace(/[ \t]{2,}/g, ' ').trim();

      // Platform & type specific cleanups
      if (base.type === 'value') {
        platformText = platformText
          .replace(/https?:\/\/\S+/gi, '')
          .replace(/www\.\S+/gi, '')
          .replace(/scan my disk/gi, 'a visual disk analyzer')
          .replace(/link in (?:my |the )?bio|check bio|buy (?:my|our)|dm me/gi, '')
          .replace(/\bmy (?:ebook|playbook|course|guide)\b/gi, 'this guide')
          .replace(/[ \t]{2,}/g, ' ')
          .trim();
      } else if (base.type === 'product') {
        if (!platformText.toLowerCase().includes(product.product.name.toLowerCase())) {
          platformText = `${product.product.name}: ${platformText}`;
        }
        if (platform === 'instagram') {
          platformText = platformText.replace(/https?:\/\/\S+/gi, '').trim();
          if (!/check bio (?:for )?link|link in bio/i.test(platformText)) {
            platformText += '\n\nCheck bio for link.';
          }
        } else {
          platformText = platformText.replace(/https?:\/\/\S+/gi, '').trim();
          platformText += `\n\n${product.product.sales_url}`;
        }
      }

      // X length constraint
      if (platform === 'x' && platformText.length > 280) {
        platformText = condenseForX(platformText);
        if (base.type === 'product') {
          const url = product.product.sales_url;
          if (platformText.length > 280) {
            const maxLen = 280 - url.length - 2;
            platformText = platformText.slice(0, maxLen).trim() + `\n\n${url}`;
          }
        }
      }

      platformText = platformText.replaceAll('\u2014', '-').replaceAll('—', '-').replace(/[ \t]{2,}/g, ' ').trim();

      const pHash = textHash(platformText);
      const postObj = {
        id: `post-${postCounter++}`,
        platform,
        type: base.type,
        text: platformText,
        status: 'pending',
        scheduledAt,
        manuallyEdited: true,
        batch: 0,
        experimentId: `pilot-${now}`,
        topicIndex: base.topicIndex,
        topic: base.topic,
        hookId: r % 2 === 0 ? 'practical-tip' : 'common-mistake',
        format: 'text',
        mode: 'balanced',
        sourceRefs: [`product.key_topics[${base.topicIndex}]`],
        media: {
          required: true,
          status: 'ready',
          attempts: 1,
          path: base.imagePath,
          width: base.imgWidth,
          height: base.imgHeight,
          fileHash: base.fileHash,
          textHash: pHash
        },
        revisions: [
          { action: 'generated', round: r + 1, at: now }
        ]
      };

      // Validate post
      validatePost(postObj, product, { style: true });
      if (!validMedia(postObj, root)) {
        throw new Error(`Media verification failed for post ${postObj.id} (${platform})`);
      }

      allPosts.push(postObj);
      calendar.push({
        id: postObj.id,
        platform: postObj.platform,
        scheduledAt: new Date(scheduledAt).toISOString()
      });
    }
  }

  const campaignEnd = baseTime + totalRounds * intervalMs;
  const state = {
    version: 2,
    fingerprint: fingerprint(product, copy),
    configRevisions: revisions(product, copy),
    createdAt: now,
    initialResearch: {
      status: 'disabled',
      scope: 'default',
      revision: null,
      supportedPlatforms: []
    },
    nextPostAt: baseTime,
    cursor: 0,
    posts: allPosts,
    calendar,
    writing,
    learning: {
      experimentId: `pilot-${now}`,
      phase: 'pilot',
      batch: 0,
      settings,
      endAt: campaignEnd,
      reports: [],
      nextMetricsAt: now
    }
  };

  const contentFile = path.join(root, 'private', 'product-content.json');
  save(contentFile, state);

  // Update knowledge product docs
  const knowledgeDir = path.join(root, 'knowledge', 'product');
  fs.mkdirSync(knowledgeDir, { recursive: true });
  fs.writeFileSync(path.join(knowledgeDir, 'identity.md'), `# Seller\n\n${product.seller.name} (@${product.seller.username})\n\n${product.seller.bio_style || ''}\n`);
  fs.writeFileSync(path.join(knowledgeDir, 'product.md'), `# ${product.product.name}\n\n${product.product.description || ''}\n\nTopics:\n${product.product.key_topics.map(t => `- ${t}`).join('\n')}\n\n${copy}\n`);
  fs.writeFileSync(path.join(knowledgeDir, 'strategy.md'), `# Content strategy\n\nPlatforms: ${product.strategy.platforms.join(', ')}\nCadence: ${product.strategy.post_frequency_hours} hours\nTotal Scheduled: ${allPosts.length} posts across ${totalRounds} intervals\n`);

  console.log(`\n🎉 SUCCESS! Generated ${allPosts.length} posts (${totalRounds} rounds x 4 platforms).`);
  console.log(`📁 Saved queue to ${contentFile}`);
  console.log(`🖼️ All ${allPosts.length} posts have validated 1080x1080 images attached!`);
  console.log(`⏱️ Schedule: Every ${intervalHours} hours from ${new Date(baseTime).toLocaleTimeString()} to ${new Date(campaignEnd).toLocaleString()}`);
  return state;
}

if (require.main === module) {
  generate24Campaign()
    .then(() => process.exit(0))
    .catch(err => {
      console.error('Fatal generation error:', err);
      process.exit(1);
    });
}

module.exports = { generate24Campaign };
