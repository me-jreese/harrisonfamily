// HFY-TSK-264 (surf-access-admin-ui): the pure model of /me/requests/ on invented rows. The matcher (maiden surname, given-name tokens, birth
// year within 2, birthplace), the place matcher against a stubbed /place/index.json, the editable preview, the decision bodies and the words.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mapToGramps } from "../../shared/legacy-form.mjs";
import {
  COPY, TABS, answersOf, applyUniquePlaces, askedAgo, bornLine, declineBody, describeError, editPreview, fold, givenOverlap, linkBody, locationFor, matchPlaces,
  newBody, parseLocation, placeChoices, previewFields, rankCandidates, requesterName, tidyPreviewNames, resultLine, revokeBody, REVOKE_PATH, saveDraft, loadDraft, clearDraft, markStepUp, takeStepUp, revokeTarget, NO_MEMBER_ID, removePrompt, scoreCandidate, setEventPlace, stateWords,
} from "../src/lib/access-requests-model.js";

const PEOPLE = [
  { grampsId: "I9001", displayName: "Tessa Example", givenName: "Tessa", surname: "Example", birthYear: 1980, isLiving: true, lifespanSummary: "1980 -" },
  { grampsId: "I9002", displayName: "Tessa Marie Example", givenName: "Tessa Marie", surname: "Example", birthYear: 1990, isLiving: true },
  { grampsId: "I9003", displayName: "Tessa Example", givenName: "Tessa", surname: "Example", birthYear: 1925, isLiving: false, lifespanSummary: "1925 - 1999" },
  { grampsId: "I9004", displayName: "Sam Sample", givenName: "Sam", surname: "Sample", birthYear: 1980, isLiving: true },
  { grampsId: "I9005", displayName: "Zoë Exemplar", givenName: "Zoë", surname: "Exemplar", birthYear: 1981, isLiving: true, birthPlaceHandle: "hplace1" },
  { grampsId: "I9006", displayName: "Tess Example", givenName: "Tess", surname: "Example", birthYear: 1983, isLiving: true },
];
const PLACES = [
  { handle: "hplace1", grampsId: "P9001", displayName: "Springfield, Exampleland, Testia" },
  { handle: "hplace2", grampsId: "P9002", displayName: "Springfield, Otherstate, Testia" },
  { handle: "hplace3", grampsId: "P9003", displayName: "Fakeville, Exampleland, Testia" },
];
const REQ = { givenNames: "TESSA", maidenSurname: "example", birthYear: 1981, birthPlace: "Fakeville, Exampleland" };

test("fold and givenOverlap ignore case, accents and punctuation; an initial matches", () => {
  assert.equal(fold("  Zoë  O'Neil "), "zoe oneil");
  assert.equal(givenOverlap("Tessa Marie", "Tessa Marie"), 1);
  assert.equal(givenOverlap("Tessa Marie", "Tessa"), 0.5);
  assert.equal(givenOverlap("T Marie", "Tessa Marie"), 1);
  assert.equal(givenOverlap("", "Tessa"), 0);
  assert.equal(givenOverlap("Tessa", ""), 0);
});

test("the surname, given names, a birth year within 2 and the birthplace all add to the score, and nothing scores without a name match", () => {
  const exact = scoreCandidate({ ...REQ, birthYear: 1980 }, PEOPLE[0]);
  const near = scoreCandidate({ ...REQ, birthYear: 1981 }, PEOPLE[0]);
  const two = scoreCandidate({ ...REQ, birthYear: 1982 }, PEOPLE[0]);
  const far = scoreCandidate({ ...REQ, birthYear: 1983 }, PEOPLE[0]);
  assert.ok(exact.score > near.score && near.score > two.score && two.score > far.score);
  assert.deepEqual(far.reasons, ["last name", "first name"]);
  assert.ok(exact.reasons.includes("birth year"));
  // a birth year alone is not a candidate
  assert.deepEqual(scoreCandidate({ givenNames: "Nobody", maidenSurname: "Nowhere", birthYear: 1980 }, PEOPLE[3]), { score: 0, reasons: [] });
  const placed = scoreCandidate({ givenNames: "Zoe", maidenSurname: "Exemplar", birthYear: 1981 }, PEOPLE[4], { placeHandles: new Set(["hplace1"]) });
  const unplaced = scoreCandidate({ givenNames: "Zoe", maidenSurname: "Exemplar", birthYear: 1981 }, PEOPLE[4], { placeHandles: new Set() });
  assert.equal(placed.score - unplaced.score, 2);
  assert.ok(placed.reasons.includes("birthplace"));
  // an index row that carries the place name instead of a handle
  const named = scoreCandidate({ givenNames: "Zoe", maidenSurname: "Exemplar", birthPlace: "Fakeville, Exampleland" }, { ...PEOPLE[4], birthPlaceHandle: undefined, birthPlace: "Fakeville, Exampleland" });
  assert.ok(named.reasons.includes("birthplace"));
});

