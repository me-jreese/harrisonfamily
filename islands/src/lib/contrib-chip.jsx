// The hero chip "N contributions" (HFY-TSK-189, flag contribV1; social.md section 8, R-26). It fills the person page's
// [data-slot="contributions"] host in the heading chip slot (person-page-mount-points) and links to the contributions column
// (#hfy-person-contributions). The hero and its slots are rebuilt by every render, so it fills the host again on every
// hfy:person-rendered, and once at start in case the host is already there. The count is contributions.stats, shared with the column header.
// "0 contributions" shows on member pages; the chip is hidden only on records that are not members (lib/contrib-model.js chipFor). No
// answer (signed out, the route dark, offline) draws nothing.
import "../contrib.css";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { readStats } from "./contrib-api.js";
import { chipFor } from "./contrib-model.js";

export const COLUMN_ID = "hfy-person-contributions";

export function ContribChip({ personId, person }) {
  const [stats, setStats] = useState(null);
  useEffect(() => {
    let live = true;
    setStats(null);
    readStats(personId).then((s) => { if (live) setStats(s); }, () => { if (live) setStats(null); });
    return () => { live = false; };
  }, [personId]);
  const chip = chipFor(stats, person);
  if (!chip) return null;
  // A hash jump alone leaves focus where it was: put it on the column's heading, so the next Tab starts inside the column.
  const onClick = () => {
    setTimeout(() => {
      const h = document.getElementById(`${COLUMN_ID}-h`);
      if (h) { h.tabIndex = -1; h.focus({ preventScroll: true }); }
    }, 0);
  };
  return <a className="hfy-contrib-chip" href={`#${COLUMN_ID}`} onClick={onClick} data-hfy-contrib-chip>{chip.text}</a>;
}

let mounted = null; // { host, root, personId }
let latest = { personId: null, person: null };

function render(m) {
  m.root.render(<ContribChip personId={latest.personId} person={latest.person} />);
}

function fill() {
  const host = document.querySelector('#person-hero [data-slot="contributions"], [data-slot="contributions"]');
  if (!host || !latest.personId) return;
  if (mounted && mounted.host === host && mounted.personId === latest.personId && host.isConnected) { render(mounted); return; }
  if (mounted) {
    // Not synchronously: this runs inside an event that can be dispatched from a render or an effect, and React warns about an unmount there.
    const old = mounted.root;
    queueMicrotask(() => { try { old.unmount(); } catch { /* the old host is gone with the old hero */ } });
  }
  mounted = { host, root: createRoot(host), personId: latest.personId };
  render(mounted);
}

let listening = false;

/** Start filling the chip slot for `personId` (`person` is the person JSON when it is already loaded). Safe to call more than once. */
export function mountContribChip(personId, person = null) {
  latest = { personId, person };
  if (!listening) {
    listening = true;
    document.addEventListener("hfy:person-rendered", (e) => {
      const d = e.detail || {};
      latest = { personId: d.personId || latest.personId, person: d.person ?? latest.person };
      fill();
    });
  }
  fill();
}
