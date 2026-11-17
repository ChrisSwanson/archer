import { KNOWN, tools, seqTools } from "./lib.mjs";
export const meta = { name: "smoke-b-seq-draw", invariants: KNOWN };
export default async (ctx) => {
  const { ui, step, page, expect } = ctx;
  const t = tools(ctx);
  const q = seqTools({ page, ui, t });
  const note = async (label) => {
    const s = await q.snap();
    console.log(
      "PROBE",
      label,
      "|",
      JSON.stringify(s.messages),
      "| src:",
      s.src.replace(/participant \w+ as \w+ ⏎ /g, ""),
      "| sel",
      JSON.stringify(s.selected),
      "panel",
      s.panel,
      "| alerts",
      JSON.stringify(await t.alerts()),
    );
    return s;
  };
  await ui.resetProject("journeys");
  await ui.openDiagram("journeys", "diagrams/seq.mmd", { edit: true });
  await note("initial");
  const headBottom = async () => {
    const b = await ui.locators.participant("c").locator(".archer-seq-participant-box").boundingBox();
    return b.y + b.height;
  };
  const rowY = async (id) => {
    const b = await ui.locators.message(id).boundingBox();
    return b.y + b.height / 2;
  };
  await step("draw before first", async () => {
    const m = await ui.seq
      .drawMessage("c", "d", { atY: (await headBottom()) + 14, label: "before-first" })
      .catch((e) => {
        console.log("PROBE draw before-first failed:", String(e).slice(0, 150));
        return null;
      });
    await t.shot("seq-draw-before-first");
    await note("after before-first " + m);
  });
  await step("draw in middle (between msg rows 2 and 3)", async () => {
    const ms = await ui.seq.messages();
    const a = await rowY(ms[1].id),
      b = await rowY(ms[2].id);
    const m = await ui.seq.drawMessage("s", "c", { atY: (a + b) / 2 + 6, label: "middle" }).catch((e) => {
      console.log("PROBE draw middle failed:", String(e).slice(0, 150));
      return null;
    });
    await note("after middle " + m);
  });
  await step("draw after last", async () => {
    const m = await ui.seq.drawMessage("d", "s", { label: "after-last" });
    await note("after after-last " + m);
  });
  await step("draw far below last message", async () => {
    const lane = await ui.locators.lifelineHit("c").boundingBox();
    const m = await ui.seq.drawMessage("c", "s", { atY: lane.y + lane.height - 20, label: "far-below" }).catch((e) => {
      console.log("PROBE far-below failed:", String(e).slice(0, 150));
      return null;
    });
    await note("after far-below " + m);
  });
  await step("draw self message (same lifeline)", async () => {
    const lane = await ui.locators.lifelineHit("s").boundingBox();
    const a = { x: lane.x + lane.width / 2, y: lane.y + lane.height - 60 };
    await t.slowDrag(a, { x: a.x + 3, y: a.y }, 10);
    await page.waitForTimeout(600);
    console.log(
      "PROBE self-draw editor:",
      await ui.locators
        .openLabelInput()
        .isVisible()
        .catch(() => false),
    );
    await page.keyboard.press("Escape");
    await note("after self draw attempt");
  });
  // each arrow type
  for (const [part, from, to] of [
    ["Reply", "c", "s"],
    ["Async", "s", "d"],
    ["Message", "d", "c"],
  ]) {
    await step(`draw ${part}`, async () => {
      await t.part(part).click();
      const m = await ui.seq.drawMessage(from, to, { label: `via ${part}` }).catch((e) => {
        console.log("PROBE draw", part, "failed:", String(e).slice(0, 150));
        return null;
      });
      await note(`after ${part} ${m}`);
    });
  }
  await t.shot("seq-draw-end");
  await step("undo 5", async () => {
    for (let i = 0; i < 5; i++) await ui.undo();
    await note("after 5 undos");
  });
  await step("redo 5", async () => {
    for (let i = 0; i < 5; i++) await ui.redo();
    await note("after 5 redos");
  });
  await ui.save();
  await step("saved", async () =>
    console.log("SAVED_SEQ_DRAW\n" + (await ui.readProjectFile("journeys", ".archer/diagrams/seq.mmd"))),
  );
};