test("rankCandidates: best first, the deceased and non-matches left out", () => {
  const out = rankCandidates(REQ, PEOPLE, PLACES);
  // I9001: surname + name + year within 1; I9002: surname + name, year too far; I9006: surname only ("Tess" is not "Tessa"), year within 2
  assert.deepEqual(out.map((c) => c.id), ["I9001", "I9002", "I9006"]);
  assert.ok(!out.some((c) => c.id === "I9003"), "a deceased person is never offered");
  assert.ok(!out.some((c) => c.id === "I9004"));
  assert.ok(out.every((c, i) => i === 0 || out[i - 1].score >= c.score));
});

test("rankCandidates limits to five and survives junk input", () => {
  const many = Array.from({ length: 9 }, (_, i) => ({ grampsId: `I90${10 + i}`, displayName: `Tessa Example${i}`, givenName: "Tessa", surname: "Example", birthYear: 1980, isLiving: true }));
  assert.equal(rankCandidates(REQ, many, []).length, 5);
  assert.deepEqual(rankCandidates(REQ, null), []);
  assert.deepEqual(rankCandidates(REQ, [null, {}, { grampsId: 7 }], null), []);
  assert.deepEqual(rankCandidates({}, PEOPLE), []);
});

test("rankCandidates falls back to the display name when the row has no split name", () => {
  const out = rankCandidates({ givenNames: "Sam", maidenSurname: "Sample", birthYear: 1980 }, [{ grampsId: "I9100", displayName: "Sam Sample", isLiving: true, birthYear: 1980 }]);
  assert.equal(out[0].id, "I9100");
  assert.equal(out[0].line, "born 1980");
});

test("matchPlaces runs on a stubbed place index: city plus state, a bare city is every place of that name", () => {
  assert.deepEqual(matchPlaces("Springfield, Exampleland", PLACES).map((p) => p.handle), ["hplace1"]);
  assert.deepEqual(matchPlaces("springfield", PLACES).map((p) => p.handle), ["hplace1", "hplace2"]);
  assert.deepEqual(matchPlaces("Springfield, Nowhere", PLACES), []);
  assert.deepEqual(matchPlaces("", PLACES), []);
  assert.deepEqual(matchPlaces("Springfield", null), []);
});

test("rankCandidates scores a birthplace through the place index", () => {
  const req = { givenNames: "Zoe", maidenSurname: "Exemplar", birthYear: 1981, birthPlace: "Springfield, Exampleland" };
  const a = rankCandidates(req, PEOPLE, PLACES)[0];
  const b = rankCandidates(req, PEOPLE, [])[0];
  assert.equal(a.id, "I9005");
  assert.equal(a.score - b.score, 2);
});

