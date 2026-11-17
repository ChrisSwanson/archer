import { expect, test } from "@playwright/test";
import { revealProjects } from "./support/sidebar";
import { sharedTsProject } from "./support/shared-service";

test("pointer crosses the Archer-to-Projects gap without collapsing the sidebar", async ({ page }) => {
  const project = await sharedTsProject({
    files: {
      "archer.toml":
        'version = 1\nname = "Sidebar sample"\n[[views]]\nid = "flow"\nkind = "freeform"\ntitle = "Flow"\nsource = ".archer/flow.mmd"\n',
      ".archer/flow.mmd": "flowchart LR\n a[Customer] e1@--> b[Shop]\n",
    },
  });
  try {
    await project.present("flow");
    await page.goto(project.url);
    await page.mouse.move(700, 500);
    const nav = page.locator(".primary-navigation");
    const brand = page.getByRole("button", { name: "Archer contents", exact: true });
    await revealProjects(page);
    const brandBox = (await brand.boundingBox())!;
    // Walk the real gap rather than teleporting between buttons as hover() does.
    await page.mouse.move(100, brandBox.y + brandBox.height + 12);
    expect(await nav.getAttribute("data-expanded")).toBe("true");
    const heading = page.getByRole("heading", { name: "Projects", exact: true });
    const headingBox = (await heading.boundingBox())!;
    await page.mouse.move(100, headingBox.y + headingBox.height / 2);
    expect(await nav.getAttribute("data-expanded")).toBe("true");
    await page
      .getByRole("navigation", { name: "Projects", exact: true })
      .getByRole("button", { name: /^Sidebar sample/ })
      .click();
    await expect(nav).toHaveAttribute("data-expanded", "false");
    await page.mouse.move(700, 500);
    await expect
      .poll(() =>
        nav.evaluate(
          (element) =>
            element.getAnimations({ subtree: true }).filter((animation) => animation.playState === "running").length,
        ),
      )
      .toBe(0);
    const glyph = heading.locator("svg");
    await expect(glyph).toBeVisible();
    const glyphBox = (await glyph.boundingBox())!;
    expect(Math.abs(glyphBox.x + glyphBox.width / 2 - 32)).toBeLessThanOrEqual(0.5);
    await page.mouse.move(glyphBox.x + glyphBox.width / 2, glyphBox.y + glyphBox.height / 2);
    await expect(nav).toHaveAttribute("data-expanded", "true");
    await page.mouse.move(32, 600);
    expect(await nav.getAttribute("data-expanded")).toBe("true");
    await page.mouse.move(700, 500);
    await expect(nav).toHaveAttribute("data-expanded", "false");
  } finally {
    await project.stop();
  }
});

