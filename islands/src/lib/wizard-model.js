// The relationship wizard's pure half (HFY-TSK-158, relationship-wizard-island; flag relationshipWizard; HFY-PLN-002 editing.md section 8, BRD2 R-24).
// No DOM and no React, so a node test pins the rules (tests/wizard-model.test.mjs): the words, the screens of the four flows ("my parents", "my
// children", "my spouse or partner", "something's wrong"), the draft, Back and Undo, the intent JSON the server compiles, the sentences of the
// summary, the duplicate answers, the draft kept in sessionStorage, and the words for every error.
//
// The client sends INTENTS (editing.md 8.2); the server compiles the ops (api/src/records/relationships.js). A person in an intent is
// `{ ref: "Person:<handle>" }` for someone already on the site or `{ new: Stub }` for someone who is not, and the draft keeps both as a
// "who": `{ ref, gid, name, lifespan }` or `{ stub: { uid, given, surname, gender, birthYear, living, deathYear } }`. The `uid` is the
// client's own name for a new person (never sent): the server numbers new people `new:1`, `new:2` ... in the order the intent lists them
// (`stubUids`), and "is this the same person?" is answered per `uid`, so the answers survive a renumbering.
//
// The draft is a stack of snapshots. Every answer pushes the screen and draft it leaves: Undo takes the last snapshot back (the last answer
// or edit, on any screen), Back goes to the previous screen (it takes snapshots back until the screen changes). The "check" screen (the
// preview request) is never a place to go back to. Copy is lowercase and plain: no "family", "ChildRef" or "relationship type" jargon.

export const MAX_KIDS = 10; // the server's MAX_CHILDREN (api/src/records/relationships.js)
export const MAX_PARENTS = 2;
export const HISTORY_MAX = 80;
export const DRAFT_VERSION = 1;
export const TEMP_RE = /^new:(\d+)$/;
export const NAME_MAX = 100; // the server's cleanPart limit
export const MIN_YEAR = 1000;

export const FLOWS = Object.freeze(["parents", "children", "spouse", "unlink"]);

