// HFY-TSK-171 (PS-11): the HFY SanitizePolicy for markdown in posts. protocols.src is [] (images only through attachments) and
// protocols.href is https and http (no mailto:); the kit's PostCard and ArticleView render the body through it, wired by
// kit-content.mjs hfyContentSanitizePolicy (they take no policy prop). Synthetic hosts and addresses only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { defaultPolicy } from "@io-kit/md";
import { importContentReact } from "../kit-content.mjs";
import { hfySanitizePolicy } from "../src/lib/sanitize-policy.js";

const { PostCard, ArticleView } = await importContentReact();

const BODY = [
  "hello family",
  "",
  "![tracker](https://tracker.example.test/pixel.png)",
  "",
  "[write me](mailto:someone@example.test) and [read more](https://example.test/read) and [plain](http://example.test/plain) and [rel](/posts/?id=1)",
  "",
  "<img src=\"https://tracker.example.test/raw.png\"> <a href=\"mailto:raw@example.test\">raw</a>"
].join("\n");

const T0 = "2026-01-01T00:00:00.000Z";
const post = (over = {}) => ({ id: "01JZZZZZZZZZZZZZZZZZZZZ001", type: "post", author: { id: "I9001", label: "Test Person" }, subject: "I9001", body: BODY, attachments: [], visibility: "published", created_at: T0, updated_at: T0, can: { edit: false, delete: false, publish: false, moderate: false }, ...over });
const card = (el) => renderToStaticMarkup(el);

test("hfySanitizePolicy: src is empty, href is https and http, and the rest is the kit default", () => {
  assert.deepEqual([...hfySanitizePolicy.protocols.src], [], "no image src from markdown");
  assert.deepEqual([...hfySanitizePolicy.protocols.href], ["https", "http"], "no mailto");
  assert.equal(hfySanitizePolicy.version, defaultPolicy.version);
  assert.equal(hfySanitizePolicy.rawHtml, "escape", "raw html is never allowed");
  assert.equal(hfySanitizePolicy.clobberPrefix, defaultPolicy.clobberPrefix);
  assert.ok(Object.isFrozen(hfySanitizePolicy) && Object.isFrozen(hfySanitizePolicy.protocols));
});

for (const [name, make] of [["PostCard (full)", (p) => createElement(PostCard, { post: p })], ["ArticleView", (p) => createElement(ArticleView, { post: p })]]) {
  test(`${name} renders a post body with no markdown image, no mailto: link and no raw html`, () => {
    const html = card(make(post({ type: name.startsWith("Article") ? "article" : "post" })));
    assert.doesNotMatch(html, /<img/, "no markdown or raw-html image element: the browser requests no external host");
    assert.doesNotMatch(html, /src="https?:/, "nothing carries an external src");
    assert.doesNotMatch(html, /href="mailto:/i, "no mailto: link");
    assert.match(html, /&lt;img src=/, "raw html is escaped to inert text, not parsed");
    assert.match(html, /href="https:\/\/example\.test\/read"/, "an https link survives");
    assert.match(html, /href="http:\/\/example\.test\/plain"/, "an http link survives");
    assert.match(html, /href="\/posts\/\?id=1"/, "a relative link survives");
    assert.match(html, /hello family/);
    assert.match(html, /<span data-hfy-md-image-omitted="">tracker<\/span>/, "the image's alt text stays as plain text");
  });
}

test("the kit trap: with protocols.src = [] alone the kit still emits the external image; the wrapper's img mapping is what stops it", async () => {
  const { KitMarkdown } = await import("@io-kit/md/react");
  const html = card(createElement(KitMarkdown, { source: BODY, policy: hfySanitizePolicy }));
  assert.match(html, /<img src="https:\/\/tracker\.example\.test\/pixel\.png"/, "if this fails the kit treats [] as none: the img mapping in lib/hfy-markdown.jsx can become a second line of defence");
  assert.doesNotMatch(html, /href="mailto:/, "href is enforced by the policy itself");
});

test("the policy reaches the card: without the build alias the kit default would let the markdown image and mailto: through", async () => {
  const { KitMarkdown } = await import("@io-kit/md/react");
  const html = card(createElement(KitMarkdown, { source: BODY }));
  assert.match(html, /src="https:\/\/tracker\.example\.test\/pixel\.png"/, "the control: the kit default renders the external image");
  assert.match(html, /mailto:/);
});

test("a photo still reaches a post as an attachment (the kit draws it), whatever the markdown says", () => {
  const html = card(createElement(PostCard, { post: post({ body: "caption", attachments: [{ kind: "image", url: "/uploads/posts/01J00000000000000000000000/photo.jpg", mime: "image/jpeg" }] }) }));
  assert.match(html, /<img[^>]+src="\/uploads\/posts\/01J00000000000000000000000\/photo\.jpg"/);
});

test("the build wires the policy: build.mjs lists hfyContentSanitizePolicy and the wrapper imports the real KitMarkdown", () => {
  assert.match(readFileSync(new URL("../build.mjs", import.meta.url), "utf8"), /plugins: \[hfyCloudscape, hfyNoDocumentEditor, hfyContentSanitizePolicy\]/);
  const wrapper = readFileSync(new URL("../src/lib/hfy-markdown.jsx", import.meta.url), "utf8");
  assert.match(wrapper, /import \{ KitMarkdown as KitMarkdownBase \} from "@io-kit\/md\/react"/);
  assert.match(wrapper, /hfySanitizePolicy/);
});

// The committed bundles (HFY-R58) carry the wrapper: every posts island loads PostCard/ArticleView, whose markdown must be the HFY one.
const site = process.env.HFY_SITE ? resolve(process.env.HFY_SITE) : join(dirname(fileURLToPath(import.meta.url)), "..", "..", "11ty");
const siteOut = join(site, "js", "islands");
function reachable(entry) {
  const seen = new Set();
  const visit = (abs) => {
    if (seen.has(abs)) return;
    seen.add(abs);
    for (const m of readFileSync(abs, "utf8").matchAll(/(?:from|import)\s*\(?\s*"(\.{1,2}\/[^"]+\.js)"/g)) visit(resolve(dirname(abs), m[1]));
  };
  visit(join(siteOut, entry));
  return [...seen];
}

test("the posts islands' built bundles carry the HFY sanitize policy (no external image, no mailto) in the kit's markdown", () => {
  for (const name of ["my-posts", "posts", "timeline"]) {
    const code = reachable(`${name}.js`).map((f) => readFileSync(f, "utf8")).join("\n");
    assert.match(code, /data-hfy-md-image-omitted/, `${name}.js: the img mapping is not in the bundle`);
    assert.match(code, /noopener noreferrer nofollow ugc/, `${name}.js: the HFY policy is not in the bundle`);
  }
});
