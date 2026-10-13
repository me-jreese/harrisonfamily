// The composite allowlist (HFY-TSK-134, Q2-10): a DynamoDB ALLOW# item wins over io's S3 file, active or revoked; no item means the file
// decides; a DynamoDB error falls back to the file. All fixtures are synthetic.
import { describe, it, expect, vi, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } from "jose";
import { buildResolver, parseAllowlist } from "@io-kit/auth/edge/deploy";
import { createIdentityService, memoryLinkStore, memoryRefreshStore } from "@io-kit/auth/server";
import { createCompositeResolver } from "../src/allowlist.js";
import { createMembership } from "../src/membership.js";
import { cognitoProvisioner } from "../src/cognito.js";
import { createAuthEdge, loadManifest } from "../src/edge.js";

const TABLE = "app-table";
const quiet = { error() {} };
// the lib-dynamodb command classes, as plain carriers
class GetCommand { constructor(input) { this.input = input; this.kind = "get"; } }
class QueryCommand { constructor(input) { this.input = input; this.kind = "query"; } }
const cmds = { GetCommand, QueryCommand };

/** A DocumentClient fake holding ALLOW# items; `fail` makes every call reject. */
function fakeDoc(items = [], { fail } = {}) {
  const rows = new Map(items.map((i) => [`${i.PK}|${i.SK}`, i]));
  const calls = [];
  return {
    calls,
    rows,
    async send(cmd) {
      calls.push(cmd);
      if (fail) throw Object.assign(new Error(`${fail} (arn:aws:dynamodb:us-west-2:000000000000:table/${TABLE})`), { name: fail });
      const i = cmd.input;
      expect(i.TableName).toBe(TABLE);
      if (cmd.kind === "get") return { Item: rows.get(`${i.Key.PK}|${i.Key.SK}`) };
      expect(i.IndexName).toBe("GSI1");
      expect(i.KeyConditionExpression).toBe("GSI1PK = :pk");
      return { Items: [...rows.values()].filter((r) => r.GSI1PK === i.ExpressionAttributeValues[":pk"]) };
    },
  };
}
const allow = (email, sub, state = "active", extra = {}) => ({
  PK: `ALLOW#${email}`, SK: "META", GSI1PK: `ALLOWSUB#${sub}`, GSI1SK: `ALLOW#${email}`, entity: "allow", sub, state, source: "access-request", at: "2026-01-01T00:00:00.000Z", by: "I9000", ...extra,
});

const FILE = { "ana@example.com": "I0111", "bo@example.com": { gramps_id: "I0222", label: "Bo", roles: ["member", "editors"] } };
const s3Resolver = (file = FILE, o = {}) => buildResolver({ kind: "s3_allowlist", bucket: "b", key: "k", cacheSeconds: 300 }, { readObject: async () => { if (o.fail) throw new Error("s3 down"); return JSON.stringify(file); } });
const resolverFor = (doc, s3 = s3Resolver()) => createCompositeResolver({ s3, ddb: doc, cmds, table: TABLE, log: quiet });

