const fs = require('fs');
const path = require('path');
const { randomUUID, createHash } = require('crypto');
const { save, withLock } = require('./content-store');
const { loadProduct, revisions } = require('./product-config');
const { changeQueue } = require('./content-queue');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const queueFile = root => path.join(root, 'private/product-content.json');
function processQueueRequests(root, liveState) {
  const dir = path.join(root, 'private/management');
  if (!fs.existsSync(dir)) return [];
  const requests = fs.readdirSync(dir).filter(name => /^[a-f0-9-]{36}\.json$/.test(name)).map(name => ({ file: path.join(dir, name), request: read(path.join(dir, name)) })).filter(({ request }) => request.kind === 'queue' && request.status === 'pending').sort((a, b) => a.request.createdAt - b.request.createdAt);
  const results = [];
  for (const { file, request } of requests) {
    try {
      const state = read(queueFile(root));
      if (!state.appliedQueueRequests?.includes(request.id)) {
        const { product, copy } = loadProduct(root);
        if (digest(state) !== request.expectedState || revisions(product, copy).config !== request.expectedConfig) throw new Error('Queue or settings changed. Preview and submit this request again.');
        const changed = changeQueue(state, product, request.operation);
        changed.state.appliedQueueRequests = [...(state.appliedQueueRequests || []), request.id];
        save(queueFile(root), changed.state);
        if (liveState) Object.assign(liveState, changed.state);
      } else if (liveState) Object.assign(liveState, state);
      const result = { ...request, status: 'applied', completedAt: Date.now() };
      save(file, result); results.push(result);
    } catch (err) {
      const result = { ...request, status: 'rejected', reason: err.message, completedAt: Date.now() };
      save(file, result); results.push(result);
    }
  }
  return results;
}
async function submitQueue(root, operation, preview = false) {
  const state = read(queueFile(root));
  const { product, copy } = loadProduct(root);
  const proposed = changeQueue(state, product, operation);
  if (preview) return { status: 'preview', changes: proposed.changes };
  const id = randomUUID();
  const request = { kind: 'queue', id, status: 'pending', operation, expectedState: digest(state), expectedConfig: revisions(product, copy).config, createdAt: Date.now() };
  const file = path.join(root, 'private/management', `${id}.json`);
  save(file, request);
  try { return await withLock(root, () => { processQueueRequests(root); return read(file); }); }
  catch (err) {
    if (err.code === 'CAMPAIGN_LOCKED') return { id, status: 'pending', message: 'Queued for a safe runtime boundary. Use queue request ID to check whether it applied.' };
    throw err;
  }
}
async function queueCommand(root, args) {
  const [command, ...rest] = args;
  if (command === 'rehumanize') return require('./rehumanize-queue').rehumanize(root, rest);
  if (command === 'request') return require('./config-management').settingsCommand(root, args);
  if (command === 'list' && !rest.length) {
    if (!fs.existsSync(queueFile(root))) return { status: 'not_created', posts: [] };
    const state = read(queueFile(root));
    return { posts: [...state.posts].sort((a, b) => (a.scheduledAt || 0) - (b.scheduledAt || 0)).map(({ id, platform, status, type, scheduledAt, text, holdReason, media }) => ({ id, platform, status, type, scheduledAt: Number.isFinite(scheduledAt) ? new Date(scheduledAt).toISOString() : null, text, holdReason, media })) };
  }
  if (command === 'show' && rest.length === 1) {
    const post = read(queueFile(root)).posts.find(p => p.id === rest[0]);
    if (!post) throw new Error('Unknown post ID'); return post;
  }
  let operation;
  let preview = rest.at(-1) === '--preview';
  if (command === 'edit' && rest.length === 3 && rest[1] === '--file') operation = { kind: 'edit', id: rest[0], text: fs.readFileSync(path.resolve(root, rest[2]), 'utf8').replace(/^\uFEFF/, '').trim() };
  else if (command === 'hold' && rest.length === 1) operation = { kind: 'hold', id: rest[0] };
  else if (command === 'retry-media' && rest.length === 1) operation = { kind: 'retry-media', id: rest[0] };
  else if (command === 'reschedule' && rest.length === 3 && rest[1] === '--at') operation = { kind: 'reschedule', id: rest[0], at: rest[2] };
  else if (command === 'reschedule' && rest.length === 4 && rest[0] === '--pending' && rest[1] === '--from' && ['--preview', '--apply'].includes(rest[3])) operation = { kind: 'reschedule-all', from: rest[2] };
  else if (command === 'catch-up' && rest.length === 1 && ['--preview', '--apply'].includes(rest[0])) operation = { kind: 'catch-up' };
  else if (command === 'update-links' && rest.length === 3 && rest[0] === '--from' && ['--preview', '--apply'].includes(rest[2])) operation = { kind: 'update-links', from: rest[1] };
  else if (command === 'extend' && rest.length === 2 && rest[0] === '--until') operation = { kind: 'extend', until: rest[1] };
  else if (command === 'clone-to-platforms') {
    let platforms = ['x', 'instagram'];
    const pIdx = rest.indexOf('--platforms');
    if (pIdx !== -1 && rest[pIdx + 1]) {
      platforms = rest[pIdx + 1].split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    }
    operation = { kind: 'clone-to-platforms', platforms };
  }
  else throw new Error('Supported: queue list | show ID | edit ID --file FILE | hold ID | reschedule ID --at ISO_TIME | reschedule --pending --from YYYY-MM-DD --preview|--apply | catch-up --preview|--apply | update-links --from OLD_URL --preview|--apply | extend --until ISO_TIME | clone-to-platforms [--platforms x,instagram] [--preview|--apply] | request ID');
  return submitQueue(root, operation, preview);
}
module.exports = { queueCommand, submitQueue, processQueueRequests };
