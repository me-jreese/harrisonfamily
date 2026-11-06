# HFY-PLN-002 addendum: the person page keeps a visual tree (the hourglass)

| field | value |
|---|---|
| Task | HFY-TSK-379 (design only) |
| Ruling | P2-R117, io, 2026-11-05 |
| Amends | `viz.md` (§4.3 fallback, §10 item 4, §14 flags, §16 step 6, VIZ-D1) and `viz-adr.md` (4.1 fallback row). Their text stays as history; each carries a pointer here. |
| Inputs | The viz ADR's recorded Q2-13 fallback (`viz-adr.md` 4.1, `viz.md` §4.3), io's design-session brief (docstore DOC-E55A13E60E53) |
| Status | Decision recorded. Layouts and mockups are not drawn yet; io approves them in a design session before any build. |

All people, ids and places in examples are invented. This record holds no real name, date or Gramps id.

## 1. Context

`viz.md` and the viz ADR planned the person page like this:

- The Graphviz SVG per person (`media/tree_<gramps-id>.svg`, 231 files) is a legacy feature, frozen since the 2026-11-05 cutover, because the legacy generator refuses to run without `--legacy-break-glass`.
- A card-based mini focus view (flag `familyVizPersonMini`, built in HFY-TSK-289) would replace the Graphviz frame on the person page.
- The Graphviz frame, the flip of `familyVizPersonMini`, the runbook handoff and the counted break-glass delete of `media/tree_*.svg` would then retire last (HFY-TSK-290).

io reviewed that plan on 2026-11-05 and did not accept its consequence: a family tree you can see at a glance would disappear from the person page.

## 2. The decision

io's words, quoted once (P2-R117, 2026-11-05):

> are we getting rid of the old svg trees? i like the card view, but a visual tree is a pivotal part of the app. users like to see one visual for 2 generations of ancestors and descendants. ... update the design so that we see a small version of the tree that can be expanded. this does not replace the new card based features. users get both.

The decision, in the design's terms:

- The person page gets a **small, expandable, native visual tree**: the hourglass. It is the viz ADR's recorded Q2-13 fallback, now built for the person page and shipped beside the cards, not instead of them.
- The **card views stay and ship**: cards, outline, lifelines, table, faces, kinship and the poster. Nothing in `viz.md` or the ADR about them changes.
- The Graphviz retirement waits for the hourglass (section 7).

## 3. What the hourglass is

**Small view.** The person in the middle. Two generations of ancestors above, two of descendants below. Partners beside the person. Siblings in a collapsed row. All of it is real DOM or SVG buttons, drawn from the published graph, so every node can take focus.

**Expanded view.** One control expands it in place, on the same page, to a larger view with:

