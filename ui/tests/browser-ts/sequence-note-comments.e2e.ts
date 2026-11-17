import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { TsProject } from "../support/ts-service";
import { sharedTsProject } from "./support/shared-service";

const BODY = "Body MAY be short and stout";
const ADDITIONS = "Available additions SHOULD accompany 406";
const SOURCE = `sequenceDiagram
participant A as Client
participant B as Service
Note over A,B: ${BODY}
A->>B: Request additions
opt additions unavailable
 B-->>A: 406 Not Acceptable
 Note over B: ${ADDITIONS}
end
`;
const discussion = (page: Page) => page.getByRole("region", { name: "Contextual discussion", exact: true });
const note = (page: Page, text: string) =>
  page.getByRole("button", { name: new RegExp(`^Note over .+: ${text}(, has comments)?$`) });
type SavedThread = {
  id: string;
  anchor: { kind: string; id: string; label: string };
  identity?: { version: number; fingerprint: string; unique: boolean };
  orphaned?: boolean;
};
const storedThreads = (project: TsProject) =>
  JSON.parse(readFileSync(join(project.root, ".archer/sequence.comments.json"), "utf8")).threads as SavedThread[];

async function open(page: Page) {
  const project = await sharedTsProject({
    files: { ".archer/sequence.mmd": SOURCE },
    commentSubmission: "queued",
  });
  await project.present("sequence");
  await page.goto(project.url);
  await page.mouse.move(1100, 700);
  await expect(note(page, BODY)).toBeVisible();
  return project;
}
async function save(page: Page, body: string) {
  await discussion(page).getByRole("textbox", { name: "Comment", exact: true }).fill(body);
  await discussion(page).getByRole("button", { name: "Add comment", exact: true }).click();
  await expect(discussion(page).getByRole("article")).toBeFocused();
}
async function rightClick(page: Page, target: Locator) {
  await target.click({ button: "right" });
  await expect(discussion(page).getByRole("textbox", { name: "Comment", exact: true })).toBeFocused();
}

for (const [text, id, participants] of [
  [BODY, "note-0", "Client and Service"],
  [ADDITIONS, "note-1", "Service"],
]) {
  test(`${id}: right-click saves a comment with a pin on the note`, async ({ page }) => {
    const project = await open(page);
    try {
      const target = note(page, text!);
      await expect(target).toHaveAttribute("data-seq-channel", "notes");
      await expect(target).toHaveAttribute("tabindex", "0");
      await expect(target).not.toHaveAttribute("aria-pressed");
      await rightClick(page, target);
      await expect(discussion(page).locator(".primary-floating-context")).toHaveText(
        `Note over ${participants}: ${text}`,
      );
      await save(page, `Review ${text}`);
      await expect.poll(() => storedThreads(project)[0]?.anchor).toEqual({ kind: "node", id, label: text });
      expect(storedThreads(project)[0]?.identity).toMatchObject({ version: 1, unique: true });
      await discussion(page).getByRole("button", { name: "Close discussion", exact: true }).click();
      const pin = page.locator(`[data-pin-thread="${storedThreads(project)[0]!.id}"]`).first();
      await expect(pin).toBeFocused();
      const sheet = await target.boundingBox();
      const p = await pin.boundingBox();
      expect(sheet).not.toBeNull();
      expect(p).not.toBeNull();
      // The pin belongs to this sheet, rather than to a lifeline or its enclosing opt header.
      expect(p!.x + p!.width / 2).toBeGreaterThanOrEqual(sheet!.x);
      expect(p!.x + p!.width / 2).toBeLessThanOrEqual(sheet!.x + sheet!.width + 24);
      expect(p!.y + p!.height / 2).toBeGreaterThanOrEqual(sheet!.y - 24);
      expect(p!.y + p!.height / 2).toBeLessThanOrEqual(sheet!.y + sheet!.height);
      await pin.click();
      await expect(discussion(page).getByRole("article")).toBeFocused();
      await expect(discussion(page)).toContainText(`Review ${text}`);
      if (id === "note-1") {
        mkdirSync(resolve("../.shots"), { recursive: true });
        await page.screenshot({ path: resolve("../.shots/sequence-note-comment-light.png") });
        await page.emulateMedia({ colorScheme: "dark" });
        await page.screenshot({ path: resolve("../.shots/sequence-note-comment-dark.png") });
      }
    } finally {
      await project.stop();
    }
  });
}

