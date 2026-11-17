import { expect, test } from "vitest";
import { compile } from "../../src/mermaid/index.ts";
import { revisionOf } from "../../src/project/index.ts";
import { addressable } from "../../src/service/emphasis.ts";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  assertSafeThumbnail,
  exportDiagram,
  exportThumbnail,
  rasterizeThumbnail,
  THUMBNAIL_BOX,
  THUMBNAIL_PNG_BOX,
  ExportRefusal,
  type ExportResources,
} from "../../src/export/index.ts";
import { testFontFaces, testResources } from "./resources.ts";
import { rgba } from "./png-decode.ts";

/** SVG export needs no WASM renderer; the theme and font are the checkout's own. */
async function svgResources(): Promise<ExportResources> {
  return {
    themeCss: await readFile(resolve("../ui/src/styles.css"), "utf8"),
    fontLicense: await readFile(resolve("../ui/src/theme/fonts/FiraSans-OFL.txt"), "utf8"),
    fontFaces: testFontFaces(),
    wasmBytes: new Uint8Array(),
  };
}

async function envelopeOf(source: string, id = "drawing") {
  const compiled = await compile(source);
  expect(compiled.model).not.toBeNull();
  return {
    schemaVersion: 2 as const,
    revision: revisionOf(new TextEncoder().encode(source)),
    view: { id, kind: "freeform" as const, title: "Drawing" },
    model: compiled.model!,
  };
}

test("a thumbnail is a small self-contained SVG of the compiled drawing, without the embedded font", async () => {
  const envelope = await envelopeOf('flowchart LR\n a["Request & response"]\n b[API]\n a calls@--> b\n');
  const resources = await svgResources();
  const thumb = await exportThumbnail(envelope, { theme: "dark", themeCss: resources.themeCss });
  const full = await exportDiagram(envelope, { resources });
  const svg = new TextDecoder().decode(thumb.bytes);
  expect(thumb.revision).toBe(envelope.revision);
  expect(svg.startsWith("<svg ")).toBe(true);
  expect(svg).toContain("Request &amp; response");
  expect(svg).toContain('data-element-id="calls"');
  expect(svg).not.toContain("font/woff2");
  expect(svg).not.toContain("<metadata");
  expect(thumb.bytes.length).toBeLessThan(full.bytes.length / 4);
  expect(thumb.width).toBeLessThanOrEqual(THUMBNAIL_BOX.width);
  expect(thumb.height).toBeLessThanOrEqual(THUMBNAIL_BOX.height);
  expect(() => assertSafeThumbnail(svg)).not.toThrow();
});

test("light and dark thumbnails use their theme's literal colours", async () => {
  const envelope = await envelopeOf("flowchart LR\n a[A]\n");
  const { themeCss } = await svgResources();
  const dark = new TextDecoder().decode((await exportThumbnail(envelope, { theme: "dark", themeCss })).bytes);
  const light = new TextDecoder().decode((await exportThumbnail(envelope, { theme: "light", themeCss })).bytes);
  expect(dark).not.toBe(light);
  expect(dark).not.toContain("var(--");
});

// Every family the painter draws passes the guard, so a family cannot lose its thumbnail unnoticed.
const families = [
  ["flowchart", "freeform"],
  ["state", "state"],
  ["er", "entity-relationship"],
  ["c4", "c4"],
  ["architecture", "architecture"],
  ["sequence", "sequence"],
  ["journey", "journey"],
] as const;
test.each(families)(
  "%s thumbnails keep their elements, fit the box and pass the guard",
  async (family, kind) => {
    const source = await readFile(resolve(import.meta.dirname, `../fixtures/${family}/widened.mmd`), "utf8"),
      compiled = await compile(source);
    expect(compiled.model, JSON.stringify(compiled.diagnostics)).not.toBeNull();
    const envelope = {
      schemaVersion: 2,
      revision: revisionOf(new TextEncoder().encode(source)),
      view: { id: "thumb", title: "Fixture", kind },
      model: compiled.model!,
    };
    const thumb = await exportThumbnail(envelope, { theme: "light", themeCss: (await svgResources()).themeCss });
    const svg = new TextDecoder().decode(thumb.bytes);
    for (const id of addressable(compiled.model!).nodes) expect(svg).toContain(`data-element-id="${id}"`);
    expect(thumb.width).toBeLessThanOrEqual(THUMBNAIL_BOX.width);
    expect(thumb.height).toBeLessThanOrEqual(THUMBNAIL_BOX.height);
  },
  20_000,
);

