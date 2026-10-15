const { writingSettings } = require('./learning-config');
const digest = value => require('crypto').createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
function rulesRevision(product) { return digest({ version: 1, settings: writingSettings(product) }); }
function validateStyle(text, product) {
  const settings = writingSettings(product);
  let textToCheck = text;
  if (product?.product?.name) textToCheck = textToCheck.replaceAll(product.product.name, '');
  if (settings.forbid_em_dash && textToCheck.includes('\u2014')) throw new Error('Writing rule: replace em dashes with natural sentence boundaries, commas or parentheses');
  if (/[ \t]{2,}/.test(text)) throw new Error('Writing rule: remove repeated spaces or tabs');
  return text;
}
module.exports = { validateStyle, rulesRevision };
