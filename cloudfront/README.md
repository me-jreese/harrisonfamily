# CloudFront Distribution Configuration

## Overview

This directory contains **sample CloudFront configurations** for the family genealogy site CDN layer. Real distribution exports with specific ARNs and certificate IDs belong in `workspace-local/cloudfront/` and should not be committed to Git.

## Architecture Overview

The genealogy site uses a **single CloudFront distribution** that serves:
- Static site files (HTML/CSS/JS) from S3 bucket root
- Person/family/event/media JSON from S3 subdirectories
- API Gateway endpoints for `/api/check-allowed` authentication

**Key design decisions:**
- No Lambda@Edge or CloudFront Functions for data processing (keeps costs low). One exception: the private data gate below (HFY-TSK-080) is a single Lambda@Edge viewer-request function on the data paths only
- CloudFront Function for clean URL rewrites (`/about/` → `/about/index.html`)
- Origin Access Control (OAC) instead of legacy Origin Access Identity (OAI)
- PriceClass_100 (North America + Europe only) to minimize costs

## Distribution Configuration

### Basic Settings
```
Distribution Domain: d1a2b3c4d5e6f7.cloudfront.net
Alternate Domain Names (CNAMEs): yourfamily.us, www.yourfamily.us
Price Class: PriceClass_100 (Use Only US, Canada, Europe)
Default Root Object: index.html
IPv6: Enabled
HTTP Version: HTTP/2
```

### Origins

#### Origin 1: S3 Static Site + Data
```
Origin Domain: your-family-frontend.s3.us-west-2.amazonaws.com
Origin Path: (empty)
Origin Access: Origin Access Control
OAC Name: your-family-OAC
Origin Protocol: HTTPS only
```

**Why OAC over OAI:**
- OAC supports all S3 features (SSE-KMS, cross-region replication)
- Signature v4 signing (more secure than OAI)
- OAI is legacy and will be deprecated

#### Origin 2: API Gateway (optional for /api/* paths)
```
Origin Domain: abc123.execute-api.us-west-2.amazonaws.com
Origin Path: /prod
Origin Protocol: HTTPS only
Custom Headers: None (auth via Lambda)
```

### Behaviors

#### Default Behavior (/**)
```
Path Pattern: Default (*)
Origin: S3 origin
Viewer Protocol Policy: Redirect HTTP to HTTPS
Allowed HTTP Methods: GET, HEAD, OPTIONS
Cached HTTP Methods: GET, HEAD
Cache Policy: CachingOptimized (managed policy)
Origin Request Policy: CORS-S3Origin (managed policy)
Response Headers Policy: SecurityHeadersPolicy (custom - see below)
Compress Objects: Yes
Function Associations:
  - Viewer Request: HFYAppendIndex (CloudFront Function)
```

#### API Behavior (/api/*), legacy
```
Path Pattern: /api/*
Origin: API Gateway origin
Viewer Protocol Policy: HTTPS only
Allowed HTTP Methods: GET, HEAD, OPTIONS, PUT, POST, PATCH, DELETE
Cache Policy: CachingDisabled (managed policy)
Origin Request Policy: AllViewer (managed policy)
```
This is the pre-app layout (and what `distribution.json` still shows). `scripts/infra/add-api-behavior.sh` moves `/api/*` to hfy-api and
keeps `/api/check-allowed` on this origin; see the next section.

#### App behaviors (scripts/infra, HFY-R58)

CloudFront uses the first behavior whose path pattern matches, so order matters. After the three scripts have run, the behaviors are:

