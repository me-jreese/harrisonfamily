// /me/: the settings hub (HFY-TSK-091, navMe; HFY-PLN-002 surfaces §3.1). The shell's gear and the account sheet's "settings" open it.
// One column of 56px rows (control.h.lg; a row grows only where its dim line wraps), each a link with an icon, a label and one dim
// line, then "sign out" (the account sheet's own signOut). Shown only to a visitor the shell treats as signed in (lib/edge-session.js):
// everyone else, including authV2 off or /auth/session unreachable, gets the sign-in line, as the bar shows them "sign in" and no gear.
// A row with a `flag` shows only while that flag is on ("your links" with profileLinks, HFY-TSK-217). "family requests" for admins
// with accessRequests and GET /api/me joins this list in its own task.
import "./settings.css";
import { useEffect, useId, useState } from "react";
import { mountIsland } from "../lib/mount.jsx";
import { memberSub, useEdgeSession } from "../lib/edge-session.js";
import { signOut } from "../lib/sign-out.js";

/** The rows (DS voice: lowercase, no exclamation marks, "page" never "record"). */
export const ROWS = [
  { id: "notifications", label: "notifications", href: "/me/notifications/", line: "texts on this device, and what they're about" },
  { id: "links", label: "your links", href: "/me/links/", line: "facebook, instagram and the rest, on your page", flag: "profileLinks" },
  // "sessions" in io's brief: the kit's account page lists the sign-in methods and passkeys.
  { id: "sign-in", label: "sign-in and devices", href: "/auth/link", line: "google, password, face or fingerprint" }
];
export const SIGN_OUT = "sign out";
export const SIGNED_OUT = "sign in to change your settings.";
/** Signed out at the edge: the edge sign-in, back to the hub afterwards. */
export const SIGN_IN_HREF = "/auth/login?returnTo=%2Fme%2F";

/** The flags, once resolved ({} until then or when feature-flags.js is missing); flagged rows join when they are on. */
function useFlags() {
  const [flags, setFlags] = useState({});
  useEffect(() => {
    let live = true;
    const resolve = window.HFYFeatureFlags?.resolveFlags;
    Promise.resolve(typeof resolve === "function" ? resolve() : {}).then(
      (f) => { if (live && f && typeof f === "object") setFlags(f); },
      () => {}
    );
    return () => { live = false; };
  }, []);
  return flags;
}

/** The rows to show: those with no flag, and those whose flag is on. */
export const visibleRows = (rows, flags) => rows.filter((row) => !row.flag || flags[row.flag] === true);

function Row({ row }) {
  const id = useId();
  return (
    <li>
      <a className="hfy-settings__row" href={row.href} aria-labelledby={`${id}-label`} aria-describedby={`${id}-line`} data-hfy-setting={row.id}>
        <span className="hfy-settings__icon" aria-hidden="true" />
        <span className="hfy-settings__text">
          <span className="hfy-settings__label" id={`${id}-label`}>{row.label}</span>
          <span className="hfy-settings__line" id={`${id}-line`}>{row.line}</span>
        </span>
      </a>
    </li>
  );
}

function Hub() {
  const flags = useFlags();
  return (
    <ul className="hfy-settings__list">
      {visibleRows(ROWS, flags).map((row) => <Row key={row.id} row={row} />)}
      <li>
        <button type="button" className="hfy-settings__row" data-hfy-setting="sign-out" onClick={() => signOut()}>
          <span className="hfy-settings__icon" aria-hidden="true" />
          <span className="hfy-settings__label">{SIGN_OUT}</span>
        </button>
      </li>
    </ul>
  );
}

/** Signed out there is nothing to change: one line and one 44px "sign in" (the notifications page's gate, in the hub's words). */
function SignInGate({ href }) {
  return (
    <div className="hfy-settings__gate" role="status" data-hfy-gate>
      <p>{SIGNED_OUT}</p>
      <a className="hfy-settings__signin" href={href}>sign in</a>
    </div>
  );
}

function Settings() {
  // The gear's rule (settings need a session): the rows only for an edge session that names the member. Pending shows a skeleton;
  // signed out, authV2 off, /auth/session unreachable or a session without a sub shows the sign-in line, with the shell's sign-in link.
  const session = useEdgeSession();
  const pending = session === undefined;
  const signedIn = !pending && memberSub(session) !== null;
  return (
    <section className="hfy-settings" aria-busy={pending}>
      {pending && <div className="hfy-settings__skeleton" role="status" aria-label="loading" />}
      {!pending && !signedIn && <SignInGate href={SIGN_IN_HREF} />}
      {signedIn && <Hub />}
    </section>
  );
}

const off = document.querySelector("[data-settings-off]");
if (off) off.remove();
mountIsland("settings", Settings);
