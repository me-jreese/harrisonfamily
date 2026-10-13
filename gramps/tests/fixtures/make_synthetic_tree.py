#!/usr/bin/env python3
"""Synthetic Gramps fixture tree generator (HFY-PLN-002, HFY-TSK-228).

Builds a small, entirely fictional family tree that contains every case the sync
design needs to exercise (sync.md section 15, plus the review scenarios), and writes:

    synthetic-tree.gramps         Gramps XML (plain, not gzipped)
    synthetic-tree.jsonl          one Gramps 6 json_data object per line
    synthetic-tree.census.json    case name -> Gramps IDs that show it (also checked by the unit test)
    media/                        the tiny media files the Media objects point at
    synthetic-tree.sha256         sha256 of every file above, for the stdlib-only check

Run it under the bundled Gramps with the shim, never with a system Python:

    gramps/tests/gramps/gramps-shim.sh --script gramps/tests/fixtures/make_synthetic_tree.py
    gramps/tests/gramps/gramps-shim.sh --script gramps/tests/fixtures/make_synthetic_tree.py --check

`--check` regenerates into a temporary directory and fails if any byte differs from the
committed files. `--out DIR` writes somewhere else. The output is a pure function of SEED and
of the Gramps version (6.0.6): handles, change times, the XML "created" date and the media
bytes are all fixed.

Every value is fictional: names are invented, phones are 555-01xx, mail is example.org, and
addresses are documentation-style. No real person, date, place or contact detail is used.
"""
import argparse
import hashlib
import io
import json
import os
import random
import shutil
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
SEED = 20261013
FIXED_TS = 1700000000  # 2023-11-14T22:13:20Z; every change time and the XML created date derive from it
GRAMPS_VERSION = "6.0.6"

# Class order of the JSONL file and of the XML census.
CLASSES = ("Tag", "Note", "Source", "Repository", "Place", "Media", "Citation", "Event", "Person", "Family")

sys.path.insert(0, HERE)
import census as census_mod  # noqa: E402  (stdlib only; shared with the unit test)

try:
    from gramps.gen.lib import (
        Address, Attribute, AttributeType, ChildRef, ChildRefType, Citation, Date, Event, EventRef,
        EventRoleType, EventType, Family, FamilyRelType, Location, LdsOrd, Media, MediaRef, Name,
        NameType, Note, NoteType, Person, PersonRef, Place, PlaceName, PlaceRef, PlaceType, Repository,
        RepoRef, RepositoryType, Source, SrcAttribute, SrcAttributeType, StyledText, StyledTextTag, StyledTextTagType,
        Surname, Tag, Url, UrlType,
    )
except ImportError:  # importable without Gramps for its constants; building the tree needs the bundle
    Person = None


class Builder:
    """Collects objects with deterministic handles and Gramps IDs."""

    PREFIX = {"Person": "I", "Family": "F", "Event": "E", "Place": "P", "Source": "S", "Citation": "C",
              "Repository": "R", "Media": "O", "Note": "N", "Tag": "T"}

    def __init__(self):
        self.objects = {c: {} for c in CLASSES}
        self.counter = {c: 0 for c in CLASSES}
        self.alias = {}

    def handle(self, cls, key):
        digest = hashlib.md5(("hfy-fixture:%s:%s" % (cls, key)).encode()).hexdigest()
        return digest[:28]

    def add(self, cls, key, obj):
        if key in self.alias:
            raise ValueError("duplicate fixture key %s" % key)
        self.counter[cls] += 1
        obj.set_handle(self.handle(cls, key))
        if hasattr(obj, "set_gramps_id"):  # tags have none
            obj.set_gramps_id("%s%04d" % (self.PREFIX[cls], self.counter[cls]))
        self.objects[cls][key] = obj
        self.alias[key] = obj
        return obj

    def get(self, key):
        return self.alias[key]

    def h(self, key):
        return self.alias[key].handle


def mkdate(year=0, month=0, day=0, modifier=None, quality=None, text="", value=None):
    d = Date()
    if modifier is None:
        modifier = Date.MOD_NONE
    if quality is None:
        quality = Date.QUAL_NONE
    if value is None:
        value = (day, month, year, False)
    d.set(quality=quality, modifier=modifier, calendar=Date.CAL_GREGORIAN, value=value, text=text)
    return d


def mkrange(y1, m1, d1, y2, m2, d2, modifier):
    return mkdate(modifier=modifier, value=(d1, m1, y1, False, d2, m2, y2, False))


