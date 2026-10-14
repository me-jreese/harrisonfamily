// Editable record schema tests (HFY-TSK-232, edit-record-schemas). Plain node:test: `node --test test/records/edit-schemas.node-test.js`
// needs no network, no AWS and no Gramps. Every fixture is synthetic: made-up handles, ids and words, no real names,
// dates or contact details.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { CLASSES, NEVER } from "../../../scripts/records/gen-edit-schemas.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(here, "..", "..", "..");
const GEN = join(REPO, "scripts", "records", "gen-edit-schemas.mjs");
const SCHEMA_DIR = join(REPO, "api", "src", "records", "schemas");
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const labels = readJson(join(REPO, "gramps", "schema", "gramps-6.0.6.labels.json")).tables;
const schemas = Object.fromEntries(CLASSES.map((c) => [c, readJson(join(SCHEMA_DIR, `${c}.schema.json`))]));

const ajv = new Ajv2020({ strict: false, allErrors: true });
const validators = Object.fromEntries(CLASSES.map((c) => [c, ajv.compile(schemas[c])]));
const ok = (cls, obj) => {
  const v = validators[cls];
  assert.equal(v(obj), true, JSON.stringify(v.errors?.slice(0, 3)));
};
const bad = (cls, obj) => assert.equal(validators[cls](obj), false, "expected the object to fail validation");

// Synthetic building blocks.
const date = (over = {}) => ({ _class: "Date", modifier: 0, calendar: 0, quality: 0, dateval: [0, 0, 1900, false], text: "", ...over });
const typed = (cls, value, string = "") => ({ _class: cls, value, string });
const attr = (value, text = "sample") => ({ _class: "Attribute", type: typed("AttributeType", value), value: text });
const surname = (name = "Sample") => ({ _class: "Surname", surname: name, primary: true, origintype: typed("NameOriginType", 2) });
const name = () => ({ _class: "Name", first_name: "Testa", surname_list: [surname()], type: typed("NameType", 2) });
const url = (type, path = "https://example.invalid/page") => ({ _class: "Url", type: typed("UrlType", type), path, desc: "A page" });
const base = (cls, extra) => ({ _class: cls, handle: "h0001", gramps_id: "X0001", private: false, tag_list: [], note_list: [], ...extra });

const noNoteList = ({ note_list, ...rest }) => rest;

const FIXTURES = {
  Person: () => base("Person", {
    gender: 2,
    primary_name: name(),
    alternate_names: [{ ...name(), type: typed("NameType", 3) }],
    event_ref_list: [{ _class: "EventRef", ref: "h0002", role: typed("EventRoleType", 1), attribute_list: [attr(2)] }],
    family_list: ["h0003"],
    parent_family_list: ["h0004"],
    person_ref_list: [{ _class: "PersonRef", ref: "h0005", rel: "Friend" }],
    media_list: [{ _class: "MediaRef", ref: "h0006", rect: [0, 0, 100, 100] }],
    urls: [url(2)],
    attribute_list: [attr(15, "Sample trade")],
    citation_list: ["h0007"],
    birth_ref_index: 0,
    death_ref_index: -1,
  }),
  Family: () => base("Family", {
    father_handle: "h0010",
    mother_handle: null,
    type: typed("FamilyRelType", 0),
    complete: 1,
    child_ref_list: [{ _class: "ChildRef", ref: "h0011", frel: typed("ChildRefType", 1), mrel: typed("ChildRefType", 1) }],
    event_ref_list: [],
  }),
  Event: () => base("Event", { type: typed("EventType", 13), date: date(), description: "A synthetic event", place: "h0020" }),
  Place: () => base("Place", {
    title: "Sample Town",
    name: { _class: "PlaceName", value: "Sample Town", lang: "en" },
    place_type: typed("PlaceType", 4),
    lat: "12.34",
    long: "-56.78",
    placeref_list: [{ _class: "PlaceRef", ref: "h0021" }],
    urls: [url(2)],
  }),
  Source: () => base("Source", {
    title: "A synthetic source",
    author: "Sample Author",
    reporef_list: [{ _class: "RepoRef", ref: "h0030", call_number: "Box 1", media_type: typed("SourceMediaType", 2) }],
    attribute_list: [{ _class: "SrcAttribute", type: typed("SrcAttributeType", 0, "Shelf"), value: "Top" }],
  }),
  Citation: () => base("Citation", { source_handle: "h0031", page: "Page 3", confidence: 2, date: date({ modifier: 4, dateval: [0, 0, 1900, false, 0, 0, 1901, false] }) }),
  Repository: () => base("Repository", { name: "A synthetic archive", type: typed("RepositoryType", 4), urls: [url(2)] }),
  Media: () => base("Media", { path: "photos/sample.jpg", mime: "image/jpeg", desc: "A synthetic picture", checksum: "0".repeat(32), date: date(), attribute_list: [attr(2)] }),
  Note: () => noNoteList(base("Note", {
    type: typed("NoteType", 1),
    format: 0,
    text: { _class: "StyledText", string: "First line.\nSecond line.", tags: [] },
  })),
};

