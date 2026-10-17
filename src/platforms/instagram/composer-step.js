function readyInstagramStep() {
  const visible = el => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden' && !el.closest('[aria-hidden="true"],[inert],[aria-busy="true"]');
  };
  const scope = [...document.querySelectorAll('[role="dialog"],[aria-modal="true"]')].find(visible)
    || (location.pathname.startsWith('/create/') ? document.querySelector('main') || document.body : null);
  if (!scope) return false;
  const caption = [...scope.querySelectorAll('textarea[aria-label*="caption" i],[contenteditable="true"][aria-label*="caption" i]')].find(visible);
  if (caption && !caption.disabled && !caption.readOnly) return 'caption';
  const next = [...scope.querySelectorAll('button,[role="button"]')].find(el => visible(el) && (el.innerText || '').trim().toLowerCase() === 'next' && !el.disabled && el.getAttribute('aria-disabled') !== 'true');
  return next ? 'next' : false;
}
async function waitForInstagramStep(page, timeout = 30000) {
  const handle = await page.waitForFunction(readyInstagramStep, { timeout, polling: 100 });
  try { return await handle.jsonValue(); } finally { await handle.dispose(); }
}
module.exports = { readyInstagramStep, waitForInstagramStep };
