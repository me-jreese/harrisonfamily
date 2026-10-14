// Notification registry (every HFY type, level 0 by default) and best-effort fan-out: persist first into the kit inbox store, push second.
import { createDelivery } from "@io-kit/notify/server";
import { logSafeError } from "./http.js";

/** Level 0 is content-free; level 1 may name the actor. Recipients opt in to level 1 per type. */
const T = "Harrison Family";
export const TEMPLATE_REGISTRY = {
  features: {
    // Voice (DS guide/04-voice.md): lowercase sentences, "page" never "record", the site name as the title (a proper noun keeps its case).
    // The lock-screen preview on /me/notifications/ mirrors these word for word (islands/src/islands/notifications.jsx CATALOG).
    comment_on_my_record: { title: T, level0: "someone commented on your page.", level1: "{actor} commented on your page.", many: "{count} new comments on your page." },
    reply_to_me: { title: T, level0: "someone replied to you.", level1: "{actor} replied to you.", many: "{count} new replies to you." },
    // Push-only: the timeline is its in-app surface, and an inbox item per member for every post would be noise (BRD2 D2-15; inbox:false).
    new_family_post: { title: T, level0: "there's a new family post.", level1: "{actor} shared a new family post.", inbox: false },
    mention: { title: T, level0: "you were mentioned.", level1: "{actor} mentioned you." },
    // PLN-002 (HFY-TSK-253, social.md section 5 and editing.md section 8). Proposals: R-10 submitted, R-11 decided.
    proposal_submitted: { title: T, level0: "someone suggested a change.", level1: "{actor} suggested a change to {subject}'s page.", many: "{count} suggested changes are waiting for review." },
    proposal_accepted: { title: T, level0: "your suggested change was accepted.", level1: "{actor} accepted your change to {subject}'s page." },
    proposal_declined: { title: T, level0: "your suggested change wasn't added.", level1: "{actor} didn't add your change to {subject}'s page." },
    proposal_needs_changes: { title: T, level0: "an admin has a question about your suggestion.", level1: "{actor} has a question about your suggestion for {subject}'s page." },
    proposal_stale: { title: T, level0: "your suggestion needs a quick update.", level1: "your suggestion for {subject}'s page needs a quick update." },
    // Record changes: R-11 mine, R-12 followed, and one digest when a batch touches more than DIGEST_OVER followed pages for a recipient.
    record_updated_mine: { title: T, level0: "your page was updated.", level1: "{actor} updated your page.", many: "your page was updated {count} times." },
    record_updated_followed: { title: T, level0: "a page you follow was updated.", level1: "{subject}'s page was updated.", many: "a page you follow was updated {count} times." },
    // inboxText has no {count}: the store's count is how many digests coalesced, not how many pages (the push line carries the page count).
    records_updated_followed_digest: { title: T, level0: "pages you follow were updated.", level1: "{count} pages you follow were updated.", inboxText: "pages you follow were updated." },
    // Moderation (R-32). The reason for a hide stays private; an admin's note travels as the inbox `detail`, never in a push.
    moderation_hidden: { title: T, level0: "a moderator hid something you shared.", level1: "{actor} hid your {item}." },
    moderation_request: { title: T, level0: "a moderator asked you to update something you shared.", level1: "{actor} asked you to update your {item}." },
    moderation_question: { title: T, level0: "a moderator has a question about something you shared.", level1: "{actor} has a question about your {item}." },
    moderation_unhidden: { title: T, level0: "something you shared is visible again.", level1: "your {item} is visible again." },
    moderation_resolved: { title: T, level0: "an item you asked about was updated.", level1: "{actor} updated the {item} you asked about.", many: "{count} items you asked about were updated." },
    photo_graduated: { title: T, level0: "your photo was added to a family page.", level1: "{actor} added your photo to {subject}'s page." },
    // Push-only (chat.md section 13, CHAT-D12): content-free, never any message text. Called by hfy-chat-api-service-routes.
    chat_message: { title: T, level0: "you have a new chat message.", level1: "{actor} sent you a chat message.", inbox: false },
  },
  whitelist: ["actor", "subject", "item", "count"],
};
/** `@I0044` in a comment body mentions that gramps person (= principal id). */
export const mentionsOf = (body) => [...new Set([...String(body).matchAll(/(?:^|[^\w@])@(I\d{4,8})\b/g)].map((m) => m[1]))].slice(0, 10);
export const NOTIFY_TYPES = Object.keys(TEMPLATE_REGISTRY.features);

/**
 * The single source other surfaces compare against (hfy-inbox-ui's CATALOG, hfy-chat-api-service-routes): the field whitelist, and per type the
 * inbox flag, the push/level strings, and the group key's presence. test/notify-producers.test.js pins it.
 */
export const notifyContract = () => ({
  whitelist: [...TEMPLATE_REGISTRY.whitelist],
  types: Object.fromEntries(Object.entries(TEMPLATE_REGISTRY.features).map(([k, t]) => [k, { inbox: t.inbox !== false, title: t.title, level0: t.level0, level1: t.level1 }])),
});

