// Tests for the editing documentation (HFY-TSK-284, edit-docs). CodeArtifact-free: runs in the io-kit CI `tests` list, which
// installs nothing. The generator stands in for the two @io-kit packages that api/src/http.js imports (see its header), and a
// test runs it in a copy with no node_modules.
//   - docs/reference/field-policy.md is generated from api/src/records/field-policy.js, and the drift check fails on a mismatch
//   - every editing route in api/src/routes.js is in the API reference's route table
//   - the changed docs pages have no broken relative links or anchors
//   - the new pages carry no e-mail address or phone number
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { check, OUT_PATH, render, load } from "../../records/gen-field-policy-doc.mjs";
import { checkFile } from "../../docs/check-relative-links.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (p) => readFileSync(join(REPO, p), "utf8");
const PAGES = [
  "docs/reference/field-policy.md",
  "docs/reference/api.md",
  "docs/explanation/editing-and-proposals.md",
  "docs/how-to/review-suggested-changes.md",
  "docs/how-to/turn-on-editing.md",
  "docs/README.md",
  "docs/reference/codebase-map.md",
  "docs/how-to/run-the-tests.md",
  "docs/reference/repository-operations.md",
  "docs/reference/editing-d11-audit.md",
];

describe("field-policy.md", () => {
  it("is current with the policy table", async () => {
    assert.deepEqual(await check(REPO), []);
  });

  it("is exactly what the generator renders", async () => {
    assert.equal(read(OUT_PATH), render(await load(REPO)));
  });

  it("lists every row of the table", async () => {
    const mod = await load(REPO);
    const page = read(OUT_PATH);
    for (const r of mod.DEFAULT_FIELD_POLICY.document().rows) assert.ok(page.includes(`\`${r.pointer}\``), `${r.cls} ${r.pointer}`);
    for (const r of mod.Q2_15_ROWS) assert.ok(page.includes(`\`${r.id}\``), r.id);
  });

  it("fails the drift check on a hand edit, and the CLI exits 1", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hfy-fp-doc-"));
    try {
      mkdirSync(join(dir, "docs/reference"), { recursive: true });
      writeFileSync(join(dir, OUT_PATH), read(OUT_PATH).replace("`direct`", "`proposal`"));
      const mod = await load(REPO);
      assert.equal((await check(dir, mod)).length, 1);
      const run = spawnSync(process.execPath, [join(REPO, "scripts/records/gen-field-policy-doc.mjs"), "--check", "--root", dir], { encoding: "utf8" });
      assert.equal(run.status, 1);
      assert.match(run.stderr, /drift/);
      rmSync(join(dir, OUT_PATH));
      assert.equal((await check(dir, mod))[0], `${OUT_PATH} is missing`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("passes the CLI check on the committed page", () => {
    const run = spawnSync(process.execPath, [join(REPO, "scripts/records/gen-field-policy-doc.mjs"), "--check"], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /field-policy\.md is current/);
  });

  it("passes the CLI check in a copy with no installed packages, as CI runs it", () => {
    // CI installs nothing; a worktree with api/node_modules would hide a package import on the table's import chain.
    const dir = mkdtempSync(join(tmpdir(), "hfy-fp-bare-"));
    try {
      for (const p of ["api/src", "gramps/redaction", "scripts/records/gen-field-policy-doc.mjs", OUT_PATH]) cpSync(join(REPO, p), join(dir, p), { recursive: true });
      for (let d = dir; d !== dirname(d); d = dirname(d)) assert.ok(!existsSync(join(d, "node_modules")), `${d} has node_modules`);
      // Run it through the unresolved temp path (a symlink on macOS): the CLI must still run, not exit 0 having checked nothing.
      const run = spawnSync(process.execPath, [join(dir, "scripts/records/gen-field-policy-doc.mjs"), "--check"], { encoding: "utf8" });
      assert.equal(run.status, 0, run.stderr);
      assert.match(run.stdout, /field-policy\.md is current/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Error codes are a smoke check only (any three-digit code in the last column); they are not verified against the handlers.
const EXPECTED_ROUTES = ["changes.post", "edit.get", "edit.schema", "me.get", "proposals.amend", "proposals.decide", "proposals.get", "proposals.list", "proposals.withdraw", "relationships.post", "relationships.preview"];
describe("api.md editing routes", () => {
  const routes = [...read("api/src/routes.js").matchAll(/name: "([a-zA-Z.]+)", method: "([A-Z]+)", path: "([^"]+)"/g)]
    .map(([, name, method, path]) => ({ name, method, path }))
    .filter((r) => /^(me|edit|changes|relationships|proposals)\./.test(r.name));
  const api = read("docs/reference/api.md");
  const glance = api.slice(api.indexOf("## Editing routes at a glance"), api.indexOf("## Editing API core"));

  it("finds the editing routes", () => {
    // The exact set: a new or removed editing route must be added here and to the table. The route regex needs one entry per line.
    assert.deepEqual(routes.map((r) => r.name).sort(), EXPECTED_ROUTES, "editing route set changed");
  });

  for (const r of routes) {
    it(`documents ${r.method} /api${r.path} with its errors`, () => {
      const row = glance.split("\n").find((l) => l.startsWith(`| \`${r.method} /api${r.path}\``));
      assert.ok(row, "no row in the route table");
      const cols = row.split(/ \| /);
      assert.ok(cols.length >= 4 && /\d{3}/.test(cols[cols.length - 1]), "the row has no error codes");
    });
  }
});

describe("relative links", () => {
  for (const p of PAGES) {
    it(`${p} has none broken`, () => {
      assert.deepEqual(checkFile(join(REPO, p)), []);
    });
  }

  it("reports a broken link and a missing anchor", () => {
    const dir = mkdtempSync(join(tmpdir(), "hfy-links-"));
    try {
      writeFileSync(join(dir, "a.md"), "# A\n\n[gone](missing.md) [bad](b.md#nope) [ok](b.md#hello-there) `[code](skip.md)`\n\n```\n[fenced](skip2.md)\n```\n");
      writeFileSync(join(dir, "b.md"), "## Hello there\n");
      const found = checkFile(join(dir, "a.md"));
      assert.equal(found.length, 2, found.join("\n"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("privacy", () => {
  for (const p of PAGES.slice(0, 5)) {
    it(`${p} has no e-mail address or phone number`, () => {
      const text = read(p).replace(/<[a-z-]+@?[^>\s]*>/g, "");
      assert.deepEqual(text.match(/[\w.+-]+@[\w-]+\.[\w.-]+/g) ?? [], []);
      assert.deepEqual(text.match(/(?<![\w.:/-])\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}(?!\w)/g) ?? [], []);
    });
  }
});
