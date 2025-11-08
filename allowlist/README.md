# Email Allowlist Management

## Overview

This directory contains **sanitized sample allowlist artifacts** that demonstrate the dual-allowlist architecture used for authenticating family members. Real email addresses and Gramps ID mappings belong in `workspace-local/allowlist/` and must never be committed to Git.

## Dual Allowlist Architecture

The genealogy site uses **two separate allowlists** to balance security and functionality:

### 1. Google Secret Manager Allowlist
**File:** `harrisonfamily-allowlist.json` (simple email array)
**Storage:** Google Cloud Secret Manager
**Purpose:** Pre-filter Google Sign-In attempts before they reach the site

```json
[
  "jane.smith@example.com",
  "john.doe@example.com",
  "researcher@example.org"
]
```

**Why it's separate:**
- Google Identity Services can reference this secret to block unauthorized sign-ins at OAuth level
- Provides first line of defense before users even see your site
- Simpler format (just emails) reduces complexity in Google Cloud Function

### 2. Email-to-Gramps ID Mapping
**File:** `userGrampsID.json` (email → Gramps ID object)
**Storage:** Private S3 bucket (`s3://your-family/config/userGrampsID.json`)
**Purpose:** Enable personalized "My Record" navbar link

```json
{
  "jane.smith@example.com": "I0001",
  "john.doe@example.com": "I0042",
  "researcher@example.org": "I0150"
}
```

**Why it's separate:**
- AWS Lambda can fetch this quickly without exposing mapping publicly
- Allows visitors without a personal Gramps record (e.g., researchers) to still access the site
- Keeps Google Secret Manager simple (no complex objects)

## Source of Truth: CSV File

Both allowlist artifacts are generated from a single CSV file:

**File:** `workspace-local/allowlist/initial_allowlist.csv`

```csv
email,grampsId,displayName
jane.smith@example.com,I0001,Jane Smith
john.doe@example.com,I0042,John Doe
researcher@example.org,,Dr. Alice Researcher
```

**Important:** The `grampsId` column can be empty for users who don't have a person record (e.g., external researchers, spouses who aren't blood relatives, archivists).

## Generating Allowlist Artifacts

### Step 1: Edit the CSV
Update `workspace-local/allowlist/initial_allowlist.csv` with new email addresses.

**Example: Adding a new family member**
```csv
email,grampsId,displayName
jane.smith@example.com,I0001,Jane Smith
john.doe@example.com,I0042,John Doe
newperson@example.com,I0200,New Person
```

### Step 2: Regenerate JSON Artifacts
Run the generation script (if available) or manually create JSON files:

```bash
python3 scripts/infra/generate_allowlist_artifacts.py \
  --csv workspace-local/allowlist/initial_allowlist.csv \
  --output workspace-local/allowlist
```

**Output files:**
- `workspace-local/allowlist/harrisonfamily-allowlist.json` – Simple email array
- `workspace-local/allowlist/userGrampsID.json` – Email → Gramps ID mapping

### Step 3: Publish to Cloud Services
Upload both allowlists to their respective storage locations:

```bash
scripts/infra/publish_allowlists.sh
```

**What this script does:**
1. Uploads `userGrampsID.json` to `s3://your-family/config/userGrampsID.json`
2. Creates new Secret Manager version with updated email array
3. Logs the snapshot to `docs/dev/allowlist-publish.md` for audit trail

**Manual commands (if script unavailable):**
```bash
# Upload to S3
aws s3 cp workspace-local/allowlist/userGrampsID.json \
  s3://your-family/config/userGrampsID.json \
  --content-type application/json

# Update Google Secret Manager
gcloud secrets versions add harrisonfamily-allowlist \
  --data-file=workspace-local/allowlist/harrisonfamily-allowlist.json
```

## Verifying Allowlist Updates

### Check S3 Upload
```bash
aws s3 ls s3://your-family/config/userGrampsID.json
aws s3 cp s3://your-family/config/userGrampsID.json - | jq .
```

### Check Secret Manager Version
```bash
# List versions
gcloud secrets versions list harrisonfamily-allowlist

# View latest version content
gcloud secrets versions access latest --secret=harrisonfamily-allowlist
```

