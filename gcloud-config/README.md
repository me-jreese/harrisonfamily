# Google Cloud Configuration

## Overview

This directory contains **sanitized sample configurations** for Google Cloud services used in the family genealogy site architecture. Real credentials and environment-specific configs belong in `workspace-local/gcloud-config/` and must never be committed to Git.

## Services Used

### 1. Google Cloud Secret Manager
Stores the email allowlist for Google Identity Services authentication.

**Secret Name:** `harrisonfamily-allowlist` (or `your-family-allowlist`)
**Secret Value:** JSON array of authorized email addresses

```json
[
  "jane.smith@example.com",
  "john.doe@example.com",
  "researcher@example.org"
]
```

**Why Secret Manager?**
- Google Identity Services can reference this secret to pre-filter sign-in attempts
- Centralized access control without hardcoding emails in Lambda/Cloud Functions
- Version history lets you audit who had access at any point in time

### 2. Google Cloud Functions
Hosts the `getAllowlist` helper function that validates Secret Manager configuration.

**Function Name:** `getAllowlist`
**Region:** `us-west2`
**Runtime:** Python 3.11
**Entry Point:** `get_allowlist`
**Environment Variables:**
- `HFY_ALLOWLIST_SECRET=projects/YOUR_PROJECT_ID/secrets/harrisonfamily-allowlist/versions/latest`
- `GCP_PROJECT=your-gcp-project-id`

**Source:** `workspace/gcloud/allowlist-fn/main.py`

**What it does:**
- Accepts HTTP GET requests
- Fetches the latest allowlist secret from Secret Manager
- Returns JSON array of emails (for manual verification only)
- Used during development to confirm allowlist updates propagated

### 3. Google Identity Services (OAuth 2.0)
Provides the authentication layer for family members signing in.

**Credentials Location:** `workspace-local/gcloud-config/oauth_credentials.json`

**OAuth Client Configuration:**
```json
{
  "web": {
    "client_id": "123456789-abcdefghijklmnop.apps.googleusercontent.com",
    "client_secret": "GOCSPX-your_secret_here",
    "redirect_uris": [
      "https://yourfamily.us",
      "http://localhost:8081"
    ],
    "javascript_origins": [
      "https://yourfamily.us",
      "http://localhost:8081"
    ]
  }
}
```

**Setup Steps:**
1. Create new Google Cloud Project (or use existing)
2. Enable **Google+ API** and **Identity Toolkit API**
3. Navigate to **APIs & Services > Credentials**
4. Create **OAuth 2.0 Client ID** (Application type: Web application)
5. Add authorized JavaScript origins and redirect URIs
6. Download JSON credentials to `workspace-local/gcloud-config/`
7. Extract `client_id` for use in Eleventy builds via `HFY_GOOGLE_CLIENT_ID` env var

## Setting Up Your Environment

### Prerequisites
1. Install Google Cloud CLI: https://cloud.google.com/sdk/docs/install
2. Authenticate: `gcloud auth login`
3. Set project: `gcloud config set project YOUR_PROJECT_ID`

### Enable Required APIs
```bash
gcloud services enable secretmanager.googleapis.com
gcloud services enable cloudfunctions.googleapis.com
gcloud services enable run.googleapis.com
gcloud services enable cloudbuild.googleapis.com
```

### Create Secret Manager Secret
```bash
# Create initial secret from local file
gcloud secrets create harrisonfamily-allowlist \
  --data-file=workspace-local/allowlist/harrisonfamily-allowlist.json \
  --replication-policy=automatic

# Grant Cloud Function service account access
gcloud secrets add-iam-policy-binding harrisonfamily-allowlist \
  --member="serviceAccount:YOUR_PROJECT_ID@appspot.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"
```

### Deploy Cloud Function
```bash
cd workspace/gcloud/allowlist-fn

gcloud functions deploy getAllowlist \
  --runtime=python311 \
  --trigger-http \
  --allow-unauthenticated \
  --region=us-west2 \
  --entry-point=get_allowlist \
  --set-env-vars="HFY_ALLOWLIST_SECRET=projects/YOUR_PROJECT_ID/secrets/harrisonfamily-allowlist/versions/latest,GCP_PROJECT=YOUR_PROJECT_ID"
```

