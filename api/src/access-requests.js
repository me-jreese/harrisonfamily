// The admin side of the access requests (HFY-TSK-141, surf-access-admin-api; surfaces.md 7.4, BRD2 D2-23, reviews PS-13 and IF-06).
//
//   GET  /api/access-requests            ?state=pending|awaiting_record|done&cursor=   the queue (admins)
//   GET  /api/access-requests/:id        one request: the requester's email MASKED (first character plus domain), the answers, the Gramps preview
//   POST /api/access-requests/:id/decision   { decision: "link" | "new" | "decline", version, ... }
//   POST /api/access-requests/:id/revoke     { version, reason?, confirmedOutside }
//   POST /api/second-email/:id               { response: "confirm" | "object" }   the MEMBER answers the 72 hour notice (not an admin route)
//
// The routes sit behind the `accessRequests` flag (default off; dark routes are 404 to everyone outside the uat group). Every admin route is 403
// not_admin for a member, whatever the flag says. Nothing here answers with a full requester address (IF-06), and every message to the requester
// is a system template (shared/emails.mjs): the only free text an admin adds is the decline note, which the R-18 guard scans first.
//
// The state machine of ACCESSREQ#<id>.state (surfaces.md 7.1): pending -> active (link) | awaiting_record (new) | declined; awaiting_record ->
// active (link, or completeAccessRequest when the approval mints the gramps_id) | declined; active -> revoked. Every change is ONE
// TransactWriteItems guarded by `#state = :expected AND #version = :v`, so a double click or a second admin cannot decide a request twice.
//
// Approvals that put a stranger behind a member's sign-in (link, new, revoke, allowSecondEmail) need a sign-in at most 900 s old
// (401 step_up_required) and the flag `confirmedOutside: true` ("confirmed with this person outside the site"), recorded in AUDIT#accessreq.
// `link` refuses a person who is not living (422 not_living). `allowSecondEmail` is for the gramps-owner alone; it grants the second email with
// an `effectiveAt` 72 hours ahead, tells the member (an inbox item and a mail to every address they already sign in with), and the grant
// counts only once effectiveAt has passed or the member confirms in the app; the member may object (the grant is revoked) until then.
// The auth edge and the shared member reader both honour effectiveAt (shared/allowlist-store.mjs isAllowedNow), so no timer is needed.
import { HttpError } from "./http.js";
import { TxnCancelled, auditItem, transact } from "./txn.js";
import { allowKeys, emailOfAllowItem, grantItems, isAllowedNow, listAllowBySub, normalizeAllowEmail, readAllowEntry, revokeItems } from "./allowlist-store.js";
import { createGuard } from "./guard.js";
import { mapToGramps } from "./shared/legacy-form.mjs";
import { createSystem, loadProposal } from "./records/proposal-store.js";
import { problem, requireRecentSignIn } from "./records/changes.js";
import { byGrampsId, get } from "./records/index.js";

/** Q2-11(a): store the requester's city and state as a Residence event. The same value as auth/src/access-request.js and islands/src/lib/join.js. */
export const STORE_CURRENT_CITY = true;
/** A decided request lives this long (surfaces.md 7.9); an awaiting_record one gets a fresh 90 days when it is set. */
export const DECIDED_TTL_SECONDS = 30 * 86400;
export const AWAITING_TTL_SECONDS = 90 * 86400;
/** The member's objection window for a second email (PS-13). */
export const HOLD_MS = 72 * 3600 * 1000;
export const MAX_NOTE_CHARS = 500;
export const MAX_REASON_CHARS = 200;
export const PAGE_DEFAULT = 25;
export const PAGE_MAX = 50;
export const LIST_STATES = Object.freeze({
  pending: Object.freeze(["pending"]),
  awaiting_record: Object.freeze(["awaiting_record"]),
  done: Object.freeze(["active", "declined", "revoked", "expired"]),
});

export const requestKey = (id) => ({ PK: `ACCESSREQ#${id}`, SK: "META" });
export const requestEmailKey = (hash) => ({ PK: `ACCESSREQEMAIL#${hash}`, SK: "META" });
const partition = (state) => `ACCESSREQS#${state}`;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const GID_RE = /^[A-Za-z0-9_-]{1,32}$/;
const HANDLE_RE = /^[A-Za-z0-9_-]{8,64}$/;

/** `s***@example.test`: the first character and the domain, never the rest (IF-06). */
export function maskEmail(email) {
  const s = typeof email === "string" ? email : "";
  const at = s.lastIndexOf("@");
  if (at < 1) return "***";
  return `${[...s.slice(0, at)][0]}***${s.slice(at)}`;
}

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const nameOf = (form) => [form?.givenNames, form?.maidenSurname].filter((x) => typeof x === "string" && x).join(" ");
const errName = (e) => (e instanceof Error && e.name ? e.name : "error");
const validation = (errors, message = "the request is not valid") => problem(400, "validation", message, { errors });
const unavailable = () => new HttpError(503, "unavailable", "the store is busy; try again");
const conflict = (req) => new HttpError(409, "conflict", "this request changed; reload it", { current: { state: req.state, version: req.version } });

