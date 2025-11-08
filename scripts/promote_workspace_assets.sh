#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_FILE=""
DRY_RUN=0

usage() {
  cat <<EOF
Usage: $(basename "$0") --log workspace/session-logs/<file>.json [--dry-run]

Copies workspace artifacts listed in the session log into the repo directory.
Each change entry with "promote": true will be synced.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --log)
      LOG_FILE="$2"
      shift 2
      ;;
    --dry-run|-n)
      DRY_RUN=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "[ERROR] Unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if [[ -z "${LOG_FILE}" ]]; then
  echo "[ERROR] --log is required." >&2
  usage
  exit 1
fi

if [[ ! -f "${LOG_FILE}" ]]; then
  echo "[ERROR] Session log not found: ${LOG_FILE}" >&2
  exit 1
fi

PROMOTE_ENTRIES=()
while IFS=$'\t' read -r workspace repo notes; do
  [[ -n "${workspace}" ]] || continue
  [[ -n "${repo}" ]] || continue
  PROMOTE_ENTRIES+=("${workspace}"$'\t'"${repo}"$'\t'"${notes}")
done < <(python3 - <<'PY' "${LOG_FILE}"
import json, sys, pathlib
log_path = pathlib.Path(sys.argv[1])
with log_path.open() as f:
    data = json.load(f)
changes = data.get("changes", [])
for entry in changes:
    if not entry.get("promote"):
        continue
    workspace = entry.get("workspace_path")
    repo = entry.get("repo_path")
    if not workspace or not repo:
        continue
    notes = entry.get("notes", "")
    print(f"{workspace}\t{repo}\t{notes}")
PY
)

if [[ ${#PROMOTE_ENTRIES[@]} -eq 0 ]]; then
  echo "[INFO] No promotable entries found in ${LOG_FILE}."
  exit 0
fi

copy_file() {
  local src="$1"
  local dest="$2"
  local notes="$3"
  if [[ ${DRY_RUN} -eq 1 ]]; then
    echo "[DRY] copy ${src} -> ${dest} (${notes})"
    return
  fi
  mkdir -p "$(dirname "${dest}")"
  rsync -a "${src}" "${dest}"
  echo "[OK] Copied file ${src} -> ${dest} (${notes})"
}

sync_directory() {
  local src="$1"
  local dest="$2"
  local notes="$3"
  if [[ ${DRY_RUN} -eq 1 ]]; then
    echo "[DRY] sync dir ${src}/ -> ${dest}/ (${notes})"
    return
  fi
  mkdir -p "${dest}"
  rsync -a --delete "${src}/" "${dest}/"
  echo "[OK] Synced directory ${src}/ -> ${dest}/ (${notes})"
}

for entry in "${PROMOTE_ENTRIES[@]}"; do
  IFS=$'\t' read -r workspace_rel repo_rel notes <<< "${entry}"
  workspace_path="${PROJECT_ROOT}/${workspace_rel}"
  repo_path="${REPO_ROOT}/${repo_rel}"

  if [[ ! -e "${workspace_path}" ]]; then
    echo "[WARN] Workspace path missing, skipping: ${workspace_rel}"
    continue
  fi

  if [[ -d "${workspace_path}" ]]; then
    sync_directory "${workspace_path%/}" "${repo_path%/}" "${notes}"
  else
    copy_file "${workspace_path}" "${repo_path}" "${notes}"
  fi
done
