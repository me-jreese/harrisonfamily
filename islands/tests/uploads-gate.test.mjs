// HFY members-only /uploads/*: CloudFront gates GETs of member photos with the io_id session (hfy-edge-gate viewer-request,
// scripts/infra/add-data-gate-behaviors.sh) and answers them "Cache-Control: private, no-store". What the browser side must keep true:
//  - photos are only ever loaded as same-origin <img src> (the browser sends the io_id cookie; a script fetch would need
//    credentials: "same-origin"/"include"), never fetched or XHR'd by the islands;
//  - the presigned PUT goes straight to S3 (a different origin, not through CloudFront), so the gate never sees an upload.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FIXTURE_POSTS } from "@io-kit/content/testing";
import { importContentReact } from "../kit-content.mjs";
import { uploadPhoto } from "../src/lib/upload.js";
import { createApi } from "../src/lib/api.js";
import { makeApi, signToken } from "../../api/test/world.js";

// Since @io-kit/content 0.2.0, Node cannot import "@io-kit/content/react" directly (DocumentEditor's Cloudscape import, see
// kit-content.mjs); it is bundled the way the islands build bundles it.
const { PostCard } = await importContentReact();

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const walk = (d) => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));

const UPLOAD_URL = "https://harrisonfamily-frontend.s3.us-west-2.amazonaws.com/uploads/posts/01J00000000000000000000000/garden.jpg?X-Amz-Signature=abc";
const PUBLIC_URL = "https://harrisonfamily.us/uploads/posts/01J00000000000000000000000/garden.jpg";

test("uploadPhoto PUTs to the presigned S3 URL (cross-origin, no cookies, not via the gated /uploads/*) and hands back the same-origin public URL", async () => {
  const puts = [];
  const asked = [];
  const api = { post: async (path, body) => (asked.push(body), path === "/uploads" && body.contentType === "image/jpeg" ? { uploadUrl: UPLOAD_URL, publicUrl: PUBLIC_URL } : assert.fail("unexpected api call")) };
  const fetchImpl = async (url, init) => { puts.push({ url, init }); return { ok: true, status: 200 }; };
  const file = { name: "garden.jpg", type: "image/jpeg", size: 3 };
  const att = await uploadPhoto(api, file, fetchImpl);
  assert.equal(puts.length, 1);
  assert.equal(puts[0].url, UPLOAD_URL);
  assert.notEqual(new URL(puts[0].url).origin, new URL(PUBLIC_URL).origin, "the upload does not go through the site (CloudFront) origin");
  assert.equal(puts[0].init.method, "PUT");
  assert.deepEqual(puts[0].init.headers, { "Content-Type": "image/jpeg" });
  assert.equal(puts[0].init.credentials, undefined, "no credentials option: S3 is cross-origin and must not receive the io_id cookie");
  assert.deepEqual(att, { kind: "image", url: PUBLIC_URL, mime: "image/jpeg" });
  assert.deepEqual(asked, [{ filename: "photo", contentType: "image/jpeg", size: 3 }], "the file's own name is never sent (privacy-guard-existing-paths AC6)");
  assert.doesNotMatch(JSON.stringify(asked), /garden/);
});

