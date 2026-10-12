# allowlist/

Sanitized samples with no real data:

- `allowed_hashes.json`: the shape of `config/allowed_hashes.json`, the digest list the legacy sign-in Lambda checks. The sample digests never match a real one.
- `harrisonfamily-allowlist.json`: the email array the allowlist publisher reads, in the legacy Google Secret Manager format, with `example.com` addresses.

The real allowlist, email map and admin list are private and live outside the repo. Why one allowlist decides membership: [The identity model](../docs/explanation/identity-model.md). Files, locations and readers: [Private data and secrets](../docs/reference/private-data-and-secrets.md#access-configuration-in-config-bucketconfig). Adding or removing a member or an admin: [Manage family access](../docs/how-to/manage-family-access.md). A member who cannot sign in: [Diagnose sign-in and API failures](../docs/how-to/diagnose-sign-in-and-api-failures.md).
