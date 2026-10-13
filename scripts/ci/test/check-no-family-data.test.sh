#!/usr/bin/env bash
# Demonstrates scripts/ci/check-no-family-data.sh on throwaway git repos with synthetic content.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GUARD="$HERE/../check-no-family-data.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
pass=0; fail=0

new_repo() {
  R="$TMP/repo-$1"; mkdir -p "$R"
  git -C "$R" init -q
  git -C "$R" config user.email t@example.com; git -C "$R" config user.name t
  mkdir -p "$R/harrisonfamily-frontend/person"
  echo '{"synthetic":true}' > "$R/harrisonfamily-frontend/person/I0001.json"
  printf '%s  %s\n' "$(shasum -a 256 "$R/harrisonfamily-frontend/person/I0001.json" | cut -d' ' -f1)" \
    harrisonfamily-frontend/person/I0001.json > "$R/allow.txt"
  git -C "$R" add -A -f
}
run() { HFY_GUARD_ROOT="$R" HFY_GUARD_ALLOWLIST="$R/allow.txt" bash "$GUARD" >/dev/null 2>&1; }
expect() { # name want_exit
  run; got=$?
  if [ "$got" -eq "$2" ]; then pass=$((pass+1)); echo "ok   $1"; else fail=$((fail+1)); echo "FAIL $1 (exit $got, want $2)"; fi
}
add() { mkdir -p "$R/$(dirname "$1")"; echo "$2" > "$R/$1"; git -C "$R" add -f "$1"; }

new_repo clean;      expect "allowlisted sample passes" 0
new_repo undata;     add harrisonfamily-frontend/person/I0002.json x; expect "unlisted file in a data dir fails" 1
new_repo gramps;     add trees/a.gramps x;    expect "unlisted *.gramps fails" 1
new_repo sqlite;     add a/b.sqlite x;        expect "unlisted *.sqlite fails" 1
new_repo db;         add a/b.db x;            expect "unlisted *.db fails" 1
new_repo wsl;        add workspace-local/a.txt x; expect "workspace-local file fails" 1
new_repo gout;       add graph/out/a.json x;  expect "graph/out file fails" 1
new_repo jsonl;      add graph/people/a.jsonl x; expect "graph jsonl fails" 1
new_repo gaz;        add p/q.gazetteer/a x;   expect "gazetteer file fails" 1
new_repo fixture;    add gramps/tests/fixtures/t.gramps x; expect "synthetic fixture is exempt" 0
new_repo other;      add docs/a.md x;         expect "ordinary file passes" 0
new_repo tamper;     echo '{"changed":1}' > "$R/harrisonfamily-frontend/person/I0001.json"; git -C "$R" add -f -A; expect "changed sample hash fails" 1
new_repo stale;      echo "$(printf '0%.0s' {1..64})  etl-output/gone.json" >> "$R/allow.txt"; expect "stale allowlist entry fails" 1

echo "check-no-family-data tests: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
