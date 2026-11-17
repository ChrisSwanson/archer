import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { TsProject } from "../support/ts-service";
import { sharedTsProject } from "./support/shared-service";

const SOURCE = `sequenceDiagram
participant A as Client
participant B as Service
alt ready
 A->>B: Start
 opt cached
  B-->>A: Cache hit
  Note over A,B: Cached response
 end
else wait
 B-->>A: Wait
end
loop retry
 A->>B: Retry
end
par concurrent
 A->>B: First task
and second
 B-->>A: Second task
end
`;
const discussion = (page: Page) => page.getByRole("region", { name: "Contextual discussion", exact: true });
const header = (page: Page, name: string) => page.getByRole("button", { name, exact: true });
const threads = (project: TsProject) =>
  JSON.parse(readFileSync(join(project.root, ".archer/sequence.comments.json"), "utf8")).threads as {
    id: string;
    anchor: { kind: string; id: string };
    identity?: unknown;
  }[];
async function open(page: Page, source = SOURCE) {
  const project = await sharedTsProject({
    files: { ".archer/sequence.mmd": source },
    commentSubmission: "queued",
  });
  await project.present("sequence");
  await page.goto(project.url);
  await page.mouse.move(1100, 700);
  await expect(page.locator('.archer-seq-message[data-seq-id="msg-0"]')).toBeVisible();
  return project;
}
async function compose(page: Page, _label: string, block: Locator) {
  await block.click({ button: "right", position: { x: 30, y: 10 } });
  await expect(discussion(page).getByRole("textbox", { name: "Comment", exact: true })).toBeFocused();
  await expect(discussion(page).locator(".primary-floating-context")).toHaveText(
    (await block.getAttribute("aria-label"))!.replace(", has comments", ""),
  );
}
async function save(page: Page, body: string) {
  await discussion(page).getByRole("textbox", { name: "Comment", exact: true }).fill(body);
  await discussion(page).getByRole("button", { name: "Add comment", exact: true }).click();
  await expect(discussion(page).getByRole("article")).toBeFocused();
}

for (const [kind, label, id] of [
  ["alt", "ready", "frag-0"],
  ["opt", "cached", "frag-1"],
  ["loop", "retry", "frag-2"],
  ["par", "concurrent", "frag-3"],
]) {
  test(`${kind}: header comments on the whole block and pins it at the header`, async ({ page }) => {
    const project = await open(page);
    try {
      const block = page.locator(`.archer-seq-block-header[data-seq-id="${id}"]`);
      await expect(block).toHaveAccessibleName(`${kind} block: ${label}`);
      await compose(page, label!, block);
      await save(page, `Review ${kind}`);
      await expect.poll(() => threads(project)[0]?.anchor).toEqual({ kind: "group", id, label });
      expect(threads(project)[0]?.identity).toBeDefined();
      await discussion(page).getByRole("button", { name: "Close discussion", exact: true }).click();
      const pin = page.locator(`[data-pin-thread="${threads(project)[0]!.id}"]`).first();
      await expect(pin).toBeVisible();
      const h = await block.boundingBox(),
        p = await pin.boundingBox();
      expect(h).not.toBeNull();
      expect(p).not.toBeNull();
      expect(Math.abs(p!.y + p!.height / 2 - (h!.y + h!.height / 2))).toBeLessThan(24);
      await pin.click();
      await expect(discussion(page).getByRole("article")).toBeFocused();
      await discussion(page).getByRole("button", { name: "Close discussion", exact: true }).click();
      await expect(pin).toBeFocused();
      if (kind === "alt") {
        mkdirSync(resolve("../.shots"), { recursive: true });
        await page.screenshot({ path: resolve("../.shots/sequence-block-light.png") });
        await page.emulateMedia({ colorScheme: "dark" });
        await page.screenshot({ path: resolve("../.shots/sequence-block-dark.png") });
      }
    } finally {
      await project.stop();
    }
  });
}

