// privacy-guard-existing-paths AC2 (node half): the composers' pre-check verdict, the DOB switch the page learns from the API, and
// the comment source's refusal mapping. The DOM decoration and the 375 px screenshots are tests/contact-guard.spec.mjs.
// Synthetic text only (555-01xx, example.org).
import { test } from "node:test";
import assert from "node:assert/strict";
import { CommentError } from "@io-kit/comments";
import { ApiError } from "../src/lib/api.js";
import { createHfyCommentSource } from "../src/lib/comment-source.js";
import { GUARD_COPY, learnFromRefusal, mergeSpans, precheck, precheckAll } from "../src/lib/contact-precheck.js";

const CONTACT = "this looks like a phone number or street address. we don't keep those on the site, so please remove it to continue.";
const DOB = "we only keep the birth year on the site.";

test("the copy is the DS voice line from shared/privacy-guard.mjs (the server's own)", () => {
  assert.equal(GUARD_COPY.contact_info, CONTACT);
  assert.equal(GUARD_COPY.dob_not_allowed, DOB);
});

test("precheck: contact kinds give contact_info with spans (offsets into the text), clean text gives null", () => {
  const text = "call me on 555-0142 or write to ann@example.org";
  const v = precheck(text);
  assert.equal(v.code, "contact_info");
  assert.equal(v.message, CONTACT);
  assert.deepEqual(v.spans.map((s) => [s.kind, text.slice(s.start, s.end)]), [["phone", "555-0142"], ["email", "ann@example.org"]]);
  for (const clean of ["", "the 1950 reunion: 120 people", "see you at noon", undefined, null, 42]) assert.equal(precheck(clean), null);
  assert.equal(precheckAll(["fine", undefined, "42 Example Street"]).code, "contact_info");
  assert.equal(precheckAll(["fine", undefined]), null);
});

test("mergeSpans: overlapping and touching spans mark once, in order", () => {
  assert.deepEqual(mergeSpans([{ start: 10, end: 14 }, { start: 0, end: 4 }, { start: 3, end: 6 }, { start: 14, end: 16 }]), [{ start: 0, end: 6 }, { start: 10, end: 16 }]);
});

// Before the comment source test: learnFromRefusal changes module state for the rest of this file.
test("the birthday check is off until the API answers dob_not_allowed once, then on for the page", () => {
  const bday = "her birthday is May 5th";
  assert.equal(precheck(bday), null);
  learnFromRefusal("contact_info");
  assert.equal(precheck(bday), null);
  learnFromRefusal("dob_not_allowed");
  assert.equal(precheck(bday).code, "dob_not_allowed");
  assert.equal(precheck(bday).message, DOB);
  assert.equal(precheck(`${bday}, call 555-0142`).code, "contact_info");
});

test("the comment source sends nothing for a refused text and maps the API's 422 to the DS copy (not 'try again')", async () => {
  const sent = [];
  const api = {
    post: async (path, body) => { sent.push([path, body]); throw new ApiError(422, "contact_info", CONTACT); },
    patch: async (path, body) => { sent.push([path, body]); throw new ApiError(422, "dob_not_allowed", DOB); },
  };
  const src = createHfyCommentSource(api);
  await assert.rejects(src.create("person:I9001", { body: "text 555-0142" }), (e) => e instanceof CommentError && e.code === "validation" && e.message === CONTACT);
  await assert.rejects(src.edit("person:I9001", "01J00000000000000000000000", { body: "write to ann@example.org" }), (e) => e.message === CONTACT);
  assert.deepEqual(sent, []); // held before the request
  // a text the client let through (the server's DOB switch is on) comes back as the server's copy
  await assert.rejects(src.create("person:I9001", { body: "fine by me" }), (e) => e.code === "validation" && e.message === CONTACT);
  await assert.rejects(src.edit("person:I9001", "01J00000000000000000000000", { body: "fine again" }), (e) => e.message === DOB);
  assert.equal(sent.length, 2);
});
