// The family tab ("your family"): which page is the member's own, what the nav matches its routes against, that the route is not a gated
// data prefix, and that the 2025 dev scaffold (/private/ as a sample "Person Directory") is gone from every page.
// HFY_SITE=<dir> checks a scratch copy built with `node build.mjs --site <dir>` instead of ../11ty.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { navPathname, onOwnPage, ownRoute } from "../src/lib/family-route.js";

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

// The NAV registry of shell.jsx, with the kit's matching rules (KitShell isActive; the top bar's isCurrent), without importing the island.
const NAV = [...shellSrc.slice(shellSrc.indexOf("export const NAV"), shellSrc.indexOf("];", shellSrc.indexOf("export const NAV"))).matchAll(/\{ id: "(\w+)", label: "(\w+)", route: "([^"]+)"/g)].map((m) => ({ id: m[1], label: m[2], route: m[3] }));
const kitActive = (pathname, route) => (route === "/" ? pathname === "/" : pathname === route || pathname.startsWith(`${route}/`));
const barActive = (pathname, route) => (route === "/" ? pathname === "/" : pathname === route || pathname.startsWith(route));
const marked = (location, sub) => {
  const routes = NAV.map((i) => (i.id === "family" && sub ? { ...i, route: ownRoute(sub) } : i));
  const p = navPathname(location, sub);
  return { kit: routes.filter((i) => kitActive(p, i.route)).map((i) => i.id), bar: routes.filter((i) => barActive(p, i.route)).map((i) => i.id) };
};

test("the registry keeps its shape: five lowercase destinations, family at /private/ (never the gated /family/ prefix)", () => {
  assert.deepEqual(NAV.map((i) => i.id), ["home", "family", "search", "posts", "me"]);
  assert.deepEqual(NAV.map((i) => i.label), ["home", "family", "search", "posts", "me"]);
  assert.equal(NAV.find((i) => i.id === "family").route, "/private/");
  for (const i of NAV) assert.doesNotMatch(i.route, /^\/(family|person|media|event|note|place)(\/|$)/, `${i.id}: ${i.route} is a gated data prefix or a data page`);
});

test("aria-current: the family tab on the own page only", () => {
  assert.deepEqual(marked(loc("/person/", "?id=I0042"), "I0042"), { kit: ["family"], bar: ["family"] });
  assert.deepEqual(marked(loc("/person/", "?id=I0099"), "I0042"), { kit: [], bar: [] }, "another person's page marks no tab");
  assert.deepEqual(marked(loc("/person/", "?id=I0042"), null), { kit: [], bar: [] }, "signed out");
  assert.deepEqual(marked(loc("/search/"), "I0042"), { kit: ["search"], bar: ["search"] });
  assert.deepEqual(marked(loc("/"), "I0042"), { kit: ["home"], bar: ["home"] });
  assert.deepEqual(marked(loc("/private/"), null), { kit: ["family"], bar: ["family"] }, "the redirect page is the family route");
});

// ------------------------------------------------------------------------------------------------- the scaffold is gone
const htmlFiles = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
  const p = join(dir, d.name);
  return d.isDirectory() ? htmlFiles(p) : d.name.endsWith(".html") ? [p] : [];
});
const rel = (p) => relative(site, p).split(sep).join("/");

test("no page of the site says 'local development' or carries the sample person / the person directory", () => {
  const pages = htmlFiles(site);
  assert.ok(pages.length >= 13, "found the site's pages");
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
  assert.match(html, /<title>your family · Harrison Family<\/title>/);
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
