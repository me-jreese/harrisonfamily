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
import { useEffect, useMemo, useRef, useState } from "react";
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
  return <TagOverlay tags={detail.tags} names={name} aspect={(detail.card.width || 4) / (detail.card.height || 3)} />;
}

function TagList({ detail }) {
  const tags = detail.tags;
  return (
    <section className="hfy-mb-people" aria-labelledby="hfy-mb-people-h" data-media-people>
      <h2 id="hfy-mb-people-h" className="hfy-mb-people__h">{DEFAULT_LABELS.people}</h2>
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
    </section>
  );
}

// The detail page: the host owns navigation (onNavigate), so the pushed address is the /all-media/ one, and the kit's hard-coded /media/ crumb is moved by an effect.
function DetailHost({ initialId, children }) {
  const root = useRef(null);
  const [nav, setNav] = useState(() => ({ id: initialId, ctx: detailContextFromSearch(location.search) }));
  useEffect(() => {
    const on = () => { const id = mediaIdFromSearch(location.search); if (id) setNav({ id, ctx: detailContextFromSearch(location.search) }); };
    window.addEventListener("popstate", on);
    return () => window.removeEventListener("popstate", on);
  }, []);
  useEffect(() => {
    root.current?.querySelectorAll('a[href^="/media/"]').forEach((a) => { const h = a.getAttribute("href"); if (rebase(h) !== h) a.setAttribute("href", rebase(h)); });
  });
  const onNavigate = (id, href) => { history.pushState(null, "", rebase(href)); setNav({ id, ctx: detailContextFromSearch(location.search) }); };
  return <div ref={root}>{children({ id: nav.id, ctx: nav.ctx, onNavigate })}</div>;
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