describe("generator", () => {
  it("takes no database path and refuses unknown arguments", () => {
    for (const args of [["--db", "tree.sqlite"], ["tree.sqlite"], ["--database", "x"]]) {
      const r = spawnSync(process.execPath, [GEN, ...args], { encoding: "utf8" });
      assert.equal(r.status, 2, args.join(" "));
    }
    const text = readFileSync(GEN, "utf8");
    const imports = [...text.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]).sort();
    assert.deepEqual(imports, ["node:crypto", "node:fs", "node:path", "node:url"]);
    assert.doesNotMatch(text.replace(/^\/\/.*$/gm, ""), /sqlite|\.db\b|process\.env/i);
  });

  it("--check passes on the committed output", () => {
    const r = spawnSync(process.execPath, [GEN, "--check"], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  });

  const withCopy = (fn) => {
    const dir = mkdtempSync(join(tmpdir(), "hfy-edit-schemas-"));
    try {
      mkdirSync(join(dir, "gramps"), { recursive: true });
      cpSync(join(REPO, "gramps", "schema"), join(dir, "gramps", "schema"), { recursive: true });
      cpSync(SCHEMA_DIR, join(dir, "api", "src", "records", "schemas"), { recursive: true });
      mkdirSync(join(dir, "islands", "src", "lib"), { recursive: true });
      cpSync(join(REPO, "islands", "src", "lib", "edit-schemas.js"), join(dir, "islands", "src", "lib", "edit-schemas.js"));
      return fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const check = (dir) => spawnSync(process.execPath, [GEN, "--check", "--root", dir], { encoding: "utf8" });

  it("--check exits non-zero after any byte of a committed schema is changed", () => {
    withCopy((dir) => {
      assert.equal(check(dir).status, 0);
      const file = join(dir, "api", "src", "records", "schemas", "Person.schema.json");
      const original = readFileSync(file);
      for (const at of [0, Math.floor(original.length / 2), original.length - 2]) {
        const changed = Buffer.from(original);
        changed[at] = changed[at] === 0x20 ? 0x21 : changed[at] ^ 0x01;
        writeFileSync(file, changed);
        const r = check(dir);
        assert.equal(r.status, 1, `byte ${at}`);
        assert.match(r.stderr, /Person\.schema\.json/);
      }
      writeFileSync(file, original);
      assert.equal(check(dir).status, 0);
    });
  });

  it("--check also fails on drift in the islands mirror, a missing schema, a stray file and an altered input", () => {
    withCopy((dir) => {
      const mirror = join(dir, "islands", "src", "lib", "edit-schemas.js");
      const text = readFileSync(mirror, "utf8");
      writeFileSync(mirror, text.replace("Sample", "Sampl3").replace("Date", "Dat3"));
      assert.equal(check(dir).status, 1);
      writeFileSync(mirror, text);
      assert.equal(check(dir).status, 0);

      writeFileSync(join(dir, "api", "src", "records", "schemas", "Stray.schema.json"), "{}\n");
      assert.equal(check(dir).status, 1);
      rmSync(join(dir, "api", "src", "records", "schemas", "Stray.schema.json"));

      rmSync(join(dir, "api", "src", "records", "schemas", "Note.schema.json"));
      assert.equal(check(dir).status, 1);
    });
    withCopy((dir) => {
      const labelsFile = join(dir, "gramps", "schema", "gramps-6.0.6.labels.json");
      writeFileSync(labelsFile, readFileSync(labelsFile, "utf8").replace("Caste", "Caste2"));
      const r = check(dir);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /sha256|differs/);
    });
  });
});

describe("committed schemas", () => {
  it("are the nine classes, JSON Schema 2020-12, each with a sha256 header that matches its body", () => {
    assert.deepEqual(readdirSync(SCHEMA_DIR).sort(), CLASSES.map((c) => `${c}.schema.json`).sort());
    assert.equal(CLASSES.length, 9);
    for (const cls of CLASSES) {
      const schema = schemas[cls];
      assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
      assert.equal(schema.additionalProperties, false);
      assert.deepEqual(schema.properties._class.enum, [cls]);
      const { "x-hfy-sha256": header, ...rest } = schema;
      assert.match(header, /^[0-9a-f]{64}$/);
      assert.equal(createHash("sha256").update(JSON.stringify(rest, null, 2) + "\n").digest("hex"), header);
      assert.equal(Object.keys(schema)[0], "x-hfy-sha256");
    }
  });

  it("are mirrored byte for byte in islands/src/lib/edit-schemas.js", async () => {
    const mirror = await import(join(REPO, "islands", "src", "lib", "edit-schemas.js"));
    assert.deepEqual(Object.keys(mirror.EDIT_SCHEMAS), CLASSES);
    for (const cls of CLASSES) {
      assert.deepEqual(mirror.EDIT_SCHEMAS[cls], schemas[cls]);
      assert.equal(mirror.EDIT_SCHEMA_SHA256[cls], schemas[cls]["x-hfy-sha256"]);
    }
  });

  it("put secondary objects in $defs and no never-in-cloud class anywhere", () => {
    assert.ok(schemas.Person.$defs.Name && schemas.Person.$defs.Date && schemas.Family.$defs.ChildRef);
    for (const cls of CLASSES) {
      const { "x-hfy": meta, ...body } = schemas[cls];
      assert.deepEqual(meta.dropped, NEVER.props[cls] ?? []);
      const text = JSON.stringify(body);
      for (const never of NEVER.classes) assert.ok(!(never in schemas[cls].$defs), `${cls} defines ${never}`);
      assert.doesNotMatch(text, /"(address_list|lds_ord_list|alt_loc|street|locality|postal|phone)"/);
    }
  });

  it("restate the redaction-v1 never-in-cloud list", () => {
    const policy = readJson(join(REPO, "gramps", "redaction", "redaction-v1.json"));
    const values = (list) => list.map((e) => e.value).sort((a, b) => a - b);
    assert.deepEqual(NEVER.typeValues.PlaceType, values(policy.places.excludedTypes));
    assert.deepEqual(NEVER.typeValues.UrlType, [policy.urls.emailType]);
    assert.deepEqual(NEVER.typeValues.AttributeType, values([...policy.attributes.ageAndTime, ...policy.attributes.governmentId]));
    assert.deepEqual(NEVER.urlSchemes, policy.urls.schemes);
    assert.equal(NEVER.customHomeLike.pattern, policy.places.customHomeLike.pattern);
    assert.equal(NEVER.customHomeLike.flags, policy.places.customHomeLike.flags);
  });
});

describe("validation with synthetic records", () => {
  it("accepts a valid synthetic object of every class", () => {
    for (const cls of CLASSES) ok(cls, FIXTURES[cls]());
  });

  it("rejects a Person with an address_list", () => {
    bad("Person", { ...FIXTURES.Person(), address_list: [{ _class: "Address", city: "Sampleton" }] });
    bad("Person", { ...FIXTURES.Person(), address_list: [] });
  });

  it("rejects LDS ordinances, alternate locations, Place codes and Repository addresses", () => {
    bad("Person", { ...FIXTURES.Person(), lds_ord_list: [] });
    bad("Family", { ...FIXTURES.Family(), lds_ord_list: [] });
    bad("Place", { ...FIXTURES.Place(), alt_loc: [{ _class: "Location", city: "Sampleton" }] });
    bad("Place", { ...FIXTURES.Place(), code: "00000" });
    bad("Repository", { ...FIXTURES.Repository(), address_list: [] });
  });

  it("rejects a Url of type 1 (E-mail) and contact-channel schemes", () => {
    const person = FIXTURES.Person();
    bad("Person", { ...person, urls: [url(1, "https://example.invalid/page")] });
    bad("Repository", { ...FIXTURES.Repository(), urls: [url(1)] });
    bad("Place", { ...FIXTURES.Place(), urls: [url(2, "mailto:someone@example.invalid")] });
    bad("Person", { ...person, urls: [url(2, "TEL:+10000000000")] });
    ok("Person", { ...person, urls: [url(2), url(3), url(4, "ftp://example.invalid/f")] });
  });

  it("rejects an attribute of type 3, 6, 10, 11, 12 or 14 and accepts the others", () => {
    for (const value of [3, 6, 10, 11, 12, 14]) {
      bad("Person", { ...FIXTURES.Person(), attribute_list: [attr(value, "0")] });
      bad("Event", { ...FIXTURES.Event(), attribute_list: [attr(value, "0")] });
    }
    for (const value of [-1, 1, 2, 4, 5, 7, 8, 9, 13, 15]) ok("Person", { ...FIXTURES.Person(), attribute_list: [attr(value)] });
  });

  it("limits Place lat and long to at most 2 decimals", () => {
    for (const good of ["12.34", "-56.7", "0", "90", "+5.25", ""]) ok("Place", { ...FIXTURES.Place(), lat: good, long: good });
    for (const worse of ["12.345", "12.3456789", "abc", "12.", "1234", "12.34N"]) {
      bad("Place", { ...FIXTURES.Place(), lat: worse });
      bad("Place", { ...FIXTURES.Place(), long: worse });
    }
  });

  it("leaves place types 7, 18, 19 and 20 out of the member enum", () => {
    const branchValues = schemas.Place.$defs.PlaceType.oneOf.map((b) => b.properties.value.const);
    for (const never of [7, 18, 19, 20]) assert.ok(!branchValues.includes(never), `place type ${never} present`);
    assert.equal(branchValues.length, labels.PlaceType.entries.length - 4);
    for (const never of [7, 18, 19, 20]) bad("Place", { ...FIXTURES.Place(), place_type: typed("PlaceType", never) });
    for (const good of [-1, 1, 4, 17]) ok("Place", { ...FIXTURES.Place(), place_type: typed("PlaceType", good) });
    ok("Place", { ...FIXTURES.Place(), place_type: typed("PlaceType", 0, "Sample district") });
    bad("Place", { ...FIXTURES.Place(), place_type: typed("PlaceType", 0, "") });
    bad("Place", { ...FIXTURES.Place(), place_type: typed("PlaceType", 99) });
    assert.equal(schemas.Place.$defs.PlaceType["x-hfy-custom-deny"].pattern, NEVER.customHomeLike.pattern);
  });

  it("closes every enum: unknown codes and stray strings fail, customs are marked for the registry", () => {
    bad("Event", { ...FIXTURES.Event(), type: typed("EventType", 9999) });
    bad("Event", { ...FIXTURES.Event(), type: typed("EventType", 13, "stray text") });
    ok("Event", { ...FIXTURES.Event(), type: typed("EventType", 0, "Sample custom event") });
    const custom = schemas.Event.$defs.EventType.oneOf.find((b) => b["x-hfy-custom-registry"]);
    assert.equal(custom["x-hfy-custom-registry"], "EventType");
    assert.equal(custom.properties.value.const, 0);
  });

  it("bounds strings and keeps digits out of name parts", () => {
    const person = FIXTURES.Person();
    bad("Person", { ...person, primary_name: { ...name(), first_name: "Testa 5551234" } });
    bad("Person", { ...person, primary_name: { ...name(), first_name: "x".repeat(101) } });
    bad("Person", { ...person, primary_name: { ...name(), surname_list: [surname("Sample1")] } });
    bad("Person", { ...person, primary_name: { ...name(), first_name: " Testa" } });
    ok("Person", { ...person, primary_name: { ...name(), first_name: "Mary-Jo O’Sample", nick: "" } });
    ok("Person", { ...person, primary_name: { ...name(), first_name: "Élise" } });
    bad("Event", { ...FIXTURES.Event(), description: "x".repeat(501) });
    bad("Event", { ...FIXTURES.Event(), description: "line\u0007bell" });
    bad("Citation", { ...FIXTURES.Citation(), page: "p".repeat(501) });
    bad("Source", { ...FIXTURES.Source(), title: "t".repeat(201) });
    const note = FIXTURES.Note();
    bad("Note", { ...note, text: { ...note.text, string: "n".repeat(10001) } });
    ok("Note", { ...note, text: { ...note.text, string: "n".repeat(10000) } });
    bad("Note", { ...note, text: { ...note.text, string: "bell\u0007" } });
  });

  it("pins the shape of dateval per modifier and keeps text for TEXTONLY dates", () => {
    const event = FIXTURES.Event();
    ok("Event", { ...event, date: date({ modifier: 5, dateval: [0, 0, 1900, false, 0, 0, 1901, false] }) });
    bad("Event", { ...event, date: date({ modifier: 5, dateval: [0, 0, 1900, false] }) });
    bad("Event", { ...event, date: date({ modifier: 0, dateval: [0, 0, 1900, false, 0, 0, 1901, false] }) });
    bad("Event", { ...event, date: date({ dateval: [32, 1, 1900, false] }) });
    bad("Event", { ...event, date: date({ dateval: [1, 13, 1900, false] }) });
    bad("Event", { ...event, date: date({ dateval: [1, 1, 1900] }) });
    bad("Event", { ...event, date: date({ text: "about then" }) });
    ok("Event", { ...event, date: date({ modifier: 6, dateval: [0, 0, 0, false], text: "about then" }) });
  });
});

describe("type tables", () => {
  const owners = {};
  for (const cls of CLASSES) for (const [n, def] of Object.entries(schemas[cls].$defs)) if (labels[n]) owners[n] = def;

  it("has all 13 type tables as enums with plain-language titles", () => {
    assert.equal(Object.keys(labels).length, 13);
    for (const table of Object.keys(labels)) {
      const def = owners[table];
      assert.ok(def, `${table} is used by no schema`);
      const dropped = new Set(NEVER.typeValues[table] ?? []);
      assert.equal(def.oneOf.length, labels[table].entries.length - dropped.size, table);
      for (const branch of def.oneOf) {
        assert.equal(typeof branch.title, "string");
        assert.match(branch.title, /^[A-Za-z][A-Za-z0-9' ()\-/]*$/, `${table}: ${JSON.stringify(branch.title)}`);
        assert.doesNotMatch(branch.title, /_|[a-z][A-Z]/, `${table}: ${branch.title}`);
      }
      const titles = def.oneOf.map((b) => b.title);
      assert.equal(new Set(titles).size, titles.length, `${table} has a duplicate title`);
      }
  });

  it("covers the documented table sizes", () => {
    const expected = { EventType: 47, PlaceType: 22, NoteType: 29, AttributeType: 17, EventRoleType: 20, ChildRefType: 8, FamilyRelType: 5, NameType: 5, UrlType: 6, RepositoryType: 11, SourceMediaType: 15, NameOriginType: 14, SrcAttributeType: 2 };
    for (const [table, n] of Object.entries(expected)) assert.equal(labels[table].entries.length, n, table);
  });

  it("gives Custom its own branch in each table, at the table's custom code", () => {
    for (const [table, def] of Object.entries(owners)) {
      const custom = def.oneOf.filter((b) => b["x-hfy-custom-registry"]);
      assert.equal(custom.length, 1, table);
      assert.equal(custom[0].properties.value.const, labels[table].custom, table);
    }
  });
});
