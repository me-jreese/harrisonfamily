#!/usr/bin/env node
// Derive the nine editable record schemas (HFY-TSK-232, edit-record-schemas).
//
//   node scripts/records/gen-edit-schemas.mjs           write the schemas and the islands mirror
//   node scripts/records/gen-edit-schemas.mjs --check   exit 1 on any drift, write nothing
//
// Inputs, and only these: gramps/schema/gramps-6.0.6.schema.json (the Gramps get_schema() export) and
// gramps/schema/gramps-6.0.6.labels.json (its _DATAMAP type tables with their labels). The generator opens no
// database, reads no tree data and takes no database path. gramps-6.0.6.sha256 is read only to verify those two
// inputs (integrity metadata, never a data source). `--root <dir>` moves the repository root (tests use it).
//
// Outputs:
//   api/src/records/schemas/<Class>.schema.json   JSON Schema 2020-12, one per class, secondary objects in $defs,
//                                                 each carrying an x-hfy-sha256 header
//   islands/src/lib/edit-schemas.js               the same nine schemas as an ES module, for the browser
//
// What the schemas leave out is the redaction-v1 never-in-cloud list (gramps/redaction/redaction-v1.json, Q2-02):
// the NEVER constants below restate it, and api/test/records/edit-schemas.node-test.js pins them to that file.
// With additionalProperties:false, a dropped field is rejected structurally.
//
// The type enums are closed `oneOf` lists of {value: const} with plain-language titles. The Custom branch accepts a
// string only from the store's registry, which the server injects at run time (DEC-E10); it is marked
// x-hfy-custom-registry here and never lists strings.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const CLASSES = ["Person", "Family", "Event", "Place", "Source", "Citation", "Repository", "Media", "Note"];

const SCHEMA_PATH = "gramps/schema/gramps-6.0.6.schema.json";
const LABELS_PATH = "gramps/schema/gramps-6.0.6.labels.json";
const SHA_PATH = "gramps/schema/gramps-6.0.6.sha256";
const OUT_DIR = "api/src/records/schemas";
const MIRROR_PATH = "islands/src/lib/edit-schemas.js";
const DIALECT = "https://json-schema.org/draft/2020-12/schema";

// redaction-v1: what never goes to the cloud (Q2-02 items 2 and 4, as amended by BRD2 section 11.1).
export const NEVER = {
  // Whole fields. Person and Repository addresses, LDS ordinances, alternate locations (street, locality, postal and
  // phone live only there), and the postal code of a place.
  props: {
    Person: ["address_list", "lds_ord_list"],
    Family: ["lds_ord_list"],
    Repository: ["address_list"],
    // Place.code stays in the schema: BRD2 3.3 and IF-04 make "Place code on administrative types" a member proposal
    // row. The per-type rule (local-only below the administrative level, rule place.code.local_only) belongs to the
    // field policy and the guard; the schema only bounds the value.
    Place: ["alt_loc"],
  },
  // Classes that exist only inside the dropped fields.
  classes: ["Address", "LdsOrd", "Location"],
  // Type-table values removed from the member enums.
  typeValues: {
    AttributeType: [3, 6, 10, 11, 12, 14], // Identification Number, SSN, Age, Father's Age, Mother's Age, Time
    UrlType: [1], // E-mail
    PlaceType: [7, 18, 19, 20], // Street, Farm, Building, Number
  },
  urlSchemes: ["mailto", "tel", "sms", "callto", "facetime", "skype", "whatsapp"],
  customHomeLike: { pattern: "house|home|residence|address|apartment|apt|lot|farm", flags: "i" },
};

// Titles the label tables do not give in plain language.
const TITLE_OVERRIDES = {
  NameOriginType: { 1: "None" },
  EventType: { 20: "Cause of death" },
  NoteType: { 24: "HTML code", 25: "To-do" },
  SourceMediaType: {},
};
const TYPE_TITLES = {
  AttributeType: "Attribute type",
  ChildRefType: "Relationship to parent",
  EventRoleType: "Role in the event",
  EventType: "Event type",
  FamilyRelType: "Family relationship",
  NameOriginType: "Surname origin",
  NameType: "Name type",
  NoteType: "Note type",
  PlaceType: "Place type",
  RepositoryType: "Repository type",
  SourceMediaType: "Source media type",
  SrcAttributeType: "Source attribute type",
  UrlType: "Link type",
};

