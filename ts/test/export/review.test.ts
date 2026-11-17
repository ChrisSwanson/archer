import { expect, test } from "vitest";
import { compile } from "../../src/mermaid/index.ts";
import { exportDiagram } from "../../src/export/index.ts";
import { testResources } from "./resources.ts";
import { rgba } from "./png-decode.ts";

const sequence =
  "sequenceDiagram\nparticipant a as Reader\nparticipant b as Server\na->>b: Request\nactivate b\nNote over b: Note\nb-->>a: Reply\ndeactivate b\n";

test("sequence export retains the page activation, note, lifeline and reply style tokens", async () => {
  const model = (await compile(sequence)).model;
  expect(model).not.toBeNull();
  const resources = await testResources();
  const envelope = {
    schemaVersion: 2,
    revision: `sha256:${"a".repeat(64)}`,
    view: { id: "test", kind: "sequence", title: "Test" },
    model,
  };
  const svg = new TextDecoder().decode((await exportDiagram(envelope, { resources })).bytes);
  const darkTheme = resources.themeCss.slice(resources.themeCss.indexOf(':root[data-theme="dark"]'));
  for (const [token, attribute] of [
    ["activation-bg", "fill"],
    ["surface-2", "fill"],
    ["fragment-border", "stroke"],
    ["lifeline", "stroke"],
    ["text-faint", "stroke"],
    ["text-dim", "fill"],
  ] as const) {
    const color = darkTheme.match(new RegExp(`--${token}:\\s*(#[a-fA-F0-9]{6})`))![1]!;
    expect(svg.includes(`${attribute}="${color}"`), `sequence page style ${token}`).toBe(true);
  }
});

for (const [kind, source, selected] of [
  ["sequence", sequence, "a"],
  ["journey", "journey\nsection Read\n Browse: 3: Reader\n", "browse"],
  ["architecture", "architecture-beta\ngroup scope(cloud)[Scope]\nservice a(server)[One] in scope\n", "scope"],
] as const) {
  test(`${kind}: presentation PNG colours the emphasised element's own border, and nothing outside it`, async () => {
    const model = (await compile(source)).model;
    expect(model).not.toBeNull();
    const resources = await testResources();
    const envelope = {
      schemaVersion: 2,
      revision: `sha256:${"a".repeat(64)}`,
      view: { id: "test", kind, title: "Test" },
      model,
    };
    const presentation = {
      diagramKey: false,
      emphases: [
        {
          id: "mark",
          viewId: "test",
          groups: [
            {
              id: "group",
              label: "Group",
              style: "highlight" as const,
              palette: "coral" as const,
              state: "existing" as const,
              nodes: [selected],
              edges: [],
            },
          ],
        },
      ],
    };
    const svg = new TextDecoder().decode(
      (await exportDiagram(envelope, { resources, mode: "presentation", presentation })).bytes,
    );
    const viewBox = svg
      .match(/viewBox="([^"]+)"/)![1]!
      .split(" ")
      .map(Number);
    const rectangle = svg.match(
      new RegExp(`data-element-id="${selected}"[^]*?<rect x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)"`),
    );
    expect(rectangle).not.toBeNull();
    const [x, y, , height] = rectangle!.slice(1).map(Number);
    const image = rgba(
      (await exportDiagram(envelope, { resources, format: "png", mode: "presentation", presentation })).bytes,
    );
    // The first group's hue, whatever the wire named (ADR 0030).
    const color = resources.themeCss.match(/--g1:\s*(#[a-fA-F0-9]{6})/)![1]!;
    const target = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
    const near = (px: number, py: number) => {
      const offset = (py * image.width + px) * 4;
      return target.every((value, channel) => Math.abs(image.pixels[offset + channel]! - value) <= 24);
    };
    let border = 0,
      outside = 0;
    for (let py = Math.ceil(y! - viewBox[1]! + 6); py < y! - viewBox[1]! + height! - 6; py++) {
      const left = Math.round(x! - viewBox[0]!);
      for (let px = left - 1; px <= left + 1; px++) if (near(px, py)) border++;
      for (let px = left - 7; px <= left - 4; px++) if (near(px, py)) outside++;
    }
    expect(border, `${selected}: hue on the element's own border`).toBeGreaterThan(10);
    expect(outside, `${selected}: no detached ring outside it`).toBe(0);
  });
}

for (const codePoint of [0xfffe, 0xffff]) {
  test(`XML-forbidden U+${codePoint.toString(16).toUpperCase()} is refused before painting`, async () => {
    const model = (await compile("flowchart LR\na[One]\n")).model;
    expect(model).not.toBeNull();
    const envelope = {
      schemaVersion: 2,
      revision: `sha256:${"a".repeat(64)}`,
      view: { id: "test", kind: "freeform", title: `Invalid ${String.fromCodePoint(codePoint)}` },
      model,
    };
    const outcome = await exportDiagram(envelope, { resources: await testResources() }).then(
      () => "accepted",
      (error: unknown) => (error as { code?: string }).code,
    );
    expect(outcome).toBe("export_invalid_input");
  });
}

import { parseFragment, type DefaultTreeAdapterTypes } from "parse5";
function svgElements(source: string): DefaultTreeAdapterTypes.Element[] {
  const result: DefaultTreeAdapterTypes.Element[] = [];
  const pending: DefaultTreeAdapterTypes.Node[] = [parseFragment(source)];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if ("tagName" in node) result.push(node);
    if ("childNodes" in node) pending.push(...node.childNodes);
  }
  return result;
}
const attribute = (node: DefaultTreeAdapterTypes.Element, name: string): string | undefined =>
  node.attrs.find((a) => a.name === name)?.value;
