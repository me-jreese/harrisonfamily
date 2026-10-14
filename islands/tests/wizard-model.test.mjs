// HFY-TSK-158 (relationship-wizard-island): the pure half (src/lib/wizard-model.js). The four flows end in the intent JSON the server compiles and a
// sentence summary; Back and Undo restore the draft; the duplicate answers; the draft kept in sessionStorage; the words for every error.
// Synthetic people only (ids I9001.., handles hsyn..).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  COPY, FLOWS, MAX_KIDS, addKid, answerDifferent, answerSame, back, canBack, canUndo, changeKid, chooseParent, chooseParentRel, chooseRole, chooseUnlink, clearDraft, confirmDistinct,
  confirmUnlink, edit, editLine, freshState, go, intentOf, kidsDone, kidsLookRight, loadDraft, moreParents, panelLines, parseYear, partsText, previewView, problemOf, refWho, removeKid, restart,
  restoreState, rolesLeft, roleGender, routeId, saveDraft, sentenceLines, sentencesOf, setEndYear, setEnded, setKidRelMe, setKidRelOther, setOtherParent, setPlace, setRelType, setSpouse, setYear,
  settle, startFlow, stepOf, stubUids, stubWho, undo, unansweredDuplicates, unlinkChoices, validateStubForm, whoName, wizardHref
} from "../src/lib/wizard-model.js";

const ME = { handle: "hsyn0001", gid: "I9001" };
const NOW = 2026;
const ref = (handle, gid, name, lifespan = "") => refWho({ handle, gid, name, lifespan });
const MOTHER = ref("hsyn0002", "I9002", "Tessa Example");
const text = (state) => sentencesOf(state).map(partsText);
const stubOf = (state, form) => stubWho(state.draft, { gender: "unknown", living: "unknown", ...form }, { nowYear: NOW });
const memory = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m };
};

describe("flow: my parents (AC1)", () => {
  it("a picked mother and a new father end in the parents intent and the sentences", () => {
    let s = startFlow(freshState(), "parents");
    assert.equal(s.screen, "p.which");
    s = chooseRole(s, "mother");
    assert.equal(s.screen, "p.who");
    s = chooseParent(s, MOTHER);
    assert.equal(s.screen, "p.rel");
    s = chooseParentRel(s, "birth");
    assert.equal(s.screen, "p.more");
    s = moreParents(s, true);
    assert.deepEqual(rolesLeft(s.draft), ["father", "other"], "a mother is not offered twice");
    s = chooseRole(s, "father");
    const who = stubOf(s, { given: "Orrin", surname: "Example", gender: roleGender("father"), birthYear: "1950", living: "no", deathYear: "2010" });
    s = chooseParent(s, who);
    s = chooseParentRel(s, "adopted");
    assert.equal(s.screen, "check", "two parents is the most: straight to the check");
    assert.deepEqual(intentOf(s, ME), {
      type: "parents", person: "Person:hsyn0001",
      parents: [
        { who: { ref: "Person:hsyn0002" }, rel: "birth" },
        { who: { new: { given: "Orrin", surname: "Example", gender: "male", birthYear: 1950, living: "no", deathYear: 2010 } }, rel: "adopted" },
      ],
    });
    assert.deepEqual(text(s), ["Tessa Example is your birth mother.", "Orrin Example is your adoptive father.", "they are listed together as your parents."]);
    assert.deepEqual(stubUids(s), ["u1"]);
  });

  it("one parent, then 'that's all'", () => {
    let s = chooseRole(startFlow(freshState(), "parents"), "other");
    s = chooseParentRel(chooseParent(s, MOTHER), "foster");
    s = moreParents(s, false);
    assert.equal(s.screen, "check");
    assert.deepEqual(intentOf(s, ME).parents, [{ who: { ref: "Person:hsyn0002" }, rel: "foster" }]);
    assert.deepEqual(text(s), ["Tessa Example is your foster parent."]);
  });

  it("the choices are in plain words, with the rare ones apart", async () => {
    const { parentChoices, childChoices } = await import("../src/lib/wizard-model.js");
    const m = parentChoices("mother");
    assert.deepEqual(m.main.map((c) => c.label), ["birth mother", "adoptive mother", "stepmother", "foster mother", "not sure"]);
    assert.deepEqual(m.more.map((c) => c.value), ["sponsored", "none"]);
    assert.deepEqual(parentChoices("father").main.map((c) => c.value), ["birth", "adopted", "step", "foster", "unknown"]);
    assert.equal(childChoices().main[0].label, "birth child");
  });
});

