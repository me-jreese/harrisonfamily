// What the committed bundle and the config declare (HFY-TSK-198 ACs 1, 2 and 6): no network, no Cloudflare.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { unstable_readConfig } from "wrangler";
import { distFile, root } from "./helpers.mjs";

const read = (p) => readFileSync(join(root, p), "utf8");
const json = (p) => JSON.parse(read(p));
const bundle = readFileSync(distFile, "utf8");
const deploy = json("dist/deploy.json");
const prod = unstable_readConfig({ config: join(root, "wrangler.toml") });
const staging = unstable_readConfig({ config: join(root, "wrangler.toml"), env: "staging" });

test("dist holds the bundle and deploy.json and nothing else", () => {
  assert.deepEqual(readdirSync(join(root, "dist")).sort(), ["deploy.json", "index.js"]);
  assert.equal(deploy.main_module, "index.js");
  assert.equal(deploy.bundle.sha256, createHash("sha256").update(readFileSync(distFile)).digest("hex"));
});

test("deploy.json declares the ChatHub binding, migration v1 with new_sqlite_classes, and exactly the two routes", () => {
  assert.deepEqual(deploy.bindings, [{ type: "durable_object_namespace", name: "CHAT_HUB", class_name: "ChatHub" }]);
  assert.deepEqual(deploy.migrations, { new_tag: "v1", new_sqlite_classes: ["ChatHub"] });
  assert.deepEqual(deploy.routes, ["harrisonfamily.us/chat/ws*", "harrisonfamily.us/chat/v1/*"]);
  assert.match(deploy.compatibility_date, /^\d{4}-\d{2}-\d{2}$/);
});

test("deploy.json carries no secret, no staging value and no version (CI injects the commit sha at upload)", () => {
  const text = read("dist/deploy.json");
  for (const bad of ["CHAT_SERVICE_PRIVATE_KEY", "TEST_JWKS", "STAGING_MEMBERS", "CHAT_PASSTHROUGH", "chat-staging", "BEGIN PRIVATE KEY", "CHAT_WORKER_VERSION"]) {
    assert.ok(!text.includes(bad), `deploy.json mentions ${bad}`);
  }
  assert.equal(deploy.vars.SITE_ORIGIN, "https://harrisonfamily.us");
  assert.equal(deploy.vars.CHAT_OPEN_TO, "uat", "the Worker starts closed to everyone but the UAT list");
  assert.equal(deploy.vars.CHAT_ENABLED, "1");
});

test("wrangler.toml: every Durable Object class is declared in new_sqlite_classes, with no key-value class", () => {
  for (const [label, cfg] of [["production", prod], ["staging", staging]]) {
    const classes = cfg.durable_objects.bindings.map((b) => b.class_name);
    assert.deepEqual(classes, ["ChatHub"], label);
    const declared = new Set(cfg.migrations.flatMap((m) => m.new_sqlite_classes ?? []));
    for (const c of classes) assert.ok(declared.has(c), `${label}: ${c} is not in new_sqlite_classes`);
    for (const m of cfg.migrations) {
      assert.equal(m.new_classes, undefined, `${label}: new_classes would create a key-value class`);
      assert.equal(m.deleted_classes, undefined, `${label}: a delete migration destroys data`);
      assert.equal(m.renamed_classes, undefined, `${label}: a class is never renamed`);
    }
    assert.deepEqual(cfg.migrations.map((m) => m.tag), ["v1"], label);
  }
});

test("wrangler.toml: only the two chat routes, workers.dev off, and no platform log", () => {
  assert.deepEqual(prod.routes.map((r) => r.pattern), ["harrisonfamily.us/chat/ws*", "harrisonfamily.us/chat/v1/*"]);
  for (const r of prod.routes) assert.equal(r.zone_name, "harrisonfamily.us");
  assert.equal(prod.workers_dev, false);
  assert.equal(prod.preview_urls, false);
  assert.equal(prod.observability.enabled, false, "observability can record request headers, the cookie among them");
  assert.equal(prod.observability.logs?.enabled, false);
  assert.equal(prod.observability.logs?.invocation_logs, false);
  assert.equal(staging.observability.enabled, false);
  assert.deepEqual(staging.routes ?? [], []);
});

