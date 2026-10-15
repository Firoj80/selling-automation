const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { validateProduct } = require('../src/content/product-config');
const { TargetAccountAnalyzer } = require('../src/knowledge/target-account-analyzer');
const { ContentEngine } = require('../src/content/content-engine');
const { ContentHumanizer, loadWriting } = require('../src/content/content-humanizer');

function createTempWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'analyzer-test-'));
  fs.mkdirSync(path.join(root, 'knowledge'), { recursive: true });
  fs.mkdirSync(path.join(root, 'private'), { recursive: true });
  fs.writeFileSync(path.join(root, 'knowledge', 'voice.md'), '# Writing Style Examples\n\nShort test post.\n', 'utf8');
  return root;
}

test('target_accounts validation and handle normalization in validateProduct', () => {
  const base = {
    seller: { name: 'Hamza', username: 'Hamza_build' },
    product: {
      name: 'Scan My Disk',
      type: 'desktop app',
      price: '$5',
      sales_url: 'https://www.scanmydisk.com',
      description: 'Disk space visualizer',
      target_audience: 'Windows users',
      key_topics: ['Clean disk', 'Free up space']
    },
    strategy: {
      platforms: ['threads', 'facebook', 'x', 'instagram'],
      post_frequency_hours: 2,
      value_posts_before_selling: 0,
      view_threshold_to_sell: 0,
      product_mention_ratio: '1 in 5 posts'
    }
  };

  // Valid handles with @ stripped
  const valid = validateProduct({
    ...base,
    target_accounts: {
      x: '@target_creator_x',
      threads: 'target_creator_threads'
    }
  });
  assert.equal(valid.target_accounts.x, 'target_creator_x');
  assert.equal(valid.target_accounts.threads, 'target_creator_threads');

  // Handles with invalid whitespace must fail
  assert.throws(() => {
    validateProduct({
      ...base,
      target_accounts: {
        x: 'invalid handle with spaces'
      }
    });
  }, /target_accounts must map/);
});

test('TargetAccountAnalyzer isAnalyzed and saveStyle cycle', () => {
  const root = createTempWorkspace();
  const analyzer = new TargetAccountAnalyzer({ root });

  const targetAccounts = { x: 'creator_x', threads: 'creator_threads' };
  assert.equal(analyzer.isAnalyzed(targetAccounts), false);

  const mockProfile = {
    target_accounts: targetAccounts,
    analyzed_at: new Date().toISOString(),
    content_types: ['framework breakdown', 'tactical checklist'],
    hook_patterns: ['Most people think X, but Y'],
    tone: 'Direct, practical, no-fluff',
    formatting: {
      avg_sentence_length: 'short',
      line_breaks: 'frequent',
      bullet_style: 'minimal',
      emoji_policy: 'minimal'
    },
    reply_style: {
      tone: 'Conversational, validating, direct',
      typical_structure: '1-sentence confirmation + actionable detail',
      patterns: ['Validate premise then offer concrete nuance'],
      examples: ['Spot on. The key is keeping it simple.']
    },
    rules_to_follow: ['Use single spaces', 'State conclusions directly'],
    rules_to_avoid: ['Do not use em dashes', 'Avoid generic corporate jargon'],
    voice_markdown: '# Writing Style Examples\n\nFix trust first. Sales follow.\n',
    sample_posts_count: 5,
    sample_replies_count: 5
  };

  analyzer.saveStyle(mockProfile);

  assert.equal(analyzer.isAnalyzed(targetAccounts), true);
  // Different accounts return false
  assert.equal(analyzer.isAnalyzed({ x: 'different_user' }), false);

  const loaded = TargetAccountAnalyzer.loadTargetStyle(root);
  assert.ok(loaded);
  assert.equal(loaded.target_accounts.x, 'creator_x');
  assert.equal(loaded.reply_style.tone, 'Conversational, validating, direct');

  fs.rmSync(root, { recursive: true, force: true });
});