describe("composite resolver precedence", () => {
  it("DDB active gives the principal (no S3 entry needed)", async () => {
    const r = resolverFor(fakeDoc([allow("new@example.com", "I0555")]));
    expect(await r("new@example.com", { kind: "google" })).toEqual({ sub: "I0555", label: "new@example.com", roles: ["member"], claims: {} });
  });
  it("DDB active wins over a different sub in the S3 file", async () => {
    const r = resolverFor(fakeDoc([allow("ana@example.com", "I0999")]));
    expect((await r("ana@example.com")).sub).toBe("I0999");
  });
  it("DDB revoked gives null even when the email is in the S3 file", async () => {
    const r = resolverFor(fakeDoc([allow("ana@example.com", "I0111", "revoked")]));
    expect(await r("ana@example.com")).toBeNull();
  });
  it("S3 only gives the principal", async () => {
    const r = resolverFor(fakeDoc());
    expect(await r("ana@example.com")).toMatchObject({ sub: "I0111", roles: ["member"] });
    expect(await r("bo@example.com")).toMatchObject({ sub: "I0222", label: "Bo", roles: ["member", "editors"] });
    expect(await r("stranger@example.com")).toBeNull();
  });
  it("a DDB error with an S3 hit gives the principal", async () => {
    const r = resolverFor(fakeDoc([], { fail: "ProvisionedThroughputExceededException" }));
    expect(await r("ana@example.com")).toMatchObject({ sub: "I0111" });
  });
  it("a DDB error with an S3 miss gives null", async () => {
    const r = resolverFor(fakeDoc([], { fail: "ProvisionedThroughputExceededException" }));
    expect(await r("stranger@example.com")).toBeNull();
  });
  it("fails closed (rejects) when S3 has never loaded and DynamoDB has no answer", async () => {
    await expect(resolverFor(fakeDoc(), s3Resolver(FILE, { fail: true }))("ana@example.com")).rejects.toThrow("s3 down");
    await expect(resolverFor(fakeDoc([], { fail: "InternalServerError" }), s3Resolver(FILE, { fail: true }))("ana@example.com")).rejects.toThrow("s3 down");
  });
  it("a DDB active item still admits when S3 is down", async () => {
    const r = resolverFor(fakeDoc([allow("new@example.com", "I0555")]), s3Resolver(FILE, { fail: true }));
    expect((await r("new@example.com")).sub).toBe("I0555");
  });
  it("an item with an unknown state or no sub denies; it does not fall through to the file", async () => {
    expect(await resolverFor(fakeDoc([allow("ana@example.com", "I0111", "pending")]))("ana@example.com")).toBeNull();
    expect(await resolverFor(fakeDoc([allow("ana@example.com", "", "active")]))("ana@example.com")).toBeNull();
  });
  it("normalizes the address (case, spaces) for both stores and passes the provider to S3", async () => {
    const doc = fakeDoc([allow("new@example.com", "I0555")]);
    const s3 = vi.fn(async () => null);
    const r = createCompositeResolver({ s3, ddb: doc, cmds, table: TABLE, log: quiet });
    expect((await r("  New@Example.COM ", { kind: "google" })).sub).toBe("I0555");
    expect(doc.calls[0].input.Key).toEqual({ PK: "ALLOW#new@example.com", SK: "META" });
    await r("Other@Example.com", { kind: "password" });
    expect(s3).toHaveBeenCalledWith("other@example.com", { kind: "password" });
  });
  it("reads the item strongly consistent, so a revoke bites at once", async () => {
    const doc = fakeDoc();
    await resolverFor(doc)("ana@example.com");
    expect(doc.calls[0].input.ConsistentRead).toBe(true);
  });
  it("never logs an address", async () => {
    const log = { error: vi.fn() };
    await createCompositeResolver({ s3: s3Resolver(), ddb: fakeDoc([], { fail: "InternalServerError" }), cmds, table: TABLE, log })("ana@example.com");
    expect(log.error).toHaveBeenCalledOnce();
    expect(JSON.stringify(log.error.mock.calls)).not.toMatch(/ana@|arn:aws/);
  });
});

describe("with zero ALLOW# items the composite resolver equals the S3 resolver", () => {
  it("returns what buildResolver returns for hits, misses and spellings", async () => {
    const plain = s3Resolver();
    const composite = resolverFor(fakeDoc());
    for (const e of ["ana@example.com", "ANA@example.com", "bo@example.com", "stranger@example.com", ""]) {
      expect(await composite(e, { kind: "google" })).toEqual(await plain(e, { kind: "google" }));
    }
  });
});

describe("cognitoProvisioner behind the composite resolver", () => {
  const send = (log) => async (name, input) => {
    log.push(name);
    if (name === "AdminGetUser") throw Object.assign(new Error("none"), { name: "UserNotFoundException" });
    if (name === "AdminCreateUser") return { User: { Attributes: [{ Name: "sub", Value: "cog-1" }, ...input.UserAttributes] } };
    return {};
  };
  it("a DDB-granted member can set a password; a revoked S3 member cannot, before Cognito is called", async () => {
    const doc = fakeDoc([allow("new@example.com", "I0555"), allow("ana@example.com", "I0111", "revoked")]);
    const resolver = resolverFor(doc);
    const calls = [];
    const p = cognitoProvisioner({ userPoolId: "us-west-2_TEST", send: send(calls), resolver });
    await p.setPassword({ email: "new@example.com", hostSub: "I0555", password: "pw-1234567890" });
    expect(calls).toContain("AdminCreateUser");
    const denied = [];
    await expect(cognitoProvisioner({ userPoolId: "us-west-2_TEST", send: send(denied), resolver }).setPassword({ email: "ana@example.com", hostSub: "I0111", password: "pw-1234567890" }))
      .rejects.toMatchObject({ code: "AUTH_FORBIDDEN" });
    expect(denied).toEqual([]);
  });
});