describe("flow: my children (AC1)", () => {
  const withOther = (other) => {
    let s = startFlow(freshState(), "children");
    return setOtherParent(s, other);
  };
  it("a pre-listed partner, one picked child and one new child, with a changed relation", () => {
    let s = withOther(ref("hsyn0003", "I9003", "Pat Example"));
    assert.equal(s.screen, "c.add");
    s = addKid(s, ref("hsyn0004", "I9004", "Sam Example"));
    s = addKid(s, stubOf(s, { given: "Wren", surname: "Example", birthYear: "2015", living: "yes" }));
    assert.equal(s.draft.kids.length, 2);
    s = kidsDone(s);
    assert.equal(s.screen, "c.rel");
    s = changeKid(s, 1);
    assert.equal(s.screen, "c.relMe");
    s = setKidRelMe(s, "adopted");
    assert.equal(s.screen, "c.relOther", "a known other parent is asked about too");
    s = setKidRelOther(s, "step");
    assert.equal(s.screen, "c.rel");
    s = kidsLookRight(s);
    assert.equal(s.screen, "check");
    assert.deepEqual(intentOf(s, ME), {
      type: "children", person: "Person:hsyn0001", otherParent: { ref: "Person:hsyn0003" },
      children: [
        { who: { ref: "Person:hsyn0004" }, relToMe: "birth", relToOther: "birth" },
        { who: { new: { given: "Wren", surname: "Example", gender: "unknown", birthYear: 2015, living: "yes", deathYear: null } }, relToMe: "adopted", relToOther: "step" },
      ],
    });
    assert.deepEqual(text(s), ["Sam Example is the birth child of you and Pat Example.", "Wren Example is your adopted child, and the stepchild of Pat Example."]);
  });

  it("'I'd rather not say' sends { unknown: true } and no relToOther", () => {
    let s = withOther({ unknown: true });
    s = addKid(s, ref("hsyn0004", "I9004", "Sam Example"));
    s = kidsLookRight(kidsDone(s));
    assert.deepEqual(intentOf(s, ME), { type: "children", person: "Person:hsyn0001", otherParent: { unknown: true }, children: [{ who: { ref: "Person:hsyn0004" }, relToMe: "birth" }] });
    assert.deepEqual(text(s), ["Sam Example is your birth child.", "the other parent isn't named."]);
    // no other parent: changing a child's relation asks only the one question
    let t = changeKid(kidsDone(addKid(withOther({ unknown: true }), MOTHER)), 0);
    assert.equal(setKidRelMe(t, "foster").screen, "c.rel");
  });

  it("a new other parent is the first new person on the server's list", () => {
    let s = withOther(stubOf(freshState(), { given: "Pat", surname: "Example" }));
    s = addKid(s, stubOf(s, { given: "Wren", surname: "Example" }));
    assert.deepEqual(stubUids(s), ["u1", "u2"]);
    assert.equal(s.draft.uidn, 2);
  });

  it("at most ten children at a time; a removed child is one Undo away", () => {
    let s = withOther({ unknown: true });
    for (let i = 0; i < MAX_KIDS + 3; i += 1) s = addKid(s, ref(`hsyn1${i}`, `I91${i}`, `Kid ${i}`));
    assert.equal(s.draft.kids.length, MAX_KIDS);
    const before = s.draft.kids.length;
    s = removeKid(s, 0);
    assert.equal(s.draft.kids.length, before - 1);
    s = undo(s);
    assert.equal(s.draft.kids.length, before);
  });
});

