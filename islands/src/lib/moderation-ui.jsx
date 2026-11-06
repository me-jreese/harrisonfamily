// Moderation controls for the islands (HFY-TSK-191, R-32; social.md 11.6), behind the default-off flag moderationV1.
//   - ModerateControl: the 44 px "moderate" button on a post, a story, a photo. Under 688 px it opens a bottom Sheet whose rows are 56 px,
//     from 688 px a small menu under the button. "ask for changes…" and "ask a question…" open the ask form in the same panel: a note (16 px,
//     counter, required) and the "keep it hidden until they update it" checkbox, which starts checked for changes and unchecked for a question.
//   - PostNotice: what the item itself shows. An admin sees a "hidden" badge with a one-tap "unhide"; the author sees a neutral status banner
//     (never a danger alert) with the moderator's note and an "edit" button; everyone else sees nothing, because the server never sends the item.
//   - useModerator: whether the flag is on and who is looking (id for "is this mine", admin for the badge). Comments use the kit's own menu,
//     badge and banner (lib/comments-ui.jsx), restyled to the same sheet by src/comments.css.
// The note, the moderator's name and every label are text nodes, never markup. The server re-checks admin on every call.
import "../moderation.css";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { safeUrl } from "@io-kit/content/react";
import { getSession } from "./api.js";
import { canModerate, getMe } from "./me.js";
import { useMedia } from "./use-media.js";
import { PersonName } from "./person-name.jsx";
import { COPY, FLAG, NOTE_MAX, errorLine, hideDefault, menuItems, noteError, noticeParts, postPhotoId } from "./moderation.js";

/** Under the bottom bar's breakpoint (43rem = 688 px, as posts.css) the menu is a bottom Sheet. */
export const SHEET_QUERY = "(max-width: 42.99rem)";

// ---- who is looking ---------------------------------------------------------------------------------------------------------------------

let loading = null;
/**
 * `{ enabled, viewer: { id, admin } | null }`, once per page: the flag first (off => nothing else is asked), then /api/me and the edge session.
 * A failed lookup is not remembered: the next caller asks again.
 */
export function loadModerator() {
  if (loading) return loading;
  const p = (async () => {
    let flags = {};
    try { flags = (await globalThis.HFYFeatureFlags?.resolveFlags?.()) ?? {}; } catch { flags = {}; }
    if (flags?.[FLAG] !== true) return { enabled: false, viewer: null };
    const [me, session] = await Promise.all([getMe(), getSession()]);
    // The session's sub is the author id on every post and comment; /api/me's id is the same principal and is the fallback.
    const id = session?.authenticated ? session.sub : (me?.id ?? null);
    return { enabled: true, viewer: { id, admin: canModerate(me) } };
  })();
  loading = p;
  p.catch(() => { if (loading === p) loading = null; });
  return p;
}
/** Drop the shared answer (tests). */
export function forgetModerator() { loading = null; }

/** `undefined` until known, then `{ enabled, viewer }`. */
export function useModerator() {
  const [state, setState] = useState(undefined);
  useEffect(() => {
    let live = true;
    loadModerator().then((s) => { if (live) setState(s); }, () => { if (live) setState({ enabled: false, viewer: null }); });
    return () => { live = false; };
  }, []);
  return state;
}

// ---- the control --------------------------------------------------------------------------------------------------------------------------

/**
 * The "moderate" button and its menu or bottom Sheet. `onAct(input)` sends the action (`{action, note?, hide?}`) and resolves when the server
 * accepted it; a rejection is shown in the panel with its DS line and the panel stays open. `photo` offers hide or unhide for one photo only
 * (a note is for a whole post or comment). `moderation` is the item's open moderation, which decides the rows.
 */
