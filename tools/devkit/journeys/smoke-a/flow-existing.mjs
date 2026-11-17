// smoke-a: existing flowcharts (clean, styled, CRLF, positioned, 150-node): rename, add+connect, reattach, move, delete edge, save; diff the file.
import { KNOWN, mk } from "./lib.mjs";
export const meta = {
  name: "smoke-a-flow-existing",
  invariants: { ...KNOWN, "pointer-mode": { severity: "warn", reason: "recorded" } },
  timeoutMs: 600000,
};
const FILES = [
  ["journeys", "diagrams/flow.mmd"],
  ["awkward", "diagrams/flow-styled.mmd"],
  ["awkward", "diagrams/flow-crlf.mmd"],
  ["awkward", "diagrams/flow-positioned.mmd"],
  ["awkward", "diagrams/flow-large.mmd"],
];
export default async (ctx) => {
  const { ui, step, expect, page } = ctx;
  const h = mk(ctx);
  for (const [slug, file] of FILES) {
    await h.note(`===== ${slug}/${file}`);
    await ui.resetProject(slug);
    const before = await ui.readProjectFile(slug, `.archer/${file}`);
    await ui.openDiagram(slug, file, { edit: true });
    const nodes = await h.nodes();
    await h.note("nodes", nodes.length, "edges", (await h.edges()).length);
    await h.shot(`existing-${file.replace(/\W/g, "_")}-1-open`);
    await h.fit();
    await h.shot(`existing-${file.replace(/\W/g, "_")}-2-fit`);
    // pick plain nodes (not groups)
    const plain = await page
      .locator(".react-flow__node-archer-node, .react-flow__node:not(.react-flow__node-group)")
      .evaluateAll((els) => els.map((e) => e.getAttribute("data-id")));
    const target = plain[0];
    await ui.rename(target, "Renamed by smoke");
    const idsBefore = new Set(await h.nodes());
    let z = await ui.addPart("Process", { name: "Zed" });
    // addPart waits 3 s for the name editor; on flow-large under load the part can take longer to appear (the
    // 150-node add is slow: smoke-a#3). Find the new node and name it, and log how late it was.
    if (z === undefined)
      z = await step(
        "find the slow new part and name it Zed",
        async () => {
          const t0 = Date.now();
          await expect
            .poll(async () => (await h.nodes()).some((id) => !idsBefore.has(id)), { timeout: 15_000 })
            .toBe(true);
          const id = (await h.nodes()).find((x) => !idsBefore.has(x));
          const input = ui.locators.openLabelInput();
          if (await input.isVisible().catch(() => false)) {
            await input.fill("Zed");
            await input.press("Enter");
            await expect(input).toBeHidden();
          } else await ui.rename(id, "Zed");
          await ui.settle();
          console.log(`NOTE slow add on ${file}: new part ${id} named ${Date.now() - t0} ms after addPart gave up`);
          return id;
        },
        { labelEdit: true },
      );
    // Connect to… menu
    await h.part("Arrow");
    await ui.select(z);
    await step("Connect to… (Zed → first node)", async () => {
      await h.toolbar.getByRole("button", { name: "Connect to…" }).click();
      const items = page.getByRole("menu").getByRole("menuitem");
      console.log("NOTE menu items:", await items.count());
      await items.first().click();
      await ui.settle();
      console.log("NOTE alerts:", JSON.stringify(await h.alert()));
    });
    await h.src(`${file} after rename + add + connect`);
    await ui.moveNode(z, 0, 90);
    await ui.save();
    await step("status after save", async () => console.log("NOTE url", page.url()));
    await h.diffFile(slug, `.archer/${file}`, before);
    await ui.openDiagram(slug, file);
    await h.shot(`existing-${file.replace(/\W/g, "_")}-3-reading`);
  }
};