function inheritedAttribute(node: DefaultTreeAdapterTypes.Element, name: string): string | undefined {
  for (
    let current: DefaultTreeAdapterTypes.ParentNode | null = node;
    current !== null;
    current = "parentNode" in current ? current.parentNode : null
  ) {
    if ("tagName" in current && attribute(current, name) !== undefined) return attribute(current, name);
  }
  return undefined;
}
const darkColor = (css: string, token: string): string =>
  css.slice(css.indexOf(':root[data-theme="dark"]')).match(new RegExp(`--${token}:\\s*(#[a-fA-F0-9]{6})`))![1]!;
const fragmentSource =
  "sequenceDiagram\nautonumber\nparticipant a as Reader\nparticipant b as Server\nloop Review loop\na->>b: Request\nend\n";
async function fragmentSvg() {
  const model = (await compile(fragmentSource)).model;
  expect(model).not.toBeNull();
  const resources = await testResources();
  const svg = new TextDecoder().decode(
    (
      await exportDiagram(
        {
          schemaVersion: 2,
          revision: `sha256:${"a".repeat(64)}`,
          view: { id: "test", kind: "sequence", title: "Test" },
          model,
        },
        { resources },
      )
    ).bytes,
  );
  return { resources, elements: svgElements(svg) };
}

test("sequence fragment chip and header retain page tint, text ink and background halo", async () => {
  const { resources, elements } = await fragmentSvg();
  const chip = elements.find(
    (e) => e.tagName === "rect" && attribute(e, "height") === "18" && attribute(e, "rx") === "5",
  );
  expect(chip).toBeDefined();
  expect(attribute(chip!, "fill")).toBe(darkColor(resources.themeCss, "fragment-border"));
  expect(attribute(chip!, "fill-opacity")).toBe("0.25");
  expect(attribute(chip!, "stroke")).toBe(darkColor(resources.themeCss, "fragment-border"));
  const label = elements.find(
    (e) => e.tagName === "text" && e.childNodes.some((n) => "value" in n && n.value === "[Review loop]"),
  );
  expect(label).toBeDefined();
  expect(inheritedAttribute(label!, "fill")).toBe(darkColor(resources.themeCss, "fragment-text"));
  expect(attribute(label!, "stroke")).toBe(darkColor(resources.themeCss, "bg"));
  expect(attribute(label!, "paint-order")).toBe("stroke");
});

test("sequence autonumber digits retain the page text ink independently of message label ink", async () => {
  const { resources, elements } = await fragmentSvg();
  const digit = elements.find(
    (e) =>
      e.tagName === "text" &&
      attribute(e, "font-size") === "10" &&
      e.childNodes.some((n) => "tagName" in n && n.childNodes.some((t) => "value" in t && t.value === "1")),
  );
  expect(digit).toBeDefined();
  expect(inheritedAttribute(digit!, "fill")).toBe(darkColor(resources.themeCss, "text"));
});

