// HFY-TSK-323, rulings P2-R46 (a listed name is a link to the person's page, never underlined) and P2-R47 (a photo's text is its
// visible caption). The one rule (lib/person-name.js), its DOM twin, the React <PersonName> (lib/person-name.jsx) and what the posts
// islands hand the kit cards (lib/posts-ui.jsx CARD_PROPS: authorHref and the photo alts), rendered through the real
// @io-kit/content 0.3.2 PostCard and ArticleView. Synthetic principals only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { hfyNoDocumentEditor } from "../kit-content.mjs";
import { MENTION_SOURCE, PERSON_NAME_CLASS, authorHref, isPersonId, personHref, personNameNode, personPath } from "../src/lib/person-name.js";
import { personHref as tagHref } from "../src/lib/photo-tags.js";
import { ownRoute } from "../src/lib/family-route.js";

const islands = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * A module under src/ bundled the way the build bundles it (JSX, the Cloudscape barrel stubbed, CSS dropped), with every bare import
 * but @io-kit/content left external at its resolved URL, so React is this test's own instance and renderToStaticMarkup works.
 */
async function importIsland(contents) {
  const externals = {
    name: "hfy-test-externals",
    setup(b) {
      b.onResolve({ filter: /^[^./]/ }, (args) => (args.path.startsWith("@io-kit/content") || args.namespace !== "file" ? undefined : { path: import.meta.resolve(args.path), external: true }));
    }
  };
  const out = await build({
    stdin: { contents, resolveDir: join(islands, "src", "lib"), loader: "jsx" },
    bundle: true,
    format: "esm",
    platform: "node",
    jsx: "automatic",
    loader: { ".css": "empty" },
    plugins: [hfyNoDocumentEditor, externals],
    write: false,
    logLevel: "silent"
  });
  return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].contents).toString("base64")}`);
}

test("isPersonId: I and digits only; anything else is not a person page", () => {
  for (const id of ["I0001", "I9003", "I4", "I0044000"]) assert.equal(isPersonId(id), true, id);
  for (const id of ["", "I", "i0001", "I0001x", " I0001", "I0001 ", "O9001", "F0001", "family member", "I-1", null, undefined, 1, {}, ["I0001"]]) {
    assert.equal(isPersonId(id), false, String(id));
  }
});

test("personHref, personPath and authorHref: /person/?id=<id> for a Gramps person id, null (plain text) otherwise", () => {
  assert.equal(personHref("I9003"), "/person/?id=I9003");
  assert.equal(personHref("family member"), null);
  assert.equal(personHref(undefined), null);
  assert.equal(personPath("I9003"), "/person/?id=I9003");
  assert.equal(personPath("a b&c"), "/person/?id=a%20b%26c", "personPath encodes; it does not check");
  assert.equal(authorHref({ id: "I9003", label: "Ann Other" }), "/person/?id=I9003");
  assert.equal(authorHref({ id: "anon", label: "a family member" }), null);
  assert.equal(authorHref({ label: "no id" }), null);
  assert.equal(authorHref(null), null);
  assert.equal(authorHref(undefined), null);
});

test("every surface takes its person link from the one rule: photo tags, the own-page route, mentions", () => {
  assert.equal(tagHref({ grampsId: "I9002" }), personHref("I9002"));
  assert.equal(tagHref({ grampsId: "O9001" }), null, "a tag that names no person id has no link");
  assert.equal(tagHref({ grampsId: null }), null);
  assert.equal(ownRoute("I9001"), personPath("I9001"));
  const mention = new RegExp(`\\b${MENTION_SOURCE}\\b`, "g");
  assert.deepEqual("ask @I0044 or I9001, not I2 or XI0001".match(mention), ["I0044", "I9001"]);
  for (const m of "ask @I0044 or I9001".match(mention)) assert.equal(isPersonId(m), true, "every mention is a person id");
});

// A document with just enough of the DOM for personNameNode: createElement, className, setAttribute and textContent.
const fakeDoc = {
  createElement(tag) {
    return {
      tagName: tag.toUpperCase(),
      className: "",
      attrs: {},
      textContent: "",
      setAttribute(k, v) { this.attrs[k] = String(v); },
      getAttribute(k) { return this.attrs[k] ?? null; }
    };
  }
};

test("personNameNode: an <a class=hfy-person-name> for a person id, a <span> otherwise; the name is always text", () => {
  const a = personNameNode(fakeDoc, { id: "I9002", name: "Sam Example" });
  assert.equal(a.tagName, "A");
  assert.equal(a.className, PERSON_NAME_CLASS);
  assert.equal(a.getAttribute("href"), "/person/?id=I9002");
  assert.equal(a.textContent, "Sam Example");
  const s = personNameNode(fakeDoc, { id: null, name: "Someone Example", className: "extra" });
  assert.equal(s.tagName, "SPAN");
  assert.equal(s.className, `${PERSON_NAME_CLASS} extra`);
  assert.equal(s.getAttribute("href"), null);
  const evil = '<img src=x onerror="window.__pwned=1">';
  assert.equal(personNameNode(fakeDoc, { id: "I9002", name: evil }).textContent, evil, "markup in a name stays a string");
  assert.equal(personNameNode(fakeDoc, { id: "I9002" }).textContent, "");
});

test("<PersonName>: the same rule in React", async () => {
  const { PersonName } = await importIsland('export { PersonName } from "./person-name.jsx";');
  assert.equal(renderToStaticMarkup(createElement(PersonName, { id: "I9002", name: "Sam Example" })), '<a class="hfy-person-name" href="/person/?id=I9002">Sam Example</a>');
  assert.equal(renderToStaticMarkup(createElement(PersonName, { id: "anon", name: "a family member" })), '<span class="hfy-person-name">a family member</span>');
  assert.equal(renderToStaticMarkup(createElement(PersonName, { id: "I9002", className: "x" }, "Sam")), '<a class="hfy-person-name x" href="/person/?id=I9002">Sam</a>');
  assert.equal(renderToStaticMarkup(createElement(PersonName, { id: "I9002", name: "<b>x</b>" })), '<a class="hfy-person-name" href="/person/?id=I9002">&lt;b&gt;x&lt;/b&gt;</a>');
});

// posts-ui as the islands bundle it, and the kit cards from the same bundle (one copy of @io-kit/content).
const POSTS_UI = 'export { CARD_PROPS, photoAlt } from "./posts-ui.jsx"; export { PostCard, ArticleView } from "@io-kit/content/react";';

const post = (over = {}) => ({
  id: "01JZZZZZZZZZZZZZZZZZZZZ001", type: "post", author: { id: "I9003", label: "Ann Other" }, subject: "I9003", body: "a line",
  attachments: [], visibility: "published", created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
  can: { edit: false, delete: false, publish: false, moderate: false }, ...over
});
const img = (n, alt) => ({ kind: "image", url: `/media/posts/01JZZZZZZZZZZZZZZZZZZZZ90${n}/photo.png`, mime: "image/png", ...(alt === undefined ? {} : { alt }) });

test("CARD_PROPS on the kit PostCard and ArticleView: the author's name is a person link; no person id, plain text", async () => {
  const { CARD_PROPS, PostCard, ArticleView } = await importIsland(POSTS_UI);
  const card = renderToStaticMarkup(createElement(PostCard, { post: post(), ...CARD_PROPS }));
  assert.match(card, /<a class="iok-content-author" href="\/person\/\?id=I9003">Ann Other<\/a>/);
  const article = renderToStaticMarkup(createElement(ArticleView, { post: post({ type: "article", title: "a title" }), ...CARD_PROPS }));
  assert.match(article, /<a class="iok-content-author" href="\/person\/\?id=I9003">Ann Other<\/a>/);
  const plain = renderToStaticMarkup(createElement(PostCard, { post: post({ author: { id: "anon", label: "a family member" } }), ...CARD_PROPS }));
  assert.doesNotMatch(plain, /iok-content-author|<a /);
  assert.match(plain, /a family member/);
});

test("CARD_PROPS photos (P2-R47): the typed text is the visible <figcaption>; the img alt is the who-posted fallback, never the caption", async () => {
  const { CARD_PROPS, PostCard, photoAlt } = await importIsland(POSTS_UI);
  const p = post({ body: "", attachments: [img(1, "the lake at dusk"), img(2), img(3, "  ")] });
  const html = renderToStaticMarkup(createElement(PostCard, { post: p, ...CARD_PROPS }));
  const figures = html.match(/<figure class="iok-content-figure">.*?<\/figure>/g);
  assert.equal(figures.length, 3);
  assert.match(figures[0], /alt="photo 1 of 3 from Ann Other"/);
  assert.match(figures[0], /<figcaption class="iok-content-caption">the lake at dusk<\/figcaption>/);
  assert.doesNotMatch(figures[0], /alt="the lake at dusk"/, "the caption is not repeated as the alt");
  assert.match(figures[1], /alt="photo 2 of 3 from Ann Other"/);
  assert.doesNotMatch(figures[1], /figcaption/);
  assert.match(figures[2], /alt="photo 3 of 3 from Ann Other"/);
  assert.doesNotMatch(figures[2], /figcaption/, "a blank caption draws no figcaption");
  // photos are counted among the images only, at the kit's attachment index; no author label, no "from"
  const mixed = { attachments: [{ kind: "file", url: "/x.pdf" }, img(1), img(2)], author: { id: "I9003", label: "" } };
  assert.deepEqual([1, 2].map((i) => photoAlt(mixed.attachments[i], i, mixed)), ["photo 1 of 2", "photo 2 of 2"]);
  assert.equal(photoAlt(img(1), 0, { attachments: [img(1)], author: { label: "Ann Other" } }), "a photo from Ann Other");
});
