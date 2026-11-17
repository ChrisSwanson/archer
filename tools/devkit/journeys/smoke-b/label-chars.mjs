import { KNOWN, tools, seqTools } from "./lib.mjs";
export const meta = { name: "smoke-b-label-chars", invariants: KNOWN };
export default async (ctx) => {
  const { ui, step, page, expect } = ctx;
  const t = tools(ctx);
  const q = seqTools({ page, ui, t });
  const samples = [
    "semi; colon",
    "hash # sign",
    "a %% b",
    "<b>tag</b>",
    'say "q"',
    "a & b",
    "x -> y",
    "key: value",
    "back\\slash",
    "unicode — ü 日本",
    "{curly}",
    "(paren) [brk]",
    "ends with ;",
    "#59; literal",
  ];
  await ui.resetProject("journeys");
  await ui.resetProject("awkward");
  await ui.openDiagram("journeys", "diagrams/seq.mmd", { edit: true });
  await q.quiet(300);
  for (const s of samples) {
    await step(`seq message label ${JSON.stringify(s)}`, async () => {
      await ui.locators.message("msg-0").dblclick();
      const i = ui.locators.openLabelInput();
      await i.fill(s);
      await i.press("Enter");
      await q.quiet(450);
      // A refused label stays on screen read-only for ~4 s (app bug, reported): let it close before the next edit.
      await expect(i).toBeHidden({ timeout: 6000 });
      const al = await t.alerts();
      const line = (await t.src()).split("\n").find((l) => /c->>s/.test(l));
      console.log(
        "PROBE seq msg",
        JSON.stringify(s),
        "=>",
        JSON.stringify(line?.trim()),
        al.length ? "REFUSED " + al[0].slice(30, 80) : "ok",
        "| canvas:",
        await ui.locators.message("msg-0").getAttribute("aria-label"),
      );
    });
  }
  await ui.cancel({ discard: true });
  await ui.openDiagram("awkward", "diagrams/state-composite.mmd", { edit: true });
  await q.quiet(300);
  for (const s of samples) {
    await step(`state transition label ${JSON.stringify(s)}`, async () => {
      await ui.renameEdge("Idle--Checking", s);
      await q.quiet(300);
      const al = await t.alerts();
      const line = (await t.src()).split("\n").find((l) => /Idle --> Checking/.test(l));
      console.log(
        "PROBE state edge",
        JSON.stringify(s),
        "=>",
        JSON.stringify(line?.trim()),
        al.length ? "REFUSED " + al[0].slice(30, 80) : "ok",
      );
    });
  }
  await ui.cancel({ discard: true });
  await ui.openDiagram("awkward", "diagrams/state-composite.mmd", { edit: true });
  await q.quiet(300);
  for (const s of ["semi; colon", "key: value", "a %% b", "new\nline"]) {
    await step(`state name ${JSON.stringify(s)}`, async () => {
      await ui.rename("Report", s).catch((e) => console.log("rename err", String(e).slice(0, 80)));
      await q.quiet(300);
      const al = await t.alerts();
      const line = (await t.src()).split("\n").find((l) => /as Report|state Report/.test(l));
      console.log(
        "PROBE state name",
        JSON.stringify(s),
        "=>",
        JSON.stringify(line?.trim()),
        al.length ? "REFUSED " + al[0].slice(30, 80) : "ok",
      );
    });
  }
};
