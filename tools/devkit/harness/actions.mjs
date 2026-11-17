// User-action helpers that mirror the real page (selectors from ui/src/authoring/AuthoringWorkspace.tsx,
// families.ts, ui/src/diagrams/{DiagramCanvas,GraphNode,FigureNode,SequenceCanvas}.tsx,
// ui/src/app/SourcePanel.tsx). Every helper is one harness step, so invariants run after it.
// If the UI changes, fix the selector here once; journeys stay as they are.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { issueLink, resetPresentations, settleCorpusTimes } from "../sandbox.mjs";

const css = (s) => s.replace(/["\\]/g, "\\$&");
const center = (b) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
/** Unified diff of two texts, CR ignored (so a CRLF file diffs by content). "(no diff)" when equal. */
export const udiff = (a, b) => {
  const d = mkdtempSync(join(tmpdir(), "harness-diff-"));
  try {
    writeFileSync(join(d, "a"), a);
    writeFileSync(join(d, "b"), b);
    return (
      spawnSync("diff", ["-u", "--strip-trailing-cr", "-L", "before", "-L", "after", join(d, "a"), join(d, "b")], {
        encoding: "utf8",
      }).stdout || "(no diff)"
    );
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
};
export const hasCrlf = (t) => /\r\n/.test(t);
/** A textarea's value has LF line breaks whatever the source had: compare sources the same way. */
export const normalizeSource = (t) => String(t).replace(/\r\n?/g, "\n");

/**
 * Which drawn message is the new one (TG-b3). Located by what the page shows (from, to, label), never by the
 * open editor's `msg-N` id, which renumbers when a message is inserted above others. `before`/`after` are
 * seq.state().messages. Returns {id, index} or throws, naming any message whose label changed instead
 * (codex-arch#1: the label typed for a new message landed on another one).
 */
export function locateNewMessage(before, after, { from, to, label }) {
  const key = (m, withLabel = true) => `${m.from}>${m.to}${withLabel ? `:${m.label ?? ""}` : ""}`;
  const inserted = (withLabel) => {
    const was = before.map((m) => key(m, withLabel));
    const hits = [];
    for (let i = 0; i < after.length; i++) {
      const rest = after.filter((_, j) => j !== i).map((m) => key(m, withLabel));
      if (rest.length === was.length && rest.every((k, j) => k === was[j])) hits.push(i);
    }
    return hits;
  };
  const want = (m) => m.from === from && m.to === to && (label === undefined || (m.label ?? "") === label);
  if (after.length !== before.length + 1)
    throw new Error(
      `expected one new message ${from} → ${to}; the page shows ${before.length} before and ${after.length} after`,
    );
  const exact = inserted(true).filter((i) => want(after[i]));
  if (exact.length >= 1) return { id: after[exact[0]].id, index: exact[0] };
  // Diagnose: where the arrow went in, and which existing message's label changed.
  const loose = inserted(false);
  const at = loose.find((i) => after[i].from === from && after[i].to === to) ?? loose[0];
  const others = at === undefined ? [] : after.filter((_, j) => j !== at);
  const changed = others
    .map((m, j) => ({ id: m.id, before: before[j]?.label ?? "", after: m.label ?? "" }))
    .filter((c) => c.before !== c.after);
  const drawn =
    at === undefined
      ? "no message was inserted at one place"
      : `the new arrow ${after[at].id} (${after[at].from} → ${after[at].to}) shows "${after[at].label ?? ""}"`;
  throw new Error(
    `drew ${from} → ${to}${label === undefined ? "" : ` labelled "${label}"`}, but ${drawn}${changed.length ? `; labels changed on ${changed.map((c) => `${c.id} "${c.before}" → "${c.after}"`).join(", ")} (the label went to the wrong message)` : ""}`,
  );
}

/**
 * Press a pointer-mode button after a drag, from a resting point on the canvas. A drag that ends over the left rail
 * expands the hover navigation, which then covers the canvas controls and takes the click (the canvas stayed in
 * Hand mode and later edge clicks panned). So: move the mouse back to `rest` first, wait for the rail to collapse,
 * press, and confirm the button is pressed. Throws instead of leaving the canvas in the wrong mode.
 */
export async function pressModeButton(page, button, rest, { attempts = 3, timeout = 1500 } = {}) {
  let last = null;
  for (let i = 0; i < attempts; i++) {
    // Off the rail: the resting point itself may sit under the expanded navigation, which overlays the canvas.
    // Read without waiting: locator.boundingBox() waits the whole action timeout for a rail that is not expanded
    // (600 s in smoke-a flow-existing, once per pan), and the catch turned that wait into a silent stall.
    const rail = await page.evaluate(() => {
      const r = document.querySelector("aside.primary-navigation[data-expanded=true]")?.getBoundingClientRect();
      return r && r.width > 0 ? { x: r.x, width: r.width } : null;
    });
    await page.mouse.move(rail && rest.x <= rail.x + rail.width ? rail.x + rail.width + 40 : rest.x, rest.y);
    await page
      .locator("aside.primary-navigation[data-expanded=true]")
      .waitFor({ state: "detached", timeout })
      .catch(() => {});
    try {
      await button.click({ timeout });
      if ((await button.getAttribute("aria-pressed")) === "true") return;
      last = new Error("the button did not become pressed");
    } catch (error) {
      last = error;
    }
  }
  throw new Error(`could not switch the canvas pointer mode back: ${last?.message ?? last}`);
}

export function createUi({ page, sandbox, step, expect, run = null, entryShots = false }) {
  const origin = sandbox.origin;
  const editor = () =>
    page.getByRole("region", { name: "Diagram Editor" }).or(page.locator('section[aria-label="Diagram Editor"]'));
  // Subgraph/group frames are `group:<id>` in the DOM; a bare id finds the node, or else the group of that id.
  const node = (id) =>
    id.startsWith("group:")
      ? page.locator(`.react-flow__node[data-id="${css(id)}"]`)
      : page.locator(`.react-flow__node[data-id="${css(id)}"], .react-flow__node[data-id="group:${css(id)}"]`);
  const edge = (id) => page.locator(`.react-flow__edge[data-id="${css(id)}"]`);
  const edgePath = (id) => edge(id).locator(".react-flow__edge-path"); // the drawn line: the edge <g> reports the whole svg
  const participant = (id) => page.locator(`g.archer-seq-participant[data-seq-id="${css(id)}"]`);
  const lifelineHit = (id) => page.locator(`line.archer-seq-lifeline-hit[data-seq-id="${css(id)}"]`);
  const message = (id) => page.locator(`g.archer-seq-message[data-seq-id="${css(id)}"]`);
  const button = (name, scope = page) => scope.getByRole("button", { name, exact: true });
  // A frame (flowchart subgraph "group:<id>", C4 boundary, state composite: class archer-group) is mostly covered by
  // its children: press or hover it at its corner (the title area), never its centre.
  const isFrame = async (loc) =>
    loc
      .evaluate(
        (el) => (el.getAttribute("data-id") ?? "").startsWith("group:") || el.classList.contains("archer-group"),
      )
      .catch(() => false);
  const hoverNode = async (id) => {
    const n = node(id).first();
    await n.hover((await isFrame(n)) ? { position: { x: 12, y: 12 } } : {});
  };
  const box = async (locator, what, state = "visible") => {
    // Invisible hit targets (stroke-opacity 0, e.g. lifeline hit lines) count as hidden: wait for attached.
    await locator.first().waitFor({ state });
    const b = await locator.first().boundingBox();
    if (b === null) throw new Error(`${what} has no bounding box (not rendered?)`);
    return b;
  };
  /** A real pointer drag: press, move in steps past the 4px threshold, release. */
  const drag = async (from, to, steps = 14) => {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + (to.x > from.x ? 6 : -6), from.y + 6, { steps: 2 });
    await page.mouse.move(to.x, to.y, { steps });
    await page.mouse.up();
  };
  /** Human-speed drag: dwell at the start, many moves, dwell before release (React Flow needs a dwell on a handle). */
  const slowDrag = async (from, to, steps = 40) => {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + (to.x > from.x ? 8 : -8), from.y + 8, { steps: 3 });
    await page.mouse.move(to.x, to.y, { steps });
    await page.waitForTimeout(150);
    await page.mouse.up();
  };
  const viewportTransform = () =>
    page.evaluate(() => document.querySelector(".react-flow__viewport")?.style.transform ?? null);
  /** A point on the canvas background (nothing but the pane under it): safe to press on without moving a node. */
  const emptyPanePoint = async () => {
    const c = await page.locator(".react-flow").first().boundingBox();
    if (!c) throw new Error("no graph canvas on the page");
    return page.evaluate((c) => {
      for (let fy = 0.9; fy >= 0.1; fy -= 0.1)
        for (let fx = 0.1; fx <= 0.9; fx += 0.1) {
          const x = c.x + c.width * fx,
            y = c.y + c.height * fy,
            el = document.elementFromPoint(x, y);
          if (el?.classList.contains("react-flow__pane")) return { x, y };
        }
      return null;
    }, c);
  };
  /**
   * Pan the graph canvas by (dx, dy) screen px. A background drag in select mode draws a selection box and the
   * wheel is unreliable, so this uses Hand mode (drag the background), then goes back to Select mode (the
   * pointer-mode invariant). Returns true when the viewport moved.
   */
  const panBy = async (dx, dy = 0) => {
    const before = await viewportTransform();
    const at = await emptyPanePoint();
    if (!at) return false;
    const hand = page.getByRole("button", { name: "Hand mode", exact: true }),
      select = page.getByRole("button", { name: "Select mode", exact: true });
    const haveHand = (await hand.count()) > 0;
    if (haveHand) await hand.click();
    try {
      await page.mouse.move(at.x, at.y);
      await page.mouse.down();
      await page.mouse.move(at.x + dx / 2, at.y + dy / 2, { steps: 5 });
      await page.mouse.move(at.x + dx, at.y + dy, { steps: 5 });
      await page.mouse.up();
    } finally {
      if (haveHand) await pressModeButton(page, select, at);
    }
    let after = await viewportTransform();
    if (after === before && !haveHand) {
      await page.mouse.move(at.x, at.y);
      await page.mouse.wheel(-dx, -dy);
      await page.waitForTimeout(300);
      after = await viewportTransform();
    }
    return after !== before;
  };
  /**
   * Bring graph nodes (or edges) fully into the canvas before acting on them: pan toward their centre, then
   * zoom out a notch at a time while they still do not fit together. Sequence parts are scrolled into view.
   * Returns true when every target is inside the canvas.
   */
  const reveal = async (...locators) => {
    const inside = async () => {
      // "In view" = inside the canvas, below the headers and the floating parts bar, and the point at its
      // centre hits the canvas (not a header, bar or panel laid over it).
      const probes = [];
      for (const l of locators) {
        await l.first().waitFor({ state: "attached" });
        probes.push(
          await l.first().evaluate((el) => {
            const r = el.getBoundingClientRect(),
              canvas = document.querySelector(".react-flow")?.getBoundingClientRect();
            if (!canvas) return null;
            let top = canvas.top;
            const bottom = Math.min(canvas.bottom, innerHeight);
            for (const h of document.querySelectorAll("header, .authoring-parts")) {
              const b = h.getBoundingClientRect();
              if (b.width > 0 && b.bottom > top && b.top < bottom - 40) top = Math.max(top, b.bottom + 6);
            }
            const cx = r.x + r.width / 2,
              cy = r.y + r.height / 2;
            const hit =
              cx >= 0 && cy >= 0 && cx < innerWidth && cy < innerHeight ? document.elementFromPoint(cx, cy) : null;
            const clear =
              hit !== null &&
              (hit === el ||
                el.contains(hit) ||
                (hit.closest(".react-flow__viewport, .react-flow__pane") !== null &&
                  !hit.closest(
                    ".authoring-edit-cluster, .authoring-parts, .react-flow__controls, .authoring-message-panel, .authoring-panel, header",
                  )));
            const fits = r.x >= canvas.x + 4 && r.y >= top + 4 && r.right <= canvas.right - 4 && r.bottom <= bottom - 4;
            return {
              box: { x: r.x, y: r.y, width: r.width, height: r.height },
              ok: fits && clear,
              canvas: { x: canvas.x, y: top, width: canvas.width, height: bottom - top },
            };
          }),
        );
      }
      const have = probes.filter(Boolean);
      if (have.length === 0) return { ok: true };
      const c = have[0].canvas;
      const mx = have.reduce((a, q) => a + q.box.x + q.box.width / 2, 0) / have.length,
        my = have.reduce((a, q) => a + q.box.y + q.box.height / 2, 0) / have.length;
      return { ok: have.every((q) => q.ok), dx: c.x + c.width / 2 - mx, dy: c.y + c.height / 2 - my };
    };
    if ((await page.locator(".react-flow").count()) === 0) {
      for (const l of locators)
        await l
          .first()
          .scrollIntoViewIfNeeded()
          .catch(() => {});
      return true;
    }
    let dir = 1,
      last = null,
      zooms = 0;
    for (let attempt = 0; attempt < 7; attempt++) {
      const r = await inside();
      if (r.ok) return true;
      const dist = Math.hypot(r.dx, r.dy);
      if (last !== null && dist > last + 20) dir = -dir; // the last pan went the wrong way (drag vs wheel): turn around
      last = dist;
      const moved = await panBy(dir * Math.max(-600, Math.min(600, r.dx)), dir * Math.max(-400, Math.min(400, r.dy)));
      if ((!moved || attempt >= 3) && zooms < 3) {
        zooms++;
        await page
          .getByRole("button", { name: "Zoom out" })
          .click()
          .catch(() => {});
        await page.waitForTimeout(250);
      }
    }
    return (await inside()).ok;
  };
  /** Click along an edge's drawn path at several fractions until it is selected (its midpoint can sit under a label or another edge's end handle). */
  const selectEdgeNow = async (id) => {
    const e = page.locator(`.react-flow__edge[data-id="${css(id)}"]`);
    await reveal(e.locator(".react-flow__edge-path"));
    for (const f of [0.5, 0.3, 0.7, 0.2, 0.8, 0.4, 0.6, 0.1, 0.9, 0.15, 0.85]) {
      // Only press where the edge itself is on top: a point off screen, outside the canvas, or under a hint, panel
      // or another element would pick that instead (an edge half below the fold after reveal).
      const pt = await e
        .locator(".react-flow__edge-path")
        .first()
        .evaluate((p, f) => {
          const m = p.getScreenCTM();
          const q = p.getPointAtLength(p.getTotalLength() * f);
          const x = q.x * m.a + q.y * m.c + m.e,
            y = q.x * m.b + q.y * m.d + m.f;
          const hit = x >= 0 && y >= 0 && x < innerWidth && y < innerHeight ? document.elementFromPoint(x, y) : null;
          return { x, y, onEdge: !!hit && hit.closest(".react-flow__edge") === p.closest(".react-flow__edge") };
        }, f);
      if (!pt.onEdge) continue;
      await page.mouse.click(pt.x, pt.y);
      if (/\bselected\b/.test((await e.getAttribute("class")) ?? "")) return f;
    }
    throw new Error(`could not select edge ${id} by clicking its path`);
  };
  // TG-b4: the source the service returned for the latest accepted edit (POST …/api/authoring/edit, ok: true).
  // settle() waits until the Mermaid source pane shows it, so "the canvas changed but the source lags" fails here.
  let expectedSource = null;
  const reads = new Set();
  page.on("response", (r) => {
    let path;
    try {
      path = new URL(r.url()).pathname;
    } catch {
      return;
    }
    if (r.request().method() !== "POST" || !/\/api\/authoring\/edit$/.test(path)) return;
    const p = r
      .json()
      .then(
        (v) => {
          if (v && v.ok === true && typeof v.source === "string") expectedSource = { text: v.source, at: Date.now() };
        },
        () => {},
      )
      .finally(() => reads.delete(p));
    reads.add(p);
  });
  page.on("framenavigated", (f) => {
    if (f === page.mainFrame()) expectedSource = null;
  });
  /**
   * Wait until the editor's preview is not busy, nothing says "Checking preview…", and, when the Mermaid source
   * pane is open, it shows the source the service returned for the last edit (`{source: false}` skips that).
   */
  const settle = async (timeout = 10_000, { source = true } = {}) => {
    const preview = page.locator(".authoring-preview");
    if (await preview.count()) await expect(preview.first()).toHaveAttribute("aria-busy", "false", { timeout });
    // The parts bar is busy while an edit is checked or a fresh preview is laid out (a part picked then waits for it).
    await expect(page.locator('.authoring-parts[aria-busy="true"]')).toHaveCount(0, { timeout });
    await expect(page.locator("p.authoring-checking")).toHaveCount(0, { timeout });
    if (!source) return;
    if (reads.size) await Promise.all([...reads]);
    if (expectedSource === null) return;
    const want = normalizeSource(expectedSource.text);
    const area = page.locator("#authoring-source");
    if (!(await area.isVisible().catch(() => false))) {
      expectedSource = null;
      return;
    } // pane closed: nothing to compare
    const got = async () => normalizeSource(await sourceText(area, 1000).catch(() => ""));
    try {
      await expect
        .poll(got, { timeout: Math.min(timeout, 5000), message: "the Mermaid source pane shows the last edit" })
        .toBe(want);
    } catch {
      const now = await got();
      throw new Error(
        `the Mermaid source pane does not show the source the service returned for the last edit (${Date.now() - expectedSource.at} ms later; - the service's source, + the pane):\n${udiff(want, now).split("\n").slice(0, 30).join("\n")}`,
      );
    } finally {
      expectedSource = null;
    }
  };
  // TG-ux4: one screenshot of each editor family's entry state per viewport and theme, by default. shots/entry/.
  const shotTaken = new Set();
  const entryShot = async () => {
    if (!entryShots || !run?.dir) return;
    const facts = await page
      .evaluate(() => {
        const bar = document.querySelector(".authoring-parts")?.getAttribute("aria-label") ?? "";
        const source = document.querySelector("#authoring-source");
        const h = (s) => Math.round(document.querySelector(s)?.getBoundingClientRect().height ?? 0);
        return {
          family:
            bar
              .replace(/ parts$/, "")
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, "-") || "editor",
          theme: document.documentElement.getAttribute("data-theme") ?? "system",
          width: innerWidth,
          height: innerHeight,
          sourceOpen: source !== null,
          canvasHeight: h(".authoring-preview"),
          sourceHeight: h(".authoring-source"),
        };
      })
      .catch(() => null);
    if (!facts) return;
    const key = `${facts.family}-${facts.width}-${facts.theme}`;
    if (shotTaken.has(key)) return;
    shotTaken.add(key);
    const dir = join(run.dir, "shots", "entry");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${key}.png`);
    await page.screenshot({ path }).catch(() => {});
    (run.entryShots ??= []).push({ ...facts, path });
  };
  /** The editing canvas has drawn at least one part (large diagrams take a while to lay out). */
  const canvasReady = (timeout = 20_000) =>
    expect(page.locator(".react-flow__node, g.archer-seq-participant").first()).toBeVisible({ timeout });
  const seqState = () =>
    page.evaluate(() => {
      const svg = document.querySelector(".archer-seq-svg");
      if (!svg) return null;
      const clean = (t) => (t ?? "").replace(/\s+/g, " ").trim();
      const nameOf = (el) => clean(el.getAttribute("aria-label")).replace(/, has comments$/, "");
      const lifelines = [...document.querySelectorAll("line.archer-seq-lifeline[data-seq-lifeline]")].map((l) => ({
        id: l.getAttribute("data-seq-lifeline"),
        x: Number(l.getAttribute("x1")),
      }));
      const at = (x) => {
        let best = null;
        for (const l of lifelines) if (best === null || Math.abs(l.x - x) < Math.abs(best.x - x)) best = l;
        return best && Math.abs(best.x - x) <= 3 ? best.id : null;
      };
      const participants = [...document.querySelectorAll("g.archer-seq-participant")].map((g) => {
        const id = g.getAttribute("data-seq-id");
        const text = clean([...g.querySelectorAll("text")].map((t) => t.textContent).join(" "));
        return {
          id,
          label: nameOf(g) || text,
          x: lifelines.find((l) => l.id === id)?.x ?? null,
          selected: g.classList.contains("archer-seq-selected"),
        };
      });
      const messages = [...document.querySelectorAll("g.archer-seq-message")].map((g) => {
        const line = g.querySelector(".archer-seq-message-stroke line"),
          path = g.querySelector(".archer-seq-message-stroke path");
        let from = null,
          to = null,
          y = null;
        if (line) {
          from = at(Number(line.getAttribute("x1")));
          to = at(Number(line.getAttribute("x2")));
          y = Number(line.getAttribute("y1"));
        } else if (path) {
          const m = /M\s*([-\d.]+)\s+([-\d.]+)/.exec(path.getAttribute("d") ?? "");
          if (m) {
            from = to = at(Number(m[1]));
            y = Number(m[2]);
          }
        }
        const title = g.querySelector(":scope > title");
        const label = title
          ? clean(title.textContent)
          : clean([...g.querySelectorAll(":scope > text")].map((t) => t.textContent).join(" "));
        const name = nameOf(g),
          num = /^(\d+)\. /.exec(name)?.[1] ?? g.querySelector(".archer-seq-message-number text")?.textContent ?? null;
        return {
          id: g.getAttribute("data-seq-id"),
          number: num === null ? null : Number(num),
          from,
          to,
          label,
          kind: /archer-seq-message--(\w+)/.exec(g.getAttribute("class") ?? "")?.[1] ?? null,
          y,
          name,
          selected: g.classList.contains("archer-seq-selected"),
        };
      });
      const notes = [...document.querySelectorAll("g.archer-seq-note")].map((g) => {
        const b = g.getBBox(),
          name = nameOf(g);
        return {
          id: g.closest("[data-seq-part]")?.getAttribute("data-seq-part-id") ?? null,
          text: name.replace(/^Note [^:]*: /, ""),
          over: lifelines.filter((l) => l.x >= b.x - 2 && l.x <= b.x + b.width + 2).map((l) => l.id),
          name,
          selected: !!g.closest("[data-seq-part]")?.querySelector(":scope > rect[pointer-events='none']"),
        };
      });
      const frames = [...document.querySelectorAll("g.archer-seq-fragment")],
        headers = [...document.querySelectorAll(".archer-seq-fragment-header")];
      const fragments = frames.map((g, i) => {
        const r = g.querySelector(":scope > rect"),
          h = headers[i];
        const x = Number(r?.getAttribute("x")),
          y = Number(r?.getAttribute("y")),
          w = Number(r?.getAttribute("width")),
          ht = Number(r?.getAttribute("height"));
        const labels = h ? [...h.querySelectorAll(".archer-seq-fragment-label")].map((t) => clean(t.textContent)) : [];
        const part = h?.closest("[data-seq-part]");
        return {
          id: part?.getAttribute("data-seq-part-id") ?? null,
          kind: clean(h?.querySelector(".archer-seq-fragment-chip-text")?.textContent) || null,
          label: labels[0] ?? null,
          sections: labels.slice(1),
          messages: messages.filter((m) => m.y !== null && m.y > y && m.y < y + ht).map((m) => m.id),
          box: { x, y, width: w, height: ht },
          selected: !!part?.querySelector(":scope > rect[pointer-events='none']"),
        };
      });
      const panelEl = document.querySelector("section.authoring-message-panel");
      let panel = null;
      if (panelEl) {
        const kind = (panelEl.getAttribute("aria-label") ?? "").replace(/^Selected /, "");
        const sel = (t) =>
          [...panelEl.querySelectorAll("label")]
            .find((l) => clean(l.textContent).startsWith(t))
            ?.querySelector("select")?.value ?? null;
        panel = {
          kind,
          from: sel("From"),
          to: sel("To"),
          type: sel("Type"),
          position: panelEl.querySelector("input[aria-label='Position in the sequence']")?.value ?? null,
          text: panelEl.querySelector("textarea")?.value ?? null,
          heading: clean(panelEl.querySelector("h3")?.textContent) || null,
        };
      }
      const selection = [...document.querySelectorAll(".archer-seq-selected")].map((el) => ({
        kind: /archer-seq-(participant|message)\b/.exec(el.getAttribute("class") ?? "")?.[1] ?? "seq",
        id: el.getAttribute("data-seq-id"),
      }));
      const editor = document.querySelector(".archer-seq-label-editor input, .archer-seq-label-editor textarea");
      return {
        participants,
        messages,
        notes,
        fragments,
        selection,
        panel,
        labelEditor: editor ? { label: editor.getAttribute("aria-label"), value: editor.value } : null,
      };
    });
  /** A select wrapped in its <label>: its accessible name includes the selected option ("Type Message"), so match the label text. */
  const panelSelect = (panel, text) =>
    panel
      .first()
      .locator("label")
      .filter({ hasText: new RegExp(`^\\s*${text}`) })
      .locator("select");
  /** The inline label editor that is open now (graph node/edge, C4/ER/state figure, sequence). */
  const openLabelInput = () =>
    page.locator(".archer-node-label-input, .archer-seq-label-editor input, .archer-seq-label-editor textarea").first();

  const ui = {
    page,
    sandbox,
    settle,
    drag,
    slowDrag,
    canvasReady,
    panBy,
    reveal,
    locators: { editor, node, edge, participant, lifelineHit, message, button, openLabelInput },

    /** Log in through the sandbox's editing link (sets the access cookie). */
    login: () =>
      step(
        "login via editing link",
        async () => {
          const res = await page.goto(sandbox.link);
          if (!res || res.status() >= 400) throw new Error(`login link answered ${res?.status()}`);
          const cookies = await page.context().cookies(origin);
          if (!cookies.some((c) => /archer-\d+$/.test(c.name)))
            throw new Error(
              `no archer access cookie after following the link (cookies: ${cookies.map((c) => c.name).join(", ") || "none"})`,
            );
        },
        { leavesEditor: true, selectionMayChange: true },
      ),

    // ---------- navigation ----------
    openProject: (slug) =>
      step(
        `open project ${slug}`,
        async () => {
          await page.goto(`${origin}/projects/${slug}/`);
          await expect(page.getByRole("tablist", { name: "Project content" })).toBeVisible();
        },
        { leavesEditor: true, selectionMayChange: true },
      ),
    /** path is relative to the Archer folder, e.g. "diagrams/flow.mmd" or "notes/design.md#overview". */
    openDiagram: (slug, path, { edit = false, source = false } = {}) =>
      step(
        `open ${slug}/${path}${edit ? " (?edit)" : ""}`,
        async () => {
          const [file, hash] = path.split("#");
          const q = [edit && "edit", source && "source"].filter(Boolean).join("&");
          await page.goto(`${origin}/projects/${slug}/${file}${q ? `?${q}` : ""}${hash ? `#${hash}` : ""}`);
          if (edit) {
            await expect(editor()).toBeVisible();
            await canvasReady();
            await settle();
            await entryShot();
          } else
            await expect(
              page.locator(".react-flow, .archer-seq-canvas, .archer-note, article, main").first(),
            ).toBeVisible();
        },
        { leavesEditor: true, selectionMayChange: true },
      ),

    // ---------- edit mode ----------
    enterEdit: ({ expects } = {}) =>
      step(
        "enter edit (reading page Edit button)",
        async () => {
          const edit = page.locator(".archer-diagram-edit").getByRole("button", { name: "Edit", exact: true });
          await expect(edit, "the Edit button appears once authoring status reports authorized").toBeVisible();
          await edit.click();
          await expect(editor()).toBeVisible();
          expect(new URL(page.url()).searchParams.has("edit")).toBe(true);
          await canvasReady();
          await settle();
          await entryShot();
        },
        { selectionMayChange: true, ...(expects ? { expects } : {}) },
      ), // expects: what entering deliberately causes (errors.mjs)
    /** Cancel; with unsaved changes the "Discard your changes?" dialog answers `discard` (default) or Keep editing. */
    cancel: ({ discard = true } = {}) =>
      step(
        "Cancel",
        async () => {
          await button("Cancel").click();
          const dialog = page.getByRole("alertdialog", { name: "Discard your changes?" });
          if (await dialog.isVisible().catch(() => false))
            await dialog.getByRole("button", { name: discard ? "Discard" : "Keep editing", exact: true }).click();
          if (discard) await expect(editor()).toHaveCount(0);
        },
        { leavesEditor: discard, selectionMayChange: true },
      ),
    /** Save; in-place editing exits after a successful save. Returns the saved URL. */
    save: ({ expectExit = true } = {}) =>
      step(
        "Save",
        async () => {
          await settle();
          const save = page.locator(".authoring-toolbar").getByRole("button", { name: "Save", exact: true });
          await expect(save).toBeEnabled();
          await save.click();
          if (expectExit) await expect(editor()).toHaveCount(0, { timeout: 15_000 });
          return page.url();
        },
        { leavesEditor: expectExit, selectionMayChange: true },
      ),
    undo: () =>
      step(
        "Undo",
        async () => {
          await button("Undo", page.getByRole("toolbar", { name: "Editing tools" })).click();
          await settle();
        },
        { selectionMayChange: true },
      ),
    redo: () =>
      step(
        "Redo",
        async () => {
          await button("Redo", page.getByRole("toolbar", { name: "Editing tools" })).click();
          await settle();
        },
        { selectionMayChange: true },
      ),
    /** Undo with the keyboard (Ctrl+Z at document level, as a user does after a canvas action), not the button. */
    undoKey: () =>
      step(
        "Undo (Ctrl+Z)",
        async () => {
          await page.keyboard.press("Control+z");
          await settle();
        },
        { selectionMayChange: true },
      ),
    /** Redo with the keyboard (Ctrl+Shift+Z). */
    redoKey: () =>
      step(
        "Redo (Ctrl+Shift+Z)",
        async () => {
          await page.keyboard.press("Control+Shift+z");
          await settle();
        },
        { selectionMayChange: true },
      ),
    deleteSelected: () =>
      step("Delete selected", async () => {
        await button("Delete selected", page.getByRole("toolbar", { name: "Editing tools" })).click();
        await settle();
      }),
    toggleStructure: () => step("toggle Structure and properties", () => button("Structure and properties").click()),
    status: async () =>
      (
        await page
          .locator("div.authoring-statusline")
          .first()
          .textContent()
          .catch(() => null)
      )?.trim() ?? null,

    /** New → Diagram from the project page, then choose type and Save-as path. */
    newDiagram: (slug, { type = "Flowchart", saveAs } = {}) =>
      step(
        `new ${type} diagram`,
        async () => {
          await page.goto(`${origin}/projects/${slug}/`);
          await page.getByRole("button", { name: "New", exact: true }).click();
          await page.getByRole("menu", { name: "New" }).getByRole("menuitem", { name: "Diagram", exact: true }).click();
          await expect(editor()).toBeVisible();
          if (type !== "Flowchart") {
            await panelSelect(page.locator(".authoring-workspace"), "Type").selectOption({ label: type });
            const confirm = page.getByRole("alertdialog", { name: /^Switch to / });
            if (await confirm.isVisible().catch(() => false))
              await confirm.getByRole("button", { name: "Clear and switch" }).click();
          }
          if (saveAs !== undefined) await page.getByLabel("Save as", { exact: true }).fill(saveAs);
          await expect(
            page.getByRole("toolbar", { name: `${type === "C4" ? "C4 container" : type} parts` }),
          ).toBeVisible();
          // A person starts once the new type's empty drawing is shown, not the moment its parts bar appears (O17).
          await settle();
          await entryShot();
        },
        { leavesEditor: true, selectionMayChange: true },
      ),

    // ---------- parts and labels ----------
    /** Click a part in the parts bar ("Process", "Participant", "Loop"…); node parts open the name editor. Returns the new id when one opened. */
    addPart: (label, { name } = {}) =>
      step(
        `add part "${label}"${name ? ` named "${name}"` : ""}`,
        async () => {
          await page.locator(".authoring-parts").getByRole("button", { name: label, exact: true }).click();
          const input = openLabelInput();
          const opened = await input.waitFor({ state: "visible", timeout: 3000 }).then(
            () => true,
            () => false,
          );
          let id;
          if (opened) {
            const aria = (await input.getAttribute("aria-label")) ?? "";
            id = aria.replace(/ (label|name|message)$/, "");
            if (name !== undefined) {
              await input.fill(name);
              await input.press("Enter");
              await expect(input).toBeHidden();
            }
          }
          await settle();
          // Naming an ER entity or state can re-add it under a readable id made from the name (W, smoke-b#11:b): the
          // field's "<id> label" is then stale. The renamed part stays selected: take its id from the canvas.
          if (opened && name !== undefined) {
            const now = await page
              .locator(".react-flow__node.selected")
              .first()
              .getAttribute("data-id", { timeout: 1000 })
              .catch(() => null);
            if (now && !now.startsWith("group:")) id = now;
          }
          return id;
        },
        { labelEdit: name !== undefined },
      ),
    /** Type into whatever inline label editor is open and commit with Enter. */
    typeLabel: (text) =>
      step(
        `type label "${text}"`,
        async () => {
          const input = openLabelInput();
          await expect(input).toBeVisible();
          await input.fill(text);
          await input.press("Enter");
          await expect(input).toBeHidden();
          await settle();
        },
        { labelEdit: true },
      ),
    /** Double-click a graph node / figure / sequence participant or message and rename it. */
    rename: (id, text) =>
      step(
        `rename ${id} → "${text}"`,
        async () => {
          const target = node(id).or(participant(id)).or(message(id));
          await reveal(target);
          const group = await isFrame(target.first());
          await target.first().dblclick(group ? { position: { x: 12, y: 12 } } : {});
          // The editor's accessible name carries the id until the thing is named and then its label: take the one open editor.
          const input = openLabelInput();
          await expect(input).toBeFocused();
          await input.fill(text);
          await input.press("Enter");
          await expect(input).toBeHidden();
          await settle();
        },
        { labelEdit: true },
      ),
    /** Rename a graph connection (focus + Enter opens '<id> connection label'). */
    renameEdge: (id, text) =>
      step(
        `rename connection ${id} → "${text}"`,
        async () => {
          await edge(id).focus();
          await edge(id).press("Enter");
          const input = page
            .getByRole("textbox", { name: `${id} connection label` })
            .or(page.getByRole("textbox", { name: /connection label$/ }))
            .first();
          await expect(input).toBeFocused();
          await input.fill(text);
          await input.press("Enter");
          await expect(input).toBeHidden();
          await settle();
        },
        { labelEdit: true },
      ),
    select: (id, { shift = false } = {}) =>
      step(
        `select ${id}${shift ? " (+shift)" : ""}`,
        async () => {
          const target = node(id).or(edge(id)).or(participant(id)).or(message(id));
          await reveal(node(id).or(edgePath(id)).or(participant(id)).or(message(id)));
          // A group frame is mostly covered by its children: press on its corner (the title area).
          const group = await isFrame(target.first());
          await target
            .first()
            .click({ modifiers: shift ? ["Shift"] : [], ...(group ? { position: { x: 12, y: 12 } } : {}) });
          // Picking something re-defines what is selected: a journey step that selects and then edits is not judged
          // against what was selected before it (selection-identity).
        },
        { selectionMayChange: true },
      ),

    // ---------- graph gestures ----------
    /** Drag from a node's source handle to another node's target handle. Returns the new edge id. */
    connect: (fromId, toId, { slow = false } = {}) =>
      step(`connect ${fromId} → ${toId}`, async () => {
        const before = new Set(
          await page.locator(".react-flow__edge").evaluateAll((els) => els.map((e) => e.getAttribute("data-id"))),
        );
        await reveal(node(fromId), node(toId));
        await hoverNode(fromId);
        const from = center(
          await box(node(fromId).locator(".react-flow__handle.source"), `source handle of ${fromId}`),
        );
        const to = center(await box(node(toId).locator(".react-flow__handle.target"), `target handle of ${toId}`));
        await (slow ? slowDrag : drag)(from, to);
        await settle();
        // The edge is drawn once the edit round-trips; poll rather than read once.
        let added = [];
        await expect
          .poll(
            async () => {
              const after = await page
                .locator(".react-flow__edge")
                .evaluateAll((els) => els.map((e) => e.getAttribute("data-id")));
              added = after.filter((id) => !before.has(id));
              return added.length;
            },
            { message: `a new connection ${fromId} → ${toId}`, timeout: 5000 },
          )
          .toBeGreaterThan(0);
        if (added.length !== 1)
          throw new Error(`expected one new connection, found ${added.length} (${added.join(", ")})`);
        return added[0];
      }),
    /** Select an edge, then drag its source/target end onto another node (React Flow edge updater). */
    // `where`: "handle" (default: the matching handle), "body" (drop on the node body), or {x, y} in page px.
    // `slow`: human-speed drag (needed for the thin handles of fork/join/composites).
    reattachEdge: (edgeId, end, toId, where = "handle", { slow = false } = {}) =>
      step(`reattach ${edgeId} ${end} → ${toId} (${typeof where === "string" ? where : "xy"})`, async () => {
        await reveal(edgePath(edgeId), node(toId));
        await selectEdgeNow(edgeId); // clicks along the drawn path until it is selected (the midpoint can sit under another edge's updater)
        const updater = edge(edgeId).locator(`.react-flow__edgeupdater-${end}`);
        const from = center(await box(updater, `${end} end of ${edgeId}`));
        await hoverNode(toId);
        let to;
        if (typeof where === "object") to = where;
        else if (where === "body") to = center(await box(node(toId), `node ${toId}`));
        else to = center(await box(node(toId).locator(`.react-flow__handle.${end}`), `${end} handle of ${toId}`)); // a target end lands on a target handle
        await (slow ? slowDrag : drag)(from, to);
        await settle();
      }),
    /** Click an edge at fraction `f` (0..1) along its drawn path, no assertion; returns whether it is now selected (for probing where a click lands). */
    pickEdge: async (id, f = 0.25) => {
      const pt = await edgePath(id)
        .first()
        .evaluate((p, f) => {
          const m = p.getScreenCTM();
          const q = p.getPointAtLength(p.getTotalLength() * f);
          return { x: q.x * m.a + q.y * m.c + m.e, y: q.x * m.b + q.y * m.d + m.f };
        }, f)
        .catch(() => null);
      if (!pt) return false;
      await page.mouse.click(pt.x, pt.y);
      await page.waitForTimeout(200);
      return /\bselected\b/.test((await edge(id).getAttribute("class")) ?? "");
    },
    /** Select a graph connection by clicking along its path until it takes the selection. */
    selectEdge: (id) =>
      step(`select connection ${id}`, async () => {
        await selectEdgeNow(id);
      }),
    /** Pan the canvas by (dx, dy) screen px. */
    pan: (dx, dy = 0) => step(`pan by ${dx},${dy}`, async () => panBy(dx, dy)),
    /** Make sure the nodes/edges with these ids are inside the canvas (pans, then zooms out a notch at a time). */
    panTo: (...ids) =>
      step(`bring ${ids.join(", ")} into view`, async () =>
        reveal(...ids.map((id) => node(id).or(edgePath(id)).or(participant(id)).or(message(id)))),
      ),
    /** Drag a node by an offset. */
    moveNode: (id, dx, dy) =>
      step(`move ${id} by ${dx},${dy}`, async () => {
        await reveal(node(id));
        const from = center(await box(node(id), `node ${id}`));
        await drag(from, { x: from.x + dx, y: from.y + dy });
        await settle();
      }),

    // ---------- sequence gestures ----------
    seq: {
      /**
       * Draw a message from one lifeline to another; `atY` = 'end' (below the last message), 'start' (above the first)
       * or a page y. Returns the new message's id, found by comparing from/to/label before and after (TG-b3), not
       * the open editor's id. Throws when the label landed on another message.
       */
      drawMessage: (fromId, toId, { atY = "end", label } = {}) =>
        step(
          `draw message ${fromId} → ${toId}${label ? ` "${label}"` : ""}`,
          async () => {
            const before = (await seqState())?.messages ?? [];
            const a = await box(lifelineHit(fromId), `lifeline ${fromId}`, "attached"),
              b = await box(lifelineHit(toId), `lifeline ${toId}`, "attached");
            let y = atY;
            if (y === "start") {
              const first = page.locator("g.archer-seq-message").first();
              const fb = (await first.count()) ? await first.boundingBox() : null;
              const head = await box(
                participant(fromId).locator(".archer-seq-participant-box"),
                `participant ${fromId}`,
              );
              y = fb ? Math.max(head.y + head.height + 8, fb.y - 10) : head.y + head.height + 30;
            } else if (y === "end") {
              const last = page.locator("g.archer-seq-message").last();
              const lb = (await last.count()) ? await last.boundingBox() : null;
              const head = await box(
                participant(fromId).locator(".archer-seq-participant-box"),
                `participant ${fromId}`,
              );
              y = Math.min(a.y + a.height - 12, (lb ? lb.y + lb.height : head.y + head.height) + 30);
            }
            await drag({ x: a.x + a.width / 2, y }, { x: b.x + b.width / 2, y });
            const input = page.getByRole("textbox", { name: / message$/ });
            await expect(input).toBeVisible();
            if (label !== undefined) {
              await input.fill(label);
              await input.press("Enter");
              await expect(input).toBeHidden();
            }
            await settle();
            const after = (await seqState())?.messages ?? [];
            return locateNewMessage(before, after, { from: fromId, to: toId, label }).id;
          },
          { labelEdit: label !== undefined },
        ),
      /** Select a message, then drag its 'source' or 'target' end handle onto another lifeline. */
      dragMessageEnd: (messageId, end, toId) =>
        step(`drag ${messageId} ${end} end → ${toId}`, async () => {
          await message(messageId).click();
          const handle = page.locator(`circle[data-seq-end="${end}"][data-seq-message="${css(messageId)}"]`);
          const from = center(await box(handle, `${end} handle of ${messageId}`));
          const lane = await box(lifelineHit(toId), `lifeline ${toId}`, "attached");
          await drag(from, { x: lane.x + lane.width / 2, y: from.y });
          await settle();
        }),
      /** Select a message and drag it vertically: `target` is another message id (drop just above it) or a dy in pixels. */
      moveMessage: (messageId, target) =>
        step(`move ${messageId} ${typeof target === "number" ? `by ${target}px` : `above ${target}`}`, async () => {
          await message(messageId).click();
          const from = center(
            await box(message(messageId).locator("rect.archer-seq-hit").or(message(messageId)), `message ${messageId}`),
          );
          let y = from.y + (typeof target === "number" ? target : 0);
          if (typeof target === "string") {
            const t = await box(
              message(target).locator("rect.archer-seq-hit").or(message(target)),
              `message ${target}`,
            );
            y = t.y - 6;
          }
          await drag(from, { x: from.x, y });
          await settle();
        }),
      /** Drag a participant header sideways so it lands just past `beforeId`'s header (or by dx when a number). */
      reorderParticipant: (id, target) =>
        step(`reorder participant ${id} → ${typeof target === "number" ? `${target}px` : target}`, async () => {
          const from = center(await box(participant(id).locator(".archer-seq-participant-box"), `participant ${id}`));
          let x = from.x + (typeof target === "number" ? target : 0);
          if (typeof target === "string") {
            const t = await box(participant(target).locator(".archer-seq-participant-box"), `participant ${target}`);
            x = t.x + t.width / 2 + (t.x > from.x ? t.width * 0.6 : -t.width * 0.6);
          }
          await drag(from, { x, y: from.y });
          await settle();
        }),
      /** Shift-click messages in a row, then wrap them: kind is the part label: "Loop" | "If / else" | "Optional" | "Parallel". */
      wrap: (messageIds, kind) =>
        step(`wrap ${messageIds.join(", ")} in ${kind}`, async () => {
          for (const [i, id] of messageIds.entries()) await message(id).click({ modifiers: i === 0 ? [] : ["Shift"] });
          const before = await page.locator(".archer-seq-fragment").count();
          await page.locator(".authoring-parts").getByRole("button", { name: kind, exact: true }).click();
          await settle();
          await expect(page.locator(".archer-seq-fragment")).toHaveCount(before + 1);
        }),
      /** Select one or two participants, then add a Note over them. */
      addNote: (participantIds) =>
        step(`note over ${participantIds.join(", ")}`, async () => {
          for (const [i, id] of participantIds.entries())
            await participant(id).click({ modifiers: i === 0 ? [] : ["Shift"] });
          const before = await page.locator("g.archer-seq-note").count();
          await page.locator(".authoring-parts").getByRole("button", { name: "Note", exact: true }).click();
          await settle();
          await expect(page.locator("g.archer-seq-note")).toHaveCount(before + 1);
        }),
      /** The Selected message panel (shown when exactly one message is selected). */
      panel: {
        set: (messageId, { from, to, type, position } = {}) =>
          step(`message panel ${messageId} ${JSON.stringify({ from, to, type, position })}`, async () => {
            await message(messageId).click();
            const panel = page
              .getByRole("region", { name: "Selected message" })
              .or(page.locator("section.authoring-message-panel"));
            await expect(panel.first()).toBeVisible();
            if (from !== undefined) {
              await panelSelect(panel, "From").selectOption(from);
              await settle();
            }
            if (to !== undefined) {
              await panelSelect(panel, "To").selectOption(to);
              await settle();
            }
            if (type !== undefined) {
              await panelSelect(panel, "Type").selectOption(type);
              await settle();
            }
            if (position !== undefined) {
              const f = panel.first().getByLabel("Position in the sequence");
              await f.fill(String(position));
              await f.press("Enter");
              await settle();
            }
          }),
      },
      participants: () =>
        page.locator("g.archer-seq-participant").evaluateAll((els) => els.map((e) => e.getAttribute("data-seq-id"))),
      /**
       * The sequence diagram as the page shows it (TG-b5): participants (id, label, lifeline x), messages in drawn
       * order (id, number, from, to, label, kind, selected), notes (id, text, over), fragments (id, kind, label,
       * sections, the messages inside), the selection, and the open message/note/block panel. Ends come from the
       * drawn geometry (arrow ends against lifelines), labels from the drawn text, so a stale model shows here.
       */
      state: () => seqState(),
      messages: () =>
        page
          .locator("g.archer-seq-message")
          .evaluateAll((els) =>
            els.map((e) => ({ id: e.getAttribute("data-seq-id"), label: e.getAttribute("aria-label") })),
          ),
    },

    // ---------- source ----------
    /** Reading page: open the Source panel and return its text. */
    openSourcePanel: () =>
      step("open Source panel", async () => {
        const toggle = page.locator("button.archer-source-tool");
        if ((await toggle.getAttribute("aria-pressed")) !== "true") await toggle.click();
        const panel = page.locator("section.archer-source-panel");
        await expect(panel).toBeVisible();
        // Plain <pre> until the source editor (CodeMirror) loads, then its lines (it renders the visible ones).
        const code = panel.locator("pre.archer-source-panel-code, .cm-content");
        await expect(code.first()).toBeVisible();
        await expect(panel.locator("p.archer-source-panel-note")).toHaveCount(0);
        return sourceText(code.first());
      }),
    /** Reading page: click Copy in the Source panel and return the clipboard text. */
    copySource: () =>
      step("Copy source", async () => {
        const panel = page.locator("section.archer-source-panel");
        await button("Copy", panel).click();
        await expect(panel.getByRole("button", { name: "Copied" }).or(panel.getByText("Copied"))).toBeVisible();
        return page.evaluate(() => navigator.clipboard.readText());
      }),
    /** Reading page: Source panel → Edit source (opens ?edit&source). */
    editSourceFromPanel: () =>
      step("Edit source (from Source panel)", async () => {
        await button("Edit source", page.locator("section.archer-source-panel")).click();
        await expect(editor()).toBeVisible();
        await expect(page.locator("#authoring-source")).toBeVisible();
        await settle();
      }),
    /** Editor: show/hide the Mermaid source pane. */
    // Families whose source pane is forced open have no toggle: that is reported ({forced: true}), not waited out for 10 s.
    toggleEditorSource: () =>
      step("toggle editor Mermaid source", async () => {
        const toggle = editor().getByRole("button", { name: "Mermaid source", exact: true });
        // Source-only families (and the phone layout) render no toggle: the pane is forced open.
        if ((await toggle.count()) === 0 || (await toggle.isDisabled()))
          return {
            forced: true,
            pressed: (await toggle.count()) === 0 ? null : await toggle.getAttribute("aria-pressed"),
          };
        await toggle.click();
        return { forced: false, pressed: await toggle.getAttribute("aria-pressed") };
      }),
    /** Editor: the source textarea's current text, whether the pane is open, forced open or closed (a closed pane is opened and closed again). */
    editorSource: async () => {
      const area = page.locator("#authoring-source");
      if (await area.isVisible().catch(() => false)) return sourceText(area);
      const toggle = editor().getByRole("button", { name: "Mermaid source", exact: true });
      if ((await toggle.count()) === 0 || !(await toggle.isEnabled().catch(() => false)))
        return sourceText(area, 1500).catch(() => "");
      // The toggle is there and enabled, so a click lands at once or something covers it (a selection panel over
      // Source, smoke-a flow-existing). Fail that in seconds, not after a journey's long action timeout (600 s).
      const press = () =>
        toggle.click({ timeout: 10_000 }).catch((error) => {
          throw new Error(
            `the Mermaid source toggle could not be clicked (covered?): ${error.message
              .split("\n")
              .filter((l) => /intercepts|Timeout/.test(l))
              .join(" ")}`,
          );
        });
      await press();
      const text = await sourceText(area, 2000).catch(() => "");
      await press();
      return text;
    },
    /** Editor: replace the source text (types it like a user pasting). */
    setEditorSource: (text) =>
      step(
        "replace editor source",
        async () => {
          const area = page.locator("#authoring-source");
          await expect(area).toBeVisible();
          await area.fill(text); // a textarea, or CodeMirror's contenteditable (fill selects all and inserts)
          await settle();
        },
        { selectionMayChange: true },
      ),
    /**
     * Put a sandbox project copy back to its corpus snapshot so journeys can be rerun: git checkout + clean in
     * the copy, the service's saved layouts (presentation store) emptied and re-seeded from the corpus, and
     * this browser's editor drafts (localStorage `archer.authoring.v1:*`) and source-pane preference cleared.
     * Only ever touches a project root inside this sandbox's own root.
     */
    resetProject: (slug) =>
      step(
        `reset project ${slug} to the corpus snapshot`,
        async () => {
          const p = sandbox.projects.find((x) => x.slug === slug);
          if (!p?.root.startsWith(sandbox.root + sep))
            throw new Error(`no project ${slug} inside sandbox ${sandbox.name}`);
          for (const args of [
            ["checkout", "-q", "--", "."],
            ["clean", "-qfd"],
          ]) {
            const r = spawnSync("git", args, { cwd: p.root, encoding: "utf8" });
            if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
          }
          settleCorpusTimes(p.root); // the restored files back at the snapshot's time, so the file list's order is too (O72)
          await page.waitForTimeout(400); // let the service's watcher pick the change up
          const layouts = await resetPresentations({ origin, slug, link: sandbox.link, root: p.root });
          let drafts = 0;
          if (page.url().startsWith(origin)) {
            drafts = await page
              .evaluate(() => {
                let n = 0;
                try {
                  for (const k of Object.keys(localStorage))
                    if (k.startsWith("archer.authoring.v1:")) {
                      localStorage.removeItem(k);
                      n++;
                    }
                } catch {
                  /* blocked storage */
                }
                try {
                  sessionStorage.removeItem("archer.editor.source");
                } catch {
                  /* blocked storage */
                }
                return n;
              })
              .catch(() => 0);
          }
          return { layouts, drafts };
        },
        { leavesEditor: true, selectionMayChange: true },
      ),
    /** Read a project file from the sandbox copy (what Save wrote). */
    readProjectFile: async (slug, relPath) => readFileSync(inProject(slug, relPath), "utf8"),
    /**
     * Write a file in the sandbox copy of a project, the way an agent (or `git checkout`, or an editor) would:
     * the service's watcher sees it, a page that has the diagram open should say it changed. `relPath` is
     * relative to the project root, e.g. ".archer/diagrams/flow.mmd" or "diagrams/flow.mmd" (as in archer.toml's folder).
     */
    agentWrite: (slug, relPath, text, { settleMs = 800, expects } = {}) =>
      step(
        `agent writes ${slug}/${relPath}`,
        async () => {
          const file = inProject(slug, relPath);
          mkdirSync(dirname(file), { recursive: true });
          writeFileSync(file, text);
          await page.waitForTimeout(settleMs); // watcher + the page's next poll
        },
        { selectionMayChange: true, ...(expects ? { expects } : {}) },
      ), // expects: what the write deliberately makes the page say (errors.mjs)
    /** Remove a file in the sandbox copy (an agent deleting a diagram). */
    agentRemove: (slug, relPath, { settleMs = 800 } = {}) =>
      step(
        `agent removes ${slug}/${relPath}`,
        async () => {
          rmSync(inProject(slug, relPath), { force: true });
          await page.waitForTimeout(settleMs);
        },
        { selectionMayChange: true },
      ),
    /** An ordinary access link with no authoring roots (sandbox.mjs link --reader; it may still edit). Open it in `ui.readerContext()`. */
    readerLink: async () => issueLink({ name: sandbox.name, reader: true }).url,
    /** Unified diff of a saved project file against `before` (what readProjectFile returned earlier); also reports CRLF/mixed endings. */
    diffFile: (slug, relPath, before) =>
      step(`diff ${relPath}`, async () => {
        const after = readFileSync(inProject(slug, relPath), "utf8");
        return {
          diff: udiff(before, after),
          crlfBefore: hasCrlf(before),
          crlfAfter: hasCrlf(after),
          mixedEndings: hasCrlf(after) && /(^|[^\r])\n/.test(after),
        };
      }),
    // ---------- banners, drafts, recovery (TG-c2) ----------
    /**
     * What the editor is telling the person, as data: the status line, the conflict/blocked banner and its actions,
     * the feedback callout, unfinished-save recovery actions, whether this is a restored or resumable draft, and the
     * draft id / checkpoint in the address. Never waits; null fields mean "not shown".
     */
    editorState: () =>
      page
        .evaluate(() => {
          const clean = (t) => (t ?? "").replace(/\s+/g, " ").trim();
          const actions = (root) =>
            root
              ? [...root.querySelectorAll("button, a")].map((b) => ({
                  text: clean(b.textContent),
                  disabled: b.disabled === true,
                  ...(b.href ? { href: b.getAttribute("href") } : {}),
                }))
              : [];
          const line = document.querySelector(".authoring-statusline"),
            status = clean(line?.textContent) || null;
          const conflict = document.querySelector(".authoring-conflict"),
            feedback = document.querySelector(".authoring-feedback");
          const recovery = document.querySelector(".authoring-recovery-actions");
          const save = [...document.querySelectorAll(".authoring-toolbar button")].find(
            (b) => clean(b.textContent) === "Save",
          );
          const q = new URLSearchParams(location.search);
          return {
            editing: document.querySelector(".authoring-workspace") !== null,
            status,
            draftId: q.get("draftId"),
            checkpoint: q.get("checkpoint"),
            restored: /Restored your unsaved changes/.test(status ?? ""),
            resumable: /unsaved changes from an earlier edit/.test(status ?? ""),
            storageFailed: /Browser recovery is unavailable/.test(status ?? ""),
            busy: /Working…/.test(status ?? ""),
            save: save
              ? {
                  enabled: !save.disabled,
                  blockedReason: clean(document.getElementById("authoring-save-blocked")?.textContent) || null,
                }
              : null,
            conflict: conflict
              ? {
                  kind: /Save is blocked/.test(conflict.textContent) ? "blocked" : "changed-outside",
                  text: clean(conflict.querySelector("span")?.textContent ?? conflict.textContent),
                  actions: actions(conflict),
                }
              : null,
            feedback: feedback
              ? {
                  text: clean(feedback.textContent).replace(/ ?Dismiss$/, ""),
                  role: feedback.getAttribute("role"),
                  error: feedback.classList.contains("authoring-error"),
                }
              : null,
            recovery: recovery ? { actions: actions(recovery) } : null,
            diagnostics: [...document.querySelectorAll("ul.authoring-diagnostics li")].map((li) =>
              clean(li.textContent),
            ),
          };
        })
        .catch(() => null),
    /** Wait until the conflict/blocked banner shows (an agent changed the file, another tab saved); returns editorState(). */
    waitForConflict: ({ timeout = 10_000 } = {}) =>
      step("wait for the conflict banner", async () => {
        await expect(page.locator(".authoring-conflict")).toBeVisible({ timeout });
        return ui.editorState();
      }),
    /** Status line: "Resume them" (unsaved changes from an earlier edit). The address gets that draft's id. */
    resumeDraft: () =>
      step(
        "resume earlier unsaved changes",
        async () => {
          await page.locator(".authoring-statusline").getByRole("button", { name: "Resume them", exact: true }).click();
          await expect(page.locator(".authoring-statusline")).not.toContainText("from an earlier edit");
          await settle();
          return ui.editorState();
        },
        { selectionMayChange: true },
      ),
    /** Status line: "Start fresh" (drop the offer to resume). */
    startFresh: () =>
      step(
        "start fresh (dismiss earlier unsaved changes)",
        async () => {
          await page.locator(".authoring-statusline").getByRole("button", { name: "Start fresh", exact: true }).click();
          return ui.editorState();
        },
        { selectionMayChange: true },
      ),
    /** Status line after a reload restored work: "Discard them", confirmed in the Discard dialog. */
    discardRestored: () =>
      step(
        "discard restored changes",
        async () => {
          await page
            .locator(".authoring-statusline")
            .getByRole("button", { name: "Discard them", exact: true })
            .click();
          const dialog = page.getByRole("alertdialog", { name: "Discard your changes?" });
          await dialog.getByRole("button", { name: "Discard", exact: true }).click();
          return ui.editorState();
        },
        { leavesEditor: true, selectionMayChange: true },
      ),
    /**
     * Reload the page (a dirty editor's beforeunload prompt is accepted, as "Leave"). Not an explicit navigation for
     * dirty-navigation: the editor must come back on the same address with the work restored. Returns editorState().
     */
    reload: ({ edit = true } = {}) =>
      step(
        "reload",
        async () => {
          await page.reload();
          if (edit) {
            await expect(editor()).toBeVisible();
            await canvasReady();
            await settle();
          }
          return ui.editorState();
        },
        { selectionMayChange: true },
      ),

    // ---------- viewport and theme ----------
    /** Resize the page (e.g. 1024, 768). Layout-dependent invariants then judge the new size. */
    setViewport: (width, height = width >= 1440 ? 900 : 768) =>
      step(
        `viewport ${width}×${height}`,
        async () => {
          await page.setViewportSize({ width, height });
          await page.waitForTimeout(200);
        },
        { selectionMayChange: true },
      ),
    /** Light or dark: follow the OS (no stored preference) and emulate its colour scheme; waits for data-theme. */
    setTheme: (theme) =>
      step(
        `theme ${theme}`,
        async () => {
          await page.emulateMedia({ colorScheme: theme });
          await page
            .evaluate(() => {
              try {
                localStorage.removeItem("archer.theme");
              } catch {
                /* blocked storage */
              }
            })
            .catch(() => {});
          await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
        },
        { selectionMayChange: true },
      ),

    /** Text of every visible alert on the page (role=alert, editor errors). */
    alerts: async () =>
      (await page.locator(".authoring-error, [role=alert], .authoring-interaction-error").allTextContents())
        .map((t) => t.trim())
        .filter(Boolean),
  };
  /** A path inside a sandbox project copy; refuses anything that resolves outside it. */
  function inProject(slug, relPath) {
    const p = sandbox.projects.find((x) => x.slug === slug);
    if (!p) throw new Error(`no project ${slug} in sandbox ${sandbox.name}`);
    const root = resolve(p.root),
      file = resolve(root, relPath);
    if (!file.startsWith(root + sep) || !root.startsWith(sandbox.root + sep))
      throw new Error(`${relPath} is outside project ${slug}`);
    return file;
  }
  return ui;
}

/** The Mermaid text of a source box: a textarea's value, a <pre>'s text, or CodeMirror's lines joined. */
async function sourceText(locator, timeout) {
  return locator.evaluate(
    (el) => {
      if (el instanceof HTMLTextAreaElement) return el.value;
      const content = el.classList.contains("cm-content")
        ? el
        : (el.closest(".cm-content") ?? el.querySelector(".cm-content"));
      if (!content) return el.textContent ?? "";
      // CodeMirror renders only the lines in view: read its document (the view hangs off the content element as
      // cmTile, cmView in older releases), and fall back to the rendered lines.
      const tile = content.cmTile ?? content.cmView;
      const view = tile?.view ?? tile?.rootView?.view;
      if (view?.state?.doc) return view.state.doc.toString();
      return [...content.querySelectorAll(".cm-line")].map((line) => line.textContent).join("\n");
    },
    undefined,
    timeout === undefined ? undefined : { timeout },
  );
}