test("C, Enter, Space and context-menu keys comment on the focused note without publishing it", async ({ page }) => {
  const project = await open(page);
  try {
    await page.getByRole("button", { name: "Select mode", exact: true }).click();
    await page.locator('.archer-seq-message[data-seq-id="msg-0"]').click();
    await expect.poll(() => project.selection()).toMatchObject({ edges: [{ id: "msg-0" }] });
    const before = await project.selection();
    const target = note(page, ADDITIONS);
    await note(page, BODY).focus();
    await page.keyboard.press("Tab");
    await expect(target).toBeFocused();
    await expect(
      project.setEmphasis("sequence", [
        {
          id: "notes-are-comments-only",
          groups: [{ id: "g", label: "Notes", style: "highlight", nodes: ["note-1"], edges: [] }],
        },
      ]),
    ).rejects.toThrow(/note.*cannot be emphasised/);
    await expect(target).not.toHaveClass(/archer-emph-/);
    for (const key of ["c", "Enter", " ", "ContextMenu", "Shift+F10"]) {
      await target.focus();
      await expect(target).toBeFocused();
      await page.keyboard.press(key);
      await expect(discussion(page).getByRole("textbox", { name: "Comment", exact: true })).toBeFocused();
      await expect(discussion(page).locator(".primary-floating-context")).toHaveText(`Note over Service: ${ADDITIONS}`);
      expect(await project.selection()).toEqual(before);
      await page.keyboard.press("Escape");
      await expect(target).toBeFocused();
    }
    expect((await project.selection())?.nodes.some((n) => n.id.startsWith("note-"))).toBe(false);
    expect((await project.selection())?.edges.some((n) => n.id.startsWith("note-"))).toBe(false);
  } finally {
    await project.stop();
  }
});

test("touch long press opens exactly one note composer and saves one note thread", async ({ browser }) => {
  const context = await browser.newContext({ hasTouch: true, isMobile: true, viewport: { width: 768, height: 1024 } });
  const page = await context.newPage();
  const project = await open(page);
  try {
    const target = note(page, BODY);
    const r = await target.boundingBox();
    expect(r).not.toBeNull();
    const session = await context.newCDPSession(page);
    await session.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: r!.x + r!.width / 2, y: r!.y + r!.height / 2 }],
    });
    await expect(discussion(page).getByRole("textbox", { name: "Comment", exact: true })).toBeFocused();
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect(discussion(page)).toHaveCount(1);
    await expect(discussion(page).getByRole("textbox", { name: "Comment", exact: true })).toHaveCount(1);
    await save(page, "Touch note review");
    expect(storedThreads(project)).toHaveLength(1);
    expect(storedThreads(project)[0]?.anchor).toEqual({ kind: "node", id: "note-0", label: BODY });
  } finally {
    await page.close();
    await context.close();
    await project.stop();
  }
});

test("Project Review reveals an offscreen note after reload without selecting it", async ({ page }) => {
  const project = await open(page);
  try {
    await rightClick(page, note(page, ADDITIONS));
    await save(page, "Review the unavailable additions annotation");
    await page.reload();
    const target = note(page, ADDITIONS);
    await note(page, BODY).focus();
    await page.keyboard.press("Tab");
    await expect(target).toBeFocused();
    await expect(target).toBeVisible();
    const canvas = page.locator(".archer-seq-canvas");
    const viewport = page.locator(".archer-seq-viewport");
    const before = await viewport.getAttribute("transform");
    await canvas.hover();
    await page.mouse.wheel(0, 1000);
    await expect(viewport).not.toHaveAttribute("transform", before!);
    const away = await viewport.getAttribute("transform");
    await page.getByRole("button", { name: /^Notifications/ }).click();
    const review = page.getByRole("region", { name: "Project Review", exact: true });
    await review.getByRole("button", { name: /Review the unavailable additions annotation/ }).click();
    await review.getByRole("button", { name: "Show on diagram", exact: true }).click();
    await expect(discussion(page).getByRole("article")).toBeFocused();
    await expect(viewport).not.toHaveAttribute("transform", away!);
    await expect(discussion(page).locator(".primary-floating-context")).toHaveText(`Note over Service: ${ADDITIONS}`);
    expect((await project.selection())?.nodes.some((n) => n.id.startsWith("note-")) ?? false).toBe(false);
    expect((await project.selection())?.edges.some((n) => n.id.startsWith("note-")) ?? false).toBe(false);
  } finally {
    await project.stop();
  }
});

