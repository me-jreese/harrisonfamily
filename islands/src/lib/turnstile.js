// Cloudflare Turnstile for the /join/ page (HFY-TSK-140; surfaces 7.5 and BRD2 5.3: "Turnstile loads only on /join/"). The script is
// requested by the join island once the edge's config says asking to join is open, never by any other page. One load per page; a failed
// load is forgotten so a later try can ask again. The edge verifies action "join" and the site's hostname.
export const TURNSTILE_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
export const TURNSTILE_ACTION = "join";

let pending = null;

/** window.turnstile once the script has loaded. Rejects when it cannot load. */
export function loadTurnstile() {
  if (typeof window === "undefined") return Promise.reject(new Error("no window"));
  if (window.turnstile && typeof window.turnstile.render === "function") return Promise.resolve(window.turnstile);
  if (pending) return pending;
  pending = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = TURNSTILE_SRC;
    script.async = true;
    script.defer = true;
    script.onload = () => {
      if (window.turnstile && typeof window.turnstile.render === "function") resolve(window.turnstile);
      else { pending = null; script.remove(); reject(new Error("turnstile missing")); }
    };
    script.onerror = () => { pending = null; script.remove(); reject(new Error("turnstile blocked")); };
    document.head.appendChild(script);
  });
  return pending;
}
