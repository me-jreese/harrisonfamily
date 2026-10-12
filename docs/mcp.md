# MCP server (HFY-TSK-077, groundwork HFY-TSK-073)

`https://harrisonfamily.us/mcp` (HFY-R59: a path, not a subdomain). Resource URL `https://harrisonfamily.us/mcp`, PRM at `/.well-known/oauth-protected-resource/mcp` (and the bare path), bearer `aud` must be `https://harrisonfamily.us/mcp`.
It is mounted in the `hfy-api` Lambda (`api/src/index.js` routes `/mcp*` and `/.well-known/oauth-protected-resource*` to `api/src/mcp.js`), so the tools run the route registry's own handlers (validation, Q-4, D-15 audit, notifications).

## Layers
- Edge (`@io-kit/mcp/edge`, pinned 0.1.0): RS256 bearer via the auth edge JWKS (`SESSION_JWKS_URL`, default `https://harrisonfamily.us/auth/.well-known/jwks.json`), pinned `iss` (`MCP_TOKEN_ISSUER`, default the session issuer), `token_use` + `client_id` binding (`MCP_CLIENT_IDS`, default `mcp-harrisonfamily`), PRM, 401 + `WWW-Authenticate`. The mount adds the `aud` check (`MCP_AUDIENCE`). The ASM stays with the auth edge (issuer `https://harrisonfamily.us/auth`, HFY-R44). The X-Origin-Verify check (HFY-R43) runs first in `index.js`.
- Core (`@io-kit/mcp/core`): `tools/list` and `tools/call` over a registry derived from `ROUTES` (`mcp` member per route in `api/src/routes.js`), evaluated against `api/src/policy.js`. Tool names equal the parity caps action names: `hfy_comments_list|create|delete`, `hfy_posts_list|get|create|delete`.
- `hfy_posts_create` always creates a DRAFT (no visibility argument). Agents default to dry_run; humans execute.

## Policy table (the same one the UI reads, M-09: `api/dist/policy.json` from `node api/scripts/gen-caps.mjs`)
| action | show / execute | assurance |
| --- | --- | --- |
| `comments.list`, `posts.list`, `posts.get` | mcp-authors, hfy-admin | session |
| `comments.create`, `posts.create` | mcp-authors, hfy-admin (agents: dry_run) | session |
| `*.delete` | hfy-admin | step_up: `amr` contains `mfa` and `auth_time` within 300 s |

Step-up (HFY-R67, `STRONG_AMR = ["mfa"]` in `api/src/policy.js`): only a sign-in where user verification was performed counts. The auth edge's passkeys use `userVerification: "preferred"`, and the kit's `passkeyAmr` always emits `passkey` plus `hwk` (device-bound) or `swk` (synced), adding `mfa` only when UV happened. So `passkey`, `hwk` or `swk` without `mfa` is a single possession factor (for example a PIN-less security key) and does NOT unlock deletes. iPhone passkeys always perform UV, so they carry `mfa`. `pwd` and `fed` (Google) are never a step-up. The published policy document (`api/dist/policy.json`, `stepUp.amr`) carries the same list.

Non-members authenticate and get an empty `tools/list` with `_meta.reason {code: not_in_group, group: mcp-authors}`. Members never see delete tools (existence not revealed); a non-fresh admin sees them disabled (`step_up_required`).

## Who a tool call runs as
Each tool runs the route's own handler as the actor `{id: sub, label, admin}`, the same shape the HTTP path builds from the io_id session (`api/src/auth.js`). `label` is the access token's `name` claim (trimmed). The auth edge mints it from the io_id session label in `auth/src/oauth.js` and keeps it on refresh, like `email`, `amr` and `auth_time`. When the token has no usable `name`, the label is the `sub` (gramps_id). The `email` claim is never used as a label. The label is what gets stored as `author.label` on comments, posts, their index items and the D-15 audit entry, and it names the actor in push notifications. Authorization (`admin`, groups) never comes from the token; see below.

## Groups config (HFY-TSK-073), read-only, fail closed
`s3://$GROUPS_BUCKET/$GROUPS_KEY` (defaults `harrisonfamily` / `config/groups.json`; cached 60 s):
```json
{ "version": 1, "groups": {
  "mcp-authors": { "emails": [], "subjects": [] },
  "hfy-admin":   { "subjects": ["I0113"] } } }
```
`mcp-authors` is io-curated and may be empty. `emails` match an `email` claim or, when `ALLOWLIST_KEY` wiring is added, the family allowlist; `subjects` are gramps_ids. `hfy-admin` is exactly the subject bound to gramps_id I0113 (subjects only). The token's own `groups` claim is ignored. The Lambda role needs `s3:GetObject` on that key (it already reads `config/admins.json`).

## Deploy steps (nothing here was applied by the worker)
1. Upload `config/groups.json` to the bucket (above).
2. `aws cloudformation deploy --region us-east-1 --stack-name hfy-mcp-edge401 --template-file infrastructure/mcp-edge401.us-east-1.yaml --capabilities CAPABILITY_IAM` (Lambda@Edge 401 restore; output `Edge401FunctionVersionArn`).
3. Ship the API zip (`scripts/ci/package-api.sh`), then `scripts/infra/add-mcp-behavior.sh --dry-run`, review, rerun without `--dry-run` (adds `/mcp*` and `/.well-known/oauth-protected-resource*` to `hfy-api-origin` with the origin-response association; idempotent; refuses if an earlier behavior shadows them).
4. Auth edge (other worker): `MCP_RESOURCES` must be `https://harrisonfamily.us/mcp` (its default is the old subdomain) so tokens carry the right `aud`.
5. Probe: unauthenticated `POST https://harrisonfamily.us/mcp` returns 401 with `WWW-Authenticate: Bearer realm, resource_metadata, scope`; `GET /.well-known/oauth-protected-resource/mcp` returns the PRM.

## Gates
`scripts/ci/mcp-conformance.sh [report-only|blocking]` runs MCP-C01..C12 (`api/test/mcp-conformance.test.js`), the mounted-server tests, and `io-kit parity diff --mcp-tools dist/mcp/tools.json` against `dist/mcp/parity-caps.json` (UI routes in `api/parity/routes.yaml`, tool-to-handler map in `api/parity/map.yaml`). Job shape for a `ci_jobs_file`:
```yaml
mcp-conformance:
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
    - uses: actions/setup-node@v4
      with: { node-version: "22" }
    - run: scripts/ci/mcp-conformance.sh blocking
      env: { CODEARTIFACT_AUTH_TOKEN: "${{ secrets.CODEARTIFACT_AUTH_TOKEN }}" }
```

## Known gaps
- `@io-kit/ci` 0.1.3 has `stack: mcp` but no MCP deploy-target kind (targets: s3_static, lambda, cloudfront_function, codeartifact), and `ci_jobs_file` replaces the generated jobs wholesale; so no gated-off MCP target was added to `ci.manifest.yaml`. The MCP deploys with the `hfy-api` Lambda.
- Access tokens carry `email`, `amr` and `auth_time` (HFY-R64) and `name` (this release). A token minted by an auth edge that predates `name` still works: its calls are labelled with the gramps_id until the MCP client authorizes again (a refresh keeps the original grant's claims). A token without `mfa` in `amr` (or with a stale `auth_time`) is denied deletes with `step_up_required`.
- The packaged `resolveRefs` does not expand `$fixture:` refs embedded in header values (`Bearer $fixture:...`); the test harness expands them. MCP call audit goes to structured logs (`mcp.audit`), not the D-15 DDB items (route writes keep their own D-15 audit).
