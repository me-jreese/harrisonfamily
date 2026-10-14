// "pages you follow" on /me/notifications/ (HFY-TSK-186, flag recordSubsV1; social.md section 6). My follows newest first, ten at a time with
// "show more"; each name is a link to the page (ruling P2-R46, PersonName) and each row has a 44px "unfollow". Names come from the family
// manifest (people-corpus personNames); a name that cannot be resolved reads "a page". Shows nothing when the flag is off here, or when the
// routes answer 404 (flag off at the API).
import { useCallback, useEffect, useState } from "react";
import { PersonName } from "./person-name.jsx";
import { FOLLOW_COPY, PAGE_SIZE, listFollows, unfollow } from "./follow.js";
import { personNames } from "./people-corpus.js";

export function FollowedPages({ list = listFollows, remove = unfollow, names = personNames }) {
  const [rows, setRows] = useState(null); // null = loading
  const [cursor, setCursor] = useState(null);
  const [labels, setLabels] = useState(new Map());
  const [error, setError] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState(() => new Set()); // ids with an unfollow in flight

  const load = useCallback(async (after) => {
    setBusy(true);
    try {
      const page = await list({ cursor: after || undefined, limit: PAGE_SIZE });
      setRows((cur) => (after && cur ? [...cur, ...page.items.filter((i) => !cur.some((c) => c.id === i.id))] : page.items));
      setCursor(page.cursor);
      setError(false);
    } catch (e) {
      if (e && e.status === 404) setHidden(true);
      else { setError(true); setRows((cur) => cur || []); }
    } finally {
      setBusy(false);
    }
  }, [list]);
  useEffect(() => { load(null); }, [load]);
  useEffect(() => {
    let live = true;
    names().then((m) => { if (live) setLabels(m); }, () => {});
    return () => { live = false; };
  }, [names]);

  const onUnfollow = async (id) => {
    if (removing.has(id)) return;
    setError(false);
    setRemoving((cur) => new Set(cur).add(id));
    try {
      await remove(id);
      setRows((cur) => (cur || []).filter((r) => r.id !== id));
    } catch (e) {
      // A 404 on DELETE means it is already gone: drop the row and say nothing.
      if (e && e.status === 404) setRows((cur) => (cur || []).filter((r) => r.id !== id));
      else setError(true);
    } finally {
      setRemoving((cur) => { const n = new Set(cur); n.delete(id); return n; });
    }
  };

  if (hidden) return null;
  return (
    <section className="hfy-followed" aria-labelledby="hfy-followed-title" aria-busy={rows === null} data-hfy-followed>
      <h2 className="hfy-followed__title" id="hfy-followed-title">{FOLLOW_COPY.listTitle}</h2>
      {error && <p className="hfy-followed__banner" role="alert" data-hfy-banner>{FOLLOW_COPY.listFailed}</p>}
      {rows && rows.length === 0 && !error && <p className="hfy-followed__empty">{FOLLOW_COPY.empty}</p>}
      {rows && rows.length > 0 && (
        <ul className="hfy-followed__list">
          {rows.map((r) => {
            const name = labels.get(r.id) || FOLLOW_COPY.unknownPage;
            return (
              <li className="hfy-followed__row" key={r.id}>
                <PersonName id={r.id} name={name} className="hfy-followed__name" />
                <button type="button" className="hfy-followed__unfollow" aria-label={`${FOLLOW_COPY.unfollow} ${name}${labels.get(r.id) ? "" : ` ${r.id}`}`} disabled={removing.has(r.id)} onClick={() => onUnfollow(r.id)}>{FOLLOW_COPY.unfollow}</button>
              </li>
            );
          })}
        </ul>
      )}
      {cursor && <button type="button" className="hfy-followed__more" disabled={busy} onClick={() => load(cursor)}>{FOLLOW_COPY.showMore}</button>}
    </section>
  );
}
