"""The one R-18 detector, Python port (HFY-PLN-002 D2-09, BRD2 section 5.2; task privacy-guard-core).

shared/privacy-guard.mjs is the JavaScript original; both pass the same cases in shared/privacy-guard.vectors.json
(gramps/tests/unit/test_scanner.py). Standard library only (``re``), so it runs in Gramps' bundled Python and in CI's
stock python3 (3.12 and later).

A finding is ``{"kind", "start", "end", "rule"}``: code-point offsets into the caller's string, never the matched text.
Nothing here logs or prints.

Parity rules with the JS module: ASCII-only regex semantics (re.ASCII; JS without the u flag), no \\s, no lookbehind,
``\\Z`` where JS uses ``$``, the same normalization tables, and every window counted in code points: the detectors scan a
normalized text (``_normalize``) and findings are mapped back to the caller's offsets.
"""

import re

KINDS = ("phone", "email", "street_address", "po_box", "contact_url", "dob_heuristic")
DOB_KINDS = ("dob_heuristic",)

#: Characters between a birth keyword and a date (BRD2 5.2).
DOB_WINDOW = 60

#: Birth keywords, lower case (the JS module's BIRTHDAY_KEYWORDS). Multi-word entries match any run of spaces or tabs.
BIRTHDAY_KEYWORDS = frozenset([
    "birthday", "birthdays", "bday", "bdays", "b-day", "b-days", "b'day", "b'days", "hbd",
    "birthdate", "birthdates", "birth date", "date of birth", "dob", "d.o.b",
    "born", "birth", "births", "baptized", "baptised", "baptism", "christened", "christening",
])

# Other event words: a date nearer to one of these than to a birth keyword belongs to that event.
_EVENT_WORDS = [
    "died", "dies", "death", "deaths", "deceased", "passed away", "buried", "burial", "interred",
    "married", "marriage", "marries", "marry", "wedding", "divorced", "divorce", "anniversary",
    "graduated", "graduation", "emigrated", "immigrated", "naturalized", "naturalised", "enlisted", "discharged", "retired",
    "census", "enumerated", "enumeration",
]
# Genealogy abbreviations, lower case only and case-sensitive.
_BIRTH_ABBREVIATIONS = ["b.", "bap.", "bapt.", "chr."]
_EVENT_ABBREVIATIONS = ["d.", "m.", "bur.", "div."]

#: Contact-channel hosts, matched by registrable-domain suffix, never by substring.
CONTACT_HOSTS = (
    "m.me", "ig.me", "wa.me", "wa.link", "t.me", "telegram.me", "telegram.dog", "messenger.com",
    "api.whatsapp.com", "chat.whatsapp.com", "signal.me", "signal.group",
)
#: (domain, first path segment): message paths on profile hosts.
CONTACT_PATHS = (("instagram.com", "m"), ("instagram.com", "direct"), ("facebook.com", "messages"))
CONTACT_SCHEMES = (
    "mailto", "tel", "sms", "smsto", "mms", "callto", "facetime", "facetime-audio", "skype", "whatsapp", "viber", "sgnl", "tg",
    "fb-messenger", "imessage",
)

