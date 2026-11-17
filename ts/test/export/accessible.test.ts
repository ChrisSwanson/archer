import { expect, test } from "vitest";
import { compile } from "../../src/mermaid/index.ts";
import { exportDiagram } from "../../src/export/index.ts";
import { runExportOperation } from "../../src/application/export.ts";
import { OPERATIONS } from "../../src/application/index.ts";
import { testResources } from "./resources.ts";

// WCAG 2.2 SC 1.4.1: an accessible export says each highlight group by number and in words,
// so a greyscale print keeps what the hues meant.
const graph =
  "flowchart LR\n pay[Payment]\n bank[Bank & Trust]\n mail[Mailer]\n pay e1@--> bank\n pay e2@-->|notify| mail\n";
const sequence = "sequenceDiagram\nparticipant a as Reader\nparticipant b as Server\na->>b: Request\nb-->>a: Reply\n";
const journey = "journey\nsection Read\n Browse: 3: Reader\n";
const hostile = 'Pay <now> & "soon"';

async function envelopeOf(kind: string, source: string) {
  const model = (await compile(source)).model;
  expect(model).not.toBeNull();
  return { schemaVersion: 2, revision: `sha256:${"a".repeat(64)}`, view: { id: "test", kind, title: "Test" }, model };
}
type Members = { readonly nodes: readonly string[]; readonly edges: readonly string[] };
function presentationOf(one: Members, two?: Members, accessible?: boolean) {
  return {
    ...(accessible === undefined ? {} : { accessible }),
    emphases: [
      {
        id: "mark",
        viewId: "test",
        groups: [
          {
            id: "payment",
            label: hostile,
            style: "highlight" as const,
            palette: "teal" as const,
            state: "existing" as const,
            ...one,
          },
          ...(two
            ? [
                {
                  id: "email",
                  label: "email",
                  description: "Sends <mail>",
                  style: "flow" as const,
                  palette: "violet" as const,
                  state: "existing" as const,
                  speed: "normal" as const,
                  ...two,
                },
              ]
            : []),
        ],
      },
    ],
  };
}
async function svgOf(kind: string, source: string, presentation: object, format: "svg" | "png" = "svg") {
  const resources = await testResources();
  const result = await exportDiagram(await envelopeOf(kind, source), {
    resources,
    format,
    mode: "presentation",
    presentation,
  });
  return format === "svg" ? new TextDecoder().decode(result.bytes) : result;
}
// The drawing's markers; the key's own (one per group) come after, in the presentation panel.
const drawing = (svg: string) => svg.slice(0, svg.indexOf('data-export-presentation="true"') >>> 0);
const markers = (svg: string) =>
  [
    ...drawing(svg).matchAll(
      /<g class="export-emph-marker" transform="translate\(([-\d.e]+) ([-\d.e]+)\)" data-slot="(\d)">/g,
    ),
  ].map((m) => ({ x: Number(m[1]), y: Number(m[2]), slot: Number(m[3]) }));
const keyText = (svg: string) => {
  const panel = svg.slice(svg.indexOf('data-export-presentation="true"'));
  return panel.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
};
const nodeCorner = (svg: string, id: string) => {
  const m = svg.match(
    new RegExp(`data-element-id="${id}" data-element-channel="node"[^>]*data-x="([-\\d.e]+)" data-y="([-\\d.e]+)"`),
  )!;
  return { x: Number(m[1]), y: Number(m[2]) };
};

test("graph: an accessible export numbers each emphasised element, keys its members, and describes the groups", async () => {
  const svg = (await svgOf(
    "freeform",
    graph,
    presentationOf({ nodes: ["pay", "bank"], edges: ["e1"] }, { nodes: ["mail"], edges: ["e2"] }, true),
  )) as string;
  const drawn = markers(svg);
  expect(drawn.map((m) => m.slot).sort()).toEqual([1, 1, 1, 2, 2]);
  // A node's marker sits on its box's top-left corner.
  for (const [id, slot] of [
    ["pay", 1],
    ["bank", 1],
    ["mail", 2],
  ] as const)
    expect(drawn).toContainEqual({ ...nodeCorner(svg, id), slot });
  // Ringed in the group's hue, which export resolved to a literal.
  expect(svg).not.toContain("var(--");
  const key = keyText(svg);
  expect(key).toContain("Pay &lt;now&gt; &amp; &quot;soon&quot;");
  expect(key).toContain("Members: Payment, Bank &amp; Trust, Payment to Bank &amp; Trust");
  expect(key).toContain("Sends &lt;mail&gt;");
  expect(key).toContain("Members: Mailer, notify (Payment to Mailer)");
  // The key shows each group's marker too.
  expect(svg.slice(drawing(svg).length).match(/class="export-emph-marker"/g)).toHaveLength(2);
  expect(svg).toContain(
    "<desc>Highlights: 1 Pay &lt;now&gt; &amp; &quot;soon&quot; (Payment, Bank &amp; Trust, Payment to Bank &amp; Trust); 2 email (Mailer, notify (Payment to Mailer))</desc>",
  );
  expect(svg).not.toContain("<now>");
  expect(svg).not.toContain("<mail>");
  expect(svg).toMatch(/<title>Test<\/title><desc>/);
});

test("graph: an edge marker sits on the line, clear of its caption", async () => {
  const svg = (await svgOf(
    "freeform",
    graph,
    presentationOf({ nodes: [], edges: ["e1", "e2"] }, undefined, true),
  )) as string;
  const drawn = markers(svg);
  expect(drawn).toHaveLength(2);
  // Every marker is inside the drawing, not stacked at the origin.
  for (const m of drawn) expect(m.x).toBeGreaterThan(0);
  expect(new Set(drawn.map((m) => `${m.x},${m.y}`)).size).toBe(2);
});

