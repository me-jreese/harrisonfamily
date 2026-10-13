// A synthetic gazetteer for the geocoding tests: the six pinned files in their real formats (GeoNames TSV, ZIP archives, a
// Natural Earth dBASE table), written into a scratch directory with a matching lock file. Every name is invented and the
// countries use the user-assigned ISO codes XE and XS, so nothing here is a real place.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as zlib from 'node:zlib';
import { sha256 } from '../../src/gazetteer.mjs';

/** A ZIP archive of [name, Buffer] entries, deflated or stored. */
export function zip(entries, { deflate = true } = {}) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const nameBuf = Buffer.from(name);
    const body = deflate ? zlib.deflateRawSync(data) : data;
    const method = deflate ? 8 : 0;
    const crc = typeof zlib.crc32 === 'function' ? zlib.crc32(data) : 0;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    locals.push(lh, nameBuf, body);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, nameBuf);
    offset += 30 + nameBuf.length + body.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

/** A dBASE III table of character fields: fields [[name, length]], rows of {name: value}. Short values are NUL-padded like Natural Earth's. */
export function dbf(fields, rows) {
  const headerLen = 32 + fields.length * 32 + 1;
  const recordLen = 1 + fields.reduce((n, [, len]) => n + len, 0);
  const buf = Buffer.alloc(headerLen + rows.length * recordLen + 1, 0x20);
  buf.fill(0, 0, headerLen);
  buf[0] = 0x03;
  buf.writeUInt32LE(rows.length, 4);
  buf.writeUInt16LE(headerLen, 8);
  buf.writeUInt16LE(recordLen, 10);
  fields.forEach(([name, len], i) => {
    const p = 32 + i * 32;
    buf.write(name, p, 'latin1');
    buf[p + 11] = 0x43; // C
    buf[p + 16] = len;
  });
  buf[headerLen - 1] = 0x0d;
  rows.forEach((row, r) => {
    let p = headerLen + r * recordLen + 1;
    for (const [name, len] of fields) {
      const v = Buffer.from(String(row[name] ?? ''), 'utf8');
      buf.fill(0, p, p + len);
      v.copy(buf, p, 0, Math.min(len, v.length));
      p += len;
    }
  });
  buf[buf.length - 1] = 0x1a;
  return buf;
}

// geonameid name asciiname alternatenames lat lon class code cc cc2 admin1 admin2 admin3 admin4 population elevation dem tz date
const city = (id, name, ascii, alt, lat, lon, cc, a1, a2, pop, cls = 'P') =>
  [id, name, ascii, alt, lat, lon, cls, 'PPL', cc, '', a1, a2, '', '', pop, '', '0', 'Etc/UTC', '2026-01-01'].join('\t');

export const CITIES = [
  city(1001, 'Exampleton', 'Exampleton', '', '10.1234', '20.4567', 'XE', '01', '001', 50000),
  city(1002, 'Exampleton', 'Exampleton', '', '11.5', '21.5', 'XE', '02', '010', 40000),
  city(1003, 'Portexample', 'Portexample', 'Old Example Port,Altexample', '12.004', '-22.996', 'XE', '01', '', 9000),
  city(1004, 'Sankt Exaempel', 'Sankt Exaempel', '', '13.3333', '23.3333', 'XE', '02', '', 3000),
  city(1005, 'Ézampleville', 'Ezampleville', '', '-5.5555', '30.1111', 'XS', '01', '', 2000),
  city(1006, 'Samplevale', 'Samplevale', '', '-6', '31', 'XS', '01', '', 1200),
  city(1007, 'Samplevale', 'Samplevale', '', '-6.5', '31.5', 'XS', '01', '', 100000),
  city(1008, 'Exampleton', 'Exampleton', '', '9', '19', 'XE', '01', '001', 900000, 'A'), // not a populated place
  city(1009, 'Twin Example', 'Twin Example', '', '14', '24', 'XE', '01', '', 5000),
  city(1010, 'Twin Example', 'Twin Example', '', '14.5', '24.5', 'XE', '01', '', 5000),
  city(1011, 'Примерград', 'Primergrad', 'Пример', '55', '37', 'XS', '01', '', 1500),
];

/** Writes the six gazetteer files (plus any local override and reviewed files) into dir; returns the lock object. */
export function writeGazetteer(dir, { overrides = null, reviewed = null, cities = CITIES, deflate = true } = {}) {
  const files = {
    'cities1000.zip': zip([['cities1000.txt', Buffer.from(cities.join('\n') + '\n')]], { deflate }),
    'admin1CodesASCII.txt': Buffer.from(['XE.01\tNorthshire\tNorthshire\t2001', 'XE.02\tSouthmark\tSouthmark\t2002', 'XS.01\tSamplelakes\tSamplelakes\t2003'].join('\n') + '\n'),
    'admin2Codes.txt': Buffer.from(['XE.01.001\tUpper Example\tUpper Example\t3001', 'XE.02.010\tRiverexample District\tRiverexample District\t3002'].join('\n') + '\n'),
    'countryInfo.txt': Buffer.from(['#ISO\tISO3\tISO-Numeric\tfips\tCountry', 'XE\tXEX\t990\tXE\tExamplestan\tCapital', 'XS\tXSX\t991\tXS\tSampleland\tCapital'].join('\n') + '\n'),
    'ne_10m_admin_0_countries.zip': zip([
      ['ne_10m_admin_0_countries.dbf', dbf([['ISO_A2', 4], ['ISO_A2_EH', 4], ['LABEL_X', 12], ['LABEL_Y', 12]], [
        { ISO_A2: '-99', ISO_A2_EH: 'XE', LABEL_X: '25.0123', LABEL_Y: '15.0123' },
        { ISO_A2: 'XS', ISO_A2_EH: 'XS', LABEL_X: '30.4', LABEL_Y: '-5.6' },
      ])],
      ['ne_10m_admin_0_countries.cpg', Buffer.from('UTF-8')],
    ], { deflate }),
    'ne_10m_admin_1_states_provinces.zip': zip([
      ['ne_10m_admin_1_states_provinces.dbf', dbf([['gn_a1_code', 10], ['latitude', 12], ['longitude', 12], ['name', 20]], [
        { gn_a1_code: 'XE.01', latitude: '12.3456', longitude: '22.2222', name: 'Northshire' },
        { gn_a1_code: 'XE.02', latitude: '11.1111', longitude: '21.1111', name: 'Southmark' },
        { gn_a1_code: 'XS.01', latitude: '-5.9999', longitude: '30.9999', name: 'Samplelakes' },
      ])],
    ], { deflate }),
  };
  const lock = { version: 1, files: {} };
  for (const [name, buf] of Object.entries(files)) {
    writeFileSync(join(dir, name), buf);
    lock.files[name] = { sha256: sha256(buf), retrieved: '2026-10-13' };
  }
  if (overrides) writeFileSync(join(dir, 'overrides.json'), JSON.stringify(overrides));
  if (reviewed) writeFileSync(join(dir, 'places.geo.json'), JSON.stringify(reviewed));
  return lock;
}

/** The override table the tests use: a region GeoNames files as admin2, a city by another name, a non-ASCII name. */
export const OVERRIDES = {
  version: 1,
  countries: { 'Republic of Examplestan': 'XE' },
  places: [
    { name: 'Upper Example Region', country: 'XE', admin: 'XE.01.001' },
    { name: 'Harbourexample', country: 'XE', geonameId: 1003 },
    { name: 'Sankt Exämpel', country: 'XE', search: 'Sankt Exaempel' },
  ],
};