| Order | Path pattern | Origin | Notes |
| --- | --- | --- | --- |
| (existing) | e.g. `/person/*` | S3 | untouched, positions kept |
| before `/api/*` | `/api/check-allowed*` | whatever served `/api/check-allowed` before (the hfy-check-allowed API Gateway) | Legacy Google sign-in still POSTs here. Cloned from the old `/api/*` behavior, kept as is on every rerun, retired by HFY-TSK-069 |
| | `/api/*` | `hfy-api-origin` (Function URL + `X-Origin-Verify`) | CachingDisabled, AllViewerExceptHostHeader |
| | `/auth/*`, `/.well-known/oauth-authorization-server*` | `hfy-auth-origin` (Function URL + `X-Origin-Verify`) | CachingDisabled, AllViewerExceptHostHeader |
| | `/uploads/*` | the S3 origin of the default behavior | GET/HEAD, CachingOptimized, response headers policy `UploadsResponseHeadersPolicyId` from app-stack: `X-Content-Type-Options: nosniff` and `Content-Security-Policy: sandbox; default-src 'none'; img-src 'self'` |

Scripts (each takes `--dry-run`, and `--config-file FILE` for an offline dry run against an export):

- `add-api-behavior.sh`: refuses (exit 3) if it cannot find a non-hfy-api origin serving `/api/check-allowed` and no
  `/api/check-allowed*` pin exists; `--legacy-origin ORIGIN_ID` then names the origin to pin it to.
- `add-auth-behavior.sh`: auth edge origin and behaviors.
- `add-uploads-behavior.sh`: `/uploads/*` with the response headers policy (`--response-headers-policy-id` overrides the stack output).
- `add-data-gate-behaviors.sh`: the private data gate (next section); `--remove` rolls it back.

All three merge in place: an existing origin or behavior keeps its position and every field the script does not manage. When the
result equals the live config (ignoring how CloudFront orders string sets and fills in defaults) they print `no change` and do not
call `update-distribution`. Before a real update they save the pre-change config (mode 600, it holds the origin-verify header) under
`${HFY_CF_BACKUP_DIR:-~/.local/state/hfy-infra/cloudfront}` and print the rollback command. Offline tests: `scripts/infra/test/run.sh`.

#### Private data gate (HFY-TSK-080, HFY-R63)

Person and related JSON used to be served publicly from the bucket by the default behavior (the legacy `X-HFY-Session` header was
never validated). The gate closes that: `edge-gate/` is a dependency-free Lambda@Edge viewer-request function (Node 22) that
verifies the `io_id` session cookie minted by the auth edge (RS256 signature against `https://harrisonfamily.us/auth/.well-known/jwks.json`,
`iss`, `aud`, `exp`/`nbf` with 60 s skew; JWKS cached per container with a 300 s TTL, one refetch per 30 s on an unknown `kid`).
Issuer, audience and JWKS URL are baked in at build time from `edge-gate/gate.config.json` (Lambda@Edge has no environment variables;
a test pins them to `auth/edge.manifest.json`). Allowed requests pass unchanged. Denied ones get `401 {"error":"unauthenticated"}`
(`Cache-Control: no-store`) for fetch/XHR/subresources, or `302 /auth/login?returnTo=<path>` for top-level navigations.

`scripts/infra/add-data-gate-behaviors.sh` attaches it with `CachingDisabled` (no response is ever shared between users) to
`/person/*.json`, `/family/*`, `/event/*`, `/note/*`, `/place/*`, `/media/*` on the site's S3 origin. It is `/person/*.json`, not
`/person/*`, because `/person/` is the public person-page shell that the default behavior's HFYAppendIndex function resolves to
`index.html`. New behaviors are appended after the existing ones (api, auth, uploads); a gated pattern is only moved when an
existing broader behavior such as the legacy `/person/*` would shadow it. Nothing else changes. It merges in place, so reruns are a true no-op.

Cutover order (the HFY-TSK-069 runbook step; the gate and the authV2 flip ship together):

