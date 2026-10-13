// Synthetic Gramps 6 JSON objects for the tests. Every name, place and id is invented. Fields the
// projection must never read carry ZZSENT markers, and the tests assert none of them reach the output.

export const SENTINEL = 'ZZSENT';

const enumOf = (cls, value, string = '') => ({ _class: cls, value, string });

export function date({ year = 0, month = 3, day = 17, modifier = 0, quality = 0, text = '' } = {}) {
  return {
    _class: 'Date',
    calendar: 0,
    modifier,
    quality,
    dateval: modifier === 4 || modifier === 5 ? [day, month, year, false, day, month, year + 1, false] : [year ? day : 0, year ? month : 0, year, false],
    text: text || (year ? `${SENTINEL}_DATE_TEXT` : ''),
    sortval: year ? 2400000 + year : 0,
    newyear: 0,
  };
}

export class Tree {
  constructor() {
    this.objects = [];
    this.eventSeq = 0;
  }

  place(id, { name, type = 4, customType = '', parent = null, lat = '', long = '', private: priv = false } = {}) {
    this.objects.push({
      _class: 'Place',
      handle: `h_${id}`,
      gramps_id: id,
      name: { _class: 'PlaceName', value: name ?? `Place ${id}`, lang: '', date: date() },
      place_type: enumOf('PlaceType', type, customType),
      placeref_list: parent ? [{ _class: 'PlaceRef', ref: `h_${parent}`, date: date() }] : [],
      lat,
      long,
      code: `${SENTINEL}_POSTAL`,
      alt_names: [{ _class: 'PlaceName', value: `${SENTINEL}_ALT`, lang: '' }],
      urls: [{ _class: 'Url', path: `https://example.invalid/${SENTINEL}`, type: enumOf('UrlType', 1) }],
      note_list: [`h_${SENTINEL}_note`],
      private: priv,
    });
    return this;
  }

  event(id, { type = 12, when = {}, place = null, private: priv = false, description = `${SENTINEL}_DESC` } = {}) {
    this.objects.push({
      _class: 'Event',
      handle: `h_${id}`,
      gramps_id: id,
      type: enumOf('EventType', type),
      date: when === null ? date() : date(when),
      place: place ? `h_${place}` : '',
      description,
      citation_list: [`h_${SENTINEL}_cit`],
      attribute_list: [{ _class: 'Attribute', value: `${SENTINEL}_ATTR` }],
      note_list: [],
      private: priv,
    });
    return `h_${id}`;
  }

  /**
   * person('I9001', { given, surname, gender, birth: {when, place, private}, death: {...}, extra: [{type, when, place, role}] })
   * `death` omitted = living (rule L).
   */
  person(id, { given = 'Test', surname = 'Example', gender = 2, birth = null, death = null, extra = [], private: priv = false } = {}) {
    const refs = [];
    const eventRef = (ev, role = 1, refPrivate = false) => ({ _class: 'EventRef', ref: ev, role: enumOf('EventRoleType', role), private: refPrivate, attribute_list: [], note_list: [] });
    let birthIdx = -1;
    let deathIdx = -1;
    if (birth) {
      refs.push(eventRef(this.event(`E${++this.eventSeq}`, { type: 12, when: birth.when ?? {}, place: birth.place, private: birth.private })));
      birthIdx = refs.length - 1;
    }
    if (death) {
      refs.push(eventRef(this.event(`E${++this.eventSeq}`, { type: 13, when: death.when ?? {}, place: death.place, private: death.private })));
      deathIdx = refs.length - 1;
    }
    for (const x of extra) {
      refs.push(eventRef(this.event(`E${++this.eventSeq}`, { type: x.type, when: x.when ?? {}, place: x.place, private: x.private }), x.role ?? 1, x.refPrivate ?? false));
    }
    this.objects.push({
      _class: 'Person',
      handle: `h_${id}`,
      gramps_id: id,
      gender,
      primary_name: {
        _class: 'Name',
        first_name: given,
        surname_list: [
          { _class: 'Surname', surname: `${SENTINEL}_PREFIXED_OTHER`, primary: false },
          { _class: 'Surname', surname, primary: true },
        ],
        nick: `${SENTINEL}_NICK`,
        call: `${SENTINEL}_CALL`,
        title: `${SENTINEL}_TITLE`,
        suffix: `${SENTINEL}_SUFFIX`,
        date: date({ year: 1901 }),
      },
      alternate_names: [{ _class: 'Name', first_name: `${SENTINEL}_ALT`, surname_list: [] }],
      event_ref_list: refs,
      birth_ref_index: birthIdx,
      death_ref_index: deathIdx,
      media_list: [{ _class: 'MediaRef', ref: `h_${SENTINEL}_media`, rect: [10, 10, 60, 60], private: false }],
      address_list: [{ _class: 'Address', street: `${SENTINEL}_STREET`, city: 'Nowhere', phone: '555-010-0100', date: date({ year: 1950 }) }],
      urls: [{ _class: 'Url', path: `https://example.invalid/${SENTINEL}`, type: enumOf('UrlType', 1) }],
      attribute_list: [{ _class: 'Attribute', type: enumOf('AttributeType', 0, 'Email'), value: `${SENTINEL}@example.invalid` }],
      lds_ord_list: [{ _class: 'LdsOrd', temple: `${SENTINEL}_TEMPLE` }],
      note_list: [`h_${SENTINEL}_note`],
      citation_list: [`h_${SENTINEL}_cit`],
      family_list: [],
      parent_family_list: [],
      private: priv,
    });
    return this;
  }