test("collapsed sidebar centers every visible glyph and has no footer separator", async ({ page }) => {
  const project = await sharedTsProject({
    files: {
      "archer.toml":
        'version = 1\n[[views]]\nid = "flow"\nkind = "freeform"\ntitle = "Flow"\nsource = ".archer/flow.mmd"\n',
      ".archer/flow.mmd": "flowchart LR\n a[Customer] e1@--> b[Shop]\n",
    },
  });
  try {
    await project.present("flow");
    await page.goto(project.url);
    await page.mouse.move(700, 500);
    const nav = page.locator(".primary-navigation");
    await expect(nav).toHaveAttribute("data-expanded", "false");
    await expect(page.getByRole("button", { name: "Archer settings", exact: true })).toBeVisible();
    const result = await page.locator(".primary-rail").evaluate((rail) => {
      const center = (element: Element | Range): number => {
        const box = element.getBoundingClientRect();
        return box.left + box.width / 2;
      };
      const glyphCenter = (button: HTMLElement): number => {
        const svg = button.querySelector(":scope > svg");
        if (svg) return center(svg);
        const glyph = button.querySelector(":scope > .primary-help-glyph");
        if (glyph) return center(glyph);
        const text = [...button.childNodes].find(
          (node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim(),
        );
        if (!text) throw new Error(`No visible glyph in ${button.className}`);
        const range = document.createRange();
        range.selectNodeContents(text);
        return center(range);
      };
      const buttons = [
        ...rail.querySelectorAll<HTMLElement>(
          ":scope > .primary-navigation-head .primary-brand, .primary-projects-heading, :scope > .archer-settings-launcher, :scope > .primary-help",
        ),
      ];
      const sections = rail.querySelector<HTMLElement>(":scope > .primary-sections");
      return {
        railCenter: center(rail),
        glyphCenters: buttons.map(glyphCenter),
        overflowX: getComputedStyle(sections!).overflowX,
      };
    });
    expect(result.glyphCenters).toHaveLength(4);
    for (const glyphCenter of result.glyphCenters)
      expect(Math.abs(glyphCenter - result.railCenter)).toBeLessThanOrEqual(0.5);
    expect(result.overflowX).toBe("hidden");
  } finally {
    await project.stop();
  }
});
test("hover reveals the permanent Projects section without moving its heading", async ({ page }) => {
  const project = await sharedTsProject({
    files: {
      "archer.toml":
        'version = 1\n[[views]]\nid = "flow"\nkind = "freeform"\ntitle = "Flow"\nsource = ".archer/flow.mmd"\n',
      ".archer/flow.mmd": "flowchart LR\n a[Customer] e1@--> b[Shop]\n",
    },
  });
  try {
    await project.present("flow");
    await page.goto(project.url);
    const nav = page.locator(".primary-navigation");
    const projects = page.getByRole("heading", { name: "Projects", exact: true });
    const brand = page.getByRole("button", { name: "Archer contents", exact: true });
    await page.mouse.move(700, 500);
    await expect(nav).toHaveAttribute("data-expanded", "false");
    const before = await brand.boundingBox();
    await brand.hover();
    await expect(nav).toHaveAttribute("data-expanded", "true");
    await expect(projects).toBeVisible();
    await expect.poll(async () => (await brand.boundingBox())?.x).toBe(before!.x);
    await expect.poll(async () => (await brand.boundingBox())?.y).toBe(before!.y);
    await expect(page.getByRole("navigation", { name: "Recent" })).toBeVisible();
    await page.locator(".react-flow").click({ position: { x: 500, y: 400 } });
    await expect(nav).toHaveAttribute("data-expanded", "false");
    await brand.hover();
    await page.getByRole("navigation", { name: "Recent" }).getByRole("button", { name: /^Flow/ }).click();
    await expect(nav).toHaveAttribute("data-expanded", "false");
    await expect(page.getByRole("button", { name: "All diagrams", exact: true })).toHaveCount(0);
  } finally {
    await project.stop();
  }
});

test("revealing Projects waits for every sidebar surface to finish appearing", async ({ page }) => {
  const project = await sharedTsProject({
    files: {
      "archer.toml":
        'version = 1\n[[views]]\nid = "flow"\nkind = "freeform"\ntitle = "Flow"\nsource = ".archer/flow.mmd"\n',
      ".archer/flow.mmd": "flowchart LR\n a[Customer] e1@--> b[Shop]\n",
    },
  });
  try {
    await project.present("flow");
    await page.goto(project.url);
    await page.mouse.move(700, 500);
    await page.addStyleTag({
      content:
        ".primary-navigation{transition-duration:600ms!important}.primary-projects-heading span,.primary-flyout{transition-duration:700ms!important}",
    });
    await revealProjects(page);
    const settled = await page.locator(".primary-navigation").evaluate((navigation) => ({
      heading: getComputedStyle(navigation.querySelector(".primary-projects-heading span")!).opacity,
      flyout: getComputedStyle(navigation.querySelector(".primary-flyout")!).opacity,
      running: navigation.getAnimations({ subtree: true }).filter((animation) => animation.playState === "running")
        .length,
    }));
    expect(settled).toEqual({ heading: "1", flyout: "1", running: 0 });
  } finally {
    await project.stop();
  }
});

test("reduced motion removes every sidebar reveal transition", async ({ page }) => {
  const project = await sharedTsProject({
    files: {
      "archer.toml":
        'version = 1\n[[views]]\nid = "flow"\nkind = "freeform"\ntitle = "Flow"\nsource = ".archer/flow.mmd"\n',
      ".archer/flow.mmd": "flowchart LR\n a[Customer] e1@--> b[Shop]\n",
    },
  });
  try {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await project.present("flow");
    await page.goto(project.url);
    const transitions = await page
      .locator(".primary-navigation")
      .evaluate((element) =>
        [
          element,
          element.querySelector(".primary-brand span")!,
          element.querySelector(".primary-projects-heading span")!,
          element.querySelector(".primary-flyout")!,
          element.querySelector(".primary-help-label")!,
        ].map((target) => getComputedStyle(target).transitionDuration),
      );
    expect(transitions).toEqual(["0s", "0s", "0s", "0s", "0s"]);
  } finally {
    await project.stop();
  }
});

test("the expanded sidebar owns its blank surface, then only the collapsed rail can reopen it", async ({ page }) => {
  const project = await sharedTsProject({
    files: {
      "archer.toml":
        'version = 1\n[[views]]\nid = "flow"\nkind = "freeform"\ntitle = "Flow"\nsource = ".archer/flow.mmd"\n',
      ".archer/flow.mmd": "flowchart LR\n a[Customer] e1@--> b[Shop]\n",
    },
  });
  try {
    await project.present("flow");
    await page.goto(project.url);
    await page.mouse.move(700, 500);
    await page.addStyleTag({ content: ".primary-navigation{transition-duration:600ms!important}" });
    await page.getByRole("button", { name: "Archer contents", exact: true }).hover();
    const nav = page.locator(".primary-navigation");
    await expect(nav).toHaveAttribute("data-expanded", "true");
    await expect
      .poll(() =>
        nav.evaluate(
          (element) =>
            element.getAnimations({ subtree: true }).filter((animation) => animation.playState === "running").length,
        ),
      )
      .toBe(0);
    const blank = { x: 280, y: 700 };
    await page.mouse.move(blank.x, blank.y);
    expect(
      await page.evaluate(
        ({ x, y }) =>
          document.elementFromPoint(x, y)?.closest(".primary-navigation")?.classList.contains("primary-navigation"),
        blank,
      ),
    ).toBe(true);
    await expect(nav).toHaveAttribute("data-expanded", "true");
    // The collapse is looked at mid-course, so it is slowed until it surely is: a 600 ms one could be over before the
    // check after the flip ran under load, and the rail was 64 px wide (O243, as O54 for the glyphs test).
    await page.addStyleTag({ content: ".primary-navigation{transition-duration:600s!important}" });
    await page.mouse.move(700, 700);
    await expect(nav).toHaveAttribute("data-expanded", "false");
    await nav.evaluate((element) => {
      for (const animation of element.getAnimations()) {
        animation.pause();
        animation.currentTime = 1;
      }
    });
    expect(await nav.evaluate((element) => element.getBoundingClientRect().width)).toBeGreaterThan(280);
    for (const point of [{ x: 280, y: 40 }, { x: 280, y: 108 }, blank])
      expect(
        await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest(".primary-navigation"), point),
      ).toBeNull();
    await nav.evaluate((element) => {
      for (const animation of element.getAnimations()) animation.finish();
    });
    await expect
      .poll(() =>
        nav.evaluate(
          (element) =>
            element.getAnimations({ subtree: true }).filter((animation) => animation.playState === "running").length,
        ),
      )
      .toBe(0);
    await page.mouse.move(blank.x, blank.y);
    await expect(nav).toHaveAttribute("data-expanded", "false");
    expect(
      await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest(".primary-navigation"), blank),
    ).toBeNull();
    await page.mouse.move(32, blank.y);
    await expect(nav).toHaveAttribute("data-expanded", "true");
  } finally {
    await project.stop();
  }
});

