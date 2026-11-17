import { commentOperation } from "../support/comment-operations";
import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sharedTsProject } from "./support/shared-service";

const files = {
  "archer.toml": 'version = 1\n[[views]]\nid="system"\nkind="freeform"\ntitle="System"\nsource=".archer/system.mmd"\n',
  ".archer/system.mmd": "flowchart LR\n  web[Web] e1@--> api[API]\n",
};

test("a graph discussion shares the immediate reply template and retains a refused reply", async ({ page }) => {
  const project = await sharedTsProject({ files });
  const persisted = () =>
    JSON.parse(readFileSync(join(project.root, ".archer/system.comments.json"), "utf8")) as {
      threads: { comments: { body: string }[] }[];
    };
  try {
    await project.present("system");
    const created = await project.fetch("api/comments", {
      method: "POST",
      headers: { "content-type": "application/json", origin: new URL(project.url).origin },
      body: JSON.stringify(
        commentOperation.create({
          target: "view:system",
          anchor: { kind: "node", id: "web", label: "Web" },
          body: "Graph question",
        }),
      ),
    });
    expect(created.ok).toBe(true);

    await page.goto(project.url);
    await page.locator('.react-flow__node[data-id="web"] .archer-pin').click();
    const discussion = page.getByRole("region", { name: "Contextual discussion" });
    const card = discussion.getByRole("article", { name: "Node: Web" });
    const reply = card.getByRole("textbox", { name: "Your reply" });
    const replyButton = card.getByRole("button", { name: "Reply", exact: true });
    const resolveButton = card.getByRole("button", { name: "Resolve", exact: true });

    await expect(reply).toBeVisible();
    await expect(replyButton).toBeDisabled();
    await expect(card).toBeFocused();
    await expect(card.locator(".archer-composer-actions")).toContainText("ReplyResolve");
    expect(await card.locator(".archer-composer-actions button").allTextContents()).toEqual(["Reply", "Resolve"]);

    let releaseRefusal!: () => void;
    const heldRefusal = new Promise<void>((resolve) => {
      releaseRefusal = resolve;
    });
    let sawRefusedRequest!: () => void;
    const refusedRequest = new Promise<void>((resolve) => {
      sawRefusedRequest = resolve;
    });
    await page.route("**/api/comments/*/replies", async (route) => {
      sawRefusedRequest();
      await heldRefusal;
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({ error: "write_conflict", message: "Try again." }),
      });
    });
    await reply.fill("Keep this refused reply");
    await page.keyboard.press("Control+Enter");
    await refusedRequest;
    await expect(replyButton).toBeDisabled();
    releaseRefusal();
    await expect(discussion.getByRole("alert")).toContainText("Could not reply: replying failed with HTTP 409");
    await expect(replyButton).toBeEnabled();
    await expect(reply).toHaveValue("Keep this refused reply");
    await page.unroute("**/api/comments/*/replies");

    await page.keyboard.press("Control+Enter");
    await expect.poll(() => persisted().threads[0]?.comments.at(-1)?.body).toBe("Keep this refused reply");
    await expect(reply).toHaveValue("");
    await expect(reply).toBeFocused();
  } finally {
    await project.stop();
  }
});