export const COPY = Object.freeze({
  title: "add or fix family connections",
  loading: "getting this ready",
  off: "family connections aren't turned on yet.",
  offFlag: "family connections aren't available yet.",
  signedOut: "sign in to add or fix family connections.",
  signIn: "sign in",
  notYours: "this is for your own page. open your page and use the button in its family section.",
  yourPage: "go to your page",
  noPage: "we couldn't find your page. text J and we'll sort it out.",
  loadFailed: "that didn't load. try again in a moment.",
  retry: "try again",
  stepOf: (n, total) => `step ${n} of ${total}`,
  back: "back",
  undo: "undo",
  next: "next",
  skip: "skip this",
  yes: "yes",
  no: "no",
  startQ: "what would you like to do?",
  startHelp: "pick one. nothing is sent until you check it at the end.",
  flowLabel: Object.freeze({
    parents: "my parents",
    children: "my children",
    spouse: "my spouse or partner",
    unlink: "something's wrong",
  }),
  flowHelp: Object.freeze({
    parents: "add the people who raised you or gave you life.",
    children: "add a child, or several.",
    spouse: "add the person you're married to, or your partner.",
    unlink: "take off a connection that's wrong.",
  }),
  search: "search the family",
  searchHelp: "type a name. pick the right person from the list.",
  searchNone: "nobody by that name. try fewer letters, or add them as new.",
  searchFailed: "the search didn't load. try again, or add them as new.",
  searchLoading: "looking",
  notOnSite: "they aren't on the site yet",
  notOnSiteMother: "she isn't on the site yet",
  notOnSiteFather: "he isn't on the site yet",
  pickedPerson: "picked",
  changePick: "pick someone else",
  newGiven: "first and middle names, as on the birth certificate",
  newSurname: "last name",
  newSurnameMaiden: "last name at birth (a maiden name, if you know it)",
  newBirthYear: "year born (optional)",
  newLiving: "are they living?",
  newDeathYear: "year they died (optional)",
  livingYes: "yes",
  livingNo: "no",
  livingUnknown: "not sure",
  yearHelp: "four digits, like 1950",
  needAName: "add at least a first name or a last name.",
  nameLong: `names can be up to ${NAME_MAX} letters.`,
  badYear: "use a four-digit year.",
  futureYear: "that year hasn't happened yet.",
  deathBeforeBirth: "they can't have died before they were born.",
  continue: "continue",
  // parents
  pWhich: "let's add your parents. who would you like to add first?",
  pWhichMore: "who would you like to add next?",
  pMother: "my mother",
  pFather: "my father",
  pOther: "another parent",
  pWho: (role) => (role === "mother" ? "who is your mother?" : role === "father" ? "who is your father?" : "who is your other parent?"),
  pRel: (role) => (role === "mother" ? "how are you related to her?" : role === "father" ? "how are you related to him?" : "how are you related to them?"),
  pMore: "is there another parent to add?",
  pMoreYes: "add another parent",
  pMoreNo: "that's all",
  more: "more choices",
  fewer: "fewer choices",
  // children
  cOther: "who is the other parent of your children?",
  cOtherSomeone: "someone else",
  cOtherNone: "i'd rather not say / not sure",
  cAdd: "your children",
  cAddHelp: "add each child, one at a time.",
  cAddOne: "add a child",
  cAddAnother: "add another child",
  cDone: "that's all my children",
  cEmpty: "no children added yet.",
  cMax: `that's the most we can take at once (${MAX_KIDS}). send these, then add more.`,
  cWho: "who is your child?",
  cRemove: "remove",
  cRel: "how are they related?",
  cRelHelp: "each child is a birth child unless you change it.",
  cChange: "change",
  cRelMe: (name) => `how is ${name} related to you?`,
  cRelOther: (name, other) => `how is ${name} related to ${other}?`,
  cLooksRight: "this looks right",
  // spouse
  sWho: "who is your spouse or partner?",
  sType: "were you married?",
  sMarried: "yes, married",
  sUnmarried: "partners, not married",
  sCivil: "a civil union",
  sNotSure: "not sure",
  sYear: "what year did you marry?",
  sYearHelp: "an approximate year is fine.",
  sAbout: "about this year",
  sPlace: "where did you marry?",
  sPlaceHelp: "pick a place the site already has, or type one.",
  sPlaceNone: "somewhere else",
  sPlaceName: "the town or city",
  sEnd: (type) => (type === "married" || type === "civil_union" ? "is the marriage still going?" : "are you still together?"),
  sEndStill: "yes, still together",
  sEndDivorced: "no, we split up",
  sEndWidowed: "no, they have died",
  sEndYear: "what year was that?",
  // unlink
  uList: "which connection is wrong?",
  uListHelp: "pick the one to take off. you can come back and do more than one, one at a time.",
  uLoading: "looking at your family",
  uNone: "we don't see any connections to take off.",
  uConfirm: "take this connection off?",
  uConfirmYes: "yes, take it off",
  uConfirmNo: "no, keep it",
  uParents: (names) => `${names} as your parents`,
  uPartner: (name) => `${name} as your spouse or partner`,
  uChild: (name) => `${name} as your child`,
  uSomeone: "someone",
  uWarn: "removing a connection needs an admin to look at it, and they'll ask you to sign in again first.",
  // check and duplicates
  checking: "checking this with the site",
  dupQ: "is this the same person?",
  dupHelp: (name) => `we already have someone who looks like ${name}.`,
  dupSame: (name) => `yes, that's ${name}`,
  dupDifferent: "no, someone else",
  dupBlocked: "we need an answer before this can be sent.",
  // summary
  summaryTitle: "check this before you send it",
  summaryLead: "you're telling us:",
  summaryAdmin: "an admin will check this before it shows on the site. you'll get a notification.",
  summaryNothing: "the site already says this. there's nothing to send.",
  summaryEdit: "change this",
  send: "send for review",
  sending: "sending",
  sendBack: "go back",
  warnings: "good to know",
  // done
  sent: "sent. you can change or withdraw it until an admin looks.",
  seeSent: "see what you sent",
  addMore: "add more connections",
  deathFollow: (name) => `add the year ${name} died`,
  deathFollowPlain: "add the year they died",
  // the family panel
  panel: "what you've told us so far",
  panelNone: "nothing yet.",
  // the entry
  entry: "add or fix family connections",
});

// ---- words for the choices ---------------------------------------------------------------------------------------------------

const REL_VALUES = Object.freeze(["birth", "adopted", "step", "foster", "unknown"]);
const REL_MORE = Object.freeze(["sponsored", "none"]);
export const REL_ALL = Object.freeze([...REL_VALUES, ...REL_MORE]);

const PARENT_WORDS = Object.freeze({
  mother: Object.freeze({ birth: "birth mother", adopted: "adoptive mother", step: "stepmother", foster: "foster mother", unknown: "not sure", sponsored: "sponsor", none: "none of these" }),
  father: Object.freeze({ birth: "birth father", adopted: "adoptive father", step: "stepfather", foster: "foster father", unknown: "not sure", sponsored: "sponsor", none: "none of these" }),
  other: Object.freeze({ birth: "birth parent", adopted: "adoptive parent", step: "stepparent", foster: "foster parent", unknown: "not sure", sponsored: "sponsor", none: "none of these" }),
});
const CHILD_WORDS = Object.freeze({ birth: "birth child", adopted: "adopted child", step: "stepchild", foster: "foster child", unknown: "not sure", sponsored: "sponsored child", none: "none of these" });
// The same choices inside a sentence ("is your adoptive mother").
const PARENT_SAID = Object.freeze({
  mother: Object.freeze({ birth: "your birth mother", adopted: "your adoptive mother", step: "your stepmother", foster: "your foster mother", unknown: "your mother (you're not sure how)", sponsored: "your sponsor", none: "your mother" }),
  father: Object.freeze({ birth: "your birth father", adopted: "your adoptive father", step: "your stepfather", foster: "your foster father", unknown: "your father (you're not sure how)", sponsored: "your sponsor", none: "your father" }),
  other: Object.freeze({ birth: "your birth parent", adopted: "your adoptive parent", step: "your stepparent", foster: "your foster parent", unknown: "your parent (you're not sure how)", sponsored: "your sponsor", none: "your parent" }),
});
const CHILD_SAID = Object.freeze({ birth: "birth child", adopted: "adopted child", step: "stepchild", foster: "foster child", unknown: "child (not sure how)", sponsored: "sponsored child", none: "child" });

