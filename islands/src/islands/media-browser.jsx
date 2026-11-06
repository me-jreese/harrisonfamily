// The All media page and the media detail page (HFY-TSK-388-0B, flag mediaBrowserV1; BRD HFY-PLN-004 D-31 to D-34, D-37, D-39, D-40; boards B2 and B3). One
// island on the static /all-media/ page: with no `id` in the address it renders the kit's MediaBrowserPage (sections, filter chips, grid, cursor pagination; the
// section and filter live in the address), with `?id=<gramps_id>` the kit's MediaDetail. Both read through the browse adapter (lib/hfy-media-browse.js).
// The detail slots: renderTagList is the accessible list of the tagged people (every tagged person, living or deceased, is named and linked, P4-R37), renderEditor hosts
// the kit tag editor (lib/media-tag-editor-host.jsx, flag photoTagEdit; D-40, swapped in HFY-TSK-388-0G), renderOverlay the kit overlay and renderComments is an empty host for the comment thread
// (`[data-slot="media-comments"]`, subject media:<gramps_id>), which MediaCommentsHost (lib/media-comments-host.jsx, flag mediaCommentsV1, HFY-TSK-389-0A) fills with the kit comments thread. The page needs a signed-in member
// (the routes are member-only); a visitor gets a sign-in line. /all-media/ is not in the main menu (D-31): the shell keeps "posts" as the current item.
import "@io-kit/media/tokens.css";
import "@io-kit/media/browser.css";
import "./media-browser.css";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { DEFAULT_LABELS, MediaBrowserPage, MediaDetail, detailContextFromSearch, detailHrefIn, mediaIdFromSearch } from "@io-kit/media/browser";
import { createHfyMediaBrowse } from "../lib/hfy-media-browse.js";
import { memberSub, useEdgeSession } from "../lib/edge-session.js";
import { mountIsland } from "../lib/mount.jsx";
import { TagOverlay } from "@io-kit/media/tags";
import { MediaTagEditorHost } from "../lib/media-tag-editor-host.jsx";
import { MediaCommentsHost } from "../lib/media-comments-host.jsx";

const POSTS = "/posts/";
// P4-R33: the page lives at /all-media/ because /media/ is a private data prefix (HFYAppendIndex and the data gate). The kit builds its page links on a
// hard-coded /media/ (detail-url.ts, util.ts), so every address it hands out is moved to this base here.
const BASE = "/all-media/";
const rebase = (href) => href.replace(/^\/media\/(?=\?|$)/, BASE);
const detailHref = (id, view) => rebase(detailHrefIn(id, view));
const POST_HREF = (id) => `${POSTS}?id=${encodeURIComponent(id)}`;
const PERSON_HREF = (id) => `/person/?id=${encodeURIComponent(id)}`;
const LABELS = { position: (n, total) => (n > 0 && total > 0 ? DEFAULT_LABELS.position(n, total) : "") };
const signIn = () => `/auth/login?returnTo=${encodeURIComponent(`${location.pathname}${location.search}`)}`;

// The boxes on the photo: the kit overlay (HFY-TSK-388-0G, the D-40 swap). It reads the same tags as the list and never looks at where a tag came from (V-1);
// a proposal is dashed with "pending review". The list below stays the main accessible form.
function KitOverlay({ detail }) {
  const name = (id) => detail.tags.find((t) => t.personId === id)?.person.displayName ?? "family member";
  const aspect = (detail.card.width || 4) / (detail.card.height || 3);
  // HFY-TSK-404: the stage is as wide as the photo's own aspect allows at 70dvh (media-browser.css reads --io-media-aspect), so the boxes' percentages are the photo's, not a letterbox's.
  const mark = useRef(null);
  useLayoutEffect(() => {
    const stage = mark.current?.closest(".io-media-stage");
    stage?.style.setProperty("--io-media-aspect", String(aspect));
    return () => stage?.style.removeProperty("--io-media-aspect");
  }, [aspect]);
  return (
    <>
      <span ref={mark} hidden />
      <TagOverlay tags={detail.tags} names={name} aspect={aspect} />
    </>
  );
}

