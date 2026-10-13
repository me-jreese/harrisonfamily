import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { collect, decodeSchemaVersion, fileSource, grampsCopySource, grampsSql, stdinSource } from '../src/source.mjs';
import { GraphError } from '../src/errors.mjs';
import { buildFamilyGraph } from '../src/build.mjs';
import { stringify } from '../src/canonical.mjs';
import { messyTree } from './fixtures/gramps.mjs';
import { GENERATED_AT, NOW, run, scratch, stubSqlite, writeJsonl } from './helpers.mjs';

const objects = () => messyTree().list();
const graphOf = (objs) => stringify(buildFamilyGraph(objs, { generatedAt: GENERATED_AT, now: NOW }).graph);
const isErr = (code, exit) => (e) => e instanceof GraphError && e.code === code && e.exitCode === exit;

describe('file and stdin sources', () => {
  it('reads one JSON object per line from a file', async () => {
    const f = writeJsonl(join(scratch(), 'in.jsonl'), objects());
    assert.deepEqual(await collect(fileSource(f)), objects());
  });
  it('reads from a stream, ignoring blank lines and CRLF', async () => {
    const text = objects().slice(0, 3).map((o) => JSON.stringify(o)).join('\r\n\r\n') + '\r\n';
    assert.deepEqual(await collect(stdinSource(Readable.from([text]))), objects().slice(0, 3));
  });
  it('a missing file is INPUT_MISSING', () => {
    assert.throws(() => fileSource(join(scratch(), 'nope.jsonl')), isErr('INPUT_MISSING', 2));
  });
  it('a line that is not JSON is SNAPSHOT_SHAPE, without echoing the line', async () => {
    const f = join(scratch(), 'bad.jsonl');
    writeFileSync(f, '{"_class":"Person"}\nthis is SECRETLINE not json\n');
    await assert.rejects(collect(fileSource(f)), (e) => isErr('SNAPSHOT_SHAPE', 7)(e) && !/SECRETLINE/.test(e.message) && /line 2/.test(e.message));
  });
  it('a line that is not an object is SNAPSHOT_SHAPE', async () => {
    await assert.rejects(collect(stdinSource(Readable.from(['[1,2]\n']))), isErr('SNAPSHOT_SHAPE', 7));
  });
});