1. Build (no npm install, no CodeArtifact token): `bash scripts/ci/package-edge-gate.sh` (prints `CodeSha256=`); upload `dist/hfy-edge-gate.zip` to a **us-east-1** bucket.
2. `aws cloudformation deploy --region us-east-1 --stack-name hfy-edge-gate --template-file infrastructure/cloudformation/edge-gate-stack.yaml --capabilities CAPABILITY_NAMED_IAM --parameter-overrides CodeBucket=<bucket> CodeSha256=<sha>`. The stack publishes the version (`AWS::Lambda::Version`) and outputs `EdgeGateVersionArn`.
3. `scripts/infra/add-data-gate-behaviors.sh --dry-run`, review the diff, then run it without `--dry-run` (reads the ARN from the stack, saves a backup). Wait for the distribution to deploy (a Lambda@Edge association takes minutes).
4. Flip `authV2` to `true` in `11ty/_data/flags.json` and deploy the site. Verify signed in (data loads) and signed out (`curl -i https://harrisonfamily.us/person/index.json` is 401 JSON).

**Why 3 and 4 are one change:** with the gate live, an `authV2`-off visitor has no `io_id` request path: the legacy client sends `X-HFY-Session`
and `credentials: include`, so a visitor who happens to hold an edge session still works, but anyone on the legacy Google sign-in only
cannot read person, search or media data. Under `authV2` the client (`HFYFeatureFlags.dataFetchInit`) fetches with `credentials: 'same-origin'`,
sends no `X-HFY-Session`, and a gate 401 redirects to `/auth/login?returnTo=...`. Apply step 4 immediately after step 3 (or use the
`?hfy_flags=authV2` preview to check first). Islands (`islands/`, committed bundle) still use the legacy token wait and need a rebuild with
`scripts/ci/build-islands.sh` before `searchV2`/`personV2` are used under `authV2`.

Rollback: set `authV2` back to `false` only if you also remove the gate, because the legacy flow cannot read gated data. Then
`scripts/infra/add-data-gate-behaviors.sh --remove` (deletes exactly the six gated behaviors, and only ones carrying the hfy-edge-gate
association; data is public again once the distribution deploys). The pre-change config is also saved under
`${HFY_CF_BACKUP_DIR:-~/.local/state/hfy-infra/cloudfront}`; restore it with `aws cloudfront update-distribution --if-match <ETag>`.
The Lambda stack can stay: replicas of a retained version are deleted by CloudFront hours after the last association is removed.
Tests: `node --test edge-gate/test/*.test.mjs tests/client/*.test.mjs` and `scripts/infra/test/run.sh`.

### CloudFront Functions

#### HFYAppendIndex (Viewer Request)
Rewrites directory URLs to append `index.html` before hitting S3 origin.

**Source:** See `workspace/cloudfront/functions/append-index.js`

```javascript
function handler(event) {
  var request = event.request;
  var uri = request.uri;

  // Append index.html to directory paths
  if (uri.endsWith('/')) {
    request.uri += 'index.html';
  }
  // Handle extensionless paths as directories
  else if (!uri.includes('.')) {
    request.uri += '/index.html';
  }

  return request;
}
```

**Why this is needed:**
- S3 serves `about/index.html` but not `about/`
- Without rewrite, clean URLs return 403 AccessDenied XML
- CloudFront Functions run at edge (faster + cheaper than Lambda@Edge)

**Deploy this function:**
```bash
# Create function
aws cloudfront create-function \
  --name HFYAppendIndex \
  --function-config Comment="Append index.html to directory paths",Runtime=cloudfront-js-1.0 \
  --function-code fileb://workspace/cloudfront/functions/append-index.js

# Publish function
aws cloudfront publish-function \
  --name HFYAppendIndex \
  --if-match ETAG_FROM_CREATE_RESPONSE

# Associate with distribution (update distribution config to reference function ARN)
```

### SSL/TLS Certificate

**ACM Certificate ARN:** `arn:aws:acm:us-east-1:123456789012:certificate/abc-def-ghi`

**Important:** ACM certificates for CloudFront **must** be in `us-east-1` region, regardless of where your S3 bucket lives.

**Setup Steps:**
1. Request certificate in ACM (us-east-1):
   ```bash
   aws acm request-certificate \
     --domain-name yourfamily.us \
     --subject-alternative-names www.yourfamily.us \
     --validation-method DNS \
     --region us-east-1
   ```

