"""Per-test copies of the imported fixture tree (HFY-TSK-228). Standard library only.

run.sh imports synthetic-tree.gramps once into a template tree under a throwaway GRAMPSHOME,
then calls `copy_tree` for every test so no test shares or mutates another's database. A Gramps
tree is one directory (sqlite.db, meta_data.db, name.txt, database.txt) under
<GRAMPSHOME>/gramps/grampsdb/<id>/; a copy is that directory under a new id with a new name.
"""
import hashlib
import os
import shutil
import sqlite3

TABLES = ("tag", "note", "source", "repository", "place", "media", "citation", "event", "person", "family")


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


def counts(tree_dir):
    """{table: row count} read straight from the tree's sqlite.db (no Gramps needed)."""
    con = sqlite3.connect("file:%s?mode=ro" % os.path.join(tree_dir, "sqlite.db"), uri=True)
    try:
        return {t: con.execute("SELECT COUNT(*) FROM %s" % t).fetchone()[0] for t in TABLES}
    finally:
        con.close()


def identities(tree_dir):
    """Set of (table, handle, gramps_id) for every object in the tree; tags have no Gramps ID."""
    con = sqlite3.connect("file:%s?mode=ro" % os.path.join(tree_dir, "sqlite.db"), uri=True)
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


def db_digest(tree_dir):
    with open(os.path.join(tree_dir, "sqlite.db"), "rb") as fh:
        return hashlib.sha256(fh.read()).hexdigest()
