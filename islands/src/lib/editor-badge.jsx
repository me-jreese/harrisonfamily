// The editor's mode badge (HFY-TSK-212): an icon and the words, never colour alone. Shared by the names form (editor.jsx) and the list rows
// (editor-lists.jsx), so it lives apart from both.
import { badgeFor } from "./editor-model.js";

const ICONS = {
  direct: "M4 12.5l5 5L20 6.5",
  proposal: "M5 12h12m-5-6l6 6-6 6",
  admin: "M7 11V8a5 5 0 0110 0v3M6 11h12v9H6z",
  locked: "M7 11V8a5 5 0 0110 0v3M6 11h12v9H6z"
};

/** The mode badge: an icon and the words, never colour alone. */
export function ModeBadge({ code }) {
  const badge = badgeFor(code);
  return (
    <span className="hfy-mode" data-mode={badge.key} data-hfy-mode={badge.key}>
      <svg className="hfy-mode__icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d={ICONS[badge.key]} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
      <span>{badge.text}</span>
    </span>
  );
}
