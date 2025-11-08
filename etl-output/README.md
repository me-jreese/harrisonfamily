# ETL Output Directory

## Overview

This directory is a **sanitized template** showing the structure of ETL output during development. Real Gramps exports containing family PII are generated in `workspace-local/etl-output/` and must never be committed to Git.

## What is ETL?

**ETL = Extract, Transform, Load**

In this project, ETL refers to the pipeline that:
1. **Extracts** genealogical data from your Gramps SQLite database
2. **Transforms** it into normalized JSON structures optimized for web rendering
3. **Loads** the results into S3 for CloudFront distribution

## Directory Structure

Your `workspace-local/etl-output/` should contain:

```
etl-output/
├── person/
│   ├── I0001.json              # Normalized person records
│   ├── I0002.json
│   └── ...
├── family/
│   ├── F0001.json              # Family unit records
│   └── ...
├── event/
│   ├── E0001.json              # Event records (births, marriages, etc.)
│   └── ...
├── note/
│   ├── N0001.json              # Note records (biographies, research)
│   └── ...
├── place/
│   ├── P0001.json              # Place records (locations with coords)
│   └── ...
├── media/
│   ├── M0001.jpg               # Media binaries (photos, documents)
│   ├── M0002.pdf
│   └── ...
├── bundles/                     # Self-contained person bundles for testing
│   ├── I0001/
│   │   ├── person.json
│   │   ├── events/
│   │   ├── families/
│   │   ├── notes/
│   │   ├── media/
│   │   └── places/
│   └── I0002/
│       └── ...
└── logs/
    ├── export_2025-11-08.log   # ETL execution logs
    └── errors.log              # Error details for debugging
```

## ETL Pipeline Scripts

### Primary Export Script
**Location:** `scripts/etl/export_person_data.py`

**Purpose:** Main ETL pipeline that processes your entire Gramps database

**Usage:**
```bash
python3 scripts/etl/export_person_data.py \
  --gramps-db ~/.local/share/gramps/grampsdb/YOUR_DB_ID \
  --output workspace-local/etl-output \
  --verbose
```

**Key Features:**
- Reads Gramps SQLite DB directly (no GUI needed)
- Normalizes all object types (person, family, event, note, media, place)
- Copies media binaries with SHA-256 checksums
- Preserves `isLiving` flags for privacy protection
- Generates manifests (`person/index.json`, `place/index.json`)
- Incremental mode: skips unchanged records to speed up re-runs

**Common Flags:**
- `--person-id I0123` – Export only specific person (for testing)
- `--limit 10` – Export first N people
- `--dry-run` – Preview without writing files
- `--force` – Overwrite existing files
- `--skip-media` – Don't copy media binaries (faster for data-only updates)

### Family Tree Generator
**Location:** `scripts/etl/build_family_tree_media.py`

**Purpose:** Creates Graphviz SVG diagrams for each person

**Usage:**
```bash
python3 scripts/etl/build_family_tree_media.py \
  --gramps-db ~/.local/share/gramps/grampsdb/YOUR_DB_ID \
  --output workspace-local/etl-output/media \
  --person-dir workspace-local/etl-output/person
```

**Output:** `media/tree_I0001.svg`, `media/tree_I0002.svg`, etc.

**Prerequisites:**
- Install Graphviz: `brew install graphviz` (macOS) or `apt-get install graphviz` (Linux)
- Verify: `dot -V`

**What it creates:**
- One SVG per person showing 3 generations
- Clickable nodes linking to `/person/?id=<GRAMPS_ID>`
- Color-coded with site theme (warning yellow accents)

### Bundle Exporter
**Location:** `scripts/etl/export_person_bundle.py`

**Purpose:** Creates self-contained test bundles for individual persons

**Usage:**
```bash
python3 scripts/etl/export_person_bundle.py \
  --gramps-db ~/.local/share/gramps/grampsdb/YOUR_DB_ID \
  --person-id I0001 \
  --output workspace-local/etl-output/bundles/I0001
```

**See:** `sample_bundle/README.md` for detailed bundle documentation

### S3 Sync Helper
**Location:** `scripts/etl/sync_to_s3.py`

**Purpose:** Wrapper around `aws s3 sync` with consistent flags

**Usage:**
```bash
python3 scripts/etl/sync_to_s3.py \
  --source workspace-local/etl-output \
  --bucket your-family-frontend \
  --profile default
```

**What it does:**
- Uploads all JSON/media to S3
- Uses `--delete` to remove stale files
- Excludes `.DS_Store`, `*.pyc`, logs
- Sets correct MIME types for JSON/images/PDFs

## Development Workflow

### Full Pipeline Run
```bash
# Step 1: Export from Gramps
python3 scripts/etl/export_person_data.py \
  --gramps-db ~/.local/share/gramps/grampsdb/YOUR_DB_ID \
  --output workspace-local/etl-output \
  --verbose

# Step 2: Generate family tree SVGs
python3 scripts/etl/build_family_tree_media.py \
  --gramps-db ~/.local/share/gramps/grampsdb/YOUR_DB_ID \
  --output workspace-local/etl-output/media \
  --person-dir workspace-local/etl-output/person

# Step 3: Build search indexes
cd workspace/11ty-dev
HFY_PERSON_DIR=../../workspace-local/etl-output/person \
  node scripts/search/build_search_index.js

# Step 4: Copy to frontend data directory
rsync -av --delete \
  workspace-local/etl-output/ \
  workspace-local/harrisonfamily-frontend/ \
  --exclude logs/ --exclude bundles/

# Step 5: Test locally
npm run dev
# Visit http://localhost:8081

# Step 6: Deploy to S3
python3 scripts/etl/sync_to_s3.py \
  --source workspace-local/harrisonfamily-frontend \
  --bucket your-family-frontend

# Step 7: Invalidate CloudFront
aws cloudfront create-invalidation \
  --distribution-id YOUR_DIST_ID \
  --paths "/person/*" "/media/*"
```

