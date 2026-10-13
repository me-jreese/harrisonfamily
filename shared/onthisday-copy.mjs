// On this day, the copy deck (HFY-PLN-002 surfaces section 4.2). Pure, no imports: it renders in the island and in tests, so the
// voice lives in one place. Voice rules the test enforces: lowercase except placeholders, no "!", no "record", no emoji in a
// remember row, correct plurals. Placeholders are {name} {a} {b} {n} {y} {yearWord} {place} {detail} {when} {author}.

export const HEADINGS = Object.freeze({ day: "on this day", week: "this week in family history", year: "this year in family history" });
export const REMEMBERING_LABEL = "remembering";
export const FOOTER_LINK = Object.freeze({ text: "see the family", href: "/search/" });
const WHEN = Object.freeze({ day: "today", week: "this week", year: "this year" });
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** Every template, by id. The voice test renders each one. */
export const TEMPLATES = Object.freeze({
  marriage: "{a} and {b} got married {n} {yearWord} ago {when}.",
  graduation: "{name} graduated {n} {yearWord} ago {when}.",
  graduation_from: "{name} graduated from {detail} {n} {yearWord} ago {when}.",
  degree: "{name} earned a degree {n} {yearWord} ago {when}.",
  degree_detail: "{name} earned {detail} {n} {yearWord} ago {when}.",
  education: "{n} {yearWord} ago {when}: {name}, {detail}.",
  birth_living: "{name} turns {n} this year.",
  birth_other: "{name} was born {n} {yearWord} ago, in {y}.",
  residence: "{name} moved to {place} {n} {yearWord} ago {when}.",
  death_day: "remembering {name}, who died {n} {yearWord} ago today.",
  death_week: "remembering {name}. {n} {yearWord} ago this week.",
  death_year: "it's been {n} {yearWord} since we lost {name}.",
  burial_day: "remembering {name}, who was laid to rest {n} {yearWord} ago today.",
  burial_week: "remembering {name}. laid to rest {n} {yearWord} ago this week.",
  burial_year: "it's been {n} {yearWord} since {name} was laid to rest.",
  post_text_one: "a year ago today, {author} posted:",
  post_text_many: "{n} years ago today, {author} posted:",
  post_photo_one: "a year ago today, {author} shared a photo.",
  post_photo_many: "{n} years ago today, {author} shared a photo.",
  prompt_targeted: "know the day {a} and {b} got married? add it to their page.",
  prompt_generic: "no dates for today yet. know when something happened in the family? add it to someone's page.",
});

/** "year" for 1, "years" otherwise. */
export const yearWord = (n) => (n === 1 ? "year" : "years");

/** Fill a template into parts: `{ text }` runs, and `{ name, grampsId? }` runs for people (so the island can link and set them in font.display). */
export function fill(template, vars = {}) {
  const parts = [];
  for (const piece of template.split(/(\{\w+\})/)) {
    const m = /^\{(\w+)\}$/.exec(piece);
    if (!m) { if (piece) parts.push({ text: piece }); continue; }
    const v = vars[m[1]];
    if (v && typeof v === "object") parts.push({ name: v.name, ...(v.grampsId ? { grampsId: v.grampsId } : {}) });
    else parts.push({ text: v == null ? "" : String(v) });
  }
  return parts;
}
const join = (parts) => parts.map((p) => p.text ?? p.name).join("");

/** The template id for an item, or null when the item cannot be worded (it should be skipped). Items carry `when` ∈ day|week|year. */
export function templateFor(item) {
  const when = item.when === "day" || item.when === "week" ? item.when : "year";
  switch (item.kind) {
    case "marriage": return item.people?.length >= 2 ? "marriage" : null;
    case "graduation": return item.detail ? "graduation_from" : "graduation";
    case "degree": return item.detail ? "degree_detail" : "degree";
    case "education": return item.detail ? "education" : null;
    case "birth": return item.tone === "celebrate" && item.people?.[0]?.lifeState === "living" && item.n <= 100 ? "birth_living" : "birth_other";
    case "residence": return item.place ? "residence" : null;
    case "death": return `death_${when}`;
    case "burial": return `burial_${when}`;
    default: return null;
  }
}

/** An item as parts, or null. A trailing emoji appears only on a non-remember row that carries one. */
export function renderItemParts(item) {
  const id = templateFor(item);
  if (!id || !Number.isInteger(item.n)) return null;
  const [a, b] = item.people ?? [];
  const parts = fill(TEMPLATES[id], {
    name: a, a, b, n: item.n, y: item.year, yearWord: yearWord(item.n), place: item.place, detail: item.detail, when: WHEN[item.when] ?? WHEN.year,
  });
  if (item.emoji && item.tone !== "remember") parts.push({ text: ` ${item.emoji}` });
  return parts;
}
export const renderItem = (item) => { const p = renderItemParts(item); return p && join(p); };

/** A past-year post card line as parts. `post` is `{ n, author: { label }, photo? }`; a photo post reads "shared a photo". */
export function renderPostParts(post) {
  const photo = post.photo ? "photo" : "text";
  const id = `post_${photo}_${post.n === 1 ? "one" : "many"}`;
  return fill(TEMPLATES[id], { n: post.n, author: { name: post.author?.label ?? "", grampsId: post.author?.id } });
}
export const renderPost = (post) => join(renderPostParts(post));

/** The prompt as parts: targeted when it carries two people, generic otherwise. */
export function renderPromptParts(prompt) {
  const [a, b] = prompt?.people ?? [];
  return prompt?.kind === "add_day" && a && b ? fill(TEMPLATES.prompt_targeted, { a, b }) : fill(TEMPLATES.prompt_generic);
}
export const renderPrompt = (prompt) => join(renderPromptParts(prompt));

/** The heading for a tier (day, week, year), or null for archive and prompt, which have none. */
export const headingFor = (tier) => HEADINGS[tier] ?? null;

/** "2026-10-13" -> "oct 13" (the design system's lowercase date line). Anything malformed yields "". */
export function dateLine(date) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date));
  return m && +m[2] >= 1 && +m[2] <= 12 ? `${MONTHS[+m[2] - 1]} ${+m[3]}` : "";
}
