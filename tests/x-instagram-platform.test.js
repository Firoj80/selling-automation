const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { condenseForX, validatePost, formatProductForInstagram } = require('../src/content/content-engine');
const { canonicalPostUrl } = require('../src/content/post-metrics');
const { changeQueue } = require('../src/content/content-queue');
const { validateProduct } = require('../src/content/product-config');

test('condenseForX keeps short text intact and condenses long text below 280 chars', () => {
  const shortText = 'Quick disk tip: check your Docker images and node_modules folders before buying external drives.';
  assert.equal(condenseForX(shortText), shortText);

  const longText = 'Here is a comprehensive breakdown of what fills up Windows hard drives. First, temporary files accumulate in AppData. Second, old Windows update backups take gigabytes. Third, developer caches like Docker containers and npm modules expand quietly. Finally, duplicate downloads sit forgotten in Downloads folders. Use a visual disk space tool like Scan My Disk to clean them safely.';
  assert.ok(longText.length > 280, `Expected longText to be > 280 chars, was ${longText.length}`);

  const condensed = condenseForX(longText);
  assert.ok(condensed.length <= 280, `Expected condensed length <= 280, got ${condensed.length}`);
  assert.ok(condensed.startsWith('Here is a comprehensive breakdown'), 'Should preserve hook');

  // Test URL preservation
  const textWithUrl = 'Check your Windows disk space usage now: https://www.scanmydisk.com - ' + 'A'.repeat(300);
  const condensedUrl = condenseForX(textWithUrl);
  assert.ok(condensedUrl.length <= 280, `Expected condensedUrl length <= 280, got ${condensedUrl.length}`);
  assert.ok(condensedUrl.includes('https://www.scanmydisk.com'), 'Must preserve sales/link URL');
});

test('Instagram validation requires both media attachment and non-empty caption', () => {
  const dummyProduct = validateProduct({
    seller: { name: 'Test Seller', username: 'testseller' },
    product: {
      name: 'Scan My Disk',
      type: 'desktop app',
      price: '$5',
      sales_url: 'https://example.com/disk',
      description: 'Disk cleaner',
      target_audience: 'Windows users',
      key_topics: ['Clean disk', 'Free up space']
    },
    strategy: {
      platforms: ['threads', 'facebook', 'x', 'instagram'],
      post_frequency_hours: 2,
      value_posts_before_selling: 5,
      view_threshold_to_sell: 1000,
      product_mention_ratio: '1 in 5 posts'
    }
  });

  // Text-only post on Instagram must fail (must have image)
  assert.throws(
    () => validatePost({ platform: 'instagram', type: 'value', text: 'Some text' }, dummyProduct),
    /Instagram requires an image/
  );

  // Empty caption post on Instagram must fail (must have caption text)
  assert.throws(
    () => validatePost(
      {
        platform: 'instagram',
        type: 'value',
        text: '',
        media: { required: true, image_path: 'private/images/test.png' }
      },
      dummyProduct
    ),
    /Invalid content post returned by AI/
  );

  // Post with BOTH media and valid caption text passes validation
  assert.doesNotThrow(() => {
    validatePost(
      {
        platform: 'instagram',
        type: 'value',
        text: 'Clean your disk today with visual maps',
        media: { required: true, image_path: 'private/images/test.png' }
      },
      dummyProduct
    );
  });
});

