const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const executablePath = process.env.CONTENT_TEST_BROWSER || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/chromium', '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
].find(file => fs.existsSync(file));
const { attachImages } = require('../src/platforms/media-upload');
const { collectImagePosts } = require('../src/platforms/verify-image-post');

test('all four composers wait for delayed editable hydration and stable layout', { skip: !executablePath }, async () => {
  const { default: puppeteer } = await import('puppeteer-core');
  const { waitForComposerReady } = require('../src/platforms/composer-ready');
  const browser = await puppeteer.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage();
    for (const platform of ['threads', 'facebook', 'x', 'instagram']) {
      await page.setContent('<div contenteditable="true" role="textbox">Unrelated feed editor</div><div role="dialog" aria-busy="true" style="width:300px;min-height:100px"></div>');
      await page.evaluate(kind => {
        setTimeout(() => {
          const scope = document.querySelector('[role="dialog"]');
          const editor = document.createElement(kind === 'instagram' ? 'textarea' : 'div');
          editor.setAttribute('role', 'textbox');
          if (kind === 'instagram') editor.setAttribute('aria-label', 'Write a caption…');
          else editor.contentEditable = 'true';
          if (kind === 'x') editor.setAttribute('data-testid', 'tweetTextarea_0');
          scope.append(editor);
          setTimeout(() => { scope.removeAttribute('aria-busy'); window.readyAt = performance.now(); }, 150);
        }, 150);
      }, platform);
      const editor = await waitForComposerReady(page, { platform, stableMs: 150, timeout: 5000 });
      assert.ok(await page.evaluate(el => el.closest('[role="dialog"]') !== null, editor), platform);
      assert.ok(await page.evaluate(() => performance.now() - window.readyAt >= 150), platform);
      await require('../src/platforms/composer-text').writeComposerText(page, editor, 'Ready caption.');
    }
    await page.setContent('<div role="dialog" style="display:none"><div contenteditable="true"></div></div><div contenteditable="true" role="textbox">Feed only</div>');
    await assert.rejects(waitForComposerReady(page, { platform: 'threads', timeout: 500 }), /fully ready/);
    await page.setContent('<div role="dialog" style="width:300px;min-height:100px"><input type="file" style="display:none"></div>');
    assert.ok(await waitForComposerReady(page, { platform: 'instagram', phase: 'media', stableMs: 100, timeout: 3000 }));
    for (const platform of ['threads', 'x']) {
      await page.setContent('<div role="dialog"><div data-testid="tweetTextarea_0" contenteditable="true">Main</div><div data-testid="tweetTextarea_1" contenteditable="true">Reply</div></div>');
      const reply = await waitForComposerReady(page, { platform, editorIndex: 1, stableMs: 100, timeout: 3000 });
      assert.equal(await page.evaluate(el => el.innerText, reply), 'Reply');
    }
  } finally { await browser.close(); }
});

test('native composer insertion preserves complete captions and rejects damaged text', { skip: !executablePath }, async () => {
  const { default: puppeteer } = await import('puppeteer-core');
  const { writeComposerText, assertComposerText } = require('../src/platforms/composer-text');
  const browser = await puppeteer.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage();
    const caption = 'Looking at folder sizes in Windows Explorer is painful.\n\nVisual mapping helps. 🔍';
    await page.setContent('<div role="dialog"><div role="textbox" contenteditable="true">Old draft</div><textarea>Old caption</textarea></div>');
    for (const selector of ['[contenteditable="true"]', 'textarea']) {
      const editor = await page.$(selector);
      await writeComposerText(page, editor, caption);
      await assertComposerText(page, editor, caption);
      await page.evaluate(el => { if (el.tagName === 'TEXTAREA') el.value = 'ookat folder sizes'; else el.innerText = 'ookat folder sizes'; }, editor);
      await assert.rejects(assertComposerText(page, editor, caption), /submission blocked/);
    }
    await page.setContent('<div role="dialog"><button onclick="window.shareClicks=(window.shareClicks||0)+1">Share</button></div>');
    assert.equal(await require('../src/platforms/composer-action').clickVisibleAction(page, 'Share'), true);
    assert.equal(await page.evaluate(() => window.shareClicks), 1);
    await page.setContent('<textarea aria-label="Write a caption…"></textarea><button onclick="window.shareClicks=(window.shareClicks||0)+1">Share</button>');
    const editor = await page.$(require('../src/platforms/instagram/instagram-poster').INSTAGRAM_CAPTION_SELECTOR);
    assert.ok(editor, 'Full-page Instagram composer is supported');
    await writeComposerText(page, editor, caption);
    assert.equal(await require('../src/platforms/composer-action').clickVisibleAction(page, 'Share'), true);
    assert.equal(await page.evaluate(() => window.shareClicks), 2);
  } finally { await browser.close(); }
});

