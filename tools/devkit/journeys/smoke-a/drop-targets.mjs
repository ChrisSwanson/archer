// smoke-a: where can a connection / relationship end be dropped? handle vs element body vs empty canvas, flowchart and C4 (bug class 4 and 2).
import { KNOWN, mk } from "./lib.mjs";
export const meta = { name: "smoke-a-drop-targets", invariants: KNOWN, viewport: { width: 1440, height: 1500 } };
export default async (ctx) => {
  const { ui, step, expect, page } = ctx;
  const h = mk(ctx);
  const mid = (b) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
  for (const [type, parts] of [
    [
      "Flowchart",
      [
        ["Process", "A"],
        ["Process", "B"],
        ["Process", "C"],
      ],
    ],
    [
      "C4 container",
      [
        ["Container", "A"],
        ["Container", "B"],
        ["Container", "C"],
      ],
    ],
  ]) {
    await h.note(`===== ${type}`);
    await ui.resetProject("journeys");
    await ui.newDiagram("journeys", { type, saveAs: `diagrams/smoke-a-drop-${Date.now().toString(36)}.mmd` });
    const ids = [];
    for (const [p, n] of parts) ids.push(await ui.addPart(p, { name: n }));
    if (type === "Flowchart") {
      await h.panBy(-300);
    }
    await h.shot(`drop-${type[0]}-1`);
    const [a, b, c] = ids;
    const count = async () => (await h.edges()).length;
    const tryConnect = async (label, targetOf) =>
      step(label, async () => {
        const before = await count();
        await ui.locators.node(a).hover();
        const sh = await ui.locators.node(a).locator(".react-flow__handle.source").first().boundingBox();
        const to = await targetOf();
        await ui.drag(mid(sh), to);
        await ui.settle();
        const ii = ui.locators.openLabelInput();
        if (await ii.isVisible().catch(() => false)) {
          await ii.press("Enter");
          await ui.settle();
        }
        console.log(
          `NOTE ${type}: ${label}: edges ${before} -> ${await count()}; alerts ${JSON.stringify(await h.alert())}`,
        );
      });
    await tryConnect("connect: drop on target handle", async () =>
      mid(await ui.locators.node(b).locator(".react-flow__handle.target").first().boundingBox()),
    );
    await tryConnect("connect: drop on element body (centre)", async () =>
      mid(await ui.locators.node(c).boundingBox()),
    );
    await tryConnect("connect: drop on element body (near top edge, 12px from handle)", async () => {
      const nb = await ui.locators.node(c).boundingBox();
      return { x: nb.x + nb.width / 2 + 25, y: nb.y + 12 };
    });
    await tryConnect("connect: drop on empty canvas", async () => ({ x: 400, y: 900 }));
    await step("any alert/new element after empty drop?", async () =>
      console.log(`NOTE ${type}: nodes now ${(await h.nodes()).join(",")}`),
    );
    // reattach by body
    const e0 = (await h.edges())[0];
    await h.note(`${type} edges`, (await h.edges()).join(","));
    await h.reattach(e0, "target", c, "body");
    await h.src(`${type} after body-drop reattach`);
    // C4 relationship ids are "<from>--<to>": a reattached end renames the edge. Take the edge that now ends at c
    // (or the same id, for a flowchart's eN), never the stale one.
    const edgesNow = await h.edges();
    const e1 = edgesNow.includes(e0) ? e0 : (edgesNow.find((e) => e.endsWith(`--${c}`)) ?? edgesNow[0]);
    await h.reattach(e1, "target", c, "handle");
    await h.src(`${type} after handle-drop reattach`);
    await ui.cancel({ discard: true });
  }
};
