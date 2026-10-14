// The follow toggle on the person hero (HFY-TSK-186, flag recordSubsV1; HFY-PLN-002 social.md section 6, R-12). It fills the person page's
// [data-slot="follow"] host (HFY-TSK-137 mount points) and edits nothing else. The hero and its slots are rebuilt by every render, so it
// fills the host again on every hfy:person-rendered; the loader can run after the first render, so it also fills once if the host is there.
// Absent on your own page, when signed out, and when the routes answer anything but a clean "following or not" (404 = flag off at the API).
// A failed follow or unfollow rolls the toggle back and shows a banner.
import "./follow.css";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { getMe } from "../lib/me.js";
import { FOLLOW_COPY, follow, getFollowing, helperSeen, markHelperSeen, unfollow } from "../lib/follow.js";

/** What this page view knows, so a hero rebuild shows the toggle as it was left without asking again. */
const known = new Map(); // personId -> boolean

export function FollowToggle({ personId, onShown }) {
  const [state, setState] = useState({ phase: "loading", on: false });
  const [banner, setBanner] = useState(false);
  const [helper, setHelper] = useState(false);
  useEffect(() => {
    let live = true;
    (async () => {
      const me = await getMe();
      if (!me.id || me.id === personId) return live && setState({ phase: "hidden", on: false });
      if (known.has(personId)) return live && setState({ phase: "ready", on: known.get(personId) });
      try {
        const on = await getFollowing(personId);
        known.set(personId, on);
        if (live) setState({ phase: "ready", on });
      } catch {
        if (live) setState({ phase: "hidden", on: false });
      }
    })();
    return () => { live = false; };
  }, [personId]);
  const shown = state.phase === "ready";
  useEffect(() => { onShown?.(shown); }, [shown, onShown]);
  if (!shown) return null;

  const toggle = async () => {
    const next = !state.on;
    setBanner(false);
    setState({ phase: "ready", on: next });
    known.set(personId, next);
    try {
      await (next ? follow(personId) : unfollow(personId));
      setHelper(next && !helperSeen());
      if (next) markHelperSeen();
    } catch {
      known.set(personId, !next);
      setState({ phase: "ready", on: !next });
      setHelper(false);
      setBanner(true);
    }
  };
  return (
    <div className="hfy-follow">
      <button type="button" className="hfy-follow__btn" aria-pressed={state.on} data-hfy-follow onClick={toggle}>
        {state.on ? FOLLOW_COPY.following : FOLLOW_COPY.follow}
      </button>
      {helper && <p className="hfy-follow__helper" data-hfy-follow-helper>{FOLLOW_COPY.helper}</p>}
      {banner && <p className="hfy-follow__banner" role="alert" data-hfy-banner>{FOLLOW_COPY.failed}</p>}
    </div>
  );
}

let mounted = null; // { host, root, personId }

function fill(personId) {
  const host = document.querySelector('#person-hero [data-slot="follow"], [data-slot="follow"]');
  if (!host || !personId) return;
  if (mounted && mounted.host === host && mounted.personId === personId && host.isConnected) return;
  if (mounted) {
    try { mounted.root.unmount(); } catch { /* the old host is gone with the old hero */ }
  }
  const heading = host.closest(".person-heading");
  // The wide layout (follow.css) moves the actions up beside the name only while a toggle is showing.
  const onShown = (on) => { if (heading) { if (on) heading.setAttribute("data-hfy-follow-row", ""); else heading.removeAttribute("data-hfy-follow-row"); } };
  const root = createRoot(host);
  root.render(<FollowToggle personId={personId} onShown={onShown} />);
  mounted = { host, root, personId };
}

document.addEventListener("hfy:person-rendered", (e) => fill(e.detail && e.detail.personId));
fill(new URLSearchParams(location.search).get("id"));