describe('gramps copy source', () => {
  it('refuses with GRAMPS_OPEN (exit 6) when <dbdir>/lock exists, before running sqlite3', () => {
    const dir = scratch();
    writeFileSync(join(dir, 'sqlite.db'), '');
    writeFileSync(join(dir, 'lock'), '');
    assert.throws(() => grampsCopySource(join(dir, 'sqlite.db'), { sqlite3: join(dir, 'must-not-run') }), isErr('GRAMPS_OPEN', 6));
    assert.throws(() => grampsCopySource(dir), isErr('GRAMPS_OPEN', 6)); // the directory form too
  });
  it('a missing copy is INPUT_MISSING', () => {
    assert.throws(() => grampsCopySource(join(scratch(), 'sqlite.db')), isErr('INPUT_MISSING', 2));
    assert.throws(() => grampsCopySource(scratch()), isErr('INPUT_MISSING', 2));
  });
  it('runs sqlite3 -readonly with a mode=ro URI and one UNION ALL over the version row and the five tables, and streams the rows', async () => {
    const dir = scratch();
    writeFileSync(join(dir, 'sqlite.db'), '');
    const { bin, argsFile } = stubSqlite(dir, objects().map((o) => JSON.stringify(o)).join('\n') + '\n');
    const got = await collect(grampsCopySource(join(dir, 'sqlite.db'), { sqlite3: bin }));
    assert.deepEqual(got, objects());
    const args = readFileSync(argsFile, 'utf8').trim().split('\n');
    assert.equal(args[0], '-readonly');
    assert.match(args[1], /^file:.*sqlite\.db\?mode=ro$/);
    assert.equal(args[2], grampsSql());
    for (const t of ['person', 'family', 'event', 'place', 'media']) assert.match(args[2], new RegExp(`SELECT json_data FROM ${t}\\b`));
    assert.match(args[2], /FROM metadata WHERE setting = 'version'/);
    assert.equal((args[2].match(/UNION ALL/g) ?? []).length, 5);
  });
  it('writes nothing to disk: the copy directory holds the same files afterwards', async () => {
    const dir = scratch();
    writeFileSync(join(dir, 'sqlite.db'), 'x');
    const { bin } = stubSqlite(scratch(), objects().map((o) => JSON.stringify(o)).join('\n'));
    const before = readdirSync(dir);
    const mtime = statSync(join(dir, 'sqlite.db')).mtimeMs;
    await collect(grampsCopySource(dir, { sqlite3: bin }));
    assert.deepEqual(readdirSync(dir), before);
    assert.equal(statSync(join(dir, 'sqlite.db')).mtimeMs, mtime);
  });
  it('percent-encodes a path that has ? or # in it', async () => {
    const dir = join(scratch(), 'odd?dir#x');
    mkdirSync(dir);
    writeFileSync(join(dir, 'sqlite.db'), '');
    const { bin, argsFile } = stubSqlite(scratch(), '');
    await collect(grampsCopySource(dir, { sqlite3: bin }));
    const uri = readFileSync(argsFile, 'utf8').split('\n')[1];
    assert.ok(uri.includes('odd%3Fdir%23x') && uri.endsWith('?mode=ro'), uri);
  });
  it('a failing sqlite3 is INPUT_MISSING; a missing sqlite3 binary too', async () => {
    const dir = scratch();
    writeFileSync(join(dir, 'sqlite.db'), '');
    const { bin } = stubSqlite(scratch(), '', 1);
    await assert.rejects(collect(grampsCopySource(dir, { sqlite3: bin })), isErr('INPUT_MISSING', 2));
    await assert.rejects(collect(grampsCopySource(dir, { sqlite3: join(dir, 'no-such-sqlite3') })), isErr('INPUT_MISSING', 2));
  });

  it('decodes the stored schema version: digits, JSON text and pickled ints', () => {
    const hex = (b) => Buffer.from(b).toString('hex');
    assert.equal(decodeSchemaVersion(hex('21')), 21);
    assert.equal(decodeSchemaVersion(hex('"21"')), 21);
    assert.equal(decodeSchemaVersion(hex([0x80, 0x04, 0x4b, 0x15, 0x2e])), 21); // protocol 4, BININT1
    assert.equal(decodeSchemaVersion(hex([0x80, 0x04, 0x95, 0, 0, 0, 0, 0, 0, 0, 0, 0x4d, 0x2c, 0x01, 0x2e])), 300); // framed BININT2
    assert.equal(decodeSchemaVersion(hex('I21\n.')), 21); // protocol 0
    assert.equal(decodeSchemaVersion(hex([0xff, 0xfe])), null);
    assert.equal(decodeSchemaVersion('zz'), null);
    assert.equal(decodeSchemaVersion(undefined), null);
  });
  it('a schema version other than 21 is SNAPSHOT_SHAPE (exit 7), and so is an unreadable or absent one', async () => {
    const dir = scratch();
    writeFileSync(join(dir, 'sqlite.db'), '');
    const text = objects().map((o) => JSON.stringify(o)).join('\n') + '\n';
    for (const version of ['20', '22', 'not-a-number', null]) {
      const { bin } = stubSqlite(scratch(), text, 0, { version });
      await assert.rejects(collect(grampsCopySource(dir, { sqlite3: bin })), isErr('SNAPSHOT_SHAPE', 7), String(version));
    }
    const { bin } = stubSqlite(scratch(), text, 0, { version: '21' });
    assert.equal((await collect(grampsCopySource(dir, { sqlite3: bin }))).length, objects().length);
  });
  it('the CLI exits 7 for a copy at another schema version and writes nothing', () => {
    const copy = scratch();
    writeFileSync(join(copy, 'sqlite.db'), '');
    const { bin } = stubSqlite(scratch(), objects().map((o) => JSON.stringify(o)).join('\n'), 0, { version: '20' });
    const out = scratch();
    const r = run(['--from-gramps-copy', copy, '--out', out, '--report', join(out, 'r.json')], { env: { HFY_SQLITE3: bin } });
    assert.equal(r.status, 7, r.stderr);
    assert.deepEqual(readdirSync(out), []);
  });
  it('kills the sqlite3 child when the consumer stops early', async () => {
    const dir = scratch();
    writeFileSync(join(dir, 'sqlite.db'), '');
    const pidFile = join(dir, 'pid.txt');
    const bin = join(dir, 'slow-sqlite3.sh');
    const head = JSON.stringify({ _class: 'HfyMetaVersion', hex: Buffer.from('21').toString('hex') });
    writeFileSync(bin, `#!/bin/sh\necho $$ > "${pidFile}"\necho '${head}'\necho '${JSON.stringify(objects()[0])}'\nexec sleep 30\n`);
    chmodSync(bin, 0o755);
    for await (const _ of grampsCopySource(dir, { sqlite3: bin })) break; // eslint-disable-line no-unused-vars
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    let alive = true;
    for (let i = 0; i < 40 && alive; i++) {
      try {
        process.kill(pid, 0);
        await new Promise((r) => setTimeout(r, 50));
      } catch {
        alive = false;
      }
    }
    assert.equal(alive, false, 'the child is still running');
  });

  const haveSqlite = spawnSync('sqlite3', ['-version']).status === 0;
  it('works against a real sqlite3 copy and matches the file source byte for byte', { skip: !haveSqlite && 'sqlite3 is not installed' }, async () => {
    const dir = scratch();
    const db = join(dir, 'sqlite.db');
    const tables = { person: 'Person', family: 'Family', event: 'Event', place: 'Place', media: 'Media', note: 'Note', citation: 'Citation' };
    const sql = Object.keys(tables).map((t) => `CREATE TABLE ${t} (handle TEXT PRIMARY KEY, json_data TEXT);`);
    sql.push('CREATE TABLE metadata (setting TEXT PRIMARY KEY, value BLOB);', "INSERT INTO metadata VALUES ('version', X'80044B152E');"); // a pickled int 21
    for (const o of objects()) {
      const t = Object.keys(tables).find((k) => tables[k] === o._class);
      if (!t || ['note', 'citation'].includes(t)) continue; // those two tables are never queried
      sql.push(`INSERT INTO ${t} VALUES ('${o.handle}', '${JSON.stringify(o).replace(/'/g, "''")}');`);
    }
    assert.equal(spawnSync('sqlite3', [db], { input: sql.join('\n') }).status, 0);
    const before = readFileSync(db);
    const got = await collect(grampsCopySource(db));
    assert.equal(graphOf(got), graphOf(objects().filter((o) => !['Note', 'Citation'].includes(o._class))));
    assert.deepEqual(readFileSync(db), before); // the copy was not modified
    assert.deepEqual(readdirSync(dir), ['sqlite.db']); // and no journal or JSONL appeared
  });
  it('a real sqlite3 copy at schema 20 (or with no version row) is SNAPSHOT_SHAPE', { skip: !haveSqlite && 'sqlite3 is not installed' }, async () => {
    for (const insert of ["INSERT INTO metadata VALUES ('version', X'80044B142E');", '']) {
      const db = join(scratch(), 'sqlite.db');
      const sql = ['person', 'family', 'event', 'place', 'media'].map((t) => `CREATE TABLE ${t} (handle TEXT, json_data TEXT);`);
      sql.push('CREATE TABLE metadata (setting TEXT PRIMARY KEY, value BLOB);', insert);
      assert.equal(spawnSync('sqlite3', [db], { input: sql.join('\n') }).status, 0);
      await assert.rejects(collect(grampsCopySource(db)), isErr('SNAPSHOT_SHAPE', 7));
    }
  });
});

