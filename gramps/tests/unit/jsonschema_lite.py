"""A small JSON Schema (draft-07 subset) validator for the unit tests. Standard library only; test code.

CI's stock python3 has no ``jsonschema``. This implements exactly the keywords ``gramps/redaction/redaction-v1.schema.json``
uses: type, enum, const, required, properties, additionalProperties (false or a schema), items, minItems, uniqueItems, pattern,
minimum, maximum, minLength, definitions and local ``$ref``. An unknown keyword raises, so the schema cannot quietly start
using one this validator ignores.
"""
import json
import re

KNOWN = {"$schema", "$id", "$ref", "title", "description", "type", "enum", "const", "required", "properties", "additionalProperties",
         "items", "minItems", "uniqueItems", "pattern", "minimum", "maximum", "minLength", "definitions"}


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
    raise ValueError("unknown type " + t)


def _same(a, b):
    return json.dumps(a, sort_keys=True) == json.dumps(b, sort_keys=True)


def validate(instance, schema, root=None, path=""):
    """A list of 'pointer: message' strings; empty means valid."""
    root = root if root is not None else schema
    errors = []
    unknown = set(schema) - KNOWN
    if unknown:
        raise ValueError("schema uses keywords this validator does not implement: %s" % sorted(unknown))
    if "$ref" in schema:
        ref = schema["$ref"]
        if not ref.startswith("#/"):
            raise ValueError("only local refs: " + ref)
        node = root
        for tok in ref[2:].split("/"):
            node = node[tok]
        return validate(instance, node, root, path)
    if "type" in schema and not _type_ok(instance, schema["type"]):
        return ["%s: expected %s" % (path or "/", schema["type"])]
    if "enum" in schema and not any(_same(instance, e) for e in schema["enum"]):
        errors.append("%s: not one of the allowed values" % (path or "/"))
    if "const" in schema and not _same(instance, schema["const"]):
        errors.append("%s: not the required constant" % (path or "/"))
    if isinstance(instance, str):
        if "pattern" in schema and not re.search(schema["pattern"], instance):
            errors.append("%s: does not match %s" % (path or "/", schema["pattern"]))
        if "minLength" in schema and len(instance) < schema["minLength"]:
            errors.append("%s: shorter than %d" % (path or "/", schema["minLength"]))
    if isinstance(instance, (int, float)) and not isinstance(instance, bool):
        if "minimum" in schema and instance < schema["minimum"]:
            errors.append("%s: below %s" % (path or "/", schema["minimum"]))
        if "maximum" in schema and instance > schema["maximum"]:
            errors.append("%s: above %s" % (path or "/", schema["maximum"]))
    if isinstance(instance, dict):
        for key in schema.get("required", []):
            if key not in instance:
                errors.append("%s: missing %s" % (path or "/", key))
        props = schema.get("properties", {})
        extra = schema.get("additionalProperties", True)
        for key, value in instance.items():
            if key in props:
                errors += validate(value, props[key], root, path + "/" + key)
            elif extra is False:
                errors.append("%s: unexpected %s" % (path or "/", key))
            elif isinstance(extra, dict):
                errors += validate(value, extra, root, path + "/" + key)
    if isinstance(instance, list):
        if "minItems" in schema and len(instance) < schema["minItems"]:
            errors.append("%s: fewer than %d items" % (path or "/", schema["minItems"]))
        if schema.get("uniqueItems") and len({json.dumps(v, sort_keys=True) for v in instance}) != len(instance):
            errors.append("%s: items are not unique" % (path or "/"))
        if "items" in schema:
            for i, v in enumerate(instance):
                errors += validate(v, schema["items"], root, "%s/%d" % (path, i))
    return errors
