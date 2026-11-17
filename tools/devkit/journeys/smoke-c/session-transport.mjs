// Session/transport: old /-/edit/?viewId redirect, ?edit/?source survive reload and Back, draft recovery,
// Cancel dialog, navigate-away from a dirty editor, agent write while editing, Save-as refusals.
import { KNOWN } from "../flowchart-create.mjs";
import { writeFileSync } from "node:fs";
export const meta = { name: "smoke-c-session-transport", invariants: { ...KNOWN, "editor-alert": false } };
export default async ({ ui, step, expect, page, sandbox }) => {
  const O = sandbox.origin.replace(/\/$/, "");
  await ui.resetProject("pageturner");
  const dirty = async (name) => {
    await page.locator(".authoring-parts").getByRole("button", { name: "Participant", exact: true }).click();
    const i = ui.locators.openLabelInput();
    await i.fill(name);
    await i.press("Enter");
    await ui.settle();
  };
  const status = async () => (await ui.status()) ?? "";
  await step("old /-/edit/?viewId= redirects into ?edit", async () => {
    await page.goto(`${O}/projects/pageturner/-/edit/?viewId=diagrams/checkout.mmd`);
    await expect(ui.locators.editor()).toBeVisible();
    expect(page.url()).toContain("edit");
    expect(page.url(), "address should be the canonical diagram path, not /p/<slug>/views/<id>/").toContain(
      "/diagrams/checkout.mmd",
    );
  });
  await ui.openDiagram("pageturner", "diagrams/checkout.mmd", { edit: true });
  await step("pristine editor says no changes", async () => expect(await status()).toContain("no changes"));
  await dirty("Recovered");
  await step("reload mid-edit restores the unsaved participant", async () => {
    const n = await page.locator("g.archer-seq-participant").count();
    await page.reload();
    await ui.canvasReady();
    await expect(page.locator("g.archer-seq-participant")).toHaveCount(n);
  });
  await step("recovery tells the user the work was restored (currently only 'unsaved changes')", async () =>
    expect(await status()).toMatch(/restor|recover/i),
  );
  await step("browser Back out of a dirty editor does not ask before leaving", async () => {
    await page.goBack();
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
  });
  await ui.openDiagram("pageturner", "diagrams/checkout.mmd", { edit: true });
  await dirty("Mine");
  await step("agent writes the file while editing: editor says so before Save", async () => {
    const p = sandbox.projects.find((x) => x.slug === "pageturner").root + "/.archer/diagrams/checkout.mmd";
    const { readFileSync } = await import("node:fs");
    writeFileSync(p, readFileSync(p, "utf8").replace("Storefront", "Storefront by agent"));
    await expect(page.locator("body")).toContainText(/original changed|changed on disk|changed outside/i, {
      timeout: 4000,
    });
  });
  await step("conflict offers a way to keep my work (copy/proposal) next to the message", async () => {
    await ui.locators.button("Save", page.locator(".authoring-toolbar")).click();
    await expect(page.getByRole("button", { name: /save (as )?proposal|keep my|copy my/i }).first()).toBeVisible({
      timeout: 3000,
    });
  });
  await ui.resetProject("pageturner");
  await ui.newDiagram("pageturner", { type: "Flowchart", saveAs: "diagrams/checkout.mmd" });
  await ui.addPart("Process", { name: "A" });
  await step("Save as an existing path is refused in plain words", async () => {
    await ui.locators.button("Save", page.locator(".authoring-toolbar")).click();
    await expect(page.locator("body")).toContainText(/already exists/i, { timeout: 4000 });
  });
  await step("after fixing the path Save works again", async () => {
    await page.getByLabel("Save as", { exact: true }).fill("diagrams/fresh-" + Date.now().toString(36) + ".mmd");
    await expect(ui.locators.button("Save", page.locator(".authoring-toolbar"))).toBeEnabled();
  });
};
