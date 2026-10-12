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
import { PostCard } from "@io-kit/content/react";
import { uploadPhoto } from "../src/lib/upload.js";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const walk = (d) => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));

const UPLOAD_URL = "https://harrisonfamily-frontend.s3.us-west-2.amazonaws.com/uploads/posts/01J00000000000000000000000/garden.jpg?X-Amz-Signature=abc";
const PUBLIC_URL = "https://harrisonfamily.us/uploads/posts/01J00000000000000000000000/garden.jpg";

test("uploadPhoto PUTs to the presigned S3 URL (cross-origin, no cookies, not via the gated /uploads/*) and hands back the same-origin public URL", async () => {
  const puts = [];
  const api = { post: async (path, body) => (path === "/uploads" && body.contentType === "image/jpeg" ? { uploadUrl: UPLOAD_URL, publicUrl: PUBLIC_URL } : assert.fail("unexpected api call")) };
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
