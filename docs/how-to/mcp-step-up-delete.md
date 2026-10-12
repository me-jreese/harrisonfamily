# How to delete posts and comments through the MCP connector (step-up)

**Goal:** run an admin delete (`hfy_posts_delete`, `hfy_comments_delete`) from an MCP client such as Claude.

The MCP server only runs a delete when the access token shows a user-verified sign-in that is recent: `amr` contains `mfa`, and `auth_time` is no more than 300 seconds old (HFY-R64, narrowed by HFY-R67). `mfa` is the only value that counts. A passkey sign-in gets `mfa` only when your device verified you during it (Face ID, Touch ID, Windows Hello, or the PIN of a security key). `passkey`, `hwk` or `swk` alone mean a single "something you have" factor, and `pwd` and `fed` (Google) never count, so a security key with no PIN, used on a shared computer, cannot unlock a delete, and neither can a Google sign-in. The auth edge puts `email`, `amr` and `auth_time` into every MCP access token. `auth_time` is the time of the original sign-in and nothing moves it later: not an MCP refresh token, and not the browser's silent session refresh (`@io-kit/auth` 2.1.1). A session you signed in to days ago and that has since been refreshed still reads as days old, so it does not count as a fresh sign-in.

## Prerequisites

- Your subject is in the `hfy-admin` group (`groups.json`).
- You have a passkey on your account (`https://harrisonfamily.us/auth/passkeys`) that verifies you. iPhone, iPad and Mac passkeys always do; a hardware security key needs a PIN set.

## Steps

1. Sign in at `https://harrisonfamily.us/auth/login` with your passkey (not Google), and complete the Face ID, Touch ID or PIN prompt.
2. Within 5 minutes, connect or reconnect the MCP connector. Authorization reuses the session you just created and issues a token with the fresh `auth_time`.
3. Ask for the delete. After 5 minutes the server refuses it; repeat from step 1.

## Clients that implement RFC 9470

The authorization endpoint honors OIDC `max_age` and `prompt=login`. A client that sends `max_age` (for example 300) gets the login page when your last sign-in is older than that, and is returned to the same authorization request after you sign in. Nothing else is needed on your side.
