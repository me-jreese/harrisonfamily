// surf-links-validator: shared/profile-links.mjs against shared/profile-links.cases.json (surfaces.md 6.2), plus validateLinks.
// Runs under `node --test shared/` (shared.test.mjs imports it); api/test/profile-links.test.js runs the same table from src/shared/.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ERROR_CODES, LINKEDIN_PUB_MESSAGE, PLATFORM_DOMAINS, PLATFORMS, SHORTENERS, validateLink, validateLinks,
} from "./profile-links.mjs";
import { CONTACT_HOSTS } from "./privacy-guard.mjs";

const dir = dirname(fileURLToPath(import.meta.url));
const { cases } = JSON.parse(readFileSync(join(dir, "profile-links.cases.json"), "utf8"));

test("the table holds at least 150 cases and covers every platform, every error code and the R-17 matrix (AC2)", () => {
  assert.ok(cases.length >= 150, `${cases.length} cases`);
  for (const p of PLATFORMS) assert.ok(cases.some((c) => c.platform === p && c.expect.ok), `no accepted ${p} case`);
  for (const code of ERROR_CODES) assert.ok(cases.some((c) => c.expect.code === code), `no ${code} case`);
  // R-17: the website field refuses every registry host, contact host and shortener; one case per domain at least
  const website = cases.filter((c) => c.platform === "website" && !c.expect.ok).map((c) => c.input.toLowerCase());
  for (const d of [...Object.values(PLATFORM_DOMAINS).flat(), ...SHORTENERS]) {
    assert.ok(website.some((i) => i.replace(/^https?:\/\//, "").split("/")[0].endsWith(d)), `website has no case for ${d}`);
  }
  for (const d of ["m.me", "ig.me", "wa.me", "t.me", "messenger.com", "api.whatsapp.com", "signal.me"]) {
    assert.ok(CONTACT_HOSTS.includes(d) && website.some((i) => i.split("/")[0] === d), `website has no case for contact host ${d}`);
  }
});

for (const [n, c] of cases.entries()) {
  test(`${c.platform} ${JSON.stringify(c.input).slice(0, 70)}${c.note ? ` (${c.note})` : ""} [${n}]`, () => {
    assert.deepEqual(validateLink(c.platform, c.input), c.expect);
  });
}

test("canonical URLs follow the surfaces.md 6.2 table, and the website host is ASCII (AC4)", () => {
  assert.equal(validateLink("facebook", "@jane.example").url, "https://www.facebook.com/jane.example");
  assert.equal(validateLink("facebook", "facebook.com/profile.php?id=42").url, "https://www.facebook.com/profile.php?id=42");
  assert.equal(validateLink("instagram", "@jane.example").url, "https://www.instagram.com/jane.example/");
  assert.equal(validateLink("tiktok", "@jane.example").url, "https://www.tiktok.com/@jane.example");
  assert.equal(validateLink("snapchat", "snapchat.com/add/jane.example").url, "https://www.snapchat.com/@jane.example");
  assert.equal(validateLink("linkedin", "de.linkedin.com/in/jane-example").url, "https://www.linkedin.com/in/jane-example");
  assert.equal(validateLink("linktree", "linktree.com/jane.example").url, "https://linktr.ee/jane.example");
  assert.equal(validateLink("website", "example.org").url, "https://example.org/");
  for (const c of cases.filter((x) => x.platform === "website" && x.expect.ok)) {
    const r = validateLink("website", c.input);
    assert.match(r.host, /^[\x21-\x7e]+$/, `${c.input}: the display host is ASCII`);
    assert.ok(new URL(r.url).hostname === r.host);
  }
});

test("validateLinks: a map of fields, null or blank clears, errors carry field, code and suggest (AC1)", () => {
  assert.deepEqual(validateLinks({ instagram: "@jane.example", website: "example.org", facebook: null, tiktok: "  " }), {
    ok: true,
    links: {
      instagram: { url: "https://www.instagram.com/jane.example/", handle: "jane.example" },
      website: { url: "https://example.org/", host: "example.org" },
      facebook: null,
      tiktok: null,
    },
  });
  assert.deepEqual(validateLinks({ website: "instagram.com/jane.example", snapchat: "wa.me/15550100123", myspace: "x", linkedin: 7 }), {
    ok: false,
    fields: [
      { field: "website", code: "wrong_platform", suggest: "instagram" },
      { field: "snapchat", code: "contact_channel" },
      { field: "myspace", code: "unknown_platform" },
      { field: "linkedin", code: "invalid_url" },
    ],
  });
  assert.deepEqual(validateLinks({}), { ok: true, links: {} });
  assert.deepEqual(validateLinks(JSON.parse('{"__proto__": "x"}')), { ok: false, fields: [{ field: "__proto__", code: "unknown_platform" }] });
  assert.throws(() => validateLinks(null), TypeError);
  assert.throws(() => validateLinks(["instagram"]), TypeError);
});

test("a run of 7+ digits in a handle or profile path segment is contact-like, separators . - _ ignored; 6 digits are fine (6.2)", () => {
  const joined = {
    facebook: ["facebook.com/jane5550100123", "@jane5550.100", "jane.5550100"],
    instagram: ["@jane_5550100123", "instagram.com/jane_555.0100", "jane5550100"],
    tiktok: ["@jane5550100", "tiktok.com/@jane_555_0100"],
    snapchat: ["@jane5550100", "snapchat.com/add/jane-5550100"],
    linktree: ["linktr.ee/jane5550100", "@jane_555.0100"],
    linkedin: ["linkedin.com/in/jane5550100123", "jane-555-0100", "linkedin.com/in/jane-5550-100"],
  };
  for (const [platform, inputs] of Object.entries(joined)) {
    for (const input of inputs) assert.deepEqual(validateLink(platform, input), { ok: false, code: "contact_info" }, `${platform} ${input}`);
  }
  const fine = { facebook: "jane.123456", instagram: "@jane_12.34.56", tiktok: "@jane.1985", snapchat: "@jane123456",
    linktree: "@jane_123456", linkedin: "jane-example-123456" };
  for (const [platform, input] of Object.entries(fine)) assert.equal(validateLink(platform, input).ok, true, `${platform} ${input}`);
  // the numeric profile ids facebook defines are ids, not handles
  assert.equal(validateLink("facebook", "facebook.com/profile.php?id=100012345678901").ok, true);
  assert.equal(validateLink("facebook", "facebook.com/people/Jane-Example/100012345678901/").ok, true);
});

test("a legacy linkedin.com/pub/ address is refused with a pointer to the member's /in/ address (ruling P2-R17)", () => {
  assert.match(LINKEDIN_PUB_MESSAGE, /linkedin\.com\/in\//);
  for (const input of ["linkedin.com/pub/jane-doe/555/010/123", "https://uk.linkedin.com/pub/jane-example/1a/2b3/4c5/", "linkedin.com/pub"]) {
    assert.deepEqual(validateLink("linkedin", input), { ok: false, code: "not_a_profile", message: LINKEDIN_PUB_MESSAGE }, input);
  }
  assert.deepEqual(validateLinks({ linkedin: "linkedin.com/pub/jane-doe/555/010/123", instagram: "@jane.example" }), {
    ok: false, fields: [{ field: "linkedin", code: "not_a_profile", message: LINKEDIN_PUB_MESSAGE }],
  });
});

test("validateLink input handling", () => {
  assert.throws(() => validateLink("myspace", "x"), TypeError);
  assert.deepEqual(validateLink("instagram", undefined), { ok: false, code: "invalid_url" });
  assert.deepEqual(validateLink("instagram", 5), { ok: false, code: "invalid_url" });
  assert.deepEqual(validateLink("website", "a".repeat(301)), { ok: false, code: "too_long" });
  // a result never echoes the input back except as the canonical url and handle it validated
  const bad = validateLink("instagram", "555-010-0123");
  assert.deepEqual(Object.keys(bad).sort(), ["code", "ok"]);
});