/** The body of a decision, validated field by field (400 validation with JSON pointers; nothing is echoed). */
export function parseDecision(body) {
  const b = isObj(body) ? body : null;
  if (!b) throw validation([{ pointer: "", detail: "the body is an object" }]);
  const kind = b.decision;
  if (kind !== "link" && kind !== "new" && kind !== "decline") throw validation([{ pointer: "/decision", detail: "decision is link, new or decline" }]);
  const allowed = {
    link: ["decision", "grampsId", "version", "allowSecondEmail", "confirmedOutside"],
    new: ["decision", "preview", "version", "confirmedOutside"],
    decline: ["decision", "note", "sendNote", "version"],
  }[kind];
  const errors = [];
  for (const k of Object.keys(b)) if (!allowed.includes(k)) errors.push({ pointer: `/${k}`, detail: "not a field of this decision" });
  if (!Number.isInteger(b.version) || b.version < 1) errors.push({ pointer: "/version", detail: "version is the number the request carries" });
  if (kind !== "decline" && b.confirmedOutside !== true) errors.push({ pointer: "/confirmedOutside", detail: "confirm with this person outside the site first" });
  const out = { decision: kind, version: b.version };
  if (kind === "link") {
    if (typeof b.grampsId !== "string" || !GID_RE.test(b.grampsId)) errors.push({ pointer: "/grampsId", detail: "grampsId is the person's Gramps ID" });
    else out.grampsId = b.grampsId;
    if (b.allowSecondEmail !== undefined && typeof b.allowSecondEmail !== "boolean") errors.push({ pointer: "/allowSecondEmail", detail: "allowSecondEmail is true or false" });
    out.allowSecondEmail = b.allowSecondEmail === true;
  } else if (kind === "new") {
    if (!isObj(b.preview)) errors.push({ pointer: "/preview", detail: "preview is the Gramps preview of the person" });
    else out.preview = b.preview;
  } else {
    if (b.note !== undefined && b.note !== null && (typeof b.note !== "string" || b.note.length > MAX_NOTE_CHARS)) errors.push({ pointer: "/note", detail: `note is text of at most ${MAX_NOTE_CHARS} characters` });
    else if (typeof b.note === "string" && b.note.trim()) out.note = b.note.trim();
    if (b.sendNote !== undefined && typeof b.sendNote !== "boolean") errors.push({ pointer: "/sendNote", detail: "sendNote is true or false" });
    out.sendNote = b.sendNote === true;
  }
  if (errors.length) throw validation(errors);
  return out;
}

// ---- Gramps builders for the preview -> EditOps of a `new` decision ---------------------------------------------------------------
const typed = (cls, value) => ({ _class: cls, string: "", value });
const yearDate = (year, modifier = 0) => ({ _class: "Date", calendar: 0, dateval: [0, 0, year, false], format: null, modifier, newyear: 0, quality: 0, sortval: 0, text: "" });
const noDate = () => yearDate(0);
const EVENT_TYPES = Object.freeze({ BIRTH: 12, DEGREE: 25, GRADUATION: 31, RESIDENCE: 42 });
const EVENT_TYPE_SET = new Set(Object.values(EVENT_TYPES));
const GENDERS = new Set([0, 1, 2, 3]);
const MAX_PREVIEW_EVENTS = 12;

const eventValue = ({ type, date, description, place }) => ({
  _class: "Event", attribute_list: [], citation_list: [], date, description, gramps_id: "", media_list: [], note_list: [], place: place || "", private: false, tag_list: [], type: typed("EventType", type),
});
const eventRef = (ref) => ({ _class: "EventRef", attribute_list: [], citation_list: [], note_list: [], private: false, ref, role: typed("EventRoleType", 1) });

/** A year-only date from whatever a (possibly edited) preview holds: day and month are dropped, never carried (R-19). */
function dateFrom(d, nowYear, pointer, errors) {
  if (d === undefined || d === null) return noDate();
  const year = Array.isArray(d?.dateval) ? d.dateval[2] : undefined;
  const modifier = d?.modifier === 7 ? 7 : 0;
  if (year === 0 || year === undefined) return noDate();
  if (!Number.isInteger(year) || year < 1800 || year > nowYear + 1) {
    errors.push({ pointer, detail: "a year, like 1962" });
    return noDate();
  }
  return yearDate(year, modifier);
}

/**
 * The create ops of a `new` decision, from the (editable) preview: a Person and its events, rebuilt field by field so nothing the preview carries
 * beyond the Gramps-mapped facts can reach the store. The server owns the derived fields (indexes, change) and the ids. An event's `place` is empty
 * or the handle of an existing Place (the admin UI matches places against the gated index); `placeHandles` are verified by the caller.
 */
