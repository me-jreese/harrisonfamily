// privacy-guard-existing-paths (HFY-PLN-002 BRD2 5.2 and 5.3): the R-18 guard on today's write paths. One test per path (posts
// create and edit: body, title, alt; comments create and edit; the MCP tools through handler.invoke and through the mounted MCP
// server), the DOB switch both ways (AC9), the captured-log test (AC3), and the upload binding and location refusal on post
// attachments (AC5, AC6). Synthetic data only: 555-01xx numbers, example.org mail, made-up streets.
import { beforeEach, describe, expect, it } from "vitest";
import { SignJWT, importJWK } from "jose";
import priv from "@io-kit/mcp/fixtures/keys/hfy-auth-edge.private.jwk.json" with { type: "json" };
import jwks from "@io-kit/mcp/fixtures/jwks/hfy-auth-edge.jwks.json" with { type: "json" };
import { createMcpMount } from "../src/mcp.js";
import { createGroupResolver } from "../src/policy.js";
import { GuardError, guardDobFromEnv } from "../src/guard.js";
import { makeApi, signToken } from "./world.js";
import { SOME_LAT, SOME_LON, jpeg, tiff, xmpPacket } from "./photo-fixtures.js";

const PHONE = "call me on 555-0142 after dinner";
const EMAIL = "write to cousin.ann@example.org";
const STREET = "we live at 42 Example Street now";
const BDAY = "her birthday is May 5th";
const CONTACT_COPY = "this looks like a phone number or street address. we don't keep those on the site, so please remove it to continue.";
const DOB_COPY = "we only keep the birth year on the site.";
// Fragments of the matched text that must never appear in a response or a log line.
const SECRETS = /555-0142|0142|cousin\.ann|example\.org|42 Example|Example Street|May 5/i;

let ann, olive;
beforeEach(async () => { [ann, olive] = await Promise.all(["I0001", "I0002"].map((s) => signToken(s))); });
const stored = (w, prefix) => w.ddb.all().filter((r) => r.PK.startsWith(prefix));
const refusedWith = (r, code, pointer, kind) => {
  expect(r.status).toBe(422);
  expect(r.body).toMatchObject({ error: code, message: code === "contact_info" ? CONTACT_COPY : DOB_COPY });
  expect(r.body.errors).toEqual(expect.arrayContaining([expect.objectContaining({ pointer, ...(kind ? { kind } : {}) })]));
  for (const e of r.body.errors) {
    expect(Object.keys(e).sort()).toEqual(["kind", "pointer", "span"]);
    expect(e.span).toEqual([expect.any(Number), expect.any(Number)]);
  }
  expect(JSON.stringify(r.body)).not.toMatch(SECRETS);
};

describe("posts (content.js): create and edit, every free-text field", () => {
  let w;
  beforeEach(() => { w = makeApi(); });
  const create = (body) => w.call("POST", "/api/posts", { token: ann, body: { visibility: "published", ...body } });

  it("create: a phone number in the body is 422 contact_info with pointer, kind and span, and nothing is stored", async () => {
    const r = await create({ body: PHONE });
    refusedWith(r, "contact_info", "/body", "phone");
    expect(r.body.errors[0].span).toEqual([PHONE.indexOf("555"), PHONE.indexOf("555") + 8]);
    expect(stored(w, "POST#")).toEqual([]);
    expect(stored(w, "AUDIT#")).toEqual([]);
  });
  it("create: the title (an article) and an attachment alt are guarded too", async () => {
    refusedWith(await create({ type: "article", title: EMAIL, body: "fine" }), "contact_info", "/title", "email");
    const up = (await w.call("POST", "/api/uploads", { token: ann, body: { contentType: "image/jpeg", size: 9 } })).body;
    refusedWith(await create({ body: "fine", attachments: [{ kind: "image", url: up.publicUrl, mime: "image/jpeg", alt: STREET }] }), "contact_info", "/attachments/0/alt", "street_address");
    expect(stored(w, "POST#")).toEqual([]);
    expect(w.ddb.all().find((i) => i.PK.startsWith("UPLOAD#"))).not.toHaveProperty("attached"); // the binding was not used
  });
  it("edit: body, title and alt are guarded and the stored post is unchanged", async () => {
    const up = (await w.call("POST", "/api/uploads", { token: ann, body: { contentType: "image/jpeg", size: 9 } })).body;
    const p = (await create({ type: "article", title: "T", body: "ok", attachments: [{ kind: "image", url: up.publicUrl, mime: "image/jpeg", alt: "the garden" }] })).body;
    const patch = (body) => w.call("PATCH", `/api/posts/${p.id}`, { token: ann, body });
    refusedWith(await patch({ body: PHONE }), "contact_info", "/body", "phone");
    refusedWith(await patch({ title: EMAIL }), "contact_info", "/title", "email");
    refusedWith(await patch({ attachments: [{ ...p.attachments[0], alt: STREET }] }), "contact_info", "/attachments/0/alt");
    const now = (await w.call("GET", `/api/posts/${p.id}`, { token: ann })).body;
    expect(now).toMatchObject({ title: "T", body: "ok", updated_at: p.updated_at });
    expect(now.attachments[0].alt).toBe("the garden");
    expect((await patch({ body: "still fine" })).status).toBe(200); // a clean edit still works
  });
  it("one refusal lists every hit across fields, each with its own pointer", async () => {
    const r = await create({ type: "article", title: EMAIL, body: `${PHONE}. ${STREET}` });
    refusedWith(r, "contact_info", "/body");
    expect(r.body.errors.map((e) => e.pointer).sort()).toEqual(["/body", "/body", "/title"]);
  });
  it("clean text passes and is stored as written", async () => {
    const r = await create({ body: "we met at the reunion in 1950. 120 people came." });
    expect(r.status).toBe(201);
  });
});

