# HFY-PLN-002 ADR: the family tree visualization (Q2-13, VIZ-D1)

| field | value |
|---|---|
| Task | HFY-TSK-117 (`viz-research-intake`, W0, no_code) |
| Plan | HFY-PLN-002 (requirement R-22) |
| Decisions | VIZ-D1 (approach, Q2-13), VIZ-D11 (basemap), VIZ-D12 (era and chapter copy, Q2-14) |
| Status | **Proposed.** Two separate records are pending: io's answer to sheet item Q9 (recorded in 4.1), and io's approval of this ADR in its own HFY-R10 handoff (section 8). A "defaults ok" on the sheet is never approval of this ADR. No viz UI task is checked out before that approval. |
| Inputs | DOC-E61DCBFAFA5F (the visualization report), DOC-363B23B01410 (its claim-by-claim verification), DOC-C31D9E3DD932 (the decision sheet, `decisions-for-io.md`), DOC-2CFAE07B546C (io's founding intent), BRD2 sections 2.2, 6.5, 11.6 and Appendix C, `viz.md`, `chat.md` (Cloudflare facts only), `tasks.json` |
| Written | 2026-10-13, orchestrator draft for docstore storage |

All people, ids, places and years in examples are invented (`I9001`, "Ada Example", "Riverton"). This ADR holds no real name, personal date, gramps_id or contact detail. Library release dates and ruling dates are not personal data.

Sheet item Q10 (Gmail habits) belongs to the chat ADR. Nothing here depends on it.

---

## 0. Decision in brief

- **MVP: Concept A, the Family Card Navigator.** A framework-free `<family-navigator>` custom element (our code, no third-party tree library, family-chart not embedded) shows one family at a time as large cards. On a phone that means a focus card, a parents strip, one tab per partner family and a row of children, with details in a bottom sheet. From 64rem it widens into a four-row card grid. There is no pan-and-zoom canvas. The outline stays the accessible path.
- **v2: C-lite lifelines and Faces, plus a desktop big-tree poster.** d3-dag 1.2.2 precomputes the poster's layout at build time, so no layout code ships to the client. The "how are we related" finder keeps its own flag.
- **v3: Journeys** runs on maplibre-gl 6.14.0, pmtiles 4.5.0 and @protomaps/basemaps 5.7.2. It reads a self-hosted maxzoom-11 PMTiles extract with versioned file names and a Cloudflare Cache Rule. It never uses MapLibre v5, because CVE-2026-85061 affects every v5 release and has no backport.
- **Data:** graph.json v1 stays the contract. The only additions are an additive `layout` block and `photoEdges`, each with a minor bump. Graph budgets are unchanged, as measured in section 3.3.
- **Budgets:**
  - The 120 KB chart chunk becomes a navigator chunk of 35 KB gzip JS and 15 KB gzip CSS.
  - The 250 KB v2 places chunk becomes the v3 map. MapLibre is about 431 KB gzip plus 10.5 KB CSS, loaded only on the map view.
  - Section 5 has the full table.
- **Rejected** (section 6): embedding family-chart, Olli at runtime, elkjs, Cytoscape, Sigma 4, deck.gl, MapLibre v5, Who's On First, and nine report proposals that break a viz.md section 4.1 invariant or a BRD2 section 1.2 non-goal. `data-navigator@3.0.0` (MIT) is the runtime library if one is ever needed.
- **Approval:** io's sheet answer to Q9 picks the concept (4.1). The layouts, budgets, viz.md amendments and re-cut in this ADR need io's separate go-ahead in its own handoff, with its own reply (section 8).

---

## 1. Sources, links and the prompt

### 1.1 Docstore links and the banner (live state read 2026-10-13)

| document | live related_items | action at storage of this ADR |
|---|---|---|
| DOC-E61DCBFAFA5F (report, v4; sha256 `3e5497db…` matches the local copy) | HFY-PLN-002, DOC-2CFAE07B546C | Add DOC-363B23B01410 and this ADR. Replace the description and the body banner with the text below. |
| DOC-363B23B01410 (verification, v1; sha256 `69f48938…` matches) | HFY-PLN-002, DOC-E61DCBFAFA5F, DOC-926937A24A07, DOC-2CFAE07B546C | Add this ADR. |
| This ADR | (new) | related_items: HFY-PLN-002, HFY-TSK-117, DOC-E61DCBFAFA5F, DOC-363B23B01410, DOC-C31D9E3DD932, DOC-2CFAE07B546C |

Both research documents are already linked to HFY-PLN-002. The report's current description still points to the web-research workflow `wf-7bfff314-db6b-57e8-8afa-d87530d76069`, whose output was never used. It does not point to the verification.

**Replacement banner** (body line 3 and the `description` field of DOC-E61DCBFAFA5F):

> **Unverified draft, partly fact-checked.** On 2026-10-13 DOC-363B23B01410 checked 77 visualization claims: 52 verified, 20 corrected, 5 refuted. The 13 claims in its area C (geocoding) are not claims of this text, which has no geocoding section. Claims outside its areas A-E are still unverified: the exemplars other than E1-E6; the Gramps Web, webtrees, commercial-app, fan-chart, GeneaQuilts and Mapbox-template rows; and the anti-pattern examples marked "reportedly". E4 needs a human check, and E6 was corrected. Use the corrected values in DOC-363B23B01410 sections 2-4 and in the visualization ADR for any build decision. In short: never pin MapLibre v5 (use 6.14.0), use a maxzoom-11 basemap extract (not maxzoom 12), do not embed family-chart, and use Olli as a pattern only. The web-research workflow named below was not used.

### 1.2 Which prompt produced DOC-E61DCBFAFA5F (AC8)

- **What the report is.** By its own header, DOC-E61DCBFAFA5F is the full text of a report Claude wrote in chat on 2026-10-13, answering the HFY-PLN-002 visualization research prompt. The parallel web-research workflow `wf-7bfff314-…` was launched, but its output was not used.
- **The prompt.** The prompt is `docs/drafts/visualization-research-prompt.md` in the harrisonfamily working tree.
  - The file is untracked (`?? docs/drafts/`), 85 lines.
  - The stored, corrected version has sha256 `e0f3484b57cd8fd6614eb23cdff1a1e9e473e36f9975fb501f708e7ccbc78862` (re-checked 2026-10-13) and was saved at 08:13Z.
  - The gap-fill correction is `pln2/fill1/out/visualization-research-prompt.patch` (08:08Z, 6 hunks). Its `-` lines preserve the pre-correction wording of those 6 regions exactly.
  - **The stored file is not exactly the patched file.** It drifted after the patch was made: `patch -R --dry-run` on a scratch copy fails 3 of 6 hunks. The hunks at lines 7, 22 and 25 match the patch's `+` lines; the hunks at line 11, lines 15-19 and lines 45-46 do not. No copy of the pre-correction file was kept.
- **Which version was used.** Most likely the **pre-correction draft.** The report was stored at 08:26Z, 13 minutes after the corrected file was saved, so the timing rules neither version out. The content does: the report echoes the old wording in three places and the stored corrected wording in none. Each quote below is from the stored file (sha256 `e0f3484b…`) or from the patch's `-` lines.
  1. The title says "Nine Generations". The old line 7 says "Nine generations"; the stored line 7 says "8 linked generations".
  2. The sample place chain has four levels, including a parish level. The old line 17 says "city → parish/county → state → country"; the stored line 17 says "at most 3 levels, in 4 countries". (The words "no parish or county level" are in the patch's `+` line only, not in the stored file.)
  3. The report has no geocoding step. The old line 17 says "37 of 38 already have latitude/longitude". The stored line 17 says none has latitude/longitude yet and asks for a geocoding approach.
  - **Weak, not counted:** the report's lifeline glyphs (military, occupation, migration) match the old line 16, but the stored line 16 also names military, occupation, migration and custom life events (as arriving later), so this does not tell the versions apart.
- **The rerun-or-reconcile rule (IF-25) is met without a rerun.**
  - DOC-363B23B01410 reconciles the report claim by claim (77 visualization claims; claims outside its areas A-E stay unverified, as the banner in 1.1 says).
  - Section 2 of this ADR lists every contradiction the old prompt's facts caused, with what the plan does instead.
  - The corrected prompt is not re-sent. The gate `viz-research-run` (G-research) stays done.
- **Storage action.** Because the prompt file is untracked and can change, store it as a docstore document linked to HFY-PLN-002 and DOC-E61DCBFAFA5F:
  - the "as run" text: the stored file with its 6 hunk regions replaced by the patch's `-` lines. It equals the pre-correction draft only if the drift touched nothing outside those regions, which cannot be proven, and the document says so;
  - the patch itself, the stored file's sha256 above, and the note that 3 of 6 hunks no longer match;
  - **personal data:** line 5 names the family, and line 6 names real ancestors with birth years and parishes. The stored copy replaces line 6's names, years and parishes with "[redacted]", after the orchestrator checks every other line (including the `-` lines) for the same kind of data, and records the sha256 of both the local file and the redacted copy. A verbatim copy is stored only if io accepts that in the section 8 handoff.
  - If io remembers pasting the corrected version, that goes in io's reply. The reconciliation covers both versions.

### 1.3 Corrections carried from DOC-363B23B01410 section 2 (items 1-6)

| # | Report claim | Corrected value (DOC-363B23B01410) | Effect in this ADR |
|---|---|---|---|
| 1 | Pin MapLibre v5 if older iPhones matter. v5 is about 210-216 KB gzip and v6 is about 2x that. | Every v5 release up to 5.24.0 has CVE-2026-85061 / GHSA-jrc7-96c5-q579 (CVSS 10.0, an attribution-HTML sanitizer bypass), patched only in 6.4.1 with no v5 backport. iOS Safari has had WebGL2 since 15.0, so v6 excludes only iOS 14 and older. v5.24.0 is about 276 KB gzip. v6.14.0 is about 431 KB (287 KB main + 144 KB worker) plus 10.5 KB CSS, about 1.56x. | v3 uses maplibre-gl 6.14.0, exact pin, tracking the latest 6.x. `GPUInitializationError` and the map's `error` event fall back to the outline's places list. Attribution strings are static and self-authored. v5 is rejected (section 6). |
| 2 | A regional extract is "tens to a few hundred MB" at maxzoom about 12. | The US South plus 5 metros is about 0.68-0.79 GB at z12, 0.29 GB at z11 and 0.13 GB at z10. Cloudflare Free, Pro and Business never edge-cache a file over 512 MB and do not cache `.pmtiles` by default. | maxzoom 11 (about 0.29 GB) with overzoom above it. If z12 is ever needed, the extract is split per region so each file stays under 512 MB. A Cache Rule covers `/map/*.pmtiles`, `*.pbf` and the style JSON. Files carry versioned names and no Content-Encoding. |
| 3 | v6 is ESM-only (stated without its consequences). | The worker is a separate `maplibre-gl-worker.mjs` that the island must serve (or set with `setWorkerUrl`). The CSP needs `worker-src 'self'`, not `blob:`. | `viz-v3-csp-worker` adds `worker-src 'self'` (report-only, then enforced). The Journeys chunk serves the worker beside the island module. |
| 4 | Olli is permissive (BSD-3) and small. | 3.x depends on ua-parser-js 2.x (AGPL-3.0-or-later), imported statically. It is about 29 KB gzip unminified, before its dependencies. 2.0.2 does not use ua-parser-js. | Olli is a pattern only. `client-license-gate` fails AGPL code in client bundles. `data-navigator@3.0.0` is the runtime library if one is needed. |
| 5 | family-chart is "the most active" embeddable library (fit 4). | The open-source edition has been dormant since 0.9.0 (2025-10-21). Development moved to a proprietary paid fork (Apr 2026). Its default d3-zoom captures one-finger drag and page scroll (a `zoom_polite` option exists but is off by default, A6). With d3 it is 46.6 KB gzip. Topola is active (8 releases in 2026, no built-in gestures). | Fit lowered to 3. family-chart is not embedded. Topola is a chart-vocabulary reference only (46-53 KB gzip, CommonJS-only). |
| 6 | Geocoding via GeoNames admin1 codes; the Gramps hierarchy maps onto admin1. | admin1CodesASCII has no coordinates. The GeoNames hierarchy is not one-to-one with Gramps: a region can sit at admin2 under an admin1, and a city's common name can be only an alternate name. | Geocoding follows viz.md 5.6 as amended (section 7): cities1000 plus admin1 and admin2, a parent matched at admin1 or admin2, alternate-name search, an override table, and Natural Earth or Census Gazetteer centroids. The credit reads "Place coordinates: GeoNames (geonames.org), CC BY 4.0, modified". Note: the stored report text has no geocoding section (see 1.2), so these claims come from the verification's area C. |

Other refutations and corrections this ADR relies on: A8 (Topola is active, not slow), B5 (v5 size), C6 (admin1 has no coordinates), C11 (Natural Earth places alone match only 15 of 23 leaf places), D3 (Olli), A13 (d3-dag is active again, 1.2.0 to 1.2.2 shipped Apr-Jul 2026), A17 (elkjs's licence allows EPL-2.0; it is excluded for size), B4 (v6 size), B12 (extract sizes), E3 (the TimeNets link is now idl.uw.edu/papers/timenets).

The rest of area E, carried for completeness (exemplars inform tone, not any decision here): E6 is corrected (PBS *Great Migrations* is a 4-part series that premiered 2025-01-28 and covers several migrations; "family-centred" is not verified), and E4 (NMAAHC *Transitions in Freedom*) is verified only from search-index excerpts and needs a human check in a browser (DOC-363B23B01410 section 4.6). The other corrected or refuted rows of areas A-D are carried in sections 3.1 and 6 with their DOC-363B23B01410 row numbers.

---

## 2. Data check: the report against viz.md section 1 (AC2)

viz.md section 1 records 231 people, 57 families, 169 events, 37 places and 32 media. Event-type counts come from the same gap-fill. Each claim below is checked against those facts.

| # | Report claim or assumption | Fact (viz.md section 1 / gap-fill) | Verdict | What the plan does |
|---|---|---|---|---|
| 1 | "Nine generations" (title) | The longest parent-to-child chain is 8 people, so component 0 has 8 levels (0..7) | **Contradiction** | Relative labels only (viz.md 5.4). No UI copy counts generations. |
| 2 | Places have a parish level, shown as "city, X Parish"; the sample chain has 4 levels | At most 3 levels (city or town, state or province, country); 37 places | **Contradiction** | The place line is composed from the real chain. No parish string is invented. |
| 3 | Places carry lat/lon. The map is a co-equal story layer, and v2 already has per-person mini-maps. | 0 of 37 places have coordinates. 60 of 169 events have a place, and one city holds 26 of those 60. 197 of 231 people have no placed event. | **Contradiction** | Build-time offline geocoding comes first (`viz-geocode-offline`). The map moves to v3. The navigator and outline stay the backbone. |
| 4 | Lifeline glyphs for military, occupation, migration and custom events | Events today: births 121, deaths 18, residences 12, graduations 7, marriages 4, degrees 4, divorces 2, education 1. None of the claimed types exists yet. | **Contradiction (today)** | v2 lifelines render the types present. One-event people render as dots. New types appear as members add them. |
| 5 | Face-forward cards for everyone | 26 people have any media. 21 primary photos carry a rect. 14 of 29 media files are 0-byte placeholders. | **Partial** (the report has a monogram fallback) | Initials avatars for about 205 people. The card design must read well without a face. Faces are 160 px (VIZ-D9), not the report's 96 and 256 px. |
| 6 | Step and adoptive badges | 169 Birth/Birth and 2 Unknown/Unknown child links. No step, adoptive or foster links yet. | Consistent (designed ahead) | `rel` per parent stays in graph v1. Fixtures test every `rel` value. |
| 7 | An "Other branches" shelf, each with its earliest known ancestor | 1 component of 221 people plus 10 singletons. There are no other branches. | **Contradiction** | A "not yet connected (10)" group (viz.md 9.4). The shelf is not built. |
| 8 | A "parents not recorded" ghost card with a "Tell us" link | 60 people have no parents, most of them married-in spouses | Consistent, with a condition | The ghost card always shows. The link appears only when R-24's flag is on (viz.md 9.4). |
| 9 | Unions carry `type: married` and a start year | 39 of 57 families have type Unknown. Graph v1 unions have no year. Graph v1 events are `{person, type, year, place}` with no union id, and the projection reads only the person's `event_ref_list`, so a marriage event cannot be tied to one union of a person with two. | **Contradiction** | The DS voice says "partner" for non-married or unknown types. A lifeline union's convergence point is "about" the first child's birth year, else none. A marriage-year convergence needs an additive field (for example `unions[].year`, a minor bump) approved by io as an amendment to this ADR (section 6, deferred). |
| 10 | Years with qualifiers ("abt.", "bef.", "1880s") | 164 of 169 dates are year-only, 4 are full dates and 1 is a span | Consistent, with a limit | Graph v1 carries a boolean `yearApprox`, so every approximate year reads "about 1880". Distinct before/after wording would need an additive field. It is not in this cut. |
| 11 | Graph index of 80 KB gzip, cached by the service worker | 231 people is about 12 KB gzip and 2,000 people about 90 KB (viz.md 5.3). Gated data is `private, no-store`. | **Contradiction** | No service-worker cache (section 6). The budgets stay at 25 and 150 KB. |
| 12 | `graph.public.json` (deceased only, signed out) beside `graph.family.json` | Members-only data. No public, signed-out view (viz.md 2). | **Contradiction** | One gated `person/graph.json` (section 6). |
| 13 | Living people: no place more specific than a state unless signed in | Every viewer is signed in. Living people's residence events are dropped by default (VIZ-D5). Q2-11(b) is still open: its default (sheet Q3) is "a living person's city and state are allowed, but never on the family map". | **Contradiction** | Whatever io's recorded Q2-11(b) answer is (default: dropped at build time, never on the family map), enforced by the builder and a Journeys fixture that asserts that answer (re-cut `viz-v3-journeys-places`). |
| 14 | Scale: about 2,000 people, BFS in milliseconds | Same design target | Consistent | Perf tests at 231 and 2,000 synthetic people. |
| 15 | A "me" mapping from account to Gramps id | The session sub is the gramps_id (viz.md 5.2) | Consistent | `/tree/` focuses on the viewer. |

**Not covered by the report:**
- the 0-byte media placeholders (row 5);
- the GRAPH_CYCLE data error (viz.md 5.4);
- the `living` cross-check against person JSON (rule L);
- the edge gate's existing revocation gap (viz.md 20).

The plan already handles each one.

---

## 3. Library scoring (AC3)

### 3.1 Licence, last release, measured gzip size and phone behaviour (DOC-363B23B01410 section 3, areas A-D)

| Package | Version | Licence | Last release | Gzip size (measured) | Phone behaviour | Role in this ADR |
|---|---|---|---|---|---|---|
| Family Card Navigator (ours) | — | ours | — | budget 35 KB JS + 15 KB CSS | Built for 375 px; no canvas | **MVP** |
| d3-dag | 1.2.2 | MIT (A12) | Jul 2026 (1.2.0-1.2.2 shipped Apr-Jul 2026; A13) | 0 KB on the client at build time; 41.9-45.4 KB if shipped (A15) | Layout only (A16) | **v2 build-time layout** |
| family-chart | 0.9.0 | LICENSE.txt MIT; npm package.json says ISC (A1) | 2025-10-21, dormant since (A2, A3) | 46.6 KB with d3; 28.5 KB UMD without (A5) | Default d3-zoom captures one-finger drag and page scroll; a `zoom_polite` option exists but is off by default (A6) | Rejected |
| Topola | 3.10.4 | Apache-2.0 (A7) | 2026-09-04, 8 releases in 2026 (A8) | 46.1 KB (bundlephobia); 52.7 KB full ESM; CommonJS-only (A10) | Static SVG, no zoom or touch code (A11) | Reference only |
| elkjs | 0.12.0 | EPL-2.0 OR GPL-3.0-or-later (A17) | 2026-07-17 (A18) | 433-467 KB (A19) | Layout only; Web Worker build (A20) | Rejected |
| d3-hierarchy | 3.1.2 | ISC (A21) | 2022 (A22); justified only as the hourglass fallback engine | 5.65 KB full; about 1.9 KB tree-only (A22) | Layout only | Fallback only if io rejects Q9 |
| d3-flextree | 2.1.2 | WTFPL (A24) | Nov 2021, stale (A25) | 2.6 KB, plus a duplicate d3-hierarchy v1 (A25) | Layout only | Rejected |
| Cytoscape.js | 3.34.3 | MIT (A26) | 2026-09-07 | about 137 KB (A27) | Canvas; unified touch and pinch zoom (A28) | Rejected |
| Sigma.js + graphology | 4.0.0 + 0.26.0 | MIT (A29, A32) | 2026-10-08; graphology core Jan 2025 | about 97 + 13 KB (A30) | Multi-touch; WebGL2-only (A31) | Rejected |
| Olli | 3.1.4 | BSD-3, but ua-parser-js 2.x is AGPL (D1, D3) | 2026-07-05 (D2) | about 29 KB unminified, plus dependencies (D3) | Screen reader and keyboard (pattern) | Pattern only |
| data-navigator | 3.0.0 | MIT file; no license field in package.json (D4) | 2026-06-03 | about 19 KB unminified; zero dependencies (D4) | Keyboard, screen reader, speech and gesture input (R: the report's claim; D5 verified only that the paper link and DOI are live) | Runtime library only if needed |
| Scrollama | 3.2.0 | MIT (D6) | 2022-06-17; repo commits Nov 2025 (D6) | about 2.1 KB | Works on mobile (report) | Not used; native IntersectionObserver |
| sharp (build only) | 0.35.5 | Apache-2.0; libvips binaries are LGPL-3.0-or-later (D7, D8) | 2026-09-27 (`npm view sharp time --offline`, this ADR; not in DOC-363B23B01410) | build-time | n/a | Face crops (devDependency) |
| maplibre-gl | 6.14.0 | BSD-3 (B1) | 2026-10-11 (B1) | 287 KB main + 144 KB worker = about 431 KB, plus 10.5 KB CSS (B4) | Native touch and globe; needs WebGL2 (iOS 15+); throws `GPUInitializationError` without it (B3, B17) | **v3** |
| maplibre-gl | 5.24.0 | BSD-3 | 2026-04-23 | about 276 KB (B5) | CVE-2026-85061, no backport (B6) | Rejected |
| pmtiles | 4.5.0 | BSD-3 (B8) | 2026-08-10 | about 8 KB (B8) | HTTP range reads | **v3** |
| @protomaps/basemaps | 5.7.2 | Code BSD-3, design CC0, tiles ODbL (B9) | about 2026-03-10: the `modified` date of the registry document in the local npm cache, where 5.7.2 is `latest` (the cached abbreviated document carries no per-version times; `npm view --offline` cannot read it). Within 12 months. `viz-v3-journeys` confirms the exact date with `npm view` at checkout. | about 6.8 KB (B9) | Light, dark, white, grayscale and black flavours (B17) | **v3** |
| deck.gl | 9.4.0 | MIT (B16) | — | about 553-576 KB (B16) | Heavy first paint | Rejected |

### 3.2 Messy-genealogy scoring

Scale: **2** handled natively, **1** handled with our own extra data or workaround, **0** breaks or is unsupported. Evidence letters:
- **V**: a verified row in DOC-363B23B01410;
- **M**: measured in this ADR's scratch run (3.3);
- **T**: read from the package's own type definitions in the verification scratch install;
- **R**: report claim, unverified;
- **D**: design analysis.

| Library | Two partner families | Single-parent unions | Parentless siblings | Step and adoptive links | Pedigree collapse | Disconnected people | Total /12 | Data beyond graph v1 |
|---|---|---|---|---|---|---|---|---|
| **Family Card Navigator** | 2: one tab per union (D) | 2: unions carry 0-2 partners; a dashed "parent not recorded" card (D) | 2: a 0-partner union is a sibling group under a "parents not recorded yet" card (D) | 2: per-parent `rel` becomes a text badge (D) | 2: one family per view, so a person appears once; v2 kinship lists both paths (D) | 2: a "not yet connected" group (D, viz.md 9.4) | **12** | None for the MVP |
| **d3-dag 1.2.2** (with our union nodes) | 2: a person with two union nodes is laid out once, no overlap (M) | 2 (M) | 1: lays out, but generations line up only with our rank constraints (without them the messy fixture's generation 0 splits across layers; `messy-norank.mjs`); we supply ranks (M) | 2: a child of two unions has two parents natively (V A14; M) | 2: a cousin union is laid out once (V A14; M) | 1: components share one canvas, so we lay out per component and skip singletons. A cycle is **not** rejected (`acyclic()` is false yet sugiyama returns a layout), so the builder filters GRAPH_CYCLE members first (M) | **10** | Union nodes and ranks (derived at build time) give the additive `layout` block |
| elkjs 0.12.0 | 2 (D) | 2 (D) | 1: layer constraints (D) | 2 (D) | 2 (D) | 2: component packing (D) | 11 | Union nodes; 433-467 KB, so rejected for size |
| Topola 3.10.4 | 2: a person in several `fams` (T) | 2: `husb`/`wife` optional (T) | 2: a family with no partners (T) | 0: one `famc` per person, no pedigree type (T) | 1: charts expand from one start person, so an ancestor can repeat (D) | 1: charts start from one person (D) | 8 | Conversion to its GEDCOM-like JSON |
| family-chart 0.9.0 | 2: `rels.spouses` (T, R) | 1: no union unit; parents are a list (T) | 0: siblings view open (#84, V A4) | 1: `rels.parents` is a list with no link type; badges would be ours (T) | 0: kinship pedigree collapse open (#85, V A4) | 1 (D) | 5 | `gender` must be `'M' \| 'F'` (T), so our `sex: u` people have no value |
| d3-hierarchy 3.1.2 | 1: works from one person downward only (D) | 2 (D) | 1: needs a virtual root (D) | 0: two parents throws (V A23) | 0: ambiguous parents throws (V A23) | 1: needs a virtual root (D) | 5 | Hourglass halves only |
| d3-flextree 2.1.2 | same as d3-hierarchy (built on hierarchy v1, V A25) | | | | | | 5 | — |
| Cytoscape.js 3.34.3 | 1 (D) | 1 (D) | 1 (D) | 1: edge data, our badges (D) | 2 (D) | 2 (D) | 8 | Union nodes; no genealogy semantics (R) |
| Sigma 4 + graphology | 1 (D) | 1 (D) | 1 (D) | 1 (D) | 2 (D) | 2 (D) | 8 | As Cytoscape; WebGL2-only |

Olli, data-navigator, Scrollama and the map stack are not layouts, so they are not scored. data-navigator's graph model handles non-tree kinship (R).

### 3.3 Measurements this ADR added (packages beyond section 3, measured the same way)

**Method and evidence.** Everything below can be re-run from the saved scripts; nothing ran in the repo, and every graph is synthetic (invented ids and names).
- Evidence directory: `pln2/adr/evidence/viz-measure/`, holding the scripts `synth.mjs` (seeded generator), `bench.mjs` (layout, graph size, photoEdges, messy fixture, cycle check), `messy-norank.mjs`, `bundle.mjs`, `npm-dates.sh` and `contrast.mjs`, with their outputs in `out/` (`bench-seed42.json`, `bench-seed7.json`, `bundle-report.json`, `npm-release-dates.txt`, `messy-norank.txt`, `contrast-report.json`, the sample layout blocks and gzipped graphs).
- Re-run: `node bench.mjs <pln2/verify/tree-_bundle> out <seed> 231,2000` and `node bundle.mjs <pln2/verify/tree-_tools> <pln2/verify/tree-_bundle> out`. The packages come from the verification's scratch installs, so nothing new is downloaded.
- Package metadata comes from the local npm cache (`npm-dates.sh`: `npm view --offline`, and a direct cache read for @protomaps/basemaps).
- Sizes: a one-line import bundled with esbuild 0.25.10 (`--bundle --minify --format=esm`) and gzipped. Graph sizes are the whole graph.json, keys sorted, gzipped with zlib's default level. KB here is 1,024 bytes.
- Machine: Node **24.10.0** on an Apple M2 Pro (10 cores). Node 22, the `graph/` engines floor, is not installed here, so the times are not Node 22 times. The limits in section 5 leave at least 4x headroom over the slowest run for that reason, and the 2,000-person check re-measures on the worker's own Node.
- The ADR's first draft quoted layout figures from a run whose scripts and outputs were not saved (for example coordSimplex at 2,000 people in 20.8 s). They are replaced by the saved runs below and were not reproduced.

| Package | Version | Licence | Last release | Gzip | Decision |
|---|---|---|---|---|---|
| d3-scale (`scaleLinear`) | 4.0.2 | ISC | 2021-09-24 | 7.7 KB (7,901 bytes); the bundle also holds d3-array, d3-color, d3-format, d3-interpolate, d3-time, d3-time-format and internmap | **Not adopted.** A year-to-pixel scale is a few lines of our own code. |
| d3-shape (`line`, `curveMonotoneX`) | 3.2.0 | ISC | 2022-12-20 | 1.9 KB (1,935 bytes); the bundle holds d3-shape and d3-path only | Allowed in `viz-v2-time`, exact pin. Older than 12 months; justified as a feature-complete d3 core module with one dependency, d3-path 3.1.0 (ISC, 2022-12-19), which itself has no dependencies. |
| d3-dag's own dependencies (build-time only) | — | javascript-lp-solver 1.0.3 **Unlicense**, quadprog 1.6.1 MIT, stringify-object 6.0.0 BSD-2-Clause, d3-array 3.2.4 ISC | — | 0 KB on the client | Fine in `graph/`. If d3-dag were ever shipped to a client, `client-license-gate` would fail on Unlicense without a reviewed override, which is one more reason it stays build-time. |

**d3-dag 1.2.2 layout, measured** (`sugiyama` with `layeringSimplex().rank(...)` and `decrossTwoLayer`, nodeSize 180 x 90, one layout per component of at least 2 people). Two seeds of the same generator; each 2,000-person graph has one main component of about 1,970 people, as the real tree has one main component.

| Synthetic graph (seed) | Operator | Time | Layout block | Widest poster |
|---|---|---|---|---|
| 231 people, 92 unions (42) | coordGreedy | 0.21 s (0.16-0.24 s, 3 runs) | 10.9 KB raw, **2.2 KB gzip** | 13,847 x 1,546 px |
| 231 people, 92 unions (42) | coordSimplex | 0.38 s (0.38-0.49 s) | 10.9 KB raw, 2.0 KB gzip | 13,665 x 1,546 px |
| 231 people, 93 unions (7) | coordGreedy | 0.68 s (0.58-1.09 s) | 10.6 KB raw, 2.1 KB gzip | 14,525 x 1,364 px |
| 231 people, 93 unions (7) | coordSimplex | 1.64 s (1.43-1.75 s) | 10.7 KB raw, 2.0 KB gzip | 13,846 x 1,364 px |
| 2,000 people, 865 unions (42) | coordGreedy | **12.9 s** | 98.1 KB raw, **19.0 KB gzip** | 149,184 px wide |
| 2,000 people, 865 unions (42) | coordSimplex | **217 s** | 98.0 KB raw, 17.7 KB gzip | 132,672 px wide |
| 2,000 people, 903 unions (7) | coordGreedy | **8.8 s** | 99.3 KB raw, 18.9 KB gzip | 151,346 px wide |
| 2,000 people, 903 unions (7) | coordSimplex | **1,750 s** (29 min) | 99.3 KB raw, 17.9 KB gzip | 134,663 px wide |
| messy fixture: two partner families, mother-only, parentless siblings, birth plus adoptive parents, a cousin union, a second component, a 2-person cycle, a singleton | coordSimplex | — | 29 nodes in 2 components; the cycle's 2 members and the singleton left out | 996 x 727 px |

Every run: each node once, no two nodes at one position, every rank on one layer. Seed 7's 231-person times ran while another measurement was running, so they are the upper end. `messy-norank.mjs` shows why ranks are supplied: without them the fixture's generation-0 people and unions split across layers. A cyclic graph is laid out without error (`acyclic()` is false), so the builder must filter GRAPH_CYCLE members first.

**graph.json gzip with the additive blocks** (whole file; coordSimplex block; a coordGreedy block adds about 0.1 KB at 231 and 0.5-0.8 KB at 2,000). photoEdges is generated at three densities, each photo tagging 1 to 4 people: today's density scaled (23 photos per 231 people), one tagged photo per person, and three.

| People | Base v1 | + layout | + layout + photoEdges, today's density | + one photo per person | + three photos per person | Budget |
|---|---|---|---|---|---|---|
| 231 | 10.1-10.4 KB | 12.2-12.6 KB | 12.4-12.8 KB | 14.3-14.6 KB | 18.2-18.5 KB | 25 KB |
| 2,000 | 77.5 KB | 96.3-96.5 KB | 98.4-98.7 KB | 115.7-115.9 KB | **151.6-151.9 KB** | 150 KB |

viz.md 5.3 estimates the base at about 12 KB (231) and 90 KB (2,000), above these synthetic bases; on that estimate the 2,000-person file with one tagged photo per person is about 90 + 19 + 18 = 127 KB.

**What the measurements decide:**
- **Operator: coordGreedy, not coordSimplex.** coordSimplex took 217 s and 1,750 s at 2,000 people, against 12.9 s and 8.8 s for coordGreedy, for a poster about 11% narrower. 4.7 and `viz-graph-v2-layout` use coordGreedy.
- **The graph budget does not change.** Layout plus photoEdges fit at 231 people at every density. At 2,000 people they fit up to about 2.8 tagged photos per person on average; at 3 the file passes 150 KB. Then `size.test.mjs` and the builder's `SIZE_BUDGET` (exit 3) fail, and the remedy is an amendment to this ADR (for example a separate gated layout or photoEdges file), never a silent budget change.
- **Layout time limits** (section 5): at most 5 s for 231 people, run everywhere, CI included; at most 60 s for 2,000 people, run only where `HFY_GRAPH_PERF=1` (the worker and io's machine), never on shared CI runners. The slowest measured runs were 1.09 s and 12.9 s.
- `viz-graph-cloud-source` runs the same layout in Lambda after each debounced change batch. At 2,000 people that is seconds to tens of seconds per batch, so its timeout and debounce must allow for it.
- `decrossOpt` is NP-complete (its own docs say so) and is never used.
- The poster is very wide even at 231 people (about 14,000 px). It needs a minimap and fit, and semantic zoom that hides names below 16 px instead of shrinking them (re-cut `viz-v2-bigtree`).

---

## 4. Decision: io's Q2-13 answer and what it fixes (AC4)

### 4.1 Recorded answer: io's sheet answer to Q9

This section records only io's answer to sheet item Q9. io's approval of this ADR is a separate record (section 8).

| Item | Value |
|---|---|
| Question | Sheet item Q9 (Q2-13 with Q2-14), quoted from DOC-C31D9E3DD932: "Should the family tree follow your research's recommendation?" |
| Sheet default, quoted exactly | "yes: family cards for phones, then lifelines, faces and a desktop poster, then a map of moves; era names only in wording you approve." |
| What a whole-sheet "defaults ok" records here | That sheet default, as io's answer to Q9 (Q2-13 and Q2-14), with the reply's date. It records nothing else. It does not approve this ADR's layouts, budgets, viz.md amendments or re-cut (section 8). |
| io's verbatim answer and date | **Pending.** Pasted here verbatim, with its date, when io replies on the sheet. |
| Fallback if io rejects | The viz.md 4.3 hourglass (2 generations up, 2 down) with the focus navigator, on d3-hierarchy 3.1.2 tree halves. This ADR is then revised before its approval handoff (section 8). The re-cut in section 9 keeps the same split by concern. |

**Chapter copy (VIZ-D12, Q2-14).** The sheet's wording names only era names. BRD2's Q2-14 row asks the same question for the v3 Journeys chapter copy, with the same default: decades only, and era bands or chapter titles only from an io-approved copy list. This ADR applies that rule to both. The copy lists themselves are approved in `viz-v2-time-eras` and `viz-v3-journeys-chapters` (section 9).

### 4.2 MVP: Concept A, the Family Card Navigator

- **Element.**
  - `islands/src/lib/family-navigator.js` defines `<family-navigator>`. It is framework-free (no React inside), renders into light DOM (no shadow root, so tokens, theme-lint and axe apply) and has no third-party runtime dependency.
  - The React island's lazy `ChartView` imports it. The island passes the `FamilyGraph` instance and the focus id as properties, and listens for `hfy-focus` and `hfy-details` CustomEvents.
  - The details bottom sheet is the kit `Sheet`, rendered by the island, so the element does not ship a second sheet.
- **One family at a time.** The element shows:
  - the focus card (160 px face or initials, name, years in words, one place line);
  - a parents strip;
  - one tab per union of the focus person ("with Dan Sample", or "partner not recorded");
  - that union's children as a row of cards;
  - siblings.
  - Every card is a `<button>`, and tapping it re-centres.
- **Navigation.**
  - Every direction has a visible button.
  - Swipes are horizontal only, inside the children row and the tabs (native scroll-snap, `touch-action: pan-y`). One-finger vertical drag and page scroll are never captured, so the report's swipe up/down for generations is replaced by buttons.
  - Arrow keys walk the family (Data Navigator's model, our code).
  - Reduced motion turns slides into fades.
  - One polite live region announces each re-centre.
- **Views.**
  - The toggle reads `cards | outline`. The URL keeps `?view=chart|outline`, and `localStorage["hfy:tree-view"]` is wrapped in try/catch.
  - Concept A is phone-native, so viz.md 9.3's rule shows the toggle on phones. The cards view is the default at every width.
  - The plain-HTML FocusNavigator and GenerationOutline (`viz-outline-navigator`) are the outline view and the fallback.

### 4.3 v2: C-lite lifelines, Faces, the big-tree poster and kinship

- **Lifelines (`familyVizTime`).**
  - Per-person and per-family strips on a decades axis, drawn by our own SVG renderer (d3-shape 3.2.0 optional, about 1.9 KB).
  - Partners' lines converge at the union, at about its first child's birth year (graph v1 has no union year; section 2 row 9), and children start from it.
  - Uncertain starts and ends fade (the TimeNets encoding).
  - A one-event person is a dot. Living people's lines run to today, with the birth year only.
  - At most 40 lines per view.
  - On phones, time runs down the screen, one branch per panel.
  - Era bands appear only from an io-approved copy list (Q2-14).
- **Faces (`familyVizFaces`).**
  - "Pictured with" chips come from `photoEdges`.
  - A faces tab on `/tree/` shows a mosaic of 160 px crops grouped by photo. Photos open through `surf-photo-tags-ui`'s tag display.
- **Big-tree poster (`familyVizBigTree`).**
  - Desktop only (64rem and up). An SVG poster of cards is drawn from the precomputed `layout` block, with a minimap. It is the only pan-and-zoom surface.
  - Buttons do everything a gesture does, and the wheel zooms only with a modifier.
  - No d3-dag module ships.
- **Kinship (`familyVizKinship`).** A "how are we related?" chain of cards and the "my grandparents" and "my cousins" shortcuts.

### 4.4 v3: Journeys (`familyVizJourneys`)

- **Libraries.**
  - maplibre-gl 6.14.0, exact pin, tracking the latest 6.x, never v5.
  - pmtiles 4.5.0 and @protomaps/basemaps 5.7.2 (dark flavour).
  - Everything loads lazily, only when the map view opens.
- **Basemap.** A self-hosted PMTiles extract at maxzoom 11 (about 0.29 GB) under the public prefix `map/`, with versioned names, no Content-Encoding and self-hosted fonts (OFL) and sprites/v4 (MIT). A Cloudflare Cache Rule caches it (gate G-map).
- **Worker and CSP.** `maplibre-gl-worker.mjs` is served same-origin, under `worker-src 'self'`.
- **Fallback.** `GPUInitializationError` falls back to the outline's places list.
- **Content.**
  - Decade scrubber and place sheets that open the navigator.
  - "Follow this person" draws a life path as a MapLibre line layer, drawn once. No deck.gl, no particles.
  - Chapters appear only from io-approved copy (Q2-14), triggered by IntersectionObserver. The copy is served only from a gated object, never from Eleventy front matter or public HTML or JS (section 6).
  - Living people's residence events follow io's recorded Q2-11(b) answer (sheet Q3). Under the default they are dropped at build time and never reach the client or the family map (VIZ-D5).
- **Attribution.** Static strings: "© OpenStreetMap", and the GeoNames credit whenever `attribution.geonames` is true.

### 4.5 Layouts

**Desktop, 64rem and wider** (inside the shell column; the left outline column is 280 px and the right panel is the viz.md 9.1 detail panel):

```text
+--------------------+-----------------------------------------------------+-------------------+
| generations        | grandparents  [Jo Example] [- - not recorded - -]   |  [face]           |
|  > grandparents'   |               [Kay Sample] [Lee Sample]             |  Ada Example      |
|  v parents' gen.   | parents       [Ben Example] ==== [Cara Example]     |  about 1880-1950  |
|     Ben Example    | focus family  [Hal] [Ivy  half-] [ ADA ] == [Dan]   |  Riverton         |
|  > your gen.       |               ( with Dan Sample ) ( 2nd family )    |  2 parents        |
|  > not yet         | children      [Eve] [Fay] [Gus  adopted] [+2 more]  |  1 partner, 5 ch. |
|    connected (10)  |                                    [cards|outline]  |  [ view page ]    |
+--------------------+-----------------------------------------------------+-------------------+
```

- The four rows are grandparents, parents, the focus family with siblings beside it, and children.
- A row wider than the column shows "+N more" and expands in place. Nothing scales below 16 px names.
- From 43rem to 64rem the layout has two columns (grid and panel), and the outline opens in the kit `Sheet` (viz.md 9.2).

**375 px phone:**

```text
+-------------------------------------+
| family              [cards|outline] |
| [ ^ parents ]                       |
| +-------------+ +-----------------+ |
| | (o) Ben     | | - - - - - - - - | |
| | Example     | |  parent not     | |
| | father      | |  recorded       | |
| +-------------+ +-----------------+ |
| +---------------------------------+ |
| | [face]  Ada Example             | |  <- focus card
| |         about 1880 - 1950       | |
| |         Riverton, Examplestate  | |
| | [ details ]      [ view page ]  | |
| +---------------------------------+ |
| ( with Dan Sample )( 2nd family )   |  <- one tab per union
| children (3)              [<]  [>]  |
| [Eve    ][Fay    ][Gus      >>      |  <- row scrolls inside itself
|  daughter  son     son, adopted     |
| brothers and sisters (2)       [v]  |
+-------------------------------------+
| home  family  search  posts  me     |
+-------------------------------------+
```

### 4.6 What is precomputed and what runs in the browser

| Work | Where | Task | Output |
|---|---|---|---|
| Allowlist privacy projection, unions, edges, years, places, events (living people's residences per io's Q2-11(b) answer; default dropped) | build (`graph/`) | `viz-graph-builder` | graph.json v1 |
| Generation index and components | build | `viz-generation-index` | `generations`, `components` |
| Face crops (160 px WebP, content-hashed) | build | `viz-face-crops` | `media/faces/` |
| Offline geocoding (cities1000, admin1 and admin2, overrides) | build or dev | `viz-geocode-offline` | `places[].lat/lon` (2 dp) |
| Poster layout (d3-dag 1.2.2) | build | `viz-graph-v2-layout` | `layout` (additive) |
| Photo co-occurrence | build | `viz-graph-v2-data` | `photoEdges` (additive) |
| Basemap extract, fonts, sprites | io's machine, once per rebuild | `viz-v3-basemap` | `map/` |
| Focus navigation, neighbourhoods, place line strings | browser | MVP | — |
| Relationship paths (BFS over 2,000 nodes) and `relationLabel` | browser | `viz-v2-kinship` | — |
| Lifeline geometry, decade scale, era-band placement | browser | `viz-v2-time*` | — |
| Poster drawing from coordinates (no layout code) | browser | `viz-v2-bigtree*` | — |
| Per-person place sequences and decade aggregates, from `events` and `places` | browser | `viz-v3-journeys*` | — |

**Not precomputed, though the report proposed it:**
- `journeys.json`, era tags per person and display strings: the client derives them from graph v1;
- a second public graph, data inlined into the page, per-person `/p/<id>.json` files and Markdown front-matter chapter configs: all rejected (section 6).

**Chapter copy** (v3, only with io's approved list) is the one non-graph input. It is kept with io's data outside the repo and published as a gated object under `person/` (the existing `/person/*.json` behaviour and edge gate, `private, no-store`), by the same refresh step as graph.json (`viz-v3-journeys-chapters`).

### 4.7 The additive graph.json fields

Each block bumps `minor` once, in whichever order its task merges. `additionalProperties: false` still holds, and the client accepts `schemaVersion === 1` with any `minor`.

```json
{
  "schemaVersion": 1,
  "minor": 2,
  "photoEdges": [
    { "media": "O9001", "people": ["I9001", "I9003"] }
  ],
  "layout": {
    "engine": "d3-dag 1.2.2",
    "params": { "layering": "simplex+rank", "decross": "twoLayer", "coord": "greedy", "nodeSize": [180, 90] },
    "components": [
      { "component": 0, "width": 1176, "height": 636,
        "people": [ { "id": "I9001", "x": 90, "y": 45 } ],
        "unions": [ { "id": "F9001", "x": 180, "y": 135 } ],
        "bends":  [ { "s": "I9004", "t": "F9002", "points": [[540, 225], [540, 315]] } ] }
    ]
  }
}
```

**`photoEdges` rules:**
- One entry per photo with at least one tagged, non-excluded person.
- `media` is the Media gramps_id. People are sorted.
- No handles, rects, paths, descriptions or notes.
- Private Media, private MediaRefs, `RECT_INVALID` rects and (in the cloud builder) MOD#-hidden items are skipped.

**`layout` rules:**
- Ranks:
  - a person sits at rank 2 x generation;
  - a union sits at 2 x (the highest partner generation) + 1;
  - a partnerless union sits at 2 x (the lowest child generation) - 1.
- Ranks alone kept every generation on one layer in the measured run. Group constraints are added only if a fixture shows otherwise.
- Only components with at least 2 people are laid out. Singletons and `generation: null` (cycle) members are left out.
- Coordinates are integers. Bend points are emitted only for links that span more than one layer.
- Output is sorted by id, so the result is byte-identical for shuffled input.
- `engine` is written "d3-dag 1.2.2", never "d3-dag@1.2.2". viz.md 5.2 `verify()` runs a deep string scan over the whole file, and its e-mail check rejects any `@` with PRIVACY_VIOLATION (exit 4). The same scan rejects a version that looks like a day-precise date (for example "1.10.12"), so a later pin change re-runs the verify test before it merges. viz.md 5.3's `source.builder` changes the same way ("hfy-graph 0.1.0", section 7).

### 4.8 The cut: MVP, v2 and v3

| Phase | Flag | Tasks (after the section 9 re-cut) |
|---|---|---|
| MVP | `familyViz` | `viz-page-shell`, `viz-outline-navigator`, `viz-mvp-visual`, `viz-mvp-visual-desktop`, `viz-mvp-visual-nav`, `viz-mvp-visual-perf`, `viz-mvp-visual-fallback`, then `viz-mvp-flip` |
| v2 data | — | `viz-graph-v2-data` (photoEdges), `viz-graph-v2-layout` |
| v2 lifelines | `familyVizTime` | `viz-v2-time`, `viz-v2-time-phone`, `viz-v2-time-eras` |
| v2 kinship | `familyVizKinship` | `viz-v2-kinship`, `viz-v2-kinship-ui` |
| v2 faces | `familyVizFaces` | `viz-v2-faces`, `viz-v2-faces-tab` |
| v2 poster | `familyVizBigTree` | `viz-v2-bigtree`, `viz-v2-bigtree-nav`, then `viz-v2-flips` (one decision per flag) |
| v3 | `familyVizJourneys` | `viz-v3-basemap` (G-map), `viz-v3-csp-worker` (G-csp), `viz-v3-journeys`, `viz-v3-journeys-places`, `viz-v3-journeys-chapters`, then `viz-v3-flip` |
| Tokens | — | `iokit-tokens-viz` (io-kit), then `iokit-tokens-viz-install` (harrisonfamily) |

### 4.9 Tokens finding (for `iokit-tokens-viz`)

- **The MVP needs no new tokens** (measured 2026-10-13; `viz-mvp-visual-perf` AC4 re-checks at build):
  - role badges use the existing `--io-color-semantic-tree-*` pairs (contrast-fixed by HFY-R72);
  - cards use `surface-raised`;
  - the "not recorded" card uses a dashed `border-strong`;
  - focus rings use `focus`;
  - the sheet uses `scrim`;
  - grid union connectors use `border-strong`.
- **Measured contrast** (WCAG 2.2 non-text, at least 3:1 needed). Source: the token values in `11ty/js/islands/shell.css` at harrisonfamily `cf0160b`, built from the pinned @io-kit/tokens 0.4.0. Script and output: `pln2/adr/evidence/viz-measure/contrast.mjs` and `out/contrast-report.json`.

  | Pair | Dark | Light |
  |---|---|---|
  | `border-strong` against `surface-raised` (dashed card border) | 3.78 | 4.08 |
  | `border-strong` against `surface` (card edge on the page) | 4.25 | 3.74 |
  | `focus` against `surface-raised` | 10.17 | 6.22 |
  | `focus` against `surface` | 11.46 | 5.71 |

  Every pair passes; the dashed border has the least margin (3.74 to 4.25). If the tokens pinned at build time lower any pair below 3:1, the MVP needs `iokit-tokens-viz` again (`viz-mvp-visual-perf` AC4).
- **Tokens the DS lacks are needed only later:**
  - two era-band fills (v2, and only if io approves era copy);
  - map overlay point, selected point and life-path line, at 3:1 or better against the Protomaps dark and light flavours (v3).
- **Hence the proposal:** move `iokit-tokens-viz` to those tokens, take it off the MVP path, and put the pin and theme rebuild in `iokit-tokens-viz-install` (section 9). `viz-mvp-visual-perf` re-checks the MVP finding with theme-lint and the same contrast computation against the tokens pinned at build time.

### 4.10 Cloudflare and hosting facts that bind v3

- io's ruling "chat on cloudflare" (2026-10-13, HFY-R77) is locked. The account already has Workers Paid. The zone harrisonfamily.us is on the **Free** plan and has **no Worker routes** today.
- The map needs no Worker and no Workers Paid feature. `map/` is served by S3 and CloudFront's default behaviour through the proxied zone. The chat routes (`/chat/ws*`, `/chat/v1/*`) do not overlap `/map/*`.
- Free-plan limits apply. Each cached file must be 512 MB or less: the z11 extract is about 0.29 GB, so it fits. `.pmtiles`, `.pbf` and `.json` are not cached without a Cache Rule. Range is ignored if Cloudflare must decompress, so files are served without Content-Encoding. Strong ETags may be weakened, so `viz-v3-basemap` checks that two ranged requests return the same ETag.
- The chat CI token is scoped to Workers Scripts and Workers Routes only (chat.md 17.1). So the Cache Rule is created once under G-map, by io or by the orchestrator with io's go-ahead, and recorded with a screenshot. No new CI secret is added.

---

## 5. Budget changes (approved only through the section 8 handoff)

| Budget | viz.md section 11 today | This ADR | Evidence |
|---|---|---|---|
| Chart chunk (lazy) | at most 120 KB gzip | **Navigator chunk: at most 35 KB gzip JS and 15 KB gzip CSS** | Report target. family-chart (46.6 KB) and Topola (46-53 KB) each exceed it (A5, A10). |
| v2 places chunk | at most 250 KB gzip | **Removed.** Replaced by the **v3 map**: maplibre-gl 6.14.0 is about **431 KB gzip** (287 KB main + 144 KB worker) **plus 10.5 KB CSS**, loaded only on the map view. Enforced ceiling for the Journeys chunk set: 460 KB gzip JS (MapLibre main and worker, pmtiles about 8 KB, basemaps about 6.8 KB, our code) and 12 KB gzip CSS. 0 bytes before the map opens. | B4, B8, B9 |
| Island entry (excluding the shared React chunk) | at most 60 KB gzip | unchanged | — |
| v2 lifelines chunk | — | at most 25 KB gzip JS, 5 KB CSS | Own SVG; d3-shape measured at 1.9 KB |
| v2 faces tab chunk | — | at most 15 KB gzip JS, 5 KB CSS | Reuses `surf-photo-tags-ui` |
| v2 poster chunk | — | at most 30 KB gzip JS, 5 KB CSS; no d3-dag module | d3-dag would add 41.9-45.4 KB (A15) |
| v2 kinship UI chunk | — | at most 10 KB gzip JS | — |
| `person/graph.json` gzip | at most 25 KB (231) and 150 KB (2,000) | **unchanged**, now including `layout` and `photoEdges`; the builder's `SIZE_BUDGET` stays at 150 KB | Whole synthetic file with both blocks: 14.3-14.6 KB (231) and 115.7-115.9 KB (2,000) at one tagged photo per person; the 2,000-person file passes 150 KB at about 3 tagged photos per person (3.3) |
| Layout build time (coordGreedy) | — | at most 5 s for 231 people, checked everywhere including CI; at most 60 s for 2,000 people, checked only where `HFY_GRAPH_PERF=1` (the worker and io's machine), never on shared CI runners | Slowest measured runs 1.09 s and 12.9 s on Node 24.10.0, Apple M2 Pro (3.3); not measured on Node 22 |
| Basemap file | — | at most 512 MB per file (z11 is about 0.29 GB) | B12, B14 |
| Focus card time, re-centre long task, CLS, faces | as listed | unchanged. The focus card renders from the **fetched, gated** graph: no inlined data, no service-worker cache. | HFY-R65; section 6 |

A miss fails the test that enforces it (in CI, or in the local suite for the 2,000-person layout time). Changing a number needs an amendment to this ADR, approved by io.

---

## 6. Rejected, modified and deferred, with reasons (AC5)

**Rejected:**

| Item | Reason | Invariant (viz.md 4.1) or source |
|---|---|---|
| Embedding family-chart 0.9.0 | Dormant open-source edition (last code 2025-10-21). A paid proprietary fork. One-finger drag captured by default (its `zoom_polite` option is off by default). About 47 KB gzip against the 35 KB navigator budget. Gender limited to M or F. | 4, 5; A3, A5, A6 |
| Olli at runtime | 3.x pulls in AGPL ua-parser-js 2.x, so Olli is a pattern only | 3; D3 |
| elkjs | 433-467 KB gzip, so excluded for size. EPL in a client bundle would also fail `client-license-gate`. | 5; A17, A19 |
| Cytoscape.js | About 137 KB. Canvas nodes are not buttons. Generic layouts. Pinch and pan. | 4, 5; A27, A28 |
| Sigma 4 + graphology | About 110 KB. WebGL2-only. Built for 10k+ nodes. | 5; A30, A31 |
| deck.gl | 553-576 KB. MapLibre line layers are enough. | 5; B16 |
| MapLibre v5 (every release, including 5.24.0) | CVE-2026-85061 / GHSA-jrc7-96c5-q579, CVSS 10.0, no backport | B6, B7 |
| Who's On First | 886 MB bz2 / 4.2 GB for US admin data; source-by-source licences | C12, C13 |
| d3-flextree | Stale since 2021; duplicates d3-hierarchy v1 | A25 |
| d3-scale | 7.9 KB gzip for one linear scale; last release 2021-09-24 | 3.3 |
| Natural Earth populated places alone; admin1 centroids | Matches 15 of 23 leaf places; admin1CodesASCII has no coordinates | C11, C6 |
| Gramps Web code; webtrees chart modules; Mapbox storytelling on Mapbox | AGPL (R); GPL and PHP (R); keyed and metered (R). These are the report's claims; DOC-363B23B01410 does not check them. Each is rejected anyway, because any GPL or AGPL code fails `client-license-gate` and a keyed API breaks invariant 2. | 3, 2; report only |
| Report: `graph.public.json` for signed-out viewers | No public view; the graph comes only from gated prefixes | 1; viz.md 2 |
| Report: service-worker caching of the graph | Gated data is `private, no-store`; `sw.js` caches the offline shell only | 1; HFY-R65 |
| Report: the page person's data inlined for LCP | The static `/tree/` page is public | 1 |
| Report: an Eleventy-rendered outline as the no-JS fallback, and per-branch "family stories" pages | Both would put family data in public static HTML. The no-JS path is the noscript line pointing to search. | 1 |
| Report: swipe up/down to change generation | Captures one-finger vertical drag (anti-pattern 5); replaced by buttons | 4 |
| Report: graph shape `"v": 3` (`n/g/s/b/d`, `era`, `branch`) and `journeys.json` | Would replace graph v1; only additive changes are allowed | 1 |
| Report: per-person files `/p/<gramps-id>.json` carrying events, stories, notes, full photo lists with tag rectangles `[x,y,w,h]`, and comments | A new, ungated path outside the allowlist projection. viz.md 5.2 never projects notes, free text or rects; person data is served only as the existing gated `person/*.json` and graph.json; comments stay behind the social domain's gated API. | 1; viz.md 5.2, 6 |
| Report: Journeys "chapter configs authored as Markdown front-matter in Eleventy" | Puts family narrative into public static output (the `/tree/` page and its JS are public), as the rejected "family stories" pages would. The io-approved chapter copy is served only from a gated object (4.6, `viz-v3-journeys-chapters`). | 1 |
| Report: "a Node exporter from Gramps (XML or Gramps Web API export)" | A Gramps Web API facade is a BRD2 section 1.2 non-goal. The builder reads `_class`-tagged Gramps JSON lines from a read-only copy or the cloud snapshot (viz.md 5.1, VIZ-D3), so an XML path would duplicate a settled input contract. | 1; BRD2 1.2; VIZ-D3 |
| `decrossOpt` in the layout | NP-complete brute force | 3.3 |
| `coordSimplex` as the poster's coordinate operator | 217 s and 1,750 s at 2,000 synthetic people, against 12.9 s and 8.8 s for `coordGreedy` (17x to 200x slower), for a poster about 11% narrower | 3.3 |

**Modified:**
- Face crops are 160 px only (VIZ-D9), not 96 and 256 px.
- The bottom sheet is the kit `Sheet`.
- URL state is `?focus=I9001` (not the report's hash form).
- Unknown union types read "partner".
- The report's separate `layout.big.json` (d3-dag coordinates) becomes the additive `layout` block inside the gated graph.json (4.7), under invariant 1. If the graph budget is ever missed, a separate gated layout file needs an amendment to this ADR (`viz-graph-v2-layout` AC5).

**Deferred (outside this cut, not rejected):**
- a desktop fan or "roots" poster for gap-finding;
- branch small-multiples beyond the lifeline panels;
- a social rail on cards ("on this day", comments, "contributed by"), which the social and surfaces domains own;
- Scrollama (pin 3.2.0 only if IntersectionObserver falls short);
- a union year (for example an additive `unions[].year`, a minor bump) so lifelines can converge at the marriage year (section 2 row 9). It needs an amendment to this ADR approved by io.

---

## 7. viz.md amendments applied on approval (BRD2 section 11.6)

Each bullet below is one BRD2 section 11.6 item, or a change the same items force elsewhere in viz.md.

- **4.3 Chosen approach.** Replace "To be filled at intake." with: "Q2-13 (sheet Q9), answered by io on the sheet and recorded in this ADR (4.1); the layouts and budgets approved with the ADR (section 8). MVP: Concept A, the Family Card Navigator, a framework-free `<family-navigator>` element in the lazy chart chunk. v2: C-lite lifelines, Faces and a desktop big-tree poster whose layout d3-dag 1.2.2 precomputes at build time; the kinship finder keeps its flag. v3: Journeys on maplibre-gl 6.14.0, pmtiles 4.5.0 and @protomaps/basemaps 5.7.2 over a self-hosted maxzoom-11 PMTiles extract (gate G-map). The hourglass below stays the fallback if io rejects Q2-13."
- **5.1 Package.** `bin/fetch-gazetteer.mjs` stays the only network path, now "(public GeoNames dumps, plus the Natural Earth admin-0 and admin-1 files or the Census State Gazetteer for centroids)". `gazetteer.lock.json` pins the sha256 and retrieval date of every one of those files, not "the 4 GeoNames files".
- **5.2 Privacy projection.** The `events` row's "Residence events of living people are dropped by default (VIZ-D5)" gains "until io's Q2-11(b) answer is recorded on `q2-11-living-city`; the builder then follows that answer".
- **5.3 graph.json.**
  - Add `photoEdges` and `layout` as in ADR 4.7, each an additive minor bump.
  - `source.builder` is written "hfy-graph 0.1.0", not "hfy-graph@0.1.0", because `verify()`'s e-mail check rejects any `@` (ADR 4.7).
- **5.5 Face crops and 5.7 Publishing (BRD2 11.6, first item).** The cloud graph builder (`viz-graph-cloud-source`) skips MOD#-hidden MediaRefs and hidden Media for faces, for `photoEdges` and for the graph, and a hidden primary photo gives `face: null`. The interim builder has no MOD# overlay, so the rule applies from the cloud source on.
- **5.6 Geocoding (VIZ-D6).**
  - 5.6.2: the files are GeoNames `cities1000.zip` (replacing `cities500.zip`), `admin1CodesASCII.txt`, `admin2Codes.txt` and `countryInfo.txt` (CC BY 4.0), plus Natural Earth admin-0 and admin-1 (public domain) or the Census State Gazetteer, each pinned in `gazetteer.lock.json`.
  - 5.6.3: the matcher accepts a parent at admin1 or admin2 and searches alternate names, with an override table.
  - 5.6.3 step 4 ("State and country places get no point in v1") becomes: "State, province and country places take their centroid from Natural Earth or the Census Gazetteer, because admin1CodesASCII has no coordinates; a map may instead fit to the child points."
  - 5.6.4: reviewed coordinates go back into Gramps, or into a reviewed `places.geo.json` kept outside the repo. The credit reads "Place coordinates: GeoNames (geonames.org), CC BY 4.0, modified".
- **6 Data model.**
  - The `tiles/<basemap>.pmtiles` row ("v2, only if the ADR picks raster tiles … needs a new behavior and io gate") becomes: "(v3) `map/<name>-<YYYYMMDD>.pmtiles`, fonts and sprites | io's upload under G-map, outside every `--delete` sync | `GET /map/...` (HTTP range) | CloudFront's default behaviour through the proxied zone, no new behaviour; a Cloudflare Cache Rule; public ODbL basemap with no family data, the one recorded exception to BRD2 1.2".
  - The intro bullet "no `ci.manifest.yaml` exclude change" gains "except `map/*` in v3 (`viz-v3-basemap`)".
  - The v3 chapter copy, if io approves a list, is one more gated object under `person/` (ADR 4.6).
- **11 Budgets.** Replace the chart-chunk and places-chunk rows, and add the rows, as in ADR section 5.
- **14 Flags.** `familyVizPlaces` becomes `familyVizJourneys` (v3). `familyVizFaces` and `familyVizBigTree` are new (v2).
- **18 Decisions.**
  - VIZ-D1 is answered by io's Q9 answer (4.1) and io's approval of this ADR (section 8), both attached verbatim with their dates.
  - VIZ-D6 becomes: "Offline GeoNames cities1000 plus admin1 and admin2 (CC BY 4.0) at build time, with an override table and Natural Earth or Census Gazetteer centroids; Gramps lat/long wins; reviewed coordinates go back into Gramps or a reviewed `places.geo.json` outside the repo."
  - VIZ-D11 becomes maplibre-gl 6.14.0 over a self-hosted PMTiles extract in v3 with gate G-map. There is no SVG places layer in v2.
  - VIZ-D12 also covers the Journeys chapter copy (Q2-14).
- **19 Tasks.** Replace the task list with section 9's re-cut. `iokit-tokens-viz` runs `github_pr_deploy` on `comp-io-kit` (HFY-R15).

**New `viz-mvp-visual` notes:** "Re-cut by the ADR (HFY-TSK-117): this task is the element and the 375 px layout. Desktop, navigation, performance budgets and fallbacks are separate PRs (`viz-mvp-visual-desktop`, `-nav`, `-perf`, `-fallback`). The tokens pin and theme rebuild moved to `iokit-tokens-viz-install`. The MVP needs no new tokens (ADR 4.9, measured against @io-kit/tokens 0.4.0; re-checked in `viz-mvp-visual-perf`)."

---

## 8. Approval: a separate HFY-R10 handoff, not the decision sheet (AC6)

There are two records, kept apart as BRD2 keeps them (the Q2-13 row and the section 2.2 list of go-aheads):
1. **io's answer to sheet item Q9** picks the concept (Q2-13 and Q2-14). It is given on DOC-C31D9E3DD932 and recorded in 4.1.
2. **io's approval of this ADR** is a go-ahead (HFY-R10): the layouts and size budgets for the concept io chose on the sheet, plus the viz.md amendments and the re-cut. It is asked in its own handoff, with its own reply.

**A "defaults ok" on the decision sheet never counts as approval of this ADR,** and neither does any other sheet reply. If io's Q9 answer changes or rejects the concept, this ADR is revised first, and the handoff below is sent only for the revised text.

**The handoff** (sent after io's Q9 answer is recorded) links this ADR and lists, in plain words:
- the concept as io answered Q9 (4.1), and the layouts in 4.5 (desktop and 375 px);
- every budget change in section 5:
  - the navigator chunk at most 35 KB gzip JS and 15 KB gzip CSS, replacing the 120 KB chart chunk;
  - the v3 map at about 431 KB gzip plus 10.5 KB CSS, loaded only on the map view, with a Journeys ceiling of 460 KB gzip JS and 12 KB CSS, replacing the 250 KB places chunk;
  - the new v2 chunk ceilings (lifelines 25 KB, faces tab 15 KB, poster 30 KB, kinship 10 KB);
  - the graph.json budget unchanged with `layout` and `photoEdges` inside it, and what happens if it is missed;
  - the layout time limits (5 s for 231 people everywhere; 60 s for 2,000 people, local only);
  - the basemap at most 512 MB per file;
- the viz.md amendments in section 7 and the re-cut in section 9;
- the prompt record's personal data (1.2): a redacted copy by default, or a verbatim copy if io accepts it.

**io's reply token:** `viz ADR ok` approves the ADR as written; `viz ADR: <change>` asks for a change, after which the ADR is revised and the handoff is sent again.

- **How the approval is recorded.** io's reply goes below, verbatim, with its date. It is also recorded as acceptance evidence on `viz-research-intake` (HFY-TSK-117) and under "Later clarifications" in DOC-2CFAE07B546C. The Q9 answer, not this approval, goes in the `io-policy-decisions` status table.
- **Approval record:** **pending.**
- **What approval unlocks.** After approval:
  - the section 9 re-cut is written into `tasks.json`;
  - viz.md is amended (section 7);
  - `viz-page-shell` and the later UI tasks may be checked out.
- **Until then,** no viz UI task is checked out. The data tasks (W1-W2) are not blocked.

---

## 9. Re-cut proposal (AC7; applied after io approves this ADR in the section 8 handoff; review DL-15, DL-16)

**Shared ACs, referenced by name:**
- **Merge train:** the islands merge-train AC of BRD2 section 10.2, verbatim from today's viz tasks.
- **Audit(flag):** a D-11 audit at 375, 768 and 1280 is green with `?hfy_flags=<flag>`. It is evidence for the flip task, and the task does not flip the flag.
- **Island suites:**
  - `cd islands && npm run build && npm run check:islands`
  - `npm run test:contract`
  - `npm test`
- **Graph suite:** `cd graph && node --test`.

Every harrisonfamily task is `github_pr_deploy`, `site-ci`, `ci-on-merge`, unless stated otherwise. The first half of a split keeps the original key.

### 9.1 MVP: `viz-mvp-visual` split into five PRs, plus the install side of the tokens

| Key | Size | Depends on | Component |
|---|---|---|---|
| `viz-mvp-visual` | 2-3 d | viz-outline-navigator, client-license-gate | comp-hfy-eleventy-site |
| `viz-mvp-visual-desktop` | 1-2 d | viz-mvp-visual | same |
| `viz-mvp-visual-nav` | 1-2 d | viz-mvp-visual | same |
| `viz-mvp-visual-fallback` | 1 d | viz-mvp-visual | same |
| `viz-mvp-visual-perf` | 1 d | viz-mvp-visual-desktop, viz-mvp-visual-nav, viz-mvp-visual-fallback | same |
| `iokit-tokens-viz-install` | 0.5-1 d | iokit-tokens-viz (closed, version listed in CodeArtifact) | same |

`viz-mvp-flip` depends on `viz-mvp-visual-perf` (and, through it, all five) and `viz-graph-publish`. The MVP no longer depends on `iokit-tokens-viz` (4.9).

**`viz-mvp-visual`: the `<family-navigator>` element and the 375 px layout**
1. `islands/src/lib/family-navigator.js` defines `<family-navigator>`: light DOM, no React, no third-party runtime module (the bundle test lists only our modules; family-chart absent). The lazy `ChartView` imports it, sets `graph` and `focus` as properties, and handles the `hfy-focus` and `hfy-details` CustomEvents.
2. At 375 px it renders:
   - the focus card: face or initials, name, years in words ("about 1880", "years unknown"), and one place line from the real place chain;
   - a parents strip, with a dashed "parent not recorded" card or "parents not recorded yet";
   - one tab per union ("with <partner>", or "partner not recorded");
   - that union's children as a row with native scroll-snap;
   - siblings, with "half-" badges;
   - text badges for adopted, step and foster from the per-parent `rel`.
3. `hfy-details` opens the kit `Sheet` (rendered by the island) with years, places, unions, children and "view page".
4. A pure `navigatorModel(graph, focus)` is node-tested on the messy fixture: two partner families, a mother-only union, a parentless sibling group, every `rel` value, a disconnected person, a private-excluded person, and approximate and unknown years.
5. `tree.spec.mjs` at 375 px:
   - every card is a `<button>` named like "Ben Example, father, 1878 to unknown";
   - names are at least 16 px and targets at least 44 px;
   - no horizontal page scroll at 320 or 375 (the children row scrolls inside itself);
   - axe reports 0 serious or critical issues in the cards view.
6. Merge train.

**`viz-mvp-visual-desktop`: the four-row grid**
1. From 64rem the element renders four rows: grandparents (up to 4, with "not recorded" cards), parents, the focus family (siblings beside the focus card, the selected partner beside it, other unions as tabs) and children. The viz.md 9.1 detail panel shows the focus person.
2. From 43rem to 64rem: two columns, with the outline in the kit `Sheet` behind a "generations" button.
3. There is no pan or zoom. A row wider than its column shows the first cards and a "+N more" button that expands in place. No name renders below 16 px.
4. `tree.spec.mjs` at 768 and 1280: axe clean, 44 px targets, keyboard-only re-centre three times. Screenshots at 768 and 1280 are attached.
5. Merge train.

**`viz-mvp-visual-nav`: buttons, touch, keys, motion and announcements**
1. Visible buttons cover every direction: to parents, to children, previous and next sibling, previous and next partner family. Tapping a card re-centres. `?focus` and back/forward go through `TreeApp`'s single history handler.
2. Touch:
   - only horizontal movement inside the children row and the tabs is handled;
   - the element sets `touch-action: pan-y`;
   - a Playwright touch test shows that a vertical drag starting on a card scrolls the page.
3. Arrow keys move focus between cards (up to parents, down to children, left and right across siblings and partner families). Enter or Space re-centres. There are no single-character shortcuts. After a re-centre, focus moves to the new focus card's heading.
4. Transitions take at most 250 ms. With `prefers-reduced-motion: reduce` they are fades or instant, tested with `emulateMedia`.
5. The island's one polite live region announces "centred on X: 2 parents, 1 partner, 3 children". The element adds no second region.
6. `data-navigator@3.0.0` is added only if this model needs it, with its `client-license-gate` override in the same PR and the budget test still green. Olli is not added.
7. Merge train.

**`viz-mvp-visual-fallback`: failure and fallback states**
1. If the lazy import rejects, or `customElements.define` throws, the page shows outline-only mode with "the chart didn't load. the outline below has everything." (`CHART_CHUNK_FAILED`). The outline is complete without the chunk.
2. The `cards | outline` toggle works at every width. `?view=outline` and `localStorage["hfy:tree-view"]` (read and written in try/catch) are honoured, and the noscript line stays.
3. The viz.md section 7 states keep working with the cards view: 401 refreshes once and then signs in with `returnTo`; 403 or 404 shows "being prepared"; a bad schema shows retry. Each is a test.
4. A face that fails to load becomes initials with no layout shift (CLS test).
5. Merge train.

**`viz-mvp-visual-perf`: the ADR budgets**
1. `tree-budget.test.mjs` asserts:
   - the navigator chunk is at most 35 KB gzip JS and 15 KB gzip CSS;
   - the island entry is at most 60 KB gzip, excluding the shared React chunk;
   - the old 120 KB chart-chunk line is removed.
2. `tree-perf.spec.mjs` runs on synthetic graphs of 231 and 2,000 people (`graph-synth.mjs`, invented names), with 4x CPU and slow 4G. It asserts:
   - a visible focus card within 2.5 s (231) and 3.5 s (2,000);
   - a re-centre long task of at most 100 and 200 ms;
   - CLS at most 0.05;
   - at most 24 face requests in the first view, each at most 8 KB.
3. A test proves that the built `11ty/tree/index.html` holds no person data and that `11ty/sw.js` has no `/person/` route.
4. theme-lint passes, and the contrast computation of ADR 4.9 (`contrast.mjs`, or the kit's own contrast helper if one exists by then), run against the tokens pinned at build time, shows at least 3:1 in dark and light for the dashed `border-strong` card border against `surface-raised` and `surface`, and for the `focus` ring against both. The ADR measured 3.74 to 11.46 on @io-kit/tokens 0.4.0. Otherwise this task records that `iokit-tokens-viz` is needed for the MVP, and the dependency is restored.
5. Merge train.

**`iokit-tokens-viz-install`: pin and theme rebuild (moved out of `viz-mvp-visual`)**
1. If `iokit-tokens-viz` published @io-kit/tokens 0.4.3, the islands pin it exactly and `hfy-theme.css` is rebuilt. theme-delivery and theme-lint pass, and before/after screenshots of two existing pages at 375 and 1280 show no regression.
2. Install discipline:
   - the package.json diff changes only `@io-kit/tokens` and lowers no pin;
   - the lockfile is regenerated with a local CodeArtifact token;
   - `npm ci` from the committed lockfile passes.
3. If `iokit-tokens-viz` closed as not needed, this task closes as not needed with that evidence.
4. Merge train.

**`iokit-tokens-viz` (re-scoped; keeps its kit-release ACs):**
- Its tokens are the two era-band fills (only if io approves era copy) and the map overlay point, selected point and life-path line. Each is checked against the Protomaps dark and light flavours at 3:1 or better.
- Its dependants are `iokit-tokens-viz-install`, then `viz-v2-time-eras` and `viz-v3-journeys-places`.

### 9.2 v2 and v3: confirmed or re-cut into 1-3 day tasks

| Original | Verdict | Tasks after re-cut (size) |
|---|---|---|
| `viz-graph-v2-data` | Re-cut | `viz-graph-v2-data` (photoEdges, 1 d); `viz-graph-v2-layout` (2-3 d) |
| `viz-v2-time` | Re-cut | `viz-v2-time` (desktop lifelines, 2-3 d); `viz-v2-time-phone` (1-2 d); `viz-v2-time-eras` (0.5-1 d, Q2-14) |
| `viz-v2-kinship` | Re-cut | `viz-v2-kinship` (engine, 1.5-2 d); `viz-v2-kinship-ui` (1-2 d) |
| `viz-v2-faces` | Re-cut | `viz-v2-faces` (chips, 1 d); `viz-v2-faces-tab` (2 d) |
| `viz-v2-bigtree` | Re-cut | `viz-v2-bigtree` (poster render, 2 d); `viz-v2-bigtree-nav` (1-2 d) |
| `viz-v3-basemap` | Re-cut | `viz-v3-basemap` (extract, upload, cache rule, runbook; 2 d plus G-map); `viz-v3-csp-worker` (1 d plus a report-only soak, G-csp) |
| `viz-v3-journeys` | Re-cut | `viz-v3-journeys` (map shell, 2-3 d); `viz-v3-journeys-places` (2-3 d); `viz-v3-journeys-chapters` (1-2 d) |

**Flip dependencies:**
- `viz-v2-flips` depends on `viz-v2-time-phone`, `viz-v2-time-eras`, `viz-v2-kinship-ui`, `viz-v2-faces-tab` and `viz-v2-bigtree-nav`.
- `viz-v3-flip` depends on `viz-v3-journeys-chapters`.

**`viz-graph-v2-data`: photoEdges** (comp-hfy-graph; graph suite; depends on viz-generation-index, viz-research-intake)
1. `build.mjs` emits `photoEdges` as in ADR 4.7. The schema gains it as optional, the `minor` is bumped, and `additionalProperties` stays false.
2. It skips private Media, private MediaRefs, `RECT_INVALID` rects and excluded people, and emits no handles, rects, paths or notes. `viz-graph-cloud-source` reuses `build.mjs` and also skips MOD#-hidden MediaRefs and Media.
3. Fixtures:
   - a photo with a private MediaRef has no edge;
   - a photo whose only tag is private emits nothing;
   - shuffled input gives byte-identical output.
4. `size.test.mjs` passes the unchanged budgets (at most 25 KB at 231 and 150 KB at 2,000), `build-graph.mjs --verify` passes on the staged file, and the graph suite is green.

**`viz-graph-v2-layout`: the d3-dag layout block** (comp-hfy-graph; graph suite; depends on viz-generation-index, viz-research-intake)
1. `graph/` pins d3-dag 1.2.2 exactly as a build-time dependency. Its dependencies (javascript-lp-solver under Unlicense, quadprog, stringify-object, d3-array) appear in no islands or chat-worker lockfile.
2. `build.mjs` emits `layout` as in ADR 4.7:
   - ranks from the generation index;
   - `layeringSimplex` with rank constraints, `decrossTwoLayer` and `coordGreedy` (never `coordSimplex`, which took 217 s and 1,750 s at 2,000 synthetic people, and never `decrossOpt`);
   - only components with at least 2 people;
   - integer coordinates, and bend points only for links that span more than one layer.
3. GRAPH_CYCLE members (`generation: null`) are filtered before layout. A test proves it, because d3-dag 1.2.2 lays out a cyclic graph without error.
4. A messy fixture (two partner families, mother-only, parentless siblings, birth plus adoptive parents, pedigree collapse, a second component, a cycle) gives each person once, no two nodes at one position, every generation on one layer, and byte-identical output for shuffled input.
5. Budgets, on synthetic graphs from a seeded generator like ADR 3.3's (`graph-synth`, invented names):
   - graph.json gzip including `layout` stays within 25 KB at 231 people and 150 KB at 2,000, run everywhere;
   - layout time stays within 5 s at 231 people, run everywhere, CI included;
   - layout time stays within 60 s at 2,000 people, in a test that runs only when `HFY_GRAPH_PERF=1` (the worker and io's machine) and is skipped on shared CI runners. Its measured time and Node version are recorded as acceptance evidence, because ADR 3.3 measured Node 24.10.0, not Node 22.
   - A miss fails the build or the test. The remedy is an ADR amendment (for example a separate gated layout file), not a silent change.
6. `verify()` still rejects day-precise dates, emails, phone numbers and URLs, and runs on the emitted graph with the `layout` block:
   - `engine` is "d3-dag 1.2.2" (no `@`), and a test asserts that no string in the block contains `@` or matches the date pattern;
   - `source.builder` is "hfy-graph 0.1.0" (viz.md 5.3 as amended);
   - a test feeds a block with "d3-dag@1.2.2" and expects PRIVACY_VIOLATION (exit 4).
   The interim publisher picks up the block at io's next refresh with runbook step 2b unchanged.

**`viz-v2-time`: desktop lifelines** (island suites; depends on viz-mvp-flip)
1. A lazy `tree-lifelines` chunk: our own SVG renderer, with d3-shape 3.2.0 optional and exact-pinned, and no d3-scale. It stays within 25 KB gzip JS and 5 KB CSS (budget test).
2. The per-person and per-family strip:
   - a decades axis;
   - partners converge at "about" the first child's birth year, else not at all. Graph v1 events carry no union id, so a marriage year is not used until an additive union year exists (ADR section 2 row 9, section 6 deferred). A fixture with a person in two unions shows each union converging at its own first child;
   - children start from the union;
   - uncertain ends fade (TimeNets);
   - approximate years are in words;
   - a one-event person is a dot;
   - living people run to today with the birth year only.
3. At most 40 lines per view. Beyond that, sub-branches collapse into a "+N more in <name>'s family" button.
4. Each lifeline is a button with an accessible name. Choosing it opens the navigator on that person.
5. Decades only. No era bands here.
6. Merge train.

**`viz-v2-time-phone`: phones and the table equivalent** (depends on viz-v2-time)
1. Below 43rem, time runs down the screen, one branch per panel, with previous and next buttons. No gesture is required, and there is no horizontal page scroll at 320 or 375.
2. A table view (person, born, died, events) is the screen-reader path, reachable from the view toggle.
3. Audit(`familyVizTime`).
4. Merge train.

**`viz-v2-time-eras`: era bands from io's copy (Q2-14)** (depends on viz-v2-time, iokit-tokens-viz-install)
1. Bands render only from an io-approved copy list: a data file of name, start year, end year and a one-sentence note, attached with io's verbatim approval and its date. Without the list, the task closes "decades only" and nothing renders.
2. Bands are labelled in text (never colour alone), with labels at 4.5:1 or better and boundaries at 3:1 or better. Choosing a band opens its note in the kit `Sheet`.
3. There is a test with the list and a test without it.
4. Merge train.

**`viz-v2-kinship`: the kinship engine** (depends on viz-page-shell; pure logic, no flag, can start early)
1. `family-graph.js` gains `relationPaths(a, b)`: every shortest path through common ancestors, over parent and partner links. It runs within 50 ms at 2,000 synthetic people in node.
2. `relationLabel` passes a 30-case table:
   - ancestors to third great-grandparents, siblings and half-siblings, aunts and uncles including great-;
   - first to third cousins and removed, step-, adopted, in-law through a partner;
   - pedigree collapse with two paths;
   - no relation, and "not yet connected".
3. Labels use the lowercase DS voice and are never derived from colour. The graph suite and the island suites are green.

**`viz-v2-kinship-ui`: "how are we related?"** (depends on viz-v2-kinship, viz-mvp-flip)
1. For signed-in members with `familyVizKinship`, a pill shows a vertical chain of cards from the viewer up to the common ancestor and down to the person, ending in one plain sentence. With pedigree collapse, both paths are listed.
2. The "my grandparents" and "my cousins" shortcuts re-centre the navigator. Every card is a button. The chunk is at most 10 KB gzip.
3. Audit(`familyVizKinship`).
4. Merge train.

**`viz-v2-faces`: "pictured with" chips** (depends on viz-mvp-flip, viz-graph-v2-data)
1. With `familyVizFaces`, the details sheet shows "pictured with" chips from `photoEdges`, as buttons that re-centre.
2. A fixture with a private MediaRef shows no chip.
3. Merge train.

**`viz-v2-faces-tab`: the faces tab** (depends on viz-v2-faces, surf-photo-tags-ui)
1. A faces tab on `/tree/` (no new page) shows a mosaic of 160 px crops grouped by photo. Choosing a face highlights every photo that person is in.
2. Opening a photo uses `surf-photo-tags-ui`'s tag display (containedRect, hover, tap, keyboard), not a second implementation.
3. On phones the mosaic is a two-column grid, and "people in this photo" outlines the regions on tap.
4. 44 px targets, axe clean, at most 24 lazy faces in the first view (each at most 8 KB), and the chunk at most 15 KB gzip.
5. Audit(`familyVizFaces`).
6. Merge train.

**`viz-v2-bigtree`: the poster render** (depends on viz-mvp-flip, viz-graph-v2-layout, viz-v2-kinship)
1. From 64rem, with `familyVizBigTree`, a "whole family" view draws the `layout` block as SVG:
   - person cards as buttons that open the navigator;
   - union nodes as small connectors;
   - elbow links from coordinates and bend points.
   Below 64rem the view is not offered.
2. A pedigree-collapsed person appears once, with an "also your ancestor through …" badge from `relationPaths`.
3. Names never render below 16 px. At a zoom where a name would, the card shows its face or initials only, and the name stays in the accessible name and in a hover or focus label.
4. Without a `layout` block, the view shows "the whole-family view is being prepared" and loads nothing more.
5. The chunk is at most 30 KB gzip, and the bundle test shows no d3-dag module.
6. Merge train.

**`viz-v2-bigtree-nav`: zoom, pan and minimap** (depends on viz-v2-bigtree)
1. Buttons for zoom in, zoom out, fit, reset to the viewer and a minimap do everything a gesture does.
2. Input handling:
   - the wheel zooms only with Ctrl or Cmd;
   - mouse drag pans inside the poster region only;
   - touch input on wide tablets never pans or zooms the poster, and the page scrolls (`touch-action: pan-x pan-y`, tested).
3. Keyboard users move between cards with Tab, and the focused card is scrolled into view.
4. Audit(`familyVizBigTree`) at 1280 and 1920, plus 375 where the view is absent.
5. Merge train.

**`viz-v3-basemap`: extract, upload, Cache Rule, runbook** (orchestrator; infra-script; comp-hfy-docs, comp-hfy-infra; depends on viz-research-intake)
1. A dry run first, then the real extract:

   ```sh
   pmtiles extract https://build.protomaps.com/<YYYYMMDD>.pmtiles <region>-<YYYYMMDD>.pmtiles \
     --region=<region>.geojson --maxzoom=11 --dry-run
   ```

   Then the same command without `--dry-run`.
   - The file is about 0.29 GB, and no file exceeds 512 MB. If z12 is ever needed, the extract is split per region.
   - The region GeoJSON is coarse (whole states and metro areas, no place points) and is kept with the extract, outside the repo.
   - The build date, size and sha256 are recorded.
2. Under G-map, the extract, the basemaps-assets fonts (OFL) and sprites/v4 (MIT) are uploaded under `map/` in harrisonfamily-frontend, with versioned names and no Content-Encoding. `map/` holds only the public ODbL basemap (the recorded exception to BRD2 1.2).
3. `ci.manifest.yaml` excludes `map/*` from the site deploy. The workflows are re-rendered with `io-kit-ci render`, and `io-kit-ci check` is clean.
4. A Cloudflare Cache Rule on the Free-plan zone caches `/map/*.pmtiles`, `*.pbf` and the style JSON. It is created once under G-map, by io or by the orchestrator with io's go-ahead, outside the chat CI token's scope, and recorded with a screenshot.
   - Evidence: a ranged request returns 206 with the requested bytes, and a repeat shows a cache HIT with the same ETag.
5. `docs/how-to/rebuild-the-basemap.md` covers the dry run, the extract, the versioned upload, the cache rule and the rollback (repoint to the previous file name).

**`viz-v3-csp-worker`: CSP `worker-src 'self'`** (infra-script; depends on site-csp-headers)
1. The CloudFront CSP gains `worker-src 'self'` (not `blob:`) for MapLibre's module worker:
   - report-only first, with the Playwright crawl at zero violations;
   - then enforced, through the G-csp go-ahead.
2. The rollback is recorded, and io's go-ahead is recorded verbatim.

**`viz-v3-journeys`: the map shell** (island suites; depends on viz-mvp-flip, viz-v3-basemap, viz-v3-csp-worker)
1. A lazy Journeys chunk set loads maplibre-gl 6.14.0 (exact pin, never v5), pmtiles 4.5.0 and @protomaps/basemaps 5.7.2 only when the map view opens:
   - at most 460 KB gzip JS (MapLibre about 431 KB) and 12 KB CSS;
   - nothing on `/tree/` before that, proven by bundle and network tests.
2. `maplibre-gl-worker.mjs` is served beside the island module (or set with `setWorkerUrl`). Tiles, glyphs and sprites come only from same-origin `map/`, and a network test shows no third-party request.
3. `GPUInitializationError` and the map's `error` event fall back to the outline's places list, tested with WebGL2 removed.
4. The map shows the family's geocoded places as points, fitted to them.
5. Attribution strings are static and written by us: "© OpenStreetMap" always, and the GeoNames credit whenever `attribution.geonames` is true. The OFL and MIT notices are on the credits line.
6. Merge train.

**`viz-v3-journeys-places`: places, decades and life paths** (depends on viz-v3-journeys, q2-11-living-city, iokit-tokens-viz-install)
1. A decade scrubber (buttons, plus a keyboard-operable slider) lights up each decade's places.
2. A place sheet lists people as cards that open the navigator.
3. "Follow this person" draws a life path as a MapLibre line layer, drawn once (no particles, no deck.gl). Residence years snap to decades with "about" labels.
4. A fixture asserts io's recorded Q2-11(b) answer, read from `q2-11-living-city` (sheet Q3), not a hard-coded rule. Under the default (dropped at build time, never on the family map), living people's residence events are absent from the published graph and never drawn. Under any other answer, the fixture asserts exactly what that answer allows, and this ADR is amended before the task is checked out. The outline's places list is the screen-reader equivalent.
5. Merge train.

**`viz-v3-journeys-chapters`: chapters with io's copy (Q2-14)** (depends on viz-v3-journeys-places; also touches `graph/`, so the graph suite runs too)
1. Chapters render only from an io-approved chapter copy list, attached with io's verbatim approval and its date. Without it, the task closes with the decade scrubber only.
2. Where the copy lives: the approved list is kept with io's data outside the repo (never in Git, CI, Eleventy front matter, `_data` or any public HTML or JS). The graph build publishes it as a gated object under `person/` (for example `person/journeys-chapters.json`, through `build-graph.mjs --chapters <file>`), served by the existing `/person/*.json` behaviour and edge gate with `private, no-store`. The island fetches it only when the map view opens.
3. A test proves that the built `11ty/tree/index.html` and every tree and Journeys island JS file contain none of the fixture's chapter copy, and a network test shows the copy arriving only from the gated path.
4. Chapters are triggered by native IntersectionObserver. Camera moves are cuts under reduced motion, and nothing is animated as flying arcs.
5. Audit(`familyVizJourneys`).
6. Merge train.

---

## 10. Trace to the ACs of `viz-research-intake`

The numbering follows the 8 ACs of `viz-research-intake` in `tasks.json`.

| AC | Where | Open after this draft |
|---|---|---|
| 1. Research and verification linked to HFY-PLN-002; the banner points to the verification; every corrected or refuted claim (section 2 items 1-6) carried with its corrected value | 1.1, 1.3 (items 1-6, plus the other A-E corrections and E4/E6) | The orchestrator applies the 1.1 patches at storage |
| 2. Data claims checked against viz.md section 1; contradictions listed | 2 | — |
| 3. Library table (licence, last release, gzip, phone) plus messy-genealogy scoring for the navigator and the d3-dag layout; extra packages measured the same way (npm view plus a scratch esbuild bundle, never in the repo) | 3.1, 3.2, 3.3; evidence in `pln2/adr/evidence/viz-measure/` | — |
| 4. Docstore ADR records io's Q2-13 answer from the sheet (item Q9) with every required element | 0, 4.1-4.10 | io's verbatim Q9 answer (4.1) |
| 5. Rejected list with reasons (family-chart, Olli at runtime, elkjs, Cytoscape, Sigma 4, deck.gl, MapLibre v5, Who's On First); data-navigator@3.0.0 named; every later recommendation that breaks a viz.md 4.1 invariant listed as rejected | 6 (including the per-person files, Markdown chapter configs and the Gramps exporter), 0 | — |
| 6. io approves the ADR through a handoff, including the budget changes; viz.md 4.3, 5.6, 11, 14 and 18 amended as BRD2 11.6 lists; no UI checkout before | 5, 7, 8 | io's approval in its own handoff (`viz ADR ok`), never a sheet "defaults ok"; applying the section 7 amendments |
| 7. v2 and v3 tasks and `viz-mvp-visual` confirmed or re-cut into 1-3 day tasks with concrete ACs before any UI checkout; tokens pin and theme rebuild on the install side of `iokit-tokens-viz` | 9 | Written into `tasks.json` after approval |
| 8. The intake records which prompt produced DOC-E61DCBFAFA5F; DOC-363B23B01410's reconciliation meets the rerun-or-reconcile rule, so no rerun | 1.2 | The orchestrator stores the prompt (redacted by default) as a doc |

---

## Review notes

All 13 review findings were applied; none was shown to be wrong. Where the fix differs from the reviewer's wording, or the re-check found something new, it is noted here.

1. **Approval vs "defaults ok"** (medium). Applied as asked: 4.1 records only the Q9 answer and quotes the sheet default exactly; the chapter-copy condition is a separate line; section 8 is a separate HFY-R10 handoff with its own token (`viz ADR ok` / `viz ADR: <change>`) and says plainly that a sheet "defaults ok" never counts.
2. **Banner** (medium). Applied. The reviewer's text said the area C claims "come from the prompt and the plan". The ADR says only what was checked: they are not claims of this text, which has no geocoding section (grep of DOC-E61DCBFAFA5F finds no GeoNames, gazetteer or Natural Earth mention). The fan-chart, GeneaQuilts and Mapbox-template rows were added to the unverified list.
3. **Q2-11(b)** (medium). Applied in section 2 row 13, 4.4, 4.6, the viz.md 5.2 amendment (section 7) and `viz-v3-journeys-places` AC4.
4. **AC5 completeness** (medium). Applied: three rejected rows, one "Modified" entry, and the gated storage plus no-copy-in-public-output test in `viz-v3-journeys-chapters`. Section 0 now counts nine rejected report proposals.
5. **`@` in `layout.engine`** (low). Applied as "d3-dag 1.2.2", with `source.builder` amended to match and a negative test in `viz-graph-v2-layout` AC6. Also noted: a version shaped like "1.10.12" would match verify()'s date pattern.
6. **Prompt record** (low). Confirmed and applied: the stored line 17 reads "at most 3 levels, in 4 countries"; `patch -R --dry-run` on a scratch copy fails 3 of 6 hunks (lines 11, 15-19, 45-46); item 4 is now "weak, not counted". Line 6 holds real ancestors' names, birth years and parishes. The storage default is a redacted copy, and a verbatim copy needs io's acceptance (section 8).
7. **Library table** (low). Applied. sharp 0.35.5 was published 2026-09-27. For @protomaps/basemaps, `npm view --offline` returns ENOTCACHED because only the abbreviated document is cached. That document gives `latest` 5.7.2 and `modified` 2026-03-10 but no per-version time, so the row says "about 2026-03-10" and `viz-v3-journeys` confirms the exact date at checkout.
8. **Measurements** (low). Applied, with three deviations:
   - The evidence is under `pln2/adr/evidence/viz-measure/`, not the verify directory, because this pass may write only under `pln2/adr/`.
   - Node 22 is not installed on this machine, so the Node 24.10.0 caveat is stated. The limits are now 5 s (231 people, everywhere) and 60 s (2,000 people, local only behind `HFY_GRAPH_PERF=1`), each about 4.6x the slowest run.
   - **New finding:** the re-run did not reproduce the first draft's unsaved figures. coordSimplex took 217 s and 1,750 s at 2,000 synthetic people (two seeds), against 12.9 s and 8.8 s for coordGreedy, so the operator changes to coordGreedy (4.7, section 6, `viz-graph-v2-layout`). photoEdges was measured. At 2,000 people the whole graph passes the 150 KB budget at about 3 tagged photos per person; the size test catches this, and the remedy is an ADR amendment. The d3-dag "parentless siblings" cell was reworded, because without ranks the 0-partner union did not float to the top layer; generation 0 split across layers instead (`messy-norank.mjs`).
9. **Tokens** (low). The reviewer offered two fixes; this pass measured instead of marking the finding provisional. On @io-kit/tokens 0.4.0 (as built in `11ty/js/islands/shell.css` at `cf0160b`), every pair is between 3.74 and 11.46. The repo has no contrast helper, so the computation is `contrast.mjs`, and `viz-mvp-visual-perf` AC4 re-checks it at build time.
10. **viz.md amendments** (low). Applied: BRD2 11.6's hidden-MediaRef/Media item, the VIZ-D6 row, 5.1, 5.6.2, 5.6.3 step 4, 5.6.4, and the section 6 data-model row plus its "no `ci.manifest.yaml` exclude change" bullet.
11. **Lifeline convergence** (low). Applied the first-child fallback. The marriage-year rule waits for an additive union year, listed as deferred, with a two-union fixture in `viz-v2-time` AC2.
12. **AC numbering** (low). Applied: 8 trace rows, the 1.2 heading is AC8, and the section headings carry their AC numbers.
13. **Corrected claims carried** (low). Applied: E4 and E6 in 1.3, and `zoom_polite` in 1.3, 3.1 and section 6.
