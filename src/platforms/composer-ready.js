// Browser-side readiness test: wait for hydration and a stable, editable surface.
function composerReadyElement({ platform, phase = 'caption', stableMs = 500, editorIndex = 0 }) {
  const key = `${platform}:${phase}:${editorIndex}`;
  const reject = () => { if (document.__sellingComposerReady) delete document.__sellingComposerReady[key]; return false; };
  const visible = el => {
    if (!el || el.closest('[aria-hidden="true"], [inert]')) return false;
    const box = el.getBoundingClientRect(), style = getComputedStyle(el);
    return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  };
  const selectors = {
    threads: '[role="dialog"] [contenteditable="true"], [aria-modal="true"] [contenteditable="true"]',
    facebook: '[role="dialog"] [contenteditable="true"][role="textbox"]',
    x: '[role="dialog"] [data-testid^="tweetTextarea_"][contenteditable="true"]',
    instagram: 'textarea[aria-label*="caption" i], [contenteditable="true"][aria-label*="caption" i], [role="dialog"] textarea, [role="dialog"] [contenteditable="true"][role="textbox"]'
  };
  let editor, scope;
  if (platform === 'instagram' && phase === 'media') {
    scope = [...document.querySelectorAll('[role="dialog"], [aria-modal="true"]')].find(visible);
    if (!scope && location.pathname.startsWith('/create/')) scope = document.querySelector('main') || document.body;
    if (scope) editor = scope.querySelector('input[type="file"]') || document.querySelector('input[type="file"]');
  } else {
    editor = [...document.querySelectorAll(selectors[platform] || 'invalid-platform')].filter(visible)[editorIndex];
    scope = editor?.closest('[role="dialog"], [aria-modal="true"]') || (platform === 'instagram' ? editor?.parentElement : null);
  }
  if (!editor || !scope || editor.disabled || editor.readOnly || editor.getAttribute('aria-disabled') === 'true' || scope.closest('[aria-busy="true"]') || scope.querySelector('[data-loading="true"]')) return reject();
  if (!(platform === 'instagram' && phase === 'media') && !visible(editor)) return reject();
  if (!(platform === 'instagram' && phase === 'media')) {
    const box = editor.getBoundingClientRect();
    const hit = document.elementFromPoint(Math.min(innerWidth - 1, Math.max(0, box.x + box.width / 2)), Math.min(innerHeight - 1, Math.max(0, box.y + box.height / 2)));
    if (!hit || !(hit === editor || editor.contains(hit))) return reject();
  }
  const box = (phase === 'media' ? scope : editor).getBoundingClientRect();
  if (box.width <= 0 || box.height <= 0) return reject();
  const signature = [box.x, box.y, box.width, box.height].map(Math.round).join(',');
  const cache = document.__sellingComposerReady ||= {};
  const previous = cache[key];
  if (!previous || previous.editor !== editor || previous.signature !== signature) {
    cache[key] = { editor, signature, since: performance.now() };
    return false;
  }
  return performance.now() - previous.since >= stableMs ? editor : false;
}
async function waitForComposerReady(page, { platform, phase = 'caption', timeout = 30000, stableMs = 500, editorIndex = 0 }) {
  if (!['x', 'threads', 'facebook', 'instagram'].includes(platform)) throw new Error('Unsupported composer platform');
  try {
    const handle = await page.waitForFunction(composerReadyElement, { timeout, polling: 100 }, { platform, phase, stableMs, editorIndex });
    const editor = handle.asElement();
    if (!editor) { await handle.dispose(); throw new Error('Composer editor unavailable'); }
    return editor;
  } catch (cause) {
    throw new Error(`${platform} ${phase} composer did not become fully ready; the next composer action was blocked`, { cause });
  }
}
module.exports = { composerReadyElement, waitForComposerReady };
