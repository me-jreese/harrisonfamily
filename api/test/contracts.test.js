// AC1 (offline half): the kit contract suites run against the real stores over the in-memory DynamoDB fake.
import { describe, it } from "vitest";
import { registerContentContract, FIXTURE_POSTS } from "@io-kit/content/testing";
import { registerCommentContract } from "@io-kit/comments/testing";
import { createContentSource, seedPosts } from "../src/content.js";
import { createCommentSource } from "../src/comments.js";
import { TABLE, UPLOAD_PHOTO, contractPhotos, bindUploadPhoto, checkUploadPhoto, cmds, createFakeDdb, createUlidFactory, ticker, ulidTime } from "./world.js";

// @io-kit/content 0.1.1+ reports a case the host cannot run (a capability it does not declare) through `skip`, so it shows as skipped, never as passed.
const api = { describe, it: (name, fn) => it(name, fn), skip: (name, fn) => it.skip(name, fn) };

registerContentContract(
  {
    async make() {
      const ddb = createFakeDdb();
      await seedPosts({ ddb, cmds, table: TABLE }, FIXTURE_POSTS);
      const now = ticker(Math.max(0, ...FIXTURE_POSTS.map((p) => ulidTime(p.id))));
      const ulid = createUlidFactory();
      const audit = [];
      await bindUploadPhoto(ddb, "I0001", now()); // CS-19's photo is the author's own unattached upload (privacy-guard-existing-paths)
      return { audit, as: (actor) => createContentSource({ ddb, cmds, table: TABLE, actor, now, ulid, uid: () => ulid(now()), audit: (e) => void audit.push(e), checkUpload: checkUploadPhoto }) };
    },
    author: { id: "I0001", label: "Ann Author" },
    other: { id: "I0002", label: "Olive Other" },
    admin: { id: "I0099", label: "Admin", admin: true },
    // CS-19 (photo-only posts) posts an image: the store only takes the author's own member upload, not the kit's example.test url.
    photo: UPLOAD_PHOTO,
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
      return { audit, as: (viewer) => createCommentSource({ ddb, cmds, table: TABLE, viewer, now, ulid, uid: () => ulid(now()), maxLength: 1000, audit: (e) => void audit.push(e), photos: contractPhotos /* test-only policy; the production UPLOAD#/HEAD binding is covered over HTTP in comment-photos.test.js */ }) };
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
