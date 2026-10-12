// passkey-gsi1sk-missing (HFY-R67): the passkey credential store against the REAL hfy-app key schema (read from the CloudFormation
// template), on a fake table that applies DynamoDB's sparse-index rule. The other passkey tests use the kit's memoryPasskeyStore,
// which has no index at all, so none of them could see that GSI1 never held a credential.
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } from "jose";
import { buildResolver, loadPasskeyBrowserBundle } from "@io-kit/auth/edge/deploy";
import { createIdentityService, createPasskeyService, ddbChallengeStore, ddbPasskeyStore, memoryLinkStore, memoryRefreshStore } from "@io-kit/auth/server";
import { createSoftwareAuthenticator } from "@io-kit/auth/testing";
import { createAuthEdge, loadManifest } from "../src/edge.js";
import { hfyPasskeyStore, withPasskeySortKey } from "../src/passkeystore.js";
import { TEMPLATE, fakeTable, tableSchema } from "./fake-table.js";

const TABLE = "hfy-app";
const RP = "harrisonfamily.us";
const ORIGIN = "https://harrisonfamily.us";
const quiet = { error: () => { throw new Error("must not log"); } };
const rec = (id, sub, extra = {}) => ({ credentialId: id, sub, email: `${sub.toLowerCase()}@example.com`, publicKey: "pk", counter: 0, deviceType: "singleDevice", backedUp: false, createdAt: 1, ...extra });
let schema;
beforeAll(() => { schema = tableSchema(readFileSync(TEMPLATE, "utf8")); });

describe("passkey store against the real GSI1", () => {
  it("the kit's ddbPasskeyStore alone writes credentials GSI1 never indexes (the reported bug)", async () => {
    const t = fakeTable(schema);
    const store = ddbPasskeyStore({ client: t, tableName: TABLE });
    await store.put(rec("cred-1", "I0111"));
    expect(await store.get("cred-1")).toMatchObject({ credentialId: "cred-1", sub: "I0111" });
    expect(await store.listByPrincipal("I0111")).toEqual([]);
  });

  it("hfyPasskeyStore writes GSI1SK = PK, so listByPrincipal finds every credential of that member and no one else's", async () => {
    const t = fakeTable(schema);
    const store = hfyPasskeyStore({ client: t, tableName: TABLE, log: quiet });
    await store.put(rec("cred-1", "I0111"));
    await store.put(rec("cred-2", "I0111", { createdAt: 2 }));
    await store.put(rec("cred-3", "I0222"));
    expect(t.items.get(JSON.stringify(["PASSKEY#cred-1", "META"]))).toMatchObject({ PK: "PASSKEY#cred-1", SK: "META", GSI1PK: "PASSKEYSUB#I0111", GSI1SK: "PASSKEY#cred-1" });
    expect((await store.listByPrincipal("I0111")).map((r) => r.credentialId).sort()).toEqual(["cred-1", "cred-2"]);
    expect((await store.listByPrincipal("I0222")).map((r) => r.credentialId)).toEqual(["cred-3"]);
    expect(await store.listByPrincipal("I0333")).toEqual([]);
    await store.updateCounter("cred-1", 7, 99); // the kit's UpdateItem on rec leaves the index keys alone
    expect(t.items.get(JSON.stringify(["PASSKEY#cred-1", "META"]))).toMatchObject({ GSI1SK: "PASSKEY#cred-1", rec: { counter: 7, lastUsedAt: 99 } });
    await store.delete("cred-2");
    expect((await store.listByPrincipal("I0111")).map((r) => r.credentialId)).toEqual(["cred-1"]);
  });

  it("only credential items get a sort key: challenges and other items pass through untouched", () => {
    expect(withPasskeySortKey({ PK: "PASSKEYCHAL#abc", SK: "META", rec: {} })).toEqual({ PK: "PASSKEYCHAL#abc", SK: "META", rec: {} });
    expect(withPasskeySortKey({ PK: "LINK#a@example.com", SK: "META", GSI1PK: "SUB#I0111" })).not.toHaveProperty("GSI1SK");
    expect(withPasskeySortKey({ PK: "PASSKEY#x", SK: "META", rec: {} })).not.toHaveProperty("GSI1SK"); // no GSI1PK: nothing to index
  });

  it("indexes a credential written before the fix the next time it is read, without rewriting rec", async () => {
    const t = fakeTable(schema);
    await t.put({ Item: { PK: "PASSKEY#old", SK: "META", rec: rec("old", "I0111", { counter: 4 }), GSI1PK: "PASSKEYSUB#I0111" } });
    const store = hfyPasskeyStore({ client: t, tableName: TABLE, log: quiet });
    expect(await store.listByPrincipal("I0111")).toEqual([]);
    expect((await store.get("old")).counter).toBe(4); // every passkey sign-in (and removal) reads its credential
    expect(t.items.get(JSON.stringify(["PASSKEY#old", "META"]))).toEqual({ PK: "PASSKEY#old", SK: "META", rec: rec("old", "I0111", { counter: 4 }), GSI1PK: "PASSKEYSUB#I0111", GSI1SK: "PASSKEY#old" });
    expect((await store.listByPrincipal("I0111")).map((r) => r.credentialId)).toEqual(["old"]);
  });

  it("the backfill never undoes a concurrent counter update, and a lost race is not an error", async () => {
    const t = fakeTable(schema);
    await t.put({ Item: { PK: "PASSKEY#old", SK: "META", rec: rec("old", "I0111", { counter: 4 }), GSI1PK: "PASSKEYSUB#I0111" } });
    const store = hfyPasskeyStore({ client: t, tableName: TABLE, log: quiet });
    const raced = {
      ...t,
      async get(i) {
        const r = await t.get(i);
        await store.updateCounter("old", 5, 50); // another sign-in lands between our read and the backfill
        return r;
      },
    };
    await hfyPasskeyStore({ client: raced, tableName: TABLE, log: quiet }).get("old");
    expect(t.items.get(JSON.stringify(["PASSKEY#old", "META"]))).toMatchObject({ GSI1SK: "PASSKEY#old", rec: { counter: 5, lastUsedAt: 50 } });
    const healedMeanwhile = { ...t, async get(i) { const r = await t.get(i); delete r.Item.GSI1SK; return r; } }; // stale read: already healed
    await expect(hfyPasskeyStore({ client: healedMeanwhile, tableName: TABLE, log: quiet }).get("old")).resolves.toBeTruthy();
  });

  it("a failed backfill is logged and the read still succeeds (the sign-in is not blocked)", async () => {
    const t = fakeTable(schema);
    await t.put({ Item: { PK: "PASSKEY#old", SK: "META", rec: rec("old", "I0111"), GSI1PK: "PASSKEYSUB#I0111" } });
    const logged = [];
    const broken = { ...t, async update() { throw Object.assign(new Error("throttled"), { name: "ProvisionedThroughputExceededException" }); } };
    const r = await hfyPasskeyStore({ client: broken, tableName: TABLE, log: { error: (m) => logged.push(JSON.parse(m)) } }).get("old");
    expect(r.credentialId).toBe("old");
    expect(logged).toEqual([{ msg: "passkey index backfill failed", error: "throttled" }]);
  });
});

