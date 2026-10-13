// build-graph command line (viz.md sections 5.1 and 17).
//
//   build-graph <file|-> | --input <file|-> | --snapshot <file|-> | --from-gramps-copy <sqlite.db|dir>
//               [--out <staging>] [--report <path>] [--verify-against <staging>/person]
//   build-graph --verify <graph.json> [--verify-against <staging>/person]
//
// Without --out the build is a dry run: it projects and verifies, and writes nothing.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { GraphError, EXIT } from './errors.mjs';
import { collect, fileSource, grampsCopySource, stdinSource } from './source.mjs';
import { buildFamilyGraph } from './build.mjs';
import { assertSizeBudget, assertVerified, GZIP_BUDGET_BYTES, loadSharedGuard } from './verify.mjs';
import { stringify } from './canonical.mjs';
import { writeAtomic } from './write.mjs';

const USAGE = `usage:
  build-graph (<file> | - | --input <file|-> | --snapshot <file|-> | --from-gramps-copy <sqlite.db|dir>)
              [--out <staging>] [--report <path>] [--verify-against <staging>/person]
              [--generated-at <iso>] [--max-gzip-bytes <n>] [--quiet]
  build-graph --verify <graph.json> [--verify-against <staging>/person]

  --out writes <staging>/person/graph.json (temp file, then rename). Without --out nothing is written.
  Exit codes: 0 ok, 2 input missing, 3 size budget, 4 privacy violation, 5 living mismatch,
              6 Gramps open, 7 snapshot shape, 8 gazetteer checksum.`;

/**
 * The project convention (docs/reference/repository-operations.md): the checkout sits at <project>/repo, so
 * <project> is the checkout's parent and the report goes to <project>/workspace-local/graph-build-report.json,
 * outside the synced staging prefixes. In a worktree or any other layout, set HFY_PROJECT_DIR to the project
 * root (or pass --report).
 */
export function defaultReportPath(env = process.env) {
  const project = env.HFY_PROJECT_DIR ? resolve(env.HFY_PROJECT_DIR) : resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  return join(project, 'workspace-local', 'graph-build-report.json');
}

/** graph `living` against person/<id>.json `isLiving`. Returns the mismatching gramps ids. */
export function livingMismatches(graph, personDir) {
  if (!existsSync(personDir) || !statSync(personDir).isDirectory()) {
    throw new GraphError('INPUT_MISSING', '--verify-against: the person directory does not exist');
  }
  const have = new Set(readdirSync(personDir));
  const bad = [];
  let missing = 0;
  let compared = 0;
  for (const p of graph.people) {
    const file = `${p.id}.json`;
    if (!have.has(file)) {
      missing += 1;
      continue;
    }
    compared += 1;
    let isLiving;
    try {
      isLiving = JSON.parse(readFileSync(join(personDir, file), 'utf8')).isLiving;
    } catch {
      isLiving = undefined;
    }
    if (typeof isLiving !== 'boolean' || isLiving !== p.living) bad.push(p.id);
  }
  return { bad: bad.sort(), missing, compared };
}

function assertLivingMatches(graph, personDir) {
  const { bad, missing, compared } = livingMismatches(graph, personDir);
  if (compared === 0 && graph.people.length > 0) {
    // An empty, wrong or unrelated directory must not pass the rule L cross-check by comparing nothing.
    throw new GraphError('INPUT_MISSING', '--verify-against: no person/<id>.json file matches a person in the graph, so nothing was compared');
  }
  if (bad.length) {
    throw new GraphError('LIVING_MISMATCH', `living differs from person/<id>.json isLiving for ${bad.length} id${bad.length === 1 ? '' : 's'}`, { ids: bad });
  }
  return { missing, compared };
}

function parseGraphFile(path) {
  if (!existsSync(path) || !statSync(path).isFile()) throw new GraphError('INPUT_MISSING', 'the graph file does not exist');
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new GraphError('PRIVACY_VIOLATION', 'the graph file is not valid JSON, so it cannot be verified', { pointers: ['/ [json]'] });
  }
}

/**
 * @param {string[]} argv
 * @param {{ stdin?: NodeJS.ReadableStream, stdout?: {write: Function}, stderr?: {write: Function}, now?: Date, guard?: Function|null }} [io]
 * @returns {Promise<number>} the process exit code
 */
