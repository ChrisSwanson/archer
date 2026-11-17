import { KNOWN, tools } from "./lib.mjs";
export const meta = { name: "smoke-b-state-existing", invariants: KNOWN };
export default async (ctx) => {
  const { ui, step, page, expect } = ctx;
  const t = tools(ctx);
  const lines = async (re) => (await t.src()).split("\n").filter((l) => re.test(l));
  const fit = async () => {
    await page.getByRole("button", { name: "Fit view" }).click();
    await page.waitForTimeout(900);
  };
  const vp = () => page.locator(".react-flow__viewport").evaluate((e) => e.style.transform);
  await ui.resetProject("awkward");
  await ui.openDiagram("awkward", "diagrams/state-composite.mmd", { edit: true });
  await fit();
  // 1 double-click rename must not zoom
  const before = await vp();
  await ui.rename("Report", "Reporting");
  await t.probe("dblclick rename: viewport changed?", async () => ({
    before,
    after: await vp(),
    src: await lines(/Report/),
  }));
  // dblclick on a start marker / choice / composite frame
  for (const id of ["Route", "Working", "root_start"]) {
    const v0 = await vp();
    await ui.locators
      .node(id)
      .dblclick({ position: { x: 8, y: 8 } })
      .catch((e) => console.log("dbl fail", id, String(e).slice(0, 100)));
    await page.waitForTimeout(400);
    console.log(
      "PROBE dblclick",
      id,
      "input open:",
      await ui.locators
        .openLabelInput()
        .isVisible()
        .catch(() => false),
      "viewport changed:",
      v0 !== (await vp()),
      "alerts",
      JSON.stringify(await t.alerts()),
    );
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
  }
  // 2 markers: Start/End with nothing selected
  await page.mouse.click(700, 560); // empty canvas deselect
  await t.part("Start").click();
  await t.probe("Start with nothing selected", async () => ({ al: await t.alerts(), src: await lines(/\[\*\]/) }));
  await t.part("End").click();
  await t.probe("End with nothing selected", async () => ({ al: await t.alerts() }));
  // add states
  const s1 = await ui.addPart("State", { name: "Paused" });
  await fit();
  const ch = await ui.addPart("Choice", { name: "Decide" }).catch(() => null);
  await t.probe("choice add: id/label", async () => ({ ch, src: await lines(/choice|Paused|Decide/) }));
  await fit();
  // Start on selected state
  await ui.select(s1);
  await t.part("Start").click();
  await ui.settle();
  await t.probe("Start on selected Paused", async () => ({ l: await lines(/Paused/), al: await t.alerts() }));
  await t.part("End").click();
  await ui.settle();
  await t.probe("End on selected Paused", async () => ({ l: await lines(/Paused/) }));
  // second Start on same state (dup)
  await t.part("Start").click();
  await ui.settle();
  await t.probe("2nd Start on Paused (dup)", async () => ({ l: await lines(/Paused/), al: await t.alerts() }));
  // Start on a choice, on a composite, on a pseudo-state
  await ui.select("Route");
  await t.part("End").click();
  await ui.settle();
  await t.probe("End on choice Route", async () => ({ l: await lines(/Route/), al: await t.alerts() }));
  await ui.select("Working");
  await t.part("End").click();
  await ui.settle();
  await t.probe("End on composite Working", async () => ({
    l: await lines(/Working --> \[\*\]|Working-->/),
    al: await t.alerts(),
  }));
  await ui.select("Run");
  await t.part("Start").click();
  await ui.settle();
  await t.probe("Start on nested composite Run", async () => ({
    l: await lines(/\[\*\] --> Run/),
    al: await t.alerts(),
  }));
  await fit();
  // 3 transitions by drag
  await t.part("Transition").click();
  await t.gconnect(s1, "Idle");
  let inp = ui.locators.openLabelInput();
  const o1 = await inp.isVisible().catch(() => false);
  console.log("PROBE label editor after transition drag:", o1);
  if (o1) {
    await inp.fill("resume");
    await inp.press("Enter");
    await ui.settle();
  }
  await fit();
  await t.gconnect("Notify", s1);
  inp = ui.locators.openLabelInput();
  if (await inp.isVisible().catch(() => false)) {
    await inp.fill("note: a; b");
    await inp.press("Enter");
    await ui.settle();
  }
  await t.probe("transitions", async () => ({ l: await lines(/Paused|Notify/), al: await t.alerts() }));
  // into composite / out of composite / from nested to outer / self-loop
  await fit();
  await t.gconnect(s1, "Working");
  inp = ui.locators.openLabelInput();
  if (await inp.isVisible().catch(() => false)) {
    await inp.press("Enter");
    await ui.settle();
  }
  await t.probe("transition into composite Working", async () => ({
    l: await lines(/Paused --> Working/),
    al: await t.alerts(),
  }));
  await t.gconnect("Compile", "Idle");
  inp = ui.locators.openLabelInput();
  if (await inp.isVisible().catch(() => false)) {
    await inp.press("Enter");
    await ui.settle();
  }
  await t.probe("transition nested Compile -> outer Idle", async () => ({
    l: await lines(/Compile/),
    al: await t.alerts(),
  }));
  await t.gconnect(s1, s1);
  inp = ui.locators.openLabelInput();
  if (await inp.isVisible().catch(() => false)) {
    await inp.press("Enter");
    await ui.settle();
  }
  await t.probe("self loop", async () => ({ l: await lines(/Paused --> Paused/), al: await t.alerts() }));
  await t.shot("state-1-edits");
  // 4 Connect to… (keyboard) from Idle
  await ui.select("Idle");
  await t.toolbar("Connect to…").click();
  const menu = page.getByRole("menu", { name: /^Connect .* to$/ });
  console.log("PROBE connect menu:", JSON.stringify(await menu.getByRole("menuitem").allTextContents()));
  await menu.getByRole("menuitem").first().click();
  await ui.settle();
  inp = ui.locators.openLabelInput();
  if (await inp.isVisible().catch(() => false)) {
    await inp.fill("via menu");
    await inp.press("Enter");
    await ui.settle();
  }
  await t.probe("Connect to…", async () => lines(/via menu/));
  // 5 rename transitions
  await ui.renameEdge("Idle--Checking", "poll now");
  await ui.renameEdge("Route--Working", "");
  await ui.renameEdge("Compile--Execute", 'done: <ok> & "q"');
  await t.probe("renamed transitions", async () => lines(/poll now|Route --> Working|Compile --> Execute/));
  // 6 reattach: from start marker, into composite, out of composite
  await ui.reattachEdge("root_start--Idle", "target", "Notify").catch(() => {});
  await t.probe("reattach start->Notify", async () => ({ l: await lines(/\[\*\] --> /), al: await t.alerts() }));
  await ui.reattachEdge("root_start--Notify", "source", "Report").catch(() => {});
  await t.probe("reattach start marker source -> Report", async () => ({
    l: await lines(/\[\*\] --> /),
    al: await t.alerts(),
  }));
  await ui.reattachEdge("Route--Idle", "target", "Working").catch(() => {});
  await t.probe("reattach target into composite", async () => ({ l: await lines(/Route --> /), al: await t.alerts() }));
  await ui.reattachEdge("Working--Split", "source", "Idle").catch(() => {});
  await t.probe("reattach composite-out source", async () => ({ l: await lines(/Split/), al: await t.alerts() }));
  await ui.reattachEdge("Fetch--Run", "target", "Idle").catch(() => {});
  await t.probe("reattach nested target to outer", async () => ({
    l: await lines(/Fetch --> /),
    al: await t.alerts(),
  }));
  await ui.reattachEdge("Run_start--Compile", "source", "Fetch").catch(() => {});
  await t.probe("reattach nested start source", async () => ({ l: await lines(/\[\*\] --> /), al: await t.alerts() }));
  await t.shot("state-2-reattach");
  // 7 delete: referenced, composite, marker, note target, transition
  for (const id of ["Idle", "Working", "Route", "Notify", "root_end", "Merge"]) {
    await ui.select(id).catch(() => {});
    await ui.deleteSelected().catch(() => {});
    await t.probe(`delete ${id}`, async () => ({ al: await t.alerts(), still: await ui.locators.node(id).count() }));
    await page.keyboard.press("Escape");
  }
  await ui.select("Merge--Idle").catch(() => {});
  await ui.deleteSelected().catch(() => {});
  // 8 undo/redo everything
  let n = 0;
  while ((await t.toolbar("Undo").isEnabled()) && n < 80) {
    await ui.undo();
    n++;
  }
  const orig = await ui.readProjectFile("awkward", ".archer/diagrams/state-composite.mmd");
  await t.probe("undo all", async () => ({ n, same: (await t.src()).trim() === orig.trim() }));
  let r = 0;
  while ((await t.toolbar("Redo").isEnabled()) && r < 80) {
    await ui.redo();
    r++;
  }
  await t.probe("redo all", async () => ({ r }));
  await ui.save();
  await step("saved", async () => {
    const f = await ui.readProjectFile("awkward", ".archer/diagrams/state-composite.mmd");
    console.log("SAVED_STATE\n" + f);
    expect(f).toContain("classDef bad fill:#f00");
    expect(f).toContain("note right of Route");
  });
};
