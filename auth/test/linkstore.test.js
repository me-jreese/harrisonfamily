// link-store-gsi-missing-sort-key: the link store against the REAL hfy-app key schema (read from the CloudFormation template),
// on a fake table that applies DynamoDB's sparse-index rule: an item is in a GSI only if it carries every index key attribute.
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } from "jose";
import { buildResolver } from "@io-kit/auth/edge/deploy";
import { createIdentityService, ddbLinkStore, memoryRefreshStore } from "@io-kit/auth/server";
import { createAuthEdge, loadManifest } from "../src/edge.js";
import { hfyLinkStore } from "../src/linkstore.js";

const TEMPLATE = new URL("../../infrastructure/cloudformation/app-stack.yaml", import.meta.url);

/** Table + GSI key schema and attribute types of the hfy-app table, parsed from app-stack.yaml (flow-style entries). */
function tableSchema(yaml) {
  const table = yaml.slice(yaml.indexOf("Type: AWS::DynamoDB::Table"));
  const types = Object.fromEntries([...table.matchAll(/\{\s*AttributeName:\s*(\w+),\s*AttributeType:\s*(\w+)\s*\}/g)].map((m) => [m[1], m[2]]));
  const keys = (block) => Object.fromEntries([...block.matchAll(/\{\s*AttributeName:\s*(\w+),\s*KeyType:\s*(HASH|RANGE)\s*\}/g)].map((m) => [m[2], m[1]]));
  const gsiBlock = table.slice(table.indexOf("GlobalSecondaryIndexes:"));
  const indexes = {};
  for (const m of gsiBlock.matchAll(/- IndexName:\s*(\w+)\s*\n([\s\S]*?)Projection:/g)) indexes[m[1]] = keys(m[2]);
  const base = keys(table.slice(table.indexOf("KeySchema:"), table.indexOf("GlobalSecondaryIndexes:")));
  return { types, base, indexes };
}

const typeOk = (v, t) => (t === "S" ? typeof v === "string" && v.length > 0 : t === "N" ? typeof v === "number" : t === "B" ? v instanceof Uint8Array : false);
const ddbError = (name, message) => Object.assign(new Error(message), { name });

/** The kit's `{get, put, query}` client over an in-memory table that enforces the given key schema. */
function fakeTable(schema) {
  const items = new Map();
  const keyOf = (k) => JSON.stringify([k[schema.base.HASH], k[schema.base.RANGE]]);
  const evalCond = (expr, existing) =>
    expr.split(/\s+AND\s+/).every((c) => {
      const m = /^attribute_(exists|not_exists)\((\w+)\)$/.exec(c.trim());
      if (!m) throw new Error(`fake table: unsupported condition ${c}`);
      const has = existing !== undefined && existing[m[2]] !== undefined;
      return m[1] === "exists" ? has : !has;
    });
  return {
    items,
    async get({ Key }) {
      const it = items.get(keyOf(Key));
      return it ? { Item: structuredClone(it) } : {};
    },
    async put({ Item, ConditionExpression }) {
      for (const k of [schema.base.HASH, schema.base.RANGE]) if (!typeOk(Item[k], schema.types[k])) throw ddbError("ValidationException", `missing key ${k}`);
      // DynamoDB rejects a GSI key attribute of the wrong type (or an empty string)
      for (const [name, t] of Object.entries(schema.types)) if (Item[name] !== undefined && !typeOk(Item[name], t)) throw ddbError("ValidationException", `bad type for ${name}`);
      const k = keyOf(Item);
      if (ConditionExpression && !evalCond(ConditionExpression, items.get(k))) throw ddbError("ConditionalCheckFailedException", "conditional request failed");
      items.set(k, structuredClone(Item));
      return {};
    },
    async query({ IndexName, KeyConditionExpression, ExpressionAttributeValues }) {
      const ks = schema.indexes[IndexName];
      if (!ks) throw ddbError("ValidationException", `no index ${IndexName}`);
      const m = /^(\w+) = (:\w+)$/.exec(KeyConditionExpression);
      if (!m || m[1] !== ks.HASH) throw ddbError("ValidationException", "key condition must name the index hash key");
      const indexed = [...items.values()].filter((it) => [ks.HASH, ks.RANGE].filter(Boolean).every((a) => typeOk(it[a], schema.types[a]))); // sparse index
      const hits = indexed.filter((it) => it[ks.HASH] === ExpressionAttributeValues[m[2]]).sort((a, b) => (ks.RANGE ? String(a[ks.RANGE]).localeCompare(String(b[ks.RANGE])) : 0));
      return { Items: structuredClone(hits) };
    },
  };
}

