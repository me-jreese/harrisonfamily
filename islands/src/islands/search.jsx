// /search with @io-kit/search 1.0.1 + search-ui 1.0.8, local tier only (HFY-TSK-065, BRD D-09). Mounted by the searchV2 loader.
import "@io-kit/search-ui/theme.css";
import "@io-kit/search-ui/components.css";
import "./search.css";
import { useMemo } from "react";
import { createMemoryCorpusStorage, useCorpusIndex } from "@io-kit/search/corpus";
import { CollectionSearch } from "@io-kit/search-ui/cloudscape";
import { mountAt } from "../lib/mount.jsx";
import { peopleSource, peopleProperties } from "../lib/people-corpus.js";

// Memory storage on purpose: signed-session person data must not persist in IndexedDB after sign-out.
const storage = createMemoryCorpusStorage();

function Skeleton() {
  return (
    <div className="hfy-search__skeleton" role="status" aria-busy="true" aria-label="Loading the family index">
      {[0, 1, 2, 3].map((i) => <div key={i} className="hfy-search__skel-row" />)}
    </div>
  );
}

function Row({ row }) {
  const f = row.fields;
  return (
    <a className="hfy-search__row" href={`/person/?id=${encodeURIComponent(row.id)}`}>
      {f.photo ? <img className="hfy-search__photo" src={f.photo} alt="" /> : <span className="hfy-search__photo hfy-search__photo--none" aria-hidden="true" />}
      <span className="hfy-search__body">
        <span className="hfy-search__name">{row.title}</span>
        <span className="hfy-search__meta">{f.living ? "Living" : "Deceased"}{f.lifespan ? ` · ${f.lifespan}` : ""}</span>
      </span>
    </a>
  );
}

function SearchApp() {
  const params = new URLSearchParams(window.location.search);
  const q = (params.get("q") || params.get("query") || "").trim();
  const defaultQuery = useMemo(() => ({ operation: "and", tokens: q ? [{ operator: ":", value: q }] : [] }), [q]);
  const idx = useCorpusIndex(peopleSource, { storage, retryDelaysMs: [1000], pollMs: 0 });
  const pending = idx.status === "seeding" || (idx.status === "warm" && idx.rows.length === 0);
  const error = idx.status === "error" ? idx.error || "Could not load the family index." : null;
  return (
    <div className="hfy-search">
      <h1 className="hfy-search__title">Search the Family Records</h1>
      {pending && idx.rows.length === 0 && <Skeleton />}
      <CollectionSearch
        title="People" things="people" rows={idx.rows} properties={peopleProperties}
        defaultQuery={defaultQuery} corpusPending={pending} error={error}
        placeholder="Name, surname, or year" autoFocus={params.get("focus") === "1"}
        renderRow={(row) => <Row row={row} />} pageSize={30} loadMore="button"
      />
    </div>
  );
}

const main = document.querySelector("main") || document.body;
mountAt((h) => main.prepend(h), <SearchApp />, "hfy-search-v2");
