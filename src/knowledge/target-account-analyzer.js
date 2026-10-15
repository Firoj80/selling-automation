const fs = require('fs');
const path = require('path');
const logger = require('../logging/logger');

class TargetAccountAnalyzer {
  constructor({ root, ai, browserManager, onProgress } = {}) {
    this.root = root || path.resolve(__dirname, '../..');
    this.ai = ai || require('../ai/ai-runtime');
    this.browserManager = browserManager || require('../browser/browser-manager');
    this.onProgress = onProgress || (ev => console.log(`[Style Analyzer] ${ev.stage}${ev.detail ? ': ' + ev.detail : ''}`));
    this.styleFile = path.join(this.root, 'knowledge', 'target-style.json');
    this.voiceFile = path.join(this.root, 'knowledge', 'voice.md');
  }

  static loadTargetStyle(root = path.resolve(__dirname, '../..')) {
    const file = path.join(root, 'knowledge', 'target-style.json');
    if (!fs.existsSync(file)) return null;
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return null;
    }
  }

  isAnalyzed(targetAccounts) {
    if (!targetAccounts || (!targetAccounts.x && !targetAccounts.threads)) return true;
    if (!fs.existsSync(this.styleFile) || !fs.existsSync(this.voiceFile)) return false;
    try {
      const data = JSON.parse(fs.readFileSync(this.styleFile, 'utf8'));
      if (!data?.target_accounts) return false;
      const cleanX = targetAccounts.x ? targetAccounts.x.replace(/^@/, '').trim().toLowerCase() : null;
      const cleanThreads = targetAccounts.threads ? targetAccounts.threads.replace(/^@/, '').trim().toLowerCase() : null;
      const savedX = data.target_accounts.x ? data.target_accounts.x.replace(/^@/, '').trim().toLowerCase() : null;
      const savedThreads = data.target_accounts.threads ? data.target_accounts.threads.replace(/^@/, '').trim().toLowerCase() : null;

      if (cleanX && savedX !== cleanX) return false;
      if (cleanThreads && savedThreads !== cleanThreads) return false;
      return Boolean(data.hook_patterns && data.reply_style);
    } catch {
      return false;
    }
  }

  async scrapeXAccount(rawHandle, { maxPosts = 12, maxReplies = 12 } = {}) {
    const handle = String(rawHandle || '').replace(/^@/, '').trim();
    if (!handle) return { platform: 'x', handle: '', posts: [], replies: [] };

    this.onProgress({ stage: 'Scraping X', detail: `@${handle}` });
    const page = await this.browserManager.getXPage({ bringToFront: false });

    const posts = [];
    const replies = [];

    // 1. Scrape main posts
    try {
      await page.goto(`https://x.com/${handle}`, { waitUntil: 'domcontentloaded', timeout: 35000 });
      await new Promise(r => setTimeout(r, 2500));

      for (let s = 0; s < 3; s++) {
        const batch = await page.evaluate((targetHandle) => {
          const results = [];
          const articles = [...document.querySelectorAll('article[data-testid="tweet"]')];
          for (const art of articles) {
            const textEl = art.querySelector('[data-testid="tweetText"]');
            const text = textEl ? textEl.innerText.trim() : '';
            if (text && text.length >= 15 && !results.includes(text)) {
              results.push(text);
            }
          }
          return results;
        }, handle);

        for (const t of batch) {
          if (!posts.includes(t)) posts.push(t);
        }
        if (posts.length >= maxPosts) break;
        await page.evaluate(() => window.scrollBy({ top: 600, behavior: 'smooth' }));
        await new Promise(r => setTimeout(r, 1200));
      }
    } catch (err) {
      logger.warn(`[Style Analyzer] X post scraping issue for @${handle}: ${err.message}`);
    }

    // 2. Scrape replies
    try {
      await page.goto(`https://x.com/${handle}/with_replies`, { waitUntil: 'domcontentloaded', timeout: 35000 });
      await new Promise(r => setTimeout(r, 2500));

      for (let s = 0; s < 3; s++) {
        const batch = await page.evaluate(() => {
          const results = [];
          const articles = [...document.querySelectorAll('article[data-testid="tweet"]')];
          for (const art of articles) {
            const textEl = art.querySelector('[data-testid="tweetText"]');
            const text = textEl ? textEl.innerText.trim() : '';
            if (text && text.length >= 8 && !results.includes(text)) {
              results.push(text);
            }
          }
          return results;
        });

        for (const rText of batch) {
          if (!posts.includes(rText) && !replies.includes(rText)) replies.push(rText);
        }
        if (replies.length >= maxReplies) break;
        await page.evaluate(() => window.scrollBy({ top: 600, behavior: 'smooth' }));
        await new Promise(r => setTimeout(r, 1200));
      }
    } catch (err) {
      logger.warn(`[Style Analyzer] X replies scraping issue for @${handle}: ${err.message}`);
    }

    return {
      platform: 'x',
      handle,
      posts: posts.slice(0, maxPosts),
      replies: replies.slice(0, maxReplies)
    };
  }

  async scrapeThreadsAccount(rawHandle, { maxPosts = 12, maxReplies = 12 } = {}) {
    const handle = String(rawHandle || '').replace(/^@/, '').trim();
    if (!handle) return { platform: 'threads', handle: '', posts: [], replies: [] };

    this.onProgress({ stage: 'Scraping Threads', detail: `@${handle}` });
    const page = await this.browserManager.getThreadsPage({ bringToFront: false });

    const posts = [];
    const replies = [];

    // 1. Scrape main posts
    try {
      await page.goto(`https://www.threads.com/@${handle}`, { waitUntil: 'domcontentloaded', timeout: 35000 });
      await new Promise(r => setTimeout(r, 2500));

      for (let s = 0; s < 3; s++) {
        const batch = await page.evaluate(() => {
          const results = [];
          const links = [...document.querySelectorAll('a[href*="/post/"]')];
          for (const link of links) {
            const container = link.closest('article, [data-pressable-container="true"], div[style*="border-bottom"]') || link.parentElement;
            const text = (container ? container.innerText : link.innerText || '').trim();
            if (text && text.length >= 15 && !results.includes(text)) {
              results.push(text);
            }
          }
          return results;
        });

        for (const p of batch) {
          if (!posts.includes(p)) posts.push(p);
        }
        if (posts.length >= maxPosts) break;
        await page.evaluate(() => window.scrollBy({ top: 600, behavior: 'smooth' }));
        await new Promise(r => setTimeout(r, 1200));
      }
    } catch (err) {
      logger.warn(`[Style Analyzer] Threads post scraping issue for @${handle}: ${err.message}`);
    }

    // 2. Scrape replies
    try {
      await page.goto(`https://www.threads.com/@${handle}/replies`, { waitUntil: 'domcontentloaded', timeout: 35000 });
      await new Promise(r => setTimeout(r, 2500));

      for (let s = 0; s < 3; s++) {
        const batch = await page.evaluate(() => {
          const results = [];
          const links = [...document.querySelectorAll('a[href*="/post/"]')];
          for (const link of links) {
            const container = link.closest('article, [data-pressable-container="true"], div[style*="border-bottom"]') || link.parentElement;
            const text = (container ? container.innerText : link.innerText || '').trim();
            if (text && text.length >= 8 && !results.includes(text)) {
              results.push(text);
            }
          }
          return results;
        });

        for (const rText of batch) {
          if (!posts.includes(rText) && !replies.includes(rText)) replies.push(rText);
        }
        if (replies.length >= maxReplies) break;
        await page.evaluate(() => window.scrollBy({ top: 600, behavior: 'smooth' }));
        await new Promise(r => setTimeout(r, 1200));
      }
    } catch (err) {
      logger.warn(`[Style Analyzer] Threads reply scraping issue for @${handle}: ${err.message}`);
    }

    return {
      platform: 'threads',
      handle,
      posts: posts.slice(0, maxPosts),
      replies: replies.slice(0, maxReplies)
    };
  }

  async synthesizeStyle({ posts = [], replies = [], targetAccounts = {}, product = null }) {
    this.onProgress({ stage: 'Synthesizing Voice & Style', detail: `${posts.length} posts, ${replies.length} replies` });

    if (!posts.length && !replies.length) {
      throw new Error('Cannot synthesize style: no sample posts or replies collected.');
    }

    const prompt = [
      'Return ONLY a valid JSON object matching the requested schema. No tools. No code fences.',
      'You are an expert social media voice & engagement analyst.',
      'Analyze the provided sample posts and sample replies from the target accounts.',
      'Deconstruct their exact writing style, content types, hook patterns, formatting habits, and reply style.',
      '',
      'CRITICAL CONSTRAINTS FOR voice_markdown:',
      '1. Total character length MUST BE under 3800 characters (workspace hard limit is 4000).',
      '2. NEVER use an em dash (—) anywhere in the text. Use commas, colons, or parentheses instead.',
      '3. NEVER use double spaces.',
      '4. Focus purely on WRITING STYLE, TONE, HOOK STRUCTURES, AND REPLY DEMEANOR. Do not invent product facts or claims.',
      '5. In voice_markdown, provide 5 to 8 short reference examples (separated by ---) that capture the creator\'s tone, rhythm, and sentence structure.',
      '',
      'Output schema:',
      '{',
      '  "content_types": ["...", "..."],',
      '  "hook_patterns": ["...", "..."],',
      '  "tone": "short descriptive tone summary",',
      '  "formatting": {',
      '    "avg_sentence_length": "short | medium | mixed",',
      '    "line_breaks": "frequent | standard | minimal",',
      '    "bullet_style": "...",',
      '    "emoji_policy": "never | minimal | selective"',
      '  },',
      '  "reply_style": {',
      '    "tone": "supportive, punchy, direct",',
      '    "typical_structure": "...",',
      '    "patterns": ["pattern 1", "pattern 2"],',
      '    "examples": ["example reply 1", "example reply 2"]',
      '  },',
      '  "rules_to_follow": ["rule 1", "rule 2"],',
      '  "rules_to_avoid": ["avoid 1", "avoid 2"],',
      '  "voice_markdown": "# Writing Style Examples\\n\\nThese are reference posts for writing style only...\\n\\n---\\n\\nExample post 1..."',
      '}',
      '',
      'Target Accounts Analyzed:',
      JSON.stringify(targetAccounts),
      '',
      'Sample Posts:',
      JSON.stringify(posts.slice(0, 15)),
      '',
      'Sample Replies:',
      JSON.stringify(replies.slice(0, 15))
    ].join('\n');

    const result = await this.ai.callAi(prompt, { taskType: 'CONTENT_ANALYSIS' });

    if (!result || typeof result !== 'object') {
      throw new Error('AI style synthesis failed: received empty or invalid response');
    }

    let voiceMarkdown = typeof result.voice_markdown === 'string' && result.voice_markdown.trim()
      ? result.voice_markdown.trim()
      : this.buildDefaultVoiceMarkdown(result, posts);

    // Enforce no em-dashes and no repeated spaces
    voiceMarkdown = voiceMarkdown.replaceAll('\u2014', '-').replaceAll('—', '-');
    voiceMarkdown = voiceMarkdown.replace(/[ \t]{2,}/g, ' ');

    // Safety clamp under 3800 chars (system limit is 4000)
    if (voiceMarkdown.length > 3800) {
      const parts = voiceMarkdown.slice(0, 3800).split('\n---\n');
      if (parts.length > 1) {
        parts.pop(); // Drop last partially cut example
        voiceMarkdown = parts.join('\n---\n').trim();
      } else {
        voiceMarkdown = voiceMarkdown.slice(0, 3750).trim();
      }
    }

    return {
      target_accounts: targetAccounts,
      analyzed_at: new Date().toISOString(),
      content_types: Array.isArray(result.content_types) ? result.content_types : ['actionable advice', 'framework breakdown', 'concise observation'],
      hook_patterns: Array.isArray(result.hook_patterns) ? result.hook_patterns : ['Most people X, but Y', 'Here is the mistake most make:', 'How to X without Y'],
      tone: result.tone || 'Direct, practical, conversational, high-signal, no-fluff',
      formatting: result.formatting || {
        avg_sentence_length: 'short',
        line_breaks: 'frequent',
        bullet_style: 'minimal',
        emoji_policy: 'minimal'
      },
      reply_style: result.reply_style || {
        tone: 'Conversational, validating, direct',
        typical_structure: '1-sentence confirmation followed by actionable detail',
        patterns: ['Validate premise then offer concrete nuance', 'Direct answer with zero filler'],
        examples: ['Spot on. The key is setting up the baseline first.', '100%. Keeping it simple prevents maintenance overhead.']
      },
      rules_to_follow: Array.isArray(result.rules_to_follow) ? result.rules_to_follow : ['Use single spaces', 'Keep paragraphs under 2 sentences', 'State conclusions directly'],
      rules_to_avoid: Array.isArray(result.rules_to_avoid) ? result.rules_to_avoid : ['Do not use em dashes', 'Avoid generic corporate jargon', 'Never fabricate testimonials'],
      voice_markdown: voiceMarkdown,
      sample_posts_count: posts.length,
      sample_replies_count: replies.length
    };
  }

  buildDefaultVoiceMarkdown(analysis, samplePosts = []) {
    const examples = samplePosts.slice(0, 6).map(p => p.replaceAll('\u2014', '-').replaceAll('—', '-').trim()).filter(Boolean);
    const examplesText = examples.length
      ? examples.join('\n\n---\n\n')
      : 'Most people post every day and get nowhere.\nNot because they are posting wrong content.\nBecause they are posting to an audience that does not trust them yet.\n\nFix the trust first. Sales follow.';

    return `# Writing Style Examples\n\nThese are reference posts for writing style only. Match the tone, sentence length, and directness. Do not copy facts from these - facts come from product.json and product-copy.md.\n\n---\n\n${examplesText}`;
  }

  saveStyle(styleProfile) {
    fs.mkdirSync(path.dirname(this.styleFile), { recursive: true });
    fs.writeFileSync(this.styleFile, JSON.stringify(styleProfile, null, 2), 'utf8');
    fs.writeFileSync(this.voiceFile, styleProfile.voice_markdown, 'utf8');
    this.onProgress({ stage: 'Saved', detail: `Updated knowledge/target-style.json and knowledge/voice.md (${styleProfile.voice_markdown.length} chars)` });
    return styleProfile;
  }

  async analyzeAndApply({ targetAccounts, product, sampleData = null, force = false }) {
    const accs = targetAccounts || product?.target_accounts || product?.writing?.target_accounts || {};
    if (!accs.x && !accs.threads && !sampleData) {
      throw new Error('Please configure target_accounts in product.json or provide handles via CLI (--x <handle> / --threads <handle>).');
    }

    if (!force && this.isAnalyzed(accs) && !sampleData) {
      this.onProgress({ stage: 'Already Analyzed', detail: 'Using existing target-style.json and voice.md' });
      return TargetAccountAnalyzer.loadTargetStyle(this.root);
    }

    let allPosts = [];
    let allReplies = [];

    if (sampleData) {
      allPosts = sampleData.posts || [];
      allReplies = sampleData.replies || [];
    } else {
      if (accs.x) {
        const xData = await this.scrapeXAccount(accs.x);
        allPosts.push(...xData.posts);
        allReplies.push(...xData.replies);
      }
      if (accs.threads) {
        const threadsData = await this.scrapeThreadsAccount(accs.threads);
        allPosts.push(...threadsData.posts);
        allReplies.push(...threadsData.replies);
      }
    }

    if (!allPosts.length && !allReplies.length) {
      throw new Error(`Failed to collect any sample posts or replies from target accounts: ${JSON.stringify(accs)}`);
    }

    const styleProfile = await this.synthesizeStyle({
      posts: allPosts,
      replies: allReplies,
      targetAccounts: accs,
      product
    });

    this.saveStyle(styleProfile);
    return styleProfile;
  }
}

module.exports = { TargetAccountAnalyzer };
