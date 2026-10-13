// Notification registry (four HFY types, level 0 by default) and best-effort fan-out.
import { buildDeclarativePush, sendToPrincipal } from "@io-kit/notify/server";
import { logSafeError } from "./http.js";

/** Level 0 is content-free; level 1 may name the actor. Recipients opt in to level 1 per type. */
export const TEMPLATE_REGISTRY = {
  features: {
    // Voice (DS guide/04-voice.md): lowercase sentences, "page" never "record", the site name as the title (a proper noun keeps its case).
    // The lock-screen preview on /me/notifications/ mirrors these word for word (islands/src/islands/notifications.jsx CATALOG).
    comment_on_my_record: { title: "Harrison Family", level0: "someone commented on your page.", level1: "{actor} commented on your page." },
    reply_to_me: { title: "Harrison Family", level0: "someone replied to you.", level1: "{actor} replied to you." },
    new_family_post: { title: "Harrison Family", level0: "there's a new family post.", level1: "{actor} shared a new family post." },
    mention: { title: "Harrison Family", level0: "you were mentioned.", level1: "{actor} mentioned you." },
  },
  whitelist: ["actor"],
};
/** `@I0044` in a comment body mentions that gramps person (= principal id). */
export const mentionsOf = (body) => [...new Set([...String(body).matchAll(/(?:^|[^\w@])@(I\d{4,8})\b/g)].map((m) => m[1]))].slice(0, 10);
export const NOTIFY_TYPES = Object.keys(TEMPLATE_REGISTRY.features);

/** The flag that gates persist-first inbox writes and the push app_badge (HFY-TSK-238 AC4; BRD2 D2-15, 10.1). */
export const INBOX_FLAG = "inboxV1";
/** Push-only types never become inbox items (BRD2 D2-15: new_family_post, and chat_message when chat lands). */
export const PUSH_ONLY_TYPES = new Set(["new_family_post"]);

/**
 * deps: { subscriptions, preferences, webpush, vapid, listPrincipals, log, inbox?, featureOn? }.
 * `inbox.put(principal, {type, navigate, actorLabel}) => {unread?}` is the persist-first store (hfy-inbox-delivery-api wires the
 * @io-kit/notify inbox store here). An item is stored, and the push carries `app_badge` (the unread count), only while
 * `featureOn("inboxV1", recipient)` (src/features.js): no inbox item exists for anyone while the flag is off, except uat recipients.
 * Without `featureOn` the inbox is off (fail closed).
 * Never throws: delivery is a nicety and must not fail a write.
 */
export function createNotifier(deps) {
  const log = deps.log ?? console;
  const enabled = () => Boolean(deps.webpush && deps.vapid);
  const active = () => enabled() || Boolean(deps.inbox);
  const inboxOn = async (principal) => Boolean(deps.inbox && deps.featureOn) && (await deps.featureOn(INBOX_FLAG, principal)) === true;
  /** Producers run after a committed write: no push and no inbox configured => no reads at all; any failure is logged and swallowed. */
  const guarded = (label, fn) => async (...args) => {
    if (!active()) return;
    try {
      await fn(...args);
    } catch (e) {
      log.error?.(`${label} failed`, logSafeError(e));
    }
  };
  async function notify(feature, recipients, { navigate, actorLabel, exclude = [] }) {
    if (!active()) return { sent: 0 };
    const skip = new Set(exclude);
    let sent = 0;
    await Promise.allSettled(
      [...new Set(recipients)]
        .filter((r) => !skip.has(r))
        .map(async (principal) => {
          try {
            let badge;
            if (!PUSH_ONLY_TYPES.has(feature) && (await inboxOn(principal))) {
              const stored = await deps.inbox.put(principal, { type: feature, navigate, actorLabel }); // persist first, then push
              if (Number.isInteger(stored?.unread) && stored.unread >= 0) badge = stored.unread;
            }
            if (!enabled()) return;
            const prefs = await deps.preferences.get(principal);
            const payload = buildDeclarativePush({ registry: TEMPLATE_REGISTRY, feature, prefs, navigate, fields: { actor: actorLabel }, ...(badge === undefined ? {} : { appBadge: badge }) });
            if (!payload) return;
            const r = await sendToPrincipal({ store: deps.subscriptions, webpush: deps.webpush, vapid: deps.vapid, principal, payload });
            sent += r.sent;
          } catch (e) {
            log.error?.("notify failed", feature, logSafeError(e));
          }
        }),
    );
    return { sent };
  }

  return {
    notify,
    /** After a comment is stored: reply > mention > comment_on_my_record, one notification per recipient. */
    onComment: guarded("comment notification", async (c, { parent } = {}, { postAuthorId, earlierCommenters = [] } = {}) => {
      const navigate = c.threadId.startsWith("post:") ? `/posts/?id=${c.threadId.slice(5)}` : `/person/?id=${c.threadId.slice(7)}`;
      const base = { navigate, actorLabel: c.author.label };
      const done = new Set([c.author.id]);
      const take = (ids) => ids.filter((i) => !done.has(i) && done.add(i));
      // reply_to_me: the parent's author plus everyone who commented earlier on the same subject.
      await notify("reply_to_me", take([...(parent ? [parent.author.id] : []), ...earlierCommenters]), base);
      await notify("mention", take(mentionsOf(c.body)), base);
      const owner = c.threadId.startsWith("person:") ? c.threadId.slice(7) : postAuthorId;
      if (owner) await notify("comment_on_my_record", take([owner]), base);
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
