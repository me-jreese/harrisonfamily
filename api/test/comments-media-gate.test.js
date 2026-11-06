// HFY-TSK-389-0A (P4-R32): a comments thread whose subject starts with media: is dark (404 not_found) until mediaCommentsV1 is on. Synthetic ids only.
import { describe, expect, it } from "vitest";
import { makeApi, signToken } from "./world.js";

const MEDIA = "media:O0001";
const PERSON = "person:I0001";

async function setup(flags) {
  const w = makeApi({ flags });
  const token = await signToken("I0001");
  return { w, token };
}
const calls = (w, token, subject) => ({
  list: () => w.call("GET", "/api/comments", { token, query: { subject } }),
  create: () => w.call("POST", "/api/comments", { token, body: { subject, body: "a comment" } }),
  update: () => w.call("PATCH", "/api/comments/01JZZZZZZZZZZZZZZZZZZZ0001", { token, body: { subject, body: "edited" } }),
  delete: () => w.call("DELETE", "/api/comments/01JZZZZZZZZZZZZZZZZZZZ0001", { token, query: { subject } }),
  react: () => w.call("POST", "/api/comments/01JZZZZZZZZZZZZZZZZZZZ0001/react", { token, body: { subject, emoji: "👍" } }),
});

describe("mediaCommentsV1 gate on the comments routes", () => {
  for (const op of ["list", "create", "update", "delete", "react"]) {
    it(`flag off: ${op} on a media: thread is 404 not_found`, async () => {
      const { w, token } = await setup({});
      const r = await calls(w, token, MEDIA)[op]();
      expect(r.status).toBe(404);
      expect(r.body.error).toBe("not_found");
      expect(r.body.message).toBe("no such thread");
    });
  }

  it("flag off: nothing is written for a media: thread", async () => {
    const { w, token } = await setup({});
    await calls(w, token, MEDIA).create();
    expect(w.ddb.all().filter((r) => r.SK.startsWith("C#"))).toEqual([]);
  });

  it("flag on: the media: thread falls through to the source's own visibility rule (a Media that is not public is still not_found, fail closed)", async () => {
    const { w, token } = await setup({ mediaCommentsV1: true });
    const r = await calls(w, token, MEDIA).list();
    expect(r.status).toBe(404);
    expect(r.body.message).toBe("no such thread"); // the source's refusal, not the gate's (which says the same, so check no write either)
    expect(w.ddb.all().filter((x) => x.SK.startsWith("C#"))).toEqual([]);
  });

  it("flag on: a person: thread works as before, and with the flag off too", async () => {
    for (const flags of [{}, { mediaCommentsV1: true }]) {
      const { w, token } = await setup(flags);
      const made = await calls(w, token, PERSON).create();
      expect(made.status).toBe(201);
      expect((await calls(w, token, PERSON).list()).body.thread.comments).toHaveLength(1);
    }
  });
});