// Single-line text: no control characters, no leading or trailing whitespace. NFC normalisation and trimming are
// applied by the server before validation (x-hfy-normalize); the pattern rejects what survives them.
const LINE = "^(?!\\s)[^\\p{Cc}]*(?<!\\s)$";
const PARAGRAPHS = "^(?!\\s)(?:[^\\p{Cc}]|[\\n\\t])*(?<!\\s)$";
// Name parts use `*`, not editing.md 6.1's `+`: Gramps name parts (nick, call, suffix and so on) are optional and
// stored as "". Pinned by a test; edit-field-policy owns any further restriction (for example a wider suffix set).
const NAME_PART = "^(?!\\s)[\\p{L}\\p{M} .'’-]*(?<!\\s)$";
const PLACE_CODE = "^(?!\\s)[A-Za-z0-9 ._/-]*(?<!\\s)$";
// Handles and references: ASCII identifier characters only.
const HANDLE = "^[A-Za-z0-9_-]+$";
const HANDLE_OR_EMPTY = "^[A-Za-z0-9_-]*$";
// Links are an allow-list: http(s) only, no whitespace (any Unicode space) and no control characters. This rejects
// javascript:, data:, file:, protocol-relative and every contact scheme (NEVER.urlSchemes) in one rule.
const HTTP_URL = "^[Hh][Tt][Tt][Pp][Ss]?://[^\\s\\p{Cc}]+$";
// Media paths are relative to the media root: no scheme, no absolute path, no backslash, no `..` segment.
const MEDIA_PATH = "^(?!\\s)(?![A-Za-z][A-Za-z0-9+.-]*:)(?!/)(?!.*(?:^|/)\\.\\.(?:/|$))[^\\p{Cc}\\\\]*(?<!\\s)$";
const COORDINATE = "^(?:[+-]?[0-9]{1,3}(?:\\.[0-9]{1,2})?)?$";
const caseless = (word) => [...word].map((c) => `[${c.toUpperCase()}${c.toLowerCase()}]`).join("");
const CUSTOM_PLACE_ALLOWED = `^(?!\\s)(?!.*(?:${NEVER.customHomeLike.pattern.split("|").map(caseless).join("|")}))[^\\p{Cc}]*(?<!\\s)$`;

const NAME_PARTS = {
  Name: ["first_name", "call", "nick", "famnick", "title", "suffix", "group_as"],
  Surname: ["surname", "prefix", "connector"],
};
const LENGTHS = {
  "Event.description": 500, "Media.desc": 500, "Url.desc": 500, "Citation.page": 500, "Attribute.value": 500,
  "SrcAttribute.value": 500, "Media.path": 500, "Media.thumb": 500,
  "Source.title": 200, "Source.author": 200, "Source.pubinfo": 200, "Source.abbrev": 200, "Place.title": 200,
  "PlaceName.value": 200, "Repository.name": 200,
  "PersonRef.rel": 100, "RepoRef.call_number": 100, "Media.mime": 100, "Media.checksum": 64, "PlaceName.lang": 20,
  "Url.path": 2000, "Date.format": 50, "Date.text": 100,
};
const GENDER = [[0, "Female"], [1, "Male"], [2, "Unknown"]];
const CONFIDENCE = [[0, "Very low"], [1, "Low"], [2, "Normal"], [3, "High"], [4, "Very high"]];
const NOTE_FORMAT = [[0, "Flowed text"], [1, "Preformatted text"]];
const COMPLETE = [[0, "Not complete"], [1, "Complete"]];

const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const titled = (pairs) => ({ type: "integer", oneOf: pairs.map(([value, title]) => ({ const: value, title })) });

function loadInputs(root) {
  const schemaText = readFileSync(join(root, SCHEMA_PATH));
  const labelsText = readFileSync(join(root, LABELS_PATH));
  const recorded = Object.fromEntries(
    readFileSync(join(root, SHA_PATH), "utf8").split("\n").filter(Boolean).map((line) => {
      const [hash, name] = line.trim().split(/\s+/);
      return [name, hash];
    }),
  );
  const schemaSha = sha256(schemaText);
  const labelsSha = sha256(labelsText);
  const problems = [];
  if (recorded["gramps-6.0.6.schema.json"] !== schemaSha) problems.push(`${SCHEMA_PATH} does not match ${SHA_PATH}`);
  if (recorded["gramps-6.0.6.labels.json"] !== labelsSha) problems.push(`${LABELS_PATH} does not match ${SHA_PATH}`);
  return { schema: JSON.parse(schemaText), labels: JSON.parse(labelsText), schemaSha, labelsSha, problems };
}

