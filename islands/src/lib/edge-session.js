// The page's edge session for the React islands (HFY-TSK-091). One hook and one rule, so the shell's account control, its gear and
// the /me/ settings hub agree on who is signed in: a visitor the bar shows "sign in" to never gets the hub's rows or "sign out".
// HFYFeatureFlags.edgeSession() makes one GET /auth/session per page and shares the answer, so each caller costs no extra request.
import { useEffect, useState } from "react";

/**
 * undefined while the probe is pending; null when authV2 is off, /auth/session is unreachable, feature-flags.js is missing or the
 * probe rejects; else the session, {authenticated, sub, label}.
 */
export function useEdgeSession() {
  const [session, setSession] = useState(undefined);
  useEffect(() => {
    let live = true;
    const probe = window.HFYFeatureFlags?.edgeSession;
    Promise.resolve(typeof probe === "function" ? probe() : null).then(
      (s) => { if (live) setSession(s ?? null); },
      () => { if (live) setSession(null); }
    );
    return () => { live = false; };
  }, []);
  return session;
}

/** The member's id when the session is authenticated and names them, else null. Only such a session is "signed in". */
export const memberSub = (session) => (session && session.authenticated === true && session.sub ? String(session.sub) : null);
