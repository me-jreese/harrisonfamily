// The All media page and the media detail page (HFY-TSK-388-0B, flag mediaBrowserV1; BRD HFY-PLN-004 D-31 to D-34, D-37, D-39, D-40; boards B2 and B3). One
// island on the static /media/ page: with no `id` in the address it renders the kit's MediaBrowserPage (sections, filter chips, grid, cursor pagination; the
// section and filter live in the address), with `?id=<gramps_id>` the kit's MediaDetail. Both read through the browse adapter (lib/hfy-media-browse.js).
// The detail slots: renderTagList is the accessible list of the tagged people (a living person is redacted by the server and not linked), renderEditor hosts
// the SHIPPED tag editor (lib/media-tag-editor-host.jsx, flag photoTagEdit; D-40) and renderComments is an empty host for the comment thread
// (`[data-slot="media-comments"]`, subject media:<gramps_id>), which task 389-0A fills with @io-kit/comments. The page needs a signed-in member
// (the routes are member-only); a visitor gets a sign-in line. /media/ is not in the main menu (D-31): the shell keeps "posts" as the current item.
import "@io-kit/media/tokens.css";
import "@io-kit/media/browser.css";
import "./media-browser.css";
import { useEffect, useMemo, useState } from "react";
import { DEFAULT_LABELS, MediaBrowserPage, MediaDetail, mediaIdFromSearch } from "@io-kit/media/browser";
import { createHfyMediaBrowse } from "../lib/hfy-media-browse.js";
import { memberSub, useEdgeSession } from "../lib/edge-session.js";
import { mountIsland } from "../lib/mount.jsx";
import { MediaTagEditorHost } from "../lib/media-tag-editor-host.jsx";

const POSTS = "/posts/";
const POST_HREF = (id) => `${POSTS}?id=${encodeURIComponent(id)}`;
const PERSON_HREF = (id) => `/person/?id=${encodeURIComponent(id)}`;
const LABELS = { position: (n, total) => (n > 0 && total > 0 ? DEFAULT_LABELS.position(n, total) : "") };
const signIn = () => `/auth/login?returnTo=${encodeURIComponent(`${location.pathname}${location.search}`)}`;

function TagList({ detail }) {
  const tags = detail.tags;
  return (
    <section className="hfy-mb-people" aria-labelledby="hfy-mb-people-h" data-media-people>
      <h2 id="hfy-mb-people-h" className="hfy-mb-people__h">{DEFAULT_LABELS.people}</h2>
      {tags.length === 0 ? <p className="hfy-mb-people__none">{DEFAULT_LABELS.noTags}</p> : (
        <ul className="hfy-mb-people__list">
          {tags.map((t) => (
            <li key={`${t.personId}:${t.index}`} className="hfy-mb-people__item" data-pending={t.state === "pending-proposal" ? "" : undefined}>
              {t.person.living ? <span className="hfy-mb-people__name">{t.person.displayName}</span> : <a className="hfy-mb-people__name" href={PERSON_HREF(t.personId)}>{t.person.displayName}</a>}
              {t.state === "pending-proposal" && <span className="hfy-mb-people__pending"> · pending review</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function MediaBrowser() {
  const session = useEdgeSession();
  const source = useMemo(() => createHfyMediaBrowse(), []);
  const [photoTagEdit, setPhotoTagEdit] = useState(false);
  const id = mediaIdFromSearch(location.search);
  useEffect(() => {
    document.querySelectorAll("[data-media-off]").forEach((n) => n.remove());
    window.HFYFeatureFlags?.resolveFlags?.().then((f) => setPhotoTagEdit(f && f.photoTagEdit === true), () => {});
  }, []);
  if (session === undefined) return <p className="hfy-mb-note" role="status" data-media-wait>{DEFAULT_LABELS.looking}</p>;
  if (!memberSub(session)) return <p className="hfy-mb-note" data-media-signin><a href={signIn()}>sign in</a> to see the family photos.</p>;
  if (id) {
    return (
      <MediaDetail
        source={source} mediaId={id} postsHref={POSTS} postHref={POST_HREF} personHref={PERSON_HREF} labels={LABELS}
        renderOverlaySwitch={() => null}
        renderTagList={(p) => <TagList detail={p.detail} />}
        renderEditor={(p) => <MediaTagEditorHost detail={p.detail} reload={p.reload} enabled={photoTagEdit} />}
        renderComments={(p) => <div data-slot="media-comments" data-subject={p.subject} />}
      />
    );
  }
  return <MediaBrowserPage source={source} postsHref={POSTS} />;
}

mountIsland("media-browser", MediaBrowser);
