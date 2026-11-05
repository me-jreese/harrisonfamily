// node --test 'scripts/ci/test/**/*.test.mjs'
//
// HFY-TSK-200 (hfy-chat-worker-ci): the chat Worker deploys through the cloudflare-worker target of @io-kit/ci. This test runs the
// RENDERED composite action (.github/actions/io-kit-ci/deploy-worker/action.yml) against a mock Cloudflare API on localhost, with the
// real committed chat-worker/dist/ and the target exactly as the manifest renders it (only the https smoke URLs are pointed at the mock).
// It needs only node, bash, curl and jq, like the action. No credential and no network: the token is a made-up string.
//
// What it pins (the acceptance criteria of the task):
//   - the first CI run uploads, because the production Worker was deployed by hand and carries no workers/tag annotation, and the
//     commit sha is injected at upload as the CHAT_WORKER_VERSION var, which health.version must equal;
//   - a second run of the same bundle (a workflow_dispatch re-run, or a merge that only touches the site) makes ZERO Cloudflare writes;
//   - a failing smoke after an upload rolls back to the previous deployment of the Worker, and only a changed bundle is ever rolled back;
//   - the action never writes a zone route (routes are created once by the orchestrator and only read by CI), and route drift fails.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const ACTION = join(ROOT, '.github/actions/io-kit-ci/deploy-worker/action.yml');
const WORKER_DIST = join(ROOT, 'chat-worker/dist');
const TOKEN = 'test_token_not_real_0123456789';

const haveTools = ['bash', 'curl', 'jq'].every((t) => spawnSync('sh', ['-c', `command -v ${t}`]).status === 0);
const opts = { skip: haveTools ? false : 'needs bash, curl and jq' };

// --- the rendered action: its default targets JSON and its bash step ------------------------------------------------------------
const actionText = readFileSync(ACTION, 'utf8');
function renderedTargets() {
  const m = actionText.match(/^ {4}default: '(\[\{.*\}\])'$/m);
  assert.ok(m, 'the deploy-worker action has a default targets array');
  return JSON.parse(m[1].replaceAll("''", "'"));
}
function renderedScript() {
  const lines = actionText.split('\n');
  const at = lines.findIndex((l) => /^ {6}run: \|$/.test(l));
  assert.ok(at > 0, 'the deploy-worker action has a run step');
  const body = [];
  for (const l of lines.slice(at + 1)) {
    if (l.trim() !== '' && !l.startsWith('        ')) break;
    body.push(l.slice(8));
  }
  return body.join('\n');
}

