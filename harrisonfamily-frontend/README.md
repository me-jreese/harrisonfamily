# Family Frontend Data Directory

## Overview

This directory is a **sanitized template** that mirrors the structure of `workspace-local/harrisonfamily-frontend/`, which contains the real ETL output with family PII. The actual production data (person JSON, media files, search indexes, family tree SVGs) lives outside this repo and is uploaded directly to S3.

## Purpose

When adapting this architecture for your own family site:
1. Use this directory structure as a reference for organizing your ETL output
2. Generate synthetic/example data here for testing the Eleventy build without real family information
3. Keep your real data in `workspace-local/harrisonfamily-frontend/` (never committed to Git)

## Directory Structure

Your `workspace-local/harrisonfamily-frontend/` should contain:

```
harrisonfamily-frontend/
├── person/
│   ├── index.json              # Person manifest (count, generation metadata)
│   ├── search-index.json       # Tokenized search data for client-side search
│   ├── I0001.json              # Individual person records (one per Gramps handle)
│   ├── I0002.json
│   └── ...
├── family/
│   ├── F0001.json              # Family unit records (parents + children)
│   └── ...
├── event/
│   ├── E0001.json              # Event records (births, marriages, deaths, etc.)
│   └── ...
├── note/
│   ├── N0001.json              # Note records (biographies, research notes)
│   └── ...
├── place/
│   ├── P0001.json              # Place records (locations with coordinates)
│   └── index.json              # Place manifest
└── media/
    ├── M0001.jpg               # Media binaries (photos, documents)
    ├── M0002.pdf
    ├── tree_I0001.svg          # Generated family tree diagrams
    └── ...
```

## How This Data Is Generated

### Step 1: Export from Gramps
Run the primary ETL script against your Gramps SQLite database:

```bash
python3 scripts/etl/export_person_data.py \
  --gramps-db ~/.local/share/gramps/grampsdb/YOUR_DB_ID \
  --output workspace-local/harrisonfamily-frontend \
  --verbose
```

**Key flags:**
- `--person-id I0123` – Export only specific people (for testing)
- `--limit 10` – Export first N people (faster testing cycles)
- `--dry-run` – Preview what will be exported without writing files
- `--force` – Overwrite existing files (useful for re-exports)

**What this script does:**
- Reads Gramps SQLite DB directly (no Gramps GUI needed)
- Normalizes person/family/event/note/place/media records into JSON
- Copies media binaries from Gramps media directory to output `media/`
- Generates SHA-256 checksums for all media files
- Creates `person/index.json` manifest with display names, lifespans, and badges
- Preserves `isLiving` flags to protect living persons' privacy
- Resolves relationships (parents, spouses, children) with inline metadata

**Common issues encountered:**
- **ModuleNotFoundError: gramps** – Install with `pip3 install --user gramps==6.0.5`
- **Permission denied on Gramps DB** – Ensure DB is not open in Gramps GUI
- **Missing media files** – Check that Gramps media directory path is correct
- **Slow exports** – Use `--limit` for testing, then run full export for production

### Step 2: Generate Family Tree SVGs
Create interactive family tree visualizations using Graphviz:

```bash
python3 scripts/etl/build_family_tree_media.py \
  --gramps-db ~/.local/share/gramps/grampsdb/YOUR_DB_ID \
  --output workspace-local/harrisonfamily-frontend/media \
  --person-dir workspace-local/harrisonfamily-frontend/person
```

**What this creates:**
- One SVG per person: `media/tree_I0001.svg`, `media/tree_I0002.svg`, etc.
- Each tree shows 3 generations: grandparents ↔ person ↔ grandchildren
- Clickable nodes link to `/person/?id=<GRAMPS_ID>`
- Color-coded with the site's Bootstrap theme (warning yellow accents)

**Prerequisites:**
- Install Graphviz: `brew install graphviz` (macOS) or `apt-get install graphviz` (Linux)
- Ensure `dot` command is in PATH

**Troubleshooting:**
- **AttributeError: 'list' object has no attribute 'get'** – Rebuild `person/index.json` first using search index script
- **Empty SVGs** – Check that person has at least one family relationship (parent or child)
- **SVG text too small** – Documented in HFY-ISS-009; consider adding PNG export for complex trees

### Step 3: Build Search Indexes
Generate client-side search data for navbar autocomplete and `/search` page:

```bash
cd workspace/11ty-dev
HFY_PERSON_DIR=../../workspace-local/harrisonfamily-frontend/person \
  node scripts/search/build_search_index.js
```

**Output:**
- `person/index.json` – Updated with search-friendly metadata (given/surname, years, badges)
- `person/search-index.json` – Tokenized search data (names, dates, locations)

**How search works:**
- Fully client-side (no external APIs or services)
- Dependency-free scoring algorithm (no Lunr.js needed)
- Respects authentication gates (search only loads after `/api/check-allowed` succeeds)

### Step 4: Deploy to S3
Upload the complete data tree to your S3 bucket:

```bash
python3 scripts/etl/sync_to_s3.py \
  --source workspace-local/harrisonfamily-frontend \
  --bucket your-family-frontend \
  --prefix "" \
  --profile default
```

**Or use AWS CLI directly:**
```bash
aws s3 sync workspace-local/harrisonfamily-frontend/ \
  s3://your-family-frontend/ \
  --delete \
  --exclude ".DS_Store" \
  --exclude "*.pyc"
```