function typeDef(name, table) {
  const drop = new Set(NEVER.typeValues[name] ?? []);
  const overrides = TITLE_OVERRIDES[name] ?? {};
  const branches = [];
  let customBranch = null;
  for (const entry of table.entries) {
    if (entry.value === table.custom) {
      customBranch = {
        title: "Custom (your own wording)",
        properties: { value: { const: entry.value }, string: { type: "string", minLength: 1, maxLength: 100, pattern: name === "PlaceType" ? CUSTOM_PLACE_ALLOWED : LINE } },
        required: ["value", "string"],
        "x-hfy-custom-registry": name,
      };
      continue;
    }
    if (drop.has(entry.value)) continue;
    const title = overrides[entry.value] ?? entry.label;
    branches.push({ title, properties: { value: { const: entry.value }, string: { const: "" } }, required: ["value"] });
  }
  if (customBranch) branches.push(customBranch);
  const def = {
    title: TYPE_TITLES[name] ?? name,
    type: "object",
    additionalProperties: false,
    properties: {
      _class: { enum: [name] },
      string: { type: "string", maxLength: 100 },
      value: { type: "integer" },
    },
    required: ["_class", "value"],
    oneOf: branches,
  };
  if (name === "PlaceType") def["x-hfy-custom-deny"] = { ...NEVER.customHomeLike, reason: "home-like custom place types never reach the cloud" };
  return def;
}

function dateDef() {
  const ints = (max) => ({ type: "integer", minimum: 0, maximum: max });
  const half = [ints(31), ints(12), ints(9999), { type: "boolean" }];
  return {
    title: "Date",
    type: "object",
    additionalProperties: false,
    properties: {
      _class: { enum: ["Date"] },
      calendar: { title: "Calendar", type: "integer", minimum: 0, maximum: 6 },
      dateval: { title: "Values", type: "array" },
      format: { title: "Format", type: ["null", "string"], maxLength: LENGTHS["Date.format"] },
      modifier: { title: "Modifier", type: "integer", minimum: 0, maximum: 6 },
      newyear: { title: "New year begins", type: "integer", minimum: 0, maximum: 5 },
      quality: { title: "Quality", type: "integer", minimum: 0, maximum: 2 },
      sortval: { title: "Sort value", type: "integer", minimum: 0 },
      text: { title: "Text", type: "string", maxLength: LENGTHS["Date.text"], pattern: LINE },
    },
    required: ["_class", "modifier", "dateval"],
    allOf: [
      {
        // dateval is [day, month, year, slash] once, and twice for a range (4) or a span (5).
        if: { properties: { modifier: { enum: [4, 5] } }, required: ["modifier"] },
        then: { properties: { dateval: { type: "array", minItems: 8, maxItems: 8, prefixItems: [...half, ...half], items: false } } },
        else: { properties: { dateval: { type: "array", minItems: 4, maxItems: 4, prefixItems: half, items: false } } },
      },
      {
        // text is empty unless the modifier is TEXTONLY (6).
        if: { properties: { modifier: { const: 6 } }, required: ["modifier"] },
        else: { properties: { text: { maxLength: 0 } } },
      },
    ],
    "x-hfy-note": "This schema does not enforce the no-date-of-birth rule: any day and month is valid here. A birth-like event never reaches the cloud with a day or month (redaction-v1 isBirthLike), enforced by the guard (edit-guard-wiring, BRD2 D2-32). The day must fit the month, the calendar must be Gregorian or Julian for members and no date is in the future: these run in api/src/records/semantics.js.",
  };
}

class Deriver {
  constructor({ schema, labels }) {
    this.sources = schema.$defs;
    this.labels = labels.tables;
    this.defs = {};
    this.cache = new Map();
  }

  refTo(name) {
    return { $ref: `#/$defs/${name}` };
  }

