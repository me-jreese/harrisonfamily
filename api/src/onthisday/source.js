// On this day, the source adapters (HFY-TSK-194; surfaces.md section 4.3).
//
// The builder (build.js) is pure and reads a snapshot `{ version, events, persons }`. A source is whatever produces one:
//
//   OnThisDaySource { version(): Promise<string>, events(): AsyncIterable<EventRow>, persons(): AsyncIterable<PersonRow>, snapshot?(): Promise<Snapshot> }
//
//   - `version()` is a cheap token that changes whenever the source's data changes (the record store's change sequence, or the ETag of person/index.json).
//     The route compares it with the stored index's `sourceVersion` on every cache miss, so it must not read the whole source.
//   - `events()` and `persons()` stream the rows the builder takes (build.js header). `snapshot()` is the one-traversal form of the same data; when a source has
//     it, `collectSource` uses it, so `version` and the rows come from one read. The record-store adapter (surf-onthisday-store-source, RG-5) implements the same interface.
//
// The INTERIM adapter below reads the published site data: person/index.json (the people and its ETag) and person/<id>.json (the events), 16 at a time. It gives the
// year tier only, because the published JSON is year-only (HFY-R76: no event date carries a month or day, and D-01 stripped sortValue). It needs D-02's event types.

export const INTERIM_CONCURRENCY = 16;
/** What a gramps_id looks like; only ids of this shape are ever turned into an S3 key. */
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_PEOPLE = 5000;
const MARRIAGE = 1;

