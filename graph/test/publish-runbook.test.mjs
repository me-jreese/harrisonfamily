// viz-graph-publish: the refresh runbook carries step 2b between Trees and Search, and the graph stays inside its 25 KB gzip budget.
// The real build and sync are io's step (HFY-R10); this pins what the page says and that the flags it names exist.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HERE } from './helpers.mjs';

const DOC = readFileSync(join(HERE, '..', '..', 'docs', 'how-to', 'sync-gramps-with-the-website.md'), 'utf8');

describe('sync-gramps-with-the-website.md step 2b (AC1)', () => {
  const at = (h) => DOC.indexOf(h);
  it('sits between step 2 (Trees) and step 3 (Search)', () => {
    const [trees, graph, search, sync] = ['### 2. Build the family trees', '### 2b. Build the family graph', '### 3. Build the search manifests', '### 4. Sync the data'].map(at);
    assert.ok(trees > 0 && trees < graph && graph < search && search < sync);
  });

  it('uses --from-gramps-copy and --verify-against, and verifies the staged file before the sync', () => {
    const step = DOC.slice(at('### 2b.'), at('### 3.'));
    assert.match(step, /--from-gramps-copy/);
    assert.match(step, /--verify-against/);
    assert.match(step, /--verify workspace-local/);
    assert.doesNotMatch(step, /^\s*(python3 )?\S*sync_to_s3\.py/m); // no sync command in 2b: the sync is unchanged
    assert.ok(step.indexOf('--verify workspace-local') > 0);
  });

  it('verifies the published copy and probes it live (AC2, AC3)', () => {
    const verify = DOC.slice(at('## Verify'), at('## Troubleshooting'));
    assert.match(verify, /build-graph\.mjs --verify "\$scratch\/graph\.json"/);
    assert.match(verify, /\b401\b[^\n]*private, no-store/);
    assert.match(verify, /- Signed out, `\/tree\/` returns `200` or `404`[^\n]*prints `0`/);
    assert.match(verify, /graph\.json\?x=1/);
    assert.match(verify, /\/Person\/graph\.json/);
    assert.match(verify, /trap 'rm -rf "\$scratch"' EXIT/);
    assert.match(verify, /schemaVersion/);
  });

  it('stages and verifies before the sync, and checks the search files after step 3', () => {
    assert.ok(at('--verify workspace-local') < at('### 4.'));
    const step = DOC.slice(at('### 2b.'), at('### 3.'));
    assert.match(step, /grep -ciE 'graph\\\.json\|"graph"'/);
    assert.match(step, /HFY-R16/);
  });

  it('names only flags the CLI accepts', () => {
    // Static read of the USAGE constant: running the CLI would import d3-dag and need npm ci.
    const src = readFileSync(join(HERE, '..', 'src', 'cli.mjs'), 'utf8');
    const usage = src.slice(src.indexOf('const USAGE'), src.indexOf('`;', src.indexOf('const USAGE')));
    for (const flag of ['--from-gramps-copy', '--verify-against', '--verify', '--out', '--max-gzip-bytes']) {
      assert.ok(usage.includes(flag), flag);
      assert.ok(DOC.includes(flag), flag);
    }
  });

  it('writes no real data: no Gramps id pattern appears in the runbook text for the graph', () => {
    const step = DOC.slice(at('### 2b.'), at('### 3.'));
    assert.doesNotMatch(DOC.slice(at('### 2b.'), at('### 3.')) + DOC.slice(at('## Verify'), at('## Troubleshooting')), /\b[IFCEMPN]\d{4,}\b/);
    assert.doesNotMatch(step, /\bI\d{4}\b/);
  });
});
