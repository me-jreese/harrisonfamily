// HFY-TSK-406: tag editing in the person-page lightbox on a phone (390 x 844). The editor is taller than the modal body, so (a) its header with "done" stays at the top of the
// body while the body scrolls, and (b) the swipe that closes the lightbox (swipe down >= 80 px) and steps photos is inert while the editor is open, so scrolling back up to
// "done" never closes the lightbox. With the editor closed the swipe still closes it. Synthetic people only. Runs on localhost against the committed site:
//   HFY_SITE=<dir> PW_PORT=<port> npx playwright test tests/lightbox-tag-edit-scroll.spec.mjs --workers=1
import { test, expect } from "@playwright/test";
import { ME } from "../../api/test/edit-e2e-world.js";
import { createEditWorld, editor, member, openPhoto, startTagging, toggle } from "./tag-e2e-bridge.mjs";

test.use({ viewport: { width: 390, height: 844 } });

let world;
test.beforeEach(async () => { world = await createEditWorld({ photo: true }); });
test.afterEach(() => world.dispose());

const body = (page) => page.locator("#mediaLightbox .modal-body");
const shown = (page) => page.locator("#mediaLightbox.show");

/** A touch swipe on the modal body: touchstart then touchend `dy` px lower (the page's handler reads only the first touch's clientX/clientY). */
async function swipe(page, dx, dy) {
  await body(page).evaluate((el, [x, y]) => {
    const fire = (type, list) => {
      const e = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(e, "touches", { value: type === "touchend" ? [] : list });
      Object.defineProperty(e, "changedTouches", { value: list });
      el.dispatchEvent(e);
    };
    const r = el.getBoundingClientRect();
    const sx = r.left + r.width / 2; const sy = r.top + 100;
    fire("touchstart", [{ clientX: sx, clientY: sy }]);
    fire("touchend", [{ clientX: sx + x, clientY: sy + y }]);
  }, [dx, dy]);
}

/** The done button is wholly inside the viewport and inside the modal body's visible box. */
async function expectDoneInView(page) {
  const done = editor(page).getByRole("button", { name: "done" });
  await expect(done).toBeVisible();
  const [d, b] = [await done.boundingBox(), await body(page).boundingBox()];
  const vh = page.viewportSize().height;
  expect(d.y).toBeGreaterThanOrEqual(0);
  expect(d.y + d.height).toBeLessThanOrEqual(vh);
  expect(d.y).toBeGreaterThanOrEqual(b.y - 1);
  expect(d.y + d.height).toBeLessThanOrEqual(b.y + b.height + 1);
}

test("'edit box' keeps done in view, also after scrolling the body down and back up", async ({ browser }) => {
  const { page, ctx } = await member(browser, world, ME, { width: 390, height: 844 });
  await startTagging(page);
  await editor(page).getByRole("button", { name: "edit box, Hazel Birchwell" }).click();
  await expect(editor(page).getByRole("button", { name: "move right" })).toBeVisible();
  await expectDoneInView(page);
  await body(page).evaluate((el) => { el.scrollTop = el.scrollHeight; });
  expect(await body(page).evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  await expectDoneInView(page);
  await body(page).evaluate((el) => { el.scrollTop = 0; });
  await expectDoneInView(page);
  // the header sits above the stage, so the stage never covers it
  const head = editor(page).locator("header.io-media-head");
  expect(await head.evaluate((el) => getComputedStyle(el).position)).toBe("sticky");
  await ctx.close();
});

test("while the editor is open a swipe down of 150 px leaves the lightbox open, and a sideways swipe does not step", async ({ browser }) => {
  const { page, ctx } = await member(browser, world, ME, { width: 390, height: 844 });
  await startTagging(page);
  await editor(page).getByRole("button", { name: "edit box, Hazel Birchwell" }).click();
  await expect(shown(page)).toHaveCount(1);
  await swipe(page, 0, 150);
  await swipe(page, -150, 0);
  await swipe(page, 150, 0);
  await page.waitForTimeout(600); // the modal's fade-out is 300 ms or less
  await expect(shown(page)).toHaveCount(1);
  await expect(editor(page)).toBeVisible();
  await expect(page.locator("#mediaLightboxCounter")).toHaveText(/^1 of /);
  await ctx.close();
});

test("with the editor closed the same swipe down closes the lightbox", async ({ browser }) => {
  const { page, ctx } = await member(browser, world, ME, { width: 390, height: 844 });
  await startTagging(page);
  await editor(page).getByRole("button", { name: "done" }).click();
  await expect(editor(page)).toHaveCount(0);
  await expect(toggle(page)).toHaveAttribute("aria-pressed", "false");
  await swipe(page, 0, 150);
  await expect(shown(page)).toHaveCount(0);
  await ctx.close();
});

test("the lightbox without tag editing still closes on a swipe down", async ({ browser }) => {
  const { page, ctx } = await member(browser, world, ME, { width: 390, height: 844 });
  await openPhoto(page);
  await expect(toggle(page)).toBeVisible(); // the modal has finished showing (Bootstrap ignores hide() mid-transition)
  await page.waitForTimeout(500);
  await swipe(page, 0, 150);
  await expect(shown(page)).toHaveCount(0);
  await ctx.close();
});
