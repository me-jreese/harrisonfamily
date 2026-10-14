// Notification registry (every HFY type, level 0 by default) and best-effort fan-out: persist first into the kit inbox store, push second.
import { createDelivery } from "@io-kit/notify/server";
import { logSafeError } from "./http.js";
import { TEMPLATE_REGISTRY } from "./shared/notify-registry.mjs";

export { TEMPLATE_REGISTRY };
/** `@I0044` in a comment body mentions that gramps person (= principal id). */
export const mentionsOf = (body) => [...new Set([...String(body).matchAll(/(?:^|[^\w@])@(I\d{4,8})\b/g)].map((m) => m[1]))].slice(0, 10);
export const NOTIFY_TYPES = Object.keys(TEMPLATE_REGISTRY.features);

/**
 * The single source other surfaces compare against (hfy-inbox-ui's CATALOG, hfy-chat-api-service-routes): the field whitelist, and per type the
 * inbox flag, the push/level strings, and the group key's presence. test/notify-producers.test.js pins it.
 */
export const notifyContract = () => ({
  whitelist: [...TEMPLATE_REGISTRY.whitelist],
  types: Object.fromEntries(Object.entries(TEMPLATE_REGISTRY.features).map(([k, t]) => [k, { inbox: t.inbox !== false, title: t.title, level0: t.level0, level1: t.level1, many: t.many ?? null, inboxText: t.inboxText ?? null }])),
  /** Coalescing group templates by type ("{t}" = thread id / subject / target); null = ungrouped. Producers below must match. */
  groups: { comment_on_my_record: "thread:{t}", reply_to_me: "thread:{t}", proposal_submitted: "proposals", record_updated_mine: "rec:{t}", record_updated_followed: "rec:{t}", records_updated_followed_digest: "recdigest", moderation_resolved: "mod:{t}" },
});

/** The flag that gates persist-first inbox writes and the push app_badge (HFY-TSK-238 AC4; BRD2 D2-15, 10.1). */
export const INBOX_FLAG = "inboxV1";
/** Push-only types never become inbox items (BRD2 D2-15: new_family_post, and chat_message when chat lands): the registry's `inbox:false`. */
export const PUSH_ONLY_TYPES = new Set(Object.entries(TEMPLATE_REGISTRY.features).filter(([, t]) => t.inbox === false).map(([k]) => k));

/** More followed pages than this in one batch collapse into one digest per recipient (social.md section 5). */
export const DIGEST_OVER = 3;
/** More distinct subjects than this in one non-silent call degrade to one digest per recipient (D2-16, review IF-17); the call is never refused. */
export const BATCH_DIGEST_OVER = 50;
/** Hard ceiling on subjects read from one call (memory bound); beyond it the rest of the batch is ignored. */
export const MAX_SUBJECTS = 5000;
/** Concurrent follower lookups per onRecordChanged call (the kit's fan-out bound). */
export const LOOKUP_CONCURRENCY = 8;
/** Run `fn` over `items` with at most `n` in flight; results keep input order. */
const mapLimit = async (items, n, fn) => {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i]); } }));
  return out;
};
export const MODERATION_KINDS = Object.freeze({
  hidden: "moderation_hidden", request: "moderation_request", question: "moderation_question", unhidden: "moderation_unhidden", resolved: "moderation_resolved",
});
export const DECISION_TYPES = Object.freeze({
  accepted: "proposal_accepted", declined: "proposal_declined", needs_changes: "proposal_needs_changes", stale: "proposal_stale",
});
const ITEMS = new Set(["post", "story", "comment", "photo"]);
const GID = /^[A-Za-z0-9_-]{1,32}$/;
/** The default admin review destination; the proposals domain overrides it per call with `navigate`. */
export const PROPOSALS_REVIEW_PATH = "/admin/proposals/";
export const INBOX_PATH = "/me/inbox/";
/** Where a proposal thread notification lands (editing design 7.4: the review page, one proposal). */
export const proposalPath = (id) => `/me/review/?id=${encodeURIComponent(id)}`;

/** A same-origin path the server generates: starts with one "/" and carries no scheme, backslash or control character. */
export const safePath = (p, fallback = INBOX_PATH) => (typeof p === "string" && /^\/(?!\/)[^\\\u0000-\u001f]*$/.test(p) ? p : fallback);
/** `person:<gramps_id>` -> the gramps_id, or null for anything else. */
export const personIdOf = (subject) => {
  const m = /^person:(.+)$/.exec(String(subject ?? ""));
  return m && GID.test(m[1]) ? m[1] : null;
};
const personPath = (gid) => `/person/?id=${encodeURIComponent(gid)}`;
const labelOf = (x) => (typeof x?.label === "string" && x.label ? x.label : undefined);