// --- a mock Cloudflare API -------------------------------------------------------------------------------------------------------
function mockCloudflare({ routes, migrationTag = 'v1', untaggedActive = true }) {
  const state = {
    requests: [],
    deployments: untaggedActive ? [{ id: 'dep-by-hand', annotations: {}, versions: [{ version_id: 'ver-by-hand', percentage: 100 }] }] : [],
    versionVar: 'by-hand',
    migrationTag,
    uploads: [],
    healthVersion: null, // null: report what was injected at upload
    unauthorized: 0,
  };
  const ok = (res, result) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ success: true, errors: [], result })); };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url, 'http://x');
      const isApi = url.pathname.startsWith('/client/v4/');
      if (isApi) {
        if (req.headers.authorization !== `Bearer ${TOKEN}`) { state.unauthorized += 1; res.writeHead(401); res.end('{}'); return; }
        state.requests.push({ method: req.method, path: url.pathname.slice('/client/v4'.length) });
      }
      const p = url.pathname.replace('/client/v4', '');
      let m;
      if (isApi && req.method === 'GET' && (m = p.match(/^\/accounts\/[0-9a-f]{32}\/workers\/scripts\/([^/]+)\/deployments$/))) return ok(res, { deployments: state.deployments });
      if (isApi && req.method === 'GET' && /^\/accounts\/[0-9a-f]{32}\/workers\/scripts$/.test(p)) return ok(res, [{ id: 'hfy-chat-worker', migration_tag: state.migrationTag }]);
      if (isApi && req.method === 'GET' && /^\/zones\/[0-9a-f]{32}\/workers\/routes$/.test(p)) return ok(res, routes);
      if (isApi && req.method === 'PUT' && /^\/accounts\/[0-9a-f]{32}\/workers\/scripts\/[^/]+$/.test(p)) {
        const text = body.toString('latin1');
        const meta = text.match(/name="metadata"[^\r\n]*\r\nContent-Type: application\/json\r\n\r\n([\s\S]*?)\r\n--/i);
        assert.ok(meta, 'the upload carries a metadata part');
        const metadata = JSON.parse(meta[1]);
        state.uploads.push({ metadata, parts: [...text.matchAll(/name="([^"]+)"; filename="([^"]+)"/g)].map((x) => x[2]) });
        state.versionVar = (metadata.bindings.find((b) => b.name === 'CHAT_WORKER_VERSION') || {}).text;
        if (metadata.migrations) state.migrationTag = metadata.migrations.new_tag;
        state.deployments.unshift({ id: `dep-${state.deployments.length + 1}`, annotations: metadata.annotations, versions: [{ version_id: `ver-${state.deployments.length + 1}`, percentage: 100 }] });
        return ok(res, { id: 'hfy-chat-worker' });
      }
      if (isApi && req.method === 'POST' && /\/deployments$/.test(p)) {
        const sent = JSON.parse(body.toString('utf8'));
        state.rollbacks = [...(state.rollbacks || []), sent];
        state.deployments.unshift({ id: `dep-${state.deployments.length + 1}`, annotations: sent.annotations || {}, versions: sent.versions });
        return ok(res, { id: 'rolled' });
      }
      if (!isApi && url.pathname === '/chat/v1/health') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, version: state.healthVersion ?? state.versionVar, protocol: 1 })); return; }
      res.writeHead(404); res.end('{"success":false,"errors":[{"code":404,"message":"not found"}]}');
    });
  });
  return new Promise((done) => server.listen(0, '127.0.0.1', () => done({ state, server, base: `http://127.0.0.1:${server.address().port}` })));
}

// --- running the action ----------------------------------------------------------------------------------------------------------
function workdir() {
  const dir = mkdtempSync(join(tmpdir(), 'hfy-deploy-worker-'));
  cpSync(WORKER_DIST, join(dir, 'chat-worker/dist'), { recursive: true });
  writeFileSync(join(dir, 'step.sh'), renderedScript());
  return dir;
}
function runAction({ dir, base, commit, token = TOKEN }) {
  const targets = renderedTargets().map((t) => ({
    ...t,
    smoke: { ...t.smoke, url: `${base}/chat/v1/health` },
  }));
  return new Promise((done) => {
    const child = spawn('bash', [join(dir, 'step.sh')], {
      cwd: dir,
      env: { PATH: process.env.PATH, HOME: dir, TARGETS: JSON.stringify(targets), CLOUDFLARE_API_TOKEN: token, CF_API_BASE: `${base}/client/v4`, SMOKE_RETRY_DELAY: '1', GITHUB_SHA: commit },
    });
    let out = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (out += c));
    child.on('close', (status) => done({ status, out }));
  });
}
const writes = (state) => state.requests.filter((r) => r.method !== 'GET');
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_C = 'c'.repeat(40);

async function withMock(routesFor, fn) {
  const deployJson = JSON.parse(readFileSync(join(WORKER_DIST, 'deploy.json'), 'utf8'));
  const routes = routesFor(deployJson);
  const mock = await mockCloudflare({ routes });
  const dir = workdir();
  try { await fn({ ...mock, dir, deployJson }); } finally { mock.server.close(); rmSync(dir, { recursive: true, force: true }); }
}
const zoneRoutes = (d) => d.routes.map((pattern, i) => ({ id: `r${i}`, pattern, script: 'hfy-chat-worker' }));

