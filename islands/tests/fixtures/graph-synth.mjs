// A deterministic generator of synthetic family graphs (graph.json v1, viz.md section 5.3) for the budget and performance tests
// (HFY-TSK-302, viz-mvp-visual-perf; viz.md section 11). Every name is invented from the syllable pools below; no real person, date or id
// is used. The same (people, seed) always gives byte-identical output.
//
//   import { synthGraph, synthFocus } from "./fixtures/graph-synth.mjs";
//   const graph = synthGraph(2000);          // an object; JSON.stringify it to serve it
//   const focus = synthFocus(graph);         // a middle-generation person who has parents, a partner and children
//
// The shape: a few founding couples, each couple having one to four children, each child pairing with a newcomer who has no recorded parents,
// generation after generation until `people` is reached. About one person in 50 more stands alone (a singleton component, like the real
// tree's strays). About 3 in 5 people have a face crop name (`faces/<token>.webp`).

/** mulberry32: a small seeded generator, so the output is the same on every machine. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const GIVEN_A = ["Al", "Bre", "Cor", "Dal", "El", "Fen", "Gar", "Hal", "Ire", "Jun", "Kel", "Lor", "Mar", "Nor", "Ol", "Per", "Quin", "Ros", "Sol", "Tam", "Ul", "Ver", "Wen", "Yor", "Zel"];
const GIVEN_B = ["a", "ek", "en", "ia", "in", "is", "o", "on", "ric", "ta", "us", "wyn", "ya"];
const SURNAMES = ["Alder", "Birchwood", "Cobbler", "Dunmere", "Eastlake", "Fennick", "Glenhart", "Hollin", "Ivorton", "Juniper", "Kestrel", "Larkspur", "Meadowby", "Northam", "Oakley", "Pennywell", "Quillon", "Rowanford", "Sparrow", "Thistledown"];

const pad = (n, w) => String(n).padStart(w, "0");

/**
 * @param {number} people  how many people (at least 12)
 * @param {{seed?: number}} [opts]
 * @returns the graph object
 */
export function synthGraph(people, { seed = 302 } = {}) {
  if (!(people >= 12)) throw new Error("synthGraph needs at least 12 people");
  const rand = rng(seed);
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const all = [];
  const unions = [];
  const byGen = [];
  const strays = Math.floor(people / 50);
  const treeSize = people - strays;

  const addPerson = (gen, surname, sex, birthYear, component = 0) => {
    const n = all.length;
    const given = pick(GIVEN_A) + pick(GIVEN_B);
    const p = {
      id: `I${7000 + n}`,
      name: `${given} ${surname}`,
      given,
      surname,
      sex,
      living: birthYear > 1950,
      birthYear,
      deathYear: birthYear > 1950 ? null : birthYear + 55 + Math.floor(rand() * 30),
      yearApprox: rand() < 0.1,
      birthPlace: null,
      deathPlace: null,
      generation: gen,
      component,
      face: rand() < 0.6 ? `faces/s${pad(n, 5)}.webp` : null
    };
    all.push(p);
    if (component === 0) (byGen[gen] ||= []).push(p.id);
    return p;
  };

  // Generation 0: founding couples (about one per 60 people, at least two).
  const founders = Math.max(2, Math.round(treeSize / 60));
  let couples = [];
  for (let i = 0; i < founders && all.length + 2 <= treeSize; i++) {
    const surname = pick(SURNAMES);
    const a = addPerson(0, surname, "m", 1850 + Math.floor(rand() * 10));
    const b = addPerson(0, pick(SURNAMES), "f", a.birthYear + Math.floor(rand() * 6));
    couples.push([a, b]);
  }
  let gen = 0;
  while (couples.length && all.length < treeSize) {
    const next = [];
    gen += 1;
    for (const [a, b] of couples) {
      if (all.length >= treeSize) break;
      const kids = 1 + Math.floor(rand() * 4);
      const u = { id: `F${7000 + unions.length}`, type: rand() < 0.9 ? "married" : "unknown", partners: [a.id, b.id], children: [] };
      unions.push(u);
      for (let k = 0; k < kids && all.length < treeSize; k++) {
        const sex = rand() < 0.5 ? "m" : "f";
        const year = Math.round((a.birthYear + b.birthYear) / 2) + 24 + k * 2 + Math.floor(rand() * 5);
        const child = addPerson(gen, a.surname, sex, year);
        u.children.push({ id: child.id, rel: { [a.id]: "birth", [b.id]: "birth" } });
        // Pair with a newcomer: someone with no recorded parents, in the same generation.
        if (all.length < treeSize && rand() < 0.75) {
          const mate = addPerson(gen, pick(SURNAMES), sex === "m" ? "f" : "m", year + Math.floor(rand() * 5) - 2);
          next.push(sex === "m" ? [child, mate] : [mate, child]);
        }
      }
    }
    couples = next;
  }
  const treeCount = all.length;
  // Strays and anyone the loop left over: single-person components.
  const components = [{ id: 0, size: treeCount, roots: all.filter((p) => p.generation === 0).map((p) => p.id) }];
  for (let i = 0; all.length < people; i++) {
    const p = addPerson(0, pick(SURNAMES), rand() < 0.5 ? "m" : "f", 1900 + Math.floor(rand() * 90), i + 1);
    components.push({ id: i + 1, size: 1, roots: [p.id] });
  }

  all.sort((x, y) => (x.id < y.id ? -1 : 1));
  return {
    schemaVersion: 1,
    minor: 0,
    generatedAt: "2026-01-01T00:00:00Z",
    counts: { people: all.length },
    people: all,
    unions,
    edges: [],
    places: [],
    events: [],
    components,
    generations: [{ component: 0, levels: byGen.map((l) => [...l]) }]
  };
}

/** The id of a person in the middle generations who has parents, a partner and at least two children (the busiest first view). */
export function synthFocus(graph) {
  const kids = new Map();
  const hasParents = new Set();
  for (const u of graph.unions) {
    for (const c of u.children) hasParents.add(c.id);
    for (const p of u.partners) kids.set(p, (kids.get(p) || 0) + u.children.length);
  }
  const mid = Math.floor(graph.generations[0].levels.length / 2);
  const level = graph.generations[0].levels[mid] || [];
  const best = level.find((id) => hasParents.has(id) && (kids.get(id) || 0) >= 2) || level.find((id) => hasParents.has(id));
  return best || graph.people[0].id;
}

/** Every id and name in the graph: a test uses these to prove none reaches a static file. */
export const synthTokens = (graph) => [...graph.people.map((p) => p.id), ...graph.people.map((p) => p.name)];
