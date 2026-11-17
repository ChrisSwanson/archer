import { expect, test } from "vitest";
import { compile } from "../../src/mermaid/index.ts";
import { revisionOf } from "../../src/project/index.ts";
import { testResources } from "./resources.ts";
import { exportDiagram } from "../../src/export/index.ts";
test("standalone export contains the actual compiled diagram labels and IDs", async () => {
  const source = 'flowchart LR\n a["Request & response"]\n b[API]\n a calls@--> b\n';
  const compiled = await compile(source);
  expect(compiled.model).not.toBeNull();
  const envelope = {
    schemaVersion: 2 as const,
    revision: revisionOf(new TextEncoder().encode(source)),
    view: { id: "drawing", kind: "freeform" as const, title: "Drawing" },
    model: compiled.model!,
  };
  const result = await exportDiagram(envelope, { resources: await testResources() });
  expect(result.mimeType).toBe("image/svg+xml");
  const svg = new TextDecoder().decode(result.bytes);
  expect(svg).toContain('data-element-id="a"');
  expect(svg).toContain("Request &amp; response");
  expect(svg).toContain('data-element-id="calls"');
  expect(svg).not.toMatch(/foreignObject|<script|(?:href|src)=["']https?:|url\(https?:/);
  expect(result.width).toBeGreaterThan(100);
});
test("standalone font embeds its existing license notice without executable or network references", async () => {
  const source = 'flowchart LR\n a["http://example.test is a label, not an asset"]\n',
    compiled = await compile(source),
    resources = await testResources(),
    result = await exportDiagram(
      {
        schemaVersion: 2,
        revision: revisionOf(new TextEncoder().encode(source)),
        view: { id: "test", kind: "freeform", title: "Test" },
        model: compiled.model,
      },
      { resources },
    );
  const svg = new TextDecoder().decode(result.bytes);
  expect(svg).toContain('<metadata id="fira-sans-font-license">');
  expect(svg).toContain("SIL OPEN FONT LICENSE");
  expect(svg).toContain("The Mozilla Foundation and Telefonica S.A.");
  expect(svg).not.toMatch(/(?:href|src)=["']https?:|url\(https?:|<script|foreignObject/);
});

test("an SVG is set in the page's face: every Fira Sans face it draws, embedded, and the page's tracking", async () => {
  // The layout sized every label for Fira Sans with +0.04em a character (`ui/src/layout/text-measure.ts`); an
  // SVG drawn in another face, or untracked, opens wider or narrower than its boxes.
  const source = 'flowchart LR\n a["Title<br/>description"]\n b[API]\n a calls@-->|"reads"| b\n',
    compiled = await compile(source),
    resources = await testResources(),
    svg = new TextDecoder().decode(
      (
        await exportDiagram(
          {
            schemaVersion: 2,
            revision: revisionOf(new TextEncoder().encode(source)),
            view: { id: "test", kind: "freeform", title: "Test" },
            model: compiled.model,
          },
          { resources },
        )
      ).bytes,
    );
  const faces = [...svg.matchAll(/@font-face\{([^}]*)\}/g)].map((match) => match[1]!);
  expect(faces).toHaveLength(resources.fontFaces.length);
  for (const face of resources.fontFaces) {
    const declared = faces.find((body) => body.includes(`font-style:${face.style};font-weight:${face.weight};`));
    expect(declared, `${face.weight} ${face.style}`).toBeDefined();
    expect(declared).toContain("font-family:'Fira Sans'");
    expect(declared).toContain(`url(data:font/woff2;base64,${Buffer.from(face.bytes).toString("base64")})`);
  }
  expect(svg).toContain("text{letter-spacing:0.04em}");
  expect(svg).toMatch(/<g [^>]*font-family="Fira Sans, sans-serif">/);
  expect(svg).not.toMatch(/Inter/);
});

test("C4 export captions draw relationship technology and description under the label, inside its text box", async () => {
  const source =
    'C4Container\n Container(a, "One", "App")\n Container(b, "Two", "App")\n Rel(a, b, "Calls", "HTTPS", "Every request")\n';
  const model = (await compile(source)).model!;
  const envelope = {
    schemaVersion: 2,
    revision: revisionOf(new TextEncoder().encode(source)),
    view: { id: "test", kind: "c4", title: "Technologies" },
    model,
  };
  const svg = new TextDecoder().decode((await exportDiagram(envelope, { resources: await testResources() })).bytes);
  const edge = svg.slice(svg.indexOf('data-element-channel="edge"'));
  expect(edge).toContain(">Calls<");
  expect(edge).toContain(">[HTTPS]<");
  expect(edge).not.toContain("ⓘ");
  const plate = edge.match(/<rect x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)"/)!;
  const rows = [
    ...edge
      .slice(0, edge.indexOf('class="export-emph-chevrons"'))
      .matchAll(/<tspan x="([^"]+)" y="([^"]+)">([^<]+)<\/tspan>/g),
  ];
  expect(rows.map((row) => row[3])).toEqual(["Calls", "[HTTPS]", "Every request"]);
  for (const row of rows) {
    expect(Number(row[2])).toBeGreaterThan(Number(plate[2]));
    expect(Number(row[2])).toBeLessThan(Number(plate[2]) + Number(plate[4]));
  }
});

test("C4 export does not repeat a technology that is already the unlabelled caption", async () => {
  const source = 'C4Container\n Container(a, "One", "App")\n Container(b, "Two", "App")\n Rel(a, b, "", "HTTPS")\n';
  const model = (await compile(source)).model!;
  const envelope = {
    schemaVersion: 2,
    revision: revisionOf(new TextEncoder().encode(source)),
    view: { id: "test", kind: "c4", title: "Technologies" },
    model,
  };
  const svg = new TextDecoder().decode((await exportDiagram(envelope, { resources: await testResources() })).bytes);
  expect(svg.match(/\[HTTPS\]/g)).toHaveLength(1);
});