export function ModerateControl({ photo = false, moderation, onAct, name }) {
  const sheet = useMedia(SHEET_QUERY);
  const id = useId();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(null);
  const [note, setNote] = useState("");
  const [keep, setKeep] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [precheck, setPrecheck] = useState(null);
  const root = useRef(null);
  const trigger = useRef(null);
  const panel = useRef(null);
  const rows = menuItems({ photo, moderation });

  const close = useCallback((refocus = true) => {
    setOpen(false);
    setForm(null);
    setNote("");
    setError("");
    if (refocus) requestAnimationFrame(() => trigger.current?.focus());
  }, []);

  // The R-18 pre-check on the note, with the detector loaded the first time a form opens (it is not in the posts bundles otherwise).
  useEffect(() => {
    if (form === null || precheck) return;
    let live = true;
    import("./contact-precheck.js").then((m) => { if (live) setPrecheck(() => m.precheck); }, () => {});
    return () => { live = false; };
  }, [form, precheck]);

  // The Sheet is a native modal <dialog> (focus held inside, Escape and the backdrop come with it); the desktop menu is a plain popover.
  // Focus moves into the panel when it opens (the first row, or the note), and a click outside closes the desktop menu.
  useEffect(() => {
    if (!open) return undefined;
    const el = panel.current;
    if (sheet && el && typeof el.showModal === "function" && !el.open) el.showModal();
    (el?.querySelector(form ? "textarea" : "button"))?.focus();
    if (sheet) return undefined;
    const away = (e) => { if (root.current && !root.current.contains(e.target)) close(false); };
    document.addEventListener("pointerdown", away, true);
    return () => document.removeEventListener("pointerdown", away, true);
  }, [open, form, sheet, close]);

  const run = async (input) => {
    setBusy(true);
    setError("");
    try {
      await onAct(input);
      close();
    } catch (e) {
      setError(await errorLine(e));
    } finally {
      setBusy(false);
    }
  };

  const pick = (row) => {
    if (row.form) {
      setForm(row.form);
      setNote("");
      setKeep(hideDefault(row.form));
      setError("");
    } else run(row.input);
  };

  // Escape closes the menu (a modal <dialog> raises `cancel` instead, below) and gives focus back to the button.
  const onKeyDown = (e) => {
    if (e.key === "Escape" && !sheet) { e.preventDefault(); e.stopPropagation(); if (!busy) close(); }
  };

  const send = (e) => {
    e.preventDefault();
    if (busy || noteError(note) || precheck?.(note)) return;
    run({ action: form, note: note.trim(), hide: keep });
  };

  const hit = form && precheck ? precheck(note) : null;
  const bad = noteError(note);
  const label = photo ? COPY.triggerPhoto : COPY.trigger;
  return (
    <div className="hfy-mod" ref={root} data-hfy-moderate data-open={open ? "" : undefined}>
      <button type="button" className="hfy-btn hfy-btn--quiet hfy-mod__trigger" ref={trigger} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined}
        aria-label={name ? `${label}, ${name}` : undefined} onClick={() => (open ? close(false) : setOpen(true))}>{label}</button>
      {open && (() => {
        const Panel = sheet ? "dialog" : "div";
        const props = sheet
          ? { className: "hfy-mod__panel hfy-mod__sheet", "aria-label": COPY.menu, onCancel: (e) => { e.preventDefault(); if (!busy) close(); }, onClick: (e) => { if (e.target === e.currentTarget && !busy) close(); } }
          : { className: "hfy-mod__panel", role: "dialog", "aria-label": COPY.menu };
        return (
          <Panel {...props} id={id} ref={panel} data-variant={sheet ? "sheet" : "menu"} onKeyDown={onKeyDown}>
            <div className="hfy-mod__body">
              {sheet && <p className="hfy-mod__title" aria-hidden="true">{COPY.menu}</p>}
              {form === null ? (
                <ul className="hfy-mod__rows">
                  {rows.map((r) => <li key={r.id}><button type="button" className="hfy-mod__row" disabled={busy} data-row={r.id} onClick={() => pick(r)}>{r.label}</button></li>)}
                </ul>
              ) : (
                <form className="hfy-mod__form" onSubmit={send} data-hfy-ask={form} noValidate>
                  <label className="hfy-mod__field">
                    <span>{COPY.note}</span>
                    <textarea className="hfy-mod__note" rows={3} value={note} disabled={busy} required aria-required="true" aria-describedby={`${id}-count`} onChange={(e) => setNote(e.target.value)} />
                  </label>
                  <p className="hfy-mod__count" id={`${id}-count`} aria-live="polite" data-over={note.length > NOTE_MAX ? "" : undefined}>{note.length}/{NOTE_MAX}</p>
                  {hit && <p className="hfy-mod__hint" role="status" data-hfy-guard>{hit.message}</p>}
                  <label className="hfy-mod__check">
                    <input type="checkbox" checked={keep} disabled={busy || form === "request_changes"} onChange={(e) => setKeep(e.target.checked)} />
                    <span>{COPY.keepHidden}</span>
                  </label>
                  <div className="hfy-mod__actions">
                    <button type="submit" className="hfy-btn hfy-btn--primary" disabled={busy || bad !== null || hit !== null}>{busy ? COPY.sending : COPY.send}</button>
                    <button type="button" className="hfy-btn" disabled={busy} onClick={() => { setForm(null); setError(""); }}>{COPY.cancel}</button>
                  </div>
                </form>
              )}
              {error && <p className="hfy-mod__error" role="alert" data-hfy-mod-error>{error}</p>}
            </div>
          </Panel>
        );
      })()}
    </div>
  );
}

