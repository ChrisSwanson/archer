import { afterEach, expect, test } from "vitest";
import { compareDiagramCommits, compareModels } from "../../src/accuracy/compare.ts";
import { compile } from "../../src/mermaid/index.ts";
import { loadFixtures } from "../mermaid/support/fixtures.ts";
import { cleanup, commit, FLOW, manifest, project, repo, write } from "./support.ts";
afterEach(cleanup);
test("full semantic attributes and endpoints change even when labels do not", async () => {
  const before = await compile(FLOW),
    after = await compile(FLOW.replace("a[Client]", "a[(Client)]"));
  expect(before.model).not.toBeNull();
  expect(after.model).not.toBeNull();
  expect(compareModels(before.model!, after.model!).changes).toMatchObject([{ key: "node:a", status: "changed" }]);
});
test("sequence insertion preserves message identity across derived ordinal IDs", async () => {
  const source = "sequenceDiagram\n participant A\n participant B\n A->>B: First\n B-->>A: Second\n";
  const before = await compile(source),
    after = await compile(source.replace(" A->>B: First", " A->>B: Inserted\n A->>B: First"));
  expect(before.model).not.toBeNull();
  expect(after.model).not.toBeNull();
  const comparison = compareModels(before.model!, after.model!);
  expect(comparison.changes).toHaveLength(1);
  expect(comparison.changes[0]).toMatchObject({ status: "added", after: { label: "Inserted" } });
});
const kinds = {
  flowchart: "freeform",
  sequence: "sequence",
  state: "state",
  er: "entity-relationship",
  c4: "c4",
  architecture: "architecture",
  journey: "journey",
} as const;
test.each(loadFixtures().filter((f) => f.name.endsWith("/minimal")))(
  "exact historical models for $name use the production compiler",
  async ({ name, source, expected }) => {
    const kind = kinds[name.split("/")[0] as keyof typeof kinds];
    const root = repo({ "archer.toml": manifest("", ".archer/flow.mmd", kind), ".archer/flow.mmd": source });
    const old = commit(root);
    write(root, ".archer/flow.mmd", source + "\n%% changed source only\n");
    const now = commit(root);
    const comparison = await compareDiagramCommits(project(root), "flow", old, now);
    expect(comparison.before.status).toBe("compiled");
    expect(comparison.after.status).toBe("compiled");
    if (comparison.before.status === "unavailable") throw new Error(comparison.before.reason);
    expect(comparison.before.result.envelope?.model).toEqual(expected);
    expect(comparison.sourceChanged).toBe(true);
    expect(comparison.semantic).toEqual({ status: "compared", changes: [] });
  },
);
const mutations: Record<string, [string, string, string]> = {
  flowchart: ["Client]", "Client)]", "node:a"],
  sequence: ["A->>B", "A-)B", "event:msg-0"],
  state: ["state Idle", "state Idle <<choice>>", "state:Idle"],
  er: ["||--o{", "|o--o{", "relationship:CUSTOMER--ORDER"],
  c4: ["Person(customer", "Person_Ext(customer", "element:customer"],
  architecture: ["api(server)", "api(database)", "service:api"],
  journey: ["Search the shop: 3", "Search the shop: 1", "task:search-the-shop"],
};
test.each(loadFixtures().filter((f) => f.name.endsWith("/minimal") && !f.name.startsWith("flowchart/")))(
  "attribute semantics for $name are compared beyond labels",
  async ({ name, source }) => {
    const family = name.split("/")[0]!;
    const [from, to, key] = mutations[family]!;
    const before = await compile(source),
      after = await compile(source.replace(from, to));
    expect(before.model).not.toBeNull();
    expect(after.model, JSON.stringify(after.diagnostics)).not.toBeNull();
    expect(compareModels(before.model!, after.model!).changes).toContainEqual(
      expect.objectContaining({ key, status: "changed" }),
    );
  },
);
test("sequence ordering is reported as a move, with original and new positions", async () => {
  const head = "sequenceDiagram\n participant A\n participant B\n";
  const before = await compile(head + " A->>B: One\n B-->>A: Two\n"),
    after = await compile(head + " B-->>A: Two\n A->>B: One\n");
  const result = compareModels(before.model!, after.model!);
  expect(result.changes).toHaveLength(1);
  expect(result.changes[0]).toMatchObject({ status: "moved", beforeIndex: 0, afterIndex: 1 });
});
test("sequence fragment section context stays part of event semantics", async () => {
  const source =
    "sequenceDiagram\n participant A\n participant B\n alt approved\n A->>B: Submit\n else refused\n B-->>A: Refuse\n end\n";
  const before = await compile(source),
    after = await compile(source.replace("else refused", "else delayed"));
  expect(before.model).not.toBeNull();
  expect(after.model).not.toBeNull();
  const changes = compareModels(before.model!, after.model!).changes;
  expect(changes).toContainEqual(
    expect.objectContaining({
      status: "changed",
      after: expect.objectContaining({
        label: "Refuse",
        context: [{ kind: "alt", label: "approved", section: "delayed" }],
      }),
    }),
  );
});
test("journey task reordering is retained rather than flattened into a set", async () => {
  const source = "journey\n section Shop\n  Search: 3: Reader\n  Buy: 5: Reader\n";
  const before = await compile(source),
    after = await compile(
      source.replace("  Search: 3: Reader\n  Buy: 5: Reader", "  Buy: 5: Reader\n  Search: 3: Reader"),
    );
  expect(compareModels(before.model!, after.model!).changes).toContainEqual(
    expect.objectContaining({ key: "task:search", status: "moved" }),
  );
});
