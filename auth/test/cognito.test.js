// cognito-self-signup-enabled: AdminCreateUser only after the allowlist check; a self-signed-up user is repaired, not trusted.
import { describe, it, expect } from "vitest";
import { cognitoFirstPassword, cognitoProvisioner, randomPassword } from "../src/cognito.js";

const POOL = "us-west-2_TEST";
const ALLOW = { "ana@example.com": "I0111", "bo@example.com": "I0222" };
const resolver = async (email) => (ALLOW[email] ? { sub: ALLOW[email] } : null);
const notFound = () => Object.assign(new Error("User does not exist."), { name: "UserNotFoundException" });

function cognito(users = {}) {
  const calls = [];
  const send = async (name, input) => {
    calls.push([name, input]);
    if (name === "AdminGetUser") {
      const u = users[input.Username];
      if (u instanceof Error) throw u;
      if (!u) throw notFound();
      return u;
    }
    if (name === "AdminCreateUser") return { User: { Username: "uuid-new", UserStatus: "FORCE_CHANGE_PASSWORD", Attributes: [{ Name: "sub", Value: "cog-new" }, ...input.UserAttributes] } };
    return {};
  };
  return { calls, names: () => calls.map((c) => c[0]), send };
}

describe("cognitoProvisioner.setPassword", () => {
  it("creates an allowlisted member (suppressed invite, verified email) and sets a permanent password", async () => {
    const c = cognito();
    const r = await cognitoProvisioner({ userPoolId: POOL, send: c.send, resolver }).setPassword({ email: "Ana@Example.com", hostSub: "I0111", password: "pw-1234567890" });
    expect(c.names()).toEqual(["AdminGetUser", "AdminCreateUser", "AdminSetUserPassword"]);
    expect(c.calls[1][1]).toEqual({
      UserPoolId: POOL, Username: "ana@example.com", MessageAction: "SUPPRESS",
      UserAttributes: [{ Name: "email", Value: "ana@example.com" }, { Name: "email_verified", Value: "true" }],
    });
    expect(c.calls[2][1]).toEqual({ UserPoolId: POOL, Username: "ana@example.com", Password: "pw-1234567890", Permanent: true });
    expect(r).toEqual({ idpIssuer: `https://cognito-idp.us-west-2.amazonaws.com/${POOL}`, idpSub: "cog-new" });
  });
  it("never touches Cognito for an email that is not on the allowlist", async () => {
    const c = cognito();
    await expect(cognitoProvisioner({ userPoolId: POOL, send: c.send, resolver }).setPassword({ email: "stranger@example.com", hostSub: "I0111", password: "pw-1234567890" }))
      .rejects.toMatchObject({ code: "AUTH_FORBIDDEN", detail: "not_allowlisted", status: 403 });
    expect(c.calls).toEqual([]);
  });
  it("never touches Cognito when the email belongs to a different member, or the allowlist is unreadable", async () => {
    const c = cognito();
    const p = cognitoProvisioner({ userPoolId: POOL, send: c.send, resolver });
    await expect(p.setPassword({ email: "bo@example.com", hostSub: "I0111", password: "pw-1234567890" })).rejects.toMatchObject({ detail: "link_conflict" });
    const broken = cognitoProvisioner({ userPoolId: POOL, send: c.send, resolver: async () => { throw new Error("s3 down"); } });
    await expect(broken.setPassword({ email: "ana@example.com", hostSub: "I0111", password: "pw-1234567890" })).rejects.toMatchObject({ code: "AUTH_FORBIDDEN", detail: "not_allowlisted" });
    expect(c.calls).toEqual([]);
  });
  it("repairs a self-signed-up account (UNCONFIRMED, email unverified): confirm, verify, then the member's password", async () => {
    const c = cognito({ "ana@example.com": { Username: "uuid-x", UserStatus: "UNCONFIRMED", UserAttributes: [{ Name: "sub", Value: "cog-x" }, { Name: "email", Value: "ana@example.com" }, { Name: "email_verified", Value: "false" }] } });
    const r = await cognitoProvisioner({ userPoolId: POOL, send: c.send, resolver }).setPassword({ email: "ana@example.com", hostSub: "I0111", password: "pw-1234567890" });
    expect(c.names()).toEqual(["AdminGetUser", "AdminConfirmSignUp", "AdminUpdateUserAttributes", "AdminSetUserPassword"]);
    expect(c.calls[2][1]).toEqual({ UserPoolId: POOL, Username: "ana@example.com", UserAttributes: [{ Name: "email_verified", Value: "true" }] });
    expect(r.idpSub).toBe("cog-x");
  });
  it("an existing confirmed, verified member only gets the new password", async () => {
    const c = cognito({ "ana@example.com": { UserStatus: "CONFIRMED", UserAttributes: [{ Name: "sub", Value: "cog-a" }, { Name: "email_verified", Value: "true" }] } });
    await cognitoProvisioner({ userPoolId: POOL, send: c.send, resolver }).setPassword({ email: "ana@example.com", hostSub: "I0111", password: "pw-1234567890" });
    expect(c.names()).toEqual(["AdminGetUser", "AdminSetUserPassword"]);
  });
  it("a Cognito failure other than UserNotFound is surfaced, never answered with AdminCreateUser", async () => {
    const throttled = Object.assign(new Error("Rate exceeded"), { name: "TooManyRequestsException" });
    const c = cognito({ "ana@example.com": throttled });
    await expect(cognitoProvisioner({ userPoolId: POOL, send: c.send, resolver }).setPassword({ email: "ana@example.com", hostSub: "I0111", password: "pw-1234567890" }))
      .rejects.toMatchObject({ name: "TooManyRequestsException" });
    expect(c.names()).toEqual(["AdminGetUser"]);
  });
});