describe("comments (comments.js): create and edit", () => {
  let w;
  beforeEach(() => { w = makeApi(); });
  it("create: 422 contact_info and nothing stored", async () => {
    const r = await w.call("POST", "/api/comments", { token: ann, body: { subject: "person:I0001", body: EMAIL } });
    refusedWith(r, "contact_info", "/body", "email");
    expect(stored(w, "THREAD#")).toEqual([]);
    expect(stored(w, "AUDIT#")).toEqual([]);
  });
  it("edit: 422 contact_info and the stored comment keeps its old body", async () => {
    const c = (await w.call("POST", "/api/comments", { token: ann, body: { subject: "person:I0001", body: "lovely photo" } })).body;
    const r = await w.call("PATCH", `/api/comments/${c.id}`, { token: ann, body: { subject: "person:I0001", body: `lovely. ${PHONE}` } });
    refusedWith(r, "contact_info", "/body", "phone");
    const list = (await w.call("GET", "/api/comments", { token: ann, query: { subject: "person:I0001" } })).body;
    expect(list.thread.comments[0]).toMatchObject({ body: "lovely photo" });
    expect(list.thread.comments[0]).not.toHaveProperty("edited_at");
  });
});

describe("the MCP tools (hfy_posts_create, hfy_comments_create) through handler.invoke", () => {
  const actor = { id: "I0044", label: "Ann Example", admin: false };
  it("posts.create: GuardError 422 contact_info, nothing stored", async () => {
    const w = makeApi();
    const e = await w.handler.invoke(actor, "posts.create", { body: { body: PHONE, visibility: "draft" } }).catch((x) => x);
    expect(e).toBeInstanceOf(GuardError);
    expect(e).toMatchObject({ status: 422, code: "contact_info", message: CONTACT_COPY });
    expect(e.errors).toEqual([{ pointer: "/body", kind: "phone", span: [PHONE.indexOf("555"), PHONE.indexOf("555") + 8] }]);
    expect(JSON.stringify({ m: e.message, e: e.errors })).not.toMatch(SECRETS);
    expect(stored(w, "POST#")).toEqual([]);
  });
  it("comments.create: GuardError 422 contact_info, nothing stored", async () => {
    const w = makeApi();
    const e = await w.handler.invoke(actor, "comments.create", { body: { subject: "person:I0001", body: STREET } }).catch((x) => x);
    expect(e).toMatchObject({ status: 422, code: "contact_info", errors: [expect.objectContaining({ pointer: "/body", kind: "street_address" })] });
    expect(stored(w, "THREAD#")).toEqual([]);
  });
});

// The mounted MCP server end to end: the tool caller sees the DS copy as the tool error, never the matched text.
const RESOURCE = "https://harrisonfamily.us/mcp";
const ISS = "https://harrisonfamily.us/auth";
const GROUPS = { version: 1, groups: { "mcp-authors": { emails: [], subjects: ["I0044"] }, "hfy-admin": { subjects: [] } } };
const key = await importJWK(priv, "RS256");
const mcpToken = () => new SignJWT({ client_id: "mcp-harrisonfamily", token_use: "access", scope: "openid", name: "Ann Example" })
  .setProtectedHeader({ alg: "RS256", kid: priv.kid ?? "hfy-auth-edge-key-1" }).setSubject("I0044").setIssuer(ISS).setAudience(RESOURCE).setIssuedAt().setExpirationTime("10m").sign(key);
