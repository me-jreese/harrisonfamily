// Presigned S3 PUT for member uploads (HFY-R58 (2)). Kept apart from index.js so tests can sign offline with fake credentials.
//  - content-type is SIGNED: the S3 presigner marks it unsignable by default, which would let the uploader store any
//    Content-Type (text/html) under an image key. signableHeaders forces it into X-Amz-SignedHeaders, so S3 rejects a PUT
//    whose Content-Type differs from the validated image type.
//  - checksums are WHEN_REQUIRED: the SDK default (WHEN_SUPPORTED) signs x-amz-checksum-crc32 of an EMPTY body into the URL,
//    so every real upload fails with 400 BadDigest.
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

/** S3 client options for presigning (exported for tests). */
export const PRESIGN_CLIENT_OPTIONS = Object.freeze({ requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED" });

/**
 * Returns `presignPut({ bucket, key, contentType, size, expiresIn, checksumSha256? }) => url`. `clientOptions` (region, credentials) is for tests.
 * `checksumSha256` (the base64 SHA-256 of the body, HFY-TSK-173) is signed too and sent as the `x-amz-checksum-sha256` header, never hoisted
 * into the query string, so S3 refuses a PUT whose bytes do not hash to it (the desktop sync's blob upload, sync.md 9).
 */
export function createPresignPut(clientOptions = {}) {
  const s3 = new S3Client({ ...clientOptions, ...PRESIGN_CLIENT_OPTIONS });
  return ({ bucket, key, contentType, size, expiresIn, checksumSha256 }) =>
    getSignedUrl(s3, new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType, ContentLength: size, ...(checksumSha256 ? { ChecksumSHA256: checksumSha256 } : {}) }), {
      expiresIn,
      signableHeaders: new Set(["content-type", "content-length", ...(checksumSha256 ? ["x-amz-checksum-sha256"] : [])]),
      ...(checksumSha256 ? { unhoistableHeaders: new Set(["x-amz-checksum-sha256"]) } : {}),
    });
}
