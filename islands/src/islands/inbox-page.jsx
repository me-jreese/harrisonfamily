// /me/inbox/ (HFY-TSK-185, flag inboxV1): the full inbox, the same kit NotificationInbox the bell opens, at every width. Signed in only
// (the inbox is per member): signed out it is the neutral sign-in line. The static page keeps its "not available yet" note until this
// bundle runs, and feature-flags.js loads the bundle only with inboxV1, so with the flag off nothing here is ever requested (HFY-R8).
import { memberSub, useEdgeSession } from "../lib/edge-session.js";
import { mountIsland } from "../lib/mount.jsx";
import { COPY, Inbox, SETTINGS_ROUTE, useFamilyInbox } from "../lib/inbox-ui.jsx";
import "./inbox-page.css";

export const SIGN_IN_HREF = "/auth/login?returnTo=%2Fme%2Finbox%2F";

function SignInGate() {
  return (
    <div className="hfy-inboxpage__gate" role="status" data-hfy-gate>
      <p>{COPY.signedOut}</p>
      <a className="hfy-inboxpage__signin" href={SIGN_IN_HREF}>{COPY.signIn}</a>
    </div>
  );
}

function Member() {
  const inbox = useFamilyInbox();
  return (
    <>
      <Inbox inbox={inbox} />
      <p className="hfy-inboxpage__settings"><a className="hfy-inboxpage__link" href={SETTINGS_ROUTE}>{COPY.settings}</a></p>
    </>
  );
}

function InboxPage() {
  const session = useEdgeSession();
  const sub = memberSub(session);
  return (
    <section className="hfy-inboxpage" aria-label="your inbox" aria-busy={session === undefined}>
      {session === undefined && <div className="hfy-inboxpage__skeleton" role="status" aria-label={COPY.loading} />}
      {session !== undefined && !sub && <SignInGate />}
      {sub && <Member />}
    </section>
  );
}

const off = document.querySelector("[data-inbox-off]");
if (off) off.remove();
mountIsland("inbox-page", InboxPage);
