import { KNOWN, tools, seqTools } from "./lib.mjs";
export const meta = { name: "smoke-b-crlf", invariants: KNOWN };
export default async (ctx) => {
  const { ui, step, page, expect } = ctx;
  const t = tools(ctx);
  const q = seqTools({ page, ui, t });
  const eol = (s) => ({ crlf: (s.match(/\r\n/g) || []).length, lf: (s.match(/(?<!\r)\n/g) || []).length });
  const fit = async () => {
    await page.getByRole("button", { name: "Fit view" }).click();
    await page.waitForTimeout(800);
  };
  await ui.resetProject("awkward");
  // sequence CRLF
  await ui.openDiagram("awkward", "diagrams/seq-crlf.mmd", { edit: true });
  const m = await ui.seq.drawMessage("a", "b", { label: "third" });
  await ui.seq.addNote(["a", "b"]);
  await ui.seq.wrap([m], "Loop");
  const p = await ui.addPart("Participant", { name: "Carol" });
  await ui.seq.reorderParticipant(p, "a");
  await ui.rename("msg-0", "Hello edited");
  await ui.seq.panel.set("msg-1", { type: "async" });
  await ui.save();
  await step("seq-crlf saved", async () => {
    const f = await ui.readProjectFile("awkward", ".archer/diagrams/seq-crlf.mmd");
    console.log("PROBE seq-crlf eol:", JSON.stringify(eol(f)), JSON.stringify(f));
  });
  // state CRLF
  await ui.openDiagram("awkward", "diagrams/state-crlf.mmd", { edit: true });
  await fit();
  const s = await ui.addPart("State", { name: "Standby" });
  await fit();
  await t.part("Transition").click();
  await t.gconnect("On", s);
  const inp = ui.locators.openLabelInput();
  if (await inp.isVisible().catch(() => false)) {
    await inp.fill("idle");
    await inp.press("Enter");
    await ui.settle();
  }
  await ui.select(s);
  await t.part("End").click();
  await ui.settle();
  await ui.rename("On", "Powered on");
  await ui.renameEdge("Off--On", "flip");
  await ui.save();
  await step("state-crlf saved", async () => {
    const f = await ui.readProjectFile("awkward", ".archer/diagrams/state-crlf.mmd");
    console.log("PROBE state-crlf eol:", JSON.stringify(eol(f)), JSON.stringify(f));
  });
  // ER with CRLF? create via note crlf-note embedded: edit embedded diagram
  await ui.openDiagram("awkward", "notes/crlf-note.md", {});
  console.log("PROBE crlf-note url", page.url());
};