// The kit's detail page draws the "who's in this photo" heading and names the region with it, so this is only the list (HFY-TSK-404: it drew a second heading).
function TagList({ detail }) {
  const tags = detail.tags;
  return (
    <div className="hfy-mb-people" data-media-people>
      {tags.length === 0 ? <p className="hfy-mb-people__none">{DEFAULT_LABELS.noTags}</p> : (
        <ul className="hfy-mb-people__list">
          {tags.map((t) => (
            <li key={`${t.personId}:${t.index}`} className="hfy-mb-people__item" data-pending={t.state === "pending-proposal" ? "" : undefined}>
              <a className="hfy-mb-people__name" href={PERSON_HREF(t.personId)}>{t.person.displayName}</a>
              {t.state === "pending-proposal" && <span className="hfy-mb-people__pending"> · pending review</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// "view full size" (HFY-TSK-404): the kit's link goes to the raw original, which in the installed app (no browser bar) has no way back. The click is taken here and the
// original opens in a full-screen viewer inside the page: a dialog, a visible "close" button, Esc, and the system back (one history entry that keeps the same address).
// The link keeps its href, so a new-tab or modified click and a page without scripts still reach the image.
function FullSizeViewer({ src, alt, onClose }) {
  const close = useRef(null);
  useEffect(() => {
    close.current?.focus();
    const html = document.documentElement;
    const before = html.style.overflow;
    html.style.overflow = "hidden";
    return () => { html.style.overflow = before; };
  }, []);
  const onKeyDown = (e) => {
    if (e.key === "Escape") { e.preventDefault(); onClose(); }
    else if (e.key === "Tab") { e.preventDefault(); close.current?.focus(); }
  };
  return createPortal(
    <div className="hfy-full" role="dialog" aria-modal="true" aria-label="full size photo" onKeyDown={onKeyDown} data-hfy-full>
      <img className="hfy-full__img" src={src} alt={alt} />
      <button ref={close} type="button" className="io-media-btn hfy-full__close" onClick={onClose}>close</button>
    </div>,
    document.body,
  );
}

// The detail page: the host owns navigation (onNavigate), so the pushed address is the /all-media/ one, and the kit's hard-coded /media/ crumb is moved by an effect.
function DetailHost({ initialId, children }) {
  const root = useRef(null);
  const [nav, setNav] = useState(() => ({ id: initialId, ctx: detailContextFromSearch(location.search) }));
  const [full, setFull] = useState(null);
  const fullRef = useRef(null);
  fullRef.current = full;
  useEffect(() => {
    const on = () => {
      if (fullRef.current) { setFull(null); return; }
      const id = mediaIdFromSearch(location.search);
      if (id) setNav({ id, ctx: detailContextFromSearch(location.search) });
    };
    window.addEventListener("popstate", on);
    return () => window.removeEventListener("popstate", on);
  }, []);
  useEffect(() => {
    root.current?.querySelectorAll('a[href^="/media/"]').forEach((a) => { const h = a.getAttribute("href"); if (rebase(h) !== h) a.setAttribute("href", rebase(h)); });
  });
  // Behind the dialog the page is inert; once it is back, focus returns to the link that opened the viewer.
  const opener = useRef(null);
  useEffect(() => {
    if (full) { root.current?.setAttribute("inert", ""); return; }
    root.current?.removeAttribute("inert");
    if (opener.current) { const link = opener.current; opener.current = null; if (link.isConnected) link.focus(); }
  }, [full]);
  const onNavigate = (id, href) => { history.pushState(null, "", rebase(href)); setNav({ id, ctx: detailContextFromSearch(location.search) }); };
  const openFull = (e) => {
    const link = e.target instanceof Element ? e.target.closest(".io-media-detail-full a") : null;
    if (!link || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    history.pushState({ hfyFull: true }, "", location.href);
    const alt = root.current?.querySelector(".io-media-stage-img")?.getAttribute("alt") || "";
    opener.current = link;
    setFull({ src: link.getAttribute("href"), alt });
  };
  // Close from the button or Esc: step back over the entry the open pushed, and the popstate above closes it (one path for all three ways out).
  const closeFull = () => { if (history.state?.hfyFull) history.back(); else setFull(null); };
  return (
    <>
      <div ref={root} onClick={openFull}>{children({ id: nav.id, ctx: nav.ctx, onNavigate })}</div>
      {full && <FullSizeViewer src={full.src} alt={full.alt} onClose={closeFull} />}
    </>
  );
}

function MediaBrowser() {
  const session = useEdgeSession();
  const source = useMemo(() => createHfyMediaBrowse(), []);
  const [photoTagEdit, setPhotoTagEdit] = useState(false);
  const [mediaComments, setMediaComments] = useState(false);
  const id = mediaIdFromSearch(location.search);
  useEffect(() => {
    document.querySelectorAll("[data-media-off]").forEach((n) => n.remove());
    window.HFYFeatureFlags?.resolveFlags?.().then((f) => { setPhotoTagEdit(f && f.photoTagEdit === true); setMediaComments(f && f.mediaCommentsV1 === true); }, () => {});
  }, []);
  if (session === undefined) return <p className="hfy-mb-note" role="status" data-media-wait>{DEFAULT_LABELS.looking}</p>;
  if (!memberSub(session)) return <p className="hfy-mb-note" data-media-signin><a href={signIn()}>sign in</a> to see the family photos.</p>;
  if (id) {
    return (
      <DetailHost initialId={id}>
        {(h) => (
          <MediaDetail
            source={source} mediaId={h.id} context={h.ctx} onNavigate={h.onNavigate} postsHref={POSTS} postHref={POST_HREF} personHref={PERSON_HREF} labels={LABELS}
            renderOverlaySwitch={() => null}
            renderOverlay={(p) => <KitOverlay detail={p.detail} />}
            renderTagList={(p) => <TagList detail={p.detail} />}
            renderEditor={(p) => <MediaTagEditorHost detail={p.detail} reload={p.reload} enabled={photoTagEdit} />}
            renderComments={(p) => <MediaCommentsHost subject={p.subject} enabled={mediaComments} />}
          />
        )}
      </DetailHost>
    );
  }
  return <MediaBrowserPage source={source} postsHref={POSTS} hrefFor={detailHref} />;
}

mountIsland("media-browser", MediaBrowser);
