// A thread reopened by itself after a reload (its reply kept, O93) is focused, and its whole card shows: the top of
// its focus ring and its status badge are not cut off by the discussion's scrolling body (O99). The card sat flush
// against the top of `.primary-floating-content` (overflow: auto, no top padding), so the ring drawn 3 px outside the
// card (2 px outline, 1 px offset) was clipped along its top edge, over the "Sent" badge.
import { commentOperation } from "../support/comment-operations";
import { expect, test, type Page } from "@playwright/test";
import { sharedTsProject } from "./support/shared-service";

/** The focused card's ring box and the scrolling body's visible box, in window coordinates. */
const measure = (page: Page) =>
  page.evaluate(() => {
    const card = document.activeElement as HTMLElement | null;
    if (card === null || !card.classList.contains("archer-thread")) return null;
    const body = card.closest(".primary-floating-content") as HTMLElement;
    const cs = getComputedStyle(card);
    const ring = cs.outlineStyle === "none" ? 0 : parseFloat(cs.outlineWidth) + parseFloat(cs.outlineOffset);
    const r = card.getBoundingClientRect(),
      b = body.getBoundingClientRect();
    const badge = card.querySelector(".archer-thread-status")!.getBoundingClientRect();
    return {
      ring: { top: r.top - ring, left: r.left - ring, right: r.right + ring },
      badgeTop: badge.top,
      visible: {
        top: b.top + body.clientTop,
        left: b.left + body.clientLeft,
        right: b.left + body.clientLeft + body.clientWidth,
      },
    };
  });

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`after a reload the reopened thread card shows whole, its ring and badge uncut (${viewport.width}×${viewport.height})`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    const project = await sharedTsProject({
      files: {
        "archer.toml":
          'version = 1\n[[views]]\nid = "system"\nkind = "freeform"\ntitle = "System"\nsource = ".archer/system.mmd"\n',
        ".archer/system.mmd": "flowchart LR\n web[Web] e1@-->|calls| api[API]\n",
      },
    });
    try {
      await project.present("system");
      const origin = new URL(project.url).origin;
      const made = await project.fetch("api/comments", {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify(
          commentOperation.create({
            target: "view:system",
            anchor: { kind: "node", id: "web", label: "Web" },
            body: "A sent thread",
          }),
        ),
      });
      expect(made.ok).toBe(true);
      await page.goto(project.url);
      await page.locator('.react-flow__node[data-id="web"] [data-pin-thread]').click();
      const discussion = page.getByRole("region", { name: "Contextual discussion" });
      await expect(discussion).toContainText("A sent thread");
      const reply = discussion.getByRole("textbox", { name: "Your reply", exact: true });
      await reply.fill("a reply not yet sent");

      await page.reload();
      await expect(
        page
          .getByRole("region", { name: "Contextual discussion" })
          .getByRole("textbox", { name: "Your reply", exact: true }),
      ).toHaveValue("a reply not yet sent");
      await expect(page.getByRole("region", { name: "Contextual discussion" }).getByRole("article")).toBeFocused();
      const m = await measure(page);
      expect(m).not.toBeNull();
      expect(m!.ring.top, "the ring's top edge is inside the scrolling body").toBeGreaterThanOrEqual(
        m!.visible.top - 0.5,
      );
      expect(m!.badgeTop, "the status badge is inside the scrolling body").toBeGreaterThanOrEqual(m!.visible.top - 0.5);
      expect(m!.ring.left).toBeGreaterThanOrEqual(m!.visible.left - 0.5);
      expect(m!.ring.right).toBeLessThanOrEqual(m!.visible.right + 0.5);
    } finally {
      await project.stop();
    }
  });
}