// --- the checks ------------------------------------------------------------------------------------------------------------------
test('the manifest target renders to the deploy-worker action, with the version var, the smoke and the two read-only route checks', () => {
  const [t, ...rest] = renderedTargets();
  assert.equal(rest.length, 0);
  assert.equal(t.kind, 'cloudflare-worker');
  assert.equal(t.name, 'hfy-chat-worker');
  assert.equal(t.dir, 'chat-worker');
  assert.equal(t.environment, 'production');
  assert.equal(t.routes_from, 'dist/deploy.json');
  assert.match(t.account_id, /^[0-9a-f]{32}$/);
  assert.match(t.zone_id, /^[0-9a-f]{32}$/);
  assert.equal(t.smoke.url, 'https://harrisonfamily.us/chat/v1/health');
  assert.equal(t.smoke.expected_version, 'commit_sha');
  assert.equal(t.smoke.version_var, 'CHAT_WORKER_VERSION');
  assert.equal(t.smoke.checks, undefined, 'the Worker smoke is the health URL alone: a site check (the data gate, the home page) never rolls the Worker back');
  const deploy = readFileSync(join(ROOT, '.github/workflows/io-kit-deploy.yml'), 'utf8');
  assert.match(deploy, /^ {2}worker:\n(?: {4}.*\n)*? {4}environment: production$/m, 'the worker job runs in the production environment');
  assert.match(deploy, /api-token: \$\{\{ secrets\.CLOUDFLARE_API_TOKEN \}\}/);
});

test('the committed deploy.json matches what the target uploads: the Durable Object binding, the v1 SQLite migration, two routes, no version var', () => {
  const d = JSON.parse(readFileSync(join(WORKER_DIST, 'deploy.json'), 'utf8'));
  assert.deepEqual(d.migrations, { new_tag: 'v1', new_sqlite_classes: ['ChatHub'] });
  assert.deepEqual(d.routes, ['harrisonfamily.us/chat/ws*', 'harrisonfamily.us/chat/v1/*']);
  assert.equal(d.vars.CHAT_WORKER_VERSION, undefined, 'the commit sha is injected at upload, never committed');
  assert.equal(createHash('sha256').update(readFileSync(join(WORKER_DIST, 'index.js'))).digest('hex'), d.bundle.sha256);
});

test('first run uploads (the hand-deployed Worker is untagged), injects the sha as health.version, and writes no route', opts, async () => {
  await withMock(zoneRoutes, async ({ state, base, dir }) => {
    const r = await runAction({ dir, base, commit: SHA_A });
    assert.equal(r.status, 0, r.out);
    assert.deepEqual(writes(state).map((w) => `${w.method} ${w.path.replace(/[0-9a-f]{32}/g, '<id>')}`), ['PUT /accounts/<id>/workers/scripts/hfy-chat-worker']);
    assert.equal(state.uploads.length, 1);
    const { metadata, parts } = state.uploads[0];
    assert.equal(metadata.bindings.find((b) => b.name === 'CHAT_WORKER_VERSION').text, SHA_A);
    assert.ok(metadata.bindings.some((b) => b.type === 'durable_object_namespace' && b.name === 'CHAT_HUB'));
    assert.ok(metadata.bindings.some((b) => b.name === 'CHAT_OPEN_TO' && b.text === 'uat'), 'the dark-launch var is uploaded from deploy.json');
    assert.deepEqual(metadata.keep_bindings, ['secret_text', 'secret_key'], 'the service key and the other Worker secrets are kept');
    assert.equal(metadata.migrations, undefined, 'the v1 migration is already applied by the hand deploy, so it is not sent again');
    assert.deepEqual(parts, ['index.js']);
    assert.match(metadata.annotations['workers/tag'], /^sha256:[0-9a-f]{64}$/);
    assert.match(r.out, new RegExp(`ok   hfy-chat-worker smoke: version=${SHA_A}`));
    assert.match(r.out, /zone routes match deploy.json/);
    assert.equal(state.unauthorized, 0);
  });
});

test('a run on an unchanged bundle (workflow_dispatch re-run, or a merge that only touches the site) makes zero Cloudflare writes', opts, async () => {
  await withMock(zoneRoutes, async ({ state, base, dir }) => {
    assert.equal((await runAction({ dir, base, commit: SHA_A })).status, 0);
    assert.equal(writes(state).length, 1);
    const before = state.requests.length;

    const again = await runAction({ dir, base, commit: SHA_B });
    assert.equal(again.status, 0, again.out);
    assert.match(again.out, /bundle unchanged .* no Cloudflare write/);
    assert.equal(writes(state).length, 1, 'still only the first upload');
    assert.ok(state.requests.length > before, 'the second run only read');
    assert.ok(state.requests.slice(before).every((r) => r.method === 'GET'));
    assert.match(again.out, new RegExp(`version=${SHA_A}`), 'smoke expects the sha of the upload that is live, not the site merge sha');
    assert.equal(state.deployments.length, 2);

    const third = await runAction({ dir, base, commit: SHA_C });
    assert.equal(third.status, 0, third.out);
    assert.equal(writes(state).length, 1);
  });
});

