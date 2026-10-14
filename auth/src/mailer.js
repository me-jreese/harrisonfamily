// Access-request mail (surfaces.md 7.8). A thin SES sender over shared/emails.mjs: plain text, no links, no tracking, sent from the
// site's OWN join identity (join.<site>, its MAIL FROM subdomain and its configuration set), so a flood of join mail can never pause
// Cognito's password-reset mail (review PS-25, ruling P2-R23). The AWS client is injected: `send(input)` takes a SESv2 SendEmail input.
import { renderEmail } from "./shared/emails.mjs";

/** The SESv2 SendEmail input for one template. `from` is a bare address (the IAM ses:FromAddress condition compares it exactly). */
export function sendEmailInput({ from, configurationSet, template, to, vars }) {
  const { subject, text } = renderEmail(template, vars);
  return {
    FromEmailAddress: from,
    Destination: { ToAddresses: [to] },
    Content: { Simple: { Subject: { Data: subject, Charset: "UTF-8" }, Body: { Text: { Data: text, Charset: "UTF-8" } } } },
    ...(configurationSet ? { ConfigurationSetName: configurationSet } : {}),
  };
}

/**
 * `{ send({ template, to, vars }) }`. It rejects when SES does; the caller decides what that means (the start route answers 503, the
 * post-commit mails of the submit route are best effort). Errors carry the SES error name only: an SES message can quote the address.
 */
export function createSesMailer({ send, from, configurationSet }) {
  if (!from) throw new Error("the join From address is not set");
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
