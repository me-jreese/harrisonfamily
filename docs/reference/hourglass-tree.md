# The hourglass tree

Reference for the family tree that the site draws itself: the small tree on the person page and the big tree on `/tree/?view=tree`. It covers where the data comes from, the model and the views drawn from it, the addresses, the flag and what it needs, the chunks and their byte limits, the words, the accessibility rules, the token aliases and the family page's tab, chip and link.

For the decision that put a visual tree back on the person page, and why it sits beside the card views and does not replace them, see [the hourglass addendum](../design/hfy-pln-002/viz-hourglass-addendum.md). For the flag as a row among the others, see [Front end: Feature flags](front-end.md#feature-flags). To turn it on for one tab, see [Turn a feature flag on or off](../how-to/toggle-a-feature-flag.md).

All people, ids and places in the tests and fixtures are invented (HFY-R16). This page names no real person.

## Data, model and views

The tree reads `person/graph.json` and nothing else. The fetch is the one the `/tree/` page and the person island already make, so a page asks for the graph once (`cachedGraph` in [`lib/tree-data.js`](../../islands/src/lib/tree-data.js)). The graph is gated: a signed-out visitor, a missing graph or a graph without the person gets the page as it is without the flag.

| Stage | File | What it is |
|---|---|---|
| Adapter and model | [`lib/hourglass-model.js`](../../islands/src/lib/hourglass-model.js) | Pure. `indexGraph` indexes the graph body once; `familyModel` turns it into the model of one middle person: parents, grandparents, brothers and sisters (full and half), partners, children with their grandchildren, the both-sides note, the words and the accessible names. |
| Big-tree model and geometry | [`lib/hourglass-big.js`](../../islands/src/lib/hourglass-big.js) | Pure. `bigModel` adds the parents' other partners and the great-grandparents; `bigLayout` places every card at one of four sizes and returns the strips, rings and row names. Apart from the small tree's files, so the person page never loads it. |
| Small-tree rows | [`lib/hourglass-layout.js`](../../islands/src/lib/hourglass-layout.js) | Pure. The rows and connector strips of the small tree for one content width. |
| Drawing | [`lib/tree-hourglass.js`](../../islands/src/lib/tree-hourglass.js), [`lib/tree-hourglass-big.js`](../../islands/src/lib/tree-hourglass-big.js), [`lib/hourglass-dom.js`](../../islands/src/lib/hourglass-dom.js) | Plain DOM. No React, no chart or graph library. Every card is a real link or button; the connectors are 2 px `<i>` strips placed under the cards, never SVG. |
| The switch | [`lib/hourglass-ui.js`](../../islands/src/lib/hourglass-ui.js) | The person page's `tree · cards` switch and the remembered choice (`localStorage` key `hfy:person-family-view`, in try/catch). |
| Addresses | [`lib/hourglass-links.js`](../../islands/src/lib/hourglass-links.js), [`lib/tree-view.js`](../../islands/src/lib/tree-view.js) | `bigHref`, `listHref` and `page` for the trees; `treeUrl`, `treeTabIsNew` and `firstNameOf` for the family page. |

The small tree is a two-up, two-down hourglass: grandparents and children on a four-column grid, parents spanning two columns each, the person's row at 1 : 1.4 : 1 inside a sunken band that also holds the brothers-and-sisters toggle. At most four children show before `+N more children`. Below 600 px of the tree's own width the grandchildren are faces and a names line; from there they are a card row.

The big tree has four card sizes, `faces only`, `small`, `medium` and `large` (48 x 48, 128 x 184, 168 x 232 and 208 x 264 px). It starts at `small` below 700 px and at `medium` from there. A tree is never scaled, so a target never falls under 44 px: the sizes are real sizes, and a family wider than the stage scrolls inside its own region, never the page. Rows are named on the ground (`great-grandparents`, `grandparents`, `parents`, `children`, `grandchildren`). The parents' other partners show from `medium`; half brothers and sisters hang dashed from the shared parent.

Below 1100 px the big tree is a full-screen view with a bar under the stage. From 1100 px it is a framed page region with a 320 px panel beside the stage. The bar and the panel hold `open <first>'s page`, `how are we related?` and the other views of the family.

## Addresses

The big tree is the `view=tree` view of `/tree/`. It exists only with the flag on; with the flag off the address is an unknown view and the page is what it always was.

| Parameter | Meaning |
|---|---|
| `view=tree` | The big tree. The other views are `cards`, `outline`, `lifelines`, `table`, `faces` and `family` (the poster). |
| `focus=<id>` | The person in the middle. A tap writes a new one with `history.pushState` and keeps the people before in `history.state.hg`, so Back retraces the taps. An id the graph does not hold falls back as `/tree/` does. |
| `from=<id>` | The person page the visitor came from. `back to <first>` and the top bar's back return to it. The family page's `tree` tab keeps an existing `from=`; the cards' link sets it to its own person. |
| `ggp=1` | The great-grandparents row is shown. It is the one view state in the address, so a reload keeps it. |
| `kin=1` | Read by the cards view, not the big tree: `how are we related?` opens `/tree/?view=cards&focus=<id>&kin=1`, and the relationship panel opens at once for the person in the address. |

An id outside `[A-Za-z0-9_-]{1,32}` is never put in an address.

The big tree links out to the family views with `focus=<id>`: `cards`, `outline`, `family` (the poster, with `familyVizBigTree`, a `layout` block in the graph and 64rem) and `table` (with `familyVizTime`). A link to a view whose flag is off is not drawn.

## The flag and what it needs

`familyVizHourglass` is default off, in [`11ty/_data/flags.json`](../../11ty/_data/flags.json). It needs `familyViz` (the `/tree/` page and its graph fetch) and `personV2`, which loads the person island that draws the small tree. Without `personV2` the person page keeps the Graphviz frame. With the key off nothing changes anywhere: no chunk and no `graph.json` is requested, and the card views never change (HFY-R8).

Three other flags only add links: `familyVizKinship` (`how are we related?`, for a signed-in member who is in the graph), `familyVizBigTree` (the poster) and `familyVizTime` (the table). Read the served value with `curl -s https://<site>/_data/flags.json | jq .familyVizHourglass`. The flag's state is not recorded here.

## Chunks and the byte ledger

The hourglass is lazy: the person page loads `hourglass-ui` first, and `tree-hourglass` only when the tree is the view; `/tree/` loads `tree-hourglass-big` only when `?view=tree` is asked for with the flag on. The chunk files are in `11ty/js/islands/chunks/`, named `<chunk>-<hash>.js`; a module that two chunks share is built into a `chunk-<hash>.js` that [`tests/tree-budget.test.mjs`](../../islands/tests/tree-budget.test.mjs) finds by following the static imports.

| Part | Chunks | Limit (minified bytes) |
|---|---|---|
| Person page | `tree-hourglass` and the shared adapter | 14 KB |
| Big tree only | `tree-hourglass-big` | 11.5 KB |
| Switch glue | `hourglass-ui`, listed apart | 2.5 KB |
| All hourglass scripts, glue not counted | every chunk above but the glue | 25 KB (25,600 bytes) |
| All hourglass scripts, gzip, glue counted | the same | 25 KB |
| The partial `theme/46-hourglass.css` | | 5 KB gzip |

The minified total is io's brief; the gzip total is the addendum's. The minified one is the stricter, and both are asserted. The family page's own code, the tab, the chip and the cards' link, lives in the page entry (`islands/tree.jsx`, with `lib/tree-view.js` and the rules in `islands/tree.css`), not in the hourglass chunks, so it counts against the entry's 60 KB gzip and not against the hourglass total. The chip in the big tree's top bar is drawn from the entry into that bar with a portal, for the same reason.

To re-measure: `cd islands && npm run build`, then `node --test tests/tree-budget.test.mjs`. The diagnostic line prints each part, and `wc -c ../11ty/js/islands/chunks/tree-hourglass-*.js` gives exact bytes. The lines are tight on purpose, so a change to a shared helper, to the minifier version or to a string can fail the test with no feature added. A line moves only with io's ruling on the record.

## Where the words are

The words are T-Copy of the design: lower case, names keep their capitals. They are inline literals in the file that draws them, plus three tables: `COPY` in `hourglass-model.js`, `BIG_COPY` in `hourglass-big.js` and `TREE_COPY` in `lib/tree-view.js` (the family page's tab, chip and link). [`tests/hourglass-copy.test.mjs`](../../islands/tests/hourglass-copy.test.mjs) checks every string for lower case and for the banned words: node, graph, chart, pedigree, collapse, focus, re-centre, living, deceased, unknown. The existing `yearsLabel` of `lib/tree-data.js` says `years unknown`, so the tree never uses it. A person's years read `1880–1942`, `b. 1950`, `d. 1942`, `c. 1880` for an approximate year, and nothing for a missing one.

The `know who? tell us` thank-you names a family contact by initial. Do not quote it in docs; cite `COPY.thanks`.

## Accessibility rules

- Every person is a real link or button, and its accessible name carries the relationship: `<name>, mother`, `<name>, this person. open the big tree` on the small tree's middle card, `<name>, in the middle now` on the big tree's.
- DOM and focus order is ancestors, then the person's row, then descendants.
- The middle person has `aria-current`: `page` on the small tree's card, `true` on the big tree's.
- Colour is never the only sign. Every role also has a word, a row name or a side caption.
- Text is at least 16 px and wraps rather than truncating. At `faces only` the names are not drawn, and every card keeps its accessible name. Targets are at least 44 px. The page never scrolls sideways at 375 px.
- The focus ring is the system's (`--io-control-focus-ring`). Re-centring announces `now centred on <first>` or `already in the middle` in a polite status.
- Under `prefers-reduced-motion` every duration is 0 and a re-centre jumps instead of scrolling or fading.
- Keys in the big tree: Tab and Enter re-centre, `+` and `-` step the size, `0` is `see all`, Escape goes back.

The D-11 pre-audit is [`tests/hourglass-d11.spec.mjs`](../../islands/tests/hourglass-d11.spec.mjs): the small tree, the big tree, the new tab and the chip at 375, 768 and 1280 px in both themes. `HFY_SHOTS=1 HFY_SHOTS_DIR=<folder>` also saves screenshots there, named `<surface>-<case>-<width>-<theme>.png`. [`tests/hourglass-roundtrip.spec.mjs`](../../islands/tests/hourglass-roundtrip.spec.mjs) walks person page, big tree, cards and back. Both run in the headless shell, one worker, against route-stubbed flags and graph.

## Tokens: the alias block and the names emitted

The new roles are proposed to `@io-kit/tokens`. Until a release carries them, [`theme/46-hourglass.css`](../../islands/src/theme/46-hourglass.css) opens with an alias block on `.hfy-tree, .hfy-bt`. Each `--hfy-tree-*` name reads the new token first and falls back to the existing token the new one is defined as, so moving the pin changes nothing but the dependency.

| Alias | Prefers | Falls back to |
|---|---|---|
| `--hfy-tree-edge`, `--hfy-tree-line` | `--io-color-semantic-tree-edge`, `--io-color-semantic-tree-line` | `--io-color-semantic-border-strong` |
| `--hfy-tree-repeat` | `--io-color-semantic-tree-repeat` | `--io-color-semantic-accent-secondary` |
| `--hfy-tree-ground` | `--io-color-semantic-tree-ground` | `--io-color-semantic-surface-sunken` |
| `--hfy-tree-edge-w`, `--hfy-tree-line-w` | `--io-tree-edge-w`, `--io-tree-line-w` | `--io-control-focus-ring` |
| `--hfy-tree-ring` | `--io-tree-ring` | `--io-space-2` plus the ring width |
| `--hfy-tree-gap-col`, `--hfy-tree-gap-row` | `--io-tree-gap-col`, `--io-tree-gap-row` | `--io-space-3`, `--io-space-7` |

`--io-tree-dash` is documentation only: dashes are the browser's dashed border at the line weight. The seven role fills and their inks, `--io-color-semantic-tree-{focus,parent,grandparent,sibling,spouse,child,grandchild}` and the same with `-ink`, already ship in the pinned package, and the contrast test checks their ratios. Every card has a 2 px `--hfy-tree-edge` border, because most role fills are under 3:1 against the ground. App CSS holds no literal colour, font family, radius or length (`npm run lint:css`); the alias block is the one place that reads the `--io-tree-*` names. To move to the release that carries them, see [Pin the tree tokens release](../how-to/pin-the-tree-tokens-release.md).

## The family page: tab, chip and link

Three additions on `/tree/`, all behind `familyVizHourglass`, all in `islands/tree.jsx`:

- **The `tree` tab.** The last tab of the view toggle, after `cards`, `outline`, `lifelines`, `table`, `faces` and the poster. It is a link, not a pressed button, because it leaves the view: its address is `/tree/?view=tree&focus=<id>` for the person in the middle, with `from=` kept. A quiet `new` follows its word until `TREE_TAB_NEW_UNTIL` in `lib/tree-view.js`; the date is a release choice, so move it with the release. `how are we related?` stays the existing pill.
- **The `centred on <name>` chip and `change`.** Above the tabs, in the token-pill colours, and in the big tree's top bar. Every tab keeps `focus=` in the address, so the chip is the same person on all of them. `change` has no target in the design. The page has no search of its own, so it goes to the one place that lists everyone and re-centres on a pick: the generation outline. On the family views it takes the keyboard to `#hfy-tree-outline`; in the big tree, which has no outline, it is a link to `/tree/?focus=<id>&view=cards#hfy-tree-outline`, and the page puts the keyboard on the outline when it opens. In the big tree the chip also puts the middle person back in the middle when the stage changes size (the chip making the top bar a row taller, a phone turned over), but only until the visitor moves the stage by wheel, touch, key or press; a tap that re-centres clears that, so a phone's address bar or keyboard never throws away where someone has panned to.
- **`see <first> in the tree`.** One button-styled link with a 20 px tree icon, above the cards, to `/tree/?view=tree&focus=<id>&from=<id>`. A link cannot sit inside a card, which is a button, so it stands beside the cards, not in the front card. A person with no first name reads `see the tree`. The `from=` is the same person, which the big tree's back returns to as that person's page. Nothing else in the card views changes; [`tests/hourglass-family.spec.mjs`](../../islands/tests/hourglass-family.spec.mjs) compares their markup with the flag on and off.