describe("membership (MCP groups) over the composite allowlist", () => {
  const admins = async () => JSON.stringify({ admins: ["I0222"] });
  const fileText = async () => JSON.stringify(FILE);
  const mk = (doc, o = {}) => createMembership({ readAllowlist: fileText, readAdmins: admins, ddb: doc, cmds, table: TABLE, log: quiet, ...o });
  it("S3 members keep their groups with zero ALLOW# items", async () => {
    const g = mk(fakeDoc());
    expect(await g("I0111")).toEqual(["members"]);
    expect(await g("I0222")).toEqual(["members", "editors", "admins"]);
    expect(await g("I9999")).toBeNull();
  });
  it("a DDB active grant makes a principal a member who is in no S3 entry", async () => {
    expect(await mk(fakeDoc([allow("new@example.com", "I0555")]))("I0555")).toEqual(["members"]);
  });
  it("a DDB revoked item removes an S3 member, and only that email", async () => {
    const g = mk(fakeDoc([allow("ana@example.com", "I0111", "revoked"), allow("bo@example.com", "I0222", "revoked")]));
    expect(await g("I0111")).toBeNull();
    expect(await g("I0222")).toBeNull();
  });
  it("a principal with one revoked email and one other S3 email stays a member", async () => {
    const file = { "ana@example.com": "I0111", "ana2@example.com": "I0111" };
    const g = createMembership({ readAllowlist: async () => JSON.stringify(file), readAdmins: admins, ddb: fakeDoc([allow("ana@example.com", "I0111", "revoked")]), cmds, table: TABLE, log: quiet });
    expect(await g("I0111")).toEqual(["members"]);
  });
  it("a revoked item beside an active one for the same sub keeps the sub a member", async () => {
    const g = mk(fakeDoc([allow("ana@example.com", "I0111", "revoked"), allow("ana-new@example.com", "I0111")]));
    expect(await g("I0111")).toEqual(["members"]);
  });
  it("a DDB error falls back to the file: a hit stays a member, a miss is null", async () => {
    const g = mk(fakeDoc([], { fail: "InternalServerError" }));
    expect(await g("I0111")).toEqual(["members"]);
    expect(await g("I0555")).toBeNull();
  });
  it("fails closed with no S3 copy, unless an active ALLOW# item decides it", async () => {
    const broken = async () => { throw new Error("s3 down"); };
    await expect(mk(fakeDoc(), { readAllowlist: broken })("I0111")).rejects.toThrow("s3 down");
    expect(await mk(fakeDoc([allow("new@example.com", "I0555")]), { readAllowlist: broken })("I0555")).toEqual(["members"]);
  });
  it("without a table it is the S3 file alone", async () => {
    const g = createMembership({ readAllowlist: fileText, readAdmins: admins, log: quiet });
    expect(await g("I0111")).toEqual(["members"]);
  });
  it("caches the items per sub, and a revoke shows after the ttl", async () => {
    let t = 0;
    const doc = fakeDoc([allow("new@example.com", "I0555")]);
    const g = mk(doc, { now: () => t });
    expect(await g("I0555")).toEqual(["members"]);
    expect(await g("I0555")).toEqual(["members"]);
    expect(doc.calls.filter((c) => c.kind === "query")).toHaveLength(1);
    doc.rows.set("ALLOW#new@example.com|META", allow("new@example.com", "I0555", "revoked"));
    t = 61_000;
    expect(await g("I0555")).toBeNull();
  });
  it("parseAllowlist output feeds the reader (the kit's own parser)", () => {
    expect(parseAllowlist(JSON.stringify(FILE)).get("bo@example.com")).toMatchObject({ sub: "I0222" });
  });
});

