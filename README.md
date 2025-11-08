# Harrison Family Website

A modern, privacy-focused genealogy website that preserves and shares the Harrison family legacy while protecting living relatives' personal information. Built on Gramps genealogical data, the site combines public historical narratives with authenticated family-only access to detailed records, photos, and interactive family trees.

**Live site**: [https://harrisonfamily.us](https://harrisonfamily.us)


---

## About the Harrison Family

The Harrison family's American story begins with Joseph Harrison (born c. 1802) and Kitty Wade Harrison (born c. 1803), whose migration to St. Helena Parish and East Feliciana Parish, Louisiana established roots that have flourished for over two centuries.

The native Louisiana region—home to the Houma and Bayougoula Indian Nations—was colonized around 1790 by French, German, English, and Spanish settlers. Beginning in 1719, hundreds of thousands of enslaved Africans were forcibly transported to American seaports, enduring the most brutal period in our nation's history. Between 1719 and 1802, the enslaved population grew from 1.2 million to 4.5 million people.

Joseph and Kitty Harrison seeded nine generations spanning 222 years. Their descendants—armed with stamina, wit, and wisdom—have contributed across every dimension of American society: as farmers, educators, architects, engineers, healthcare professionals, military service members, entrepreneurs, attorneys, accountants, IT professionals, and community leaders. The Harrison family legacy represents resilience, achievement, and the ongoing building of civil society in America.

---

## Site Features

### Public Access
- **Historical Overview**: Family origin story and migration history
- **Timeline Context**: Historical periods and regional background
- **Contact Portal**: Connection point for family members and researchers

### Authenticated Family Access (Google Sign-In)
- **Person Profiles**: Detailed individual records with biography, life events, and metadata
- **Media Galleries**: Family photos, documents, and historical artifacts with lightbox viewing
- **Interactive Family Trees**: Graphviz-generated relationship diagrams (3+ generations)
- **Event Timelines**: Chronological life events (births, marriages, residences, education, etc.)
- **Client-Side Search**: Fast autocomplete and full search results across all family members
- **Personalized Navigation**: "My Record" link that routes authenticated users to their own profile
- **Privacy Protection**: Living persons' sensitive data automatically hidden from public view

---

## Technology Stack

This project leverages open-source tools and cloud infrastructure to deliver a fast, secure, and maintainable family archive:

### Core Technologies
- **[Eleventy (11ty)](https://github.com/11ty/eleventy)** – Static site generator with flexible templating
- **[Bootstrap 5](https://github.com/twbs/bootstrap)** – Responsive CSS framework and component library
- **[Gramps](https://github.com/gramps-project/gramps)** – Genealogy database and research platform (single source of truth)
- **[Graphviz](https://gitlab.com/graphviz/graphviz)** – Family tree SVG generation via DOT language

### Cloud Infrastructure
- **AWS S3** – Static asset hosting for HTML/CSS/JS and JSON data
- **AWS CloudFront** – Global CDN with HTTPS and caching
- **AWS Lambda** – Serverless authentication verification (`hfy-check-allowed`)
- **AWS API Gateway** – HTTP API for `/api/check-allowed` endpoint
- **AWS Certificate Manager** – TLS certificate management
- **Google Cloud Secret Manager** – Secure storage for email allowlists
- **Google Cloud Functions** – Allowlist verification helper (`getAllowlist`)
- **Google Identity Services** – OAuth 2.0 authentication for family members
- **Cloudflare DNS** – Domain routing and edge caching

### Development Tools
- **Node.js** – JavaScript runtime for build scripts and ETL
- **Python 3.11+** – Gramps ETL pipeline and data normalization
- **Sass/SCSS** – CSS preprocessing for theming
- **JSDOM** – Regression testing for client-side components

---

## Built with AI-Assisted Development

This project was developed using AI CLI tools powered by the **[agentharmony](https://github.com/me-jreese/agentharmony)** framework—a structured methodology for managing complex software projects through conversational AI agents.

### What is agentharmony?

AgentHarmony is an open-source governance framework that enables AI agents (like Claude) to maintain persistent project context across sessions, follow consistent development practices, and produce well-documented, production-ready code. Key features include:

- **Persistent Memory**: Project documentation that survives across AI sessions
- **Task Management**: Structured backlogs, feature tracking, and issue logging
- **Quality Standards**: Enforced coding practices, security patterns, and testing requirements
- **Multi-Project Workflows**: Reusable patterns and tooling across different codebases

By combining agentharmony's governance model with AI CLI tools, this entire genealogy platform—from AWS infrastructure provisioning to client-side authentication flows—was built through natural language conversations, with the framework ensuring consistency, completeness, and maintainability.

If you're building your own family site or similar project with AI assistance, check out the [agentharmony repository](https://github.com/me-jreese/agentharmony) for the governance templates, documentation patterns, and workflow automation that made this project possible.

### Recommended CLI Tools for Faster Development

This project leverages multiple cloud platforms, and installing their official CLI tools dramatically speeds up development, deployment, and debugging workflows:

- **[AWS CLI](https://aws.amazon.com/cli/)** – Manage S3 uploads, CloudFront invalidations, Lambda deployments, and Secrets Manager
  ```bash
  # Install via pip
  pip install awscli
  # Configure with your credentials
  aws configure
  ```

- **[Cloudflare Wrangler](https://developers.cloudflare.com/workers/wrangler/)** – Manage DNS records, Workers, KV namespaces, and R2 storage
  ```bash
  # Install via npm
  npm install -g wrangler
  # Authenticate
  wrangler login
  ```

- **[Google Cloud CLI (gcloud)](https://cloud.google.com/sdk/docs/install)** – Deploy Cloud Functions, manage Secret Manager, and configure OAuth
  ```bash
  # Install via package manager or installer
  # See: https://cloud.google.com/sdk/docs/install
  # Authenticate
  gcloud auth login
  ```

With these tools installed, you can execute deployment commands directly from your terminal (or via AI agents), inspect logs, manage secrets, and troubleshoot issues without switching between web consoles. The agentharmony framework pairs perfectly with these CLIs—allowing AI agents to execute infrastructure commands on your behalf while maintaining full audit trails in project documentation.

---

## Adapting This Repository for Your Own Family Site

This codebase is designed to be reusable for any family using Gramps as their genealogy database. Here's how to adapt it:

> [!NOTE]
> The repo directory now holds only sanitized assets and templates that can be shared publicly. After you clone it, rename the top level folder to `workspace/`, and maintain a separate repo/ directory if you wish to manage deployment with github. This also allows you to use workspace files to run an 11ty server locally for preview and debugging first, then transform the site files into production assets in the repo. All sensitive or environment-specific data lives in `workspace-local/` which ensures none of your private family data is pushed to your repo. After editing private assets, run `python repo/scripts/sync_sanitized_assets.py --sync` followed by `./repo/scripts/export_workspace_samples.sh` to ensure the repo root mirrors the sanitized workspace for collaborators.


### Prerequisites
1. **Gramps Database**: A working Gramps installation with your family tree populated
2. **AWS Account**: For S3, CloudFront, Lambda, and ACM certificate
3. **Google Cloud Project**: For OAuth credentials and Secret Manager
4. **Domain Name**: Registered domain with DNS access (Cloudflare recommended)
5. **Node.js 18+** and **Python 3.11+** installed locally

### Step-by-Step Adaptation

#### 1. Clone and Configure
```bash
git clone https://github.com/me-jreese/harrisonfamily.git your-family-site
cd your-family-site
```

#### 2. Update Site Identity
- **Content**: Replace `content/about.txt` with your family's history
- **Branding**: Update site title, colors, and logo in `workspace/11ty-dev/src/_data/site.js`
- **Domain**: Change references from `harrisonfamily.us` to your domain throughout

#### 3. Configure Cloud Infrastructure
- **S3**: Create bucket `your-family-frontend` (us-west-2 recommended)
- **CloudFront**: Set up distribution with ACM certificate for your domain
- **DNS**: Point your domain to CloudFront via CNAME records
- **Lambda**: Deploy `lambda/hfy-check-allowed/` with your OAuth client ID
- **Google OAuth**: Create OAuth 2.0 credentials in Google Cloud Console

#### 4. Export Your Gramps Data
```bash
# Run the ETL pipeline against your Gramps database
python3 scripts/etl/export_person_data.py \
  --output workspace/your-family-frontend \
  --gramps-db ~/.local/share/gramps/grampsdb/<YOUR_DB_ID>
```

#### 5. Generate Family Trees
```bash
# Build Graphviz SVG diagrams for each person
python3 scripts/etl/build_family_tree_media.py \
  --gramps-db ~/.local/share/gramps/grampsdb/<YOUR_DB_ID> \
  --output workspace/your-family-frontend/media
```

#### 6. Build Search Index
```bash
cd workspace/11ty-dev
npm install
npm run build:search
```

#### 7. Test Locally
```bash
npm run dev
# Visit http://localhost:8081
```

#### 8. Deploy to Production
```bash
# Upload static site
aws s3 sync workspace/11ty-dev/_site/ s3://your-family-frontend/ --delete

# Upload person data separately
aws s3 sync workspace/your-family-frontend/ s3://your-family-frontend/ \
  --exclude "_site/*" --exclude "node_modules/*"

# Invalidate CloudFront cache
aws cloudfront create-invalidation \
  --distribution-id YOUR_DIST_ID \
  --paths "/*"
```

---

## Required PII Assets (Never Commit to Git)

The following files contain sensitive personal information and must be managed outside version control:

### 1. Gramps Export Data
- **Location**: `workspace/your-family-frontend/`
- **Contents**: `person/*.json`, `family/*.json`, `event/*.json`, `note/*.json`, `media/*`
- **Generation**: Run `scripts/etl/export_person_data.py` after Gramps updates
- **Storage**: Upload directly to S3; never commit to Git

### 2. Email Allowlists
- **`harrisonfamily-allowlist.json`**: Simple array of authorized email addresses
  - **Storage**: Google Secret Manager (for OAuth allowlist enforcement)
  - **Generation**: `scripts/infra/publish_allowlists.sh` from source CSV
- **`userGrampsID.json`**: Maps emails to Gramps person handles (`{ "email": "I0017" }`)
  - **Storage**: S3 at `s3://your-family/config/userGrampsID.json`
  - **Purpose**: Enables personalized "My Record" navigation

### 3. OAuth Credentials
- **`docs/dev/oauth_your-family-local.json`**: Local development client ID/secret
- **`docs/dev/oauth_your-family.json`**: Production client ID/secret
- **Storage**: Keep in `docs/dev/` directory, add to `.gitignore`
- **Usage**: Injected into Eleventy builds via environment variables

### 4. Search Indexes
- **`person/index.json`**: Person manifest for autocomplete
- **`person/search-index.json`**: Tokenized search data
- **Generation**: `npm run build:search` in workspace
- **Storage**: Upload to S3 after data updates

### 5. Family Tree Visualizations
- **`media/tree_<GRAMPS_ID>.svg`**: Generated Graphviz diagrams
- **Generation**: `scripts/etl/build_family_tree_media.py`
- **Storage**: Upload to S3 `media/` directory

### 6. AWS Secrets
- **`HFY_ALLOWLIST_HMAC_SECRET`**: HMAC key for email hashing
- **Storage**: AWS Secrets Manager
- **Usage**: Lambda reads this to validate session tokens

### File Management Best Practices
- Store all PII in workspace directories outside `repo/`
- Use `.gitignore` to prevent accidental commits
- Upload PII directly to S3/GCP using AWS CLI or `publish_allowlists.sh`
- Document every production data refresh in `agent-reference/` logs
- Rotate OAuth secrets annually and update Secret Manager accordingly

---

## Repository Structure

This directory (`projects/harrisonfamily/repo`) is the Git-tracked portion of the site. It contains only the static Eleventy code plus deployment scripts/automation. **No PII or generated data ever lives in Git.**

```
repo/
├── 11ty/                # Eleventy project with src/, public assets, JS helpers
├── lambda/              # AWS Lambda source bundles (e.g., hfy-check-allowed)
├── functions/           # Google Cloud Functions source (e.g., getAllowlist)
├── scripts/             # Deployment helpers / GitHub Actions (infra-as-code)
├── docs/                # Repo-scoped docs (deployment notes, runbooks)
└── .github/workflows/   # CI/CD pipelines (deploy, tests)
```

The Eleventy build artifacts in `11ty/` are safe to commit because they only include HTML/JS/CSS. Everything sensitive (person JSON, media, allowlists, search indexes) lives outside the repo and is uploaded directly to S3/GCP.

---

## Development & Deployment Workflow

### Local Development
1. Develop in `workspace/11ty-dev` and confirm everything works with the local Eleventy server
2. Test authentication flow using local OAuth credentials
3. Validate search, person profiles, and family tree rendering

### Deploying to Production
1. Promote the build into this repo:
   ```bash
   rsync -a --delete workspace/11ty-dev/_site/ repo/11ty/ \
     --exclude 'person/' --exclude 'family/' --exclude 'media/'
   ```

2. Commit and push to `main`. The GitHub Action (`.github/workflows/deploy.yml`) will:
   - Sync `repo/11ty/` to `s3://your-family-frontend`
   - Invalidate CloudFront (`E2JCDK3QLQNNYB`)
   - Re-package and deploy the AWS Lambda + GCP Cloud Function

### CloudFront Function
- `scripts/cloudfront/append-index.js` ensures clean URLs (`/about/`, `/contact/`) resolve by appending `index.html` before CloudFront hits the S3 origin.
- After editing the file, update/publish the function:
  ```bash
  aws cloudfront update-function --name HFYAppendIndex \
    --if-match "$(aws cloudfront describe-function --name HFYAppendIndex --query 'ETag' --output text)" \
    --function-code fileb://scripts/cloudfront/append-index.js \
    --function-config Comment='Append index.html to directory paths',Runtime=cloudfront-js-1.0

  aws cloudfront publish-function --name HFYAppendIndex \
    --if-match "$(aws cloudfront describe-function --name HFYAppendIndex --query 'ETag' --output text)"
  ```
- The distribution already associates this function on the viewer-request event; re-run `aws cloudfront update-distribution` only if you rename/replace the function ARN.

### Manual Steps Outside Git
- Run the ETL (`scripts/etl/export_person_data.py`) and upload JSON/media to S3
- Publish allowlist updates via `scripts/infra/publish_allowlists.sh` (writes to S3 + Secret Manager)
- Upload new search indexes and SVG trees directly to S3 as needed
- Document every production change in `agent-reference/harrisonfamily-reference.md`

### Pre-Commit Automation

#### Deployment Sync Check
- `scripts/check-deployment-sync.sh` enforces the comparison workflow from `docs/deployment.md`.  
- Whenever Eleventy (`repo/11ty`), Lambda (`repo/lambda/hfy-check-allowed`), or Cloud Function (`repo/functions/get-allowlist`) files are staged, the hook runs rsync dry-runs against their workspace sources (e.g., `workspace/11ty-dev/_site`).  
- If differences are detected, the commit is blocked with guidance to re-run the doc’s promotion steps.  
- Set `SKIP_DEPLOYMENT_SYNC_CHECK=1` only if you have an exceptional case and want to bypass the guard (document the reason in the commit description).
- The referenced `docs/deployment.md` lives outside this Git repository (`projects/harrisonfamily/docs/`) because it captures machine-specific workspace paths and governance details. If you adopt this repo, create a similar deployment inventory that lists every sanitized asset you plan to commit plus the workspace location it must mirror, then either store it at the same path or update `scripts/check-deployment-sync.sh` to point at your custom checklist.

#### Secret Scanning
- Keep `trufflehog` installed locally (Homebrew: `brew install trufflehog`).
- Point Git at the repo’s hook directory so every commit runs the scan:
  ```bash
  git config core.hooksPath scripts/git-hooks
  ```
- The hook executes `trufflehog --no-update --fail filesystem .` and blocks commits if potential secrets are detected. Resolve any findings (or update an allowlist) before recommitting.

---

## Privacy & Security

- **Data Minimization**: Only authorized family members can access detailed records
- **OAuth 2.0**: Google Sign-In enforces per-user authentication
- **Dual Allowlist**: Email verification via Secret Manager + Gramps ID mapping in private S3
- **Living Person Protection**: Death metadata automatically hidden for living relatives
- **HTTPS-Only**: All traffic encrypted via CloudFront + ACM certificates
- **No Public PII**: Person data never exposed in HTML source or client-side bundles
- **Session Tokens**: Lambda-signed tokens gate protected API endpoints

---

## Contributing

This repository is maintained by the Harrison family for personal use. If you're adapting this codebase for your own family site and have improvements to share (better ETL scripts, enhanced security patterns, etc.), please open an issue or pull request.

---

## License

This project is provided as-is for educational and personal use. The codebase (HTML/CSS/JS/Python) is available for reuse; all family content, photos, and genealogical data remain private property of the Harrison family.

---

## Acknowledgments

- **Gramps Community**: For maintaining the gold-standard open-source genealogy platform
- **Eleventy Team**: For a flexible, developer-friendly static site generator
- **Bootstrap Contributors**: For robust, accessible UI components
- **Graphviz Maintainers**: For powerful graph visualization tools

---

**Questions or issues?** Contact the site administrator via the contact form at [harrisonfamily.us/contact](https://harrisonfamily.us/contact).