  // Convert a node of the Gramps schema. `cls` and `prop` name its owner, for the per-field rules.
  node(node, cls, prop) {
    if (node.properties?._class?.enum) {
      const name = node.properties._class.enum[0];
      if (this.labels[name]) return this.type(name);
      if (name === "Date") return this.klass("Date", node);
      return this.klass(name, node);
    }
    if (node.type === "array") {
      const out = { ...node, items: this.node(node.items, cls, prop), maxItems: node.maxItems ?? 500 };
      return out;
    }
    if (node.oneOf && `${cls}.${prop}` !== "MediaRef.rect") return { ...node, oneOf: node.oneOf.map((n) => this.node(n, cls, prop)) };
    return this.leaf(node, cls, prop);
  }

  type(name) {
    if (!this.defs[name]) this.defs[name] = typeDef(name, this.labels[name]);
    return this.refTo(name);
  }

  klass(name, node) {
    if (NEVER.classes.includes(name)) throw new Error(`class ${name} must not be reachable`);
    if (!this.cache.has(name)) {
      this.cache.set(name, null);
      this.defs[name] = name === "Date" ? dateDef() : this.object(name, node);
      this.cache.set(name, true);
    }
    return this.refTo(name);
  }

  object(name, node) {
    const drop = new Set(NEVER.props[name] ?? []);
    const properties = {};
    for (const [key, value] of Object.entries(node.properties)) {
      if (drop.has(key)) continue;
      properties[key] = key === "_class" ? value : this.node(value, name, key);
    }
    const out = { ...node, properties };
    if (name === "Event") out["x-hfy-note"] = "Birth-like events: the schema accepts any day and month; the no-date-of-birth rule is enforced by the guard (redaction-v1 isBirthLike, edit-guard-wiring), not here.";
    return out;
  }

  leaf(node, cls, prop) {
    const key = `${cls}.${prop}`;
    const out = { ...node };
    const isString = node.type === "string" || (Array.isArray(node.type) && node.type.includes("string"));
    const handleLike = isString && (prop === "handle" || prop === "ref" || /_handle$/.test(prop) || /_list$/.test(prop) || key === "Event.place");
    if (handleLike) {
      const nullable = Array.isArray(node.type) && node.type.includes("null");
      out.maxLength = 50;
      if (nullable || key === "Event.place") out.pattern = HANDLE_OR_EMPTY;
      else {
        out.minLength = 1;
        out.pattern = HANDLE;
      }
    } else if (isString && !("maxLength" in node)) {
      if (NAME_PARTS[cls]?.includes(prop)) {
        out.maxLength = 100;
        out.pattern = NAME_PART;
      } else if (key === "Place.lat" || key === "Place.long") {
        out.maxLength = 7;
        out.pattern = COORDINATE;
      } else if (key === "Url.path") {
        out.maxLength = LENGTHS[key];
        out.minLength = 1;
        out.pattern = HTTP_URL;
      } else if (key === "Media.path" || key === "Media.thumb") {
        out.maxLength = LENGTHS[key];
        out.pattern = MEDIA_PATH;
      } else if (key === "Place.code") {
        out.maxLength = 20;
        out.pattern = PLACE_CODE;
        out["x-hfy-note"] = "Local-only unless the place type is administrative (rule place.code.local_only, PS-15): the field policy and the guard enforce the per-type rule; this schema only bounds the value.";
      } else if (key === "StyledText.string") {
        out.maxLength = 10000;
        out.pattern = PARAGRAPHS;
      } else if (prop === "gramps_id") {
        out.maxLength = 30;
        out.pattern = "^[A-Za-z0-9_-]*$";
      } else {
        out.maxLength = LENGTHS[key] ?? 200;
        out.pattern = LINE;
      }
    }
    if (key === "Person.gender") return { ...titled(GENDER), title: node.title };
    if (key === "Citation.confidence") return { ...titled(CONFIDENCE), title: node.title };
    if (key === "Note.format") return { ...titled(NOTE_FORMAT), title: node.title };
    if (key === "Family.complete") return { ...titled(COMPLETE), title: node.title };
    if (key === "MediaRef.rect") {
      return { title: "Region", oneOf: [{ type: "null" }, { type: "array", items: { type: "integer", minimum: 0, maximum: 100 }, minItems: 4, maxItems: 4 }] };
    }
    if (node.type === "integer" && /^(change|birth_ref_index|death_ref_index)$/.test(prop)) {
      out.minimum = prop === "change" ? 0 : -1;
    }
    return out;
  }
}