def mkname(first, surname, name_type=None, date=None, private=False, call="", nick=""):
    n = Name()
    n.set_first_name(first)
    s = Surname()
    s.set_surname(surname)
    s.set_primary(True)
    n.add_surname(s)
    if name_type is not None:
        n.set_type(NameType(name_type))
    if date is not None:
        n.set_date_object(date)
    if call:
        n.set_call_name(call)
    if nick:
        n.set_nick_name(nick)
    n.set_privacy(private)
    return n


def attr(type_value, value, private=False, custom=None):
    a = Attribute()
    t = AttributeType(custom) if custom else AttributeType(type_value)
    a.set_type(t)
    a.set_value(value)
    a.set_privacy(private)
    return a


def person_event(b, p, key, etype, date, description="", place=None, role=None, private=False,
                 citations=(), custom=None, attributes=(), media_refs=(), birth=False, death=False):
    ev = Event()
    ev.set_type(EventType(custom) if custom else EventType(etype))
    if date is not None:
        ev.set_date_object(date)
    ev.set_description(description)
    ev.set_privacy(private)
    if place:
        ev.set_place_handle(b.h(place))
    for c in citations:
        ev.add_citation(b.h(c))
    for a in attributes:
        ev.add_attribute(a)
    for m in media_refs:
        ev.add_media_reference(m)
    b.add("Event", key, ev)
    ref = EventRef()
    ref.set_reference_handle(ev.handle)
    ref.set_role(EventRoleType(role if role is not None else EventRoleType.PRIMARY))
    p.add_event_ref(ref)
    if birth:
        p.set_birth_ref(ref)
    if death:
        p.set_death_ref(ref)
    return ev, ref


def mkperson(b, key, gender, name, private=False):
    p = Person()
    p.set_gender(gender)
    p.set_primary_name(name)
    p.set_privacy(private)
    b.add("Person", key, p)
    return p


def mkmediaref(b, media_key, rect=None, private=False):
    m = MediaRef()
    m.set_reference_handle(b.h(media_key))
    m.set_privacy(private)
    if rect is not None:
        m.set_rectangle(rect)
    return m


def build_media_files(out_media):
    """Writes the three tiny media files and returns {name: bytes}. Needs Pillow, which the bundle carries."""
    from PIL import Image
    files = {}
    # JPEG with EXIF GPS (fictional position in the open Atlantic, 12.5 N 23.25 W), 8x8 so it is a real picture.
    im = Image.new("RGB", (8, 8), (180, 200, 220))
    exif = Image.Exif()
    exif[0x010F] = "Fixture Camera Co"
    exif[0x0110] = "Synthetic 1"
    gps = {
        1: "N", 2: (12.0, 30.0, 0.0),
        3: "W", 4: (23.0, 15.0, 0.0),
        5: 0, 6: 0.0,
    }
    exif[0x8825] = gps
    buf = io.BytesIO()
    im.save(buf, "JPEG", exif=exif, quality=75, optimize=False)
    files["synthetic-photo-gps.jpg"] = buf.getvalue()
    # Plain JPEG without EXIF location, for the clean case.
    im2 = Image.new("RGB", (8, 8), (220, 200, 180))
    buf = io.BytesIO()
    im2.save(buf, "JPEG", quality=75, optimize=False)
    files["synthetic-photo-plain.jpg"] = buf.getvalue()
    # A Dropbox-placeholder-like file: present, zero bytes.
    files["synthetic-placeholder.jpg"] = b""
    # A tiny PDF standing in for a birth certificate. Hand-written so it is byte-stable.
    pdf = (b"%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n"
           b"2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n"
           b"3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 72 72]>>endobj\n"
           b"trailer<</Root 1 0 R>>\n%%EOF\n")
    files["synthetic-birth-certificate.pdf"] = pdf
    return files


