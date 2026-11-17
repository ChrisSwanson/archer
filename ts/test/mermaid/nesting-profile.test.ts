// The nesting profile (docs/proposals/ws-b-boundary-zoom.md §7, ADR 0029): findings over the
// accepted subset that steer agents to nesting the nested view can open one level at a time.
// Each finding names its fix; none blocks a model.

import { describe, expect, test } from "vitest";
import { compile } from "../../src/mermaid/index.ts";
import { nestingFindings } from "../../src/mermaid/nesting-profile.ts";

type Expected = { code: string; severity: "warning" | "info"; line: number; says: string };

const lines = (...text: string[]) => `${text.join("\n")}\n`;

/** n subgraphs nested in one another, each holding a node, and an edge so nothing is unconnected. */
const flowchartChain = (depth: number) => {
  const out = ["flowchart LR", "  top[Top]"];
  for (let level = 1; level <= depth; level++)
    out.push(
      `${"  ".repeat(level)}subgraph g${level}[G ${level}]`,
      `${"  ".repeat(level + 1)}n${level}[N ${level}]`,
      `${"  ".repeat(level + 1)}m${level}[M ${level}]`,
    );
  for (let level = depth; level >= 1; level--) out.push(`${"  ".repeat(level)}end`);
  out.push("  top e1@--> n1");
  return lines(...out);
};

