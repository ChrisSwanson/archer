import { KNOWN, tools, seqTools } from "./lib.mjs";
export const meta = { name: "smoke-b-seq-reorder", invariants: KNOWN };
export default async (ctx) => {
  const { ui, step, page, expect } = ctx;
  const t = tools(ctx);
  const q = seqTools({ page, ui, t });
  const note = async (label) => {
    const s = await q.snap();
    console.log(
      "PROBE",
      label,
      "| parts",
      JSON.stringify(s.participants),
      "| srcParts",
      JSON.stringify(s.srcPart),
      "| consistent",
      s.consistent,
      "| sel",
      JSON.stringify(s.selected),
      "| alerts",
      JSON.stringify(await t.alerts()),
    );
    return s;
  };
  await ui.resetProject("journeys");
  await ui.openDiagram("journeys", "diagrams/seq.mmd", { edit: true });
  await note("initial");
  await step("drag Database header left past Client", async () => {
    await ui.seq.reorderParticipant("d", "c");
    await note("after drag d before c");
  });
  // After the drag the order is d, c, s: Server is last (Move right rightly disabled), so move Client right instead.
  await step("Server is last: Move right disabled", async () => {
    await ui.select("s");
    console.log("PROBE order", JSON.stringify(await ui.seq.participants()));
    if ((await ui.seq.participants()).at(-1) === "s") await expect(t.toolbar("Move right")).toBeDisabled();
  });
  await step("select Client, Move right", async () => {
    await ui.select("c");
    await t.toolbar("Move right").click();
    await ui.settle();
    await note("after Move right (c)");
  });
  await step("Alt+Right with canvas focus", async () => {
    await page.keyboard.press("Alt+ArrowRight");
    await note("after Alt+Right");
  });
  await step("Alt+Left", async () => {
    await page.keyboard.press("Alt+ArrowLeft");
    await note("after Alt+Left");
  });
  await step("Move left at first position disabled?", async () => {
    await ui.select("d");
    console.log("PROBE Move left enabled for first participant:", await t.toolbar("Move left").isEnabled());
    await page.keyboard.press("Alt+ArrowLeft");
    await note("Alt+Left at first");
  });
  // undo/redo chain
  let n = 0;
  for (let i = 0; i < 6 && (await t.toolbar("Undo").isEnabled()); i++) {
    await ui.undo();
    n++;
    await note(`undo #${n}`);
  }
  for (let i = 0; i < n; i++) {
    await ui.redo();
    await note(`redo #${i + 1}`);
  }
};