function mcpWorld(apiOpts = {}) {
  const lines = [];
  const capture = (level) => (...a) => lines.push([level, ...a]);
  const log = { info: capture("info"), warn: capture("warn"), error: capture("error"), debug: capture("debug"), log: capture("log") };
  const api = makeApi({ ...apiOpts, log });
  const config = { resourceUrl: RESOURCE, audience: RESOURCE, issuer: ISS, jwksUri: `${ISS}/.well-known/jwks.json`, clientIds: ["mcp-harrisonfamily"], scopes: ["openid"] };
  const mount = createMcpMount({ config, invoke: api.handler.invoke, resolveGroups: createGroupResolver({ load: async () => GROUPS, log }), fetch: async () => ({ ok: true, status: 200, json: async () => jwks }), log });
  let id = 0;
  const tool = async (name, args) => {
    const r = await mount.handle({ rawPath: "/mcp", headers: { "content-type": "application/json", authorization: `Bearer ${await mcpToken()}` }, requestContext: { http: { method: "POST" } }, body: JSON.stringify({ jsonrpc: "2.0", id: (id += 1), method: "tools/call", params: { name, arguments: { ...args, mode: "execute" } } }) });
    return JSON.parse(r.body).result;
  };
  return { api, tool, lines };
}

describe("the mounted MCP server", () => {
  it("hfy_posts_create and hfy_comments_create answer the DS copy as a tool error and store nothing", async () => {
    const { api, tool } = mcpWorld();
    for (const [name, args] of [["hfy_posts_create", { body: PHONE }], ["hfy_posts_create", { title: EMAIL, body: "x", type: "article" }], ["hfy_comments_create", { subject: "person:I0001", body: STREET }]]) {
      const r = await tool(name, args);
      expect(r.isError, name).toBe(true);
      expect(r.content[0].text).toBe(CONTACT_COPY);
      expect(JSON.stringify(r)).not.toMatch(SECRETS);
    }
    expect(stored(api, "POST#")).toEqual([]);
    expect(stored(api, "THREAD#")).toEqual([]);
    expect((await tool("hfy_posts_create", { body: "clean draft" })).isError).toBeFalsy();
  });
});

describe("AC9: the dob_not_allowed refusal is a switch, default off (HFY_GUARD_DOB, stack parameter GuardDob)", () => {
  it("the switch reads only HFY_GUARD_DOB=on", () => {
    expect(guardDobFromEnv({})).toBe(false);
    for (const v of ["off", "", "1", "true", "yes"]) expect(guardDobFromEnv({ HFY_GUARD_DOB: v })).toBe(false);
    for (const v of ["on", "ON", " on "]) expect(guardDobFromEnv({ HFY_GUARD_DOB: v })).toBe(true);
  });
  it("off (the default): a birthday-only text is stored on every path; contact kinds are still refused", async () => {
    const w = makeApi();
    expect((await w.call("POST", "/api/posts", { token: ann, body: { body: BDAY } })).status).toBe(201);
    expect((await w.call("POST", "/api/comments", { token: ann, body: { subject: "person:I0001", body: BDAY } })).status).toBe(201);
    expect((await w.handler.invoke({ id: "I0044", label: "A" }, "posts.create", { body: { body: BDAY, visibility: "draft" } })).status).toBe(201);
    refusedWith(await w.call("POST", "/api/posts", { token: ann, body: { body: `${BDAY}. ${PHONE}` } }), "contact_info", "/body", "phone");
  });
  it("on: a birthday-only text is 422 dob_not_allowed with the birth-year copy on posts, comments and MCP; with contact info too it is contact_info", async () => {
    const w = makeApi({ guardDob: true });
    refusedWith(await w.call("POST", "/api/posts", { token: ann, body: { body: BDAY } }), "dob_not_allowed", "/body", "dob_heuristic");
    refusedWith(await w.call("POST", "/api/comments", { token: ann, body: { subject: "person:I0001", body: BDAY } }), "dob_not_allowed", "/body", "dob_heuristic");
    const e = await w.handler.invoke({ id: "I0044", label: "A" }, "posts.create", { body: { body: BDAY, visibility: "draft" } }).catch((x) => x);
    expect(e).toMatchObject({ status: 422, code: "dob_not_allowed", message: DOB_COPY });
    const mixed = await w.call("POST", "/api/posts", { token: ann, body: { body: `${BDAY}. ${PHONE}` } });
    refusedWith(mixed, "contact_info", "/body");
    expect(mixed.body.errors.map((x) => x.kind).sort()).toEqual(["dob_heuristic", "phone"]);
    expect(stored(w, "POST#")).toEqual([]);
    expect(stored(w, "THREAD#")).toEqual([]);
  });
  it("on, through the mounted MCP server: the tool error is the birth-year copy", async () => {
    const { tool } = mcpWorld({ guardDob: true });
    const r = await tool("hfy_comments_create", { subject: "person:I0001", body: BDAY });
    expect(r).toMatchObject({ isError: true, content: [{ text: DOB_COPY }] });
  });
});