const CASES: { name: string; source: string; expected: Expected[] }[] = [
  {
    name: "a well-formed C4 model has no findings",
    source: lines(
      "C4Component",
      '    Person(customer, "Customer")',
      '    System_Boundary(shop, "Web shop") {',
      '        Container_Boundary(api, "API") {',
      '            Component(checkout, "Checkout")',
      '            Component(catalog, "Catalog")',
      "        }",
      '        Container(web, "Web app")',
      "    }",
      '    Rel(customer, web, "Shops with")',
      '    Rel(web, checkout, "Places orders")',
      '    Rel(web, catalog, "Reads products")',
    ),
    expected: [],
  },
  {
    name: "a component directly inside a system boundary",
    source: lines(
      "C4Component",
      '    System_Boundary(shop, "Web shop") {',
      '        Component(checkout, "Checkout")',
      '        Container(web, "Web app")',
      "    }",
      '    Rel(web, checkout, "Calls")',
    ),
    expected: [
      {
        code: "nest_level_mismatch",
        severity: "warning",
        line: 3,
        says: "put it in a Container_Boundary inside 'shop', or make it a Container",
      },
    ],
  },
  {
    name: "systems inside a system boundary, as Mermaid's own C4 samples write them, are fine",
    source: lines(
      "C4Context",
      '    Person(customer, "Customer")',
      '    System_Boundary(bank, "Bank") {',
      '        System(core, "Core banking")',
      '        System_Ext(mail, "Mail")',
      "    }",
      '    Rel(customer, core, "Uses")',
      '    Rel(core, mail, "Sends")',
    ),
    expected: [],
  },
  {
    name: "a person inside a system boundary",
    source: lines(
      "C4Container",
      '    System_Boundary(shop, "Web shop") {',
      '        Person(clerk, "Clerk")',
      '        Container(web, "Web app")',
      "    }",
      '    Rel(clerk, web, "Uses")',
    ),
    expected: [{ code: "nest_level_mismatch", severity: "warning", line: 3, says: "move it out of 'shop'" }],
  },
  {
    name: "a component directly inside an enterprise boundary is told the whole way down",
    source: lines(
      "C4Context",
      '    Enterprise_Boundary(company, "Shop Ltd") {',
      '        System(shop, "Web shop")',
      '        Component(checkout, "Checkout")',
      "    }",
      '    Rel(shop, checkout, "Calls")',
    ),
    expected: [
      {
        code: "nest_level_mismatch",
        severity: "warning",
        line: 4,
        says: "put it in a Container_Boundary inside a System_Boundary in 'company'",
      },
    ],
  },
  {
    name: "a container inside a container boundary",
    source: lines(
      "C4Component",
      '    Container_Boundary(api, "API") {',
      '        Component(checkout, "Checkout")',
      '        Container(cache, "Cache")',
      "    }",
      '    Rel(checkout, cache, "Reads")',
    ),
    expected: [{ code: "nest_level_mismatch", severity: "warning", line: 4, says: "or make it a Component" }],
  },
  {
    name: "a system boundary inside a container boundary",
    source: lines(
      "C4Container",
      '    Container_Boundary(api, "API") {',
      '        Component(checkout, "Checkout")',
      '        System_Boundary(inner, "Inner") {',
      '            Container(web, "Web app")',
      '            Container(db, "Database")',
      "        }",
      "    }",
      '    Rel(checkout, web, "Calls")',
      '    Rel(web, db, "Reads")',
    ),
    expected: [
      { code: "nest_kind_order", severity: "warning", line: 4, says: "swap them, or make 'inner' a generic Boundary" },
    ],
  },
  {
    name: "an enterprise boundary below the top level",
    source: lines(
      "C4Context",
      '    Boundary(region, "Region") {',
      '        Enterprise_Boundary(company, "Shop Ltd") {',
      '            System(shop, "Web shop")',
      '            System(crm, "CRM")',
      "        }",
      '        System(mail, "Mail")',
      "    }",
      '    Rel(shop, crm, "Feeds")',
      '    Rel(shop, mail, "Sends")',
    ),
    expected: [
      { code: "nest_kind_order", severity: "warning", line: 3, says: "an Enterprise_Boundary goes at the top level" },
    ],
  },
  {
    name: "four levels of subgraphs are allowed",
    source: flowchartChain(4),
    expected: [],
  },
  {
    name: "five levels of subgraphs are too deep, at the fifth",
    source: flowchartChain(5),
    expected: [
      { code: "nest_too_deep", severity: "warning", line: 15, says: "split the innermost part into its own diagram" },
    ],
  },
  {
    name: "six levels: every level past four is reported",
    source: flowchartChain(6),
    expected: [
      { code: "nest_too_deep", severity: "warning", line: 15, says: "'g5' is nested 5 deep" },
      { code: "nest_too_deep", severity: "warning", line: 18, says: "'g6' is nested 6 deep" },
    ],
  },
  {
    name: "a composite named before it is declared is reported at its declaration",
    source: lines(
      "stateDiagram-v2",
      "    Idle : Waiting",
      "    state g1 {",
      "        a1 : A1",
      "        state g2 {",
      "            a2 : A2",
      "            state g3 {",
      "                a3 : A3",
      "                state g4 {",
      "                    a4 : A4",
      "                    [*] --> g5",
      "                    state g5 {",
      "                        a5 : A5",
      "                        [*] --> a5",
      "                    }",
      "                    a4 --> g5",
      "                }",
      "                a3 --> g4",
      "            }",
      "            a2 --> g3",
      "        }",
      "        a1 --> g2",
      "    }",
      "    Idle --> g1",
    ),
    expected: [{ code: "nest_too_deep", severity: "warning", line: 12, says: "'g5' is nested 5 deep" }],
  },
  {
    name: "a subgraph sharing its id with a node",
    source: lines(
      "flowchart LR",
      "  api[API]",
      "  subgraph api[Services]",
      "    a[A]",
      "    b[B]",
      "  end",
      "  api e1@--> a",
      "  a e2@--> b",
    ),
    expected: [
      {
        code: "nest_id_clash",
        severity: "warning",
        line: 3,
        says: "Rename one, for example `subgraph api_group[Services]`",
      },
    ],
  },
  {
    name: "a subgraph holding a single node is a note, not a warning",
    source: lines("flowchart LR", "  x[X]", "  subgraph g[G]", "    a[A]", "  end", "  x e1@--> a"),
    expected: [{ code: "nest_single_child", severity: "info", line: 3, says: "'g' holds only 'a'" }],
  },
  {
    name: "a composite state with one state inside has a meaning of its own: no note",
    source: lines(
      "stateDiagram-v2",
      "    Idle : Waiting",
      "    state Working {",
      "        Run : Running",
      "        [*] --> Run",
      "    }",
      "    Idle --> Working",
    ),
    expected: [],
  },
  {
    name: "seven loose nodes beside a subgraph",
    source: lines(
      "flowchart LR",
      ...["a", "b", "c", "d", "e", "f", "h"].map((id) => `  ${id}[${id.toUpperCase()}]`),
      "  subgraph g[G]",
      "    x[X]",
      "    y[Y]",
      "  end",
      "  a e1@--> b",
      "  b e2@--> c",
      "  c e3@--> d",
      "  d e4@--> e",
      "  e e5@--> f",
      "  f e6@--> h",
      "  h e7@--> x",
      "  x e8@--> y",
    ),
    expected: [{ code: "nest_mixed_root", severity: "info", line: 2, says: "7 nodes sit outside every subgraph" }],
  },
  {
    name: "six loose nodes beside a subgraph are fine",
    source: lines(
      "flowchart LR",
      ...["a", "b", "c", "d", "e", "f"].map((id) => `  ${id}[${id.toUpperCase()}]`),
      "  subgraph g[G]",
      "    x[X]",
      "    y[Y]",
      "  end",
      "  a e1@--> b",
      "  b e2@--> c",
      "  c e3@--> d",
      "  d e4@--> e",
      "  e e5@--> f",
      "  f e7@--> x",
      "  x e8@--> y",
    ),
    expected: [],
  },
  {
    name: "architecture groups five deep",
    source: lines(
      "architecture-beta",
      "    group g1(cloud)[G1]",
      "    group g2(cloud)[G2] in g1",
      "    group g3(cloud)[G3] in g2",
      "    group g4(cloud)[G4] in g3",
      "    group g5(cloud)[G5] in g4",
      "    service a(server)[A] in g5",
      "    service b(server)[B] in g5",
      "    service s1(server)[S1] in g1",
      "    service s2(server)[S2] in g2",
      "    service s3(server)[S3] in g3",
      "    service s4(server)[S4] in g4",
      "    service c(server)[C]",
      "    a:R --> L:b",
      "    b:R --> L:c",
      "    s1:R --> L:s2",
      "    s2:R --> L:s3",
      "    s3:R --> L:s4",
      "    s4:R --> L:a",
    ),
    expected: [
      { code: "nest_too_deep", severity: "warning", line: 6, says: "'g5' is nested 5 deep (g1 › g2 › g3 › g4 › g5)" },
    ],
  },
];

describe.each(CASES)("$name", ({ source, expected }) => {
  test("compiles with exactly these nesting findings, each naming its fix", async () => {
    const result = await compile(source);
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(result.model).not.toBeNull();
    const found = result.diagnostics.filter((d) => d.code.startsWith("nest_"));
    expect(found.map((d) => ({ code: d.code, severity: d.severity, line: d.span.start.line }))).toEqual(
      expected.map(({ code, severity, line }) => ({ code, severity, line })),
    );
    for (const [index, want] of expected.entries()) expect(found[index]!.message).toContain(want.says);
  });
});

test("structural findings have an identity for the write ratchet; advisory ones do not count", async () => {
  const result = await compile(CASES.find((c) => c.name.startsWith("a component directly"))!.source);
  expect(
    nestingFindings(result.model!)
      .filter((f) => f.ratcheted)
      .map((f) => f.identity),
  ).toEqual(["nest_level_mismatch:checkout:shop"]);
  const single = await compile(CASES.find((c) => c.name.startsWith("a subgraph holding"))!.source);
  expect(nestingFindings(single.model!).filter((f) => f.ratcheted)).toEqual([]);
});
