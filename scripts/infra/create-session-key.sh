#!/usr/bin/env bash
# Idempotently creates the auth-edge RS256 session signing key (HFY-R38): RSA-2048 generated locally, stored as JSON
# {privateKeyPem, kid} in Secrets Manager. Never prints the key. Existing secret => no-op (rotate deliberately, with a new kid).
# Usage: create-session-key.sh [--dry-run] [--name harrisonfamily/auth-edge/session-signing-key] [--kid hfy-session-1] [--region us-west-2]
set -euo pipefail
NAME=harrisonfamily/auth-edge/session-signing-key; KID=hfy-session-1; REGION=us-west-2; DRY=0
while [ $# -gt 0 ]; do case "$1" in
  --dry-run) DRY=1;; --name) NAME=$2; shift;; --kid) KID=$2; shift;; --region) REGION=$2; shift;; *) echo "unknown arg $1" >&2; exit 2;; esac; shift; done
if aws secretsmanager describe-secret --region "$REGION" --secret-id "$NAME" >/dev/null 2>&1; then
  echo "secret $NAME already exists in $REGION: no change"; exit 0
fi
if [ "$DRY" = 1 ]; then echo "(dry-run) would generate an RSA-2048 key (kid $KID) and create secret $NAME in $REGION"; exit 0; fi
umask 077
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$TMP/key.pem" 2>/dev/null
jq -n --rawfile k "$TMP/key.pem" --arg kid "$KID" '{privateKeyPem:$k,kid:$kid}' > "$TMP/secret.json"
aws secretsmanager create-secret --region "$REGION" --name "$NAME" --description "harrisonfamily auth edge RS256 session signing key (kid $KID)" \
  --secret-string "file://$TMP/secret.json" --query Name --output text >/dev/null
echo "created secret $NAME (kid $KID) in $REGION"