test('TargetAccountAnalyzer synthesizeStyle creates clean voice_markdown without em-dashes and within limit', async () => {
  const root = createTempWorkspace();

  const mockAi = {
    callAi: async (prompt, options) => {
      assert.equal(options.taskType, 'CONTENT_ANALYSIS');
      return {
        content_types: ['case study', 'actionable steps'],
        hook_patterns: ['Here is how I solved X in 3 steps:'],
        tone: 'Technical, practitioner-first, direct',
        formatting: {
          avg_sentence_length: 'short',
          line_breaks: 'frequent',
          emoji_policy: 'minimal'
        },
        reply_style: {
          tone: 'Supportive and inquisitive',
          typical_structure: 'Short validation then follow-up question',
          patterns: ['Acknowledge and ask nuance'],
          examples: ['100%. Did you measure disk throughput as well?']
        },
        rules_to_follow: ['Keep lines punchy'],
        rules_to_avoid: ['No buzzwords'],
        // Include intentional em dashes and extra spaces to test sanitation
        voice_markdown: '# Writing Style Examples\n\nDisk space fills fast — especially with node_modules.  Clean it now.\n\n---\n\nAlways verify duplicate scans — before deleting.'
      };
    }
  };

  const analyzer = new TargetAccountAnalyzer({ root, ai: mockAi });
  const result = await analyzer.synthesizeStyle({
    posts: ['Sample post 1', 'Sample post 2'],
    replies: ['Sample reply 1'],
    targetAccounts: { x: 'test_x' }
  });

  assert.ok(result);
  assert.ok(result.voice_markdown.length <= 3800);
  assert.ok(!result.voice_markdown.includes('—'), 'Should remove em dashes');
  assert.ok(!result.voice_markdown.includes('\u2014'), 'Should remove em dash unicode');
  assert.ok(!/[ \t]{2,}/.test(result.voice_markdown), 'Should remove double spaces');

  analyzer.saveStyle(result);

  // Verify voice.md passes content-humanizer loadWriting without error
  const dummyProduct = {
    writing: {
      humanizer_enabled: true,
      voice_examples_file: 'knowledge/voice.md',
      preserve_facts: true
    }
  };
  const writing = loadWriting(root, dummyProduct);
  assert.ok(writing.enabled);
  assert.ok(writing.voice.length > 0);

  fs.rmSync(root, { recursive: true, force: true });
});

test('ContentEngine receives targetStyle and injects voice guidelines into generation', async () => {
  let capturedPrompt = '';
  const mockAi = {
    callAi: async (prompt) => {
      capturedPrompt = prompt;
      return {
        posts: [
          { text: 'Visualizing disk space is the fastest way to reclaim gigabytes on Windows.', type: 'value', platform: 'threads' }
        ]
      };
    }
  };

  const targetStyle = {
    tone: 'Hyper-direct, punchy, zero fluff',
    hook_patterns: ['Most people think X, but Y'],
    formatting: { line_breaks: 'frequent' }
  };

  const engine = new ContentEngine({ ai: mockAi, targetStyle });
  assert.equal(engine.targetStyle.tone, 'Hyper-direct, punchy, zero fluff');

  const dummyProduct = {
    seller: { name: 'Hamza', username: 'Hamza_build' },
    product: {
      name: 'Scan My Disk',
      type: 'desktop app',
      price: '$5',
      sales_url: 'https://www.scanmydisk.com',
      description: 'Disk visualizer',
      target_audience: 'Windows users',
      key_topics: ['Clean disk', 'Free up space']
    },
    strategy: {
      platforms: ['threads', 'facebook', 'x', 'instagram'],
      post_frequency_hours: 2,
      value_posts_before_selling: 0,
      view_threshold_to_sell: 0,
      product_mention_ratio: '1 in 5 posts'
    },
    writing: { humanizer_enabled: false }
  };

  const plan = [{ platform: 'threads', topic: 'Clean disk', hook: 'Most people think X, but Y' }];
  await engine.generateContentQueue(dummyProduct, 'disk tips', 1, { plan });

  assert.ok(capturedPrompt.includes('Target creator voice & hook style to mirror'), 'Prompt must include target creator voice');
  assert.ok(capturedPrompt.includes('Hyper-direct, punchy, zero fluff'), 'Prompt must include target tone');
});

test('TargetAccountAnalyzer analyzeAndApply with sampleData updates voice.md and target-style.json', async () => {
  const root = createTempWorkspace();

  const mockAi = {
    callAi: async () => ({
      content_types: ['contrarian insight'],
      hook_patterns: ['Stop doing X. Do Y instead.'],
      tone: 'Assertive, authoritative',
      formatting: { line_breaks: 'frequent' },
      reply_style: { tone: 'Short, sharp, helpful', typical_structure: '1-sentence direct answer' },
      rules_to_follow: ['Lead with the punchline'],
      rules_to_avoid: ['No fluff'],
      voice_markdown: '# Writing Style Examples\n\nStop cleaning disks manually. Use visual tools.'
    })
  };

  const analyzer = new TargetAccountAnalyzer({ root, ai: mockAi });
  const result = await analyzer.analyzeAndApply({
    targetAccounts: { x: 'expert_x', threads: 'expert_threads' },
    sampleData: {
      posts: ['Stop cleaning disks manually. Use visual tools.', 'Finding duplicates takes 10 seconds if you scan correctly.'],
      replies: ['Exactly right. Caches are the biggest hidden culprit.']
    }
  });

  assert.ok(result);
  assert.equal(result.target_accounts.x, 'expert_x');
  assert.ok(fs.existsSync(path.join(root, 'knowledge', 'target-style.json')));
  assert.ok(fs.existsSync(path.join(root, 'knowledge', 'voice.md')));

  const content = fs.readFileSync(path.join(root, 'knowledge', 'voice.md'), 'utf8');
  assert.ok(content.includes('Stop cleaning disks manually'));

  fs.rmSync(root, { recursive: true, force: true });
});
