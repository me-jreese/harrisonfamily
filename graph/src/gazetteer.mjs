// The offline gazetteer (viz.md 5.6.2 as amended by viz-adr.md section 7; task viz-geocode-offline).
//
// bin/fetch-gazetteer.mjs is the only network path: it downloads the public dumps below into $HFY_GAZETTEER_DIR (outside the
// repository) and pins each one's sha256 and retrieval date in graph/gazetteer.lock.json. A build only reads that cache: a file
// that does not match its pin stops the build with GAZETTEER_CHECKSUM (exit 8), and a missing cache degrades to Gramps
// coordinates only (GAZETTEER_MISSING). The dumps are never committed or shipped, and the GeoNames web service is never called.
//
// Two optional local files sit with the cache, never in Git: overrides.json (the override table, place names only) and
// places.geo.json (coordinates io reviewed). See graph/README.md for their shape.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { readDbf, readZip } from './archive.mjs';
import { GraphError } from './errors.mjs';

const GEONAMES = 'https://download.geonames.org/export/dump/';
const NATURAL_EARTH = 'https://naciscdn.org/naturalearth/10m/cultural/';

/** The public files the gazetteer is built from. Each is pinned in graph/gazetteer.lock.json. */
export const GAZETTEER_FILES = Object.freeze([
  { name: 'cities1000.zip', url: `${GEONAMES}cities1000.zip`, licence: 'CC BY 4.0' },
  { name: 'admin1CodesASCII.txt', url: `${GEONAMES}admin1CodesASCII.txt`, licence: 'CC BY 4.0' },
  { name: 'admin2Codes.txt', url: `${GEONAMES}admin2Codes.txt`, licence: 'CC BY 4.0' },
  { name: 'countryInfo.txt', url: `${GEONAMES}countryInfo.txt`, licence: 'CC BY 4.0' },
  { name: 'ne_10m_admin_0_countries.zip', url: `${NATURAL_EARTH}ne_10m_admin_0_countries.zip`, licence: 'public domain (Natural Earth)' },
  { name: 'ne_10m_admin_1_states_provinces.zip', url: `${NATURAL_EARTH}ne_10m_admin_1_states_provinces.zip`, licence: 'public domain (Natural Earth)' },
].map((f) => Object.freeze(f)));

export const LOCK_URL = new URL('../gazetteer.lock.json', import.meta.url);

/** $HFY_GAZETTEER_DIR, else ~/Library/Caches/hfy-gazetteer (outside the repository and Dropbox). */
export function defaultGazetteerDir(env = process.env) {
  return env.HFY_GAZETTEER_DIR ? resolve(env.HFY_GAZETTEER_DIR) : join(homedir(), 'Library', 'Caches', 'hfy-gazetteer');
}

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

export function readLock(path = LOCK_URL) {
  try {
    const lock = JSON.parse(readFileSync(path, 'utf8'));
    if (lock && typeof lock === 'object' && lock.files && typeof lock.files === 'object') return lock;
  } catch {
    // fall through
  }
  throw new GraphError('GAZETTEER_CHECKSUM', 'graph/gazetteer.lock.json is missing or unreadable');
}

function readOptionalJson(path, what) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new GraphError('INPUT_MISSING', `${what} next to the gazetteer is not valid JSON`);
  }
}

/**
 * The cached gazetteer, parsed: null when the directory or any pinned file is missing (the caller reports GAZETTEER_MISSING),
 * and GAZETTEER_CHECKSUM when a cached file differs from its pin.
 * @param {string|null} dir
 * @param {{ lockPath?: string|URL }} [opts]
 */
export function loadGazetteer(dir, opts = {}) {
  if (!dir || !existsSync(dir)) return null;
  const lock = readLock(opts.lockPath ?? LOCK_URL);
  const files = {};
  for (const f of GAZETTEER_FILES) {
    const path = join(dir, f.name);
    if (!existsSync(path)) return null;
    const buf = readFileSync(path);
    const pin = lock.files[f.name] && lock.files[f.name].sha256;
    if (!pin || sha256(buf) !== pin) {
      throw new GraphError('GAZETTEER_CHECKSUM', `${f.name} does not match its pin in graph/gazetteer.lock.json; re-run fetch-gazetteer --update after review`);
    }
    files[f.name] = buf;
  }
  return parseGazetteer(files, {
    overrides: readOptionalJson(join(dir, 'overrides.json'), 'overrides.json'),
    reviewed: readOptionalJson(join(dir, 'places.geo.json'), 'places.geo.json'),
  });
}

const tsv = (text) => text.split('\n').filter((l) => l && !l.startsWith('#')).map((l) => l.replace(/\r$/, '').split('\t'));
const num = (s) => (s === '' || s === undefined ? NaN : Number(s));
const only = (zip, ext, label) => {
  const hit = [...zip.entries()].find(([n]) => n.toLowerCase().endsWith(ext));
  if (!hit) throw new GraphError('GAZETTEER_CHECKSUM', `${label} holds no ${ext} file`);
  return hit[1];
};

/**
 * Pure: the raw file contents (by GAZETTEER_FILES name) to the structures geocode.mjs reads. The cities stay as text and are
 * indexed later for the names a build needs, so the 25 MB dump is never fully indexed.
 */
export function parseGazetteer(files, { overrides = null, reviewed = null } = {}) {
  const countries = tsv(files['countryInfo.txt'].toString('utf8')).map((r) => ({ iso: r[0], iso3: r[1], name: r[4] }));
  const admin = (name) => tsv(files[name].toString('utf8')).map((r) => ({ code: r[0], name: r[1], ascii: r[2] }));
  const label = (row, ...keys) => {
    for (const k of keys) if (row[k] !== undefined && row[k] !== '' && row[k] !== '-99') return row[k];
    return '';
  };
  const ne0 = new Map();
  for (const row of readDbf(only(readZip(files['ne_10m_admin_0_countries.zip'], 'ne_10m_admin_0_countries.zip'), '.dbf', 'admin-0'), 'admin-0')) {
    const iso = label(row, 'iso_a2_eh', 'iso_a2');
    const lat = num(row.label_y);
    const lon = num(row.label_x);
    if (iso && Number.isFinite(lat) && Number.isFinite(lon) && !ne0.has(iso)) ne0.set(iso, { lat, lon });
  }
  const ne1 = new Map();
  for (const row of readDbf(only(readZip(files['ne_10m_admin_1_states_provinces.zip'], 'ne_10m_admin_1_states_provinces.zip'), '.dbf', 'admin-1'), 'admin-1')) {
    const code = row.gn_a1_code;
    const lat = num(row.latitude);
    const lon = num(row.longitude);
    if (code && Number.isFinite(lat) && Number.isFinite(lon) && !ne1.has(code)) ne1.set(code, { lat, lon });
  }
  const zip = readZip(files['cities1000.zip'], 'cities1000.zip');
  const cities = only(zip, '.txt', 'cities1000.zip').toString('utf8');
  return {
    countries,
    admin1: admin('admin1CodesASCII.txt'),
    admin2: admin('admin2Codes.txt'),
    cities,
    ne0,
    ne1,
    overrides,
    reviewed,
  };
}
