// viz-graph-cloud-source: the packaging contract of hfy-graph-render (scripts/ci/package-graph-render.sh) checked without a network:
// every file the function imports is staged, the platform flags are there, and the lock file pins what the stack needs.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const script = readFileSync(join(ROOT, 'scripts/ci/package-graph-render.sh'), 'utf8');

/** The repository files reachable from `entry` through relative imports (static and dynamic string-literal imports). */
function reachable(entry, seen = new Set()) {
  if (seen.has(entry)) return seen;
  seen.add(entry);
  const text = readFileSync(entry, 'utf8');
  for (const m of text.matchAll(/(?:from|import\()\s*['"](\.{1,2}\/[^'"]+)['"]/g)) {
    const target = resolve(dirname(entry), m[1]);
    if (existsSync(target)) reachable(target, seen);
  }
  return seen;
}

describe('scripts/ci/package-graph-render.sh', () => {
  it('stages every repository file the handler reaches', () => {
    const files = [...reachable(join(ROOT, 'graph/cloud/index.mjs'))].map((f) => relative(ROOT, f));
    assert.ok(files.length > 15);
    for (const f of files) {
      if (f.startsWith('graph/src/') || f.startsWith('graph/cloud/')) continue; // staged by glob
      assert.ok(script.includes(f.split('/').slice(-1)[0].replace(/\.m?js$/, '')), `${f} is not staged`);
    }
    assert.ok(files.includes('api/src/records/index.js') && files.includes('api/src/records/mod-overlay.js'), 'the api store view and overlay are reused, not copied');
    assert.ok(script.includes('shared/privacy-guard.mjs'), 'verify() loads the shared detector');
  });

  it('installs for linux/arm64 and keeps no binary of another platform (sharp ships native libvips)', () => {
    assert.match(script, /npm ci --omit=dev .*--os=linux --cpu=arm64/);
    assert.match(script, /node_modules\/@img\/sharp-linux-arm64/);
    assert.match(script, /musl/);
    assert.match(script, /GraphRenderCodeKey=/);
  });

  it('keeps the handler path the stack fixes (src/index.handler) and ships no gazetteer, test or fixture', () => {
    assert.match(script, /export \{ handler \} from "\.\.\/graph\/cloud\/index\.mjs"/);
    for (const banned of ['gazetteer.lock', 'fixtures', '/test']) assert.ok(!script.includes(`cp "$ROOT/graph/${banned}`), banned);
  });

  it('the scripts are valid bash', () => {
    for (const f of ['package-graph-render.sh', 'smoke-graph-render.sh']) {
      const r = spawnSync('bash', ['-n', join(ROOT, 'scripts/ci', f)], { encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
    }
  });

  it('the lock file pins the SDK clients and sharp exactly, from the public registry only', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'graph/cloud/package.json'), 'utf8'));
    const lock = JSON.parse(readFileSync(join(ROOT, 'graph/cloud/package-lock.json'), 'utf8'));
    const graphPkg = JSON.parse(readFileSync(join(ROOT, 'graph/package.json'), 'utf8'));
    for (const [name, version] of Object.entries(pkg.dependencies)) {
      assert.match(version, /^\d+\.\d+\.\d+$/, `${name} is pinned exactly`);
      assert.equal(lock.packages[`node_modules/${name}`].version, version);
    }
    assert.equal(pkg.dependencies.sharp, graphPkg.dependencies.sharp);
    assert.equal(pkg.dependencies['d3-dag'], graphPkg.dependencies['d3-dag']);
    for (const [path, p] of Object.entries(lock.packages)) if (path) assert.match(p.resolved ?? '', /^https:\/\/registry\.npmjs\.org\//, path);
  });
});
