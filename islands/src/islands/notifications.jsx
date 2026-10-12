// /me/notifications: per-type preferences + push opt-in on @io-kit/notify 0.4.0 (HFY-TSK-068, BRD D-08). DS components/Notifications.
import "@io-kit/notify/notify.css";
import "./notifications.css";
import { useCallback, useEffect, useMemo, useState } from "react";
import { createFetchNotifyApi } from "@io-kit/notify";
import { NotificationSettings, PushNudge } from "@io-kit/notify/react";
import { mountIsland } from "../lib/mount.jsx";
import { edgeSignedOut, signedOutResponse } from "../lib/api.js";

// Four HFY types. "generic" is level 0 (content-free, the default); "detailed" is level 1 (may name the actor).
// Labels and descriptions are the DS catalog copy (lowercase, "my page", never "record"). title / generic / detailed are the lock-screen
// preview and stay word-for-word what the server sends (api/src/notify.js), so the preview never promises a text it will not get.
export const CATALOG = {
  groups: [{ id: "family", label: "family" }],
  types: {
    comment_on_my_record: { group: "family", label: "someone comments on my page", desc: "a comment on your page in the family tree.", title: "Harrison Family", generic: "someone commented on your page.", detailed: "{actor} commented on your page." },
    reply_to_me: { group: "family", label: "someone replies to me", desc: "a reply where you commented.", title: "Harrison Family", generic: "someone replied to you.", detailed: "{actor} replied to you." },
    new_family_post: { group: "family", label: "family posts something new", desc: "a new post on the family timeline.", title: "Harrison Family", generic: "there's a new family post.", detailed: "{actor} shared a new family post." },
    mention: { group: "family", label: "someone mentions me", desc: "someone writes @ and your name in a comment.", title: "Harrison Family", generic: "you were mentioned.", detailed: "{actor} mentioned you." }
  },
  levels: { generic: "hide the details", detailed: "show who", hint: "hidden details keep names off your lock screen." },
  sample: { actor: "A family member" }
};

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

// Same-origin API (/api/notifications/*), signed session cookie. HFY-TSK-069 (D-11): with authV2 and a signed-out edge session the
// preferences GET can only answer 401 (a console error on every visit), so it is answered locally with that same 401 and not sent.
export const api = createFetchNotifyApi("/api", async (url, init) => ((await edgeSignedOut()) ? signedOutResponse() : fetch(url, { ...init, credentials: "include" })));

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
  return (
    <>
      <PushNudge api={api} dismissKey="hfy:notify-nudge" labels={LABELS} />
      {loadError && <p className="hfy-notify__banner" role="alert" data-hfy-banner>{loadError}</p>}
      <NotificationSettings catalog={CATALOG} api={watched} lockScreenHint banners labels={LABELS} />
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
