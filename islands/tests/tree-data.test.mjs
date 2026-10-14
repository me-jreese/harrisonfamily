// HFY-TSK-201: lib/tree-data.js (the /tree/ data seam) and lib/tree-link.js (the person page's link), in node on the synthetic graph.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseGraph } from "../src/lib/family-graph.js";
import { GRAPH_URL, announce, focusParam, focusUrl, loadGraph, resolveFocus, signInHref, yearsLabel } from "../src/lib/tree-data.js";
import { TREE_LINK_TEXT, fillTreeLink, treeLinkHref } from "../src/lib/tree-link.js";

const RAW = readFileSync(new URL("./fixtures/tree-graph-small.json", import.meta.url), "utf8");
const g = parseGraph(RAW);
const respond = (status, body = "") => async () => new Response(body, { status });

test("loadGraph: 200 with a valid body is ready, and the request is the gated same-origin graph", async () => {
  let seen;
  const r = await loadGraph(async (url, init) => { seen = { url, init }; return new Response(RAW, { status: 200 }); });
  assert.equal(r.state, "ready");
  assert.equal(r.graph.size, 11);
  assert.equal(seen.url, GRAPH_URL);
  assert.equal(seen.init.credentials, "same-origin");
});

test("loadGraph: 401 is sign in; 403 and 404 are 'being prepared'", async () => {
  assert.deepEqual(await loadGraph(respond(401, "{}")), { state: "signin" });
  assert.deepEqual(await loadGraph(respond(403)), { state: "prepared" });
  assert.deepEqual(await loadGraph(respond(404)), { state: "prepared" });
});

test("loadGraph: a bad body, a bad version, another status and a network failure are the retry state, with a code", async () => {
  assert.deepEqual(await loadGraph(respond(200, "<html>")), { state: "error", code: "GRAPH_PARSE" });
  assert.deepEqual(await loadGraph(respond(200, JSON.stringify({ schemaVersion: 2, people: [], unions: [] }))), { state: "error", code: "GRAPH_SCHEMA_UNSUPPORTED" });
  assert.deepEqual(await loadGraph(respond(500)), { state: "error", code: "GRAPH_HTTP" });
  assert.deepEqual(await loadGraph(async () => { throw new TypeError("offline"); }), { state: "error", code: "GRAPH_NETWORK" });
});

test("resolveFocus: ?focus, else the viewer, else the default person; a bad ?focus is flagged", () => {
  assert.deepEqual(resolveFocus(g, { focus: "I9007", sub: "I9003" }), { id: "I9007", fellBack: false });
  assert.deepEqual(resolveFocus(g, { sub: "I9003" }), { id: "I9003", fellBack: false });
  assert.deepEqual(resolveFocus(g, { focus: "nope", sub: "I9003" }), { id: "I9003", fellBack: true });
  assert.deepEqual(resolveFocus(g, { focus: "nope", sub: "ghost" }), { id: "I9001", fellBack: true });
  assert.deepEqual(resolveFocus(g, { sub: "ghost" }), { id: "I9001", fellBack: false }, "a viewer outside the graph asked for nothing");
  assert.deepEqual(resolveFocus(g, {}), { id: "I9001", fellBack: false });
});

test("URL helpers: focusParam, focusUrl keeps other parameters, signInHref returns to this page", () => {
  assert.equal(focusParam("?focus=I9001&view=outline"), "I9001");
  assert.equal(focusParam(""), null);
  assert.equal(focusUrl({ pathname: "/tree/", search: "?view=chart" }, "I9002"), "/tree/?view=chart&focus=I9002");
  assert.equal(focusUrl({ pathname: "/tree/", search: "" }, "I9002"), "/tree/?focus=I9002");
  assert.equal(signInHref({ pathname: "/tree/", search: "?focus=I9007" }), "/auth/login?returnTo=%2Ftree%2F%3Ffocus%3DI9007");
});

test("yearsLabel and announce are in words", () => {
  assert.equal(yearsLabel(g.person("I9001")), "1900 to 1970");
  assert.equal(yearsLabel(g.person("I9004")), "about 1928 to unknown");
  assert.equal(yearsLabel(g.person("I9007")), "born 1950");
  assert.equal(yearsLabel(g.person("I9011")), "years unknown");
  assert.equal(announce(g, "I9003"), "centred on Ada Example: 2 parents, 1 partner, 3 children");
  assert.equal(announce(g, "I9011"), "centred on Zed Lone: 0 parents, 0 partners, 0 children");
  assert.equal(announce(g, "nope"), "");
});

// A just-enough document for fillTreeLink: one host element, createElement for the anchor.
function fakeDoc(withHost = true) {
  const mk = (tag) => {
    const el = { tag, attrs: {}, kids: [], textContent: "", setAttribute(k, v) { el.attrs[k] = v; }, getAttribute: (k) => el.attrs[k], appendChild(c) { c.parent = el; el.kids.push(c); },
      querySelector: (sel) => (sel === "a[data-tree-link]" ? el.kids.find((k) => k.tag === "a" && "data-tree-link" in k.attrs) || null : null),
      remove() { el.parent.kids.splice(el.parent.kids.indexOf(el), 1); } };
    return el;
  };
  const host = mk("div");
  return { host, createElement: mk, querySelector: (sel) => (sel === '[data-slot="tree-link"]' && withHost ? host : null) };
}

test("treeLinkHref only builds a link for a plausible gramps id", () => {
  assert.equal(treeLinkHref("I9001"), "/tree/?focus=I9001");
  assert.equal(treeLinkHref("a b"), null);
  assert.equal(treeLinkHref("../x"), null);
  assert.equal(treeLinkHref(null), null);
});

test("fillTreeLink: on adds one link (idempotent), off removes it, no host is a no-op", () => {
  const d = fakeDoc();
  assert.equal(fillTreeLink(d, "I9001", false), false);
  assert.equal(d.host.kids.length, 0);
  assert.equal(fillTreeLink(d, "I9001", true), true);
  assert.equal(fillTreeLink(d, "I9001", true), true);
  assert.equal(d.host.kids.length, 1);
  assert.equal(d.host.kids[0].getAttribute("href"), "/tree/?focus=I9001");
  assert.equal(d.host.kids[0].textContent, TREE_LINK_TEXT);
  assert.equal(fillTreeLink(d, "I9002", true), true);
  assert.equal(d.host.kids[0].getAttribute("href"), "/tree/?focus=I9002", "a new person updates the href");
  assert.equal(fillTreeLink(d, "I9002", false), false);
  assert.equal(d.host.kids.length, 0);
  assert.equal(fillTreeLink(fakeDoc(false), "I9001", true), false);
  assert.equal(fillTreeLink(d, "bad id", true), false);
});
