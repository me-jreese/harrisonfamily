// HFY-TSK-067: the kit ContentSource contract (CS-01..CS-10) against the harrisonfamily adapter. The mocked fetch drives the real
// api/ handler over its in-memory DynamoDB fake, so adapter, wire shape and server rules are all exercised together.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FIXTURE_POSTS, runContentContract } from "@io-kit/content/testing";
import { makeApi, signToken, TABLE, cmds } from "../../api/test/world.js";
import { seedPosts } from "../../api/src/content.js";
import { createApi } from "../src/lib/api.js";
import { createHfyContentSource, CAPABILITIES } from "../src/lib/content-source.js";

const harness = {
  async make() {
    const audit = [];
    const w = makeApi({ audit: (e) => void audit.push(e) });
    await seedPosts({ ddb: w.ddb, cmds, table: TABLE }, FIXTURE_POSTS);
    const as = (actor) => {
      const fetchImpl = async (url, init) => {
        const u = new URL(url, "http://x");
        const r = await w.call(init.method, u.pathname, { token: await signToken(actor.id), body: init.body ? JSON.parse(init.body) : undefined, query: Object.fromEntries(u.searchParams) });
        return { status: r.status, ok: r.status < 400, json: async () => r.body };
      };
      return createHfyContentSource(createApi({ fetchImpl }));
    };
    return { as, audit };
  },
  author: { id: "I0001", label: "Ann Author" },
  other: { id: "I0002", label: "Olive Other" },
  admin: { id: "I0099", label: "Admin", admin: true },
  capabilities: CAPABILITIES,
};

describe("hfy content adapter over the real api handler", () => {
  it("contract CS-01..CS-10: no failures; not-applicable cases are reported, not passed", async () => {
    const { results, ok } = await runContentContract(harness);
    const n = (s) => results.filter((r) => r.status === s).length;
    console.log(`content contract: ${results.length} cases, ${n("pass")} pass, ${n("not_applicable")} n/a, ${n("fail")} fail`);
    for (const r of results.filter((x) => x.status !== "pass")) console.log(`  ${r.status} ${r.id} ${r.detail ?? ""}`);
    assert.equal(n("fail"), 0, JSON.stringify(results.filter((r) => r.status === "fail")));
    assert.ok(ok);
  });
});