export async function main(argv, io = {}) {
  const stdin = io.stdin ?? process.stdin;
  const out = io.stdout ?? process.stdout;
  const err = io.stderr ?? process.stderr;
  try {
    let args;
    try {
      args = parseArgs({
        args: argv,
        allowPositionals: true,
        options: {
          input: { type: 'string' },
          snapshot: { type: 'string' },
          'from-gramps-copy': { type: 'string' },
          out: { type: 'string' },
          report: { type: 'string' },
          verify: { type: 'string' },
          'verify-against': { type: 'string' },
          'generated-at': { type: 'string' },
          'max-gzip-bytes': { type: 'string' },
          quiet: { type: 'boolean' },
          help: { type: 'boolean', short: 'h' },
        },
      });
    } catch {
      throw new GraphError('INPUT_MISSING', `bad arguments\n${USAGE}`);
    }
    const o = args.values;
    if (o.help) {
      out.write(`${USAGE}\n`);
      return EXIT.OK;
    }
    const now = io.now ?? new Date();
    const guard = io.guard !== undefined ? io.guard : await loadSharedGuard();
    const maxGzip = o['max-gzip-bytes'] ? Number(o['max-gzip-bytes']) : GZIP_BUDGET_BYTES;
    if (!Number.isFinite(maxGzip) || maxGzip <= 0) throw new GraphError('INPUT_MISSING', '--max-gzip-bytes must be a positive number');
    if (o['generated-at'] !== undefined && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(o['generated-at'])) {
      throw new GraphError('INPUT_MISSING', '--generated-at must look like 2026-01-01T00:00:00Z');
    }

    // ---- --verify: re-run the checks on a graph that is already written -------------------------------
    if (o.verify !== undefined) {
      const graph = parseGraphFile(o.verify);
      assertVerified(graph, { now, guard });
      if (o['verify-against']) assertLivingMatches(graph, o['verify-against']);
      if (!o.quiet) err.write(`verified ${o.verify}: ${graph.counts.people} people, no findings\n`);
      return EXIT.OK;
    }

    // ---- build ----------------------------------------------------------------------------------------
    const positional = args.positionals[0];
    const named = [o['from-gramps-copy'], o.input, o.snapshot, positional].filter((x) => x !== undefined);
    if (named.length === 0) throw new GraphError('INPUT_MISSING', `no input given\n${USAGE}`);
    if (named.length > 1) throw new GraphError('INPUT_MISSING', `give exactly one input\n${USAGE}`);
    let source;
    let sourceKind = 'jsonl';
    if (o['from-gramps-copy'] !== undefined) {
      source = grampsCopySource(o['from-gramps-copy']);
      sourceKind = 'gramps-copy';
    } else {
      const path = o.input ?? o.snapshot ?? positional;
      source = path === '-' ? stdinSource(stdin) : fileSource(path);
      if (o.snapshot !== undefined) sourceKind = 'snapshot';
    }
    const objects = await collect(source);
    const { graph, report } = buildFamilyGraph(objects, { generatedAt: o['generated-at'], now, sourceKind });
    // A shape error wins over this check. An empty input must never replace a good graph.
    if (!objects.some((x) => x._class === 'Person')) throw new GraphError('INPUT_MISSING', 'the input holds no Person objects');
    assertVerified(graph, { now, guard });
    const text = stringify(graph);
    const gz = assertSizeBudget(text, maxGzip);
    const check = o['verify-against'] ? assertLivingMatches(graph, o['verify-against']) : null;
    const missing = check ? check.missing : 0;
    if (check) report.livingCheck = { compared: check.compared, missing: check.missing };

    if (o.out !== undefined) {
      const target = join(o.out, 'person', 'graph.json');
      writeAtomic(target, text);
      writeAtomic(o.report ?? defaultReportPath(), stringify(report));
      if (!o.quiet) err.write(`wrote ${target}: ${graph.counts.people} people, ${graph.counts.unions} unions, ${text.length} bytes (${gz} gzipped)\n`);
    } else if (!o.quiet) {
      err.write(`dry run (no --out): ${graph.counts.people} people, ${graph.counts.unions} unions, ${text.length} bytes (${gz} gzipped); nothing written\n`);
    }
    if (o.out === undefined && o.report !== undefined) writeAtomic(o.report, stringify(report));
    if (missing && !o.quiet) err.write(`--verify-against: ${missing} people have no person file and were not compared\n`);
    for (const w of report.warnings) if (!o.quiet) err.write(`warning ${w.code}: ${w.count}\n`);
    return EXIT.OK;
  } catch (e) {
    if (e instanceof GraphError) {
      err.write(`${e.code}: ${e.message}\n`);
      for (const p of e.pointers) err.write(`  ${p}\n`);
      if (e.ids.length) err.write(`  ids: ${e.ids.join(' ')}\n`);
      return e.exitCode;
    }
    err.write(`error: ${e && e.code ? e.code : 'unexpected failure'}\n`);
    return EXIT.GENERIC;
  }
}