export function opsFromPreview(preview, { nowYear }) {
  const errors = [];
  const p = isObj(preview.person) ? preview.person : null;
  if (!p || p._class !== "Person") errors.push({ pointer: "/preview/person", detail: "preview.person is the Person" });
  const name = isObj(p?.primary_name) ? p.primary_name : {};
  const surname = Array.isArray(name.surname_list) && isObj(name.surname_list[0]) ? name.surname_list[0].surname : undefined;
  if (typeof name.first_name !== "string" || !name.first_name.trim() || name.first_name.length > 100) errors.push({ pointer: "/preview/person/primary_name/first_name", detail: "a given name" });
  if (typeof surname !== "string" || !surname.trim() || surname.length > 60) errors.push({ pointer: "/preview/person/primary_name/surname_list/0/surname", detail: "a last name at birth" });
  if (typeof name.nick === "string" && name.nick.length > 40) errors.push({ pointer: "/preview/person/primary_name/nick", detail: "a nickname of at most 40 characters" });
  if (!GENDERS.has(p?.gender)) errors.push({ pointer: "/preview/person/gender", detail: "a Gramps gender" });
  const events = Array.isArray(preview.events) ? preview.events : [];
  if (events.length > MAX_PREVIEW_EVENTS) errors.push({ pointer: "/preview/events", detail: `at most ${MAX_PREVIEW_EVENTS} events` });
  const keys = new Set();
  const built = [];
  events.slice(0, MAX_PREVIEW_EVENTS).forEach((ev, i) => {
    const at = `/preview/events/${i}`;
    if (!isObj(ev) || typeof ev.hfyKey !== "string" || !ev.hfyKey || keys.has(ev.hfyKey)) {
      errors.push({ pointer: at, detail: "an event with its own hfyKey" });
      return;
    }
    keys.add(ev.hfyKey);
    const type = ev.type?.value;
    if (!EVENT_TYPE_SET.has(type)) errors.push({ pointer: `${at}/type`, detail: "birth, residence, graduation or degree" });
    if (ev.description !== undefined && (typeof ev.description !== "string" || ev.description.length > 200)) errors.push({ pointer: `${at}/description`, detail: "a description of at most 200 characters" });
    if (ev.place !== undefined && ev.place !== "" && (typeof ev.place !== "string" || !HANDLE_RE.test(ev.place))) errors.push({ pointer: `${at}/place`, detail: "empty, or the handle of an existing place" });
    built.push({ key: ev.hfyKey, value: eventValue({ type, date: dateFrom(ev.date, nowYear, `${at}/date`, errors), description: typeof ev.description === "string" ? ev.description : "", place: typeof ev.place === "string" ? ev.place : "" }) });
  });
  if (built.filter((e) => e.value.type.value === EVENT_TYPES.BIRTH).length !== 1) errors.push({ pointer: "/preview/events", detail: "exactly one birth event" });
  if (errors.length) throw validation(errors);
  const refs = Array.isArray(p.event_ref_list) ? p.event_ref_list.map((r) => r?.ref).filter((k) => keys.has(k)) : built.map((e) => e.key);
  const tempOf = new Map(built.map((e, i) => [e.key, `new:${i + 2}`]));
  const person = {
    _class: "Person", address_list: [], alternate_names: [], attribute_list: [], citation_list: [],
    event_ref_list: [...new Set(refs.length ? refs : built.map((e) => e.key))].map((k) => eventRef(tempOf.get(k))),
    family_list: [], gender: p.gender, gramps_id: "", lds_ord_list: [], media_list: [], note_list: [], parent_family_list: [], person_ref_list: [],
    primary_name: {
      _class: "Name", call: "", citation_list: [], date: noDate(), famnick: "", first_name: name.first_name.trim(), group_as: "",
      nick: typeof name.nick === "string" ? name.nick.trim() : "", note_list: [], private: false, suffix: "", title: "",
      surname_list: [{ _class: "Surname", connector: "", origintype: typed("NameOriginType", 1), prefix: "", primary: true, surname: surname.trim() }],
      type: typed("NameType", 2),
    },
    private: false, tag_list: [], urls: [],
  };
  const ops = [{ id: "person", op: "create", obj: "new:1", cls: "Person", value: person }];
  built.forEach((e, i) => ops.push({ id: `event-${i}`, op: "create", obj: `new:${i + 2}`, cls: "Event", value: e.value }));
  return { ops, places: built.map((e) => e.value.place).filter(Boolean) };
}

/**
 * The domain. `deps`:
 *   ddb, cmds, table, now() ms, uid() the audit suffix (a ULID), log
 *   mailer            { send({ template, to, vars }) } or absent (then emailSent is false)
 *   notify            the notifier's notify(feature, recipients, opts), or absent
 *   getAdmins         async () => Set of admin gramps_ids
 *   isOwner           async (sub) => boolean, the gramps-owner group
 *   personFacts       async (grampsId) => null (no such person) | { isLiving }, the site's own person/<id>.json
 *   readEntries       async () => Map email -> { sub }, io's S3 allowlist (optional: DynamoDB alone otherwise)
 *   guardDob          the R-18 DOB switch
 */