/** map `items` through async `fn`, at most `limit` at a time; results keep the input order. A rejection stops starting new work and rejects. */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  let failed = false;
  async function worker() {
    while (!failed && next < items.length) {
      const i = next;
      next += 1;
      try {
        out[i] = await fn(items[i], i);
      } catch (e) {
        failed = true;
        throw e;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** One consistent snapshot of a source for `buildIndex`: `{ version, events: [], persons: [] }`. */
export async function collectSource(source) {
  if (typeof source.snapshot === "function") {
    const s = await source.snapshot();
    return { version: String(s.version), events: [...s.events], persons: [...s.persons] };
  }
  const version = String(await source.version());
  const events = [];
  for await (const e of source.events()) events.push(e);
  const persons = [];
  for await (const p of source.persons()) persons.push(p);
  return { version, events, persons };
}

const isAbsent = (e) => {
  const status = e?.$metadata?.httpStatusCode;
  return e?.name === "NoSuchKey" || e?.Code === "NoSuchKey" || e?.name === "AccessDenied" || e?.Code === "AccessDenied" || status === 404 || status === 403;
};

const lifeStateOf = (isLiving) => (isLiving === true ? "living" : isLiving === false ? "deceased" : "unknown");
const typeCodeOf = (t) => {
  const c = typeof t === "object" && t !== null ? t.code : t;
  const n = typeof c === "string" && /^\d{1,3}$/.test(c) ? Number(c) : c;
  return Number.isInteger(n) ? n : null;
};
const roleOf = (r) => (typeof r === "string" ? r : typeof r?.string === "string" ? r.string : "");
const placeOf = (p) => (typeof p === "string" ? p : typeof p?.displayName === "string" ? p.displayName : "");
// The published date text is blank whenever the date had a day or month (the renderer drops it), and the bare year otherwise. A year with any other text
// (about, before, after, a range, an estimate) is not an exact date, so it takes modifier 1 and the builder skips it.
const EXACT_TEXT = /^(?:from\s+)?\d{1,4}$/i;
const dateOf = (d) => {
  if (!d || typeof d !== "object" || !Number.isInteger(d.year) || d.year < 1) return null;
  const text = typeof d.text === "string" ? d.text.trim() : "";
  return { year: d.year, modifier: text === "" || EXACT_TEXT.test(text) ? 0 : 1, quality: 0 };
};

/**
 * The OnThisDaySource rows of one published person JSON (and, for the people list, its row in person/index.json).
 * Nothing in published JSON is Gramps-private (the renderer leaves private objects out), so every row is `private: false`.
 * Only the person's own events are attributed to the person, and only when no other person's file lists the same event
 * (a shared event cannot be told from a witness role in the published JSON). Marriages come from the family blocks only,
 * where the spouses are named (father as groom, mother as bride); a spouse who is private or missing leaves the pair short, and the builder skips it.
 */
export function rowsFromPerson(person, indexRow = {}) {
  const grampsId = typeof person?.grampsId === "string" ? person.grampsId : indexRow.grampsId;
  if (typeof grampsId !== "string" || !ID_RE.test(grampsId)) return null;
  const displayName = typeof person?.displayName === "string" && person.displayName.trim() ? person.displayName : indexRow.displayName;
  if (typeof displayName !== "string" || !displayName.trim()) return null;
  const isLiving = typeof person?.isLiving === "boolean" ? person.isLiving : indexRow.isLiving;
  const own = [];
  for (const e of Array.isArray(person?.events) ? person.events : []) {
    const typeCode = typeCodeOf(e?.type);
    if (typeof e?.handle !== "string" || typeCode === null || typeCode === MARRIAGE) continue;
    own.push({ handle: e.handle, typeCode, date: dateOf(e.date), place: placeOf(e.place), description: typeof e.description === "string" ? e.description : "" });
  }
  const family = [];
  for (const fam of Array.isArray(person?.familyTree?.spouseFamilies) ? person.familyTree.spouseFamilies : []) {
    const participants = [];
    if (typeof fam?.father?.grampsId === "string") participants.push({ grampsId: fam.father.grampsId, role: "groom" });
    if (typeof fam?.mother?.grampsId === "string") participants.push({ grampsId: fam.mother.grampsId, role: "bride" });
    for (const e of Array.isArray(fam?.events) ? fam.events : []) {
      const typeCode = typeCodeOf(e?.type);
      if (typeof e?.handle !== "string" || typeCode !== MARRIAGE) continue;
      family.push({ handle: e.handle, typeCode, date: dateOf(e.date), participants, place: placeOf(e.place), description: typeof e.description === "string" ? e.description : "", role: roleOf(e.role) });
    }
  }
  return { person: { grampsId, displayName: displayName.trim(), lifeState: lifeStateOf(isLiving), private: false }, own, family };
}

/** Joins per-person rows into builder rows. An own event listed by more than one person is dropped (and counted), a marriage is joined across both spouses' files. */
export function joinRows(parts) {
  const owners = new Map();
  for (const p of parts) for (const e of p.own) (owners.get(e.handle) ?? owners.set(e.handle, []).get(e.handle)).push({ grampsId: p.person.grampsId, e });
  const events = new Map();
  let shared = 0;
  for (const [handle, list] of owners) {
    if (list.length !== 1) { shared += 1; continue; }
    const { grampsId, e } = list[0];
    events.set(handle, { handle, typeCode: e.typeCode, date: e.date, participants: [{ grampsId, role: "primary" }], place: e.place, description: e.description, private: false });
  }
  for (const p of parts) {
    for (const e of p.family) {
      const row = events.get(e.handle) ?? { handle: e.handle, typeCode: e.typeCode, date: e.date, participants: [], place: e.place, description: e.description, private: false };
      for (const x of e.participants) if (!row.participants.some((y) => y.grampsId === x.grampsId && y.role === x.role)) row.participants.push({ ...x });
      events.set(e.handle, row);
    }
  }
  return { events: [...events.values()].sort((a, b) => (a.handle < b.handle ? -1 : a.handle > b.handle ? 1 : 0)), persons: parts.map((p) => p.person), shared };
}

/**
 * The interim OnThisDaySource over the published person data.
 *   head()            -> Promise<string>    the ETag of person/index.json (a HeadObject): this is `version()`
 *   readIndex()       -> Promise<{ version, json }>   person/index.json with the ETag it was read at
 *   readPerson(id)    -> Promise<object|null>         person/<id>.json parsed; null (or an S3 not-found/denied error) when there is no such file
 * Person reads run `concurrency` (16) at a time. A person with no file is skipped; any other failure fails the whole read, so the route serves the stale index.
 */
export function createInterimSource({ head, readIndex, readPerson, concurrency = INTERIM_CONCURRENCY, log = console }) {
  async function snapshot() {
    const { version, json } = await readIndex();
    const rows = (Array.isArray(json?.people) ? json.people : []).filter((r) => r && typeof r.grampsId === "string" && ID_RE.test(r.grampsId)).slice(0, MAX_PEOPLE);
    let missing = 0;
    const parts = (await mapLimit(rows, concurrency, async (row) => {
      let person = null;
      try {
        person = await readPerson(row.grampsId);
      } catch (e) {
        if (!isAbsent(e)) throw e;
      }
      if (!person) { missing += 1; return null; }
      return rowsFromPerson(person, row);
    })).filter(Boolean);
    const { events, persons, shared } = joinRows(parts);
    if (missing || shared) log.warn?.("onthisday interim source skipped rows", { missing, sharedEvents: shared });
    return { version: String(version), events, persons };
  }
  // events() and persons() each take their own traversal unless one is already running (callers that want one read use snapshot()).
  let running;
  const shared = () => (running ??= snapshot().finally(() => { running = undefined; }));
  return {
    kind: "interim",
    snapshot,
    async version() {
      return String(await head());
    },
    async *events() { yield* (await shared()).events; },
    async *persons() { yield* (await shared()).persons; },
  };
}

/** The S3 wiring of createInterimSource (index.js passes the client and bucket; tests pass a fake). Bodies are parsed here; errors pass through untouched. */
export function s3InterimSource({ s3, cmds, bucket, log = console }) {
  const body = async (o) => JSON.parse(await o.Body.transformToString());
  return createInterimSource({
    log,
    head: async () => {
      const o = await s3.send(new cmds.HeadObjectCommand({ Bucket: bucket, Key: "person/index.json" }));
      if (!o?.ETag) throw new Error("person/index.json has no ETag");
      return o.ETag;
    },
    readIndex: async () => {
      const o = await s3.send(new cmds.GetObjectCommand({ Bucket: bucket, Key: "person/index.json" }));
      if (!o?.ETag) throw new Error("person/index.json has no ETag");
      return { version: o.ETag, json: await body(o) };
    },
    readPerson: async (id) => {
      const o = await s3.send(new cmds.GetObjectCommand({ Bucket: bucket, Key: `person/${id}.json` }));
      return body(o);
    },
  });
}