describe("cognitoFirstPassword.provision (SURF-D18, io's Q2-12)", () => {
  const make = (c, extra = {}) => cognitoFirstPassword({ userPoolId: POOL, send: c.send, resolver, password: () => "Aa1-random-for-test", ...extra });
  it("allowlisted, no pool user: creates it (invite suppressed, email verified) and sets a random permanent password", async () => {
    const c = cognito();
    expect(await make(c).provision(" Ana@Example.com ")).toBe("created");
    expect(c.names()).toEqual(["AdminGetUser", "AdminCreateUser", "AdminSetUserPassword"]);
    expect(c.calls[1][1]).toEqual({
      UserPoolId: POOL, Username: "ana@example.com", MessageAction: "SUPPRESS",
      UserAttributes: [{ Name: "email", Value: "ana@example.com" }, { Name: "email_verified", Value: "true" }],
    });
    expect(c.calls[2][1]).toEqual({ UserPoolId: POOL, Username: "ana@example.com", Password: "Aa1-random-for-test", Permanent: true });
  });
  it("allowlisted, pool user exists: creates nothing and sets no password", async () => {
    for (const status of ["CONFIRMED", "UNCONFIRMED", "RESET_REQUIRED"]) {
      const c = cognito({ "ana@example.com": { UserStatus: status, UserAttributes: [{ Name: "sub", Value: "cog-a" }] } });
      expect(await make(c).provision("ana@example.com")).toBe("exists");
      expect(c.names()).toEqual(["AdminGetUser"]);
    }
  });
  it("a user stuck in FORCE_CHANGE_PASSWORD (a create that never reached set-password) is given the random password", async () => {
    const c = cognito({ "ana@example.com": { UserStatus: "FORCE_CHANGE_PASSWORD" } });
    expect(await make(c).provision("ana@example.com")).toBe("exists");
    expect(c.names()).toEqual(["AdminGetUser", "AdminSetUserPassword"]);
    expect(c.calls[1][1]).toMatchObject({ Username: "ana@example.com", Permanent: true });
  });
  it("not allowlisted, or an unreadable allowlist: no Cognito call of any kind", async () => {
    const c = cognito();
    expect(await make(c).provision("stranger@example.com")).toBe("not_allowlisted");
    expect(await make(c).provision("")).toBe("not_allowlisted");
    expect(await make(c).provision(undefined)).toBe("not_allowlisted");
    expect(await make(c, { resolver: async () => { throw new Error("s3 down"); } }).provision("ana@example.com")).toBe("not_allowlisted");
    expect(c.calls).toEqual([]);
  });
  it("a create that loses a race (UsernameExistsException) is fine; any other Cognito failure rejects", async () => {
    const raced = cognito();
    const send = async (name, input) => {
      if (name === "AdminCreateUser") throw Object.assign(new Error("exists"), { name: "UsernameExistsException" });
      return raced.send(name, input);
    };
    expect(await make({ send }).provision("ana@example.com")).toBe("exists");
    expect(raced.names()).toEqual(["AdminGetUser"]);
    const down = (at) => ({ send: async (name) => { if (name === at) throw Object.assign(new Error("boom"), { name: "InternalErrorException" }); if (name === "AdminGetUser") throw notFound(); return {}; } });
    for (const at of ["AdminGetUser", "AdminCreateUser", "AdminSetUserPassword"]) {
      const c = at === "AdminGetUser" ? { send: async () => { throw Object.assign(new Error("boom"), { name: "InternalErrorException" }); } } : down(at);
      await expect(make(c).provision("ana@example.com"), at).rejects.toMatchObject({ name: "InternalErrorException" });
    }
  });
  it("the random password is 32 fresh random bytes that meet the pool policy (12+, upper, lower, number)", () => {
    const a = randomPassword();
    expect(a).toMatch(/^Aa1[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(randomPassword());
  });
});