**Important:**
- Static site files (HTML/CSS/JS from Eleventy) go to S3 root
- Data files (person/family/event/media) go to subdirectories in the same bucket
- Use `--delete` flag carefully—it removes S3 objects not in your local tree
- Always invalidate CloudFront after uploads: `aws cloudfront create-invalidation --distribution-id YOUR_DIST_ID --paths "/person/*" "/media/*"`

## Data Schema Reference

### Person JSON Structure
```json
{
  "grampsId": "I0001",
  "displayName": "Jane Smith",
  "surname": "Smith",
  "givenName": "Jane",
  "gender": "F",
  "isLiving": false,
  "birth": { "date": "1890-05-12", "year": 1890, "place": "Springfield, Illinois" },
  "death": { "date": "1975-11-08", "year": 1975, "place": "Portland, Oregon" },
  "lifespan": { "start": 1890, "end": 1975, "summary": "1890–1975" },
  "primaryPhoto": { "handle": "M0001", "mime": "image/jpeg", "path": "/media/M0001.jpg" },
  "mediaGallery": [ /* array of media objects */ ],
  "notes": [ /* array of note objects with HTML */ ],
  "events": [ /* chronological event array */ ],
  "familyTree": {
    "parents": [ /* parent person stubs */ ],
    "spouses": [ /* spouse/partner stubs */ ],
    "children": [ /* child person stubs */ ]
  }
}
```

**Key fields for privacy:**
- `isLiving: true` – Suppresses death info, sensitive notes, and recent events
- Derived from `death_ref_index === -1` in Gramps
- UI automatically hides protected fields on `/person` pages

### Media JSON Structure
```json
{
  "handle": "M0001",
  "grampsId": "M0001",
  "path": "/media/M0001.jpg",
  "mime": "image/jpeg",
  "checksum": "sha256:abc123def456...",
  "size": 524288,
  "description": "Family portrait, circa 1920",
  "date": "1920-06-15",
  "isPrimary": true,
  "personTags": ["I0001", "I0002"]
}
```

## Local Preview Workflow

The Eleventy dev server (`workspace/11ty-dev`) uses passthrough copy to serve this data directory during local development:

```javascript
// workspace/11ty-dev/eleventy.config.js
eleventyConfig.addPassthroughCopy({
  "../../workspace-local/harrisonfamily-frontend/person": "person",
  "../../workspace-local/harrisonfamily-frontend/media": "media",
  // ... etc
});
```

This allows you to:
1. Run `npm run dev` in `workspace/11ty-dev`
2. Visit `http://localhost:8081/person/?id=I0001`
3. See the SPA fetch data from `http://localhost:8081/person/I0001.json`
4. Test search, family trees, media galleries using real local data
5. Validate authentication flows without deploying to S3

## Security & Privacy Best Practices

1. **Never commit this data to Git** – Add `workspace-local/` to `.gitignore`
2. **Rotate allowlists carefully** – When adding/removing family members, regenerate both `harrisonfamily-allowlist.json` (Google Secret Manager) and `userGrampsID.json` (S3), then run `scripts/infra/publish_allowlists.sh`
3. **Validate living person flags** – Manually review `isLiving: true` for anyone born after 1900 and without a death record
4. **Restrict S3 bucket access** – Use bucket policy that only allows CloudFront OAC (Origin Access Control), never public access
5. **Audit exports regularly** – Check `person/index.json` to ensure no unexpected records leaked through filters

## Adapting for Your Family

Replace "harrisonfamily" references throughout:
1. Rename this directory to match your domain (e.g., `yourfamily-frontend/`)
2. Update S3 bucket name in `scripts/etl/sync_to_s3.py`
3. Change CloudFront distribution ID in deploy scripts
4. Update Gramps DB path to point at your database
5. Customize `isLiving` logic in `scripts/etl/export_person_data.py` if you have different privacy rules

**Estimated costs:**
- S3 storage for 200 people + media: ~$1–3/month
- CloudFront data transfer (low traffic): ~$5–10/month
- Total annual cost: <$30 (well under budget)

## Troubleshooting

### ETL Script Fails
- **Check Gramps version:** This was built with Gramps 6.0.5; newer versions may have schema changes
- **Verify DB path:** Use `ls ~/.local/share/gramps/grampsdb/` to list available databases
- **Test with --limit 1:** Export a single person first to isolate issues

### Search Index Empty
- Ensure `person/index.json` exists and contains `{"count": N, "people": [...]}`
- Re-run ETL with verbose logging to see which person records were skipped
- Check that `build_search_index.js` has correct `HFY_PERSON_DIR` path

### Media Files Missing in S3
- Confirm media copied to local output directory first (`ls workspace-local/harrisonfamily-frontend/media/`)
- Check S3 sync command excluded patterns (`.DS_Store`, `*.pyc` are common culprits)
- Verify CloudFront cache wasn't stale: invalidate `/media/*` explicitly

### Family Trees Not Rendering
- Install Graphviz system-wide, not just Python package
- Run `dot -V` to confirm installation
- Check that SVG files were created in `media/` directory
- Validate SVG syntax by opening in browser directly

---

**For more details on the overall architecture, see the main workspace README at `../README.md`.**
