// The sync runbook after the render cutover (HFY-TSK-377): the legacy graph build step (2b) is gone, because hfy-graph-render produces
// person/graph.json and media/faces/ from the cloud store (HFY-TSK-274), and every legacy ETL command in the break-glass section carries
// --legacy-break-glass. This pins what the page says; the legacy scripts themselves live outside the repository.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HERE } from './helpers.mjs';

const DOC = readFileSync(join(HERE, '..', '..', 'docs', 'how-to', 'sync-gramps-with-the-website.md'), 'utf8');
const at = (h) => DOC.indexOf(h);
const LEGACY = DOC.slice(at('## The legacy ETL publish (break-glass only)'), at('## Related pages'));

describe('sync-gramps-with-the-website.md, legacy ETL section', () => {
  it('has a legacy section, and no step 2b that builds the graph from a Gramps copy', () => {
    assert.ok(LEGACY.length > 0);
    assert.doesNotMatch(DOC, /### 2b\./);
    assert.doesNotMatch(DOC, /build-graph\.mjs --from-gramps-copy/);
  });

  it('names hfy-graph-render as the graph producer and the P1 wrapper as retired', () => {
    assert.match(LEGACY, /`hfy-graph-render`/);
    assert.match(LEGACY, /p1-publish-family-graph\.sh`, calls `sync_to_s3\.py`, so it refuses too, and it is retired/);
  });

  it('puts --legacy-break-glass on every legacy Python command, and --no-delete on the sync', () => {
    const cmds = LEGACY.split('\n').filter((l) => /^\s*python3 scripts\/etl\//.test(l));
    assert.ok(cmds.length >= 3, 'export, trees and sync commands');
    for (const c of cmds) assert.match(c, /--legacy-break-glass/, c);
    const sync = cmds.filter((c) => c.includes('sync_to_s3.py'));
    assert.ok(sync.length > 0);
    for (const c of sync) assert.match(c, /--no-delete/, c);
  });

  it('writes no real data: no Gramps id pattern appears in the legacy section', () => {
    assert.doesNotMatch(LEGACY, /\b[IFCEMPN]\d{4,}\b/);
  });
});
