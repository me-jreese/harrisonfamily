// The lazy lifelines chunk of /tree/ (HFY-TSK-269, viz-v2-time, flag familyVizTime; viz ADR 4.3, BRD2 R-22). Our own SVG, no d3-scale: the model
// (lifelines-model.js) places every year as a percentage of the lane, and each row is a button whose lane is an <svg> of straight lines.
//
// Each lifeline is a button named "<name>, <years in words>" (the fade and the dot are never the only cue). Choosing one calls `onPick(id)`: the
// page opens the navigator (the cards view) on that person. The "+N more in <name>'s family" button calls `onRecentre(id)`: the lifelines stay and
// show that person's family. Person names here are plain text by design (a link cannot sit inside a button); the navigator the button opens
// carries the PersonName links (P2-R46), as the cards do. Decades only: no era band renders (viz-v2-time-eras, Q2-14).
import { useMemo } from "react";
import { buildLifelines, fadeWidth, xOf } from "./lifelines-model.js";
import { yearsLabel } from "./tree-data.js";

export const COPY = {
  caption: "by decade. a faded end means the date is only about right.",
  noDates: "no dates are recorded for this family yet.",
  more: (n, name) => `+${n} more in ${name}'s family`
};

const pct = (n) => `${n.toFixed(2)}%`;

/** The line of one mark as solid core plus three stepped fades at each uncertain end. */
function Mark({ axis, mark }) {
  const s = xOf(axis, mark.start);
  if (mark.kind === "dot") {
    return <circle className={`hfy-life__dot${mark.fuzzy ? " hfy-life__dot--hollow" : ""}`} cx={pct(s)} cy="50%" r={5} data-life-mark="dot" />;
  }
  const e = xOf(axis, mark.end);
  const f = mark.fuzzy ? fadeWidth(axis, mark) : 0;
  const fe = mark.fuzzy && !mark.ongoing ? f : 0;
  const seg = (a, b, cls, key) => <line key={key} className={`hfy-life__seg${cls ? ` hfy-life__seg--${cls}` : ""}`} x1={pct(a)} x2={pct(b)} y1="50%" y2="50%" />;
  const out = [seg(s + f, e - fe, "", "core")];
  for (let k = 0; k < 3 && f > 0; k += 1) out.push(seg(s + (f * k) / 3, s + (f * (k + 1)) / 3, `fade${k}`, `s${k}`));
  for (let k = 0; k < 3 && fe > 0; k += 1) out.push(seg(e - (fe * (k + 1)) / 3, e - (fe * k) / 3, `fade${k}`, `e${k}`));
  return <g data-life-mark="line" data-life-fuzzy={mark.fuzzy ? "true" : undefined} data-life-ongoing={mark.ongoing ? "true" : undefined}>{out}</g>;
}

function Lane({ model, index, row }) {
  const { axis, unions } = model;
  if (!axis) return <svg className="hfy-life__lane" aria-hidden="true" focusable="false" />;
  return (
    <svg className="hfy-life__lane" aria-hidden="true" focusable="false">
      {axis.ticks.filter((t) => t.label).map((t) => <line key={t.year} className="hfy-life__grid" x1={pct(xOf(axis, t.year))} x2={pct(xOf(axis, t.year))} y1="0" y2="100%" />)}
      {unions.filter((u) => index >= u.from && index <= u.to).map((u) => {
        const x = pct(xOf(axis, u.year));
        return (
          <g key={u.key} data-life-union={u.key}>
            <line className="hfy-life__union" x1={x} x2={x} y1={index === u.from ? "50%" : "0"} y2={index === u.to ? "50%" : "100%"} />
            {u.kids.includes(index) && row.mark.kind !== "none" && row.mark.start > u.year ? <line className="hfy-life__elbow" x1={x} x2={pct(xOf(axis, row.mark.start))} y1="50%" y2="50%" /> : null}
            {u.nodes.includes(index) ? <circle className="hfy-life__node" cx={x} cy="50%" r={4} data-life-node={u.key} /> : null}
          </g>
        );
      })}
      {row.mark.kind !== "none" ? <Mark axis={axis} mark={row.mark} /> : null}
    </svg>
  );
}

export default function Lifelines({ graph, focus, onPick, onRecentre }) {
  const model = useMemo(() => buildLifelines(graph, focus), [graph, focus]);
  const { axis, rows } = model;
  const yearsOfUnion = (index) => model.unions.filter((u) => u.nodes.includes(index)).map((u) => u.year);
  return (
    <section className="hfy-life" aria-label="lifelines" data-tree-lifelines={focus} data-life-lines={model.lineCount}>
      <p className="hfy-life__caption">{COPY.caption}</p>
      {axis ? (
        <div className="hfy-life__head" aria-hidden="true">
          <svg className="hfy-life__axis" focusable="false">
            {axis.ticks.map((t) => (
              <g key={t.year}>
                <line className="hfy-life__tick" x1={pct(xOf(axis, t.year))} x2={pct(xOf(axis, t.year))} y1="0" y2={t.label ? "35%" : "20%"} />
                {t.label ? <text className="hfy-life__tick-label" x={pct(xOf(axis, t.year))} y="45%">{t.label}</text> : null}
              </g>
            ))}
          </svg>
        </div>
      ) : <p className="hfy-life__note">{COPY.noDates}</p>}
      <ul className="hfy-life__list">
        {rows.map((r, i) => {
          if (r.type === "more") {
            return (
              <li key={`more-${r.id}`} className="hfy-life__more-row">
                <button type="button" className="hfy-life__more" data-lifeline-more={r.id} onClick={() => onRecentre(r.id)}>{COPY.more(r.count, r.name)}</button>
              </li>
            );
          }
          const years = yearsLabel(r.person);
          const meets = yearsOfUnion(i).map((y) => `, family from about ${y}`).join("");
          return (
            <li key={r.id} className="hfy-life__row" data-depth={Math.min(r.depth, 4)}>
              <button type="button" className="hfy-life__line" data-lifeline={r.id} aria-label={`${r.name}, ${years}${meets}`} onClick={() => onPick(r.id)}>
                <span className="hfy-life__who">
                  <span className="hfy-life__name">{r.name}</span>
                  <span className="hfy-life__years">{years}</span>
                </span>
                <Lane model={model} index={i} row={r} />
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
