import { KNOWN, tools, seqTools } from "./lib.mjs";
export const meta = {
  name: "smoke-b-seq-new-save",
  invariants: { ...KNOWN, "http-errors": { severity: "warn", reason: "known 409" } },
};
export default async (ctx) => {
  const { ui, step, page, expect } = ctx;
  const t = tools(ctx);
  const q = seqTools({ page, ui, t });
  await ui.resetProject("journeys");
  const path = `diagrams/smoke-b-seq-${Date.now().toString(36)}.mmd`;
  await ui.newDiagram("journeys", { type: "Sequence", saveAs: path });
  await t.shot("seqnew-0");
  const a = await ui.addPart("Actor", { name: "Shopper" });
  const b = await ui.addPart("Participant", { name: "Shop" });
  const c = await ui.addPart("Participant", { name: "Bank" });
  console.log("PROBE ids", a, b, c, JSON.stringify(await ui.seq.participants()));
  await t.part("Message").click();
  const m1 = await ui.seq.drawMessage(a, b, { label: "order" });
  const m2 = await ui.seq.drawMessage(b, c, { label: "charge" });
  await t.part("Reply").click();
  const m3 = await ui.seq.drawMessage(c, b, { label: "ok" });
  console.log("PROBE msgs", m1, m2, m3, JSON.stringify((await q.snap()).messages));
  await t.shot("seqnew-1");
  const wrapped = await ui.seq.wrap([m2, m3], "Optional").then(
    () => true,
    () => false,
  );
  await ui.seq.addNote([b]).catch(() => {});
  // Save in place writes the file and leaves the editor for the new diagram's reading page.
  await ui.save();
  await step("after save state", async () => {
    console.log(
      "PROBE url after save:",
      page.url().replace(/.*\/projects/, ""),
      "alerts:",
      JSON.stringify(await t.alerts()),
    );
    expect(new URL(page.url()).pathname).toBe(`/projects/journeys/${path}`);
    await t.shot("seqnew-after-save");
    let f = null;
    try {
      f = await ui.readProjectFile("journeys", `.archer/${path}`);
    } catch (e) {
      f = "(no file) " + e.message.slice(0, 80);
    }
    console.log("PROBE file:", JSON.stringify(f));
    expect(f).toMatch(/^sequenceDiagram/);
    for (const text of ["Shopper", "order", "charge", "ok"]) expect(f).toContain(text);
  });
};