describe('the CLI sources', () => {
  it('file, stdin and --from-gramps-copy give the same bytes', () => {
    const dir = scratch();
    const f = writeJsonl(join(dir, 'in.jsonl'), objects());
    const text = readFileSync(f, 'utf8');
    const common = ['--generated-at', GENERATED_AT, '--quiet'];
    const outs = {};
    for (const [name, args, input, env] of [
      ['file', [f], undefined, {}],
      ['input flag', ['--input', f], undefined, {}],
      ['stdin', ['-'], text, {}],
      ['snapshot', ['--snapshot', f], undefined, {}],
    ]) {
      const out = join(dir, `out-${name.replace(' ', '-')}`);
      const r = run([...args, ...common, '--out', out, '--report', join(dir, `${name.replace(' ', '-')}.report.json`)], { input, env });
      assert.equal(r.status, 0, `${name}: ${r.stderr}`);
      outs[name] = readFileSync(join(out, 'person', 'graph.json'), 'utf8');
    }
    const copy = scratch();
    writeFileSync(join(copy, 'sqlite.db'), '');
    const { bin } = stubSqlite(scratch(), text);
    const out = join(dir, 'out-copy');
    const r = run(['--from-gramps-copy', copy, ...common, '--out', out, '--report', join(dir, 'copy.report.json')], { env: { HFY_SQLITE3: bin } });
    assert.equal(r.status, 0, r.stderr);
    outs.copy = readFileSync(join(out, 'person', 'graph.json'), 'utf8');
    const first = outs.file;
    const sansKind = (text) => {
      const g = JSON.parse(text);
      delete g.source.kind; // the only field that names the source
      return stringify(g);
    };
    for (const [k, v] of Object.entries(outs)) assert.equal(sansKind(v), sansKind(first), k);
    assert.equal(JSON.parse(outs.copy).source.kind, 'gramps-copy');
    assert.equal(JSON.parse(outs.snapshot).source.kind, 'snapshot');
    assert.equal(JSON.parse(outs.file).source.kind, 'jsonl');
  });

  it('GRAMPS_OPEN exits 6 and writes nothing', () => {
    const copy = scratch();
    writeFileSync(join(copy, 'sqlite.db'), '');
    writeFileSync(join(copy, 'lock'), '');
    const out = scratch();
    const r = run(['--from-gramps-copy', copy, '--out', out, '--report', join(out, 'r.json')]);
    assert.equal(r.status, 6);
    assert.match(r.stderr, /^GRAMPS_OPEN:/);
    assert.deepEqual(readdirSync(out), []);
  });
});
