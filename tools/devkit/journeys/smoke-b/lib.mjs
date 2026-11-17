// Shared helpers for smoke-b journeys (raw, user-like interactions with evidence).
import { tmpdir } from "node:os";
import { join } from "node:path";
export const SH = join(process.env.ARCHER_JOURNEY_SHOTS ?? join(tmpdir(), "archer-journey-shots"), "smoke-b");
export const KNOWN = {
  "duplicate-requests": { severity: "warn", reason: "known" },
  "requests-per-view": { severity: "warn", reason: "known" },
  "editor-alert": { severity: "warn", reason: "refusals recorded" },
  "label-focus": { severity: "warn", reason: "known: focus to body" },
};
export const tools = ({ page, step, expect, ui }) => {
  const center = (b) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
  const t = {
    shot: (name) => page.screenshot({ path: `${SH}/${name}.png` }),
    /** The Mermaid source text. A closed pane is opened and closed again (ui.editorSource), so reading the source
     * does not leave half the canvas covered for the rest of the journey. */
    src: () => ui.editorSource(),
    alerts: () =>
      page.evaluate(() =>
        [...document.querySelectorAll(".authoring-error, [role=alert], .authoring-interaction-error")]
          .filter((e) => e.getClientRects().length)
          .map((e) => e.textContent.trim().slice(0, 300)),
      ),
    status: () =>
      page
        .locator("div.authoring-statusline")
        .first()
        .textContent()
        .then((s) => s?.trim()),
    /** Log a note into the run console (shows in console.jsonl & stdout). */
    note: (...a) => console.log("NOTE", ...a),
    /** step wrapper that records what happened without failing the journey: returns value. */
    probe: (title, fn) =>
      step(title, async () => {
        const r = await fn();
        console.log("PROBE", title, JSON.stringify(r));
        return r;
      }),
    center,
    sel: (id) => page.locator(`.react-flow__node[data-id="${id}"], g[data-seq-id="${id}"]`).first(),
    toolbar: (name) => page.getByRole("toolbar", { name: "Editing tools" }).getByRole("button", { name, exact: true }),
    part: (name) => page.locator(".authoring-parts").getByRole("button", { name, exact: true }),
    key: (k) => page.keyboard.press(k),
    /** Human-speed drag: dwell at the start, many moves, dwell before release. */
    slowDrag: async (a, b, steps = 40) => {
      await page.mouse.move(a.x, a.y);
      await page.mouse.down();
      await page.mouse.move(a.x + (b.x > a.x ? 8 : -8), a.y + 8, { steps: 3 });
      await page.mouse.move(b.x, b.y, { steps });
      await page.waitForTimeout(150);
      await page.mouse.up();
    },
    /** Click an edge at fraction f along its path (avoids label overlap); returns whether it became selected. */
    pickEdge: async (id, f = 0.25) => {
      const pt = await page.evaluate(
        ([id, f]) => {
          const p = document.querySelector(`.react-flow__edge[data-id="${id}"] .react-flow__edge-path`);
          if (!p) return null;
          const L = p.getTotalLength();
          const q = p.getPointAtLength(L * f);
          const m = p.getScreenCTM();
          return { x: q.x * m.a + q.y * m.c + m.e, y: q.x * m.b + q.y * m.d + m.f };
        },
        [id, f],
      );
      if (!pt) return false;
      await page.mouse.click(pt.x, pt.y);
      await page.waitForTimeout(200);
      return page
        .locator(`.react-flow__edge[data-id="${id}"]`)
        .evaluate((e) => /\bselected\b/.test(e.getAttribute("class")));
    },
    /** Reattach an end of an edge at human speed. Returns {picked, note}. */
    reattach: async (edgeId, end, toId, f = 0.25) => {
      const picked = await t.pickEdge(edgeId, f);
      if (!picked) return { picked };
      const upd = page.locator(`.react-flow__edge[data-id="${edgeId}"] .react-flow__edgeupdater-${end}`);
      const ub = await upd.first().boundingBox();
      if (!ub) return { picked, noUpdater: true };
      await ui.locators.node(toId).hover();
      const hb = await ui.locators.node(toId).locator(`.react-flow__handle.${end}`).first().boundingBox();
      await t.slowDrag(center(ub), center(hb));
      await ui.settle();
      await page.waitForTimeout(300);
      return { picked };
    },
    /** Graph connect by handle drag at human speed. Returns true if an edit request went out. */
    gconnect: async (from, to) => {
      const src = ui.locators.node(from);
      await src.hover();
      const a = center(await src.locator(".react-flow__handle.source").first().boundingBox());
      const b = center(await ui.locators.node(to).locator(".react-flow__handle.target").first().boundingBox());
      await t.slowDrag(a, b);
      await ui.settle();
      await page.waitForTimeout(300);
    },
  };
  return t;
};

/** Sequence helpers: consistent state snapshot after waiting for the editor to go quiet. */
export const seqTools = ({ page, ui, t }) => {
  const quiet = async (ms = 700) => {
    await ui.settle().catch(() => {});
    await page.waitForTimeout(ms);
    await ui.settle().catch(() => {});
  };
  const snap = async () => {
    await quiet();
    const dom = {
      participants: await ui.seq.participants(),
      messages: (await ui.seq.messages()).map(
        (m) =>
          m.id +
          ":" +
          (m.label || "")
            .replace(/ to .*?: /, "→")
            .replace(/\s+/g, " ")
            .slice(0, 28),
      ),
      selected: await page.evaluate(() =>
        [...document.querySelectorAll("[data-seq-id]")]
          .filter((e) => /selected/.test(e.getAttribute("class") || ""))
          .map((e) => e.getAttribute("data-seq-id")),
      ),
      panel: await page
        .getByRole("region", { name: "Selected message" })
        .isVisible()
        .catch(() => false),
    };
    const src = (await t.src())
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !/^sequenceDiagram|^autonumber/.test(l));
    const srcPart = src.filter((l) => /^(participant|actor) /.test(l)).map((l) => l.split(/\s+/)[1]);
    return {
      ...dom,
      src: src.join(" ⏎ "),
      srcPart,
      consistent: JSON.stringify(srcPart) === JSON.stringify(dom.participants),
    };
  };
  return { quiet, snap };
};