/** The flag that gates persist-first inbox writes and the push app_badge (HFY-TSK-238 AC4; BRD2 D2-15, 10.1). */
export const INBOX_FLAG = "inboxV1";
/** Push-only types never become inbox items (BRD2 D2-15: new_family_post, and chat_message when chat lands): the registry's `inbox:false`. */
export const PUSH_ONLY_TYPES = new Set(Object.entries(TEMPLATE_REGISTRY.features).filter(([, t]) => t.inbox === false).map(([k]) => k));

/** More followed pages than this in one batch collapse into one digest per recipient (social.md section 5). */
export const DIGEST_OVER = 3;
/** Fan-out bound for one onRecordChanged call: a batch larger than this is truncated (the digest rule makes the rest redundant). */
export const MAX_CHANGES = 500;
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
  /** Producers run after a committed write: no push and no inbox configured => no reads at all; any failure is logged and swallowed. */
  const guarded = (label, fn) => async (...args) => {
    if (!active()) return;
    try {
      await fn(...args);
    } catch (e) {
      log.error?.(`${label} failed`, logSafeError(e));
    }
  };
  async function notify(feature, recipients, { navigate, actorLabel, subjectLabel, item, count, exclude = [], detail, group }) {
    if (!active()) return { sent: 0 };
    try {
      const skip = new Set(exclude);
      const toStore = [];
      const pushOnly = [];
      for (const principal of new Set(recipients)) {
        if (skip.has(principal)) continue;
        // A failed flag read means no inbox write for that recipient, but the push still goes.
        const stored = !PUSH_ONLY_TYPES.has(feature) && (await inboxOn(principal).catch(() => false));
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
      return { sent: a.pushed + b.pushed };
    } catch (e) {
      log.error?.("notify failed", feature, logSafeError(e));
      return { sent: 0 };
    }
  }

  return {
    notify,
    /** After a comment is stored: reply > mention > comment_on_my_record, one notification per recipient. */
    onComment: guarded("comment notification", async (c, { parent } = {}, { postAuthorId, earlierCommenters = [] } = {}) => {
      const navigate = c.threadId.startsWith("post:") ? `/posts/?id=${c.threadId.slice(5)}` : `/person/?id=${c.threadId.slice(7)}`;
      const base = { navigate, actorLabel: c.author.label };
      const grouped = { ...base, group: `thread:${c.threadId}` }; // comment types coalesce per thread
      const done = new Set([c.author.id]);
      const take = (ids) => ids.filter((i) => !done.has(i) && done.add(i));
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
     * needs_changes only; it is never pushed. An unknown decision notifies nobody.
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
     * Only request and question carry the admin's note; a hide's reason stays private.
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
     */
    onRecordChanged: guarded("record change notification", async (changes, { silent = false } = {}) => {
      if (silent === true || !Array.isArray(changes)) return;
      const subjects = new Map();
      for (const ch of changes.slice(0, MAX_CHANGES)) {
        const gid = personIdOf(ch?.subject);
        if (!gid) continue;
        const prev = subjects.get(ch.subject);
        // Two actors in one batch: name neither.
        if (prev) { if (prev.actor?.id !== ch.actor?.id) prev.actor = null; continue; }
        subjects.set(ch.subject, { gid, actor: ch.actor ?? null, subjectLabel: ch.subjectLabel });
      }
      if (!subjects.size) return;
      const members = deps.listMembers ? await deps.listMembers() : new Set();
      const followed = new Map(); // recipient -> [subject]
      for (const [subject, c] of subjects) {
        const actorId = c.actor?.id;
        const ownerNotified = members.has(c.gid) && c.gid !== actorId;
        if (ownerNotified) await notify("record_updated_mine", [c.gid], { navigate: personPath(c.gid), actorLabel: labelOf(c.actor), group: `rec:${subject}` });
        const followers = deps.followersOf ? await deps.followersOf(subject).catch((e) => { log.error?.("followers lookup failed", logSafeError(e)); return []; }) : [];
        for (const f of new Set(followers)) {
          if (f === actorId || f === c.gid) continue; // the actor knows; the owner is covered by record_updated_mine
          (followed.get(f) ?? followed.set(f, []).get(f)).push(subject);
        }
      }
      const perSubject = new Map(); // subject -> recipients (small lists)
      for (const [recipient, subs] of followed) {
        if (subs.length > DIGEST_OVER) {
          await notify("records_updated_followed_digest", [recipient], { navigate: INBOX_PATH, count: subs.length, group: "recdigest" });
        } else for (const subject of subs) (perSubject.get(subject) ?? perSubject.set(subject, []).get(subject)).push(recipient);
      }
      for (const [subject, recipients] of perSubject) {
        const c = subjects.get(subject);
        await notify("record_updated_followed", recipients, { navigate: personPath(c.gid), subjectLabel: c.subjectLabel, group: `rec:${subject}` });
      }
    }),
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
