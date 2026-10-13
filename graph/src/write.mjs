// Atomic writes: a temp file in the same directory, flushed, then renamed over the target. A failure at any
// point leaves the previous file untouched and removes the temp file.

import * as nodeFs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join } from 'node:path';

export function writeAtomic(target, data, fs = nodeFs) {
  const dir = dirname(target);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${basename(target)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  let fd = null;
  try {
    fd = fs.openSync(tmp, 'wx', 0o644);
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, target);
  } catch (e) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* already closed */
      }
    }
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* nothing to clean */
    }
    throw e;
  }
}
