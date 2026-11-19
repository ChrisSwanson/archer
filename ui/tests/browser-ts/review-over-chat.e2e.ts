// Project Review and the floating chat are one conversation surface at a time: opening the review while the
// chat floats over the page puts the review in front of nothing that covers it.
import { commentOperation } from "../support/comment-operations";
import { expect, test, type Page } from "@playwright/test";
import type { TsProject } from "../support/ts-service";
import { walkthroughFiles } from "../support/walkthrough-project";
import { sharedTsProject } from "./support/shared-service";

const project = (): Promise<TsProject> => sharedTsProject({ files: walkthroughFiles(), commentSubmission: "queued" });
const fab = (page: Page) => page.getByRole("button", { name: /^Chat with the agent about/ });
const chat = (page: Page) => page.getByRole("dialog", { name: /Chat with the agent/ });

for (const size of [
  { width: 1024, height: 768 },
  { width: 1440, height: 900 },
]) {
  test(`${size.width}x${size.height}: opening the review with the chat open leaves the review list uncovered`, async ({
    browser,
  }) => {
    const server = await project();
    const context = await browser.newContext({ viewport: size });
    try {
      const page = await context.newPage();
      await server.present("containers");
      const origin = new URL(server.url).origin;
      for (const body of ["First note", "Second note", "Third note"]) {
        const made = await server.fetch("api/comments", {
          method: "POST",
          headers: { "content-type": "application/json", origin },
          body: JSON.stringify(
            commentOperation.create({
              target: "view:containers",
              anchor: { kind: "node", id: "api", label: "API" },
              body,
            }),
          ),
        });
        expect(made.ok).toBe(true);
      }
      await page.goto(server.url);
      await expect(page.locator(".react-flow__node[data-id='api']")).toBeVisible();
      await fab(page).click();
      await expect(chat(page)).toBeVisible();
      await page.locator(".archer-review-toggle").click();
      const review = page.locator("#archer-review");
      await expect(review).toBeVisible();
      await expect(chat(page)).toHaveCount(0);
      const rows = review.locator(".primary-inbox-item");
      await expect(rows.first()).toBeVisible();
      // The side panel cross-fades its old content out as the review comes in: wait for it to settle.
      await expect
        .poll(() =>
          rows.evaluateAll((list) =>
            list
              // The first two rows are wholly on screen; a lower one may be scrolled out of the list's clip.
              .slice(0, 2)
              .map((row) => {
                const r = row.getBoundingClientRect();
                const hit = document.elementFromPoint(r.x + r.width / 2, r.y + Math.min(r.height / 2, 8));
                // Whatever answers at a row's point must belong to the review, not to a surface laid over it.
                return hit !== null && hit.closest("#archer-review") === null
                  ? `${hit.tagName}.${hit.className}`
                  : null;
              })
              .filter((x) => x !== null),
          ),
        )
        .toEqual([]);
    } finally {
      await context.close();
      await server.stop();
    }
  });
}
