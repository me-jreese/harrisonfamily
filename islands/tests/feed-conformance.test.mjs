// HFY-TSK-318: the @io-kit/feed conformance suite FT-01..FT-12 (FT-13 is browser-only) against the site's posts source: the real
// ContentSource adapter and the kit timeline adapter, over the real api/ handler on its in-memory DynamoDB fake. Synthetic data only.
// This surface has no since() and no realtime subscribe (the posts island refetches), so FT-05..FT-09 are reported as skips, never passes.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createTimelineSource } from "@io-kit/content";
import { FIXTURE_POSTS } from "@io-kit/content/testing";
import { runConformance } from "@io-kit/feed/testing";
import { makeApi, signToken, TABLE, cmds } from "../../api/test/world.js";
import { seedPosts } from "../../api/src/content.js";
import { createApi } from "../src/lib/api.js";
import { createHfyContentSource } from "../src/lib/content-source.js";

const AUTHOR = { id: "I0001", label: "Ann Author" };

async function makeTarget() {
  const w = makeApi({});
  await seedPosts({ ddb: w.ddb, cmds, table: TABLE }, FIXTURE_POSTS);
  const token = await signToken(AUTHOR.id);
  const fetchImpl = async (url, init) => {
    const u = new URL(url, "http://x");
    const r = await w.call(init.method, u.pathname, { token, body: init.body ? JSON.parse(init.body) : undefined, query: Object.fromEntries(u.searchParams) });
    return { status: r.status, ok: r.status < 400, json: async () => r.body };
  };
  const content = createHfyContentSource(createApi({ fetchImpl }));
  const source = createTimelineSource(content);
  // The visible-post count is tracked by the backend: walked once at setup, then moved by append/remove.
  let count = 0;
  for (let cursor = null, i = 0; i < 50; i += 1) {
    const r = await content.list({ cursor, limit: 50 });
    count += r.items.length;
    if (!r.cursor) break;
    cursor = r.cursor;
  }
  let n = 0;
  // Enough posts for two pages of 10 plus a cushion (FT-04 and FT-11 page twice).
  const backend = {
    count: () => count,
    async append(k) {
      const made = [];
      for (let i = 0; i < k; i += 1) { made.push(await content.createDraft({ type: "post", visibility: "published", body: `synthetic feed post ${++n}` })); count += 1; }
      return made;
    },
    async remove(id) { await content.delete(id); count -= 1; },
  };
  await backend.append(20);
  return { name: "harrisonfamily posts source (adapter + timeline over the api handler)", source, backend, filter: undefined, otherFilter: { type: "article" }, markOwnWrite: (item) => source.markOwnWrite(item.id) };
}

describe("feed conformance FT-01..FT-12 on the posts source", () => {
  it("no failures; FT-13 and the since/realtime cases are reported as skips", async () => {
    const report = await runConformance(await makeTarget());
    const n = (s) => report.results.filter((r) => r.status === s).length;
    console.log(`feed conformance: ${report.results.length} cases, ${n("pass")} pass, ${n("skip")} skip, ${n("fail")} fail`);
    for (const r of report.results.filter((x) => x.status !== "pass")) console.log(`  ${r.status} ${r.id} ${r.detail ?? ""}`);
    assert.equal(n("fail"), 0, JSON.stringify(report.results.filter((r) => r.status === "fail")));
    assert.ok(report.ok);
    // The cases that must really run on this surface (not skip): paging, limits, filter reset, snapshot mode, schema, transport auth.
    for (const id of ["FT-01", "FT-02", "FT-03", "FT-04", "FT-10", "FT-11", "FT-12"]) {
      assert.equal(report.results.find((r) => r.id.startsWith(id))?.status, "pass", id);
    }
    assert.equal(report.results.filter((r) => /^FT-(0[1-9]|1[0-3])/.test(r.id)).length, 13);
  });
});
