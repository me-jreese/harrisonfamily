// HFY-TSK-388-0C: the posts-page carousel's pure pieces. Run: node --test tests/media-carousel.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { carouselDetailHref, guardSource, rebaseMedia, showsOnPath } from "../src/lib/media-carousel-model.js";

test("every address the band hands out is on /all-media/, never the private /media/ prefix", () => {
  assert.equal(carouselDetailHref("M0001"), "/all-media/?id=M0001");
  assert.equal(carouselDetailHref("M 2/x"), "/all-media/?id=M+2%2Fx");
  assert.equal(rebaseMedia("/media/"), "/all-media/");
  assert.equal(rebaseMedia("/media/?section=posts"), "/all-media/?section=posts");
  assert.equal(rebaseMedia("/posts/?id=P1"), "/posts/?id=P1");
});

test("the band shows on the posts list only", () => {
  assert.equal(showsOnPath("/posts/", ""), true);
  assert.equal(showsOnPath("/posts", ""), true);
  assert.equal(showsOnPath("/posts/index.html", ""), true);
  assert.equal(showsOnPath("/posts/", "?id=01J"), false);
  for (const p of ["/", "/all-media/", "/me/posts/", "/posts/x/"]) assert.equal(showsOnPath(p, ""), false, p);
});

test("guardSource reports a failed read once per failure and still rejects", async () => {
  let fails = 0;
  const err = new Error("HTTP 503");
  const bad = guardSource({ listMedia: async () => { throw err; } }, () => { fails += 1; });
  await assert.rejects(bad.listMedia({ section: "all" }), err);
  assert.equal(fails, 1);
  const ok = guardSource({ listMedia: async (q) => ({ cards: [], nextCursor: null, counts: { media: 0, posts: 0 }, q }) }, () => { fails += 1; });
  assert.deepEqual((await ok.listMedia({ section: "all" })).q, { section: "all" });
  assert.equal(fails, 1);
  const throwing = guardSource({ listMedia: async () => { throw err; } }, () => { throw new Error("x"); });
  await assert.rejects(throwing.listMedia({}), err);
});