test('a changed bundle uploads again; a failing smoke rolls back to the previous deployment and names it', opts, async () => {
  await withMock(zoneRoutes, async ({ state, base, dir }) => {
    assert.equal((await runAction({ dir, base, commit: SHA_A })).status, 0);
    const previous = state.deployments[0];
    assert.equal(previous.id, 'dep-2');

    // A no-op Worker change: the bundle bytes differ, so the digest differs and the upload happens.
    writeFileSync(join(dir, 'chat-worker/dist/index.js'), `${readFileSync(join(dir, 'chat-worker/dist/index.js'), 'utf8')}\n// changed\n`);
    state.healthVersion = 'not-the-commit'; // health keeps reporting the wrong version: the deliberately failing smoke

    const r = await runAction({ dir, base, commit: SHA_B });
    assert.equal(r.status, 1, r.out);
    assert.equal(state.uploads.length, 2);
    assert.match(r.out, /smoke FAIL hfy-chat-worker: http 200, version='not-the-commit'/);
    assert.match(r.out, /rolled back to the previous deployment/);
    assert.equal(state.rollbacks.length, 1);
    assert.deepEqual(state.rollbacks[0].versions, previous.versions, 'the rollback selects the previous deployment, not the one just uploaded');
    assert.notDeepEqual(state.rollbacks[0].versions, state.deployments[1].versions);
    assert.equal(state.rollbacks[0].strategy, 'percentage');
    assert.deepEqual(writes(state).map((w) => w.method), ['PUT', 'PUT', 'POST']);
    assert.ok(writes(state).every((w) => w.path.includes('/workers/scripts/hfy-chat-worker')), 'only this Worker is written, never a route or the site');
  });
});

test('a failing smoke on an unchanged bundle fails the job but rolls nothing back', opts, async () => {
  await withMock(zoneRoutes, async ({ state, base, dir }) => {
    assert.equal((await runAction({ dir, base, commit: SHA_A })).status, 0);
    state.healthVersion = 'broken';
    const writesBefore = writes(state).length;
    const r = await runAction({ dir, base, commit: SHA_B });
    assert.equal(r.status, 1);
    assert.match(r.out, /nothing was uploaded, so nothing is rolled back/);
    assert.equal(writes(state).length, writesBefore);
  });
});

test('route drift fails the job and CI never creates or edits a route', opts, async () => {
  await withMock((d) => zoneRoutes(d).slice(0, 1), async ({ state, base, dir }) => {
    const r = await runAction({ dir, base, commit: SHA_A });
    assert.equal(r.status, 1);
    assert.match(r.out, /ROUTE DRIFT on the zone for hfy-chat-worker/);
    assert.ok(writes(state).every((w) => !w.path.startsWith('/zones/')), 'no zone write, ever');
  });
});

test('a wrong token shape never reaches a request, and the token is never printed', opts, async () => {
  await withMock(zoneRoutes, async ({ state, base, dir }) => {
    const bad = await runAction({ dir, base, commit: SHA_A, token: 'has spaces and "quotes"' });
    assert.equal(bad.status, 1);
    assert.equal(state.requests.length, 0);
    const good = await runAction({ dir, base, commit: SHA_A });
    assert.equal(good.status, 0, good.out);
    assert.ok(!good.out.includes(TOKEN));
  });
});

test('the install discipline: api/package.json pins @io-kit/ci 0.2.0 exactly and the lockfile agrees', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'api/package.json'), 'utf8'));
  assert.equal(pkg.devDependencies['@io-kit/ci'], '0.2.0');
  const lock = JSON.parse(readFileSync(join(ROOT, 'api/package-lock.json'), 'utf8'));
  assert.equal(lock.packages['node_modules/@io-kit/ci'].version, '0.2.0');
  assert.equal(lock.packages[''].devDependencies['@io-kit/ci'], '0.2.0');
  for (const [name, range] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) assert.match(range, /^\d+\.\d+\.\d+$/, `${name} is an exact pin`);
  assert.ok(existsSync(join(ROOT, '.github/actions/io-kit-ci/deploy-worker/action.yml')));
  assert.match(actionText, /^# @io-kit\/ci 0\.2\.0 rendered/);
});
