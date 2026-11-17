// A C4 relationship's technology and description are drawn inline under its caption, not behind an ⓘ
// (decided 2026-10-31: "that carries important information … I should see more readily"). Checked on the
// Pageturner containers and on a fixture with descriptions, at 1500 and 1000 wide, light and dark: the detail
// is visible, there is no ⓘ control, and no caption covers a node or another caption (ADR 0030's title).
// Screenshots go to `ARCHER_SHOTS` when it is set.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import type { TsProject } from "../support/ts-service";
import { sharedTsProject } from "./support/shared-service";
import { settled } from "./support/settled";

const CORPUS = resolve(import.meta.dirname, "../../../tools/devkit/corpus");
const SHOTS = process.env.ARCHER_SHOTS;

function corpus(name: string): Record<string, string> {
  const root = join(CORPUS, name);
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else out[relative(root, path)] = readFileSync(path, "utf8");
    }
  };
  walk(root);
  return out;
}
const commit = async (root: string): Promise<void> => {
  const git = (...args: string[]): void => {
    execFileSync(
      "git",
      ["-c", "user.name=archer-test", "-c", "user.email=test@archer.invalid", "-c", "init.defaultBranch=main", ...args],
      {
        cwd: root,
        stdio: "ignore",
        env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
      },
    );
  };
  git("init");
  git("add", "-A");
  git("commit", "-m", "corpus");
};

const DESCRIBED = `C4Container
    title Described relationships
    Person(customer, "Customer", "Buys books online")
    Container(web, "Storefront", "TypeScript, React", "Catalogue and checkout")
    Container(api, "Shop API", "Node.js", "Orders, stock and payments")
    ContainerDb(db, "Shop database", "PostgreSQL", "Books and orders")
    System_Ext(payments, "Payment provider", "Hosted card payments")
    Rel(customer, web, "Browses and buys from", "HTTPS", "Every page of the shop, from search to the receipt")
    Rel(web, api, "Calls", "JSON over HTTPS")
    Rel(api, db, "", "SQL")
    Rel(api, payments, "", "", "Opens a hosted payment session for each checkout and waits for its webhook")
`;

let project: TsProject | undefined;
test.afterEach(async () => {
  await project?.stop();
  project = undefined;
});

/** Every caption plate and every node, as screen rectangles, and which pairs overlap. */
async function overlaps(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const rect = (el: Element) => el.getBoundingClientRect();
    const plates = [...document.querySelectorAll<HTMLElement>(".archer-edge-label")].map((el) => ({
      name: `caption ${el.dataset.edgeId}`,
      box: rect(el),
    }));
    const nodes = [...document.querySelectorAll<HTMLElement>(".react-flow__node:not(.react-flow__node-group)")]
      .filter((el) => el.querySelector(".archer-node") !== null)
      .map((el) => ({ name: `node ${el.dataset.id}`, box: rect(el.querySelector(".archer-node")!) }));
    // A frame's "−" is checked against plates and wires at every zoom it shows at in `frame-toggle-clear.e2e.ts`.
    const hit = (a: DOMRect, b: DOMRect) =>
      a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
    const out: string[] = [];
    plates.forEach((plate, i) => {
      for (const other of [...plates.slice(i + 1), ...nodes])
        if (hit(plate.box, other.box)) out.push(`${plate.name} × ${other.name}`);
    });
    return out;
  });
}

async function look(page: Page, url: string, width: number, scheme: "light" | "dark", shot: string): Promise<void> {
  await page.setViewportSize({ width, height: 900 });
  await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
  await page.goto(url);
  await expect(page.locator(".react-flow__node").first()).toBeVisible();
  await expect(page.locator(".archer-edge-label").first()).toBeVisible();
  await settled(page);
  if (SHOTS) await page.screenshot({ path: join(SHOTS, `${shot}-${width}-${scheme}.png`) });
}

