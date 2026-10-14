// The person editor's list sections, UI half (HFY-TSK-156; editing.md section 9.1: "sub-items open inline as an expandable panel").
// One <ListEditor> per list: the rows the record has (each with change and remove), the rows the member adds, and, for photos, the order.
// A row's form is its own SchemaForm built from the adapter's schema (editor-sections.js), with the editor's host widgets; the member's
// changes are the list's draft, plain JSON, kept by the editor so the save flow can turn them into EditOps. Nothing is saved here.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SchemaForm } from "@io-kit/schema_form";
import { ModeBadge } from "./editor-badge.jsx";
import { EDITOR_WIDGETS, FormCtx } from "./editor-widgets.jsx";
import { LIST_ADAPTERS, SECTION_COPY, normalizeListDraft, photoOrder, sameValue } from "./editor-sections.js";

const editable = (code) => code === "direct" || code === "proposal";

/** One row's form. Mounted when the row's panel opens; the draft keeps the values when it closes. */
function ItemForm({ adapter, listId, bundle, schemas, lookups, viewer, resolver, rowKey, initial, isNew, onValues, env }) {
  const [live, setLive] = useState(initial);
  const contract = useMemo(() => ({
    surface: "hfy", action: `edit.${listId}`, title: SECTION_COPY.listLabel[listId], inputSchema: adapter.schema({ bundle, schemas, lookups, viewer, values: initial, isNew }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    schemaSource: "declared", schemaHash: "", requiresGovernanceHash: false, dryRun: false, trust: "first-party"
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the schema is built once, from the values the form opened with: a changing schema would reset the form
  }), [rowKey]);
  const blank = useMemo(() => adapter.blank(bundle), [adapter, bundle]);
  const ctx = useMemo(() => ({ live, initial, viewer, lookups, ...env }), [live, initial, viewer, lookups, env]);
  // The form reports only the fields it holds, and leaves out an empty one: a field it holds that is missing from its arguments was cleared (it
  // takes the blank), and a field it does not hold (the person of a connection already made) keeps the value the row opened with.
  const held = useMemo(() => Object.keys((contract.inputSchema && contract.inputSchema.properties) || {}), [contract]);
  const onValueChange = useCallback((args) => {
    const a = args && typeof args === "object" ? args : {};
    const values = { ...initial };
    for (const k of held) values[k] = a[k] !== undefined ? a[k] : blank[k];
    setLive(values);
    onValues(rowKey, values);
  }, [blank, held, initial, onValues, rowKey]);
  const codeOf = (pointer) => {
    const field = String(pointer).split("/")[1];
    const [cls, ptr] = adapter.policy(field, live);
    return resolver.resolve(cls, ptr, viewer, { lenient: true });
  };
  if (!contract.inputSchema) return null;
  return (
    <FormCtx.Provider value={ctx}>
      <div onSubmit={(e) => e.preventDefault()}>
        <SchemaForm
          contract={contract} initialValues={initial} idPrefix={`hfy-${listId}-${rowKey}`.replace(/[^A-Za-z0-9_-]/g, "_")} submitLabel="save" widgets={EDITOR_WIDGETS}
          onValueChange={onValueChange} fieldPolicy={(p) => (editable(codeOf(p)) ? "show" : "readonly")}
          fieldAdornment={(p) => <ModeBadge code={codeOf(p)} />}
        />
      </div>
    </FormCtx.Provider>
  );
}

const nextTid = (added) => `n${1 + added.reduce((m, a) => Math.max(m, Number(String(a.tid).slice(1)) || 0), 0)}`;

/**
 * The editor of one list. `draft` is the list's draft (editor-sections.js), `onChange(next)` hands back the whole next draft.
 * `env` is { searchPeople, resolvePerson } for the person picker.
 */
export function ListEditor({ sectionId, listId, bundle, schemas, lookups, viewer, resolver, draft, onChange, env }) {
  const adapter = LIST_ADAPTERS[listId];
  const d = normalizeListDraft(draft);
  const rows = useMemo(() => adapter.rows(bundle, lookups), [adapter, bundle, lookups]);
  const [openKey, setOpenKey] = useState(null);
  const panelRef = useRef(null);
  const never = SECTION_COPY.never[listId];
  const draftRef = useRef(d);
  draftRef.current = d;
  const setDraft = useCallback((fn) => { const next = fn(draftRef.current); draftRef.current = next; onChange(next); }, [onChange]);

  // A panel that has just opened takes focus in its first control.
  useEffect(() => {
    if (!openKey || !panelRef.current) return undefined;
    const frame = requestAnimationFrame(() => { const el = panelRef.current && panelRef.current.querySelector("input:not([type=hidden]),select,textarea"); if (el) el.focus(); });
    return () => cancelAnimationFrame(frame);
  }, [openKey]);

  const rowByKey = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows]);
  const onValues = useCallback((key, values) => {
    setDraft((cur) => {
      if (key.startsWith("new:")) {
        const tid = key.slice(4);
        return { ...cur, added: cur.added.map((a) => (a.tid === tid ? { ...a, values } : a)) };
      }
      const row = rowByKey.get(key);
      const edits = { ...cur.edits };
      if (row && sameValue(values, { ...adapter.blank(bundle), ...row.values })) delete edits[key];
      else edits[key] = values;
      return { ...cur, edits };
    });
  }, [setDraft, rowByKey, adapter, bundle]);

  const toggle = (key) => setOpenKey((k) => (k === key ? null : key));
  const add = () => {
    const tid = nextTid(draftRef.current.added);
    setDraft((cur) => ({ ...cur, added: [...cur.added, { tid, values: adapter.blank(bundle) }] }));
    setOpenKey(`new:${tid}`);
  };
  const discard = (tid) => {
    setDraft((cur) => ({ ...cur, added: cur.added.filter((a) => a.tid !== tid) }));
    setOpenKey((k) => (k === `new:${tid}` ? null : k));
  };
  const flipRemoved = (id) => {
    setDraft((cur) => ({ ...cur, removed: cur.removed.includes(id) ? cur.removed.filter((x) => x !== id) : [...cur.removed, id] }));
    setOpenKey((k) => (k === id ? null : k));
  };

  const formProps = { adapter, listId, bundle, schemas, lookups, viewer, resolver, onValues, env };
  const name = SECTION_COPY.listLabel[listId];
  const idBase = `hfy-list-${sectionId}-${listId}`.replace(/[^A-Za-z0-9_-]/g, "_");

  if (listId === "photos") {
    const order = photoOrder(rows, d);
    const byId = new Map(rows.map((r) => [r.id, r]));
    const move = (id, to) => setDraft((cur) => {
      const list = photoOrder(rows, cur);
      const from = list.indexOf(id);
      const next = list.slice();
      next.splice(from, 1);
      next.splice(Math.max(0, Math.min(next.length, to)), 0, id);
      return { ...cur, order: sameValue(next, rows.map((r) => r.id)) ? null : next };
    });
    return (
      <div className="hfy-list" role="group" data-hfy-list={listId} aria-label={name}>
        <p className="hfy-list__note">{SECTION_COPY.photoHint}</p>
        {order.length === 0 && <p className="hfy-list__empty">{SECTION_COPY.none}</p>}
        <ol className="hfy-rows" id={idBase}>
          {order.map((id, i) => {
            const r = byId.get(id);
            const gone = d.removed.includes(id);
            return (
              <li key={id} className="hfy-row" data-hfy-row={id} data-state={gone ? "removed" : ""}>
                <div className="hfy-row__main">
                  <span className="hfy-row__title">{r.title}</span>
                  {i === 0 && !gone && <span className="hfy-chip" data-hfy-chip="main">{SECTION_COPY.primaryTag}</span>}
                  {gone && <span className="hfy-chip" data-hfy-chip="removed">{SECTION_COPY.removedTag}</span>}
                </div>
                <div className="hfy-row__actions">
                  {i > 0 && !gone && <button type="button" onClick={() => move(id, 0)} aria-label={`${SECTION_COPY.makeMain} ${r.title}`} data-hfy-main>{SECTION_COPY.makeMain}</button>}
                  {i > 0 && !gone && <button type="button" onClick={() => move(id, i - 1)} aria-label={`${SECTION_COPY.up} ${r.title}`} data-hfy-up>{SECTION_COPY.up}</button>}
                  {i < order.length - 1 && !gone && <button type="button" onClick={() => move(id, i + 1)} aria-label={`${SECTION_COPY.down} ${r.title}`} data-hfy-down>{SECTION_COPY.down}</button>}
                  <button type="button" onClick={() => flipRemoved(id)} aria-label={`${gone ? SECTION_COPY.keep : SECTION_COPY.remove} ${r.title}`} data-hfy-remove>{gone ? SECTION_COPY.keep : SECTION_COPY.remove}</button>
                </div>
              </li>
            );
          })}
        </ol>
      </div>
    );
  }

  const panel = (key, initial, isNew) => (
    <div className="hfy-row__panel" ref={panelRef} data-hfy-panel={key}>
      <ItemForm {...formProps} rowKey={key} initial={initial} isNew={isNew} />
      <button type="button" className="hfy-row__done" onClick={() => setOpenKey(null)} data-hfy-done>{SECTION_COPY.done}</button>
    </div>
  );

  return (
    <div className="hfy-list" role="group" data-hfy-list={listId} aria-label={name}>
      {never ? <p className="hfy-list__note" data-hfy-never={listId}>{never}</p> : null}
      {rows.length === 0 && d.added.length === 0 && <p className="hfy-list__empty">{SECTION_COPY.none}</p>}
      <ul className="hfy-rows" id={idBase}>
        {rows.map((r) => {
          const gone = d.removed.includes(r.id);
          const edited = Object.hasOwn(d.edits, r.id);
          const open = openKey === r.id;
          return (
            <li key={r.id} className="hfy-row" data-hfy-row={r.id} data-state={gone ? "removed" : edited ? "edited" : ""}>
              <div className="hfy-row__main">
                <span className="hfy-row__title">{r.title}</span>
                {r.detail ? <span className="hfy-row__detail">{r.detail}</span> : null}
                {edited && !gone && <span className="hfy-chip" data-hfy-chip="edited">{SECTION_COPY.editedTag}</span>}
                {gone && <span className="hfy-chip" data-hfy-chip="removed">{SECTION_COPY.removedTag}</span>}
              </div>
              <div className="hfy-row__actions">
                {!gone && <button type="button" onClick={() => toggle(r.id)} aria-expanded={open} aria-label={`${SECTION_COPY.edit} ${r.title}`} data-hfy-edit>{SECTION_COPY.edit}</button>}
                <button type="button" onClick={() => flipRemoved(r.id)} aria-label={`${gone ? SECTION_COPY.keep : SECTION_COPY.remove} ${r.title}`} data-hfy-remove>{gone ? SECTION_COPY.keep : SECTION_COPY.remove}</button>
              </div>
              {open && !gone && panel(r.id, { ...adapter.blank(bundle), ...(d.edits[r.id] || r.values) }, false)}
            </li>
          );
        })}
        {d.added.map((a) => {
          const key = `new:${a.tid}`;
          const open = openKey === key;
          const title = `${SECTION_COPY.newTag} ${SECTION_COPY.fallbackTitle[listId] || ""}`.trim();
          return (
            <li key={key} className="hfy-row" data-hfy-row={key} data-state="new">
              <div className="hfy-row__main">
                <span className="hfy-row__title">{title}</span>
                <span className="hfy-chip" data-hfy-chip="new">{SECTION_COPY.newTag}</span>
              </div>
              <div className="hfy-row__actions">
                <button type="button" onClick={() => toggle(key)} aria-expanded={open} aria-label={`${SECTION_COPY.edit} ${title}`} data-hfy-edit>{SECTION_COPY.edit}</button>
                <button type="button" onClick={() => discard(a.tid)} aria-label={`${SECTION_COPY.discard} ${title}`} data-hfy-discard>{SECTION_COPY.discard}</button>
              </div>
              {open && panel(key, { ...adapter.blank(bundle), ...a.values }, true)}
            </li>
          );
        })}
      </ul>
      <button type="button" className="hfy-list__add" onClick={add} data-hfy-add={listId}>{SECTION_COPY.addLabel[listId]}</button>
    </div>
  );
}
