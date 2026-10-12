// Notification registry (four HFY types, level 0 by default) and best-effort fan-out.
import { buildDeclarativePush, sendToPrincipal } from "@io-kit/notify/server";

/** Level 0 is content-free; level 1 may name the actor. Recipients opt in to level 1 per type. */
export const TEMPLATE_REGISTRY = {
  features: {
    comment_on_my_record: { title: "Family tree", level0: "Someone commented on your record.", level1: "{actor} commented on your record." },
    reply_to_me: { title: "Family tree", level0: "Someone replied to you.", level1: "{actor} replied to you." },
    new_family_post: { title: "Family news", level0: "There is a new family post.", level1: "{actor} shared a new family post." },
    mention: { title: "Family tree", level0: "You were mentioned.", level1: "{actor} mentioned you." },
  },
  whitelist: ["actor"],
};
/** `@I0044` in a comment body mentions that gramps person (= principal id). */
export const mentionsOf = (body) => [...new Set([...String(body).matchAll(/(?:^|[^\w@])@(I\d{4,8})\b/g)].map((m) => m[1]))].slice(0, 10);
export const NOTIFY_TYPES = Object.keys(TEMPLATE_REGISTRY.features);

/**
 * deps: { subscriptions, preferences, webpush, vapid, listPrincipals, log }.
 * Never throws: push is a nicety and must not fail a write.
 */
export function createNotifier(deps) {
  const log = deps.log ?? console;
  async function notify(feature, recipients, { navigate, actorLabel, exclude = [] }) {
    if (!deps.webpush || !deps.vapid) return { sent: 0 };
    const skip = new Set(exclude);
    let sent = 0;
    await Promise.allSettled(
      [...new Set(recipients)]
        .filter((r) => !skip.has(r))
        .map(async (principal) => {
          try {
            const prefs = await deps.preferences.get(principal);
            const payload = buildDeclarativePush({ registry: TEMPLATE_REGISTRY, feature, prefs, navigate, fields: { actor: actorLabel } });
            if (!payload) return;
            const r = await sendToPrincipal({ store: deps.subscriptions, webpush: deps.webpush, vapid: deps.vapid, principal, payload });
            sent += r.sent;
          } catch (e) {
            log.error?.("notify failed", feature, e instanceof Error ? e.message : String(e));
          }
        }),
    );
    return { sent };
  }

  return {
    notify,
    /** After a comment is stored: reply > mention > comment_on_my_record, one notification per recipient. */
    async onComment(c, { parent }, { postAuthorId, earlierCommenters = [] } = {}) {
      const navigate = c.threadId.startsWith("post:") ? `/posts/?id=${c.threadId.slice(5)}` : `/person/?id=${c.threadId.slice(7)}`;
      const base = { navigate, actorLabel: c.author.label };
      const done = new Set([c.author.id]);
      const take = (ids) => ids.filter((i) => !done.has(i) && done.add(i));
      // reply_to_me: the parent's author plus everyone who commented earlier on the same subject.
      await notify("reply_to_me", take([...(parent ? [parent.author.id] : []), ...earlierCommenters]), base);
      await notify("mention", take(mentionsOf(c.body)), base);
      const owner = c.threadId.startsWith("person:") ? c.threadId.slice(7) : postAuthorId;
      if (owner) await notify("comment_on_my_record", take([owner]), base);
    },
    async onPublished(post) {
      const everyone = deps.listPrincipals ? await deps.listPrincipals() : [];
      await notify("new_family_post", everyone, { navigate: `/posts/?id=${post.id}`, actorLabel: post.author.label, exclude: [post.author.id] });
    },
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
