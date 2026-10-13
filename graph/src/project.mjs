// The allowlist projection (viz.md section 5.2).
//
// projectRecords() reads ONLY the fields in the section 5.2 table. It never reads notes, addresses, URLs,
// attributes, LDS ordinances, citations, handles-as-output or any free-text description, and it never reads
// a date's day, month, sortval or text. It is safe on unredacted input and again on a redacted snapshot.

import { GraphError } from './errors.mjs';
import {
  enumValue, enumString, GENDER, DATE_MODIFIER, DATE_QUALITY, ROLE_ALLOWLIST, EVENT_ROLE, EVENT_TYPE_NAMES,
  FAMILY_REL_NAMES, CHILD_REL_NAMES, PLACE_TYPE_NAMES, ADDRESS_GRADE_PLACE_TYPES, HOME_LIKE_CUSTOM, ADDRESS_LIKE_NAME, LIVING_EVENT_KEEP,
} from './gramps-enums.mjs';

/** Known Gramps classes this builder never reads. They are accepted and dropped without inspection. */
const IGNORED_CLASSES = new Set(['Note', 'Citation', 'Source', 'Repository', 'Tag']);
const READ_CLASSES = new Set(['Person', 'Family', 'Event', 'Place', 'Media']);
const SCHEMA_VERSION = 21;
const CORE_FIELDS = {
  Person: ['handle', 'gramps_id'],
  Family: ['handle', 'gramps_id'],
  Event: ['handle', 'gramps_id'],
  Place: ['handle', 'gramps_id'],
  Media: ['handle'],
};

/** Collects warning codes with the gramps ids they hit. Local report only; ids, never values. */
export class Warnings {
  constructor() {
    this.map = new Map();
  }
  add(code, id = '') {
    if (!this.map.has(code)) this.map.set(code, new Set());
    if (id) this.map.get(code).add(String(id));
    else this.map.get(code).add('');
  }
  toList() {
    return [...this.map.keys()]
      .sort()
      .map((code) => {
        const ids = [...this.map.get(code)].filter(Boolean).sort();
        return { code, count: ids.length || 1, ids };
      });
  }
}

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function safeName(x) {
  return String(x).replace(/[^A-Za-z0-9_]/g, '').slice(0, 40) || '?';
}

/** Rule L: the ETL's `isLiving`. This function is the only place the rule lives (viz.md section 5.2). */
export function isLiving(person) {
  return person.death_ref_index === -1;
}

/** Validates the shape and indexes the objects by class and handle. Throws SNAPSHOT_SHAPE. */
export function indexObjects(objects) {
  const idx = { Person: new Map(), Family: new Map(), Event: new Map(), Place: new Map(), Media: new Map() };
  const ids = { Person: new Set(), Family: new Set(), Event: new Set(), Place: new Set() };
  for (const o of objects) {
    const cls = o && typeof o === 'object' ? o._class : undefined;
    if (typeof cls !== 'string' || !cls) throw new GraphError('SNAPSHOT_SHAPE', 'an object has no _class');
    if (cls === 'Header') {
      const v = o.schema_version ?? o.schema ?? o.version;
      if (v !== undefined && Number(v) !== SCHEMA_VERSION) {
        throw new GraphError('SNAPSHOT_SHAPE', `the header's schema is not ${SCHEMA_VERSION}`);
      }
      continue;
    }
    if (IGNORED_CLASSES.has(cls)) continue;
    if (!READ_CLASSES.has(cls)) throw new GraphError('SNAPSHOT_SHAPE', `unknown _class ${safeName(cls)}`);
    for (const f of CORE_FIELDS[cls]) {
      if (typeof o[f] !== 'string' || !o[f]) throw new GraphError('SNAPSHOT_SHAPE', `${cls}.${f} is missing`);
    }
    if (cls === 'Person') {
      for (const f of ['birth_ref_index', 'death_ref_index']) {
        if (!Number.isInteger(o[f])) throw new GraphError('SNAPSHOT_SHAPE', `Person.${f} is missing`);
      }
    }
    if (idx[cls].has(o.handle)) throw new GraphError('SNAPSHOT_SHAPE', `${cls} handles are not unique`);
    idx[cls].set(o.handle, o);
    if (ids[cls]) {
      if (ids[cls].has(o.gramps_id)) throw new GraphError('SNAPSHOT_SHAPE', `${cls}.gramps_id values are not unique`);
      ids[cls].add(o.gramps_id);
    }
  }
  return idx;
}

