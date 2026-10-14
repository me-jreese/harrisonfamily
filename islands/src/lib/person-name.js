// HFY-TSK-323, ruling P2-R46 (io: "whenever we list someones name, it should be a link (with NO underline) to their profile"). The one
// rule for where a person's name links, shared by every island: the kit author links (@io-kit/content PostCard and ArticleView,
// @io-kit/comments Thread, through `authorHref`), the photo-tag names (lib/photo-tags.js and lib/photo-tags-ui.js, through personHref and
// personNameNode) and the React <PersonName> (lib/person-name.jsx). Pure apart from personNameNode, which only builds nodes from the
// document it is given, so tests/person-name.test.mjs runs it in node. The look (no underline in any state, the name's own colour and
// weight, the theme focus ring) is `a.hfy-person-name` in src/theme/20-base.css; the kit author links are styled in posts.css and
// comments.css.

/**
 * A Gramps person id: `I` and digits. The edge session's sub, and so every post and comment author id, is one; anything else (an
 * empty, missing or non-string id, a label-only principal) is not a person page, and the name stays plain text.
 */
export const PERSON_ID = /^I\d+$/;
export const isPersonId = (id) => typeof id === "string" && PERSON_ID.test(id);

/**
 * A record-id mention in free text (R18, comments-ui linkify): `I` and four or more digits, so prose like "I2" is not taken for an id.
 * The digits are a subset of PERSON_ID, so every mention links to the same page an author link would.
 */
export const MENTION_SOURCE = "I\\d{4,}";

/** The person page for an id, unchecked: the account menu's "your page" (family-route ownRoute), mentions and the search rows. */
export const personPath = (id) => `/person/?id=${encodeURIComponent(id)}`;

/** `/person/?id=<id>` when `id` is a Gramps person id, else null (the name is then shown as plain text). */
export const personHref = (id) => (isPersonId(id) ? personPath(id) : null);

/** The kit `authorHref(author)` prop (PostCard, ArticleView, Thread): the author's person page, or null for plain text. */
export const authorHref = (author) => personHref(author ? author.id : undefined);

/** The class every person-name link carries (src/theme/20-base.css). */
export const PERSON_NAME_CLASS = "hfy-person-name";

/**
 * The name as DOM: `<a class="hfy-person-name" href="/person/?id=<id>">name</a>` for a Gramps person id, else
 * `<span class="hfy-person-name">name</span>`. The name is a text node (member-editable data is never parsed as markup). `className`
 * adds the caller's own class.
 */
export function personNameNode(doc, { id, name, className } = {}) {
  const href = personHref(id);
  const n = doc.createElement(href ? "a" : "span");
  n.className = className ? `${PERSON_NAME_CLASS} ${className}` : PERSON_NAME_CLASS;
  if (href) n.setAttribute("href", href);
  n.textContent = name == null ? "" : String(name);
  return n;
}