/** A cached set of member principals (gramps_ids): the values of config/userGrampsID.json. Fails closed (empty set), retries in 5 s, never logs ids. */
export function createMemberSet({ load, ttlMs = 5 * 60_000, now = () => Date.now(), log = console }) {
  let cache = { at: -Infinity, ids: new Set() };
  return async () => {
    if (now() - cache.at < ttlMs) return cache.ids;
    try {
      const raw = await load();
      const vals = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? Object.values(raw) : [];
      cache = { at: now(), ids: new Set(vals.filter((x) => typeof x === "string" && GID.test(x))) };
      if (!cache.ids.size) log.error?.("member list empty after a successful load (record_updated_mine will notify nobody)");
    } catch (e) {
      log.error?.("member list unavailable (failing closed)", logSafeError(e));
      cache = { at: now() - ttlMs + 5_000, ids: new Set() };
    }
    return cache.ids;
  };
}

/** Followers of one record subject (social.md section 6): one GSI1 Query on RECSUB#<subject>, principal in GSI1SK. */
export function queryFollowers(ddb, cmds, table) {
  return async (subject) => {
    const found = new Set();
    let key;
    for (let i = 0; i < 20; i += 1) {
      const r = await ddb.send(new cmds.QueryCommand({
        TableName: table, IndexName: "GSI1", KeyConditionExpression: "GSI1PK = :pk", ExpressionAttributeValues: { ":pk": `RECSUB#${subject}` },
        ...(key ? { ExclusiveStartKey: key } : {}),
      }));
      for (const it of r.Items ?? []) if (typeof it.GSI1SK === "string") found.add(it.GSI1SK);
      key = r.LastEvaluatedKey;
      if (!key) break;
    }
    return [...found];
  };
}

/**
 * deps: { subscriptions, preferences, webpush, vapid, listPrincipals, log, inbox?, featureOn?, getAdmins?, listMembers?, followersOf? }.
 * `getAdmins` (auth.js createAdminList) feeds proposal_submitted, `listMembers` (createMemberSet) the record owner check and `followersOf` (queryFollowers) the R-12 fan-out;
 * a producer whose source is absent notifies nobody.
 * `inbox` is the kit NotificationStore (index.js: DynamoNotificationStore on the app table). Delivery is the kit's `createDelivery`: persist first, then
 * push with `app_badge` set to the unread count the write returned. An item is stored, and the push carries `app_badge`, only while
 * `featureOn("inboxV1", recipient)` (src/features.js): no inbox item exists for anyone while the flag is off, except uat recipients. Recipients with the
 * flag off get the push alone, with no badge. Without `featureOn` the inbox is off (fail closed). Without VAPID keys the inbox still stores.
 * Never throws: delivery is a nicety and must not fail a write.
 */