export const ROLES = Object.freeze(["mother", "father", "other"]);
export const roleGender = (role) => (role === "mother" ? "female" : role === "father" ? "male" : "unknown");

/** The relationship choices for a parent role: `{ value, label }`, the five usual ones and then (behind "more choices") the two rare ones. */
export function parentChoices(role) {
  const w = PARENT_WORDS[ROLES.includes(role) ? role : "other"];
  return { main: REL_VALUES.map((value) => ({ value, label: w[value] })), more: REL_MORE.map((value) => ({ value, label: w[value] })) };
}
export function childChoices() {
  return { main: REL_VALUES.map((value) => ({ value, label: CHILD_WORDS[value] })), more: REL_MORE.map((value) => ({ value, label: CHILD_WORDS[value] })) };
}

export const SPOUSE_TYPES = Object.freeze([
  { value: "married", label: COPY.sMarried },
  { value: "unmarried", label: COPY.sUnmarried },
  { value: "civil_union", label: COPY.sCivil },
  { value: "unknown", label: COPY.sNotSure },
]);

// ---- the screens and the step count ------------------------------------------------------------------------------------------

/** screen -> [step, total] for the visible "step 2 of 4". Screens not listed (start, check) show no count. */
const STEPS = Object.freeze({
  parents: Object.freeze({ total: 4, at: { "p.which": 1, "p.who": 2, "p.new": 2, "p.rel": 3, "p.more": 3, dup: 4, summary: 4 } }),
  children: Object.freeze({ total: 4, at: { "c.other": 1, "c.otherWho": 1, "c.otherNew": 1, "c.add": 2, "c.child": 2, "c.new": 2, "c.rel": 3, "c.relMe": 3, "c.relOther": 3, dup: 4, summary: 4 } }),
  spouse: Object.freeze({ total: 5, at: { "s.who": 1, "s.new": 1, "s.type": 2, "s.year": 3, "s.place": 3, "s.end": 4, "s.endYear": 4, dup: 5, summary: 5 } }),
  unlink: Object.freeze({ total: 3, at: { "u.list": 1, "u.confirm": 2, summary: 3 } }),
});
const FIRST = Object.freeze({ parents: "p.which", children: "c.other", spouse: "s.who", unlink: "u.list" });

/** `{ n, total }` for the screen, or null for a screen with no count (the start and the check). */
export function stepOf(state) {
  const f = state && STEPS[state.flow];
  const n = f && f.at[state.screen];
  return n ? { n, total: f.total } : null;
}

// ---- state: the draft, Back and Undo -----------------------------------------------------------------------------------------

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const snap = (s) => ({ screen: s.screen, draft: s.draft });

export const freshState = () => ({ v: DRAFT_VERSION, flow: null, screen: "start", draft: {}, past: [] });

function initialDraft(flow) {
  switch (flow) {
    case "parents": return { parents: [], cur: null, distinct: [], dups: [], uidn: 0 };
    case "children": return { other: null, kids: [], cur: null, editKid: -1, distinct: [], dups: [], uidn: 0 };
    case "spouse": return { spouse: null, relType: null, year: null, about: false, place: null, ended: null, distinct: [], dups: [], uidn: 0 };
    default: return { item: null, distinct: [], dups: [], uidn: 0 };
  }
}

/** Move to `screen` with `patch` laid over the draft; what is left is pushed for Undo and Back. */
export function go(state, screen, patch = {}) {
  const past = [...state.past, snap(state)].slice(-HISTORY_MAX);
  return { ...state, screen, draft: { ...state.draft, ...patch }, past };
}
/** A change on the same screen (a child added, a child removed): one Undo takes it back. */
export const edit = (state, patch) => go(state, state.screen, patch);
/** Leave the "check" screen with no history of its own (Back never lands on it). */
export const settle = (state, screen, patch = {}) => ({ ...state, screen, draft: { ...state.draft, ...patch } });

export const canUndo = (state) => state.past.length > 0;
export const canBack = (state) => state.screen !== "start" && state.past.length > 0;

/** Take the last snapshot back: the last answer or edit, wherever it was made. */
export function undo(state) {
  if (!canUndo(state)) return state;
  const past = state.past.slice(0, -1);
  const last = state.past[state.past.length - 1];
  return { ...state, screen: last.screen, draft: last.draft, past };
}

/** The previous screen: take snapshots back until the screen is a different one (and never the check screen or an answered duplicate question). */
export function back(state) {
  let i = state.past.length - 1;
  while (i >= 0 && (state.past[i].screen === state.screen || state.past[i].screen === "check" || state.past[i].screen === "dup")) i -= 1;
  if (i < 0) return state.flow ? { ...freshState() } : state;
  const to = state.past[i];
  return { ...state, screen: to.screen, draft: to.draft, past: state.past.slice(0, i) };
}

