# How to deploy and update the Lambda@Edge functions in us-east-1

Use this page to deploy or update the two CloudFormation stacks in `us-east-1` that hold the site's Lambda@Edge functions:

- `hfy-mcp-edge401`, from [`mcp-edge401.us-east-1.yaml`](../../infrastructure/mcp-edge401.us-east-1.yaml). Its origin-response function restores the `WWW-Authenticate` header on the MCP server's `401` answers, which a Lambda Function URL renames to `x-amzn-remapped-www-authenticate`. Deploy it before `/mcp` is routed, because [`add-mcp-behavior.sh`](../../scripts/infra/add-mcp-behavior.sh) will not add the MCP behaviors without its version.
- `hfy-edge-gate`, from [`edge-gate-stack.yaml`](../../infrastructure/cloudformation/edge-gate-stack.yaml). Its viewer-request function, built from [`edge-gate/`](../../edge-gate/), is the private data gate: it checks the `io_id` session cookie before CloudFront serves person, family, event, note, place or media data, or a member's post photo under `/uploads/`. This page deploys the gate and tests it. It does not attach it.

Deploying either stack attaches nothing and has no visitor impact. A Lambda@Edge function runs only once a CloudFront behavior names one of its numbered versions, and no stack here touches the distribution. The functions are attached elsewhere: the MCP function by the `/mcp*` behaviors in [Deploy the app stack](deploy-the-app-stack.md), and the gate in [Cut over to authV2 and the private data gate](cut-over-to-the-private-data-gate.md). The one exception on this page is the behavior rerun at the end of each "Ship a change" section, which moves live traffic to a new version of a function that is already attached. In production both functions are attached: `/mcp` is routed, and the gate has guarded the data paths since the 2026-10-12 cutover (HFY-R67). So a new version of either reaches visitors only through that rerun. For why these two functions run as Lambda@Edge while everything else runs at the origin, see [Edge and origin design](../explanation/edge-and-origin-design.md).

> **Operator credentials only.** No workflow builds or deploys either function. The GitHub deploy role in [`github-roles.yaml`](../../infrastructure/cloudformation/github-roles.yaml) has no CloudFormation permissions, and its Lambda permissions cover three functions in `us-west-2` only.

Values in angle brackets are placeholders. `<edge-code-bucket>` is the private S3 bucket in `us-east-1` that holds the gate's code zips. `<app-stack>` is the name of the live app stack, which is not `hfy-app`, the `--stack` default of `add-mcp-behavior.sh` and the other app behavior scripts, and the `--app-stack` default of `add-data-gate-behaviors.sh`. `<site>`, `<distribution-id>` and `<aws-account-id>` are listed with the other forms in [Private data and secrets](../reference/private-data-and-secrets.md#placeholders). In a photo path, `/uploads/posts/<ulid>/<name>`, `<ulid>` is the ID the API gave that upload and `<name>` its file name. The stack names `hfy-mcp-edge401` and `hfy-edge-gate` are the real names.

## Before you start

