"""render-core-port: render_site is a pure function (HFY-TSK-229, AC1). Standard library only.

No file, SQLite, network or AWS access: a test patches ``open`` and ``socket`` (and the other ways in) and renders; a second
test reads the package source and refuses any import or call that could reach one. The output is a function of the input:
the same bytes on every run, under any hash seed, on Python 3.12 and 3.13, and the caller's objects are never touched.

Run: python3 -m unittest discover gramps/tests/unit
"""

import ast
import builtins
import copy
import hashlib
import io
import json
import os
import pathlib
import shutil
import socket
import sqlite3
import subprocess
import sys
import unittest
import urllib.request
from unittest import mock

import render_support as rs
from hfygramps import render as render_pkg
from hfygramps.render import render_site

PACKAGE = pathlib.Path(render_pkg.__file__).resolve().parent
OBJECTS = rs.p_fixture()
MEDIA_FILES = rs.parity.media_files(OBJECTS)


def forbidden(name):
    def refuse(*args, **kwargs):
        raise AssertionError("render_site reached %s" % name)
    return refuse


class NoOutsideAccess(unittest.TestCase):
    def test_render_site_with_open_and_socket_patched(self):
        patches = [
            mock.patch.object(builtins, "open", forbidden("open")),
            mock.patch.object(io, "open", forbidden("io.open")),
            mock.patch.object(os, "open", forbidden("os.open")),
            mock.patch.object(os, "listdir", forbidden("os.listdir")),
            mock.patch.object(os, "scandir", forbidden("os.scandir")),
            mock.patch.object(os, "stat", forbidden("os.stat")),
            mock.patch.object(pathlib.Path, "open", forbidden("Path.open")),
            mock.patch.object(pathlib.Path, "read_bytes", forbidden("Path.read_bytes")),
            mock.patch.object(pathlib.Path, "exists", forbidden("Path.exists")),
            mock.patch.object(shutil, "copy2", forbidden("shutil.copy2")),
            mock.patch.object(socket, "socket", forbidden("socket.socket")),
            mock.patch.object(socket, "create_connection", forbidden("socket.create_connection")),
            mock.patch.object(socket, "getaddrinfo", forbidden("socket.getaddrinfo")),
            mock.patch.object(sqlite3, "connect", forbidden("sqlite3.connect")),
            mock.patch.object(subprocess, "Popen", forbidden("subprocess.Popen")),
            mock.patch.object(urllib.request, "urlopen", forbidden("urllib.request.urlopen")),
        ]
        for patch in patches:
            patch.start()
        try:
            with self.assertRaises(AssertionError):
                open("anything")                      # the patch is live
            with self.assertRaises(AssertionError):
                socket.socket()
            files = render_site(OBJECTS, media_files=MEDIA_FILES)
        finally:
            for patch in reversed(patches):
                patch.stop()
        self.assertGreater(len(files), 100)
        self.assertTrue(all(isinstance(k, str) and isinstance(v, bytes) for k, v in files.items()))

    def test_the_package_imports_nothing_that_can_reach_the_outside(self):
        allowed_roots = {"__future__", "collections", "copy", "dataclasses", "html", "json", "pathlib", "re", "typing", "urllib"}
        local = {"labels", "note_tags", "places", "policy", "search_index", "site", "store", "text_scan", "transform"}
        seen = set()
        for path in sorted(PACKAGE.glob("*.py")):
            tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
            for node in ast.walk(tree):
                if isinstance(node, ast.Import):
                    names = [a.name for a in node.names]
                elif isinstance(node, ast.ImportFrom):
                    if node.level:  # a relative import inside the package (or ``from .. import scanner``)
                        continue
                    names = [node.module]
                else:
                    if isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
                        self.assertNotIn(node.func.id, {"open", "eval", "exec", "compile", "__import__", "input", "print"}, path.name)
                    continue
                for name in names:
                    seen.add(name)
                    root = name.split(".")[0]
                    self.assertIn(root, allowed_roots, "%s imports %s" % (path.name, name))
                    if root == "urllib":
                        self.assertEqual(name, "urllib.parse", path.name)  # parsing only, never urllib.request
                    if root == "pathlib":
                        for alias in getattr(node, "names", []):
                            self.assertEqual(alias.name, "PurePosixPath", path.name)
        self.assertTrue({"json", "re", "html"} <= seen)
        self.assertEqual({p.stem for p in PACKAGE.glob("*.py")} - {"__init__"}, local)

    def test_it_is_the_function_the_task_names(self):
        files = render_site({o["handle"]: o for o in OBJECTS}, media_files=MEDIA_FILES)
        self.assertIn("person/index.json", files)
        self.assertEqual(list(files), sorted(files))
        self.assertTrue(all(isinstance(v, bytes) for v in files.values()))


class Deterministic(unittest.TestCase):
    def test_same_input_same_bytes_and_the_input_is_untouched(self):
        before = copy.deepcopy(OBJECTS)
        first = render_site(OBJECTS, media_files=MEDIA_FILES)
        second = render_site(list(reversed(OBJECTS)), media_files=MEDIA_FILES)
        self.assertEqual(first, second)
        self.assertEqual(OBJECTS, before)

    def test_a_mapping_and_a_list_are_the_same_input(self):
        self.assertEqual(render_site(OBJECTS, media_files=MEDIA_FILES),
                         render_site({o["handle"]: o for o in OBJECTS}, media_files=MEDIA_FILES))

    def test_generated_at_reaches_only_the_two_index_files(self):
        a = render_site(OBJECTS, media_files=MEDIA_FILES, generated_at="2026-01-02T03:04:05.000Z")
        b = render_site(OBJECTS, media_files=MEDIA_FILES, generated_at="2027-01-02T03:04:05.000Z")
        self.assertEqual({k for k in a if a[k] != b[k]}, {"person/index.json", "person/search-index.json"})
        self.assertEqual(json.loads(a["person/index.json"])["generatedAt"], "2026-01-02T03:04:05.000Z")
        self.assertEqual(json.loads(a["person/search-index.json"])["generatedAt"], "2026-01-02T03:04:05.000Z")

    def test_independent_of_the_hash_seed_and_the_python_version(self):
        script = (
            "import hashlib, sys\n"
            "sys.path[:0] = [%r, %r]\n"
            "import render_support as rs\n"
            "files = rs.rendered()\n"
            "h = hashlib.sha256()\n"
            "for k in sorted(files):\n"
            "    h.update(k.encode()); h.update(b'\\0'); h.update(files[k]); h.update(b'\\0')\n"
            "print(h.hexdigest())\n"
        ) % (rs.HERE, rs.GRAMPS)
        digests = {}
        for label, exe, seed in (("self-0", sys.executable, "0"), ("self-1", sys.executable, "1"), ("self-777", sys.executable, "777")):
            digests[label] = self._run(exe, script, seed)
        for version in ("3.12", "3.13"):
            exe = shutil.which("python" + version)
            if exe:
                digests["py" + version] = self._run(exe, script, "5")
        self.assertEqual(len(set(digests.values())), 1, digests)
        h = hashlib.sha256()
        for k, v in rs.rendered().items():
            h.update(k.encode()); h.update(b"\0"); h.update(v); h.update(b"\0")
        self.assertEqual(set(digests.values()), {h.hexdigest()})

    @staticmethod
    def _run(exe, script, seed):
        env = dict(os.environ, PYTHONHASHSEED=seed, PYTHONDONTWRITEBYTECODE="1")
        done = subprocess.run([exe, "-c", script], env=env, check=True, capture_output=True, text=True)
        return done.stdout.strip()


if __name__ == "__main__":
    unittest.main()