def build_tree(media_files):
    rng = random.Random(SEED)
    b = Builder()

    # ---- tags -------------------------------------------------------------------------------
    for key, name, color in (("tag_todo", "Fixture ToDo", "#ef2929"), ("tag_review", "Fixture Review", "#3465a4")):
        t = Tag()
        t.set_name(name)
        t.set_color(color)
        t.set_priority(1)
        b.add("Tag", key, t)

    # ---- repository (with an address) ---------------------------------------------------------
    repo = Repository()
    repo.set_name("Example County Archive")
    repo.set_type(RepositoryType(RepositoryType.ARCHIVE))
    a = Address()
    a.set_street("100 Example Street")
    a.set_locality("Exampleton")
    a.set_city("Exampleville")
    a.set_state("EX")
    a.set_country("Fixtureland")
    a.set_postal_code("00000")
    a.set_phone("555-0100")
    repo.add_address(a)
    u = Url()
    u.set_path("https://archive.example.org/")
    u.set_type(UrlType(UrlType.WEB_HOME))
    u.set_description("Archive website")
    repo.add_url(u)
    b.add("Repository", "repo_archive", repo)

    # ---- places -------------------------------------------------------------------------------
    def mkplace(key, name, ptype, parent=None, lat="", lon="", custom=None, alt_loc=None, url=None, code=""):
        pl = Place()
        pn = PlaceName()
        pn.set_value(name)
        pl.set_name(pn)
        pl.set_type(PlaceType(custom) if custom else PlaceType(ptype))
        pl.set_title(name)
        pl.set_code(code)
        if lat:
            pl.set_latitude(lat)
            pl.set_longitude(lon)
        if parent:
            pr = PlaceRef()
            pr.set_reference_handle(b.h(parent))
            pl.add_placeref(pr)
        if alt_loc:
            pl.add_alternate_locations(alt_loc)
        if url:
            pl.add_url(url)
        b.add("Place", key, pl)
        return pl

    mkplace("pl_country", "Fixtureland", PlaceType.COUNTRY)
    mkplace("pl_city", "Exampleville", PlaceType.CITY, "pl_country", code="00000")
    mkplace("pl_farm", "Sample Farm", PlaceType.FARM, "pl_city")
    mkplace("pl_home", "The Homestead", None, "pl_city", custom="Home")
    mkplace("pl_coords", "Coordinate Cove", PlaceType.LOCALITY, "pl_city", lat="12.345678", lon="-23.456789")
    loc = Location()
    loc.set_street("123 Example Street")
    loc.set_locality("Exampleton")
    loc.set_postal_code("00000")
    loc.set_phone("555-0143")
    loc.set_city("Exampleville")
    pl_url = Url()
    pl_url.set_path("https://places.example.org/street")
    pl_url.set_type(UrlType(UrlType.WEB_HOME))
    mkplace("pl_street", "Example Street", PlaceType.STREET, "pl_city", alt_loc=loc, url=pl_url)
    mkplace("pl_building", "Sample Hall", PlaceType.BUILDING, "pl_street")

    # ---- sources and citations ----------------------------------------------------------------
    src = Source()
    src.set_title("Fixture Parish Register")
    src.set_author("A. Clerk")
    src.set_publication_info("Example Press")
    src.set_abbreviation("FPR")
    rr = RepoRef()
    rr.set_reference_handle(b.h("repo_archive"))
    src.add_repo_reference(rr)
    sa = SrcAttribute()
    sa.set_type(SrcAttributeType(SrcAttributeType.CUSTOM))
    sa.set_value("registry lot 7")
    src.add_attribute(sa)
    b.add("Source", "src_register", src)

    def mkcite(key, page, date=None, private=False):
        c = Citation()
        c.set_reference_handle(b.h("src_register"))
        c.set_page(page)
        if date is not None:
            c.set_date_object(date)
        c.set_privacy(private)
        b.add("Citation", key, c)
        return c

    mkcite("cit_plain", "folio 1")
    mkcite("cit_birth_fulldate", "folio 2", date=mkdate(1871, 4, 12))
    mkcite("cit_private", "folio 3", private=True)

    # ---- media objects ------------------------------------------------------------------------
    def mkmedia(key, name, mime, desc, private=False, date=None):
        m = Media()
        m.set_path("media/" + name)
        m.set_mime_type(mime)
        m.set_description(desc)
        m.set_checksum(hashlib.md5(media_files[name]).hexdigest())
        m.set_privacy(private)
        if date is not None:
            m.set_date_object(date)
        b.add("Media", key, m)
        return m

    mkmedia("med_group", "synthetic-photo-plain.jpg", "image/jpeg", "Group photo (fictional)")
    mkmedia("med_gps", "synthetic-photo-gps.jpg", "image/jpeg", "Photo with embedded location (fictional)")
    mkmedia("med_placeholder", "synthetic-placeholder.jpg", "image/jpeg", "Zero-byte placeholder file")
    mkmedia("med_cert", "synthetic-birth-certificate.pdf", "application/pdf", "Birth certificate (fictional)")
    mkmedia("med_private", "synthetic-photo-plain.jpg", "image/jpeg", "Private photo (fictional)", private=True)

    # ---- notes (with phone / email / styled tags) ---------------------------------------------------
    def mknote(key, text, ntype=None, tags=(), private=False):
        n = Note()
        n.set_styledtext(StyledText(text, list(tags)))
        n.set_type(NoteType(ntype if ntype is not None else NoteType.PERSON))
        n.set_privacy(private)
        b.add("Note", key, n)
        return n

    styled_text = "Bold start, italic middle, link end."
    styled_tags = [
        StyledTextTag(StyledTextTagType(StyledTextTagType.BOLD), True, [(0, 10)]),
        StyledTextTag(StyledTextTagType(StyledTextTagType.ITALIC), True, [(12, 25)]),
        StyledTextTag(StyledTextTagType(StyledTextTagType.LINK), "https://notes.example.org/page", [(27, 35)]),
    ]
    mknote("note_styled", styled_text, tags=styled_tags)
    mknote("note_phone", "For questions call 555-0142 in the evening.")
    mknote("note_email", "Write to fixture.contact@example.org with any news.")
    mknote("note_plain", "A plain note with nothing sensitive in it.")
    mknote("note_street", "The cottage was at 456 Sample Road, Exampleville.")
    mknote("note_dob_prose", "Born on 3 May 1900 according to the register (fictional).")
    mknote("note_private", "A private note that only the private person carries.", private=True)
    mknote("note_priv_inner", "A private note on an otherwise shared person.", private=True)

    # ---- persons and events -------------------------------------------------------------------------
    M, F, U = Person.MALE, Person.FEMALE, Person.UNKNOWN

    # I: grandparents (full DOBs, death, marriage with every family event)
    p_gp1 = mkperson(b, "p_gp1", M, mkname("Alder", "Testwood"))
    person_event(b, p_gp1, "ev_gp1_birth", EventType.BIRTH, mkdate(1840, 2, 14), "Born (fictional)",
                 place="pl_farm", birth=True, citations=("cit_plain",))
    person_event(b, p_gp1, "ev_gp1_death", EventType.DEATH, mkdate(1912, 9, 3), place="pl_city", death=True)
    p_gp2 = mkperson(b, "p_gp2", F, mkname("Birch", "Samplefield"))
    person_event(b, p_gp2, "ev_gp2_birth", EventType.BIRTH, mkdate(1844, 11, 30), place="pl_farm", birth=True)
    person_event(b, p_gp2, "ev_gp2_death", EventType.DEATH, mkdate(1920, 1, 9), death=True)

    # Birth event (full date) that the review scenario retypes to Residence: the retype must not carry the date.
    p_retype = mkperson(b, "p_retype", M, mkname("Cedar", "Testwood"))
    person_event(b, p_retype, "ev_retype_birth", EventType.BIRTH, mkdate(1868, 6, 21),
                 "Retype to Residence (review scenario)", place="pl_home", birth=True)

    # Stillbirth. Like the christening below, it is not the person's birth_ref: Gramps (its editor and
    # its XML import) points birth_ref only at a Birth event, so a stillbirth or christening is a fallback.
    p_still = mkperson(b, "p_still", U, mkname("Dell", "Testwood"))
    person_event(b, p_still, "ev_still", EventType.STILLBIRTH, mkdate(1870, 3, 8))

    # Baptism of a deceased person, with a day, and no Birth event.
    p_bapt = mkperson(b, "p_bapt", F, mkname("Elm", "Testwood"))
    person_event(b, p_bapt, "ev_bapt", EventType.BAPTISM, mkdate(1873, 7, 15), place="pl_building", citations=("cit_plain",))
    person_event(b, p_bapt, "ev_bapt_death", EventType.DEATH, mkdate(1874, 2, 2), death=True)

    # RANGE birth date
    p_range = mkperson(b, "p_range", M, mkname("Fennel", "Testwood"))
    person_event(b, p_range, "ev_range_birth", EventType.BIRTH,
                 mkrange(1875, 3, 1, 1875, 3, 31, Date.MOD_RANGE), birth=True)

    # TEXTONLY birth date
    p_text = mkperson(b, "p_text", F, mkname("Gorse", "Testwood"))
    person_event(b, p_text, "ev_text_birth", EventType.BIRTH,
                 mkdate(modifier=Date.MOD_TEXTONLY, text="sometime in spring 1877, per the register"), birth=True)

    # Birth event with a full-date citation; birth-name Name.date full.
    p_cite = mkperson(b, "p_cite", M, mkname("Hazel", "Testwood", name_type=NameType.BIRTH, date=mkdate(1871, 4, 12)))
    person_event(b, p_cite, "ev_cite_birth", EventType.BIRTH, mkdate(1871, 4, 12), birth=True,
                 citations=("cit_birth_fulldate",))
    p_cite.add_alternate_name(mkname("Hazelton", "Testwood", name_type=NameType.AKA))
    p_cite.add_alternate_name(mkname("Private Alias", "Testwood", name_type=NameType.AKA, private=True))

    # Christening, blessing, a custom birth-like event, a SPAN residence and a custom unrelated event.
    p_events = mkperson(b, "p_events", F, mkname("Iris", "Samplefield"))
    person_event(b, p_events, "ev_chr", EventType.CHRISTEN, mkdate(1880, 5, 9))
    person_event(b, p_events, "ev_bless", EventType.BLESS, mkdate(1880, 5, 20))
    person_event(b, p_events, "ev_custom_birth", None, mkdate(1880, 5, 1), custom="Geburt")
    person_event(b, p_events, "ev_span", EventType.RESIDENCE,
                 mkrange(1890, 1, 1, 1895, 12, 31, Date.MOD_SPAN), place="pl_home")
    person_event(b, p_events, "ev_custom_other", None, mkdate(1900, 8, 17), "Fixture pilgrimage", custom="Fixture Pilgrimage")
    person_event(b, p_events, "ev_private_role", EventType.OCCUPATION, mkdate(1905), "Fixture clerk", private=True)

    # Private person with an exclusive birth event, note and photo.
    p_priv = mkperson(b, "p_private", F, mkname("Juniper", "Fixturely"), private=True)
    person_event(b, p_priv, "ev_priv_birth", EventType.BIRTH, mkdate(1950, 10, 5), private=True, birth=True)
    p_priv.add_note(b.h("note_private"))
    p_priv.add_media_reference(mkmediaref(b, "med_private"))

    # Person whose primary name is private (the whole person is held).
    p_privname = mkperson(b, "p_privname", M, mkname("Kestrel", "Fixturely", private=True))
    person_event(b, p_privname, "ev_privname_birth", EventType.BIRTH, mkdate(1955, 1, 20), birth=True)

    # Contact-shaped data on a shared person.
    p_contact = mkperson(b, "p_contact", F, mkname("Laurel", "Fixturely"))
    person_event(b, p_contact, "ev_contact_birth", EventType.BIRTH, mkdate(1960, 12, 25), birth=True)
    ad = Address()
    ad.set_street("123 Example Street")
    ad.set_city("Exampleville")
    ad.set_state("EX")
    ad.set_postal_code("00000")
    ad.set_phone("555-0101")
    ad.set_country("Fixtureland")
    p_contact.add_address(ad)
    ad2 = Address()
    ad2.set_street("999 Private Lane")
    ad2.set_city("Exampleville")
    ad2.set_privacy(True)
    p_contact.add_address(ad2)
    for typ, path, desc, priv in (
        (UrlType.EMAIL, "laurel@example.org", "Email", False),
        (UrlType.WEB_HOME, "https://wa.me/15555550123", "Chat channel", False),
        (UrlType.WEB_HOME, "tel:+15555550124", "Phone link", False),
        (UrlType.WEB_SEARCH, "https://example.org/search?q=fixture", "Search", False),
        (UrlType.WEB_HOME, "https://example.org/private-page", "Private page", True),
    ):
        u = Url()
        u.set_type(UrlType(typ))
        u.set_path(path)
        u.set_description(desc)
        u.set_privacy(priv)
        p_contact.add_url(u)
    p_contact.add_note(b.h("note_phone"))
    p_contact.add_note(b.h("note_email"))
    p_contact.add_note(b.h("note_street"))
    p_contact.add_note(b.h("note_dob_prose"))
    p_contact.add_note(b.h("note_styled"))
    p_contact.add_note(b.h("note_priv_inner"))
    p_contact.add_attribute(attr(AttributeType.AGE, "62"))
    p_contact.add_attribute(attr(AttributeType.FATHER_AGE, "30"))
    p_contact.add_attribute(attr(AttributeType.MOTHER_AGE, "28"))
    p_contact.add_attribute(attr(AttributeType.TIME, "04:15"))
    p_contact.add_attribute(attr(AttributeType.SSN, "000-00-0000"))
    p_contact.add_attribute(attr(AttributeType.ID, "FIXTURE-ID-0001"))
    p_contact.add_attribute(attr(None, "I0999", custom="Merged Gramps ID"))
    p_contact.add_attribute(attr(AttributeType.OCCUPATION, "Secret occupation", private=True))
    p_contact.add_tag(b.h("tag_todo"))
    ref_assoc = PersonRef()
    ref_assoc.set_reference_handle(p_gp1.handle)
    ref_assoc.set_relation("Godfather")
    p_contact.add_person_ref(ref_assoc)
    ref_assoc2 = PersonRef()
    ref_assoc2.set_reference_handle(p_gp2.handle)
    ref_assoc2.set_relation("Private friend")
    ref_assoc2.set_privacy(True)
    p_contact.add_person_ref(ref_assoc2)
    lds = LdsOrd()
    lds.set_type(LdsOrd.BAPTISM)
    lds.set_date_object(mkdate(1969, 3, 2))
    p_contact.add_lds_ord(lds)
    lds2 = LdsOrd()
    lds2.set_type(LdsOrd.ENDOWMENT)
    lds2.set_date_object(mkdate(1980, 7, 9))
    lds2.set_privacy(True)
    p_contact.add_lds_ord(lds2)

    # Photo tags: two tags of one person in one photo, a [0,0,100,100] rect, a float rect, a private ref.
    p_tag2 = mkperson(b, "p_tag2", M, mkname("Maple", "Fixturely"))
    person_event(b, p_tag2, "ev_tag2_birth", EventType.BIRTH, mkdate(1962, 4, 4), birth=True)
    p_tag2.add_media_reference(mkmediaref(b, "med_group", rect=(10, 10, 40, 40)))
    p_tag2.add_media_reference(mkmediaref(b, "med_group", rect=(50, 10, 90, 40)))
    p_tag2.add_media_reference(mkmediaref(b, "med_gps", private=True))
    p_full = mkperson(b, "p_fullrect", F, mkname("Nettle", "Fixturely"))
    person_event(b, p_full, "ev_full_birth", EventType.BIRTH, mkdate(1964, 9, 9), birth=True)
    p_full.add_media_reference(mkmediaref(b, "med_group", rect=(0, 0, 100, 100)))
    p_full.add_media_reference(mkmediaref(b, "med_gps"))
    p_float = mkperson(b, "p_floatrect", M, mkname("Orchid", "Fixturely"))
    person_event(b, p_float, "ev_float_birth", EventType.BIRTH, mkdate(1966, 2, 28), birth=True)
    p_float.add_media_reference(mkmediaref(b, "med_group", rect=(12.5, 10.25, 40.75, 60.5)))
    p_float.add_media_reference(mkmediaref(b, "med_placeholder"))
    p_float.add_media_reference(mkmediaref(b, "med_cert"))

    # Birth certificate PDF as media on the retype person, coordinates place on a custom event.
    p_retype.add_media_reference(mkmediaref(b, "med_cert"))
    person_event(b, p_retype, "ev_retype_coords", EventType.RESIDENCE, mkdate(1890), place="pl_coords")
    person_event(b, p_retype, "ev_retype_street", EventType.RESIDENCE, mkdate(1895), place="pl_street")
    p_retype.add_tag(b.h("tag_review"))

    # Filler persons from the seeded generator (year-only births, so no extra full DOBs).
    firsts = ["Ash", "Bay", "Clove", "Dune", "Ember", "Flint", "Glen", "Heron", "Ivy", "Jade", "Kelp", "Lark"]
    lasts = ["Testwood", "Samplefield", "Fixturely"]
    fillers = []
    for i in range(10):
        fp = mkperson(b, "filler%02d" % i, rng.choice((M, F, U)), mkname(rng.choice(firsts) + str(i), rng.choice(lasts)))
        person_event(b, fp, "ev_filler%02d" % i, EventType.BIRTH, mkdate(rng.randint(1700, 1990)), birth=True)
        fillers.append(fp)

    # ---- families ----------------------------------------------------------------------------------------
    def mkfamily(key, father, mother, rel=FamilyRelType.MARRIED, private=False):
        fam = Family()
        if father is not None:
            fam.set_father_handle(father.handle)
            father.add_family_handle(b.handle("Family", key))
        if mother is not None:
            fam.set_mother_handle(mother.handle)
            mother.add_family_handle(b.handle("Family", key))
        fam.set_relationship(FamilyRelType(rel))
        fam.set_privacy(private)
        b.add("Family", key, fam)
        return fam

    def addchild(fam, child, frel=ChildRefType.BIRTH, mrel=ChildRefType.BIRTH, private=False, custom=None,
                 mcustom=None):
        # A custom relation always carries its string: ChildRefType(CUSTOM) with no string does not survive XML.
        cr = ChildRef()
        cr.set_reference_handle(child.handle)
        cr.set_father_relation(ChildRefType(custom) if custom else ChildRefType(frel))
        cr.set_mother_relation(ChildRefType(mcustom) if mcustom else ChildRefType(mrel))
        cr.set_privacy(private)
        fam.add_child_ref(cr)
        child.add_parent_family_handle(fam.handle)
        return cr

    f1 = mkfamily("f1", p_gp1, p_gp2)
    ev = Event()
    ev.set_type(EventType(EventType.MARRIAGE))
    ev.set_date_object(mkdate(1866, 5, 19))
    ev.set_place_handle(b.h("pl_city"))
    b.add("Event", "ev_f1_marriage", ev)
    er = EventRef()
    er.set_reference_handle(ev.handle)
    er.set_role(EventRoleType(EventRoleType.FAMILY))
    f1.add_event_ref(er)
    ev = Event()
    ev.set_type(EventType(EventType.DIVORCE))
    ev.set_date_object(mkdate(1890, 2, 2))
    b.add("Event", "ev_f1_divorce", ev)
    er = EventRef()
    er.set_reference_handle(ev.handle)
    er.set_role(EventRoleType(EventRoleType.FAMILY))
    er.set_privacy(True)
    f1.add_event_ref(er)
    f1.add_attribute(attr(AttributeType.NUM_CHILD, "6"))
    f1.add_note(b.h("note_plain"))
    f1.add_media_reference(mkmediaref(b, "med_group", rect=(5, 5, 95, 95)))
    for c in (p_retype, p_still, p_bapt, p_range, p_text):
        addchild(f1, c)
    addchild(f1, p_cite, private=True)  # private ChildRef

    # Every ChildRefType on frel and mrel: second family (NONE is on the f5 child below).
    f2 = mkfamily("f2", p_cite, p_events, rel=FamilyRelType.UNMARRIED)
    kinds = [ChildRefType.BIRTH, ChildRefType.ADOPTED, ChildRefType.STEPCHILD, ChildRefType.SPONSORED,
             ChildRefType.FOSTER, ChildRefType.UNKNOWN]
    kids = fillers[:7]
    for i, kid in enumerate(kids[:6]):
        addchild(f2, kid, frel=kinds[i], mrel=kinds[(i + 1) % len(kinds)])
    addchild(f2, kids[6], custom="Godchild", mcustom="Ward")

    # Remaining family relationship types.
    mkfamily("f3", p_contact, p_tag2, rel=FamilyRelType.CIVIL_UNION)
    mkfamily("f4", p_full, p_float, rel=FamilyRelType.UNKNOWN)
    f5 = mkfamily("f5", fillers[7], fillers[8], rel=FamilyRelType.CUSTOM)
    f5.set_relationship(FamilyRelType("Fixture partnership"))
    f5.add_tag(b.h("tag_review"))
    addchild(f5, fillers[9], frel=ChildRefType.NONE, mrel=ChildRefType.NONE)

    # Private family: a couple of its own (the private person and the private-name person), no children.
    mkfamily("f_private", p_priv, p_privname, private=True)

    return b