/** Pick a flow on the start screen. */
export function startFlow(state, flow) {
  if (!FLOWS.includes(flow)) return state;
  const past = [...state.past, snap(state)].slice(-HISTORY_MAX);
  return { ...state, flow, screen: FIRST[flow], draft: initialDraft(flow), past };
}

/** Leave the flow for the start screen with nothing kept (after a send, or "add more"). */
export const restart = () => freshState();

// ---- people ("who") ----------------------------------------------------------------------------------------------------------

export const isStub = (w) => isObj(w) && isObj(w.stub);
export const isRef = (w) => isObj(w) && typeof w.ref === "string";

/** The next client id for a new person; call with the draft and lay the returned patch over it. */
export const nextUid = (draft) => `u${(draft.uidn || 0) + 1}`;

/** A "who" for someone picked from the family: the handle comes from the records API. */
export const refWho = ({ handle, gid = null, name = "", lifespan = "" }) => ({ ref: `Person:${handle}`, gid, name, lifespan });

/** The form values -> a "who" for a new person; `uid` is the draft's next client id. Returns null if the form is not valid. */
export function stubWho(draft, form, { nowYear }) {
  const v = validateStubForm(form, { nowYear });
  if (!v.ok) return null;
  return { stub: { uid: nextUid(draft), ...v.stub } };
}

const cleanName = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();

/** The year in a text box: null when blank, NaN when it is not four digits. */
export function parseYear(text) {
  const t = String(text == null ? "" : text).trim();
  if (!t) return null;
  return /^\d{4}$/.test(t) ? Number(t) : Number.NaN;
}

/**
 * Check the "not on the site yet" form: `{ given, surname, birthYear, living, deathYear }` as typed -> `{ ok, errors, stub }`. `errors` names the
 * field (`given`, `surname`, `birthYear`, `deathYear`) and carries the words. `gender` comes from the screen (the role the person is asked for).
 */
export function validateStubForm(form, { nowYear }) {
  const f = isObj(form) ? form : {};
  const errors = {};
  const given = cleanName(f.given);
  const surname = cleanName(f.surname);
  if (!given && !surname) errors.given = COPY.needAName;
  if (given.length > NAME_MAX) errors.given = COPY.nameLong;
  if (surname.length > NAME_MAX) errors.surname = COPY.nameLong;
  const birthYear = parseYear(f.birthYear);
  const living = ["yes", "no", "unknown"].includes(f.living) ? f.living : "unknown";
  let deathYear = living === "no" ? parseYear(f.deathYear) : null;
  if (Number.isNaN(birthYear)) errors.birthYear = COPY.badYear;
  else if (birthYear !== null && (birthYear < MIN_YEAR || birthYear > nowYear)) errors.birthYear = birthYear > nowYear ? COPY.futureYear : COPY.badYear;
  if (Number.isNaN(deathYear)) errors.deathYear = COPY.badYear;
  else if (deathYear !== null && (deathYear < MIN_YEAR || deathYear > nowYear)) errors.deathYear = deathYear > nowYear ? COPY.futureYear : COPY.badYear;
  if (!errors.birthYear && !errors.deathYear && birthYear !== null && deathYear !== null && deathYear < birthYear) errors.deathYear = COPY.deathBeforeBirth;
  if (Number.isNaN(deathYear)) deathYear = null;
  const gender = ["female", "male", "unknown"].includes(f.gender) ? f.gender : "unknown";
  const ok = Object.keys(errors).length === 0;
  return { ok, errors, stub: ok ? { given, surname, gender, birthYear: birthYear === null ? null : birthYear, living, deathYear } : null };
}

/** The name as a person is called in the summary and the lists. */
export function whoName(w) {
  if (isStub(w)) return [w.stub.given, w.stub.surname].filter(Boolean).join(" ") || COPY.uSomeone;
  return (isRef(w) && w.name) || COPY.uSomeone;
}
/** The Gramps id a name links to (P2-R46), or null: a new person has no page yet. */
export const whoId = (w) => (isRef(w) && typeof w.gid === "string" && w.gid ? w.gid : null);

const whoIntent = (w) => (isStub(w)
  ? { new: { given: w.stub.given, surname: w.stub.surname, gender: w.stub.gender, birthYear: w.stub.birthYear, living: w.stub.living, deathYear: w.stub.deathYear } }
  : { ref: w.ref });

// ---- the answers, flow by flow -----------------------------------------------------------------------------------------------

