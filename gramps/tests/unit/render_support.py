"""Shared setup for the renderer tests (HFY-TSK-229): paths, P(fixture), and the render of it. Standard library only."""

import functools
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
GRAMPS = os.path.dirname(os.path.dirname(HERE))
RENDER_FIX = os.path.join(GRAMPS, "tests", "fixtures", "render")
for path in (GRAMPS, RENDER_FIX):
    if path not in sys.path:
        sys.path.insert(0, path)

import deltas  # noqa: E402
import parity  # noqa: E402
from hfygramps.render import render_site  # noqa: E402

FIXED_AT = "2000-01-01T00:00:00.000Z"  # the value the legacy golden was generated with
GOLDEN = os.path.join(RENDER_FIX, "golden", "legacy")
DELTAS = os.path.join(RENDER_FIX, "expected-deltas.json")


@functools.lru_cache(maxsize=None)
def raw_tree():
    return parity.load_jsonl() + parity.supplement()


@functools.lru_cache(maxsize=None)
def p_fixture():
    return parity.project(list(raw_tree()))


@functools.lru_cache(maxsize=None)
def rendered():
    objects = p_fixture()
    return render_site(objects, media_files=parity.media_files(objects), generated_at=FIXED_AT)


@functools.lru_cache(maxsize=None)
def legacy_golden():
    out = {}
    for base, _dirs, names in os.walk(GOLDEN):
        for name in names:
            path = os.path.join(base, name)
            with open(path, "rb") as fh:
                out[os.path.relpath(path, GOLDEN).replace(os.sep, "/")] = fh.read()
    return {key: out[key] for key in sorted(out)}


def committed_deltas():
    with open(DELTAS, encoding="utf-8") as fh:
        return json.load(fh)


def by_gramps_id(cls):
    return {o["gramps_id"]: o for o in p_fixture() if o["_class"] == cls and "gramps_id" in o}


def render_json(key):
    return json.loads(rendered()[key])


def person(gramps_id):
    return render_json("person/%s.json" % gramps_id)