test("the list words: name, born line, relative time, state words, answers", () => {
  assert.equal(requesterName({ givenNames: "TESSA marie", maidenSurname: "o'neil-example" }), "Tessa Marie O'Neil-Example");
  assert.equal(bornLine({ birthYear: 1981, birthPlace: "Fakeville, EX" }), "born 1981 · Fakeville, EX");
  assert.equal(bornLine({ birthYear: null, birthPlace: "Fakeville, EX" }), "Fakeville, EX");
  const now = Date.parse("2026-10-14T12:00:00Z");
  assert.equal(askedAgo("2026-10-11T12:00:00Z", now), "asked 3 days ago");
  assert.equal(askedAgo("2026-10-13T11:00:00Z", now), "asked 1 day ago");
  assert.equal(askedAgo("2026-10-14T10:00:00Z", now), "asked 2 hours ago");
  assert.equal(askedAgo("2026-10-14T11:59:30Z", now), "asked just now");
  assert.equal(askedAgo("2026-09-01T12:00:00Z", now), "asked 1 month ago");
  assert.equal(askedAgo("nope", now), "");
  assert.equal(stateWords("awaiting_record"), "adding to the tree");
  assert.equal(stateWords("revoked"), "access removed");
  assert.deepEqual(answersOf({ givenNames: "Tessa", everMarried: "never_married", otherDegreeYears: [2001, 2004], university: "" }).map((r) => [r.label, r.value]), [
    ["given names", "Tessa"], ["ever married", "never married"], ["degree years", "2001, 2004"],
  ]);
  assert.deepEqual(answersOf(null), []);
});

test("the address: tab and id round trip and a stray value falls back", () => {
  assert.deepEqual(parseLocation("?tab=tree&id=abc_1"), { tab: "tree", id: "abc_1" });
  assert.deepEqual(parseLocation("?tab=zzz&id=../x"), { tab: "waiting", id: null });
  assert.equal(locationFor({ tab: "waiting", id: null }), "");
  assert.equal(locationFor({ tab: "done", id: "abc" }), "?tab=done&id=abc");
  assert.deepEqual(TABS.map((t) => t.label), ["waiting", "adding to the tree", "done"]);
});

const FORM = { email: "x@example.test", givenNames: "Tessa", maidenSurname: "Example", gender: "female", birthPlace: "Springfield, Exampleland", birthYear: "1981", currentPlace: "Fakeville, Exampleland", forSelf: true };
const preview = () => mapToGramps(FORM, { storeCurrentCity: true, now: Date.parse("2026-10-14T00:00:00Z") });

test("the editable preview: fields read back, edits change a copy, places are set by handle", () => {
  const p = preview();
  assert.deepEqual(previewFields(p), { given: "Tessa", surname: "Example", nick: "", gender: 0, birthYear: "1981" });
  const edited = editPreview(editPreview(editPreview(p, "given", "Tess"), "nick", "Tessie"), "birthYear", "1982");
  assert.deepEqual(previewFields(edited), { given: "Tess", surname: "Example", nick: "Tessie", gender: 0, birthYear: "1982" });
  assert.equal(previewFields(p).given, "Tessa", "the original is untouched");
  assert.equal(previewFields(editPreview(edited, "nick", "")).nick, "");
  assert.equal(previewFields(editPreview(p, "gender", 1)).gender, 1);
  assert.equal(previewFields(editPreview(p, "surname", "Sample")).surname, "Sample");
  assert.equal(previewFields(editPreview(p, "birthYear", "abc")).birthYear, "");
  const placed = setEventPlace(p, "birth", "hplace1");
  assert.equal(placed.events.find((e) => e.hfyKey === "birth").place, "hplace1");
  assert.equal(p.events.find((e) => e.hfyKey === "birth").place, "");
});

test("tidyPreviewNames proper-cases the two names and nothing else", () => {
  const p = mapToGramps({ ...FORM, givenNames: "tessa marie", maidenSurname: "O'NEIL", nickname: "tessie" }, { now: Date.parse("2026-10-14T00:00:00Z") });
  const t = tidyPreviewNames(p);
  assert.deepEqual(previewFields(t), { given: "Tessa Marie", surname: "O'Neil", nick: "tessie", gender: 0, birthYear: "1981" });
});

test("placeChoices and applyUniquePlaces: a single match is chosen, several are left to the admin", () => {
  const p = preview();
  const c = placeChoices(p, PLACES);
  assert.deepEqual(c.map((x) => [x.eventKey, x.matches.length, x.ambiguous]), [["birth", 1, false], ["residence", 1, false]]);
  const applied = applyUniquePlaces(p, PLACES);
  assert.equal(applied.events.find((e) => e.hfyKey === "birth").place, "hplace1");
  assert.equal(applied.events.find((e) => e.hfyKey === "residence").place, "hplace3");
  const two = placeChoices(p, [...PLACES, { handle: "hplace4", grampsId: "P9004", displayName: "Springfield, Exampleland, Elsewhere" }]);
  assert.equal(two[0].ambiguous, true);
  assert.equal(applyUniquePlaces(p, [...PLACES, { handle: "hplace4", grampsId: "P9004", displayName: "Springfield, Exampleland, Elsewhere" }]).events.find((e) => e.hfyKey === "birth").place, "");
});

