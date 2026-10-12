// AC1 (offline half): the kit contract suites run against the real stores over the in-memory DynamoDB fake.
import { describe, it } from "vitest";
import { registerContentContract, FIXTURE_POSTS } from "@io-kit/content/testing";
import { registerCommentContract } from "@io-kit/comments/testing";
import { createContentSource, seedPosts } from "../src/content.js";
import { createCommentSource } from "../src/comments.js";
import { TABLE, cmds, createFakeDdb, createUlidFactory, ticker, ulidTime } from "./world.js";

const api = { describe, it: (name, fn) => it(name, fn) };

registerContentContract(
  {
    async make() {
      const ddb = createFakeDdb();
      await seedPosts({ ddb, cmds, table: TABLE }, FIXTURE_POSTS);
      const now = ticker(Math.max(0, ...FIXTURE_POSTS.map((p) => ulidTime(p.id))));
      const ulid = createUlidFactory();
      const audit = [];
      return { audit, as: (actor) => createContentSource({ ddb, cmds, table: TABLE, actor, now, ulid, uid: () => ulid(now()), audit: (e) => void audit.push(e) }) };
    },
    author: { id: "I0001", label: "Ann Author" },
    other: { id: "I0002", label: "Olive Other" },
    admin: { id: "I0099", label: "Admin", admin: true },
  },
  api,
  "hfy posts (CS) over DynamoDB fake",
);

const roles = (id, label, r) => ({ id, label, ...(r ? { roles: r } : {}) });
registerCommentContract(
  {
    async make() {
      const ddb = createFakeDdb();
      const now = ticker();
      const ulid = createUlidFactory();
      const audit = [];
      return { audit, as: (viewer) => createCommentSource({ ddb, cmds, table: TABLE, viewer, now, ulid, uid: () => ulid(now()), maxLength: 1000, audit: (e) => void audit.push(e) }) };
    },
    threadId: "person:I0001",
    author: roles("I0003", "Ann Author"),
    other: roles("I0004", "Olive Other"),
    admin: roles("I0099", "Admin", ["admin"]),
    reader: roles("I0005", "Rita Reader", ["reader"]),
    maxLength: 1000,
    features: { reactions: true },
  },
  api,
  "hfy comments (CC) over DynamoDB fake",
);
