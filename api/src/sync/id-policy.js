// The cloud ID policy of Q2-03 (HFY-TSK-246; BRD2 Q2-03, SYNC-03, R-03, R-23, R-24; reviews DL-07 and SI-23). It is one of two branches,
// chosen by config, and the branch not chosen is off:
//
//   mint    (io approved Q2-03) A web-origin create that leaves gramps_id empty is given one from SYNC#HEAD.id_next.<Class>, inside the
//           same transaction and under the GID# guard. The block is <prefix>8000-<prefix>8999 per class (I8000, F8000, ...). The desktop
//           may not create into it or move an object into it (validator.js: 409 reserved_id_block). A minted Person id is permanent: the
//           existing Person rules retire it on delete, withdraw or merge and never release it (store.js "GID lifecycle").
//   assign  (io declined) A web-origin create keeps an empty gramps_id. The desktop's first assignment (empty to an id) is allowed once,
//           from desktop origin only, under the GID guard, and is not a renumber. Any later change of a Person id is renumber_blocked.
//           After the commit the policy's `completeAccessRequest(requestId, grampsId)` runs for a Person that came from an access request.
//           The renderer gives an ID-less person no file (render-lambda).
//
// With no mode configured the store behaves as before this task: every create needs a gramps_id, nothing is minted, nothing is assigned.
// The mode comes from `ctx.idPolicy` or, failing that, the HFY_ID_POLICY environment variable ("mint" or "assign"). It is read from the
// q2-03-id-block answer by whoever deploys; this module never guesses one.
import { SyncError } from "./errors.js";
import { HARD_ORIGINS } from "./validator.js";

export const ID_POLICY_MODES = Object.freeze(["mint", "assign"]);
/** The cloud block of each class: <prefix>8000 to <prefix>8999. */
export const ID_BLOCK_FIRST = 8000;
export const ID_BLOCK_LAST = 8999;
/** The Gramps default id prefix of each class that has one (a Tag has no gramps_id). */
export const ID_PREFIX = Object.freeze({ Person: "I", Family: "F", Event: "E", Place: "P", Media: "O", Note: "N", Source: "S", Citation: "C", Repository: "R" });
/** Origins that write for the website: they get minted ids (mint) or keep empty ones (assign). */
export const WEB_ORIGINS = HARD_ORIGINS;

/**
 * Builds the policy object for ctx.idPolicy.
 * @param opts.mode                   "mint" | "assign" | undefined (unset: the pre-Q2-03 behaviour)
 * @param opts.accessRequestOf        async ({class, handle, store}) => requestId | undefined. Which access request, if any, a Person came from.
 *                                    Wired by surf-access-admin-api; without it assign mode completes no request.
 * @param opts.completeAccessRequest  async (requestId, grampsId) => void. The link transaction of the access-request domain.
 */
export function createIdPolicy({ mode, accessRequestOf, completeAccessRequest } = {}) {
  if (mode !== undefined && !ID_POLICY_MODES.includes(mode)) throw new TypeError(`id policy mode must be one of ${ID_POLICY_MODES.join(", ")}`);
  for (const [name, fn] of [["accessRequestOf", accessRequestOf], ["completeAccessRequest", completeAccessRequest]]) {
    if (fn !== undefined && typeof fn !== "function") throw new TypeError(`${name} must be a function`);
  }
  return Object.freeze({ mode, accessRequestOf, completeAccessRequest });
}

/** The policy from the environment (HFY_ID_POLICY), or the unset policy. An unknown value is a configuration error, not a default. */
export function idPolicyFromEnv(env = process.env) {
  const raw = env.HFY_ID_POLICY;
  return createIdPolicy({ mode: raw === undefined || raw === "" ? undefined : raw });
}

/** The policy of a ctx: ctx.idPolicy, else the environment's. */
export const policyOf = (ctx) => (ctx.idPolicy !== undefined ? createIdPolicy(ctx.idPolicy) : idPolicyFromEnv());