#: (lo, hi, out, step): code points lo..hi fold to out (+ (cp - lo) when step is 1). Unicode spaces, dashes, curly
#: apostrophes, the small and fullwidth at signs and fullwidth ASCII fold to ASCII, one character to one character.
FOLD = (
    (0x00A0, 0x00A0, 0x20, 0), (0x00B7, 0x00B7, 0x2E, 0), (0x02BC, 0x02BC, 0x27, 0), (0x1680, 0x1680, 0x20, 0),
    (0x2000, 0x200A, 0x20, 0), (0x2010, 0x2015, 0x2D, 0), (0x2018, 0x2019, 0x27, 0), (0x2024, 0x2024, 0x2E, 0),
    (0x2028, 0x2029, 0x20, 0), (0x202F, 0x202F, 0x20, 0), (0x205F, 0x205F, 0x20, 0), (0x2212, 0x2212, 0x2D, 0),
    (0x3000, 0x3000, 0x20, 0), (0xFE58, 0xFE58, 0x2D, 0), (0xFE63, 0xFE63, 0x2D, 0), (0xFE6B, 0xFE6B, 0x40, 0),
    (0xFF01, 0xFF5E, 0x21, 1),
)
#: (lo, hi, value): code point cp in lo..hi becomes the ASCII digits of value + (cp - lo). Every Unicode decimal digit (Nd)
#: and every character whose NFKC form is ASCII digits (superscripts, subscripts, circled numbers). A fixed table, not the
#: runtime's Unicode data, so both ports agree.
DIGITS = (
    (0x00B2, 0x00B3, 2), (0x00B9, 0x00B9, 1), (0x0660, 0x0669, 0), (0x06F0, 0x06F9, 0), (0x07C0, 0x07C9, 0),
    (0x0966, 0x096F, 0), (0x09E6, 0x09EF, 0), (0x0A66, 0x0A6F, 0), (0x0AE6, 0x0AEF, 0), (0x0B66, 0x0B6F, 0),
    (0x0BE6, 0x0BEF, 0), (0x0C66, 0x0C6F, 0), (0x0CE6, 0x0CEF, 0), (0x0D66, 0x0D6F, 0), (0x0DE6, 0x0DEF, 0),
    (0x0E50, 0x0E59, 0), (0x0ED0, 0x0ED9, 0), (0x0F20, 0x0F29, 0), (0x1040, 0x1049, 0), (0x1090, 0x1099, 0),
    (0x17E0, 0x17E9, 0), (0x1810, 0x1819, 0), (0x1946, 0x194F, 0), (0x19D0, 0x19D9, 0), (0x1A80, 0x1A89, 0),
    (0x1A90, 0x1A99, 0), (0x1B50, 0x1B59, 0), (0x1BB0, 0x1BB9, 0), (0x1C40, 0x1C49, 0), (0x1C50, 0x1C59, 0),
    (0x2070, 0x2070, 0), (0x2074, 0x2079, 4), (0x2080, 0x2089, 0), (0x2460, 0x2473, 1), (0x24EA, 0x24EA, 0),
    (0x3251, 0x325F, 21), (0x32B1, 0x32BF, 36), (0xA620, 0xA629, 0), (0xA8D0, 0xA8D9, 0), (0xA900, 0xA909, 0),
    (0xA9D0, 0xA9D9, 0), (0xA9F0, 0xA9F9, 0), (0xAA50, 0xAA59, 0), (0xABF0, 0xABF9, 0), (0x104A0, 0x104A9, 0),
    (0x10D30, 0x10D39, 0), (0x11066, 0x1106F, 0), (0x110F0, 0x110F9, 0), (0x11136, 0x1113F, 0), (0x111D0, 0x111D9, 0),
    (0x112F0, 0x112F9, 0), (0x11450, 0x11459, 0), (0x114D0, 0x114D9, 0), (0x11650, 0x11659, 0), (0x116C0, 0x116C9, 0),
    (0x11730, 0x11739, 0), (0x118E0, 0x118E9, 0), (0x11950, 0x11959, 0), (0x11C50, 0x11C59, 0), (0x11D50, 0x11D59, 0),
    (0x11DA0, 0x11DA9, 0), (0x11F50, 0x11F59, 0), (0x16A60, 0x16A69, 0), (0x16AC0, 0x16AC9, 0), (0x16B50, 0x16B59, 0),
    (0x1D7CE, 0x1D7D7, 0), (0x1D7D8, 0x1D7E1, 0), (0x1D7E2, 0x1D7EB, 0), (0x1D7EC, 0x1D7F5, 0), (0x1D7F6, 0x1D7FF, 0),
    (0x1E140, 0x1E149, 0), (0x1E2F0, 0x1E2F9, 0), (0x1E4F0, 0x1E4F9, 0), (0x1E950, 0x1E959, 0), (0x1FBF0, 0x1FBF9, 0),
)
#: (lo, hi): removed before scanning. The Unicode default-ignorable characters (soft hyphen, zero-width space and joiners,
#: word joiner, byte-order mark, bidi and other format controls, fillers, variation selectors, tags).
DROP = (
    (0x00AD, 0x00AD), (0x034F, 0x034F), (0x061C, 0x061C), (0x115F, 0x1160), (0x17B4, 0x17B5), (0x180B, 0x180F),
    (0x200B, 0x200F), (0x202A, 0x202E), (0x2060, 0x206F), (0x3164, 0x3164), (0xFE00, 0xFE0F), (0xFEFF, 0xFEFF),
    (0xFFA0, 0xFFA0), (0xFFF0, 0xFFF8), (0x1BCA0, 0x1BCA3), (0x1D173, 0x1D17A), (0xE0000, 0xE0FFF),
)
# code point -> its replacement ("" removes it)
_NORM = {cp: chr(out + (cp - lo) * step) for lo, hi, out, step in FOLD for cp in range(lo, hi + 1)}
_NORM.update({cp: str(value + cp - lo) for lo, hi, value in DIGITS for cp in range(lo, hi + 1)})
_NORM.update({cp: "" for lo, hi in DROP for cp in range(lo, hi + 1)})
_NEEDS_NORM = re.compile("[" + "".join(
    "\\U%08x" % r[0] if r[0] == r[1] else "\\U%08x-\\U%08x" % (r[0], r[1]) for r in FOLD + DIGITS + DROP) + "]")

