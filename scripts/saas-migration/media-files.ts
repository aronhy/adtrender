import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { extname, isAbsolute, join, resolve } from 'node:path';
import { matchesMediaSignature } from '../../saas/app/src/media/download';
const digest = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const mimeByExtension: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.mp4': 'video/mp4', '.webm': 'video/webm' };
const safeName = (name: string) => Boolean(name && name !== '.' && name !== '..' && name.length <= 255 && !/[\\/%?#\u0000-\u001f\u007f]/.test(name));

export async function checkedRoot(root: string) {
  try {
    // Requiring the canonical absolute spelling also rejects symlink ancestors.
    if (!isAbsolute(root) || resolve(root) !== root || await realpath(root) !== root) throw new Error();
    const stat = await lstat(root); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error();
    return stat;
  } catch { throw new Error('MEDIA_UNSAFE_ROOT'); }
}

/** Hold verified bytes in memory before any upload. No write is made to the source tree. */
export async function readApprovedFile(root: string, name: string, maxBytes: number) {
  if (!safeName(name)) throw new Error('MEDIA_UNSAFE_FILE');
  const rootBefore = await checkedRoot(root); const path = join(root, name);
  let before;
  try { before = await lstat(path); if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw new Error(); }
  catch { throw new Error('MEDIA_UNSAFE_FILE'); }
  if (before.size <= 0 || before.size > maxBytes) throw new Error('MEDIA_SIZE_LIMIT');
  const mimeType = mimeByExtension[extname(name).toLowerCase()]; if (!mimeType) throw new Error('MEDIA_UNSUPPORTED_TYPE');
  let handle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); } catch { throw new Error('MEDIA_UNSAFE_FILE'); }
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.nlink !== 1) throw new Error('MEDIA_UNSAFE_FILE');
    const chunks: Buffer[] = []; let count = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      count += chunk.length; if (count > maxBytes) throw new Error('MEDIA_SIZE_LIMIT'); chunks.push(Buffer.from(chunk));
    }
    const after = await handle.stat(); const rootAfter = await checkedRoot(root); const namedAfter = await lstat(path);
    if (rootBefore.dev !== rootAfter.dev || rootBefore.ino !== rootAfter.ino || namedAfter.isSymbolicLink() || namedAfter.dev !== after.dev || namedAfter.ino !== after.ino
      || after.size !== count || before.size !== count || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || after.nlink !== 1) throw new Error('MEDIA_FILE_CHANGED');
    const bytes = Buffer.concat(chunks); if (!matchesMediaSignature(mimeType, bytes)) throw new Error('MEDIA_INVALID_SIGNATURE');
    return { bytes, sha256: digest(bytes), sizeBytes: count, mimeType };
  } finally { await handle.close(); }
}