- photos on the nodes (the graph's face crops, initials where there is none);
- zoom buttons;
- re-centre on tap: choosing a person makes that person the middle;
- one-tap links to the cards, to "how are we related?" and to the whole-family poster.

**Links appear only when their target exists.** The cards link needs `familyViz`. "How are we related?" needs `familyVizKinship`. The poster needs `familyVizBigTree` and a graph with a `layout` block. A link to a surface whose flag is off is not shown.

**Data.** The hourglass reads the published graph (`/person/graph.json`) and nothing else: `people` (names, years, `face`), `unions` and `edges` (the shape), `photoEdges` (photos shared between people) and `layout` (only to decide whether the poster link is offered). The list is a ceiling, not a requirement; the approved mockups decide which fields are used. No field of the graph changes, and there is no new API route (VIZ-D2).

**Engine.** The starting point is the ADR's fallback: a small permissive tidy-tree layout, one tree for the ancestors and one for the descendants, rendered as DOM or SVG buttons (`viz-adr.md` 4.1 and 3.2). The licence rule of `viz.md` §4.1 holds (MIT, BSD, ISC or Apache-2.0 only), and so does the rule that nothing is sent to a third party. A hand-written layout of five rows is allowed if it fits the budget. The mockups and the build task choose.

## 4. The flag

| flag | default | gates | dependencies |
|---|---|---|---|
| `familyVizHourglass` | `false` | The person page's small, expandable visual tree | `familyViz` |

- Planned by HFY-TSK-379. The build task adds the key to `11ty/_data/flags.json`; this record does not.
- It follows HFY-R8: default off, flipped only after the D-11 audit and io's approval, and a global flip needs io's G-prod approval (`AGENTS.md`).
- Preview uses the session-scoped override, `?hfy_flags=familyViz,familyVizHourglass` (HFY-R42, HFY-R58).
- The hourglass is a lazy chunk on the person page. With the flag off, or the chunk failing, the page is as it is without it, and requests nothing.

## 5. Budget and accessibility

**Budget.** The hourglass chunk (small and expanded views together, excluding the shared React chunk the shell already loads) is at most **25 KB gzip of JS and 5 KB of CSS**. This is the ceiling of the lifelines chunk (`viz.md` §11). A bundle test enforces it the way the other chunk ceilings are enforced, and changing the number needs an amendment approved by io. The face rule of §11 holds: at most 24 face requests in the first view, lazy, each at most 8 KB.

**Accessibility.** The D-11 and WCAG 2.2 AA budgets of `viz.md` §12.1 apply, with these rules made explicit for this view:

- **Real buttons.** Every node is a `<button>`. No clickable `<div>` or SVG shape without a role and a name.
- **Names carry the relationship.** An accessible name reads like "Ben Example, father, 1878 to unknown" (`viz.md` §12.2). The role is never carried by colour alone.
- **Sizes.** Names are at least 16 CSS px. Every target is at least 44 by 44 CSS px. Where a name cannot fit at 16 px, the node shows the face or initials and the name stays in the accessible name.
- **No gesture-only control.** Expand, collapse, zoom in, zoom out, fit and re-centre all have buttons (WCAG 2.5.1, 2.5.7). Pinch and drag may exist, but nothing needs them. There are no single-character shortcuts (WCAG 2.1.4).
- **Phones.** `viz.md` §4.1 invariant 4 holds: the small view fits the page width, with no horizontal page scroll at 320 or 375 px, and the expanded view pans inside its own region.
- **Colour.** Role colours come from the existing `--io-color-semantic-tree-*` pairs (`focus`, `parent`, `grandparent`, `sibling`, `spouse`, `child`, `grandchild`, each with its `-ink`). A new token is added only with a 3:1 non-text contrast case, and io approves the design-system amendment (the HFY-R72 precedent, `viz.md` §13).
- **Focus and announcements.** Focus is always visible. After a re-centre, focus moves to the new middle node, and one polite live region announces it ("centred on Ada Example: 2 parents, 1 spouse, 3 children").
- **Reduced motion.** With `prefers-reduced-motion: reduce`, expanding and re-centring are instant.
- **A text path stays.** The view is supplementary: a labelled region ("family tree of Ada Example. The family section has the same people."). The person page's own family section keeps listing parents, partners and children as links.

## 6. What does not change

- The graph data contract, the privacy projection, the gate and `no-store` (`viz.md` §5, §6; HFY-R63, HFY-R65).
- Concept A, the Family Card Navigator, and every card-family view and flag: `familyViz`, `familyVizTime`, `familyVizKinship`, `familyVizFaces`, `familyVizBigTree`, `familyVizJourneys`.
- The `/tree/` page, the family tab and the "see in the family tree" link.
- The rule that built bundles are committed (HFY-R58), so the hourglass build also rebuilds and commits `11ty/js/islands/`.

## 7. What happens to what exists

**`familyVizPersonMini` and the card mini focus view (HFY-TSK-289).** They stay in code, with the flag default `false`. The flag is not flipped. The approved mockups decide whether the card mini focus view is placed on the person page (for example as the "cards" link target or beside the hourglass) or dropped. Dropping it is its own task, with its flag, after the hourglass has shipped.

**The Graphviz SVGs and frame.** The frame code stays in `11ty/js/person-page.js`, and the 231 `media/tree_*.svg` files stay served, until the hourglass has shipped and io approves. They are frozen snapshots meanwhile: nothing regenerates them, and a person created in the cloud has none. The hourglass reads the graph, so it covers every person.

**HFY-TSK-290** (the `familyVizPersonMini` flip, the runbook handoff that drops `build_family_tree_media.py`, and the counted break-glass delete of `media/tree_*.svg`) is **on hold** until the hourglass has shipped and io approves. io re-scopes it then. The flip of `familyVizPersonMini` is no longer part of it unless the mockups place the card mini focus view.

## 8. Gate order

1. io's design session (brief DOC-E55A13E60E53).
2. io approves the mockups.
3. Build, behind `familyVizHourglass`, default off.
4. D-11 pre-audit (`viz.md` §15), including the installed iPhone PWA.
5. io's iPhone UAT and G-prod approval.
6. The flip (flags deploy first; HFY-R70).
7. Only then the Graphviz retirement: HFY-TSK-290, re-scoped by io.

Build tasks are filed after step 2, not before.

## 9. Left to the mockups

These are not decided here:

- Where the small view sits on the person page, and whether it holds the Graphviz frame back while it is on.
- How many people each row shows before a "+N more" control.
- Whether re-centring in the expanded view changes only the tree or also opens that person's page. The focus node always has a "view page" link.
- The layout engine (section 3).