  /**
   * family('F9001', { father, mother, type, children: [{ id, frel, mrel, private }], events: [{ type, when, place, role }] })
   */
  family(id, { father = null, mother = null, type = 0, children = [], events = [], private: priv = false } = {}) {
    const refs = events.map((x) => ({
      _class: 'EventRef',
      ref: this.event(`E${++this.eventSeq}`, { type: x.type, when: x.when ?? {}, place: x.place }),
      role: enumOf('EventRoleType', x.role ?? 8),
      private: false,
    }));
    this.objects.push({
      _class: 'Family',
      handle: `h_${id}`,
      gramps_id: id,
      father_handle: father ? `h_${father}` : null,
      mother_handle: mother ? `h_${mother}` : null,
      type: enumOf('FamilyRelType', type, type === 4 ? `${SENTINEL}_CUSTOM_FAMILY` : ''),
      child_ref_list: children.map((c) => ({
        _class: 'ChildRef',
        ref: c.dangling ? 'h_nowhere' : `h_${c.id}`,
        frel: enumOf('ChildRefType', c.frel ?? 1, (c.frel ?? 1) === 7 ? `${SENTINEL}_CUSTOM_REL` : ''),
        mrel: enumOf('ChildRefType', c.mrel ?? 1, (c.mrel ?? 1) === 7 ? `${SENTINEL}_CUSTOM_REL` : ''),
        private: c.private ?? false,
      })),
      event_ref_list: refs,
      note_list: [],
      attribute_list: [],
      private: priv,
    });
    return this;
  }

  /** extra objects the projection must accept and ignore */
  extras() {
    this.objects.push(
      { _class: 'Note', handle: `h_${SENTINEL}_note`, gramps_id: 'N9001', text: { _class: 'StyledText', string: `${SENTINEL}_NOTE_TEXT` } },
      { _class: 'Citation', handle: `h_${SENTINEL}_cit`, gramps_id: 'C9001', page: `${SENTINEL}_PAGE` },
      { _class: 'Media', handle: `h_${SENTINEL}_media`, gramps_id: 'O9001', path: `${SENTINEL}/photo.jpg`, desc: `${SENTINEL}_MEDIA_DESC` },
    );
    return this;
  }

  list() {
    return this.objects;
  }
}

/** The messy genealogy used by the golden test. Two partner families, a mother-only union, parentless siblings,
 *  every rel value, a private person, address-grade places, approximate and text-only dates. */
