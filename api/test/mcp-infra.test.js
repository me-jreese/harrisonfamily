// HFY-TSK-077: the CloudFront behaviors script (offline, --dry-run on an exported config), the Lambda@Edge 401-restore code, and tools/list == caps.
import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mcpParityCaps, mcpToolsList } from "../src/mcp-caps.js";
import { buildCaps } from "../src/routes.js";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SCRIPT = join(ROOT, "scripts/infra/add-mcp-behavior.sh");
const FIXTURE = join(ROOT, "scripts/infra/test/fixtures/live-like.json");
const ARN = "arn:aws:lambda:us-east-1:111122223333:function:hfy-mcp-edge401:3";
const SECRET = "hfy-test-origin-verify-must-never-be-printed";
const run = (...args) => spawnSync("bash", [SCRIPT, "--dry-run", "--function-url", "https://api123example.lambda-url.us-west-2.on.aws/", "--edge401-arn", ARN, ...args], { encoding: "utf8", env: { ...process.env, ORIGIN_VERIFY: SECRET } });

describe("scripts/infra/add-mcp-behavior.sh", () => {
  it("adds /mcp* and the PRM behavior with the Lambda@Edge association; a rerun on the result is a no-op; the secret is never printed", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcpcf-"));
    const after = join(dir, "after.json");
    const first = run("--config-file", FIXTURE, "--write-after", after);
    expect(first.status).toBe(0);
    expect(first.stdout + first.stderr).not.toContain(SECRET);
    const cfg = JSON.parse(readFileSync(after, "utf8"));
    const by = Object.fromEntries(cfg.CacheBehaviors.Items.map((b) => [b.PathPattern, b]));
    for (const p of ["/mcp*", "/.well-known/oauth-protected-resource*"]) {
      expect(by[p]).toMatchObject({ TargetOriginId: "hfy-api-origin", ViewerProtocolPolicy: "redirect-to-https", CachePolicyId: "4135ea2d-6df8-44a3-9df3-4b5a84be39ad" });
      expect(by[p].LambdaFunctionAssociations.Items).toEqual([{ LambdaFunctionARN: ARN, EventType: "origin-response", IncludeBody: false }]);
      expect(by[p].AllowedMethods.Items).toContain("POST");
    }
    const second = run("--config-file", after);
    expect(second.status).toBe(0);
    expect(second.stdout).toContain("no change");
  });
  it("refuses a non-versioned ARN and real runs from an exported config", () => {
    expect(run("--config-file", FIXTURE, "--edge401-arn", "arn:aws:lambda:us-east-1:1:function:x:$LATEST").status).toBe(2);
    const live = spawnSync("bash", [SCRIPT, "--function-url", "https://a.lambda-url.us-west-2.on.aws/", "--edge401-arn", ARN, "--config-file", FIXTURE], { encoding: "utf8", env: { ...process.env, ORIGIN_VERIFY: SECRET } });
    expect(live.status).toBe(2);
  });
  it("refuses when an earlier behavior would shadow /mcp*", () => {
    const cfg = JSON.parse(readFileSync(FIXTURE, "utf8"));
    const c = cfg.DistributionConfig ?? cfg;
    const b = structuredClone(c.CacheBehaviors.Items[0] ?? c.DefaultCacheBehavior);
    b.PathPattern = "/m*";
    c.CacheBehaviors = { Quantity: (c.CacheBehaviors?.Items?.length ?? 0) + 1, Items: [b, ...(c.CacheBehaviors?.Items ?? [])] };
    const f = join(mkdtempSync(join(tmpdir(), "mcpcf-")), "shadow.json");
    writeFileSync(f, JSON.stringify(cfg));
    const r = run("--config-file", f);
    expect(r.status).toBe(3);
    expect(r.stderr).toContain("would shadow it");
  });
  it("passes shellcheck when installed", () => {
    const r = spawnSync("shellcheck", ["-x", SCRIPT, join(ROOT, "scripts/ci/mcp-conformance.sh")], { encoding: "utf8" });
    if (r.error) return; // shellcheck not installed
    expect(r.stdout).toBe("");
  });
});

describe("Lambda@Edge 401 restore (infrastructure/mcp-edge401.us-east-1.yaml)", () => {
  const yaml = readFileSync(join(ROOT, "infrastructure/mcp-edge401.us-east-1.yaml"), "utf8");
  const code = /ZipFile: \|\n((?: {10}.*\n)+)/.exec(yaml)[1].replace(/^ {10}/gm, "");
  const handler = new Function("exports", `${code}; return exports.handler;`)({});
  const ev = (status, headers) => ({ Records: [{ cf: { response: { status, headers } } }] });
  it("copies x-amzn-remapped-www-authenticate to WWW-Authenticate on a 401 only", async () => {
    const wa = 'Bearer realm="harrisonfamily.us", resource_metadata="https://harrisonfamily.us/.well-known/oauth-protected-resource", scope="openid"';
    const r = await handler(ev("401", { "x-amzn-remapped-www-authenticate": [{ key: "x-amzn-Remapped-WWW-Authenticate", value: wa }] }));
    expect(r.headers["www-authenticate"]).toEqual([{ key: "WWW-Authenticate", value: wa }]);
    const ok = await handler(ev("200", { "x-amzn-remapped-www-authenticate": [{ key: "k", value: wa }] }));
    expect(ok.headers["www-authenticate"]).toBeUndefined();
    expect((await handler(ev("401", {}))).headers["www-authenticate"]).toBeUndefined();
  });
  it("is the same logic as the packaged edge-401-header.mjs", async () => {
    const src = readFileSync(join(ROOT, "api/node_modules/@io-kit/mcp/infra/edge-401-header.mjs"), "utf8");
    for (const frag of ['String(response.status) !== "401"', '"x-amzn-remapped-www-authenticate"', '!response.headers["www-authenticate"]']) {
      expect(src).toContain(frag);
      expect(code).toContain(frag);
    }
    expect(yaml).toContain("nodejs22.x");
  });
});

describe("tools/list == caps", () => {
  it("the parity caps actions are exactly the tools/list names, and every tool maps to a registry route", async () => {
    const { tools } = await mcpToolsList();
    const caps = await mcpParityCaps();
    expect(caps.actions.map((a) => a.name).sort()).toEqual(tools.map((t) => t.name).sort());
    expect(buildCaps().mcp.tools.map((t) => t.name).sort()).toEqual(tools.map((t) => t.name).sort());
    expect(tools.every((t) => /^[a-zA-Z0-9_-]+$/.test(t.name))).toBe(true);
  });
});
