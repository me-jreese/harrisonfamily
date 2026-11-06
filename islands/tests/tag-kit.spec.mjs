// HFY-TSK-388-0G pass 2 (flag photoTagEdit): the kit tag editor on BOTH surfaces, the person page's lightbox and the media detail page (/all-media/?id=), at 375 and
// 1280: tap places a box, drag, nudge, zoom to the box, the person picker, the 1% note, remove with undo, the duplicate prompt, the stale-version banner, the offline chip,
// self-untag with undo, a proposal shown dashed with "pending review", the keyboard-only path, axe, no sideways scroll. The requests are the shipped editor's (wire parity).
// At most four screenshots in all (each surface at each width). Synthetic people only.
//   HFY_SITE=<dir> PW_PORT=<port> npx playwright test tests/tag-kit.spec.mjs --workers=1
import { test, expect } from "@playwright/test";
import { axeViolations } from "./axe.mjs";
import { NAMES, VIEWPORTS, drag, editorOf, noSideways, openEditor, pickPerson, stub, tap } from "./tag-kit-stub.mjs";

const ops = (state, n = 0) => state.calls[n].body.ops;

for (const surface of ["person", "media"]) {
  for (const [name, viewport] of VIEWPORTS) {
    test.describe(`${surface} ${name}px`, () => {
      test.use({ viewport });

      test("opens: the photo with its boxes, the accessible list, 44px targets, axe clean, no sideways scroll", async ({ page }, testInfo) => {
        await openEditor(page, surface);
        const ed = editorOf(page);
        await expect(ed.locator("[data-box]")).toHaveCount(2);
        await expect(ed.locator("ul.io-media-list li")).toHaveCount(2);
        await expect(ed.locator("ul.io-media-list")).toContainText(NAMES.I9002);
        await expect(ed.locator("ul.io-media-list")).toContainText(NAMES.I9012);
        const small = await page.evaluate(() => [...document.querySelectorAll("section.io-media-tags button")].filter((b) => b.offsetParent).map((b) => { const r = b.getBoundingClientRect(); return `${(b.textContent || "").trim()}:${Math.round(r.height)}`; }).filter((s) => Number(s.split(":").pop()) < 44));
        expect(small).toEqual([]);
        await noSideways(page);
        expect(await axeViolations(page)).toEqual([]);
        await testInfo.attach(`${surface}-${name}`, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
      });

      test("tap places a box, the picker names a person, and another person's tag is a proposal shown dashed with 'pending review'", async ({ page }) => {
        const state = await openEditor(page, surface);
        const ed = editorOf(page);
        await tap(page, 75, 75);
        await expect(page.getByRole("dialog", { name: "who is this?" })).toBeVisible();
        expect(await axeViolations(page)).toEqual([]);
        await pickPerson(page, "robin", "Robin Sample");
        await ed.getByRole("button", { name: "done" }).click();
        await expect.poll(() => state.calls.length).toBe(1);
        const [call] = state.calls;
        expect(call.body.target).toBe("Person:hp3");
        expect(call.key).toBeTruthy();
        expect(ops(state)[0].id).toBe("tag.add");
        expect(ops(state)[0].value.ref).toBe("MTAG1");
        expect(ops(state)[0].value.rect.length).toBe(4);
        expect(ops(state)[0].value.rect.every(Number.isInteger)).toBe(true);
        expect(ops(state)[0].value.private).toBe(false);
        await expect(ed).toHaveCount(0); // done closes the editor
        await page.locator("button.hfy-tag-toggle").click();
        const row = editorOf(page).locator("ul.io-media-list li", { hasText: NAMES.I9003 });
        await expect(row).toHaveAttribute("data-pending", "");
        await expect(row).toContainText("pending review");
        await expect(editorOf(page).locator('[data-box][data-pending]')).toHaveCount(1);
      });

      test("an own tag: select, nudge twice, the move is one tag.rect op that saves now", async ({ page }) => {
        const state = await openEditor(page, surface);
        const ed = editorOf(page);
        await ed.getByRole("button", { name: `edit box, ${NAMES.I9002}` }).click();
        const move = ed.getByRole("group", { name: "move or resize the selected box" }).getByRole("button", { name: "move right" });
        await move.click();
        await move.click();
        await ed.getByRole("button", { name: "done" }).click();
        await expect.poll(() => state.calls.length).toBe(1);
        const op = ops(state)[0];
        expect(op.id).toBe("tag.rect");
        expect(state.store.I9002.obj.media_list[0].rect[0]).toBeGreaterThan(10);
        expect(state.store.I9002.obj.media_list[0].rect.every(Number.isInteger)).toBe(true);
        expect(state.store.I9002.version).toBe(4);
      });

      test("drag draws a box, zoom to the box follows it, and a tiny box carries the 1% note", async ({ page }) => {
        await openEditor(page, surface);
        const ed = editorOf(page);
        await drag(page, [45, 55], [47, 57]);
        await expect(page.getByRole("dialog", { name: "who is this?" })).toBeVisible();
        await expect(ed.locator(".io-media-stage")).toHaveAttribute("data-zoom", /.+/);
        await pickPerson(page, "robin", "Robin Sample"); // the note shows once the picker has given way to the adjusting box
        await expect(ed.getByText("this box is very small. gramps stores this to the nearest 1%")).toBeVisible();
      });

      test("remove with undo (an admin's removal saves now; undo puts the box back)", async ({ page }) => {
        const state = await openEditor(page, surface, { admin: true });
        const ed = editorOf(page);
        await ed.getByRole("button", { name: `remove, ${NAMES.I9012}` }).click();
        const sheet = page.getByRole("alertdialog");
        await expect(sheet).toContainText(NAMES.I9012);
        await sheet.getByRole("button", { name: "remove" }).click();
        await expect.poll(() => state.calls.length).toBe(1);
        expect(ops(state)[0].id).toBe("tag.remove");
        expect(state.store.I9012.obj.media_list).toEqual([]);
        await ed.getByRole("button", { name: "undo" }).click();
        await expect.poll(() => state.calls.length).toBe(2);
        expect(ops(state, 1)[0].id).toBe("tag.add");
        expect(state.store.I9012.obj.media_list[0].rect).toEqual([60, 15, 90, 45]);
      });

      test("the duplicate prompt: a box over a person's own box asks to move it instead", async ({ page }) => {
        const state = await openEditor(page, surface);
        await drag(page, [10, 20], [30, 50]);
        await pickPerson(page, "sam", NAMES.I9002);
        const prompt = page.getByRole("alertdialog");
        await expect(prompt).toContainText("already tagged here");
        await expect(prompt).toContainText("move her box here instead?");
        await expect(prompt.getByRole("button", { name: "move her box here" })).toBeVisible();
        await expect(prompt.getByRole("button", { name: "add a second box" })).toBeVisible();
        await prompt.getByRole("button", { name: "cancel" }).click();
        expect(state.calls).toEqual([]);
      });

      test("a stale version: the change is held, never written, and the banner offers reload", async ({ page }) => {
        const state = await openEditor(page, surface);
        const ed = editorOf(page);
        // Another session moves the father's tag and bumps his record after this editor loaded the photo.
        state.store.I9012.obj.media_list[0].rect = [62, 17, 92, 47];
        state.store.I9012.version += 1;
        await tap(page, 75, 75);
        await pickPerson(page, "robin", "Robin Sample");
        await ed.getByRole("button", { name: "done" }).click();
        await expect(page.getByRole("alert").filter({ hasText: "someone else changed this photo" })).toBeVisible();
        expect(state.calls).toEqual([]);
        expect(state.store.I9012.obj.media_list[0].rect).toEqual([62, 17, 92, 47]);
      });

      test("offline: the change waits (chip), then goes out when the connection is back", async ({ page, context }) => {
        const state = await openEditor(page, surface);
        const ed = editorOf(page);
        await tap(page, 75, 75);
        await pickPerson(page, "robin", "Robin Sample");
        await context.setOffline(true);
        await ed.getByRole("button", { name: "add a box in the middle" }).click(); // commits the first box, opens a second
        await page.getByRole("dialog", { name: "who is this?" }).getByRole("button", { name: "cancel" }).click();
        await expect(ed.locator(".io-media-save")).toHaveAttribute("data-state", "waiting", { timeout: 15000 });
        await expect(ed.locator(".io-media-save")).toContainText("waiting for connection");
        expect(state.calls).toEqual([]);
        await context.setOffline(false);
        await expect.poll(() => state.calls.length, { timeout: 20000 }).toBe(1);
        await expect(ed.locator(".io-media-save")).toBeHidden();
      });

      test("self-untag: 'remove me from this photo' on my own tag only, a note, a reversible audit, undo", async ({ page }) => {
        const state = await openEditor(page, surface);
        const ed = editorOf(page);
        await expect(ed.getByRole("button", { name: "remove me from this photo" })).toHaveCount(1);
        await ed.getByRole("button", { name: "remove me from this photo" }).click();
        const sheet = page.getByRole("alertdialog");
        await expect(sheet).toContainText("the photo stays for everyone else.");
        await sheet.getByRole("button", { name: "remove me" }).click();
        await expect.poll(() => state.calls.length).toBe(1);
        expect(ops(state)[0].id).toBe("tag.remove");
        expect(JSON.stringify(state.calls[0].body)).toContain("Removed from this photo by the tagged person.");
        expect(state.store.I9002.obj.media_list.map((r) => r.ref)).toEqual(["MTAG3"]);
        await expect(ed.locator(".io-media-toast").getByText("you are removed from this photo.")).toBeVisible();
        await ed.getByRole("button", { name: "undo" }).click();
        await expect.poll(() => state.calls.length).toBe(2);
        await expect.poll(() => state.store.I9002.obj.media_list.map((r) => r.ref).sort()).toEqual(["MTAG1", "MTAG3"]);
        expect(state.store.I9002.obj.media_list.find((r) => r.ref === "MTAG1").rect).toEqual([10, 20, 30, 50]);
        await expect(ed.getByRole("button", { name: "remove me from this photo" })).toHaveCount(1);
      });

      test("the keyboard alone: edit a box, move it with the arrow keys, Escape sends it", async ({ page }) => {
        const state = await openEditor(page, surface);
        const ed = editorOf(page);
        await ed.getByRole("button", { name: `edit box, ${NAMES.I9002}` }).focus();
        await page.keyboard.press("Enter");
        await expect(ed.locator('[data-box][data-selected] button')).toBeFocused();
        await page.keyboard.press("ArrowRight");
        await page.keyboard.press("ArrowRight");
        await page.keyboard.press("Escape");
        await expect.poll(() => state.calls.length).toBe(1);
        expect(ops(state)[0].id).toBe("tag.rect");
        expect(state.store.I9002.obj.media_list[0].rect[0]).toBeGreaterThan(10);
      });

      test("reduced motion: the sheets do not slide; the picker is not hidden by the keyboard-sized viewport", async ({ page }) => {
        await page.emulateMedia({ reducedMotion: "reduce" });
        await openEditor(page, surface);
        await tap(page, 75, 75);
        const sheet = page.getByRole("dialog", { name: "who is this?" });
        await expect(sheet).toHaveAttribute("data-enter", "none");
        await noSideways(page);
        // focus not obscured (WCAG 2.4.11): what is on top at the centre of the box being named is the box or the photo, not the sheet
        const covered = await page.evaluate(() => {
          const d = document.querySelector('section.io-media-tags [data-key="draft"]');
          const r = d.getBoundingClientRect();
          const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          return !top || !(top.closest(".io-media-stage") || top.closest("[data-key=draft]"));
        });
        expect(covered).toBe(false);
      });

      test("with photoTagEdit off there is no toggle and the editor island is never requested", async ({ page }) => {
        const state = await openEditor(page, surface, { flag: false });
        await page.waitForTimeout(400);
        await expect(page.locator("button.hfy-tag-toggle")).toHaveCount(0);
        expect(state.islandRequests).toBe(0);
      });
    });
  }
}

test("when /api/me says editing is off the toggle stays away", async ({ page }) => {
  await stub(page, { editing: false });
  await page.goto("/all-media/?id=O1", { waitUntil: "domcontentloaded" });
  await expect(page.locator(".io-media-detail")).toBeVisible();
  await page.waitForTimeout(300);
  await expect(page.locator("button.hfy-tag-toggle")).toHaveCount(0);
});
