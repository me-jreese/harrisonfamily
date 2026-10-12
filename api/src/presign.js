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

/** Returns `presignPut({ bucket, key, contentType, size, expiresIn }) => url`. `clientOptions` (region, credentials) is for tests. */
export function createPresignPut(clientOptions = {}) {
  const s3 = new S3Client({ ...clientOptions, ...PRESIGN_CLIENT_OPTIONS });
  return ({ bucket, key, contentType, size, expiresIn }) =>
    getSignedUrl(s3, new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType, ContentLength: size }), {
      expiresIn,
      signableHeaders: new Set(["content-type", "content-length"]),
    });
}