// parents
export const chooseRole = (state, role) => go(state, "p.who", { cur: { role: ROLES.includes(role) ? role : "other", who: null, rel: null } });
/** Someone is chosen for the parent in progress (a pick, or a new person with the uid already in `who`). */
export function chooseParent(state, who) {
  const d = state.draft;
  const patch = { cur: { ...d.cur, who }, ...(isStub(who) ? { uidn: (d.uidn || 0) + 1 } : {}) };
  return go(state, "p.rel", patch);
}
export function chooseParentRel(state, rel) {
  const d = state.draft;
  const parents = [...d.parents, { role: d.cur.role, who: d.cur.who, rel }];
  return go(state, parents.length >= MAX_PARENTS ? "check" : "p.more", { parents, cur: null });
}
export const moreParents = (state, more) => (more ? go(state, "p.which") : go(state, "check"));
/** The roles still worth offering: one mother and one father, and "another parent" while there is room. */
export function rolesLeft(draft) {
  const have = new Set((draft.parents || []).map((p) => p.role));
  return ROLES.filter((r) => r === "other" || !have.has(r));
}

// children
export const setOtherParent = (state, other) => {
  const d = state.draft;
  const patch = { other, ...(isStub(other) ? { uidn: (d.uidn || 0) + 1 } : {}) };
  return go(state, "c.add", patch);
};
export const addKid = (state, who) => {
  const d = state.draft;
  if ((d.kids || []).length >= MAX_KIDS) return state;
  const kids = [...d.kids, { who, relToMe: "birth", relToOther: "birth" }];
  return go(state, "c.add", { kids, uidn: isStub(who) ? (d.uidn || 0) + 1 : d.uidn || 0 });
};
export const removeKid = (state, index) => edit(state, { kids: state.draft.kids.filter((_, i) => i !== index) });
export const kidsDone = (state) => go(state, "c.rel", {});
export const changeKid = (state, index) => go(state, "c.relMe", { editKid: index });
export function setKidRelMe(state, rel) {
  const d = state.draft;
  const kids = d.kids.map((k, i) => (i === d.editKid ? { ...k, relToMe: rel } : k));
  return go(state, hasOtherParent(d) ? "c.relOther" : "c.rel", { kids });
}
export function setKidRelOther(state, rel) {
  const d = state.draft;
  return go(state, "c.rel", { kids: d.kids.map((k, i) => (i === d.editKid ? { ...k, relToOther: rel } : k)), editKid: -1 });
}
export const kidsLookRight = (state) => go(state, "check", {});
/** True when the other parent is a person (picked or new), not "i'd rather not say". */
export const hasOtherParent = (d) => isObj(d.other) && (isRef(d.other) || isStub(d.other));

// spouse
export const setSpouse = (state, who) => go(state, "s.type", { spouse: who, ...(isStub(who) ? { uidn: (state.draft.uidn || 0) + 1 } : {}) });
export function setRelType(state, relType) {
  const married = relType === "married" || relType === "civil_union";
  return go(state, married ? "s.year" : "s.end", { relType, ...(married ? {} : { year: null, about: false, place: null }) });
}
export function setYear(state, { year, about }) {
  const has = Number.isInteger(year);
  return go(state, has ? "s.place" : "s.end", { year: has ? year : null, about: has && about === true, ...(has ? {} : { place: null }) });
}
/** `place`: null (skip), `{ ref, name }` (a place the site has) or `{ name }` (a new one, a city). */
export const setPlace = (state, place) => go(state, "s.end", { place });
export function setEnded(state, how) {
  if (how === "divorced") return go(state, "s.endYear", { ended: { how, year: null } });
  if (how === "widowed") return go(state, "check", { ended: { how, year: null } });
  return go(state, "check", { ended: null });
}
export const setEndYear = (state, year) => go(state, "check", { ended: { how: "divorced", year: Number.isInteger(year) ? year : null } });

// unlink
/**
 * The connections a member can take off, from what the site holds about their family: `{ kind, family, person, as, names: [{ id, name }] }`
 * with kind `parents` (me, as a child of this family), `partner` (me, as a partner in it) or `child` (one of my children, as a child of it).
 */
export function unlinkChoices({ me, families }) {
  const out = [];
  const nm = (p) => ({ id: p.gid || null, name: p.name || COPY.uSomeone });
  for (const fam of Array.isArray(families) ? families : []) {
    if (!isObj(fam) || typeof fam.handle !== "string") continue;
    const parents = (fam.parents || []).filter((p) => p && p.handle !== me.handle);
    const family = `Family:${fam.handle}`;
    if (fam.meAs === "child") {
      const names = (fam.parents || []).map(nm);
      if (names.length) out.push({ kind: "parents", family, person: `Person:${me.handle}`, as: "child", names });
    } else if (fam.meAs === "partner") {
      if (parents.length) out.push({ kind: "partner", family, person: `Person:${me.handle}`, as: "partner", names: parents.map(nm) });
      for (const kid of fam.children || []) if (kid && typeof kid.handle === "string") out.push({ kind: "child", family, person: `Person:${kid.handle}`, as: "child", names: [nm(kid)] });
    }
  }
  return out;
}
export const chooseUnlink = (state, item) => go(state, "u.confirm", { item });
export const confirmUnlink = (state, yes) => (yes ? go(state, "check", {}) : go(state, "u.list", { item: null }));

// ---- the intent ------------------------------------------------------------------------------------------------------------------

