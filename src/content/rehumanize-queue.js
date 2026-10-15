const fs = require('fs');
const path = require('path');
const { save, withLock } = require('./content-store');
const { loadProduct, revisions } = require('./product-config');
const { ContentHumanizer, loadWriting } = require('./content-humanizer');
const { validatePost } = require('./content-engine');
const { syncQueue } = require('./content-queue');

async function rehumanize(root, args, { ai, onProgress = event => console.log(`[Rehumanize] ${JSON.stringify(event)}`) } = {}) {
  const preview = args.includes('--preview');
  const includeManual = args.includes('--include-manual');
  const target = args[0];
  if (!target || args.slice(1).some(a => !['--preview', '--include-manual'].includes(a)) || new Set(args).size !== args.length) throw new Error('Supported: queue rehumanize ID|--pending [--include-manual] [--preview]');
  const file = fs.existsSync(path.join(root, 'private/product-content.json')) ? path.join(root, 'private/product-content.json') : path.join(root, 'private/product-generation.json');
  const action = async () => {
    if (!fs.existsSync(file)) throw new Error('No saved campaign or generation checkpoint to rehumanize');
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    const { product, copy } = loadProduct(root);
    const writing = loadWriting(root, product);
    if (!writing.enabled && !preview) throw new Error('Enable writing.humanizer_enabled before rehumanizing');
    const posts = state.posts.filter(p => (target === '--pending' ? ['pending', 'needs_edit'].includes(p.status) : p.id === target) && (includeManual || target !== '--pending' || !p.manuallyEdited)).filter(p => target !== '--pending' || p.writing?.status !== 'edited' || p.writing.rulesRevision !== writing.rulesRevision || p.writing.skillVersion !== writing.skillVersion || p.writing.voiceVersion !== writing.voiceVersion);
    if (target !== '--pending' && !posts.length) throw new Error('Unknown post ID');
    if (posts.some(p => !['pending', 'needs_edit', 'held', 'missed'].includes(p.status) || p.attemptedAt != null || p.result)) throw new Error('Rehumanize only unattempted drafts; reconcile uncertain submissions first');
    if (preview) return { status: 'preview', file, posts: posts.map(p => ({ id: p.id, platform: p.platform, status: p.status, manuallyEdited: !!p.manuallyEdited })) };
    if (!posts.length) return { status: 'complete', file, processed: 0, ready: 0, needsEdit: 0 };
    const editor = new ContentHumanizer({ ai: ai || require('../ai/ai-runtime'), writing });
    let ready = 0, needsEdit = 0;
    for (const [index, post] of posts.entries()) {
      onProgress({ id: post.id, current: index + 1, total: posts.length, stage: 'editing' });
      const previous = structuredClone(post);
      const edited = await editor.edit(post, product, validatePost, { onStage: (stage, detail) => onProgress({ id: post.id, current: index + 1, total: posts.length, stage, detail }) });
      if (edited.writing.status === 'edited' && state.posts.some(other => other.id !== post.id && other.text.trim().toLowerCase().replace(/\s+/g, ' ') === edited.text.trim().toLowerCase().replace(/\s+/g, ' '))) {
        edited.text = post.text; edited.status = 'needs_edit'; edited.writing = { ...edited.writing, status: 'needs_edit', reason: 'Rewrite duplicates another saved post' };
      }
      post.revisions ||= [];
      post.revisions.push({ action: 'rehumanize', at: Date.now(), text: previous.text, type: previous.type, writing: previous.writing, status: previous.status, scheduledAt: previous.scheduledAt });
      post.text = edited.text; post.writing = edited.writing;
      post.contentRevision = (post.contentRevision || 0) + 1;
      if (edited.writing.status === 'needs_edit') { post.status = 'needs_edit'; post.editingResumeStatus ||= previous.status === 'needs_edit' ? 'pending' : previous.status; needsEdit++; }
      else {
        post.status = previous.status === 'needs_edit' ? previous.editingResumeStatus || 'pending' : previous.status;
        delete post.editingResumeStatus;
        post.validation = { status: 'valid', rulesRevision: writing.rulesRevision, at: Date.now() }; ready++;
      }
      state.writing = writing;
      // Update the writing revision only; product fact review remains mandatory.
      if (state.configRevisions) state.configRevisions.writing = revisions(product, copy).writing;
      if (path.basename(file) === 'product-content.json') syncQueue(state);
      save(file, state); // Commit each edit before starting the next AI call.
      onProgress({ id: post.id, stage: 'saved', completed: index + 1, total: posts.length, ready, needsEdit });
    }
    return { status: 'complete', file, processed: posts.length, ready, needsEdit };
  };
  return preview ? action() : withLock(root, action);
}
module.exports = { rehumanize };
