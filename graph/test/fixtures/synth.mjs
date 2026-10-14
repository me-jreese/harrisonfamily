// A seeded synthetic family, as Gramps objects, for the layout budgets (ADR 3.3's generator, ported). Every id, name, place
// and year is invented, and the same (people, seed) always gives the same tree. Same shape as the real one: a main component of
// about 8 generations that holds nearly everyone, a few single-parent unions, second partners, married-in partners with no
// parents, one pair of first cousins who are partners, a small second component, and singletons for the rest.
import { Tree } from './gramps.mjs';

function rng(seed) {
  // mulberry32
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const GIVEN = ['Ada', 'Ben', 'Cleo', 'Dee', 'Eve', 'Fay', 'Gus', 'Hal', 'Ivy', 'Jo', 'Kay', 'Lee', 'Max', 'Nell', 'Otto', 'Pia'];
const SURNAME = ['Example', 'Sample', 'Test', 'Demo', 'Placeholder', 'Mock'];
const MAX_GEN = 7; // 8 levels

export function synthTree(targetPeople, seed = 1) {
  const r = rng(seed);
  const t = new Tree();
  const gens = [];
  let pid = 0;
  let uid = 0;
  const people = [];
  const unions = [];

  // places: 4 countries, 10 states, 23 towns, with coordinates at two decimals
  for (let i = 1; i <= 4; i++) t.place(`P${i}`, { name: `Country ${i}`, type: 1 });
  for (let i = 5; i <= 14; i++) t.place(`P${i}`, { name: `State ${i}`, type: 2, parent: `P${1 + (i % 4)}` });
  for (let i = 15; i <= 37; i++) {
    const lat = (30 + r() * 10).toFixed(2);
    const long = (-95 + r() * 10).toFixed(2);
    t.place(`P${i}`, { name: `Town ${i}`, type: 4, parent: `P${5 + (i % 10)}`, lat, long });
  }

  const newP = (gen, comp = 0) => {
    const id = `I${10000 + ++pid}`;
    const p = { id, gen, comp, unions: [], parents: [] };
    people.push(p);
    gens.push(gen);
    return p;
  };
  const newU = (partners) => {
    const u = { id: `F${10000 + ++uid}`, partners: partners.map((p) => p.id), children: [] };
    unions.push(u);
    for (const p of partners) p.unions.push(u.id);
    return u;
  };
  const addChild = (u, gen, rel = 1) => {
    const c = newP(gen);
    u.children.push({ id: c.id, rel });
    c.parents.push(u.id);
    return c;
  };

  const reserve = 20;
  const queue = [];
  const unmarriedByGen = new Map();
  const pushUnmarried = (p) => {
    if (!unmarriedByGen.has(p.gen)) unmarriedByGen.set(p.gen, []);
    unmarriedByGen.get(p.gen).push(p);
  };
  const founder = () => {
    const a = newP(0);
    const b = newP(0);
    queue.push({ u: newU([a, b]), gen: 0 });
  };
  founder();
  founder();
  while (people.length < targetPeople - reserve) {
    if (queue.length === 0) founder();
    const { u, gen } = queue.shift();
    if (gen >= MAX_GEN) continue;
    const n = [0, 1, 2, 2, 3, 3, 4, 5][Math.floor(r() * 8)];
    for (let i = 0; i < n && people.length < targetPeople - reserve; i++) {
      const c = addChild(u, gen + 1, r() < 0.03 ? 2 : 1);
      const roll = r();
      if (roll < 0.08) {
        queue.push({ u: newU([c]), gen: gen + 1 }); // a single-parent union
      } else if (roll < 0.62) {
        const pool = unmarriedByGen.get(gen + 1) || [];
        const partner = pool.length && r() < 0.15 ? pool.splice(Math.floor(r() * pool.length), 1)[0] : newP(gen + 1);
        queue.push({ u: newU([c, partner]), gen: gen + 1 });
        if (r() < 0.06) queue.push({ u: newU([c, newP(gen + 1)]), gen: gen + 1 }); // a second partner family
      } else {
        pushUnmarried(c);
      }
    }
  }
  // parentless siblings, one of whom marries in
  const sibs = newU([]);
  const s1 = addChild(sibs, 3);
  addChild(sibs, 3);
  const pool = unmarriedByGen.get(3) || [];
  const su = newU([s1, pool.length ? pool.shift() : newP(3)]);
  addChild(su, 4);
  // first cousins who are partners (pedigree collapse)
  for (const [gen, list] of unmarriedByGen) {
    if (gen < 2 || list.length < 2) continue;
    addChild(newU([list.shift(), list.shift()]), gen + 1);
    break;
  }
  // a small second component
  const x = newP(0, 1);
  const y = newP(0, 1);
  const xu = newU([x, y]);
  addChild(xu, 1);
  addChild(xu, 1);
  // singletons for the rest
  while (people.length < targetPeople) newP(0, 2);

  // Gramps objects
  for (const p of people) {
    const n = Number(p.id.slice(1));
    const given = GIVEN[n % GIVEN.length];
    const surname = SURNAME[Math.floor(n / GIVEN.length) % SURNAME.length];
    const hasBirth = r() < 0.52;
    const dead = r() < 0.08;
    const by = hasBirth ? 1790 + p.gen * 28 + Math.floor(r() * 20) : null;
    const birth = hasBirth ? { when: { year: by }, place: r() < 0.3 ? `P${15 + Math.floor(r() * 23)}` : undefined } : null;
    const death = dead && by ? { when: { year: by + 40 + Math.floor(r() * 40) } } : null;
    t.person(p.id, { given, surname, gender: n % 2, birth, death });
  }
  for (const u of unions) {
    const [a, b] = u.partners;
    const fam = { children: u.children.map((c) => ({ id: c.id, frel: c.rel, mrel: c.rel })) };
    if (a) fam.mother = a;
    if (b) fam.father = b;
    t.family(u.id, fam);
  }
  return t;
}
