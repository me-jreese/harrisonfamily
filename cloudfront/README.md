# cloudfront/

`distribution.json` is a sanitized sample of the distribution before the `scripts/infra/` behavior scripts ran: the site bucket on the default behavior and the legacy API Gateway origin on `/api/*`, with no app, MCP or data-gate behaviors. It is the input of the offline dry runs in `scripts/infra/test/run.sh`, not the live configuration. `scripts/export_workspace_samples.sh` replaces this directory wholesale from the workspace copy, so change both.

- Live routing and why one distribution fronts everything: [System architecture](../docs/reference/architecture.md#request-routing), [Edge and origin design](../docs/explanation/edge-and-origin-design.md), [App backend cost estimate](../docs/reference/cost-estimate.md)
- Creating the distribution, then adding the `/api/*`, `/auth/*`, `/uploads/*` and MCP behaviors: [Stand up the static site](../docs/how-to/stand-up-the-static-site.md), [Deploy the app stack](../docs/how-to/deploy-the-app-stack.md)
- Private data gate: [Deploy the edge functions](../docs/how-to/deploy-the-edge-functions.md), then [Cut over to authV2 and the private data gate](../docs/how-to/cut-over-to-the-private-data-gate.md) for the deploy order and rollback
- Edge failures: [Diagnose sign-in and API failures](../docs/how-to/diagnose-sign-in-and-api-failures.md)
