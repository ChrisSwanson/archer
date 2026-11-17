import { expect, test, type Locator } from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { testPage } from "./support/page-path";

const TS_SRC = resolve(import.meta.dirname, "../../../ts/src");
const PAGE = testPage();
const load = async (path: string) => import(/* @vite-ignore */ pathToFileURL(join(TS_SRC, path)).href);

async function twoProjects() {
  const { startService } = (await load("service/service.ts")) as {
    startService(options: unknown): Promise<{ close(): Promise<void>; socketPath: string }>;
  };
  const { connectService } = (await load("service/client.ts")) as {
    connectService(path: string): Promise<{ call(method: string, params: unknown): Promise<unknown>; close(): void }>;
  };
  const directory = mkdtempSync(join(tmpdir(), "archer-column-order-"));
  const stateDir = join(directory, "state"),
    socketPath = join(stateDir, "archer.sock");
  const roots = ["Northwind", "Contoso"].map((name) => join(directory, name));
  for (const [index, root] of roots.entries()) {
    const files: Record<string, string> = {
      "archer.toml": `version = 1\nname = "${index === 0 ? "Northwind" : "Contoso"}"\n`,
      ".archer/flow.mmd": `flowchart LR\n a[${index === 0 ? "Orders" : "Billing"}] link@--> b[Service]\n`,
      ".archer/notes/guide.md": `# ${index === 0 ? "Order" : "Billing"} guide\n`,
    };
    for (const [path, contents] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), contents);
    }
  }
  const service = await startService({
    stateDir,
    forceHttp: true,
    socketPath,
    pagePath: PAGE,
    log: () => {},
    env: { ...process.env, HOME: directory, ARCHER_OPEN_BROWSER: "never" },
  });
  const client = await connectService(service.socketPath);
  const urls: string[] = [];
  for (const root of roots) urls.push(((await client.call("attach", { root })) as { url: string }).url);
  return {
    url: urls[0]!,
    async stop() {
      client.close();
      await service.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

const headings = async (tree: Locator): Promise<string[]> =>
  tree.evaluate((node) =>
    [...node.querySelectorAll<HTMLElement>(".archer-folder-tree-head [data-column]")].map(
      (heading) => heading.dataset.column ?? "",
    ),
  );
/** Every row's cells follow the header's order. */
const cellOrders = async (tree: Locator): Promise<string[]> =>
  tree.evaluate((node) => [
    ...new Set(
      [...node.querySelectorAll<HTMLElement>("[data-browser-row]")].map((row) =>
        [...row.querySelectorAll<HTMLElement>("[data-column]")].map((cell) => cell.dataset.column).join(","),
      ),
    ),
  ]);

test("Folders tree columns move by their header handles, the name staying first, and the order survives reload", async ({
  page,
}, testInfo) => {
  const project = await twoProjects();
  try {
    await page.goto(project.url); // Nothing presented: the follow page is the all-projects overview.
    const tree = page.getByRole("treegrid", { name: "Project files" });
    await expect(tree.locator("[data-project-root]")).toHaveCount(2);
    await expect.poll(() => headings(tree)).toEqual(["name", "title", "kind", "threads", "edited", "created"]);
    await expect(tree.getByRole("button", { name: "Move Name column" })).toHaveCount(0);

    await tree
      .getByRole("button", { name: "Move Created column", exact: true })
      .dragTo(tree.getByRole("columnheader", { name: "Kind", exact: true }));
    await expect.poll(() => headings(tree)).toEqual(["name", "title", "created", "kind", "threads", "edited"]);
    await expect.poll(() => cellOrders(tree)).toEqual(["name,title,created,kind,threads,edited"]);
    await expect(tree.locator("[data-column-dragging], [style*='translateX']")).toHaveCount(0);

    const kind = tree.getByRole("button", { name: "Move Kind column", exact: true });
    await kind.focus();
    await page.keyboard.press("ArrowRight");
    await expect.poll(() => headings(tree)).toEqual(["name", "title", "created", "threads", "kind", "edited"]);
    await page.screenshot({ path: testInfo.outputPath("tree-columns-desktop.png"), fullPage: true });

    await page.reload();
    await expect
      .poll(() => headings(page.getByRole("treegrid", { name: "Project files" })))
      .toEqual(["name", "title", "created", "threads", "kind", "edited"]);
  } finally {
    await project.stop();
  }
});