/** True for an id inside a class's cloud block (I8000 and I08000-style padding included). */
export function inBlock(cls, id) {
  const p = ID_PREFIX[cls];
  return p !== undefined && typeof id === "string" && new RegExp(`^${p}0*8[0-9]{3}$`, "i").test(id);
}

export const formatId = (cls, n) => `${ID_PREFIX[cls]}${String(n).padStart(4, "0")}`;

const isEmptyId = (op) => op.op === "create" && op.class !== "Tag" && (op.gramps_id === undefined || op.gramps_id === "");

/** A web-origin create that leaves gramps_id empty, and so is a candidate for minting. */
export const wantsMint = (policy, origin, op) => policy.mode === "mint" && WEB_ORIGINS.includes(origin) && isEmptyId(op);

/**
 * Mints the ids of a batch's web-origin creates under mint mode. Returns { ops, idNext }: the ops with `gramps_id` and `obj.gramps_id`
 * filled in (new objects; the input is not touched) and the new SYNC#HEAD.id_next map to write, or undefined when nothing was minted.
 * A candidate whose GID# item exists is skipped (it was claimed another way), so a stale counter cannot loop a batch forever. The counter
 * is written under the SYNC#HEAD seq condition, so two concurrent minters cannot both take a number: the loser re-reads.
 * `getGid(cls, id)` reads a GID# item. `rebuild(op, obj)` returns the op with its canonical JSON recomputed.
 */
export async function mintIds({ policy, origin, ops, head, getGid, rebuild }) {
  const next = {};
  for (const [cls, n] of Object.entries(head?.id_next ?? {})) if (Number.isInteger(n)) next[cls] = n;
  let minted = false;
  const out = [];
  for (const op of ops) {
    if (op.op === "marker" || op.class === "Tag") {
      out.push(op);
      continue;
    }
    if (policy.mode === "mint" && WEB_ORIGINS.includes(origin) && op.op === "create" && !isEmptyId(op) && inBlock(op.class, op.gramps_id)) {
      throw new SyncError(409, "reserved_id_block", "ids from the reserved block are minted by the store, never supplied", { conflicts: [{ op_id: op.op_id, class: op.class, handle: op.handle }] });
    }
    if (!wantsMint(policy, origin, op)) {
      out.push(op);
      continue;
    }
    let n = Math.max(ID_BLOCK_FIRST, next[op.class] ?? ID_BLOCK_FIRST);
    let id;
    for (; n <= ID_BLOCK_LAST; n += 1) {
      const candidate = formatId(op.class, n);
      if (!(await getGid(op.class, candidate))) {
        id = candidate;
        break;
      }
    }
    if (id === undefined) throw new SyncError(409, "id_block_exhausted", `the cloud id block of ${op.class} is used up`, { class: op.class });
    next[op.class] = n + 1;
    minted = true;
    out.push(rebuild(op, { ...op.obj, gramps_id: id }));
  }
  return { ops: out, idNext: minted ? next : undefined };
}

/**
 * True when `op` is the desktop's first assignment under assign mode: an update of a live object whose stored gramps_id is empty, giving it
 * one. `prevId` is the stored id ("" for an ID-less object, undefined for no live object).
 */
export const isAssignment = (policy, origin, op, prevId) =>
  policy.mode === "assign" && origin === "desktop" && op.op === "update" && prevId === "" && typeof op.gramps_id === "string" && op.gramps_id !== "" && op.renumber !== true;

/** Runs the access-request completion for committed assignments. Never throws: a failure is logged by name and code only. */
export async function completeAssignments({ policy, assigned, store, log, safe }) {
  if (!policy.accessRequestOf || !policy.completeAccessRequest) return;
  for (const a of assigned) {
    if (a.class !== "Person") continue;
    try {
      const requestId = await policy.accessRequestOf({ class: a.class, handle: a.handle, store });
      if (requestId) await policy.completeAccessRequest(requestId, a.gramps_id);
    } catch (e) {
      log.warn?.("complete_access_request_failed", safe(e, { route: "applyBatch" }));
    }
  }
}
