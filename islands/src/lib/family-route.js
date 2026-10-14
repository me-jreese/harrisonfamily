// The own-page tab: "family" ("your family") without navMe, "me" with it (HFY-TSK-091, lib/nav.js). Which page is the member's own,
// and what the nav matches its routes against. Pure functions, no DOM access of their own (the shell passes window.location), so
// tests/family-route.test.mjs runs them in node.

import { personPath } from "./person-name.js";

/** The member's own page: /person/?id=<sub> (the edge session's sub is the gramps id); the account menu's "your page" is the same URL. */
export const ownRoute = (sub) => personPath(sub);
// True on that page only. Another person's page (/person/?id=<someone else>) is nobody's tab: it is reached from the tree, a search
// or a link, so no item is marked there (marking the own-page tab would say it is the member's own page, marking "search" would guess
// how they arrived). The id is compared exactly, as the person data keys are.
export const onOwnPage = (loc, sub) => /^\/person(\/(index\.html)?)?$/.test(loc.pathname) && new URLSearchParams(loc.search).get("id") === sub;
// The pathname the kit matches the registry routes against. The kit's rule is path equality or a sub-path, and an item's route
// can carry a query (the own page), so on the own page the pathname is that route itself; everywhere else it is the real path.
export const navPathname = (loc, sub) => (sub && onOwnPage(loc, sub) ? ownRoute(sub) : loc.pathname);
