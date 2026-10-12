# How to stand up the static site and its deploy access

Use this page once per environment to set up the static hosting edge, the CI deploy access and the Google sign-in client. The hosting edge is the site bucket, the certificate, the CloudFront distribution and its default behavior, the `HFYAppendIndex` CloudFront Function, and DNS. The deploy access is the GitHub OIDC deploy role and the repository secrets. It is also the first step when you adapt the repo for another family. For why the edge is shaped this way, read [Edge and origin design](../explanation/edge-and-origin-design.md).

A full environment is built in this order:

1. This page.
2. [Deploy the app stack](deploy-the-app-stack.md): `hfy-api`, `hfy-auth-edge`, the `/api/*`, `/auth/*` and `/uploads/*` behaviors, and the upload CORS rule.
3. [Manage family access](manage-family-access.md): the allowlist and the admin list.
4. [Refresh the family data](refresh-the-family-data.md): the private Gramps data under the bucket's data prefixes.
5. [Deploy a site change](deploy-a-site-change.md): how changes to `11ty/` ship. The [Verify](#verify) section below uses it for the first deploy.
6. Optional: [Turn on push notifications](turn-on-push-notifications.md).

Values in angle brackets, such as `<site>`, `<site-bucket>`, `<distribution-id>`, `<aws-account-id>`, `<github-owner>`, `<github-repo>` and `<google-web-client-id>`, are placeholders. Their forms are listed in [Private data and secrets](../reference/private-data-and-secrets.md#placeholders). Never commit the real values: keep filled-in copies of the samples outside the repository.

## Before you start

- You have admin credentials for the target AWS account, the AWS CLI v2, and `jq`.
- You control the DNS for `<site>`.
- `gh` is installed and authenticated with a token that has Secrets: write and Actions: write on the repository. Step 6, step 7 and [Verify](#verify) set secrets, start a workflow run and watch it.
- You have a Google account that can create a Google Cloud project and an OAuth client.
- You run every command from the root of a checkout. The CLI paths, such as `fileb://scripts/...`, are relative to that root.

### If you are adapting the repo for another family

Several files carry this environment's names, so a copy for another family needs edits before its first deploy. The distribution ID is known only after step 3. Edit your working copy before [step 6](#6-create-the-deploy-role-and-its-secret), then ship the edits with [Deploy a site change](deploy-a-site-change.md). The run from that merge is the first deploy in [Verify](#verify).

| File | Values | Change to |
| --- | --- | --- |
| [`ci.manifest.yaml`](../../ci.manifest.yaml) | The `s3_static` target's `bucket` and `distribution`; the `smoke` URLs; the `lambda` target's `name`; `deploy.region` | `<site-bucket>`, `<distribution-id>`, `https://<site>/...`, and your legacy Lambda, or see [Legacy pieces](#legacy-pieces). Then re-render the workflows: [Change the CI pipeline](change-the-ci-pipeline.md). Never edit the rendered files directly. |
| [`deploy-gcf-legacy.yml`](../../.github/workflows/deploy-gcf-legacy.yml) | `GCP_PROJECT_ID`, `GCF_REGION`, `GCF_FUNCTION`, `GCF_ENV_VARS` | Your legacy names, or delete the workflow (see [Legacy pieces](#legacy-pieces)). It is hand-maintained. |
| [`github-roles.yaml`](../../infrastructure/cloudformation/github-roles.yaml) | Defaults of `GitHubOrg`, `GitHubRepo` and `OIDCProviderArn` | Pass your own values as `--parameter-overrides` in step 6, or edit the defaults |
| [`github-roles.yaml`](../../infrastructure/cloudformation/github-roles.yaml) | Bucket ARNs in `S3SiteSync` and `ProtectMemberUploads`; the distribution in `CloudFrontInvalidation`; the function ARNs in `LambdaDeploy` | `<site-bucket>`, `<distribution-id>`, and your function names and region |
| [`auth/edge.manifest.json`](../../auth/edge.manifest.json) | `site`, `authOrigin`, `cookieDomain`, `returnOrigins`, `idp.domain`, `session.issuer`, `session.audience`, `session.signingKeySecretName`, `resolver.bucket`, `theme.cssUrl`, and the sign-in page text in `copy` | Your host name, issuer, audience, secret name, `<config-bucket>` and family name. Keep them in step with the `app-stack.yaml` parameters below. |
| [`app-stack.yaml`](../../infrastructure/cloudformation/app-stack.yaml) parameters | `ConfigBucket`, `MediaBucket`, `MediaPublicBase`, `SessionIssuer`, `SessionAudience`, `SessionJwksUrl`, `McpResources`, `SigningKeySecretName`, `OriginVerifySecretName` | Pass your values as `--parameter-overrides` in [Deploy the app stack](deploy-the-app-stack.md#4-deploy-the-stack), or edit the defaults |
| [`media-bucket-cors.json`](../../infrastructure/cloudformation/media-bucket-cors.json) | `AllowedOrigins` | `https://<site>` |
| [`11ty/js/feature-flags.js`](../../11ty/js/feature-flags.js) | The production host name in the `isProductionHost` check | `<site>`. Without it, the production host does not force `enforceAssets`, the guard described in [Family data privacy](../explanation/family-data-privacy.md#gating-the-json). |
| [`11ty/manifest.webmanifest`](../../11ty/manifest.webmanifest) | `name`, `short_name` | Your family's names for the installed app |
| The `scripts/infra/` scripts | The `--distribution` default, and the secret-name defaults | Pass `--distribution <distribution-id>` and `--secret-name` every time, as [Deploy the app stack](deploy-the-app-stack.md) does |

`11ty/` also carries the family's own pages and text, rendered from `<eleventy-source>`. Rebuild them from your own source with [Refresh the Eleventy output](refresh-the-eleventy-output.md).

### Legacy pieces

While `authV2` is `false` in [`11ty/_data/flags.json`](../../11ty/_data/flags.json), members sign in through the legacy path. Its pieces were created outside the repo's IaC, and this page does not set them up. [Identity services](../reference/identity-services.md#legacy-sign-in-hfy-check-allowed) describes them, and [The identity model](../explanation/identity-model.md#retirement-order-once-authv2-is-flipped) gives the order in which they retire.

Every push to `main` deploys both legacy functions, whatever the flag says. The first deploy in [Verify](#verify) is green only if these already exist:

| You need | What fails without it |
| --- | --- |
| The `hfy-check-allowed` Lambda in `us-west-2`. The deploy updates its code only. | The Lambda update in the `deploy` job of `io-kit-deploy.yml` |
| The `GCP_SERVICE_ACCOUNT_KEY` repository secret, holding a Google service-account JSON key | The "Authenticate to Google Cloud" step of `deploy-gcf-legacy.yml` |
| The Google Cloud project named by `GCP_PROJECT_ID` in `deploy-gcf-legacy.yml`, with the Secret Manager, Cloud Functions, Cloud Run and Cloud Build APIs enabled (`secretmanager`, `cloudfunctions`, `run` and `cloudbuild`, each `.googleapis.com`), and that service account allowed to deploy Cloud Functions in it | The "Deploy Google Cloud Function" step, which deploys `getAllowlist` as a 2nd-gen function |

Legacy sign-in also needs the `HFY_ALLOWLIST_HMAC_SECRET` secret in Secrets Manager and an API Gateway route to the Lambda, reached through CloudFront under `/api/check-allowed`. [Deploy the app stack](deploy-the-app-stack.md#add-the-api-behavior-and-the-legacy-pin) keeps that route ahead of `/api/*`.

If you will not run the legacy path:

- In `ci.manifest.yaml`, remove the `lambda` target, the `artifacts` entry and `&& bash scripts/ci/package-lambda.sh` from `build.cmd`, then re-render ([Change the CI pipeline](change-the-ci-pipeline.md)).
- Delete `deploy-gcf-legacy.yml`, and remove `hfy-check-allowed` from the `LambdaDeploy` statement in `github-roles.yaml`.
- `add-api-behavior.sh` refuses to run until it knows where `/api/check-allowed` should go. Pass `--legacy-origin` with the ID of the site's S3 origin. The pin then sends that path to the bucket, which answers `403`, and nothing else changes.
- Members cannot sign in until `authV2` is on ([Toggle a feature flag](toggle-a-feature-flag.md)).

## Steps

### 1. Create the site bucket

Create the bucket in `us-west-2`, the region the deploy workflow uses, and turn on all four Block Public Access settings:

```sh
aws s3api create-bucket --bucket <site-bucket> --region us-west-2 \
  --create-bucket-configuration LocationConstraint=us-west-2
aws s3api put-public-access-block --bucket <site-bucket> \
  --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
```

The bucket policy admits only the distribution, through Origin Access Control. It names the distribution, so you apply it at the end of step 3. Save this sample now as `bucket-policy.json`, outside the repository:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowCloudFrontOAC",
      "Effect": "Allow",
      "Principal": { "Service": "cloudfront.amazonaws.com" },
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::<site-bucket>/*",
      "Condition": {
        "StringEquals": {
          "AWS:SourceArn": "arn:aws:cloudfront::<aws-account-id>:distribution/<distribution-id>"
        }
      }
    }
  ]
}
```

The policy grants `s3:GetObject` and nothing else. A path with no object therefore returns `403`, not `404`, through CloudFront as well as directly. The deploy role writes to the bucket with its own IAM permissions, which this policy does not limit. The CORS rule that member photo uploads need is applied in [Deploy the app stack](deploy-the-app-stack.md#7-apply-the-photo-upload-cors-rule), not on this page.

### 2. Request the certificate

CloudFront accepts certificates only from `us-east-1`, wherever the bucket is.

```sh
aws acm request-certificate --region us-east-1 \
  --domain-name <site> --subject-alternative-names www.<site> \
  --validation-method DNS --query CertificateArn --output text
```

Keep the printed `<certificate-arn>`. List the validation records, add each one at your DNS provider as a DNS-only CNAME, and wait for the certificate to be issued:

```sh
aws acm describe-certificate --region us-east-1 --certificate-arn <certificate-arn> \
  --query 'Certificate.DomainValidationOptions[].ResourceRecord' --output table
aws acm wait certificate-validated --region us-east-1 --certificate-arn <certificate-arn>
```

The validation records can take a minute to appear in the first command's output. Leave them in place, because ACM uses them to renew the certificate.

### 3. Create the distribution

Start from [`cloudfront/distribution.json`](../../cloudfront/distribution.json). The template is not ready to create as it stands: its origin has no Origin Access Control, and it has no `CallerReference`, root object or headers policy. First create the two resources the distribution refers to.

**a. Create the Origin Access Control.**

```sh
aws cloudfront create-origin-access-control --origin-access-control-config \
  Name=<site-bucket>-oac,SigningProtocol=sigv4,SigningBehavior=always,OriginAccessControlOriginType=s3 \
  --query 'OriginAccessControl.Id' --output text
```

Keep the printed `<oac-id>`.

**b. Create the security-headers response policy.** Save this as `security-headers.json`. It sets four security headers: `Strict-Transport-Security`, `X-Content-Type-Options`, `X-Frame-Options` and `Referrer-Policy`.

```json
{
  "Name": "<policy-name>",
  "Comment": "Security headers for the family site",
  "SecurityHeadersConfig": {
    "StrictTransportSecurity": { "Override": true, "AccessControlMaxAgeSec": 31536000, "IncludeSubdomains": true, "Preload": true },
    "ContentTypeOptions": { "Override": true },
    "FrameOptions": { "Override": true, "FrameOption": "DENY" },
    "ReferrerPolicy": { "Override": true, "ReferrerPolicy": "strict-origin-when-cross-origin" }
  }
}
```

`IncludeSubdomains` applies HTTPS-only to every subdomain of `<site>`. `Preload` only adds the directive. It takes effect once the domain is submitted to the browsers' preload list, and that is slow to undo. Drop either setting if it does not fit your domain.

```sh
aws cloudfront create-response-headers-policy \
  --response-headers-policy-config file://security-headers.json \
  --query 'ResponseHeadersPolicy.Id' --output text
```

Keep the printed `<headers-policy-id>`.

**c. Fill in a copy of the template.** Copy `cloudfront/distribution.json` outside the repository and make these changes. The template also carries the legacy API Gateway origin and the `/api/*` behavior that reaches it. Keep them, with `Origins.Items[1].DomainName` and `OriginPath` set to your legacy API Gateway's domain and stage, only if you run the legacy path. Otherwise delete that origin and the whole `CacheBehaviors` block, and set `Origins.Quantity` to `1`.

| Field | Template | Set to |
| --- | --- | --- |
| `CallerReference` | Absent | Any string unique to this request, such as `site-<yyyymmdd>` |
| `Aliases.Items` | `example.com`, `www.example.com` | `<site>`, `www.<site>` |
| `Origins.Items[0].DomainName` | `example-bucket.s3.amazonaws.com` | `<site-bucket>.s3.us-west-2.amazonaws.com` |
| `Origins.Items[0].OriginAccessControlId` | Absent | `<oac-id>`. Keep `S3OriginConfig` with its empty `OriginAccessIdentity`; an S3 origin that uses OAC needs both. |
| `DefaultRootObject` | Absent | `index.html` |
| `DefaultCacheBehavior.ResponseHeadersPolicyId` | Absent | `<headers-policy-id>` |
| `ViewerCertificate.ACMCertificateArn` | Placeholder | `<certificate-arn>` |

Keep the rest of the template as it is. That includes `PriceClass_100`, `redirect-to-https`, compression, GET and HEAD only, and cache policy `658327ea-f89d-4fab-a63d-7e88639e58f6` (the managed CachingOptimized policy).

**d. Create the distribution and wait for it.**

```sh
aws cloudfront create-distribution --cli-input-json file://<path-to-copy>/distribution.json \
  --query 'Distribution.[Id,DomainName,ARN]' --output text
aws cloudfront wait distribution-deployed --id <distribution-id>
```

Keep the ID as `<distribution-id>` and the domain name, which ends in `cloudfront.net`, for step 5.

**e. Admit the distribution to the bucket.** Put the distribution ID and account ID into `bucket-policy.json` from step 1, then apply it:

```sh
aws s3api put-bucket-policy --bucket <site-bucket> --policy file://bucket-policy.json
```

### 4. Create and attach HFYAppendIndex

[`scripts/cloudfront/append-index.js`](../../scripts/cloudfront/append-index.js) rewrites a URI that ends in `/` to `.../index.html`, and a URI with no `.` to `.../index.html`. Without it, a clean URL such as `/about/` returns `403`. The rewrite rules are listed in [Architecture](../reference/architecture.md#hfyappendindex).

Check whether the function already exists in the account:

```sh
aws cloudfront describe-function --name HFYAppendIndex --query ETag --output text
```

If the command fails with `NoSuchFunctionExists`, create the function:

```sh
aws cloudfront create-function --name HFYAppendIndex \
  --function-config Comment="Append index.html to directory paths",Runtime=cloudfront-js-1.0 \
  --function-code fileb://scripts/cloudfront/append-index.js
```

If it exists, update it with its current ETag:

```sh
aws cloudfront update-function --name HFYAppendIndex \
  --if-match "$(aws cloudfront describe-function --name HFYAppendIndex --query ETag --output text)" \
  --function-config Comment="Append index.html to directory paths",Runtime=cloudfront-js-1.0 \
  --function-code fileb://scripts/cloudfront/append-index.js
```

Either way, publish it. A created or updated function is only in the `DEVELOPMENT` stage, and viewers get `LIVE`:

```sh
aws cloudfront publish-function --name HFYAppendIndex \
  --if-match "$(aws cloudfront describe-function --name HFYAppendIndex --query ETag --output text)"
```

Attach it to the default behavior on viewer-request:

```sh
FN_ARN=$(aws cloudfront describe-function --name HFYAppendIndex --stage LIVE \
  --query 'FunctionSummary.FunctionMetadata.FunctionARN' --output text)
aws cloudfront get-distribution-config --id <distribution-id> > dist-current.json
jq --arg arn "$FN_ARN" '.DistributionConfig
  | .DefaultCacheBehavior.FunctionAssociations =
      {Quantity: 1, Items: [{FunctionARN: $arn, EventType: "viewer-request"}]}' \
  dist-current.json > dist-new.json
aws cloudfront update-distribution --id <distribution-id> \
  --if-match "$(jq -r .ETag dist-current.json)" --distribution-config file://dist-new.json
aws cloudfront wait distribution-deployed --id <distribution-id>
```

This replaces any other function association on the default behavior, which a new distribution does not have. Later code changes need only the update and publish commands. The association holds the function's ARN, which publishing does not change, so it stays in place.

### 5. Point DNS at the distribution

Point the apex and `www` at the distribution's `cloudfront.net` domain.

- **Route 53.** Create an alias `A` record for each name. Its target is the distribution domain, with hosted zone ID `Z2FDTNDATAQYW2`, the fixed zone for CloudFront aliases.
- **Another provider.** Create a CNAME for `www`. For the apex, use the record type your provider offers for pointing an apex at a hostname: ALIAS, ANAME or a flattened CNAME.

If Cloudflare proxies the records, set its SSL/TLS mode to Full (strict). Cloudflare then caches in front of CloudFront, and the deploy's CloudFront invalidation does not purge Cloudflare's copies.

### 6. Create the deploy role and its secret

The deploy workflow uses no stored AWS keys. It assumes `harrisonfamily-github-deploy-role` through GitHub's OIDC provider, and the stack only references that provider. Check that the account has one:

```sh
aws iam list-open-id-connect-providers --query 'OpenIDConnectProviderList[].Arn' --output text
```

If no ARN ends in `token.actions.githubusercontent.com`, create the provider:

```sh
aws iam create-open-id-connect-provider \
  --url https://token.actions.githubusercontent.com --client-id-list sts.amazonaws.com
```

Deploy the stack. The overrides can be left out when the template defaults already match your environment.

```sh
aws cloudformation deploy --stack-name harrisonfamily-github-roles \
  --template-file infrastructure/cloudformation/github-roles.yaml \
  --capabilities CAPABILITY_NAMED_IAM --region us-west-2 \
  --parameter-overrides GitHubOrg=<github-owner> GitHubRepo=<github-repo> \
    OIDCProviderArn=arn:aws:iam::<aws-account-id>:oidc-provider/token.actions.githubusercontent.com
```

Set the repository secret from the stack's `DeployRoleArn` output:

```sh
gh secret set AWS_DEPLOY_ROLE_TO_ASSUME --repo <github-owner>/<github-repo> --body "$(
  aws cloudformation describe-stacks --stack-name harrisonfamily-github-roles --region us-west-2 \
    --query "Stacks[0].Outputs[?OutputKey=='DeployRoleArn'].OutputValue" --output text)"
```

Only runs on `main` can assume the role. It may write to `<site-bucket>` except under `uploads/`, create and read invalidations on `<distribution-id>`, and update the code, versions and aliases of the three named functions. Nothing else is granted. The trust policy and permissions are listed in [Repository operations](../reference/repository-operations.md#deploy-role-github-rolesyaml).

### 7. Create the Google web client

Both sign-in paths render the Google Identity Services button and post the Google ID token themselves, so Google redirects nowhere and the client needs only authorized JavaScript origins. [The identity model](../explanation/identity-model.md#one-edge-several-methods) explains how each path uses the token.

1. In the Google Cloud console, choose or create a project. Under **Google Auth Platform**, fill in the branding, set the audience to **External**, and publish the app. While it is in **Testing**, only listed test users can sign in.
2. Under **Clients**, create a client of type **Web application**. Add `https://<site>` and `https://www.<site>` as authorized JavaScript origins. Add both `http://localhost` and `http://localhost:<port>` only if you test sign-in against a local server.
3. Leave the redirect URIs empty. Nothing uses the client secret that Google generates, so do not store it. The client needs no redirect URIs, no client secret and no other Google API.
4. Set the client ID as a repository secret:

   ```sh
   gh secret set HFY_GOOGLE_CLIENT_ID --repo <github-owner>/<github-repo> --body "<google-web-client-id>"
   ```

The pipeline's build step writes this value over the placeholder `REPLACE_WITH_GOOGLE_CLIENT_ID` in the committed pages ([Front end](../reference/front-end.md#what-11ty-contains)). Keep `<google-web-client-id>` for the `GoogleClientId` parameter in [Deploy the app stack](deploy-the-app-stack.md). To replace the client later, follow [Rotate the Google sign-in client](rotate-the-google-client.md).

## Verify

The bucket is empty until the first deploy, so run that first.

1. **The first deploy is green.** Ship through [Deploy a site change](deploy-a-site-change.md), or start a run on `main` by hand and watch it:

   ```sh
   gh workflow run io-kit-deploy.yml --repo <github-owner>/<github-repo> --ref main
   gh run list --repo <github-owner>/<github-repo> --workflow io-kit-deploy.yml --limit 1
   gh run watch <run-id> --repo <github-owner>/<github-repo>
   ```

   `build`, `deploy`, `invalidate` and `smoke` succeed. On the first deploy there is no earlier release, so if `smoke` fails, `rollback_on_smoke_fail` fails too, with `no previous successful run`. The run of `deploy-gcf-legacy.yml` from the same push also succeeds, if you kept it.
2. **The site answers through CloudFront.**

   ```sh
   curl -sI "https://<site>/" | grep -iE '^(HTTP|x-cache|strict-transport-security)'
   ```

   You see a `200` status line, an `x-cache` header from CloudFront, and the `strict-transport-security` header from step 3.
3. **Directory URLs resolve through HFYAppendIndex.**

   ```sh
   for p in /about/ /about; do
     curl -s -o /dev/null -w "%{http_code} $p\n" "https://<site>$p"
   done
   ```

   Both lines start with `200`.
4. **The bucket is not reachable directly.**

   ```sh
   curl -s -o /dev/null -w "%{http_code}\n" "https://<site-bucket>.s3.us-west-2.amazonaws.com/index.html"
   ```

   The result is `403`.

| Symptom | Likely cause |
| --- | --- |
| The `build` job fails | `HFY_GOOGLE_CLIENT_ID` is missing or empty |
| The `deploy` job fails at the AWS credentials step | `AWS_DEPLOY_ROLE_TO_ASSUME` is missing or wrong, the run is not on `main`, or `GitHubOrg`/`GitHubRepo` do not match the repository |
| The `deploy` job fails at the Lambda update | The `hfy-check-allowed` [legacy piece](#legacy-pieces) is missing. The site sync has already run. |
| `deploy-gcf-legacy.yml` fails | A Google Cloud [legacy piece](#legacy-pieces) is missing, or the service account cannot deploy in the project |
| The `smoke` job fails | The site does not answer on the `smoke` URLs in `ci.manifest.yaml`. Check the next rows. |
| Every path returns `403` | The bucket policy is missing or names the wrong distribution, the origin has no OAC, or the bucket is still empty |
| `/` works but `/about/` returns `403` | `HFYAppendIndex` is not published to `LIVE` or not attached on viewer-request |
| TLS error | The certificate is not issued or does not cover the name, or DNS still points elsewhere |

## Related pages

- [Edge and origin design](../explanation/edge-and-origin-design.md): why one distribution fronts everything and the bucket is reachable only through it.
- [Architecture](../reference/architecture.md): the distribution, the buckets, the deploy role and the secrets, as built.
- [Private data and secrets](../reference/private-data-and-secrets.md): placeholders, and where real values may live.
- [Repository operations](../reference/repository-operations.md): the deploy workflow and the repo's guards.
- [Deploy the app stack](deploy-the-app-stack.md), [Manage family access](manage-family-access.md), [Refresh the family data](refresh-the-family-data.md), [Deploy a site change](deploy-a-site-change.md), [Rotate the Google sign-in client](rotate-the-google-client.md), [Diagnose sign-in and API failures](diagnose-sign-in-and-api-failures.md).
