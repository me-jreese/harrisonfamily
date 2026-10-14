// HFY-TSK-186: lib/follow.js, the record-follow client and its copy (node, no browser).
import test from "node:test";
import assert from "node:assert/strict";
import { FOLLOW_COPY, HELPER_KEY, PAGE_SIZE, follow, getFollowing, helperSeen, listFollows, markHelperSeen, personIdOf, subjectFor, unfollow } from "../src/lib/follow.js";

const recorder = (responses = {}) => {
  const calls = [];
  const api = {
    get: async (path, opts) => { calls.push(["get", path, opts]); return responses.get; },
    put: async (path, body) => { calls.push(["put", path, body]); return responses.put; },
    del: async (path) => { calls.push(["del", path]); return responses.del; },
  };
  return { api, calls };
};

test("subjects and ids round-trip", () => {
  assert.equal(subjectFor("I9001"), "person:I9001");
  assert.equal(personIdOf("person:I9001"), "I9001");
  assert.equal(personIdOf("post:abc") , null);
  assert.equal(personIdOf(undefined), null);
});

test("getFollowing asks the subject and reads subscribed strictly", async () => {
  const { api, calls } = recorder({ get: { subject: "person:I9001", subscribed: true } });
  assert.equal(await getFollowing("I9001", api), true);
  assert.deepEqual(calls[0], ["get", "/subscriptions", { query: { subject: "person:I9001" } }]);
  assert.equal(await getFollowing("I9001", recorder({ get: { subscribed: "yes" } }).api), false);
});

test("follow sends a JSON body (the 415 rule); unfollow is a DELETE; ids are encoded", async () => {
  const { api, calls } = recorder();
  await follow("I9001", api);
  await unfollow("I9001", api);
  assert.deepEqual(calls, [["put", "/subscriptions/person/I9001", {}], ["del", "/subscriptions/person/I9001"]]);
  const enc = recorder();
  await follow("a b", enc.api);
  assert.equal(enc.calls[0][1], "/subscriptions/person/a%20b");
});

test("listFollows maps items to ids, drops bad subjects and passes cursor and limit", async () => {
  const { api, calls } = recorder({ get: { items: [{ subject: "person:I9020", created_at: "2026-01-01" }, { subject: "junk" }], cursor: "abc" } });
  const page = await listFollows({ cursor: "c1" }, api);
  assert.deepEqual(page, { items: [{ id: "I9020", createdAt: "2026-01-01" }], cursor: "abc" });
  assert.deepEqual(calls[0][2], { query: { cursor: "c1", limit: PAGE_SIZE } });
  assert.deepEqual(await listFollows({}, recorder({ get: { items: [], cursor: null } }).api), { items: [], cursor: null });
  assert.deepEqual(await listFollows({}, recorder({ get: null }).api), { items: [], cursor: null });
});

test("the helper flag survives a missing or throwing storage", () => {
  const mem = new Map();
  const ok = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
  assert.equal(helperSeen(ok), false);
  markHelperSeen(ok);
  assert.equal(mem.get(HELPER_KEY), "1");
  assert.equal(helperSeen(ok), true);
  const bad = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
  assert.equal(helperSeen(bad), false);
  assert.doesNotThrow(() => markHelperSeen(bad));
});

test("copy is lowercase voice with 'page', never 'record'", () => {
  for (const v of Object.values(FOLLOW_COPY)) { assert.equal(v[0], v[0].toLowerCase()); assert.ok(!/record/i.test(v)); }
});
