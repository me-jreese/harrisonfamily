// HFY-TSK-388-0A pass 3: the pure helpers and the save run of the portrait and add-photo islands (src/lib/person-media-model.js). Synthetic ids only.
// Run: node --test tests/person-media.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { COPY, CONTACT, REVIEWER, initialsOf, savePortrait, tagHref, viewerMode } from "../src/lib/person-media-model.js";

test("viewerMode: own record direct, another person's by proposal, signed out nothing (D-09)", () => {
  assert.equal(viewerMode("I9001", "I9001"), "own");
  assert.equal(viewerMode("I9002", "I9001"), "other");
  assert.equal(viewerMode(null, "I9001"), null);
  assert.equal(viewerMode("I9002", ""), null);
});

test("initialsOf: first and last word, capitals, ? when there is no name", () => {
  assert.equal(initialsOf("Test Person (synthetic)"), "TS");
  assert.equal(initialsOf("sam"), "S");
  assert.equal(initialsOf("  "), "?");
  assert.equal(initialsOf(undefined), "?");
});

test("tagHref names the person's photos on the person page, escaped", () => {
  assert.equal(tagHref("I9001"), "/person/?id=I9001#person-media-section");
  assert.equal(tagHref("a&b"), "/person/?id=a%26b#person-media-section");
});

test("copy: lower case and none of the banned words", () => {
  const text = [COPY.suggest, COPY.close, COPY.cropTitle, REVIEWER, CONTACT].join(" ");
  assert.doesNotMatch(text.toLowerCase(), /\b(event|role|mediaref|region)\b/);
  assert.equal(COPY.suggest, COPY.suggest.toLowerCase());
});

const photo = () => ({ file: new File([new Uint8Array([1, 2, 3])], "p.jpg", { type: "image/jpeg" }), width: 200, height: 200 });
function fakeSource({ tagState = "applied", failCommit = 0 } = {}) {
  const calls = { presign: [], commit: [], portrait: [], put: 0 };
  let commits = 0;
  return {
    calls,
    rectUnit: { kind: "int-percent", min: 0, max: 100 },
    upload: {
      async presign(req) { calls.presign.push(req); return { uploadId: `U${calls.presign.length}`, url: "https://uploads.example.test/u", expiresAt: "2030-01-01T00:00:00Z" }; },
      async commit(items) { calls.commit.push(items); commits += 1; if (commits <= failCommit) throw new Error("boom"); return items.map((i) => ({ uploadId: i.uploadId, mediaId: "O9100", state: "graduated" })); },
    },
    portrait: { async setPortrait(req) { calls.portrait.push(req); return [{ personId: req.personId, mediaId: req.mediaId, rect: req.crop, index: 0, state: tagState }]; } },
  };
}
const put = async () => {};

test("savePortrait on the member's own record: presign, commit, one setPortrait with the crop; not pending", async () => {
  const source = fakeSource();
  const seen = [];
  const r = await savePortrait({ source, personId: "I9001", photo: photo(), rect: [10, 10, 60, 60], put, onChange: (e) => seen.push(e.map((x) => x.state).join()) });
  assert.equal(r.failed, false);
  assert.equal(r.pending, false);
  assert.deepEqual(source.calls.presign.map((p) => [p.purpose, p.subject]), [["portrait", "I9001"]]);
  assert.deepEqual(source.calls.commit[0], [{ uploadId: "U1", purpose: "portrait", subject: "I9001" }]);
  assert.deepEqual(source.calls.portrait, [{ personId: "I9001", mediaId: "O9100", crop: [10, 10, 60, 60] }]);
  assert.ok(seen.length > 0);
});

test("savePortrait: a full-frame crop goes as null, and a proposal comes back pending", async () => {
  const source = fakeSource({ tagState: "pending-proposal" });
  const r = await savePortrait({ source, personId: "I9001", photo: photo(), rect: null, put });
  assert.equal(source.calls.portrait[0].crop, null);
  assert.equal(r.pending, true);
});

test("savePortrait: a failed commit is reported as failed and the retry with the same entries finishes it", async () => {
  const source = fakeSource({ failCommit: 1 });
  const first = await savePortrait({ source, personId: "I9001", photo: photo(), rect: null, put });
  assert.equal(first.failed, true);
  assert.equal(source.calls.portrait.length, 0);
  const second = await savePortrait({ source, personId: "I9001", photo: photo(), rect: null, entries: first.entries, put });
  assert.equal(second.failed, false);
  assert.equal(source.calls.portrait.length, 1);
});

test("savePortrait refuses a source without the upload and portrait ports", async () => {
  await assert.rejects(savePortrait({ source: { upload: {} }, personId: "I9001", photo: photo(), rect: null }), /NOT_SUPPORTED/);
});