test("sequence emphasis is the message line and arrowhead in the hue, with no band and no dash", async () => {
  const model = (await compile(sequence)).model;
  expect(model).not.toBeNull();
  const resources = await testResources();
  const envelope = {
    schemaVersion: 2,
    revision: `sha256:${"a".repeat(64)}`,
    view: { id: "test", kind: "sequence", title: "Test" },
    model,
  };
  const presentation = {
    diagramKey: false,
    emphases: [
      {
        id: "mark",
        viewId: "test",
        groups: [
          {
            id: "group",
            label: "Group",
            style: "highlight" as const,
            palette: "coral" as const,
            state: "proposed" as const,
            nodes: [],
            edges: ["msg-0", "msg-1"],
          },
        ],
      },
    ],
  };
  const svg = new TextDecoder().decode(
    (await exportDiagram(envelope, { resources, mode: "presentation", presentation })).bytes,
  );
  expect(svg).not.toContain("export-emph-band");
  for (const id of ["msg-0", "msg-1"]) {
    const className = svg.match(new RegExp(`data-element-id="${id}"[^>]*class="([^"]+)"`))![1]!;
    const lineRule = svg.match(new RegExp(`\\.${className}>\\.export-edge-line\\{([^}]+)\\}`))![1]!;
    const arrowRule = svg.match(new RegExp(`\\.${className} \\[data-export-arrow\\]\\{([^}]+)\\}`))![1]!;
    const g1 = resources.themeCss.match(/--g1:\s*(#[a-fA-F0-9]{6})/)![1]!;
    expect(lineRule).toMatch(new RegExp(`stroke:(var\\(--g1\\)|${g1})`, "i"));
    expect(lineRule).not.toContain("stroke-dasharray");
    expect(arrowRule).toMatch(new RegExp(`fill:(var\\(--g1\\)|${g1})`, "i"));
  }
});

test("a flow group exports still moving-arrow marks in its hue, and a highlight does not", async () => {
  const source = "flowchart LR\n a[One] e1@<--> b[Two]\n b e2@--> c[Three]\n";
  const model = (await compile(source)).model;
  expect(model).not.toBeNull();
  const resources = await testResources();
  const envelope = {
    schemaVersion: 2,
    revision: `sha256:${"a".repeat(64)}`,
    view: { id: "test", kind: "freeform", title: "Test" },
    model,
  };
  const presentation = {
    diagramKey: false,
    emphases: [
      {
        id: "mark",
        viewId: "test",
        groups: [
          {
            id: "flow",
            label: "Flow",
            style: "flow" as const,
            palette: "teal" as const,
            state: "existing" as const,
            speed: "normal" as const,
            nodes: [],
            edges: ["e1"],
          },
          {
            id: "still",
            label: "Still",
            style: "highlight" as const,
            palette: "violet" as const,
            state: "existing" as const,
            nodes: [],
            edges: ["e2"],
          },
        ],
      },
    ],
  };
  const svg = new TextDecoder().decode(
    (await exportDiagram(envelope, { resources, mode: "presentation", presentation })).bytes,
  );
  const classOf = (id: string) => svg.match(new RegExp(`data-element-id="${id}"[^>]*class="([^"]+)"`))![1]!;
  expect(svg).toMatch(new RegExp(`\\.${classOf("e1")} \\.export-emph-chevrons\\{visibility:visible`));
  expect(svg).not.toMatch(new RegExp(`\\.${classOf("e2")} \\.export-emph-chevrons\\{visibility:visible`));
  // A two-way line: one mark each way.
  const e1 = svg.slice(svg.indexOf('data-element-id="e1"'));
  const angles = [
    ...e1
      .slice(e1.indexOf("export-emph-chevrons"), e1.indexOf("</g>", e1.indexOf("export-emph-chevrons")))
      .matchAll(/rotate\(([-\d.]+)\)/g),
  ].map((m) => Number(m[1]));
  expect(angles).toHaveLength(2);
  expect(Math.abs(Math.abs(angles[0]! - angles[1]!) - 180)).toBeLessThan(1);
});
