// The admin inbox item of a new access request (surfaces.md 7.2 step 4; task surf-access-submit). It is the notification domain's own
// delivery, not a copy of it: the same @io-kit/notify createDelivery, the same TEMPLATE_REGISTRY (shared/notify-registry.mjs, which
// api/src/notify.js re-exports) and the same INBOX#<principal> store as hfy-api's producers (api/src/index.js createInboxStore), with no
// push (the edge holds no subscriptions) and no fields: the item says "someone asked to join." and opens /me/requests/. Persist-first
// writes sit behind the inboxV1 flag, like every other producer (BRD2 D2-28). A failure is never thrown: the caller already committed.
import { DynamoNotificationStore, createDelivery } from "@io-kit/notify/server";
import { ACCESS_REQUEST_NOTIFICATION, TEMPLATE_REGISTRY } from "./shared/notify-registry.mjs";

/** Unread items carry no TTL; the 90-day TTL starts when an item is read (BRD2 D2-15; the same numbers as api/src/index.js INBOX_TTL). */
export const INBOX_TTL = Object.freeze({ unreadTtlDays: null, readTtlDays: 90 });

/**
 * - `principals()` returns the admin principals (createAdminDirectory).
 * - `featureOn(name)` returns whether a flag is on (createFlagReader); omitted means the inbox is off.
 * - `store` is a NotificationStore; by default a DynamoNotificationStore on `ddb`, `cmds` and `table`.
 * `notifyNewRequest()` resolves to { stored, failed } and never rejects.
 */
export function createAdminInbox({ principals, featureOn, ddb, cmds, table, store, log = console }) {
  const inbox = store ?? new DynamoNotificationStore(ddb, cmds, table, { ...INBOX_TTL });
  const deliver = createDelivery({
    registry: TEMPLATE_REGISTRY, store: inbox,
    // fixed labels only: the kit's log data holds a feature name and an error name, but nothing is forwarded beyond the label
    log: (event) => log.error?.(JSON.stringify({ msg: "admin inbox", event })),
  });
  return {
    async notifyNewRequest() {
      const none = { stored: 0, failed: 0 };
      try {
        if (!featureOn || (await featureOn("inboxV1")) !== true) return none;
        const recipients = await principals();
        if (!recipients.length) return none;
        const r = await deliver({ ...ACCESS_REQUEST_NOTIFICATION, fields: {}, recipients });
        return { stored: r.stored, failed: r.failed };
      } catch (e) {
        log.error?.(JSON.stringify({ msg: "admin inbox failed", error: e instanceof Error && e.name ? e.name : "error" }));
        return none;
      }
    },
  };
}
