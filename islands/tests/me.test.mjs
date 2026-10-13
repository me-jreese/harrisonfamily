// HFY-TSK-298: the islands' one GET /api/me reader (src/lib/me.js) and the source rule that no island infers admin or moderator rights
// from can.delete (BRD2 D2-12, SOC-D16). Synthetic ids only.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const { getMe, forgetMe, canModerate, NOT_ME } = await import("../src/lib/me.js");

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const ME = { id: "I9001", label: "Test Member", admin: false, can: { moderate: false, graduate: false, approve: false } };
const ADMIN = { id: "I9099", label: "Test Admin", admin: true, can: { moderate: true, graduate: true, approve: true } };

/** A fetch stub that records calls and answers with `respond(call)`. */
function stubFetch(respond) {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return respond(calls.length); };
  return { calls, fetchImpl };
}
const json = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
function quietWarn(fn) {
  const w = console.warn;
  const warnings = [];
  console.warn = (...a) => warnings.push(a.join(" "));
  return Promise.resolve().then(fn).finally(() => { console.warn = w; }).then((v) => ({ value: v, warnings }));
}
function fresh() { forgetMe(); delete globalThis.HFYFeatureFlags; }

// ------------------------------------------------------------------------------------------------------------- getMe
test("getMe: one same-origin GET /api/me, shared by every caller (concurrent and later)", async () => {
  fresh();
  const { calls, fetchImpl } = stubFetch(() => json(200, ME));
  const [a, b] = await Promise.all([getMe({ fetchImpl }), getMe({ fetchImpl })]);
  const c = await getMe({ fetchImpl });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/me");
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.credentials, "same-origin");
  assert.equal(calls[0].init.headers.Accept, "application/json");
  assert.equal(a, b);
  assert.equal(a, c);
  assert.deepEqual({ ...a, can: { ...a.can } }, ME);
});

test("getMe: an admin answer keeps admin and can.* as the server sent them", async () => {
  fresh();
  const { fetchImpl } = stubFetch(() => json(200, ADMIN));
  const me = await getMe({ fetchImpl });
  assert.equal(me.admin, true);
  assert.equal(me.can.moderate, true);
  assert.equal(canModerate(me), true);
});

test("getMe: admin is true only for a literal true (a truthy string is not admin)", async () => {
  fresh();
  const { fetchImpl } = stubFetch(() => json(200, { id: "I9001", label: "Test Member", admin: "yes" }));
  const me = await getMe({ fetchImpl });
  assert.equal(me.admin, false);
  assert.deepEqual({ ...me.can }, {});
  assert.equal(canModerate(me), false);
});

test("getMe: a 401 means not admin, without a warning", async () => {
  fresh();
  const { calls, fetchImpl } = stubFetch(() => json(401, { error: "unauthenticated" }));
  const { value, warnings } = await quietWarn(() => getMe({ fetchImpl }));
  assert.equal(value, NOT_ME);
  assert.equal(calls.length, 1);
  assert.deepEqual(warnings, []);
});

for (const [name, respond] of [
  ["a network failure", () => { throw new TypeError("Failed to fetch"); }],
  ["a 500", () => json(500, { error: "server" })],
  ["a 403", () => json(403, { error: "forbidden" })],
  ["a body that is not JSON", () => ({ status: 200, ok: true, json: async () => { throw new SyntaxError("Unexpected token <"); } })],
]) {
  test(`getMe: ${name} means not admin (warned), and the failure is shared, not retried`, async () => {
    fresh();
    const { calls, fetchImpl } = stubFetch(respond);
    const { value, warnings } = await quietWarn(async () => [await getMe({ fetchImpl }), await getMe({ fetchImpl })]);
    assert.equal(value[0], NOT_ME);
    assert.equal(value[1], NOT_ME);
    assert.equal(calls.length, 1);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /not admin/);
  });
}

for (const body of [null, [], "admin", 1]) {
  test(`getMe: a 200 body of ${JSON.stringify(body)} means not admin`, async () => {
    fresh();
    const { fetchImpl } = stubFetch(() => json(200, body));
    assert.equal(await getMe({ fetchImpl }), NOT_ME);
  });
}

test("getMe: a signed-out edge session sends no request (a certain 401) and is not admin", async () => {
  fresh();
  globalThis.HFYFeatureFlags = { edgeSession: async () => ({ authenticated: false }) };
  try {
    const { calls, fetchImpl } = stubFetch(() => json(200, ADMIN));
    assert.equal(await getMe({ fetchImpl }), NOT_ME);
    assert.equal(calls.length, 0);
  } finally { fresh(); }
});

test("getMe: a signed-in edge session sends the request", async () => {
  fresh();
  globalThis.HFYFeatureFlags = { edgeSession: async () => ({ authenticated: true, sub: "I9099" }) };
  try {
    const { calls, fetchImpl } = stubFetch(() => json(200, ADMIN));
    assert.equal((await getMe({ fetchImpl })).admin, true);
    assert.equal(calls.length, 1);
  } finally { fresh(); }
});

