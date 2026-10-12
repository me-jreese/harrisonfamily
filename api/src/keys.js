// Single-table key layout for hfy-app (documented in api/README.md).
export const GSI1 = "GSI1";
export const postKeys = (id) => ({ PK: `POST#${id}`, SK: "META" });
export const commentKeys = (id) => ({ PK: `COMMENT#${id}`, SK: "META" });
export const auditKeys = (recordId, sk) => ({ PK: `AUDIT#${recordId}`, SK: sk });
export const gsiPosts = "POSTS";
export const gsiAuthor = (a) => `AUTHOR#${a}`;
export const gsiSubject = (s) => `SUBJECT#${s}`;
export const gsiThread = (s) => `THREAD#${s}`;
export const gsiAudit = "AUDIT";