/** Every new person of the draft, in the order the server numbers them (`new:1` is the first). */
export function stubUids(state) {
  const d = state.draft;
  const out = [];
  const take = (w) => { if (isStub(w)) out.push(w.stub.uid); };
  switch (state.flow) {
    case "parents": (d.parents || []).forEach((p) => take(p.who)); break;
    case "children": take(d.other); (d.kids || []).forEach((k) => take(k.who)); break;
    case "spouse": take(d.spouse); break;
    default: break;
  }
  return out;
}

/**
 * The intent the server compiles (editing.md 8.2), or null while the draft is not finished. `me` is `{ handle }`. A new person's client id
 * (`uid`) is never sent.
 */
export function intentOf(state, me) {
  const d = state.draft;
  const person = `Person:${me.handle}`;
  switch (state.flow) {
    case "parents":
      if (!d.parents || !d.parents.length) return null;
      return { type: "parents", person, parents: d.parents.map((p) => ({ who: whoIntent(p.who), rel: p.rel })) };
    case "children": {
      if (!d.kids || !d.kids.length) return null;
      const other = hasOtherParent(d) ? whoIntent(d.other) : { unknown: true };
      const known = hasOtherParent(d);
      return {
        type: "children", person, otherParent: other,
        children: d.kids.map((k) => ({ who: whoIntent(k.who), relToMe: k.relToMe, ...(known ? { relToOther: k.relToOther } : {}) })),
      };
    }
    case "spouse": {
      if (!d.spouse || !d.relType) return null;
      const married = Number.isInteger(d.year)
        ? { year: d.year, about: d.about === true, place: d.place ? (d.place.ref ? { ref: d.place.ref } : { new: { name: d.place.name, type: "City" } }) : null }
        : null;
      return { type: "spouse", person, spouse: whoIntent(d.spouse), relType: d.relType, married, ended: d.ended ? { how: d.ended.how, year: d.ended.year ?? null } : null };
    }
    case "unlink":
      if (!d.item) return null;
      return { type: "unlink", family: d.item.family, person: d.item.person, as: d.item.as };
    default:
      return null;
  }
}

/** The `new:n` stubs the member has said are different people, in the order the server numbers them (the body's `confirmDistinct`). */
export function confirmDistinct(state) {
  const distinct = new Set(state.draft.distinct || []);
  return stubUids(state).map((uid, i) => (distinct.has(uid) ? `new:${i + 1}` : null)).filter(Boolean);
}

// ---- "is this the same person?" ---------------------------------------------------------------------------------------------

/**
 * The duplicates the preview reported that the member has not answered yet: `[{ uid, name, candidates: [{ handle, displayName, lifespan }] }]`.
 * `duplicates` is the preview's `[{ for: "new:1", candidates }]`; an answered one (said "different", or swapped for the person who is there) is
 * left out, and a `for` the draft does not have is ignored.
 */
export function unansweredDuplicates(state, duplicates) {
  const uids = stubUids(state);
  const distinct = new Set(state.draft.distinct || []);
  const out = [];
  for (const dup of Array.isArray(duplicates) ? duplicates : []) {
    const m = TEMP_RE.exec(dup && dup.for);
    const uid = m ? uids[Number(m[1]) - 1] : undefined;
    if (!uid || distinct.has(uid) || !Array.isArray(dup.candidates) || !dup.candidates.length) continue;
    out.push({ uid, name: whoName(findStub(state, uid)), candidates: dup.candidates.filter((c) => c && typeof c.handle === "string") });
  }
  return out.filter((d) => d.candidates.length);
}

function findStub(state, uid) {
  const d = state.draft;
  const all = [];
  if (state.flow === "parents") (d.parents || []).forEach((p) => all.push(p.who));
  if (state.flow === "children") { all.push(d.other); (d.kids || []).forEach((k) => all.push(k.who)); }
  if (state.flow === "spouse") all.push(d.spouse);
  return all.find((w) => isStub(w) && w.stub.uid === uid) || null;
}

function mapWho(state, fn) {
  const d = state.draft;
  switch (state.flow) {
    case "parents": return { parents: (d.parents || []).map((p) => ({ ...p, who: fn(p.who) })) };
    case "children": return { other: isObj(d.other) ? fn(d.other) : d.other, kids: (d.kids || []).map((k) => ({ ...k, who: fn(k.who) })) };
    case "spouse": return { spouse: fn(d.spouse) };
    default: return {};
  }
}

/**
 * The member said "yes, that's them": the new person is swapped for the one already on the site. `candidate` is `{ handle, displayName, lifespan }`
 * (the server's duplicate candidate), plus `gid` when the caller looked the person up, so the summary can link the name (P2-R46).
 */
export function answerSame(state, uid, candidate) {
  const swap = (w) => (isStub(w) && w.stub.uid === uid ? refWho({ handle: candidate.handle, gid: typeof candidate.gid === "string" && candidate.gid ? candidate.gid : null, name: candidate.displayName || "", lifespan: candidate.lifespan || "" }) : w);
  return go(state, "check", { ...mapWho(state, swap), dups: [] });
}
/** The member said "no, someone else": the new person is kept, and named in `confirmDistinct`. */
export const answerDifferent = (state, uid) => go(state, "check", { distinct: [...new Set([...(state.draft.distinct || []), uid])], dups: [] });