for (const scheme of ["light", "dark"] as const) {
  for (const width of [1500, 1000]) {
    test(`Pageturner containers show each relationship's technology inline, ${width} ${scheme}`, async ({ page }) => {
      project = await sharedTsProject({ files: corpus("pageturner"), beforeAttach: commit });
      const origin = new URL(project.url).origin;
      await page.goto((await project.issueAccess("edge-detail")).url);
      const slug = new URL(project.url).pathname.split(/\/(?:p|projects)\//)[1]!.split("/")[0]!;
      await look(page, `${origin}/projects/${slug}/diagrams/containers.mmd`, width, scheme, "containers");
      const closed = await overlaps(page);
      // Opened, every relationship inside the shop is drawn.
      await page.getByRole("button", { name: /^Open Pageturner online bookshop$/i }).click();
      await expect(page.locator('.archer-edge-label[data-edge-id="api--db"]')).toBeVisible();
      await page.getByRole("button", { name: "Fit view", exact: true }).first().click();
      await settled(page);
      if (SHOTS) await page.screenshot({ path: join(SHOTS, `containers-open-${width}-${scheme}.png`) });
      expect(closed, "closed").toEqual([]);

      await expect(page.locator(".archer-edge-label-more, [data-edge-more]")).toHaveCount(0);
      await expect(page.locator(".archer-edge-label", { hasText: "ⓘ" })).toHaveCount(0);
      // The customer's caption, then its technology under it, both drawn and on screen.
      const customer = page.locator('.archer-edge-label[data-edge-id="customer--web"]');
      await expect(customer).toBeVisible();
      const technology = customer.locator(".archer-edge-label-technology");
      await expect(technology).toHaveText("[HTTPS]");
      await expect(technology).toBeVisible();
      const label = (await customer.locator(".archer-edge-label-row").last().boundingBox())!;
      const under = (await technology.boundingBox())!;
      expect(under.y, "the technology is under the label").toBeGreaterThanOrEqual(label.y + label.height - 1);
      // The technology is inside the plate the layout reserved, never spilling out of it.
      const plate = (await customer.boundingBox())!;
      expect(under.y + under.height).toBeLessThanOrEqual(plate.y + plate.height + 0.5);
      // Every relationship with a technology shows it.
      await expect(page.locator(".archer-edge-label-technology")).toHaveCount(9);
      // Read in the secondary style a C4 card's `[Container]` line uses.
      const [edgeTech, cardType] = await Promise.all([
        technology.evaluate((el) => {
          const s = getComputedStyle(el);
          return { size: s.fontSize, opacity: s.opacity, weight: s.fontWeight };
        }),
        page
          .locator(".archer-c4-type")
          .first()
          .evaluate((el) => {
            const s = getComputedStyle(el);
            return { size: s.fontSize, opacity: s.opacity, weight: s.fontWeight };
          }),
      ]);
      expect(edgeTech).toEqual(cardType);
      expect(await overlaps(page)).toEqual([]);
    });

    test(`a relationship's description is drawn inline and wraps, ${width} ${scheme}`, async ({ page }) => {
      project = await sharedTsProject({
        files: {
          "archer.toml":
            'version = 1\n[[views]]\nid = "described"\nkind = "c4"\ntitle = "Described"\nsource = ".archer/described.mmd"\n',
          ".archer/described.mmd": DESCRIBED,
        },
      });
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
      await page.goto(project.url);
      await project.present("described");
      await expect(page.locator(".archer-edge-label").first()).toBeVisible();
      await settled(page);
      if (SHOTS) await page.screenshot({ path: join(SHOTS, `described-${width}-${scheme}.png`) });

      await expect(page.locator(".archer-edge-label-more, [data-edge-more]")).toHaveCount(0);
      const browses = page.locator('.archer-edge-label[data-edge-id="customer--web"]');
      await expect(browses.locator(".archer-edge-label-technology")).toHaveText("[HTTPS]");
      const description = browses.locator(".archer-edge-label-description");
      await expect(description).toBeVisible();
      expect((await description.locator(".archer-edge-label-row").allTextContents()).join(" ")).toBe(
        "Every page of the shop, from search to the receipt",
      );
      // A long description wraps rather than making one wide plate.
      expect((await browses.boundingBox())!.width).toBeLessThan(220);
      expect(await description.locator(".archer-edge-label-row").count()).toBeGreaterThan(1);
      // With no label, the detail stands alone.
      const alone = page.locator('.archer-edge-label[data-edge-id="api--payments"]');
      await expect(alone).toBeVisible();
      await expect(alone.locator(".archer-edge-label-technology")).toHaveCount(0);
      await expect(page.locator('.archer-edge-label[data-edge-id="api--db"] .archer-edge-label-technology')).toHaveText(
        "[SQL]",
      );
      // The screen reader still hears it, on the edge itself.
      await expect(page.locator(".react-flow__edge[aria-label*='Every page of the shop']")).toHaveCount(1);
      expect(await overlaps(page)).toEqual([]);
    });
  }
}