def write_database(b, workdir):
    """Loads the builder into a throwaway sqlite Gramps database and returns (db, path)."""
    from gramps.gen.db import DbTxn
    from gramps.gen.db.utils import make_database

    dbdir = os.path.join(workdir, "tree")
    os.makedirs(dbdir)
    db = make_database("sqlite")
    db.load(dbdir, None)
    adders = {
        "Tag": db.add_tag, "Note": db.add_note, "Source": db.add_source, "Repository": db.add_repository,
        "Place": db.add_place, "Media": db.add_media, "Citation": db.add_citation, "Event": db.add_event,
        "Person": db.add_person, "Family": db.add_family,
    }
    with DbTxn("synthetic fixture", db, batch=True) as trans:
        for cls in CLASSES:
            for obj in b.objects[cls].values():
                if cls == "Tag":
                    adders[cls](obj, trans)
                else:
                    adders[cls](obj, trans, set_gid=False)
    return db, dbdir


def dump_jsonl(db):
    lines = []
    iters = {
        "Tag": db.iter_tags, "Note": db.iter_notes, "Source": db.iter_sources, "Repository": db.iter_repositories,
        "Place": db.iter_places, "Media": db.iter_media, "Citation": db.iter_citations, "Event": db.iter_events,
        "Person": db.iter_people, "Family": db.iter_families,
    }
    from gramps.gen.lib.json_utils import object_to_dict
    for cls in CLASSES:
        rows = []
        for obj in iters[cls]():
            d = object_to_dict(obj)
            rows.append((d.get("gramps_id") or d.get("name") or "", d))
        rows.sort(key=lambda r: r[0])
        for _, d in rows:
            lines.append(json.dumps(d, sort_keys=True, ensure_ascii=False, separators=(",", ":")))
    return ("\n".join(lines) + "\n").encode("utf-8")


