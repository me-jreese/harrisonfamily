// JSON Schema per Gramps class, and the MediaRef.rect rule (HFY-TSK-245; sync design 7.2 "JSON Schema per class", section 9).
//
// gramps/schema/gramps-6.0.6.schema.json is generated from Gramps' own get_schema() (HFY-TSK-231). It uses a small keyword set, which
// validate() implements, so the Lambda needs no JSON Schema dependency: type, enum, properties, additionalProperties, required, items,
// minItems, maxItems, minimum, maximum, maxLength, oneOf and $ref. Any other keyword in the file throws, so a regenerated schema that
// grows a keyword cannot be silently half-checked.
//
// A violation names a rule, a handle and an RFC 6901 pointer relative to the object. It never carries a value.
import { existsSync, readFileSync } from "node:fs";
import { escapePointerToken, matchPointers, pointerGet, rectProblem } from "../shared/redaction-rules.mjs";

const SCHEMA = "gramps/schema/gramps-6.0.6.schema.json";
const KEYWORDS = new Set(["type", "enum", "properties", "additionalProperties", "required", "items", "minItems", "maxItems", "minimum", "maximum", "maxLength", "oneOf", "$ref", "title", "$schema", "x-gramps", "$defs"]);

/** Where the schema sits for a schema.js at `base`: the zip stages gramps/ beside src/, the checkout keeps it at the repo root. */
export function schemaUrl(base = import.meta.url, exists = existsSync) {
  const staged = new URL(`../../${SCHEMA}`, base);
  const checkout = new URL(`../../../${SCHEMA}`, base);
  return exists(staged) ? staged : checkout;
}

let cached = null;
/** The parsed Gramps 6.0.6 schema, found in either layout. */
export function loadSchema() {
  cached ??= JSON.parse(readFileSync(schemaUrl(), "utf8"));
  return cached;
}

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
function typeOk(v, t) {
  switch (t) {
    case "object": return isObj(v);
    case "array": return Array.isArray(v);
    case "string": return typeof v === "string";
    case "boolean": return typeof v === "boolean";
    case "null": return v === null;
    case "integer": return Number.isInteger(v);
    case "number": return typeof v === "number" && Number.isFinite(v);
    default: throw new Error(`unsupported schema type ${t}`);
  }
}

/** Violations of `value` against `node`: [{pointer, keyword}]. `schema` resolves $ref. */
export function validate(value, node, schema, pointer = "", depth = 0) {
  if (depth > 64) return [{ pointer, keyword: "depth" }];
  for (const k of Object.keys(node)) if (!KEYWORDS.has(k)) throw new Error(`unsupported schema keyword ${k}`);
  if (node.$ref) return validate(value, schema.$defs[node.$ref.replace("#/$defs/", "")], schema, pointer, depth + 1);
  const errs = [];
  if (node.oneOf && node.oneOf.filter((s) => validate(value, s, schema, pointer, depth + 1).length === 0).length !== 1) errs.push({ pointer, keyword: "oneOf" });
  if (node.type) {
    const types = [].concat(node.type);
    if (!types.some((t) => typeOk(value, t))) return [...errs, { pointer, keyword: "type" }];
  }
  if (node.enum && !node.enum.some((e) => typeof e === typeof value && e === value)) errs.push({ pointer, keyword: "enum" });
  if (typeof value === "string" && node.maxLength !== undefined && value.length > node.maxLength) errs.push({ pointer, keyword: "maxLength" });
  if (typeof value === "number") {
    if (node.minimum !== undefined && value < node.minimum) errs.push({ pointer, keyword: "minimum" });
    if (node.maximum !== undefined && value > node.maximum) errs.push({ pointer, keyword: "maximum" });
  }
  if (isObj(value)) {
    for (const r of node.required || []) if (!Object.prototype.hasOwnProperty.call(value, r)) errs.push({ pointer: `${pointer}/${escapePointerToken(r)}`, keyword: "required" });
    for (const [k, sub] of Object.entries(value)) {
      const at = `${pointer}/${escapePointerToken(k)}`;
      if (node.properties && Object.prototype.hasOwnProperty.call(node.properties, k)) errs.push(...validate(sub, node.properties[k], schema, at, depth + 1));
      else if (node.additionalProperties === false) errs.push({ pointer: at, keyword: "additionalProperties" });
    }
  }
  if (Array.isArray(value)) {
    if (node.minItems !== undefined && value.length < node.minItems) errs.push({ pointer, keyword: "minItems" });
    if (node.maxItems !== undefined && value.length > node.maxItems) errs.push({ pointer, keyword: "maxItems" });
    if (node.items) value.forEach((x, i) => errs.push(...validate(x, node.items, schema, `${pointer}/${i}`, depth + 1)));
  }
  return errs;
}

/** Schema violations of one primary object: [{rule: "schema.<keyword>", handle, pointer}]. A class that is not a primary class is one violation. */
export function schemaViolations(object, schema = loadSchema()) {
  const handle = isObj(object) ? object.handle : undefined;
  const cls = isObj(object) ? object._class : undefined;
  if (!schema["x-gramps"].primary.includes(cls)) return [{ rule: "schema.class", handle, pointer: "/_class" }];
  return validate(object, schema.$defs[cls], schema).map((e) => ({ rule: `schema.${e.keyword}`, handle, pointer: e.pointer }));
}

/**
 * MediaRef.rect violations of one object (sync design 9): `rect` is null or [x1, y1, x2, y2] integers with 0 <= x1 < x2 <= 100 and
 * 0 <= y1 < y2 <= 100, and [0, 0, 100, 100] is sent as null (Gramps' own normalisation). A fraction is refused; the float-to-integer
 * rounding of a web tagger is the tagging domain's job before it calls applyBatch(). Every MediaRef of the object is checked (the
 * media_list of a Person, Family, Event, Place, Source or Citation).
 */
export function rectViolations(object, policy) {
  const handle = isObj(object) ? object.handle : undefined;
  const out = [];
  for (const ptr of matchPointers(object, "/**/media_list/*/rect")) {
    const problem = rectProblem(pointerGet(object, ptr), policy);
    if (problem) out.push({ rule: `media.rect.${problem}`, handle, pointer: ptr });
  }
  return out;
}