/** A Gramps Date -> { year, approx }. The day, month, sortval and text are never read. */
export function dateYear(date, ctx) {
  if (!date || typeof date !== 'object') return { year: null, approx: false };
  const modifier = enumValue(date.modifier) ?? DATE_MODIFIER.NONE;
  if (modifier === DATE_MODIFIER.TEXTONLY) return { year: null, approx: false };
  const dv = date.dateval;
  const raw = Array.isArray(dv) ? dv[2] : 0;
  if (!Number.isInteger(raw) || raw === 0) return { year: null, approx: false };
  if (raw < 1000 || raw > ctx.maxYear) {
    ctx.warnings.add('YEAR_OUT_OF_RANGE', ctx.owner);
    return { year: null, approx: false };
  }
  const quality = enumValue(date.quality) ?? DATE_QUALITY.REGULAR;
  return { year: raw, approx: modifier !== DATE_MODIFIER.NONE || quality !== DATE_QUALITY.REGULAR };
}

function parseCoord(value, axis) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (!s) return null;
  const hemi = (h) => (h ? h.toUpperCase() : '');
  let m = /^([NSEW])?\s*([+-]?\d+(?:\.\d+)?)\s*°?\s*([NSEW])?$/i.exec(s);
  let n;
  let h;
  if (m) {
    n = Number(m[2]);
    h = hemi(m[1] || m[3]);
  } else {
    m = /^([NSEW])?\s*(\d+)\s*[°:]\s*(\d+)\s*['′:]\s*(\d+(?:\.\d+)?)?\s*["″]?\s*([NSEW])?$/i.exec(s);
    if (!m) return NaN;
    n = Number(m[2]) + Number(m[3]) / 60 + Number(m[4] ?? 0) / 3600;
    h = hemi(m[1] || m[5]);
  }
  const ok = axis === 'lat' ? ['', 'N', 'S'] : ['', 'E', 'W'];
  if (!ok.includes(h)) return NaN;
  if (h === 'S' || h === 'W') n = -Math.abs(n);
  const limit = axis === 'lat' ? 90 : 180;
  return Math.abs(n) <= limit ? n : NaN;
}

const round2 = (n) => {
  const r = Math.round(n * 100) / 100;
  return Object.is(r, -0) ? 0 : r;
};

function cleanText(s) {
  return typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : '';
}

/**
 * @param {object[]} objects  _class-tagged Gramps JSON objects
 * @param {{ maxYear: number, warnings?: Warnings, keepLivingResidence?: boolean }} opts
 * @returns {{ people: object[], unions: object[], places: object[], events: object[], warnings: Warnings }}
 */
