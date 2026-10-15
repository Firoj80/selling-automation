const { canonicalPostUrl } = require('../content/post-metrics');
function evidenceUrl(raw, platform) {
  let post = canonicalPostUrl(raw, platform);
  if (!post && platform === 'facebook') {
    try {
      const url = new URL(raw);
      if (url.protocol === 'https:' && ['www.facebook.com', 'facebook.com'].includes(url.hostname) && !url.port && !url.username && !url.password && /^\/(?:reel\/\d+|groups\/[\w.-]+\/posts\/[\w.-]+)\/?$/.test(url.pathname)) post = `https://www.facebook.com${url.pathname.replace(/\/$/, '')}`;
    } catch { /* Unsupported public identity. */ }
  }
  if (!post) return null;
  if (platform !== 'facebook') return post;
  const source = new URL(raw), result = new URL(post);
  const id = source.searchParams.get('reply_comment_id') || source.searchParams.get('comment_id');
  if (id !== null) {
    if (!/^\d+$/.test(id)) return null;
    result.searchParams.set('comment_id', id);
  }
  return result.toString();
}
module.exports = { evidenceUrl };
