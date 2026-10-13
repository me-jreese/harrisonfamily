import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { validateSchema } from '../src/schema-validate.mjs';
import { loadSchema } from '../src/verify.mjs';
import { GOLDEN } from './helpers.mjs';

const require = createRequire(import.meta.url);
const Ajv2020 = require('ajv/dist/2020');
const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
const schema = loadSchema();
const ajvValidate = ajv.compile(schema);
const golden = () => JSON.parse(readFileSync(GOLDEN, 'utf8'));
const clone = (x) => structuredClone(x);

const bothAccept = (g) => {
  assert.equal(ajvValidate(g), true, JSON.stringify(ajvValidate.errors));
  assert.deepEqual(validateSchema(schema, g), []);
};
const bothReject = (g, label) => {
  assert.equal(ajvValidate(g), false, `ajv accepted: ${label}`);
  assert.notDeepEqual(validateSchema(schema, g), [], `built-in validator accepted: ${label}`);
};

describe('family-graph.v1.schema.json', () => {
  it('is JSON Schema 2020-12', () => {
    assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  });

  it('validates the golden output (ajv and the built-in validator agree)', () => bothAccept(golden()));

  it('has additionalProperties:false on every object schema', () => {
    const missing = [];
    const walk = (node, path) => {
      if (Array.isArray(node)) return node.forEach((n, i) => walk(n, `${path}/${i}`));
      if (!node || typeof node !== 'object') return;
      const isObjectSchema = node.type === 'object' || node.properties || node.patternProperties;
      if (isObjectSchema && node.additionalProperties !== false) missing.push(path || '/');
      for (const [k, v] of Object.entries(node)) {
        if (k === 'enum' || k === 'const' || k === 'required') continue;
        walk(v, `${path}/${k}`);
      }
    };
    walk(schema, '');
    assert.deepEqual(missing, []);
  });

  it('rejects an unknown property at every object in the golden', () => {
    const g = golden();
    const paths = [];
    const walk = (v, ptr) => {
      if (Array.isArray(v)) v.forEach((x, i) => walk(x, [...ptr, i]));
      else if (v && typeof v === 'object') {
        paths.push(ptr);
        for (const [k, x] of Object.entries(v)) walk(x, [...ptr, k]);
      }
    };
    walk(g, []);
    assert.ok(paths.length > 100);
    for (const ptr of paths) {
      const m = clone(g);
      const target = ptr.reduce((n, k) => n[k], m);
      target.zzExtra = 1;
      bothReject(m, `extra property at /${ptr.join('/')}`);
    }
  });

  it('rejects the usual mistakes, in both validators', () => {
    const cases = {
      'schemaVersion 2': (g) => { g.schemaVersion = 2; },
      'missing required top-level key': (g) => { delete g.edges; },
      'person.sex outside the enum': (g) => { g.people[0].sex = 'x'; },
      'a year below 1000': (g) => { g.people[0].birthYear = 999; },
      'a sort value as a year': (g) => { g.people[0].birthYear = 2400000; },
      'a non-integer year': (g) => { g.people[0].birthYear = 1900.5; },
      'a string year': (g) => { g.people[0].birthYear = '1900'; },
      'living not boolean': (g) => { g.people[0].living = 'no'; },
      'union rel outside the enum': (g) => { g.unions[0].children[0].rel[g.unions[0].partners[0]] = 'bio'; },
      'three partners': (g) => { g.unions[0].partners.push('I1'); },
      'edge of neither shape': (g) => { g.edges[0].kind = 'sibling'; },
      'partner edge with a rel': (g) => { g.edges.find((e) => e.kind === 'partner').rel = 'birth'; },
      'latitude out of range': (g) => { g.places[1].lat = 91; },
      'a bad generatedAt': (g) => { g.generatedAt = '2026-10-20'; },
      'a bad snapshot': (g) => { g.source.snapshot = 'sha256:XYZ'; },
      'a face path outside faces/': (g) => { g.people[0].face = '../x.webp'; },
      'an id with a space': (g) => { g.people[0].id = 'I 1'; },
      'an empty name': (g) => { g.people[0].name = ''; },
      'event type outside the enum': (g) => { g.events[0].type = 'wedding'; },
    };
    for (const [label, mutate] of Object.entries(cases)) {
      const g = golden();
      mutate(g);
      bothReject(g, label);
    }
  });
});