test("brand, Projects and shortcuts glyphs stay fixed throughout sidebar expansion and collapse", async ({ page }) => {
  const project = await sharedTsProject({
    files: {
      "archer.toml":
        'version = 1\n[[views]]\nid = "flow"\nkind = "freeform"\ntitle = "Flow"\nsource = ".archer/flow.mmd"\n',
      ".archer/flow.mmd": "flowchart LR\n a[Customer] e1@--> b[Shop]\n",
    },
  });
  try {
    await project.present("flow");
    await page.goto(project.url);
    await page.mouse.move(700, 500);
    const nav = page.locator(".primary-navigation");
    // Slow enough that the width transition is surely still running when it is looked at, and then stepped through by
    // hand: a 600 ms one could end before a poll under load first saw it running (O54).
    await page.addStyleTag({ content: ".primary-navigation{transition-duration:600s!important}" });
    const centers = () =>
      nav.evaluate((element) =>
        [
          ".primary-brand svg",
          ".primary-projects-heading svg",
          ".archer-settings-launcher svg",
          ".primary-help-glyph",
        ].map((selector) => {
          const box = element.querySelector(selector)!.getBoundingClientRect();
          return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
        }),
      );
    const expectFixed = (
      actual: Awaited<ReturnType<typeof centers>>,
      expected: Awaited<ReturnType<typeof centers>>,
    ) => {
      expect(actual).toHaveLength(expected.length);
      actual.forEach((point, index) => {
        expect(Math.abs(point.x - expected[index]!.x)).toBeLessThanOrEqual(0.5);
        expect(Math.abs(point.y - expected[index]!.y)).toBeLessThanOrEqual(0.5);
      });
    };
    const initial = await centers();
    /** The sidebar's transition, held at each fifth of its course in turn: the glyphs stay put at every one; then ended. */
    const throughTransition = async () => {
      await expect
        .poll(() =>
          nav.evaluate((element) => element.getAnimations().some((animation) => animation.playState === "running")),
        )
        .toBe(true);
      for (const part of [0, 0.2, 0.4, 0.6, 0.8, 1]) {
        await nav.evaluate((element, part) => {
          for (const animation of element.getAnimations()) {
            animation.pause();
            animation.currentTime = part * Number(animation.effect!.getComputedTiming().duration);
          }
        }, part);
        await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
        expectFixed(await centers(), initial);
      }
      await nav.evaluate((element) => {
        for (const animation of element.getAnimations({ subtree: true })) animation.finish();
      });
      await expect
        .poll(() =>
          nav.evaluate(
            (element) =>
              element.getAnimations({ subtree: true }).filter((animation) => animation.playState === "running").length,
          ),
        )
        .toBe(0);
      expectFixed(await centers(), initial);
    };
    await page.mouse.move(32, 32);
    await expect(nav).toHaveAttribute("data-expanded", "true");
    await throughTransition();
    await page.mouse.move(700, 500);
    await expect(nav).toHaveAttribute("data-expanded", "false");
    await throughTransition();
  } finally {
    await project.stop();
  }
});