_A = re.ASCII
_AI = re.ASCII | re.IGNORECASE

_WORD_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_"
_SPACE_CHARS = " \t\r\n\f\v"


def _is_word_char(ch):
    return ch != "" and ch in _WORD_CHARS


def _is_digit(ch):
    return ch != "" and ch in "0123456789"


def _at(t, i):
    """t[i], or "" outside the string (JS t[i] is undefined there)."""
    return t[i] if 0 <= i < len(t) else ""


def _normalize(text):
    """(t, frm, to): the text the detectors scan and, for each character of t, the caller offsets of the character it came
    from (frm[i] up to to[i]); frm is None when t is the caller's text unchanged."""
    if _NEEDS_NORM.search(text) is None:
        return text, None, None
    out, frm, to = [], [], []
    for i, ch in enumerate(text):
        for c in _NORM.get(ord(ch), ch):
            out.append(c)
            frm.append(i)
            to.append(i + 1)
    return "".join(out), frm, to


def _escape(s):
    return re.sub(r"[.*+?^${}()|\[\]\\\-']", lambda m: "\\" + m.group(0), s)


def _alternation(words):
    ordered = sorted(words, key=lambda w: (-len(w), w))
    return "|".join(_escape(w).replace(" ", "[ \\t]+") for w in ordered)


# ---------------------------------------------------------------- phone

_PHONE_RUN = re.compile(
    r"(?:\+[ \t]?)?(?:\([ \t]?)?[0-9]+(?:[ \t]?\))?(?:(?:[ \t]{0,2}[\-/][ \t]{0,2}|\.|[ \t]{1,2})?(?:\([ \t]?)?[0-9]+(?:[ \t]?\))?)*",
    _A)
_DIGIT_GROUP = re.compile(r"[0-9]+", _A)
_AREA_CODE = re.compile(r"\([ \t]?[0-9]{1,5}[ \t]?\)", _A)
_YEAR_LIKE = re.compile(r"(?:1[0-9]{3}|20[0-9]{2})", _A)
_HOST_PATH = re.compile(r"[A-Za-z0-9\-]\.[A-Za-z]{2,24}(?::[0-9]{1,5})?[/?#]", _A)
_PHONE_WORD = re.compile(r"\b(?:tel|tele|telephone|phone|ph|cell|cellphone|mobile|mob|call|text|txt|fax|whatsapp)\b", _AI)
# A reference label directly before the number: an unseparated run is a reference, a separated one too unless phone-shaped.
_REFERENCE = re.compile(
    r"\b(?:" + _alternation([
        "p", "pp", "pg", "pgs", "page", "pages", "vol", "vols", "volume", "no", "nos", "nr", "film", "roll", "fiche", "folio", "fol",
        "item", "image", "img", "dgs", "cert", "certificate", "record", "rec", "ref", "reference", "id", "isbn", "issn", "case", "file",
        "lot", "plot", "grave", "row", "sec", "section", "entry", "frame", "register", "reg", "batch", "serial", "census",
        "book", "bk", "chapter", "ch", "memorial", "find a grave", "serial number", "service number", "database", "accession",
    ]) + r")\.?[ \t]*(?:[:#][ \t]*)?\Z", _AI)


def _year_like(d):
    return _YEAR_LIKE.fullmatch(d) is not None


def _sep_core(sep):
    return re.sub(r"[ \t()]", "", sep)


def _day_month(a, b):
    return a >= 1 and b >= 1 and ((a <= 12 and b <= 31) or (a <= 31 and b <= 12))