const TABLE = "hfy-app";
const google = (email, linkedAt = 1) => ({ kind: "google", mode: "gis_id_token", email, idpIssuer: "https://accounts.google.com", idpSub: "g-1", linkedAt });
let schema;
beforeAll(() => { schema = tableSchema(readFileSync(TEMPLATE, "utf8")); });

describe("hfy-app key schema (infrastructure/cloudformation/app-stack.yaml)", () => {
  it("GSI1 is GSI1PK HASH + GSI1SK RANGE, both strings", () => {
    expect(schema.base).toEqual({ HASH: "PK", RANGE: "SK" });
    expect(schema.indexes.GSI1).toEqual({ HASH: "GSI1PK", RANGE: "GSI1SK" });
    expect(schema.types).toMatchObject({ PK: "S", SK: "S", GSI1PK: "S", GSI1SK: "S" });
  });
});

describe("link store against the real GSI1", () => {
  it("the kit's ddbLinkStore alone writes items GSI1 never indexes (the reported bug)", async () => {
    const t = fakeTable(schema);
    const store = ddbLinkStore({ client: t, tableName: TABLE });
    await store.put({ sub: "I0111", providers: [google("ana@example.com")] });
    expect(await store.findByEmail("ana@example.com")).toBeTruthy();
    expect(await store.getBySub("I0111")).toBeUndefined();
  });
  it("hfyLinkStore writes GSI1SK = PK, so getBySub finds every linked email", async () => {
    const t = fakeTable(schema);
    const store = hfyLinkStore({ client: t, tableName: TABLE });
    await store.put({ sub: "I0111", providers: [google("ana@example.com"), { kind: "password", email: "ana.alt@example.com", idpIssuer: "cog", idpSub: "c-1", linkedAt: 2 }] });
    const item = t.items.get(JSON.stringify(["LINK#ana@example.com", "META"]));
    expect(item).toMatchObject({ PK: "LINK#ana@example.com", SK: "META", GSI1PK: "SUB#I0111", GSI1SK: "LINK#ana@example.com", sub: "I0111" });
    const rec = await store.getBySub("I0111");
    expect(rec.sub).toBe("I0111");
    expect(rec.providers.map((p) => p.email).sort()).toEqual(["ana.alt@example.com", "ana@example.com"]);
    expect(await store.getBySub("I0222")).toBeUndefined();
  });
  it("heals a link item written before the fix the next time it is read", async () => {
    const t = fakeTable(schema);
    await t.put({ Item: { PK: "LINK#ana@example.com", SK: "META", sub: "I0111", providers: [google("ana@example.com")], GSI1PK: "SUB#I0111" } });
    const store = hfyLinkStore({ client: t, tableName: TABLE, log: { error: () => {} } });
    expect(await store.getBySub("I0111")).toBeUndefined();
    expect((await store.findByEmail("ana@example.com")).sub).toBe("I0111"); // every sign-in does this read
    expect((await store.getBySub("I0111")).providers).toHaveLength(1);
  });
  it("the heal never overwrites a newer write", async () => {
    const t = fakeTable(schema);
    await t.put({ Item: { PK: "LINK#ana@example.com", SK: "META", sub: "I0111", providers: [google("ana@example.com")], GSI1PK: "SUB#I0111" } });
    const store = hfyLinkStore({ client: t, tableName: TABLE, log: { error: () => { throw new Error("must not log a conditional miss"); } } });
    const raced = {
      ...t,
      async get(i) {
        const r = await t.get(i);
        // a concurrent recordLink lands between our read and the backfill
        await store.put({ sub: "I0111", providers: [google("ana@example.com"), { kind: "password", email: "ana@example.com", idpIssuer: "cog", idpSub: "c-1", linkedAt: 3 }] });
        return r;
      },
    };
    await hfyLinkStore({ client: raced, tableName: TABLE, log: { error: () => { throw new Error("must not log a conditional miss"); } } }).findByEmail("ana@example.com");
    expect((await store.getBySub("I0111")).providers.map((p) => p.kind)).toEqual(["google", "password"]);
  });
});

