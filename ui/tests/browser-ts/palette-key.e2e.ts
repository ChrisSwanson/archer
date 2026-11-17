/**
 * The Diagram Key's colours as painted (DESIGN.md, "The Key"), for the owner's home rig, in both themes: each
 * row's sample is drawn in what its members are drawn in on the canvas -- the same computed fill, border
 * colour, width and dash -- its members are named behind a disclosure and in their accessible names, and
 * the Key passes axe.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { sharedTsProject } from "./support/shared-service";

const HOME_RIG = readFileSync(resolve(import.meta.dirname, "../fixtures/palette/home-rig.mmd"), "utf8");

type Paint = { fill: string; border: string; width: string; dash: string };
const paintOf = (el: Locator): Promise<Paint> =>
  el.evaluate((node) => {
    const style = getComputedStyle(node);
    return {
      fill: style.backgroundColor,
      border: style.borderTopColor,
      width: style.borderTopWidth,
      dash: style.borderTopStyle,
    };
  });

/** Each Key row and the canvas element it must match. */
const ROWS = [
  // In the order each is first worn in the source (owner, 2026-11-12).
  ["kind:Person", '.react-flow__node[data-id="you"]'],
  ["category:sandbox", '.react-flow__node[data-id="staging"]'],
  // Plain structure (the home server) has no row (owner, 2026-11-12). Every gpu member is a panel or a light
  // card in one, so the gpu sample is the panel.
  ["category:gpu", '.react-flow__node[data-id="group:gpu1"]'],
] as const;

async function openHomeRig(page: Page, scheme: "light" | "dark") {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
  const project = await sharedTsProject({
    files: {
      "archer.toml": `version = 1\n[[views]]\nid = "home-rig"\nkind = "freeform"\ntitle = "The Home Rig"\nsource = ".archer/home-rig.mmd"\n`,
      ".archer/home-rig.mmd": HOME_RIG,
    },
  });
  await page.goto(project.url);
  await project.present("home-rig");
  await expect(page.locator('.react-flow__node[data-id="you"]')).toBeVisible();
  const key = page.getByRole("region", { name: "Diagram Key", exact: true });
  const toggle = page.getByRole("button", { name: "Diagram Key", exact: true });
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  await expect(key.getByRole("group", { name: "Colours" })).toBeVisible();
  return { project, key };
}

for (const scheme of ["light", "dark"] as const)
  test(`the Key's samples are what its members are drawn in, in ${scheme}`, async ({ page }) => {
    const { project, key } = await openHomeRig(page, scheme);
    try {
      await expect
        .poll(() => key.locator("[data-key-row]").evaluateAll((els) => els.map((el) => el.dataset.keyRow)))
        .toEqual(ROWS.map(([row]) => row));
      for (const [row, member] of ROWS) {
        const sample = await paintOf(key.locator(`[data-key-row="${row}"] .archer-key-swatch`));
        const painted = await paintOf(page.locator(member));
        expect(sample, `${row} against ${member}`).toEqual(painted);
      }
      // A family is told from a plain node by its fill and its border, in both themes (dark: a quiet tint).
      const person = await paintOf(key.locator('[data-key-row="kind:Person"] .archer-key-swatch'));
      const plain = await paintOf(page.locator('.react-flow__node[data-id="vpn"]'));
      expect(person.fill).not.toBe(plain.fill);
      expect(person.border).not.toBe(plain.border);
    } finally {
      await project.stop();
    }
  });

test("the Key names each row's members, the members say their row, and axe passes", async ({ page }) => {
  const { project, key } = await openHomeRig(page, "light");
  try {
    const disclosure = key.locator('[data-key-row="category:gpu"] details');
    const summary = disclosure.locator("summary");
    await expect(summary).toHaveText("Members of Model server on a GPU");
    // The keyboard opens it.
    await summary.focus();
    await page.keyboard.press("Enter");
    await expect(disclosure).toHaveAttribute("open", "");
    await expect(disclosure.getByRole("listitem")).toHaveText([
      "GPU 1: RTX PRO 5000, 72 GB (group)",
      "GPU 2: RTX PRO 4000, 24 GB (group)",
      "Chat Model Server",
      "Farm Model Server",
      "Helper Model Server",
    ]);
    await expect(page.locator('.react-flow__node[data-id="farmModel"]')).toHaveAttribute(
      "aria-label",
      /, Model server on a GPU$/,
    );
    await expect(page.locator('.react-flow__node[data-id="staging"]')).toHaveAttribute(
      "aria-label",
      /, Walled-off sandbox, dashed outline$/,
    );
    await expect(key).toContainText("Blue marks your selection and comments. Amber marks the agent's replies.");
    expect((await new AxeBuilder({ page }).include(".archer-diagram-key").analyze()).violations).toEqual([]);
  } finally {
    await project.stop();
  }
});
