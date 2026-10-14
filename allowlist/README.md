# allowlist/

Sanitized samples with no real data:

- `allowed_hashes.json`: the shape of `config/allowed_hashes.json`, the digest list that only the legacy sign-in Lambda read. That object and its HMAC key were retired on 2026-10-14 (ruling P2-R51), so this sample is a record of the old format. The sample digests never match a real one.
- `harrisonfamily-allowlist.json`: the email array, with `example.com` addresses. The allowlist publisher checks that the real file exists but no longer reads it; until 2026-10-14 it hashed the array into the digest list (ruling P2-R51). It was also the format of the legacy Google Secret Manager copy, which was deleted on 2026-10-14 (HFY-TSK-325).

The real allowlist, email map and admin list are private and live outside the repo. Why one allowlist decides membership: [The identity model](../docs/explanation/identity-model.md). Files, locations and readers: [Private data and secrets](../docs/reference/private-data-and-secrets.md#access-configuration-in-config-bucketconfig). Adding or removing a member or an admin: [Manage family access](../docs/how-to/manage-family-access.md). A member who cannot sign in: [Diagnose sign-in and API failures](../docs/how-to/diagnose-sign-in-and-api-failures.md).
