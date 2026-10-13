import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after } from 'node:test';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const BIN = join(HERE, '..', 'bin', 'build-graph.mjs');
export const GOLDEN = join(HERE, 'fixtures', 'messy.graph.golden.json');
export const NOW = new Date('2026-10-20T00:00:00Z');
export const GENERATED_AT = '2026-10-20T18:04:00Z';

const made = [];
/** A scratch directory under the OS temp dir, removed when the test file finishes. */
export function scratch(prefix = 'hfy-graph-') {
  const d = mkdtempSync(join(tmpdir(), prefix));
  made.push(d);
  return d;
}
after(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

export function writeJsonl(path, objects) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, objects.map((o) => JSON.stringify(o)).join('\n') + '\n');
  return path;
}

/** Runs the real CLI in a child process. */
export function run(args, { input, env = {}, cwd } = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    input,
    cwd,
    // hermetic by default: a developer's own gazetteer cache must not change the build a test expects
    env: { ...process.env, HFY_GAZETTEER_DIR: join(HERE, 'no-such-gazetteer'), ...env },
    encoding: 'utf8',
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** A stand-in sqlite3 that records its arguments and prints a prepared output. */
export function stubSqlite(dir, outputText, exitCode = 0, { version = '21' } = {}) {
  const argsFile = join(dir, 'stub-args.txt');
  const outFile = join(dir, 'stub-out.txt');
  const bin = join(dir, 'sqlite3-stub.sh');
  // the real query's first row is the metadata schema version, as hex of the stored value
  const head = version === null ? '' : `${JSON.stringify({ _class: 'HfyMetaVersion', hex: Buffer.from(String(version)).toString('hex') })}\n`;
  writeFileSync(outFile, head + outputText);
  writeFileSync(bin, `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a" >> "${argsFile}"; done\ncat "${outFile}"\nexit ${exitCode}\n`);
  chmodSync(bin, 0o755);
  return { bin, argsFile };
}
