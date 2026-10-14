// The composite allowlist resolver (HFY-TSK-134, surfaces.md 7.6, Q2-10). It is the PrincipalResolver that index.js passes to
// createIdentityService and to cognitoProvisioner, in place of the kit's S3-only buildResolver result. The manifest's resolver stays
// `s3_allowlist` (the kit validates only that kind and `static`), so edge.manifest.json is unchanged and the S3 resolver is still built
// from it and handed in as `s3`.
//
// Precedence for one email:
//   1. DynamoDB ALLOW#<email>: active -> the principal; revoked -> null, even when io's S3 file lists the email.
//   2. No item: the S3 resolver, as today (cached; the last good copy is served if a refresh fails).
//   3. DynamoDB error: the S3 resolver's answer (a hit admits, a miss is null). If S3 also fails the call rejects, which denies.
// With no ALLOW# item anywhere this behaves exactly like the S3 resolver, which is why the resolver deploys dark.
import { normalizeEmail } from "@io-kit/auth";
import { allowPrincipal, isActiveAllowItem, readAllowEntry } from "./shared/allowlist-store.mjs";

/**
 * `s3(email, provider)` is the kit's S3 PrincipalResolver. `ddb.send` and `cmds` are the lib-dynamodb DocumentClient and its command
 * classes; `table` is the app table.
 */
export function createCompositeResolver({ s3, ddb, cmds, table, log = console }) {
  return async (rawEmail, provider) => {
    const email = normalizeEmail(String(rawEmail ?? ""));
    let item;
    try {
      item = await readAllowEntry(ddb, cmds, table, email);
    } catch (e) {
      // only the error name is logged: never an address
      log.error?.("allowlist table unavailable (the S3 file decides)", e instanceof Error ? e.name : "error");
      return s3(email, provider);
    }
    if (item) return isActiveAllowItem(item) ? allowPrincipal(item, email) : null; // a DynamoDB item wins over the S3 file, active or revoked
    return s3(email, provider);
  };
}
