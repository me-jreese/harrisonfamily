// The posts-page media carousel (HFY-TSK-388-0C, flag mediaBrowserV1; BRD HFY-PLN-004 D-29, D-30, D-31, D-38; board B1). The kit's MediaCarousel is mounted in a
// host placed before the feed (`[data-island="posts"]` on the static /posts/ page): newest first across both sections (section=all), s320 thumbnails only,
// a 280 px band on desktop and at most half the viewport on a phone, collapse once the feed has scrolled past it, back at scroll top. The "all media" header link
// and the trailing card go to /all-media/ (not in the main menu). Signed out: nothing. A failed read, or a throw while drawing, removes the band and never
// touches the feed. When the shell wraps the page in its scroller, the collapse watches that scroller instead of the window.
import "@io-kit/media/tokens.css";
import "@io-kit/media/browser.css";
import "./media-carousel.css";
import { Component, useEffect, useMemo, useRef, useState } from "react";
import { MediaCarousel } from "@io-kit/media/browser";
import { createHfyMediaBrowse } from "../lib/hfy-media-browse.js";
import { ALL_MEDIA_BASE, carouselDetailHref, guardSource, showsOnPath } from "../lib/media-carousel-model.js";
import { memberSub, useEdgeSession } from "../lib/edge-session.js";
import { mountAt } from "../lib/mount.jsx";

class Quiet extends Component {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch() { /* nothing sensitive to log: the band is optional */ }
  render() { return this.state.failed ? null : this.props.children; }
}

function Band() {
  const session = useEdgeSession();
  const [failed, setFailed] = useState(false);
  const [scroller, setScroller] = useState(null);
  const host = useRef(null);
  const source = useMemo(() => guardSource(createHfyMediaBrowse(), () => setFailed(true)), []);
  useEffect(() => {
    const find = () => setScroller(host.current?.closest("[data-io-scroller]") || null);
    find();
    const timers = [300, 1200, 3000].map((ms) => setTimeout(find, ms));
    return () => timers.forEach(clearTimeout);
  }, []);
  if (!memberSub(session) || failed) return null;
  return (
    <div ref={host} className="hfy-mc" data-hfy-mc>
      <MediaCarousel source={source} hrefFor={carouselDetailHref} allMediaHref={ALL_MEDIA_BASE} scrollElement={scroller} />
    </div>
  );
}

function start() {
  if (!showsOnPath(location.pathname, location.search)) return;
  const feed = document.querySelector('[data-island="posts"]');
  if (!feed || !feed.parentNode) return;
  mountAt((h) => feed.parentNode.insertBefore(h, feed), <Quiet><Band /></Quiet>, "hfy-media-carousel");
}

try { start(); } catch { /* the feed stands on its own */ }
