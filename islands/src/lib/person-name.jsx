// HFY-TSK-323, ruling P2-R46: a person's name is always a link to their page. The islands' one entry for it: the rule, the hrefs and the
// DOM twin come from lib/person-name.js (pure, so node tests and the non-React photo tags use it directly), and <PersonName> renders a
// name an island draws itself. The kit draws the post, article and comment author names and takes the same rule through `authorHref`
// (posts-ui CARD_PROPS, comments-ui Thread).
import { PERSON_NAME_CLASS, personHref } from "./person-name.js";

export { MENTION_SOURCE, PERSON_ID, PERSON_NAME_CLASS, authorHref, isPersonId, personHref, personNameNode, personPath } from "./person-name.js";

/**
 * A person's name: `<a class="hfy-person-name" href="/person/?id=<id>">` when `id` is a Gramps person id, else the same name as a
 * `<span class="hfy-person-name">`. Same colour and weight as the text around it, never underlined, with the theme focus ring
 * (src/theme/20-base.css). `children` replaces `name` as the visible text.
 */
export function PersonName({ id, name, children, className }) {
  const href = personHref(id);
  const cls = className ? `${PERSON_NAME_CLASS} ${className}` : PERSON_NAME_CLASS;
  const text = children ?? name;
  return href ? <a className={cls} href={href}>{text}</a> : <span className={cls}>{text}</span>;
}