test("the decision bodies carry the confirmed-outside flag only as true, and a note only with text", () => {
  assert.deepEqual(linkBody({ grampsId: "I9001", version: 3, confirmedOutside: true }), { decision: "link", grampsId: "I9001", version: 3, confirmedOutside: true });
  assert.equal(linkBody({ grampsId: "I9001", version: 3, confirmedOutside: "yes" }).confirmedOutside, false);
  assert.equal(linkBody({ grampsId: "I9001", version: 3, confirmedOutside: true, allowSecondEmail: true }).allowSecondEmail, true);
  assert.equal(newBody({ preview: { a: 1 }, version: 2, confirmedOutside: true }).decision, "new");
  assert.deepEqual(declineBody({ note: "  ", sendNote: true, version: 1 }), { decision: "decline", version: 1 });
  assert.deepEqual(declineBody({ note: " hello ", sendNote: true, version: 1 }), { decision: "decline", version: 1, note: "hello", sendNote: true });
  assert.deepEqual(declineBody({ note: "hello", version: 1 }), { decision: "decline", version: 1, note: "hello", sendNote: false });
  assert.deepEqual(revokeBody({ grampsId: "I9001", confirmedOutside: true, reason: " " }), { grampsId: "I9001", confirmedOutside: true });
  assert.deepEqual(revokeBody({ grampsId: "I9001", confirmedOutside: "yes", reason: " why " }), { grampsId: "I9001", confirmedOutside: false, reason: "why" });
  assert.equal(REVOKE_PATH, "/allow-grants/revoke");
});

test("result and error words (surfaces.md 7.10, DS voice: lowercase, no exclamation marks)", () => {
  assert.equal(resultLine({ state: "active", emailSent: true }), "done. we emailed them.");
  assert.equal(resultLine({ state: "active", emailSent: false }), "done, but the email didn't send. let them know yourself.");
  assert.equal(resultLine({ state: "revoked" }, { revoke: true }), `${COPY.doneRemoved} ${COPY.byHand}`);
  const e = (status, code, extra = {}) => describeError({ status, code, ...extra });
  assert.equal(e(401, "step_up_required").kind, "signin");
  assert.equal(e(409, "conflict").kind, "reload");
  assert.equal(e(409, "already_member").kind, "plain");
  assert.equal(e(409, "second_email").kind, "second");
  assert.equal(e(403, "owner_only").kind, "plain");
  assert.equal(e(403, "not_admin").text, COPY.notAdmin);
  assert.equal(e(422, "unknown_person").text, "that person isn't in the tree.");
  assert.equal(e(400, "validation", { errors: [{ pointer: "/x" }] }).errors.length, 1);
  assert.equal(e(503, "unavailable").text, COPY.loadFailed);
  const all = [...Object.values(COPY).flatMap((v) => (typeof v === "string" ? [v] : Object.values(v))), ...[401, 403, 404, 409, 422, 400, 503].map((s) => e(s, "x").text)];
  for (const t of all) {
    assert.equal(t, t.toLowerCase(), `lowercase: ${t}`);
    assert.ok(!t.includes("!"), `no exclamation mark: ${t}`);
    assert.ok(!/\brecord\b/i.test(t), `says page, not record: ${t}`);
  }
});

test("free-text birth place: the city must equal the first segment, not just start it", () => {
  const row = { grampsId: "I9100", displayName: "Tessa Example", givenName: "Tessa", surname: "Example", isLiving: true };
  const req = { givenNames: "Tessa", maidenSurname: "Example", birthPlace: "York, Exampleland" };
  assert.ok(!scoreCandidate(req, { ...row, birthPlace: "Yorktown, Exampleland" }).reasons.includes("birthplace"));
  assert.ok(!scoreCandidate({ ...req, birthPlace: "Ann" }, { ...row, birthPlace: "Annapolis, Exampleland" }).reasons.includes("birthplace"));
  assert.ok(scoreCandidate(req, { ...row, birthPlace: "York, Exampleland" }).reasons.includes("birthplace"));
  assert.ok(!scoreCandidate(req, { ...row, birthPlace: "York, Otherland" }).reasons.includes("birthplace"));
});

