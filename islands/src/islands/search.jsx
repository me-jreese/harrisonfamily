// /search with @io-kit/search 1.0.1 + search-ui 1.0.10, local tier only (HFY-TSK-065, BRD D-09). Mounted by the searchV2 loader.
// DS components/Search: "people" in display serif, `looking…` (never a false 0) while the index loads, errors in the banner only,
// `find someone.` / `nothing for "{q}".` states, skeleton rows under the controls.
import "@io-kit/search-ui/theme.css";
import "@io-kit/search-ui/components.css";
import "./search.css";
import { createContext, useContext, useMemo, useState } from "react";
import { createMemoryCorpusStorage, useCorpusIndex } from "@io-kit/search/corpus";
import { CollectionSearch } from "@io-kit/search-ui";
import { cloudscapeUi, useColorMode } from "@io-kit/search-ui/cloudscape";
import { mountAt } from "../lib/mount.jsx";
import { SEARCH_COPY, peopleSource, peopleProperties, filterTokensFromParams } from "../lib/people-corpus.js";

// Cloudscape's half of the theme is static: search.css imports `hfy:cloudscape-theme`, which islands/build.mjs generates at build time
// from lib/cloudscape-theme.js (Cloudscape generateThemeStylesheet over var(--io-search-*) values). Kit root cause and upstream there.

// Memory storage on purpose: signed-session person data must not persist in IndexedDB after sign-out.
const storage = createMemoryCorpusStorage();

// The contract's CollectionHeader / ZeroResults / EmptyState props carry no corpus-pending, error or query text, so the island's
// overrides read them from context. The ui object is module-level so the component identities never change (no remounts).
const PLACEHOLDER = "a first name, a town, or a year";
const SearchState = createContext({ pending: false, error: null, q: "" });
const tokenText = (query) => query.tokens.map((t) => (Array.isArray(t.value) ? t.value.join("–") : String(t.value ?? ""))).filter(Boolean).join(" ");

function Header({ title, count, refining, actions, toggle, level = 2 }) {
  const { pending, error } = useContext(SearchState);
  const H = `h${level}`;
  return (
    <header className="io-search-header">
      <div className="io-search-header__lead">
        <H className="io-search-header__title">{title}</H>
        {error ? null : (
          <span className="io-search-header__count" data-hfy-count>
            {pending || refining ? "looking…" : count === undefined ? "" : `${count.toLocaleString("en-US")} ${count === 1 ? "person" : "people"}`}
          </span>
        )}
        {toggle ?? null}
      </div>
      {actions ? <div className="io-search-header__actions">{actions}</div> : null}
    </header>
  );
}

function Zero({ onClear }) {
  const { error, q } = useContext(SearchState);
  if (error) return null; // errors are banners, never empty states
  return (
    <div className="io-search-zero" role="status">
      <p className="io-search-zero__title">{q ? `nothing for "${q}".` : "nothing found."}</p>
      <p className="io-search-zero__text">try a first name, or a town.</p>
      <button type="button" className="io-search__button io-search__button--touch" onClick={onClear}>clear filters</button>
    </div>
  );
}

function Empty() {
  const { error } = useContext(SearchState);
  if (error) return null;
  return (
    <div className="io-search-zero io-search-empty" role="status">
      <p className="io-search-zero__title">find someone.</p>
      <p className="io-search-zero__text">a first name, a town, or a year.</p>
    </div>
  );
}

// The filter sheet's editor FilterInput gets no placeholder from CollectionSearch (@io-kit/search-ui 1.0.10 passes one to the row-1 input
// only), so it fell back to the kit's English "Filter by text, property or value". The wrapper gives it the house line. Module-level, so
// the component identity never changes (no remounts). Kit follow-up: a labels / i18n prop on CollectionSearch.
const FilterInput = (p) => <cloudscapeUi.FilterInput {...p} placeholder={p.placeholder ?? PLACEHOLDER} />;

const UI = { ...cloudscapeUi, CollectionHeader: Header, ZeroResults: Zero, EmptyState: Empty, FilterInput };
// The engine's relevance order (no sort spec), relabelled in the house style.
const SORTS = [{ id: "relevance", label: "best match" }];

function Skeleton() {
  return (
    <div className="hfy-search__skeleton" role="status" aria-busy="true" aria-label="loading the family index">
      {[0, 1, 2, 3].map((i) => <div key={i} className="hfy-search__skel-row" />)}
    </div>
  );
}

function Row({ row }) {
  const f = row.fields;
  // DS (theme QA before / after): "living" is a text.dim word after the lifespan, "b. 1975 · living".
  const meta = f.living ? `${f.lifespan ? `${f.lifespan} · ` : ""}living` : f.lifespan;
  return (
    <a className="hfy-search__row" href={`/person/?id=${encodeURIComponent(row.id)}`}>
      {f.photo ? <img className="hfy-search__photo" src={f.photo} alt="" /> : <span className="hfy-search__photo hfy-search__photo--none" aria-hidden="true">{(f.given || row.title || "").trim().charAt(0)}</span>}
      <span className="hfy-search__body">
        <span className="hfy-search__name">{row.title}</span>
        {meta ? <span className="hfy-search__meta">{meta}</span> : null}
      </span>
    </a>
  );
}

function SearchApp() {
  useColorMode("dark"); // what the Cloudscape CollectionSearch wrapper does; the base one is used for the ui overrides
  const params = new URLSearchParams(window.location.search);
  const q0 = (params.get("q") || params.get("query") || "").trim();
  const [query, setQuery] = useState(() => ({ operation: "and", tokens: [...(q0 ? [{ operator: ":", value: q0 }] : []), ...filterTokensFromParams(params)] }));
  const idx = useCorpusIndex(peopleSource, { storage, retryDelaysMs: [1000], pollMs: 0 });
  const pending = idx.status === "seeding" || (idx.status === "warm" && idx.rows.length === 0);
  const error = idx.status === "error" ? idx.error || SEARCH_COPY.failed : null;
  const ctx = useMemo(() => ({ pending, error, q: tokenText(query) }), [pending, error, query]);
  return (
    <div className="hfy-search">
      <h1 className="hfy-search__title">search the family</h1>
      <SearchState.Provider value={ctx}>
        <CollectionSearch
          ui={UI} title="people" things="people" rows={idx.rows} properties={peopleProperties}
          query={query} onQueryChange={setQuery} corpusPending={pending} error={error}
          placeholder={PLACEHOLDER} autoFocus={params.get("focus") === "1"}
          controlsToggle={false} sortOptions={SORTS} renderRow={(row) => <Row row={row} />} pageSize={30} loadMore="button"
        />
      </SearchState.Provider>
      {pending && idx.rows.length === 0 && <Skeleton />}
    </div>
  );
}

// HFY-TSK-069 (D-11 item 7): mount in the page's own <main>, never the shell's scroller (which holds the install hint first).
const main = document.querySelector("main:not([data-io-scroller])") || document.body;
mountAt((h) => main.prepend(h), <SearchApp />, "hfy-search-v2");
