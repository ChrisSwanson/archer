// ADR 0030 in a real browser, in both schemes: an emphasised node is its border
// in the group's hue, an emphasised line and its arrowheads take the same hue,
// and nothing else is drawn -- no ring, glow, band, filter or dash. The hue is
// the group's POSITION (teal, violet, coral), checked against the theme's own
// tokens, and each clears 3:1 against the canvas.
import { followBrowserMotion } from "./support/emphasis-motion";
import { expect, test, type Page } from "@playwright/test";
import { sharedTsProject } from "./support/shared-service";

const SOURCE = "flowchart LR\n  a[Customer] e1@--> b[Shop]\n  b e2@--> c[Bank]\n  c e3@--> d[Ledger]\n";

/** sRGB relative luminance, for the contrast check. */
function luminance([r, g, b]: readonly number[]): number {
  const [R, G, B] = [r, g, b].map((v) => {
    const c = v! / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * R! + 0.7152 * G! + 0.0722 * B!;
}
const rgb = (value: string): number[] => (value.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
const contrast = (a: string, b: string): number => {
  const [x, y] = [luminance(rgb(a)), luminance(rgb(b))].sort((m, n) => n - m);
  return (x! + 0.05) / (y! + 0.05);
};

async function token(page: Page, name: string): Promise<string> {
  return page.evaluate((token) => {
    const probe = document.createElement("div");
    probe.style.color = `var(${token})`;
    document.querySelector(".react-flow")!.append(probe);
    const value = getComputedStyle(probe).color;
    probe.remove();
    return value;
  }, name);
}

for (const scheme of ["light", "dark"] as const) {
  test(`emphasis is colour and nothing else, by group position: ${scheme}`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
    const server = await sharedTsProject({
      files: {
        "archer.toml":
          'version = 1\n[[views]]\nid = "drawing"\nkind = "freeform"\ntitle = "Drawing"\nsource = ".archer/drawing.mmd"\n',
        ".archer/drawing.mmd": SOURCE,
      },
    });
    try {
      await server.present("drawing");
      await page.goto(server.url);
      await expect(page.locator('.react-flow__node[data-id="a"]')).toBeVisible();
      // A resting node casts no shadow (owner, 2026-11-12: shadows removed), read before the highlight: while one
      // is shown the nodes it does not name step back (archer-dimmed), so none of them is at rest any more.
      const resting = await page
        .locator('.react-flow__node[data-id="a"]')
        .evaluate((element) => getComputedStyle(element).boxShadow);
      expect(resting, "the resting node shadow").toBe("none");
      await server.setEmphasis("drawing", [
        {
          id: "three",
          title: "Three groups",
          groups: [
            { id: "first", label: "First", style: "highlight", nodes: ["a"], edges: ["e1"] },
            { id: "second", label: "Second", style: "highlight", nodes: ["c"], edges: [] },
            { id: "third", label: "Third", style: "highlight", nodes: [], edges: ["e3"] },
          ],
        },
      ]);
      await expect(page.locator('.react-flow__node[data-id="a"].archer-emph')).toBeVisible();

      const [g1, g3, g4, bg] = await Promise.all(["--g1", "--g3", "--g4", "--bg"].map((name) => token(page, name)));
      for (const hue of [g1!, g3!, g4!]) expect(contrast(hue, bg!), `${hue} on ${bg}`).toBeGreaterThanOrEqual(3);

      const node = (id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);
      const edge = (id: string) => page.locator(`.react-flow__edge[data-id="${id}"]`);
      const style = (locator: ReturnType<Page["locator"]>, selector: string | null, properties: readonly string[]) =>
        locator.evaluate(
          (element, [inner, names]) => {
            const target = inner === null ? element : element.querySelector(inner)!;
            const computed = getComputedStyle(target);
            return Object.fromEntries((names as string[]).map((name) => [name, computed.getPropertyValue(name)]));
          },
          [selector, properties] as const,
        );

      for (const [id, hue] of [
        ["a", g1],
        ["c", g3],
      ] as const) {
        // The border colour eases in (a 120ms transition): wait for it to settle.
        await expect
          .poll(async () => (await style(node(id), null, ["border-top-color"]))["border-top-color"], {
            message: `node ${id}`,
          })
          .toBe(hue);
        const drawn = await style(node(id), null, [
          "border-top-color",
          "outline-style",
          "box-shadow",
          "animation-name",
          "filter",
        ]);
        expect(drawn["border-top-color"], `node ${id}`).toBe(hue);
        expect(drawn["outline-style"], `node ${id} has no ring`).toBe("none");
        // No glow: the emphasised node casts what it did at rest -- nothing.
        expect(drawn["box-shadow"], `node ${id} has no glow`).toBe(resting);
        expect(drawn["animation-name"], `node ${id} does not breathe`).toBe("none");
        expect(drawn["filter"]).toBe("none");
      }
      for (const [id, hue] of [
        ["e1", g1],
        ["e3", g4],
      ] as const) {
        const line = await style(edge(id), "path.react-flow__edge-path", [
          "stroke",
          "stroke-dasharray",
          "filter",
          "stroke-width",
        ]);
        expect(line.stroke, `edge ${id}`).toBe(hue);
        expect(line["stroke-dasharray"], `edge ${id} is not dashed`).toBe("none");
        expect(line.filter).toBe("none");
        // No wider than a resting line: 2px since the owner lightened the lines (2026-11-15).
        expect(Number.parseFloat(line["stroke-width"]!)).toBeLessThanOrEqual(2);
        const arrow = await style(edge(id), "marker polyline", ["fill"]);
        expect(arrow.fill, `edge ${id}'s arrowhead`).toBe(hue);
        await expect(edge(id).locator(".archer-edge-emph-band")).toHaveCount(0);
      }
      // An element nobody pointed at keeps the theme's own ink.
      const plain = await style(edge("e2"), "path.react-flow__edge-path", ["stroke"]);
      expect([g1, g3, g4]).not.toContain(plain.stroke);

      // Selection keeps its fill and glow; the emphasis keeps the border.
      await page.getByRole("button", { name: "Select mode", exact: true }).click();
      await node("a").click();
      await expect(node("a")).toHaveClass(/selected/);
      const fill = await token(page, "--accent-fill");
      await expect
        .poll(async () => (await style(node("a"), null, ["background-color"]))["background-color"])
        .toBe(fill);
      expect((await style(node("a"), null, ["border-top-color"]))["border-top-color"]).toBe(g1);
    } finally {
      await server.stop();
    }
  });
}

test("a two-way flow line has arrowheads at both ends and arrows moving both ways; still under reduced motion", async ({
  page,
}) => {
  await followBrowserMotion(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const server = await sharedTsProject({
    files: {
      "archer.toml":
        'version = 1\n[[views]]\nid = "drawing"\nkind = "freeform"\ntitle = "Drawing"\nsource = ".archer/drawing.mmd"\n',
      ".archer/drawing.mmd": "flowchart LR\n  a[Orders API] e1@<-->|Reads and writes| b[Orders DB]\n",
    },
  });
  try {
    await server.present("drawing");
    await page.goto(server.url);
    await server.setEmphasis("drawing", [
      { id: "rw", groups: [{ id: "rw", label: "Reads and writes", style: "flow", nodes: [], edges: ["e1"] }] },
    ]);
    const edge = page.locator('.react-flow__edge[data-id="e1"]');
    await expect(edge.locator(".archer-emph-chevrons")).toBeAttached();
    await expect(edge.locator("marker")).toHaveCount(2);
    const x = (direction: "on" | "back") =>
      edge
        .locator(`.archer-emph-chevron[data-direction="${direction}"]`)
        .first()
        .evaluate((element) => {
          const box = (element as unknown as SVGGraphicsElement).getBoundingClientRect();
          return box.x + box.width / 2;
        });
    // Signed progress at fixed animation times: most forward arrows move toward
    // the target (right) and most back arrows toward the source (left). One of
    // each set may wrap round inside the interval, so the majority decides.
    const progress = await edge.evaluate((element) => {
      const svg = element.closest("svg") as SVGSVGElement;
      svg.pauseAnimations();
      const centres = () =>
        [...element.querySelectorAll<SVGGraphicsElement>(".archer-emph-chevron")].map((chevron) => {
          const box = chevron.getBoundingClientRect();
          return { direction: chevron.getAttribute("data-direction"), x: box.x + box.width / 2 };
        });
      svg.setCurrentTime(0.2);
      const before = centres();
      svg.setCurrentTime(0.5);
      const after = centres();
      svg.unpauseAnimations();
      return before.map((entry, index) => ({ direction: entry.direction, dx: after[index]!.x - entry.x }));
    });
    for (const [direction, sign] of [
      ["on", 1],
      ["back", -1],
    ] as const) {
      const moves = progress.filter((entry) => entry.direction === direction);
      expect(moves.length, direction).toBeGreaterThanOrEqual(2);
      const agreeing = moves.filter((entry) => Math.sign(entry.dx) === sign).length;
      expect(agreeing, `${direction} arrows: ${JSON.stringify(moves)}`).toBeGreaterThan(moves.length / 2);
    }
    await expect(edge.locator('.archer-emph-chevron[data-direction="back"] animateMotion').first()).toHaveAttribute(
      "keyPoints",
      "1;0",
    );
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(edge.locator("animateMotion")).toHaveCount(0);
    await expect(edge.locator(".archer-emph-chevron")).toHaveCount(2);
  } finally {
    await server.stop();
  }
});

for (const scheme of ["light", "dark"] as const) {
  test(`sequence and journey emphasis is colour only too: ${scheme}`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
    const server = await sharedTsProject({
      files: {
        "archer.toml":
          'version = 1\n[[views]]\nid = "chat"\nkind = "sequence"\ntitle = "Chat"\nsource = ".archer/chat.mmd"\n[[views]]\nid = "trip"\nkind = "journey"\ntitle = "Trip"\nsource = ".archer/trip.mmd"\n',
        ".archer/chat.mmd":
          "sequenceDiagram\n  participant A as Customer\n  participant B as Shop\n  A->>B: Order\n  B-->>A: Receipt\n",
        ".archer/trip.mmd":
          "journey\n  title Buying a book\n  section Find\n    Search the shop: 3: Reader\n    Pick a book: 5: Reader\n",
      },
    });
    try {
      await server.present("chat");
      await page.goto(server.url);
      const box = page.locator('[data-seq-channel="participants"][data-seq-id="B"] .archer-seq-participant-box');
      await expect(box).toBeVisible();
      await server.setEmphasis("chat", [
        { id: "e", groups: [{ id: "g", label: "Shop side", style: "highlight", nodes: ["B"], edges: ["msg-1"] }] },
      ]);
      const g1 = await page.evaluate(() => {
        const probe = document.createElement("div");
        probe.style.color = "var(--g1)";
        document.querySelector(".archer-seq-canvas")!.append(probe);
        const value = getComputedStyle(probe).color;
        probe.remove();
        return value;
      });
      await expect.poll(() => box.evaluate((element) => getComputedStyle(element).stroke)).toBe(g1);
      const reply = page.locator('[data-seq-channel="messages"][data-seq-id="msg-1"]');
      const line = await reply
        .locator(".archer-seq-message-stroke :is(line, path)")
        .first()
        .evaluate((element) => {
          const style = getComputedStyle(element);
          return { stroke: style.stroke, dash: style.strokeDasharray };
        });
      expect(line.stroke).toBe(g1);
      // The reply keeps the notation's own dash.
      expect(line.dash).not.toBe("none");
      await expect(
        page.locator(
          ".archer-seq-emph-ring, .archer-seq-emph-glow, .archer-seq-emph-band, .archer-seq-emph-label, .archer-seq-emph-lifeline",
        ),
      ).toHaveCount(0);

      await server.present("trip");
      const card = page.locator('[data-journey-id="search-the-shop"]');
      await expect(card).toBeVisible();
      await server.setEmphasis("trip", [
        {
          id: "e",
          groups: [{ id: "g", label: "Searching", style: "highlight", nodes: ["search-the-shop"], edges: [] }],
        },
      ]);
      await expect.poll(() => card.evaluate((element) => getComputedStyle(element).borderTopColor)).toBe(g1);
      const drawn = await card.evaluate((element) => {
        const style = getComputedStyle(element);
        return { outline: style.outlineStyle, animation: style.animationName };
      });
      expect(drawn).toEqual({ outline: "none", animation: "none" });
    } finally {
      await server.stop();
    }
  });
}
