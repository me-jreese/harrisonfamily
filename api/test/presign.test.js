// HFY-R58 (2): the real AWS SDK presigner, run offline with fake credentials (signing is local; nothing is sent).
import { describe, expect, it } from "vitest";
import { createPresignPut, PRESIGN_CLIENT_OPTIONS } from "../src/presign.js";
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
