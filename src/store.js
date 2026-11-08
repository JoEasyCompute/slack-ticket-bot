import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

export class FileStore {
  constructor(directory) { this.directory = directory; }
  path(key) { return join(this.directory, `${createHash('sha256').update(key).digest('hex')}.json`); }
  async claim(key, record) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    let file;
    try { file = await open(this.path(key), 'wx', 0o600); }
    catch (error) { if (error.code === 'EEXIST') return false; throw error; }
    try {
      await file.writeFile(JSON.stringify({ ...record, status: 'pending', createdAt: new Date().toISOString() }, null, 2));
      await file.sync();
    } finally { await file.close(); }
    return true;
  }
  async complete(key, record) {
    const destination = this.path(key);
    const temp = `${destination}.tmp`;
    const file = await open(temp, 'w', 0o600);
    try {
      await file.writeFile(JSON.stringify({ ...record, status: 'sent', updatedAt: new Date().toISOString() }, null, 2));
      await file.sync();
    } finally { await file.close(); }
    await rename(temp, destination);
  }
  async release(key) { await unlink(this.path(key)); }
}
