import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { sharedTsProject } from "./support/shared-service";

const AUTH = [
  "# Auth design",
  "",
  "Prose about zeppelins only.",
  "",
  "## Login",
  "",
  "```mermaid",
  "%% archer-id: login-form",
  "flowchart LR",
  '  user["User"] e1@--> form["Form"]',
  "```",
  "",
  "Between the blocks.",
  "",
  "```mermaid",
  "%% archer-id: login-token",
  "flowchart LR",
  '  form["Form"] e1@--> token["Token"]',
  "```",
  "",
].join("\n");
const REFRESH = [
  "# Refresh",
  "",
  "## Rotation",
  "",
  "```mermaid",
  "flowchart LR",
  '  old["Old token"] e1@--> new["New token"]',
  "```",
  "",
].join("\n");
const FILES: Record<string, string> = {
  "archer.toml": 'version = 1\n[discovery]\nroots = [".archer"]\nexclude = ["**/secret.md"]\n',
  ".archer/diagrams/overview.mmd": "flowchart LR\nweb[Web] e1@--> api[API]\n",
  ".archer/notes/auth.md": AUTH,
  ".archer/notes/refresh.md": REFRESH,
  "README.md": "# Demo\n\nA demo project.\n",
};

async function openProject(page: Page, url: string, tab = "diagrams"): Promise<string> {
  await page.goto(url);
  const root = new URL(page.url()).pathname;
  await page.goto(new URL(`${root}?tab=${tab}`, page.url()).href);
  return root;
}
const cardOf = (page: Page, name: string | RegExp) => page.getByRole("article", { name });

test("embedded diagrams are cards in the gallery: titles told apart, the address beneath, their note linked, counted with the others", async ({
  page,
}) => {
  const project = await sharedTsProject({ files: FILES });
  try {
    const root = await openProject(page, project.url);
    const grid = page.getByRole("list", { name: "Diagrams" });
    await expect(grid.getByRole("article")).toHaveCount(4);
    // 7. Two blocks under one heading read apart; a block alone under its heading keeps the heading.
    await expect(cardOf(page, "Login, login-form")).toBeVisible();
    await expect(cardOf(page, "Login, login-token")).toBeVisible();
    await expect(cardOf(page, "Rotation")).toBeVisible();
    await expect(cardOf(page, "Login, login-form").locator(".archer-diagram-card-address")).toHaveText(
      "notes/auth.md#login-form",
    );
    // 4. One combined count: the tab, the All chip and the project's facts agree; In notes is the embedded subset.
    await expect(page.getByRole("tab", { name: /^Diagrams/ })).toContainText("4");
    await expect(page.getByRole("button", { name: "All, 4 diagrams" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByLabel("Project facts")).toContainText("4 diagrams");
    await page.getByRole("button", { name: "In notes, 3 diagrams" }).click();
    await expect(grid.getByRole("article")).toHaveCount(3);
    await expect(cardOf(page, "Overview")).toHaveCount(0);
    expect((await new AxeBuilder({ page }).analyze()).violations.map((violation) => violation.id)).toEqual([]);
    // 3. "in <note>" opens the note.
    await cardOf(page, "Login, login-form").getByRole("link", { name: "in Auth design" }).click();
    await expect(page).toHaveURL(new RegExp(`${root}notes/auth\\.md$`));
    await expect(page.getByRole("article", { name: "Reading Auth design" })).toBeVisible();
  } finally {
    await project.stop();
  }
});

test("In notes is kept in the address like the other filters: a reload, a shared link and Back keep it", async ({
  page,
}) => {
  const project = await sharedTsProject({ files: FILES });
  try {
    await openProject(page, project.url);
    const grid = page.getByRole("list", { name: "Diagrams" });
    const inNotes = page.getByRole("button", { name: "In notes, 3 diagrams" });
    await inNotes.click();
    await expect.poll(() => new URL(page.url()).searchParams.get("in")).toBe("notes");
    await page.reload();
    await expect(inNotes).toHaveAttribute("aria-pressed", "true");
    await expect(grid.getByRole("article")).toHaveCount(3);
    // A fresh page from the link opens the same gallery.
    const link = page.url();
    const other = await page.context().newPage();
    try {
      await other.goto(link);
      await expect(other.getByRole("button", { name: "In notes, 3 diagrams" })).toHaveAttribute("aria-pressed", "true");
      await expect(other.getByRole("list", { name: "Diagrams" }).getByRole("article")).toHaveCount(3);
    } finally {
      await other.close();
    }
    // A type chip and All take it out of the address; Back puts it back.
    await page.getByRole("button", { name: "All, 4 diagrams" }).click();
    await expect.poll(() => new URL(page.url()).searchParams.has("in")).toBe(false);
    await expect(grid.getByRole("article")).toHaveCount(4);
    await page.goBack();
    await expect(inNotes).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: /^Flowchart, / }).click();
    await expect.poll(() => new URL(page.url()).searchParams.has("in")).toBe(false);
    await expect(page.getByRole("button", { name: /^Flowchart, / })).toHaveAttribute("aria-pressed", "true");
  } finally {
    await project.stop();
  }
});

