// HFY-TSK-217: lib/profile-links.js, the pure side of the links section and the editor (copy, chips, the changed fields).
import test from "node:test";
import assert from "node:assert/strict";
import { CHIP_REL, EDITOR_COPY, PLATFORMS, changesFrom, checkField, chipsFrom, errorLine, fieldErrors, valuesFromLinks } from "../src/lib/profile-links.js";

test("the seven platforms in the editor's order", () => {
  assert.deepEqual(PLATFORMS, ["facebook", "instagram", "snapchat", "tiktok", "linktree", "linkedin", "website"]);
});

test("error lines are the design's voice, lowercase, with the 'move it' suggestion for wrong_platform", () => {
  assert.equal(errorLine({ field: "website", code: "wrong_platform", suggest: "instagram" }), "that's an instagram link. move it to instagram?");
  assert.equal(errorLine({ field: "website", code: "wrong_platform", suggest: "tiktok" }), "that's a tiktok link. move it to tiktok?");
  assert.equal(errorLine({ field: "facebook", code: "short_link" }), "that's a share link. open your profile and copy the address from there.");
  assert.equal(errorLine({ field: "facebook", code: "contact_channel" }), "that's a way to message someone, not a profile. use your profile's address instead.");
  assert.equal(errorLine({ field: "facebook", code: "contact_info" }), "that looks like a phone number. take it out, then save.");
  assert.equal(errorLine({ field: "linkedin", code: "not_a_profile", message: "that's an old linkedin address. open it." }), "that's an old linkedin address. open it.");
  for (const code of ["invalid_url", "scheme_not_allowed", "not_a_profile", "too_long", "invalid_handle", "unknown_platform", "something_new"]) {
    const line = errorLine({ field: "instagram", code });
    assert.ok(line && line === line.toLowerCase() && !line.includes("!"), `${code}: ${line}`);
  }
});

test("checkField runs the shared validator: blank is fine, a bad value gives its code and suggestion", () => {
  assert.equal(checkField("instagram", "   "), null);
  assert.equal(checkField("instagram", "@sample.name"), null);
  assert.deepEqual(checkField("website", "https://www.instagram.com/sample.name"), { field: "website", code: "wrong_platform", suggest: "instagram" });
  assert.equal(checkField("facebook", "+1 555 010 0100")?.code, "contact_info");
  assert.equal(checkField("facebook", "mailto:a@example.com")?.code, "contact_channel");
});

test("values and changes: only the fields that differ are sent, a blank is a clear", () => {
  const stored = valuesFromLinks({ instagram: { url: "https://www.instagram.com/sample.name", handle: "sample.name" }, website: { url: "https://example.org/", host: "example.org" } });
  assert.equal(stored.instagram, "https://www.instagram.com/sample.name");
  assert.equal(stored.facebook, "");
  assert.deepEqual(changesFrom({ ...stored }, stored), {});
  assert.deepEqual(changesFrom({ ...stored, instagram: "", facebook: " @sample.fb " }, stored), { instagram: null, facebook: "@sample.fb" });
  assert.deepEqual(valuesFromLinks(undefined), Object.fromEntries(PLATFORMS.map((p) => [p, ""])));
});

test("fieldErrors keys a 422's list by field and ignores junk", () => {
  assert.deepEqual(fieldErrors([{ field: "website", code: "wrong_platform", suggest: "instagram" }, null, { code: "x" }]), { website: { field: "website", code: "wrong_platform", suggest: "instagram" } });
  assert.deepEqual(fieldErrors(undefined), {});
});

test("chips: @handle for handle platforms, the name for facebook and linkedin, the host for a website; order is the editor's", () => {
  const chips = chipsFrom({
    website: { url: "https://example.org/", host: "example.org" },
    linkedin: { url: "https://www.linkedin.com/in/sample-name", handle: "sample-name" },
    instagram: { url: "https://www.instagram.com/sample.name", handle: "sample.name" },
    facebook: { url: "https://www.facebook.com/sample.name", handle: "sample.name" },
    tiktok: { url: "https://www.tiktok.com/@sample.name", handle: "sample.name" }
  });
  assert.deepEqual(chips.map((c) => [c.platform, c.text]), [["facebook", "facebook"], ["instagram", "@sample.name"], ["tiktok", "@sample.name"], ["linkedin", "linkedin"], ["website", "example.org"]]);
  assert.equal(chips[1].label, "instagram: @sample.name (opens in a new tab)");
  assert.equal(chips[0].label, "facebook (opens in a new tab)");
  assert.equal(chips[4].label, "website: example.org (opens in a new tab)");
  assert.equal(CHIP_REL, "noopener noreferrer nofollow ugc");
});

test("chips drop anything that is not an https URL (stored data is not trusted)", () => {
  assert.deepEqual(chipsFrom({ instagram: { url: "javascript:alert(1)", handle: "x" }, facebook: { url: "http://www.facebook.com/x" }, website: { url: 5 }, snapchat: null }), []);
  assert.deepEqual(chipsFrom(null), []);
  assert.deepEqual(chipsFrom([]), []);
});

test("editor copy has no exclamation marks and is lowercase", () => {
  for (const [k, v] of Object.entries(EDITOR_COPY)) assert.ok(!v.includes("!") && v === v.toLowerCase(), k);
});
