// The related pages of a record, as links to their editors (HFY-TSK-157, editor-other-records): event to place, citation to source to repository,
// and the notes, citations, events and people around a record. Pure links: nothing is saved here, and a link the viewer cannot see is absent.
import { useMemo } from "react";
import { RECORD_COPY, drillLinks } from "./editor-records.js";

export function DrillLinks({ cls, bundle, lookups }) {
  const groups = useMemo(() => drillLinks(cls, bundle, lookups), [cls, bundle, lookups]);
  if (!groups.length) return <p className="hfy-editor__soon" data-hfy-drill-empty>{RECORD_COPY.linksNone}</p>;
  return (
    <div className="hfy-drill" data-hfy-drill>
      {groups.map((g) => (
        <div key={g.id} className="hfy-drill__group" data-hfy-drill-group={g.id} role="group" aria-label={g.label}>
          <h3 className="hfy-editor__h3">{g.label}</h3>
          <ul className="hfy-drill__list">
            {g.items.map((it, i) => (
              <li key={`${it.href}:${i}`}>
                <a href={it.href} data-hfy-drill-link={it.cls.toLowerCase()}>{it.title}</a>
                {it.detail ? <span className="hfy-row__detail">{it.detail}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
