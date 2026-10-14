// Synthetic Gramps objects for the layout tests. Every name, place and id is invented.
//
// layoutMessyTree(): the messy shapes the poster layout must survive, in one tree.
//   component 0: two partner families (I8003 with I8005 and with I8006), a mother-only union (F8004), parentless siblings
//                (F8005) of whom one marries in, a child with birth parents and adoptive parents (I8007 in F8002 and F8008),
//                pedigree collapse (first cousins I8008 and I8010 are partners), and a cross-generation partner link
//   a second component of three people
//   a cycle: I8031 and I8032 are each other's parent; I8033 is a child of the cycle (generation null)
//   a singleton: I8040
import { Tree } from './gramps.mjs';

const born = (year) => ({ when: { year } });

export function layoutMessyTree() {
  const t = new Tree();
  const p = (id, given, gender, year) => t.person(id, { given, surname: 'Layout', gender, birth: born(year) });

  p('I8001', 'Alba', 1, 1850);
  p('I8002', 'Bryn', 0, 1852);
  p('I8003', 'Cato', 1, 1875);
  p('I8004', 'Dara', 0, 1878);
  p('I8005', 'Eben', 0, 1880);
  p('I8006', 'Fenn', 0, 1882);
  p('I8007', 'Gale', 1, 1900);
  p('I8008', 'Hale', 0, 1902);
  p('I8009', 'Isla', 0, 1905);
  p('I8010', 'Jory', 1, 1903);
  p('I8011', 'Kale', 1, 1870);
  p('I8012', 'Lark', 0, 1872);
  p('I8013', 'Mira', 0, 1871);
  p('I8014', 'Nico', 1, 1898);
  p('I8018', 'Orla', 0, 1876);
  p('I8019', 'Pike', 1, 1874);
  p('I8020', 'Quin', 1, 1930);
  p('I8021', 'Rhea', 0, 1940);
  p('I8022', 'Sol', 1, 1942);
  p('I8023', 'Tamsin', 0, 1970);
  p('I8031', 'Ula', 0, 1800);
  p('I8032', 'Vance', 1, 1820);
  p('I8033', 'Wren', 0, 1840);
  p('I8040', 'Xan', 2, 1960);

  t.family('F8001', { father: 'I8001', mother: 'I8002', children: [{ id: 'I8003' }, { id: 'I8004' }] });
  t.family('F8002', { father: 'I8003', mother: 'I8005', children: [{ id: 'I8007' }, { id: 'I8008' }] }); // Cato and Eben
  t.family('F8003', { father: 'I8003', mother: 'I8006', children: [{ id: 'I8009' }] }); // Cato and Fenn: a second partner family
  t.family('F8004', { mother: 'I8004', type: 3, children: [{ id: 'I8010' }] }); // mother-only
  t.family('F8005', { type: 3, children: [{ id: 'I8011' }, { id: 'I8012' }] }); // parentless siblings
  t.family('F8006', { father: 'I8011', mother: 'I8013', children: [{ id: 'I8014' }] });
  t.family('F8008', { father: 'I8019', mother: 'I8018', children: [{ id: 'I8007', frel: 2, mrel: 2 }] }); // adoptive parents of Gale
  t.family('F8009', { father: 'I8010', mother: 'I8008', children: [{ id: 'I8020' }] }); // first cousins
  t.family('F8010', { father: 'I8022', mother: 'I8021', children: [{ id: 'I8023' }] });
  t.family('F8011', { father: 'I8031', children: [{ id: 'I8032' }] }); // a cycle: each is the other's parent
  t.family('F8012', { father: 'I8032', children: [{ id: 'I8031' }, { id: 'I8033' }] });
  t.extras();
  return t;
}
