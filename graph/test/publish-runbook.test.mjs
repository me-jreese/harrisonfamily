// viz-graph-publish: the refresh runbook carries step 2b between Trees and Search, and the graph stays inside its 25 KB gzip budget.
// The real build and sync are io's step (HFY-R10); this pins what the page says and that the flags it names exist.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HERE, run } from './helpers.mjs';

const DOC = readFileSync(join(HERE, '..', '..', 'docs', 'how-to', 'refresh-the-family-data.md'), 'utf8');

describe('refresh-the-family-data.md step 2b (AC1)', () => {
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
    assert.doesNotMatch(step, /sync_to_s3\.py\s+--/); // no sync change
  });

  it('verifies the published copy and probes it live (AC2, AC3)', () => {
    const verify = DOC.slice(at('## Verify'), at('## Troubleshooting'));
    assert.match(verify, /build-graph\.mjs --verify "\$scratch\/graph\.json"/);
    assert.match(verify, /\b401\b[^\n]*private, no-store/);
    assert.match(verify, /\/tree\/[^\n]*\n?[^\n]*`200` or `404`/);
    assert.match(verify, /schemaVersion/);
  });

  it('names only flags the CLI accepts', () => {
    const r = run(['--help']);
    const usage = r.stdout + r.stderr;
    for (const flag of ['--from-gramps-copy', '--verify-against', '--verify', '--out', '--max-gzip-bytes']) {
      assert.ok(usage.includes(flag), flag);
      assert.ok(DOC.includes(flag), flag);
    }
  });

  it('writes no real data: no Gramps id pattern appears in the runbook text for the graph', () => {
    const step = DOC.slice(at('### 2b.'), at('### 3.'));
    assert.doesNotMatch(step, /\bI\d{4}\b/);
  });
});
