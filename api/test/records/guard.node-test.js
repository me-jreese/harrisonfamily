// Edit guard adapter (HFY-TSK-250, edit-guard-wiring). Plain node:test: `node --test test/records/guard.node-test.js`; needs no
// network, no AWS and no install. Every fixture is synthetic. The cases are the shared corpus (shared/edit-guard.cases.json) that
// the browser mirror also runs; this file adds the adapter's own contract: policy import, 422 body, captured log.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { RecordGuardError, createRecordGuard, loadPolicy, policyUrl } from "../../src/records/guard.js";
import { createEditGuard } from "../../src/shared/edit-guard.mjs";
import { expected, leaksText, runCase } from "../../src/shared/edit-guard-corpus.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const corpus = JSON.parse(readFileSync(resolve(here, "../../../shared/edit-guard.cases.json"), "utf8"));
const policy = loadPolicy();
const make = ({ dob }) => createRecordGuard({ policy, dob });

describe("the shared corpus through the adapter", () => {
  for (const c of corpus.cases) {
    it(c.id, () => {
      const found = runCase(make, c);
      assert.deepEqual(found, expected(c));
      assert.equal(leaksText(found, corpus), false);
    });
  }
});

const byId = (id) => corpus.cases.find((c) => c.id === id);
const phoneAtEachDepth = ["text-name-first", "text-surname-nested", "text-alt-name", "text-attribute", "text-url-desc", "text-medialink-attribute", "text-eventref-attribute", "text-note", "text-event-description", "text-place-name-and-alt", "text-citation-source-repo-media"];

describe("R-18 at every depth", () => {
  it("a synthetic phone number at each depth, including nested secondary objects, is a 422 contact_info", () => {
    for (const id of phoneAtEachDepth) {
      const guard = createRecordGuard({ policy });
      assert.throws(() => guard.assertObjects(byId(id).objects), (e) => e instanceof RecordGuardError && e.status === 422 && e.code === "contact_info" && e.errors.length > 0, id);
    }
  });
  it("proposal notes, decision reasons and relationship stub fields are guarded", () => {
    const guard = createRecordGuard({ policy });
    for (const v of [corpus.phone, { reason: `x ${corpus.phone}` }, { stubs: [{ given: "Ada", place: corpus.phone }] }]) {
      assert.throws(() => guard.assertValue(v, "proposal.note"), (e) => e.status === 422 && e.code === "contact_info");
    }
    assert.doesNotThrow(() => guard.assertValue("fixing a typo", "proposal.note"));
  });
});

describe("R-19 structural rules come from the policy file", () => {
  it("the adapter reads gramps/redaction/redaction-v1.json and keeps no birth-like list of its own", () => {
    const src = readFileSync(resolve(here, "../../src/records/guard.js"), "utf8") + readFileSync(resolve(here, "../../../shared/edit-guard.mjs"), "utf8");
    assert.match(readFileSync(resolve(here, "../../../shared/edit-guard.mjs"), "utf8"), /import \{[^}]*isBirthLike[^}]*\} from "\.\/redaction-rules\.mjs"/);
    assert.match(src, /redaction-v1\.json/);
    assert.doesNotMatch(src, /\[\s*12\s*,\s*14\s*,\s*15|birth\|bapt/);
  });
  it("a policy with another birth-like type changes the verdict (no local list)", () => {
    const narrowed = { ...policy, birthLike: { ...policy.birthLike, eventTypes: [{ value: 12, name: "Birth" }] } };
    const c = byId("birth-like-type-baptism");
    assert.equal(createEditGuard({ policy }).checkObjects(c.objects).length, 1);
    assert.equal(createEditGuard({ policy: narrowed }).checkObjects(c.objects).length, 0);
  });
  it("a refusal for a mix of codes reports contact_info first, then dob_not_allowed, then never_in_cloud", () => {
    assert.equal(new RecordGuardError([{ code: "never_in_cloud" }, { code: "dob_not_allowed" }]).code, "dob_not_allowed");
    assert.equal(new RecordGuardError([{ code: "never_in_cloud" }]).code, "never_in_cloud");
    assert.equal(new RecordGuardError([{ code: "never_in_cloud" }, { code: "contact_info" }]).code, "contact_info");
  });
});

describe("the 422 body and the log carry pointers and counts, never the matched text", () => {
  it("errors hold pointers and spans only, and the message is the DS copy", () => {
    const lines = [];
    const guard = createRecordGuard({ policy, log: { info: (...a) => lines.push(a) } });
    let err;
    try { guard.assertObjects(byId("text-citation-source-repo-media").objects, { surface: "changes", op: "submit" }); } catch (e) { err = e; }
    assert.ok(err instanceof RecordGuardError);
    assert.equal(err.errors.length, 4);
    assert.match(err.message, /phone number or street address/);
    for (const e of err.errors) assert.deepEqual(Object.keys(e).sort(), ["code", "kind", "obj", "opId", "path", "pointer", "span"]);
    const body = JSON.stringify({ error: err.code, message: err.message, errors: err.errors });
    assert.equal(body.includes("555"), false);
    assert.equal(body.includes("010-0199"), false);
  });
  it("a captured log has one line of counts per code and no text, offsets or ids", () => {
    const lines = [];
    const guard = createRecordGuard({ policy, log: { info: (...a) => lines.push(a) } });
    const objects = { ...byId("text-note").objects, ...byId("birth-day-month").objects, ...byId("place-type-7").objects };
    assert.throws(() => guard.assertObjects(objects, { surface: "changes", op: "submit" }));
    assert.deepEqual(lines, [["privacy_guard", { surface: "changes", op: "submit", counts: { contact_info: 1, dob_not_allowed: 2, never_in_cloud: 1 } }]]);
    const text = JSON.stringify(lines);
    for (const needle of ["555", "Note:n1", "Event:e1", "span", "pointer", "handle"]) assert.equal(text.includes(needle), false, needle);
  });
  it("a throwing logger never changes the answer", () => {
    const guard = createRecordGuard({ policy, log: { info() { throw new Error("log down"); } } });
    assert.throws(() => guard.assertValue(corpus.phone, "n"), RecordGuardError);
  });
});

describe("the policy path in both layouts", () => {
  const stage = () => {
    const root = mkdtempSync(join(tmpdir(), "hfy-policy-"));
    mkdirSync(join(root, "gramps", "redaction"), { recursive: true });
    return root;
  };
  it("the zip layout (gramps/ beside src/) and the checkout layout (gramps/ above api/) both resolve to the policy file", () => {
    const zip = stage();
    const repo = stage();
    try {
      writeFileSync(join(zip, "gramps", "redaction", "redaction-v1.json"), "{}");
      assert.equal(policyUrl(pathToFileURL(join(zip, "src", "records", "guard.js"))).pathname, pathToFileURL(join(zip, "gramps", "redaction", "redaction-v1.json")).pathname);
      mkdirSync(join(repo, "api", "src", "records"), { recursive: true });
      writeFileSync(join(repo, "gramps", "redaction", "redaction-v1.json"), "{}");
      assert.equal(policyUrl(pathToFileURL(join(repo, "api", "src", "records", "guard.js"))).pathname, pathToFileURL(join(repo, "gramps", "redaction", "redaction-v1.json")).pathname);
    } finally {
      rmSync(zip, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });
  it("loadPolicy reads the real policy from the checkout", () => {
    assert.ok(loadPolicy().dates.dayMonthIndexes);
  });
});
