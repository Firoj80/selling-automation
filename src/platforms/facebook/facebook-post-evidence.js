function collectFacebookEvidence({ text, username = null, postUrl = null }) {
  const normalize = value => String(value || '').replace(/\s+/g, ' ').trim();
  const identity = raw => {
    try {
      const u = new URL(raw); if (u.protocol !== 'https:' || !['www.facebook.com', 'facebook.com', 'm.facebook.com'].includes(u.hostname) || u.username || u.password || u.port) return null;
      const m = u.pathname.match(/^\/([^/]+)\/posts\/([\w.:-]+)\/?$/);
      if (m) return `https://www.facebook.com/${m[1]}/posts/${m[2]}`;
      if (/^\/photo(?:\.php)?\/?$/.test(u.pathname) && /^\d+$/.test(u.searchParams.get('fbid') || '')) return `https://www.facebook.com/photo/?fbid=${u.searchParams.get('fbid')}`;
      if (['/story.php', '/permalink.php'].includes(u.pathname) && u.searchParams.get('story_fbid')) return `https://www.facebook.com/permalink.php?story_fbid=${u.searchParams.get('story_fbid')}${u.searchParams.get('id') ? '&id=' + u.searchParams.get('id') : ''}`;
      return null;
    } catch { return null; }
  };
  const selector = '[data-ad-preview="message"], [data-ad-comet-preview="message"]';
  const results = [];
  for (const message of document.querySelectorAll(selector)) {
    if (!message.getClientRects().length || normalize(message.innerText) !== normalize(text)) continue;
    for (let root = message.parentElement; root && !['BODY', 'HTML'].includes(root.tagName); root = root.parentElement) {
      if (root.querySelectorAll(selector).length > 1) break;
      const anchors = [...root.querySelectorAll('a[href]')];
      const links = [...new Set(anchors.map(a => identity(a.href)).filter(Boolean))];
      if (!links.length || postUrl && !links.includes(postUrl)) continue;
      const author = !username || anchors.some(a => { try { const u = new URL(a.href); return u.hostname.endsWith('facebook.com') && u.pathname.replace(/^\//, '').replace(/\/$/, '').toLowerCase() === username.toLowerCase(); } catch { return false; } });
      if (!author) continue;
      const images = [...root.querySelectorAll('img')].filter(img => { const r = img.getBoundingClientRect(); return img.complete && img.naturalWidth >= 200 && img.naturalHeight >= 120 && r.width >= 100 && r.height >= 100 && !/avatar|profile picture/i.test(img.alt || ''); }).map(img => ({ src: img.currentSrc || img.src, width: img.naturalWidth, height: img.naturalHeight }));
      if (images.length) { results.push({ text: message.innerText, links, images, labels: [], authorVerified: !!username && author }); break; }
    }
  }
  return results;
}
module.exports = { collectFacebookEvidence };
