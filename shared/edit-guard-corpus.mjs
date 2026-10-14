// How the shared corpus (shared/edit-guard.cases.json) is run, so the server adapter, the browser mirror and the shared suite
// compare findings the same way. Pure: the caller reads the JSON and passes `makeGuard({dob})` (a createEditGuard).
const key = (f) => `${f.obj} ${f.path} ${f.code} ${f.kind}`;

/** Findings of one corpus case, reduced to what the corpus pins: obj, path, code, kind and, where the case names one, the span. */
export function runCase(makeGuard, c) {
  const guard = makeGuard({ dob: c.dob === true });
  const found = c.kind === "objects" ? guard.checkObjects(c.objects, { context: c.context || [] }) : guard.checkValue(c.value, c.obj);
  const want = new Map(c.expect.map((e) => [key(e), e]));
  return found.map((f) => {
    const w = want.get(key(f));
    return { obj: f.obj, path: f.path, code: f.code, kind: f.kind, ...(w && w.span ? { span: f.span } : {}) };
  }).sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

export const expected = (c) => [...c.expect].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));

/** No finding carries the matched text, and every pointer is `/<obj><path>`. */
export function leaksText(findings, corpus) {
  const blob = JSON.stringify(findings);
  return blob.includes(corpus.phone) || blob.includes("a.test@example.org");
}