- **Approvals** ([`AGENTS.md`](../../AGENTS.md)). Deploys of the `us-east-1` stacks need io's go-ahead, and so does a real run of `add-mcp-behavior.sh`. A real run of `add-data-gate-behaviors.sh` without `--remove`, such as the behavior reruns in [Ship a change to the gate](#ship-a-change-to-the-gate) and [Roll back](#roll-back), needs io's G-prod approval: `AGENTS.md` counts every such run as attaching the data gate, and a go-ahead in the session is not enough.
- **Operator AWS credentials in `us-east-1`.** They must be able to:
  - deploy CloudFormation with `CAPABILITY_NAMED_IAM` for `hfy-edge-gate`, whose role is named `hfy-edge-gate-role`, and with `CAPABILITY_IAM` for `hfy-mcp-edge401`, whose role is unnamed. That covers creating IAM roles and Lambda functions and publishing Lambda versions.
  - read, list and write `<edge-code-bucket>`: `s3:PutObject` for the upload, `s3:GetObject` because Lambda fetches the code with the deploying identity's permissions, and `s3:ListBucket`, without which a lookup of a missing key answers `403 Forbidden` instead of `404 Not Found`.
  - call `lambda:InvokeFunction` on the gate's published versions, for step 5, and `lambda:GetFunctionConfiguration` and `lambda:ListVersionsByFunction`, for [Verify](#verify) and [Roll back](#roll-back).
  - for the behavior reruns in the "Ship a change" sections and in [Roll back](#roll-back) only: read and update the CloudFront distribution, list its response headers policies, and update `hfy-private-no-store` or `hfy-uploads-private` if one has drifted. Associating a Lambda@Edge version also takes `lambda:GetFunction` and `lambda:EnableReplication*` on the function. `add-mcp-behavior.sh` also reads the outputs of `<app-stack>` and the origin-verify secret in `us-west-2`.
- **`<edge-code-bucket>`, a private S3 bucket in `us-east-1`.** Lambda loads code only from a bucket in the function's own Region, so `<code-bucket>`, which is in `us-west-2`, cannot hold the gate's zips. Keep Block Public Access on. `hfy-mcp-edge401` needs no bucket: its code is inline in the template.
- **Regions.** Every command on this page that touches the edge stacks passes `--region us-east-1`. Leave the shell's default Region at `us-west-2`, as [Deploy the app stack](deploy-the-app-stack.md) sets it, because `add-mcp-behavior.sh` reads `<app-stack>` and the origin-verify secret in the default Region:

  ```sh
  export AWS_REGION=us-west-2 AWS_DEFAULT_REGION=us-west-2
  ```

- **Tools.** Node.js 22, `zip`, `openssl`, `jq`, and the AWS CLI version 2 (step 5 uses its `--cli-binary-format` option). Deploying needs no CodeArtifact token: the gate has no dependencies and the 401-restore code is inline. Changing a template also needs `python3` with PyYAML for `scripts/infra/test/run.sh`, and a change to the 401-restore code also runs the API suite, which does need the token.
- **A clean checkout of the commit to deploy.** `git status --short` prints nothing, so the zip and the templates match a commit you can name later.
- **The gate's tests pass.**

  ```sh
  (cd edge-gate && npm test)
  ```

  The run ends with `ℹ fail 0`.
- **For another family, the gate's configuration matches the auth edge.** The build bakes [`edge-gate/gate.config.json`](../../edge-gate/gate.config.json) into the zip, because Lambda@Edge has no environment variables. Its `issuer` and `audience` must equal `session.issuer` and `session.audience` in [`auth/edge.manifest.json`](../../auth/edge.manifest.json), and its `jwksUrl` must be `<session.issuer>/.well-known/jwks.json`. A test in [`gate.test.mjs`](../../edge-gate/test/gate.test.mjs) pins all three, so the `npm test` above fails when they disagree.

Run every command on this page from the repository root, in one shell.

## Steps

On a first deploy, run all five steps. Step 1 is independent of steps 2 to 5. To ship new code to a function, follow [Ship a change to the gate](#ship-a-change-to-the-gate) or [Ship a change to the MCP 401-restore function](#ship-a-change-to-the-mcp-401-restore-function) instead.

### 1. Deploy the MCP 401-restore function

```sh
aws cloudformation deploy --region us-east-1 \
  --stack-name hfy-mcp-edge401 \
  --template-file infrastructure/mcp-edge401.us-east-1.yaml \
  --capabilities CAPABILITY_IAM
```

This creates the role, the function `hfy-mcp-edge401` and its first numbered version. The template has no Region rule, so a deploy without `--region us-east-1` succeeds in the wrong Region, and CloudFront cannot use a function from there.

Read the version ARN:

```sh
aws cloudformation describe-stacks --region us-east-1 --stack-name hfy-mcp-edge401 \
  --query "Stacks[0].Outputs[?OutputKey=='Edge401FunctionVersionArn'].OutputValue" --output text
```

It prints `arn:aws:lambda:us-east-1:<aws-account-id>:function:hfy-mcp-edge401:<n>`. `add-mcp-behavior.sh` reads this output itself, from the stack named by its `--edge-stack` option, whose default is `hfy-mcp-edge401`, so you do not pass the ARN on. If the script cannot read the output, a real run stops with `no Lambda@Edge version ARN`, and a dry run prints `(dry-run) Lambda@Edge version ARN not resolved; using a placeholder`.

### 2. Build the gate

```sh
bash scripts/ci/package-edge-gate.sh
```

[`package-edge-gate.sh`](../../scripts/ci/package-edge-gate.sh) writes `dist/hfy-edge-gate.zip`, which holds `index.mjs`, `gate.mjs` and `edge-gate/gate.config.json` copied in as `config.json`. The zip is reproducible: fixed file times and no extra attributes, so the same sources give the same bytes. The script stops if the zip reaches 1 MB, the limit for a viewer-request function, or if the configuration lacks `issuer`, `audience` or `jwksUrl`.

It prints `built <repo>/dist/hfy-edge-gate.zip (<size> bytes)`, then the two stack parameters, which it also writes to `dist/hfy-edge-gate.params`:

- `CodeKey=lambda/hfy-edge-gate-<16 hex>.zip`, a content-addressed key made from the first 16 hex digits of the zip's SHA-256.
- `CodeSha256=<base64>`, the zip's SHA-256 in base64, the form Lambda reports.

The upload and deploy commands it prints after them name the bucket `<us-east-1 code bucket>`, which is `<edge-code-bucket>`. Keep both values in the shell for steps 3 and 4:

```sh
CODE_KEY="$(sed -n 's/^CodeKey=//p' dist/hfy-edge-gate.params)"
CODE_SHA="$(sed -n 's/^CodeSha256=//p' dist/hfy-edge-gate.params)"
echo "$CODE_KEY $CODE_SHA"
```

### 3. Upload under the content-addressed key

First confirm that nothing is stored under the key yet:

```sh
aws s3api head-object --bucket <edge-code-bucket> --key "$CODE_KEY" --region us-east-1
```

The command fails with `An error occurred (404) when calling the HeadObject operation: Not Found`. If it prints the object's metadata instead, this build was uploaded before: the key comes from the zip's own hash. Do not upload it again. Go to step 4. A `403 Forbidden` says nothing about the key: check that your credentials have `s3:GetObject` and `s3:ListBucket` on the bucket.

Then upload the zip and compare the sizes:

```sh
aws s3 cp dist/hfy-edge-gate.zip "s3://<edge-code-bucket>/$CODE_KEY" --region us-east-1
echo "local $(wc -c < dist/hfy-edge-gate.zip | tr -d ' '), uploaded $(aws s3api head-object \
  --bucket <edge-code-bucket> --key "$CODE_KEY" --region us-east-1 --query ContentLength --output text)"
```

The line shows the same number twice. Never put a different zip under a key that is already deployed. [Ship a change to the gate](#ship-a-change-to-the-gate) explains what that breaks.

### 4. Deploy the gate stack

```sh
aws cloudformation deploy --region us-east-1 \
  --stack-name hfy-edge-gate \
  --template-file infrastructure/cloudformation/edge-gate-stack.yaml \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides \
    CodeBucket=<edge-code-bucket> \
    CodeKey="$CODE_KEY" \
    CodeSha256="$CODE_SHA"
```

The stack creates the role `hfy-edge-gate-role`, the function `hfy-edge-gate` and an `AWS::Lambda::Version`, which publishes a numbered version only when the function's code matches `CodeSha256`. Its outputs are `EdgeGateVersionArn`, the qualified ARN of that version, and `EdgeGateFunctionName`.

The template rejects mistakes before anything changes:

- `CodeKey` must match `lambda/hfy-edge-gate-<16 hex>.zip`, and `CodeSha256` must be a 44-character base64 value. Neither has a default, and the pattern refuses a fixed key such as `lambda/hfy-edge-gate.zip`.
- The rule `UsEast1Only` fails a deploy in any other Region with `Lambda@Edge functions can only be created in us-east-1`.

Each version is kept (`DeletionPolicy` and `UpdateReplacePolicy` are `Retain`), because CloudFront's copies of a version pin it. A later deploy publishes a new version and leaves the old ones in place, which is what makes [Roll back](#roll-back) possible.

If the command reports `No changes to deploy` and exits non-zero, the stack already runs this build.

Keep the version ARN for step 5:

```sh
GATE_ARN="$(aws cloudformation describe-stacks --region us-east-1 --stack-name hfy-edge-gate \
  --query "Stacks[0].Outputs[?OutputKey=='EdgeGateVersionArn'].OutputValue" --output text)"
echo "$GATE_ARN"
```

It prints `arn:aws:lambda:us-east-1:<aws-account-id>:function:hfy-edge-gate:<n>`.

### 5. Validate the published version before anything attaches it

Invoke the published version directly with synthetic viewer-request events, shaped like the ones in [`gate.test.mjs`](../../edge-gate/test/gate.test.mjs): the request's `uri`, `querystring`, `method`, and `headers` keyed by the lower-case header name, each a list of `{key, value}`. A direct invocation does not involve CloudFront, so it has no visitor impact even when the gate is attached.

Never put a real token in an event. The second event carries a forged token made up on the spot: three base64url parts with key ID `forged` and no valid signature. Keep the event files outside the repository.

```sh
EV="$(mktemp -d)"
FORGED="$(node -e 'const b = (o) => Buffer.from(JSON.stringify(o)).toString("base64url"); console.log(`${b({ alg: "RS256", kid: "forged" })}.${b({ sub: "forged" })}.AAAA`)')"
ev() { # NAME HEADERS_JSON
  jq -n --argjson h "$2" '{Records: [{cf: {request: {uri: "/person/index.json", querystring: "", method: "GET", headers: $h}}}]}' > "$EV/$1.json"
}
ev no-cookie '{"accept": [{"key": "Accept", "value": "application/json"}]}'
ev forged "$(jq -nc --arg c "io_id=$FORGED" '{accept: [{key: "Accept", value: "application/json"}], cookie: [{key: "Cookie", value: $c}]}')"
ev navigate '{"accept": [{"key": "Accept", "value": "text/html"}], "sec-fetch-mode": [{"key": "Sec-Fetch-Mode", "value": "navigate"}]}'

for e in no-cookie forged navigate; do
  aws lambda invoke --region us-east-1 --function-name "$GATE_ARN" \
    --cli-binary-format raw-in-base64-out --payload "file://$EV/$e.json" "$EV/$e.out.json" \
    --query '[StatusCode, ExecutedVersion, FunctionError]' --output text
  echo "$e: $(jq -c '{status, location: .headers.location[0].value, cache: .headers["cache-control"][0].value, body}' "$EV/$e.out.json")"
done
```

Each invocation prints `200`, the version number at the end of `$GATE_ARN`, and `None`. Anything other than `None` in the last column, such as `Unhandled`, means the function threw: stop, and do not attach this version. The three result lines must read:

```
no-cookie: {"status":"401","location":null,"cache":"private, no-store","body":"{\"error\":\"unauthenticated\"}"}
forged: {"status":"401","location":null,"cache":"private, no-store","body":"{\"error\":\"unauthenticated\"}"}
navigate: {"status":"302","location":"/auth/login?returnTo=%2Fperson%2Findex.json","cache":"private, no-store","body":null}
```

- **No cookie, `Accept: application/json`:** `401` with the body `{"error":"unauthenticated"}`, the answer a fetch or XHR gets.
- **A forged `io_id`:** also `401`. To look up the unknown key ID, the gate may fetch the live key set from the `jwksUrl` baked into the zip. The answer is `401` whether or not that fetch happens or succeeds, so this check also passes before the auth edge exists.
- **`Sec-Fetch-Mode: navigate` and no cookie:** `302` to `/auth/login?returnTo=%2Fperson%2Findex.json`, the answer a top-level page load gets.
- **Every response** carries `cache-control: private, no-store`, so neither Cloudflare nor a browser stores a gate answer (HFY-R65).

The gate reads the path only to build `returnTo`, so these three events also stand for the other gated paths, `/uploads/` photos included. A photo that a page loads with `<img>` is not a navigation, so a signed-out request for one gets the `401`.

These direct invocations leave no log you can read: the function's role may write only to the `/aws/lambda/us-east-1.hfy-edge-gate` log groups that CloudFront's copies use. The result lines are the evidence. Delete the event files when you are done:

```sh
rm -rf "$EV"
```

After a first deploy, the gate is deployed and tested, and still attached to nothing. To attach it, follow [Cut over to authV2 and the private data gate](cut-over-to-the-private-data-gate.md). If you came here from [Ship a change to the gate](#ship-a-change-to-the-gate), go on to its step 4.

## Ship a change to the gate

1. **Test.** Run `(cd edge-gate && npm test)`. If you changed the template or `package-edge-gate.sh`, also run `bash scripts/infra/test/run.sh`, which ends with `scripts/infra tests: <n> passed, 0 failed`.
2. **Rebuild, upload to the new key, and redeploy.** Run [steps 2 to 4](#2-build-the-gate). A code or configuration change gives the zip a new `CodeKey` and a new `CodeSha256`. CloudFormation then updates the function's code from the new key and replaces the version resource, which publishes a new numbered version and a new `EdgeGateVersionArn`. The old version is kept and keeps serving wherever it is attached.
3. **Validate the new version** as in [step 5](#5-validate-the-published-version-before-anything-attaches-it), with `GATE_ARN` set to the new output.
4. **If the gate is attached, move the behaviors to the new version.** In production it is. This step changes what visitors get. The real run needs io's G-prod approval ([Before you start](#before-you-start)); the dry run needs no approval. Check which behaviors carry the gate:

   ```sh
   aws cloudfront get-distribution-config --id <distribution-id> \
     --query 'DistributionConfig.CacheBehaviors.Items[].[PathPattern, LambdaFunctionAssociations.Items[0].LambdaFunctionARN]' --output text
   ```

   Each row shows a path pattern and the first Lambda@Edge association of its behavior. A row that ends in `:function:hfy-edge-gate:<n>` is gated. After a complete cutover there are seven, all with the same `<n>`: `/person/*.json`, `/family/*`, `/event/*`, `/note/*`, `/place/*`, `/media/*` and `/uploads/*`.

   - If no row ends that way, the gate is not attached and you are done. The new version waits for [Cut over to authV2 and the private data gate](cut-over-to-the-private-data-gate.md).
   - If the six data patterns are gated but `/uploads/*` is not, or has no row, the rerun below also makes member photos members-only. That is the `/uploads/*` part of the cutover: review it as in that page's [step 3](cut-over-to-the-private-data-gate.md#3-attach-the-gate), and afterwards purge Cloudflare's copies under `<site>/uploads/` as in its [step 4](cut-over-to-the-private-data-gate.md#4-optional-purge-cloudflare).

   Then do a dry run:

   ```sh
   scripts/infra/add-data-gate-behaviors.sh --distribution <distribution-id> --dry-run
   ```

   Do not pass `--stack <app-stack>` to this script: its `--stack` names the gate's stack in `us-east-1`, and its default, `hfy-edge-gate`, is right. The script names the app stack with `--app-stack <app-stack>` instead, and only `--remove` reads it, so this run does not need it.

   The dry run reads the new version ARN from the stack output. Review what it prints:

   - **The policies.** One line for each:
     - `response headers policy hfy-private-no-store (<policy-id>) already forces Cache-Control: private, no-store`
     - `response headers policy hfy-uploads-private (<uploads-policy-id>) already forces Cache-Control: private, no-store and the nosniff + sandbox CSP security headers`

     A line that starts `(dry-run) would put response headers policy <name> (<id>) back` means someone changed that policy, and the real run will restore it. `(dry-run) would create response headers policy hfy-uploads-private ...` goes with an ungated `/uploads/*`, the case above.
   - **The plan line.** `gating /person/*.json /family/* /event/* /note/* /place/* /media/* /uploads/* on origin <origin-id> with arn:aws:lambda:us-east-1:<aws-account-id>:function:hfy-edge-gate:<n> (CachingDisabled, response headers policy <policy-id>: Cache-Control: private, no-store; /uploads/* keeps its origin and gets policy <uploads-policy-id>)`. `<n>` must be the version you validated in step 3.
   - **The diff.** It changes only the version number at the end of seven `LambdaFunctionARN` values, one for each gated behavior. If `/uploads/*` was not gated, it changes six and gates `/uploads/*` in place instead, as the cutover's step 3 describes: an association, CachingDisabled and `hfy-uploads-private`, with the same position and origin. With no `/uploads/*` behavior at all, it adds one, already gated. The one other change the script can make is to move a gated behavior that sits behind a broader one matching the same paths, such as a legacy `/person/*`, to just ahead of it. Stop if the diff does anything else.
   - **No change.** `distribution <distribution-id> already has the data-gate behaviors (/person/*.json /family/* /event/* /note/* /place/* /media/* /uploads/*) on <version ARN> with response headers policies <policy-id> and <uploads-policy-id>: no change` means the behaviors already name that version.

   If the output is as described, apply it and wait:

   ```sh
   scripts/infra/add-data-gate-behaviors.sh --distribution <distribution-id>
   aws cloudfront wait distribution-deployed --id <distribution-id>
   ```

   The real run reads the live configuration again, so its diff should match the dry run's. It saves the pre-change distribution configuration under `${HFY_CF_BACKUP_DIR:-~/.local/state/hfy-infra/cloudfront}`, mode 600, prints a rollback command, and then prints the distribution status, `InProgress`. Moving a Lambda@Edge association takes minutes. The `wait` command returns with no output when it is done; if it times out, run it again. Then run [Verify](#verify) step 4 on this page and the Verify section of [Cut over to authV2 and the private data gate](cut-over-to-the-private-data-gate.md#verify).

Two mistakes fail the stack update, and both leave visitors untouched:

- **Reusing a key.** If a different zip is uploaded under a key that is already deployed, the stack sees no change to `CodeKey`, so the function's code is not updated. The new `CodeSha256` still replaces the version resource, and publishing it fails because the function's code does not match. Rebuild and upload under the key the build prints.
- **A zip that does not match `CodeSha256`.** Publishing the version fails, for example after the parameters of one build were deployed with the zip of another.

In both cases CloudFormation rolls the update back, the stack ends in `UPDATE_ROLLBACK_COMPLETE`, and the attached version keeps serving.

## Ship a change to the MCP 401-restore function

CloudFormation publishes a new Lambda version only when the version resource itself changes. An edit to the inline code alone updates the function's unpublished code, `$LATEST`, but leaves `Edge401FunctionVersionArn` on the old version, so CloudFront keeps running the old code. The template therefore carries a hash of the code in the description of `Edge401Version`, and an edit to the code must update that hash.

1. **Edit the inline code** under `Edge401Function` in [`mcp-edge401.us-east-1.yaml`](../../infrastructure/mcp-edge401.us-east-1.yaml). It is the CommonJS twin of `infra/edge-401-header.mjs` in `@io-kit/mcp`. Keep its indentation: [`api/test/mcp-infra.test.js`](../../api/test/mcp-infra.test.js) finds the code by it.
2. **Get the new hash.**

   ```sh
   bash scripts/infra/test/run.sh
   ```

   The check for `mcp-edge401.us-east-1.yaml` fails and prints the value to use: `set Edge401Version Description to 'code sha256 <16 hex>' so a new version is published`.
3. **Update the description** of `Edge401Version` to `"restore WWW-Authenticate on 401 (code sha256 <16 hex>)"` with that value. Run `bash scripts/infra/test/run.sh` again. It ends with `scripts/infra tests: <n> passed, 0 failed`.
4. **Run the API suite** as in [Run the tests](run-the-tests.md). `mcp-infra.test.js` runs the inline code against a `401` with the renamed header, a `200` and a `401` without it, and checks it against the packaged `edge-401-header.mjs`. That suite needs a CodeArtifact token.
5. **Redeploy** as in [step 1](#1-deploy-the-mcp-401-restore-function). The changed description replaces the version resource, which publishes a new numbered version and a new `Edge401FunctionVersionArn`. The old version is kept.
6. **Move the MCP behaviors to the new version.** `add-mcp-behavior.sh` also writes the origin-verify value into `hfy-api-origin`, so first run the secret check in [Deploy the app stack](deploy-the-app-stack.md) and stop if it does not match. Then name the secret the app stack uses:

   ```sh
   OV_NAME="$(aws cloudformation describe-stacks --stack-name <app-stack> \
     --query "Stacks[0].Parameters[?ParameterKey=='OriginVerifySecretName'].ParameterValue" --output text)"
   scripts/infra/add-mcp-behavior.sh --stack <app-stack> --distribution <distribution-id> --secret-name "$OV_NAME" --dry-run
   ```

   Pass `--stack <app-stack>`: the script reads the API's Function URL from that stack, and its default, `hfy-app`, is not the live stack's name. The dry run must not print `(dry-run) Lambda@Edge version ARN not resolved; using a placeholder`, and its diff should change only the version number at the end of the `LambdaFunctionARN` of `/mcp*` and `/.well-known/oauth-protected-resource*`. If it does, apply it and wait:

   ```sh
   scripts/infra/add-mcp-behavior.sh --stack <app-stack> --distribution <distribution-id> --secret-name "$OV_NAME"
   aws cloudfront wait distribution-deployed --id <distribution-id>
   ```

   Then follow the MCP checks in the Verify section of [Deploy the app stack](deploy-the-app-stack.md).

## Verify

1. **Both stacks are complete and output their versions.**

   ```sh
   for s in hfy-mcp-edge401 hfy-edge-gate; do
     aws cloudformation describe-stacks --region us-east-1 --stack-name "$s" \
       --query 'Stacks[0].[StackName, StackStatus]' --output text
     aws cloudformation describe-stacks --region us-east-1 --stack-name "$s" \
       --query 'Stacks[0].Outputs[].[OutputKey, OutputValue]' --output text
   done
   ```

   Each status is `CREATE_COMPLETE` or `UPDATE_COMPLETE`. The outputs are `Edge401FunctionVersionArn` ending in `:function:hfy-mcp-edge401:<n>`, `EdgeGateVersionArn` ending in `:function:hfy-edge-gate:<n>`, and `EdgeGateFunctionName` `hfy-edge-gate`.
2. **The gate's version runs this build.**

   ```sh
   aws lambda get-function-configuration --region us-east-1 --function-name "$GATE_ARN" \
     --query '[CodeSha256, Description]' --output text
   ```

   The first value equals `$CODE_SHA`. The description reads `code <CodeSha256> (s3 <CodeKey>)` with this build's values.
3. **The published gate answers as expected.** All three result lines in [step 5](#5-validate-the-published-version-before-anything-attaches-it) match.
4. **After a behavior rerun, the behaviors name the version you meant.** Run the listing from [Ship a change to the gate](#ship-a-change-to-the-gate), step 4, again. Every row that ends in `:function:hfy-edge-gate:<n>` shows the same `<n>`, the version you validated or, after [Roll back](#roll-back), the previous one. With `/uploads/*` gated there are seven such rows. After a rerun of `add-mcp-behavior.sh`, the `/mcp*` and `/.well-known/oauth-protected-resource*` rows end in `:function:hfy-mcp-edge401:<n>` with the new version.
5. **After attachment**, follow the Verify sections of [Cut over to authV2 and the private data gate](cut-over-to-the-private-data-gate.md#verify) for the gate and of [Deploy the app stack](deploy-the-app-stack.md) for the MCP function. The gate's checks there include a signed-out request for an `/uploads/posts/<ulid>/<name>` photo, which must answer `401` with `cache-control: private, no-store` and a `cf-cache-status` that is never `HIT`.

**Logs.** When CloudFront runs a version, the function logs to `/aws/lambda/us-east-1.hfy-edge-gate` or `/aws/lambda/us-east-1.hfy-mcp-edge401` in the Region of the edge location that served the request, not in `us-east-1`. To find the Regions that have them:

```sh
for r in $(aws ec2 describe-regions --query 'Regions[].RegionName' --output text); do
  n="$(aws logs describe-log-groups --region "$r" --log-group-name-prefix /aws/lambda/us-east-1.hfy- \
    --query 'length(logGroups)' --output text)"
  [ "$n" = 0 ] || echo "$r: $n"
done
aws logs tail /aws/lambda/us-east-1.hfy-edge-gate --region <edge-region> --since 1h
```

`<edge-region>` is one of the Regions the loop prints. The loop needs `ec2:DescribeRegions` and `logs:DescribeLogGroups`.

The gate logs only deny reasons, as `edge-gate: deny <reason>` (`malformed`, `alg-or-kid`, `unknown-kid`, `bad-signature`, `iss`, `aud`, `expired`, `nbf` or `sub`) or `edge-gate: deny error <message>`, and key-set fetch failures. It never logs a token, a claim or a path. A request without an `io_id` cookie is denied without a log line. `hfy-mcp-edge401` writes no lines of its own, only Lambda's start, end and report lines and any error.

## Roll back

**A failed deploy needs no rollback.** A failed update rolls back by itself, ends in `UPDATE_ROLLBACK_COMPLETE`, and leaves the attached version serving. A failed first create ends in `ROLLBACK_COMPLETE`, a state that cannot be updated. Nothing is attached yet, so delete the stack with `aws cloudformation delete-stack --region us-east-1 --stack-name hfy-edge-gate` (or `hfy-mcp-edge401`), fix the cause and deploy again.

**A bad version that is already attached.** Every version is kept, so point the behaviors back at the previous one. List the versions with their descriptions, which name the build:

```sh
aws lambda list-versions-by-function --region us-east-1 --function-name hfy-edge-gate \
  --query 'Versions[].[FunctionArn, Description]' --output text
```

For the MCP function, use `--function-name hfy-mcp-edge401`. The `$LATEST` row is not a version CloudFront accepts. Then dry-run, apply and wait, with the previous version's ARN:

```sh
scripts/infra/add-data-gate-behaviors.sh --distribution <distribution-id> --version-arn <previous EdgeGateVersionArn> --dry-run
scripts/infra/add-data-gate-behaviors.sh --distribution <distribution-id> --version-arn <previous EdgeGateVersionArn>
aws cloudfront wait distribution-deployed --id <distribution-id>
```

```sh
scripts/infra/add-mcp-behavior.sh --stack <app-stack> --distribution <distribution-id> --secret-name "$OV_NAME" --edge401-arn <previous version ARN> --dry-run
scripts/infra/add-mcp-behavior.sh --stack <app-stack> --distribution <distribution-id> --secret-name "$OV_NAME" --edge401-arn <previous version ARN>
aws cloudfront wait distribution-deployed --id <distribution-id>
```

Review each dry run as in the matching "Ship a change" section: the diff changes only the version number at the end of each attached behavior's `LambdaFunctionARN`, back to the previous version. For the gate that is seven behaviors once `/uploads/*` is gated. A gate run on a distribution where `/uploads/*` is not gated gates it too, as described in [Ship a change to the gate](#ship-a-change-to-the-gate), step 4. The real gate run needs io's G-prod approval, and the real MCP run needs io's go-ahead.

Set `OV_NAME` as in [Ship a change to the MCP 401-restore function](#ship-a-change-to-the-mcp-401-restore-function). A version ARN must be qualified, `arn:aws:lambda:us-east-1:<aws-account-id>:function:hfy-edge-gate:<n>` or the same form for `hfy-mcp-edge401`. An unqualified or `$LATEST` ARN makes either script exit with status `2` before it changes anything.

The stacks' outputs still name the newer version, so a later run of either script without the explicit ARN moves the behaviors forward again. Pass the previous ARN on every run until a fixed build ships through the matching "Ship a change" section.

To take the gate off altogether, use the rollback in [Cut over to authV2 and the private data gate](cut-over-to-the-private-data-gate.md#roll-back), not this page. Its `add-data-gate-behaviors.sh --remove` deletes the six data behaviors and puts `/uploads/*` back to its ungated state. Every member photo then becomes readable by anyone who holds its URL. The family data becomes public again too, unless `HFYAppendIndex` runs its default-deny code, which then refuses that data to everyone, members included; that page explains both cases. While `/uploads/*` is gated, every production `--remove`, including `--remove --dry-run`, must pass `--app-stack <app-stack>` with the shell's Region at `us-west-2`, or name the policy with `--restore-uploads-policy-id <id>`. Without either it exits `1` and changes nothing.

## Related pages

- [Deploy the app stack](deploy-the-app-stack.md): attaches the MCP function through the `/mcp*` and protected-resource metadata behaviors.
- [Cut over to authV2 and the private data gate](cut-over-to-the-private-data-gate.md): attaches the gate, in order after `authV2`, gates `/uploads/*`, and removes the gate again.
- [The privacy model for family data](../explanation/family-data-privacy.md): what the gate protects, member photos included, and why at the edge.
- [Edge and origin design](../explanation/edge-and-origin-design.md): why these two functions run as Lambda@Edge.
- [Architecture](../reference/architecture.md#cloudformation-stacks): the stacks, their resources and outputs, and the [compute](../reference/architecture.md#compute) they hold.
- [Repository operations](../reference/repository-operations.md): `package-edge-gate.sh` among the build scripts, and the [CloudFront behavior scripts](../reference/repository-operations.md#cloudfront-behavior-scripts).
- [The release model](../explanation/release-model.md): why the functions ship by hand with operator credentials.
- [MCP server](../reference/mcp-server.md): what `/mcp` serves, and why its `401` needs the restored header.
- [Private data and secrets](../reference/private-data-and-secrets.md): the placeholders, and what docs may cite.