export function createNotifier(deps) {
  const log = deps.log ?? console;
  const enabled = () => Boolean(deps.webpush && deps.vapid);
  const active = () => enabled() || Boolean(deps.inbox);
  const inboxOn = async (principal) => Boolean(deps.inbox && deps.featureOn) && (await deps.featureOn(INBOX_FLAG, principal)) === true;
  const kitLog = (event, data) => log.error?.(`notify ${event}`, data);
  const common = { registry: TEMPLATE_REGISTRY, preferences: deps.preferences, subscriptions: deps.subscriptions, webpush: deps.webpush, vapid: deps.vapid, log: kitLog };
  const deliverStored = createDelivery({ ...common, store: deps.inbox });
  const deliverPushOnly = createDelivery(common);
  /**
   * Producers run after a committed write: no push and no inbox configured => no reads at all; any failure is logged and swallowed.
   * `report: true` (onRecordChanged only) returns what happened instead of undefined, so the render-outbox consumer can tell a delivery
   * that was lost from one that was sent: `{ inactive: true }` when nothing is configured, `{ error: true, lost: 1 }` when the producer threw,
   * otherwise the producer's own `{ lost }`. It still never throws.
   */
  const guarded = (label, fn, { report = false } = {}) => async (...args) => {
    if (!active()) return report ? { inactive: true, lost: 0 } : undefined;
    try {
      const out = await fn(...args);
      return report ? out ?? { lost: 0 } : undefined;
    } catch (e) {
      log.error?.(`${label} failed`, logSafeError(e));
      return report ? { error: true, lost: 1 } : undefined;
    }
  };
  async function notify(feature, recipients, { navigate, actorLabel, subjectLabel, item, count, exclude = [], detail, group }) {
    if (!active()) return { sent: 0, lost: 0 };
    let lost = 0; // durable (inbox) deliveries that did not happen: the consumer retries on these; a push that fails (a dead endpoint) is best-effort
    try {
      const skip = new Set(exclude);
      const toStore = [];
      const pushOnly = [];
      for (const principal of new Set(recipients)) {
        if (skip.has(principal)) continue;
        // A failed flag read means no inbox write for that recipient, but the push still goes.
        const stored = !PUSH_ONLY_TYPES.has(feature) && (await inboxOn(principal).catch(() => { lost += 1; return false; }));
        (stored ? toStore : pushOnly).push(principal);
      }
      const fields = {
        ...(actorLabel ? { actor: actorLabel } : {}), ...(subjectLabel ? { subject: subjectLabel } : {}),
        ...(ITEMS.has(item) ? { item } : {}), ...(Number.isInteger(count) && count > 0 ? { count: String(count) } : {}),
      };
      const input = { feature, navigate: safePath(navigate), fields, ...(detail ? { detail: String(detail).slice(0, 1000) } : {}), ...(group ? { group } : {}) };
      const [a, b] = await Promise.all([
        toStore.length ? deliverStored({ ...input, recipients: toStore }) : { pushed: 0 },
        pushOnly.length && enabled() ? deliverPushOnly({ ...input, recipients: pushOnly }) : { pushed: 0 },
      ]);
      if (toStore.length && TEMPLATE_REGISTRY.features[feature]?.inbox !== false) lost += Math.max(0, toStore.length - (a.stored ?? 0));
      return { sent: a.pushed + b.pushed, lost };
    } catch (e) {
      log.error?.("notify failed", feature, logSafeError(e));
      return { sent: 0, lost: lost + 1 };
    }
  }

  return {
    notify,
    /**
     * After a comment is stored: reply > mention > comment_on_my_record, one notification per recipient. A `proposal:<ulid>` thread links to the review
     * page and its owner is the proposer (`postAuthorId`); `visibleTo` (a Set of principal ids: the proposal's visibility set) limits every recipient of
     * a reply, a mention or the owner notice to it, so a mention cannot tell an outsider that a suggestion exists (PS-09). A proposal thread with no
     * `visibleTo` notifies nobody (fail closed).
     */
    onComment: guarded("comment notification", async (c, { parent } = {}, { postAuthorId, earlierCommenters = [], visibleTo } = {}) => {
      const onProposal = c.threadId.startsWith("proposal:");
      const navigate = onProposal ? proposalPath(c.threadId.slice(9)) : c.threadId.startsWith("post:") ? `/posts/?id=${c.threadId.slice(5)}` : `/person/?id=${c.threadId.slice(7)}`;
      const base = { navigate, actorLabel: c.author.label };
      const grouped = { ...base, group: `thread:${c.threadId}` }; // comment types coalesce per thread
      const allowed = onProposal ? (visibleTo instanceof Set ? visibleTo : new Set()) : null;
      const done = new Set([c.author.id]);
      const take = (ids) => ids.filter((i) => !done.has(i) && (allowed === null || allowed.has(i)) && done.add(i));
      // reply_to_me: the parent's author plus everyone who commented earlier on the same subject.
      await notify("reply_to_me", take([...(parent ? [parent.author.id] : []), ...earlierCommenters]), grouped);
      await notify("mention", take(mentionsOf(c.body)), base);
      const owner = c.threadId.startsWith("person:") ? c.threadId.slice(7) : postAuthorId;
      if (owner) await notify("comment_on_my_record", take([owner]), grouped);
    }),
    /**
     * R-10, after the proposals domain commits a submission: every admin except the proposer.
     * `{ proposal: { id, subject: "person:<id>", subjectLabel?, proposer: { id, label } }, navigate? }`.
     */
    onProposalSubmitted: guarded("proposal submitted notification", async ({ proposal, navigate } = {}) => {
      if (!deps.getAdmins || !proposal?.proposer?.id) return;
      const admins = [...(await deps.getAdmins())];
      await notify("proposal_submitted", admins, {
        navigate: safePath(navigate, PROPOSALS_REVIEW_PATH), actorLabel: labelOf(proposal.proposer), subjectLabel: proposal.subjectLabel,
        exclude: [proposal.proposer.id], group: "proposals",
      });
    }),
    /**
     * R-11, after a decision commits: the proposer. `decision` is accepted, declined, needs_changes or stale (BRD2 D2-15 names the rejection `proposal_declined`).
     * `{ proposal: { id, subject, subjectLabel?, proposer }, decision, note?, by: { id, label } }`. The admin's note is the inbox `detail` for declined and
     * needs_changes only; it is never pushed. An unknown decision notifies nobody. The deciding admin is excluded (deciding your own proposal notifies nobody).
     * CALLER DUTY: validate `note` with the shared contact-info validator (R-18) before calling; the producer only caps it at 1000 chars. The inbox UI must render `detail` as text, never HTML.
     */
    onProposalDecided: guarded("proposal decision notification", async ({ proposal, decision, note, by } = {}) => {
      const type = DECISION_TYPES[decision];
      const gid = personIdOf(proposal?.subject);
      if (!type || !proposal?.proposer?.id) return;
      await notify(type, [proposal.proposer.id], {
        navigate: gid ? personPath(gid) : INBOX_PATH, actorLabel: labelOf(by), subjectLabel: proposal.subjectLabel,
        exclude: by?.id ? [by.id] : [], ...(decision === "declined" || decision === "needs_changes" ? { detail: note } : {}),
      });
    }),
    /**
     * R-32, after a moderation transition commits. `kind`: hidden | request | question | unhidden | resolved.
     * `{ kind, item, target, authorId, by: { id, label }, askedBy?, note?, navigate }`. hidden, request, question and unhidden go to the item's author;
     * resolved (the author edited) goes to the admin who asked (`askedBy`), grouped `mod:<target>`. The actor is never notified.
     * Only request and question carry the admin's note; a hide's reason stays private. The acting admin is excluded (moderating your own item notifies nobody).
     * CALLER DUTY: validate `note` with the shared contact-info validator (R-18) before calling; the producer only caps it at 1000 chars. The inbox UI must render `detail` as text, never HTML.
     */
    onModeration: guarded("moderation notification", async ({ kind, item, target, authorId, by, askedBy, note, navigate } = {}) => {
      const type = MODERATION_KINDS[kind];
      if (!type) return;
      const resolved = kind === "resolved";
      await notify(type, [resolved ? askedBy : authorId].filter(Boolean), {
        navigate, actorLabel: labelOf(by), item, exclude: by?.id ? [by.id] : [],
        ...(kind === "request" || kind === "question" ? { detail: note } : {}),
        ...(resolved && target ? { group: `mod:${target}` } : {}),
      });
    }),
    /** R-02, after an admin graduates a comment photo into a record: the photo's author. `{ photo: { authorId }, subject: "person:<id>", subjectLabel?, by }`. */
    onGraduated: guarded("graduation notification", async ({ photo, subject, subjectLabel, by } = {}) => {
      const gid = personIdOf(subject);
      if (!photo?.authorId || !gid) return;
      await notify("photo_graduated", [photo.authorId], { navigate: `${personPath(gid)}#photos`, actorLabel: labelOf(by), subjectLabel, exclude: by?.id ? [by.id] : [] });
    }),
    /**
     * R-11 and R-12. Called ONLY by the render-outbox consumer (hfy-record-change-fanout), once per live pass; never from a request (BRD2 D2-02).
     * `changes`: `[{ subject: "person:<id>", subjectLabel?, actor: { id, label } | null, source }]`. `silent: true` is mandatory for imports, seeding and backfills.
     * The owner (a member, per `listMembers`) gets record_updated_mine unless they are the actor; followers (per `followersOf`) get record_updated_followed,
     * never the actor and never the owner twice; a follower with more than DIGEST_OVER pages in one call gets one records_updated_followed_digest instead.
     * Idempotency across redelivery (dedupe key rec:<seq>:<subject>) is the consumer's; within a call a subject counts once.
     * `silent:true`, `import:true` or `seed:true` (SYNC#SESSION.seed) send nothing. More than BATCH_DIGEST_OVER distinct subjects: one digest per follower, one record_updated_mine per owner.
     * Returns (never throws) `{ lost }`, plus `inactive: true` when no push or inbox is configured (nothing was sent) or `error: true` when the producer threw:
     * the consumer treats `lost > 0` and `error` as a failed delivery and gives its claims back, and `inactive` as "not delivered, not retried" (see record-change-fanout.js).
     * Budget: at most MAX_SUBJECTS subjects, follower Queries LOOKUP_CONCURRENCY at a time; the consumer should chunk large passes and must dedupe before redelivery.
     */
    onRecordChanged: guarded("record change notification", async (changes, { silent = false, import: isImport = false, seed = false } = {}) => {
      // Seeds (SYNC#SESSION.seed=true, passed by the consumer as `seed`), explicit imports and backfills send nothing and read nothing.
      if (silent === true || isImport === true || seed === true || !Array.isArray(changes)) return { lost: 0 };
      const subjects = new Map();
      for (const ch of changes.slice(0, MAX_SUBJECTS)) {
        const gid = personIdOf(ch?.subject);
        if (!gid) continue;
        const prev = subjects.get(ch.subject);
        // Two actors in one batch: name neither.
        if (prev) { if (prev.actor?.id !== ch.actor?.id) prev.actor = null; continue; }
        subjects.set(ch.subject, { gid, actor: ch.actor ?? null, subjectLabel: ch.subjectLabel });
      }
      if (!subjects.size) return { lost: 0 };
      let lost = 0; // inbox writes that failed, flag reads that failed and follower lookups that failed: the consumer gives its claims back on any
      // A large batch is never refused: every follower gets one digest and every member owner one record_updated_mine.
      const bulk = subjects.size > BATCH_DIGEST_OVER;
      const members = deps.listMembers ? await deps.listMembers() : new Set();
      const followed = new Map(); // recipient -> [subject]
      const entries = [...subjects];
      const lookups = await mapLimit(entries, LOOKUP_CONCURRENCY, ([subject]) => (deps.followersOf ? deps.followersOf(subject).catch((e) => { log.error?.("followers lookup failed", logSafeError(e)); lost += 1; return []; }) : []));
      for (const [idx, [subject, c]] of entries.entries()) {
        const actorId = c.actor?.id;
        const ownerNotified = members.has(c.gid) && c.gid !== actorId;
        if (ownerNotified) lost += (await notify("record_updated_mine", [c.gid], { navigate: personPath(c.gid), actorLabel: labelOf(c.actor), group: `rec:${subject}` })).lost;
        for (const f of new Set(lookups[idx])) {
          if (f === actorId || f === c.gid) continue; // the actor knows; the owner is covered by record_updated_mine
          (followed.get(f) ?? followed.set(f, []).get(f)).push(subject);
        }
      }
      const perSubject = new Map(); // subject -> recipients (small lists)
      for (const [recipient, subs] of followed) {
        if (bulk || subs.length > DIGEST_OVER) {
          lost += (await notify("records_updated_followed_digest", [recipient], { navigate: INBOX_PATH, count: subs.length, group: "recdigest" })).lost;
        } else for (const subject of subs) (perSubject.get(subject) ?? perSubject.set(subject, []).get(subject)).push(recipient);
      }
      for (const [subject, recipients] of perSubject) {
        const c = subjects.get(subject);
        lost += (await notify("record_updated_followed", recipients, { navigate: personPath(c.gid), subjectLabel: c.subjectLabel, group: `rec:${subject}` })).lost;
      }
      return { lost };
    }, { report: true }),
    /** After a post becomes published: everyone subscribed except the author (the principal Scan only runs with push on; push-only type). */
    onPublished: guarded("publish notification", async (post) => {
      if (!enabled()) return;
      const everyone = deps.listPrincipals ? await deps.listPrincipals() : [];
      await notify("new_family_post", everyone, { navigate: `/posts/?id=${post.id}`, actorLabel: post.author.label, exclude: [post.author.id] });
    }),
  };
}

/** Lists principals that hold at least one push subscription (Scan; fine at family scale). */
export function scanSubscribedPrincipals(ddb, cmds, table) {
  return async () => {
    const found = new Set();
    let key;
    for (let i = 0; i < 20; i += 1) {
      const r = await ddb.send(
        new cmds.ScanCommand({
          TableName: table,
          FilterExpression: "begins_with(PK, :p)",
          ExpressionAttributeValues: { ":p": "SUB#" },
          ProjectionExpression: "PK",
          ...(key ? { ExclusiveStartKey: key } : {}),
        }),
      );
      for (const it of r.Items ?? []) found.add(String(it.PK).slice(4));
      key = r.LastEvaluatedKey;
      if (!key) break;
    }
    return [...found];
  };
}
