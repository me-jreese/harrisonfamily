#!/usr/bin/env bash
# Idempotently creates the CloudFront -> Lambda shared secret (HFY-R43): 32 random bytes (hex) stored as a plain string in Secrets Manager.
# CloudFront injects it as X-Origin-Verify; both Lambdas reject requests without it. Never prints the value. Existing secret => no-op.
# Usage: create-origin-verify.sh [--dry-run] [--name harrisonfamily/cloudfront/origin-verify] [--region us-west-2]
set -euo pipefail
NAME=harrisonfamily/cloudfront/origin-verify; REGION=us-west-2; DRY=0
while [ $# -gt 0 ]; do case "$1" in
  --dry-run) DRY=1;; --name) NAME=$2; shift;; --region) REGION=$2; shift;; *) echo "unknown arg $1" >&2; exit 2;; esac; shift; done
if aws secretsmanager describe-secret --region "$REGION" --secret-id "$NAME" >/dev/null 2>&1; then
  echo "secret $NAME already exists in $REGION: no change"; exit 0
fi
if [ "$DRY" = 1 ]; then echo "(dry-run) would create secret $NAME in $REGION with a random 256-bit value"; exit 0; fi
umask 077
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
printf '%s' "$(openssl rand -hex 32)" > "$TMP/v"
aws secretsmanager create-secret --region "$REGION" --name "$NAME" --description "CloudFront -> Lambda X-Origin-Verify shared secret" \
  --secret-string "file://$TMP/v" --query Name --output text >/dev/null
echo "created secret $NAME in $REGION"