describe("flow: my spouse or partner (AC1)", () => {
  it("married with a year, a place and a divorce", () => {
    let s = setSpouse(startFlow(freshState(), "spouse"), ref("hsyn0005", "I9005", "Alex Example"));
    assert.equal(s.screen, "s.type");
    s = setRelType(s, "married");
    assert.equal(s.screen, "s.year");
    s = setYear(s, { year: 1990, about: true });
    assert.equal(s.screen, "s.place");
    s = setPlace(s, { ref: "Place:hsynp1", name: "Springfield" });
    assert.equal(s.screen, "s.end");
    s = setEnded(s, "divorced");
    assert.equal(s.screen, "s.endYear");
    s = setEndYear(s, 2001);
    assert.equal(s.screen, "check");
    assert.deepEqual(intentOf(s, ME), {
      type: "spouse", person: "Person:hsyn0001", spouse: { ref: "Person:hsyn0005" }, relType: "married",
      married: { year: 1990, about: true, place: { ref: "Place:hsynp1" } }, ended: { how: "divorced", year: 2001 },
    });
    assert.deepEqual(text(s), ["you and Alex Example are married.", "you married in about 1990 in Springfield.", "you are no longer together (2001)."]);
  });

  it("partners, not married: no year and no place are asked; widowed ends the questions", () => {
    let s = setRelType(setSpouse(startFlow(freshState(), "spouse"), stubOf(freshState(), { given: "Alex", surname: "Example", living: "no", deathYear: "2020" })), "unmarried");
    assert.equal(s.screen, "s.end");
    s = setEnded(s, "widowed");
    assert.equal(s.screen, "check");
    assert.deepEqual(intentOf(s, ME), {
      type: "spouse", person: "Person:hsyn0001",
      spouse: { new: { given: "Alex", surname: "Example", gender: "unknown", birthYear: null, living: "no", deathYear: 2020 } }, relType: "unmarried", married: null, ended: { how: "widowed", year: null },
    });
    assert.deepEqual(text(s), ["you and Alex Example are partners, not married.", "Alex Example has died."]);
  });

  it("a skipped year skips the place; a typed place becomes a new city; still together is no end", () => {
    let s = setRelType(setSpouse(startFlow(freshState(), "spouse"), MOTHER), "civil_union");
    s = setYear(s, { year: null });
    assert.equal(s.screen, "s.end", "no year, no place");
    s = setEnded(s, "still");
    assert.equal(intentOf(s, ME).married, null);
    assert.equal(intentOf(s, ME).ended, null);
    let t = setPlace(setYear(setRelType(setSpouse(startFlow(freshState(), "spouse"), MOTHER), "married"), { year: 1988 }), { name: "Lakeside" });
    assert.deepEqual(intentOf(setEnded(t, "still"), ME).married, { year: 1988, about: false, place: { new: { name: "Lakeside", type: "City" } } });
  });
});

