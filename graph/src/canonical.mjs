// Canonical JSON: keys sorted, compact, one trailing newline. The same value always gives the same bytes.

export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = canonicalize(value[k]);
    return out;
  }
  return value;
}

export function stringify(value) {
  return `${JSON.stringify(canonicalize(value))}\n`;
}