def _phone_shaped(lens):
    """Group lengths laid out like a phone number: 555-010-0123, 1-800-555-0199, 0207 946 0123, 01 23 45 67 89."""
    return len(lens) <= 5 and lens[0] <= 4 and all(2 <= x <= 4 for x in lens[1:])


def _five_twos(groups, seps, frm):
    """groups[frm:] are five two-digit groups with one separator throughout, the French layout: 01 23 45 67 89."""
    return (len(groups) - frm == 5 and all(len(g[1]) == 2 for g in groups[frm:])
            and all(s == seps[frm] for s in seps[frm:]))


def _is_date_triple(groups, seps):
    ca, cb = (_sep_core(s) for s in seps)
    if ca != cb:
        return False
    a, b, c = (g[1] for g in groups)
    if len(a) == 4 and len(b) <= 2 and len(c) <= 2:
        return 1 <= int(b) <= 12 and 1 <= int(c) <= 31
    if len(a) <= 2 and len(b) <= 2 and len(c) in (2, 4):
        return _day_month(int(a), int(b))
    return False


def _url_prefixes(t):
    """url[p] is 1 when the space-delimited token of t up to offset p already reads as a URL ("://" or host.tld/ before p).
    One pass, so linear in the text."""
    url = bytearray(len(t) + 1)
    k = t.find("://")
    while k != -1:
        url[k + 3] = 1
        k = t.find("://", k + 1)
    for m in _HOST_PATH.finditer(t):  # the token's first match ends first
        url[m.end()] = 1
    on = 0
    for p in range(1, len(t) + 1):
        if t[p - 1] in _SPACE_CHARS:
            on = 0
        elif url[p]:
            on = 1
        url[p] = on
    return url


def _phone_excluded(groups, seps, before):
    lens = [len(g[1]) for g in groups]
    n = sum(lens)
    core = [_sep_core(s) for s in seps]
    if all(_year_like(g[1]) for g in groups):
        return True
    if len(groups) == 3 and _is_date_triple(groups, seps):
        return True
    if all(x <= 2 for x in lens) and n < 10:
        return True
    if (len(groups) >= 3 and all(s == seps[0] for s in seps) and seps[0] in (".", " ")
            and lens[0] <= 3 and all(x == 3 for x in lens[1:])):
        return True
    if len(groups) == 2:
        a, b = int(groups[0][1]), int(groups[1][1])
        if core[0] == "-" and lens[0] == lens[1] and b > a and b - a < 10 ** (lens[0] - 1):
            return True
        if core[0] == "" and min(lens) <= 4 and any(_year_like(g[1]) for g in groups):
            return True
    return _REFERENCE.search(before) is not None and not _phone_shaped(lens)


def _phone_verdict(t, s, run, groups, in_url):
    # seps[i] is the text between groups[i] and groups[i + 1]
    seps = [run[groups[i][0] + len(groups[i][1]):g[0]] for i, g in enumerate(groups[1:])]
    n = sum(len(g[1]) for g in groups)
    frm = 0
    while True:
        if frm > 0:
            n -= len(groups[frm - 3][1]) + len(groups[frm - 2][1]) + len(groups[frm - 1][1])
        if n < 7:
            return None
        off = groups[frm][0]
        if frm == 0 and run[0] == "+":
            return 0, "plus"
        before = t[max(0, s + off - 24):s + off]
        if len(groups) - frm == 1:
            if n > 15 or in_url(s + off) or _REFERENCE.search(before):
                return None
            return off, "run"
        if not _AREA_CODE.match(run[(0 if frm == 0 else off):off + 9]) and not _PHONE_WORD.search(before):
            # a date followed by more digits (5/12/2020 10:30): judge what follows the date on its own, unless the groups
            # are five two-digit groups (01 23 45 67 89 is a phone number)
            if (len(groups) - frm > 3 and _is_date_triple(groups[frm:frm + 3], seps[frm:frm + 2])
                    and not _five_twos(groups, seps, frm)):
                frm += 3
                continue
            if _phone_excluded(groups[frm:], seps[frm:], before):
                return None
        return (0 if frm == 0 else off), "grouped"


def _unwrap(run):
    """(a, b): the run without wrapping parentheses, keeping an area code's."""
    a, b = 0, len(run)
    if run[0] == "(" and not _AREA_CODE.match(run):
        a = 1
        while a < b and run[a] in " \t":
            a += 1
    inner = run[a:b]
    if run[b - 1] == ")" and inner.count(")") > inner.count("("):
        b -= 1
        while b > a and run[b - 1] in " \t":
            b -= 1
    return a, b


