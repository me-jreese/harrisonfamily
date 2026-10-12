// Cognito password provisioning for POST /auth/link (the only place this app creates Cognito users; HFY-R58 ruling 5).
// The pool is AdminCreateUserOnly, so a user exists only if this code created it: AdminCreateUser runs only AFTER the allowlist
// check (the kit re-checks the allowlist only after provisioning). A pre-existing user that was self-signed-up before the pool
// was locked down (UNCONFIRMED, or email_verified false) is confirmed, marked verified and given the member's password.
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