test("focused C, context-menu key and Enter open the nested block without publishing fragment selection", async ({
  page,
}) => {
  const project = await open(page);
  try {
    const child = page.locator('.archer-seq-message[data-seq-id="msg-0"]');
    await page.getByRole("button", { name: "Select mode", exact: true }).click();
    await child.click();
    await expect.poll(() => project.selection()).toMatchObject({ edges: [{ id: "msg-0" }] });
    await header(page, "alt block: ready").focus();
    await page.keyboard.press("Tab");
    const block = header(page, "opt block: cached");
    await expect(block).toBeFocused();
    for (const key of ["c", "ContextMenu", "Shift+F10", "Enter"]) {
      await block.focus();
      await expect(block).toBeFocused();
      await page.keyboard.press(key);
      await expect(discussion(page).getByRole("textbox", { name: "Comment", exact: true })).toBeFocused();
      await expect(discussion(page).locator(".primary-floating-context")).toHaveText("opt block: cached");
      await page.keyboard.press("Escape");
      await expect(block).toBeFocused();
    }
    const selected = await project.selection();
    expect(selected?.nodes.some((n) => n.id.startsWith("frag-"))).toBe(false);
    expect(selected?.edges.some((n) => n.id.startsWith("frag-"))).toBe(false);
  } finally {
    await project.stop();
  }
});

test("the border is commentable after zoom; child messages keep click and comment priority", async ({ page }) => {
  const project = await open(page);
  try {
    await page.getByRole("button", { name: "Zoom in", exact: true }).click();
    const border = page.locator('.archer-seq-fragment-border-hit[data-seq-id="frag-0"]');
    await border.click({ button: "right", position: { x: 2, y: 45 } });
    await expect(discussion(page).locator(".primary-floating-context")).toHaveText("alt block: ready");
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Select mode", exact: true }).click();
    const child = page.locator('.archer-seq-message[data-seq-id="msg-1"]');
    await child.click();
    await expect.poll(() => project.selection()).toMatchObject({ edges: [{ id: "msg-1", label: "Cache hit" }] });
    await child.click({ button: "right" });
    await expect(discussion(page).locator(".primary-floating-context")).toHaveText("Edge: Cache hit");
  } finally {
    await project.stop();
  }
});

test("Project Review reopens a saved block discussion at its header after reload", async ({ page }) => {
  const project = await open(page);
  try {
    await compose(page, "ready", header(page, "alt block: ready"));
    await save(page, "Review the alternative as a whole");
    await page.reload();
    await expect(header(page, "alt block: ready, has comments")).toBeVisible();
    await page.getByRole("button", { name: /^Notifications/ }).click();
    const review = page.getByRole("region", { name: "Project Review", exact: true });
    await review.getByRole("button", { name: /Review the alternative as a whole/ }).click();
    await review.getByRole("button", { name: "Show on diagram", exact: true }).click();
    await expect(discussion(page).getByRole("article")).toBeFocused();
    await expect(discussion(page).locator(".primary-floating-context")).toHaveText("alt block: ready");
    await expect(discussion(page)).not.toContainText("Original location is unavailable");
  } finally {
    await project.stop();
  }
});

test("touch long press opens one whole-block composer", async ({ browser }) => {
  const context = await browser.newContext({ hasTouch: true, isMobile: true, viewport: { width: 768, height: 1024 } });
  const page = await context.newPage();
  const project = await open(page);
  try {
    const block = header(page, "alt block: ready");
    const r = await block.boundingBox();
    expect(r).not.toBeNull();
    const session = await context.newCDPSession(page);
    await session.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: r!.x + 25, y: r!.y + r!.height / 2 }],
    });
    await expect(discussion(page).getByRole("textbox", { name: "Comment", exact: true })).toBeFocused();
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect(discussion(page).locator(".primary-floating-context")).toHaveText("alt block: ready");
    await expect(page.getByRole("region", { name: "Contextual discussion", exact: true })).toHaveCount(1);
    await save(page, "Touch block review");
    expect(threads(project)).toHaveLength(1);
  } finally {
    await page.close();
    await context.close();
    await project.stop();
  }
});

test("authoring still picks blocks for editing and returns to block comments after Cancel", async ({ page }) => {
  const project = await open(page);
  try {
    await page.goto((await project.issueAuthoringAccess("Sequence block authoring regression")).url);
    const url = new URL(project.url);
    await page.goto(`${url.origin}${url.pathname}sequence.mmd?edit`);
    const editor = page.getByRole("region", { name: "Diagram Editor", exact: true });
    await expect(editor).toBeVisible();
    await editor.getByRole("button", { name: "Select mode", exact: true }).click();
    await editor
      .locator('[data-seq-part="fragment"][data-seq-part-id="frag-0"] .archer-seq-fragment-chip-text')
      .click();
    const picked = page.getByRole("region", { name: "Selected block", exact: true });
    await expect(picked).toContainText("alt block");
    await expect(picked.getByRole("button", { name: "Remove block, keep messages", exact: true })).toBeVisible();
    await page.getByRole("banner").getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(editor).toHaveCount(0);
    await compose(page, "ready", header(page, "alt block: ready"));
  } finally {
    await project.stop();
  }
});