2. Validate via DNS (add CNAME records to your DNS provider):
   ```
   Name: _abc123.yourfamily.us
   Type: CNAME
   Value: _def456.acm-validations.aws.
   TTL: Auto (or 300)
   ```

3. Wait for certificate status to change to "Issued"
   ```bash
   aws acm describe-certificate \
     --certificate-arn YOUR_CERT_ARN \
     --region us-east-1 \
     --query 'Certificate.Status'
   ```

4. Attach certificate to CloudFront distribution in viewer settings

### Custom Response Headers Policy

Create a custom policy to add security headers:

```json
{
  "Name": "FamilySiteSecurityHeaders",
  "Comment": "Security headers for genealogy site",
  "CustomHeadersConfig": {
    "Items": [
      {
        "Header": "Strict-Transport-Security",
        "Value": "max-age=31536000; includeSubDomains; preload",
        "Override": true
      },
      {
        "Header": "X-Content-Type-Options",
        "Value": "nosniff",
        "Override": true
      },
      {
        "Header": "X-Frame-Options",
        "Value": "DENY",
        "Override": true
      },
      {
        "Header": "Referrer-Policy",
        "Value": "strict-origin-when-cross-origin",
        "Override": true
      }
    ]
  }
}
```

## S3 Bucket Policy