describe("flow: something's wrong (AC1)", () => {
  const families = [
    { handle: "hsynf1", meAs: "child", parents: [{ handle: "hsyn0002", gid: "I9002", name: "Tessa Example" }, { handle: "hsyn0006", gid: "I9006", name: "Orrin Example" }], children: [{ handle: "hsyn0007", gid: "I9007", name: "Bo Example" }] },
    { handle: "hsynf2", meAs: "partner", parents: [{ handle: "hsyn0001", gid: "I9001", name: "Me Example" }, { handle: "hsyn0005", gid: "I9005", name: "Alex Example" }], children: [{ handle: "hsyn0004", gid: "I9004", name: "Sam Example" }] },
  ];
  it("lists my parents, my partner and my children as connections to take off", () => {
    const items = unlinkChoices({ me: ME, families });
    assert.deepEqual(items.map((i) => [i.kind, i.family, i.person, i.as]), [
      ["parents", "Family:hsynf1", "Person:hsyn0001", "child"],
      ["partner", "Family:hsynf2", "Person:hsyn0001", "partner"],
      ["child", "Family:hsynf2", "Person:hsyn0004", "child"],
    ]);
    assert.deepEqual(items[0].names.map((n) => n.name), ["Tessa Example", "Orrin Example"]);
  });
  it("a chosen connection, confirmed, is the unlink intent; 'no, keep it' goes back to the list", () => {
    const items = unlinkChoices({ me: ME, families });
    let s = chooseUnlink(startFlow(freshState(), "unlink"), items[1]);
    assert.equal(s.screen, "u.confirm");
    assert.deepEqual(text(s), ["take off Alex Example as your spouse or partner."]);
    const kept = confirmUnlink(s, false);
    assert.equal(kept.screen, "u.list");
    assert.equal(kept.draft.item, null);
    s = confirmUnlink(s, true);
    assert.equal(s.screen, "check");
    assert.deepEqual(intentOf(s, ME), { type: "unlink", family: "Family:hsynf2", person: "Person:hsyn0001", as: "partner" });
    const kid = confirmUnlink(chooseUnlink(startFlow(freshState(), "unlink"), items[2]), true);
    assert.deepEqual(intentOf(kid, ME), { type: "unlink", family: "Family:hsynf2", person: "Person:hsyn0004", as: "child" });
    assert.deepEqual(text(kid), ["take off Sam Example as your child."]);
    assert.deepEqual(text(confirmUnlink(chooseUnlink(startFlow(freshState(), "unlink"), items[0]), true)), ["take off Tessa Example and Orrin Example as your parents."]);
  });
  it("a family with no other parent offers no 'partner' line", () => {
    const only = [{ handle: "hsynf3", meAs: "partner", parents: [{ handle: "hsyn0001", gid: "I9001", name: "Me Example" }], children: [] }];
    assert.deepEqual(unlinkChoices({ me: ME, families: only }), []);
  });
});

describe("Back and Undo restore the previous draft step (AC3)", () => {
  it("Back goes to the previous screen with its draft; Undo takes the last answer or edit back", () => {
    let s = startFlow(freshState(), "parents");
    const atWhich = s;
    s = chooseRole(s, "mother");
    const atWho = s;
    s = chooseParent(s, MOTHER);
    assert.equal(s.screen, "p.rel");
    assert.ok(canBack(s) && canUndo(s));
    const b = back(s);
    assert.equal(b.screen, "p.who");
    assert.deepEqual(b.draft, atWho.draft, "the draft is what it was on that screen");
    assert.deepEqual(back(b).draft, atWhich.draft);
    assert.equal(back(back(b)).screen, "start");
    assert.equal(back(back(back(b))).screen, "start", "nothing before the start");
    const u = undo(s);
    assert.equal(u.screen, "p.who");
    assert.deepEqual(u.draft, atWho.draft);
    assert.equal(canUndo(freshState()), false);
    assert.equal(undo(freshState()).screen, "start");
  });

  it("Back skips same-screen edits and the check screen; Undo takes one edit at a time", () => {
    let s = setOtherParent(startFlow(freshState(), "children"), { unknown: true });
    s = addKid(s, ref("hsyn0004", "I9004", "Sam Example"));
    s = addKid(s, ref("hsyn0008", "I9008", "Jo Example"));
    s = removeKid(s, 0);
    assert.equal(s.draft.kids.length, 1);
    assert.equal(undo(s).draft.kids.length, 2, "one Undo is the one removal");
    assert.equal(undo(undo(s)).draft.kids.length, 1);
    // c.add -> c.rel -> check -> (settle) summary
    let t = kidsLookRight(kidsDone(s));
    assert.equal(t.screen, "check");
    t = settle(t, "summary");
    const b = back(t);
    assert.equal(b.screen, "c.rel", "Back from the summary lands on the last question, never on the check");
    assert.equal(back(b).screen, "c.add");
    assert.equal(back(back(b)).screen, "c.other");
  });

  it("the history is bounded", () => {
    let s = startFlow(freshState(), "children");
    s = setOtherParent(s, { unknown: true });
    for (let i = 0; i < 200; i += 1) s = edit(s, { n: i });
    assert.ok(s.past.length <= 80);
  });
});