describe("AC3: captured log lines carry counts per code only, never matched text", () => {
  it("every refusal on every path logs {surface, op, counts}; nothing logged quotes the text, an offset or an id", async () => {
    const { api: w, tool, lines } = mcpWorld({ guardDob: true });
    const consoleLines = [];
    const saved = {};
    for (const m of ["log", "info", "warn", "error", "debug"]) { saved[m] = console[m]; console[m] = (...a) => consoleLines.push([m, ...a]); }
    try {
      await w.call("POST", "/api/posts", { token: ann, body: { body: `${PHONE}. ${EMAIL}` } });
      await w.call("POST", "/api/posts", { token: ann, body: { type: "article", title: STREET, body: BDAY } });
      const p = (await w.call("POST", "/api/posts", { token: ann, body: { body: "fine" } })).body;
      await w.call("PATCH", `/api/posts/${p.id}`, { token: ann, body: { body: PHONE } });
      await w.call("POST", "/api/comments", { token: olive, body: { subject: "person:I0001", body: EMAIL } });
      const c = (await w.call("POST", "/api/comments", { token: olive, body: { subject: "person:I0001", body: "nice" } })).body;
      await w.call("PATCH", `/api/comments/${c.id}`, { token: olive, body: { subject: "person:I0001", body: BDAY } });
      await tool("hfy_posts_create", { body: STREET });
      await tool("hfy_comments_create", { subject: "person:I0001", body: PHONE });
    } finally {
      Object.assign(console, saved);
    }
    const guardLines = lines.filter((l) => l[1] === "privacy_guard");
    expect(guardLines.map(([level, , f]) => [level, f.surface, f.op, f.counts])).toEqual([
      ["info", "posts", "create", { contact_info: 2 }],
      ["info", "posts", "create", { contact_info: 1, dob_not_allowed: 1 }],
      ["info", "posts", "update", { contact_info: 1 }],
      ["info", "comments", "create", { contact_info: 1 }],
      ["info", "comments", "update", { dob_not_allowed: 1 }],
      ["info", "posts", "create", { contact_info: 1 }],
      ["info", "comments", "create", { contact_info: 1 }],
    ]);
    for (const [, , f] of guardLines) expect(Object.keys(f).sort()).toEqual(["counts", "op", "surface"]);
    const everything = JSON.stringify([lines, consoleLines]);
    expect(everything).not.toMatch(SECRETS);
    expect(everything).not.toMatch(/"span"|"pointer"/);
    expect(everything).not.toMatch(/her birthday|call me|write to|we live/);
  });
});

