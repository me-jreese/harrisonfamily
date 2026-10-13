"""The one R-18 detector, Python port (HFY-PLN-002 D2-09, BRD2 section 5.2; task privacy-guard-core).

shared/privacy-guard.mjs is the JavaScript original; both pass the same cases in shared/privacy-guard.vectors.json
(gramps/tests/unit/test_scanner.py). Standard library only (``re``), so it runs in Gramps' bundled Python and in CI's
stock python3 (3.12 and later).

A finding is ``{"kind", "start", "end", "rule"}``: code-point offsets into the caller's string, never the matched text.
Nothing here logs or prints.

Parity rules with the JS module: ASCII-only regex semantics (re.ASCII; JS without the u flag), no \\s, no lookbehind,
``\\Z`` where JS uses ``$``, and a fold step that maps one character to one character so it never moves an offset.
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

#: (lo, hi, out, step): code points lo..hi fold to out (+ (cp - lo) when step is 1). One character to one character.
FOLD = (
    (0x00A0, 0x00A0, 0x20, 0), (0x00AD, 0x00AD, 0x20, 0), (0x00B7, 0x00B7, 0x2E, 0), (0x02BC, 0x02BC, 0x27, 0),
    (0x0660, 0x0669, 0x30, 1), (0x06F0, 0x06F9, 0x30, 1), (0x1680, 0x1680, 0x20, 0), (0x2000, 0x200D, 0x20, 0),
    (0x2010, 0x2015, 0x2D, 0), (0x2018, 0x2019, 0x27, 0), (0x2024, 0x2024, 0x2E, 0), (0x2028, 0x2029, 0x20, 0),
    (0x202F, 0x202F, 0x20, 0), (0x205F, 0x2060, 0x20, 0), (0x2212, 0x2212, 0x2D, 0), (0x3000, 0x3000, 0x20, 0),
    (0xFE58, 0xFE58, 0x2D, 0), (0xFE63, 0xFE63, 0x2D, 0), (0xFE6B, 0xFE6B, 0x40, 0), (0xFEFF, 0xFEFF, 0x20, 0),
    (0xFF01, 0xFF5E, 0x21, 1),
)
_FOLD_TABLE = {cp: chr(out + (cp - lo) * step) for lo, hi, out, step in FOLD for cp in range(lo, hi + 1)}

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
_REFERENCE = re.compile(
    r"\b(?:" + _alternation([
        "p", "pp", "pg", "pgs", "page", "pages", "vol", "vols", "volume", "no", "nos", "nr", "film", "roll", "fiche", "folio", "fol",
        "item", "image", "img", "dgs", "cert", "certificate", "record", "rec", "ref", "reference", "id", "isbn", "issn", "case", "file",
        "lot", "plot", "grave", "row", "sec", "section", "line", "entry", "frame", "register", "reg", "batch", "serial", "census",
        "book", "bk", "chapter", "ch",
    ]) + r")\.?[ \t]*(?:[:#][ \t]*)?\Z", _AI)


def _year_like(d):
    return _YEAR_LIKE.fullmatch(d) is not None


def _sep_core(sep):
    return re.sub(r"[ \t()]", "", sep)


def _day_month(a, b):
    return a >= 1 and b >= 1 and ((a <= 12 and b <= 31) or (a <= 31 and b <= 12))


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


def _in_url(t, pos):
    if pos == 0 or t[pos - 1] not in "/=?&#":
        return False
    i = pos
    while i > 0 and t[i - 1] not in _SPACE_CHARS:
        i -= 1
    token = t[i:pos]
    return "://" in token or _HOST_PATH.search(token) is not None


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
    return _REFERENCE.search(before) is not None


def _phone_verdict(t, s, run, groups):
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
            if n > 15 or _in_url(t, s + off) or _REFERENCE.search(before):
                return None
            return off, "run"
        if not _AREA_CODE.match(run[(0 if frm == 0 else off):off + 9]) and not _PHONE_WORD.search(before):
            # a date followed by more digits (5/12/2020 10:30): judge what follows the date on its own
            if len(groups) - frm > 3 and _is_date_triple(groups[frm:frm + 3], seps[frm:frm + 2]):
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
    for m in _PHONE_RUN.finditer(t):
        if m.start() > 0 and _is_word_char(t[m.start() - 1]):
            continue
        a, b = _unwrap(m.group(0))
        s = m.start() + a
        run = m.group(0)[a:b]
        if not run:
            continue
        groups = [(g.start(), g.group(0)) for g in _DIGIT_GROUP.finditer(run)]
        v = _phone_verdict(t, s, run, groups)
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
    "generations", "grandchildren", "cousins", "siblings", "brothers", "sisters",
]
_STRONG_SUFFIXES = [
    "street", "st", "avenue", "ave", "av", "road", "rd", "lane", "ln", "drive", "dr", "boulevard", "blvd", "highway", "hwy",
    "parkway", "pkwy", "turnpike", "tpke", "expressway", "expy", "freeway", "fwy", "pike", "alley", "aly", "crescent", "cres",
]
_WEAK_SUFFIXES = [
    "court", "ct", "place", "pl", "terrace", "ter", "way", "circle", "cir", "square", "sq", "trail", "trl", "close", "row",
    "loop", "path", "walk", "plaza", "plz",
]
_STRONG = frozenset(_STRONG_SUFFIXES)
_STREET = re.compile(
    r"\b([0-9]{1,6})([A-Za-z]?)(?:-[0-9]{1,5}[A-Za-z]?)?[ \t]+"
    r"(?:(?!(?:" + _alternation(_STREET_STOP) + r")\b)(?:[A-Za-z][A-Za-z'.\-]*|[0-9]{1,3}(?:st|nd|rd|th))[ \t]+){1,4}?"
    r"(" + _alternation(_STRONG_SUFFIXES + _WEAK_SUFFIXES) + r")\b\.?", _AI)
_PO_BOX = re.compile(
    r"\b(?:g?p[ \t]*\.?[ \t]*o\.?[ \t]*|post[ \t]+office[ \t]+)box[ \t]*(?:no\.?[ \t]*|#[ \t]*)?[0-9]{1,8}\b"
    r"|\bpmb[ \t]*#?[ \t]*[0-9]{1,8}\b", _AI)


def _scan_addresses(t, add):
    for m in _STREET.finditer(t):
        if not m.group(2) and _year_like(m.group(1)) and m.group(3).lower() not in _STRONG:
            continue
        add("street_address", m.start(), m.end(), "number-street")
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
    words = [(m.start(), m.end(), re.sub(r"[ \t]+", " ", m.group(0).lower()) in BIRTHDAY_KEYWORDS)
             for m in _WORD_KEYWORD.finditer(t)]
    abbrs = []
    for m in _ABBR_KEYWORD.finditer(t):
        s, e = m.start(), m.end()
        if s > 0 and t[s - 1] in ".'":
            continue
        if any(s < w[1] and e > w[0] for w in words):
            continue
        abbrs.append((s, e, m.group(0) in _BIRTH_ABBR))
    return words + abbrs


def _scan_dob(t, add):
    dates = _date_candidates(t)
    if not dates:
        return
    kws = _keywords(t)
    for ds, de, rule in dates:
        best, birth = None, False
        for ks, ke, kb in kws:
            if ke <= ds:
                gap = ds - ke
            elif ks >= de and rule != "month-year":
                gap = ks - de
            else:
                continue
            if gap > DOB_WINDOW:
                continue
            # the nearest event word owns the date; a tie goes to the birth keyword
            if best is None or gap < best or (gap == best and kb):
                best, birth = gap, kb
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
    t = text.translate(_FOLD_TABLE)
    hits = []
    seen = set()

    def add(kind, start, end, rule):
        key = (kind, start, end)
        if (want is not None and kind not in want) or end <= start or key in seen:
            return
        seen.add(key)
        hits.append({"kind": kind, "start": start, "end": end, "rule": rule})

    for detect in _DETECTORS:
        detect(t, add)
    hits.sort(key=lambda h: (h["start"], h["end"], KINDS.index(h["kind"])))
    return hits


#: The JS module's name, so both ports export scanText (AC1).
scanText = scan_text