test("revoke errors have their own words, and other routes keep theirs", () => {
  const e = (status, code, o) => describeError({ status, code }, o);
  assert.match(e(404, "not_found", { revoke: true }).text, /no access to remove/);
  assert.match(e(422, "too_many", { revoke: true }).text, /more ways in/);
  assert.equal(e(404, "not_found").text, "that request isn't there anymore.");
  assert.equal(e(401, "step_up_required", { revoke: true }).kind, "signin");
});

test("a preview draft round-trips through storage, and a missing or broken storage is no draft", () => {
  const mem = new Map();
  const st = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, v), removeItem: (k) => mem.delete(k) };
  saveDraft("req1", { person: { nick: "Tessie" } }, st);
  assert.deepEqual(loadDraft("req1", st), { person: { nick: "Tessie" } });
  assert.equal(loadDraft("req2", st), null);
  clearDraft("req1", st);
  assert.equal(loadDraft("req1", st), null);
  mem.set("hfy-requests-draft:bad", "{not json");
  assert.equal(loadDraft("bad", st), null);
  const boom = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); }, removeItem() { throw new Error("blocked"); } };
  saveDraft("v", { a: 1 }, st, { version: 3, now: 1000 });
  assert.deepEqual(loadDraft("v", st, { version: 3, now: 2000 }), { a: 1 });
  assert.equal(loadDraft("v", st, { version: 4, now: 2000 }), null, "another version of the request");
  assert.equal(loadDraft("v", st, { version: 3, now: 1000 + 61 * 60 * 1000 }), null, "older than an hour");
  assert.equal(takeStepUp("v", st), false);
  markStepUp("v", st);
  assert.equal(takeStepUp("v", st), true);
  assert.equal(takeStepUp("v", st), false, "read once");
  markStepUp("v", st);
  clearDraft("v", st);
  assert.equal(takeStepUp("v", st), false, "clearing a draft clears the flag");
  assert.doesNotThrow(() => { saveDraft("x", { a: 1 }, boom); clearDraft("x", boom); });
  assert.equal(loadDraft("x", boom), null);
  assert.equal(loadDraft("x", null), null);
});

test("revokeTarget uses the linked person, else null; resultLine counts what was removed and never claims every email went", () => {
  assert.equal(revokeTarget({ decision: { grampsId: " I9001 " }, hold: { until: "2030-01-01T00:00:00Z", noticed: true } }), "I9001");
  assert.equal(revokeTarget({ hold: { until: "2030-01-01T00:00:00Z", noticed: true } }), null);
  assert.equal(revokeTarget({ decision: {} }), null);
  assert.equal(revokeTarget(null), null);
  assert.match(NO_MEMBER_ID, /no access to remove/);
  assert.equal(resultLine({ revoked: [{ email: "a***@example.test" }, { email: "b***@example.test" }] }, { revoke: true }), `done. 2 ways in were removed. ${COPY.byHand}`);
  assert.equal(resultLine({ revoked: [{ email: "a***@example.test" }] }, { revoke: true }), `done. 1 way in was removed. ${COPY.byHand}`);
  assert.equal(resultLine({}, { revoke: true }), `${COPY.doneRemoved} ${COPY.byHand}`);
  // the grant revoke leaves io's S3 allowlist file alone (allowlist-store: a file address with no ALLOW# item still signs in)
  for (const words of [removePrompt("Tessa Example"), resultLine({ revoked: [{ email: "a***@example.test" }] }, { revoke: true }), resultLine({}, { revoke: true })]) {
    assert.match(words, /may still work/);
    assert.doesNotMatch(words, /every email they use|all of their ways in|their access is removed/);
  }
  assert.doesNotMatch(describeError({ status: 400, code: "validation" }, { revoke: true }).text, /outside the site/);
});
