// The own-page tab ("family" without navMe, "me" with it): which page is the member's own, what the nav matches its routes against, the
// nav's shape for every flag combination (lib/nav.js navItems, HFY-TSK-091), that no route is a gated data prefix, and that the 2025 dev
// scaffold (/private/ as a sample "Person Directory") is gone from every page.
// HFY_SITE=<dir> checks a scratch copy built with `node build.mjs --site <dir>` instead of ../11ty.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { navPathname, onOwnPage, ownRoute } from "../src/lib/family-route.js";
import { navItems, onSettings } from "../src/lib/nav.js";

const islandsDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const site = process.env.HFY_SITE ? resolve(process.env.HFY_SITE) : join(islandsDir, "..", "11ty");
const shellSrc = readFileSync(join(islandsDir, "src", "islands", "shell.jsx"), "utf8");
const loc = (pathname, search = "") => ({ pathname, search });

test("ownRoute is /person/?id=<sub>, encoded", () => {
  assert.equal(ownRoute("I0042"), "/person/?id=I0042");
  assert.equal(ownRoute("a b&c=d"), "/person/?id=a%20b%26c%3Dd");
});

test("onOwnPage: the member's own /person/ page only, the id compared exactly", () => {
  assert.equal(onOwnPage(loc("/person/", "?id=I0042"), "I0042"), true);
  assert.equal(onOwnPage(loc("/person", "?id=I0042"), "I0042"), true);
  assert.equal(onOwnPage(loc("/person/index.html", "?id=I0042"), "I0042"), true);
  assert.equal(onOwnPage(loc("/person/", "?x=1&id=I0042&y=2"), "I0042"), true);
  assert.equal(onOwnPage(loc("/person/", "?id=I0099"), "I0042"), false, "another person");
  assert.equal(onOwnPage(loc("/person/", "?id=I00420"), "I0042"), false, "a longer id");
  assert.equal(onOwnPage(loc("/person/", "?id=i0042"), "I0042"), false, "case differs");
  assert.equal(onOwnPage(loc("/person/", ""), "I0042"), false, "no id");
  assert.equal(onOwnPage(loc("/persons/", "?id=I0042"), "I0042"), false);
  assert.equal(onOwnPage(loc("/search/", "?id=I0042"), "I0042"), false);
});

test("navPathname: the own page matches the family route itself; every other page keeps its real path", () => {
  assert.equal(navPathname(loc("/person/", "?id=I0042"), "I0042"), "/person/?id=I0042");
  assert.equal(navPathname(loc("/person/", "?id=I0099"), "I0042"), "/person/");
  assert.equal(navPathname(loc("/person/", "?id=I0042"), null), "/person/", "signed out: no own page");
  assert.equal(navPathname(loc("/search/", "?q=x"), "I0042"), "/search/");
});

// The nav of shell.jsx is navItems() (lib/nav.js), matched with the kit's rules (KitShell isActive; the top bar's isCurrent).
const kitActive = (pathname, route) => (route === "/" ? pathname === "/" : pathname === route || pathname.startsWith(`${route}/`));
const barActive = (pathname, route) => (route === "/" ? pathname === "/" : pathname === route || pathname.startsWith(route));
const marked = (location, sub, flags = {}) => {
  const routes = navItems({ ...flags, sub });
  const p = navPathname(location, sub);
  return { kit: routes.filter((i) => kitActive(p, i.route)).map((i) => i.id), bar: routes.filter((i) => barActive(p, i.route)).map((i) => i.id) };
};
const GATED = /^\/(family|person|media|event|note|place|uploads)(\/|$)/;
const SUB = "I0042";
const OWN = ownRoute(SUB);

test("shell.jsx composes its nav with navItems() and keeps no inline registry of its own", () => {
  assert.match(shellSrc, /import \{[^}]*\bnavItems\b[^}]*\} from "\.\.\/lib\/nav\.js"/);
  assert.match(shellSrc, /navItems\(\{ navMe, familyViz, notifyV2, sub \}\)/);
  assert.doesNotMatch(shellSrc, /export const NAV\b/);
});

