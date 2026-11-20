/**
 * Real-layout coverage for the grouped filter dialog. jsdom cannot see the
 * overflow that made the old side-by-side count inputs unusable.
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { existsSync } from "node:fs";
import type { TsProject } from "../support/ts-service";
import { testPage } from "./support/page-path";
import { sharedTsProject } from "./support/shared-service";

const PAGE = testPage();
const FILES = {
  "archer.toml": `version = 1
name = "Filter fixture"
[[views]]
id = "checkout"
kind = "freeform"
title = "Checkout"
source = ".archer/flows/checkout.mmd"
`,
  ".archer/flows/checkout.mmd": "flowchart LR\n a[Reader] route@--> b[Checkout]\n",
  ".archer/notes/operations.md": "# Operations\n\nRun the service.\n",
};

let project: TsProject | undefined;
let problems: string[];

test.beforeAll(() => {
  if (!existsSync(PAGE)) throw new Error(`no page at ${PAGE}; run: npm --workspace ui run build`);
});

test.beforeEach(async ({ page }) => {
  problems = [];
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning")
      problems.push(`${message.type()}: ${message.text()}`);
  });
  page.on("pageerror", (error) => problems.push(`uncaught: ${error.message}`));
});

test.afterEach(async ({ page }) => {
  await page.close();
  await project?.stop();
  project = undefined;
  expect(problems, "the page logged errors or warnings").toEqual([]);
});

async function openFilters(page: Page, viewport: { width: number; height: number }): Promise<Locator> {
  project = await sharedTsProject({ files: FILES });
  await page.setViewportSize(viewport);
  await page.goto(project.address(`q=`));
  await page.getByRole("button", { name: "Filters", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Project Filters" });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function expectFixedFrame(dialog: Locator, viewport: { width: number; height: number }): Promise<void> {
  const box = await dialog.boundingBox();
  expect(box).not.toBeNull();
  const expectedWidth = viewport.width > 640 ? Math.min(1040, viewport.width - 48) : viewport.width - 24;
  const expectedHeight = viewport.width > 640 ? Math.min(820, viewport.height - 48) : viewport.height - 24;
  expect(box!.width).toBeCloseTo(expectedWidth, 0);
  expect(box!.height).toBeCloseTo(expectedHeight, 0);
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height);
  const layout = await dialog.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      columns: style.gridTemplateColumns,
      padding: style.padding,
      columnGap: style.columnGap,
      rowGap: style.rowGap,
    };
  });
  if (viewport.width > 640) {
    // One column since the redesign dropped the Filters/Fields section links; filters are the dialog's only panel.
    expect(layout.columns.split(" ")).toHaveLength(1);
    expect(layout.padding).toBe("32px");
    expect(layout.columnGap).toBe("40px");
    expect(layout.rowGap).toBe("28px");
  } else {
    expect(layout.columns.split(" ")).toHaveLength(1);
    expect(layout.padding).toBe("20px");
    expect(layout.columnGap).toBe("20px");
    expect(layout.rowGap).toBe("20px");
  }
}

async function expectContentFits(dialog: Locator): Promise<void> {
  const content = dialog.locator(".archer-browser-content");
  expect(await content.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  const contentBox = (await content.boundingBox())!;
  const controls = content.locator("select:visible, input:visible");
  for (const control of await controls.all()) {
    const box = await control.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(contentBox.x - 1);
    expect(box!.x + box!.width).toBeLessThanOrEqual(contentBox.x + contentBox.width + 1);
  }
}

async function expectClearFilterEdges(dialog: Locator): Promise<void> {
  const content = dialog.locator(".archer-browser-content");
  const overflow = await content.evaluate((element) => ({
    active: element.scrollHeight > element.clientHeight,
    gutter: getComputedStyle(element).scrollbarGutter,
  }));
  expect(overflow.active, "the regression exercises an active body scrollbar").toBe(true);
  expect(overflow.gutter, "the filter body reserves a stable scrollbar gutter").toContain("stable");

  const contentBox = await content.boundingBox();
  const trailingDiagramCount = dialog
    .getByRole("group", { name: "Diagram type", exact: true })
    .locator(".archer-search-choice-count")
    .last();
  const countBox = await trailingDiagramCount.boundingBox();
  expect(contentBox).not.toBeNull();
  expect(countBox).not.toBeNull();
  expect(
    contentBox!.x + contentBox!.width - (countBox!.x + countBox!.width),
    "Diagram type counts remain clear of the active scrollbar",
  ).toBeGreaterThanOrEqual(24);

  const selects = dialog.locator(".archer-browser-filter-content select:visible");
  expect(await selects.count(), "the fixture exercises every filter dropdown family").toBeGreaterThanOrEqual(6);
  for (const select of await selects.all()) {
    const control = await select.evaluate((element) => {
      const style = getComputedStyle(element);
      const native = element as HTMLSelectElement;
      return {
        tag: element.tagName,
        role: element.getAttribute("role"),
        multiple: native.multiple,
        size: native.size,
        appearance: style.appearance,
        paddingRight: Number.parseFloat(style.paddingRight),
        backgroundImage: style.backgroundImage,
        backgroundPosition: style.backgroundPosition,
        // Every layer's repeat, however the browser spells the list: Chromium 159 reports one value for a
        // property set once over two images, where earlier builds repeated it per layer (O279).
        backgroundRepeat: [...new Set(style.backgroundRepeat.split(",").map((value) => value.trim()))],
      };
    });
    expect(control, "a styled dropdown remains a native, single-select combobox").toMatchObject({
      tag: "SELECT",
      role: null,
      multiple: false,
      size: 0,
      appearance: "none",
      backgroundRepeat: ["no-repeat"],
    });
    expect(control.paddingRight, "dropdown text clears the indicator").toBeGreaterThanOrEqual(32);
    expect(control.backgroundImage, "the dropdown carries the familiar fine chevron").not.toBe("none");
    expect(control.backgroundPosition, "the dropdown indicator is inset from the end edge").toContain(
      "calc(100% - 12px)",
    );
  }

  for (const section of await dialog.locator(".archer-filter-section").all()) {
    const summary = section.locator(":scope > h3");
    const body = section.locator(":scope > .archer-filter-section-grid");
    const [sectionStyle, summaryStyle, summaryBox, bodyBox] = await Promise.all([
      section.evaluate((element) => {
        const style = getComputedStyle(element);
        return { top: style.borderTopWidth, bottom: style.borderBottomWidth };
      }),
      summary.evaluate((element) => {
        const style = getComputedStyle(element);
        return { top: style.borderTopWidth, bottom: style.borderBottomWidth };
      }),
      summary.boundingBox(),
      body.boundingBox(),
    ]);
    expect(sectionStyle, "the disclosure does not enclose the whole section with rules").toEqual({
      top: "0px",
      bottom: "0px",
    });
    expect(summaryStyle, "the section rule sits directly below its title").toEqual({ top: "0px", bottom: "1px" });
    expect(summaryBox).not.toBeNull();
    expect(bodyBox).not.toBeNull();
    expect(summaryBox!.y + summaryBox!.height).toBeCloseTo(bodyBox!.y, 0);
  }
}

async function expectCohesiveFileFacets(
  filesSection: Locator,
  viewport: { width: number; height: number },
): Promise<void> {
  const kind = filesSection.getByRole("group", { name: "Kind", exact: true });
  const diagramType = filesSection.getByRole("group", { name: "Diagram type", exact: true });
  const folder = filesSection.getByLabel("Folder", { exact: true });
  const [kindBox, diagramTypeBox, folderBox] = await Promise.all([
    kind.boundingBox(),
    diagramType.boundingBox(),
    folder.boundingBox(),
  ]);
  expect(kindBox).not.toBeNull();
  expect(diagramTypeBox).not.toBeNull();
  expect(folderBox).not.toBeNull();
  expect(kindBox!.width, "Kind stays a compact group").toBeLessThanOrEqual(280);
  expect(folderBox!.width, "Folder keeps a readable control width").toBeLessThanOrEqual(280);
  expect(diagramTypeBox!.width, "Diagram type stays a cohesive cluster").toBeLessThanOrEqual(460);
  if (viewport.width > 640) {
    expect(diagramTypeBox!.x, "Diagram type sits beside the Kind and Folder stack").toBeGreaterThan(
      kindBox!.x + kindBox!.width,
    );
    expect(
      Math.abs(diagramTypeBox!.y - kindBox!.y),
      "the two desktop clusters share a visual start",
    ).toBeLessThanOrEqual(1);
  } else {
    expect(diagramTypeBox!.y, "phone facets stack without stretching").toBeGreaterThan(
      folderBox!.y + folderBox!.height,
    );
  }
}

async function expectNaturalDiscussionAndDateFacets(
  dialog: Locator,
  viewport: { width: number; height: number },
): Promise<void> {
  const bounds = async (role: "group", name: string): Promise<{ width: number }> => {
    const box = await dialog.getByRole(role, { name, exact: true }).boundingBox();
    expect(box).not.toBeNull();
    return box!;
  };
  expect((await bounds("group", "Status")).width, "Status stays with its choices").toBeLessThanOrEqual(280);
  const countWidth = viewport.width > 640 ? 340 : 280;
  expect((await bounds("group", "Total threads")).width, "Total threads keeps a task-sized range").toBeLessThanOrEqual(
    countWidth,
  );
  expect(
    (await bounds("group", "Unresolved threads")).width,
    "Unresolved threads keeps a task-sized range",
  ).toBeLessThanOrEqual(countWidth);
  for (const name of ["Edited", "Created", "Commented"]) {
    expect((await bounds("group", name)).width, `${name} stays a cohesive date group`).toBeLessThanOrEqual(280);
  }
}

for (const viewport of [
  { width: 1440, height: 900, name: "desktop" },
  { width: 390, height: 900, name: "phone" },
  { width: 390, height: 500, name: "short phone" },
] as const) {
  test(`filter sections stay bounded and keyboard-operable on ${viewport.name}`, async ({ page }) => {
    const dialog = await openFilters(page, viewport);
    await expectFixedFrame(dialog, viewport);
    const frameBefore = await dialog.boundingBox();
    const headerBefore = await dialog.locator(".archer-browser-dialog-heading").boundingBox();
    const contentBefore = await dialog.locator(".archer-browser-content").boundingBox();

    const filesSection = dialog
      .locator("section.archer-filter-section")
      .filter({ has: page.getByText("Files", { exact: true }) });
    const discussionsSection = dialog
      .locator("section.archer-filter-section")
      .filter({ has: page.getByText("Discussions", { exact: true }) });
    const datesSection = dialog
      .locator("section.archer-filter-section")
      .filter({ has: page.getByText("Dates", { exact: true }) });
    await expect(filesSection).toBeVisible();
    await expect(discussionsSection).toBeVisible();
    await expect(datesSection).toBeVisible();

    await expect(dialog.locator("summary")).toHaveCount(0);
    await expect(filesSection.getByRole("group", { name: "Kind", exact: true })).toContainText("Diagrams");
    await expect(filesSection.getByRole("group", { name: "Kind", exact: true })).toContainText("Notes");
    await expect(
      filesSection.getByRole("group", { name: "Diagram type", exact: true }).getByRole("checkbox"),
    ).toHaveCount(1);
    await expect(filesSection.getByLabel("Folder", { exact: true })).toBeVisible();
    await expectCohesiveFileFacets(filesSection, viewport);
    await expectClearFilterEdges(dialog);

    await expect(discussionsSection.getByRole("group", { name: "Status", exact: true })).toContainText(
      "Does not compile",
    );
    await expect(discussionsSection.getByRole("group", { name: "Status", exact: true })).toContainText(
      "Has open threads",
    );

    await expectNaturalDiscussionAndDateFacets(dialog, viewport);

    const total = discussionsSection.getByRole("group", { name: "Total threads" });
    await total.getByRole("combobox", { name: "Total threads condition" }).selectOption("between");
    const minimum = total.getByRole("spinbutton", { name: "Minimum" });
    const maximum = total.getByRole("spinbutton", { name: "Maximum" });
    await minimum.fill("4");
    await maximum.fill("12");
    await expectContentFits(dialog);
    const [minimumBox, maximumBox] = await Promise.all([minimum.boundingBox(), maximum.boundingBox()]);
    expect(minimumBox).not.toBeNull();
    expect(maximumBox).not.toBeNull();
    expect(minimumBox!.x + minimumBox!.width, "the range inputs do not overlap").toBeLessThanOrEqual(maximumBox!.x);
    expect(Math.abs(minimumBox!.y - maximumBox!.y), "the range inputs stay grouped on one line").toBeLessThanOrEqual(1);
    await expect.poll(() => new URL(page.url()).searchParams.get("total")).toBe("4..12");

    const editedFacet = datesSection.getByRole("group", { name: "Edited", exact: true });
    const edited = editedFacet.getByLabel("Edited", { exact: true });
    await expect
      .poll(() =>
        edited.locator("option").evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value)),
      )
      .toEqual(["", "1d", "7d", "30d", "365d", "after", "before", "between"]);
    await edited.selectOption("after");
    await editedFacet.getByLabel("Date", { exact: true }).fill("2000-01-01");
    await expect.poll(() => new URL(page.url()).searchParams.get("edited")).toBe("2000-01-01..");
    await edited.selectOption("before");
    await editedFacet.getByLabel("Date", { exact: true }).fill("2100-12-31");
    await expect.poll(() => new URL(page.url()).searchParams.get("edited")).toBe("..2100-12-31");
    await edited.selectOption("between");
    await editedFacet.getByLabel("From", { exact: true }).fill("2000-01-01");
    await expect(editedFacet.getByText("Includes both dates.", { exact: true })).toBeVisible();
    await expect.poll(() => new URL(page.url()).searchParams.get("edited")).toBe("2000-01-01..2100-12-31");
    await expectContentFits(dialog);

    expect(await dialog.boundingBox()).toEqual(frameBefore);
    expect(await dialog.locator(".archer-browser-dialog-heading").boundingBox()).toEqual(headerBefore);
    expect(await dialog.locator(".archer-browser-content").boundingBox()).toEqual(contentBefore);
    await expect(dialog.getByRole("button", { name: "Close filters" })).toBeVisible();
    expect((await new AxeBuilder({ page }).include(".archer-browser-dialog").analyze()).violations).toEqual([]);

    await dialog.getByRole("button", { name: "Close filters" }).focus();
    await page.keyboard.press("Shift+Tab");
    const last = dialog
      .locator(
        "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex='-1'])",
      )
      .last();
    await expect(last).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(dialog.getByRole("button", { name: "Close filters" })).toBeFocused();
  });
}
