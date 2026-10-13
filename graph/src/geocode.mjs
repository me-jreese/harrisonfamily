// Offline geocoding (viz.md 5.6 as amended by viz-adr.md section 7, VIZ-D6; task viz-geocode-offline). Pure: it reads the
// parsed gazetteer (gazetteer.mjs) and the projected places, and never touches a file or the network. Place names only.
//
// Precedence for each place: Gramps lat/long (already set by the projection, geo "gramps"), then io's reviewed coordinates
// (places.geo.json, geo "geonames": they are GeoNames-derived), then the GeoNames match, then null. Country, state and
// province places take a Natural Earth centroid (geo "naturalearth") because admin1CodesASCII has no coordinates.
//
// The matcher takes the country first, accepts each ancestor as either an admin1 or an admin2 of that country, then matches
// the place against cities1000 class-P rows by name, asciiname or alternate names (accent- and case-folded). The most
// populous candidate wins unless the runner-up is within 2x (AMBIGUOUS_PLACE). Coordinates are rounded to 2 decimals.

/** The credit every surface that shows a coordinate prints when graph.attribution.geonames is true. */
export const GEONAMES_CREDIT = Object.freeze({
  text: 'Place coordinates: GeoNames (geonames.org), CC BY 4.0, modified',
  licence: 'https://creativecommons.org/licenses/by/4.0/',
});

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const round2 = (n) => {
  const r = Math.round(n * 100) / 100;
  return Object.is(r, -0) ? 0 : r;
};
const SPECIAL = { ß: 'ss', æ: 'ae', ø: 'o', œ: 'oe', đ: 'd', ð: 'd', ł: 'l', þ: 'th', ı: 'i', ŀ: 'l' };

