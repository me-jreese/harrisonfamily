"""Stdlib-only check of the committed Gramps schema goldens (HFY-TSK-231, review DL-14).

No Gramps needed, so any worker or CI job can run it:

    python3 gramps/hfygramps/schema_check.py

It verifies gramps/schema/*.sha256 against the files, checks the version and DB schema the files
record, and validates every object of the synthetic fixture tree against the schema with a small
validator that implements the subset of JSON Schema the generator emits (type, enum, properties,
additionalProperties, required, items, minItems, maxItems, minimum, maximum, maxLength, oneOf, $ref
to #/$defs/...). Anything else in a schema raises, so the subset cannot silently grow.
"""
import hashlib
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
SCHEMA_DIR = os.path.join(REPO, "gramps", "schema")
STEM = "gramps-6.0.6"
JSONL = os.path.join(REPO, "gramps", "tests", "fixtures", "synthetic-tree.jsonl")
CENSUS = os.path.join(REPO, "gramps", "tests", "fixtures", "synthetic-tree.census.json")

ANNOTATIONS = {"title", "$schema", "x-gramps", "$defs"}
KEYWORDS = {"type", "enum", "properties", "additionalProperties", "required", "items", "minItems", "maxItems",
            "minimum", "maximum", "maxLength", "oneOf", "$ref"} | ANNOTATIONS


def load(name):
    with open(os.path.join(SCHEMA_DIR, name), encoding="utf-8") as fh:
        return json.load(fh)


def verify_hashes(schema_dir=SCHEMA_DIR):
    """Return a list of problems with the sha256 manifest (empty when it matches)."""
    problems = []
    with open(os.path.join(schema_dir, STEM + ".sha256"), encoding="utf-8") as fh:
        rows = [line.split(None, 1) for line in fh.read().splitlines() if line.strip()]
    names = sorted(r[1].strip() for r in rows)
    if names != [STEM + ".labels.json", STEM + ".schema.json"]:
        problems.append("manifest lists %r" % names)
    for digest, name in rows:
        with open(os.path.join(schema_dir, name.strip()), "rb") as fh:
            if hashlib.sha256(fh.read()).hexdigest() != digest:
                problems.append("sha256 mismatch: " + name.strip())
    return problems


def _type_ok(value, t):
    if t == "object":
        return isinstance(value, dict)
    if t == "array":
        return isinstance(value, list)
    if t == "string":
        return isinstance(value, str)
    if t == "boolean":
        return isinstance(value, bool)
    if t == "null":
        return value is None
    if t == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if t == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    raise ValueError("unsupported type " + t)


def validate(value, node, root, path="#"):
    """Return a list of error strings; empty means valid."""
    unknown = set(node) - KEYWORDS
    if unknown:
        raise ValueError("unsupported schema keywords %s at %s" % (sorted(unknown), path))
    if "$ref" in node:
        ref = node["$ref"]
        if not ref.startswith("#/$defs/"):
            raise ValueError("unsupported $ref " + ref)
        return validate(value, root["$defs"][ref[len("#/$defs/"):]], root, path)
    errs = []
    if "oneOf" in node:
        hits = [i for i, sub in enumerate(node["oneOf"]) if not validate(value, sub, root, path)]
        if len(hits) != 1:
            errs.append("%s: matches %d of the oneOf branches" % (path, len(hits)))
    if "type" in node:
        types = node["type"] if isinstance(node["type"], list) else [node["type"]]
        if not any(_type_ok(value, t) for t in types):
            return errs + ["%s: expected %s" % (path, "/".join(types))]
    if "enum" in node and not any(type(value) is type(e) and value == e for e in node["enum"]):
        errs.append("%s: %r not in enum" % (path, value))
    if isinstance(value, str) and "maxLength" in node and len(value) > node["maxLength"]:
        errs.append("%s: longer than %d" % (path, node["maxLength"]))
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if "minimum" in node and value < node["minimum"]:
            errs.append("%s: below minimum" % path)
        if "maximum" in node and value > node["maximum"]:
            errs.append("%s: above maximum" % path)
    if isinstance(value, dict):
        props = node.get("properties", {})
        for key in node.get("required", []):
            if key not in value:
                errs.append("%s: missing %s" % (path, key))
        for key, sub in value.items():
            if key in props:
                errs += validate(sub, props[key], root, path + "/" + key)
            elif node.get("additionalProperties") is False:
                errs.append("%s: unknown key %s" % (path, key))
    if isinstance(value, list):
        if "minItems" in node and len(value) < node["minItems"]:
            errs.append("%s: fewer than %d items" % (path, node["minItems"]))
        if "maxItems" in node and len(value) > node["maxItems"]:
            errs.append("%s: more than %d items" % (path, node["maxItems"]))
        if "items" in node:
            for i, item in enumerate(value):
                errs += validate(item, node["items"], root, "%s/%d" % (path, i))
    return errs


def validate_object(obj, schema):
    """Validate one primary object against $defs/<its _class>; an unknown _class is an error."""
    cls = obj.get("_class") if isinstance(obj, dict) else None
    if cls not in schema["x-gramps"]["primary"]:
        return ["#: _class %r is not a primary Gramps class" % (cls,)]
    return validate(obj, schema["$defs"][cls], schema)


def expected_invalid_ids(census_path=CENSUS):
    """gramps_ids the fixture census marks as deliberate float-rect hostile input (census key rect_float).
    The expected-invalid set is derived from the census, not hard-coded, so a fixture change that adds a
    second hostile object updates one place."""
    with open(census_path, encoding="utf-8") as fh:
        return sorted(json.load(fh)["rect_float"])


def only_rect_errors(errors):
    """True when the schema refused the object for its MediaRef rect and nothing else."""
    return bool(errors) and all("/rect: " in e or "/rect/" in e for e in errors)


def check_fixture(schema, jsonl=JSONL, census_path=CENSUS):
    """Validate every fixture object. Return (count, invalid, problems): invalid maps gramps_id -> errors
    for the census-listed float-rect objects, which must fail with rect errors only; every other object
    must validate."""
    want = set(expected_invalid_ids(census_path))
    invalid, problems, count = {}, [], 0
    with open(jsonl, encoding="utf-8") as fh:
        for n, line in enumerate(fh, 1):
            count += 1
            obj = json.loads(line)
            errs = validate_object(obj, schema)
            gid = obj.get("gramps_id")
            if gid in want:
                if only_rect_errors(errs):
                    invalid[gid] = errs
                else:
                    problems.append("line %d: %s is census rect_float but fails with %r" % (n, gid, errs))
            else:
                problems += ["line %d: %s" % (n, e) for e in errs]
    for gid in sorted(want - set(invalid)):
        problems.append("census rect_float object %s was not refused" % gid)
    return count, invalid, problems


def main():
    problems = verify_hashes()
    schema = load(STEM + ".schema.json")
    meta = schema["x-gramps"]
    if (meta["gramps_version"], meta["db_schema"]) != ("6.0.6", 21):
        problems.append("schema records %r" % meta)
    count, invalid, more = check_fixture(schema)
    problems += more
    print("%d fixture objects checked (%d census rect_float expected invalid), %d problems"
          % (count, len(invalid), len(problems)))
    for p in problems:
        print("  " + p, file=sys.stderr)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
