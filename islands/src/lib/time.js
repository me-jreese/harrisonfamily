// The one site time format (DS Voice "Time" and Posts "Time format (decision)"), shared by posts, comments and notifications:
// `just now` · `5 min ago` · `3 hr ago` · `yesterday` · `oct 3` · `oct 3, 2024`. Relative under 7 days, `mon d` in the same
// year, `mon d, yyyy` otherwise; lowercase like everything else. The full date and time goes in a title attribute (fullTime).
const MON = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MIN = 60e3;
const HR = 60 * MIN;
const DAY = 24 * HR;

const parse = (iso) => {
  const t = typeof iso === "number" ? iso : Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};

/** `iso` (ISO string or epoch ms) relative to `now`, in the one site format. Unparseable input yields "". */
export function formatTime(iso, now = Date.now()) {
  const t = parse(iso);
  if (t === null) return "";
  const ago = now - t;
  if (ago < MIN) return "just now"; // includes a little clock skew into the future
  if (ago < HR) return `${Math.floor(ago / MIN)} min ago`;
  if (ago < DAY) return `${Math.floor(ago / HR)} hr ago`;
  if (ago < 2 * DAY) return "yesterday";
  if (ago < 7 * DAY) return `${Math.floor(ago / DAY)} days ago`;
  const d = new Date(t);
  const md = `${MON[d.getMonth()]} ${d.getDate()}`;
  return d.getFullYear() === new Date(now).getFullYear() ? md : `${md}, ${d.getFullYear()}`;
}

/** The full local date and time for the title attribute: `october 3, 2024, 4:05 pm`. */
export function fullTime(iso) {
  const t = parse(iso);
  if (t === null) return "";
  const d = new Date(t);
  const h = d.getHours();
  return `${MONTH[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}, ${h % 12 || 12}:${String(d.getMinutes()).padStart(2, "0")} ${h < 12 ? "am" : "pm"}`;
}

/**
 * The kit components take `formatTime(iso): string` only, so the full date cannot travel with it. This keeps a `title` with the
 * full date on every `<time datetime>` under `root` (now and as rows are added). Returns a disconnect function.
 */
export function watchTimeTitles(root) {
  if (!root) return () => {};
  const apply = () => {
    for (const el of root.querySelectorAll("time[datetime]")) {
      const full = fullTime(el.getAttribute("datetime"));
      if (full && el.getAttribute("title") !== full) el.setAttribute("title", full);
    }
  };
  apply();
  if (typeof MutationObserver === "undefined") return () => {};
  const mo = new MutationObserver(apply);
  mo.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ["datetime"] });
  return () => mo.disconnect();
}