def write_xml(db, path):
    from gramps.gen.user import User
    from gramps.plugins.export.exportxml import XmlWriter
    XmlWriter(db, User(), 0, 0).write(path)


def generate(out_dir):
    """Writes every fixture file into out_dir. Pure function of SEED and the Gramps version."""
    os.makedirs(os.path.join(out_dir, "media"), exist_ok=True)
    media_files = build_media_files(out_dir)
    for name, data in media_files.items():
        with open(os.path.join(out_dir, "media", name), "wb") as fh:
            fh.write(data)

    real_time, real_tz = time.time, os.environ.get("TZ")
    time.time = lambda: float(FIXED_TS)  # change times and the XML created date
    # The XML created date is time.localtime(time.time()), so pin the zone too: FIXED_TS is late on
    # 2023-11-14 in UTC and already 2023-11-15 east of UTC+1:47.
    os.environ["TZ"] = "UTC"
    time.tzset()
    work = tempfile.mkdtemp(prefix="hfy-fixture-")
    try:
        b = build_tree(media_files)
        db, _ = write_database(b, work)
        try:
            jsonl = dump_jsonl(db)
            write_xml(db, os.path.join(out_dir, "synthetic-tree.gramps"))
        finally:
            db.close()
    finally:
        time.time = real_time
        if real_tz is None:
            os.environ.pop("TZ", None)
        else:
            os.environ["TZ"] = real_tz
        time.tzset()
        shutil.rmtree(work, ignore_errors=True)

    with open(os.path.join(out_dir, "synthetic-tree.jsonl"), "wb") as fh:
        fh.write(jsonl)

    objs = census_mod.load_jsonl(os.path.join(out_dir, "synthetic-tree.jsonl"))
    result = census_mod.run_census(objs)
    with open(os.path.join(out_dir, "synthetic-tree.census.json"), "w", encoding="utf-8") as fh:
        json.dump(result, fh, sort_keys=True, indent=2)
        fh.write("\n")

    write_checksums(out_dir)