for (const width of [1440, 390])
  test(`notifications have one accessible document-action hit target at ${width}px`, async ({ page }) => {
    const project = await sharedTsProject({
      files: {
        "archer.toml":
          'version = 1\n[[views]]\nid = "flow"\nkind = "freeform"\ntitle = "Flow"\nsource = ".archer/flow.mmd"\n',
        ".archer/flow.mmd": "flowchart LR\n a[Customer] e1@--> b[Shop]\n",
      },
    });
    try {
      await page.setViewportSize({ width, height: 900 });
      await project.present("flow");
      await page.goto(project.url);
      await expect(
        page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: /Notifications/ }),
      ).toHaveCount(0);
      const bell = page.getByRole("button", { name: "Notifications", exact: true });
      await expect(bell).toHaveCount(1);
      expect(await bell.evaluate((el) => !!el.closest(".primary-document-actions"))).toBe(true);
      // Firefox reports nominal dimensions with floating-point layout error (~0.000002px).
      const box = await bell.boundingBox();
      expect(box!.width).toBeCloseTo(width < 720 ? 44 : 36, 5);
      expect(box!.height).toBeCloseTo(width < 720 ? 44 : 36, 5);
      // An icon-only control's glyph box is --icon (20px; icon-scale.e2e.ts).
      const icon = await bell.locator("svg").boundingBox();
      expect(icon!.width).toBeCloseTo(20, 5);
      expect(icon!.height).toBeCloseTo(20, 5);
      expect(
        await page.evaluate(
          ({ x, y }) => document.elementFromPoint(x, y)?.closest("button")?.getAttribute("aria-label"),
          { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 },
        ),
      ).toBe("Notifications");
      await bell.click();
      await expect(page.getByRole("region", { name: "Project Review" })).toBeVisible();
      await expect(page.locator(".primary-navigation")).toHaveAttribute("data-expanded", "false");
      await page.getByRole("button", { name: "Close project review" }).click();
      await expect(bell).toBeFocused();
    } finally {
      await project.stop();
    }
  });
