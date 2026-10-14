// The feed line island piece (HFY-TSK-190, flag contribV1): fetches GET /api/contributions/stats once and draws p.hfy-contrib-line.
import { useEffect, useState } from "react";
import { api, edgeSignedOut } from "./api.js";
import { lineFor } from "./contrib-line.js";

/** One GET per page load; any failure (signed out, flag dark, offline) draws nothing. */
export function useContribLine() {
  const [text, setText] = useState(null);
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const flags = window.HFYFeatureFlags;
        if (!flags?.resolveFlags || (await flags.resolveFlags()).contribV1 !== true) return;
        if (await edgeSignedOut()) return;
        const t = lineFor(await api.get("/contributions/stats"));
        if (live && t) setText(t);
      } catch { /* signed out, route dark or offline: no line */ }
    })();
    return () => { live = false; };
  }, []);
  return text;
}

export function ContribLine() {
  const text = useContribLine();
  return text ? <p className="hfy-contrib-line" data-hfy-contrib-line>{text}</p> : null;
}
