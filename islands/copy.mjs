// HFY design-system pass: DS Voice copy on the committed Eleventy pages, rewritten by islands/build.mjs (like heads.mjs).
//
// The pages under 11ty/ are Eleventy OUTPUT whose source (workspace/11ty-dev: the index content, the about heading,
// partials/footer.njk and the page titles) lives outside this repo. Until io ports the copy there, the build rewrites the committed
// pages, so an Eleventy promotion that brings the old copy back is put right by the next `npm run build`, and `build.mjs --check`
// (CI) fails while a page still carries it. Every rewrite matches the OLD copy only, so applying the set twice changes nothing.
//
// What changes (DS guide/04-voice.md): lowercase headings, no exclamation marks, "sign in" never "log in", the Voice footer, lowercase
// page titles. Family-authored prose (the about story, the person data) is content and is never touched. Person names and
// "Harrison" stay proper nouns.
//
// Workspace port (for io; 11ty/README.md): src/index content -> HERO below; the about and family-login headings; partials/footer.njk -> FOOTER;
// each page's `title` front matter -> TITLES (the layout appends " · Harrison Family").

/** The Voice footer (DS Shell anatomy and the Voice microcopy table). */
export const FOOTER = "harrisonfamily.us · kept by the family, for the family";
const SITE = "Harrison Family";

/** Document titles (<title>, og:title, twitter:title) per page: the page name in lowercase, then the site name. */
export const TITLES = {
  "index.html": { from: ["Harrison Family · Harrison Family Heritage"], title: SITE, og: SITE },
  "about/index.html": { from: ["Harrison Family Heritage - Our Story · Harrison Family Heritage", "Harrison Family Heritage - Our Story"], title: `our story · ${SITE}`, og: "our story" },
  "contact/index.html": { from: ["Contact &amp; Access · Harrison Family Heritage", "Contact &amp; Access"], title: `contact and access · ${SITE}`, og: "contact and access" },
  "family-login/index.html": { from: ["Family Login · Harrison Family Heritage", "Family Login"], title: `sign in · ${SITE}`, og: "sign in" },
  "logged-out/index.html": { from: ["Logged Out · Harrison Family Heritage", "Logged Out"], title: `signed out · ${SITE}`, og: "signed out" },
  "person/index.html": { from: ["Person Profile · Harrison Family Heritage", "Person Profile"], title: `family member · ${SITE}`, og: "family member" },
  "privacy/index.html": { from: ["Privacy Policy · Harrison Family Heritage", "Privacy Policy"], title: `privacy · ${SITE}`, og: "privacy" },
  "private/index.html": { from: ["Private Area - Person Directory · Harrison Family Heritage", "Private Area - Person Directory"], title: `family directory · ${SITE}`, og: "family directory" },
  "search/index.html": { from: ["Search · Harrison Family Heritage", "Search"], title: `search · ${SITE}`, og: "search" },
  "terms/index.html": { from: ["Terms of Service · Harrison Family Heritage", "Terms of Service"], title: `terms · ${SITE}`, og: "terms" },
};

/** Home hero and about heading: [old, new] pairs, exact strings of the Eleventy output. */
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
  "about/index.html": [["Honoring the Harrison Family Legacy</h1>", "honoring the Harrison family legacy</h1>"]],
  "family-login/index.html": [['mb-3">Family Login</h1>', 'mb-3">sign in</h1>']],
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
  "family-login/index.html",
  "logged-out/index.html",
  "person/index.html",
  "privacy/index.html",
  "private/index.html",
  "search/index.html",
  "terms/index.html",
];

const OLD_FOOTER = /&copy; \d{4} Harrison Family Heritage\. All rights reserved\./g;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `html` with the Voice copy applied. Idempotent. */
export function applyCopy(html, page) {
  let out = html.replace(OLD_FOOTER, FOOTER);
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
export const RETIRED = [/All rights reserved/, /Welcome to the Harrison Family Website!/, />About Us</, />Family Login</, /Harrison Family Heritage<\/title>/, />HARRISON FAMILY</];
