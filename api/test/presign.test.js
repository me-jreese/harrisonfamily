// HFY-R58 (2): the real AWS SDK presigner, run offline with fake credentials (signing is local; nothing is sent).
import { describe, expect, it } from "vitest";
import { createPresignGet, createPresignPut, PRESIGN_CLIENT_OPTIONS } from "../src/presign.js";
import { UPLOAD_EXPIRES_SECONDS, UPLOAD_PREFIX } from "../src/uploads.js";

const presignPut = createPresignPut({
  region: "us-west-2",
  credentials: { accessKeyId: "AKIDEXAMPLETEST", secretAccessKey: "test-secret-not-a-real-key-000000000000" },
});
const key = `${UPLOAD_PREFIX}/01J00000000000000000000000/garden.jpg`;
const sign = async (contentType = "image/jpeg", size = 2048) =>
  new URL(await presignPut({ bucket: "harrisonfamily-frontend", key, contentType, size, expiresIn: UPLOAD_EXPIRES_SECONDS }));

describe("presigned upload PUT (real SDK presigner)", () => {
  it("signs content-type (and content-length), so S3 rejects a PUT stored as text/html", async () => {
    const u = await sign();
    const signed = u.searchParams.get("X-Amz-SignedHeaders").split(";");
    expect(signed).toEqual(expect.arrayContaining(["content-type", "content-length", "host"]));
    // The signature depends on the content type: a URL issued for image/jpeg is not valid for text/html.
    const jpeg = u.searchParams.get("X-Amz-Signature");
    const html = (await sign("text/html")).searchParams.get("X-Amz-Signature");
    expect(jpeg).not.toBe(html);
  });

  it("carries no x-amz-checksum-* / sdk checksum params (an empty-body CRC32 would make every real upload 400 BadDigest)", async () => {
    const u = await sign();
    const names = [...u.searchParams.keys()].map((k) => k.toLowerCase());
    expect(names.filter((k) => k.startsWith("x-amz-checksum") || k === "x-amz-sdk-checksum-algorithm")).toEqual([]);
    expect(PRESIGN_CLIENT_OPTIONS.requestChecksumCalculation).toBe("WHEN_REQUIRED");
  });

  it("PUTs straight to the bucket's S3 endpoint, never to the site (CloudFront) host, so the members-only /uploads/* gate never sees an upload", async () => {
    const u = await sign();
    expect(u.hostname).toBe("harrisonfamily-frontend.s3.us-west-2.amazonaws.com");
    expect(u.hostname).not.toBe("harrisonfamily.us");
    expect(u.protocol).toBe("https:");
  });

  it("targets the uploads/posts key with the short expiry", async () => {
    const u = await sign();
    expect(decodeURIComponent(u.pathname)).toMatch(new RegExp(`/${key}$`));
    expect(u.searchParams.get("X-Amz-Expires")).toBe(String(UPLOAD_EXPIRES_SECONDS));
  });
});

describe("presigned upload PUT with a signed SHA-256 (HFY-TSK-173, sync.md 9)", () => {
  const b64 = Buffer.alloc(32, 7).toString("base64");
  const signWith = async (checksumSha256) =>
    new URL(await presignPut({ bucket: "harrisonfamily-frontend", key: "media/.staging/abc/def", contentType: "image/jpeg", size: 2048, expiresIn: 300, checksumSha256 }));

  it("signs x-amz-checksum-sha256 as a header the client must send, and keeps it out of the query string", async () => {
    const u = await signWith(b64);
    expect(u.searchParams.get("X-Amz-SignedHeaders").split(";")).toEqual(expect.arrayContaining(["content-type", "content-length", "host", "x-amz-checksum-sha256"]));
    expect([...u.searchParams.keys()].map((k) => k.toLowerCase()).filter((k) => k === "x-amz-checksum-sha256" || k === "x-amz-sdk-checksum-algorithm")).toEqual([]);
  });

  it("the signature depends on the checksum, and a call without one is unchanged", async () => {
    const other = Buffer.alloc(32, 9).toString("base64");
    expect((await signWith(b64)).searchParams.get("X-Amz-Signature")).not.toBe((await signWith(other)).searchParams.get("X-Amz-Signature"));
    expect((await signWith(undefined)).searchParams.get("X-Amz-SignedHeaders")).not.toContain("x-amz-checksum-sha256");
  });
});

describe("createPresignGet (HFY-TSK-174, the sync pull routes)", () => {
  const presignGet = createPresignGet({ region: "us-west-2", credentials: { accessKeyId: "AKIDEXAMPLETEST", secretAccessKey: "test-secret-not-a-real-key-000000000000" } });
  it("signs a GET for the key with the expiry, and the response content type when given", async () => {
    const u = new URL(await presignGet({ bucket: "sync-bucket.test", key: "snapshots/7.jsonl.gz", expiresIn: 300, contentType: "application/gzip" }));
    expect(u.pathname.endsWith("/snapshots/7.jsonl.gz")).toBe(true);
    expect(u.searchParams.get("X-Amz-Expires")).toBe("300");
    expect(u.searchParams.get("response-content-type")).toBe("application/gzip");
    expect(new URL(await presignGet({ bucket: "sync-bucket.test", key: "snapshots/7.jsonl.gz", expiresIn: 300 })).searchParams.has("response-content-type")).toBe(false);
  });
});