describe("AC5, AC6: post attachments are bound to their uploader and checked for location", () => {
  let w;
  beforeEach(() => { w = makeApi(); });
  const presign = async (token = ann, contentType = "image/jpeg") => (await w.call("POST", "/api/uploads", { token, body: { contentType, size: 9 } })).body;
  const att = (up, mime = "image/jpeg") => ({ kind: "image", url: up.publicUrl, mime });
  const create = (attachments, token = ann) => w.call("POST", "/api/posts", { token, body: { body: "a photo", visibility: "published", attachments } });
  const upload = (up) => w.ddb.all().find((i) => i.PK === `UPLOAD#${up.key.split("/")[2]}`);

  it("own upload: 201; the UPLOAD# item records the post and loses its ttl in the same write; the bytes were range-read once", async () => {
    const up = await presign();
    const r = await create([att(up)]);
    expect(r.status).toBe(201);
    expect(upload(up)).toMatchObject({ owner: "I0001", attached: r.body.id });
    expect(upload(up)).not.toHaveProperty("ttl");
    expect(w.s3.gets).toEqual([{ Bucket: "harrisonfamily-frontend", Key: up.key, Range: "bytes=0-262143" }]);
  });
  it("another member's upload: 403 upload_not_owned, nothing stored, the binding untouched (create and edit)", async () => {
    const theirs = await presign(olive);
    const r = await create([att(theirs)]);
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("upload_not_owned");
    expect(stored(w, "POST#")).toEqual([]);
    expect(upload(theirs)).not.toHaveProperty("attached");
    const mine = (await create([])).body;
    const e = await w.call("PATCH", `/api/posts/${mine.id}`, { token: ann, body: { attachments: [att(theirs)] } });
    expect(e.status).toBe(403);
    expect(e.body.error).toBe("upload_not_owned");
    expect(w.s3.gets).toEqual([]); // refused before any byte was read
  });
  it("an upload attaches once; an unknown, expired or retyped upload is refused", async () => {
    const up = await presign();
    expect((await create([att(up)])).status).toBe(201);
    expect((await create([att(up)])).body.error).toBe("upload_not_owned"); // already attached to the first post
    const ghost = { publicUrl: "https://harrisonfamily.us/uploads/posts/01J00000000000000000000000/photo.jpg" };
    expect((await create([att(ghost)])).body.error).toBe("upload_not_owned"); // no UPLOAD# binding
    const old = await presign();
    const item = upload(old);
    w.ddb.rows.set(`${item.PK}\u0000${item.SK}`, { ...item, ttl: Math.floor(Date.now() / 1000) - 1 });
    expect((await create([att(old)])).body.error).toBe("upload_not_owned"); // the 24 h binding lapsed
    const png = await presign(ann, "image/png");
    expect((await create([att(png, "image/jpeg")])).body.error).toBe("upload_missing"); // not the type it was presigned for
    const twice = await presign();
    expect((await create([att(twice), att(twice)])).status).toBe(422); // the same upload twice in one post
  });
  it("a photo carrying location is 400 photo_has_location; an upload that never arrived is 400 upload_missing", async () => {
    const gps = await presign();
    w.s3.objects.set(gps.key, { bytes: jpeg({ exif: tiff({ gps: { lat: SOME_LAT, lon: SOME_LON } }) }), contentType: "image/jpeg" });
    const r = await create([att(gps)]);
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("photo_has_location");
    expect(upload(gps)).not.toHaveProperty("attached");
    const city = await presign();
    w.s3.objects.set(city.key, { bytes: jpeg({ xmp: xmpPacket({ attrs: 'photoshop:City="Example City"' }) }), contentType: "image/jpeg" });
    expect((await create([att(city)])).body.error).toBe("photo_has_location");
    const gone = await presign();
    w.s3.objects.delete(gone.key);
    expect((await create([att(gone)])).body.error).toBe("upload_missing");
    expect(stored(w, "POST#")).toEqual([]);
  });
  it("an edit checks only the attachments it adds; one removed and added back to the same post is accepted", async () => {
    const a = await presign();
    const p = (await create([att(a)])).body;
    const b = await presign();
    expect(w.s3.gets).toHaveLength(1);
    const r = await w.call("PATCH", `/api/posts/${p.id}`, { token: ann, body: { attachments: [att(a), att(b)] } });
    expect(r.status).toBe(200);
    expect(w.s3.gets.map((g) => g.Key)).toEqual([a.key, b.key]); // a was not read again
    expect((await w.call("PATCH", `/api/posts/${p.id}`, { token: ann, body: { attachments: [att(b)] } })).status).toBe(200);
    expect((await w.call("PATCH", `/api/posts/${p.id}`, { token: ann, body: { attachments: [att(a), att(b)] } })).status).toBe(200);
  });
  it("a binding taken between the read and the write cancels the whole post write (403, nothing stored)", async () => {
    const up = await presign();
    let raced = false;
    const racing = makeApi({
      intercept: async (cmd) => {
        if (!raced && cmd.constructor.name === "TransactWriteCommand" && cmd.input.TransactItems.some((t) => t.Update?.Key.PK.startsWith("UPLOAD#"))) {
          raced = true;
          const k = cmd.input.TransactItems.find((t) => t.Update).Update.Key;
          const row = racing.ddb.rows.get(`${k.PK}\u0000${k.SK}`);
          racing.ddb.rows.set(`${k.PK}\u0000${k.SK}`, { ...row, attached: "01J00000000000000000000099" });
        }
      },
    });
    const mine = (await racing.call("POST", "/api/uploads", { token: ann, body: { contentType: "image/jpeg", size: 9 } })).body;
    const r = await racing.call("POST", "/api/posts", { token: ann, body: { body: "x", attachments: [att(mine)] } });
    expect(raced).toBe(true);
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("upload_not_owned");
    expect(racing.ddb.all().filter((i) => i.PK.startsWith("POST#") || i.PK.startsWith("AUDIT#"))).toEqual([]);
    expect(up).toBeTruthy();
  });
});
