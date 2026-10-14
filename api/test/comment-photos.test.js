// hfy-comments-photos-desc-api: GET /comments?order=desc, POST /uploads purpose comment, and comment photo attachments (BRD2 9.2, PS-10).
// Every photo is presigned through POST /api/uploads first, so the UPLOAD# binding and the fake bucket (HEAD, then checkLocation) are
// the real ones. All names, text and bytes are synthetic.
import { beforeEach, describe, expect, it } from "vitest";
import { mcpToolsList } from "../src/mcp-caps.js";
import { SOME_LAT, SOME_LON, jpeg, tiff } from "./photo-fixtures.js";
import { makeApi, signToken } from "./world.js";

const SUBJECT = "person:I0001";
const PHONE = "call me on 555-0142 after dinner";
let w, ann, olive;
beforeEach(async () => {
  w = makeApi({ flags: { commentPhotosV1: true } });
  [ann, olive] = await Promise.all(["I0001", "I0002"].map((s) => signToken(s)));
});
const presign = async (token = ann, contentType = "image/jpeg", extra = {}) => {
  const r = await w.call("POST", "/api/uploads", { token, body: { contentType, size: 9, purpose: "comment", ...extra } });
  expect(r.status).toBe(201);
  return r.body;
};
const att = (up, over = {}) => ({ url: up.publicUrl, mime: "image/jpeg", width: 640, height: 480, alt: "a photo", ...over });
const create = (body, token = ann) => w.call("POST", "/api/comments", { token, body: { subject: SUBJECT, ...body } });
const patch = (id, body, token = ann) => w.call("PATCH", `/api/comments/${id}`, { token, body: { subject: SUBJECT, ...body } });
const list = (query, token = ann) => w.call("GET", "/api/comments", { token, query: { subject: SUBJECT, ...query } });
const upload = (up) => w.ddb.all().find((r) => r.PK === `UPLOAD#${up.key.split("/")[2]}`);
const comments = () => w.ddb.all().filter((r) => r.SK.startsWith("C#"));
const audits = () => w.ddb.all().filter((r) => r.PK.startsWith("AUDIT#"));

describe("GET /comments order", () => {
  it("defaults to oldest first, and order=desc returns the same comments newest first", async () => {
    const ids = [];
    for (let i = 0; i < 5; i += 1) ids.push((await create({ body: `c${i}` })).body.id);
    expect((await list({})).body.thread.comments.map((c) => c.id)).toEqual(ids);
    expect((await list({ order: "asc" })).body.thread.comments.map((c) => c.id)).toEqual(ids);
    expect((await list({ order: "desc" })).body.thread.comments.map((c) => c.id)).toEqual([...ids].reverse());
  });

  it("the desc cursor never repeats or skips a row when a comment arrives between pages", async () => {
    const ids = [];
    for (let i = 0; i < 6; i += 1) ids.push((await create({ body: `c${i}` })).body.id);
    const first = await list({ order: "desc", limit: 2 });
    expect(first.body.thread.comments.map((c) => c.id)).toEqual([ids[5], ids[4]]);
    const fresh = (await create({ body: "late" })).body.id;
    const seen = [];
    let cursor = first.body.cursor;
    while (cursor) {
      const page = await list({ order: "desc", limit: 2, cursor });
      seen.push(...page.body.thread.comments.map((c) => c.id));
      cursor = page.body.cursor;
    }
    expect(seen).toEqual([ids[3], ids[2], ids[1], ids[0]]);
    expect(seen).not.toContain(fresh);
    expect((await list({ order: "desc", limit: 1 })).body.thread.comments[0].id).toBe(fresh);
  });

  it("a cursor from the other order is 400 cursor_invalid, both ways, and an unknown order is a validation error", async () => {
    for (let i = 0; i < 3; i += 1) await create({ body: `c${i}` });
    const asc = (await list({ limit: 1 })).body.cursor;
    const desc = (await list({ limit: 1, order: "desc" })).body.cursor;
    for (const q of [{ order: "desc", cursor: asc }, { cursor: desc }, { order: "asc", cursor: desc }]) {
      const r = await list(q);
      expect(r.status).toBe(400);
      expect(r.body.error).toBe("cursor_invalid");
    }
    expect((await list({ order: "desc", limit: 1, cursor: desc })).status).toBe(200);
    expect((await list({ order: "sideways" })).status).toBe(422);
  });

  it("the MCP description and schema carry the optional order", async () => {
    const tool = (await mcpToolsList()).tools.find((t) => t.name === "hfy_comments_list");
    expect(tool.description).toMatch(/oldest first by default; order=desc for newest first/);
    expect(tool.inputSchema.properties.order.enum).toEqual(["asc", "desc"]);
    expect(tool.inputSchema.required).toEqual(["subject"]);
  });
});

