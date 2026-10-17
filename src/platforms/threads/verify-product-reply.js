// Runs in the browser: match one complete, authored reply card on the parent detail page.
function collectProductReplyEvidence({ postUrl, text, username }) {
  const normalize = value => String(value || '').normalize('NFKC').replace(/[\u200b-\u200d\ufeff]/g, '').replace(/\s+/g, ' ').trim();
  const identity = raw => {
    try {
      const url = new URL(raw, location.href);
      const match = url.pathname.match(/^\/@([^/]+)\/post\/([\w-]+)(?:\/media)?\/?$/);
      return url.protocol === 'https:' && ['www.threads.com', 'threads.com', 'www.threads.net', 'threads.net'].includes(url.hostname) && !url.port && !url.username && !url.password && match
        ? { url: `https://www.threads.com/@${match[1]}/post/${match[2]}`, author: match[1].toLowerCase() } : null;
    } catch { return null; }
  };
  const destination = raw => {
    try {
      let url = new URL(raw, location.href);
      if (['l.threads.com', 'l.threads.net', 'l.instagram.com'].includes(url.hostname) && url.searchParams.has('u')) url = new URL(url.searchParams.get('u'));
      return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
    } catch { return null; }
  };
  const visible = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && !el.closest('[aria-hidden="true"], [inert], aside, [role="complementary"]'); };
  const parent = identity(postUrl), current = identity(location.href);
  if (!parent || current?.url !== parent.url || !username || parent.author !== username.replace(/^@/, '').toLowerCase()) return [];
  const expectedLinks = (text.match(/https?:\/\/[^\s]+/g) || []).map(destination);
  if (expectedLinks.length !== 1 || !expectedLinks[0]) return [];
  const anchors = [...document.querySelectorAll('a[href]')].filter(visible);
  if (!anchors.some(a => identity(a.href)?.url === parent.url)) return [];
  const results = [];
  for (const anchor of anchors) {
    const reply = identity(anchor.href);
    if (!reply || reply.url === parent.url || reply.author !== parent.author) continue;
    for (let root = anchor.parentElement; root && !['BODY', 'HTML', 'MAIN'].includes(root.tagName); root = root.parentElement) {
      const links = [...root.querySelectorAll('a[href]')].filter(visible);
      const ids = new Set(links.map(a => identity(a.href)?.url).filter(Boolean));
      if (ids.size !== 1 || !ids.has(reply.url)) break;
      if (!links.some(a => destination(a.href) === expectedLinks[0])) continue;
      const clone = root.cloneNode(true);
      // The UI abbreviates URL labels; use the verified destination from that same card.
      for (const a of clone.querySelectorAll('a[href]')) if (destination(a.href) === expectedLinks[0]) a.textContent = expectedLinks[0];
      for (const br of clone.querySelectorAll('br')) br.replaceWith('\n');
      for (const block of clone.querySelectorAll('div,p')) { block.prepend(' '); block.append(' '); }
      if (normalize(clone.textContent).includes(normalize(text))) {
        results.push({ postUrl: reply.url, parentUrl: parent.url, author: reply.author, text, salesUrl: expectedLinks[0] });
        break;
      }
    }
  }
  return results;
}
async function verifyProductReply(page, input, { attempts = 15, delayMs = 1000 } = {}) {
  await page.goto(input.postUrl, { waitUntil: 'domcontentloaded', timeout: 35000 });
  for (let attempt = 0; attempt < attempts; attempt++) {
    const replies = await page.evaluate(collectProductReplyEvidence, input);
    if (replies.length) return replies[0];
    if (attempt + 1 < attempts) await new Promise(resolve => setTimeout(resolve, delayMs));
  }
  throw new Error('Main Threads post exists but its complete product reply and exact sales link could not be verified; review before retrying');
}
module.exports = { verifyProductReply, collectProductReplyEvidence };