// The four flag combinations (HFY-PLN-002 surfaces §3.1), each signed in (the session names the member) and signed out (or pending).
// `route(signedIn)` per id; notifyV2 only decides where "me" goes while it is still the settings item.
const TABLE = [
  { navMe: false, familyViz: false, ids: ["home", "family", "search", "posts", "me"], family: (inn) => (inn ? OWN : "/private/"), me: (_, notify) => (notify ? "/me/notifications/" : "/auth/link") },
  { navMe: false, familyViz: true, ids: ["home", "family", "search", "posts", "me"], family: () => "/tree/", me: (_, notify) => (notify ? "/me/notifications/" : "/auth/link") },
  { navMe: true, familyViz: false, ids: ["home", "search", "posts", "me"], family: null, me: (inn) => (inn ? OWN : "/private/") },
  { navMe: true, familyViz: true, ids: ["home", "family", "search", "posts", "me"], family: () => "/tree/", me: (inn) => (inn ? OWN : "/private/") }
];
for (const row of TABLE) {
  for (const notifyV2 of [false, true]) {
    for (const signedIn of [true, false]) {
      const name = `navItems navMe=${row.navMe} familyViz=${row.familyViz} notifyV2=${notifyV2} ${signedIn ? "signed in" : "signed out"}`;
      test(`${name}: ${row.ids.join(", ")}; no route is a gated data prefix`, () => {
        const items = navItems({ navMe: row.navMe, familyViz: row.familyViz, notifyV2, sub: signedIn ? SUB : null });
        assert.deepEqual(items.map((i) => i.id), row.ids);
        assert.deepEqual(items.map((i) => i.label), row.ids, "labels are the lowercase ids");
        assert.deepEqual(items.map((i) => i.order), row.ids.map((_, n) => n + 1), "order 1..n");
        assert.ok(items.length <= 5, "the kit's compact cap is 5 primary items");
        assert.ok(items.every((i) => i.icon === " "), "a placeholder glyph, painted by shell.css");
        const by = Object.fromEntries(items.map((i) => [i.id, i.route]));
        assert.equal(by.home, "/");
        assert.equal(by.search, "/search/");
        assert.equal(by.posts, "/posts/");
        if (row.family) assert.equal(by.family, row.family(signedIn));
        else assert.equal(by.family, undefined, "family leaves the bar while navMe is on and familyViz is off");
        assert.equal(by.me, row.me(signedIn, notifyV2));
        // Every route but the own page is a static route outside the data prefixes; the own page is the public person page shell
        // (/person/?id=<sub>, never a .json), the one /person/ URL the nav may name.
        for (const i of items) {
          if (signedIn && i.route === OWN) { assert.doesNotMatch(i.route, /\.json/i); continue; }
          assert.doesNotMatch(i.route, GATED, `${i.id}: ${i.route} is a gated data prefix or a data page`);
        }
        const own = items.filter((i) => i.route === OWN || i.route === "/private/");
        assert.ok(own.length <= 1, "at most one item opens the own page");
      });
    }
  }
}

test("navItems: the defaults are today's nav (every flag off)", () => {
  assert.deepEqual(navItems({ sub: SUB }), navItems({ navMe: false, familyViz: false, notifyV2: false, sub: SUB }));
  assert.deepEqual(navItems().map((i) => [i.id, i.route]), [["home", "/"], ["family", "/private/"], ["search", "/search/"], ["posts", "/posts/"], ["me", "/auth/link"]]);
});

test("aria-current without navMe: the family tab on the own page only", () => {
  assert.deepEqual(marked(loc("/person/", "?id=I0042"), "I0042"), { kit: ["family"], bar: ["family"] });
  assert.deepEqual(marked(loc("/person/", "?id=I0099"), "I0042"), { kit: [], bar: [] }, "another person's page marks no tab");
  assert.deepEqual(marked(loc("/person/", "?id=I0042"), null), { kit: [], bar: [] }, "signed out");
  assert.deepEqual(marked(loc("/search/"), "I0042"), { kit: ["search"], bar: ["search"] });
  assert.deepEqual(marked(loc("/"), "I0042"), { kit: ["home"], bar: ["home"] });
  assert.deepEqual(marked(loc("/private/"), null), { kit: ["family"], bar: ["family"] }, "the redirect page is the family route");
});