### Incremental Update (Data Only)
When you've added new photos or updated biographies but core person records haven't changed:

```bash
# Re-export with force to update media/notes
python3 scripts/etl/export_person_data.py \
  --gramps-db ~/.local/share/gramps/grampsdb/YOUR_DB_ID \
  --output workspace-local/etl-output \
  --force

# Skip family tree rebuild if relationships unchanged
# Skip search rebuild if names unchanged

# Sync only changed files
python3 scripts/etl/sync_to_s3.py \
  --source workspace-local/etl-output \
  --bucket your-family-frontend

# Invalidate only data paths
aws cloudfront create-invalidation \
  --distribution-id YOUR_DIST_ID \
  --paths "/person/*" "/media/*"
```

### Testing Single Person
```bash
# Export just one person
python3 scripts/etl/export_person_bundle.py \
  --gramps-db ~/.local/share/gramps/grampsdb/YOUR_DB_ID \
  --person-id I0042 \
  --output workspace-local/etl-output/bundles/I0042 \
  --include-relatives

# Copy to frontend data
cp workspace-local/etl-output/bundles/I0042/person.json \
   workspace-local/harrisonfamily-frontend/person/I0042.json

# Test in browser
npm run dev
# Visit http://localhost:8081/person/?id=I0042
```

## Lessons Learned (Important!)

### Issue: ModuleNotFoundError: gramps
- **Symptom:** ETL scripts fail with import error
- **Cause:** Gramps Python package not installed
- **Solution:** `pip3 install --user gramps==6.0.5`
- **Note:** You need the package even if Gramps GUI is installed

### Issue: Permission Denied on Gramps DB
- **Symptom:** SQLite error when reading database
- **Cause:** Gramps GUI has DB locked
- **Solution:** Close Gramps desktop app before running ETL

### Issue: Event Types Show as "Event"
- **Symptom:** All events labeled generically
- **Cause:** Not calling `Event.get_type()` method
- **Solution:** Use Gramps API classes, not raw SQL queries
- **Documented in:** HFY-ISS-001 (resolved 2025-11-05)

### Issue: Missing Display Names for Relatives
- **Symptom:** `displayName: null` in family tree
- **Cause:** Related persons not in export set
- **Solution:** Ensure ETL bundles related person stubs with metadata
- **Documented in:** HFY-ISS-002 (resolved 2025-11-05)

### Issue: AttributeError: 'list' object has no attribute 'get'
- **Symptom:** Family tree script crashes
- **Cause:** Old `person/index.json` format (list instead of manifest object)
- **Solution:** Rebuild search index first: `node scripts/search/build_search_index.js`
- **Documented in:** HFY-DEP-002 (2025-11-08)

### Issue: Media Checksums Don't Match
- **Symptom:** Same media file has different SHA-256 on re-export
- **Cause:** Gramps modified file timestamp or metadata
- **Solution:** Use `--force` flag to overwrite; compare file content not metadata

### Issue: Notes HTML Not Rendering
- **Symptom:** Biography appears as plain text
- **Cause:** StyledText `_tags` not converted to HTML
- **Solution:** Run note rendering pipeline in ETL (converts bold/italic/color tags)

## Performance Tips

### For Large Databases (500+ people)
- Use `--limit 50` for initial testing
- Run with `--dry-run` first to estimate time
- Consider splitting export by family branches using person filters
- Expected time: ~30 seconds per 100 people (including media copy)

### For Media-Heavy Trees
- Use `--skip-media` for data-only updates (10x faster)
- Compress images before adding to Gramps (optimize JPEGs, use WebP)
- Store high-res originals separately; use web-optimized versions in ETL

### For Faster Iteration
- Keep one test bundle (`bundles/I0001/`) for template development
- Use incremental mode (ETL skips unchanged JSON by default)
- Clear `workspace-local/etl-output/logs/` periodically to reduce disk usage

## Security Reminders

1. **Never commit ETL output** – Add `workspace-local/` to `.gitignore`
2. **Validate `isLiving` flags** – Manually review anyone born after 1900 without death record
3. **Scrub sensitive notes** – Remove SSNs, account numbers, medical info before export
4. **Check media filenames** – Avoid filenames that reveal addresses or phone numbers
5. **Audit person manifest** – Review `person/index.json` to ensure no unexpected records

## Output Size Estimates

For a typical family tree:
- 200 people: ~2 MB JSON + ~40 MB media = **~42 MB total**
- 500 people: ~5 MB JSON + ~120 MB media = **~125 MB total**
- 1000 people: ~10 MB JSON + ~300 MB media = **~310 MB total**

S3 storage cost: ~$0.023/GB/month = **<$10/month** for most families

---

**For detailed ETL troubleshooting, see the main project reference documentation. For production data structure, see `../harrisonfamily-frontend/README.md`.**