export function projectRecords(objects, opts) {
  const warnings = opts.warnings ?? new Warnings();
  const idx = indexObjects(objects);
  const maxYear = opts.maxYear;

  const privateSeen = new Set();
  const noteExcluded = (obj) => {
    const id = obj.gramps_id ?? obj.handle;
    if (!privateSeen.has(id)) {
      privateSeen.add(id);
      warnings.add('PRIVATE_EXCLUDED', obj.gramps_id ?? '');
    }
  };

  // ---- places (rule S) --------------------------------------------------------------------------------
  const isAddressGrade = (pl) => {
    const t = enumValue(pl.place_type);
    if (ADDRESS_GRADE_PLACE_TYPES.has(t)) return true;
    if (t === 0 && HOME_LIKE_CUSTOM.test(enumString(pl.place_type))) return true;
    // A name that reads as a street address is address-grade whatever the type says (City, Locality, Unknown...).
    const nm = pl.name && typeof pl.name === 'object' ? pl.name.value : pl.name;
    return typeof nm === 'string' && ADDRESS_LIKE_NAME.test(nm);
  };
  const parentHandle = (pl) => (Array.isArray(pl.placeref_list) && pl.placeref_list[0] ? pl.placeref_list[0].ref : undefined);

  /** Nearest acceptable ancestor-or-self, starting at `handle`. A private first hop gives null. */
  const acceptablePlace = (handle, ownerId, { first = true } = {}) => {
    let cur = idx.Place.get(handle);
    if (!cur) {
      warnings.add('DANGLING_REF', ownerId);
      return null;
    }
    const seen = new Set();
    let collapsed = false;
    let hop = 0;
    while (cur) {
      if (seen.has(cur.handle)) return null;
      seen.add(cur.handle);
      if (cur.private === true) {
        noteExcluded(cur);
        if (first && hop === 0) return null;
      } else if (isAddressGrade(cur)) {
        collapsed = true;
      } else {
        if (collapsed) warnings.add('ADDRESS_GRADE_PLACE_COLLAPSED', ownerId);
        return cur;
      }
      cur = idx.Place.get(parentHandle(cur));
      hop += 1;
    }
    return null;
  };

  const placeCache = new Map();
  const placeFor = (handle, ownerId) => {
    if (!handle) return null;
    if (!placeCache.has(handle)) placeCache.set(handle, acceptablePlace(handle, ownerId));
    return placeCache.get(handle);
  };

  // ---- events ------------------------------------------------------------------------------------------
  const eventFromRef = (ref, ownerId) => {
    if (!ref) {
      warnings.add('DANGLING_REF', ownerId);
      return null;
    }
    if (ref.private === true) return null;
    const ev = idx.Event.get(ref.ref);
    if (!ev) {
      warnings.add('DANGLING_REF', ownerId);
      return null;
    }
    if (ev.private === true) {
      noteExcluded(ev);
      return null;
    }
    return ev;
  };

  // ---- people ------------------------------------------------------------------------------------------
  const sortedPeople = [...idx.Person.values()].sort((a, b) => cmp(a.gramps_id, b.gramps_id));
  const personByHandle = new Map(); // handle -> output person (kept only)
  const used = new Set(); // place handles an output record points at
  const people = [];
  const faceJobs = []; // [{ id, media handle, rect }] for faces.mjs; read by the CLI, never written to the graph

  for (const p of sortedPeople) {
    if (p.private === true) {
      noteExcluded(p);
      continue;
    }
    const id = p.gramps_id;
    const ctx = { maxYear, warnings, owner: id };
    const living = isLiving(p);

    const pn = p.primary_name && typeof p.primary_name === 'object' ? p.primary_name : {};
    const surnames = Array.isArray(pn.surname_list) ? pn.surname_list : [];
    const primarySurname = surnames.find((s) => s && s.primary === true) ?? surnames[0];
    const given = cleanText(pn.first_name);
    const surname = cleanText(primarySurname && primarySurname.surname);
    const name = [given, surname].filter(Boolean).join(' ') || 'unknown';

    const g = enumValue(p.gender);
    const sex = g === GENDER.FEMALE ? 'f' : g === GENDER.MALE ? 'm' : 'u';

    const refs = Array.isArray(p.event_ref_list) ? p.event_ref_list : [];
    const evAt = (i) => (i === -1 ? null : eventFromRef(refs[i], id));
    const birthEv = evAt(p.birth_ref_index);
    const deathEv = living ? null : evAt(p.death_ref_index);
    const b = birthEv ? dateYear(birthEv.date, ctx) : { year: null, approx: false };
    const d = deathEv ? dateYear(deathEv.date, ctx) : { year: null, approx: false };
    const birthPlace = birthEv ? placeFor(birthEv.place, id) : null;
    const deathPlace = deathEv ? placeFor(deathEv.place, id) : null;
    if (birthPlace) used.add(birthPlace.handle);
    if (deathPlace) used.add(deathPlace.handle);

    const out = {
      id,
      name,
      given,
      surname,
      sex,
      living,
      birthYear: b.year,
      deathYear: d.year,
      yearApprox: (b.year !== null && b.approx) || (d.year !== null && d.approx),
      birthPlace: birthPlace ? birthPlace.gramps_id : null,
      deathPlace: deathPlace ? deathPlace.gramps_id : null,
      generation: null, // filled by the generation index (viz-generation-index)
      component: 0, // set by build.mjs
      face: null, // set by applyFaces (build.mjs) from the face crops (faces.mjs)
    };
    people.push(out);
    personByHandle.set(p.handle, { out, src: p });
    // the face crop source: Person.media_list[0], Gramps' person image, unless it or its Media is private
    const mref = Array.isArray(p.media_list) ? p.media_list[0] : null;
    if (mref && typeof mref.ref === 'string' && mref.private !== true) {
      const media = idx.Media.get(mref.ref);
      if (media && media.private === true) noteExcluded(media);
      else faceJobs.push({ id, media: mref.ref, rect: mref.rect ?? null });
    }
  }

  // ---- unions ------------------------------------------------------------------------------------------
  const unions = [];
  const familyEventRefs = []; // [{ person handle, ref, family id }]
  const sortedFamilies = [...idx.Family.values()].sort((a, b) => cmp(a.gramps_id, b.gramps_id));
  for (const f of sortedFamilies) {
    if (f.private === true) {
      noteExcluded(f);
      continue;
    }
    const fid = f.gramps_id;
    const parentOf = (handle) => {
      if (!handle) return null;
      const p = personByHandle.get(handle);
      if (!p) {
        if (!idx.Person.has(handle)) warnings.add('DANGLING_REF', fid);
        return null;
      }
      return p;
    };
    const father = parentOf(f.father_handle);
    const mother = parentOf(f.mother_handle);
    if (father && mother && father.out.id === mother.out.id) warnings.add('SELF_UNION_REF_DROPPED', fid);
    const partnerSet = new Map();
    if (father) partnerSet.set(father.out.id, { who: father, key: 'frel' });
    if (mother && !partnerSet.has(mother.out.id)) partnerSet.set(mother.out.id, { who: mother, key: 'mrel' });
    const partners = [...partnerSet.keys()].sort(cmp);

    const children = [];
    const seenChild = new Set();
    for (const cr of Array.isArray(f.child_ref_list) ? f.child_ref_list : []) {
      if (!cr || cr.private === true) continue;
      const child = personByHandle.get(cr.ref);
      if (!child) {
        if (!idx.Person.has(cr.ref)) warnings.add('DANGLING_REF', fid);
        continue;
      }
      if (seenChild.has(child.out.id)) continue;
      if (partnerSet.has(child.out.id)) {
        warnings.add('SELF_UNION_REF_DROPPED', fid); // a person cannot be their own parent or partner
        continue;
      }
      seenChild.add(child.out.id);
      const rel = {};
      for (const pid of partners) {
        const { key } = partnerSet.get(pid);
        const v = enumValue(cr[key]);
        rel[pid] = CHILD_REL_NAMES.get(v) ?? 'unknown';
      }
      children.push({ id: child.out.id, rel });
    }
    children.sort((a, b) => cmp(a.id, b.id));

    const keep = partners.length === 2 || (children.length >= 1 && (partners.length >= 1 || children.length >= 2));
    if (!keep) continue;
    unions.push({
      id: fid,
      type: FAMILY_REL_NAMES.get(enumValue(f.type)) ?? 'unknown',
      partners,
      children,
    });
    for (const pid of partners) {
      const who = partnerSet.get(pid).who;
      for (const ref of Array.isArray(f.event_ref_list) ? f.event_ref_list : []) {
        familyEventRefs.push({ person: who, ref, family: fid });
      }
    }
  }

  // ---- events (for the v2 layers) -----------------------------------------------------------------------
  const events = [];
  const eventSeen = new Set();
  const pushEvent = (person, ev, ref) => {
    if (!ref || !ROLE_ALLOWLIST.has(enumValue(ref.role) ?? EVENT_ROLE.UNKNOWN)) return;
    const key = `${person.out.id}\u0000${ev.handle}`;
    if (eventSeen.has(key)) return;
    eventSeen.add(key);
    const type = EVENT_TYPE_NAMES.get(enumValue(ev.type)) ?? 'other';
    if (person.out.living) {
      // A death or burial contradicts the living flag (rule L): drop it and say so.
      if (type === 'death' || type === 'burial') {
        warnings.add('LIVING_DEATH_EVENT_DROPPED', person.out.id);
        return;
      }
      // VIZ-D5: a living person keeps only birth, marriage, divorce, education, graduation and degree events. Residence
      // (42), custom ("Home"), Medical Information, Cause of Death, cremation and the rest never carry a year or place.
      if (type === 'residence' && opts.keepLivingResidence) {
        // kept on request
      } else if (!LIVING_EVENT_KEEP.has(type)) {
        if (type !== 'residence') warnings.add('LIVING_EVENT_DROPPED', person.out.id);
        return;
      }
    }
    const ctx = { maxYear, warnings, owner: person.out.id };
    const { year } = dateYear(ev.date, ctx);
    const place = placeFor(ev.place, person.out.id);
    if (place) used.add(place.handle);
    events.push({ person: person.out.id, type, year, place: place ? place.gramps_id : null });
  };
  for (const { out, src } of personByHandle.values()) {
    for (const ref of Array.isArray(src.event_ref_list) ? src.event_ref_list : []) {
      if (!ref || ref.private === true) continue;
      const ev = idx.Event.get(ref.ref);
      if (!ev) continue; // already reported for the birth and death slots; others are dropped silently
      if (ev.private === true) {
        noteExcluded(ev);
        continue;
      }
      pushEvent({ out }, ev, ref);
    }
  }
  for (const { person, ref } of familyEventRefs) {
    if (!ref || ref.private === true) continue;
    const ev = idx.Event.get(ref.ref);
    if (!ev) continue;
    if (ev.private === true) {
      noteExcluded(ev);
      continue;
    }
    pushEvent(person, ev, ref);
  }
  events.sort((a, b) => cmp(a.person, b.person) || (a.year ?? 9999) - (b.year ?? 9999) || cmp(a.type, b.type) || cmp(a.place ?? '', b.place ?? ''));

  // ---- places: referenced ones plus their acceptable ancestors ------------------------------------------
  const outPlaces = new Map(); // handle -> output
  const building = new Set(); // guards a cycle in the place hierarchy
  const place = (handle) => {
    if (outPlaces.has(handle)) return outPlaces.get(handle);
    building.add(handle);
    const pl = idx.Place.get(handle);
    const owner = pl.gramps_id;
    const type = enumValue(pl.place_type);
    const lat = parseCoord(pl.lat, 'lat');
    const lon = parseCoord(pl.long, 'lon');
    let latOut = null;
    let lonOut = null;
    if (lat !== null || lon !== null) {
      if (lat === null || lon === null || Number.isNaN(lat) || Number.isNaN(lon)) {
        warnings.add('COORD_UNPARSEABLE', owner);
      } else {
        latOut = round2(lat);
        lonOut = round2(lon);
      }
    }
    const pName = pl.name && typeof pl.name === 'object' ? cleanText(pl.name.value) : cleanText(pl.name);
    const o = {
      id: owner,
      name: pName || 'unknown',
      type: PLACE_TYPE_NAMES.get(type) ?? 'custom',
      parent: null,
      lat: latOut,
      lon: lonOut,
      geo: latOut === null ? null : 'gramps',
    };
    outPlaces.set(handle, o);
    const up = idx.Place.get(parentHandle(pl));
    if (up) {
      const anc = acceptablePlace(up.handle, owner, { first: false });
      if (anc && anc.handle !== handle && !building.has(anc.handle)) {
        o.parent = place(anc.handle).id;
      }
    }
    building.delete(handle);
    return o;
  };
  for (const h of [...used]) place(h);
  const places = [...outPlaces.values()].sort((a, b) => cmp(a.id, b.id));

  unions.sort((a, b) => cmp(a.id, b.id));
  return { people, unions, places, events, warnings, faceJobs };
}
