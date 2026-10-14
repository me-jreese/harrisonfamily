// The "add or fix family connections" button on the member's own page (HFY-TSK-158, flag relationshipWizard; editing.md section 8.3). It fills a
// [data-slot="family-edit"] host in the person page's family section (created here, after the tree link when there is one, so person-page.js is
// not touched) and shows only on the signed-in member's OWN page, and only when /api/me does not say editing is off. Anyone else, a signed-out
// visitor included, gets nothing. It is its own small bundle: the person page never loads the wizard. The section and its hosts survive a render
// (only the hero is rebuilt), but the host is looked for again on every hfy:person-rendered.
import "./family-entry.css";
import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";
import { getMe } from "../lib/me.js";
import { entryMode } from "../lib/editor-model.js";
import { COPY, wizardHref } from "../lib/wizard-model.js";

export function FamilyEntry({ personId }) {
  const [own, setOwn] = useState(null);
  useEffect(() => {
    let live = true;
    getMe().then((me) => {
      if (!live) return;
      setOwn(entryMode(me, personId) === "own" ? (me.ownRecord && typeof me.ownRecord.gramps_id === "string" ? me.ownRecord.gramps_id : personId) : null);
    });
    return () => { live = false; };
  }, [personId]);
  if (!own) return null;
  return <a className="hfy-family-entry" href={wizardHref(own)} data-hfy-family-entry>{COPY.entry}</a>;
}

let mounted = null; // { host, root, personId }

function hostFor() {
  const existing = document.querySelector('[data-slot="family-edit"]');
  if (existing) return existing;
  const section = document.getElementById("person-family-section");
  if (!section) return null;
  const host = document.createElement("div");
  host.setAttribute("data-slot", "family-edit");
  const tree = section.querySelector('[data-slot="tree-link"]');
  if (tree) tree.insertAdjacentElement("afterend", host);
  else section.appendChild(host);
  return host;
}

function fill(personId) {
  if (!personId) return;
  const host = hostFor();
  if (!host) return;
  if (mounted && mounted.host === host && mounted.personId === personId && host.isConnected) return;
  if (mounted) {
    const old = mounted.root;
    // Not synchronously: this can run inside the hfy:person-rendered handler, and React warns on a sync unmount during a render.
    queueMicrotask(() => { try { old.unmount(); } catch { /* the old host is gone with its section */ } });
  }
  const root = createRoot(host);
  root.render(<FamilyEntry personId={personId} />);
  mounted = { host, root, personId };
}

document.addEventListener("hfy:person-rendered", (e) => fill(e.detail && e.detail.personId));
// The first fill uses ?id= only when it is a gramps id; an h:<handle> id waits for the render event, whose detail carries the gramps id.
const first = new URLSearchParams(location.search).get("id");
if (first && !first.startsWith("h:")) fill(first);
