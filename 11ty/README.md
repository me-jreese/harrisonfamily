# Eleventy Deployable Artifacts

This directory is reserved for the **deployable** Eleventy build artifacts.

Develop in `/Users/jreese/Dropbox/claude-code-dev/projects/harrisonfamily/workspace/11ty-dev`. When you are ready to refresh the production assets:

```bash
cd /Users/jreese/Dropbox/claude-code-dev/projects/harrisonfamily/workspace/11ty-dev
HFY_ENV=prod \
HFY_DATA_BASE="https://harrisonfamily.us/person/" \
HFY_MEDIA_BASE="https://harrisonfamily.us/media/" \
npm run build

rsync -a --delete \
  --exclude README.md \
  --exclude media/ --exclude person/ --exclude family/ \
  --exclude event/ --exclude note/ --exclude private/ \
  ./_site/ ../repo/11ty/
```

The production copy only contains static HTML/CSS/JS; person data and media are fetched at runtime from the CDN (`HFY_DATA_BASE`, `HFY_MEDIA_BASE`).
