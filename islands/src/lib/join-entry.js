// The "new here? ask to join." line on the signed-out home page, /about/ and /contact/ (HFY-TSK-140, flag accessRequests; surfaces 7.10).
// Pure data and placement, no React, so a node test can pin the words and the places. The line is a plain link to /join/: no query
// string, so nothing about the visitor (and never an email) travels in a URL.
export const JOIN_HREF = "/join/";
export const LEAD = "new here? ";
export const ACTION = "ask to join.";
export const LINE = `${LEAD}${ACTION}`;

/** The pages that get the line, by the pathname the loader matches. */
export const PAGES = Object.freeze([
  { name: "home", test: /^\/(index\.html)?$/ },
  { name: "about", test: /^\/about\/?(index\.html)?$/ },
  { name: "contact", test: /^\/contact\/?(index\.html)?$/ }
]);

export const pageOf = (pathname) => PAGES.find((p) => p.test.test(pathname)) || null;

/**
 * Where the line goes on each page, as [selector, position] for Element.insertAdjacentElement. It sits right after the page's own
 * call to action, and the Eleventy output is never edited:
 *   home     after the row of buttons under the lede ("our story", "sign in")
 *   about    after the hero section (the signed-in call to action, aboutCta, lands there too)
 *   contact  after the first paragraph, which says how to reach us
 */
export const PLACES = Object.freeze({
  home: ["section.home-hero .home-hero__copy + div", "afterend"],
  about: ["section.about-hero", "afterend"],
  contact: ["main section .container > p", "afterend"]
});

/** { host, position } for the page, or null when the page has no such anchor. `doc` is a Document. */
export function entryTarget(doc, pathname) {
  const page = pageOf(pathname);
  if (!page) return null;
  const [selector, position] = PLACES[page.name];
  const host = doc.querySelector(selector);
  return host ? { host, position, page: page.name } : null;
}

/** Every string the island can show, for the copy test. */
export const allCopy = () => [LEAD.trim(), ACTION, LINE];
