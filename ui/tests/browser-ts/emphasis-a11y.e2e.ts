// WCAG 2.2 SC 1.4.1 in a real browser (ADR 0030 amendment, 2026-10-22):
//
//   - colour stays the default and nothing else is drawn while Group numbers is off;
//   - with Group numbers on, every emphasised box and line carries its group's number,
//     legible in greyscale, at desktop and phone width, light and dark;
//   - names, the Members list and its keyboard path, axe, forced colours, high contrast
//     and reduced motion.
//
// ARCHER_A11Y_SHOTS=<dir> saves greyscale screenshots of each state for review.
import AxeBuilder from "@axe-core/playwright";
import { followBrowserMotion } from "./support/emphasis-motion";
import { expect, test, type Page } from "@playwright/test";
import { resolve } from "node:path";
import { sharedTsProject } from "./support/shared-service";

const SHOTS = process.env.ARCHER_A11Y_SHOTS;
const SOURCE =
  "flowchart LR\n  shop[Shop] e1@-->|card details| pay[Payment service]\n  pay e2@--> bank[Bank]\n  shop e3@--> mail[Mailer]\n  mail e4@--> inbox[Customer inbox]\n";
const FILES = {
  "archer.toml":
    'version = 1\n[[views]]\nid = "drawing"\nkind = "freeform"\ntitle = "Drawing"\nsource = ".archer/drawing.mmd"\n',
  ".archer/drawing.mmd": SOURCE,
};
const GROUPS = [
  {
    id: "two",
    title: "Checkout",
    groups: [
      {
        id: "payment",
        label: "payment",
        description: "Card details go to the bank.",
        style: "flow",
        nodes: ["pay", "bank"],
        edges: ["e1", "e2"],
      },
      { id: "email", label: "email", style: "highlight", nodes: ["mail", "inbox"], edges: ["e4"] },
    ],
  },
];

async function open(page: Page, touch: boolean) {
  const server = await sharedTsProject({ files: FILES });
  await server.present("drawing");
  await page.goto(server.url);
  await expect(page.locator('.react-flow__node[data-id="pay"]')).toBeVisible();
  await server.setEmphasis("drawing", GROUPS);
  await expect(page.locator('.react-flow__node[data-id="pay"].archer-emph')).toBeVisible();
  return server;
}

/** The legend, opened from the dock's panel chip on a phone (0.6.4 D5: one sheet holds the panel). */
async function legendOf(page: Page, touch: boolean) {
  const legend = page.getByRole("region", { name: "Highlights", exact: true });
  if (touch && !(await legend.isVisible())) await page.locator(".archer-stage-dock .archer-dock-chip--panel").tap();
  await expect(legend).toBeVisible();
  return legend;
}

/** Folds the sheet back to its chip with a press outside it; the highlights stay on. */
async function closeSheet(page: Page, touch: boolean) {
  if (touch) await page.locator(".react-flow__pane").tap({ position: { x: 8, y: 8 } });
}

async function greyShot(page: Page, name: string): Promise<void> {
  if (SHOTS === undefined) return;
  await page.addStyleTag({ content: "html { filter: grayscale(1) !important; }" });
  await page.screenshot({ path: resolve(SHOTS, `${name}.png`) });
  await page.addStyleTag({ content: "html { filter: none !important; }" });
}

/** What a node's corner says: its `::after` content, or "none". */
const cornerNumber = (page: Page, id: string) =>
  page
    .locator(`.react-flow__node[data-id="${id}"]`)
    .evaluate((element) => getComputedStyle(element, "::after").content);

for (const [label, size, touch] of [
  ["desktop", { width: 1280, height: 800 }, false],
  ["phone", { width: 390, height: 844 }, true],
] as const)
  for (const scheme of ["light", "dark"] as const) {
    test.describe(`${label} ${scheme}`, () => {
      test.use({ hasTouch: touch, isMobile: touch });
      test("quiet by default; Group numbers on numbers every member, in greyscale too", async ({ page }) => {
        await page.setViewportSize(size);
        await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
        const server = await open(page, touch);
        try {
          // Off: colour only, exactly as before -- no marker, no corner number.
          await expect(page.locator(".archer-emph-marker")).toHaveCount(0);
          expect(await cornerNumber(page, "pay")).toBe("none");
          await greyShot(page, `${label}-${scheme}-numbers-off`);

          const legend = await legendOf(page, touch);
          await legend.getByRole("combobox", { name: "Group numbers" }).selectOption("on");
          await closeSheet(page, touch);
          await expect(page.locator(".archer-emph-surface")).toHaveClass(/archer-emph-numbered/);
          // Every emphasised box shows its group's number on its corner...
          for (const [id, n] of [
            ["pay", "1"],
            ["bank", "1"],
            ["mail", "2"],
            ["inbox", "2"],
          ] as const)
            expect(await cornerNumber(page, id)).toBe(`"${n}"`);
          expect(await cornerNumber(page, "shop")).toBe("none");
          // ...and every emphasised line one on its middle, drawn and on the canvas.
          for (const [id, n] of [
            ["e1", "1"],
            ["e2", "1"],
            ["e4", "2"],
          ] as const) {
            const marker = page.locator(`.react-flow__edge[data-id="${id}"] .archer-emph-marker`);
            await expect(marker).toHaveAttribute("data-slot", n);
            const box = (await marker.boundingBox())!;
            expect(box.width, `${id}'s number is legible`).toBeGreaterThanOrEqual(12);
          }
          await expect(page.locator('.react-flow__edge[data-id="e3"] .archer-emph-marker')).toHaveCount(0);
          // A number never sits on a caption.
          const caption = (await page.locator(".archer-edge-label").filter({ hasText: "card details" }).boundingBox())!;
          const marker = (await page.locator('.react-flow__edge[data-id="e1"] .archer-emph-marker').boundingBox())!;
          const overlaps =
            marker.x < caption.x + caption.width &&
            caption.x < marker.x + marker.width &&
            marker.y < caption.y + caption.height &&
            caption.y < marker.y + marker.height;
          expect(overlaps, "e1's number is clear of its caption").toBe(false);
          await greyShot(page, `${label}-${scheme}-numbers-on`);
          // Remembered across a reload.
          await page.reload();
          await expect(page.locator(".archer-emph-surface.archer-emph-numbered")).toBeVisible();
        } finally {
          await server.stop();
        }
      });
    });
  }