test("forgetMe: the next getMe asks again", async () => {
  fresh();
  const { calls, fetchImpl } = stubFetch((n) => json(200, n === 1 ? ME : ADMIN));
  assert.equal((await getMe({ fetchImpl })).admin, false);
  forgetMe();
  assert.equal((await getMe({ fetchImpl })).admin, true);
  assert.equal(calls.length, 2);
});

test("NOT_ME is frozen: no caller can make the shared failure answer an admin", () => {
  assert.equal(Object.isFrozen(NOT_ME), true);
  assert.equal(Object.isFrozen(NOT_ME.can), true);
  assert.equal(NOT_ME.admin, false);
});

// ------------------------------------------------------------------------------------------------------------- canModerate
test("canModerate: can.moderate decides when it is a boolean; otherwise admin decides", () => {
  assert.equal(canModerate({ admin: true, can: { moderate: true } }), true);
  assert.equal(canModerate({ admin: false, can: { moderate: false } }), false);
  assert.equal(canModerate({ admin: true, can: { moderate: false } }), false);
  assert.equal(canModerate({ admin: false, can: { moderate: true } }), true);
  assert.equal(canModerate({ admin: true, can: {} }), true);
  assert.equal(canModerate({ admin: true }), true);
  assert.equal(canModerate({ admin: false }), false);
  assert.equal(canModerate({ admin: false, can: { moderate: "yes" } }), false);
  assert.equal(canModerate(NOT_ME), false);
  assert.equal(canModerate(undefined), false);
  assert.equal(canModerate(null), false);
});

// ------------------------------------------------------------------------------------------------------------- source rule
// Comments are stripped first, so prose that states the rule does not trip it; the check is on code.
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
// can.delete / can?.delete, can["delete"] / can?.["delete"], and a destructuring `{ delete: d } = c.can`.
const CAN_DELETE = /\bcan\s*\??\.\s*delete\b|\bcan\s*(?:\?\.)?\s*\[\s*["'`]delete["'`]\s*\]|\{[^{}]*\bdelete\b[^{}]*\}\s*=\s*[\w.?]*\bcan\b/;
const ADMIN_WORDS = /admin|moderat|roles/i;
const read = (rel) => readFileSync(join(SRC, rel), "utf8");
const walk = (dir) => readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? walk(p) : /\.(m?js|jsx)$/.test(f) ? [p] : []; });

test("source rule: the detectors catch the old can.delete inference (so the checks below can fail)", () => {
  const old = 'onList: (cs) => { if (sid && cs.some((c) => c.author.id !== sid && c.can.delete)) setAdmin(true); },';
  assert.match(stripComments(old), CAN_DELETE);
  assert.ok(ADMIN_WORDS.test(old));
  for (const v of ["c.can.delete", "c.can?.delete", "c.can . delete", 'c.can["delete"]', "c.can?.['delete']", "c.can [ 'delete' ]", "const { delete: d } = c.can", "const { edit, delete: del } = comment.can"]) assert.match(v, CAN_DELETE, v);
  assert.doesNotMatch(stripComments("// the kit gates delete on can.delete itself"), CAN_DELETE);
  assert.doesNotMatch("candelete; scan.deleted; api.del(x)", CAN_DELETE);
});

for (const file of ["lib/comments-ui.jsx", "lib/comment-source.js"]) {
  test(`source rule: ${file} never reads can.delete (moderator rights come from /api/me; the kit gates each delete button)`, () => {
    const code = stripComments(read(file));
    const hits = code.split("\n").map((l, i) => [i + 1, l]).filter(([, l]) => CAN_DELETE.test(l));
    assert.deepEqual(hits, [], `${file} reads can.delete`);
    assert.doesNotMatch(code, /\bonList\b/, `${file} still observes loaded comments to infer rights`);
  });
}

test("source rule: comments-ui takes moderator rights from getMe/canModerate in lib/me.js, and from nowhere else", () => {
  const code = stripComments(read("lib/comments-ui.jsx"));
  assert.match(code, /import\s*\{[^}]*\bcanModerate\b[^}]*\bgetMe\b[^}]*\}\s*from\s*"\.\/me\.js"/);
  assert.match(code, /getMe\(\)\.then\(\(me\) => \{[^}]*setModerator\(canModerate\(me\)\)/);
  const setters = [...code.matchAll(/setModerator\(([^;]*)\)/g)].map((m) => m[1]);
  assert.deepEqual(setters, ["canModerate(me)"], "setModerator is fed only by canModerate(me)");
  const roleGrants = [...code.matchAll(/roles:\s*\[\s*"admin"\s*\]/g)];
  assert.equal(roleGrants.length, 1);
  assert.match(code, /\.\.\.\(moderator \? \{ roles: \["admin"\] \} : \{\}\)/);
});

test("source rule: no island statement infers admin, moderator or roles from can.delete", () => {
  const files = walk(SRC);
  assert.ok(files.length > 10, "walked the island sources");
  const hits = [];
  for (const f of files) {
    const statements = stripComments(readFileSync(f, "utf8")).split(/[;\n]/);
    for (const s of statements) if (CAN_DELETE.test(s) && ADMIN_WORDS.test(s)) hits.push(`${f.slice(SRC.length)}: ${s.trim()}`);
  }
  assert.deepEqual(hits, []);
});
