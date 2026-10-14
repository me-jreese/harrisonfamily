// HFY design-system pass: DS Voice copy on the committed Eleventy pages, rewritten by islands/build.mjs (like heads.mjs).
//
// The pages under 11ty/ are Eleventy OUTPUT whose source (workspace/11ty-dev: the index content, the about heading,
// partials/footer.njk and the page titles) lives outside this repo. Until io ports the copy there, the build rewrites the committed
// pages, so an Eleventy promotion that brings the old copy back is put right by the next `npm run build`, and `build.mjs --check`
// (CI) fails while a page still carries it. Every rewrite matches the OLD copy only, so applying the set twice changes nothing.
//
// What changes (DS guide/04-voice.md): lowercase headings, no exclamation marks, "sign in" never "log in", the Voice footer with its
// quiet links, lowercase page titles, the Voice meta description, the sign-in flash copy, the person page's static strings. Family-
// authored prose (the about story, the person data) is content and is never touched, beyond fixing a typo in it. Person names and
// "Harrison" stay proper nouns.
//
// Workspace port (for io; 11ty/README.md): src/index content -> HERO below; the about heading; partials/footer.njk -> FOOTER;
// each page's `title` front matter -> TITLES (the layout appends " · Harrison Family").

/** The Voice footer (DS Shell anatomy and the Voice microcopy table). */
export const FOOTER = "harrisonfamily.us · kept by the family, for the family";
/**
 * The quiet links after the footer line. The shell hides the Bootstrap navbar that carried about and contact, and nothing linked
 * /privacy/ or /terms/ at all, so /contact/, /privacy/ and /terms/ were orphaned. Lowercase labels; islands/src/theme/40-site.css
 * styles them (44px targets, text.dim, underlined).
 */
export const FOOTER_LINKS = [["about", "/about/"], ["contact", "/contact/"], ["privacy", "/privacy/"], ["terms", "/terms/"]];
export const FOOTER_NAV = `<nav class="site-footer__links" aria-label="about this site">${FOOTER_LINKS.map(([label, href]) => `<a href="${href}">${label}</a>`).join("")}</nav>`;
/** The site-wide <meta name=description> / og / twitter text of the Eleventy default, and its Voice replacement. */
export const OLD_DESCRIPTION = "Modern genealogy archive built with gramps, 11ty and bootstrap. Family members, login to see your data.";
export const DESCRIPTION = "the Harrison family archive. family members sign in to see the private pages.";
const SITE = "Harrison Family";

/** Document titles (<title>, og:title, twitter:title) per page: the page name in lowercase, then the site name. */
export const TITLES = {
  "index.html": { from: ["Harrison Family · Harrison Family Heritage"], title: SITE, og: SITE },
  "about/index.html": { from: ["Harrison Family Heritage - Our Story · Harrison Family Heritage", "Harrison Family Heritage - Our Story"], title: `our story · ${SITE}`, og: "our story" },
  "contact/index.html": { from: ["Contact &amp; Access · Harrison Family Heritage", "Contact &amp; Access"], title: `contact and access · ${SITE}`, og: "contact and access" },
  "logged-out/index.html": { from: ["Logged Out · Harrison Family Heritage", "Logged Out"], title: `signed out · ${SITE}`, og: "signed out" },
  "person/index.html": { from: ["Person Profile · Harrison Family Heritage", "Person Profile"], title: `family member · ${SITE}`, og: "family member" },
  "privacy/index.html": { from: ["Privacy Policy · Harrison Family Heritage", "Privacy Policy"], title: `privacy · ${SITE}`, og: "privacy" },
  // The own-page redirect (HFYFeatureFlags.goToFamily), the "me" item's route while the session does not name the member; it replaced
  // the 2025 "Person Directory" dev scaffold. "your page" since the navMe flip (HFY-TSK-223), as the account sheet's link; the
  // pre-flip "your family" title is rewritten too, so an Eleventy refresh that brings it back is put right by the next build.
  "private/index.html": { from: ["Your Family · Harrison Family Heritage", "Your Family", `your family · ${SITE}`, "your family"], title: `your page · ${SITE}`, og: "your page" },
  "search/index.html": { from: ["Search · Harrison Family Heritage", "Search"], title: `search · ${SITE}`, og: "search" },
  "terms/index.html": { from: ["Terms of Service · Harrison Family Heritage", "Terms of Service"], title: `terms · ${SITE}`, og: "terms" },
};