describe("POST /uploads purpose comment", () => {
  it("returns uploads/comments/<ulid>/photo.<ext>, ignores the client file name, and writes UPLOAD# {owner, purpose, ttl 24 h}", async () => {
    const up = await presign(ann, "image/png", { filename: "../../Grandma Rose at 12 Example Street.png" });
    expect(up.key).toMatch(/^uploads\/comments\/[0-9A-HJKMNP-TV-Z]{26}\/photo\.png$/);
    expect(up.publicUrl).toMatch(/\/uploads\/comments\/[0-9A-HJKMNP-TV-Z]{26}\/photo\.png$/);
    expect(JSON.stringify(up)).not.toMatch(/Grandma|Example Street/);
    const row = upload(up);
    expect(row).toMatchObject({ owner: "I0001", purpose: "comment", key: up.key, contentType: "image/png" });
    expect(row.attached).toBeUndefined();
    const created = Date.parse(row.created_at) / 1000;
    expect(row.ttl - created).toBeCloseTo(24 * 60 * 60, -1);
  });

  it("rejects HEIC for comments (posts keep it), an unknown purpose, and stays dark without commentPhotosV1", async () => {
    const heic = await w.call("POST", "/api/uploads", { token: ann, body: { contentType: "image/heic", size: 9, purpose: "comment" } });
    expect(heic.status).toBe(400);
    expect(heic.body.error).toBe("validation");
    expect((await w.call("POST", "/api/uploads", { token: ann, body: { contentType: "image/heic", size: 9 } })).body.key).toMatch(/^uploads\/posts\/.*photo\.heic$/);
    expect((await w.call("POST", "/api/uploads", { token: ann, body: { contentType: "image/jpeg", size: 9, purpose: "avatar" } })).status).toBe(400);
    const dark = makeApi();
    const r = await dark.call("POST", "/api/uploads", { token: await signToken("I0001"), body: { contentType: "image/jpeg", size: 9, purpose: "comment" } });
    expect(r.status).toBe(404);
  });
});

