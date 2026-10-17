const { composerReadyElement } = require('../composer-ready');

async function openInstagramComposer(page, { timeout = 45000 } = {}) {
  // Wait through navigation hydration; click each navigation action only once.
  let createClicked = false, postClicked = false;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (/\/accounts\/login|\/challenge\/|\/checkpoint\//.test(new URL(page.url()).pathname)) {
      throw new Error('Instagram requires login or account verification before composing');
    }
    const ready = await page.evaluateHandle(composerReadyElement, { platform: 'instagram', phase: 'media', stableMs: 500 });
    if (ready.asElement()) return ready.asElement();
    await ready.dispose();
    const action = !createClicked ? 'create' : !postClicked ? 'post' : null;
    if (action) {
      const clicked = await page.evaluate(kind => {
        const visible = el => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden' && !el.closest('[aria-hidden="true"], [inert]');
        };
        const controls = [...document.querySelectorAll('a,button,[role="button"]')].filter(visible);
        const target = controls.find(el => {
          const label = (el.getAttribute('aria-label') || el.innerText || '').trim().toLowerCase();
          return kind === 'create'
            ? ['create', 'new post'].includes(label) || !!el.querySelector('svg[aria-label="New post"],svg[aria-label="Create"]')
            : label === 'post';
        });
        if (!target || target.getAttribute('aria-disabled') === 'true') return false;
        target.click(); return true;
      }, action);
      if (clicked) { if (action === 'create') createClicked = true; else postClicked = true; }
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error('Instagram Create/media composer did not become ready before timeout');
}
module.exports = { openInstagramComposer };
