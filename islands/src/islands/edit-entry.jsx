// The edit entry on the person hero (HFY-TSK-212, flag recordEdit; HFY-PLN-002 editing.md section 9.1). It fills the person page's
// [data-slot="edit"] host in the hero action slot (HFY-TSK-137 mount points) and edits nothing else; person-page.js is not touched.
// Own page: "edit my info". Another person's page: "suggest a change". An admin: "edit". Signed out, or when /api/me says editing is off:
// nothing. The hero and its slots are rebuilt by every render, so it fills the host again on every hfy:person-rendered; the loader can run
// after the first render, so it also fills once if the host is there. It is its own small bundle: the person page never loads the form kit.
import "./edit-entry.css";
import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";
import { getMe } from "../lib/me.js";
import { api } from "../lib/api.js";
import { ENTRY_LABEL, editHref, entryMode } from "../lib/editor-model.js";
import { pendingChip } from "../lib/editor-pending.js";

export function EditEntry({ personId }) {
  const [mode, setMode] = useState(null);
  const [chip, setChip] = useState(null);
  useEffect(() => {
    let live = true;
    getMe().then((me) => { if (live) setMode(entryMode(me, personId)); });
    return () => { live = false; };
  }, [personId]);
  // The "N suggested changes waiting for review" chip (editing.md 9.1), only once the entry itself shows (so only while recordEdit is on and
  // the viewer is signed in). It reads the same edit bundle the editor does, whose pending[] the server already limits to the proposals the
  // viewer may see (their own, any for an admin, or one about their own page, PS-09); a failed read just leaves the chip out.
  useEffect(() => {
    if (!mode) return undefined;
    let live = true;
    setChip(null);
    api.get(`/edit/Person/${encodeURIComponent(personId)}`).then((bundle) => { if (live) setChip(pendingChip(bundle && bundle.pending)); }, () => {});
    return () => { live = false; };
  }, [mode, personId]);
  if (!mode) return null;
  const href = editHref("Person", personId);
  return (
    <div className="hfy-edit-entry__wrap">
      <a className="hfy-edit-entry" href={href} data-hfy-edit-entry={mode}>{ENTRY_LABEL[mode]}</a>
      {chip && <p className="hfy-edit-entry__chip" role="status" data-hfy-pending-chip>{chip.text}</p>}
    </div>
  );
}

let mounted = null; // { host, root, personId }

function fill(personId) {
  const host = document.querySelector('#person-hero [data-slot="edit"], [data-slot="edit"]');
  if (!host || !personId) return;
  if (mounted && mounted.host === host && mounted.personId === personId && host.isConnected) return;
  if (mounted) {
    const old = mounted.root;
    // Not synchronously: this runs inside the hfy:person-rendered handler, and React warns on a sync unmount during a render.
    queueMicrotask(() => { try { old.unmount(); } catch { /* the old host is gone with the old hero */ } });
  }
  const root = createRoot(host);
  root.render(<EditEntry personId={personId} />);
  mounted = { host, root, personId };
}

document.addEventListener("hfy:person-rendered", (e) => fill(e.detail && e.detail.personId));
// The first fill uses ?id= only when it is a gramps id; an h:<handle> id never matches the own-page rule, so wait for the render event,
// whose detail carries the gramps id.
const first = new URLSearchParams(location.search).get("id");
if (first && !first.startsWith("h:")) fill(first);