describe("'is this the same person?' (AC4)", () => {
  const twoNew = () => {
    let s = setOtherParent(startFlow(freshState(), "children"), stubOf(freshState(), { given: "Pat", surname: "Example", gender: "female" }));
    s = addKid(s, stubOf(s, { given: "Wren", surname: "Example" }));
    return s;
  };
  const dups = [{ for: "new:2", candidates: [{ handle: "hsyn0009", displayName: "Wren Exampel", lifespan: "2015-" }] }, { for: "new:9", candidates: [{ handle: "x" }] }];

  it("an unanswered duplicate is reported by name; the unknown 'for' is ignored", () => {
    const s = twoNew();
    const open = unansweredDuplicates(s, dups);
    assert.equal(open.length, 1);
    assert.equal(open[0].uid, "u2");
    assert.equal(open[0].name, "Wren Example");
    assert.deepEqual(open[0].candidates, [{ handle: "hsyn0009", displayName: "Wren Exampel", lifespan: "2015-" }]);
  });
  it("'no, someone else' names the new person in confirmDistinct and the question is answered", () => {
    let s = twoNew();
    assert.deepEqual(confirmDistinct(s), []);
    s = answerDifferent(s, "u2");
    assert.equal(s.screen, "check", "the answer is checked again with the server");
    assert.deepEqual(confirmDistinct(s), ["new:2"]);
    assert.deepEqual(unansweredDuplicates(s, dups), []);
  });
  it("'yes, that's them' swaps the new person for the one on the site, and the numbering follows", () => {
    let s = answerSame(twoNew(), "u2", dups[0].candidates[0]);
    assert.deepEqual(intentOf(s, ME).children[0].who, { ref: "Person:hsyn0009" });
    assert.deepEqual(stubUids(s), ["u1"]);
    assert.equal(whoName(s.draft.kids[0].who), "Wren Exampel");
    // an earlier answer for the other new person still counts after the numbering moved
    let t = answerDifferent(twoNew(), "u2");
    t = answerSame(t, "u1", { handle: "hsyn0010", displayName: "Pat Exampel" });
    assert.deepEqual(stubUids(t), ["u2"]);
    assert.deepEqual(confirmDistinct(t), ["new:1"]);
  });
  it("works for parents and a spouse too", () => {
    let p = chooseParentRel(chooseParent(chooseRole(startFlow(freshState(), "parents"), "mother"), stubOf(freshState(), { given: "Tess" })), "birth");
    p = settle(p, "dup");
    assert.deepEqual(intentOf(answerSame(p, "u1", { handle: "hsyn0002", displayName: "Tessa Example" }), ME).parents[0].who, { ref: "Person:hsyn0002" });
    const sp = setRelType(setSpouse(startFlow(freshState(), "spouse"), stubOf(freshState(), { given: "Alex" })), "unmarried");
    assert.deepEqual(intentOf(answerSame(sp, "u1", { handle: "hsyn0005", displayName: "Alex Example" }), ME).spouse, { ref: "Person:hsyn0005" });
  });
});