describe("the passkey service on the real key schema", () => {
  const who = { sub: "I0111", email: "ana@example.com", label: "Ana" };
  async function world(maxPerPrincipal) {
    const t = fakeTable(schema);
    const passkeys = createPasskeyService({
      rpID: RP, rpName: "Harrison Family", origin: [ORIGIN], userVerification: "preferred", ...(maxPerPrincipal ? { maxPerPrincipal } : {}),
      store: hfyPasskeyStore({ client: t, tableName: TABLE, log: quiet }), challenges: ddbChallengeStore({ client: t, tableName: TABLE }),
    });
    const enrol = async () => {
      const a = createSoftwareAuthenticator({ rpId: RP, origin: ORIGIN });
      const options = await passkeys.registrationOptions(who);
      const created = await passkeys.verifyRegistration(who, a.register({ challenge: options.challenge, rp: options.rp, user: options.user }));
      return { a, id: created.id, options };
    };
    return { t, passkeys, enrol };
  }

  it("excludeCredentials, allowCredentials and the per-member limit all see the member's registered credentials", async () => {
    const { passkeys, enrol } = await world(2);
    const first = await enrol();
    expect((await passkeys.list("I0111")).map((p) => p.id)).toEqual([first.id]);
    const second = await enrol();
    expect(second.options.excludeCredentials.map((c) => c.id)).toEqual([first.id]);
    await expect(passkeys.registrationOptions(who)).rejects.toMatchObject({ detail: "passkey_limit" });
    const step = await passkeys.stepUpOptions(who);
    expect(step.allowCredentials.map((c) => c.id).sort()).toEqual([first.id, second.id].sort());
    const hinted = await passkeys.authenticationOptions({ hint: "I0111" });
    expect(hinted.allowCredentials.map((c) => c.id).sort()).toEqual([first.id, second.id].sort());
    expect(await passkeys.remove("I0222", first.id)).toBe(false);
    expect(await passkeys.remove("I0111", first.id)).toBe(true);
    expect((await passkeys.list("I0111")).map((p) => p.id)).toEqual([second.id]);
  });
});