// ---- what the item shows --------------------------------------------------------------------------------------------------------------------

/**
 * The moderation line under a post. Admin: a "hidden" badge (or "question open"), the note, a one-tap "unhide". Author: a neutral status banner
 * (role=status, not an alert) with the note, what editing does, and an "edit" button. Anyone else, and an unmoderated post: nothing.
 */
export function PostNotice({ moderation, own, admin, canEdit, onUnhide, onEdit, busy }) {
  const parts = noticeParts(moderation, { own });
  if (!parts || (!own && !admin)) return null;
  const by = parts.by ? <PersonName id={parts.by.id} name={parts.by.label} /> : null;
  if (own) {
    // A plain hide stays hidden when the author edits (social.md 11.2), so it shows the line and no "edit"; only a note (changes or a question) invites one.
    const text = parts.asked ? <>{by} {COPY.askedTemplate} {parts.note}{parts.editToShow ? <> — {COPY.editToShow}</> : null}</> : parts.hidden ? COPY.hiddenByModerator : null;
    if (text === null) return null;
    return (
      <div className="hfy-mod__notice" data-hfy-mod-notice="author">
        <p className="hfy-mod__banner" role="status" data-hfy-mod-banner>{text}</p>
        {canEdit && parts.asked && <button type="button" className="hfy-btn hfy-btn--quiet hfy-mod__edit" data-hfy-mod-edit onClick={onEdit}>{COPY.edit}</button>}
      </div>
    );
  }
  return (
    <div className="hfy-mod__notice" data-hfy-mod-notice="admin" data-state={parts.state}>
      <span className="hfy-mod__badge" data-hfy-mod-badge>{parts.hidden ? COPY.badgeHidden : COPY.badgeAsked}</span>
      {parts.asked && <p className="hfy-mod__asked">{by} {COPY.askedTemplate} {parts.note}</p>}
      <button type="button" className="hfy-btn hfy-btn--quiet hfy-mod__unhide" data-hfy-mod-unhide disabled={busy} onClick={onUnhide}>{parts.hidden ? COPY.unhide : COPY.close}</button>
    </div>
  );
}

