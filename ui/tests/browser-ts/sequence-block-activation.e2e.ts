import { expect, test } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { sharedTsProject } from "./support/shared-service";

const SOURCE = `sequenceDiagram
participant A as Client
participant B as Service
opt additions unavailable
 A->>B: Request additions
 B-->>A: Unavailable
end
`;

for (const activation of ["click", "Enter", "Space"]) {
  test(`${activation} opens exactly one whole-block composer in Hand and Select modes`, async ({ page }) => {
    const project = await sharedTsProject({
      files: { ".archer/sequence.mmd": SOURCE },
      commentSubmission: "queued",
    });
    try {
      await project.present("sequence");
      await page.goto(project.url);
      const block = page.getByRole("button", { name: /^opt block: additions unavailable(, has comments)?$/ });
      await expect(block).toHaveAccessibleName("opt block: additions unavailable");
      await expect(block).toBeVisible();
      const discussion = page.getByRole("region", { name: "Contextual discussion", exact: true });
      for (const mode of ["Hand", "Select"]) {
        await page.getByRole("button", { name: `${mode} mode`, exact: true }).click();
        if (mode === "Select") {
          await page.locator('.archer-seq-message[data-seq-id="msg-0"]').click();
          await expect.poll(() => project.selection()).toMatchObject({ edges: [{ id: "msg-0" }] });
        }
        const before = await project.selection();
        if (activation === "click") await block.click({ position: { x: 25, y: 10 } });
        else await block.press(activation === "Space" ? " " : activation);
        await expect(discussion).toHaveCount(1);
        await expect(discussion.getByRole("textbox", { name: "Comment", exact: true })).toBeFocused();
        await expect(discussion.getByRole("textbox", { name: "Comment", exact: true })).toHaveCount(1);
        await expect(discussion.locator(".primary-floating-context")).toHaveText("opt block: additions unavailable");
        expect(await project.selection()).toEqual(before);
        await discussion.getByRole("textbox", { name: "Comment", exact: true }).fill(`${activation} in ${mode}`);
        await discussion.getByRole("button", { name: "Add comment", exact: true }).click();
        await expect(discussion.getByRole("article")).toBeFocused();
        if (activation === "click" && mode === "Select") {
          mkdirSync(resolve("../.shots"), { recursive: true });
          await page.screenshot({ path: resolve("../.shots/sequence-block-click.png") });
        }
        await discussion.getByRole("button", { name: "Close discussion", exact: true }).click();
      }
      const threads = JSON.parse(readFileSync(join(project.root, ".archer/sequence.comments.json"), "utf8")).threads;
      expect(threads).toHaveLength(2);
      expect(threads.map((thread: { anchor: unknown }) => thread.anchor)).toEqual([
        { kind: "group", id: "frag-0", label: "additions unavailable" },
        { kind: "group", id: "frag-0", label: "additions unavailable" },
      ]);
    } finally {
      await project.stop();
    }
  });
}

test("dragging a block in Hand mode pans without opening a composer", async ({ page }) => {
  const project = await sharedTsProject({ files: { ".archer/sequence.mmd": SOURCE } });
  try {
    await project.present("sequence");
    await page.goto(project.url);
    const block = page.getByRole("button", { name: "opt block: additions unavailable", exact: true });
    await expect(block).toBeVisible();
    const viewport = page.locator(".archer-seq-viewport");
    const before = await viewport.getAttribute("transform");
    const rect = await block.boundingBox();
    expect(rect).not.toBeNull();
    await page.mouse.move(rect!.x + 25, rect!.y + 10);
    await page.mouse.down();
    await page.mouse.move(rect!.x + 105, rect!.y + 70, { steps: 8 });
    await page.mouse.up();
    await expect(viewport).not.toHaveAttribute("transform", before!);
    await expect(page.getByRole("region", { name: "Contextual discussion", exact: true })).toHaveCount(0);
  } finally {
    await project.stop();
  }
});
