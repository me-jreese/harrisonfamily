#!/usr/bin/env bash
# MCP-C03-style live check: validates an MCP access token against the LIVE auth edge (metadata + JWKS), without printing it.
#   MCP_TOKEN=<access_token> scripts/mcp/token-smoke.sh [--base https://harrisonfamily.us/auth] [--audience https://mcp.harrisonfamily.us]
# Obtain a token by running the authorization-code + PKCE flow against /authorize and /token (e.g. from the MCP inspector), then pass it in
# MCP_TOKEN. Checks: RFC 8414 metadata shape (S256, public client), RS256 signature via jwks_uri, kid, iss, aud, sub (gramps_id), groups, exp.
set -euo pipefail
BASE=https://harrisonfamily.us/auth; AUD=https://mcp.harrisonfamily.us
while [ $# -gt 0 ]; do case "$1" in --base) BASE=$2; shift;; --audience) AUD=$2; shift;; *) echo "unknown arg $1" >&2; exit 2;; esac; shift; done
: "${MCP_TOKEN:?set MCP_TOKEN to an access token from /auth/token}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
[ -d "$ROOT/auth/node_modules/jose" ] || { echo "run npm ci in auth/ first (needs jose)" >&2; exit 1; }
cd "$ROOT/auth"
BASE="$BASE" AUD="$AUD" node --input-type=module -e '
import { createRemoteJWKSet, jwtVerify, decodeProtectedHeader } from "jose";
const base = process.env.BASE.replace(/\/+$/, ""), token = process.env.MCP_TOKEN;
const md = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
const must = (ok, msg) => { if (!ok) { console.error("FAIL " + msg); process.exit(1); } console.log("ok   " + msg); };
must(md.issuer === base, "metadata issuer is " + base);
must(md.code_challenge_methods_supported?.join() === "S256", "PKCE S256 only");
must(md.token_endpoint_auth_methods_supported?.join() === "none", "public client only");
must(md.grant_types_supported?.includes("authorization_code") && md.grant_types_supported?.includes("refresh_token"), "grant types");
must(!!md.authorization_endpoint && !!md.token_endpoint && !!md.registration_endpoint, "endpoints present");
const { kid, alg } = decodeProtectedHeader(token);
const { payload } = await jwtVerify(token, createRemoteJWKSet(new URL(md.jwks_uri)), { issuer: md.issuer, audience: process.env.AUD, algorithms: ["RS256"] });
must(alg === "RS256" && kid === "hfy-session-1", "RS256 signature verifies against the live JWKS (kid " + kid + ")");
must(/^[A-Za-z0-9_-]+$/.test(payload.sub ?? ""), "sub is a gramps_id (" + payload.sub + ")");
must(Array.isArray(payload.groups) && payload.groups.includes("members"), "groups: " + JSON.stringify(payload.groups));
must(payload.exp - payload.iat <= 3600, "exp within 1h (" + new Date(payload.exp * 1000).toISOString() + ")");
'
