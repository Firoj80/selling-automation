const fs = require('fs');
const path = require('path');
async function attachImages(page, files) {
  if (!Array.isArray(files) || files.length < 1 || files.length > 4 || files.some(file => !path.isAbsolute(file) || !fs.existsSync(file))) throw new Error('Invalid image attachment paths');
  const dialogSelector = 'div[role="dialog"], [aria-modal="true"]';
  // The dialog shell can appear before Threads mounts its editable composer.
  await page.waitForFunction(selector => [...document.querySelectorAll(selector)].some(el => {
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && el.querySelector('[contenteditable="true"], [role="textbox"]');
  }), { timeout: 20000 }, dialogSelector);
  const before = await page.evaluate(selector => {
    const dialog = [...document.querySelectorAll(selector)].find(el => el.getBoundingClientRect().width > 0 && el.querySelector('[contenteditable="true"], [role="textbox"]'));
    if (!dialog) throw new Error('No active visible image composer');
    document.querySelectorAll('[data-meta-image-upload]').forEach(el => el.removeAttribute('data-meta-image-upload'));
    dialog.setAttribute('data-meta-image-upload', 'active');
    return [...dialog.querySelectorAll('img')].map(img => img.currentSrc || img.src);
  }, dialogSelector);
  // Some platforms mount the hidden file input outside the dialog.
  const activeSelector = '[data-meta-image-upload="active"]';
  const input = await page.$(`${activeSelector} input[type="file"]`) || await page.$('input[type="file"][accept*="image"]');
  if (!input) throw new Error('Image file input not found; required media was not attached');
  await input.uploadFile(...files);
  await page.waitForFunction((selector, previous, count) => {
    const dialog = document.querySelector(selector);
    if (!dialog) return false;
    if (dialog.querySelector('[role="progressbar"], [data-upload-state="uploading"], [aria-label*="uploading" i]')) return false;
    const alert = [...dialog.querySelectorAll('[role="alert"]')].some(el => /failed|could not|couldn.t|error/i.test(el.textContent || ''));
    if (alert) return false;
    const previews = [...dialog.querySelectorAll('img')].filter(img => { const rect = img.getBoundingClientRect(); return img.complete && img.naturalWidth >= 90 && img.naturalHeight >= 90 && rect.width >= 90 && rect.height >= 90 && !/avatar|profile picture/i.test(img.alt || '') && !previous.includes(img.currentSrc || img.src); });
    return previews.length >= count;
  }, { timeout: 45000 }, activeSelector, before, files.length);
  return { attached: files.length };
}
module.exports = { attachImages };
