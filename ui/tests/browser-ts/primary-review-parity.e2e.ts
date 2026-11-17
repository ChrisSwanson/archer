import { commentOperation } from "../support/comment-operations";
import { files as projectPage, graphToolsTrigger } from "./support/primary-navigation";
import { expect, test } from "@playwright/test";
import { sharedTsProject } from "./support/shared-service";

test("Review thread navigation selects its destination model when node IDs overlap", async ({ page }) => {
  const project = await sharedTsProject({
    files: {
      "archer.toml":
        'version = 1\n[[views]]\nid = "first"\nkind = "freeform"\ntitle = "First drawing"\nsource = ".archer/first.mmd"\n[[views]]\nid = "second"\nkind = "freeform"\ntitle = "Second drawing"\nsource = ".archer/second.mmd"\n',
      ".archer/first.mmd": "flowchart LR\n shared[First model node] first-edge@--> first-end[First end]\n",
      ".archer/second.mmd": "flowchart LR\n shared[Second model node] second-edge@--> second-end[Second end]\n",
    },
  });
  try {
    await project.present("first");
    const response = await project.fetch("api/comments", {
      method: "POST",
      headers: { "content-type": "application/json", origin: new URL(project.url).origin },
      body: JSON.stringify(
        commentOperation.create({
          target: "view:second",
          anchor: { kind: "node", id: "shared", label: "Second model node" },
          body: "Review the second model node",
        }),
      ),
    });
    expect(response.ok).toBe(true);
    await page.goto(project.url);
    const shared = page.locator('.react-flow__node[data-id="shared"]');
    await expect(shared).toContainText("First model node");
    await page.getByRole("button", { name: /^Notifications/ }).click();
    const review = page.getByRole("region", { name: "Project Review" });
    await review.getByRole("button", { name: /Review the second model node/ }).click();
    // The entry opens in place; Show on diagram takes it to the drawing.
    await expect(review.getByRole("article", { name: /Second model node/ })).toBeVisible();
    await review.getByRole("button", { name: "Show on diagram" }).click();
    await expect(shared).toContainText("Second model node");
    await expect(shared).toHaveClass(/selected/);
    await expect(page.getByRole("region", { name: "Contextual discussion" })).toContainText(
      "Review the second model node",
    );
    await expect
      .poll(async () => {
        const selection = await project.selection();
        return {
          viewId: selection?.viewId,
          nodes: selection?.nodes.map(({ id, label }) => ({ id, label })),
          edges: selection?.edges,
        };
      })
      .toEqual({ viewId: "second", nodes: [{ id: "shared", label: "Second model node" }], edges: [] });
    await (await projectPage(page)).getByRole("button", { name: "First drawing", exact: true }).click();
    await expect(shared).toContainText("First model node");
    await expect(page.getByRole("region", { name: "Contextual discussion" })).toHaveCount(0);
  } finally {
    await project.stop();
  }
});

test("primary shell keeps a queue semantic and offers no vendor appearance pack", async ({ page }) => {
  const project = await sharedTsProject({
    files: {
      "archer.toml":
        'version = 1\n[[views]]\nid = "queues"\nkind = "c4"\ntitle = "Queues"\nsource = ".archer/queues.mmd"\n',
      ".archer/queues.mmd": 'C4Container\n ContainerQueue(queue, "Queue", "Messages", "Pending jobs")\n',
    },
  });
  try {
    await project.present("queues");
    await page.goto(project.url);
    const queue = page.locator('.react-flow__node[data-id="queue"]');
    await expect(queue).toBeVisible();
    await expect(queue.locator(".archer-c4-type")).toContainText("queue");
    await expect(queue.locator(".archer-c4-queue-cap ellipse")).toHaveCount(1);
    await queue.hover();
    await page.getByRole("button", { name: "Select mode", exact: true }).click();
    await queue.click();
    await expect(queue).toHaveClass(/selected/);
    await expect(queue.locator(".archer-c4-queue-cap ellipse")).toHaveCount(1);
    await project.setEmphasis("queues", [
      {
        id: "jobs",
        title: "Job queue",
        groups: [{ id: "queue", label: "queue", nodes: ["queue"], edges: [], style: "highlight" }],
      },
    ]);
    await expect(page.getByRole("button", { name: "Job queue", exact: true })).toBeVisible();
    await expect(queue.locator(".archer-c4-queue-cap ellipse")).toHaveCount(1);
    await graphToolsTrigger(page).click();
    await expect(page.getByRole("button", { name: /Appearance|Vendor icons|AWS icons|Python diagrams/i })).toHaveCount(
      0,
    );
    await expect(queue.locator("img, image")).toHaveCount(0);
    await expect(queue).not.toContainText(/Amazon|AWS|SQS|Azure|Google Cloud/);
  } finally {
    await project.stop();
  }
});
