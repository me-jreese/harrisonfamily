// RecordSource: where the _class-tagged Gramps JSON objects come from (viz.md section 5.1).
//
//   fileSource(path)            one JSON object per line
//   stdinSource(stream)         the same, from a stream
//   grampsCopySource(db, opts)  sqlite3 -readonly on a COPY of the tree, streamed over a pipe
//
// Each returns an async iterable of parsed objects. Nothing here writes a file: the gramps-copy
// source never stages the unredacted rows anywhere but the pipe.

import { spawn } from 'node:child_process';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { GraphError } from './errors.mjs';

/** The tables of Gramps schema v21 whose json_data column is the object. */
export const GRAMPS_TABLES = ['person', 'family', 'event', 'place', 'media'];

export function grampsSql() {
  return GRAMPS_TABLES.map((t) => `SELECT json_data FROM ${t}`).join(' UNION ALL ') + ';';
}

async function* parseLines(lines, where) {
  let n = 0;
  for await (const raw of lines) {
    n += 1;
    const line = raw.trim();
    if (!line) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      // Never echo the line: it can hold the unredacted record.
      throw new GraphError('SNAPSHOT_SHAPE', `${where}: line ${n} is not valid JSON`);
    }
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
      throw new GraphError('SNAPSHOT_SHAPE', `${where}: line ${n} is not a JSON object`);
    }
    yield obj;
  }
}

export function fileSource(path) {
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new GraphError('INPUT_MISSING', 'the input file does not exist or is not a file');
  }
  const rl = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });
  return parseLines(rl, 'input');
}

export function stdinSource(stream) {
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  return parseLines(rl, 'stdin');
}

/** `<db>` is the sqlite.db file of a copied tree, or the copy's directory. */
export function resolveGrampsDb(path) {
  if (!path) throw new GraphError('INPUT_MISSING', 'no Gramps copy was given');
  let db = resolve(path);
  if (existsSync(db) && statSync(db).isDirectory()) db = join(db, 'sqlite.db');
  if (!existsSync(db) || !statSync(db).isFile()) {
    throw new GraphError('INPUT_MISSING', 'the Gramps copy has no sqlite.db');
  }
  return db;
}

/** The same rule as the sync addon: a `lock` file next to the database means Gramps has it open. */
export function assertGrampsClosed(db) {
  if (existsSync(join(dirname(db), 'lock'))) {
    throw new GraphError('GRAMPS_OPEN', 'Gramps has this tree open: close Gramps or copy the tree first');
  }
}

function sqliteUri(db) {
  // RFC 3986 percent-encoding of the characters that end the path of a sqlite URI.
  const enc = db.replace(/[%?#]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `file:${enc}?mode=ro`;
}

/**
 * Streams `json_data` rows out of a copy of the Gramps database.
 * @param {string} path  sqlite.db of the copy (or its directory)
 * @param {{ sqlite3?: string }} [opts]  `sqlite3` is the executable (default `sqlite3`, or HFY_SQLITE3)
 */
export function grampsCopySource(path, opts = {}) {
  const db = resolveGrampsDb(path);
  assertGrampsClosed(db);
  const bin = opts.sqlite3 ?? process.env.HFY_SQLITE3 ?? 'sqlite3';
  return (async function* () {
    // -readonly plus mode=ro: the copy is never opened for writing, and no JSONL is written to disk.
    const child = spawn(bin, ['-readonly', sqliteUri(db), grampsSql()], { stdio: ['ignore', 'pipe', 'pipe'] });
    let spawnError = null;
    child.on('error', (e) => {
      spawnError = e;
    });
    child.stderr.resume(); // sqlite3's own messages can quote data: drained, never kept or shown
    const closed = new Promise((res) => child.on('close', (code) => res(code)));
    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    try {
      yield* parseLines(rl, 'gramps copy');
    } catch (e) {
      child.kill();
      throw e;
    }
    const code = await closed;
    if (spawnError) {
      throw new GraphError('INPUT_MISSING', 'could not run sqlite3 (is it installed?)');
    }
    if (code !== 0) {
      throw new GraphError('INPUT_MISSING', `sqlite3 could not read the Gramps copy (exit ${code})`);
    }
  })();
}

/** Collects a source into an array. The family tree is small (hundreds to a few thousand objects). */
export async function collect(source) {
  const out = [];
  for await (const o of source) out.push(o);
  return out;
}