def _scan_phones(t, add):
    url = []  # [_url_prefixes(t)], built on first use

    def in_url(pos):
        if pos == 0 or t[pos - 1] not in "/=?&#":
            return False
        if not url:
            url.append(_url_prefixes(t))
        return url[0][pos] == 1

    for m in _PHONE_RUN.finditer(t):
        if m.start() > 0 and _is_word_char(t[m.start() - 1]):
            continue
        a, b = _unwrap(m.group(0))
        s = m.start() + a
        run = m.group(0)[a:b]
        if not run:
            continue
        groups = [(g.start(), g.group(0)) for g in _DIGIT_GROUP.finditer(run)]
        v = _phone_verdict(t, s, run, groups, in_url)
        if v:
            add("phone", s + v[0], s + len(run), v[1])


# ---------------------------------------------------------------- email

_LOCAL_CHARS = _WORD_CHARS + ".%+-"
_DOMAIN = re.compile(r"(?:[A-Za-z0-9](?:[A-Za-z0-9\-]{0,61}[A-Za-z0-9])?\.){1,8}[A-Za-z]{2,24}\b", _A)
_DOMAIN_SPELLED = re.compile(
    r"(?:[A-Za-z0-9\-]{1,63}(?:[ \t]*(?:\[dot\]|\(dot\)|\{dot\}|<dot>)[ \t]*|[ \t]+dot[ \t]+|\.)){1,8}[A-Za-z]{2,24}\b", _AI)
_AT_SPELLED = re.compile(r"(?:\[at\]|\(at\)|\{at\}|<at>)[ \t]*", _AI)


def _local_start(t, at, spaced=False):
    if spaced:
        while at > 0 and t[at - 1] in " \t":
            at -= 1
    i = at
    while i > 0 and at - i < 64 and t[i - 1] in _LOCAL_CHARS:
        i -= 1
    while i < at and t[i] in ".-":
        i += 1
    for j in range(i, at):
        if t[j] in _WORD_CHARS and t[j] != "_":
            return i
    return -1


def _domain_end(t, pos, plain_ok):
    if plain_ok:
        m = _DOMAIN.match(t, pos)
        if m:
            return m.end(), False
    m = _DOMAIN_SPELLED.match(t, pos)
    return (m.end(), True) if m else None


def _scan_emails(t, add):
    at = t.find("@")
    while at != -1:
        s = _local_start(t, at)
        d = None if s == -1 else _domain_end(t, at + 1, True)
        if d:
            add("email", s, d[0], "spelled" if d[1] else "address")
        at = t.find("@", at + 1)
    for m in _AT_SPELLED.finditer(t):
        s = _local_start(t, m.start(), True)
        d = None if s == -1 else _domain_end(t, m.end(), True)
        if d:
            add("email", s, d[0], "spelled")


# ---------------------------------------------------------------- street address and PO box

_STREET_STOP = [
    "to", "the", "a", "an", "in", "on", "at", "of", "and", "or", "from", "by", "for", "with", "near", "he", "she", "they", "we",
    "it", "was", "were", "is", "are", "his", "her", "their", "our", "my", "moved", "lived", "went", "times", "years", "months",
    "weeks", "days", "hours", "minutes", "kids", "children", "sons", "daughters", "people", "miles", "acres", "feet",
    "generations", "grandchildren", "cousins", "siblings", "brothers", "sisters", "year", "month", "week", "day", "hour",
    "minute", "foot", "percent", "degree", "degrees",
]
_STRONG_SUFFIXES = [
    "street", "st", "avenue", "ave", "av", "road", "rd", "lane", "ln", "drive", "dr", "boulevard", "blvd", "highway", "hwy",
    "parkway", "pkwy", "turnpike", "tpke", "expressway", "expy", "freeway", "fwy", "pike", "alley", "aly", "crescent", "cres",
]
_WEAK_SUFFIXES = [
    "court", "ct", "place", "pl", "terrace", "ter", "way", "circle", "cir", "square", "sq", "trail", "trl", "close", "row",
    "loop", "path", "walk", "plaza", "plz", "grove", "grv", "glen", "gardens", "gdns", "heights", "hts", "hill", "park",
    "point", "ridge", "rdg", "cove", "manor", "mews", "vale", "wynd", "quay", "crossing", "xing", "bend", "trace", "esplanade",
    "promenade",
]
_STRONG = frozenset(_STRONG_SUFFIXES)
_STREET = re.compile(
    r"\b([0-9]{1,6})([A-Za-z]?)(?:-[0-9]{1,5}[A-Za-z]?)?[ \t]+"
    r"(?:(?!(?:" + _alternation(_STREET_STOP) + r")\b)(?:[A-Za-z][A-Za-z'.\-]*|[0-9]{1,3}(?:st|nd|rd|th))[ \t]+){1,4}?"
    r"(" + _alternation(_STRONG_SUFFIXES + _WEAK_SUFFIXES) + r")\b\.?", _AI)
