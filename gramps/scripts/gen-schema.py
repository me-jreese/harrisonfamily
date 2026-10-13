#!/usr/bin/env python3
"""Generate the Gramps 6.0.6 JSON Schema and the English enum label tables (HFY-PLN-002, HFY-TSK-231).

Single source of Gramps schema truth for the sync and editing tasks (store-apply-core, validator-js,
edit-record-schemas): they read the committed output and never call get_schema() themselves.

Run it under the bundled Gramps with the shim, never with a system Python:

    gramps/tests/gramps/gramps-shim.sh --script gramps/scripts/gen-schema.py            # rewrite gramps/schema/
    gramps/tests/gramps/gramps-shim.sh --script gramps/scripts/gen-schema.py --check    # byte comparison, writes nothing

It reads only the class definitions in the Gramps library (get_schema() and the type _DATAMAP
tables). It opens no family database, no sqlite file and no tree. Output files, in gramps/schema/:

    gramps-6.0.6.schema.json   JSON Schema 2020-12: one $defs entry per Gramps class (27), a oneOf over
                               the ten primary objects, strict (additionalProperties false, _class required)
    gramps-6.0.6.labels.json   English label tables for the type enums editing needs
    gramps-6.0.6.sha256        sha256 of the two files, checked without Gramps by gramps/hfygramps/schema_check.py

The output is a pure function of the Gramps version: the locale is pinned to US English before
Gramps is imported, and keys are sorted.
"""
import argparse
import hashlib
import inspect
import json
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.normpath(os.path.join(HERE, "..", "schema"))
GRAMPS_VERSION = "6.0.6"
DB_SCHEMA = 21
STEM = "gramps-" + GRAMPS_VERSION
LOCALE = {"LANG": "en_US.UTF-8", "LC_ALL": "en_US.UTF-8", "LANGUAGE": "en"}
if __name__ == "__main__":
    os.environ.update(LOCALE)

# The object classes of the schema (get_schema() classes that are not type tables).
PRIMARY = ("Tag", "Note", "Source", "Repository", "Place", "Media", "Citation", "Event", "Person", "Family")
# Type tables editing needs, in the order the labels file lists them.
TYPE_TABLES = (
    "EventType", "PlaceType", "ChildRefType", "FamilyRelType", "EventRoleType", "UrlType", "AttributeType",
    "NameType", "NoteType", "RepositoryType", "SourceMediaType", "NameOriginType", "SrcAttributeType",
)
# Classes get_schema() exposes that are embedded values or abstractions, not standalone object classes.
NOT_OBJECT_CLASSES = ("PrimaryObject", "StyledText", "GrampsType", "MarkerType", "StyledTextTagType")


# Keys Gramps 6.0.6 serializes (object_to_dict of an empty instance) that get_schema() omits, and one
# type it states too narrowly (a StyledTextTag value is True for bold and italic). Each is added to the
# class's schema so real exported objects validate; build() proves with an empty instance of every
# class that no serialized key is left out.
SUPPLEMENTS = {
    "Date": {"format": {"type": ["null", "string"], "title": "Format"}},
    "Family": {"complete": {"type": "integer", "title": "Complete"}},
    "Media": {"thumb": {"type": ["null", "string"], "title": "Thumbnail"}},
    "StyledTextTag": {"value": {"type": ["null", "string", "integer", "boolean"], "title": "Value"}},
}


class GenError(Exception):
    pass


def supplement(node):
    """Apply SUPPLEMENTS to every object schema (nested ones included) by its _class."""
    if isinstance(node, dict):
        out = {k: supplement(v) for k, v in node.items()}
        cls = (out.get("properties", {}).get("_class", {}).get("enum") or [None])[0] if isinstance(out.get("properties"), dict) else None
        if cls in SUPPLEMENTS:
            out["properties"] = dict(out["properties"], **SUPPLEMENTS[cls])
        return out
    if isinstance(node, list):
        return [supplement(v) for v in node]
    return node


def uncovered(value, node, path):
    """Serialized keys the schema does not describe."""
    out = []
    if isinstance(value, dict) and isinstance(node.get("properties"), dict):
        for k, v in value.items():
            if k not in node["properties"]:
                out.append(path + "/" + k)
            else:
                out += uncovered(v, node["properties"][k], path + "/" + k)
    elif isinstance(value, list) and isinstance(node.get("items"), dict):
        for v in value:
            out += uncovered(v, node["items"], path + "[]")
    return out


