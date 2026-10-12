#!/usr/bin/env bash
# Replace REPLACE_WITH_GOOGLE_CLIENT_ID in 11ty html/js with $HFY_GOOGLE_CLIENT_ID.
set -euo pipefail
: "${HFY_GOOGLE_CLIENT_ID:?HFY_GOOGLE_CLIENT_ID must be set}"
find 11ty -type f \( -name '*.html' -o -name '*.js' \) \
  -exec grep -l 'REPLACE_WITH_GOOGLE_CLIENT_ID' {} + \
| xargs -r sed -i "s/REPLACE_WITH_GOOGLE_CLIENT_ID/${HFY_GOOGLE_CLIENT_ID}/g"
