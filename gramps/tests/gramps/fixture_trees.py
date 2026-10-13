"""Per-test copies of the imported fixture tree (HFY-TSK-228). Standard library only.

run.sh imports synthetic-tree.gramps once into a template tree under a throwaway GRAMPSHOME,
then calls `copy_tree` for every test so no test shares or mutates another's database. A Gramps
tree is one directory (sqlite.db, meta_data.db, name.txt, database.txt) under
<GRAMPSHOME>/gramps/grampsdb/<id>/; a copy is that directory under a new id with a new name.
"""
import hashlib
import json
import os
import pathlib
import shutil
import sqlite3

TABLES = ("tag", "note", "source", "repository", "place", "media", "citation", "event", "person", "family")
TEMPLATE = os.environ.get("HFY_TEMPLATE_TREE", "hfy-template")  # the tree run.sh imports the fixture into


def _readonly(tree_dir):
    """A read-only sqlite3 connection to the tree's sqlite.db (the URI is percent-encoded, so any path works)."""
    uri = pathlib.Path(os.path.abspath(os.path.join(tree_dir, "sqlite.db"))).as_uri() + "?mode=ro"
    return sqlite3.connect(uri, uri=True)


def tree_root(grampshome):
    return os.path.join(grampshome, "gramps", "grampsdb")


def find_tree(grampshome, name):
    """Directory of the tree called `name` under this GRAMPSHOME, or None."""
    root = tree_root(grampshome)
    if not os.path.isdir(root):
        return None
    for entry in sorted(os.listdir(root)):
        name_file = os.path.join(root, entry, "name.txt")
        if os.path.isfile(name_file):
            with open(name_file, encoding="utf-8") as fh:
                if fh.read().strip() == name:
                    return os.path.join(root, entry)
    return None


def copy_tree(grampshome, template_name, copy_name):
    """Copies the template tree to a new tree called `copy_name`; returns the new directory."""
    src = find_tree(grampshome, template_name)
    if src is None:
        raise FileNotFoundError("template tree %r not found under %s" % (template_name, tree_root(grampshome)))
    if find_tree(grampshome, copy_name) is not None:
        raise FileExistsError("tree %r already exists" % copy_name)
    new_id = hashlib.sha1(copy_name.encode()).hexdigest()[:8]
    dest = os.path.join(tree_root(grampshome), new_id)
    shutil.copytree(src, dest, ignore=shutil.ignore_patterns("lock", "*.lock"))
    with open(os.path.join(dest, "name.txt"), "w", encoding="utf-8") as fh:
        fh.write(copy_name)
    return dest


def fresh_copy(testcase, grampshome, template_name=TEMPLATE):
    """A private copy of the template for one test method, removed when the test ends.

    run.sh already gives each test file its own copy (HFY_TREE_NAME); a test that writes to its tree
    and must not disturb the other methods of its file calls this from setUp or from the test.
    """
    dest = copy_tree(grampshome, template_name, "%s-%s" % (os.environ.get("HFY_TREE_NAME", "hfy"), testcase.id()))
    testcase.addCleanup(shutil.rmtree, dest, True)
    return dest


def counts(tree_dir):
    """{table: row count} read straight from the tree's sqlite.db (no Gramps needed)."""
    con = _readonly(tree_dir)
    try:
        return {t: con.execute("SELECT COUNT(*) FROM %s" % t).fetchone()[0] for t in TABLES}
    finally:
        con.close()


def identities(tree_dir):
    """Set of (table, handle, gramps_id) for every object in the tree; tags have no Gramps ID."""
    con = _readonly(tree_dir)
    try:
        out = set()
        for t in TABLES:
            if t == "tag":
                out.update((t, h, "") for (h,) in con.execute("SELECT handle FROM tag"))
            else:
                out.update((t, h, g) for (h, g) in con.execute("SELECT handle, gramps_id FROM %s" % t))
        return out
    finally:
        con.close()


def json_objects(tree_dir):
    """{(table, handle): json_data dict} for every object in the tree, read with sqlite3 only."""
    con = _readonly(tree_dir)
    try:
        return {(t, h): json.loads(j) for t in TABLES
                for (h, j) in con.execute("SELECT handle, json_data FROM %s" % t)}
    finally:
        con.close()


def _xml_rect(rect):
    """What Gramps 6.0.6's XML export and import make of a MediaRef rect.

    The exporter writes each corner with %d (floats are floored) and leaves out a rect of all zeros
    or of 0,0,100,100 (it reads as "the whole picture"); the importer reads the corners as ints.
    """
    if rect is None:
        return None
    x1, y1, x2, y2 = rect  # the exporter tests the raw values, then formats them
    if x1 == y1 == x2 == y2 == 0 or (x1 == y1 == 0 and x2 == y2 == 100):
        return None
    return [int(v) for v in rect]


def expected_after_xml_import(obj):
    """A JSONL object as the template tree holds it after the CLI import of synthetic-tree.gramps.

    The only loss the fixture shows is in MediaRef rects (see _xml_rect); everything else round-trips.
    """
    if isinstance(obj, list):
        return [expected_after_xml_import(v) for v in obj]
    if not isinstance(obj, dict):
        return obj
    out = {k: expected_after_xml_import(v) for k, v in obj.items()}
    if out.get("_class") == "MediaRef" and "rect" in out:
        out["rect"] = _xml_rect(obj["rect"])
    return out


def db_digest(tree_dir):
    """sha256 over every file in the tree directory (names and bytes, sorted), not just sqlite.db."""
    h = hashlib.sha256()
    for dirpath, dirnames, filenames in os.walk(tree_dir):
        dirnames.sort()
        for name in sorted(filenames):
            if name == "lock" or name.endswith(".lock"):
                continue
            path = os.path.join(dirpath, name)
            h.update(os.path.relpath(path, tree_dir).encode() + b"\0")
            with open(path, "rb") as fh:
                h.update(fh.read())
            h.update(b"\0")
    return h.hexdigest()


def main(argv):
    """CLI for run.sh, so no path is ever spliced into a python -c string.

    fixture_trees.py find <grampshome> <name>            print the tree directory or nothing
    fixture_trees.py copy <grampshome> <template> <copy> copy a tree
    fixture_trees.py digest <tree_dir>                   print db_digest
    """
    cmd, args = argv[1], argv[2:]
    if cmd == "find":
        print(find_tree(args[0], args[1]) or "")
    elif cmd == "copy":
        print(copy_tree(args[0], args[1], args[2]))
    elif cmd == "digest":
        print(db_digest(args[0]))
    else:
        raise SystemExit(main.__doc__)


if __name__ == "__main__":
    import sys

    main(sys.argv)
