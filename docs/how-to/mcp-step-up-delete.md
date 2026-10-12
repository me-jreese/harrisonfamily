# How to delete posts and comments through the MCP connector (step-up)

**Goal:** run an admin delete (`hfy_posts_delete`, `hfy_comments_delete`) from an MCP client such as Claude.

The MCP server only runs a delete when the access token shows a strong sign-in that is recent: `amr` contains `mfa`, and `auth_time` is no more than 300 seconds old (HFY-R64, narrowed by HFY-R67). A passkey sign-in gets `mfa` only when your device verified you during it (Face ID, Touch ID, Windows Hello, or the PIN of a security key). `passkey`, `hwk` or `swk` alone mean "something you have" and do not count, so a security key with no PIN, used on a shared computer, cannot unlock a delete. The auth edge puts `email`, `amr` and `auth_time` into every MCP access token. A refresh token reuses the original `auth_time`, so a refreshed token does not count as a fresh sign-in.

## Prerequisites

- Your subject is in the `hfy-admin` group (`groups.json`).
- You have a passkey on your account (`https://harrisonfamily.us/auth/passkeys`) that verifies you. iPhone, iPad and Mac passkeys always do; a hardware security key needs a PIN set.

## Steps

1. Sign in at `https://harrisonfamily.us/auth/login` with your passkey, and complete the Face ID, Touch ID or PIN prompt.
2. Within 5 minutes, connect or reconnect the MCP connector. Authorization reuses the session you just created and issues a token with the fresh `auth_time`.
3. Ask for the delete. After 5 minutes the server refuses it; repeat from step 1.

## Clients that implement RFC 9470

The authorization endpoint honors OIDC `max_age` and `prompt=login`. A client that sends `max_age` (for example 300) gets the login page when your last sign-in is older than that, and is returned to the same authorization request after you sign in. Nothing else is needed on your side.
