#!/usr/bin/env python3
"""Generate gramps/hfygramps/blanks.py: the blank Gramps 6.0.6 object of every object class (HFY-TSK-409).

Gramps reads every key of an object it loads (`Event.set_object_state` pops `description`, and a website-created Event that lacks it
raises KeyError), so the addon completes an object from the website with the keys of a blank object of its class before it hands it to
Gramps (`hfygramps/blank.py`, `hfy_sync_tool.GrampsTree.apply`), and the merge treats a missing key and its blank value as the same
(`merge.py`). The apply asks Gramps itself for the blank; this table is the Gramps-free copy the merge and CI use, and the Gramps lane
(tests/gramps/test_addon_blank.py) proves the two agree.

Run it under the bundled Gramps with the shim, never with a system Python:

    gramps/tests/gramps/gramps-shim.sh --script gramps/scripts/gen-blanks.py            # rewrite gramps/hfygramps/blanks.py
    gramps/tests/gramps/gramps-shim.sh --script gramps/scripts/gen-blanks.py --check    # byte comparison, writes nothing

It reads only class definitions and builds empty instances: it opens no family database and no file of the user. The output is
a pure function of the Gramps version.
"""
import argparse
import inspect
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.normpath(os.path.join(HERE, "..", "hfygramps", "blanks.py"))
GRAMPS_VERSION = "6.0.6"
LOCALE = {"LANG": "en_US.UTF-8", "LC_ALL": "en_US.UTF-8", "LANGUAGE": "en"}
os.environ.update(LOCALE)

# The object classes of gen-schema.py (27) and StyledText, which gen-schema.py leaves out of its schema but whose blank a Note needs.
NOT_OBJECT_CLASSES = ("PrimaryObject", "GrampsType", "MarkerType", "StyledTextTagType")

HEADER = '''"""The blank Gramps %s object of every object class (generated: do not edit; HFY-TSK-409).

Written by gramps/scripts/gen-blanks.py under the bundled Gramps, which checks it byte for byte with --check. Each value is
`object_to_dict(Class())`. `hfygramps/blank.py` reads it; standard library only.
"""
import json

#: The Gramps version the table was built from. tests/unit/test_addon_sparse.py fails when this is not the version the repository pins
#: (hfygramps/schema_check.py STEM), so a Gramps upgrade cannot pass CI with a stale table: regenerate it with this script.
GRAMPS_VERSION = "%s"

BLANKS = json.loads(r\'\'\'
%s\'\'\')
'''


def build():
    import gramps.gen.lib as lib
    from gramps.gen.lib.json_utils import object_to_dict
    from gramps.version import VERSION

    if VERSION != GRAMPS_VERSION:
        raise SystemExit("Gramps %s is not %s" % (VERSION, GRAMPS_VERSION))
    out = {}
    for name, cls in sorted(vars(lib).items()):
        if not inspect.isclass(cls) or not hasattr(cls, "get_schema") or name.endswith("Type") or name in NOT_OBJECT_CLASSES:
            continue
        schema = cls.get_schema()
        if not isinstance(schema, dict) or schema.get("properties", {}).get("_class", {}).get("enum") != [name]:
            continue
        out[name] = object_to_dict(cls())
    if len(out) != 28:
        raise SystemExit("expected 28 object classes, found %d: %s" % (len(out), sorted(out)))
    body = json.dumps(out, indent=1, sort_keys=True, ensure_ascii=False)
    return (HEADER % (GRAMPS_VERSION, GRAMPS_VERSION, body + "\n")).encode("utf-8")


def main(argv):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--check", action="store_true", help="compare with the committed file; write nothing")
    ap.add_argument("--out", default=OUT, help="output file (default gramps/hfygramps/blanks.py)")
    args = ap.parse_args(argv)
    data = build()
    if args.check:
        try:
            with open(args.out, "rb") as fh:
                same = fh.read() == data
        except OSError:
            same = False
        if not same:
            print("DRIFT: regenerated output differs from the committed " + args.out, file=sys.stderr)
            return 1
        print("ok: blanks.py matches")
        return 0
    with open(args.out, "wb") as fh:
        fh.write(data)
    print("wrote %s" % args.out)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
