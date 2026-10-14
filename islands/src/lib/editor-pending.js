// The "N suggested changes waiting for review" chip's model (HFY-TSK-156; editing.md section 9.1). It is its own small module so the person
// hero's edit entry (edit-entry.jsx, which never loads the form kit or the section adapters) and the editor island say the same thing.
// No DOM and no React.

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

export const PENDING_COPY = Object.freeze({
  pendingOne: "1 suggested change waiting for review",
  pendingMany: (n) => `${n} suggested changes waiting for review`
});

const OPEN_STATES = new Set(["pending", "needs_changes", "stale"]);

/**
 * The chip "2 suggested changes waiting for review", or null when there are none. `pending` is the bundle's list, which the server already
 * limits to the proposals the viewer may see (their own, any for an admin, or one about their own page, PS-09); the chip trusts that list and
 * counts only what it holds: open proposals with an id. Nothing else (no value, no note) is ever drawn from it.
 */
export function pendingChip(pending) {
  const list = Array.isArray(pending) ? pending : [];
  const n = new Set(list.filter((p) => isObj(p) && typeof p.proposalId === "string" && p.proposalId && OPEN_STATES.has(p.state)).map((p) => p.proposalId)).size;
  if (!n) return null;
  return { n, text: n === 1 ? PENDING_COPY.pendingOne : PENDING_COPY.pendingMany(n) };
}