def strict(node):
    """Close every object schema: no unknown keys, and _class is required."""
    if isinstance(node, dict):
        out = {k: strict(v) for k, v in node.items()}
        if out.get("type") == "object" and isinstance(out.get("properties"), dict):
            out["additionalProperties"] = False
            if "_class" in out["properties"]:
                out["required"] = ["_class"]
        return out
    if isinstance(node, list):
        return [strict(v) for v in node]
    return node


def build():
    import gramps.gen.lib as lib
    from gramps.gen.db.generic import DbGeneric
    from gramps.gen.lib.json_utils import object_to_dict
    from gramps.version import VERSION

    if VERSION != GRAMPS_VERSION:
        raise GenError("Gramps %s is not %s" % (VERSION, GRAMPS_VERSION))
    if DbGeneric.VERSION[0] != DB_SCHEMA:
        raise GenError("DB schema %r is not %d" % (DbGeneric.VERSION, DB_SCHEMA))

    defs = {}
    for name, cls in sorted(vars(lib).items()):
        if not inspect.isclass(cls) or not hasattr(cls, "get_schema") or name.endswith("Type"):
            continue
        if name in NOT_OBJECT_CLASSES:
            continue
        schema = cls.get_schema()
        if not isinstance(schema, dict) or schema.get("properties", {}).get("_class", {}).get("enum") != [name]:
            raise GenError("%s: get_schema() does not describe class %s" % (name, name))
        schema = supplement(schema)
        gaps = uncovered(object_to_dict(cls()), schema, name)
        if gaps:
            raise GenError("serialized keys missing from the %s schema: %s" % (name, gaps))
        defs[name] = strict(schema)
    if len(defs) != 27:
        raise GenError("expected 27 classes, found %d: %s" % (len(defs), sorted(defs)))
    for name in PRIMARY:
        if name not in defs:
            raise GenError("missing primary class " + name)

    meta = {"gramps_version": GRAMPS_VERSION, "db_schema": DB_SCHEMA}
    schema_doc = {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "title": "Gramps %s json_data (DB schema %d)" % (GRAMPS_VERSION, DB_SCHEMA),
        "x-gramps": dict(meta, classes=sorted(defs), primary=list(PRIMARY), supplements=SUPPLEMENTS),
        "oneOf": [{"$ref": "#/$defs/" + n} for n in PRIMARY],
        "$defs": defs,
    }

    tables = {}
    for tname in TYPE_TABLES:
        cls = getattr(lib, tname)
        entries = []
        for value, label, xml in cls._DATAMAP:
            entries.append({"value": value, "label": label, "xml": xml})
        values = [e["value"] for e in entries]
        if len(set(values)) != len(values):
            raise GenError(tname + ": duplicate values")
        tables[tname] = {"custom": cls._CUSTOM, "entries": entries}
    labels_doc = {"x-gramps": dict(meta, locale="en_US"), "tables": tables}
    return {
        STEM + ".schema.json": dump(schema_doc),
        STEM + ".labels.json": dump(labels_doc),
    }


def dump(doc):
    return (json.dumps(doc, indent=1, sort_keys=True, ensure_ascii=False) + "\n").encode("utf-8")


def manifest(files):
    return "".join("%s  %s\n" % (hashlib.sha256(files[n]).hexdigest(), n) for n in sorted(files)).encode()


def main(argv):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--check", action="store_true", help="compare with the committed files; write nothing")
    ap.add_argument("--out", default=OUT_DIR, help="output directory (default gramps/schema)")
    args = ap.parse_args(argv)
    files = build()
    files[STEM + ".sha256"] = manifest(files)
    if args.check:
        bad = []
        for name, data in sorted(files.items()):
            path = os.path.join(args.out, name)
            try:
                with open(path, "rb") as fh:
                    same = fh.read() == data
            except OSError:
                same = False
            if not same:
                bad.append(name)
        if bad:
            print("DRIFT: regenerated output differs from the committed " + ", ".join(bad), file=sys.stderr)
            return 1
        print("ok: %d files match" % len(files))
        return 0
    os.makedirs(args.out, exist_ok=True)
    for name, data in files.items():
        with open(os.path.join(args.out, name), "wb") as fh:
            fh.write(data)
    print("wrote %d files to %s" % (len(files), args.out))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
