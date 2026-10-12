# How to connect an MCP client and run an admin delete

Use this page to add the family site's MCP server to an MCP client such as Claude, to check which tools you get, and, if you are an admin, to delete a post or a comment through it. A delete needs a recent sign-in with a passkey that verified you. For why, see [The identity model](../explanation/identity-model.md#step-up-for-destructive-agent-actions). For the tools, the policy table and the groups file, see [MCP server](../reference/mcp-server.md). For the authorization server and the claims it puts in a token, see [Identity services](../reference/identity-services.md#mcp-authorization-server).

Values in angle brackets are placeholders. `<site>` is the site's host name, `<config-bucket>` is the bucket that holds `config/`, and `<app-stack>` is the name of the deployed app stack. `<gramps-id>` is a member's Gramps ID, and `<record-id>` is the id of the post or comment you delete. The forms are listed in [Private data and secrets](../reference/private-data-and-secrets.md#placeholders).

The sign-in pages take their wording from the `copy` block of [`auth/edge.manifest.json`](../../auth/edge.manifest.json), which can change. So this page names their headings and buttons by copy key, such as `passkey_button`, and does not quote them. [Identity services: On the kit pages](../reference/identity-services.md#on-the-kit-pages) says where each key appears.

## Before you start

- **The MCP server is deployed.** The CloudFront behaviors for `/mcp*` and the protected-resource metadata are in place, as in the MCP step of [Deploy the app stack](deploy-the-app-stack.md). Check from any shell:

  ```sh
  curl -s "https://<site>/.well-known/oauth-protected-resource/mcp" | jq -c '{resource, authorization_servers}'
  curl -s -o /dev/null -D - -X POST "https://<site>/mcp" | grep -i '^www-authenticate'
  ```

  The first command prints `{"resource":"https://<site>/mcp","authorization_servers":["https://<site>/auth"]}`. The second prints a `Bearer realm="<site>"` challenge whose `resource_metadata` is `https://<site>/.well-known/oauth-protected-resource`.

- **Your client's callback is allowed.** The client's OAuth callback URL must be on the `McpRedirectUris` stack parameter, exactly. The stack default lists Claude's two callbacks, `https://claude.ai/api/mcp/auth_callback` and `https://claude.com/api/mcp/auth_callback`. A client that calls the token endpoint from a web page also needs its origin on `McpCorsOrigins`. To check or change either, see [An MCP client cannot connect](diagnose-sign-in-and-api-failures.md#an-mcp-client-cannot-connect).
- **You are on the family allowlist,** so you can sign in at `https://<site>/auth/login`. The edge checks the allowlist again before it lets a client connect ([Add or remove a family member's access](manage-family-access.md)).
- **To see any tools, you are in `mcp-authors`.** Your Gramps ID, which is the token's subject, is in the group's `subjects`, or the email address you sign in with is in its `emails`. The group is in `<config-bucket>/config/groups.json`, and [Add or remove a family member's access](manage-family-access.md) covers editing it. Members of `hfy-admin` see the same tools. The API keeps the file for 60 s, so a change can take a minute to show.
- **For deletes, you are in `hfy-admin`.** That group takes subjects only: your Gramps ID must be in its `subjects`, and an email there does nothing. It is not the site's admin list, `config/admins.json`. Deletes through MCP follow `groups.json` alone. If `groups.json` is missing or cannot be parsed, nobody is in any group.
- **For deletes, a passkey that verifies you.** Using it must ask for your fingerprint, face or device PIN. A hardware security key does that only when it has a PIN set. To add a passkey, open `https://<site>/auth/passkeys`. It redirects to the account page at `/auth/link`, by way of the sign-in page if you are signed out. There, use the `passkey_add` button in the section headed `passkey_manage`. The sign-in page also offers one, under the `passkey_add_title` heading, after a Google or password sign-in when you have no passkey and have not chosen `passkey_later` in that browser before.
- **For the audit check, optional:** AWS credentials in `us-west-2` with `cloudformation:DescribeStacks` on `<app-stack>` and `dynamodb:Query` on its table, and `jq`.

## Steps

### 1. Connect

Add `https://<site>/mcp` to the client as a connector URL (in Claude, a custom connector), and start the connection. The client then works on its own:

1. It reads the protected-resource metadata, which names `https://<site>/auth` as the authorization server.
2. It registers. Registration always returns the same public client, `mcp-harrisonfamily`, with no secret.
3. It opens the authorization page in your browser. If you are not signed in to the site in that browser, the edge sends you to `https://<site>/auth/login`.

Sign in with any method: Google, email and password, or a passkey. If you have no passkey, a Google or password sign-in may be followed by the offer to add one. Adding one, or choosing `passkey_later`, carries on to the client. A passkey added there does not change how this sign-in counts, so it does not enable deletes: step 3 needs a sign-in with the passkey itself. The edge shows no consent page of its own. Once you are signed in, and still on the allowlist, it returns you to the client, which exchanges the code for an access token and a refresh token. If you were already signed in, you go straight back to the client. The access token lasts an hour, and the client renews it with the refresh token.

### 2. Check what you can do

Ask the client to list the server's tools.

| You are | Tools you see |
| --- | --- |
| In neither group | None. The list is empty, and its `_meta.reason` has the code `not_in_group` and the group `mcp-authors`. |
| In `mcp-authors` | Three read tools, `hfy_posts_list`, `hfy_posts_get` and `hfy_comments_list`, and two create tools, `hfy_posts_create` and `hfy_comments_create`. |
| In `hfy-admin` | The same five, and `hfy_posts_delete` and `hfy_comments_delete`. The two deletes are disabled, with the reason `step_up_required`, until you complete step 3. |

`hfy_posts_create` always makes a draft. It takes no visibility, and a post is published on the site, by a person.

A create or delete call runs when the client makes it. To preview one without writing anything, add `"mode": "dry_run"` to its arguments. The result describes the call instead of running it: the policy decision, and `wouldExecute`, which says whether the call would run.

### 3. Run an admin delete

1. In the browser your client opens for authorization, sign in at `https://<site>/auth/login` with your passkey, not with Google or a password. Use the `passkey_button` button, or pick the passkey from the email field's suggestions where the browser offers it. Complete the fingerprint, face or PIN prompt. Do this even if you are already signed in: only a sign-in in the last 5 minutes counts, and a session that has been refreshed keeps the time of its original sign-in.
2. Within 5 minutes of that sign-in, disconnect the connector and connect it again, so that the client runs a new authorization. It reuses the session you just created, so you are not asked to sign in, and the new token carries that sign-in's `amr` and `auth_time`. Letting the client refresh its token does not work: a refreshed token keeps the `auth_time` of the original connection.
3. Still within those 5 minutes, ask for the delete:
   - `hfy_posts_delete` with the post's `id`. It deletes the post and every comment on it.
   - `hfy_comments_delete` with the comment's `id` and its `subject`: `person:<gramps-id>` for a comment on a person record, or `post:` followed by the post's id. An optional `reason` is kept in the audit record.

   `hfy_posts_list`, `hfy_posts_get` and `hfy_comments_list` give you the ids.
4. Once 5 minutes have passed since the sign-in, the server refuses deletes again. For another delete, repeat from substep 1.

A client that sends `max_age` (for example `max_age=300`) or `prompt=login` with its authorization request re-prompts you automatically. The edge shows the sign-in page when your last sign-in is older than `max_age`, or always for `prompt=login`, and returns you to the same request afterwards. Choose the passkey there too. Another method gives a fresh `auth_time` but no `mfa`, so the deletes stay disabled.

## Verify

1. **The deletes are enabled.** List the tools again. `hfy_posts_delete` and `hfy_comments_delete` are no longer disabled, and carry no `step_up_required` reason. If your client does not show whether a tool is disabled, call the delete with `"mode": "dry_run"` first: the result has `"wouldExecute": true`, and its decision has `"effect": "allow"`.
2. **The delete succeeded.** The tool returns `{"ok": true, "action": "posts.delete"}`, or `"comments.delete"` for a comment. `hfy_posts_get` on a deleted post now returns an error.
3. **The audit record holds the deleted record.** Every delete writes an `AUDIT#<record-id>` item whose `before` is the full record and whose `after` is `null` ([API: Audit records](../reference/api.md#audit-records)). Read it:

   ```sh
   TABLE=$(aws cloudformation describe-stacks --stack-name <app-stack> --region us-west-2 \
     --query "Stacks[0].Outputs[?OutputKey=='TableName'].OutputValue" --output text)
   aws dynamodb query --table-name "$TABLE" --region us-west-2 \
     --key-condition-expression 'PK = :pk' \
     --expression-attribute-values '{":pk":{"S":"AUDIT#<record-id>"}}' \
     --query 'Items[?op.S==`delete`].{op: op.S, by: principal.S, before: before.M.id.S}'
   ```

   It prints one item: `op` is `delete`, `by` is your Gramps ID, and `before` is `<record-id>`, read from the stored record. The output names a Gramps ID, so keep it private.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| The tool list is empty, and `_meta.reason` has the code `not_in_group`. | Neither your Gramps ID nor your email is in `mcp-authors`, and you are not in `hfy-admin`. Or `groups.json` is missing or cannot be parsed, which puts nobody in any group. | Fix `config/groups.json` ([Add or remove a family member's access](manage-family-access.md)). Wait a minute, then list the tools again. |
| The sign-in page shows the `denied_body` notice, with a button that copies your email when you typed one, or a page headed `denied_title`. The client never finishes connecting. | The email you signed in with is not on the family allowlist. The edge checks it at every sign-in, by any method. | [Add or remove a family member's access](manage-family-access.md), then connect again. See also [A member is told they are not on the access list](diagnose-sign-in-and-api-failures.md#a-member-is-told-they-are-not-on-the-access-list). |
| The client reports `access_denied`, "not on the family access list". | You have a sign-in, but your Gramps ID was not on the allowlist when the client asked to connect, for example because your email was removed after you signed in. The authorization server reads the allowlist through its own 60 s cache. | [Add or remove a family member's access](manage-family-access.md). |
| The sign-in page the client opens has no styling, or the old styling after a restyle, or Google sign-in there fails with "origin is not allowed for the given client ID". | A problem with the auth edge's pages, not with MCP. No styling: the sign-in stylesheet, `11ty/css/auth-edge.css`, is missing from `https://<site>`. It ships with the site, not with the edge. Old styling: `hfy-auth-edge` was not redeployed after the stylesheet changed, so its manifest still links the old `theme.cssUrl` stamp. Google refused: `hfy-auth-edge` was built with `@io-kit/auth` older than 2.1.2, or the Google client does not allow the site's origin. | To finish connecting now, sign in with a password or a passkey. Then deploy the site ([Deploy a site change](deploy-a-site-change.md)) or redeploy `hfy-auth-edge` from `main` ([Deploy the app stack](deploy-the-app-stack.md)), as the cause needs, and see [Diagnose sign-in and API failures](diagnose-sign-in-and-api-failures.md#find-your-symptom). For Google, see also the table in [Rotate the Google sign-in client: Verify](rotate-the-google-client.md#verify). |
| The deletes are listed but disabled with the reason `step_up_required`, or a delete returns that reason. | The token does not show a recent sign-in that verified you. Its `amr` has no `mfa`: you signed in with Google or a password, or the passkey did not verify you, as with a security key that has no PIN. Or its `auth_time` is more than 300 s old. Or its `auth_time` is `0`, an unknown sign-in time, which a connection made before the auth edge recorded sign-in times keeps through every refresh. | Repeat step 3 from the passkey sign-in, and disconnect and reconnect rather than letting the client refresh. Set a PIN on a security key. |
| A delete returns the JSON-RPC error `-32602`, "Unknown tool". | You are not in `hfy-admin`. The server answers for a tool you may not see as if it did not exist. | Add your Gramps ID to the `subjects` of `hfy-admin` in `groups.json`. An email there does not count. |
| Every call fails with `401` `invalid_token`, "token not issued for this resource". | The token's audience is not `https://<site>/mcp`. Usually the stack's `McpResources` parameter still holds the old `https://mcp.<site>` value, so the edge issues tokens for that resource. | Set `McpResources` to `https://<site>/mcp`, deploy the stack ([Deploy the app stack](deploy-the-app-stack.md)), then disconnect and reconnect the client. |

To read the current `McpResources` value:

```sh
aws cloudformation describe-stacks --stack-name <app-stack> --region us-west-2 \
  --query "Stacks[0].Parameters[?ParameterKey=='McpResources'].ParameterValue" --output text
```

It prints `https://<site>/mcp` when the stack is right. For a client that cannot connect at all, or any other error, see [An MCP client cannot connect](diagnose-sign-in-and-api-failures.md#an-mcp-client-cannot-connect).

## Related pages

- [MCP server](../reference/mcp-server.md): the tools, the policy table, the groups file and the step-up rule.
- [Identity services](../reference/identity-services.md#mcp-authorization-server): the authorization server, `max_age` and `prompt=login`, and the `amr` and `auth_time` claims.
- [Identity services: On the kit pages](../reference/identity-services.md#on-the-kit-pages) and [Page theme and HFY overrides](../reference/identity-services.md#page-theme-and-hfy-overrides): the sign-in, add-a-passkey and account pages, their copy keys, their stylesheet and the edge's changes to them.
- [The identity model](../explanation/identity-model.md): why an agent signs in as a member, and why a delete needs a recent step-up.
- [Add or remove a family member's access](manage-family-access.md): the allowlist and the MCP groups.
- [Diagnose sign-in and API failures](diagnose-sign-in-and-api-failures.md), [Deploy the app stack](deploy-the-app-stack.md), [Rotate the Google sign-in client](rotate-the-google-client.md).