// ---- the sentences of the summary -------------------------------------------------------------------------------------------

const t = (text) => ({ text });
const n = (w) => ({ name: whoName(w), id: whoId(w) });
const joinParts = (...chunks) => chunks.flat();

/**
 * The summary as lines: `{ parts, edit }`. `parts` is one sentence, a list of `{ text }` or `{ name, id }` (a name the page links to the person,
 * P2-R46); plain words, no "family" or "relationship" jargon. `edit` is where "change this" goes: `{ screen, patch }` (laid over the draft with
 * `go`), or null for a line that is only a consequence of another.
 */
export function sentenceLines(state) {
  const d = state.draft;
  const out = [];
  const line = (parts, edit = null) => out.push({ parts, edit });
  switch (state.flow) {
    case "parents": {
      (d.parents || []).forEach((p, i) => line(
        joinParts([n(p.who)], [t(` is ${PARENT_SAID[p.role][p.rel] || PARENT_SAID[p.role].birth}.`)]),
        { screen: "p.which", patch: { parents: d.parents.filter((_, j) => j !== i), cur: null } },
      ));
      if ((d.parents || []).length === 2) line([t("they are listed together as your parents.")]);
      break;
    }
    case "children": {
      const known = hasOtherParent(d);
      (d.kids || []).forEach((k, i) => {
        const me = CHILD_SAID[k.relToMe] || CHILD_SAID.birth;
        const edit = { screen: "c.add", patch: { kids: d.kids.filter((_, j) => j !== i) } };
        if (!known) line(joinParts([n(k.who)], [t(` is your ${me}.`)]), edit);
        else {
          const other = CHILD_SAID[k.relToOther] || CHILD_SAID.birth;
          line(me === other
            ? joinParts([n(k.who)], [t(` is the ${me} of you and `)], [n(d.other)], [t(".")])
            : joinParts([n(k.who)], [t(` is your ${me}, and the ${other} of `)], [n(d.other)], [t(".")]), edit);
        }
      });
      if (!known && (d.kids || []).length) line([t("the other parent isn't named.")], { screen: "c.other", patch: {} });
      break;
    }
    case "spouse": {
      const who = d.spouse;
      const toType = { screen: "s.type", patch: {} };
      if (d.relType === "married") line(joinParts([t("you and ")], [n(who)], [t(" are married.")]), toType);
      else if (d.relType === "civil_union") line(joinParts([t("you and ")], [n(who)], [t(" are in a civil union.")]), toType);
      else if (d.relType === "unmarried") line(joinParts([t("you and ")], [n(who)], [t(" are partners, not married.")]), toType);
      else line(joinParts([n(who)], [t(" is your spouse or partner.")]), toType);
      if (Number.isInteger(d.year)) {
        line([t(`you ${d.relType === "civil_union" ? "joined" : "married"} in ${d.about ? "about " : ""}${d.year}${d.place && d.place.name ? ` in ${d.place.name}` : ""}.`)], { screen: "s.year", patch: {} });
      }
      if (d.ended && d.ended.how === "divorced") line([t(`you are no longer together${Number.isInteger(d.ended.year) ? ` (${d.ended.year})` : ""}.`)], { screen: "s.end", patch: {} });
      if (d.ended && d.ended.how === "widowed") line(joinParts([n(who)], [t(" has died.")]), { screen: "s.end", patch: {} });
      break;
    }
    case "unlink": {
      const it = d.item;
      if (it) {
        const list = [];
        it.names.forEach((x, i) => { if (i) list.push(t(" and ")); list.push({ name: x.name, id: x.id }); });
        const tail = it.kind === "parents" ? " as your parents." : it.kind === "partner" ? " as your spouse or partner." : " as your child.";
        line(joinParts([t("take off ")], list, [t(tail)]), { screen: "u.list", patch: { item: null } });
      }
      break;
    }
    default: break;
  }
  return out;
}
/** "change this" on a summary line: back to the screen that line came from, with that answer taken out of the draft. */
export const editLine = (state, edit) => go(state, edit.screen, edit.patch);
/** The sentences alone, each a list of parts. */
export const sentencesOf = (state) => sentenceLines(state).map((l) => l.parts);
export const partsText = (parts) => parts.map((p) => (p.text !== undefined ? p.text : p.name)).join("");

/** The people named in the draft, for the "so far" panel on a wide page: the same sentences, as text. */
export const panelLines = (state) => (state.flow ? sentencesOf(state).map(partsText) : []);

// ---- the words for an error --------------------------------------------------------------------------------------------------