describe("the new-person form", () => {
  it("needs a name; years are four digits and not in the future; a death cannot precede a birth", () => {
    assert.equal(validateStubForm({}, { nowYear: NOW }).ok, false);
    assert.equal(validateStubForm({ given: "A", birthYear: "19x0" }, { nowYear: NOW }).errors.birthYear, COPY.badYear);
    assert.equal(validateStubForm({ given: "A", birthYear: "2999" }, { nowYear: NOW }).errors.birthYear, COPY.futureYear);
    assert.equal(validateStubForm({ given: "A", birthYear: "1950", living: "no", deathYear: "1940" }, { nowYear: NOW }).errors.deathYear, COPY.deathBeforeBirth);
    assert.equal(validateStubForm({ given: "x".repeat(101) }, { nowYear: NOW }).errors.given, COPY.nameLong);
    const ok = validateStubForm({ given: "  Ann  Marie ", surname: "Example", birthYear: " 1950 ", living: "yes", deathYear: "1999", gender: "female" }, { nowYear: NOW });
    assert.deepEqual(ok.stub, { given: "Ann Marie", surname: "Example", gender: "female", birthYear: 1950, living: "yes", deathYear: null }, "a death year is kept only when they are not living");
    assert.equal(parseYear(""), null);
    assert.ok(Number.isNaN(parseYear("95")));
  });
});

describe("the summary and its edit links", () => {
  it("each line has a way back to the answer it came from", () => {
    let s = chooseParentRel(chooseParent(chooseRole(startFlow(freshState(), "parents"), "mother"), MOTHER), "birth");
    s = moreParents(s, false);
    s = settle(s, "summary");
    const lines = sentenceLines(s);
    assert.equal(lines.length, 1);
    const e = editLine(s, lines[0].edit);
    assert.equal(e.screen, "p.which");
    assert.deepEqual(e.draft.parents, []);
    assert.equal(undo(e).screen, "summary", "and one Undo is back at the summary");
  });
  it("a name with a page is a link part; a new person is plain text (P2-R46)", () => {
    const s = chooseParentRel(chooseParent(chooseRole(startFlow(freshState(), "parents"), "mother"), MOTHER), "birth");
    assert.deepEqual(sentencesOf(s)[0][0], { name: "Tessa Example", id: "I9002" });
    const n = chooseParentRel(chooseParent(chooseRole(startFlow(freshState(), "parents"), "mother"), stubOf(freshState(), { given: "Tess" })), "birth");
    assert.deepEqual(sentencesOf(n)[0][0], { name: "Tess", id: null });
  });
  it("the panel lists the same sentences as text", () => {
    const s = chooseParentRel(chooseParent(chooseRole(startFlow(freshState(), "parents"), "mother"), MOTHER), "step");
    assert.deepEqual(panelLines(s), ["Tessa Example is your stepmother."]);
    assert.deepEqual(panelLines(freshState()), []);
  });
});

describe("the step count (AC2)", () => {
  it("each flow screen shows 'step n of total'; the start and the check show none", () => {
    assert.equal(stepOf(freshState()), null);
    const p = chooseRole(startFlow(freshState(), "parents"), "mother");
    assert.deepEqual(stepOf(p), { n: 2, total: 4 });
    assert.equal(COPY.stepOf(2, 4), "step 2 of 4");
    assert.deepEqual(stepOf(settle(p, "check")), null);
    assert.deepEqual(stepOf(setSpouse(startFlow(freshState(), "spouse"), MOTHER)), { n: 2, total: 5 });
    assert.deepEqual(stepOf(startFlow(freshState(), "unlink")), { n: 1, total: 3 });
    assert.deepEqual(stepOf(startFlow(freshState(), "children")), { n: 1, total: 4 });
  });
});

