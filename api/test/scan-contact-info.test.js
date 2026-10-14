// privacy-guard-existing-paths AC4: the one-off read-only scan of existing posts and comments reports counts only. Synthetic data.
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { formatReport, scanExisting, textsOf } from "../scripts/scan-contact-info.mjs";
import { seedPosts } from "../src/content.js";
import { TABLE, cmds, createFakeDdb } from "./world.js";

const T0 = "2026-01-01T00:00:00.000Z";
const post = (n, fields) => ({ id: `01J000000000000000000000${String(n).padStart(2, "0")}`, type: "post", author: { id: "I9001", label: "Test Person" }, body: "x", attachments: [], visibility: "published", created_at: T0, updated_at: T0, ...fields });
const SECRETS = /555-0142|cousin\.ann|example\.org|42 Example|Example Street|May 5|01J0000|I9001|THREAD#|POST#|Test Person/;

async function seeded() {
  const ddb = createFakeDdb();
  await seedPosts({ ddb, cmds, table: TABLE }, [
    post(1, { body: "call 555-0142 after six", subject: "I9001" }),
    post(2, { title: "write to cousin.ann@example.org", body: "her birthday is May 5th" }),
    post(3, { body: "clean", attachments: [{ kind: "image", url: "/uploads/posts/01J00000000000000000000000/photo.jpg", mime: "image/jpeg", alt: "outside 42 Example Street" }] }),
    post(4, { body: "the 1950 reunion" }),
  ]);
  const comment = (n, body) => ({ PK: "THREAD#person:I9001", SK: `C#01J0000000000000000000C${n}00`, GSI1PK: "COMMENTS", GSI1SK: `01J0000000000000000000C${n}00`, entity: "comment", comment: { id: `01J0000000000000000000C${n}00`, threadId: "person:I9001", author: { id: "I9002", label: "Other" }, body, created_at: T0 } });
  for (const c of [comment(1, "lovely"), comment(2, "text me 555-0142"), comment(3, "see you soon")]) await ddb.send(new cmds.PutCommand({ TableName: TABLE, Item: c }));
  return ddb;
}

describe("scan-contact-info.mjs (AC4)", () => {
  it("counts items, items with a hit and hits per kind over posts (body, title, alts) and comments", async () => {
    const ddb = await seeded();
    const before = ddb.calls.length;
    const r = await scanExisting({ ddb, cmds, table: TABLE, pageSize: 2 });
    expect(r.posts).toEqual({ scanned: 4, withHit: 3, kinds: { phone: 1, email: 1, street_address: 1, po_box: 0, contact_url: 0, dob_heuristic: 1 } });
    expect(r.comments).toEqual({ scanned: 3, withHit: 1, kinds: { phone: 1, email: 0, street_address: 0, po_box: 0, contact_url: 0, dob_heuristic: 0 } });
    expect(new Set(ddb.calls.slice(before))).toEqual(new Set(["QueryCommand"])); // read-only: Query and nothing else
    expect(ddb.calls.slice(before).length).toBeGreaterThan(2); // paged (pageSize 2)
  });
  it("the report holds counts only: no text, id, key, handle or label", async () => {
    const out = formatReport(await scanExisting({ ddb: await seeded(), cmds, table: TABLE }), { table: TABLE, at: T0 });
    expect(out).not.toMatch(SECRETS);
    const doc = JSON.parse(out);
    expect(Object.keys(doc).sort()).toEqual(["at", "comments", "posts", "readOnly", "scan", "table"]);
    expect(formatReport({ posts: { scanned: "leak 555-0142", withHit: 1, kinds: { phone: "x" } } }, { table: TABLE })).not.toMatch(SECRETS);
  });
  it("textsOf reads the guarded fields only", () => {
    expect(textsOf("posts", { body: "b", title: "t", subject: "I9001", attachments: [{ alt: "a", url: "/u" }] })).toEqual(["b", "t", "a"]);
    expect(textsOf("comments", { body: "b", threadId: "person:I9001" })).toEqual(["b"]);
    expect(textsOf("posts", null)).toEqual([]);
  });
  it("the CLI refuses unknown arguments before touching AWS", () => {
    const script = fileURLToPath(new URL("../scripts/scan-contact-info.mjs", import.meta.url));
    let err;
    try { execFileSync(process.execPath, [script, "--write"], { stdio: "pipe" }); } catch (e) { err = e; }
    expect(err.status).toBe(1);
    expect(String(err.stderr)).toMatch(/^usage: scan-contact-info\.mjs/);
  });
});
