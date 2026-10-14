// The shell's navigation, composed from the flags (HFY-TSK-091, HFY-PLN-002 surfaces §3.1). A pure function, no DOM access of its own
// (the shell passes the flags and the edge session's sub), so tests/family-route.test.mjs table-tests every flag combination in node.
//
//   navMe  familyViz   items (order 1..n)
//   off    off         home, family -> own page, search, posts, me -> settings      (the shell before navMe, unchanged)
//   off    on          home, family -> /tree/,   search, posts, me -> settings
//   on     off         home, search, posts, me -> own page                          (4 items: "family" leaves the bar until the tree
//                                                                                    exists, so "family" and "me" never both open it)
//   on     on          home, family -> /tree/,   search, posts, me -> own page      (5 items, the kit's compact cap)
//
// "own page" is the member's own /person/?id=<sub> once the edge session names them, and the stable /private/ redirect until then
// (session pending, signed out, authV2 off): HFYFeatureFlags.goToFamily sends a signed-in member to their own page and a signed-out
// visitor to the sign-in and back (SURF-D3: /private/ stays that redirect). "settings" is what "me" opened before navMe:
// /me/notifications/ with notifyV2, else the account page /auth/link. With navMe the settings live at /me/, behind the shell's gear instead.
// No route may be a gated data prefix (/family/ above all): family-route.test.mjs asserts it for every combination.
import { ownRoute } from "./family-route.js";

/** The own-page redirect, the route of the own-page item while the session does not name the member. */
export const OWN_PAGE_REDIRECT = "/private/";
/** The family tree (viz domain, familyViz). */
export const TREE_ROUTE = "/tree/";
/** The settings hub (navMe): the gear and the account sheet's "settings" open it. */
export const SETTINGS_ROUTE = "/me/";

/** The registry items for the given flags and session sub: [{ id, label, route, icon, order }]. */
export function navItems({ navMe = false, familyViz = false, notifyV2 = false, sub = null } = {}) {
  const own = sub ? ownRoute(sub) : OWN_PAGE_REDIRECT;
  const settings = notifyV2 ? "/me/notifications/" : "/auth/link";
  const items = [{ id: "home", label: "home", route: "/" }];
  if (familyViz) items.push({ id: "family", label: "family", route: TREE_ROUTE });
  else if (!navMe) items.push({ id: "family", label: "family", route: own });
  items.push({ id: "search", label: "search", route: "/search/" }, { id: "posts", label: "posts", route: "/posts/" });
  items.push({ id: "me", label: "me", route: navMe ? own : settings });
  // The icon is a placeholder glyph (a space) so the kit renders its .io-nav__icon span; shell.css paints each item's single-weight
  // line icon as a currentColor mask keyed by data-io-nav-item.
  return items.map((i, n) => ({ ...i, icon: " ", order: n + 1 }));
}

/** True on the settings hub and its sub-paths (/me/, /me/notifications/), where the gear is marked current. */
export const onSettings = (pathname) => pathname === "/me" || pathname.startsWith(SETTINGS_ROUTE);