export function messyTree() {
  const t = new Tree();
  t.place('P9001', { name: 'Examplestate', type: 2 })
    .place('P9002', { name: 'Riverton', type: 4, parent: 'P9001', lat: '40.0049', long: '-100.0051' })
    .place('P9003', { name: 'Elm Street', type: 7, parent: 'P9002' })
    .place('P9004', { name: 'Hilltop Farm', type: 18, parent: 'P9002' })
    .place('P9005', { name: 'Hidden Hollow', type: 4, parent: 'P9001', private: true })
    .place('P9006', { name: 'Homestead', type: 0, customType: 'Family Homestead', parent: 'P9002' })
    .place('P9007', { name: 'Lakeside', type: 16, parent: 'P9001', lat: `40° 30' 0" N`, long: `100° 15' 36" W` });

  t.person('I9001', { given: 'Ada', surname: 'Example', gender: 0, birth: { when: { year: 1880 }, place: 'P9002' }, death: { when: { year: 1950 }, place: 'P9003' }, extra: [
    { type: 42, when: { year: 1920 }, place: 'P9004' }, // residence at a farm: collapses to Riverton
    { type: 37, when: { year: 1910 } }, // occupation
    { type: 26, when: { year: 1895 }, private: true }, // a private event: dropped
    { type: 3, when: { year: 1899 } }, // MARR_LIC: other
    { type: 21, when: { year: 1900 }, role: 7 }, // witness role: not in the role allowlist
  ] });
  t.person('I9002', { given: 'Ben', surname: 'Example', gender: 1, birth: { when: { year: 1878, modifier: 3 } }, death: { when: { year: 1949, quality: 1 }, place: 'P9005' }, extra: [
    { type: 19, when: { year: 1949 }, place: 'P9005' }, // burial at a private place: place null
  ] });
  t.person('I9003', { given: 'Cleo', surname: 'Example', gender: 0, birth: { when: { year: 1905 }, place: 'P9002' }, death: { when: { year: 1990 }, place: 'P9007' }, extra: [{ type: 31, when: { year: 1923 }, place: 'P9002' }] });
  t.person('I9004', { given: 'Cyrus', surname: 'Example', gender: 1, birth: { when: { year: 1908, modifier: 1 } }, death: { when: { text: 'unknown', modifier: 6, year: 0 } } });
  t.person('I9005', { given: 'Dina', surname: 'Example', gender: 3, birth: { when: { year: 1910, modifier: 4 } }, death: { when: { year: 1999 } } });
  t.person('I9006', { given: 'Edith', surname: 'Sample', gender: 0, birth: { when: { year: 1885 } }, death: { when: { year: 1960 } } });
  t.person('I9007', { given: 'Eli', surname: 'Sample', gender: 1, birth: { when: { year: 1912 } }, death: { when: { year: 1980 } } });
  t.person('I9008', { given: 'Faye', surname: 'Sample', gender: 0, birth: { when: { year: 1915 } }, death: { when: { year: 2001 } } });
  t.person('I9009', { given: 'Gus', surname: 'Example', gender: 1, birth: { when: { year: 1995 }, place: 'P9006' }, extra: [{ type: 42, when: { year: 2015 }, place: 'P9002' }] }); // living: residence dropped
  t.person('I9010', { given: 'Hana', surname: 'Lone', gender: 0, birth: { when: { year: 1930 } }, death: { when: { year: 2005 } } });
  t.person('I9011', { given: 'Ivo', surname: 'Lone', gender: 1, birth: { when: { year: 1932 } } });
  t.person('I9012', { given: 'Jo', surname: 'Pair', gender: 2, birth: { when: { year: 1960 } } });
  t.person('I9013', { given: 'Kit', surname: 'Pair', gender: 2, birth: { when: { year: 1962 } } });
  t.person('I9014', { given: 'Lee', surname: 'Pair', gender: 1, birth: { when: { year: 0 } }, death: { when: { year: 2020 } } });
  t.person('I9015', { given: 'Mal', surname: 'Hidden', gender: 1, birth: { when: { year: 1887 } }, private: true });
  t.person('I9016', { given: 'Nell', surname: 'Sample', gender: 0, birth: { when: { year: 1925 }, place: 'P9002' }, death: { when: { year: 2010 } } });
  t.person('I9017', { given: '', surname: '', gender: 2 }); // no name, no events, no family: a singleton called "unknown"
  t.person('I9018', { given: 'Orin', surname: 'Solo', gender: 1, birth: { when: { year: 1970 } } });

  t.family('F9001', { father: 'I9002', mother: 'I9001', type: 0, events: [{ type: 1, when: { year: 1903 }, place: 'P9002' }], children: [
    { id: 'I9003', frel: 2, mrel: 1 }, // adopted by the father, born to the mother
    { id: 'I9004', frel: 3, mrel: 3 }, // step
    { id: 'I9005', frel: 4, mrel: 5 }, // sponsored, foster
    { id: 'I9015', frel: 1, mrel: 1 }, // the private person drops out
  ] });
  t.family('F9002', { father: 'I9002', mother: 'I9006', type: 1, children: [
    { id: 'I9007', frel: 6, mrel: 0 }, // unknown, none
    { id: 'I9008', frel: 7, mrel: 1 }, // custom, birth
  ] });
  t.family('F9003', { mother: 'I9003', type: 3, children: [{ id: 'I9009', frel: 1, mrel: 1 }] }); // mother-only union
  t.family('F9004', { type: 3, children: [{ id: 'I9010' }, { id: 'I9011' }, { id: 'I9011', frel: 2 }, { dangling: true }] }); // parentless siblings
  t.family('F9005', { father: 'I9013', mother: 'I9012', type: 2 }); // a civil union, no children
  t.family('F9006', { father: 'I9014', mother: 'I9005', type: 4, events: [{ type: 7, when: { year: 1965 } }] }); // a custom family type with a divorce
  t.family('F9007', { father: 'I9015', mother: 'I9006', type: 0, children: [{ id: 'I9016' }] }); // the private partner drops: a mother-only union remains
  t.family('F9008', { father: 'I9015', type: 0, private: true }); // a private family
  t.family('F9009', { father: 'I9018', type: 0 }); // one partner and no children: dropped
  t.extras();
  return t;
}

export function shuffled(list, seed) {
  // deterministic Fisher-Yates over a tiny LCG, so a failing shuffle can be reproduced
  const a = list.slice();
  let s = seed >>> 0 || 1;
  const rnd = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
