"""Runs the live, out-of-repo ETL (and ``build_search_index.js``) on P(fixture). Worker-local only: CI never calls it.

The live ETL is not in this repository (it is io's out-of-repo project, <project>/scripts/etl, D02_RUNBOOK). ``run_legacy(project_root, objects)``
copies ``scripts/etl`` and ``scripts/search`` from that project into a throwaway directory, feeds the ETL a throwaway SQLite
copy of ``objects`` (the shape the live ETL's own tests use), and returns ``{s3_key: bytes}`` for every JSON file it and
``build_search_index.js`` write. The project is never written to, and nothing leaves the throwaway directory.

Three things are pinned so the run is repeatable, none of which changes the bytes the ETL writes:

* the clock: ``build_search_index.js`` stamps ``generatedAt`` from ``new Date()``; a preload fixes it to ``FIXED_AT``;
* the directory order: the script reads ``fs.readdirSync`` unsorted; the preload sorts it (name order);
* the hash seed: the ETL walks Python sets, so the order of entries in ``place/index.json`` and ``media/index.json``
  depends on ``PYTHONHASHSEED``. Those two lists are sorted by (grampsId, handle) after the run, and the renderer does the
  same. Nothing else in the ETL's output depends on set order.

The Gramps library is not needed: the ETL reads JSON rows, and only imports ``gramps.gen.lib`` for the pickled layout, so
the run installs empty stand-ins for those eight class names.
"""

import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import types

FIXED_AT = "2000-01-01T00:00:00.000Z"

#: The files of the live project the golden depends on; their hashes go in the provenance file.
SOURCE_FILES = (
    "scripts/etl/common.py", "scripts/etl/export_person_data.py", "scripts/etl/gramps_labels.py", "scripts/etl/note_tags.py",
    "scripts/etl/privacy_scan.py", "scripts/etl/publish_policy.py", "scripts/etl/transform.py",
    "scripts/search/build_search_index.js",
)

PRELOAD = """
const fs = require('fs');
const real = fs.readdirSync;
fs.readdirSync = function (...args) {
  const out = real.apply(this, args);
  return Array.isArray(out) ? out.slice().sort() : out;
};
Date.prototype.toISOString = function () { return process.env.HFY_FIXED_AT; };
"""

TABLES = ("person", "family", "event", "media", "place", "note", "citation", "source")


def sha256_of(path):
    import hashlib
    with open(path, "rb") as fh:
        return hashlib.sha256(fh.read()).hexdigest()


def provenance(project_root):
    return {rel: sha256_of(os.path.join(project_root, rel)) for rel in SOURCE_FILES}


def _build_db(path, objects):
    conn = sqlite3.connect(path)
    for table in TABLES:
        conn.execute(f"CREATE TABLE {table} (handle TEXT PRIMARY KEY, gramps_id TEXT, json_data TEXT)")
    for obj in objects:
        table = obj["_class"].lower()
        if table in TABLES:
            conn.execute(f"INSERT INTO {table} VALUES (?, ?, ?)", (obj["handle"], obj.get("gramps_id"), json.dumps(obj)))
    conn.commit()
    conn.close()


def _install_gramps_stubs():
    for name in ("gramps", "gramps.gen", "gramps.gen.lib"):
        sys.modules[name] = types.ModuleType(name)
    for cls in ("Citation", "Event", "Family", "Media", "Note", "Person", "Place", "Source"):
        setattr(sys.modules["gramps.gen.lib"], cls, type(cls, (), {}))


def _allowlist(objects, policy):
    """What io would approve if he approved every note and every MediaRef attribute value: the scanner still decides."""
    notes = {o["handle"]: policy.note_digest(o) for o in objects if o["_class"] == "Note"}
    attributes = {}
    for person in (o for o in objects if o["_class"] == "Person"):
        for ref_index, mref in enumerate(person.get("media_list") or []):
            for attr_index, attribute in enumerate(mref.get("attribute_list") or []):
                key = policy.mediaref_attribute_key(person["handle"], mref["ref"], ref_index, attr_index)
                attributes[key] = policy.mediaref_attribute_digest(attribute)
    return {"version": 1, "notes": notes, "region_notes": {}, "mediaref_attributes": attributes}


def run_legacy(project_root, objects, media_dir, held_blob_paths=(), node="node"):
    work = tempfile.mkdtemp(prefix="hfy-legacy-golden-")
    saved_modules = dict(sys.modules)
    saved_path, saved_cwd, saved_flag = list(sys.path), os.getcwd(), sys.dont_write_bytecode
    try:
        sys.dont_write_bytecode = True
        scripts = os.path.join(work, "p", "scripts")
        os.makedirs(scripts)
        shutil.copytree(os.path.join(project_root, "scripts", "etl"), os.path.join(scripts, "etl"),
                        ignore=shutil.ignore_patterns("tests", "__pycache__", "*.bak-*", ".pytest_cache", "publish_allowlist.json"))
        shutil.copytree(os.path.join(project_root, "scripts", "search"), os.path.join(scripts, "search"),
                        ignore=shutil.ignore_patterns("__pycache__", "*.bak-*"))
        # The media tree the ETL reads blobs from (Media.path is relative to it), minus the blobs the projection holds.
        media_root = os.path.join(work, "media-root")
        shutil.copytree(os.path.join(media_dir, "media"), os.path.join(media_root, "media"))
        for rel in held_blob_paths:
            os.remove(os.path.join(media_root, rel))
        db = os.path.join(work, "gramps.db")
        _build_db(db, objects)

        sys.path.insert(0, os.path.join(work, "p"))
        _install_gramps_stubs()
        from scripts.etl import publish_policy  # noqa: E402
        allow = os.path.join(work, "allowlist.json")
        with open(allow, "w", encoding="utf-8") as fh:
            json.dump(_allowlist(objects, publish_policy), fh)
        from scripts.etl import export_person_data  # noqa: E402
        out = os.path.join(work, "out")
        os.chdir(media_root)
        import contextlib
        import io
        with contextlib.redirect_stdout(io.StringIO()):
            export_person_data.main(["--db", db, "--output", out, "--allowlist", allow])
        os.chdir(saved_cwd)

        preload = os.path.join(work, "preload.js")
        with open(preload, "w", encoding="utf-8") as fh:
            fh.write(PRELOAD)
        env = dict(os.environ, HFY_PERSON_DIR=os.path.join(out, "person"), HFY_FIXED_AT=FIXED_AT)
        subprocess.run([node, "-r", preload, os.path.join(scripts, "search", "build_search_index.js")], check=True,
                       env=env, stdout=subprocess.DEVNULL)

        files = {}
        for prefix in ("person", "family", "event", "note", "place", "media"):
            folder = os.path.join(out, prefix)
            for name in sorted(os.listdir(folder)):
                if name.endswith(".json"):
                    with open(os.path.join(folder, name), "rb") as fh:
                        files[f"{prefix}/{name}"] = fh.read()
        for key in ("place/index.json", "media/index.json"):
            entries = json.loads(files[key])
            entries.sort(key=lambda e: (str(e.get("grampsId") or ""), str(e.get("handle") or "")))
            files[key] = json.dumps(entries, indent=2, sort_keys=True).encode("utf-8")
        return {key: files[key] for key in sorted(files)}
    finally:
        os.chdir(saved_cwd)
        sys.path[:] = saved_path
        sys.dont_write_bytecode = saved_flag
        for name in list(sys.modules):
            if name not in saved_modules:
                del sys.modules[name]
        shutil.rmtree(work, ignore_errors=True)