def write_checksums(out_dir):
    names = sorted(census_mod.GENERATED_FILES + ["media/" + n for n in census_mod.MEDIA_FILES])
    lines = []
    for n in names:
        with open(os.path.join(out_dir, n), "rb") as fh:
            lines.append("%s  %s" % (hashlib.sha256(fh.read()).hexdigest(), n))
    with open(os.path.join(out_dir, "synthetic-tree.sha256"), "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")


ALLOWLIST = os.path.abspath(os.path.join(HERE, "..", "..", "..", "scripts", "ci", "data-sample-allowlist.txt"))
GUARDED = ("synthetic-tree.gramps", "synthetic-tree.jsonl")


def update_allowlist():
    """Keeps the D-03 guard's allowlist lines for the two data-shaped goldens in step with the files."""
    if not os.path.isfile(ALLOWLIST):
        return
    with open(ALLOWLIST, encoding="utf-8") as fh:
        lines = [l for l in fh.read().split("\n") if l]
    lines = [l for l in lines if not any(l.endswith("gramps/tests/fixtures/" + n) for n in GUARDED)]
    for n in GUARDED:
        with open(os.path.join(HERE, n), "rb") as fh:
            lines.append("%s  gramps/tests/fixtures/%s" % (hashlib.sha256(fh.read()).hexdigest(), n))
    with open(ALLOWLIST, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")
    print("[OK] updated %s" % os.path.relpath(ALLOWLIST, os.getcwd()))


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--out", default=HERE, help="directory to write (default: this directory)")
    ap.add_argument("--check", action="store_true", help="regenerate in a temp dir and compare byte for byte")
    args = ap.parse_args()

    if args.check:
        tmp = tempfile.mkdtemp(prefix="hfy-fixture-check-")
        try:
            generate(tmp)
            bad = []
            for n in census_mod.ALL_FILES:
                with open(os.path.join(tmp, n), "rb") as a, open(os.path.join(args.out, n), "rb") as c:
                    if a.read() != c.read():
                        bad.append(n)
            if bad:
                print("[FAIL] regenerated output differs from the committed files: %s" % ", ".join(bad))
                return 1
            print("[OK] regenerated output is byte-identical (%d files)" % len(census_mod.ALL_FILES))
            return 0
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    generate(args.out)
    print("[OK] wrote %d files to %s" % (len(census_mod.ALL_FILES), args.out))
    if os.path.abspath(args.out) == HERE:
        update_allowlist()
    return 0


if __name__ == "__main__":
    sys.exit(main())