// Version skew (HFY-TSK-240 review): merging deploys the site at once, but the new hfy-api goes live only when the RG-2 change set
// executes. Until then the live presign is HFY-TSK-067's, frozen below from api/src/uploads.js as of 3f233e8, which refuses a
// body without a filename. The islands must work against both.
const PRE_RG2_TYPES = { "image/jpeg": ["jpg", "jpeg"], "image/png": ["png"], "image/webp": ["webp"], "image/heic": ["heic"] };
function preRg2Presign(input) {
  const { filename, contentType, size } = input ?? {};
  if (typeof filename !== "string" || filename.trim() === "") return [400, { error: "validation", message: "filename is required" }];
  if (typeof contentType !== "string" || !Object.hasOwn(PRE_RG2_TYPES, contentType)) return [400, { error: "validation", message: "only jpeg, png, webp and heic images are accepted" }];
  if (!Number.isInteger(size) || size <= 0) return [400, { error: "validation", message: "size must be a positive integer" }];
  if (size > 10 * 1024 * 1024) return [400, { error: "validation", message: "image exceeds 10 MB" }];
  const base = String(filename).split(/[\\/]/).pop().replace(/\.[^.]*$/, "");
  const stem = base.normalize("NFKD").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[.\-_]+|[.\-_]+$/g, "").slice(0, 60) || "photo";
  const key = `uploads/posts/01J00000000000000000000000/${stem}.${PRE_RG2_TYPES[contentType][0]}`;
  return [201, { uploadUrl: `https://presign.test/${key}`, publicUrl: `https://harrisonfamily.us/${key}`, key }];
}

const jsonFetch = (route) => async (url, init) => {
  const [status, body] = await route(new URL(url, "http://x").pathname, init.body ? JSON.parse(init.body) : undefined);
  return { status, ok: status < 400, json: async () => body };
};
const okPut = async () => ({ ok: true, status: 200 });

test("uploadPhoto works against the presign live before the RG-2 change set (filename required), and its key is photo.<ext> there too", async () => {
  assert.equal(preRg2Presign({ contentType: "image/jpeg", size: 3 })[0], 400, "the frozen rule refuses a body without a filename, as the live API does");
  const api = createApi({ fetchImpl: jsonFetch((path, body) => (path === "/api/uploads" ? preRg2Presign(body) : [404, {}])) });
  for (const [type, ext] of [["image/jpeg", "jpg"], ["image/png", "png"], ["image/webp", "webp"], ["image/heic", "heic"]]) {
    const att = await uploadPhoto(api, { name: "Garden Party 2001.jpg", type, size: 3 }, okPut);
    assert.equal(att.url, `https://harrisonfamily.us/uploads/posts/01J00000000000000000000000/photo.${ext}`);
  }
});

test("uploadPhoto works against the new presign (the real api handler), which ignores the filename", async () => {
  const w = makeApi();
  const token = await signToken("I0001");
  const api = createApi({ fetchImpl: async (url, init) => {
    const r = await w.call(init.method, new URL(url, "http://x").pathname, { token, body: init.body ? JSON.parse(init.body) : undefined });
    return { status: r.status, ok: r.status < 400, json: async () => r.body };
  } });
  const att = await uploadPhoto(api, { name: "Garden Party 2001.jpg", type: "image/png", size: 3 }, okPut);
  assert.match(att.url, /^https:\/\/harrisonfamily\.us\/uploads\/posts\/[0-9A-HJKMNP-TV-Z]{26}\/photo\.png$/);
  assert.equal(w.presigned.length, 1);
  assert.doesNotMatch(JSON.stringify(w.presigned), /garden/i);
});

test("a post photo renders as a plain same-origin <img src>, so the browser sends the io_id cookie that the gate needs", () => {
  const post = { ...FIXTURE_POSTS[0], can: { edit: false, delete: false, publish: false, withdraw: false }, attachments: [{ kind: "image", url: PUBLIC_URL, mime: "image/jpeg", alt: "the garden" }] };
  const html = renderToStaticMarkup(createElement(PostCard, { post }));
  assert.match(html, new RegExp(`<img src="${PUBLIC_URL.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}"`));
  assert.doesNotMatch(html, /crossorigin/i, "a crossorigin attribute would change how credentials are sent");
});

test("no island source fetches or XHRs a member photo (a script fetch of /uploads/ would need credentials)", () => {
  for (const f of walk(SRC).filter((n) => /\.(js|jsx|mjs)$/.test(n))) {
    const code = readFileSync(f, "utf8");
    assert.doesNotMatch(code, /\/uploads\//, `${f} mentions a /uploads/ path`);
    assert.doesNotMatch(code, /XMLHttpRequest/, `${f} uses XMLHttpRequest`);
  }
});
