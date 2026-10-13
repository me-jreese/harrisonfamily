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
const EXPECTED_SCHEMA = 21;
export const GRAMPS_TABLES = ['person', 'family', 'event', 'place', 'media'];

/** The first row: the schema version Gramps stores in `metadata`, as hex (the column is a pickle or text). */
const VERSION_SELECT = `SELECT '{"_class":"HfyMetaVersion","hex":"' || hex(value) || '"}' FROM metadata WHERE setting = 'version'`;

export function grampsSql() {
  return [VERSION_SELECT, ...GRAMPS_TABLES.map((t) => `SELECT json_data FROM ${t}`)].join(' UNION ALL ') + ';';
}

/** Decodes the `metadata.version` value: plain digits, JSON, or a small-int pickle. Returns null when unreadable. */
export function decodeSchemaVersion(hex) {
  if (typeof hex !== 'string' || !/^([0-9a-f]{2})+$/i.test(hex)) return null;
  const buf = Buffer.from(hex, 'hex');
  const text = buf.toString('utf8').trim().replace(/^"(\d+)"$/, '$1');
  if (/^\d{1,6}$/.test(text)) return Number(text);
  const proto0 = /^I(\d{1,6})\n\./.exec(buf.toString('latin1'));
  if (proto0) return Number(proto0[1]);
  let i = 0;
  if (buf[i] === 0x80) i += 2; // PROTO
  if (buf[i] === 0x95) i += 9; // FRAME
  if (buf[i] === 0x4b && buf.length > i + 1) return buf[i + 1]; // BININT1
  if (buf[i] === 0x4d && buf.length > i + 2) return buf.readUInt16LE(i + 1); // BININT2
  if (buf[i] === 0x4a && buf.length > i + 4) return buf.readInt32LE(i + 1); // BININT
  return null;
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
    let sawVersion = false;
    let completed = false;
    try {
      for await (const obj of parseLines(rl, 'gramps copy')) {
        if (obj._class === 'HfyMetaVersion') {
          // The schema check: anything but 21 (or a value that cannot be read) is rejected, never guessed at.
          sawVersion = true;
          if (decodeSchemaVersion(obj.hex) !== EXPECTED_SCHEMA) {
            throw new GraphError('SNAPSHOT_SHAPE', `the Gramps copy's schema is not ${EXPECTED_SCHEMA}`);
          }
          continue;
        }
        yield obj;
      }
      completed = true;
    } finally {
      if (!completed) child.kill(); // the consumer quit early, or a line or the version check failed
    }
    const code = await closed;
    if (spawnError) {
      throw new GraphError('INPUT_MISSING', 'could not run sqlite3 (is it installed?)');
    }
    if (code !== 0) {
      throw new GraphError('INPUT_MISSING', `sqlite3 could not read the Gramps copy (exit ${code})`);
    }
    if (!sawVersion) throw new GraphError('SNAPSHOT_SHAPE', 'the Gramps copy has no schema version in its metadata');
  })();
}

/** Collects a source into an array. The family tree is small (hundreds to a few thousand objects). */
export async function collect(source) {
  const out = [];
  for await (const o of source) out.push(o);
  return out;
}
