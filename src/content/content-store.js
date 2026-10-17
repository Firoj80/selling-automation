const fs = require('fs');
const path = require('path');
function writeFlushed(file, data) {
  const fd = fs.openSync(file, 'w');
  try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
}
function lockGuard(root, action) {
  const dir = path.join(root, 'private');
  fs.mkdirSync(dir, { recursive: true });
  const guard = path.join(dir, 'product-content-lock.guard');
  let fd;
  try { fd = fs.openSync(guard, 'wx'); } catch (cause) {
    if (cause.code !== 'EEXIST') throw cause;
    throw new Error('Lock ownership is being changed or a lock operation was interrupted. Preserve the guard for review and retry later.');
  }
  try { fs.writeFileSync(fd, String(process.pid)); return action(); }
  finally { fs.closeSync(fd); fs.unlinkSync(guard); }
}
function save(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  const serialized = JSON.stringify(data, null, 2) + '\n';
  if (fs.existsSync(file)) {
    const previous = fs.readFileSync(file, 'utf8');
    try {
      JSON.parse(previous);
      const backupTmp = `${file}.last-good.${process.pid}.tmp`;
      writeFlushed(backupTmp, previous); fs.renameSync(backupTmp, `${file}.last-good`);
    }
    catch (err) { if (!(err instanceof SyntaxError)) throw err; }
  }
  writeFlushed(tmp, serialized);
  fs.renameSync(tmp, file);
}
async function withLock(root, action) {
  const file = path.join(root, 'private', 'product-content.lock');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let fd;
  try { fd = lockGuard(root, () => fs.openSync(file, 'wx')); } catch (cause) {
    if (cause.code !== 'EEXIST') throw cause;
    const error = new Error('Campaign is already locked. Use recover --inspect to check the owner; do not delete an active lock.');
    error.code = 'CAMPAIGN_LOCKED';
    throw error;
  }
  const owner = JSON.stringify({ pid: process.pid, token: require('crypto').randomUUID(), createdAt: Date.now() });
  try {
    fs.writeFileSync(fd, owner);
    return await action();
  } finally {
    fs.closeSync(fd);
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === owner) fs.unlinkSync(file);
  }
}
module.exports = { save, withLock, lockGuard };
