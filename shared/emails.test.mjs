import { test } from "node:test";
import assert from "node:assert/strict";
import { FOOTER, TEMPLATE_IDS, renderEmail } from "./emails.mjs";

test("the ten system templates exist", () => {
  assert.deepEqual([...TEMPLATE_IDS].sort(), ["admin_new", "already_member", "already_requested", "approved", "approved_later", "awaiting_record", "code", "declined", "received", "second_email_notice"]);
});

test("every message is plain text with the footer, no link and no html", () => {
  for (const id of TEMPLATE_IDS) {
    const { subject, text } = renderEmail(id, { code: "123456", note: "synthetic note" });
    assert.ok(subject.length > 0 && subject.length < 80, id);
    assert.ok(text.endsWith(`${FOOTER}\n`), id);
    assert.doesNotMatch(text, /https?:\/\/|<[a-z/]|href/i, id);
    assert.doesNotMatch(subject.replace(/Harrison Family/g, ""), /[A-Z]/, `${id}: subject is lowercase except the site name`);
  }
});

test("the code message carries the code and the fifteen-minute window", () => {
  const { text } = renderEmail("code", { code: "042042" });
  assert.match(text, /your code is 042042\. it works for 15 minutes\./);
});

test("the declined note appears only when given", () => {
  assert.doesNotMatch(renderEmail("declined").text, /a note from the family/);
  assert.match(renderEmail("declined", { note: "  please ask again  " }).text, /a note from the family: please ask again\n/);
});

test("an unknown template throws", () => {
  assert.throws(() => renderEmail("nope"), /unknown email template/);
  assert.throws(() => renderEmail("constructor"), /unknown email template/);
});

test("approved_later names a date only, and never the member whose account gets the email", () => {
  assert.match(renderEmail("approved_later", { when: "2030-01-04" }).text, /you can sign in starting 2030-01-04\./);
  assert.match(renderEmail("approved_later", { when: "not a date <b>" }).text, /starting in a few days\./);
  assert.doesNotMatch(renderEmail("approved_later", { when: "2030-01-04" }).text, /account|member|already/);
});

test("second_email_notice is content-free: it says someone asked, never who or which address", () => {
  const { text } = renderEmail("second_email_notice", { email: "x@example.test", name: "Sam" });
  assert.match(text, /in 3 days/);
  assert.doesNotMatch(text, /example\.test|Sam|@/);
});
