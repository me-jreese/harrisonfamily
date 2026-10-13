"""Finishes the template tree after the Gramps CLI import (HFY-TSK-228). Needs the bundled Gramps.

    gramps-shim.sh --script prepare_template.py <tree_dir> <fixtures_dir>

run.sh calls it once, before it takes the template's digest and copies the template for the tests.

1. Media path. The fixture's Media paths are relative (media/...). Gramps resolves a relative path
   against the tree's media path, and with none set, against GLib's Pictures folder, which on macOS
   is the account's real ~/Pictures whatever HOME says. So the template's media path is set to the
   fixtures directory: every Media object then resolves to its committed file, and no test can read
   the real Pictures folder through Gramps (run.sh also forbids that folder to the audit hook).
2. MediaRef rects the XML format cannot carry. Gramps' XML export drops a 0,0,100,100 rect and
   floors float corners (fixture_trees._xml_rect), so after the import the full-frame and float
   rect cases are gone. They are put back from synthetic-tree.jsonl, committed with the JSONL change
   time, and the result must equal the JSONL line exactly.

Afterwards every object in the template equals its JSONL line (test_template_tree.py checks this).
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))


def prepare(tree_dir, fixtures_dir):
    """Returns the number of objects whose rects were restored."""
    fixtures_dir = os.path.abspath(fixtures_dir)
    sys.path.insert(0, HERE)
    sys.path.insert(0, fixtures_dir)
    import census
    import fixture_trees as ft
    from gramps.gen.db import DbTxn
    from gramps.gen.db.utils import make_database
    from gramps.gen.lib.json_utils import object_to_dict

    lossy = [o for o in census.load_jsonl(os.path.join(fixtures_dir, "synthetic-tree.jsonl"))
             if ft.expected_after_xml_import(o) != o]
    db = make_database("sqlite")
    db.load(tree_dir, None)
    try:
        db.set_mediapath(fixtures_dir)

        def fetch(o):
            obj = getattr(db, "get_%s_from_handle" % o["_class"].lower())(o["handle"])
            if obj is None:
                raise SystemExit("[FAIL] %s %s is not in the imported tree" % (o["_class"], o.get("gramps_id")))
            return obj

        with DbTxn("hfy fixture: restore the MediaRef rects the XML format drops", db) as trans:
            for o in lossy:
                obj = fetch(o)
                refs = obj.get_media_list()
                if [r.ref for r in refs] != [r["ref"] for r in o["media_list"]]:
                    raise SystemExit("[FAIL] %s: imported media refs differ from the JSONL" % o["gramps_id"])
                for ref, want in zip(refs, o["media_list"]):
                    ref.set_rectangle(tuple(want["rect"]) if want["rect"] is not None else None)
                getattr(db, "commit_%s" % o["_class"].lower())(obj, trans, change_time=o["change"])
        for o in lossy:
            if object_to_dict(fetch(o)) != o:
                raise SystemExit("[FAIL] %s still differs from its JSONL line after the rect restore" % o["gramps_id"])
    finally:
        db.close()
    return len(lossy)


def main(argv):
    if len(argv) != 3:
        raise SystemExit(__doc__)
    n = prepare(argv[1], argv[2])
    print("[OK] media path set to the fixtures directory; rects restored on %d object(s)" % n)


if __name__ == "__main__":
    main(sys.argv)