export function createAccessRequests(deps) {
  const { ddb, cmds, table, now = () => Date.now(), uid, log = console } = deps;
  const sec = () => Math.floor(now() / 1000);
  const iso = (ms = now()) => new Date(ms).toISOString();
  const guard = createGuard({ dob: deps.guardDob === true, log });
  const send = (input) => ddb.send(input);

  function requireAdmin(actor) {
    if (actor?.admin !== true) throw new HttpError(403, "not_admin", "only an admin can do that");
  }
  const checkId = (id) => {
    if (typeof id !== "string" || !ID_RE.test(id)) throw new HttpError(404, "not_found", "no such request");
    return id;
  };
  async function loadRequest(id) {
    const r = await send(new cmds.GetCommand({ TableName: table, Key: requestKey(id), ConsistentRead: true }));
    const it = r?.Item;
    if (!it || it.entity !== "accessreq") return null;
    if (Number.isFinite(it.ttl) && it.ttl <= sec()) return null; // DynamoDB deletes lazily; an expired request is gone
    return it;
  }
  async function need(id) {
    const req = await loadRequest(checkId(id));
    if (!req) throw new HttpError(404, "not_found", "no such request");
    return req;
  }

  // ---- reads ------------------------------------------------------------------------------------------------------------------
  const summary = (it) => ({
    id: it.id, state: it.state, createdAt: it.createdAt,
    givenNames: it.form?.givenNames ?? "", maidenSurname: it.form?.maidenSurname ?? "", birthYear: it.form?.birthYear ?? null, birthPlace: it.form?.birthPlace ?? "",
  });

  const encodeCursor = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  function decodeCursor(raw, states) {
    if (raw === undefined || raw === "") return { p: 0, k: undefined };
    try {
      const o = JSON.parse(Buffer.from(String(raw), "base64url").toString("utf8"));
      const k = o?.k;
      if (!Number.isInteger(o?.p) || o.p < 0 || o.p >= states.length) throw new Error("bad");
      if (k !== undefined && !(isObj(k) && typeof k.PK === "string" && k.PK.startsWith("ACCESSREQ#") && k.SK === "META" && k.GSI1PK === partition(states[o.p]))) throw new Error("bad");
      return { p: o.p, k };
    } catch {
      throw validation([{ pointer: "/cursor", detail: "cursor is a value from a previous page" }]);
    }
  }

  async function list(actor, query = {}) {
    requireAdmin(actor);
    const state = query.state === undefined || query.state === "" ? "pending" : query.state;
    if (!Object.hasOwn(LIST_STATES, state)) throw validation([{ pointer: "/state", detail: "state is pending, awaiting_record or done" }]);
    const limit = query.limit === undefined || query.limit === "" ? PAGE_DEFAULT : Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > PAGE_MAX) throw validation([{ pointer: "/limit", detail: `limit is 1 to ${PAGE_MAX}` }]);
    const states = LIST_STATES[state];
    const cur = decodeCursor(query.cursor, states);
    const items = [];
    let p = cur.p;
    let k = cur.k;
    let next;
    const newestFirst = state === "done";
    while (p < states.length && items.length < limit) {
      const r = await send(new cmds.QueryCommand({
        TableName: table, IndexName: "GSI1", KeyConditionExpression: "GSI1PK = :pk", ExpressionAttributeValues: { ":pk": partition(states[p]) },
        ScanIndexForward: !newestFirst, Limit: limit - items.length, ...(k ? { ExclusiveStartKey: k } : {}),
      }));
      for (const it of r.Items ?? []) if (it.entity === "accessreq" && !(Number.isFinite(it.ttl) && it.ttl <= sec())) items.push(summary(it));
      if (r.LastEvaluatedKey) {
        k = r.LastEvaluatedKey;
        if (items.length >= limit) next = encodeCursor({ p, k });
      } else {
        p += 1;
        k = undefined;
        if (items.length >= limit && p < states.length) next = encodeCursor({ p, k: undefined });
      }
    }
    return { items, cursor: next ?? null };
  }

  function previewOf(form, email) {
    try {
      const m = mapToGramps({ ...form, email }, { storeCurrentCity: STORE_CURRENT_CITY, now: now() });
      return { person: m.person, events: m.events, placeQueries: m.placeQueries };
    } catch {
      return null; // an answer that no longer validates (the rules moved): the admin reads the form itself
    }
  }

  async function getOne(actor, id) {
    requireAdmin(actor);
    const req = await need(id);
    const { decision, hold, proposalId } = req;
    return {
      id: req.id, state: req.state, version: req.version, createdAt: req.createdAt, email: maskEmail(req.email), form: req.form, preview: previewOf(req.form, req.email),
      ...(decision ? { decision: { ...decision } } : {}), ...(hold ? { hold: { until: hold.until } } : {}), ...(proposalId ? { proposalId } : {}),
    };
  }

  // ---- shared pieces of a write -------------------------------------------------------------------------------------------------
  const update = (req, { state, at, ttl, decision, extra = {}, tag = "accessreq.update" }) => {
    const names = { "#state": "state", "#version": "version", "#updatedAt": "updatedAt", "#gsi1pk": "GSI1PK", "#decision": "decision", "#ttl": "ttl" };
    const values = { ":next": state, ":nv": req.version + 1, ":at": at, ":gpk": partition(state), ":decision": decision, ":ttl": ttl, ":expected": req.state, ":v": req.version };
    const sets = ["#state = :next", "#version = :nv", "#updatedAt = :at", "#gsi1pk = :gpk", "#decision = :decision", "#ttl = :ttl"];
    Object.entries(extra).forEach(([k, v], i) => {
      names[`#x${i}`] = k;
      values[`:x${i}`] = v;
      sets.push(`#x${i} = :x${i}`);
    });
    return { key: requestKey(req.id), update: `SET ${sets.join(", ")}`, condition: "#state = :expected AND #version = :v", names, values, tag };
  };
  const guardUpdate = (req, state, ttl) => ({
    key: requestEmailKey(req.emailHash),
    update: "SET #state = :gs, #ttl = :gt",
    condition: "attribute_not_exists(PK) OR #rid = :rid", // never move a newer request's guard
    names: { "#state": "state", "#ttl": "ttl", "#rid": "requestId" },
    values: { ":gs": state, ":gt": ttl, ":rid": req.id },
    tag: "accessreq.guard",
  });
  const audit = (op, req, actorId, at, before, after, reason) =>
    ({ item: auditItem({ op, id: `accessreq:${req.id}`, principalId: actorId, at, before, after, ...(reason !== undefined ? { reason } : {}) }, uid(), table) });

  async function commit(parts) {
    try {
      await transact(ddb, cmds, table, parts, deps.txnOpts);
    } catch (e) {
      if (e instanceof TxnCancelled) {
        if (e.conditionFailed) {
          const tags = e.failures.map((f) => f.tag);
          if (tags.includes("allow.grant")) throw new HttpError(409, "already_member", "that email already has access");
          throw new HttpError(409, "conflict", "this request changed; reload it");
        }
        throw unavailable();
      }
      throw e;
    }
  }

  /** Runs a post-commit side effect: the write is done, so a failure is logged by name only and never reaches the caller. */
  async function after(label, fn) {
    try {
      return await fn();
    } catch (e) {
      log.error?.(`access request ${label} failed (write already committed)`, errName(e));
      return undefined;
    }
  }
  /** One system template to one address; true when SES took it. */
  async function mailTo(to, template, vars = {}) {
    if (!deps.mailer) return false;
    try {
      await deps.mailer.send({ template, to, vars });
      return true;
    } catch (e) {
      log.error?.("access request mail failed (the decision stands)", errName(e));
      return false;
    }
  }
  const mirrorGuard = (req, state, ttl) => after("guard mirror", async () => {
    const g = guardUpdate(req, state, ttl);
    await send(new cmds.UpdateCommand({
      TableName: table, Key: g.key, UpdateExpression: g.update, ConditionExpression: "attribute_exists(PK) AND #rid = :rid",
      ExpressionAttributeNames: g.names, ExpressionAttributeValues: g.values,
    })).catch((e) => { if (e?.name !== "ConditionalCheckFailedException") throw e; });
  });

  /** Every address a member signs in with: their active ALLOW# items plus io's S3 file entries that no item overrides. */
  async function emailsOfSub(sub) {
    const items = await listAllowBySub(ddb, cmds, table, sub);
    const overridden = new Set(items.map(emailOfAllowItem));
    const out = items.filter((it) => isAllowedNow(it, now())).map(emailOfAllowItem);
    if (deps.readEntries) for (const [email, p] of (await deps.readEntries()) ?? []) if (p?.sub === sub && !overridden.has(normalizeAllowEmail(email))) out.push(normalizeAllowEmail(email));
    return [...new Set(out)].sort();
  }

  async function livingCheck(store, grampsId) {
    if (typeof deps.personFacts !== "function") throw new HttpError(503, "unavailable", "person lookup is not configured");
    let facts;
    try {
      facts = await deps.personFacts(grampsId);
    } catch (e) {
      log.error?.("person lookup failed", errName(e));
      throw unavailable();
    }
    if (!facts) throw new HttpError(422, "unknown_person", "that person is not on the site");
    const notLiving = new HttpError(422, "not_living", "only a person who is living can be linked to a request");
    if (facts.isLiving !== true) throw notLiving; // missing or false: fail closed
    if (store) { // the record store knows a death event the page index may not have caught up with
      for (const h of await byGrampsId(store, "Person", grampsId)) {
        const head = await get(store, "Person", h.handle);
        if (head && Number.isInteger(head.obj.death_ref_index) && head.obj.death_ref_index >= 0) throw notLiving;
      }
    }
  }

  async function alreadyMember(req) {
    const own = await readAllowEntry(ddb, cmds, table, req.email);
    if (own) return own.state === "active"; // a revoked item overrides the file, and may be granted again
    return Boolean(deps.readEntries && (await deps.readEntries())?.has(req.email));
  }

  // ---- the decision -----------------------------------------------------------------------------------------------------------
  async function decide(actor, id, body, { store } = {}) {
    requireAdmin(actor);
    checkId(id);
    const input = parseDecision(body);
    if (input.decision !== "decline") requireRecentSignIn(actor, now());
    if (input.decision === "link" && input.allowSecondEmail && !(typeof deps.isOwner === "function" && (await deps.isOwner(actor.id)))) {
      throw new HttpError(403, "owner_only", "only the owner of the family tree can allow a second email");
    }
    if (input.note) guard("access-requests", "decline", [["/note", input.note]]); // R-18: a refusal is 422 and echoes no text
    const req = await need(id);
    const states = input.decision === "new" ? ["pending"] : ["pending", "awaiting_record"];
    if (!states.includes(req.state) || req.version !== input.version) throw conflict(req);
    if (input.decision === "link") return link(actor, req, input, store);
    if (input.decision === "new") return makeNew(actor, req, input, store);
    return decline(actor, req, input);
  }

  async function link(actor, req, input, store) {
    const { grampsId } = input;
    await livingCheck(store, grampsId);
    try {
      if (await alreadyMember(req)) throw new HttpError(409, "already_member", "that email already has access");
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw unavailable();
    }
    const existing = await emailsOfSub(grampsId).catch(() => { throw unavailable(); });
    const second = existing.length > 0;
    if (second && !input.allowSecondEmail) throw new HttpError(409, "second_email", "that person already has access with another email", { retryWith: { allowSecondEmail: true } });
    const hold = second && input.allowSecondEmail;
    const at = iso();
    const effectiveAt = hold ? iso(now() + HOLD_MS) : undefined;
    const decision = { kind: "link", by: actor.id, at, grampsId, confirmedOutside: true, ...(hold ? { secondEmail: true } : {}) };
    const grant = grantItems({ email: req.email, sub: grampsId, source: "access-request", requestId: req.id, at, by: actor.id, uid: uid(), table, ...(hold ? { effectiveAt } : {}) });
    const ttl = sec() + DECIDED_TTL_SECONDS;
    await commit({
      puts: [...grant.puts, audit("accessreq.decide", req, actor.id, at, { state: req.state }, { state: "active", decision: "link", sub: grampsId, confirmedOutside: true, secondEmail: hold })],
      updates: [update(req, { state: "active", at, ttl, decision, extra: hold ? { hold: { until: effectiveAt, grampsId } } : {} })],
    });
    // Committed. Nothing below can change the answer.
    const emailSent = await mailTo(req.email, hold ? "approved_later" : "approved", hold ? { when: effectiveAt.slice(0, 10) } : {});
    await mirrorGuard(req, "active", ttl);
    await tellAdmins(actor, req);
    if (hold) await after("second email notice", () => noticeMember(grampsId, existing));
    await after("facts proposal", () => proposeFacts(store, req, grampsId));
    return { state: "active", emailSent, ...(hold ? { effectiveAt } : {}) };
  }

  async function tellAdmins(actor, req) {
    await after("admin notice", async () => {
      if (!deps.notify || !deps.getAdmins) return;
      const admins = [...(await deps.getAdmins())].filter((x) => x !== actor.id);
      if (admins.length) await deps.notify("access_request_decided", admins, { navigate: "/me/requests/", actorLabel: actor.label, subjectLabel: nameOf(req.form) });
    });
  }

  /** The member's side of a second email: one inbox item, and a mail to every address they already sign in with. Content-free. */
  async function noticeMember(grampsId, existing) {
    if (deps.notify) await deps.notify("second_email_notice", [grampsId], { navigate: "/me/inbox/" });
    for (const to of existing.slice(0, 10)) await mailTo(to, "second_email_notice");
  }

  async function makeNew(actor, req, input, store) {
    if (!store) throw new HttpError(503, "unavailable", "the record store is not configured");
    const { ops, places } = opsFromPreview(input.preview, { nowYear: new Date(now()).getUTCFullYear() });
    for (const handle of places) {
      if (!(await get(store, "Place", handle))) throw validation([{ pointer: "/preview/events", detail: "a place on an event does not exist" }]);
    }
    // The proposal first: one request id makes one proposal (a repeat returns the first), so a lost race below can be retried safely.
    const proposal = await createSystem(store, { kind: "create", ops, origin: "access_request", requestId: req.id, base_versions: {} });
    const at = iso();
    const ttl = sec() + AWAITING_TTL_SECONDS;
    const decision = { kind: "new", by: actor.id, at, proposalId: proposal.id, confirmedOutside: true };
    await commit({
      puts: [audit("accessreq.decide", req, actor.id, at, { state: req.state }, { state: "awaiting_record", decision: "new", proposalId: proposal.id, confirmedOutside: true })],
      updates: [update(req, { state: "awaiting_record", at, ttl, decision, extra: { proposalId: proposal.id } })],
    });
    const emailSent = await mailTo(req.email, "awaiting_record");
    await mirrorGuard(req, "awaiting_record", ttl);
    return { state: "awaiting_record", emailSent, proposalId: proposal.id };
  }

  async function decline(actor, req, input) {
    const at = iso();
    const ttl = sec() + DECIDED_TTL_SECONDS;
    const decision = { kind: "decline", by: actor.id, at, ...(input.note ? { note: input.note } : {}), noteSent: Boolean(input.note && input.sendNote) };
    await commit({
      puts: [audit("accessreq.decide", req, actor.id, at, { state: req.state }, { state: "declined", decision: "decline", noteSent: decision.noteSent })],
      // the duplicate guard follows the request: a declined address may ask again, and the stub goes 30 days after the decline
      updates: [update(req, { state: "declined", at, ttl, decision }), guardUpdate(req, "declined", ttl)],
    });
    const emailSent = await mailTo(req.email, "declined", input.note && input.sendNote ? { note: input.note } : {});
    return { state: "declined", emailSent };
  }

  // ---- revoke -------------------------------------------------------------------------------------------------------------------
  async function revoke(actor, id, body) {
    requireAdmin(actor);
    checkId(id);
    const b = isObj(body) ? body : null;
    const errors = [];
    if (!b) throw validation([{ pointer: "", detail: "the body is an object" }]);
    for (const k of Object.keys(b)) if (!["version", "reason", "confirmedOutside"].includes(k)) errors.push({ pointer: `/${k}`, detail: "not a field of this request" });
    if (!Number.isInteger(b.version) || b.version < 1) errors.push({ pointer: "/version", detail: "version is the number the request carries" });
    if (b.confirmedOutside !== true) errors.push({ pointer: "/confirmedOutside", detail: "confirm with this person outside the site first" });
    if (b.reason !== undefined && b.reason !== null && (typeof b.reason !== "string" || b.reason.length > MAX_REASON_CHARS)) errors.push({ pointer: "/reason", detail: `reason is text of at most ${MAX_REASON_CHARS} characters` });
    if (errors.length) throw validation(errors);
    requireRecentSignIn(actor, now());
    const reason = typeof b.reason === "string" && b.reason.trim() ? b.reason.trim() : undefined;
    if (reason) guard("access-requests", "revoke", [["/reason", reason]]);
    const req = await need(id);
    if (req.state !== "active" || req.version !== b.version) throw conflict(req);
    const sub = req.decision?.grampsId;
    if (typeof sub !== "string" || !sub) throw conflict(req);
    return finishRevoke(actor, req, { sub, reason, revokedBy: actor.id, kind: "revoke" });
  }

  /** ALLOW# to revoked (the item stays, so it keeps overriding io's S3 file), the request to revoked, the audits and the guard: one transaction. No mail. */
  async function finishRevoke(actor, req, { sub, reason, revokedBy, kind }) {
    const at = iso();
    const ttl = sec() + DECIDED_TTL_SECONDS;
    const rv = revokeItems({ email: req.email, sub, at, by: revokedBy, ...(reason ? { reason } : {}), uid: uid(), table });
    const decision = { ...(req.decision ?? {}), revoked: { by: revokedBy, at, ...(kind === "object" ? { byMember: true } : {}), ...(reason ? { reason } : {}) } };
    await commit({
      puts: [...rv.puts, audit(kind === "object" ? "accessreq.object" : "accessreq.revoke", req, actor.id, at, { state: req.state }, { state: "revoked", sub }, reason)],
      updates: [...rv.updates, update(req, { state: "revoked", at, ttl, decision }), guardUpdate(req, "declined", ttl)],
    });
    return { state: "revoked" };
  }

  // ---- the member answers a second email ------------------------------------------------------------------------------------------
  async function respondSecondEmail(actor, id, body) {
    checkId(id);
    const b = isObj(body) ? body : {};
    if (b.response !== "confirm" && b.response !== "object") throw validation([{ pointer: "/response", detail: "response is confirm or object" }]);
    const req = await loadRequest(id);
    // not the member's request: the same 404 as no request, so the route reveals nothing about requests that are not theirs
    if (!req || req.state === "pending" || !req.hold || req.hold.grampsId !== actor.id) throw new HttpError(404, "not_found", "no such request");
    const open = req.state === "active" && Date.parse(req.hold.until) > now();
    if (b.response === "confirm") {
      if (req.state === "active" && !open) return { state: "active", effective: true }; // the window ran out: it already counts
      if (!open) throw new HttpError(409, "window_closed", "that is no longer open");
      return confirmHold(actor, req);
    }
    if (!open) throw new HttpError(409, "window_closed", "that is no longer open");
    return finishRevoke(actor, req, { sub: actor.id, reason: "member_objected", revokedBy: actor.id, kind: "object" });
  }

  async function confirmHold(actor, req) {
    const at = iso();
    const decision = { ...(req.decision ?? {}), confirmedByMember: at };
    await commit({
      puts: [audit("accessreq.confirm", req, actor.id, at, { state: "active", effectiveAt: req.hold.until }, { state: "active", effective: true })],
      updates: [
        {
          key: allowKeys(req.email),
          update: "REMOVE #eff",
          condition: "attribute_exists(PK) AND #state = :active AND #sub = :sub",
          names: { "#eff": "effectiveAt", "#state": "state", "#sub": "sub" },
          values: { ":active": "active", ":sub": actor.id },
          tag: "allow.confirm",
        },
        update(req, { state: "active", at, ttl: req.ttl, decision, extra: { hold: { until: req.hold.until, grampsId: actor.id, confirmedAt: at } } }),
      ],
    });
    return { state: "active", effective: true };
  }

  // ---- the link as the approval completes it (Q2-03) ---------------------------------------------------------------------------
  /**
   * The link transaction as a transact() fragment `{ puts, updates }`, or null when the request cannot be linked now (not awaiting_record, or the
   * address already has access). The approval of the person.create proposal merges it into its own transaction (records/proposals.js
   * approvalHookFragment), so the link commits with the approval or not at all.
   */
  async function completeAccessRequest({ requestId, grampsId, by, at }) {
    const req = await loadRequest(requestId);
    if (!req || req.state !== "awaiting_record" || typeof grampsId !== "string" || !grampsId) return null;
    if (await alreadyMember(req)) return null;
    const when = typeof at === "string" ? at : iso();
    const admin = req.decision?.by ?? by ?? "system:access_request";
    const decision = { ...(req.decision ?? {}), kind: "link", via: "record", grampsId, completedAt: when, ...(by ? { completedBy: by } : {}) };
    const grant = grantItems({ email: req.email, sub: grampsId, source: "access-request", requestId: req.id, at: when, by: admin, uid: uid(), table });
    const ttl = sec() + DECIDED_TTL_SECONDS;
    return {
      puts: [...grant.puts, audit("accessreq.decide", req, by ?? admin, when, { state: "awaiting_record" }, { state: "active", decision: "link", sub: grampsId, via: "record", confirmedOutside: req.decision?.confirmedOutside === true })],
      updates: [update(req, { state: "active", at: when, ttl, decision })],
    };
  }

  /** After the approval commits: the requester is told, the other admins are told, the stub of the guard is shortened. Never throws. */
  async function afterComplete({ requestId, grampsId, by }) {
    await after("completion notice", async () => {
      const req = await loadRequest(requestId);
      if (!req || req.state !== "active" || req.decision?.grampsId !== grampsId) return;
      await mailTo(req.email, "approved");
      await mirrorGuard(req, "active", req.ttl);
      await tellAdmins({ id: by ?? "", label: "an admin" }, req);
    });
  }

  /** The desktop assigned the Gramps ID (assign mode): link the request that is awaiting this Person. Used as idPolicy.completeAccessRequest. */
  async function completeById(requestId, grampsId) {
    const frag = await completeAccessRequest({ requestId, grampsId });
    if (!frag) return false;
    await commit(frag);
    await afterComplete({ requestId, grampsId });
    return true;
  }

  /** Which awaiting_record request a created Person came from (assign mode: the approval minted no id). Used as idPolicy.accessRequestOf. */
  async function accessRequestOf({ class: cls, handle, store }) {
    if (cls !== "Person" || typeof handle !== "string") return undefined;
    const ctx = store ?? { ddb, cmds, table };
    const r = await send(new cmds.QueryCommand({
      TableName: table, IndexName: "GSI1", KeyConditionExpression: "GSI1PK = :pk", ExpressionAttributeValues: { ":pk": partition("awaiting_record") }, Limit: 100,
    }));
    for (const it of r.Items ?? []) {
      if (typeof it.proposalId !== "string") continue;
      const p = await loadProposal(ctx, it.proposalId);
      if (p?.state === "approved" && isObj(p.decision?.applied) && Object.hasOwn(p.decision.applied, `Person:${handle}`)) return it.id;
    }
    return undefined;
  }

  // ---- the facts a link adds to the person's page (7.4 "Post-commit") --------------------------------------------------------------
  /**
   * A system proposal, reviewed like any other, for the Gramps-mapped facts the person's page lacks: the nickname, a graduation and degrees. The
   * place-bound facts (birthplace, residence) wait for the admin UI's place matching. Best effort; the email never moves.
   */
  async function proposeFacts(store, req, grampsId) {
    if (!store) return;
    const heads = await byGrampsId(store, "Person", grampsId);
    if (heads.length !== 1) return;
    const head = await get(store, "Person", heads[0].handle);
    if (!head) return;
    const have = new Set();
    for (const ref of Array.isArray(head.obj.event_ref_list) ? head.obj.event_ref_list : []) {
      const ev = typeof ref?.ref === "string" ? await get(store, "Event", ref.ref) : null;
      if (ev) have.add(ev.obj.type?.value);
    }
    const key = `Person:${head.obj.handle ?? heads[0].handle}`;
    const ops = [];
    const nick = req.form?.nickname;
    if (typeof nick === "string" && nick && !head.obj.primary_name?.nick) ops.push({ id: "nick", op: "set", obj: key, path: "/primary_name/nick", base: head.obj.primary_name?.nick ?? "", value: nick });
    const mapped = previewOf(req.form, req.email);
    let n = 0;
    for (const ev of mapped?.events ?? []) {
      const type = ev.type?.value;
      if ((type !== EVENT_TYPES.GRADUATION && type !== EVENT_TYPES.DEGREE) || have.has(type)) continue;
      n += 1;
      const temp = `new:${n}`;
      ops.push({ id: `event-${n}`, op: "create", obj: temp, cls: "Event", value: eventValue({ type, date: dateFrom(ev.date, new Date(now()).getUTCFullYear() + 1, "", []), description: ev.description ?? "" }) });
      ops.push({ id: `ref-${n}`, op: "add", obj: key, path: "/event_ref_list", value: eventRef(temp) });
    }
    if (!ops.length) return;
    await createSystem(store, { kind: n > 0 ? "create" : "edit", ops, origin: "access_request", requestId: `${req.id}-facts`, base_versions: { [key]: head.version } });
  }

  return { list, get: getOne, decide, revoke, respondSecondEmail, completeAccessRequest, afterComplete, completeById, accessRequestOf };
}
