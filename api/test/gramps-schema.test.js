// Vitest for the Gramps 6.0.6 schema golden (HFY-TSK-231): the committed gramps/schema/*.schema.json
// validates every synthetic fixture object, and mutated objects (wrong _class, unknown key, float
// rect) fail. The validator is a small subset implementation (what the generator emits), so this test
// needs no JSON Schema dependency; validator-js is a later task.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const schemaDir = join(repo, "gramps", "schema");
const read = (p) => readFileSync(p);
const schema = JSON.parse(read(join(schemaDir, "gramps-6.0.6.schema.json")));
const labels = JSON.parse(read(join(schemaDir, "gramps-6.0.6.labels.json")));
const fixture = read(join(repo, "gramps", "tests", "fixtures", "synthetic-tree.jsonl"))
  .toString("utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

const KEYWORDS = new Set(["type", "enum", "properties", "additionalProperties", "required", "items", "minItems",
  "maxItems", "minimum", "maximum", "maxLength", "oneOf", "$ref", "title", "$schema", "x-gramps", "$defs"]);

function typeOk(v, t) {
  switch (t) {
    case "object": return v !== null && typeof v === "object" && !Array.isArray(v);
    case "array": return Array.isArray(v);
    case "string": return typeof v === "string";
    case "boolean": return typeof v === "boolean";
    case "null": return v === null;
    case "integer": return Number.isInteger(v);
    case "number": return typeof v === "number";
    default: throw new Error(`unsupported type ${t}`);
  }
}

function validate(v, node, path = "#") {
  for (const k of Object.keys(node)) if (!KEYWORDS.has(k)) throw new Error(`unsupported keyword ${k} at ${path}`);
  if (node.$ref) return validate(v, schema.$defs[node.$ref.replace("#/$defs/", "")], path);
  const errs = [];
  if (node.oneOf) {
    const hits = node.oneOf.filter((s) => validate(v, s, path).length === 0).length;
    if (hits !== 1) errs.push(`${path}: matches ${hits} oneOf branches`);
  }
  if (node.type) {
    const types = [].concat(node.type);
    if (!types.some((t) => typeOk(v, t))) return [...errs, `${path}: expected ${types.join("/")}`];
  }
  if (node.enum && !node.enum.some((e) => typeof e === typeof v && e === v)) errs.push(`${path}: not in enum`);
  if (typeof v === "string" && node.maxLength !== undefined && v.length > node.maxLength) errs.push(`${path}: too long`);
  if (typeof v === "number") {
    if (node.minimum !== undefined && v < node.minimum) errs.push(`${path}: below minimum`);
    if (node.maximum !== undefined && v > node.maximum) errs.push(`${path}: above maximum`);
  }
  if (v && typeof v === "object" && !Array.isArray(v)) {
    for (const r of node.required || []) if (!(r in v)) errs.push(`${path}: missing ${r}`);
    for (const [k, sub] of Object.entries(v)) {
      if (node.properties && k in node.properties) errs.push(...validate(sub, node.properties[k], `${path}/${k}`));
      else if (node.additionalProperties === false) errs.push(`${path}: unknown key ${k}`);
    }
  }
  if (Array.isArray(v)) {
    if (node.minItems !== undefined && v.length < node.minItems) errs.push(`${path}: too few items`);
    if (node.maxItems !== undefined && v.length > node.maxItems) errs.push(`${path}: too many items`);
    if (node.items) v.forEach((x, i) => errs.push(...validate(x, node.items, `${path}/${i}`)));
  }
  return errs;
}

const check = (obj) => {
  const cls = obj && obj._class;
  if (!schema["x-gramps"].primary.includes(cls)) return [`#: _class ${cls} is not a primary class`];
  return validate(obj, schema.$defs[cls]);
};
// Expected-invalid set comes from the fixture census (rect_float), not a hard-coded pin. JSON.parse cannot
// tell 10.0 from 10, so the float rule here relies on the fixture's literal 12.5 style values; the Python
// checker (gramps/hfygramps/schema_check.py) rejects 10.0 too.
const census = JSON.parse(read(join(repo, "gramps", "tests", "fixtures", "synthetic-tree.census.json")));
const expectedInvalid = [...census.rect_float].sort();
const hasFloatRect = (o) => (o.media_list || []).some((r) => r.rect && r.rect.some((c) => !Number.isInteger(c)));
const clone = (o) => JSON.parse(JSON.stringify(o));
const firstOf = (cls) => fixture.find((o) => o._class === cls);

describe("gramps schema golden", () => {
  it("records the Gramps version and DB schema, and matches its sha256 manifest", () => {
    expect(schema["x-gramps"]).toMatchObject({ gramps_version: "6.0.6", db_schema: 21 });
    expect(labels["x-gramps"]).toMatchObject({ gramps_version: "6.0.6", db_schema: 21 });
    const rows = read(join(schemaDir, "gramps-6.0.6.sha256")).toString().trim().split("\n").map((l) => l.split(/\s+/));
    expect(rows.length).toBe(2);
    for (const [digest, name] of rows) {
      expect(createHash("sha256").update(read(join(schemaDir, name))).digest("hex")).toBe(digest);
    }
  });

  it("covers 27 classes and the 13 label tables", () => {
    expect(Object.keys(schema.$defs).length).toBe(27);
    expect(Object.keys(labels.tables).sort()).toEqual([
      "AttributeType", "ChildRefType", "EventRoleType", "EventType", "FamilyRelType", "NameOriginType", "NameType",
      "NoteType", "PlaceType", "RepositoryType", "SourceMediaType", "SrcAttributeType", "UrlType",
    ]);
    expect(labels.tables.EventType.entries.length).toBe(47);
  });

  it("validates every synthetic-tree object except the census rect_float objects, which fail on rect only", () => {
    expect(fixture.length).toBe(109);
    const failing = fixture.filter((o) => check(o).length > 0).map((o) => o.gramps_id).sort();
    expect(failing).toEqual(expectedInvalid);
    for (const id of expectedInvalid) {
      const obj = fixture.find((o) => o.gramps_id === id);
      expect(hasFloatRect(obj)).toBe(true);
      const errs = check(obj);
      expect(errs.length).toBeGreaterThan(0);
      expect(errs.every((e) => e.includes("/rect"))).toBe(true);
    }
  });

  it("does not let a bool satisfy an integer enum", () => {
    expect(validate(true, { type: "integer", enum: [1] })).not.toEqual([]);
  });

  it("refuses a wrong _class", () => {
    const p = clone(firstOf("Person"));
    p._class = "Family";
    expect(check(p).length).toBeGreaterThan(0);
    p._class = "Bogus";
    expect(check(p).length).toBeGreaterThan(0);
    const n = clone(firstOf("Person"));
    n.primary_name._class = "Surname";
    expect(check(n).length).toBeGreaterThan(0);
  });

  it("refuses an unknown key, top level and nested", () => {
    const p = clone(firstOf("Person"));
    p.extra_field = 1;
    expect(check(p).some((e) => e.includes("unknown key"))).toBe(true);
    const q = clone(firstOf("Person"));
    q.primary_name.extra_field = 1;
    expect(check(q).length).toBeGreaterThan(0);
  });

  it("refuses a float rect and accepts an integer one", () => {
    const p = clone(fixture.find((o) => o._class === "Person" && (o.media_list || []).some((r) => r.rect && r.rect.every(Number.isInteger))));
    expect(check(p)).toEqual([]);
    for (const r of p.media_list) if (r.rect) r.rect = [10.5, 10, 40, 40];
    expect(check(p).some((e) => e.includes("/rect"))).toBe(true);
  });
});
