// Access-request mail from the API (surfaces.md 7.8; task surf-access-admin-api): what the admin routes tell the requester and the member.
// A thin SES sender over shared/emails.mjs, like auth/src/mailer.js: plain text, no links, no tracking, and every message a system template,
// so an admin never writes a word of the mail except the optional decline note, which the route scans first (R-18). The AWS client is
// injected: `send(input)` takes a SESv2 SendEmail input (src/index.js builds it with @aws-sdk/client-sesv2).
//
// The api role's ses:SendEmail grant, conditioned on ses:FromAddress, comes from app-stack-sync-infra (SesIdentityArn, SesFromAddress and
// SesConfigurationSet; test_app_stack.py pins it), so this mailer sends from SES_FROM_ADDRESS with SES_CONFIGURATION_SET.
import { renderEmail } from "./shared/emails.mjs";

/** The SESv2 SendEmail input for one template. `from` is a bare address (the IAM ses:FromAddress condition compares it exactly). */
export function sendEmailInput({ from, configurationSet, template, to, vars }) {
  if (!configurationSet) throw new Error("the SES configuration set is not set");
  const { subject, text } = renderEmail(template, vars);
  return {
    FromEmailAddress: from,
    Destination: { ToAddresses: [to] },
    Content: { Simple: { Subject: { Data: subject, Charset: "UTF-8" }, Body: { Text: { Data: text, Charset: "UTF-8" } } } },
    ConfigurationSetName: configurationSet,
  };
}

/**
 * `{ send({ template, to, vars }) }`. It rejects when SES does or when mail is not configured; the caller decides what that means (the
 * admin routes commit first and answer `emailSent: false`). Errors carry the SES error name only: an SES message can quote the address.
 */
export function createSesMailer({ send, from, configurationSet }) {
  if (!from) throw new Error("the From address is not set");
  if (!configurationSet) throw new Error("the SES configuration set is not set"); // fail closed: no feedback without one
  return {
    async send({ template, to, vars }) {
      try {
        await send(sendEmailInput({ from, configurationSet, template, to, vars }));
      } catch (e) {
        throw Object.assign(new Error("mail not sent"), { name: e instanceof Error && e.name ? e.name : "MailError" });
      }
    },
  };
}
