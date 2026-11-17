// Shared helpers for smoke-a journeys (not a journey itself).
export const KNOWN = {
  "duplicate-requests": { severity: "warn", reason: "known" },
  "requests-per-view": { severity: "warn", reason: "known" },
  "label-focus": { severity: "warn", reason: "known: focus to body" },
};
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
export const udiff = (a, b) => {
  const d = mkdtempSync(join(tmpdir(), "smoke-a-diff-"));
  writeFileSync(join(d, "a"), a);
  writeFileSync(join(d, "b"), b);
  return (
    spawnSync("diff", ["-u", "--strip-trailing-cr", "-L", "before", "-L", "after", join(d, "a"), join(d, "b")], {
      encoding: "utf8",
    }).stdout || "(no diff)"
  );
};
/** Where screenshots go: $ARCHER_JOURNEY_SHOTS, else a folder under the system temp directory. */
const SHOTS = join(process.env.ARCHER_JOURNEY_SHOTS ?? join(tmpdir(), "archer-journey-shots"), "smoke-a");
export const hasCrlf = (t) => /\r\n/.test(t);
export const mk = ({ ui, step, expect, page }) => {
  const toolbar = page.getByRole("toolbar", { name: "Editing tools" });
  const bar = page.locator(".authoring-parts");
  const L = (...a) => console.log(...a);
  let h;
  h = {
    toolbar,
    bar,
    /** The Mermaid source (ui.editorSource: open, or opened and closed again; a textarea or the CodeMirror editor). */
    srcQuiet: () => ui.editorSource(),
    /** Print the Mermaid source under a label and return it. */
    src: async (t) => {
      const s = await ui.editorSource();
      L(`--- SRC ${t}\n${s}\n---`);
      return s;
    },
    shot: (n) =>
      step(`shot ${n}`, async () => {
        await page.screenshot({ path: join(SHOTS, `${n}.png`) });
      }),
    part: (name) => step(`click part ${name}`, () => bar.getByRole("button", { name, exact: true }).click()),
    btn: (name) =>
      step(`click ${name}`, async () => {
        await toolbar.getByRole("button", { name, exact: true }).click();
        await ui.settle();
      }),
    /** Click a toolbar button only when it is offered and enabled (Reset layout: flowcharts only, disabled until something moved). */
    btnIfEnabled: (name) =>
      step(`click ${name} (if enabled)`, async () => {
        const b = toolbar.getByRole("button", { name, exact: true });
        if (!(await b.count())) {
          L(`NOTE ${name} not offered here`);
          return false;
        }
        if (!(await b.isEnabled())) {
          L(`NOTE ${name} disabled`);
          return false;
        }
        await b.click();
        await ui.settle();
        return true;
      }),
    alert: async () => (await page.getByRole("alert").allTextContents()).map((s) => s.trim()).filter(Boolean),
    nodes: () => page.locator(".react-flow__node").evaluateAll((els) => els.map((e) => e.getAttribute("data-id"))),
    edges: () => page.locator(".react-flow__edge").evaluateAll((els) => els.map((e) => e.getAttribute("data-id"))),
    fit: () =>
      step("Fit view", async () => {
        await page.getByRole("button", { name: "Fit view" }).click();
        await page.waitForTimeout(500);
      }),
    zoomOut: (n = 2) =>
      step(`Zoom out x${n}`, async () => {
        for (let i = 0; i < n; i++) {
          await page.getByRole("button", { name: "Zoom out" }).click();
          await page.waitForTimeout(250);
        }
      }),
    vp: () => page.evaluate(() => document.querySelector(".react-flow__viewport")?.style.transform),
    /** Pan the canvas by dragging empty background (select mode); falls back to the hand button. Logs whether a plain drag pans. */
    panBy: (dx, dy = 0) =>
      step(`pan by ${dx},${dy}`, async () => {
        const before = await page.evaluate(() => document.querySelector(".react-flow__viewport")?.style.transform);
        const x0 = 700,
          y0 = 300;
        await page.mouse.move(x0, y0);
        await page.mouse.down();
        await page.mouse.move(x0 + dx / 2, y0 + dy / 2, { steps: 5 });
        await page.mouse.move(x0 + dx, y0 + dy, { steps: 5 });
        await page.mouse.up();
        const after = await page.evaluate(() => document.querySelector(".react-flow__viewport")?.style.transform);
        if (before === after) {
          await page.mouse.move(x0, y0);
          await page.mouse.wheel(-dx, -dy);
          await page.waitForTimeout(300);
          console.log(
            "NOTE wheel pan ->",
            await page.evaluate(() => document.querySelector(".react-flow__viewport")?.style.transform),
          );
        }
        console.log(
          `NOTE plain background drag in select mode: ${before} -> ${after} (${before === after ? "NO PAN" : "panned"})`,
        );
      }),
    /** Select an edge by clicking along its path: the harness helper, which first brings the edge into the canvas
     * (an edge below the fold or under the first-use hint could not be picked by clicks at fixed fractions). */
    selectEdge: (id) => ui.selectEdge(id),
    /** After Save in place: diff the file against what it was before (minimal-edit check). */
    diffFile: (slug, rel, before) =>
      step(`diff ${rel}`, async () => {
        const after = await ui.readProjectFile(slug, rel);
        console.log(
          `--- DIFF ${rel} (crlf before=${hasCrlf(before)} after=${hasCrlf(after)} mixed=${hasCrlf(after) && /(^|[^\r])\n/.test(after)})\n${udiff(before, after)}\n---`,
        );
      }),
    /** Select an edge (h.selectEdge) then drag its end onto `toId`: where = 'handle' | 'body' | {x,y}. Returns the new edge ids list. */
    reattach: (edgeId, end, toId, where = "handle") =>
      step(`reattach ${edgeId} ${end} -> ${toId} (${typeof where === "string" ? where : "xy"})`, async () => {
        await h.selectEdgeNow(edgeId);
        const upd = page.locator(`.react-flow__edge[data-id="${edgeId}"] .react-flow__edgeupdater-${end}`);
        const ub = await upd.boundingBox();
        const nb = await page.locator(`.react-flow__node[data-id="${toId}"]`).boundingBox();
        if (!ub || !nb) throw new Error(`geometry missing updater=${JSON.stringify(ub)} node=${JSON.stringify(nb)}`);
        let to;
        if (typeof where === "object") to = where;
        else if (where === "body") to = { x: nb.x + nb.width / 2, y: nb.y + nb.height / 2 };
        else {
          const hb = await page
            .locator(`.react-flow__node[data-id="${toId}"] .react-flow__handle.${end}`)
            .first()
            .boundingBox();
          to = { x: hb.x + hb.width / 2, y: hb.y + hb.height / 2 };
        }
        await ui.drag({ x: ub.x + ub.width / 2, y: ub.y + ub.height / 2 }, to);
        await ui.settle();
        console.log(
          `NOTE reattach ${edgeId} ${end}->${toId} (${typeof where === "string" ? where : "xy"}); updater ${Math.round(ub.width)}px; alerts ${JSON.stringify(await h.alert())}; edges now ${(await h.edges()).filter((e) => e.includes(toId) || e === edgeId).join(",")}`,
        );
      }),
    selectEdgeNow: async (id) => {
      const edge = page.locator(`.react-flow__edge[data-id="${id}"]`);
      for (const f of [0.5, 0.3, 0.7, 0.2, 0.8, 0.4, 0.6]) {
        const pt = await edge
          .locator(".react-flow__edge-path")
          .first()
          .evaluate((p, f) => {
            const m = p.getScreenCTM();
            const q = p.getPointAtLength(p.getTotalLength() * f);
            return { x: q.x * m.a + q.y * m.c + m.e, y: q.x * m.b + q.y * m.d + m.f };
          }, f);
        await page.mouse.click(pt.x, pt.y);
        if (/\bselected\b/.test((await edge.getAttribute("class")) ?? "")) return;
      }
      throw new Error(`could not select edge ${id}`);
    },
    note: (...a) => step(`NOTE ${a.join(" ")}`, async () => L("NOTE", ...a)),
    /** Undo the last edit unless the service refused it: a refused edit changed nothing, so there is nothing of it to
     * undo (Undo may be disabled). A refusal is on screen as an alert; without one, Undo runs as usual. */
    undoUnlessRefused: async () => {
      const refused = (await h.alert()).length > 0;
      if (!refused) return ui.undo();
      return step("Undo skipped: the edit was refused (nothing changed)", async () =>
        L("NOTE refused, no undo:", JSON.stringify(await h.alert())),
      );
    },
  };
  return h;
};
