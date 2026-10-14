// /edit/: the record editor shell (HFY-TSK-212, flag recordEdit; HFY-PLN-002 editing.md section 9.1, BRD2 R-08 and R-09). The frame every later
// editing task fills: the route (`?cls=person&id=<gramps id>`), the edit bundle from GET /api/edit/:cls/:ref, the section framework (a sticky
// index from 64rem, an accordion under it) and a mode badge on every field, drawn through the kit's `fieldAdornment` hook: "saves now",
// "goes to review", or "only an admin can change this", from the policy table in the bundle. The names section is a live SchemaForm; the
// other sections are frames. Saving is the save flow (HFY-TSK-213, lib/editor-save-ui.jsx): the forms report their values, a sticky bar counts the
// changes, "review" opens the dry-run confirmation sheet, and the kit's own submit button stays hidden in the CSS.
// The page loads this bundle only with recordEdit (feature-flags.js), so flag off the page keeps its "not available yet" note.
import "./editor.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SchemaForm } from "@io-kit/schema_form";
import { api } from "../lib/api.js";
import { getMe } from "../lib/me.js";
import { memberSub, useEdgeSession } from "../lib/edge-session.js";
import { PersonName } from "../lib/person-name.jsx";
import { mountIsland } from "../lib/mount.jsx";
import {
  COPY, badgeFor, createModeResolver, introFor, parseRoute, sectionSchema, sectionValues, sectionsFor
} from "../lib/editor-model.js";
import { replaySeed } from "../lib/editor-save.js";
import { ConfirmSheet, SaveDock, useCounts, useSaveFlow } from "../lib/editor-save-ui.jsx";

export const signInHref = () => `/auth/login?returnTo=${encodeURIComponent(`${location.pathname}${location.search}`)}`;

const ICONS = {
  direct: "M4 12.5l5 5L20 6.5",
  proposal: "M5 12h12m-5-6l6 6-6 6",
  admin: "M7 11V8a5 5 0 0110 0v3M6 11h12v9H6z",
  locked: "M7 11V8a5 5 0 0110 0v3M6 11h12v9H6z"
};

/** The mode badge: an icon and the words, never colour alone. */
export function ModeBadge({ code }) {
  const badge = badgeFor(code);
  return (
    <span className="hfy-mode" data-mode={badge.key} data-hfy-mode={badge.key}>
      <svg className="hfy-mode__icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d={ICONS[badge.key]} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
      <span>{badge.text}</span>
    </span>
  );
}

/** The record's display name for the heading; "" when it has none. */
export function nameOf(obj) {
  const n = obj && typeof obj.primary_name === "object" && obj.primary_name ? obj.primary_name : {};
  const surname = (Array.isArray(n.surname_list) ? n.surname_list : []).map((s) => (s && typeof s.surname === "string" ? s.surname : "")).filter(Boolean).join(" ");
  return [n.first_name, surname].filter((x) => typeof x === "string" && x).join(" ");
}