/** Accent- and case-folded, punctuation as spaces: "Sankt-Exämpel " -> "sankt exampel". */
export function fold(s) {
  const str = String(s ?? '');
  // ASCII fast path (most gazetteer names): the same result without the Unicode normalization
  if (/^[\x00-\x7f]*$/.test(str)) return str.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return str
    .toLowerCase()
    .replace(/[ßæøœđðłþıŀ]/g, (c) => SPECIAL[c])
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

// Words that name the kind of unit, ignored in a second, looser admin comparison ("Example County" ~ "Example").
const ADMIN_WORDS = /\b(?:county|parish|province|provincia|region|department|departement|state|district|shire|oblast|canton|municipality)\b/g;
const loose = (f) => f.replace(ADMIN_WORDS, ' ').replace(/\s+/g, ' ').trim();

const COUNTRY_TYPES = new Set(['country']);
const ADMIN1_TYPES = new Set(['state', 'province']); // a centroid is expected; unresolved is reported
const AREA_TYPES = new Set(['state', 'province', 'region', 'department', 'county', 'district']);
const COUNTRY_ALIASES = {
  usa: 'US', 'u s a': 'US', us: 'US', 'u s': 'US', 'united states of america': 'US', america: 'US',
  uk: 'GB', 'u k': 'GB', 'great britain': 'GB', britain: 'GB',
};

function indexAdmins(rows) {
  const byCountry = new Map();
  for (const r of rows) {
    const cc = r.code.split('.')[0];
    if (!byCountry.has(cc)) byCountry.set(cc, []);
    const names = [...new Set([fold(r.name), fold(r.ascii)].filter(Boolean))];
    byCountry.get(cc).push({ code: r.code, names, loose: [...new Set(names.map(loose))] });
  }
  return byCountry;
}

function validOverrides(o) {
  if (o == null) return { countries: {}, places: [] };
  const countries = o.countries && typeof o.countries === 'object' ? o.countries : {};
  const places = Array.isArray(o.places) ? o.places.filter((p) => p && typeof p.name === 'string') : [];
  return { countries, places };
}

/** The cities1000 class-P rows whose name, asciiname or an alternate name folds to one of `wanted`. */
function indexCities(text, wanted) {
  const byName = new Map();
  const byId = new Map();
  if (!wanted.size) return { byName, byId };
  // A name in another script (Cyrillic, Han, ...) folds to that script, so it can only match a wanted name that has one too.
  const LATIN = /^[\u0000-\u024f\u0300-\u036f\u1e00-\u1eff\u2000-\u206f]*$/;
  const anyNonLatin = [...wanted].some((w) => !LATIN.test(w));
  const keep = (n) => anyNonLatin || LATIN.test(n);
  let start = 0;
  while (start < text.length) {
    let end = text.indexOf('\n', start);
    if (end === -1) end = text.length;
    const line = text.slice(start, end);
    start = end + 1;
    const r = line.split('\t');
    if (r.length < 15 || r[6] !== 'P') continue;
    const names = new Set([r[1], r[2], ...(r[3] ? r[3].split(',') : [])].filter(keep).map(fold));
    let row = null;
    for (const n of names) {
      if (!wanted.has(n)) continue;
      row ??= {
        geonameId: Number(r[0]), lat: Number(r[4]), lon: Number(r[5]), cc: r[8], admin1: r[10], admin2: r[11],
        population: Number(r[14]) || 0,
      };
      if (!byName.has(n)) byName.set(n, []);
      byName.get(n).push(row);
    }
    if (row) byId.set(row.geonameId, row);
  }
  return { byName, byId };
}

/**
 * @param {object[]} places  projected places ({id, name, type, parent, lat, lon, geo}); not modified
 * @param {object|null} gaz  parseGazetteer() output, or null when the cache is missing
 * @param {{ warnings: { add(code: string, id?: string): void }, used?: Set<string> }} ctx
 *   used: the place ids an event or a person's birth or death place refers to
 * @returns {{ places: object[], entries: object[], geonames: boolean }} entries are the local report rows
 */
export function geocodePlaces(places, gaz, { warnings, used = new Set() }) {
  const out = places.map((p) => ({ ...p }));
  const entries = [];
  if (!gaz) {
    warnings.add('GAZETTEER_MISSING');
    for (const p of out) if (p.geo === 'gramps') entries.push({ place: p.id, status: 'gramps', lat: p.lat, lon: p.lon });
    return { places: out, entries, geonames: false };
  }
  const byId = new Map(out.map((p) => [p.id, p]));
  const hasChild = new Set(out.map((p) => p.parent).filter(Boolean));
  const ov = validOverrides(gaz.overrides);
  const overrideFor = (name, cc) => {
    const f = fold(name);
    return ov.places.find((o) => fold(o.name) === f && (!o.country || !cc || o.country === cc)) || null;
  };
  const countryOf = new Map();
  for (const c of gaz.countries) for (const k of [c.name, c.iso, c.iso3]) if (k) countryOf.set(fold(k), c.iso);
  for (const [k, v] of Object.entries(COUNTRY_ALIASES)) if (!countryOf.has(k)) countryOf.set(k, v);
  for (const [k, v] of Object.entries(ov.countries)) countryOf.set(fold(k), String(v));
  const admin1 = indexAdmins(gaz.admin1);
  const admin2 = indexAdmins(gaz.admin2);

  /** An ancestor (or an area place itself) as an admin unit of cc: {level: 1|2, code} or null. */
  const matchAdmin = (name, cc, a1) => {
    const o = overrideFor(name, cc);
    if (o && typeof o.admin === 'string') return { level: o.admin.split('.').length === 2 ? 1 : 2, code: o.admin };
    if (!cc) return null;
    const f = fold(name);
    const find = (rows, key, value, within) => {
      const hits = (rows.get(cc) || []).filter((r) => r[key].includes(value) && (!within || r.code.startsWith(within + '.')));
      return hits.length === 1 ? hits[0].code : null; // the same name twice in one country constrains nothing
    };
    const tryLevel = (level, key, value) => (level === 1 ? find(admin1, key, value) : find(admin2, key, value, a1));
    const levels = a1 ? [2, 1] : [1, 2];
    for (const [key, value] of [['names', f], ['loose', loose(f)]]) {
      for (const level of levels) {
        const code = value ? tryLevel(level, key, value) : null;
        if (code) return { level, code };
      }
    }
    return null;
  };

  /** Walks the parent chain: the country, then each ancestor as admin1 or admin2, from the country down. */
  const context = (p) => {
    const chain = [];
    const seen = new Set([p.id]);
    for (let a = byId.get(p.parent); a && !seen.has(a.id); a = byId.get(a.parent)) {
      seen.add(a.id);
      chain.push(a);
    }
    // the nearest ancestor typed country, else the root of the chain, if its name or code is a country
    let countryAt = chain.findIndex((a) => COUNTRY_TYPES.has(a.type) && countryOf.has(fold(a.name)));
    if (countryAt === -1 && chain.length && countryOf.has(fold(chain[chain.length - 1].name))) countryAt = chain.length - 1;
    const cc = countryAt === -1 ? null : countryOf.get(fold(chain[countryAt].name));
    let a1 = null;
    let a2 = null;
    const below = countryAt === -1 ? chain : chain.slice(0, countryAt);
    for (const a of [...below].reverse()) {
      const m = matchAdmin(a.name, cc, a1);
      if (!m) continue;
      if (m.level === 1) a1 = m.code;
      else {
        a2 = m.code;
        a1 = m.code.split('.').slice(0, 2).join('.');
      }
    }
    return { cc, a1, a2 };
  };

  const wanted = new Set();
  const settlements = out.filter((p) => p.geo === null && !AREA_TYPES.has(p.type) && !COUNTRY_TYPES.has(p.type) && (used.has(p.id) || !hasChild.has(p.id)));
  for (const p of settlements) {
    const o = overrideFor(p.name, null);
    wanted.add(fold(o && typeof o.search === 'string' ? o.search : p.name));
  }
  const cities = indexCities(gaz.cities, wanted);
  const reviewed = gaz.reviewed && gaz.reviewed.places && typeof gaz.reviewed.places === 'object' ? gaz.reviewed.places : {};

  for (const p of [...out].sort((a, b) => cmp(a.id, b.id))) {
    if (p.geo === 'gramps') {
      entries.push({ place: p.id, status: 'gramps', lat: p.lat, lon: p.lon });
      continue;
    }
    const r = reviewed[p.id];
    if (r && Number.isFinite(r.lat) && Number.isFinite(r.lon) && Math.abs(r.lat) <= 90 && Math.abs(r.lon) <= 180) {
      Object.assign(p, { lat: round2(r.lat), lon: round2(r.lon), geo: 'geonames' });
      entries.push({ place: p.id, status: 'reviewed', lat: p.lat, lon: p.lon });
      continue;
    }
    const { cc, a1, a2 } = context(p);
    if (COUNTRY_TYPES.has(p.type)) {
      const iso = countryOf.get(fold(p.name));
      const c = iso && gaz.ne0.get(iso);
      if (c) {
        Object.assign(p, { lat: round2(c.lat), lon: round2(c.lon), geo: 'naturalearth' });
        entries.push({ place: p.id, status: 'centroid', lat: p.lat, lon: p.lon });
      } else {
        warnings.add('UNRESOLVED_PLACE', p.id);
        entries.push({ place: p.id, status: 'unresolved' });
      }
      continue;
    }
    if (AREA_TYPES.has(p.type)) {
      const m = matchAdmin(p.name, cc, a1);
      const c = m && m.level === 1 ? gaz.ne1.get(m.code) : null;
      if (c) {
        Object.assign(p, { lat: round2(c.lat), lon: round2(c.lon), geo: 'naturalearth' });
        entries.push({ place: p.id, status: 'centroid', lat: p.lat, lon: p.lon });
      } else if (ADMIN1_TYPES.has(p.type) && !(m && m.level === 2)) {
        warnings.add('UNRESOLVED_PLACE', p.id);
        entries.push({ place: p.id, status: 'unresolved' });
      } else {
        entries.push({ place: p.id, status: 'area' }); // no admin2 centroid source; a map fits to the child points
      }
      continue;
    }
    if (!settlements.includes(p)) continue; // an unused place with children: its children carry the points
    const o = overrideFor(p.name, cc);
    let candidates;
    if (o && Number.isInteger(o.geonameId)) {
      const row = cities.byId.get(o.geonameId);
      candidates = row ? [row] : [];
    } else {
      const name = fold(o && typeof o.search === 'string' ? o.search : p.name);
      candidates = (cities.byName.get(name) || []).filter((c) => (!cc || c.cc === cc) && (!a1 || !c.admin1 || `${c.cc}.${c.admin1}` === a1) &&
        (!a2 || !c.admin2 || `${c.cc}.${c.admin1}.${c.admin2}` === a2));
      candidates = [...new Map(candidates.map((c) => [c.geonameId, c])).values()];
    }
    candidates.sort((a, b) => b.population - a.population || a.geonameId - b.geonameId);
    const [top, next] = candidates;
    const brief = (c) => (c ? { geonameId: c.geonameId, population: c.population } : null);
    if (!top) {
      warnings.add('UNRESOLVED_PLACE', p.id);
      entries.push({ place: p.id, status: 'unresolved' });
    } else if (next && top.population <= 2 * next.population) {
      warnings.add('AMBIGUOUS_PLACE', p.id);
      entries.push({ place: p.id, status: 'ambiguous', candidates: [brief(top), brief(next)] });
    } else {
      Object.assign(p, { lat: round2(top.lat), lon: round2(top.lon), geo: 'geonames' });
      entries.push({ place: p.id, status: 'geonames', lat: p.lat, lon: p.lon, ...brief(top), runnerUp: brief(next) });
    }
  }
  entries.sort((a, b) => cmp(a.place, b.place));
  return { places: out, entries, geonames: out.some((p) => p.geo === 'geonames') };
}