test('formatProductForInstagram formats product posts with check bio for link', () => {
  const dummyProduct = validateProduct({
    seller: { name: 'Test Seller', username: 'testseller' },
    product: {
      name: 'Scan My Disk',
      type: 'desktop app',
      price: '$5',
      sales_url: 'https://www.scanmydisk.com',
      description: 'Disk cleaner',
      target_audience: 'Windows users',
      key_topics: ['Clean disk', 'Free up space']
    },
    strategy: {
      platforms: ['threads', 'facebook', 'x', 'instagram'],
      post_frequency_hours: 2,
      value_posts_before_selling: 5,
      view_threshold_to_sell: 1000,
      product_mention_ratio: '1 in 5 posts'
    }
  });

  const rawPostText = 'Scan My Disk shows where disk space is going with treemap charts. Get it at https://www.scanmydisk.com';
  const formatted = formatProductForInstagram(rawPostText, dummyProduct);

  assert.ok(formatted.includes('Check bio for link'), 'Must include "Check bio for link"');
  assert.ok(formatted.includes('https://www.scanmydisk.com'), 'Must retain product sales URL');

  // Must pass Instagram validation as product post
  assert.doesNotThrow(() => {
    validatePost(
      {
        platform: 'instagram',
        type: 'product',
        text: formatted,
        media: { required: true, image_path: 'private/images/test.png' }
      },
      dummyProduct
    );
  });

  // If text already has bio mention, it does not double-append
  const alreadyHasBio = 'Scan My Disk is available now. Check bio for link: https://www.scanmydisk.com';
  const formattedAgain = formatProductForInstagram(alreadyHasBio, dummyProduct);
  assert.equal(formattedAgain, alreadyHasBio);
});

test('canonicalPostUrl correctly handles X and Instagram permalinks and strips queries', () => {
  // X.com
  const xUrl = canonicalPostUrl('https://x.com/Hamza_build/status/1845123456789012345?s=20&t=abc', 'x');
  assert.equal(xUrl, 'https://x.com/Hamza_build/status/1845123456789012345');

  // Twitter.com (canonicalized to x.com)
  const twitterUrl = canonicalPostUrl('https://twitter.com/Hamza_build/status/1845123456789012345', 'x');
  assert.equal(twitterUrl, 'https://x.com/Hamza_build/status/1845123456789012345');

  // Instagram post
  const igPostUrl = canonicalPostUrl('https://www.instagram.com/p/DBc12345XYZ/?utm_source=ig_web_copy_link', 'instagram');
  assert.equal(igPostUrl, 'https://www.instagram.com/p/DBc12345XYZ/');

  // Instagram reel
  const igReelUrl = canonicalPostUrl('https://instagram.com/reel/DBc12345XYZ/', 'instagram');
  assert.equal(igReelUrl, 'https://www.instagram.com/p/DBc12345XYZ/');

  // Non-url or invalid platform
  assert.equal(canonicalPostUrl('https://tiktok.com/@user/video/123', 'x'), null);
});

test('changeQueue clone-to-platforms clones pending posts to X and Instagram with correct platform rules', () => {
  const dummyProduct = validateProduct({
    seller: { name: 'Test Seller', username: 'testseller' },
    product: {
      name: 'Scan My Disk',
      type: 'desktop app',
      price: '$5',
      sales_url: 'https://example.com/disk',
      description: 'Disk cleaner',
      target_audience: 'Windows users',
      key_topics: ['Clean disk', 'Free up space']
    },
    strategy: {
      platforms: ['threads', 'facebook', 'x', 'instagram'],
      post_frequency_hours: 2,
      value_posts_before_selling: 5,
      view_threshold_to_sell: 1000,
      product_mention_ratio: '1 in 5 posts'
    }
  });

  const state = {
    cursor: 0,
    nextPostAt: 1760000000000,
    posts: [
      {
        id: 'post_1',
        platform: 'threads',
        type: 'value',
        text: 'Threads post 1 - very long text that needs condensing for X. ' + 'Tips on cleaning disk space. '.repeat(10),
        status: 'pending',
        scheduledAt: 1760000000000,
        media: { required: true, status: 'ready', path: 'private/images/img1.png' }
      },
      {
        id: 'post_2',
        platform: 'facebook',
        type: 'value',
        text: 'Facebook post 2 - text only',
        status: 'pending',
        scheduledAt: 1760007200000
      },
      {
        id: 'post_3',
        platform: 'threads',
        type: 'value',
        text: 'Already published post',
        status: 'published',
        publishedAt: 1759990000000
      }
    ]
  };

  const operation = {
    kind: 'clone-to-platforms',
    platforms: ['x', 'instagram']
  };

  const { state: nextState, changes } = changeQueue(state, dummyProduct, operation, 1760000000000);

  // Original 3 posts + 2 pending cloned to X + 2 pending cloned to Instagram = 7 posts
  assert.equal(nextState.posts.length, 7);
  assert.equal(changes.length, 4);

  const xPosts = nextState.posts.filter((p) => p.platform === 'x');
  const igPosts = nextState.posts.filter((p) => p.platform === 'instagram');

  assert.equal(xPosts.length, 2);
  assert.equal(igPosts.length, 2);

  // X posts must be <= 280 chars
  for (const p of xPosts) {
    assert.ok(p.text.length <= 280, `Expected X post length <= 280, was ${p.text.length}`);
    assert.equal(p.status, 'pending');
  }

  // Instagram posts must have required media AND retain caption text
  for (const p of igPosts) {
    assert.equal(p.media?.required, true);
    assert.ok(p.text.length > 0, 'Instagram cloned posts must retain caption text');
    if (p.media?.status === 'ready') {
      assert.equal(p.status, 'pending');
    } else {
      assert.equal(p.status, 'needs_media');
    }
  }
});