function usedDefs(root, defs) {
  const seen = new Set();
  const walk = (value) => {
    if (Array.isArray(value)) return value.forEach(walk);
    if (!value || typeof value !== "object") return;
    for (const [k, v] of Object.entries(value)) {
      if (k === "$ref") {
        const name = v.slice("#/$defs/".length);
        if (!seen.has(name)) {
          seen.add(name);
          walk(defs[name]);
        }
      } else walk(v);
    }
  };
  walk(root);
  return [...seen].sort();
}

export function derive(root) {
  const inputs = loadInputs(root);
  const out = {};
  for (const name of CLASSES) {
    const deriver = new Deriver(inputs);
    const source = inputs.schema.$defs[name];
    const body = deriver.object(name, source);
    const needed = usedDefs(body, deriver.defs);
    const defs = Object.fromEntries(needed.map((n) => [n, deriver.defs[n]]));
    const rest = {
      $schema: DIALECT,
      $id: `hfy:records/${name}`,
      title: `${name} (editable record)`,
      ...body,
      "x-hfy": {
        generator: "scripts/records/gen-edit-schemas.mjs",
        policy: "redaction-v1",
        gramps: inputs.schema["x-gramps"]?.gramps_version ?? null,
        sourceSchemaSha256: inputs.schemaSha,
        sourceLabelsSha256: inputs.labelsSha,
        dropped: NEVER.props[name] ?? [],
        normalize: ["NFC", "trim"],
      },
      $defs: defs,
    };
    const hash = sha256(JSON.stringify(rest, null, 2) + "\n");
    out[name] = { "x-hfy-sha256": hash, ...rest };
  }
  return { schemas: out, problems: inputs.problems };
}

export function render(schemas) {
  const files = {};
  for (const name of CLASSES) files[`${OUT_DIR}/${name}.schema.json`] = JSON.stringify(schemas[name], null, 2) + "\n";
  const hashes = Object.fromEntries(CLASSES.map((n) => [n, schemas[n]["x-hfy-sha256"]]));
  const combined = sha256(CLASSES.map((n) => `${n} ${hashes[n]}`).join("\n"));
  files[MIRROR_PATH] = [
    "// GENERATED by scripts/records/gen-edit-schemas.mjs from gramps/schema/gramps-6.0.6.*. Do not edit by hand:",
    "// `node scripts/records/gen-edit-schemas.mjs` rewrites it and `--check` fails on any drift.",
    "// Mirror of api/src/records/schemas/<Class>.schema.json (HFY-TSK-232). Not imported by any island yet.",
    `// sha256 ${combined}`,
    "",
    `export const EDIT_SCHEMA_SHA256 = ${JSON.stringify(hashes, null, 2)};`,
    "",
    `export const EDIT_SCHEMAS = ${JSON.stringify(schemas, null, 2)};`,
    "",
    "export default EDIT_SCHEMAS;",
    "",
  ].join("\n");
  return files;
}

export function check(root) {
  const { schemas, problems } = derive(root);
  const files = render(schemas);
  for (const [path, text] of Object.entries(files)) {
    const file = join(root, path);
    if (!existsSync(file)) problems.push(`${path} is missing`);
    else if (readFileSync(file, "utf8") !== text) problems.push(`${path} differs from the regenerated output`);
  }
  const dir = join(root, OUT_DIR);
  if (existsSync(dir)) {
    for (const f of readdirSync(dir)) {
      if (!files[`${OUT_DIR}/${f}`]) problems.push(`${OUT_DIR}/${f} is not a generated schema`);
    }
  }
  return problems;
}

function main(argv) {
  let root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  let checkOnly = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--check") checkOnly = true;
    else if (argv[i] === "--root" && argv[i + 1]) root = resolve(argv[++i]);
    else {
      console.error("usage: gen-edit-schemas.mjs [--check] [--root <repository root>]");
      return 2;
    }
  }
  if (checkOnly) {
    const problems = check(root);
    if (problems.length) {
      for (const p of problems) console.error(`drift: ${p}`);
      console.error("run `node scripts/records/gen-edit-schemas.mjs` and commit the result");
      return 1;
    }
    console.log("edit schemas are current");
    return 0;
  }
  const { schemas, problems } = derive(root);
  if (problems.length) {
    for (const p of problems) console.error(`input: ${p}`);
    return 1;
  }
  const files = render(schemas);
  mkdirSync(join(root, OUT_DIR), { recursive: true });
  for (const [path, text] of Object.entries(files)) writeFileSync(join(root, path), text);
  console.log(`wrote ${Object.keys(files).length} files`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
