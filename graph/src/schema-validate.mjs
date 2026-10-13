// A small JSON Schema validator for the subset family-graph.v1.schema.json uses, so the builder needs no
// runtime dependency (ajv is a dev dependency: the tests cross-check this validator against it).
// Failures carry a JSON pointer and a keyword, never the offending value.

const TYPE_CHECKS = {
  object: (v) => v !== null && typeof v === 'object' && !Array.isArray(v),
  array: Array.isArray,
  string: (v) => typeof v === 'string',
  number: (v) => typeof v === 'number' && Number.isFinite(v),
  integer: (v) => Number.isInteger(v),
  boolean: (v) => typeof v === 'boolean',
  null: (v) => v === null,
};

const esc = (k) => String(k).replace(/~/g, '~0').replace(/\//g, '~1');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function resolveRef(root, ref) {
  if (!ref.startsWith('#/')) throw new Error(`unsupported $ref ${ref}`);
  return ref
    .slice(2)
    .split('/')
    .reduce((node, part) => node[part.replace(/~1/g, '/').replace(/~0/g, '~')], root);
}

/** @returns {{ pointer: string, keyword: string }[]} */
export function validateSchema(schema, data) {
  const errors = [];
  const patterns = new Map();
  const re = (p) => {
    if (!patterns.has(p)) patterns.set(p, new RegExp(p));
    return patterns.get(p);
  };

  function check(node, value, ptr, sink) {
    if (node.$ref) node = { ...resolveRef(schema, node.$ref), ...Object.fromEntries(Object.entries(node).filter(([k]) => k !== '$ref')) };
    const fail = (keyword) => sink.push({ pointer: ptr, keyword });

    if (node.type !== undefined) {
      const types = Array.isArray(node.type) ? node.type : [node.type];
      if (!types.some((t) => TYPE_CHECKS[t](value))) return fail('type');
    }
    if (node.const !== undefined && !same(node.const, value)) fail('const');
    if (node.enum !== undefined && !node.enum.some((e) => same(e, value))) fail('enum');

    if (typeof value === 'number') {
      if (node.minimum !== undefined && value < node.minimum) fail('minimum');
      if (node.maximum !== undefined && value > node.maximum) fail('maximum');
    }
    if (typeof value === 'string') {
      if (node.minLength !== undefined && value.length < node.minLength) fail('minLength');
      if (node.maxLength !== undefined && value.length > node.maxLength) fail('maxLength');
      if (node.pattern !== undefined && !re(node.pattern).test(value)) fail('pattern');
    }
    if (Array.isArray(value)) {
      if (node.minItems !== undefined && value.length < node.minItems) fail('minItems');
      if (node.maxItems !== undefined && value.length > node.maxItems) fail('maxItems');
      if (node.items) value.forEach((v, i) => check(node.items, v, `${ptr}/${i}`, sink));
    }
    if (TYPE_CHECKS.object(value)) {
      for (const k of node.required ?? []) if (!(k in value)) sink.push({ pointer: `${ptr}/${esc(k)}`, keyword: 'required' });
      const props = node.properties ?? {};
      const patternProps = Object.entries(node.patternProperties ?? {});
      for (const [k, v] of Object.entries(value)) {
        let matched = false;
        if (Object.hasOwn(props, k)) {
          matched = true;
          check(props[k], v, `${ptr}/${esc(k)}`, sink);
        }
        for (const [p, sub] of patternProps) {
          if (re(p).test(k)) {
            matched = true;
            check(sub, v, `${ptr}/${esc(k)}`, sink);
          }
        }
        if (!matched) {
          if (node.additionalProperties === false) sink.push({ pointer: `${ptr}/${esc(k)}`, keyword: 'additionalProperties' });
          else if (node.additionalProperties && typeof node.additionalProperties === 'object') check(node.additionalProperties, v, `${ptr}/${esc(k)}`, sink);
        }
      }
    }
    if (node.anyOf || node.oneOf) {
      const branches = node.anyOf ?? node.oneOf;
      const passing = branches.filter((b) => {
        const sub = [];
        check(b, value, ptr, sub);
        return sub.length === 0;
      }).length;
      if (node.anyOf ? passing === 0 : passing !== 1) fail(node.anyOf ? 'anyOf' : 'oneOf');
    }
  }

  check(schema, data, '', errors);
  return errors;
}
