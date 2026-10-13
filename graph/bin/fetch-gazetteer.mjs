#!/usr/bin/env node
// fetch-gazetteer: the ONLY network path of graph/ (viz.md 5.6.2 as amended; task viz-geocode-offline).
//
//   fetch-gazetteer [--dir <dir>] [--update] [--lock <path>]
//
// Downloads the public GeoNames dumps (CC BY 4.0) and the Natural Earth admin-0 and admin-1 files (public domain) listed in
// src/gazetteer.mjs into <dir> (default $HFY_GAZETTEER_DIR, else ~/Library/Caches/hfy-gazetteer), never into the repository,
// and pins each file's sha256, size and retrieval date in graph/gazetteer.lock.json. A file whose sha256 differs from its pin
// fails with GAZETTEER_CHECKSUM (exit 8) and nothing is written, unless --update re-pins it after review. Bulk downloads of
// public files reveal nothing about the family; the GeoNames web service is never called. Builds never fetch.
//
// On a proxied network, Node's fetch needs NODE_USE_ENV_PROXY=1 (Node 22.21 or later).

import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { EXIT, GraphError } from '../src/errors.mjs';
import { GAZETTEER_FILES, LOCK_URL, defaultGazetteerDir, sha256 } from '../src/gazetteer.mjs';
import { stringify } from '../src/canonical.mjs';
import { writeAtomic } from '../src/write.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const USAGE = 'usage: fetch-gazetteer [--dir <dir>] [--update] [--lock <path>]';

const inside = (dir, root) => {
  const rel = relative(root, dir);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

function readLockOrEmpty(path) {
  if (!existsSync(path)) return { version: 1, files: {} };
  const lock = JSON.parse(readFileSync(path, 'utf8'));
  if (!lock || typeof lock !== 'object' || !lock.files || typeof lock.files !== 'object') {
    throw new GraphError('GAZETTEER_CHECKSUM', 'the lock file has no files object');
  }
  return lock;
}

/**
 * @param {string[]} argv
 * @param {{ fetch?: typeof fetch, env?: object, now?: Date, stderr?: { write: Function }, repoRoot?: string }} [io]
 * @returns {Promise<number>} the exit code
 */
export async function main(argv, io = {}) {
  const err = io.stderr ?? process.stderr;
  const doFetch = io.fetch ?? globalThis.fetch;
  try {
    let args;
    try {
      args = parseArgs({ args: argv, options: { dir: { type: 'string' }, update: { type: 'boolean' }, lock: { type: 'string' } } });
    } catch {
      throw new GraphError('INPUT_MISSING', `bad arguments\n${USAGE}`);
    }
    const dir = args.values.dir ? resolve(args.values.dir) : defaultGazetteerDir(io.env ?? process.env);
    if (inside(dir, io.repoRoot ?? REPO)) {
      throw new GraphError('INPUT_MISSING', 'the gazetteer directory must be outside the repository: the dumps are never committed');
    }
    const lockPath = args.values.lock ? resolve(args.values.lock) : fileURLToPath(LOCK_URL);
    const lock = readLockOrEmpty(lockPath);
    const day = (io.now ?? new Date()).toISOString().slice(0, 10);

    const got = [];
    for (const f of GAZETTEER_FILES) {
      const res = await doFetch(f.url);
      if (!res.ok) throw new GraphError('INPUT_MISSING', `${f.name}: the download failed with HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      got.push({ f, buf, hash: sha256(buf), modified: res.headers.get('last-modified') ?? null });
    }
    const changed = got.filter(({ f, hash }) => lock.files[f.name] && lock.files[f.name].sha256 && lock.files[f.name].sha256 !== hash);
    if (changed.length && !args.values.update) {
      throw new GraphError('GAZETTEER_CHECKSUM', `${changed.map((c) => c.f.name).join(', ')}: the download differs from graph/gazetteer.lock.json; review the new snapshot, then re-run with --update`);
    }
    for (const { f, buf, hash, modified } of got) {
      writeAtomic(resolve(dir, f.name), buf);
      const prev = lock.files[f.name];
      const same = prev && prev.sha256 === hash;
      lock.files[f.name] = {
        url: f.url,
        licence: f.licence,
        sha256: hash,
        bytes: buf.length,
        retrieved: same && prev.retrieved ? prev.retrieved : day,
        lastModified: modified,
      };
    }
    lock.version = 1;
    writeAtomic(lockPath, stringify(lock));
    err.write(`fetched ${got.length} files into ${dir}; pins in ${lockPath}${changed.length ? ` (re-pinned: ${changed.map((c) => c.f.name).join(', ')})` : ''}\n`);
    return EXIT.OK;
  } catch (e) {
    if (e instanceof GraphError) {
      err.write(`${e.code}: ${e.message}\n`);
      return e.exitCode;
    }
    err.write(`error: ${e && e.message ? e.message : 'unexpected failure'}\n`);
    return EXIT.GENERIC;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
