// HFY-TSK-315: a post is a line, a photo, or both. validateBody accepts an empty or whitespace body while the post holds at least
// one attachment, still answers validation "body is required" when it has neither, and keeps MAX_BODY. The kit half is
// @io-kit/content 0.3.1 (PostComposer submits a photo with an empty body; the contract's CS-19 runs in contracts.test.js).
import { beforeEach, describe, expect, it } from "vitest";
import { MAX_BODY } from "../src/content.js";
import { UPLOAD_PHOTO, makeApi, signToken } from "./world.js";

let w, ann, olive;
beforeEach(async () => {
  w = makeApi();
  [ann, olive] = await Promise.all(["I0001", "I0002"].map((s) => signToken(s)));
});
const create = (body) => w.call("POST", "/api/posts", { token: ann, body: { visibility: "published", ...body } });
const patch = (id, body) => w.call("PATCH", `/api/posts/${id}`, { token: ann, body });
const posts = () => w.ddb.all().filter((r) => r.PK.startsWith("POST#"));
const audits = () => w.ddb.all().filter((r) => r.PK.startsWith("AUDIT#"));
const bodyRequired = (r) => {
  expect(r.status).toBe(422);
  expect(r.body).toMatchObject({ error: "validation", message: "body is required", details: { field: "body" } });
};

describe("photo-only posts: create (HFY-TSK-315)", () => {
  it("an empty body with one photo is a post: 201, stored with body \"\" and its photo, listed to others as just the photo", async () => {
    const r = await create({ body: "", subject: "I0001", attachments: [UPLOAD_PHOTO] });
    expect(r.status).toBe(201);
    expect(r.body.body).toBe("");
    expect(r.body.attachments).toEqual([UPLOAD_PHOTO]);
    const seen = (await w.call("GET", "/api/posts", { token: olive, query: { subject: "I0001" } })).body.items;
    expect(seen.map((p) => [p.id, p.body, p.attachments[0].alt])).toEqual([[r.body.id, "", "a photo"]]);
  });

  it("a whitespace-only body with a photo is accepted as written", async () => {
    const r = await create({ body: " \n\t ", attachments: [UPLOAD_PHOTO] });
    expect(r.status).toBe(201);
    expect(r.body.body).toBe(" \n\t ");
  });

  it("neither a body nor a photo is still 422 validation \"body is required\" and stores nothing", async () => {
    const before = w.ddb.all().length;
    for (const b of [{ body: "" }, { body: "   " }, { body: "", attachments: [] }, { body: "\n", attachments: [] }, {}]) {
      bodyRequired(await create(b));
    }
    expect(w.ddb.all().length).toBe(before);
  });

  it("only a real member upload stands in for the body: a junk or foreign attachment is validation on attachments", async () => {
    const before = w.ddb.all().length;
    for (const a of [{}, null, { ...UPLOAD_PHOTO, url: "javascript:alert(1)" }, { ...UPLOAD_PHOTO, url: "https://evil.example/x.png" }]) {
      const r = await create({ body: "", attachments: [a] });
      expect(r.status, JSON.stringify(a)).toBe(422);
      expect(r.body).toMatchObject({ error: "validation", details: { field: "attachments" } });
    }
    expect(w.ddb.all().length).toBe(before);
  });

  it("a body that is not a string is \"body is required\", photo or not", async () => {
    for (const body of [null, 7, ["x"], { text: "x" }]) bodyRequired(await create({ body, attachments: [UPLOAD_PHOTO] }));
    expect(posts()).toHaveLength(0);
  });

  it(`MAX_BODY (${MAX_BODY} characters) still applies with a photo: at the limit is 201, one over is 422 "body too long"`, async () => {
    expect((await create({ body: "a".repeat(MAX_BODY), attachments: [UPLOAD_PHOTO] })).status).toBe(201);
    for (const attachments of [[UPLOAD_PHOTO], []]) {
      const r = await create({ body: "a".repeat(MAX_BODY + 1), attachments });
      expect(r.status).toBe(422);
      expect(r.body).toMatchObject({ error: "validation", message: "body too long", details: { field: "body" } });
    }
  });
});

describe("photo-only posts: edit (HFY-TSK-315)", () => {
  it("the author can empty a photo post's body or blank it with whitespace", async () => {
    const p = (await create({ body: "the garden", attachments: [UPLOAD_PHOTO] })).body;
    const r = await patch(p.id, { body: "" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ body: "", attachments: [UPLOAD_PHOTO] });
    expect((await patch(p.id, { body: "  " })).status).toBe(200);
  });

  it("removing the last photo of a photo-only post is \"body is required\" and leaves the post and the audit trail as they were", async () => {
    const p = (await create({ body: "", attachments: [UPLOAD_PHOTO] })).body;
    const trail = audits().length;
    bodyRequired(await patch(p.id, { attachments: [] }));
    bodyRequired(await patch(p.id, { body: " ", attachments: [] }));
    const r = await patch(p.id, { attachments: [{}] });
    expect(r.status).toBe(422);
    expect(r.body.details).toEqual({ field: "attachments" });
    expect((await w.call("GET", `/api/posts/${p.id}`, { token: ann })).body).toMatchObject({ body: "", attachments: [UPLOAD_PHOTO] });
    expect(audits().length).toBe(trail);
  });

  it("a text post's body can be emptied in the same edit that adds a photo, but not on its own", async () => {
    const p = (await create({ body: "a line" })).body;
    bodyRequired(await patch(p.id, { body: "" }));
    const r = await patch(p.id, { body: "", attachments: [UPLOAD_PHOTO] });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ body: "", attachments: [UPLOAD_PHOTO] });
  });

  it("an edit that leaves the body alone (title only) still works on a photo-only post", async () => {
    const p = (await create({ body: "", attachments: [UPLOAD_PHOTO] })).body;
    const r = await patch(p.id, { title: "summer" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ title: "summer", body: "", attachments: [UPLOAD_PHOTO] });
  });

  it(`MAX_BODY applies to an edit of a photo post: ${MAX_BODY + 1} characters is 422 "body too long"`, async () => {
    const p = (await create({ body: "", attachments: [UPLOAD_PHOTO] })).body;
    const r = await patch(p.id, { body: "a".repeat(MAX_BODY + 1) });
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ error: "validation", message: "body too long", details: { field: "body" } });
  });
});
