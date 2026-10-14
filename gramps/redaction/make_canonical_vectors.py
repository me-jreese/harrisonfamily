#!/usr/bin/env python3
"""Generator of the canonical JSON vectors shared by Python and JavaScript (task projection-py). Standard library only.

    python3 gramps/redaction/make_canonical_vectors.py           # rewrite shared/canonical.vectors.json
    python3 gramps/redaction/make_canonical_vectors.py --check   # byte comparison, writes nothing

Each vector is ``{id, title, value, canonical, sha256, stored}``. ``canonical`` is written by hand below, never produced by the
code under test; ``sha256`` is the hash of its UTF-8 bytes, computed here with hashlib. ``stored`` is true when the vector is a
whole Gramps object: its canonical text is ``obj_json`` (the top-level ``change`` key is not part of it) and the hash is ``hash``.

gramps/tests/unit/test_canonical.py (Python) and shared/canonical.test.mjs (JavaScript) both check every vector. Values are plain
JSON, so both languages read them identically; what must be refused (floats, lone surrogates) cannot be written in JSON and is
tested in each language on its own. Every value is fictional.
"""
import hashlib
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "..", "shared", "canonical.vectors.json")

V = []


def vec(vid, title, value, canonical, stored=False):
    assert all(v["id"] != vid for v in V), vid
    V.append({"id": vid, "title": title, "value": value, "canonical": canonical, "stored": stored,
              "sha256": hashlib.sha256(canonical.encode("utf-8")).hexdigest()})


vec("scalar.null", "null", None, "null")
vec("scalar.true", "true", True, "true")
vec("scalar.false", "false", False, "false")
vec("scalar.zero", "zero", 0, "0")
vec("scalar.negative", "a negative integer", -17, "-17")
vec("scalar.max_safe", "the largest safe integer", 9007199254740991, "9007199254740991")
vec("scalar.min_safe", "the smallest safe integer", -9007199254740991, "-9007199254740991")
vec("scalar.empty_string", "the empty string", "", '""')
vec("empty.object", "an empty object", {}, "{}")
vec("empty.array", "an empty array", [], "[]")
vec("empty.nested", "empty containers inside one another", {"b": [], "a": {}, "c": [[], {}]}, '{"a":{},"b":[],"c":[[],{}]}')
vec("order.keys", "keys are sorted, at every depth", {"b": 1, "a": {"z": 1, "y": 2}, "B": 3}, '{"B":3,"a":{"y":2,"z":1},"b":1}')
vec("order.array", "arrays keep their order", [3, 1, 2, {"b": 1, "a": 2}], '[3,1,2,{"a":2,"b":1}]')
vec("order.digits_before_letters", "code point order puts digits before upper case before lower case", {"a": 1, "A": 2, "1": 3, "_": 4},
    '{"1":3,"A":2,"_":4,"a":1}')
vec("order.prefix", "a key sorts before a longer key it prefixes", {"ab": 1, "a": 2, "": 3}, '{"":3,"a":2,"ab":1}')
vec("order.astral_after_bmp", "an astral key sorts after U+FFFF (code points, not UTF-16 units)",
    {"\U0001f600": 1, "￿": 2, "": 3, "z": 4}, '{"z":4,"":3,"￿":2,"\U0001f600":1}')
vec("order.astral_pair", "two astral keys sort by code point", {"\U00010400": 1, "\U0001f600": 2, "\U00010000": 3},
    '{"\U00010000":3,"\U00010400":1,"\U0001f600":2}')
vec("escape.basic", "quote, backslash and the short control escapes", 'a"b\\c\nd\re\tf\bg\fh', '"a\\"b\\\\c\\nd\\re\\tf\\bg\\fh"')
vec("escape.control", "other control characters are lower-case \\u00xx", "\x00\x01\x1f\x0b", '"\\u0000\\u0001\\u001f\\u000b"')
vec("escape.del_and_slash", "DEL and slash are written as they are", "\x7f/", '"\x7f/"')
vec("escape.line_separators", "U+2028 and U+2029 are written as they are", "a b c", '"a b c"')
vec("escape.key", "keys are escaped like values", {'k"\n': 1}, '{"k\\"\\n":1}')
vec("unicode.latin", "non-ASCII letters stay as they are", "Zoe café über", '"Zoe café über"')
vec("unicode.cjk", "CJK text stays as it is", {"名": "山田"}, '{"名":"山田"}')
vec("unicode.emoji", "an astral character stays one character", "x\U0001f600y", '"x\U0001f600y"')
vec("unicode.combining", "a combining sequence is not normalised", "é", '"é"')
vec("gramps.coordinates", "latitude and longitude are strings", {"lat": "40.12", "long": "-111.99"}, '{"lat":"40.12","long":"-111.99"}')
vec("gramps.date", "a projected Date", {"_class": "Date", "calendar": 0, "dateval": [0, 0, 1900, False], "format": None, "modifier": 0,
                                         "newyear": 0, "quality": 0, "sortval": 2415021, "text": ""},
    '{"_class":"Date","calendar":0,"dateval":[0,0,1900,false],"format":null,"modifier":0,"newyear":0,"quality":0,'
    '"sortval":2415021,"text":""}')
vec("gramps.rect", "a media rectangle and a null one", {"a": [10, 10, 50, 60], "b": None}, '{"a":[10,10,50,60],"b":null}')
vec("object.drops_change", "a stored object has no change key", {"_class": "Tag", "change": 1700000000, "color": "#3465a4",
                                                                   "handle": "tag01", "name": "Fixture Review", "priority": 1},
    '{"_class":"Tag","color":"#3465a4","handle":"tag01","name":"Fixture Review","priority":1}', stored=True)
vec("object.no_change_key", "an object that has no change key is stored as it is", {"_class": "Tag", "handle": "tag02", "name": "Fixture ToDo"},
    '{"_class":"Tag","handle":"tag02","name":"Fixture ToDo"}', stored=True)
vec("object.nested_change_kept", "only the top-level change key is derived", {"_class": "Note", "change": 5, "handle": "n01",
                                                                              "text": {"_class": "StyledText", "change": 7, "string": "Hello", "tags": []}},
    '{"_class":"Note","handle":"n01","text":{"_class":"StyledText","change":7,"string":"Hello","tags":[]}}', stored=True)


def render():
    lines = [json.dumps(v, sort_keys=True, ensure_ascii=True, separators=(",", ":")) for v in V]
    return '{"format":"canonical-json-v1","vectors":[\n%s\n]}\n' % ",\n".join(lines)


def main(argv):
    text = render()
    if "--check" in argv:
        have = open(OUT, encoding="utf-8").read() if os.path.exists(OUT) else None
        if have != text:
            sys.stderr.write("%s is out of date: run make_canonical_vectors.py\n" % os.path.normpath(OUT))
            return 1
        return 0
    with open(OUT, "w", encoding="utf-8") as fh:
        fh.write(text)
    print("wrote %d vectors" % len(V))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