describe("/auth/passkey list and remove end to end on the real key schema", () => {
  const ENV = { COGNITO_USER_POOL_ID: "us-west-2_TEST", COGNITO_CLIENT_ID: "client123", GOOGLE_CLIENT_ID: "gis-client.apps.googleusercontent.com" };
  const raw = JSON.parse(readFileSync(new URL("../edge.manifest.json", import.meta.url), "utf8"));
  const call = (edge, method, rawPath, body, cookie) => edge({
    rawPath, requestContext: { http: { method } },
    headers: { "x-requested-with": "io-kit", origin: ORIGIN, "content-type": "application/json", accept: "application/json", ...(cookie ? { cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = (res) => JSON.parse(res.body);

  it("a member sees the passkey they registered, can remove it, and the removed passkey no longer signs in", async () => {
    const manifest = loadManifest(raw, ENV);
    const g = await generateKeyPair("RS256", { extractable: true });
    const s = await generateKeyPair("RS256", { extractable: true });
    const pub = { ...(await exportJWK(s.publicKey)), kid: "hfy-session-1", alg: "RS256", use: "sig" };
    const t = fakeTable(schema);
    const identity = createIdentityService({
      resolver: buildResolver(manifest.resolver, { readObject: async () => JSON.stringify({ "ana@example.com": "I0111" }) }),
      links: memoryLinkStore(),
      google: { clientId: ENV.GOOGLE_CLIENT_ID, jwks: createLocalJWKSet({ keys: [{ ...(await exportJWK(g.publicKey)), kid: "g1", alg: "RS256", use: "sig" }] }) },
      sessions: { issuer: manifest.session.issuer, audience: manifest.session.audience, kid: "hfy-session-1", privateKey: s.privateKey, store: memoryRefreshStore(), defaultProfile: "installed" },
    });
    const pk = manifest.providers.find((p) => p.kind === "passkey");
    const passkeys = createPasskeyService({ rpID: pk.rpId, rpName: pk.rpName, origin: pk.origins, store: hfyPasskeyStore({ client: t, tableName: TABLE, log: quiet }), challenges: ddbChallengeStore({ client: t, tableName: TABLE }) });
    const edge = createAuthEdge({ manifest, identity, publicJwk: pub, passkeys, passkeyClientScript: loadPasskeyBrowserBundle(), verify: { issuers: [manifest.session.issuer], audiences: [manifest.session.audience], jwks: createLocalJWKSet({ keys: [pub] }) }, nonce: () => "n" });
    const credential = await new SignJWT({ email: "ana@example.com", email_verified: true }).setProtectedHeader({ alg: "RS256", kid: "g1" })
      .setSubject("gs").setIssuer("https://accounts.google.com").setAudience(ENV.GOOGLE_CLIENT_ID).setIssuedAt().setExpirationTime("10m").sign(g.privateKey);
    const signIn = await call(edge, "POST", "/auth/google", { credential });
    expect(signIn.statusCode).toBe(200);
    const cookie = signIn.cookies.map((c) => c.split(";")[0]).join("; ");

    const authenticator = createSoftwareAuthenticator({ rpId: pk.rpId, origin: ORIGIN });
    const { options } = json(await call(edge, "POST", "/auth/passkey/register/options", {}, cookie));
    const reg = await call(edge, "POST", "/auth/passkey/register/verify", { response: authenticator.register({ challenge: options.challenge, rp: options.rp, user: options.user }), label: "Phone" }, cookie);
    expect(reg.statusCode).toBe(200);
    const id = json(reg).passkey.id;

    const listed = json(await call(edge, "GET", "/auth/passkey/list", undefined, cookie)).passkeys;
    expect(listed.map((p) => p.id)).toEqual([id]); // was [] with the kit store: no Remove button, a stolen passkey kept working
    const again = json(await call(edge, "POST", "/auth/passkey/register/options", {}, cookie)).options;
    expect(again.excludeCredentials.map((c) => c.id)).toEqual([id]);

    const login = async () => {
      const o = json(await call(edge, "POST", "/auth/passkey/login/options", {})).options;
      return call(edge, "POST", "/auth/passkey/login/verify", { response: authenticator.authenticate({ challenge: o.challenge }) });
    };
    expect((await login()).statusCode).toBe(200);
    expect((await call(edge, "DELETE", `/auth/passkey/${encodeURIComponent(id)}`, undefined, cookie)).statusCode).toBe(200);
    expect(json(await call(edge, "GET", "/auth/passkey/list", undefined, cookie)).passkeys).toEqual([]);
    expect((await login()).statusCode).toBe(401);
  });
});

describe("Lambda wiring (src/index.js)", () => {
  it("builds the passkey service on hfyPasskeyStore, never on the kit's ddbPasskeyStore directly", () => {
    const src = readFileSync(new URL("../src/index.js", import.meta.url), "utf8");
    expect(src).toMatch(/store:\s*hfyPasskeyStore\(\{\s*client:\s*ddb,\s*tableName\s*\}\)/);
    expect(src).not.toMatch(/ddbPasskeyStore\s*\(/);
  });
});