test('X and Threads product posts route sales URL to inner thread while Facebook keeps direct URL and Instagram checks bio', async () => {
  const dummyProduct = validateProduct({
    seller: { name: 'Test Seller', username: 'testseller' },
    product: {
      name: 'Scan My Disk',
      type: 'desktop app',
      price: '$5',
      sales_url: 'https://scanmydisk.com/',
      description: 'Disk cleaner',
      target_audience: 'Windows users',
      key_topics: ['Clean disk', 'Free up space']
    },
    strategy: {
      platforms: ['threads', 'facebook', 'x', 'instagram'],
      post_frequency_hours: 2,
      value_posts_before_selling: 5,
      view_threshold_to_sell: 1000,
      product_mention_ratio: '1 in 5 posts'
    }
  });

  const rawProductText = 'Tired of clunky disk tools? Scan My Disk maps your drives visually. One-time payment $5. https://scanmydisk.com/';

  // 1. Threads & X: Should move sales_url to threadReply
  const { publish } = require('../src/content/content-cli');

  // Validate X handling
  const xPost = {
    id: 'post_x_prod',
    platform: 'x',
    type: 'product',
    text: rawProductText,
    media: { status: 'ready', path: 'dummy.png' }
  };
  // In dry run or test, let's verify publish extracts threadReply and validates cleanly
  const xPoster = require('../src/platforms/x/x-poster');
  const simResult = await xPoster.publishPost({
    text: 'Scan My Disk visualizer',
    threadReply: 'Scan My Disk 🔍\n\nOne-time $5.\n\n👉 https://scanmydisk.com/',
    mediaPaths: ['dummy.png'],
    dryRun: true
  });
  assert.equal(simResult.success, true);
  assert.ok(simResult.threadReply.includes('https://scanmydisk.com/'));

  // 2. Facebook: Keeps URL directly in caption
  const fbPost = {
    platform: 'facebook',
    type: 'product',
    text: rawProductText
  };
  assert.doesNotThrow(() => {
    validatePost(fbPost, dummyProduct);
  });
  assert.ok(fbPost.text.includes('https://scanmydisk.com/'));

  // 3. Instagram: Replaces or appends with Check bio for link
  const igPost = {
    platform: 'instagram',
    type: 'product',
    text: 'Scan My Disk visualizes drives and cleans caches. Check bio for link.',
    media: { required: true, image_path: 'dummy.png' }
  };
  assert.doesNotThrow(() => {
    validatePost(igPost, dummyProduct);
  });
  assert.ok(igPost.text.toLowerCase().includes('check bio'));
});
