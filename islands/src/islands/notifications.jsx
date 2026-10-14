// /me/notifications: per-type preferences + push opt-in on @io-kit/notify (0.4.0 when built, 0.6.0 since HFY-TSK-185; HFY-TSK-068, BRD D-08). DS components/Notifications.
import "@io-kit/notify/notify.css";
import "./notifications.css";
import { useCallback, useEffect, useMemo, useState } from "react";
import { NotificationSettings, PushNudge } from "@io-kit/notify/react";
import { mountIsland } from "../lib/mount.jsx";
import { edgeSignedOut } from "../lib/api.js";
import { notifyApi } from "../lib/notify-api.js";
import { CATALOG, catalogFor } from "../lib/notify-catalog.js";
import { getMe } from "../lib/me.js";

// The catalog (lib/notify-catalog.js) holds one entry per type of the API registry, grouped "about me", "family" and "for moderators";
// the moderators group is shown to an admin only (catalogFor). tests/notify-catalog.test.mjs fails when it drifts from the registry.
export { CATALOG };

// DS Voice microcopy for every string the kit renders.
export const LABELS = {
  heading: "texts on this device",
  saving: "saving…",
  saved: "saved",
  saveError: "that didn't save. try again, or text J.",
  lockScreenHint: "showing who puts names on your lock screen.",
  unsupportedText: "this browser can't get texts from us. if that's wrong, text J.",
  deniedText: "texts are turned off for this site in your phone's settings.",
  nudgeAriaLabel: "texts",
  dismiss: "not now",
  prompt: "want a text when someone posts? you can turn it off anytime.",
  turnOn: "turn them on",
  blocked: "texts are turned off for this site in your phone's settings.",
  iosHint: "on iphone, add this to your home screen first. tap share, then add to home screen.",
};
const LOAD_FAILED = "that didn't work. try again, or text J.";
const SIGNED_OUT = "this page is family-only. sign in to see it.";

// Same-origin API (/api/notifications/*), signed session cookie; the one client the bell and /me/inbox/ share (lib/notify-api.js).
export const api = notifyApi;

/**
 * Signed out there is nothing to set: the island resolves the edge session once, shows a skeleton while that is pending, and when
 * signed out renders only the neutral sign-in gate (one line, one 44px "sign in"). No PushNudge, no settings with unsaveable defaults,
 * and never the push API (enablePush would fire the OS permission prompt, then report a false "turned off in your phone's settings").
 * A 401 from the preferences load (authV2 off) lands on the same gate.
 */
function SignInGate() {
  const returnTo = encodeURIComponent(location.pathname + location.search);
  return (
    <div className="hfy-notify__gate" role="status" data-hfy-gate>
      <p>{SIGNED_OUT}</p>
      <a className="hfy-notify__signin" href={`/auth/login?returnTo=${returnTo}`}>sign in</a>
    </div>
  );
}

function Settings({ onSignedOut }) {
  // The kit swallows a failed preferences load (it renders defaults); the island says so in a danger banner.
  const [loadError, setLoadError] = useState(null);
  const watched = useMemo(() => ({
    ...api,
    getPreferences: () => api.getPreferences().then((p) => { setLoadError(null); return p; }, (e) => {
      if (/: 401$/.test(String(e?.message))) onSignedOut();
      else setLoadError(LOAD_FAILED);
      throw e;
    }),
  }), [onSignedOut]);
  // The moderators' group is for admins (/api/me, one shared request per page); the list waits for the answer so it never reflows.
  const [admin, setAdmin] = useState(null);
  useEffect(() => {
    let live = true;
    getMe().then((me) => { if (live) setAdmin(me.admin === true); });
    return () => { live = false; };
  }, []);
  const catalog = useMemo(() => (admin === null ? null : catalogFor({ admin })), [admin]);
  return (
    <>
      <PushNudge api={api} dismissKey="hfy:notify-nudge" labels={LABELS} />
      {loadError && <p className="hfy-notify__banner" role="alert" data-hfy-banner>{loadError}</p>}
      {catalog ? <NotificationSettings catalog={catalog} api={watched} lockScreenHint banners labels={LABELS} /> : <div className="iok-notify-skeleton" role="status" aria-label="loading" />}
    </>
  );
}

function Notifications() {
  const [signedOut, setSignedOut] = useState(undefined);
  useEffect(() => {
    let live = true;
    edgeSignedOut().then((out) => { if (live) setSignedOut(out); });
    return () => { live = false; };
  }, []);
  const onSignedOut = useCallback(() => setSignedOut(true), []);
  return (
    <section className="hfy-notify" aria-label="texts and notifications" aria-busy={signedOut === undefined}>
      {signedOut === undefined && <div className="iok-notify-skeleton" role="status" aria-label="loading" />}
      {signedOut === true && <SignInGate />}
      {signedOut === false && <Settings onSignedOut={onSignedOut} />}
    </section>
  );
}

const off = document.querySelector("[data-notify-off]");
if (off) off.remove();
mountIsland("notifications", Notifications);