/** The author's inline editor for a moderated post: the body in a 16 px box, save and cancel. Saving an effective edit makes the post visible again. */
export function PostEditForm({ post, onSave, onCancel }) {
  const id = useId();
  const box = useRef(null);
  const [body, setBody] = useState(post.body ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [precheck, setPrecheck] = useState(null);
  useEffect(() => { box.current?.focus(); }, []);
  useEffect(() => {
    let live = true;
    import("./contact-precheck.js").then((m) => { if (live) setPrecheck(() => m.precheck); }, () => {});
    return () => { live = false; };
  }, []);
  const hit = precheck ? precheck(body) : null;
  const keepsPhotos = Array.isArray(post.attachments) && post.attachments.length > 0;
  const empty = body.trim() === "" && !keepsPhotos;
  const submit = async (e) => {
    e.preventDefault();
    if (busy || hit || empty) return;
    setBusy(true);
    setError("");
    try {
      await onSave(body);
    } catch (err) {
      setError(await errorLine(err));
      setBusy(false);
    }
  };
  return (
    <form className="hfy-mod__edit-form" onSubmit={submit} onKeyDown={(e) => { if (e.key === "Escape" && !busy) { e.preventDefault(); onCancel(); } }} data-hfy-mod-edit-form noValidate>
      <label className="hfy-mod__field" htmlFor={id}><span>{COPY.editBody}</span></label>
      <textarea id={id} ref={box} className="hfy-mod__note" rows={4} value={body} disabled={busy} onChange={(e) => setBody(e.target.value)} />
      {hit && <p className="hfy-mod__hint" role="status" data-hfy-guard>{hit.message}</p>}
      {error && <p className="hfy-mod__error" role="alert">{error}</p>}
      <div className="hfy-mod__actions">
        <button type="submit" className="hfy-btn hfy-btn--primary" disabled={busy || Boolean(hit) || empty}>{busy ? COPY.saving : COPY.save}</button>
        <button type="button" className="hfy-btn" disabled={busy} onClick={onCancel}>{COPY.cancel}</button>
      </div>
    </form>
  );
}

// ---- photos of a post --------------------------------------------------------------------------------------------------------------------

/**
 * One mount point inside each photo of a post card, for the admin's per-photo control. The kit draws the photos (`ul.iok-content-media > li`,
 * in attachment order after it drops unsafe urls) and has no slot under a photo, so a container is appended to each `li` and the control is
 * portalled into it. Kit gap, for the kit backlog: a PostCard `renderAttachmentActions(post, attachment)` as @io-kit/comments has; then
 * delete this and render the control there.
 * Returns `[{ attachment, host }]` for the photos that can be moderated (an upload path names them).
 */
export function usePhotoSlots(ref, post, enabled) {
  const [slots, setSlots] = useState([]);
  const attachments = post.attachments;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!enabled || !el) { setSlots([]); return undefined; }
    const shown = (Array.isArray(attachments) ? attachments : []).map((a) => ({ a, src: safeUrl(a.url) })).filter((x) => x.src !== "");
    const sync = () => {
      // Each photo is matched to its attachment by the url the kit drew (the <img src>, the <a href> of a file), never by position, so a photo
      // the kit dropped or reordered cannot hand its control to another. A url that repeats is matched in order.
      const left = [...shown];
      const next = [];
      el.querySelectorAll(".iok-content-media > li").forEach((li) => {
        const drawn = li.querySelector("img")?.getAttribute("src") ?? li.querySelector("a")?.getAttribute("href");
        const at = left.findIndex((x) => x.src === drawn);
        if (at < 0) return;
        const [{ a }] = left.splice(at, 1);
        if (!postPhotoId(a)) return;
        let host = li.querySelector(":scope > .hfy-mod__photo");
        if (!host) {
          host = document.createElement("div");
          host.className = "hfy-mod__photo";
          host.setAttribute("data-hfy-mod-photo", "");
          li.append(host);
        }
        next.push({ attachment: a, host });
      });
      setSlots((prev) => (prev.length === next.length && prev.every((p, i) => p.host === next[i].host && p.attachment === next[i].attachment) ? prev : next));
    };
    sync();
    const mo = new MutationObserver(sync);
    mo.observe(el, { subtree: true, childList: true });
    return () => mo.disconnect();
  }, [ref, enabled, attachments]);
  return slots;
}

/** The portalled per-photo controls. `act(attachment, input)` sends the action for that photo. */
export function PhotoControls({ slots, act }) {
  return slots.map(({ attachment, host }) => createPortal(
    <ModerateControl key={postPhotoId(attachment)} photo moderation={attachment.moderation?.hidden === true ? { state: "hidden", hidden: true } : undefined} onAct={(input) => act(attachment, input)} />,
    host,
    postPhotoId(attachment),
  ));
}
