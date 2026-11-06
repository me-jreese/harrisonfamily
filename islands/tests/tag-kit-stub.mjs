// HFY-TSK-388-0G pass 2: the shared stub of the tagging specs. /auth, /api/me, /api/media/:id (the kit DTO the editor reads), /api/edit/Media/:id and Person/:id (the
// edit bundles the adapter plans against), /api/changes (a small fake store that applies the ops with the API's own op engine, api/src/records/ops.js), the people index,
// the flags and the pictures are answered by route interception. What the page sends is what is judged: a tag on the viewer's own record saves now, on someone else's it
// is a proposal (listed as a pending-proposal tag), an admin's saves now, and a stale base version is a 409 that changes nothing. Synthetic people only.
import { expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { applyOps } from "../../api/src/records/ops.js";

export const ME = "I9002";
export const NAMES = { I9002: "Sam Example", I9012: "Father Example", I9003: "Robin Sample", I9004: "Wren Sample" };
export const PEOPLE = Object.entries(NAMES).map(([grampsId, displayName]) => ({ grampsId, displayName, isLiving: grampsId === "I9004" }));
export const MEDIA = {
  O1: { handle: "MTAG1", w: 800, h: 600, title: "Landscape group" },
  O2: { handle: "MTAG2", w: 600, h: 900, title: "Portrait, nobody tagged yet" },
  O3: { handle: "MTAG3", w: 800, h: 600, title: "Photo with an unmarked tag" }
};
export const VIEWPORTS = [["375", { width: 375, height: 812 }], ["1280", { width: 1280, height: 900 }]];
export const PERSON = JSON.parse(readFileSync(new URL("./fixtures/person-legacy.json", import.meta.url), "utf8"));
const svg = (w, h) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="gray"/></svg>`;
export const ref = (handle, rect, extra = {}) => ({ _class: "MediaRef", private: false, citation_list: [], note_list: [], attribute_list: [], ref: handle, rect, ...extra });
const gtag = (id, rect) => ({ grampsId: id, name: NAMES[id], rect, isPrimary: false, attributes: [], notes: [], citations: [] });
export const GALLERY = {
  ...PERSON,
  mediaGallery: [
    { handle: "MTAG1", mime: "image/jpeg", title: "Landscape group", grampsId: "O1", tags: [gtag("I9002", [10, 20, 30, 50]), gtag("I9012", [60, 15, 90, 45])] },
    { handle: "MTAG2", mime: "image/jpeg", title: "Portrait, nobody tagged yet", grampsId: "O2" },
    { handle: "MTAG3", mime: "image/jpeg", title: "Photo with an unmarked tag", grampsId: "O3", tags: [gtag("I9002", null)] }
  ]
};

/** The kit's detail reply for one media, from the store: a tag per MediaRef (index = its place in media_list) and a pending-proposal tag per proposal. */
export function detailOf(state, gid) {
  const m = MEDIA[gid];
  if (!m) return null;
  const tags = [];
  const versions = [];
  for (const [pid, e] of Object.entries(state.store)) {
    versions.push(`${pid}:${e.version}`);
    (e.obj.media_list || []).forEach((r, index) => { if (r.ref === m.handle) tags.push({ personId: pid, mediaId: gid, rect: r.rect, index, state: "applied", person: { displayName: NAMES[pid] } }); });
  }
  for (const p of state.proposals) if (p.mediaId === gid) tags.push({ personId: p.personId, mediaId: gid, rect: p.rect, index: 100 + p.n, state: "pending-proposal", person: { displayName: NAMES[p.personId] } });
  return {
    card: { mediaId: gid, thumbUrl: `/media/${m.handle}.jpg`, width: m.w, height: m.h, section: "media", tagCount: tags.length, needsTags: tags.length === 0, title: m.title },
    imageUrl: `/media/${m.handle}.jpg`, origin: "gramps", tags, version: versions.join("|"), handle: m.handle, commentsSubject: `media:${gid}`
  };
}

/** All the routes. `state`: { store, calls, proposals, details, hooks }; `hooks.beforeSave(entry)` may change the store just before a save is judged. */
export async function stub(page, { flag = true, admin = false, editing = true } = {}) {
  const store = {
    I9002: { handle: "hp2", version: 3, obj: { _class: "Person", handle: "hp2", gramps_id: "I9002", media_list: [ref("MTAG1", [10, 20, 30, 50]), ref("MTAG3", null)] } },
    I9012: { handle: "hp12", version: 5, obj: { _class: "Person", handle: "hp12", gramps_id: "I9012", media_list: [ref("MTAG1", [60, 15, 90, 45])] } },
    I9003: { handle: "hp3", version: 1, obj: { _class: "Person", handle: "hp3", gramps_id: "I9003", media_list: [] } }
  };
  const state = { store, calls: [], proposals: [], details: 0, hooks: {}, islandRequests: 0, offline: false };
  await page.route(/accounts\.google\.com|googleapis|gstatic/, (r) => r.abort());
  await page.route("**/_data/flags.json", (r) => r.fulfill({ json: { authV2: true, shellV2: false, personV2: false, postsV2: false, searchV2: false, notifyV2: false, navMe: false, aboutCta: false, photoTags: true, photoTagEdit: flag, mediaBrowserV1: true, recordEdit: false } }));
  await page.route("**/auth/session", (r) => r.fulfill({ json: { authenticated: true, sub: ME, grampsId: ME, label: "Sam Example" } }));
  await page.route("**/auth/refresh", (r) => r.fulfill({ status: 401, json: { error: "no refresh" } }));
  await page.route("**/api/me", (r) => r.fulfill({ json: { id: ME, label: "Sam Example", admin, can: {}, ownRecord: { cls: "Person", handle: "hp2", gramps_id: ME }, editing } }));
  await page.route(/\/js\/islands\/photo-tag-edit\./, (r) => { state.islandRequests += 1; return r.continue(); });
  await page.route(/\/api\/media\/[^/?]+(\?.*)?$/, (r) => {
    const gid = decodeURIComponent(new URL(r.request().url()).pathname.split("/").pop());
    state.details += 1;
    const body = detailOf(state, gid);
    return body ? r.fulfill({ json: body }) : r.fulfill({ status: 404, json: { error: "not_found" } });
  });
  await page.route(/\/api\/edit\/Media\/[^/?]+$/, (r) => {
    const gid = decodeURIComponent(new URL(r.request().url()).pathname.split("/").pop());
    const m = MEDIA[gid];
    return m ? r.fulfill({ json: { key: `Media:${m.handle}`, version: 1, obj: { _class: "Media", handle: m.handle, gramps_id: gid } } }) : r.fulfill({ status: 404, json: { error: "not_found" } });
  });
  await page.route("**/api/edit/Person/*", (r) => {
    const gid = decodeURIComponent(new URL(r.request().url()).pathname.split("/").pop());
    const e = store[gid];
    if (!e) return r.fulfill({ status: 404, json: { error: "not_found" } });
    return r.fulfill({ json: { key: `Person:${e.handle}`, version: e.version, etag: `Person:${e.handle}@${e.version}`, obj: e.obj, related: {}, relation: gid === ME ? "own" : "other", viewer: { admin }, policy: { rows: [] }, pending: [], customTypes: {}, schemaHash: "0".repeat(64) } });
  });
  await page.route("**/api/changes", async (route) => {
    const req = route.request();
    const body = req.postDataJSON();
    const call = { body, key: req.headers()["idempotency-key"] };
    state.calls.push(call);
    const target = body.target;
    const gid = Object.keys(store).find((k) => `Person:${store[k].handle}` === target);
    const entry = store[gid];
    if (!entry) return route.fulfill({ status: 404, json: { error: "not_found" } });
    if (state.hooks.beforeSave) { state.hooks.beforeSave(entry); state.hooks.beforeSave = null; }
    const conflict = () => route.fulfill({ status: 409, json: { error: "version_conflict", message: "the page changed since you opened it", details: { current: { [target]: entry.version } } } });
    if (body.base_versions[target] !== entry.version) return conflict();
    const applied = applyOps({ [target]: entry.obj }, body.ops);
    if (!applied.ok) return conflict();
    if (!call.key) return route.fulfill({ status: 400, json: { error: "validation", message: "Idempotency-Key is required" } });
    const summary = body.ops.map((o) => ({ text: "tag", opIds: [o.id] }));
    if (admin || gid === ME) {
      entry.obj = applied.objects[target];
      entry.version += 1;
      return route.fulfill({ status: 201, json: { applied: { versions: { [target]: entry.version }, undo: { base_versions: { [target]: entry.version }, ops: applied.inverse } }, proposal: null, summary: summary.map((s) => ({ ...s, route: "direct" })) } });
    }
    for (const o of body.ops) {
      const v = o.value;
      const gidOfMedia = v && Object.keys(MEDIA).find((k) => MEDIA[k].handle === v.ref);
      if (o.id === "tag.add" && gidOfMedia) state.proposals.push({ personId: gid, mediaId: gidOfMedia, rect: v.rect, n: state.proposals.length });
    }
    return route.fulfill({ status: 201, json: { applied: null, proposal: { id: "P1", state: "pending" }, summary: summary.map((s) => ({ ...s, route: "review" })) } });
  });
  await page.route("**/person/index.json", (r) => r.fulfill({ json: { people: PEOPLE } }));
  await page.route("**/person/search-index.json", (r) => r.fulfill({ json: { documents: PEOPLE.map((p) => ({ grampsId: p.grampsId, searchText: p.displayName.toLowerCase() })) } }));
  await page.route("**/person/I9001.json", (r) => r.fulfill({ json: GALLERY }));
  await page.route("**/media/tree_I9001.svg", (r) => r.fulfill({ contentType: "image/svg+xml", body: readFileSync(new URL("./fixtures/tree-synthetic.svg", import.meta.url), "utf8") }));
  await page.route(/\/media\/MTAG\d\.jpg/, (r) => { const k = Object.values(MEDIA).find((m) => r.request().url().includes(m.handle)); return r.fulfill({ contentType: "image/svg+xml", body: svg(k.w, k.h) }); });
  // Registered last, so it runs first: while state.offline is set, every API request fails like a lost connection. (context.setOffline does not stop a request a route fulfils.)
  await page.route("**/api/**", (r) => (state.offline ? r.abort("internetdisconnected") : r.fallback()));
  return state;
}

/** Open the editor of photo O1 on a surface ("person": the lightbox of the person page; "media": the media detail page). */
export async function openEditor(page, surface, opts) {
  const state = await stub(page, opts);
  if (surface === "person") {
    await page.goto("/person/?id=I9001", { waitUntil: "domcontentloaded" });
    await expect(page.locator("#person-hero h1")).toHaveText("Test Person (synthetic)");
    const fig = page.locator("#person-media-grid .gallery-item").first();
    await fig.scrollIntoViewIfNeeded();
    await fig.locator("button.media-lightbox-trigger").click({ position: { x: 5, y: 5 } });
    await expect(page.locator("#mediaLightboxImage")).toBeVisible();
    if (opts && opts.flag === false) return state;
    const toggle = page.locator("#mediaLightbox button.hfy-tag-toggle");
    await expect(toggle).toBeVisible();
    await toggle.click();
  } else {
    await page.goto("/all-media/?id=O1", { waitUntil: "domcontentloaded" });
    if (opts && opts.flag === false) { await expect(page.locator(".io-media-detail")).toBeVisible(); return state; }
    const toggle = page.locator("button.hfy-tag-toggle");
    await expect(toggle).toBeVisible();
    await toggle.click();
  }
  await expect(page.locator("section.io-media-tags .io-media-stage")).toBeVisible();
  await expect(page.locator("section.io-media-tags ul.io-media-list li").first()).toBeVisible();
  return state;
}

export const editorOf = (page) => page.locator("section.io-media-tags");
export const realCalls = (state) => state.calls;

/** Percent of the photo -> page coordinates (the stage is the photo's shape in the fixtures). */
export async function at(page, px, py) {
  const stage = editorOf(page).locator(".io-media-stage");
  await stage.scrollIntoViewIfNeeded(); // a point low on a tall photo can be below the fold of a 900 px window
  const b = await stage.boundingBox();
  return [b.x + (px / 100) * b.width, b.y + (py / 100) * b.height];
}
export async function tap(page, px, py) {
  const [x, y] = await at(page, px, py);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.up();
}
export async function drag(page, from, to) {
  const [x1, y1] = await at(page, ...from);
  const [x2, y2] = await at(page, ...to);
  await page.mouse.move(x1, y1);
  await page.mouse.down();
  await page.mouse.move((x1 + x2) / 2, (y1 + y2) / 2, { steps: 4 });
  await page.mouse.move(x2, y2, { steps: 4 });
  await page.mouse.up();
}
export async function pickPerson(page, typed, name) {
  const sheet = page.getByRole("dialog", { name: "who is this?" });
  await sheet.getByRole("combobox").fill(typed);
  await sheet.getByRole("option", { name: new RegExp(name) }).click();
}
export const noSideways = async (page) => expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