describe("comment attachments: create", () => {
  it("takes a photo with text, verifies it with HEAD, attaches the upload to the comment and clears its ttl", async () => {
    const up = await presign();
    const r = await create({ body: "look", attachments: [att(up)] });
    expect(r.status).toBe(201);
    const [a] = r.body.attachments;
    expect(a).toMatchObject({ id: up.key.split("/")[2], kind: "image", mime: "image/jpeg", width: 640, height: 480, alt: "a photo" });
    expect(a.url).toBe(`/${up.key}`);
    expect(w.s3.heads.map((h) => h.Key)).toEqual([up.key]);
    expect(upload(up)).toMatchObject({ attached: r.body.id });
    expect(upload(up).ttl).toBeUndefined();
    expect((await list({})).body.thread.comments[0].attachments).toEqual(r.body.attachments);
  });

  it("accepts a photo-only comment (empty body), and still refuses neither text nor photo", async () => {
    const up = await presign();
    const r = await create({ body: "  ", attachments: [att(up)] });
    expect(r.status).toBe(201);
    expect(r.body.body).toBe("");
    const none = await create({ body: " ", attachments: [] });
    expect(none.status).toBe(422);
    expect(none.body.error).toBe("validation");
  });

  it("a photo comment without a body field is 422 \"body is required\": only an explicit empty string goes with a photo", async () => {
    const up = await presign();
    const before = comments().length;
    for (const over of [{}, { body: null }, { body: 0 }]) {
      const r = await create({ ...over, attachments: [att(up)] });
      expect(r.status, JSON.stringify(over)).toBe(422);
      expect(r.body).toMatchObject({ error: "validation", message: "body is required", details: { field: "body" } });
    }
    expect(comments().length).toBe(before);
    expect(upload(up).attached).toBeUndefined();
  });

  it("takes up to 4 photos, not 5", async () => {
    const four = await Promise.all([1, 2, 3, 4].map(() => presign()));
    expect((await create({ body: "four", attachments: four.map((u) => att(u)) })).status).toBe(201);
    const five = await Promise.all([1, 2, 3, 4, 5].map(() => presign()));
    const r = await create({ body: "five", attachments: five.map((u) => att(u)) });
    expect(r.status).toBe(422);
    expect(r.body.details.field).toBe("attachments");
    expect(upload(five[0]).attached).toBeUndefined();
  });

  it("another member's upload is 403 upload_not_owned; so is an upload already attached, an expired one, and a post upload", async () => {
    const mine = await presign(olive);
    const stolen = await create({ body: "x", attachments: [att(mine)] });
    expect(stolen.status).toBe(403);
    expect(stolen.body.error).toBe("upload_not_owned");
    expect(comments()).toHaveLength(0);
    const own = await presign();
    expect((await create({ body: "once", attachments: [att(own)] })).status).toBe(201);
    expect((await create({ body: "twice", attachments: [att(own)] })).body.error).toBe("upload_not_owned");
    const old = await presign();
    const item = upload(old);
    w.ddb.rows.set(`${item.PK}\u0000${item.SK}`, { ...item, ttl: Math.floor(Date.now() / 1000) - 1 });
    expect((await create({ body: "late", attachments: [att(old)] })).body.error).toBe("upload_not_owned");
    const post = (await w.call("POST", "/api/uploads", { token: ann, body: { contentType: "image/jpeg", size: 9 } })).body;
    expect((await create({ body: "p", attachments: [att(post)] })).status).toBe(422); // not an uploads/comments url
  });

  it("an attach that races another comment cancels the whole write: 403, no comment", async () => {
    let armed = null;
    const racing = makeApi({ flags: { commentPhotosV1: true }, intercept: async (cmd) => {
      if (armed && cmd.constructor.name === "TransactWriteCommand") racing.ddb.rows.set(`${armed.PK}\u0000${armed.SK}`, { ...armed, attached: "01J00000000000000000000009" });
    } });
    const token = await signToken("I0001");
    const up = (await racing.call("POST", "/api/uploads", { token, body: { contentType: "image/jpeg", size: 9, purpose: "comment" } })).body;
    armed = racing.ddb.all().find((r) => r.PK === `UPLOAD#${up.key.split("/")[2]}`);
    const r = await racing.call("POST", "/api/comments", { token, body: { subject: SUBJECT, body: "race", attachments: [att(up)] } });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("upload_not_owned");
    expect(racing.ddb.all().filter((x) => x.SK.startsWith("C#"))).toHaveLength(0);
  });

  it("400 upload_missing when HEAD answers 404 or the stored type does not match, and nothing is attached", async () => {
    const gone = await presign();
    w.s3.objects.delete(gone.key);
    const r = await create({ body: "x", attachments: [att(gone)] });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("upload_missing");
    const png = await presign(ann, "image/png");
    expect((await create({ body: "x", attachments: [att(png, { mime: "image/jpeg" })] })).body.error).toBe("upload_missing"); // declared type differs
    const swapped = await presign();
    w.s3.objects.set(swapped.key, { ...w.s3.objects.get(swapped.key), contentType: "image/png" });
    expect((await create({ body: "x", attachments: [att(swapped)] })).body.error).toBe("upload_missing"); // stored type differs
    const big = await presign();
    w.s3.objects.set(big.key, { ...w.s3.objects.get(big.key), size: 10 * 1024 * 1024 + 1 });
    expect((await create({ body: "x", attachments: [att(big)] })).body.error).toBe("upload_missing");
    expect(comments()).toHaveLength(0);
    expect(upload(gone).attached).toBeUndefined();
  });

  it("a stored photo carrying GPS is 400 photo_has_location and attaches nothing", async () => {
    const up = await presign();
    w.s3.objects.set(up.key, { bytes: jpeg({ exif: tiff({ gps: { lat: SOME_LAT, lon: SOME_LON } }) }), contentType: "image/jpeg" });
    const r = await create({ body: "x", attachments: [att(up)] });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("photo_has_location");
    expect(comments()).toHaveLength(0);
    expect(upload(up).attached).toBeUndefined();
  });

  it("runs the shared contact guard on body and every alt (422, nothing stored, the text never echoed)", async () => {
    const up = await presign();
    const bad = await create({ body: "fine", attachments: [att(up, { alt: PHONE })] });
    expect(bad.status).toBe(422);
    expect(bad.body.error).toBe("contact_info");
    expect(bad.body.errors[0].pointer).toBe("/attachments/0/alt");
    expect(JSON.stringify(bad.body)).not.toMatch(/555-0142/);
    const photoOnly = await create({ body: PHONE, attachments: [att(up)] });
    expect(photoOnly.body.errors[0].pointer).toBe("/body");
    expect(comments()).toHaveLength(0);
  });

  it("validates url, mime, size fields, and is dark without commentPhotosV1", async () => {
    const up = await presign();
    for (const over of [{ url: "https://evil.example/uploads/comments/01J00000000000000000000000/photo.jpg" }, { url: "javascript:alert(1)" }, { mime: "image/heic" }, { width: 0 }, { height: 100001 }, { width: 1.5 }, { alt: "x".repeat(501) }]) {
      const r = await create({ body: "x", attachments: [att(up, over)] });
      expect(r.status, JSON.stringify(over)).toBe(422);
    }
    const dark = makeApi();
    const t = await signToken("I0001");
    const r = await dark.call("POST", "/api/comments", { token: t, body: { subject: SUBJECT, body: "x", attachments: [] } });
    expect(r.status).toBe(404);
    expect((await dark.call("POST", "/api/comments", { token: t, body: { subject: SUBJECT, body: "plain" } })).status).toBe(201);
  });
});