# (no two adjacent [ \t]* around an optional token, so "p" or "pmb" before a long run of spaces stays linear)
_PO_BOX = re.compile(
    r"\b(?:g?p[ \t]*(?:\.[ \t]*)?o\.?[ \t]*|post[ \t]+office[ \t]+)box[ \t]*(?:no\.?[ \t]*|#[ \t]*)?[0-9]{1,8}\b"
    r"|\bpmb[ \t]*(?:#[ \t]*)?[0-9]{1,8}\b", _AI)
# Rural-route and highway-contract boxes, either order: RR 2 Box 15, HC 65 Box 10, Box 42, R.R. 1.
_ROUTE = (r"(?:r\.?[ \t]*r\.?|r\.?[ \t]*f\.?[ \t]*d\.?|h\.?[ \t]*c\.?|rural[ \t]+route|highway[ \t]+contract|star[ \t]+route"
          r"|route|rte\.?|rt\.?)[ \t]*(?:#[ \t]*)?[0-9]{1,4}")
_RURAL_BOX = re.compile(
    r"\b" + _ROUTE + r"[ \t]*(?:,[ \t]*)?box[ \t]*(?:#[ \t]*)?[0-9]{1,6}\b"
    r"|\bbox[ \t]*(?:#[ \t]*)?[0-9]{1,6}[ \t]*(?:,[ \t]*)?" + _ROUTE + r"\b", _AI)
# A year directly after one of these is a date, not a house number: In 1850 Main Street was paved.
_YEAR_WORDS = frozenset(["in", "by", "since", "until", "circa", "ca.", "c."])


def _word_before(t, i):
    """The word (with a trailing period) that ends just before the spaces at offset i, lower case; "" when there is none."""
    e = i
    while e > 0 and t[e - 1] in " \t":
        e -= 1
    if e == i:
        return ""
    s = e - 1 if e > 0 and t[e - 1] == "." else e
    while s > 0 and e - s < 8 and _is_word_char(t[s - 1]):
        s -= 1
    return "" if s > 0 and _is_word_char(t[s - 1]) else t[s:e].lower()


def _scan_addresses(t, add):
    for m in _STREET.finditer(t):
        if not m.group(2) and _year_like(m.group(1)):
            # a year-like number is prose, not a house number, with a weak suffix (the 1920 Census Place) or after in, by,
            # since, until or circa (In 1850 Main Street was paved)
            if m.group(3).lower() not in _STRONG or _word_before(t, m.start()) in _YEAR_WORDS:
                continue
        add("street_address", m.start(), m.end(), "number-street")
    for m in _RURAL_BOX.finditer(t):
        add("street_address", m.start(), m.end(), "rural-route")
    for m in _PO_BOX.finditer(t):
        add("po_box", m.start(), m.end(), "box")


# ---------------------------------------------------------------- contact channels

_SCHEME = re.compile(r"\b(?:" + _alternation(CONTACT_SCHEMES) + r"):[^ \t\r\n\f\v<>\"']+", _AI)
_URLISH = re.compile(
    r"(?:[A-Za-z][A-Za-z0-9+.\-]{0,20}://)?((?:[A-Za-z0-9](?:[A-Za-z0-9\-]{0,61}[A-Za-z0-9])?\.){1,8}[A-Za-z]{2,24})"
    r"(?![A-Za-z0-9\-])(?::[0-9]{1,5})?([/?#][^ \t\r\n\f\v<>\"']*)?", _A)
_TRAILING = ".,;:!?)]}'\""


def _norm_host(host):
    return str(host).lower().rstrip(".")


