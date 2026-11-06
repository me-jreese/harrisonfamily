// The invented people of tests/fixtures/tree-graph-hourglass.json, by the case of the hourglass tree boards (T-Case-*, HFY-TSK-379) that each one
// is the focus of. Nothing here is a real person: every name, id and year is made up (HFY-R16).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The graph.json body (schemaVersion 1, minor 3). */
export const GRAPH = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "tree-graph-hourglass.json"), "utf8"));

/** Focus person ids by case. */
export const CASES = {
  full: "I9007", // both parents and four grandparents, a brother, a married partner, three children (one adopted), four grandchildren
  oneParent: "I9020", // only the mother is recorded; her own parents are
  noParents: "I9021", // no recorded parent; a partner in a "custom" union and one child
  large: "I9024", // nine children (the cap is four) and nine grandchildren (the cap is six)
  siblings: "I9048", // full and half brothers and sisters from both parents' other unions; the mother has no recorded parents
  pedigree: "I9065", // two of the grandparents are brother and sister, so their parents stand on both sides
  bothSides: "I9071", // one grandparent stands under both parents
  partners: "I9076", // four partners (married, unmarried, civil union, unknown), a father with two unions, a mother with a partner and a one-parent record of her own mother
  adoptedBirth: "I9089", // two parent unions: adopted listed first, birth second
  adoptedFirst: "I9090", // two parent unions, neither a birth link
  alone: "I9092" // nobody recorded around them
};
