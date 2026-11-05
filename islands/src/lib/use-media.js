// True while a media query matches; false when matchMedia is missing. Shared by the /tree/ page (tree.jsx) and its lazy chunks.
import { useEffect, useState } from "react";

export function useMedia(query) {
  const [on, setOn] = useState(() => (typeof matchMedia === "function" ? matchMedia(query).matches : false));
  useEffect(() => {
    if (typeof matchMedia !== "function") return undefined;
    const mq = matchMedia(query);
    const update = () => setOn(mq.matches);
    update();
    mq.addEventListener?.("change", update);
    return () => mq.removeEventListener?.("change", update);
  }, [query]);
  return on;
}
