import { commentOperation } from "../support/comment-operations";
import { expect, test } from "@playwright/test";
import { sharedTsProject } from "./support/shared-service";

test("the open-thread filter includes a note and refreshes when its thread is resolved", async ({ page }) => {
  const project = await sharedTsProject({
    files: { "archer.toml": "version = 1\n", ".archer/notes/decision.md": "# Decision\n\nA durable decision.\n" },
  });
  try {
    await page.goto(project.address(`q=&kind=note&status=comments`));
    await expect(page.getByText("No files match these filters.")).toBeVisible();
    const response = await page.request.post(project.api(`api/comments`), {
      headers: { origin: new URL(project.url).origin },
      // As the page sends it: an operation (ADR 0016), answered with its receipt and the thread.
      data: commentOperation.create({
        target: "note:notes/decision.md",
        anchor: { kind: "view" },
        body: "Why this decision?",
      }),
    });
    expect(response.status()).toBe(200);
    const thread = (await response.json()).thread;
    const result = page
      .getByRole("region", { name: "Project documents", exact: true })
      .locator("[data-browser-row]")
      .filter({ has: page.getByRole("button", { name: "Decision", exact: true }) });
    await expect(result).toBeVisible();
    await expect(result).toContainText("1 open");
    const resolved = await page.request.post(project.api(`api/comments/${thread.id}/resolve`), {
      headers: { origin: new URL(project.url).origin },
      data: {},
    });
    expect(resolved.status()).toBe(200);
    await expect(result).toHaveCount(0);
    await expect(page.getByText("No files match these filters.")).toBeVisible();
  } finally {
    await project.stop();
  }
});