test("sequence: participants are numbered at their corner and messages on their line", async () => {
  const svg = (await svgOf(
    "sequence",
    sequence,
    presentationOf({ nodes: ["a"], edges: ["msg-0"] }, { nodes: ["b"], edges: ["msg-1"] }, true),
  )) as string;
  const drawn = markers(svg);
  expect(drawn.map((m) => m.slot).sort()).toEqual([1, 1, 2, 2]);
  const participant = svg.match(
    /data-element-id="a" data-element-channel="node"[^>]*><path[^>]*\/><rect x="([-\d.e]+)" y="([-\d.e]+)"/,
  )!;
  expect(drawn).toContainEqual({ x: Number(participant[1]), y: Number(participant[2]), slot: 1 });
  const line = svg.match(
    /data-element-id="msg-1" data-element-channel="edge"[^>]*><path class="export-edge-line" d="M ([-\d.e]+) ([-\d.e]+) H ([-\d.e]+)"/,
  )!;
  const onLine = drawn.find((m) => m.slot === 2 && m.y === Number(line[2]));
  expect(onLine).toBeDefined();
  expect(onLine!.x).toBeGreaterThan(Math.min(Number(line[1]), Number(line[3])));
  expect(onLine!.x).toBeLessThan(Math.max(Number(line[1]), Number(line[3])));
  const key = keyText(svg);
  expect(key).toContain("Members: Reader, Request (Reader to Server)");
  expect(key).toContain("Members: Server, Reply (Server to Reader)");
  expect(svg).toContain(
    "<desc>Highlights: 1 Pay &lt;now&gt; &amp; &quot;soon&quot; (Reader, Request (Reader to Server)); 2 email (Server, Reply (Server to Reader))</desc>",
  );
});

test("journey: a task is numbered and named in the key", async () => {
  const svg = (await svgOf(
    "journey",
    journey,
    presentationOf({ nodes: ["browse"], edges: [] }, undefined, true),
  )) as string;
  expect(markers(svg).map((m) => m.slot)).toEqual([1]);
  expect(keyText(svg)).toContain("Members: Browse");
});

test("without accessible the export draws no marker or member key, and is the same as accessible: false", async () => {
  for (const [kind, source, one, two] of [
    ["freeform", graph, { nodes: ["pay", "bank"], edges: ["e1"] }, { nodes: ["mail"], edges: ["e2"] }],
    ["sequence", sequence, { nodes: ["a"], edges: ["msg-0"] }, { nodes: ["b"], edges: ["msg-1"] }],
  ] as const) {
    const omitted = (await svgOf(kind, source, presentationOf(one, two))) as string;
    const off = (await svgOf(kind, source, presentationOf(one, two, false))) as string;
    expect(off).toBe(omitted);
    expect(omitted).not.toContain("export-emph-marker");
    expect(omitted).not.toContain("Members:");
    // The description is invisible, so it is always there.
    expect(omitted).toContain("<desc>Highlights: 1 ");
  }
});

test("no emphasis, no description", async () => {
  const svg = (await svgOf("freeform", graph, { emphases: [], accessible: true })) as string;
  expect(svg).not.toContain("<desc>");
  expect(svg).not.toContain("export-emph-marker");
});

test("an accessible PNG still renders, and differs from the plain one", async () => {
  const plain = (await svgOf("freeform", graph, presentationOf({ nodes: ["pay"], edges: ["e1"] }), "png")) as {
    bytes: Uint8Array;
  };
  const numbered = (await svgOf(
    "freeform",
    graph,
    presentationOf({ nodes: ["pay"], edges: ["e1"] }, undefined, true),
    "png",
  )) as { bytes: Uint8Array };
  expect([...numbered.bytes.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  expect(Buffer.from(numbered.bytes).equals(Buffer.from(plain.bytes))).toBe(false);
}, 20_000);

test("export_diagram takes accessible and passes it to the painter", async () => {
  const schema = OPERATIONS.find((o) => o.name === "export_diagram")!.inputSchema as {
    properties: Record<string, { type: string; description?: string }>;
  };
  expect(schema.properties["accessible"]).toMatchObject({
    type: "boolean",
    description: expect.stringContaining("greyscale"),
  });
  const envelope = await envelopeOf("freeform", graph);
  const read = { envelope, compile: { diagnostics: [] }, sourceRevision: envelope.revision };
  const snapshot = { views: [presentationOf({ nodes: ["pay"], edges: [] })] };
  const decode = (r: { structured: Record<string, unknown> }) =>
    Buffer.from(String(r.structured["data"]), "base64").toString("utf8");
  expect(decode(await runExportOperation(read, { mode: "presentation", accessible: true }, snapshot))).toContain(
    "export-emph-marker",
  );
  expect(decode(await runExportOperation(read, { mode: "presentation" }, snapshot))).not.toContain(
    "export-emph-marker",
  );
});

test("a blank label is named by its id, and two lines with one caption are told apart by their ends", async () => {
  const source = 'flowchart LR\n a[" "]\n b[Bank]\n c[Card]\n a e1@-->|Request| b\n c e2@-->|Request| b\n';
  const svg = (await svgOf(
    "freeform",
    source,
    presentationOf({ nodes: ["a"], edges: ["e1", "e2"] }, undefined, true),
  )) as string;
  expect(keyText(svg)).toContain("Members: a, Request (a to Bank), Request (Card to Bank)");
});