test("saved note identity survives insertion and reordering, then orphans when removed", async ({ page }) => {
  const project = await open(page);
  try {
    await rightClick(page, note(page, BODY));
    await save(page, "Keep this comment on the body annotation");
    const threadId = storedThreads(project)[0]!.id;
    await discussion(page).getByRole("button", { name: "Close discussion", exact: true }).click();
    const inserted = SOURCE.replace(`Note over A,B: ${BODY}`, `Note over A: New annotation\nNote over A,B: ${BODY}`);
    await project.agentWrite("sequence", ".archer/sequence.mmd", inserted);
    await expect(note(page, BODY)).toHaveAttribute("data-seq-id", "note-1");
    const current = async () => {
      const response = await project.fetch("api/comments?target=view%3Asequence");
      expect(response.status).toBe(200);
      return ((await response.json()) as { threads: SavedThread[] }).threads.find((thread) => thread.id === threadId);
    };
    await expect.poll(async () => (await current())?.anchor.id).toBe("note-1");
    expect((await current())?.orphaned).not.toBe(true);
    const reordered = inserted.replace(
      `Note over A: New annotation\nNote over A,B: ${BODY}`,
      `Note over A,B: ${BODY}\nNote over A: New annotation`,
    );
    await project.agentWrite("sequence", ".archer/sequence.mmd", reordered);
    await expect(note(page, BODY)).toHaveAttribute("data-seq-id", "note-0");
    await expect.poll(async () => (await current())?.anchor.id).toBe("note-0");
    expect((await current())?.orphaned).not.toBe(true);
    await page.locator(`[data-pin-thread="${threadId}"]`).first().click();
    await expect(discussion(page)).toContainText("Keep this comment on the body annotation");
    await discussion(page).getByRole("button", { name: "Close discussion", exact: true }).click();
    await project.agentWrite("sequence", ".archer/sequence.mmd", reordered.replace(`Note over A,B: ${BODY}\n`, ""));
    await expect(note(page, BODY)).toHaveCount(0);
    await expect.poll(async () => (await current())?.orphaned).toBe(true);
    await expect(page.locator(`[data-pin-thread="${threadId}"]`)).toHaveCount(0);
    await page.getByRole("button", { name: /^Notifications/ }).click();
    const review = page.getByRole("region", { name: "Project Review", exact: true });
    await review.getByRole("button", { name: /Keep this comment on the body annotation/ }).click();
    await expect(review.getByRole("article")).toHaveAttribute("data-orphaned", "true");
    const before = await page.locator(".archer-seq-viewport").getAttribute("transform");
    await review.getByRole("button", { name: "Show on diagram", exact: true }).click();
    await expect(discussion(page)).toContainText("Original location is unavailable");
    await expect(page.locator(".archer-seq-viewport")).toHaveAttribute("transform", before!);
  } finally {
    await project.stop();
  }
});

test("a source update during a note draft keeps the words and requires reopening the intended note", async ({
  page,
}) => {
  const project = await open(page);
  try {
    await rightClick(page, note(page, BODY));
    await discussion(page).getByRole("textbox", { name: "Comment", exact: true }).fill("Keep this note question");
    await project.agentWrite(
      "sequence",
      ".archer/sequence.mmd",
      SOURCE.replace(`Note over A,B: ${BODY}`, `Note over A: Earlier annotation\nNote over A,B: ${BODY}`),
    );
    await expect(note(page, BODY)).toHaveAttribute("data-seq-id", "note-1");
    await expect(discussion(page).getByRole("button", { name: "Add comment", exact: true })).toBeDisabled();
    await expect(discussion(page)).toContainText("The diagram changed");
    await expect(discussion(page).getByRole("textbox", { name: "Comment", exact: true })).toHaveValue(
      "Keep this note question",
    );
    await discussion(page).getByRole("button", { name: "Cancel", exact: true }).click();
    await rightClick(page, note(page, BODY));
    await save(page, "Review the original body note");
    await expect.poll(() => storedThreads(project)[0]?.anchor.id).toBe("note-1");
  } finally {
    await project.stop();
  }
});

// cheat-sheet.e2e.ts holds a graph's Commenting rows, which name no sequence block or note.
test("the ? sheet over a sequence names its block and note comments", async ({ page }) => {
  const project = await open(page);
  try {
    await page.keyboard.press("?");
    const sheet = page.getByRole("dialog", { name: "Keyboard & Pointer" });
    const commenting = sheet.getByRole("heading", { name: "Commenting", exact: true }).locator("..");
    await expect(commenting.locator("dt").filter({ hasText: "Sequence block / note" })).toHaveCount(1);
    await expect(commenting).toContainText("including sequence blocks and notes");
  } finally {
    await project.stop();
  }
});
