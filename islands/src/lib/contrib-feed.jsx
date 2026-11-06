// The contributions column of the person page (HFY-TSK-189, flag contribV1; social.md section 8, R-26, R-27). It fills the host that
// lib/person-social.jsx owns (#hfy-person-contributions > [data-hfy-contrib-host]) and nothing else:
//   - the header total from contributions.stats ("42 contributions");
//   - contributions.list newest first, 10 a page, in a CappedSection ("show older contributions");
//   - a row is one link of at least 44 px: a kind glyph, a sentence and a time. The page's name inside the sentence is a PersonName link
//     (P2-R46), drawn above the row's stretched link, so no link nests in another;
//   - the owner sees their own hidden entries with a "hidden" tag; nobody else is shown one (lib/contrib-model.js rowsFor);
//   - loading is skeleton rows, an error is a banner with a retry, and an empty feed says "no contributions yet." (with "add a photo" on
//     your own page).
import "../posts.css"; // the island primitives (.hfy-btn, .hfy-banner, .hfy-skeleton)
import "../contrib.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CappedSection } from "./capped.jsx";
import { PersonName } from "./person-name.jsx";
import { personNames } from "./people-corpus.js";
import { getMe } from "./me.js";
import { formatTime, fullTime } from "./time.js";
import { readPage, readStats } from "./contrib-api.js";
import { COPY, MAX_EMPTY_PAGES, countCopy, rowsFor, totalOf } from "./contrib-model.js";

export function ContribRow({ row }) {
  const named = row.person !== null;
  return (
    <li className="hfy-contrib__row" data-hfy-contrib-row data-kind={row.kind}>
      <span className="hfy-contrib__glyph" data-glyph={row.glyph} aria-hidden="true" />
      <span className="hfy-contrib__main">
        <span className="hfy-contrib__sentence">
          <a className="hfy-contrib__link" href={row.href} {...(named ? { "aria-label": row.text } : {})}>{row.lead}</a>
          {named && <><PersonName id={row.person.id} name={row.person.name} className="hfy-contrib__name" />{row.tail}</>}
        </span>
        {row.at && <time className="hfy-contrib__time" dateTime={row.at} title={fullTime(row.at)}>{formatTime(row.at)}</time>}
      </span>
      {row.hidden && <span className="hfy-contrib__tag" data-hfy-contrib-hidden>{COPY.hidden}</span>}
    </li>
  );
}

const authError = (e) => e && (e.status === 401 || e.status === 403);

export function ContributionsFeed({ personId }) {
  // phase: loading | ready | error | signedOut
  const [view, setView] = useState({ phase: "loading", items: [], cursor: null });
  const [more, setMore] = useState({ loading: false, failed: false });
  const [names, setNames] = useState(() => new Map());
  const [me, setMe] = useState(null);
  const [total, setTotal] = useState(null);
  const [attempt, setAttempt] = useState(0);
  const live = useRef(true);
  const cursorRef = useRef(null);
  useEffect(() => () => { live.current = false; }, []);

  useEffect(() => {
    let current = true;
    getMe().then((m) => { if (current) setMe(m); });
    personNames().then((m) => { if (current) setNames(m); }, () => { /* the names fall back to "a family page" */ });
    return () => { current = false; };
  }, []);

  useEffect(() => {
    let current = true;
    setView({ phase: "loading", items: [], cursor: null });
    readStats(personId).then((s) => { if (current) setTotal(totalOf(s)); }, () => { /* no total in the header; the chip is silent too */ });
    (async () => {
      try {
        // A first page of nothing but entries the viewer is not shown asks on, a few pages at most.
        let page = await readPage(personId);
        let items = page.items;
        for (let n = 0; n < MAX_EMPTY_PAGES && page.cursor && !items.some((i) => i && i.hidden !== true); n += 1) {
          page = await readPage(personId, { cursor: page.cursor });
          items = items.concat(page.items);
        }
        if (current) { cursorRef.current = page.cursor; setView({ phase: "ready", items, cursor: page.cursor }); }
      } catch (e) {
        if (current) setView({ phase: authError(e) ? "signedOut" : "error", items: [], cursor: null });
      }
    })();
    return () => { current = false; };
  }, [personId, attempt]);

  const loadMore = useCallback(async () => {
    const cursor = cursorRef.current;
    if (!cursor) return;
    setMore({ loading: true, failed: false });
    try {
      const page = await readPage(personId, { cursor });
      if (!live.current) return;
      cursorRef.current = page.cursor;
      setView((v) => {
        const seen = new Set(v.items.map((i) => i && i.id));
        return { ...v, items: v.items.concat(page.items.filter((i) => i && !seen.has(i.id))), cursor: page.cursor };
      });
      setMore({ loading: false, failed: false });
    } catch {
      if (live.current) setMore({ loading: false, failed: true });
    }
  }, [personId]);

  const owner = Boolean(me && me.id && me.id === personId);
  const rows = useMemo(() => rowsFor(view.items, { names, ownerId: personId, ownerView: owner }), [view.items, names, personId, owner]);

  return (
    <>
      {total !== null && <p className="hfy-social__total" data-hfy-contrib-total>{countCopy(total)}</p>}
      {view.phase === "loading" && (
        <div className="hfy-contrib__skeleton" role="status" aria-busy="true" aria-label={COPY.loading}>
          <span className="hfy-skeleton" /><span className="hfy-skeleton" /><span className="hfy-skeleton" />
        </div>
      )}
      {view.phase === "error" && (
        <div className="hfy-banner hfy-contrib__banner" role="alert" data-hfy-banner>
          <p>{COPY.failed}</p>
          <button type="button" className="hfy-btn" onClick={() => setAttempt((n) => n + 1)}>{COPY.retry}</button>
        </div>
      )}
      {view.phase === "signedOut" && <p className="hfy-social__empty" role="status" data-hfy-signed-out>{COPY.signedOut}</p>}
      {view.phase === "ready" && rows.length === 0 && !view.cursor && (
        <div className="hfy-contrib__empty" data-hfy-empty>
          <p className="hfy-social__empty">{COPY.empty}</p>
          {owner && <a className="hfy-btn hfy-btn--primary" href="#share" data-hfy-contrib-add>{COPY.addPhoto}</a>}
        </div>
      )}
      {view.phase === "ready" && (rows.length > 0 || view.cursor) && (
        <CappedSection label={COPY.older} clipSelector=".hfy-contrib__list" itemSelector=":scope > li" hasMore={Boolean(view.cursor)} loading={more.loading} onMore={loadMore}>
          <ul className="hfy-contrib__list" aria-label={COPY.heading}>
            {rows.map((row) => <ContribRow key={row.id} row={row} />)}
          </ul>
          {more.failed && (
            <p className="hfy-banner hfy-contrib__banner" role="alert" data-hfy-banner>{COPY.failed}</p>
          )}
        </CappedSection>
      )}
    </>
  );
}
