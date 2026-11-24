// HFY-TSK-413: the post-deploy MCP probe against a local stand-in for the site (no network, no kit package).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { CLIENTS, REFUSED, probeOnce, run } from '../mcp-post-deploy-probe.mjs';

const loopback = (u) => /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\//.test(u);
async function site({ version = '0.3.0', allow = (u) => Object.values(CLIENTS).includes(u) || loopback(u), registerStatus = 400 } = {}) {
  const srv = createServer((req, res) => {
    const base = `http://127.0.0.1:${srv.address().port}`;
    const u = new URL(req.url, base);
    const send = (status, body, h = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...h }); res.end(body === undefined ? '' : JSON.stringify(body)); };
    const v = version ? { 'x-io-kit-mcp': version } : {};
    if (u.pathname.startsWith('/.well-known/oauth-protected-resource')) return send(200, { resource: `${base}/mcp`, authorization_servers: [`${base}/auth`] }, v);
    if (u.pathname === '/.well-known/oauth-authorization-server/auth') {
      return send(200, { issuer: `${base}/auth`, authorization_endpoint: `${base}/auth/authorize`, registration_endpoint: `${base}/auth/register`, code_challenge_methods_supported: ['S256'], scopes_supported: ['mcp'] });
    }
    if (u.pathname === '/mcp') return send(401, { error: 'unauthorized' }, { 'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`, ...v });
    if (u.pathname === '/auth/register') return send(registerStatus, { error: 'invalid_redirect_uri' });
    if (u.pathname === '/auth/authorize') {
      if (!allow(u.searchParams.get('redirect_uri'))) return send(400, { error: 'invalid_request' });
      res.writeHead(302, { location: `/auth/login?next=${encodeURIComponent(u.search)}` }); return res.end();
    }
    if (u.pathname === '/auth/login') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<html>login</html>'); }
    send(404, {});
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${srv.address().port}`, close: () => srv.close() };
}
const failedIds = (r) => Object.entries(r.checks).filter(([, c]) => !c.ok).map(([id]) => id);

test('a site that allows every supported client and refuses the rest passes every check', async () => {
  const s = await site();
  try {
    const r = await probeOnce({ base: s.base, expectVersion: '0.3.0' });
    assert.deepEqual(failedIds(r), [], JSON.stringify(r.checks));
    assert.equal(r.ok, true);
    assert.equal(Object.keys(CLIENTS).length >= 7 && Object.keys(REFUSED).length >= 4, true);
  } finally { s.close(); }
});

test('C14 fails naming the client when Cursor or loopback is refused (the state before HFY-TSK-413)', async () => {
  const s = await site({ allow: (u) => u.startsWith('https://claude.') });
  try {
    const r = await probeOnce({ base: s.base, expectVersion: '0.3.0' });
    assert.deepEqual(failedIds(r), ['C14']);
    assert.match(r.checks.C14.detail, /cursor \(web\): final 400/);
    assert.match(r.checks.C14.detail, /loopback localhost: final 400/);
  } finally { s.close(); }
});

test('C14 fails when a foreign callback is accepted', async () => {
  const s = await site({ allow: () => true });
  try {
    const r = await probeOnce({ base: s.base, expectVersion: '0.3.0' });
    assert.deepEqual(failedIds(r), ['C14']);
    assert.match(r.checks.C14.detail, /refuse foreign https/);
  } finally { s.close(); }
});

test('C16 fails when the header is absent or is another version', async () => {
  for (const version of [null, '0.1.0']) {
    const s = await site({ version });
    try { assert.deepEqual(failedIds(await probeOnce({ base: s.base, expectVersion: '0.3.0' })), ['C16']); } finally { s.close(); }
  }
});

test('C13 fails when registration answers 201', async () => {
  const s = await site({ registerStatus: 201 });
  try { assert.deepEqual(failedIds(await probeOnce({ base: s.base, expectVersion: '0.3.0' })), ['C13']); } finally { s.close(); }
});

test('run: exit 0 on a pass, 1 after the last attempt on a fail, and it retries in between', async () => {
  const good = await site();
  const bad = await site({ version: null });
  try {
    const lines = [];
    assert.equal(await run(['--base', good.base, '--expect-version', '0.3.0', '--attempts', '2'], { log: (l) => lines.push(l), sleep: async () => {} }), 0);
    const slept = [];
    assert.equal(await run(['--base', bad.base, '--expect-version', '0.3.0', '--attempts', '3', '--interval', '7'], { log: (l) => lines.push(l), sleep: async (s) => { slept.push(s); } }), 1);
    assert.deepEqual(slept, [7, 7]);
    assert.equal(await run(['--attempts', '0'], { log: () => {} }), 2);
  } finally { good.close(); bad.close(); }
});
