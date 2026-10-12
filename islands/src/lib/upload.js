// Photo upload for PostComposer.onUpload: presign via /api/uploads, PUT the bytes straight to S3, return the Attachment record.
export async function uploadPhoto(api, file, fetchImpl) {
  const presigned = await api.post("/uploads", { filename: file.name || "photo", contentType: file.type, size: file.size });
  const put = await (fetchImpl || globalThis.fetch)(presigned.uploadUrl, { method: "PUT", headers: { "Content-Type": file.type }, body: file });
  if (!put.ok) throw new Error(`Upload failed (HTTP ${put.status}).`);
  return { kind: "image", url: presigned.publicUrl, mime: file.type };
}