test.each([
  ["a script element", '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'],
  ["an event handler", '<svg xmlns="http://www.w3.org/2000/svg"><rect onload="alert(1)"/></svg>'],
  ["a foreign object", '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject/></svg>'],
  ["an external link", '<svg xmlns="http://www.w3.org/2000/svg"><a href="https://example.test">x</a></svg>'],
  ["an xlink reference", '<svg xmlns="http://www.w3.org/2000/svg"><use xlink:href="other.svg#a"/></svg>'],
  [
    "an external url()",
    '<svg xmlns="http://www.w3.org/2000/svg"><rect style="fill:url(https://example.test/a)"/></svg>',
  ],
  ["a stylesheet import", '<svg xmlns="http://www.w3.org/2000/svg"><style>@import "x.css";</style></svg>'],
  ["an image", '<svg xmlns="http://www.w3.org/2000/svg"><image/></svg>'],
  ["a javascript: URL", '<svg xmlns="http://www.w3.org/2000/svg"><rect style="x:javascript:1"/></svg>'],
  ["not an svg", "<html></html>"],
  // C-14: a prefixed element is the same element to an XML parser; a handler needs no whitespace before it.
  [
    "a prefixed script element",
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:svg="http://www.w3.org/2000/svg"><svg:script>alert(1)</svg:script></svg>',
  ],
  [
    "a prefixed foreign object",
    '<svg xmlns="http://www.w3.org/2000/svg"><x:foreignObject xmlns:x="http://www.w3.org/2000/svg"/></svg>',
  ],
  [
    "a namespace declaration",
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:h="http://www.w3.org/1999/xhtml"><rect/></svg>',
  ],
  [
    "a handler right after a quoted value",
    '<svg xmlns="http://www.w3.org/2000/svg"><rect x="1"onload="alert(1)"/></svg>',
  ],
  ["a handler after a slash", '<svg xmlns="http://www.w3.org/2000/svg"><g/onload=alert(1)></g></svg>'],
  ["a handler in upper case", '<svg xmlns="http://www.w3.org/2000/svg"><rect ONCLICK="x"/></svg>'],
  ["an entity-encoded script URL", '<svg xmlns="http://www.w3.org/2000/svg"><rect style="x:&#106;avascript:1"/></svg>'],
  [
    "an external url() in a style element",
    '<svg xmlns="http://www.w3.org/2000/svg"><style>rect{fill:url(https://example.test/a)}</style></svg>',
  ],
  ["a handler after a quoted >", '<svg xmlns="http://www.w3.org/2000/svg"><rect title=">" onload="alert(1)"/></svg>'],
  ["an unclosed tag", '<svg xmlns="http://www.w3.org/2000/svg"><rect title="x></svg>'],
  [
    "a comment or CDATA section",
    '<svg xmlns="http://www.w3.org/2000/svg"><style><![CDATA[@import "x.css";]]></style></svg>',
  ],
  // C-28: a default namespace other than SVG makes an element XHTML (a `<meta http-equiv=refresh>` runs).
  [
    "a default XHTML namespace on an element",
    '<svg xmlns="http://www.w3.org/2000/svg"><g xmlns="http://www.w3.org/1999/xhtml"><meta http-equiv="refresh" content="0;url=https://example.test"/></g></svg>',
  ],
  ["a default XHTML namespace on the root", '<svg xmlns="http://www.w3.org/1999/xhtml"><rect/></svg>'],
  [
    "an entity-encoded default namespace",
    '<svg xmlns="http://www.w3.org/2000/svg"><g xmlns="&#104;ttp://www.w3.org/1999/xhtml"><meta/></g></svg>',
  ],
  [
    "an unquoted default namespace",
    '<svg xmlns="http://www.w3.org/2000/svg"><g xmlns=http://www.w3.org/1999/xhtml><meta/></g></svg>',
  ],
  [
    "a near-SVG default namespace",
    '<svg xmlns="http://www.w3.org/2000/svg"><g xmlns=" http://www.w3.org/2000/svg"/></svg>',
  ],
  ["an empty default namespace", '<svg xmlns="http://www.w3.org/2000/svg"><g xmlns=""><meta/></g></svg>'],
  [
    "a foreign object in the XHTML namespace",
    '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject xmlns="http://www.w3.org/1999/xhtml"><meta/></foreignObject></svg>',
  ],
  ["a lower-case foreign object", '<svg xmlns="http://www.w3.org/2000/svg"><foreignobject/></svg>'],
])("the thumbnail guard refuses %s", (_name, svg) => {
  expect(() => assertSafeThumbnail(svg)).toThrow(ExportRefusal);
});

