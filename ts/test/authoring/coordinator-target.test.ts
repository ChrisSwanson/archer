import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { AuthoringCoordinator } from "../../src/authoring/coordinator.ts";
import { AuthoringStore, parseJournalCompletion } from "../../src/authoring/store.ts";
import { ChangeStore } from "../../src/changes/index.ts";
import { findProject } from "../../src/project/project.ts";
import { revisionOf } from "../../src/project/envelope.ts";
import { resolveFeedbackConfiguration } from "../../src/config/feedback-resolution.ts";
import { FLOW, tempDir, removeTempDirs } from "../project/support.ts";
afterEach(removeTempDirs);
const id = (n = 1) => n.toString(16).padStart(32, "0");
function fixture(extra: Record<string, string> = {}) {
  const root = tempDir({
    "archer.toml": 'version = 1\n[feedback]\nchanges = "manual"\n',
    ".archer/a.mmd": FLOW,
    ".archer/b.mmd": FLOW,
    ...extra,
  });
  const state = tempDir();
  chmodSync(state, 0o700);
  const store = new AuthoringStore({ stateDir: state, serviceName: "main", assertOwner() {} }),
    changes = new ChangeStore({ stateDir: state, serviceName: "main", assertOwner() {} });
  const options = {
    store,
    changes,
    project: () => findProject(root),
    authority: () => ({ grantId: "g", entitlementId: "e" }),
    feedback: (project: ReturnType<typeof findProject>) => {
      const f = resolveFeedbackConfiguration({ user: {} as never, project, serviceName: "main" });
      return { changes: f.changes, delivery: f.delivery, effectiveRevision: f.revision };
    },
  };
  return { root, state, store, options, coordinator: new AuthoringCoordinator(options) };
}
test("browser-open identity refuses a later view remap to another file with identical source bytes", async () => {
  const f = fixture(),
    opened = f.coordinator.open({ kind: "view", viewId: "a" });
  writeFileSync(
    join(f.root, "archer.toml"),
    'version = 1\n[[views]]\nid = "a"\nkind = "freeform"\ntitle = "A"\nsource = ".archer/b.mmd"\n',
  );
  await expect(
    f.coordinator.mutate({
      op: "document.apply",
      operationId: id(),
      target: opened.target,
      expectedSourceRevision: opened.sourceRevision,
      expectedTargetRevision: opened.targetRevision,
      source: FLOW.replace("Client", "Changed"),
    }),
  ).rejects.toMatchObject({ code: "authoring_target_conflict" });
  expect(readFileSync(join(f.root, ".archer/a.mmd"), "utf8")).toBe(FLOW);
  expect(readFileSync(join(f.root, ".archer/b.mmd"), "utf8")).toBe(FLOW);
  expect(f.store.getOperation(id())).toBeNull();
});
test("Publish returns durable target identity for repeat Apply and exact replay survives mapping changes", async () => {
  const f = fixture(),
    request = { op: "document.publish", operationId: id(), path: "diagrams/new.mmd", source: FLOW } as const;
  const published = await f.coordinator.mutate(request);
  expect(published.document).toMatchObject({
    target: { kind: "view", viewId: "new" },
    targetRevision: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
  });
  const target = published.document!.target!,
    expectedTargetRevision = published.document!.targetRevision!;
  const saved = await f.coordinator.mutate({
    op: "document.apply",
    operationId: id(2),
    target,
    expectedTargetRevision,
    expectedSourceRevision: published.document!.sourceRevision,
    source: FLOW.replace("Client", "Again"),
  });
  expect(saved).toMatchObject({ outcome: "applied", document: { target, targetRevision: expectedTargetRevision } });
  writeFileSync(
    join(f.root, "archer.toml"),
    'version = 1\n[[views]]\nid = "new"\nkind = "freeform"\ntitle = "Remapped"\nsource = ".archer/b.mmd"\n',
  );
  expect(await f.coordinator.mutate(request)).toEqual(published);
  const reopenedStore = new AuthoringStore({ stateDir: f.state, serviceName: "main", assertOwner() {} }),
    restarted = new AuthoringCoordinator({ ...f.options, store: reopenedStore });
  expect(restarted.operation(id())).toEqual(published);
  expect(readFileSync(join(f.root, ".archer/diagrams/new.mmd"), "utf8")).toContain("Again");
});
for (const path of ["bad.name.mmd", "2/same.mmd", ".hidden/hidden.mmd"])
  test(`Publish refuses undiscoverable or ambiguous identity ${path} before effect`, async () => {
    const f = fixture({
      ".archer/1/same.mmd": FLOW,
      ".archer/2/keep.md": "parent exists",
      ".archer/.hidden/keep.md": "parent exists",
    });
    await expect(
      f.coordinator.mutate({ op: "document.publish", operationId: id(), path, source: FLOW }),
    ).rejects.toMatchObject({ code: expect.stringMatching(/^authoring_target_/u) });
    expect(() => readFileSync(join(f.root, ".archer", path))).toThrow();
    expect(f.store.getOperation(id())).toBeNull();
  });
test("strict completion parser retains identity fields and refuses malformed or unpaired identity", () => {
  const revision = revisionOf(Buffer.from(FLOW)),
    completion = {
      outcome: "created",
      document: {
        path: ".archer/new.mmd",
        sourceRevision: revision,
        modelRevision: null,
        target: { kind: "view", viewId: "new" },
        targetRevision: revision,
      },
      review: { mode: "manual", configRevision: revision, state: "not_queued_manual" },
    };
  expect(parseJournalCompletion(completion)).toEqual(completion);
  for (const document of [
    { ...completion.document, targetRevision: "bad" },
    { ...completion.document, target: { kind: "view", viewId: "bad.name" } },
    { path: ".archer/new.mmd", sourceRevision: revision, modelRevision: null, targetRevision: revision },
  ])
    expect(() => parseJournalCompletion({ ...completion, document })).toThrow();
  const legacy = {
    ...completion,
    document: { path: ".archer/new.mmd", sourceRevision: revision, modelRevision: null },
  };
  expect(parseJournalCompletion(legacy)).toEqual(legacy);
});
