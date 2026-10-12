# cloudfront/

`distribution.json` is a sanitized sample of the distribution configuration as it was before the `scripts/infra/add-*-behavior.sh` scripts ran: the S3 origin, plus the legacy API Gateway origin that serves `/api/*` (and so `POST /api/check-allowed`). It has none of the `/api/check-allowed*`, `hfy-api`, `/auth/*` or `/uploads/*` behaviors. It is a starting template and an offline dry-run input, not the live configuration, which is not in the repo.

- Live routing, origins and policies: [System architecture](../docs/reference/architecture.md#request-routing)
- Why one distribution fronts everything: [Edge and origin design](../docs/explanation/edge-and-origin-design.md)
- Creating the distribution from this template: [Stand up the static site](../docs/how-to/stand-up-the-static-site.md); adding the `/auth/*`, `/api/*` and `/uploads/*` behaviors: [Deploy the app stack](../docs/how-to/deploy-the-app-stack.md)
- Edge failures: [Diagnose sign-in and API failures](../docs/how-to/diagnose-sign-in-and-api-failures.md); cost: [App backend cost estimate](../docs/reference/cost-estimate.md)