for (const familyViz of [false, true]) {
  test(`aria-current with navMe (familyViz=${familyViz}): "me" on the own page only`, () => {
    const flags = { navMe: true, familyViz };
    assert.deepEqual(marked(loc("/person/", "?id=I0042"), "I0042", flags), { kit: ["me"], bar: ["me"] });
    assert.deepEqual(marked(loc("/person/index.html", "?id=I0042"), "I0042", flags), { kit: ["me"], bar: ["me"] });
    assert.deepEqual(marked(loc("/person/", "?id=I0099"), "I0042", flags), { kit: [], bar: [] }, "another person's page marks no tab");
    assert.deepEqual(marked(loc("/person/", "?id=I0042"), null, flags), { kit: [], bar: [] }, "signed out");
    assert.deepEqual(marked(loc("/me/"), "I0042", flags), { kit: [], bar: [] }, "the settings hub is the gear's, not a tab's");
    assert.deepEqual(marked(loc("/me/notifications/"), "I0042", flags), { kit: [], bar: [] });
    assert.deepEqual(marked(loc("/search/"), "I0042", flags), { kit: ["search"], bar: ["search"] });
    assert.deepEqual(marked(loc("/"), "I0042", flags), { kit: ["home"], bar: ["home"] });
    assert.deepEqual(marked(loc("/private/"), null, flags), { kit: ["me"], bar: ["me"] }, "the redirect page is the me route");
    if (familyViz) assert.deepEqual(marked(loc("/tree/"), "I0042", flags), { kit: ["family"], bar: ["family"] });
  });
}

test("onSettings: the gear is current on /me/ and its sub-paths only", () => {
  for (const p of ["/me", "/me/", "/me/index.html", "/me/notifications/", "/me/links/"]) assert.equal(onSettings(p), true, p);
  for (const p of ["/", "/media/", "/meetings/", "/person/", "/posts/", "/search/me/"]) assert.equal(onSettings(p), false, p);
});

// ------------------------------------------------------------------------------------------------- the scaffold is gone
const htmlFiles = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
  const p = join(dir, d.name);
  return d.isDirectory() ? htmlFiles(p) : d.name.endsWith(".html") ? [p] : [];
});
const rel = (p) => relative(site, p).split(sep).join("/");

test("no page of the site says 'local development' or carries the sample person / the person directory", () => {
  const pages = htmlFiles(site);
  assert.ok(pages.length >= 14, "found the site's pages");
  for (const p of pages) {
    const html = readFileSync(p, "utf8");
    assert.doesNotMatch(html, /local development/i, rel(p));
    assert.doesNotMatch(html, /Sample Person/, rel(p));
    assert.doesNotMatch(html, /Person Directory|Available person profiles|View Profile/, rel(p));
  }
});

test("/private/ is the redirect page: no cards, no images, no data, a noscript sign-in link, the theme head blocks", () => {
  const html = readFileSync(join(site, "private", "index.html"), "utf8");
  const main = html.slice(html.indexOf("<main"), html.indexOf("</main>"));
  assert.doesNotMatch(main, /class="card|<img|\/media\/|I0001|href="\/person\//, "no directory markup or sample ids");
  assert.match(main, /<noscript><p class="mb-0"><a href="\/auth\/login\?returnTo=%2Fprivate%2F">sign in to see your family<\/a><\/p><\/noscript>/);
  assert.match(main, /flags\.goToFamily\(\)/);
  assert.match(html, /<!-- hfy-theme:start A -->/);
  assert.match(html, /<!-- hfy-theme:start B -->/);
  assert.match(html, /<link rel="stylesheet" href="\/css\/hfy-theme\.css\?v=[0-9a-f]{8}" \/>/);
  assert.match(html, /<title>your page · Harrison Family<\/title>/); // since the navMe flip (HFY-TSK-223): "me" opens it
});

test("the redirect rule is one function (HFYFeatureFlags.goToFamily) used by /private/ and by /person/ without an id", () => {
  const flags = readFileSync(join(site, "js", "feature-flags.js"), "utf8");
  assert.match(flags, /featureAPI\.goToFamily = /);
  assert.match(flags, /const FAMILY_ROUTE = "\/private\/"/);
  const person = readFileSync(join(site, "js", "person-page.js"), "utf8");
  assert.match(person, /featureFlags\.goToFamily\(\)/);
  // no sample-data or fixture fallback in the person page script
  assert.doesNotMatch(person, /Sample Person|I0001|sampleData|fixtures?\b/);
});

test("the person page's script has no id fallback: the id comes from the URL only", () => {
  const person = readFileSync(join(site, "js", "person-page.js"), "utf8");
  assert.equal([...person.matchAll(/params\.get\("id"\)/g)].length, 1);
  assert.doesNotMatch(person, /personId\s*=\s*[^;]*\|\|/, "no `|| default id`");
});