def matches_domain(host, domain):
    """True when host is domain or a subdomain of it (registrable-domain suffix match, never a substring match)."""
    h = _norm_host(host)
    return h == domain or h.endswith("." + domain)


def _first_segment(path):
    p = str(path or "")
    if p.startswith("/"):
        p = p[1:]
    return re.split(r"[/?#]", p)[0].lower()


def is_contact_channel(host, path=""):
    """True for a messaging link: a contact host or a message path on a profile host."""
    if any(matches_domain(host, d) for d in CONTACT_HOSTS):
        return True
    seg = _first_segment(path)
    return any(seg == s and matches_domain(host, d) for d, s in CONTACT_PATHS)


def _trim_end(t, start, end):
    while end > start and t[end - 1] in _TRAILING:
        end -= 1
    return end


def _scan_contact_urls(t, add):
    for m in _SCHEME.finditer(t):
        add("contact_url", m.start(), _trim_end(t, m.start(), m.end()), "scheme")
    for m in _URLISH.finditer(t):
        s = m.start()
        if s > 0 and (_is_word_char(t[s - 1]) or t[s - 1] in "@.-"):
            continue
        host = m.group(1).lower()
        via_host = any(matches_domain(host, d) for d in CONTACT_HOSTS)
        if not via_host and not is_contact_channel(host, m.group(2) or ""):
            continue
        host_end = m.group(0).index(m.group(1)) + len(m.group(1))
        add("contact_url", s, _trim_end(t, s + host_end, m.end()), "host" if via_host else "path")


# ---------------------------------------------------------------- dob heuristic

_MONTH = ("(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?"
          "|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)")
_DAY = "(?:3[01]|[12][0-9]|0?[1-9])"
_ORD = "(?:st|nd|rd|th)"
_UNITS = "(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth)"
_WORD_ORD = ("(?:twenty[ \\t\\-]?" + _UNITS + "|thirty[ \\t\\-]?first|" + _UNITS + "|tenth|eleventh|twelfth|thirteenth"
             "|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|twentieth|thirtieth)")
_YEAR_TAIL = "(?:,?[ \\t]*(?:[0-9]{4}|'[0-9]{2})\\b)?"

_DATE_FORMS = [
    ("month-day", re.compile(
        r"\b" + _MONTH + r"\b\.?(?:[ \t]+the)?[ \t]+(?:" + _DAY + _ORD + "?|" + _WORD_ORD + r")\b" + _YEAR_TAIL, _AI), None),
    ("day-month", re.compile(
        r"\b(?:" + _DAY + _ORD + r"?(?:[ \t]+of)?|" + _WORD_ORD + r"[ \t]+of)[ \t]+" + _MONTH + r"\b\.?" + _YEAR_TAIL, _AI), None),
    ("numeric", re.compile(r"\b[0-9]{4}([\-/.])(?:1[0-2]|0?[1-9])\1(?:3[01]|[12][0-9]|0?[1-9])\b", _A), "free"),
    ("numeric", re.compile(r"\b([0-9]{1,2})([\-/.])([0-9]{1,2})\2(?:[0-9]{4}|[0-9]{2})\b", _A), "dmy"),
    ("numeric", re.compile(r"\b([0-9]{1,2})/([0-9]{1,2})\b", _A), "md"),
    # full dates with the month as letters: 5-Mar-1950, 05MAR1950 and Mar-05-1950
    ("day-month", re.compile(r"\b" + _DAY + r"([\-/.]?)" + _MONTH + r"\1(?:[0-9]{4}|[0-9]{2})\b", _AI), None),
    ("month-day", re.compile(r"\b" + _MONTH + r"([\-/.])" + _DAY + r"\1(?:[0-9]{4}|[0-9]{2})\b", _AI), None),
    ("month-year", re.compile(r"\b" + _MONTH + r"\b\.?,?[ \t]+(?:of[ \t]+)?[0-9]{4}\b", _AI), None),
    ("month-year", re.compile(r"\b(?:1[0-2]|0?[1-9])/[0-9]{4}\b", _A), "free"),
]
_RULE_ORDER = ["month-day", "day-month", "numeric", "month-year"]

_WORD_KEYWORD = re.compile(r"\b(?:" + _alternation(list(BIRTHDAY_KEYWORDS) + _EVENT_WORDS) + r")\b", _AI)
_ABBR_KEYWORD = re.compile(
    r"\b(?:" + _alternation([a[:-1] for a in _BIRTH_ABBREVIATIONS + _EVENT_ABBREVIATIONS]) + r")\.", _A)
