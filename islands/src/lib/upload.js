// Photo upload for PostComposer.onUpload: presign via /api/uploads, PUT the bytes straight to S3, return the Attachment record.
// The file's own name is never sent: the API names every upload photo.<ext> (privacy-guard-existing-paths AC6). The fixed
// `filename: "photo"` is for the API deployed before the RG-2 change set, which refuses a presign without one (400 "filename is
// required"); the site ships on merge, ahead of that API, and the new API ignores the field. Drop it once RG-2 is live.
export const UPLOAD_FILENAME = "photo";
export async function uploadPhoto(api, file, fetchImpl) {
  const presigned = await api.post("/uploads", { filename: UPLOAD_FILENAME, contentType: file.type, size: file.size });
  const put = await (fetchImpl || globalThis.fetch)(presigned.uploadUrl, { method: "PUT", headers: { "Content-Type": file.type }, body: file });
  if (!put.ok) throw new Error(`Upload failed (HTTP ${put.status}).`);
  return { kind: "image", url: presigned.publicUrl, mime: file.type };
}