test("the guard keeps the SVG default namespace, on the root and repeated on an element (C-28)", () => {
  expect(() =>
    assertSafeThumbnail(
      '<svg xmlns="http://www.w3.org/2000/svg"><g xmlns="http://www.w3.org/2000/svg"><rect/></g></svg>',
    ),
  ).not.toThrow();
});

test("the guard reads markup, not label text: escaped labels that spell attributes or CSS are allowed (C-14)", async () => {
  const labels = [
    "src=x",
    "onload=1",
    "href=y",
    "url(https://example.test/a)",
    "javascript:void",
    "@import x",
    "use a b",
    "a & b > c",
  ];
  const envelope = await envelopeOf(
    `flowchart LR\n${labels.map((label, i) => ` n${i}["${label.replace(/"/g, "#quot;")}"]`).join("\n")}\n`,
  );
  const svg = new TextDecoder().decode(
    (await exportThumbnail(envelope, { theme: "light", themeCss: (await svgResources()).themeCss })).bytes,
  );
  expect(svg).toContain("src=x");
  expect(svg).toContain("a &amp; b &gt; c");
  expect(() => assertSafeThumbnail(svg)).not.toThrow();
  expect(() =>
    assertSafeThumbnail(
      '<svg xmlns="http://www.w3.org/2000/svg"><text>src=x onload=1 url(http://x) &lt;script&gt;</text></svg>',
    ),
  ).not.toThrow();
});

test("the guard allows in-document marker references", () => {
  expect(() =>
    assertSafeThumbnail('<svg xmlns="http://www.w3.org/2000/svg"><path marker-end="url(#e1-end)"/></svg>'),
  ).not.toThrow();
});

test("a drawing larger than the export dimension limit is scaled into the thumbnail box, not refused", async () => {
  const count = 130;
  const lines = [
    "flowchart LR",
    ...Array.from({ length: count }, (_, i) => ` n${i}["Step number ${i} of a long chain"]`),
    ...Array.from({ length: count - 1 }, (_, i) => ` n${i} e${i}@--> n${i + 1}`),
  ];
  const envelope = await envelopeOf(`${lines.join("\n")}\n`);
  const resources = await svgResources();
  await expect(exportDiagram(envelope, { resources })).rejects.toMatchObject({ code: "export_extent_limit" });
  const thumb = await exportThumbnail(envelope, { theme: "light", themeCss: resources.themeCss });
  expect(thumb.width).toBeLessThanOrEqual(THUMBNAIL_BOX.width);
  expect(thumb.height).toBeLessThanOrEqual(THUMBNAIL_BOX.height);
  expect(() => assertSafeThumbnail(new TextDecoder().decode(thumb.bytes))).not.toThrow();
}, 30_000);

