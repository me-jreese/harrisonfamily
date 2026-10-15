// /edit/: the record editor shell (HFY-TSK-212, flag recordEdit; HFY-PLN-002 editing.md section 9.1, BRD2 R-08 and R-09). The frame every later
// editing task fills: the route (`?cls=person&id=<gramps id>`), the edit bundle from GET /api/edit/:cls/:ref, the section framework (a sticky
// index from 64rem, an accordion under it) and a mode badge on every field, drawn through the kit's `fieldAdornment` hook: "saves now",
// "goes to review", or "only an admin can change this", from the policy table in the bundle. The person sections (HFY-TSK-156) are live: the names
// form, and a list editor each for also-known-as names, life events, facts, notes, the photo order, people connected and sources
// (lib/editor-lists.jsx, lib/editor-sections.js); the links, family and more sections are still frames. The other record classes (HFY-TSK-157) are one record form and a list of related pages each (lib/editor-records.js, lib/editor-drill.jsx). Saving is the save flow (HFY-TSK-213, lib/editor-save-ui.jsx): the forms report their values, a sticky bar counts the
// changes, "review" opens the dry-run confirmation sheet, and the kit's own submit button stays hidden in the CSS.
// The page loads this bundle only with recordEdit (feature-flags.js), so flag off the page keeps its "not available yet" note.
import "./editor.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SchemaForm } from "@io-kit/schema_form";
import { api } from "../lib/api.js";
import { getMe } from "../lib/me.js";
import { memberSub, useEdgeSession } from "../lib/edge-session.js";
import { PersonName } from "../lib/person-name.jsx";
import { ModeBadge } from "../lib/editor-badge.jsx";
import { mountIsland } from "../lib/mount.jsx";
import {
  COPY, createModeResolver, fieldPointer, introFor, parseRoute, sectionSchema, sectionValues, sectionsFor
} from "../lib/editor-model.js";
import { replayDrafts } from "../lib/editor-save.js";
import { ConfirmSheet, SaveDock, useCounts, useSaveFlow } from "../lib/editor-save-ui.jsx";
import { EDITOR_WIDGETS, FormCtx } from "../lib/editor-widgets.jsx";
import { ListEditor } from "../lib/editor-lists.jsx";
import { DrillLinks } from "../lib/editor-drill.jsx";
import { recordNotes, recordPolicy, recordTitle } from "../lib/editor-records.js";
import { draftKey, makeLookups, pendingChip } from "../lib/editor-sections.js";
import { suggestPeople } from "../lib/people-corpus.js";
import { canDelete, COPY as DELETE_COPY } from "../lib/admin-delete.js";
import { DeletePanel } from "../lib/admin-delete-ui.jsx";
import { useFlags } from "../lib/use-flags.js";

export { ModeBadge };
// `fresh`: a step-up (a destructive change needs a sign-in no older than 15 minutes), so the sign-in page asks again instead of reusing the session.
export const signInHref = (fresh = false) => `/auth/login?${fresh ? "prompt=login&" : ""}returnTo=${encodeURIComponent(`${location.pathname}${location.search}`)}`;

/** The record's display name for the heading; "" when it has none. */
export function nameOf(obj) {
  const n = obj && typeof obj.primary_name === "object" && obj.primary_name ? obj.primary_name : {};
  const surname = (Array.isArray(n.surname_list) ? n.surname_list : []).map((s) => (s && typeof s.surname === "string" ? s.surname : "")).filter(Boolean).join(" ");
  return [n.first_name, surname].filter((x) => typeof x === "string" && x).join(" ");
}

