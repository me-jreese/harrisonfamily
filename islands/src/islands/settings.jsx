// /me/: the settings hub (HFY-TSK-091, navMe; HFY-PLN-002 surfaces §3.1). The shell's gear and the account sheet's "settings" open it.
// One column of 56px rows, each a link with an icon, a label and one dim line, then "sign out" (the account sheet's own signOut).
// Rows that need flags or data that do not exist yet ("your links" with profileLinks, "family requests" for admins with
// accessRequests and GET /api/me) join this list in their own tasks.
import "./settings.css";
import { useEffect, useId, useState } from "react";
import { mountIsland } from "../lib/mount.jsx";
import { edgeSignedOut } from "../lib/api.js";
import { signOut } from "../lib/sign-out.js";

/** The rows (DS voice: lowercase, no exclamation marks, "page" never "record"). */
export const ROWS = [
  { id: "notifications", label: "notifications", href: "/me/notifications/", line: "texts on this device, and what they're about" },
  // "sessions" in io's brief: the kit's account page lists the sign-in methods and passkeys.
  { id: "sign-in", label: "sign-in and devices", href: "/auth/link", line: "google, password, face or fingerprint" }
];
export const SIGN_OUT = "sign out";
export const SIGNED_OUT = "sign in to change your settings.";
/** Signed out: the edge sign-in, back to the hub afterwards. */
export const SIGN_IN_HREF = "/auth/login?returnTo=%2Fme%2F";

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
  return (
    <ul className="hfy-settings__list">
      {ROWS.map((row) => <Row key={row.id} row={row} />)}
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
function SignInGate() {
  return (
    <div className="hfy-settings__gate" role="status" data-hfy-gate>
      <p>{SIGNED_OUT}</p>
      <a className="hfy-settings__signin" href={SIGN_IN_HREF}>sign in</a>
    </div>
  );
}

function Settings() {
  // edgeSignedOut() is true only when authV2's session probe answered "signed out"; pending shows a skeleton.
  const [signedOut, setSignedOut] = useState(undefined);
  useEffect(() => {
    let live = true;
    edgeSignedOut().then((out) => { if (live) setSignedOut(out); });
    return () => { live = false; };
  }, []);
  return (
    <section className="hfy-settings" aria-busy={signedOut === undefined}>
      {signedOut === undefined && <div className="hfy-settings__skeleton" role="status" aria-label="loading" />}
      {signedOut === true && <SignInGate />}
      {signedOut === false && <Hub />}
    </section>
  );
}

const off = document.querySelector("[data-settings-off]");
if (off) off.remove();
mountIsland("settings", Settings);