test("a PNG thumbnail is the same drawing rasterized to fit the PNG box, with visible glyphs", async () => {
  const envelope = await envelopeOf('flowchart LR\n a["VISIBLE GLYPHS"]\n b[API]\n a calls@--> b\n');
  const resources = await testResources();
  const thumb = await exportThumbnail(envelope, { theme: "dark", themeCss: resources.themeCss });
  const png = await rasterizeThumbnail(thumb, resources);
  expect([...png.bytes.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  const image = rgba(png.bytes);
  expect([image.width, image.height]).toEqual([png.width, png.height]);
  // Contained in the box, touching it on one side, with the drawing's proportions.
  expect(png.width).toBeLessThanOrEqual(THUMBNAIL_PNG_BOX.width);
  expect(png.height).toBeLessThanOrEqual(THUMBNAIL_PNG_BOX.height);
  expect(png.width === THUMBNAIL_PNG_BOX.width || png.height === THUMBNAIL_PNG_BOX.height).toBe(true);
  expect(Math.abs(png.width / png.height - thumb.width / thumb.height)).toBeLessThan(0.05);
  // Dark theme: light text pixels on the node boxes; opaque everywhere (the background is painted).
  let light = 0,
    transparent = 0;
  for (let i = 0; i < image.pixels.length; i += 4) {
    if (image.pixels[i]! > 180 && image.pixels[i + 1]! > 180 && image.pixels[i + 2]! > 180) light++;
    if (image.pixels[i + 3] !== 255) transparent++;
  }
  expect(light).toBeGreaterThan(200);
  expect(transparent).toBe(0);
  const again = await rasterizeThumbnail(thumb, resources);
  expect(Buffer.from(again.bytes).equals(Buffer.from(png.bytes))).toBe(true);
});

test("PNG labels keep their weight: the semibold and bold Fira Sans faces draw them, not the regular (speed round)", async () => {
  const envelope = await envelopeOf('flowchart LR\n a["HEAVY LABEL TEXT"]\n b["MORE LABEL TEXT"]\n a calls@--> b\n');
  const resources = await testResources();
  const thumb = await exportThumbnail(envelope, { theme: "dark", themeCss: resources.themeCss });
  const lightPixels = (png: Uint8Array): number => {
    const image = rgba(png);
    let light = 0;
    for (let i = 0; i < image.pixels.length; i += 4)
      if (image.pixels[i]! > 180 && image.pixels[i + 1]! > 180 && image.pixels[i + 2]! > 180) light++;
    return light;
  };
  const bold = await rasterizeThumbnail(thumb, resources);
  const regularOnly = { ...resources, fontFaces: resources.fontFaces.filter((face) => face.weight === 400) };
  const thin = await rasterizeThumbnail(thumb, regularOnly);
  expect(lightPixels(bold.bytes)).toBeGreaterThan(lightPixels(thin.bytes) * 1.15);
  // The box covers a 2x-DPR gallery card (~258x145 CSS px on desktop, ~314x177 on a phone).
  expect(THUMBNAIL_PNG_BOX).toEqual({ width: 640, height: 360 });
});

test("a thumbnail is set in the face and tracking its layout was measured in, not the reader's sans-serif", async () => {
  // The painter sized every box for Fira Sans with +0.04em a character: a thumbnail that falls back to the
  // reader's system face, or drops the tracking, draws labels wider or narrower than their boxes.
  const envelope = await envelopeOf(
    'flowchart LR\n a["Orders database<br/>the regular description line"]\n b[API]\n a calls@-->|"reads"| b\n',
  );
  const resources = await testResources();
  const thumb = await exportThumbnail(envelope, { theme: "light", themeCss: resources.themeCss });
  const svg = new TextDecoder().decode(thumb.bytes);
  expect(svg).toMatch(/<g [^>]*font-family="Fira Sans, sans-serif">/);
  expect(svg).toContain("text{letter-spacing:0.04em}");
  expect(svg).not.toMatch(/Inter|ui-sans-serif|system-ui/);
  // And its PNG is drawn in those faces: the regular face's bytes are what draw the regular text.
  const drawn = await rasterizeThumbnail(thumb, resources);
  const italicAsRegular = {
    ...resources,
    fontFaces: resources.fontFaces.map((face) =>
      face.weight === 400 && face.style === "normal"
        ? { ...face, bytes: resources.fontFaces.find((other) => other.style === "italic")!.bytes }
        : face,
    ),
  };
  const swapped = await rasterizeThumbnail(thumb, italicAsRegular);
  expect(Buffer.from(swapped.bytes).equals(Buffer.from(drawn.bytes))).toBe(false);
});

test("a PNG thumbnail of a drawing past the export limit still fits the box", async () => {
  const lines = [
    "flowchart LR",
    ...Array.from({ length: 130 }, (_, i) => ` n${i}["Step number ${i} of a long chain"]`),
    ...Array.from({ length: 129 }, (_, i) => ` n${i} e${i}@--> n${i + 1}`),
  ];
  const resources = await testResources();
  const thumb = await exportThumbnail(await envelopeOf(`${lines.join("\n")}\n`), {
    theme: "light",
    themeCss: resources.themeCss,
  });
  const png = await rasterizeThumbnail(thumb, resources);
  expect(png.width).toBe(THUMBNAIL_PNG_BOX.width);
  expect(png.height).toBeLessThanOrEqual(THUMBNAIL_PNG_BOX.height);
}, 30_000);

test("rasterizing refuses something that is not a safe thumbnail", async () => {
  const resources = await testResources();
  const unsafe = new TextEncoder().encode(
    '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>1</script></svg>',
  );
  await expect(rasterizeThumbnail({ bytes: unsafe, width: 10, height: 10 }, resources)).rejects.toBeInstanceOf(
    ExportRefusal,
  );
});
