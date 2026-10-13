// HFY design-system pass: DS Voice copy on the committed Eleventy pages (islands/copy.mjs, applied by islands/build.mjs). Fails when an
// Eleventy refresh brings back the old copy (Title Case hero, "Family Login", "© … All rights reserved.", "… Harrison Family Heritage"
// titles): run `cd islands && npm run build` and commit, and port the copy to the workspace templates (11ty/README.md).
// HFY_SITE=<dir> checks a scratch copy built with `node build.mjs --site <dir>` instead of ../11ty.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { COPY_EXTRA, COPY_PAGES, DESCRIPTION, FOOTER, FOOTER_LINKS, FOOTER_NAV, HERO, HERO_IMAGES, OLD_DESCRIPTION, RETIRED, SIGNED_OUT, TITLES, applyCopy } from "../copy.mjs";
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

test("every page with the footer line carries the quiet footer links, once, and the rewrite is idempotent", () => {
  for (const page of [...COPY_PAGES, ...COPY_EXTRA]) {
    const html = read(page);
    assert.equal(html.split(FOOTER_NAV).length - 1, 1, `${page}: the footer links once`);
    assert.equal(html.match(/class="site-footer__links"/g).length, 1, `${page}: one links nav`);
    assert.ok(html.indexOf(FOOTER_NAV) > html.indexOf(FOOTER), `${page}: after the footer line`);
    assert.equal(applyCopy(html, page), html, `${page}: applyCopy is a no-op on the built page`);
  }
  assert.deepEqual(FOOTER_LINKS.map(([label]) => label), ["about", "contact", "privacy", "terms"]);
  for (const [label, href] of FOOTER_LINKS) assert.equal(label, label.toLowerCase(), href);
});

test("the footer links go in after the footer line of an old page, keeping its indentation (and only once)", () => {
  const old = '<div class="x">\n      <p class="site-footer__text text-center mb-0">&copy; 2025 Harrison Family Heritage. All rights reserved.</p>\n    </div>';
  const once = applyCopy(old, "search/index.html");
  assert.equal(once, `<div class="x">\n      <p class="site-footer__text text-center mb-0">${FOOTER}</p>\n      ${FOOTER_NAV}\n    </div>`);
  assert.equal(applyCopy(once, "search/index.html"), once);
});

test("the Eleventy default description, the [D0T] typo, the 222 years typo and the person page's static strings are put right", () => {
  const withOld = `<meta name="description" content="${OLD_DESCRIPTION}" />`;
  assert.equal(applyCopy(withOld, "search/index.html"), `<meta name="description" content="${DESCRIPTION}" />`);
  assert.match(DESCRIPTION, /^the Harrison family archive\. family members sign in/);
  assert.equal(applyCopy("email info [@] harrisonfamily [D0T] us.", "contact/index.html"), "email info [@] harrisonfamily [DOT] us.");
  assert.equal(applyCopy("Over the next two hundred twenty (222) years, they", "about/index.html"), "Over the next two hundred twenty-two years, they");
  assert.equal(applyCopy("<p>Loading person record…</p><p>Loading high-resolution media…</p> Download original", "person/index.html"), "<p>loading…</p><p>loading the full-size photo…</p> download original");
  // only /privacy/ and /terms/ wording the email typo: nothing else of their prose is in the rewrite set
  assert.deepEqual(HERO["privacy/index.html"], [["harrisonfamily [D0T] us", "harrisonfamily [DOT] us"]]);
  assert.deepEqual(HERO["terms/index.html"], [["harrisonfamily [D0T] us", "harrisonfamily [DOT] us"]]);
});

test("HFY-TSK-223: /private/ (the 'me' own-page redirect under navMe) is titled 'your page'; the old and the pre-flip titles rewrite once", () => {
  const html = read("private/index.html");
  assert.equal(TITLES["private/index.html"].title, "your page · Harrison Family");
  assert.match(html, /<title>your page · Harrison Family<\/title>/);
  assert.match(html, /<meta property="og:title" content="your page" \/>/);
  assert.match(html, /<meta name="twitter:title" content="your page" \/>/);
  assert.doesNotMatch(html.slice(0, html.indexOf("</head>")), /your family/i, "no old title left in the head");
  for (const [title, og] of [["Your Family · Harrison Family Heritage", "Your Family"], ["your family · Harrison Family", "your family"]]) {
    const old = `<title>${title}</title><meta property="og:title" content="${og}" /><meta name="twitter:title" content="${og}" />`;
    const once = applyCopy(old, "private/index.html");
    assert.equal(once, '<title>your page · Harrison Family</title><meta property="og:title" content="your page" /><meta name="twitter:title" content="your page" />');
    assert.equal(applyCopy(once, "private/index.html"), once);
  }
});

test("/logged-out/ is in the family voice and signs in again at the edge", () => {
  const html = read("logged-out/index.html");
  const main = html.slice(html.indexOf("<main"), html.indexOf("</main>"));
  assert.match(main, new RegExp(`<h1 class="mb-3">${SIGNED_OUT.heading.replace(/[.']/g, "\\$&")}</h1>`));
  assert.match(main, /<a class="btn btn-primary" href="\/auth\/login">sign in again<\/a>/);
  assert.match(main, /<a class="btn btn-outline-light" href="\/">home<\/a>/);
  assert.equal(main.replace(/<[^>]+>/g, " ").trim(), main.replace(/<[^>]+>/g, " ").trim().toLowerCase(), "all lowercase");
});

test("the /family-login/ copy that shows before the redirect to the edge sign-in is in the voice", () => {
  const html = read("family-login/index.html");
  assert.match(html, /sign in with your Google account to see the family pages\./);
  assert.match(html, /not on the list yet\? text J\./);
  assert.doesNotMatch(html, /approved Google account|site administrator|authentication status/);
});
