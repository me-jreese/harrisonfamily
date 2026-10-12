// /me/notifications: per-type preferences + push opt-in on @io-kit/notify 0.4.0 (HFY-TSK-068, BRD D-08).
import "@io-kit/notify/notify.css";
import "./notifications.css";
import { createFetchNotifyApi } from "@io-kit/notify";
import { NotificationSettings, PushNudge } from "@io-kit/notify/react";
import { mountIsland } from "../lib/mount.jsx";
import { edgeSignedOut, signedOutResponse } from "../lib/api.js";

// Four HFY types. "generic" is level 0 (content-free, the default); "detailed" is level 1 (may name the actor).
export const CATALOG = {
  groups: [{ id: "family", label: "Family" }],
  types: {
    comment_on_my_record: { group: "family", label: "Comments on my record", desc: "Someone comments on your page in the tree.", title: "Family tree", generic: "Someone commented on your record.", detailed: "{actor} commented on your record." },
    reply_to_me: { group: "family", label: "Replies to me", desc: "Someone replies in a conversation you joined.", title: "Family tree", generic: "Someone replied to you.", detailed: "{actor} replied to you." },
    new_family_post: { group: "family", label: "New family posts", desc: "A family post is published.", title: "Family news", generic: "There is a new family post.", detailed: "{actor} shared a new family post." },
    mention: { group: "family", label: "Mentions", desc: "Someone mentions you with @ in a comment.", title: "Family tree", generic: "You were mentioned.", detailed: "{actor} mentioned you." }
  },
  levels: { generic: "Hide the details", detailed: "Show who", hint: "Hidden details keep names off your lock screen." },
  sample: { actor: "A family member" }
};

// Same-origin API (/api/notifications/*), signed session cookie. HFY-TSK-069 (D-11): with authV2 and a signed-out edge session the
// preferences GET can only answer 401 (a console error on every visit), so it is answered locally with that same 401 and not sent.
export const api = createFetchNotifyApi("/api", async (url, init) => ((await edgeSignedOut()) ? signedOutResponse() : fetch(url, { ...init, credentials: "include" })));

function Notifications() {
  const ios = /iP(hone|ad|od)/.test(navigator.userAgent) && !window.matchMedia("(display-mode: standalone)").matches;
  return (
    <section className="hfy-notify" aria-label="Notification settings">
      <PushNudge api={api} dismissKey="hfy:notify-nudge" labels={{ iosHint: "To get notifications on iPhone or iPad, add this site to your Home Screen first." }} />
      {ios && (
        <aside className="hfy-notify__ios" role="note">
          <strong>iPhone and iPad</strong>
          <ol>
            <li>Tap the Share button in Safari.</li>
            <li>Choose Add to Home Screen.</li>
            <li>Open Harrison Family from the Home Screen, then come back here and turn notifications on.</li>
          </ol>
        </aside>
      )}
      <NotificationSettings catalog={CATALOG} api={api} bulkActions lockScreenHint banners />
    </section>
  );
}

const off = document.querySelector("[data-notify-off]");
if (off) off.remove();
mountIsland("notifications", Notifications);
