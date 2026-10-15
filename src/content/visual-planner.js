function checkedVisualBrief(result) {
  if (!result || !['photo', 'illustration'].includes(result.style) || typeof result.scene !== 'string' || !result.scene.trim() || result.scene.length > 1400) throw new Error('Invalid visual brief');
  return { style: result.style, scene: result.scene, palette: typeof result.palette === 'string' ? result.palette.slice(0, 160) : 'natural warm light' };
}

/**
 * Build a compact product-context block from the product object.
 * Keeps tokens low — only the fields the visual AI needs.
 */
function productContext(product) {
  if (!product) return '';
  const name = product.product?.name || '';
  const type = product.product?.type || '';
  const desc = (product.product?.description || '').slice(0, 300);
  const audience = (product.product?.target_audience || '').slice(0, 200);
  if (!name) return '';
  return [
    `Product: ${name} (${type}).`,
    desc ? `What it does: ${desc}` : '',
    audience ? `Audience: ${audience}` : '',
  ].filter(Boolean).join(' ');
}

async function visualBrief(ai, caption, product) {
  const ctx = productContext(product);
  const lines = [
    'Return ONLY JSON {"style":"photo|illustration","scene":"...","palette":"..."}. No tools.',
    'Plan ONE premium, high-impact visual that directly and specifically illustrates the core concept in the caption.',
    ctx ? `Product Context — ${ctx}` : '',
    '',
    'CONTENT MATCHING & SCENE DIRECTIVES (Match the caption closely):',
    '• Device: A modern Windows PC desktop setup, ultrawide monitor, or clean Windows laptop in a realistic workspace (warm natural desk lighting, shallow depth of field). Do NOT feature Apple/Mac hardware.',
    '• ACTIVE SCREEN CONTENT (Crucial): The computer screen must be ON and clearly showing the specific topic described:',
    '  - If caption discusses visual charts (treemap, sunburst, disk maps): The monitor must visibly display that exact visualization (e.g. colored nested rectangles sized by storage, or radiating multi-tiered sunburst circular rings showing directory depth).',
    '  - If caption discusses large archives, old files, or ISOs/ZIPs: Show Windows File Explorer with files clearly organized and sorted by date or size.',
    '  - If caption discusses developer clutter (node_modules, caches, Docker): Show a clean developer desktop with code editor, terminal disk analysis, or deep folder hierarchies.',
    '  - If caption discusses low disk space or full drives: Show Windows "This PC" drive meters with red storage bars, or external NVMe/SSD storage drives alongside.',
    '  - If caption discusses duplicates or app leftovers: Show side-by-side folder comparison or cleanup folder views.',
    '• NEVER describe an empty screen, off screen, or generic blurred wallpaper. The screen content must directly reflect the topic.',
    '• Aesthetic Quality: Editorial tech photography style. Natural workspace, matte desk surfaces, clean cable management, premium atmospheric lighting.',
    '• Negative Constraints: NO text banners or promotional flyers. NO meme graphics, social media icons, fake company logos, or artificial watermark badges.',
    '',
    'Caption to illustrate:', JSON.stringify(caption),
  ].filter(l => l !== undefined && l !== null).join('\n');
  return checkedVisualBrief(await ai.callAi(lines, { taskType: 'CONTENT_GENERATION' }));
}
module.exports = { visualBrief, checkedVisualBrief, productContext };