test("a source update while typing keeps the words and requires reopening the intended block", async ({ page }) => {
  const project = await open(page);
  try {
    await compose(page, "ready", header(page, "alt block: ready"));
    await discussion(page).getByRole("textbox", { name: "Comment", exact: true }).fill("Keep this scope");
    await project.agentWrite(
      "sequence",
      ".archer/sequence.mmd",
      SOURCE.replace("alt ready", "loop earlier\n A->>B: Before\nend\nalt ready"),
    );
    await expect(page.locator('.archer-seq-block-header[data-seq-id="frag-1"]')).toHaveAccessibleName(
      "alt block: ready",
    );
    await expect(discussion(page).getByRole("button", { name: "Add comment", exact: true })).toBeDisabled();
    await expect(discussion(page)).toContainText("The diagram changed");
    await expect(discussion(page).getByRole("textbox", { name: "Comment", exact: true })).toHaveValue(
      "Keep this scope",
    );
    await discussion(page).getByRole("button", { name: "Cancel", exact: true }).click();
    await compose(page, "ready", header(page, "alt block: ready"));
    await save(page, "Review moved scope");
    await expect.poll(() => threads(project)[0]?.anchor.id).toBe("frag-1");
  } finally {
    await project.stop();
  }
});

test("Discussion avoids docked Key and chrome through save, panel resize, viewport resize and zoom", async ({
  page,
}) => {
  const coffee = readFileSync(resolve("../examples/rfc-2324-htcpcp/.archer/diagrams/coffee-conversations.mmd"), "utf8");
  const project = await open(page, coffee);
  try {
    const key = page.getByRole("region", { name: "Diagram Key", exact: true });
    await expect(key).toBeVisible();
    const block = header(page, "opt block: additions unavailable");
    await block.click({ button: "right", position: { x: 30, y: 10 } });
    const clear = async () => {
      await expect
        .poll(() =>
          page.evaluate(() => {
            const card = document.querySelector(".primary-floating-discussion")!.getBoundingClientRect();
            const canvas = document.querySelector(".archer-seq-canvas")!.getBoundingClientRect();
            const obstacles = document.querySelectorAll(
              ".archer-diagram-panel, .archer-diagram-key, .archer-canvas-controls, .archer-canvas-tools",
            );
            return (
              card.left >= canvas.left &&
              card.top >= canvas.top &&
              card.right <= canvas.right &&
              card.bottom <= canvas.bottom &&
              [...obstacles].every((element) => {
                const r = element.getBoundingClientRect();
                return (
                  !r.width ||
                  !r.height ||
                  card.right <= r.left ||
                  card.left >= r.right ||
                  card.bottom <= r.top ||
                  card.top >= r.bottom
                );
              })
            );
          }),
        )
        .toBe(true);
    };
    await clear();
    const beforeTyping = (await discussion(page).boundingBox())!.height;
    await discussion(page)
      .getByRole("textbox", { name: "Comment", exact: true })
      .fill("A whole-block question.\n".repeat(12));
    await expect.poll(async () => (await discussion(page).boundingBox())!.height).toBeGreaterThan(beforeTyping);
    await clear();
    const divider = page.getByRole("separator", { name: "Resize diagram panel" });
    await divider.press("ArrowLeft");
    await clear();
    await save(page, "Check this entire alternative and keep the Key readable");
    await clear();
    await page.setViewportSize({ width: 1100, height: 800 });
    await clear();
    const canvas = page.locator(".archer-seq-canvas");
    const viewport = page.locator(".archer-seq-viewport");
    const transform = await viewport.getAttribute("transform");
    const c = (await canvas.boundingBox())!;
    await page.mouse.move(c.x + c.width / 2, c.y + c.height - 40);
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, -100);
    await page.keyboard.up("Control");
    await expect(viewport).not.toHaveAttribute("transform", transform!);
    await clear();
    await page.getByRole("button", { name: "Collapse diagram panel", exact: true }).click();
    await page
      .locator(`[data-pin-thread="${threads(project)[0]!.id}"]`)
      .first()
      .click();
    await clear();
    await page.getByRole("button", { name: "Expand to the diagram key", exact: true }).click();
    await page
      .locator(`[data-pin-thread="${threads(project)[0]!.id}"]`)
      .first()
      .click();
    await clear();
    mkdirSync(resolve("../.shots"), { recursive: true });
    await page.screenshot({ path: resolve("../.shots/fixB-discussion-key.png") });
    // A person may move a discussion over chrome. The shell must then protect the covered control.
    const zoom = page.getByRole("button", { name: "Zoom in", exact: true });
    const z = (await zoom.boundingBox())!;
    const handle = discussion(page).getByRole("button", { name: "Move discussion", exact: true });
    const h = (await handle.boundingBox())!;
    await page.mouse.move(h.x + 15, h.y + h.height / 2);
    await page.mouse.down();
    await page.mouse.move(z.x + z.width / 2, z.y + z.height / 2, { steps: 8 });
    await page.mouse.up();
    await expect(zoom).toHaveAttribute("inert", "");
    await zoom.evaluate((element) => (element as HTMLElement).focus());
    await expect(zoom).not.toBeFocused();
  } finally {
    await project.stop();
  }
});