Your S3 bucket must restrict access to **only** the CloudFront distribution:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowCloudFrontOAC",
      "Effect": "Allow",
      "Principal": {
        "Service": "cloudfront.amazonaws.com"
      },
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::your-family-frontend/*",
      "Condition": {
        "StringEquals": {
          "AWS:SourceArn": "arn:aws:cloudfront::123456789012:distribution/E1A2B3C4D5E6F7"
        }
      }
    }
  ]
}
```

**Block Public Access settings:**
- Block all public access: **ON**
- Block public ACLs: **ON**
- Ignore public ACLs: **ON**
- Block public bucket policies: **ON**
- Restrict public buckets: **ON**

All traffic flows through CloudFront; S3 is never directly accessible.

## DNS Configuration (Cloudflare Example)

Point your domain at CloudFront using CNAME records:

```
Type: CNAME
Name: @ (apex)
Target: d1a2b3c4d5e6f7.cloudfront.net
Proxy: Enabled (orange cloud)
TTL: Auto
```

```
Type: CNAME
Name: www
Target: d1a2b3c4d5e6f7.cloudfront.net
Proxy: Enabled (orange cloud)
TTL: Auto
```

**Cloudflare-specific notes:**
- Enabling proxy (orange cloud) adds Cloudflare's CDN layer on top of CloudFront
- Provides additional DDoS protection and caching at Cloudflare edge
- May cause double-caching; tune CloudFront cache TTLs accordingly
- Ensure Cloudflare SSL/TLS mode is set to "Full (strict)"

**If using Route 53 instead:**
```bash
aws route53 change-resource-record-sets \
  --hosted-zone-id YOUR_ZONE_ID \
  --change-batch file://dns-change.json
```

```json
{
  "Changes": [
    {
      "Action": "UPSERT",
      "ResourceRecordSet": {
        "Name": "yourfamily.us",
        "Type": "A",
        "AliasTarget": {
          "HostedZoneId": "Z2FDTNDATAQYW2",
          "DNSName": "d1a2b3c4d5e6f7.cloudfront.net",
          "EvaluateTargetHealth": false
        }
      }
    }
  ]
}
```

## Cache Invalidation

After deploying new versions, invalidate CloudFront cache:

```bash
# Invalidate specific paths
aws cloudfront create-invalidation \
  --distribution-id E1A2B3C4D5E6F7 \
  --paths "/index.html" "/about/*" "/person/*"

# Invalidate everything (costs $0.005 per invalidation after 1000/month)
aws cloudfront create-invalidation \
  --distribution-id E1A2B3C4D5E6F7 \
  --paths "/*"
```

**Best practices:**
- Use specific paths when possible (cheaper, faster)
- Group related invalidations (`/person/*` instead of `/person/I0001.json`, `/person/I0002.json`, ...)
- For data-only updates, invalidate `/person/*` + `/media/*` but not static HTML
- GitHub Actions should auto-invalidate after successful deployments

**Monitor invalidation status:**
```bash
aws cloudfront get-invalidation \
  --distribution-id E1A2B3C4D5E6F7 \
  --id INVALIDATION_ID
```

## Monitoring & Logging

### Enable Access Logs
```bash
aws cloudfront update-distribution --id E1A2B3C4D5E6F7 \
  --distribution-config file://dist-config.json
```

```json
{
  "Logging": {
    "Enabled": true,
    "IncludeCookies": false,
    "Bucket": "your-family-logs.s3.amazonaws.com",
    "Prefix": "cloudfront/"
  }
}
```

### Useful CloudWatch Metrics
- `Requests` – Total number of viewer requests
- `BytesDownloaded` – Total bytes served
- `4xxErrorRate` – Client errors (404s, 403s)
- `5xxErrorRate` – Origin errors (500s from S3/API Gateway)

Set up alarms for elevated error rates:
```bash
aws cloudwatch put-metric-alarm \
  --alarm-name cloudfront-high-4xx \
  --metric-name 4xxErrorRate \
  --namespace AWS/CloudFront \
  --statistic Average \
  --period 300 \
  --threshold 5 \
  --comparison-operator GreaterThanThreshold \
  --evaluation-periods 1
```

## Troubleshooting

### AccessDenied Errors on Directory URLs
- Symptom: `/about/` returns S3 XML error instead of HTML
- Cause: CloudFront Function not attached or not handling path correctly
- Fix: Verify HFYAppendIndex function is associated with viewer-request event

### Certificate Not Trusted
- Symptom: Browser shows SSL warning
- Cause: Certificate not validated or wrong region
- Fix: Ensure ACM cert is in `us-east-1` and status is "Issued"

### Stale Content After Deployment
- Symptom: Old HTML/CSS served even after S3 upload
- Cause: CloudFront cache not invalidated
- Fix: Run `aws cloudfront create-invalidation` with appropriate paths

### High Data Transfer Costs
- Symptom: Unexpected AWS bill for CloudFront egress
- Cause: Large media files or high traffic
- Solutions:
  - Use PriceClass_100 (North America/Europe only)
  - Compress images before uploading (optimize JPEGs, use WebP)
  - Set longer cache TTLs to reduce origin fetches
  - Consider CloudFront quota/budget alerts

### 502/503 Errors from API Gateway
- Symptom: `/api/check-allowed` returns 5xx errors
- Cause: Lambda timeout or unhandled exception
- Fix: Check Lambda logs, increase timeout, add error handling

## Cost Optimization Tips

1. **Use PriceClass_100** – Serves from NA/EU only (~30% cheaper than global)
2. **Enable compression** – Reduces egress for text files (HTML/CSS/JS/JSON)
3. **Set appropriate TTLs** – Cache static assets for 1 year, HTML for 1 hour
4. **Minimize invalidations** – Use versioned filenames for assets instead (e.g., `main.abc123.css`)
5. **Monitor CloudWatch** – Set billing alerts at $10, $20, $30 thresholds

**Expected monthly costs for low-traffic site:**
- CloudFront requests: ~$0.50 (1M requests)
- CloudFront data transfer: ~$5 (50 GB egress)
- Total: **<$10/month**

## Exporting Current Configuration

Save your working distribution config for backup/version control:

```bash
aws cloudfront get-distribution-config \
  --id E1A2B3C4D5E6F7 \
  --query 'DistributionConfig' \
  > workspace-local/cloudfront/distribution-config.json
```

**Sanitize before committing:**
- Replace actual distribution ID with `YOUR_DIST_ID`
- Replace S3 bucket name with `your-family-frontend`
- Replace certificate ARN with placeholder
- Store sanitized version in `workspace/cloudfront/distribution-config.json`

---

**For Google Cloud setup (OAuth, Secret Manager), see `../gcloud-config/README.md`.**