/** The /logged-out/ copy (also in the Eleventy source, src/logged-out.njk). */
export const SIGNED_OUT = { heading: "you're signed out.", lede: "come back whenever you like.", signIn: "sign in again", home: "home" };

/** Page copy: [old, new] pairs per page, exact strings of the Eleventy output (hero, headings, typos, static strings). */
export const HERO = {
  "index.html": [
    // The Eleventy output also closes this h1 with a second <h1> (an empty heading in the DOM); the rewrite closes it properly.
    ["<h1>Welcome to the Harrison Family Website!<h1>", "<h1>hi family. this is where we keep our history.</h1>"],
    ["<h1>Welcome to the Harrison Family Website!</h1>", "<h1>hi family. this is where we keep our history.</h1>"],
    // The sub-line is a lede paragraph, not an <h3> (it skipped a heading level under the h1; QA2). Both the original and the already
    // lowercased h3 become the paragraph, so the rewrite stays idempotent (the new markup contains neither).
    ["<h3>Learn about our heritage and help us preserve our family history.</h3>", '<p class="home-hero__lede">learn about our heritage and help us preserve our family history.</p>'],
    ["<h3>learn about our heritage and help us preserve our family history.</h3>", '<p class="home-hero__lede">learn about our heritage and help us preserve our family history.</p>'],
    ['href="/about/">About Us</a>', 'href="/about/">our story</a>'],
    ['data-feature="familyLoginLink">Family Login</a>', 'data-feature="familyLoginLink">sign in</a>'],
  ],
  "about/index.html": [
    ["Honoring the Harrison Family Legacy</h1>", "honoring the Harrison family legacy</h1>"],
    // The one typo in the story: "two hundred twenty (222) years" said the number twice, and "twenty" is not 222.
    ["two hundred twenty (222) years", "two hundred twenty-two years"]
  ],
  // /logged-out/ is shown after every sign-out. The Eleventy source (src/logged-out.njk) carries the same copy; this puts the old text right
  // after a refresh from a source that has not been ported. "sign in again" goes straight to the edge sign-in.
  "logged-out/index.html": [
    ['<h1 class="mb-3">You are signed out</h1>', `<h1 class="mb-3">${SIGNED_OUT.heading}</h1>`],
    [`<p class="lead text-muted mb-4">Your session has ended successfully. Use the button below to sign back in when you're ready.</p>`, `<p class="lead text-muted mb-4">${SIGNED_OUT.lede}</p>`],
    ['<a class="btn btn-primary" href="/family-login/">Return to Family Login</a>', `<a class="btn btn-primary" href="/auth/login">${SIGNED_OUT.signIn}</a>`],
    ['<a class="btn btn-outline-light" href="/">Back to Home</a>', `<a class="btn btn-outline-light" href="/">${SIGNED_OUT.home}</a>`]
  ],
  // The person page's static strings, shown before person-page.js paints its own (and in the lightbox, which it never repaints).
  "person/index.html": [
    ["Loading person record…", "loading…"],
    ["Loading high-resolution media…", "loading the full-size photo…"],
    ["Download original", "download original"]
  ],
  // The address is obfuscated on purpose; only the zero in "[D0T]" was wrong. The pages' wording is io's to rewrite, not this build's.
  "contact/index.html": [["harrisonfamily [D0T] us", "harrisonfamily [DOT] us"]],
  "privacy/index.html": [["harrisonfamily [D0T] us", "harrisonfamily [DOT] us"]],
  "terms/index.html": [["harrisonfamily [D0T] us", "harrisonfamily [DOT] us"]]
};