test("picker, discussion and Project Review use the same whole-block label", async ({ page }) => {
  const project = await open(page);
  try {
    await header(page, "opt block: cached").click({ button: "right", position: { x: 25, y: 10 } });
    await expect(discussion(page).getByRole("combobox", { name: "Comment on", exact: true })).toContainText(
      "opt block: cached",
    );
    await expect(discussion(page).locator(".primary-floating-context")).toHaveText("opt block: cached");
    await save(page, "Whole optional cached branch");
    await expect(discussion(page).locator(".primary-floating-context")).toHaveText("opt block: cached");
    await discussion(page).getByRole("button", { name: "Close discussion", exact: true }).click();
    await page.getByRole("button", { name: /^Notifications/ }).click();
    const review = page.getByRole("region", { name: "Project Review", exact: true });
    await expect(review.getByRole("button", { name: /Whole optional cached branch/ })).toContainText(
      "opt block: cached",
    );
  } finally {
    await project.stop();
  }
});

test("a detached discussion keeps its screen position through typing and camera movement, then reattaches", async ({
  page,
}) => {
  const project = await open(page);
  try {
    await compose(page, "ready", header(page, "alt block: ready"));
    await discussion(page).getByRole("button", { name: "Move discussion", exact: true }).press("ArrowRight");
    await expect(discussion(page)).toHaveAttribute("data-detached", "true");
    const position = await discussion(page).evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, top: rect.top };
    });
    await discussion(page).getByRole("textbox", { name: "Comment", exact: true }).fill("Keep this conversation here");
    const viewport = page.locator(".archer-seq-viewport");
    const before = await viewport.getAttribute("transform");
    const clearPoint = await page.locator(".archer-seq-canvas").evaluate((canvas) => {
      const rect = canvas.getBoundingClientRect();
      for (const fx of [0.1, 0.5, 0.9]) {
        for (const fy of [0.2, 0.5, 0.8]) {
          const x = rect.x + rect.width * fx;
          const y = rect.y + rect.height * fy;
          const hit = document.elementFromPoint(x, y);
          if (hit && canvas.contains(hit) && !hit.closest("button, .archer-canvas-controls, .archer-canvas-tools"))
            return { x, y };
        }
      }
      throw new Error("No clear canvas point for the pan gesture");
    });
    await page.mouse.move(clearPoint.x, clearPoint.y);
    await page.mouse.wheel(80, 0);
    await expect(viewport).not.toHaveAttribute("transform", before!);
    await expect(discussion(page)).toHaveAttribute("data-detached", "true");
    await expect
      .poll(() =>
        discussion(page).evaluate((element) => {
          const rect = element.getBoundingClientRect();
          return { left: rect.left, top: rect.top };
        }),
      )
      .toEqual(position);
    mkdirSync(resolve("../.shots"), { recursive: true });
    await page.screenshot({ path: resolve("../.shots/s3-discussion-detached.png") });
    await discussion(page).getByRole("button", { name: "Reattach", exact: true }).click();
    await expect(discussion(page)).toHaveAttribute("data-detached", "false");
    await expect(discussion(page).getByRole("textbox", { name: "Comment", exact: true })).toHaveValue(
      "Keep this conversation here",
    );
    await expect
      .poll(() =>
        discussion(page).evaluate((element) => {
          const rect = element.getBoundingClientRect();
          return { left: rect.left, top: rect.top };
        }),
      )
      .not.toEqual(position);
  } finally {
    await project.stop();
  }
});
