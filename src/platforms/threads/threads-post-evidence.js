// Runs in the page. Current Threads cards have no article or lexical-text markers.
// Bound evidence by the post permalink instead of accepting feed-wide text.
function collectThreadsEvidence({ text, username = null, postUrl = null }) {
  const normalize = value => String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  const expected = normalize(text);
  if (!expected) return [];
  const identity = raw => {
    try {
      const url = new URL(raw);
      if (url.protocol !== 'https:' || !['www.threads.com', 'threads.com', 'www.threads.net', 'threads.net'].includes(url.hostname) || url.port || url.username || url.password) return null;
      const match = url.pathname.match(/^\/@([^/]+)\/post\/([\w-]+)(?:\/media)?\/?$/);
      return match ? { url: `https://www.threads.com/@${match[1]}/post/${match[2]}`, author: match[1] } : null;
    } catch { return null; }
  };
  const visible = element => { const rect = element.getBoundingClientRect(); return rect.width > 0 && rect.height > 0; };
  const results = new Map();
  for (const anchor of document.querySelectorAll('a[href]')) {
    const target = identity(anchor.href);
    if (!target || !visible(anchor) || username && target.author.toLowerCase() !== username.replace(/^@/, '').toLowerCase() || postUrl && target.url !== postUrl) continue;
    let fallback;
    for (let root = anchor.parentElement; root && !['BODY', 'HTML'].includes(root.tagName); root = root.parentElement) {
      const links = [...root.querySelectorAll('a[href]')].filter(visible);
      const identities = new Set(links.map(link => identity(link.href)?.url).filter(Boolean));
      // Never combine a neighboring post, nested reply or suggested post with this one.
      if (identities.size !== 1 || !identities.has(target.url)) break;
      if (!visible(root) || !normalize(root.innerText).includes(expected)) continue;
      const images = [...root.querySelectorAll('img')].filter(img => {
        const mediaLink = img.closest('a[href]');
        return mediaLink && /\/media\/?$/.test(new URL(mediaLink.href).pathname) && identity(mediaLink.href)?.url === target.url &&
          visible(img) && img.complete && img.naturalWidth >= 200 && img.naturalHeight >= 120 && !/avatar|profile picture/i.test(img.alt || '');
      }).map(img => ({ src: img.currentSrc || img.src, width: img.naturalWidth, height: img.naturalHeight }));
      const labels = [...root.querySelectorAll('button, [role="button"], a, [aria-label]')].filter(visible).flatMap(el => [el.getAttribute('aria-label') || '', el.innerText || '']);
      const evidence = { text: root.innerText, links: [target.url], labels, images };
      fallback ||= evidence;
      if (images.length) { fallback = evidence; break; }
    }
    if (fallback && (!results.has(target.url) || fallback.images.length > results.get(target.url).images.length)) results.set(target.url, fallback);
  }
  return [...results.values()];
}
module.exports = { collectThreadsEvidence };
