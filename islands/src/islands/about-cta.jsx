// The /about/ call to action (HFY-TSK-136, flag aboutCta; HFY-PLN-002 surfaces 5): for a signed-in member, a close to the family's story,
// "the story isn't finished.", with four cards that send them to look around, add what's missing, fix what's wrong and add photos.
// Mounted in a host inserted after section.about-hero; the story above it is never touched. Signed out (or authV2 off, or the session
// unreachable) it renders nothing. Counts come from /person/index.json and the nudge from the member's own /person/<sub>.json; when
// either fetch fails the cards render without numbers (or without the nudge). A card whose target flag is off shows its browse-only
// variant (lib/about-cta.js), so no card sends a member to a dead end.
import "../posts.css";
import "./about-cta.css";
import { useEffect, useState } from "react";
import { mountAt } from "../lib/mount.jsx";
import { memberSub, useEdgeSession } from "../lib/edge-session.js";
import { ownRoute } from "../lib/family-route.js";
import { CLOSING, HEADING, LEDE, NUDGE_ACTION, buildCards, countsFrom, nudgeLine, ownGap } from "../lib/about-cta.js";

/** Same-origin gated JSON; a background load, so a lapsed session never redirects the reader away from the story. */
async function getJson(url) {
  const f = window.HFYFeatureFlags;
  const init = { credentials: "same-origin", headers: { Accept: "application/json" } };
  const res = await (f && typeof f.dataFetch === "function" ? f.dataFetch(url, init, { interactive: false }) : fetch(url, init));
  if (!res.ok) throw new Error(`${url} ${res.status}`);
  return res.json();
}

/** { flags, counts, gap } once the flags and both fetches have settled; a failed fetch leaves its part null. */
function useCtaData(sub) {
  const [data, setData] = useState(null);
  useEffect(() => {
    if (!sub) return undefined;
    let live = true;
    const f = window.HFYFeatureFlags;
    Promise.allSettled([
      f && typeof f.resolveFlags === "function" ? f.resolveFlags() : Promise.resolve({}),
      getJson("/person/index.json"),
      getJson(`/person/${encodeURIComponent(sub)}.json`)
    ]).then(([flags, manifest, own]) => {
      if (!live) return;
      setData({
        flags: flags.status === "fulfilled" ? flags.value || {} : {},
        counts: manifest.status === "fulfilled" ? countsFrom(manifest.value) : null,
        gap: own.status === "fulfilled" ? ownGap(own.value) : null
      });
    });
    return () => { live = false; };
  }, [sub]);
  return data;
}

function Cards({ sub }) {
  const data = useCtaData(sub);
  if (!data) {
    return (
      <div className="hfy-about-cta__skeletons" role="status" aria-busy="true" aria-label="loading">
        {[0, 1, 2, 3].map((i) => <div key={i} className="hfy-about-cta__skeleton" />)}
      </div>
    );
  }
  const cards = buildCards({ counts: data.counts, flags: data.flags, sub });
  return (
    <>
      {data.gap ? (
        <p className="hfy-about-cta__nudge" data-hfy-nudge>
          <span>{nudgeLine(data.gap)}</span>{" "}
          <a className="hfy-about-cta__nudge-link" href={ownRoute(sub)}>{NUDGE_ACTION}</a>
        </p>
      ) : null}
      <ul className="hfy-about-cta__cards">
        {cards.map((c) => (
          <li key={c.id}>
            <a className="hfy-about-cta__card" href={c.href} data-hfy-card={c.id} data-hfy-variant={c.variant}>
              <span className="hfy-about-cta__title">{c.title}</span>
              <span className="hfy-about-cta__line">{c.line}</span>
              <span className="hfy-about-cta__action">{c.action}</span>
            </a>
          </li>
        ))}
      </ul>
    </>
  );
}

export function AboutCta() {
  const session = useEdgeSession();
  const sub = memberSub(session);
  if (!sub) return null;
  return (
    <section className="hfy-about-cta" aria-labelledby="hfy-about-cta-h" data-hfy-about-cta>
      <div className="container">
        <h2 className="hfy-h hfy-about-cta__h" id="hfy-about-cta-h">{HEADING}</h2>
        <p className="hfy-about-cta__lede">{LEDE}</p>
        <Cards sub={sub} />
        <p className="hfy-about-cta__closing">{CLOSING}</p>
      </div>
    </section>
  );
}

const run = () => {
  const hero = document.querySelector("section.about-hero");
  if (!hero) return;
  mountAt((h) => hero.insertAdjacentElement("afterend", h), <AboutCta />, "hfy-about-cta");
};
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", run, { once: true }); else run();
