// HFY design-system pass: DS Voice copy on the committed Eleventy pages (islands/copy.mjs, applied by islands/build.mjs). Fails when an
// Eleventy refresh brings back the old copy (Title Case hero, "Family Login", "© … All rights reserved.", "… Harrison Family Heritage"
// titles): run `cd islands && npm run build` and commit, and port the copy to the workspace templates (11ty/README.md).
// HFY_SITE=<dir> checks a scratch copy built with `node build.mjs --site <dir>` instead of ../11ty.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { COPY_PAGES, FOOTER, HERO, HERO_IMAGES, RETIRED, TITLES, applyCopy } from "../copy.mjs";
import { PAGES } from "../heads.mjs";

const islandsDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const site = process.env.HFY_SITE ? resolve(process.env.HFY_SITE) : join(islandsDir, "..", "11ty");
const read = (p) => readFileSync(join(site, p), "utf8");

test("every Eleventy page is in the copy set (and the head-block set)", () => {
  for (const p of COPY_PAGES) assert.ok(PAGES.includes(p), p);
  for (const p of Object.keys(TITLES)) assert.ok(COPY_PAGES.includes(p), p);
  for (const p of Object.keys(HERO)) assert.ok(COPY_PAGES.includes(p), p);
});

for (const page of COPY_PAGES) {
  test(`${page}: DS Voice copy (footer, lowercase title, no retired strings) and the rewrite is idempotent`, () => {
    const html = read(page);
    for (const re of RETIRED) assert.doesNotMatch(html, re, `${page} still carries ${re}`);
    assert.ok(html.includes(FOOTER), `${page}: the Voice footer`);
    const title = html.match(/<title>([^<]*)<\/title>/)?.[1];
    assert.equal(title, TITLES[page].title);
    assert.doesNotMatch(title, /!|[A-Z]{2,}/);
    assert.equal(applyCopy(html, page), html, `${page}: applyCopy is a no-op on the built page`);
  });
}

test("home: one closed h1 in lowercase, the CTAs say 'our story' and 'sign in'", () => {
  const html = read("index.html");
  const h1 = [...html.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/g)].map((m) => m[1]);
  assert.deepEqual(h1, ["hi family. this is where we keep our history."]);
  assert.match(html, /href="\/about\/">our story<\/a>/);
  assert.match(html, /data-feature="familyLoginLink">sign in<\/a>/);
});

test("about: the heading is lowercase except the proper noun, the family-authored story is untouched", () => {
  const html = read("about/index.html");
  assert.match(html, /<h1 [^>]*>honoring the Harrison family legacy<\/h1>/);
  assert.match(html, /Joseph and Kitty Wade Harrison seeded nine generations/);
});

test("HFY-TSK-084: the hero lede is a paragraph (no h3 under the h1), the hero photos carry their size, the fallback wordmark is not shouted", () => {
  const home = read("index.html");
  assert.match(home, /<p class="home-hero__lede">learn about our heritage and help us preserve our family history\.<\/p>/);
  assert.doesNotMatch(home, /<h3\b/);
  for (const [page, img] of Object.entries(HERO_IMAGES)) {
    const html = read(page);
    assert.ok(html.includes(`src="${img.src}" width="${img.width}" height="${img.height}"`), `${page}: width/height on the hero <img>`);
    const real = readFileSync(join(site, img.src));
    // JPEG SOF0/SOF2 marker: the attributes are the file's own dimensions, not a guess
    let i = 2;
    while (i < real.length && !(real[i] === 0xff && (real[i + 1] === 0xc0 || real[i + 1] === 0xc2))) i += 2 + real.readUInt16BE(i + 2);
    assert.deepEqual([real.readUInt16BE(i + 7), real.readUInt16BE(i + 5)], [img.width, img.height], `${page}: ${img.src} is ${img.width}x${img.height}`);
  }
  for (const page of COPY_PAGES) assert.doesNotMatch(read(page), />HARRISON FAMILY</, `${page}: the navbar wordmark`);
  assert.match(home, /class="navbar-brand" href="\/">Harrison Family<\/a>/);
});

test("applyCopy only rewrites the old copy", () => {
  const old = "<title>Search · Harrison Family Heritage</title><p>&copy; 2025 Harrison Family Heritage. All rights reserved.</p>";
  const once = applyCopy(old, "search/index.html");
  assert.equal(once, `<title>search · Harrison Family</title><p>${FOOTER}</p>`);
  assert.equal(applyCopy(once, "search/index.html"), once);
  const prose = "<p>Welcome to the family reunion. All are welcome.</p>";
  assert.equal(applyCopy(prose, "about/index.html"), prose);
  // the h3 lede (original and already-lowercased), the unsized hero img and the shouted wordmark each rewrite once and stay put
  const hero = '<a class="navbar-brand" href="/">HARRISON FAMILY</a><h3>Learn about our heritage and help us preserve our family history.</h3><img\n  src="/images/00_mama_harrison.jpg"\n class="x">';
  const heroOnce = applyCopy(hero, "index.html");
  assert.match(heroOnce, /Harrison Family<\/a><p class="home-hero__lede">learn about/);
  assert.match(heroOnce, /<img\n  src="\/images\/00_mama_harrison\.jpg" width="3038" height="3931"\n class="x">/);
  assert.equal(applyCopy(heroOnce, "index.html"), heroOnce);
  assert.match(applyCopy("<h3>learn about our heritage and help us preserve our family history.</h3>", "index.html"), /^<p class="home-hero__lede">/);
});
