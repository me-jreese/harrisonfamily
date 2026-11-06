// HFY-TSK-388-0G (plan HFY-PLN-004, pass 2): the kit's tag editor (@io-kit/media/tags TagEditor) over the HFY tag ports of pass 1, one mount for both surfaces: the
// person page's lightbox (lib/person-tag-editor.jsx) and the media detail page (lib/media-tag-editor-host.jsx). It replaces the shipped editor (HFY-TSK-260), under
// the same flag photoTagEdit; the server decides every write, so a tag on the member's own record saves now and another person's becomes a proposal (D-09).
//
//   source        the kit MediaSource: reads through the browse adapter (getMedia: the kit DTO), writes and the picker through the tag ports (putTags, resolvePeople,
//                 consent). One per page, so the offline queue, the locks and the audit trail share one store (IndexedDB behind lib/tag-store.js).
//   queue         the kit editor reports its unsent changes through onQueueChange; they are kept in the store. On the next mount the stored ones are replayed first
//                 (a stale one is dropped as a conflict, never overwritten); what could not be sent yet is said in a line above the editor.
//   self-untag    RemoveMeControl ("remove me from this photo", confirm, a 10 second undo) over a port that calls consent.selfUntag and, for the undo, undoSelfUntag.
//   names         the tagged people's names come from the server's read (a living person is already "a living family member", P4-R18).
import "@io-kit/media/tokens.css";
import "@io-kit/media/tags.css";
import "../tag-editor.css";
import { useEffect, useRef, useState } from "react";
import { TagEditor } from "@io-kit/media/tags";
import { createHfyMediaSource } from "./hfy-media-source.js";
import { createHfyMediaBrowse } from "./hfy-media-browse.js";
import { createTagStore } from "./tag-store.js";
import { getMe } from "./me.js";
import { personNames } from "./people-corpus.js";

const WAIT_CLOSE_MS = 4000;
export const WAITING_COPY = (n) => (n === 1 ? "1 change from earlier is waiting for a connection." : `${n} changes from earlier are waiting for a connection.`);

let shared = null;

/** The page's one tag kit: { source, store, queue, port }. */
export function tagKit() {
  if (!shared) {
    const store = createTagStore();
    const base = createHfyMediaSource({ store });
    const browse = createHfyMediaBrowse();
    // A network failure must reach the kit editor as something that is not a MediaError, or it drops the change; as a plain error it keeps it queued and retries.
    const putTags = async (ops) => {
      try { return await base.putTags(ops); } catch (e) {
        if (e && (e.status === 0 || e.status >= 500)) throw Object.assign(new Error("network"), { status: e.status });
        throw e;
      }
    };
    const source = { ...base, getMedia: browse.getMedia, putTags };
    const port = {
      async selfUntag(req) {
        await base.consent.selfUntag(req.personId, req.mediaId, req.index);
        const mine = (await base.selfUntags()).filter((x) => x.personId === req.personId && x.mediaId === req.mediaId);
        return mine[mine.length - 1];
      },
      undo: (audit) => base.undoSelfUntag(audit),
    };
    shared = { source, store, queue: base.queue, port };
  }
  return shared;
}

/** For tests: forget the page's kit. */
export const resetTagKit = () => { shared = null; };

/** `<HfyTagEditor mediaId onClose onSaved />`: the kit editor for one media (the Gramps id of the media). */
export function HfyTagEditor({ mediaId, onClose, onSaved }) {
  const kit = tagKit();
  const [boot, setBoot] = useState(null);
  const [names, setNames] = useState({});
  const [kept, setKept] = useState(0);
  const alive = useRef(true);
  // The kit calls onClose right after "done" has queued the changes. Closing then would unmount the editor before the save answers, and a stale-version banner
  // (the change is kept so the member can try again) would never show. So "done" waits for the queue to drain and closes; a conflict keeps the editor open; a
  // queue that stays (offline) closes after WAIT_CLOSE_MS, the changes being kept in the store for the next mount.
  const closeWanted = useRef(false);
  const conflictShown = useRef(false);
  const closeTimer = useRef(0);
  const finishClose = () => {
    closeWanted.current = false;
    clearTimeout(closeTimer.current);
    if (alive.current && onClose) onClose();
  };
  const settleClose = () => {
    if (!closeWanted.current || conflictShown.current) return;
    if (kit.queue.pending().length === 0) finishClose();
  };
  const handleClose = () => {
    if (conflictShown.current) { conflictShown.current = false; finishClose(); return; } // a second "done" with the banner up leaves
    closeWanted.current = true;
    clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => { if (closeWanted.current && !conflictShown.current) finishClose(); }, WAIT_CLOSE_MS);
    setTimeout(settleClose, 0);
  };

  const refreshNames = async () => {
    try {
      const r = await kit.source.readTags(mediaId);
      if (alive.current) setNames((prev) => ({ ...prev, ...Object.fromEntries(Object.entries(r.names).map(([id, v]) => [id, v.displayName])) }));
    } catch { /* the kit falls back to "living family member" */ }
  };

  useEffect(() => {
    alive.current = true;
    (async () => {
      const me = await getMe().catch(() => null);
      const locks = new Set((await kit.store.get("locks").catch(() => null)) || []);
      let left = 0;
      try {
        await kit.queue.load();
        if (kit.queue.pending().length > 0) await kit.queue.flush(kit.source);
        left = kit.queue.pending().length;
      } catch { left = kit.queue.pending().length; }
      await refreshNames();
      // The picker offers the member first as "you (<name>)"; the kit reads that name from `names`. /api/me's label can be the id itself, so the family index wins.
      let label = me && me.label ? me.label : "";
      try { const known = me && me.id ? (await personNames()).get(me.id) : ""; if (known) label = known; } catch { /* the label stays */ }
      if (alive.current) { setKept(left); setBoot({ viewer: me && me.id ? me.id : "", label, locks }); }
    })();
    return () => { alive.current = false; clearTimeout(closeTimer.current); };
  }, [mediaId]);

  if (!boot) return <p className="hfy-tag-note" role="status">looking…</p>;
  const shown = boot.viewer && boot.label && (!names[boot.viewer] || names[boot.viewer] === boot.viewer) ? { ...names, [boot.viewer]: boot.label } : names;
  return (
    <div className="hfy-tag-editor" data-hfy-tag-editor>
      {kept > 0 && <p className="hfy-tag-note" role="status" data-hfy-tag-waiting>{WAITING_COPY(kept)}</p>}
      <TagEditor
        source={kit.source}
        mediaId={mediaId}
        names={shown}
        {...(boot.viewer ? { viewerPersonId: boot.viewer } : {})}
        reAddLocks={boot.locks}
        reAddPolicy="audit-only"
        selfUntagPort={kit.port}
        onQueueChange={(ops) => { kit.queue.onQueueChange(ops); setTimeout(settleClose, 0); }}
        onSaved={(res) => {
          if (res && Array.isArray(res.conflicts) && res.conflicts.length > 0) { conflictShown.current = true; closeWanted.current = false; clearTimeout(closeTimer.current); }
          void refreshNames();
          if (onSaved) onSaved(res);
        }}
        {...(onClose ? { onClose: handleClose } : {})}
      />
    </div>
  );
}
