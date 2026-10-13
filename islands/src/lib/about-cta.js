// The /about/ call to action (HFY-TSK-136, flag aboutCta; HFY-PLN-002 surfaces 5). Pure data and copy, no DOM, so a node test can pin the
// words (tests/about-cta.test.mjs): lowercase, no exclamation mark, never "record", "users" or "members".
import { ownRoute } from "./family-route.js";
import { mapPerson } from "./people-corpus.js";

export const HEADING = "the story isn't finished.";
export const LEDE = "it keeps going with every name, date and photo the family adds. a lot of pages are still thin, and you probably know something that isn't here yet.";
export const CLOSING = "the memories live on.";
export const NUDGE_ACTION = "open your page";

const n = (count) => count.toLocaleString("en-US");

/**
 * Counts from the family index (/person/index.json rows). `people` is null when the rows are unavailable; a card then renders its
 * count-free line. A row's birth year is read the way the search corpus reads it (lib/people-corpus.js mapPerson), so a card's count
 * and the search it opens agree.
 */
export function countsFrom(manifest) {
  const rows = Array.isArray(manifest && manifest.people) ? manifest.people : Array.isArray(manifest) ? manifest : null;
  if (!rows) return { people: null, noPhoto: null, noBirthYear: null };
  let people = 0;
  let noPhoto = 0;
  let noBirthYear = 0;
  for (const raw of rows) {
    const p = mapPerson(raw);
    if (!p) continue;
    people += 1;
    if (!p.fields.has_photo) noPhoto += 1;
    if (!p.fields.has_birth_year) noBirthYear += 1;
  }
  return { people, noPhoto, noBirthYear };
}

/** The first gap on the member's own page (/person/<sub>.json), in the order photo, birth year, birthplace, story; null if none or unknown. */
export function ownGap(person) {
  if (!person || typeof person !== "object") return null;
  const birth = person.lifespan && person.lifespan.birth;
  if (!person.primaryPhoto) return "a photo";
  if (!birth || birth.year == null) return "a birth year";
  if (!birth.place || !birth.place.displayName) return "a birthplace";
  if (!Array.isArray(person.notes) || person.notes.length === 0) return "a story";
  return null;
}
export const nudgeLine = (gap) => `your page is missing ${gap}. start there?`;

/** Which cards are the full "do something" cards: recordEdit gates the two edit cards, commentPhotosV1 or the own-page composer (postsV2) the photo card. */
export function cardModes(flags) {
  const f = flags || {};
  return {
    edit: f.recordEdit === true,
    photoSearch: f.commentPhotosV1 === true,
    photoShare: f.commentPhotosV1 !== true && f.postsV2 === true
  };
}

const zero = (count) => count === 0;
const have = (count) => typeof count === "number";

/**
 * The four cards for the given counts, flags and member. Each is { id, variant: "edit" | "browse", title, line, action, href }.
 * `sub` is the member's id (the edge session's sub). Without it the cards that point at the member's page point at the search.
 */
export function buildCards({ counts, flags, sub }) {
  const c = counts || {};
  const mode = cardModes(flags);
  const own = sub ? ownRoute(sub) : "/search/";
  const cards = [];

  cards.push({
    id: "look",
    variant: "edit",
    title: "look around",
    line: have(c.people) && !zero(c.people) ? `${n(c.people)} people so far. find someone you remember.` : "find someone you remember.",
    action: "open the family",
    href: "/search/"
  });

  if (mode.edit) {
    cards.push({
      id: "missing",
      variant: "edit",
      title: "add what's missing",
      line: !have(c.noBirthYear) ? "know a birth year that isn't here? add it."
        : zero(c.noBirthYear) ? "every page has a birth year. nice work, family."
        : `${n(c.noBirthYear)} ${c.noBirthYear === 1 ? "person doesn't" : "people don't"} have a birth year yet. know one? add it.`,
      action: "see who's missing a year",
      href: "/search/?has_birth_year=false"
    });
    cards.push({
      id: "fix",
      variant: "edit",
      title: "fix what's wrong",
      line: "see a wrong date or a misspelled name? open that page and suggest a fix. we check it before it changes.",
      action: "start with your page",
      href: own
    });
  } else {
    cards.push({
      id: "missing",
      variant: "browse",
      title: "see what's missing",
      line: !have(c.noBirthYear) ? "some pages don't have a birth year yet."
        : zero(c.noBirthYear) ? "every page has a birth year. nice work, family."
        : `${n(c.noBirthYear)} ${c.noBirthYear === 1 ? "person doesn't" : "people don't"} have a birth year yet.`,
      action: "see who's missing a year",
      href: "/search/?has_birth_year=false"
    });
    cards.push({
      id: "fix",
      variant: "browse",
      title: "check your page",
      line: "open your page and read it through. you know it better than anyone.",
      action: "open your page",
      href: own
    });
  }

  if (mode.photoSearch || mode.photoShare) {
    cards.push({
      id: "photos",
      variant: "edit",
      title: "add photos",
      line: !have(c.noPhoto) ? "a phone photo of an old print counts."
        : zero(c.noPhoto) ? "every page has a photo. nice work, family."
        : `${n(c.noPhoto)} ${c.noPhoto === 1 ? "person doesn't" : "people don't"} have a photo yet. a phone photo of an old print counts.`,
      action: mode.photoSearch || !sub ? "see who needs a photo" : "add a photo",
      href: mode.photoSearch || !sub ? "/search/?has_photo=false" : `${ownRoute(sub)}#share`
    });
  } else {
    cards.push({
      id: "photos",
      variant: "browse",
      title: "look at photos",
      line: !have(c.noPhoto) ? "some pages don't have a photo yet."
        : zero(c.noPhoto) ? "every page has a photo. nice work, family."
        : `${n(c.noPhoto)} ${c.noPhoto === 1 ? "person doesn't" : "people don't"} have a photo yet.`,
      action: "see who's missing a photo",
      href: "/search/?has_photo=false"
    });
  }
  return cards;
}

/** Every string the island can show, for the copy test. */
export function allCopy() {
  const out = [HEADING, LEDE, CLOSING, NUDGE_ACTION];
  out.push("see who needs a photo");
  for (const gap of ["a photo", "a birth year", "a birthplace", "a story"]) out.push(nudgeLine(gap));
  const flagSets = [{}, { recordEdit: true }, { commentPhotosV1: true }, { postsV2: true }, { recordEdit: true, commentPhotosV1: true, postsV2: true }];
  const countSets = [{}, { people: 0, noPhoto: 0, noBirthYear: 0 }, { people: 1, noPhoto: 1, noBirthYear: 1 }, { people: 1200, noPhoto: 340, noBirthYear: 55 }];
  for (const flags of flagSets) for (const counts of countSets) for (const c of buildCards({ counts, flags, sub: "I0001" })) out.push(c.title, c.line, c.action);
  return out;
}