_BIRTH_ABBR = frozenset(_BIRTH_ABBREVIATIONS)


def _numeric_isolated(t, s, e):
    def sep_digit(i, j):
        return _at(t, i) != "" and _at(t, i) in "-/." and _is_digit(_at(t, j))
    return not sep_digit(e, e + 1) and not (s >= 2 and sep_digit(s - 1, s - 2))


def _date_candidates(t):
    found = []
    for rule, rx, check in _DATE_FORMS:
        for m in rx.finditer(t):
            s, e = m.start(), m.end()
            if check:
                if not _numeric_isolated(t, s, e):
                    continue
                if check == "dmy" and not _day_month(int(m.group(1)), int(m.group(3))):
                    continue
                if check == "md" and not _day_month(int(m.group(1)), int(m.group(2))):
                    continue
            found.append((s, e, rule))
    found.sort(key=lambda c: (c[0], -c[1], _RULE_ORDER.index(c[2])))
    out = []
    for c in found:
        if not out or c[0] >= out[-1][1]:
            out.append(c)
    return out


def _keywords(t):
    """Event keywords (start, end, birth) sorted by start; they never overlap, so their ends are sorted too."""
    words = [(m.start(), m.end(), re.sub(r"[ \t]+", " ", m.group(0).lower()) in BIRTHDAY_KEYWORDS)
             for m in _WORD_KEYWORD.finditer(t)]
    abbrs = []
    w = 0  # the first word that ends after this abbreviation starts
    for m in _ABBR_KEYWORD.finditer(t):
        s, e = m.start(), m.end()
        if s > 0 and t[s - 1] in ".'":
            continue
        while w < len(words) and words[w][1] <= s:
            w += 1
        if w < len(words) and words[w][0] < e:
            continue
        abbrs.append((s, e, m.group(0) in _BIRTH_ABBR))
    return sorted(words + abbrs, key=lambda k: k[0])


def _scan_dob(t, add):
    dates = _date_candidates(t)  # sorted and non-overlapping
    if not dates:
        return
    kws = _keywords(t)
    # The nearest event word owns the date: the last keyword ending at or before it, or the first starting at or after its
    # end (not for a month-year); a tie goes to the birth keyword. Two cursors, so linear in dates plus keywords.
    before = after = 0
    for ds, de, rule in dates:
        while before < len(kws) and kws[before][1] <= ds:
            before += 1
        while after < len(kws) and kws[after][0] < de:
            after += 1
        best, birth = None, False
        if before > 0 and ds - kws[before - 1][1] <= DOB_WINDOW:
            best, birth = ds - kws[before - 1][1], kws[before - 1][2]
        if rule != "month-year" and after < len(kws):
            gap = kws[after][0] - de
            if gap <= DOB_WINDOW and (best is None or gap < best or (gap == best and kws[after][2])):
                birth = kws[after][2]
        if birth:
            add("dob_heuristic", ds, de, rule)


# ---------------------------------------------------------------- API

_DETECTORS = (_scan_phones, _scan_emails, _scan_addresses, _scan_contact_urls, _scan_dob)


def scan_text(text, kinds=None):
    """Every R-18 / R-19 finding in ``text``, sorted by start, end and kind; ``kinds`` limits the result.

    None scans as empty; any other non-string is a TypeError. Returns ``[{"kind", "start", "end", "rule"}]``.
    """
    if text is None:
        return []
    if not isinstance(text, str):
        raise TypeError("scan_text: text must be a string")
    want = set(kinds) if kinds is not None else None
    t, frm, to = _normalize(text)
    hits = []
    seen = set()

    def add(kind, start, end, rule):
        if (want is not None and kind not in want) or end <= start:
            return
        if frm is not None:  # back to the caller's offsets
            start, end = frm[start], to[end - 1]
        key = (kind, start, end)
        if key in seen:
            return
        seen.add(key)
        hits.append({"kind": kind, "start": start, "end": end, "rule": rule})

    for detect in _DETECTORS:
        detect(t, add)
    hits.sort(key=lambda h: (h["start"], h["end"], KINDS.index(h["kind"])))
    return hits


#: The JS module's name, so both ports export scanText (AC1).
scanText = scan_text
