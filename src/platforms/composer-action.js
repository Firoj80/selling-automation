async function clickVisibleAction(page, expectedText) {
  const handle = await page.evaluateHandle(text => {
    const scope = [...document.querySelectorAll('[role="dialog"]')].find(e => e.getClientRects().length) || document;
    return [...scope.querySelectorAll('button, div[role="button"]')].find(el => el.getClientRects().length && !el.disabled && el.getAttribute('aria-disabled') !== 'true' && (el.innerText || '').trim().toLowerCase() === text.toLowerCase()) || null;
  }, expectedText);
  const button = handle.asElement();
  try { if (!button) return false; await button.click(); return true; }
  finally { await handle.dispose(); }
}
module.exports = { clickVisibleAction };
