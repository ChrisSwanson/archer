// @vitest-environment jsdom
// The page build draws the export painter's glyphs with React's client renderer (`src/export/static-markup-page.ts`)
// in place of `react-dom/server`. Every fixture the painter draws must come out byte for byte as the server renderer
// draws it, in both export modes.
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadModelEnvelope, loadValidFixture } from "./fixtures";

const using = vi.hoisted(() => ({ page: false }));
vi.mock("react-dom/server", async (original) => {
  const real = await original<typeof import("react-dom/server")>();
  const page = await import("../src/export/static-markup-page");
  return {
    ...real,
    renderToStaticMarkup: (element: Parameters<typeof real.renderToStaticMarkup>[0]) =>
      using.page ? page.renderToStaticMarkup(element as never) : real.renderToStaticMarkup(element),
  };
});
const { paintExport } = await import("../src/export/painter");

const golden = readdirSync(resolve(process.cwd(), "../ts/test/fixtures")).flatMap((type) =>
  readdirSync(resolve(process.cwd(), "../ts/test/fixtures", type))
    .filter((f) => f.endsWith(".json"))
    .map((f) => [type, f.slice(0, -5)] as const),
);
const protocol = readdirSync(resolve(process.cwd(), "../fixtures/protocol/valid")).filter((f) => f.endsWith(".json"));
const envelopes: [string, unknown][] = [
  ...golden.map(([type, name]) => [`${type}/${name}`, loadModelEnvelope(type, name)] as [string, unknown]),
  ...protocol.map((name) => [name, loadValidFixture(name)] as [string, unknown]),
];

describe("the page's static markup", () => {
  it.each(envelopes)("draws %s as the server renderer does", async (_name, envelope) => {
    for (const mode of ["diagram", "presentation"] as const) {
      using.page = false;
      let server: string;
      try {
        server = (await paintExport({ envelope, mode } as never)).content;
      } catch {
        continue;
      }
      expect(server.length).toBeGreaterThan(0);
      using.page = true;
      const page = (await paintExport({ envelope, mode } as never)).content;
      if (page !== server) {
        let i = 0;
        while (page[i] === server[i]) i += 1;
        expect(page.slice(Math.max(0, i - 80), i + 80)).toBe(server.slice(Math.max(0, i - 80), i + 80));
      }
    }
  });
});

describe("every glyph the painter draws through it", async () => {
  const { createElement } = await import("react");
  const real = await vi.importActual<typeof import("react-dom/server")>("react-dom/server");
  const page = await import("../src/export/static-markup-page");
  const { KindGlyph } = await import("../src/export/KindGlyph");
  const { KeySymbol, ICONS } = await import("../src/export/KeySymbol");
  const { PersonGlyph, ArchitectureGlyph } = await import("../src/diagrams/FigureGlyphs");
  const { ArrowMarkers } = await import("../src/diagrams/ArrowMarkers");
  const { EdgeEnds } = await import("../src/diagrams/EdgeEnds");
  const { Arrowhead, ActorGlyph } = await import("../src/diagrams/SequencePrimitives");
  const { NODE_KINDS } = await import("../src/layout/graph-metrics");
  const { CARDINALITIES, ARCHITECTURE_ICONS } = await import("../src/diagrams/figures");
  const labels = [
    "person",
    "actor",
    "actors",
    "queue",
    "call",
    "reply",
    "async message",
    "external",
    "thick line",
    "thick line: x",
    "dotted line",
    "dashed line",
    "dash-dot line",
    "undirected",
    "lifelines",
    "fork",
    "join",
    "activation",
    "score rail",
    "satisfaction score",
    "section",
    "start",
    "end",
    "choice",
    "composite",
    "state note",
    "note",
    "boundary",
    "group",
    "database",
    "junction",
    "message numbers",
    "identifying",
    "non-identifying",
    "zero or more",
    "more",
    "cloud icon",
    "internet icon",
    "disk icon",
    "server icon",
    "a person line: dotted",
    "Something <&> \"'",
    ...Object.values(ICONS as Record<string, string>).map((title) => `${title} icon`),
  ];
  const cases: [string, unknown, Record<string, unknown>][] = [
    ...NODE_KINDS.map(
      (kind) => [`KindGlyph ${kind}`, KindGlyph, { kind }] as [string, unknown, Record<string, unknown>],
    ),
    ...labels.map(
      (label) => [`KeySymbol ${label}`, KeySymbol, { label }] as [string, unknown, Record<string, unknown>],
    ),
    ...[16, 26, 28].map(
      (size) => [`PersonGlyph ${size}`, PersonGlyph, { size }] as [string, unknown, Record<string, unknown>],
    ),
    ...ARCHITECTURE_ICONS.flatMap((icon) =>
      [16, 28, undefined].map(
        (size) =>
          [`ArchitectureGlyph ${icon} ${size}`, ArchitectureGlyph, { icon, size }] as [
            string,
            unknown,
            Record<string, unknown>,
          ],
      ),
    ),
    ...[
      [undefined, 8],
      [8, undefined],
      [6, 10],
      [undefined, undefined],
    ].map(
      ([start, end]) =>
        [`ArrowMarkers ${start} ${end}`, ArrowMarkers, { id: "e<1>", start, end }] as [
          string,
          unknown,
          Record<string, unknown>,
        ],
    ),
    ...CARDINALITIES.flatMap((source) =>
      CARDINALITIES.map(
        (target) =>
          [
            `EdgeEnds ${source} ${target}`,
            EdgeEnds,
            {
              figure: { type: "cardinality", source, target },
              route: [
                { x: 0, y: 0 },
                { x: 40, y: 10 },
                { x: 80, y: 30 },
              ],
            },
          ] as [string, unknown, Record<string, unknown>],
      ),
    ),
    [
      "EdgeEnds none",
      EdgeEnds,
      {
        figure: { type: "plain" },
        route: [
          { x: 0, y: 0 },
          { x: 1, y: 1 },
        ],
      },
    ],
    ...[1, -1].flatMap((direction) =>
      [true, false].map(
        (open) =>
          [`Arrowhead ${direction} ${open}`, Arrowhead, { tipX: 10.5, y: 3, direction, open }] as [
            string,
            unknown,
            Record<string, unknown>,
          ],
      ),
    ),
    ["ActorGlyph", ActorGlyph, { x: 4, y: 7.25 }],
  ];
  it.each(cases)("%s", (_name, component, props) => {
    const element = createElement(component as never, props as never);
    expect(page.renderToStaticMarkup(element)).toBe(real.renderToStaticMarkup(element));
  });
});
