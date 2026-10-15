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
