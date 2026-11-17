import { test, expect } from "vitest";
import { compile } from "../../src/mermaid/index.ts";
import { exportDiagram } from "../../src/export/index.ts";
import { testResources } from "./resources.ts";
import { rgba } from "./png-decode.ts";
test("exported PNG contains visible Fira Sans glyphs inside the actual node box", async () => {
  const source = "flowchart LR\n a[VISIBLE GLYPHS]\n",
    model = (await compile(source)).model!,
    resources = await testResources(),
    envelope = {
      schemaVersion: 2,
      revision: `sha256:${"a".repeat(64)}`,
      view: { id: "test", kind: "freeform", title: "Test" },
      model,
    };
  const result = await exportDiagram(envelope, { resources, format: "png" }),
    image = rgba(result.bytes);
  // Single-node layout starts at (12,12), export gutter is 20. Its text is centered.
  let lightPixels = 0;
  for (let y = 50; y < 77; y++)
    for (let x = 50; x < 195; x++) {
      const i = (y * image.width + x) * 4;
      if (
        image.pixels[i]! > 180 &&
        image.pixels[i + 1]! > 180 &&
        image.pixels[i + 2]! > 180 &&
        image.pixels[i + 3] === 255
      )
        lightPixels++;
    }
  expect(lightPixels).toBeGreaterThan(100);
});
test("a PNG is drawn in the packaged faces, by weight and slant, not in a host font", async () => {
  // A label and its description: the title is 700 (bold, redesign slice 4), the description 400. Swapping the bytes behind one face
  // changes the pixels only if that face is what draws them.
  const source = 'flowchart LR\n a["HEAVY TITLE<br/>regular description text"]\n',
    model = (await compile(source)).model!,
    resources = await testResources(),
    envelope = {
      schemaVersion: 2,
      revision: `sha256:${"a".repeat(64)}`,
      view: { id: "test", kind: "freeform", title: "Test" },
      model,
    };
  const draw = async (faces: typeof resources.fontFaces) =>
    rgba((await exportDiagram(envelope, { resources: { ...resources, fontFaces: faces }, format: "png" })).bytes);
  const bytesOf = (weight: number, style: string) =>
    resources.fontFaces.find((face) => face.weight === weight && face.style === style)!.bytes;
  const drawn = await draw(resources.fontFaces);
  for (const [weight, style, stand] of [
    [400, "normal", bytesOf(400, "italic")],
    [700, "normal", bytesOf(400, "normal")],
  ] as const) {
    const swapped = await draw(
      resources.fontFaces.map((face) =>
        face.weight === weight && face.style === style ? { ...face, bytes: stand } : face,
      ),
    );
    expect(Buffer.from(swapped.pixels).equals(Buffer.from(drawn.pixels)), `${weight} ${style}`).toBe(false);
  }
});
test("a PNG is refused without the regular face, rather than drawn in whatever the host has", async () => {
  const model = (await compile("flowchart LR\n a[One]\n")).model!,
    resources = await testResources(),
    envelope = {
      schemaVersion: 2,
      revision: `sha256:${"a".repeat(64)}`,
      view: { id: "test", kind: "freeform", title: "Test" },
      model,
    };
  await expect(
    exportDiagram(envelope, {
      resources: { ...resources, fontFaces: resources.fontFaces.filter((face) => face.weight !== 400) },
      format: "png",
    }),
  ).rejects.toMatchObject({ code: "export_resources_missing" });
});
test("PNG edge emphasis paints its actual palette over the production edge stroke", async () => {
  const source = "flowchart LR\n a[One]\n b[Two]\n a calls@--> b\n",
    model = (await compile(source)).model!,
    resources = await testResources(),
    envelope = {
      schemaVersion: 2,
      revision: `sha256:${"a".repeat(64)}`,
      view: { id: "test", kind: "freeform", title: "Test" },
      model,
    };
  const result = await exportDiagram(envelope, {
      resources,
      format: "png",
      mode: "presentation",
      presentation: {
        diagramKey: false,
        emphases: [
          {
            id: "mark",
            viewId: "test",
            groups: [
              { id: "call", style: "highlight", palette: "coral", state: "existing", nodes: [], edges: ["calls"] },
            ],
          },
        ],
      },
    }),
    image = rgba(result.bytes);
  const color = resources.themeCss.match(/--g1:\s*(#[a-fA-F0-9]{6})/)![1]!;
  const target = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
  let painted = 0;
  for (let i = 0; i < image.pixels.length; i += 4) if (target.every((v, j) => image.pixels[i + j] === v)) painted++;
  expect(painted).toBeGreaterThan(20);
});
test("PNG group panel matches the canonical CSS theme instead of turning black", async () => {
  const source = "flowchart TB\n subgraph scope[Scope]\n a[One]\n end\n",
    model = (await compile(source)).model!,
    resources = await testResources(),
    envelope = {
      schemaVersion: 2,
      revision: `sha256:${"a".repeat(64)}`,
      view: { id: "test", kind: "freeform", title: "Test" },
      model,
    };
  const svg = new TextDecoder().decode((await exportDiagram(envelope, { resources })).bytes),
    rectangle = svg.match(/data-element-id="scope"[^>]*><rect x="([^"]+)" y="([^"]+)"/)!;
  const image = rgba((await exportDiagram(envelope, { resources, format: "png" })).bytes),
    x = Number(rectangle[1]) + 24,
    y = Number(rectangle[2]) + 60,
    i = (y * image.width + x) * 4;
  // A plain group is the neutral outermost panel (DESIGN.md, Diagram palette; owner, 2026-11-12), opaque, which
  // the PNG must paint as the theme's own literal (dark, the export default), never black. Read from the theme
  // so a palette change keeps this honest; WASM rounding may move one 8-bit channel.
  const dark = resources.themeCss.slice(resources.themeCss.indexOf(':root[data-theme="dark"]'));
  const panel = /--group-bg:\s*#([0-9a-f]{6})/.exec(dark)![1]!;
  const target = [0, 2, 4].map((at) => Number.parseInt(panel.slice(at, at + 2), 16));
  expect(Math.max(...target)).toBeGreaterThan(16);
  for (const [channel, value] of target.entries())
    expect(Math.abs(image.pixels[i + channel]! - value)).toBeLessThanOrEqual(1);
});

for (const [kind, source] of [
  ["freeform", "flowchart TB\n a[One]\n b[Two]\n a both@<--> b\n"],
  ["c4", 'C4Container\n Container(a, "One", "App")\n Container(b, "Two", "App")\n BiRel(a, b, "Calls")\n'],
] as const) {
  test(`${kind}: PNG renders both complete arrowheads on a vertical relationship`, async () => {
    const compiled = await compile(source);
    expect(compiled.model, JSON.stringify(compiled.diagnostics)).not.toBeNull();
    const resources = await testResources();
    const envelope = {
      schemaVersion: 2,
      revision: `sha256:${"a".repeat(64)}`,
      view: { id: "test", kind, title: "Arrowheads" },
      model: compiled.model,
    };
    const svg = new TextDecoder().decode((await exportDiagram(envelope, { resources })).bytes);
    const origin = svg
      .match(/viewBox="([^"]+)"/)![1]!
      .split(" ")
      .map(Number);
    const route = svg
      .match(/class="export-edge-line" d="([^"]+)"/)![1]!
      .match(/-?\d+(?:\.\d+)?/g)!
      .map(Number);
    const image = rgba((await exportDiagram(envelope, { resources, format: "png", scale: 4 })).bytes);
    const markerInk = svg.match(/class="arrowclosed"[^>]*stroke:(#[a-fA-F0-9]{6})/)![1]!;
    const ink = [1, 3, 5].map((i) => parseInt(markerInk.slice(i, i + 2), 16));
    for (const at of ["start", "end"] as const) {
      const [x, y, nextX, nextY] =
        at === "start" ? route.slice(0, 4) : [route.at(-2)!, route.at(-1)!, route.at(-4)!, route.at(-3)!];
      const length = Math.hypot(nextX! - x!, nextY! - y!);
      const dx = (nextX! - x!) / length,
        dy = (nextY! - y!) / length;
      const sides = [0, 0];
      // Count ink off the shaft, in the triangle behind each arrow tip. Inspect
      // actual PNG bytes in layout coordinates, independently of marker orient.
      for (let py = Math.floor((y! - origin[1]! - 9) * 4); py <= (y! - origin[1]! + 9) * 4; py++) {
        for (let px = Math.floor((x! - origin[0]! - 9) * 4); px <= (x! - origin[0]! + 9) * 4; px++) {
          const ox = origin[0]! + (px + 0.5) / 4 - x!,
            oy = origin[1]! + (py + 0.5) / 4 - y!;
          const behind = ox * dx + oy * dy,
            across = ox * -dy + oy * dx;
          if (behind < 1 || behind > 7 || Math.abs(across) < 1.5 || Math.abs(across) > 5.5) continue;
          const offset = (py * image.width + px) * 4;
          if (ink.every((value, channel) => Math.abs(image.pixels[offset + channel]! - value) <= 8))
            sides[across < 0 ? 0 : 1]!++;
        }
      }
      expect.soft(sides[0], `${at}: left half of filled head`).toBeGreaterThan(80);
      expect.soft(sides[1], `${at}: right half of filled head`).toBeGreaterThan(80);
      expect.soft(Math.min(...sides) / Math.max(...sides), `${at}: symmetric head`).toBeGreaterThan(0.85);
    }
  });
}

test("C4 PNG paints relationship technology glyphs rather than dropping the hidden detail", async () => {
  const resources = await testResources();
  const images = [];
  for (const technology of ["HTTPS", "AMQPS"]) {
    const source = `C4Container\n Container(a, "One", "App")\n Container(b, "Two", "App")\n Rel(a, b, "Calls", "${technology}")\n`;
    const model = (await compile(source)).model!;
    const envelope = {
      schemaVersion: 2,
      revision: `sha256:${"a".repeat(64)}`,
      view: { id: "test", kind: "c4", title: "Technologies" },
      model,
    };
    const svg = new TextDecoder().decode((await exportDiagram(envelope, { resources })).bytes);
    const row = [...svg.matchAll(/<tspan x="([^"]+)" y="([^"]+)">([^<]+)<\/tspan>/g)].find(
      (match) => match[3] === `[${technology}]`,
    )!;
    expect(row, "technology has a painted caption row").toBeDefined();
    const origin = svg
      .match(/viewBox="([^"]+)"/)![1]!
      .split(" ")
      .map(Number);
    const image = rgba((await exportDiagram(envelope, { resources, format: "png" })).bytes);
    let glyphPixels = 0;
    const cx = Number(row[1]) - origin[0]!,
      baseline = Number(row[2]) - origin[1]!;
    for (let y = Math.floor(baseline - 11); y < baseline + 1; y++)
      for (let x = Math.floor(cx - 24); x < cx + 24; x++) {
        const at = (y * image.width + x) * 4;
        // Glyph ink on the dark plate (#191816): the label's dim ink (--text-dim, #aaa49a, since the diagram
        // palette made connection labels light; owner 2026-11-11), well clear of the plate in every channel.
        if ([0, 1, 2].every((channel) => image.pixels[at + channel]! > 120)) glyphPixels++;
      }
    expect(glyphPixels, "visible technology glyphs inside the PNG caption").toBeGreaterThan(50);
    images.push(image);
  }
  // The model technology is the only changed input. PNG has no textual metadata, so distinct pixels
  // prove that the relationship detail reaches the raster painter, beyond an SVG string assertion.
  expect(images[0]!.pixels).not.toEqual(images[1]!.pixels);
});