**Test the deployment:**
```bash
gcloud functions call getAllowlist --region=us-west2
```

Expected output:
```json
{
  "allowlist": ["jane.smith@example.com", "john.doe@example.com"]
}
```

## Managing Allowlists

### Adding New Family Members
1. Edit `workspace-local/allowlist/initial_allowlist.csv`:
   ```csv
   email,grampsId,displayName
   jane.smith@example.com,I0001,Jane Smith
   john.doe@example.com,I0002,John Doe
   newperson@example.com,I0150,New Person
   ```

2. Regenerate allowlist artifacts:
   ```bash
   # This creates harrisonfamily-allowlist.json + userGrampsID.json
   python3 scripts/infra/generate_allowlist_artifacts.py \
     --csv workspace-local/allowlist/initial_allowlist.csv \
     --output workspace-local/allowlist
   ```

3. Publish to Google Secret Manager + S3:
   ```bash
   scripts/infra/publish_allowlists.sh
   ```

This script:
- Creates new Secret Manager version with updated email array
- Uploads `userGrampsID.json` to `s3://your-family/config/userGrampsID.json`
- Logs the snapshot to `docs/dev/allowlist-publish.md`

### Removing Family Members
Follow the same process, but delete their row from `initial_allowlist.csv` before regenerating.

## Service Account Configuration

### For GitHub Actions CI/CD
Create a service account with minimal necessary permissions:

```bash
# Create service account
gcloud iam service-accounts create github-actions \
  --display-name="GitHub Actions Deployer"

# Grant permissions
gcloud projects add-iam-policy-binding YOUR_PROJECT_ID \
  --member="serviceAccount:github-actions@YOUR_PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/cloudfunctions.developer"

gcloud projects add-iam-policy-binding YOUR_PROJECT_ID \
  --member="serviceAccount:github-actions@YOUR_PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"

# Generate key (NEVER commit this)
gcloud iam service-accounts keys create \
  workspace-local/gcloud-config/github-actions-key.json \
  --iam-account=github-actions@YOUR_PROJECT_ID.iam.gserviceaccount.com
```

Store the JSON key content as GitHub Secret: `GCP_SERVICE_ACCOUNT_KEY`

## Troubleshooting

### OAuth Sign-In Button Not Appearing
- Verify `HFY_GOOGLE_CLIENT_ID` is set during Eleventy build
- Check browser console for `gsi` library load errors
- Confirm authorized JavaScript origins include your domain

### Secret Manager Access Denied
- Ensure Cloud Function service account has `secretmanager.secretAccessor` role
- Check that secret name matches exactly (case-sensitive)
- Verify secret exists: `gcloud secrets describe harrisonfamily-allowlist`

### Allowlist Updates Not Reflecting
- Secret Manager uses versioned secrets; old versions remain cached
- Wait 60 seconds for Cloud Function cold starts to pick up new version
- Force refresh: disable/re-enable the function or update env vars

### 403 Errors from `/api/check-allowed`
- Lambda may be reading stale `userGrampsID.json` from S3
- Invalidate CloudFront: `aws cloudfront create-invalidation --distribution-id YOUR_ID --paths "/api/*"`
- Check Lambda logs: `aws logs tail /aws/lambda/hfy-check-allowed --follow`

## Cost Estimates

All Google Cloud services used here fall within free tier for low-traffic family sites:

- **Secret Manager:** First 6 secret versions/month free, $0.06/version thereafter
- **Cloud Functions:** 2 million invocations/month free
- **Cloud Build:** 120 build-minutes/day free
- **Secret access operations:** 10,000/month free

Expected monthly cost: **$0** for typical genealogy site usage

## Security Best Practices

1. **Never commit credentials** – All `*-key.json` and OAuth secrets go in `workspace-local/`
2. **Rotate secrets annually** – Update OAuth client secret and service account keys yearly
3. **Scope IAM tightly** – Service accounts should have minimum permissions needed
4. **Enable audit logging** – Track Secret Manager access via Cloud Logging
5. **Use separate projects** – Consider dev/staging/prod GCP projects for isolation

---

**For AWS infrastructure setup (Lambda, S3, CloudFront), see `../cloudfront/README.md` and the main project documentation.**