describe("comment attachments: edit", () => {
  let made, first, second;
  beforeEach(async () => {
    first = await presign();
    second = await presign();
    made = (await create({ body: "caption", attachments: [att(first), att(second, { alt: "second" })] })).body;
  });

  it("can remove photos and change alt, keeping the ids, with one audit entry carrying before and after", async () => {
    const before = audits().length;
    const r = await patch(made.id, { body: "caption", attachments: [att(first, { alt: "better words" })] });
    expect(r.status).toBe(200);
    expect(r.body.attachments).toHaveLength(1);
    expect(r.body.attachments[0]).toMatchObject({ id: made.attachments[0].id, alt: "better words" });
    expect(r.body.edited_at).toBeTruthy();
    expect(audits().length).toBe(before + 1);
    const none = await patch(made.id, { body: "caption", attachments: [] });
    expect(none.status).toBe(200);
    expect(none.body.attachments).toBeUndefined();
  });

  it("the same body and photos is a no-op with no audit entry; an omitted attachments field leaves them", async () => {
    const before = audits().length;
    const same = await patch(made.id, { body: " caption ", attachments: made.attachments.map((a) => ({ ...a, url: a.url })) });
    expect(same.status).toBe(200);
    expect(same.body.edited_at).toBeUndefined();
    const omitted = await patch(made.id, { body: "caption" });
    expect(omitted.body.edited_at).toBeUndefined();
    expect(audits().length).toBe(before);
    const words = await patch(made.id, { body: "new words" });
    expect(words.body.attachments).toHaveLength(2);
  });

  it("a PATCH that leaves out body, or sends a non-string one, is 422 \"body is required\" and keeps the text, photos and audit trail", async () => {
    const before = audits().length;
    for (const edit of [{}, { attachments: [att(first, { alt: "new alt" })] }, { body: null }, { body: 7, attachments: made.attachments }]) {
      const r = await patch(made.id, edit);
      expect(r.status, JSON.stringify(edit)).toBe(422);
      expect(r.body).toMatchObject({ error: "validation", message: "body is required", details: { field: "body" } });
    }
    const [row] = comments().filter((c) => c.comment?.id === made.id);
    expect(row.comment.body).toBe("caption");
    expect(row.comment.attachments).toEqual(made.attachments);
    expect(row.comment.edited_at).toBeUndefined();
    expect(audits().length).toBe(before);
  });

  it("with commentPhotosV1 off, a PATCH without body still cannot wipe a photo comment's text", async () => {
    let flags = { commentPhotosV1: true };
    const sw = makeApi({ flags: () => Promise.resolve(flags) });
    const t = await signToken("I0001");
    const up = (await sw.call("POST", "/api/uploads", { token: t, body: { contentType: "image/jpeg", size: 9, purpose: "comment" } })).body;
    const c = (await sw.call("POST", "/api/comments", { token: t, body: { subject: SUBJECT, body: "hello", attachments: [att(up)] } })).body;
    flags = { commentPhotosV1: false };
    const r = await sw.call("PATCH", `/api/comments/${c.id}`, { token: t, body: { subject: SUBJECT } });
    expect(r.status).toBe(422);
    expect(r.body.message).toBe("body is required");
    expect(sw.ddb.all().find((i) => i.comment?.id === c.id).comment.body).toBe("hello");
  });

  it("cannot add a photo: your own fresh upload is 422, another member's key is 403 upload_not_owned, and nothing attaches", async () => {
    const mine = await presign();
    const add = await patch(made.id, { body: "caption", attachments: [...made.attachments, att(mine)] });
    expect(add.status).toBe(422);
    expect(upload(mine).attached).toBeUndefined();
    const theirs = await presign(olive);
    const foreign = await patch(made.id, { body: "caption", attachments: [...made.attachments, att(theirs)] });
    expect(foreign.status).toBe(403);
    expect(foreign.body.error).toBe("upload_not_owned");
  });

  it("a photo-only comment can be edited with an empty body but not stripped of its only photo; alt runs the guard", async () => {
    const up = await presign();
    const only = (await create({ body: "", attachments: [att(up)] })).body;
    expect((await patch(only.id, { body: "" })).body.edited_at).toBeUndefined();
    const stripped = await patch(only.id, { body: "", attachments: [] });
    expect(stripped.status).toBe(422);
    const guarded = await patch(made.id, { body: "caption", attachments: [att(first, { alt: PHONE })] });
    expect(guarded.status).toBe(422);
    expect(guarded.body.error).toBe("contact_info");
  });
});