describe("/auth/link end to end on the real key schema", () => {
  const ENV = { COGNITO_USER_POOL_ID: "us-west-2_TEST", COGNITO_CLIENT_ID: "client123", GOOGLE_CLIENT_ID: "gis-client.apps.googleusercontent.com" };
  const ALLOW = { "ana@example.com": "I0111" };
  const raw = JSON.parse(readFileSync(new URL("../edge.manifest.json", import.meta.url), "utf8"));
  const req = (method, rawPath, { body, cookie } = {}) => ({
    rawPath, requestContext: { http: { method } },
    headers: { "x-requested-with": "io-kit", origin: "https://harrisonfamily.us", "content-type": "application/json", accept: method === "GET" ? "text/html" : "application/json", ...(cookie ? { cookie } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  async function world(makeLinks) {
    const manifest = loadManifest(raw, ENV);
    const g = await generateKeyPair("RS256", { extractable: true });
    const s = await generateKeyPair("RS256", { extractable: true });
    const pub = { ...(await exportJWK(s.publicKey)), kid: "hfy-session-1", alg: "RS256", use: "sig" };
    const provisioned = [];
    const identity = createIdentityService({
      resolver: buildResolver(manifest.resolver, { readObject: async () => JSON.stringify(ALLOW) }),
      links: makeLinks(fakeTable(schema)),
      google: { clientId: ENV.GOOGLE_CLIENT_ID, jwks: createLocalJWKSet({ keys: [{ ...(await exportJWK(g.publicKey)), kid: "g1", alg: "RS256", use: "sig" }] }) },
      passwords: { setPassword: async (i) => { provisioned.push(i.email); return { idpIssuer: "https://cognito-idp.us-west-2.amazonaws.com/us-west-2_TEST", idpSub: "cog-sub-1" }; } },
      sessions: { issuer: manifest.session.issuer, audience: manifest.session.audience, kid: "hfy-session-1", privateKey: s.privateKey, store: memoryRefreshStore(), defaultProfile: "installed" },
    });
    const edge = createAuthEdge({ manifest, identity, publicJwk: pub, nonce: () => "n", verify: { issuers: [manifest.session.issuer], audiences: [manifest.session.audience], jwks: createLocalJWKSet({ keys: [pub] }) } });
    const credential = await new SignJWT({ email: "ana@example.com", email_verified: true }).setProtectedHeader({ alg: "RS256", kid: "g1" })
      .setSubject("google-sub-1").setIssuer("https://accounts.google.com").setAudience(ENV.GOOGLE_CLIENT_ID).setIssuedAt().setExpirationTime("10m").sign(g.privateKey);
    const signIn = await edge(req("POST", "/auth/google", { body: { credential } }));
    expect(signIn.statusCode).toBe(200);
    return { edge, provisioned, cookie: signIn.cookies.map((c) => c.split(";")[0]).join("; ") };
  }

  it("a Google-signed-in member sees the link and can add a password", async () => {
    const { edge, provisioned, cookie } = await world((t) => hfyLinkStore({ client: t, tableName: TABLE }));
    const page = await edge(req("GET", "/auth/link", { cookie }));
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("google (ana@example.com)");
    expect(page.body).toContain('id="password"');
    const set = await edge(req("POST", "/auth/link", { cookie, body: { password: "a-long-password-1" } }));
    expect(set.statusCode).toBe(200);
    expect(JSON.parse(set.body)).toEqual({ ok: true, linked: ["google", "password"] });
    expect(provisioned).toEqual(["ana@example.com"]);
  });
  it("with the kit store alone the same request is refused no_verified_email (regression guard)", async () => {
    const { edge, cookie } = await world((t) => ddbLinkStore({ client: t, tableName: TABLE }));
    const set = await edge(req("POST", "/auth/link", { cookie, body: { password: "a-long-password-1" } }));
    expect(set.statusCode).toBe(403);
    expect(JSON.parse(set.body)).toMatchObject({ detail: "no_verified_email" });
  });
});