describe("the draft survives a reload (AC3)", () => {
  it("saves and loads the state, and clears it", () => {
    const st = memory();
    let s = chooseParent(chooseRole(startFlow(freshState(), "parents"), "mother"), MOTHER);
    saveDraft(st, "I9001", s);
    const back1 = loadDraft(st, "I9001");
    assert.deepEqual(back1, s);
    assert.equal(back(back1).screen, "p.who", "the way back is kept too");
    assert.equal(loadDraft(st, "I9002"), null, "per member");
    saveDraft(st, "I9001", restart());
    assert.equal(st.m.size, 0, "a state with no flow is not kept");
    saveDraft(st, "I9001", s);
    clearDraft(st, "I9001");
    assert.equal(loadDraft(st, "I9001"), null);
  });
  it("garbage, another version, an unknown flow or a throwing storage is nothing", () => {
    assert.equal(restoreState("not json"), null);
    assert.equal(restoreState({ v: 0 }), null);
    assert.equal(restoreState({ v: 1, flow: "bogus", screen: "start", draft: {}, past: [] }), null);
    assert.equal(restoreState({ v: 1, flow: null, screen: "<script>", draft: {}, past: [] }), null);
    assert.equal(restoreState({ v: 1, flow: null, screen: "start", draft: {}, past: new Array(500).fill({ screen: "start", draft: {} }) }), null);
    assert.equal(restoreState({ v: 1, flow: null, screen: "done", draft: {}, past: [] }), null);
    const boom = { getItem() { throw new Error("denied"); }, setItem() { throw new Error("denied"); }, removeItem() { throw new Error("denied"); } };
    assert.equal(loadDraft(boom, "x"), null);
    assert.doesNotThrow(() => { saveDraft(boom, "x", startFlow(freshState(), "parents")); clearDraft(boom, "x"); });
    assert.equal(loadDraft(null, "x"), null);
  });
});

describe("words and routes", () => {
  it("the four flows are named in plain words", () => {
    assert.deepEqual(FLOWS, ["parents", "children", "spouse", "unlink"]);
    assert.deepEqual(COPY.flowLabel, { parents: "my parents", children: "my children", spouse: "my spouse or partner", unlink: "something's wrong" });
  });
  it("the jargon never reaches a member", () => {
    const all = JSON.stringify(COPY).toLowerCase();
    for (const bad of ["childref", "relationship type", "partner1", "partner2", "gramps", "proposal"]) assert.ok(!all.includes(bad), `copy says "${bad}"`);
  });
  it("problems get plain words and never echo input", () => {
    assert.equal(problemOf({ status: 401 }).kind, "signin");
    assert.equal(problemOf({ status: 404 }).text, COPY.off);
    assert.equal(problemOf({ status: 422, code: "contact_info" }).kind, "fix");
    assert.equal(problemOf({ status: 422, code: "cycle" }).kind, "fix");
    assert.equal(problemOf({ status: 422, code: "unconfirmed_duplicate" }).kind, "duplicate");
    assert.equal(problemOf({ status: 409, code: "already_recorded" }).kind, "recorded");
    assert.equal(problemOf({ status: 500 }).kind, "retry");
    assert.equal(problemOf(undefined).kind, "retry");
  });
  it("the page route and the button's link", () => {
    assert.equal(routeId("?id=I9001"), "I9001");
    assert.equal(routeId("?id=a%20b"), null);
    assert.equal(routeId(""), null);
    assert.equal(wizardHref("I9001"), "/edit/family/?id=I9001");
  });
  it("a preview body is read defensively", () => {
    const v = previewView({ summary: [{ text: "a" }, 3], warnings: [{ detail: "w" }, {}], followUps: [{ code: "offer_death_year", person: "Person:h" }, { code: "other" }], already_recorded: true, duplicates: "no" });
    assert.deepEqual(v, { summary: ["a"], warnings: ["w"], followUps: [{ code: "offer_death_year", person: "Person:h" }], alreadyRecorded: true, destructive: false, duplicates: [] });
    assert.deepEqual(previewView(null).summary, []);
  });
  it("go() does not touch the state it was given", () => {
    const s = startFlow(freshState(), "parents");
    const frozen = JSON.stringify(s);
    go(s, "p.who", { x: 1 });
    assert.equal(JSON.stringify(s), frozen);
  });
});