test("names, the Members list by keyboard, and axe with everything open", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const server = await open(page, false);
  try {
    await expect(page.getByRole("button", { name: /^Payment service, in highlight 1: payment/ })).toBeAttached();
    await expect(
      page.getByRole("button", { name: /^Mailer → Customer inbox.*, in highlight 2: email/ }),
    ).toBeAttached();
    const legend = page.getByRole("region", { name: "Highlights", exact: true });
    const toggle = legend.getByRole("button", { name: "Members", exact: true });
    await toggle.focus();
    await page.keyboard.press("Enter");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    const email = legend.getByRole("list", { name: "Highlight 2: email" });
    await expect(email.getByRole("button")).toHaveText(["Mailer", "Customer inbox", "Mailer → Customer inbox"]);
    await email.getByRole("button", { name: "Customer inbox", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect
      .poll(() => page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.id))
      .toBe("inbox");
    await legend.getByRole("combobox", { name: "Group numbers" }).selectOption("on");
    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations.flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(" ")}`))).toEqual([]);
  } finally {
    await server.stop();
  }
});

for (const media of [{ forcedColors: "active" }, { contrast: "more" }] as const)
  test(`Auto numbers the groups under ${JSON.stringify(media)}, and emphasis stays visible`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.emulateMedia({ reducedMotion: "reduce", ...media });
    const server = await open(page, false);
    try {
      await expect(page.locator(".archer-emph-surface")).toHaveClass(/archer-emph-numbered/);
      if ("forcedColors" in media) {
        const [emph, plain] = await Promise.all(
          ["pay", "shop"].map((id) =>
            page
              .locator(`.react-flow__node[data-id="${id}"]`)
              .evaluate(
                (element) => `${getComputedStyle(element).borderTopColor} ${getComputedStyle(element).borderTopWidth}`,
              ),
          ),
        );
        expect(emph, "an emphasised border differs from a plain one in forced colours").not.toBe(plain);
        await greyShot(page, "forced-colors");
      }
    } finally {
      await server.stop();
    }
  });

test("reduced motion: the numbers and the parked arrows both stay, nothing moves", async ({ page }) => {
  await followBrowserMotion(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const server = await open(page, false);
  try {
    await page
      .getByRole("region", { name: "Highlights", exact: true })
      .getByRole("combobox", { name: "Group numbers" })
      .selectOption("on");
    const edge = page.locator('.react-flow__edge[data-id="e2"]');
    await expect(edge.locator(".archer-emph-marker")).toHaveCount(1);
    await expect(edge.locator(".archer-emph-chevron")).toHaveCount(2);
    await expect(edge.locator("animateMotion")).toHaveCount(0);
    const animations = await page.evaluate(
      () =>
        document
          .getAnimations()
          .filter(
            (a) =>
              a.playState === "running" &&
              (a.effect as KeyframeEffect | null)?.target?.closest?.(".archer-emph-surface"),
          ).length,
    );
    expect(animations).toBe(0);
  } finally {
    await server.stop();
  }
});

test.describe("phone", () => {
  test.use({ hasTouch: true, isMobile: true });
  test("a member tapped in the Highlights sheet closes the sheet and is focused, on screen and uncovered", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    const server = await open(page, true);
    try {
      const legend = await legendOf(page, true);
      await legend.getByRole("button", { name: "Members", exact: true }).tap();
      await legend
        .getByRole("list", { name: "Highlight 2: email" })
        .getByRole("button", { name: "Customer inbox", exact: true })
        .tap();
      await expect(page.locator(".archer-dock-sheet")).toHaveCount(0);
      await expect
        .poll(() => page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.id))
        .toBe("inbox");
      // On screen once the camera settles, and nothing paints over its middle.
      await expect
        .poll(async () =>
          page.locator('.react-flow__node[data-id="inbox"]').evaluate((element) => {
            const box = element.getBoundingClientRect();
            const x = box.left + box.width / 2,
              y = box.top + box.height / 2;
            const top = document.elementFromPoint(x, y);
            return x > 0 && x < innerWidth && y > 0 && y < innerHeight && top !== null && element.contains(top);
          }),
        )
        .toBe(true);
    } finally {
      await server.stop();
    }
  });
});