/**
 * Intrinsic size of each page's hero photograph (width x height of the committed file in 11ty/images/), written as width/height
 * attributes so the browser reserves the box before the file arrives (the unsized <img> pushed the copy from y=148 to y=520 on load,
 * a 0.325 layout shift; QA2). CSS still decides the displayed size (.home-hero__image).
 */
export const HERO_IMAGES = {
  "index.html": { src: "/images/00_mama_harrison.jpg", width: 3038, height: 3931 },
  "about/index.html": { src: "/images/Adell-MinorSr-1901-cropped.jpg", width: 2358, height: 1784 },
};

/** Every page with the Eleventy footer. */
export const COPY_PAGES = [
  "index.html",
  "about/index.html",
  "contact/index.html",
  "logged-out/index.html",
  "person/index.html",
  "privacy/index.html",
  "private/index.html",
  "search/index.html",
  "terms/index.html",
];

/** Repo-owned pages that carry the same footer but have no Eleventy title to rewrite: they get the footer and its links only. */
export const COPY_EXTRA = ["posts/index.html", "me/index.html", "me/notifications/index.html", "me/links/index.html"];

const OLD_FOOTER = /&copy; \d{4} Harrison Family Heritage\. All rights reserved\./g;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `html` with the Voice copy applied. Idempotent. */
export function applyCopy(html, page) {
  let out = html.replace(OLD_FOOTER, FOOTER).split(OLD_DESCRIPTION).join(DESCRIPTION);
  // the quiet footer links, once, after the footer line (the lookahead makes a second pass a no-op)
  out = out.replace(new RegExp(`(<p class="site-footer__text[^"]*">${esc(FOOTER)}</p>)(?!\\s*<nav class="site-footer__links")`, "g"), (m, p, at) => {
    const lineStart = out.lastIndexOf("\n", at - 1) + 1;
    const lead = out.slice(lineStart, at);
    return `${p}\n${/^[ \t]*$/.test(lead) ? lead : ""}${FOOTER_NAV}`;
  });
  const t = TITLES[page];
  if (t) {
    for (const from of t.from) {
      out = out.replace(new RegExp(`<title>${esc(from)}</title>`), `<title>${t.title}</title>`);
      out = out.replace(new RegExp(`(<meta (?:property="og:title"|name="twitter:title") content=")${esc(from)}(" />)`, "g"), `$1${t.og}$2`);
    }
  }
  for (const [from, to] of HERO[page] || []) out = out.split(from).join(to);
  // The fallback navbar's wordmark: the site name as a proper noun, not shouted ("HARRISON FAMILY"; the shell's own wordmark is
  // "Harrison Family" in the display serif). Painted only until the shell mounts.
  out = out.split('class="navbar-brand" href="/">HARRISON FAMILY</a>').join('class="navbar-brand" href="/">Harrison Family</a>');
  const img = HERO_IMAGES[page];
  if (img) out = out.replace(new RegExp(`(<img\\s+src="${esc(img.src)}")(?![^>]*\\swidth=)`), `$1 width="${img.width}" height="${img.height}"`);
  return out;
}

/** Strings that must not survive on any page (theme-delivery / copy tests). */
export const RETIRED = [
  /All rights reserved/, /Welcome to the Harrison Family Website!/, />About Us</, />Family Login</, /Harrison Family Heritage<\/title>/, />HARRISON FAMILY</,
  /Modern genealogy archive built with gramps/, /\[D0T\]/, /two hundred twenty \(222\)/, /You are signed out/, /Return to Family Login/, /Loading person record/, /Loading high-resolution media/, /Download original/,
  /approved Google account to access/, /Loading authentication status/
];
