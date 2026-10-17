// Keep the checked image caption intact; persist the exact outgoing copy separately.
function publicationContent(post, product) {
  if (!product.publishing?.promote_every_post) return null;
  const { name, sales_url: url, price } = product.product;
  if (!name || !url) throw new Error('Product promotion requires a product name and sales URL');
  let text = post.text.trim();
  let threadReply;
  if (['threads', 'x'].includes(post.platform)) {
    text = text.split(url).join('').trim();
    threadReply = post.threadReply || `${name}${price ? `. ${price} one-time.` : '.'}\n${url}`;
  } else if (post.platform === 'facebook') {
    if (!text.includes(name)) text += `\n\n${name}${price ? `. ${price} one-time.` : '.'}`;
    if (!text.includes(url)) text += `\n${url}`;
  } else if (post.platform === 'instagram') {
    if (!text.includes(name)) text += `\n\n${name}${price ? `. ${price} one-time.` : '.'}`;
    if (!/check bio (?:for )?link|link in bio/i.test(text)) text += '\nCheck bio for link.';
  }
  const payload = { text, type: 'product', ...(threadReply ? { threadReply } : {}) };
  require('./content-engine').validatePost({ ...post, ...payload }, product);
  return payload;
}
module.exports = { publicationContent };
