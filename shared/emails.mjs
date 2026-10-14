// Plain-text system emails of the access-request flow (HFY-PLN-002 surfaces.md 7.8; task surf-access-request-edge). Pure ESM, no
// imports: auth/src/mailer.js (and later api/src/mailer.js) are thin senders over renderEmail(). Every message is a system
// template: an anonymous visitor can choose the address a mail goes to, never its words. Plain text only, no links, no tracking.
// Voice: lowercase except "Harrison" and site names (DS guide/04-voice.md).

export const FOOTER = "harrisonfamily.us · kept by the family, for the family";

/** Template ids. Each value is `(vars) => { subject, lines }`; `vars` are the few values a template may interpolate. */
export const TEMPLATES = Object.freeze({
  code: ({ code }) => ({
    subject: "your Harrison Family code",
    lines: [`your code is ${code}. it works for 15 minutes.`, "", "if you didn't ask to join the Harrison family site, ignore this. nobody can join with your address without this code."],
  }),
  already_member: () => ({
    subject: "you're already on the list",
    lines: ["you're already on the list. open harrisonfamily.us and tap sign in with this email."],
  }),
  already_requested: () => ({
    subject: "we have your request",
    lines: ["we already have your request. we'll email you when it's done."],
  }),
  received: () => ({
    subject: "we got your request",
    lines: ["we got your request to join. someone in the family will look at it soon, usually within a few days. we'll email you either way."],
  }),
  approved: () => ({
    subject: "you're in",
    lines: [
      "you're in. open harrisonfamily.us and tap sign in.",
      "- if this is a gmail address, tap continue with google.",
      "- otherwise tap forgot password? and we'll email you a code to set one.",
      "we will never email you a link to sign in.",
    ],
  }),
  awaiting_record: () => ({
    subject: "you're approved",
    lines: ["you're approved. we're adding you to the family tree now. we'll email you again when you can sign in."],
  }),
  declined: ({ note } = {}) => ({
    subject: "about your request",
    lines: [
      "we couldn't add you to the family site.",
      ...(typeof note === "string" && note.trim() ? ["", `a note from the family: ${note.trim()}`] : []),
      "",
      "if you think that's a mistake, ask the family member who told you about the site to reach out.",
    ],
  }),
  admin_new: () => ({
    subject: "someone asked to join the family site",
    lines: ["someone asked to join the family site. open the family site, then settings → family requests."],
  }),
});

export const TEMPLATE_IDS = Object.freeze(Object.keys(TEMPLATES));

/** `{ subject, text }` for a template id; throws for an unknown id (a programming error, never user input). */
export function renderEmail(id, vars = {}) {
  const t = Object.hasOwn(TEMPLATES, id) ? TEMPLATES[id] : undefined;
  if (!t) throw new Error("unknown email template");
  const { subject, lines } = t(vars);
  return { subject, text: `${lines.join("\n")}\n\n${FOOTER}\n` };
}
