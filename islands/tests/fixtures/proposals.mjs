// Synthetic ProposalViews for the review island's tests (HFY-TSK-259). Placeholder people only (ids I9001..); ULIDs are made up.
export const ID = (n) => `01HZ${String(n).padStart(22, "0")}`;

const OP_FIRST = { id: "names.first_name", op: "set", obj: "Person:hsyn0002", path: "/primary_name/first_name", base: "Tess", value: "Tessa Marie" };

/** A ProposalView as GET /api/proposals serves it. `over` replaces any member. */
export function view(n = 1, over = {}) {
  const base = {
    id: ID(n), rev: 1, state: "pending", kind: "edit", origin: "web",
    proposer: { id: "I9001", label: "Sam Example" },
    subject: { cls: "Person", handle: "hsyn0002", gramps_id: "I9002" },
    targets: ["Person:hsyn0002"], owners: ["I9002"], base_versions: { "Person:hsyn0002": 4 },
    ops: [OP_FIRST], summary: [{ text: "change the first name from \"Tess\" to \"Tessa Marie\"", opIds: ["names.first_name"] }],
    note: "", warnings: [],
    created_at: `2026-03-0${Math.min(n, 9)}T10:00:00.${String(n).padStart(3, "0")}Z`, updated_at: `2026-03-0${Math.min(n, 9)}T10:00:00.${String(n).padStart(3, "0")}Z`,
    etag: `etag${n}`.padEnd(16, "0"), can: { amend: false, withdraw: false, decide: true, comment: true }, stale: false,
  };
  return { ...base, ...over };
}

export const STATES = ["pending", "needs_changes", "stale", "approved", "declined", "withdrawn", "superseded"];

/** The rebase block GET /api/proposals/:id adds. */
export const REBASE_CLEAN = { status: "clean", conflicts: [] };
export const REBASE_CONFLICT = {
  status: "conflict",
  conflicts: [{ opId: "names.first_name", obj: "Person:hsyn0002", path: "/primary_name/first_name", reason: "base_mismatch", base: "Tess", current: "Tessie", proposed: "Tessa Marie" }],
};