test("a card opens the diagram at its canonical address, and a shared link reloads to it", async ({ page }) => {
  const project = await sharedTsProject({ files: FILES });
  try {
    const root = await openProject(page, project.url);
    await cardOf(page, "Rotation").getByRole("button", { name: "Rotation" }).click();
    await expect(page).toHaveURL(new RegExp(`${root}notes/refresh\\.md#rotation$`));
    await expect(page.locator('.react-flow__node[data-id="old"]')).toBeVisible();
    await page.reload();
    await expect(page.locator('.react-flow__node[data-id="old"]')).toBeVisible();
    await page.goBack();
    await expect(cardOf(page, "Rotation")).toBeVisible();
  } finally {
    await project.stop();
  }
});

test("each embedded card shows its thumbnail, asked for at the address's own thumbnail route", async ({ page }) => {
  const project = await sharedTsProject({ files: FILES });
  try {
    const asked: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/api/thumbnails/"))
        asked.push(decodeURIComponent(new URL(request.url()).pathname.split("/api/thumbnails/")[1]!));
    });
    await openProject(page, project.url);
    for (const name of ["Login, login-form", "Login, login-token", "Rotation"]) {
      const image = cardOf(page, name).locator("img");
      await expect(image).toBeVisible();
      await expect
        .poll(() => image.evaluate((node: HTMLImageElement) => node.complete && node.naturalWidth > 0), name)
        .toBe(true);
    }
    expect(asked).toEqual(
      expect.arrayContaining(["notes/auth.md#login-form", "notes/auth.md#login-token", "notes/refresh.md#rotation"]),
    );
    // Each address once: the prefetch and the card share one request.
    expect(new Set(asked).size).toBe(asked.length);
  } finally {
    await project.stop();
  }
});

test("the Folders tree lists the blocks beside their note, and a note's folder page counts them", async ({ page }) => {
  const project = await sharedTsProject({ files: FILES });
  try {
    const root = await openProject(page, project.url, "folders");
    const tree = page.getByRole("treegrid", { name: "Project files" });
    await expect
      .poll(() => tree.locator(".archer-folder-tree-file-name").allTextContents())
      .toEqual(
        expect.arrayContaining([
          "auth.md",
          "auth.md#login-form",
          "auth.md#login-token",
          "refresh.md",
          "refresh.md#rotation",
          "overview.mmd",
        ]),
      );
    await tree.getByRole("link", { name: "notes/" }).click();
    await expect(page).toHaveURL(new RegExp(`${root}notes/$`));
    const notes = page.getByRole("treegrid", { name: "Project files" });
    await expect(notes.locator("[data-kind='diagram']")).toHaveCount(3);
    await expect(notes.locator("[data-kind='note']")).toHaveCount(2);
    await notes.getByRole("button", { name: "Rotation" }).click();
    await expect(page).toHaveURL(new RegExp(`${root}notes/refresh\\.md#rotation$`));
  } finally {
    await project.stop();
  }
});

test("a search for a word in one block finds that block, by its row and its address", async ({ page }) => {
  const project = await sharedTsProject({ files: FILES });
  try {
    await openProject(page, project.url);
    await page.getByRole("searchbox", { name: "Search projects and files" }).fill("token");
    await expect(cardOf(page, "Login, login-token")).toBeVisible();
    // The address is a name for it too.
    await page.getByRole("searchbox", { name: "Search projects and files" }).fill("refresh.md#rotation");
    await expect(cardOf(page, "Rotation")).toBeVisible();
    await expect(cardOf(page, "Login, login-form")).toHaveCount(0);
  } finally {
    await project.stop();
  }
});

test("a word only in a sibling block or in the note's prose finds neither block", async ({ page }) => {
  const project = await sharedTsProject({ files: FILES });
  try {
    await openProject(page, project.url);
    const box = page.getByRole("searchbox", { name: "Search projects and files" });
    await box.fill("zeppelins");
    await expect(page.getByRole("list", { name: "Diagrams" }).getByRole("article")).toHaveCount(0);
    await box.fill("user");
    await expect(cardOf(page, "Login, login-form")).toBeVisible();
    await expect(cardOf(page, "Login, login-token")).toHaveCount(0);
  } finally {
    await project.stop();
  }
});
