// surf-links-validator: shared/profile-links.mjs against shared/profile-links.cases.json (surfaces.md 6.2), plus validateLinks.
// Runs under `node --test shared/` (shared.test.mjs imports it); api/test/profile-links.test.js runs the same table from src/shared/.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ERROR_CODES, PLATFORM_DOMAINS, PLATFORMS, SHORTENERS, validateLink, validateLinks } from "./profile-links.mjs";
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

test("validateLink input handling", () => {
  assert.throws(() => validateLink("myspace", "x"), TypeError);
  assert.deepEqual(validateLink("instagram", undefined), { ok: false, code: "invalid_url" });
  assert.deepEqual(validateLink("instagram", 5), { ok: false, code: "invalid_url" });
  assert.deepEqual(validateLink("website", "a".repeat(301)), { ok: false, code: "too_long" });
  // a result never echoes the input back except as the canonical url and handle it validated
  const bad = validateLink("instagram", "555-010-0123");
  assert.deepEqual(Object.keys(bad).sort(), ["code", "ok"]);
});
