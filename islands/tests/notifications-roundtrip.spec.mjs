// HFY-TSK-318: /me/notifications drives the REAL api handler (the kit's notify handler over the in-memory DynamoDB fake), not a stub.
// Every toggle's exact PUT /api/notifications/preferences payload is captured in the browser, and the test asserts it round-trips into the
// stored preferences shape ({features:{type:{enabled,detail}}}) and back out on GET ({types:{type:{enabled,level}}}): no mapping drift.
// Synthetic principal only.
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { makeApi, signToken } from "../../api/test/world.js";
import { TEMPLATE_REGISTRY } from "../../api/src/notify.js";

const ME = "I0001";

async function wire(page) {
  const w = makeApi({ withPush: true });
  const token = await signToken(ME);
  const puts = [];
  await page.route("**/api/notifications/**", async (r) => {
    const req = r.request(); const u = new URL(req.url());
    const body = req.postData() ? JSON.parse(req.postData()) : undefined;
    if (req.method() === "PUT" && u.pathname.endsWith("/preferences")) puts.push(body);
    const res = await w.call(req.method(), u.pathname, { token, body });
    return r.fulfill({ status: res.status, json: res.body ?? {} });
  });
  return { w, puts };
}

const open = async (page) => {
  await page.goto("/me/notifications/?hfy_flags=notifyV2", { waitUntil: "domcontentloaded" });
  const root = page.locator(".hfy-notify");
  await expect(root.locator('[data-type="mention"] [role=switch]')).toBeVisible();
  return root;
};

test("toggles and detail levels reach the stored shape and come back on GET unchanged", async ({ page }) => {
  const { w, puts } = await wire(page);
  const root = await open(page);

  // 1. Turn "someone mentions me" off.
  await root.locator('[data-type="mention"] [role=switch]').click();
  await expect.poll(() => puts.length).toBeGreaterThan(0);
  const afterOff = puts.at(-1);
  expect(afterOff.types.mention).toEqual({ enabled: false, level: 0 });
  expect(await w.preferences.get(ME)).toMatchObject({ features: { mention: { enabled: false, detail: 0 } } });

  // 2. Show who for "someone replies to me" (level 1).
  await root.locator('[data-testid="detail-reply_to_me"] [role=radio]').nth(1).click();
  await expect.poll(() => puts.at(-1)?.types?.reply_to_me?.level).toBe(1);
  const afterLevel = puts.at(-1);
  expect(afterLevel.types.reply_to_me).toEqual({ enabled: true, level: 1 });
  expect(afterLevel.types.mention).toEqual({ enabled: false, level: 0 });

  // The stored shape is exactly the wire payload re-keyed: level -> detail, types -> features. Nothing else is invented or dropped.
  const stored = await w.preferences.get(ME);
  expect(Object.keys(stored)).toEqual(["features"]);
  expect(stored.features).toEqual(Object.fromEntries(Object.entries(afterLevel.types).map(([k, v]) => [k, { enabled: v.enabled, detail: v.level }])));

  // 3. GET returns the same per-type values the PUT sent (the master flag and extra are the kit's constants).
  const got = await w.call("GET", "/api/notifications/preferences", { token: await signToken(ME) });
  expect(got.status).toBe(200);
  expect(got.body).toEqual({ enabled: true, types: afterLevel.types, extra: {} });

  // 4. A reload renders the stored state: mention is off, replies show "show who" selected.
  await page.reload({ waitUntil: "domcontentloaded" });
  const again = page.locator(".hfy-notify");
  await expect(again.locator('[data-type="mention"] [role=switch]')).toHaveAttribute("aria-checked", "false");
  await expect(again.locator('[data-testid="detail-reply_to_me"] [role=radio]').nth(1)).toHaveAttribute("aria-checked", "true");
  await expect(again.locator('[data-testid="detail-reply_to_me"] [role=radio]').nth(0)).toHaveAttribute("aria-checked", "false");
  // The reload did not re-save anything or change what is stored.
  expect((await w.preferences.get(ME)).features).toEqual(stored.features);
});

test("every payload the page sends is accepted by the handler (200, never invalid preferences)", async ({ page }) => {
  const statuses = [];
  const { w } = await wire(page);
  page.on("response", (res) => { if (res.request().method() === "PUT" && res.url().endsWith("/api/notifications/preferences")) statuses.push(res.status()); });
  const root = await open(page);
  const types = ["comment_on_my_record", "reply_to_me", "new_family_post", "mention"];
  for (const [i, t] of types.entries()) {
    await root.locator(`[data-type="${t}"] [role=switch]`).click();
    await expect.poll(() => statuses.length).toBeGreaterThanOrEqual(i + 1);
  }
  await expect.poll(async () => Object.keys((await w.preferences.get(ME)).features ?? {}).length).toBe(4);
  expect(statuses.length).toBeGreaterThanOrEqual(4);
  expect(statuses.every((s) => s === 200)).toBe(true);
});

// HFY-TSK-253 added the PLN-002 types to TEMPLATE_REGISTRY (api/src/notify.js notifyContract()). The island CATALOG gains them in
// hfy-inbox-ui (chat_message in hfy-chat-api-service-routes); until then they are pinned here, so a registry type that is neither in the
// CATALOG nor on this list still fails the test. Moving a type into the CATALOG means removing it from this list.
const REGISTRY_TYPES_NOT_IN_CATALOG = [
  "proposal_submitted", "proposal_accepted", "proposal_declined", "proposal_needs_changes", "proposal_stale",
  "record_updated_mine", "record_updated_followed", "records_updated_followed_digest",
  "moderation_hidden", "moderation_request", "moderation_question", "moderation_unhidden", "moderation_resolved",
  "photo_graduated", "chat_message",
];

// Deliberately a source-text check: the island is JSX and not importable from the node/Playwright runner without a build step.
// If CATALOG is reformatted (4-space entries, `export const CATALOG` / `export const LABELS` markers) update the slice below.
test("the island catalog and the server registry name the same types (less the pinned PLN-002 types) with the same lock-screen text", async () => {
  const src = readFileSync(new URL("../src/islands/notifications.jsx", import.meta.url), "utf8");
  const catalog = src.slice(src.indexOf("export const CATALOG"), src.indexOf("export const LABELS"));
  const ids = [...catalog.matchAll(/^\s{4}(\w+): \{ group:/gm)].map((m) => m[1]);
  const registry = Object.keys(TEMPLATE_REGISTRY.features);
  expect(REGISTRY_TYPES_NOT_IN_CATALOG.filter((id) => !registry.includes(id)), "pinned types missing from the registry").toEqual([]);
  expect(ids.filter((id) => REGISTRY_TYPES_NOT_IN_CATALOG.includes(id)), "a CATALOG type still on the pinned list").toEqual([]);
  expect(ids.sort()).toEqual(registry.filter((id) => !REGISTRY_TYPES_NOT_IN_CATALOG.includes(id)).sort());
  for (const id of ids) {
    const t = TEMPLATE_REGISTRY.features[id];
    expect(catalog, `${id} generic`).toContain(`generic: ${JSON.stringify(t.level0)}`);
    expect(catalog, `${id} detailed`).toContain(`detailed: ${JSON.stringify(t.level1)}`);
  }
});