describe("sign-in through the edge", () => {
  const raw = JSON.parse(readFileSync(new URL("../edge.manifest.json", import.meta.url), "utf8"));
  const ENV = { COGNITO_USER_POOL_ID: "us-west-2_TEST", COGNITO_CLIENT_ID: "client123", GOOGLE_CLIENT_ID: "gis-client.apps.googleusercontent.com" };
  const post = (rawPath, body) => ({
    rawPath, requestContext: { http: { method: "POST" } },
    headers: { "x-requested-with": "io-kit", origin: "https://harrisonfamily.us", "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  let manifest, gToken, build;
  beforeAll(async () => {
    manifest = loadManifest(raw, ENV);
    const g = await generateKeyPair("RS256", { extractable: true });
    const s = await generateKeyPair("RS256", { extractable: true });
    gToken = (email) => new SignJWT({ email, email_verified: true }).setProtectedHeader({ alg: "RS256", kid: "g1" }).setSubject("google-sub-1").setIssuer("https://accounts.google.com").setAudience(ENV.GOOGLE_CLIENT_ID).setIssuedAt().setExpirationTime("10m").sign(g.privateKey);
    const sessionPub = { ...(await exportJWK(s.publicKey)), kid: "hfy-session-1", alg: "RS256", use: "sig" };
    const gjwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(g.publicKey)), kid: "g1", alg: "RS256", use: "sig" }] });
    build = (resolver) => createAuthEdge({
      manifest,
      identity: createIdentityService({
        resolver, links: memoryLinkStore(), google: { clientId: ENV.GOOGLE_CLIENT_ID, jwks: gjwks },
        sessions: { issuer: manifest.session.issuer, audience: manifest.session.audience, kid: "hfy-session-1", privateKey: s.privateKey, store: memoryRefreshStore(), defaultProfile: "installed" },
      }),
      publicJwk: sessionPub, verify: { issuers: [manifest.session.issuer], audiences: [manifest.session.audience], jwks: createLocalJWKSet({ keys: [sessionPub] }) }, nonce: () => "n0nce",
    });
  });
  const signIn = async (edge, email) => edge(post("/auth/google", { credential: await gToken(email) }));
  it("an existing member's sign-in still works with zero ALLOW# items", async () => {
    const edge = build(resolverFor(fakeDoc()));
    const res = await signIn(edge, "ana@example.com");
    expect(res.statusCode).toBe(200);
    expect((res.cookies ?? []).some((c) => c.startsWith("io_id="))).toBe(true);
  });
  it("a DDB-granted member signs in; a DDB-revoked S3 member and a stranger get 403 not_allowlisted", async () => {
    const edge = build(resolverFor(fakeDoc([allow("new@example.com", "I0555"), allow("ana@example.com", "I0111", "revoked")])));
    expect((await signIn(edge, "new@example.com")).statusCode).toBe(200);
    for (const e of ["ana@example.com", "stranger@example.com"]) {
      const res = await signIn(edge, e);
      expect(res.statusCode).toBe(403);
      expect(res.body).toMatch(/not_allowlisted/);
    }
  });
});

describe("wiring and manifest", () => {
  it("index.js passes the composite resolver to the identity service and the provisioner; the manifest resolver is unchanged", () => {
    const src = readFileSync(new URL("../src/index.js", import.meta.url), "utf8");
    expect(src).toMatch(/const resolver = createCompositeResolver\(\{ s3: buildResolver\(m\.resolver, \{ readObject \}\)/);
    expect(src).toMatch(/createIdentityService\(\{\s*resolver,/);
    expect(src).toMatch(/cognitoAdmin\(m\.idp\.userPoolId, resolver\)/);
    expect(src).toMatch(/createMembership\(\{[^}]*ddb: doc, cmds: lib, table: tableName/s);
    const manifest = JSON.parse(readFileSync(new URL("../edge.manifest.json", import.meta.url), "utf8"));
    expect(manifest.resolver).toEqual({ kind: "s3_allowlist", bucket: "harrisonfamily", key: "config/userGrampsID.json", cacheSeconds: 300 });
    // edge.manifest.json itself is untouched by this task
  });
});