function SectionForm({ section, schema, bundle, cls, resolver, viewer, seed, onDraft, lookups, env }) {
  // The record's values, or the member's own values replayed over a refetched record (the save flow's conflict path).
  const initialValues = useMemo(() => seed || sectionValues(bundle.obj, section.form), [bundle, section, seed]);
  const input = useMemo(() => sectionSchema(schema, section.form, lookups, initialValues), [schema, section, lookups, initialValues]);
  const [live, setLive] = useState(initialValues);
  const onValueChange = useCallback((args) => { setLive(args || {}); onDraft(section.id, args); }, [onDraft, section.id]);
  const ctx = useMemo(() => ({ live, initial: initialValues, viewer, lookups, ...env }), [live, initialValues, viewer, lookups, env]);
  const pendingPaths = useMemo(() => new Set((bundle.pending || []).flatMap((p) => p.paths || [])), [bundle]);
  const contract = useMemo(() => input && ({
    surface: "hfy", action: `edit.${section.id}`, title: section.title, inputSchema: input,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    schemaSource: "declared", schemaHash: bundle.schemaHash || "", requiresGovernanceHash: false, dryRun: false, trust: "first-party"
  }), [input, section, bundle]);
  useEffect(() => {
    // A form section with no schema falls back to "coming soon"; say so, so a schema/API drift is not silent.
    if (!contract) console.warn(`[editor] no schema for section "${section.id}" (${cls}.${section.form.from}); showing the frame only`);
  }, [contract, section, cls]);
  if (!contract) return <p className="hfy-editor__soon">{COPY.soon}</p>;
  const pointerOf = (p) => fieldPointer(section.form, p);
  // A record form of another class judges each field at the pointer its adapter names (a birth's date, a tag, an enclosing place); the rest by the field's own.
  const codeOf = (p) => {
    if (section.form.record) {
      // A third element is a code the form already knows (a Place's code on a local place is never kept): it outranks the lenient table.
      const [c, ptr, fixed] = recordPolicy(section.form, String(p).split("/")[1], live, bundle.obj);
      return fixed || resolver.resolve(c, ptr, viewer, { lenient: true });
    }
    return resolver.resolve(cls, pointerOf(p), viewer);
  };
  const editable = (code) => code === "direct" || code === "proposal";
  // Enter in a field must not submit (a reload or a POST): the sticky bar's review button is the way to save.
  return (
    <FormCtx.Provider value={ctx}>
      <div onSubmit={(e) => e.preventDefault()}>
        <SchemaForm
          contract={contract}
          initialValues={initialValues}
          idPrefix={`hfy-${section.id}`}
          submitLabel="save"
          widgets={EDITOR_WIDGETS}
          onValueChange={onValueChange}
          fieldPolicy={(p) => (editable(codeOf(p)) ? "show" : "readonly")}
          fieldAdornment={(p) => (
            <>
              <ModeBadge code={codeOf(p)} />
              {pendingPaths.has(pointerOf(p)) && <span className="hfy-mode hfy-mode--pending" data-hfy-pending>{COPY.pendingField}</span>}
            </>
          )}
        />
        {section.form.record && recordNotes(section.form, bundle.obj, live).map((n) => (
          <p key={n.kind} className="hfy-editor__note" role={n.kind === "warning" ? "status" : undefined} data-hfy-style-note={n.kind}>{n.text}</p>
        ))}
      </div>
    </FormCtx.Provider>
  );
}

function Section({ section, open, onToggle, children }) {
  const hid = `hfy-sec-${section.id}-h`;
  const bid = `hfy-sec-${section.id}-b`;
  return (
    <section className="hfy-editor__section" id={`sec-${section.id}`} aria-labelledby={hid} data-section={section.id}>
      <h2 className="hfy-editor__h" id={hid}>
        <button type="button" className="hfy-editor__toggle" aria-expanded={open} aria-controls={bid} onClick={() => onToggle(section.id)}>
          <span>{section.title}</span>
          <svg className="hfy-editor__chev" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
      </h2>
      <div className="hfy-editor__body" id={bid} hidden={!open}>{children}</div>
    </section>
  );
}

const LIST_TITLE = { alt: "also known as" };
const DELETE_SECTION = Object.freeze({ id: "delete", title: DELETE_COPY.sectionTitle });

const wide = () => typeof matchMedia === "function" && matchMedia("(min-width: 64rem)").matches;

