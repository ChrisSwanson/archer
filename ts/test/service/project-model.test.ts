// The service's project model (ADR 0036 §7, A1): rebuilt whole in the reconcile step whenever a
// view joins or leaves, gets a new last-good revision, or its note's status or based-on changes.
import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { ProjectState } from "../../src/service/project-state.ts";
import { cleanUp, tempDir, write } from "./support.ts";

const states: ProjectState[] = [];
afterEach(() => {
  states.splice(0).forEach((state) => state.close());
  cleanUp();
});

const CONTEXT = `C4Context\nPerson(user, "Shopper")\nSystem(shop, "Shop")\nRel(user, shop, "buys")\n`;
const note = (front: string, body: string): string =>
  `---\n${front}\n---\n# Checkout\n\n\`\`\`mermaid\n%% archer-id: flow\n${body}\`\`\`\n`;
const FLOW = `flowchart LR\n  shop[Shop]:::system\n  pay[Payments]:::system\n  shop e1@--> pay\n`;

async function open(): Promise<{ root: string; state: ProjectState }> {
  const root = tempDir("archer-model-");
  write(root, "archer.toml", "version = 1\n");
  write(root, ".archer/diagrams/context.mmd", CONTEXT);
  write(root, ".archer/notes/checkout.md", note("author: agent", FLOW));
  const state = await ProjectState.open(
    root,
    (slug) => `http://127.0.0.1/projects/${slug}/`,
    () => {},
    { restoreState: false },
  );
  states.push(state);
  return { root, state };
}

const ids = (state: ProjectState): string[] => state.projectModel().model.elements.map((e) => e.id);
const name = (state: ProjectState, id: string): string | undefined =>
  state.projectModel().model.elements.find((e) => e.id === id)?.name;

test("the model is built at open, from every view's last-good envelope", async () => {
  const { state } = await open();
  expect(ids(state)).toEqual(["pay", "shop", "user"]);
  expect(state.projectModel().model.relationships.map((r) => `${r.from}>${r.to}`)).toEqual(["shop>pay", "user>shop"]);
});

test("a good edit is in the model after the reload, though no compile event goes out", async () => {
  const { root, state } = await open();
  const published: string[] = [];
  state.subscribe((event) => published.push(event));
  const before = state.projectModel().generation;
  write(root, ".archer/diagrams/context.mmd", CONTEXT.replace('"Shop"', '"Web shop"'));
  await state.reload();
  expect(name(state, "shop")).toBe("Web shop");
  expect(state.projectModel().generation).toBeGreaterThan(before);
  expect(published).not.toContain("compile");
});

test("a source that stops compiling keeps its last-good contribution", async () => {
  const { root, state } = await open();
  write(root, ".archer/diagrams/context.mmd", "C4Context\nPerson(user\n");
  await state.reload();
  expect(name(state, "shop")).toBe("Shop");
});

test("removing a good view takes its elements out", async () => {
  const { root, state } = await open();
  rmSync(join(root, ".archer/diagrams/context.mmd"));
  await state.reload();
  expect(ids(state)).toEqual(["pay", "shop"]);
  expect(name(state, "shop")).toBe("Shop");
});

test("a status-only edit to the note takes its diagram out of the model, and back", async () => {
  const { root, state } = await open();
  write(root, ".archer/notes/checkout.md", note("author: agent\nstatus: proposed", FLOW));
  await state.reload();
  expect(ids(state)).toEqual(["shop", "user"]);
  const index = state.projectModel().model.index.find((e) => e.id === "pay");
  expect(index?.occurrences).toEqual([expect.objectContaining({ viewId: "notes/checkout.md#flow", proposed: true })]);
  write(root, ".archer/notes/checkout.md", note("author: agent", FLOW));
  await state.reload();
  expect(ids(state)).toEqual(["pay", "shop", "user"]);
});

test("a based-on-only edit to the note takes its diagram out of the model and the index", async () => {
  const { root, state } = await open();
  write(root, ".archer/notes/checkout.md", note("author: agent\nbased-on: context@sha256:00", FLOW));
  await state.reload();
  expect(ids(state)).toEqual(["shop", "user"]);
  expect(state.projectModel().model.index.map((e) => e.id)).toEqual(["shop", "user"]);
});

test("a reload that changes nothing the model reads keeps its generation", async () => {
  const { root, state } = await open();
  const before = state.projectModel().generation;
  // Prose around the fence moves nothing the model reads.
  write(
    root,
    ".archer/notes/checkout.md",
    note("author: agent", FLOW).replace("# Checkout\n", "# Checkout\n\nMore words.\n"),
  );
  await state.reload();
  expect(state.projectModel().generation).toBe(before);
});

test("the management socket serves the attached project's model in one call, and refuses a project not attached", async () => {
  const { startService } = await import("../../src/service/index.ts");
  const { connectService } = await import("../../src/mcp/index.ts");
  const stateDir = tempDir("archer-model-svc-");
  const svc = await startService({
    forceHttp: true,
    stateDir,
    env: { HOME: stateDir },
    socketPath: `${stateDir}/archer.sock`,
    log: () => {},
  });
  const client = await connectService(svc.socketPath);
  try {
    const root = tempDir("archer-model-");
    write(root, "archer.toml", "version = 1\n");
    write(root, ".archer/diagrams/context.mmd", CONTEXT);
    await expect(client.call("getProjectModel", { root })).rejects.toMatchObject({
      error: { code: "project_not_attached" },
    });
    await client.call("attach", { root });
    const first = await client.call("getProjectModel", { root });
    expect(first.model.elements.map((e) => e.id)).toEqual(["shop", "user"]);
    // A read through the front door sees an edit made since, as getModel does.
    write(root, ".archer/diagrams/context.mmd", CONTEXT.replace('"Shop"', '"Web shop"'));
    const second = await client.call("getProjectModel", { root });
    expect(second.model.elements.find((e) => e.id === "shop")?.name).toBe("Web shop");
    expect(second.generation).toBeGreaterThan(first.generation);
    await expect(client.call("getProjectModel", { root, extra: 1 } as never)).rejects.toMatchObject({
      error: { code: "invalid_params" },
    });
  } finally {
    client.close();
    await svc.close();
  }
});