### Test via Cloud Function
```bash
gcloud functions call getAllowlist --region=us-west2
```

Expected output:
```json
{
  "allowlist": [
    "jane.smith@example.com",
    "john.doe@example.com",
    "newperson@example.com"
  ]
}
```

## Common Workflows

### Adding a Family Member
1. Add row to `initial_allowlist.csv` with their email and Gramps ID
2. Regenerate allowlist artifacts
3. Run `scripts/infra/publish_allowlists.sh`
4. Test login at `https://yourfamily.us/family-login/`
5. Verify "My Record" link routes to correct person page

### Adding a Researcher (No Gramps Record)
1. Add row with email but **leave grampsId empty**:
   ```csv
   researcher@university.edu,,Dr. Smith
   ```
2. Regenerate and publish allowlists
3. User can sign in and browse, but won't see "My Record" link

### Removing Access
1. Delete their row from `initial_allowlist.csv`
2. Regenerate and publish allowlists
3. Next time they try to sign in, Lambda will return 403 Forbidden
4. Consider notifying them via email before removing access

### Bulk Updates
For large family reunions or new branches:
1. Export emails from Google Sheets or family tree software
2. Import into CSV with proper Gramps IDs
3. Regenerate artifacts in one batch
4. Test with one user before announcing to whole family

## Security Best Practices

1. **Audit access regularly** – Review `initial_allowlist.csv` quarterly to remove inactive accounts
2. **Use personal emails** – Avoid shared family emails (e.g., `family@example.com`)
3. **Verify Gramps IDs** – Double-check that each ID corresponds to the correct person
4. **Log all changes** – Document who was added/removed in `docs/dev/allowlist-publish.md`
5. **Rotate secrets** – If CSV is ever accidentally committed, rotate all OAuth credentials immediately

## Troubleshooting

### User Can't Sign In (403 Forbidden)
- **Check:** Is their email in `harrisonfamily-allowlist.json`?
- **Check:** Did you run `publish_allowlists.sh` after editing CSV?
- **Check:** Is Secret Manager returning latest version? (May take 60s to propagate)
- **Check:** Lambda CloudWatch logs for specific error message

### "My Record" Link Not Appearing
- **Check:** Does `userGrampsID.json` have their email → Gramps ID mapping?
- **Check:** Is the Gramps ID valid? (Does `/person/?id=I0042` load correctly?)
- **Check:** Browser console for feature flag errors

### Allowlist Out of Sync Between Google/AWS
- **Symptom:** User can sign in via Google but gets 403 from Lambda
- **Cause:** Secret Manager updated but S3 not updated (or vice versa)
- **Fix:** Re-run `publish_allowlists.sh` to sync both services

### Old Emails Still Working
- **Symptom:** Removed user can still access site
- **Cause:** Lambda cached old `userGrampsID.json` from S3
- **Fix:** Invalidate CloudFront `/api/*` paths or wait 5 minutes for cache expiry

## Sample Files in This Directory

### harrisonfamily-allowlist.json
Simple email array for Google Secret Manager (sanitized example):
```json
[
  "example1@example.com",
  "example2@example.com",
  "example3@example.com"
]
```

### userGrampsID.json
Email-to-Gramps mapping for Lambda (sanitized example):
```json
{
  "example1@example.com": "I0001",
  "example2@example.com": "I0002",
  "example3@example.com": "I0003"
}
```

### initial_allowlist.csv
Source CSV (sanitized example):
```csv
email,grampsId,displayName
example1@example.com,I0001,Example User One
example2@example.com,I0002,Example User Two
example3@example.com,I0003,Example User Three
researcher@example.org,,External Researcher
```

**When adapting this architecture:**
1. Copy these samples to `workspace-local/allowlist/`
2. Replace example emails with real family member emails
3. Map emails to actual Gramps person IDs from your database
4. Run generation + publish scripts

---

**For authentication testing, see `../tests/login-flow/README.md`. For Google Cloud setup, see `../gcloud-config/README.md`.**