function Editor({ route }) {
  const flags = useFlags();
  const [open, setOpen] = useState(null);
  const [isWide, setIsWide] = useState(wide());
  const [scrollTo, setScrollTo] = useState(null);
  useEffect(() => {
    if (typeof matchMedia !== "function") return undefined;
    const mq = matchMedia("(min-width: 64rem)");
    const on = () => setIsWide(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  // After a section opens from an index link, scroll to it (the browser's own jump hit the hidden body).
  useEffect(() => {
    if (!scrollTo) return;
    const el = document.getElementById(`sec-${scrollTo}`);
    if (el && typeof el.scrollIntoView === "function") el.scrollIntoView();
    setScrollTo(null);
  }, [scrollTo, open]);
  const [state, setState] = useState({ phase: "loading" });
  // The member's form values per section (the forms report them), the epoch that remounts the forms after a refetch, and the values a
  // remounted form starts from when the save flow replays the member's edits over a fresh bundle.
  const [drafts, setDrafts] = useState({});
  const [epoch, setEpoch] = useState(0);
  const [seed, setSeed] = useState(null);
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  const bundleRef = useRef(null);
  const onDraft = useCallback((id, args) => setDrafts((prev) => (JSON.stringify(prev[id]) === JSON.stringify(args) ? prev : { ...prev, [id]: args })), []);
  const fetchBundle = useCallback(() => api.get(`/edit/${route.cls}/${encodeURIComponent(route.ref)}`), [route.cls, route.ref]);
  useEffect(() => {
    let live = true;
    setState({ phase: "loading" });
    setOpen(null);
    setDrafts({});
    setSeed(null);
    (async () => {
      try {
        const bundle = await fetchBundle();
        const secs = sectionsFor(route.cls, bundle.viewer);
        const needsSchema = secs.some((s) => s.form);
        const schema = needsSchema ? (await api.get(`/edit/schema/${route.cls}`)).schema : null;
        // The list sections' choices come from the Event, Note and Citation schemas. They are only labels: one that does not load leaves the
        // choices to the values the record already holds, and the page still edits.
        const more = {};
        // A family lists its events by kind, so it also reads the Event schema for the words.
        if (secs.some((s) => (s.lists || []).length) || route.cls === "Family") {
          await Promise.all((route.cls === "Family" ? ["Event"] : ["Event", "Note", "Citation"]).map(async (c) => { try { more[c] = (await api.get(`/edit/schema/${c}`)).schema; } catch { /* labels only */ } }));
        }
        if (live) setState({ phase: "ready", bundle, schema, schemas: { ...more, [route.cls]: schema } });
      } catch (e) {
        if (!live) return;
        if (e && e.status === 401) setState({ phase: "signedOut" });
        else if (e && e.status === 404) setState({ phase: "notFound" });
        else setState({ phase: "failed" });
      }
    })();
    return () => { live = false; };
  }, [route.cls, route.ref, fetchBundle]);
  // A refetched bundle replaces the page's: the forms remount (a new epoch). When the member's edits are to be replayed (a 409), the forms start
  // from the fresh record with only the member's changed fields laid over it, and those are the drafts the ops are rebuilt from.
  const sectionsRef = useRef([]);
  const schemasRef = useRef({});
  const adopt = useCallback((bundle, keepDrafts, settled, settledUnits) => {
    const old = bundleRef.current;
    const next = keepDrafts && old ? replayDrafts({ sections: sectionsRef.current, oldBundle: old, freshBundle: bundle, drafts: draftsRef.current, settled, settledUnits, schemas: schemasRef.current }) : null;
    bundleRef.current = bundle;
    draftsRef.current = next || {};
    setState((cur) => ({ ...cur, bundle }));
    setSeed(next);
    setDrafts(next || {});
    setEpoch((n) => n + 1);
  }, []);

  const bundle = state.bundle;
  bundleRef.current = bundle || null;
  const viewer = useMemo(() => bundle && ({ admin: bundle.viewer && bundle.viewer.admin === true, relation: bundle.relation === "own" ? "own" : "other" }), [bundle]);
  const resolver = useMemo(() => createModeResolver(bundle && bundle.policy), [bundle]);
  const sections = useMemo(() => (viewer ? sectionsFor(route.cls, viewer) : []), [viewer, route.cls]);
  sectionsRef.current = sections;
  // An admin with adminDelete gets a last card to delete the page (Q2-15). It is not a form section: it makes no ops, so the save flow never sees it.
  const showDelete = canDelete({ cls: route.cls, viewer, flags });
  schemasRef.current = state.schemas || {};
  const lookups = useMemo(() => makeLookups(bundle || {}, state.schemas || {}), [bundle, state.schemas]);
  // The person picker searches the family index (suggestPeople, free text disallowed); a pick is turned into the person's handle by the records API.
  const env = useMemo(() => ({
    searchPeople: async (q) => (await suggestPeople(q)).map((r) => ({ id: r.id, label: r.title, status: r.subtitle })),
    resolvePerson: async (grampsId) => {
      const r = await api.get(`/records/Person/by-id/${encodeURIComponent(grampsId)}`);
      return r && typeof r.handle === "string" ? { handle: r.handle } : null;
    }
  }), []);
  const counts = useCounts({ bundle, sections, drafts, resolver, cls: route.cls, viewer });
  const flow = useSaveFlow({ sections, viewer, getBundle: () => bundleRef.current, getDrafts: () => draftsRef.current, refetch: fetchBundle, adopt });
  const openSet = open || new Set(isWide ? [...sections, ...(showDelete ? [DELETE_SECTION] : [])].map((s) => s.id) : sections.slice(0, 1).map((s) => s.id));
  const toggle = (id) => { const next = new Set(openSet); if (next.has(id)) next.delete(id); else next.add(id); setOpen(next); };
  const reveal = (id) => { if (!openSet.has(id)) setOpen(new Set([...openSet, id])); setScrollTo(id); };

  if (state.phase === "loading") return <div className="hfy-editor__skeleton" role="status" aria-label={COPY.loading} />;
  if (state.phase === "signedOut") return <SignInGate />;
  if (state.phase === "notFound") return <p className="hfy-editor__note" role="status">{COPY.notFound}</p>;
  if (state.phase === "failed") return <p className="hfy-editor__note" role="status">{COPY.loadFailed}</p>;

  const chip = pendingChip(bundle.pending);
  const gid = bundle.obj && typeof bundle.obj.gramps_id === "string" ? bundle.obj.gramps_id : route.ref;
  const name = route.cls === "Person" ? nameOf(bundle.obj) : "";
  const title = route.cls === "Person" ? "" : recordTitle(route.cls, bundle.obj, lookups);
  return (
    <div className="hfy-editor__layout" data-hfy-editor-ready data-relation={viewer.relation} data-admin={viewer.admin ? "true" : "false"}>
      <div className="hfy-editor__lead">
        <p className="hfy-editor__subject">
          {route.cls === "Person" ? <PersonName id={gid} name={name || gid} /> : <span data-hfy-subject>{route.cls.toLowerCase()}{title ? `: ${title}` : ""}</span>}
        </p>
        <p className="hfy-editor__intro" data-hfy-intro>{introFor(viewer)}</p>
        {chip && <p className="hfy-editor__chip" role="status" data-hfy-pending-chip>{chip.text}</p>}
        {route.cls === "Person" && <a className="hfy-editor__back" href={`/person/?id=${encodeURIComponent(gid)}`}>{COPY.back}</a>}
        {route.cls !== "Person" && <button type="button" className="hfy-editor__back" onClick={() => history.back()} data-hfy-back>{COPY.backPrev}</button>}
      </div>
      <nav className="hfy-editor__index" aria-label={COPY.sections}>
        <ol>
          {[...sections, ...(showDelete ? [DELETE_SECTION] : [])].map((s) => <li key={s.id}><a href={`#sec-${s.id}`} onClick={() => reveal(s.id)}>{s.title}</a></li>)}
        </ol>
      </nav>
      <div className="hfy-editor__cards">
        {sections.map((s) => (
          <Section key={s.id} section={s} open={openSet.has(s.id)} onToggle={toggle}>
            {s.form && <SectionForm key={`${s.id}:${epoch}`} section={s} schema={state.schema} bundle={bundle} cls={route.cls} resolver={resolver} viewer={viewer} seed={seed && seed[s.id]} onDraft={onDraft} lookups={lookups} env={env} />}
            {(s.lists || []).map((id) => (
              <div key={`${id}:${epoch}`} className="hfy-editor__list">
                {(s.form || s.lists.length > 1) && <h3 className="hfy-editor__h3">{LIST_TITLE[id]}</h3>}
                <ListEditor
                  sectionId={s.id} listId={id} bundle={bundle} schemas={state.schemas || {}} lookups={lookups} viewer={viewer} resolver={resolver} env={env}
                  draft={drafts[draftKey(s.id, id)]} onChange={(next) => onDraft(draftKey(s.id, id), next)}
                />
              </div>
            ))}
            {s.drill && <DrillLinks cls={route.cls} bundle={bundle} lookups={lookups} />}
            {!s.form && !s.drill && !(s.lists || []).length && <p className="hfy-editor__soon">{COPY.soon}</p>}
          </Section>
        ))}
        {showDelete && (
          <Section section={DELETE_SECTION} open={openSet.has(DELETE_SECTION.id)} onToggle={toggle}>
            <DeletePanel cls={route.cls} bundle={bundle} signInHref={signInHref} />
          </Section>
        )}
      </div>
      <SaveDock flow={flow} counts={counts} />
      <ConfirmSheet flow={flow} signInHref={signInHref} />
    </div>
  );
}

function SignInGate() {
  return (
    <div className="hfy-editor__gate" role="status" data-hfy-gate>
      <p>{COPY.signedOut}</p>
      <a className="hfy-editor__signin" href={signInHref()}>{COPY.signIn}</a>
    </div>
  );
}

function EditorPage() {
  const session = useEdgeSession();
  const sub = memberSub(session);
  const route = useMemo(() => parseRoute(location.search), []);
  const [me, setMe] = useState(undefined);
  useEffect(() => {
    if (!sub) return undefined;
    let live = true;
    getMe().then((m) => { if (live) setMe(m); });
    return () => { live = false; };
  }, [sub]);
  const skeleton = <div className="hfy-editor__skeleton" role="status" aria-label={COPY.loading} />;
  let body;
  if (session === undefined) body = skeleton;
  else if (!sub) body = <SignInGate />;
  else if (me === undefined) body = skeleton;
  else if (me.editing === false) body = <p className="hfy-editor__note" role="status">{COPY.off}</p>;
  else if (!route) body = <p className="hfy-editor__note" role="status">{COPY.noRoute}</p>;
  else body = <Editor route={route} />;
  return <div className="hfy-editor" aria-busy={body === skeleton}>{body}</div>;
}

const off = document.querySelector("[data-editor-off]");
if (off) off.remove();
mountIsland("editor", EditorPage);