/** The member-facing line for a failed preview or send. Never echoes what was typed (the server's messages do not carry it either). */
export function problemOf(err) {
  const status = err && err.status;
  const code = err && err.code;
  if (status === 401) return { kind: "signin", text: "sign in again to continue." };
  if (status === 404) return { kind: "off", text: COPY.off };
  if (status === 429) return { kind: "retry", text: "that's a lot at once. wait a minute and try again." };
  if (code === "contact_info") return { kind: "fix", text: "we don't keep phone numbers, emails or street addresses on the site. please take that out." };
  if (code === "dob_not_allowed") return { kind: "fix", text: "we only keep the year someone was born. please use just the year." };
  if (code === "never_in_cloud") return { kind: "fix", text: "we don't keep that on the site, so please take it out." };
  if (code === "cycle") return { kind: "fix", text: "that can't be right: it would make someone their own ancestor." };
  if (code === "too_many_children") return { kind: "fix", text: `please add up to ${MAX_KIDS} children at a time.` };
  if (code === "proposal_too_large") return { kind: "fix", text: "that's too much to check in one go. please send it in smaller pieces." };
  if (code === "already_recorded") return { kind: "recorded", text: COPY.summaryNothing };
  if (code === "version_conflict") return { kind: "retry", text: "the family changed while you were working. try once more." };
  if (code === "unconfirmed_duplicate") return { kind: "duplicate", text: COPY.dupBlocked };
  if (status === 400 || status === 422) return { kind: "fix", text: "that can't be recorded as asked. go back and check your answers." };
  if (status === 413) return { kind: "fix", text: "that's too much to send at once. please send it in smaller pieces." };
  return { kind: "retry", text: "that didn't send. try again in a moment, or text J." };
}

// ---- the draft kept in sessionStorage ----------------------------------------------------------------------------------------

const KEY_PREFIX = "hfy:wizard:v1:";
export const draftKey = (uid) => `${KEY_PREFIX}${uid}`;
const SCREEN_RE = /^[a-z]\.[a-zA-Z]+$|^(start|check|dup|summary|done)$/;

/** The stored state if it is one this code wrote: the version, the flow, a known screen shape and bounded arrays. Else null. */
export function restoreState(raw) {
  let s = raw;
  if (typeof raw === "string") {
    try { s = JSON.parse(raw); } catch { return null; }
  }
  if (!isObj(s) || s.v !== DRAFT_VERSION) return null;
  if (s.flow !== null && !FLOWS.includes(s.flow)) return null;
  if (typeof s.screen !== "string" || !SCREEN_RE.test(s.screen)) return null;
  if (!isObj(s.draft) || !Array.isArray(s.past) || s.past.length > HISTORY_MAX + 1) return null;
  if (!s.past.every((p) => isObj(p) && typeof p.screen === "string" && SCREEN_RE.test(p.screen) && isObj(p.draft))) return null;
  // A screen that only means "waiting for the server" is not somewhere to wake up: the page checks again, so keep it; "done" is not kept.
  if (s.screen === "done") return null;
  return { v: DRAFT_VERSION, flow: s.flow, screen: s.screen, draft: s.draft, past: s.past };
}
export function saveDraft(storage, uid, state) {
  try {
    if (!storage || !uid) return;
    if (!state.flow) { storage.removeItem(draftKey(uid)); return; }
    storage.setItem(draftKey(uid), JSON.stringify(state));
  } catch { /* storage can be off or full: the wizard works without it */ }
}
export function loadDraft(storage, uid) {
  try {
    if (!storage || !uid) return null;
    const raw = storage.getItem(draftKey(uid));
    return raw ? restoreState(raw) : null;
  } catch { return null; }
}
export function clearDraft(storage, uid) {
  try { if (storage && uid) storage.removeItem(draftKey(uid)); } catch { /* ignore */ }
}

// ---- the page's route ---------------------------------------------------------------------------------------------------------

const GID = /^[A-Za-z0-9._-]{1,64}$/;
/** `?id=<gramps id>` -> the id, or null (no id means "the member's own page"). */
export function routeId(search) {
  try {
    const id = (new URLSearchParams(search || "").get("id") || "").trim();
    return id && GID.test(id) ? id : null;
  } catch { return null; }
}

/** The family-section button on the member's own page: the URL it opens. */
export const wizardHref = (gid) => `/edit/family/?id=${encodeURIComponent(gid)}`;

// ---- what a preview says -----------------------------------------------------------------------------------------------------

/** The preview body as the summary screen needs it: the server's own sentences, warnings in plain words, follow-ups. */
export function previewView(body) {
  const b = isObj(body) ? body : {};
  const summary = (Array.isArray(b.summary) ? b.summary : []).map((s) => (isObj(s) && typeof s.text === "string" ? s.text : null)).filter(Boolean);
  const warnings = (Array.isArray(b.warnings) ? b.warnings : []).map((w) => (isObj(w) && typeof w.detail === "string" ? w.detail : null)).filter(Boolean);
  const followUps = (Array.isArray(b.followUps) ? b.followUps : []).filter((f) => isObj(f) && f.code === "offer_death_year" && typeof f.person === "string");
  return { summary, warnings, followUps, alreadyRecorded: b.already_recorded === true, destructive: b.destructive === true, duplicates: Array.isArray(b.duplicates) ? b.duplicates : [] };
}
