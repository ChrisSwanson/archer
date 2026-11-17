import { KNOWN, tools } from "./lib.mjs";
export const meta = { name: "smoke-b-seq-existing", invariants: KNOWN };
export default async (ctx) => {
  const { ui, step, page, expect } = ctx;
  const t = tools(ctx);
  const body = async () =>
    (await t.src())
      .split("\n")
      .filter((l) => /->|--|participant|actor|Note|loop|alt|opt|par|end|autonumber|else|and/.test(l))
      .map((l) => l.trim())
      .join(" | ");
  const msgs = async () =>
    (await ui.seq.messages()).map((m) => `${m.id}:${(m.label || "").replace(/\s+/g, " ").slice(0, 40)}`);
  const panelOpen = () =>
    page
      .getByRole("region", { name: "Selected message" })
      .isVisible()
      .catch(() => false);
  const selMsg = () =>
    page
      .locator(
        "g.archer-seq-message[class*=selected], g.archer-seq-message[aria-selected=true], g.archer-seq-message[aria-pressed=true]",
      )
      .evaluateAll((e) => e.map((x) => x.getAttribute("data-seq-id")));
  const alerts = () => t.alerts();
  const note = (...a) => console.log("PROBE", ...a);
  await ui.resetProject("journeys");
  await ui.openDiagram("journeys", "diagrams/seq.mmd", { edit: true });
  await t.shot("seq-0");
  note("initial", JSON.stringify(await msgs()), JSON.stringify(await ui.seq.participants()));
  // add participants / actor
  const p1 = await ui.addPart("Participant", { name: "Cache" });
  const a1 = await ui.addPart("Actor", { name: "Admin" });
  note("added", p1, a1, JSON.stringify(await ui.seq.participants()));
  await t.shot("seq-1-added");
  // reorder by dragging header (Cache to far left), then by buttons and keys
  await ui.seq.reorderParticipant(p1, "c");
  note("after drag reorder", JSON.stringify(await ui.seq.participants()));
  await ui.select(p1);
  await t.toolbar("Move right").click();
  await ui.settle();
  note("after Move right", JSON.stringify(await ui.seq.participants()));
  await page.keyboard.press("Alt+ArrowRight");
  await ui.settle();
  note(
    "after Alt+Right",
    JSON.stringify(await ui.seq.participants()),
    "selected still?",
    await ui.locators.participant(p1).evaluate((e) => e.getAttribute("class")),
  );
  await page.keyboard.press("Alt+ArrowLeft");
  await ui.settle();
  note("after Alt+Left", JSON.stringify(await ui.seq.participants()));
  await ui.undo();
  await ui.undo();
  await ui.undo();
  note("after 3 undo", JSON.stringify(await ui.seq.participants()), await body());
  await ui.redo();
  await ui.redo();
  await ui.redo();
  // draw messages at different heights: before the first, in the middle, after last
  // Press on the lifeline in the gap between the participant headers and the first message (first.y - 18 landed on
  // the header's hit area), and between two messages for "middle" (not on a message's own centre, which picks it).
  const first = await page.locator("g.archer-seq-message").first().boundingBox();
  const head = await ui.locators.participant("c").locator(".archer-seq-participant-box").boundingBox();
  const top = (head.y + head.height + first.y) / 2;
  const m1 = await ui.seq.drawMessage("c", "d", { atY: top, label: "before-first" });
  note("drew before first:", m1, JSON.stringify(await msgs()));
  const above = await page.locator("g.archer-seq-message").nth(1).boundingBox(),
    below = await page.locator("g.archer-seq-message").nth(2).boundingBox();
  const m2 = await ui.seq.drawMessage("s", "c", { atY: (above.y + above.height + below.y) / 2, label: "middle" });
  note("drew middle:", m2, JSON.stringify(await msgs()));
  const m3 = await ui.seq.drawMessage("d", "s", { label: "after-last" });
  note("drew after last:", m3, JSON.stringify(await msgs()));
  await t.shot("seq-2-drawn");
  note("source order", await body());
  // each arrow type via parts bar: pick type then draw
  for (const [part, from, to] of [
    ["Reply", "c", "s"],
    ["Async", "s", "d"],
    ["Message", "d", "c"],
  ]) {
    await t.part(part).click();
    const id = await ui.seq.drawMessage(from, to, { label: `via ${part}` });
    note("drew with", part, id, await body());
  }
  // change type via parts bar with message selected
  const target = (await ui.seq.messages())[1].id;
  await ui.select(target);
  await t.part("Async").click();
  await ui.settle();
  note("type via parts bar on", target, "->", await body(), "panelOpen", await panelOpen());
  await t.shot("seq-3-panel");
  // via message panel
  await ui.seq.panel.set(target, { type: "reply" });
  note("type via panel ->", await body());
  // reverse
  await ui.select(target);
  await t.toolbar("Reverse message").click();
  await ui.settle();
  note("reverse ->", await body(), "selected msgs", JSON.stringify(await selMsg()), "panel", await panelOpen());
  await ui.undo();
  note("undo reverse", await body());
  await ui.undo();
  note("undo", await body());
  await ui.save();
  await step("saved", async () =>
    console.log("SAVED_SEQ\n" + (await ui.readProjectFile("journeys", ".archer/diagrams/seq.mmd"))),
  );
};
