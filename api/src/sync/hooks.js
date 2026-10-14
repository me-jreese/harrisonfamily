// The commit-hook registry of applyBatch (HFY-TSK-243, review DL-18, BRD2 D2-02).
//
//   registerContributor(fn)   fn(batch, origin) returns extra transaction items, or nothing. They ride in the batch's own
//                             TransactWriteItems, so a counter or index they write commits with the record change or not at all.
//                             The fragment shape is transact()'s: { puts, deletes, updates, checks } (all optional). A contributor
//                             runs on every attempt of a batch (a seq race rebuilds the item set), so it must be pure: derive
//                             everything from `batch` and write nothing itself. An exception fails the batch.
//   registerAfterCommit(fn)   fn({ batch_id, origin, seq_from, seq_to }) runs exactly once per committed batch, after the
//                             transaction commits, and never for a replay of a stored receipt. It must not fail the write: an
//                             exception is caught and logged by name and code only.
//
// Both lists start empty, which is the "default to no-ops" contract. The self_edit and tag contribution ops come only from the
// contributor that hfy-record-change-fanout registers; no caller adds them.
const isFn = (fn, what) => {
  if (typeof fn !== "function") throw new TypeError(`${what} needs a function`);
};

/** A fresh registry. applyBatch reads `ctx.hooks` and falls back to the process-wide `defaultHooks`. */
export function createHookRegistry() {
  const contributors = new Set();
  const afterCommit = new Set();
  const register = (set, what) => (fn) => {
    isFn(fn, what);
    set.add(fn); // registering the same function twice (a module loaded twice) still runs it once
    return () => set.delete(fn);
  };
  return {
    registerContributor: register(contributors, "registerContributor"),
    registerAfterCommit: register(afterCommit, "registerAfterCommit"),
    contributors: () => [...contributors],
    afterCommitHooks: () => [...afterCommit],
    clear() {
      contributors.clear();
      afterCommit.clear();
    },
  };
}

export const defaultHooks = createHookRegistry();
/** Adds a contributor to the process-wide registry. Returns a function that removes it. */
export const registerContributor = (fn) => defaultHooks.registerContributor(fn);
/** Adds an after-commit hook to the process-wide registry. Returns a function that removes it. */
export const registerAfterCommit = (fn) => defaultHooks.registerAfterCommit(fn);
/** Empties the process-wide registry (tests). */
export const clearHooks = () => defaultHooks.clear();
