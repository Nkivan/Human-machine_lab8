import { expect, test, type Page } from "@playwright/test";
import type { DebugApi } from "../client/src/debug.ts"; // brings the `window.__dogfight` declaration

export type { DebugApi };

// Two browser contexts = two independent players (separate storage, separate sockets), one room.
async function enter(page: Page, name: string): Promise<void> {
  await page.goto("/?e2e=1");
  await page.getByPlaceholder("Your callsign").fill(name);
  await page.locator(".lobby li", { hasText: "Alpha" }).getByRole("button", { name: "Join" }).click();
  await expect(page.locator(".chat-status")).toHaveText("connected");
}

test("two players: roster in both, movement seen across clients within 500 ms, chat delivered", async ({ browser }) => {
  const ann = await (await browser.newContext()).newPage();
  const bob = await (await browser.newContext()).newPage();
  await enter(ann, "Ann");
  await enter(bob, "Bob");

  // 1) the roster lists both pilots in BOTH windows
  for (const page of [ann, bob]) await expect(page.locator(".chat-roster")).toHaveText("Pilots: Ann, Bob");

  // 2) Ann flies; Bob's window must see Ann's ship move within 500 ms
  const annId = await ann.waitForFunction(() => window.__dogfight?.you() ?? null).then((h) => h.jsonValue());
  if (annId === null) throw new Error("Ann has no ship id");
  const where = (id: number) => bob.evaluate((i) => window.__dogfight?.ships().find((s) => s.id === i) ?? null, id);
  await expect.poll(() => where(annId)).not.toBeNull(); // Bob sees Ann's ship at all
  const before = await where(annId);
  await ann.keyboard.down("ArrowUp"); // thrust
  const t0 = Date.now();
  await expect
    .poll(
      async () => {
        const now = await where(annId);
        return now && before ? Math.hypot(now.x - before.x, now.y - before.y) : 0;
      },
      { timeout: 500, intervals: [25] },
    )
    .toBeGreaterThan(2);
  console.log(`Bob saw Ann move after ${Date.now() - t0} ms`);
  await ann.keyboard.up("ArrowUp");

  // 3) chat: Enter focuses the input, Enter sends; Bob receives it
  await ann.keyboard.press("Enter");
  await ann.keyboard.type("hello Bob");
  await ann.keyboard.press("Enter");
  await expect(bob.locator(".chat-log")).toContainText("Ann: hello Bob");
});
