#!/usr/bin/env bash
# The end-to-end lane: scenarios of the addon against the local sync dev server, on copies of the fixture tree (HFY-TSK-181).
#
#   gramps/tests/e2e/run.sh                      every scenario_*.py in this directory
#   gramps/tests/e2e/run.sh scenario_smoke.py    one scenario (a bare name means this directory)
#   gramps/tests/e2e/run.sh --list               the scenario files, one per line
#
# It is gramps/tests/gramps/run.sh with this directory as the lane: the same throwaway GRAMPSHOME and HOME, the same per-file copy of
# the fixture tree, the same audit hook that forbids the real Gramps and Pictures folders, the same negative controls, and exit status
# 1 when any scenario (or any control) fails. Each scenario starts its own api/scripts/sync-dev-server.mjs on an ephemeral 127.0.0.1
# port, with an empty in-memory table and a temporary directory for S3, and stops it when it ends; no scenario shares cloud state.
#
# Needs: macOS with Gramps 6.0.6 (HFY_GRAMPS_APP overrides /Applications/Gramps.app), node 22 or later, and api/node_modules
# (`cd api && npm ci`, which needs CODEARTIFACT_AUTH_TOKEN). Nothing leaves the machine.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"

if [ "${1:-}" = "--list" ]; then
  for f in "$HERE"/scenario_*.py; do basename "$f"; done
  exit 0
fi

fail() { echo "[FAIL] $*" >&2; exit 2; }
command -v node >/dev/null 2>&1 || fail "node 22 or later is needed to run the sync dev server"
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' || fail "node 22 or later is needed to run the sync dev server (found $(node --version))"
[ -d "$ROOT/api/node_modules/jose" ] || fail "api/node_modules is missing: run 'cd api && npm ci' first (it needs CODEARTIFACT_AUTH_TOKEN)"

export HFY_LANE_DIR="$HERE"
export HFY_LANE_GLOB='scenario_*.py'
exec bash "$HERE/../gramps/run.sh" "$@"
