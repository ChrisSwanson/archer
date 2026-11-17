import { KNOWN, tools, seqTools } from "./lib.mjs";
export const meta = { name: "smoke-b-state-marker-on-marker", invariants: KNOWN };
export default async (ctx) => {
  const { ui, step, page, expect } = ctx;
  const t = tools(ctx);
  const q = seqTools({ page, ui, t });
  const fit = async () => {
    await page.getByRole("button", { name: "Fit view" }).click();
    await page.waitForTimeout(700);
  };
  await ui.resetProject("awkward");
  await ui.openDiagram("awkward", "diagrams/state-crlf.mmd", { edit: true });
  await fit();
  console.log(
    "PROBE nodes",
    JSON.stringify(await page.locator(".react-flow__node").evaluateAll((e) => e.map((x) => x.getAttribute("data-id")))),
  );
  await step("select start marker, click Start", async () => {
    await ui.select("root_start");
    await t.part("Start").click();
    await q.quiet(600);
    console.log(
      "PROBE after Start on marker: src",
      JSON.stringify((await t.src()).split("\n").filter((l) => /\[\*\]/.test(l))),
      "alerts",
      JSON.stringify(await t.alerts()),
    );
  });
  await step("select start marker, click End", async () => {
    await ui.select("root_start");
    await t.part("End").click();
    await q.quiet(600);
    console.log(
      "PROBE after End on start marker: src",
      JSON.stringify((await t.src()).split("\n").filter((l) => /\[\*\]/.test(l))),
      "alerts",
      JSON.stringify(await t.alerts()),
    );
  });
  await t.shot("marker-on-marker");
  await ui.save({ expectExit: true }).catch((e) => console.log("PROBE save failed", String(e).slice(0, 200)));
  console.log(
    "PROBE saved:",
    JSON.stringify(await ui.readProjectFile("awkward", ".archer/diagrams/state-crlf.mmd").catch(() => "n/a")),
  );
};