test("staging has its own script name, so its own Durable Object namespace, and a test JWKS rather than production's", () => {
  assert.equal(staging.name, "hfy-chat-worker-staging");
  assert.notEqual(staging.name, prod.name);
  assert.equal(staging.workers_dev, true);
  assert.equal(staging.main.replace(/\\/g, "/").split("/").slice(-2).join("/"), "src/staging.mjs");
  assert.notEqual(staging.vars.SESSION_JWKS_URL, prod.vars.SESSION_JWKS_URL);
  assert.ok(!/harrisonfamily\.us\/auth/.test(staging.vars.SESSION_JWKS_URL));
  assert.notEqual(staging.vars.SITE_ORIGIN, prod.vars.SITE_ORIGIN);
  assert.equal(staging.vars.CHAT_PASSTHROUGH, "off");
  assert.equal(staging.vars.TEST_JWKS, undefined, "the test JWKS is passed at deploy time, never committed");
});

test("the object keeps the Durable Object rules: no timers, tagged acceptWebSocket, a registered auto-response", () => {
  assert.ok(!/\bsetTimeout\b/.test(bundle), "setTimeout in the bundle");
  assert.ok(!/\bsetInterval\b/.test(bundle), "setInterval in the bundle");
  assert.match(bundle, /this\.ctx\.acceptWebSocket\(\s*server\s*,\s*\[uid\]\s*\)/, "acceptWebSocket is called with the uid tag");
  assert.match(bundle, /ctx\.setWebSocketAutoResponse\(/, "setWebSocketAutoResponse is registered");
  assert.match(bundle, /serializeAttachment/, "per-socket state is an attachment");
});

test("the production bundle holds no staging code and no test stand-in", () => {
  for (const bad of ["TEST_JWKS", "STAGING_MEMBERS", "stagingApi", "chat-staging", "Tester "]) assert.ok(!bundle.includes(bad), `bundle mentions ${bad}`);
});

test("the bundle logs through one text-free line only", () => {
  // Static, deliberately loose: every use of the `console` identifier, wherever it sits on a line. The runtime console spies
  // in worker.test.mjs and hub.test.mjs are the authoritative PS-16 check; this only catches a new logging site early.
  const uses = [...bundle.matchAll(/\bconsole\b\s*(\.\s*\w+)?/g)].map((m) => (m[1] ?? "<bare>").replace(/\s+/g, ""));
  assert.deepEqual(uses, [".log"], "any other console use (another method, an alias, a bare reference) must be reviewed against PS-16");
});

test("the bundle does not point at a sourcemap that is never uploaded", () => {
  assert.ok(!/sourceMappingURL/.test(bundle));
});

test("the entry wires the shared R-18 guard, not a copy", () => {
  assert.match(read("src/common.mjs"), /from "\.\.\/\.\.\/shared\/privacy-guard\.mjs"/);
  assert.match(bundle, /shared\/privacy-guard\.mjs/, "the bundle contains the shared module");
});

test("package.json pins every dependency exactly, and the lockfile agrees (no CI-time npm: review DL-23)", () => {
  const pkg = json("package.json");
  for (const group of [pkg.dependencies, pkg.devDependencies]) {
    for (const [name, v] of Object.entries(group)) assert.match(v, /^\d+\.\d+\.\d+$/, `${name}@${v} is not an exact pin`);
  }
  assert.match(pkg.dependencies["@io-kit/chat"], /^0\.3\.\d+$/);
  const lock = json("package-lock.json");
  assert.equal(lock.lockfileVersion, 3);
  const rootPkg = lock.packages[""];
  assert.deepEqual(rootPkg.dependencies, pkg.dependencies);
  assert.deepEqual(rootPkg.devDependencies, pkg.devDependencies);
  const chat = lock.packages["node_modules/@io-kit/chat"];
  assert.equal(chat.version, pkg.dependencies["@io-kit/chat"]);
  assert.match(chat.resolved, /^https:\/\/io-\d+\.d\.codeartifact\.us-west-2\.amazonaws\.com\/npm\/io-kit\/@io-kit\/chat\/-\/chat-[\d.]+\.tgz$/);
  assert.match(chat.integrity, /^sha512-/);
  assert.equal(lock.packages["node_modules/wrangler"].version, pkg.devDependencies.wrangler);
  assert.ok(!/authToken|eyJ[A-Za-z0-9_-]{20,}/.test(read("package-lock.json")), "the lockfile holds no token");
});

test(".npmrc reads the token from the environment and holds none", () => {
  assert.ok(existsSync(join(root, ".npmrc")));
  const rc = read(".npmrc");
  assert.match(rc, /_authToken=\$\{CODEARTIFACT_AUTH_TOKEN\}/);
  assert.ok(!/_authToken=(?!\$\{)/.test(rc));
});