function SectionForm({ section, schema, bundle, cls, resolver, viewer, seed, onDraft }) {
  const input = useMemo(() => sectionSchema(schema, section.form), [schema, section]);
  // The record's values, or the member's own values replayed over a refetched record (the save flow's conflict path).
  const initialValues = useMemo(() => seed || sectionValues(bundle.obj, section.form), [bundle, section, seed]);
  const onValueChange = useCallback((args) => onDraft(section.id, args), [onDraft, section.id]);
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
  const pointerOf = (p) => `${section.form.prefix}${p}`;
  const codeOf = (p) => resolver.resolve(cls, pointerOf(p), viewer);
  const editable = (code) => code === "direct" || code === "proposal";
  // Enter in a field must not submit (a reload or a POST): the sticky bar's review button is the way to save.
  return (
    <div onSubmit={(e) => e.preventDefault()}>
    <SchemaForm
      contract={contract}
      initialValues={initialValues}
      idPrefix={`hfy-${section.id}`}
      submitLabel="save"
      onValueChange={onValueChange}
      fieldPolicy={(p) => (editable(codeOf(p)) ? "show" : "readonly")}
      fieldAdornment={(p) => (
        <>
          <ModeBadge code={codeOf(p)} />
          {pendingPaths.has(pointerOf(p)) && <span className="hfy-mode hfy-mode--pending" data-hfy-pending>{COPY.pendingField}</span>}
        </>
      )}
    />
    </div>
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

const wide = () => typeof matchMedia === "function" && matchMedia("(min-width: 64rem)").matches;

function Editor({ route }) {
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
        const needsSchema = sectionsFor(route.cls, bundle.viewer).some((s) => s.form);
        const schema = needsSchema ? (await api.get(`/edit/schema/${route.cls}`)).schema : null;
        if (live) setState({ phase: "ready", bundle, schema });
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
  const adopt = useCallback((bundle, keepDrafts) => {
    const old = bundleRef.current;
    const next = keepDrafts && old ? replaySeed({ sections: sectionsRef.current, key: bundle.key, oldObj: old.obj, freshObj: bundle.obj, drafts: draftsRef.current }) : null;
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
  const counts = useCounts({ bundle, sections, drafts, resolver, cls: route.cls, viewer });
  const flow = useSaveFlow({ sections, viewer, getBundle: () => bundleRef.current, getDrafts: () => draftsRef.current, refetch: fetchBundle, adopt });
  const openSet = open || new Set(isWide ? sections.map((s) => s.id) : sections.slice(0, 1).map((s) => s.id));
  const toggle = (id) => { const next = new Set(openSet); if (next.has(id)) next.delete(id); else next.add(id); setOpen(next); };
  const reveal = (id) => { if (!openSet.has(id)) setOpen(new Set([...openSet, id])); setScrollTo(id); };

  if (state.phase === "loading") return <div className="hfy-editor__skeleton" role="status" aria-label={COPY.loading} />;
  if (state.phase === "signedOut") return <SignInGate />;
  if (state.phase === "notFound") return <p className="hfy-editor__note" role="status">{COPY.notFound}</p>;
  if (state.phase === "failed") return <p className="hfy-editor__note" role="status">{COPY.loadFailed}</p>;

  const gid = bundle.obj && typeof bundle.obj.gramps_id === "string" ? bundle.obj.gramps_id : route.ref;
  const name = route.cls === "Person" ? nameOf(bundle.obj) : "";
  return (
    <div className="hfy-editor__layout" data-hfy-editor-ready data-relation={viewer.relation} data-admin={viewer.admin ? "true" : "false"}>
      <div className="hfy-editor__lead">
        <p className="hfy-editor__subject">
          {route.cls === "Person" ? <PersonName id={gid} name={name || gid} /> : <span>{route.cls.toLowerCase()}</span>}
        </p>
        <p className="hfy-editor__intro" data-hfy-intro>{introFor(viewer)}</p>
        {route.cls === "Person" && <a className="hfy-editor__back" href={`/person/?id=${encodeURIComponent(gid)}`}>{COPY.back}</a>}
      </div>
      <nav className="hfy-editor__index" aria-label={COPY.sections}>
        <ol>
          {sections.map((s) => <li key={s.id}><a href={`#sec-${s.id}`} onClick={() => reveal(s.id)}>{s.title}</a></li>)}
        </ol>
      </nav>
      <div className="hfy-editor__cards">
        {sections.map((s) => (
          <Section key={s.id} section={s} open={openSet.has(s.id)} onToggle={toggle}>
            {s.form
              ? <SectionForm key={`${s.id}:${epoch}`} section={s} schema={state.schema} bundle={bundle} cls={route.cls} resolver={resolver} viewer={viewer} seed={seed && seed[s.id]} onDraft={onDraft} />
              : <p className="hfy-editor__soon">{COPY.soon}</p>}
          </Section>
        ))}
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