test('X and Instagram evidence rejects wrong caption, wrong author and missing image', { skip: !executablePath }, async () => {
  const { default: puppeteer } = await import('puppeteer-core');
  const { collectVisualPublication } = require('../src/platforms/visual-publication');
  const browser = await puppeteer.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage();
    const raster = await require('sharp')({ create: { width: 400, height: 400, channels: 3, background: '#663399' } }).png().toBuffer();
    const image = `data:image/png;base64,${raster.toString('base64')}`;
    const text = 'Looking at folder sizes in Windows Explorer is painful.';
    for (const platform of ['x', 'instagram']) {
      const postUrl = platform === 'x' ? 'https://x.com/seller/status/123' : 'https://www.instagram.com/p/ABC/';
      const profile = platform === 'x' ? 'https://x.com/seller' : 'https://www.instagram.com/seller/';
      await page.setContent(platform === 'x'
        ? `<article data-testid="tweet"><a href="${profile}">seller</a><div data-testid="tweetText">${text}</div><a href="${postUrl}"><time datetime="2026-10-15T12:00:00Z">Now</time></a><div data-testid="tweetPhoto"><a href="${postUrl}/photo/1"><img width="300" height="300" src="${image}"></a></div></article>`
        : `<main><div><div><a href="${profile}">seller</a><span>${text}</span></div><img width="300" height="300" src="${image}"><a href="https://www.instagram.com/seller/p/ABC/">Now</a></div><div><a href="https://www.instagram.com/other/p/DEF/">Other</a><img width="300" height="300" src="${image}"></div></main>`);
      await page.waitForFunction(() => [...document.images].every(img => img.complete && img.naturalWidth));
      const input = { platform, text, username: 'seller', postUrl };
      const evidence = await page.evaluate(collectVisualPublication, input);
      assert.equal(evidence.length, 1, platform);
      assert.equal(evidence[0].images, 1, platform);
      assert.deepEqual(await page.evaluate(collectVisualPublication, { ...input, text: 'ookat folder sizes' }), [], platform);
      assert.deepEqual(await page.evaluate(collectVisualPublication, { ...input, username: 'other' }), [], platform);
      await page.evaluate(() => document.querySelector('img').remove());
      assert.ok(!(await page.evaluate(collectVisualPublication, input)).some(e => e.images > 0), platform);
    }
    await page.setContent(`<div role="dialog"><div data-testid="tweetTextarea_0" contenteditable="true"></div><div role="progressbar" aria-valuenow="19"></div><div data-testid="attachments"><img width="300" height="300" src="${image}"></div></div>`);
    await page.waitForFunction(() => document.querySelector('img').complete && document.querySelector('img').naturalWidth);
    const { xMediaReady } = require('../src/platforms/x/x-poster');
    assert.equal(await page.evaluate(xMediaReady, 1), true, 'Character counter does not block image upload');
    await page.evaluate(() => { const progress = document.createElement('div'); progress.setAttribute('role', 'progressbar'); document.querySelector('[data-testid="attachments"]').append(progress); });
    assert.equal(await page.evaluate(xMediaReady, 1), false, 'Actual media upload progress blocks submission');
  } finally { await browser.close(); }
});
test('browser file attachment verifies a new raster preview and post DOM excludes avatars/replies', { skip: !executablePath }, async()=>{
  const { default: puppeteer } = await import('puppeteer-core');
  const browser = await puppeteer.launch({ executablePath, headless: true });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'selling-upload-'));
  const imagePath = path.join(dir, 'fixture.png');
  await require('sharp')({ create: { width: 1080, height: 1080, channels: 3, background: '#663399' } }).png().toFile(imagePath);
  const page=await browser.newPage();
  try {
    await page.setContent(`<div role="dialog" style="width:500px;min-height:100px"><img alt="Profile picture" width="40" height="40"><input type="file" accept="image/*"><div id="preview"></div></div><script>setTimeout(()=>{const editor=document.createElement('div');editor.contentEditable='true';editor.setAttribute('role','textbox');document.querySelector('[role="dialog"]').prepend(editor);},500);document.querySelector('input').onchange=e=>{const img=new Image();img.width=300;img.height=300;img.src=URL.createObjectURL(e.target.files[0]);document.getElementById('preview').append(img);};</script>`);
    assert.deepEqual(await attachImages(page,[imagePath]),{attached:1});
    const image=await page.$eval('#preview img',img=>({width:img.naturalWidth,height:img.naturalHeight}));assert.deepEqual(image,{width:1080,height:1080});
    await page.evaluate(()=>{
      const img=document.querySelector('#preview img');const root=document.createElement('article');root.innerHTML='<div data-ad-preview="message">Checked caption</div><a href="https://www.threads.com/@builder/post/ABC">permalink</a><article><img alt="reply image"></article>';
      root.append(img);document.body.replaceChildren(root);const avatar=img.cloneNode();avatar.width=40;avatar.height=40;avatar.alt='Profile picture';root.append(avatar);
    });
    const snapshots=await page.evaluate(collectImagePosts);assert.equal(snapshots.find(s=>s.text==='Checked caption').images.length,1);
  } finally {await browser.close();fs.rmSync(dir,{recursive:true,force:true});}
});
