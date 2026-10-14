// Cognito password provisioning for POST /auth/link (HFY-R58 ruling 5) and, since SURF-D18 (io's Q2-12 decision), for the first forgot-password
// request of an allowlisted member who has no Cognito user yet (cognitoFirstPassword below). These are the only two places this app creates Cognito users.
// The pool is AdminCreateUserOnly, so a user exists only if this code created it: AdminCreateUser runs only AFTER the allowlist
// check (the kit re-checks the allowlist only after provisioning). A pre-existing user that was self-signed-up before the pool
// was locked down (UNCONFIRMED, or email_verified false) is confirmed, marked verified and given the member's password.
import { randomBytes } from "node:crypto";
import { AuthError, normalizeEmail } from "@io-kit/auth";

const attrOf = (user, name) => (user?.UserAttributes ?? user?.User?.Attributes ?? []).find((a) => a.Name === name)?.Value;

/**
 * `send(name, input)` calls the Cognito admin API `name` (e.g. "AdminGetUser") and rejects with the SDK error.
 * `resolver(email, provider)` is the allowlist resolver (email -> {sub} | null).
 */
export function cognitoProvisioner({ userPoolId, send, resolver }) {
  const region = userPoolId.split("_")[0];
  const pool = { UserPoolId: userPoolId };
  return {
    async setPassword({ email: rawEmail, hostSub, password }) {
      const email = normalizeEmail(String(rawEmail ?? ""));
      let host;
      try {
        host = await resolver(email, { kind: "password" });
      } catch (cause) {
        throw new AuthError("AUTH_FORBIDDEN", "principal resolver failed", { detail: "not_allowlisted", status: 403, cause });
      }
      if (!host || typeof host.sub !== "string" || !host.sub) throw new AuthError("AUTH_FORBIDDEN", "email is not allow-listed", { detail: "not_allowlisted", status: 403 });
      if (hostSub !== undefined && host.sub !== hostSub) throw new AuthError("AUTH_FORBIDDEN", "email resolves to a different principal", { detail: "link_conflict", status: 403 });

      let user;
      try {
        user = await send("AdminGetUser", { ...pool, Username: email });
      } catch (e) {
        if (e?.name !== "UserNotFoundException") throw e;
        user = await send("AdminCreateUser", {
          ...pool, Username: email, MessageAction: "SUPPRESS",
          UserAttributes: [{ Name: "email", Value: email }, { Name: "email_verified", Value: "true" }],
        });
      }
      if (user?.UserStatus === "UNCONFIRMED") await send("AdminConfirmSignUp", { ...pool, Username: email });
      if (String(attrOf(user, "email_verified") ?? "") !== "true") {
        // the email is verified: it reached us through a verified link (Google), never through Cognito self-service
        await send("AdminUpdateUserAttributes", { ...pool, Username: email, UserAttributes: [{ Name: "email_verified", Value: "true" }] });
      }
      await send("AdminSetUserPassword", { ...pool, Username: email, Password: password, Permanent: true });
      return { idpIssuer: `https://cognito-idp.${region}.amazonaws.com/${userPoolId}`, idpSub: String(attrOf(user, "sub") ?? "") };
    },
  };
}

/** A random permanent password nobody sees: 32 random bytes, with one of each class Cognito's policy asks for (upper, lower, number). */
export const randomPassword = (bytes = randomBytes) => `Aa1${bytes(32).toString("base64url")}`;

/** Retries a Cognito admin call that was throttled (TooManyRequestsException), up to `retries` times with a short growing pause. Any other error is rethrown at once. */
const retrying = (send, { retries = 2, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) => async (name, input) => {
  for (let attempt = 0; ; attempt++) {
    try {
      return await send(name, input);
    } catch (e) {
      if (e?.name !== "TooManyRequestsException" || attempt >= retries) throw e;
      await sleep(100 * (attempt + 1));
    }
  }
};

/**
 * First password for an allowlisted member who has no Google account (SURF-D18, io's Q2-12 decision; supersedes the HFY-R58 "only at /auth/link" sentence).
 * The edge calls `provision(email)` on POST /auth/password/forgot, after the rate limiter and before the kit sends Cognito's reset code:
 *   - not allowlisted (or the allowlist cannot be read): "not_allowlisted", and no Cognito call of any kind;
 *   - allowlisted and the pool user exists and is usable (CONFIRMED, email verified): "exists", and nothing is changed;
 *   - allowlisted and the pool user exists but the kit's forgot flow cannot reset it (a deliberate addition to surfaces.md 7.7, which says existing
 *     users get no change): FORCE_CHANGE_PASSWORD (left by a call that failed between create and set-password), UNCONFIRMED, or email_verified not
 *     true (a self-signed-up user from before the pool was locked down). It is repaired the way /auth/link repairs it (confirm, mark verified) and given a
 *     random permanent password, which also voids any password a pre-registering stranger chose: "repaired";
 *   - allowlisted and no pool user: AdminCreateUser (invite suppressed, email_verified true), then AdminSetUserPassword with a random permanent
 *     password, and "created".
 * The password is never shown or sent: the account is useless until the mailbox owner enters the code the kit's forgot flow mails, so the
 * pre-registration attack that identity-model.md describes stays closed. A throttled admin call is retried briefly; any other Cognito failure rejects
 * (the edge answers 502).
 */
export function cognitoFirstPassword({ userPoolId, send: rawSend, resolver, password = randomPassword, sleep }) {
  const pool = { UserPoolId: userPoolId };
  const send = retrying(rawSend, { sleep });
  const setRandom = (Username) => send("AdminSetUserPassword", { ...pool, Username, Password: password(), Permanent: true });
  return {
    async provision(rawEmail) {
      const email = normalizeEmail(String(rawEmail ?? ""));
      if (!email) return "not_allowlisted";
      let host;
      try {
        host = await resolver(email, { kind: "password" });
      } catch {
        return "not_allowlisted"; // fail closed: an unreadable allowlist creates nobody (the kit's forgot flow then sends nothing for a missing user)
      }
      if (!host || typeof host.sub !== "string" || !host.sub) return "not_allowlisted";
      let user;
      try {
        user = await send("AdminGetUser", { ...pool, Username: email });
      } catch (e) {
        if (e?.name !== "UserNotFoundException") throw e;
      }
      if (user) {
        const unconfirmed = user.UserStatus === "UNCONFIRMED";
        const unverified = String(attrOf(user, "email_verified") ?? "") !== "true";
        if (user.UserStatus !== "FORCE_CHANGE_PASSWORD" && !unconfirmed && !unverified) return "exists";
        if (unconfirmed) await send("AdminConfirmSignUp", { ...pool, Username: email });
        if (unverified) {
          // the address is verified here by the allowlist and by the code the mailbox owner must enter, never by Cognito self-service
          await send("AdminUpdateUserAttributes", { ...pool, Username: email, UserAttributes: [{ Name: "email_verified", Value: "true" }] });
        }
        await setRandom(email);
        return "repaired";
      }
      try {
        await send("AdminCreateUser", {
          ...pool, Username: email, MessageAction: "SUPPRESS",
          UserAttributes: [{ Name: "email", Value: email }, { Name: "email_verified", Value: "true" }],
        });
      } catch (e) {
        if (e?.name === "UsernameExistsException") return "exists"; // a concurrent forgot request created it first
        throw e;
      }
      await setRandom(email);
      return "created";
    },
  };
}
