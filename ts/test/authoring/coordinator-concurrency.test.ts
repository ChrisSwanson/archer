import { chmodSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { AuthoringCoordinator, type AuthoringCoordinatorOptions } from "../../src/authoring/coordinator.ts";
import { AuthoringStore } from "../../src/authoring/store.ts";
import { ChangeStore } from "../../src/changes/index.ts";
import { compileDiagramBytes } from "../../src/project/envelope.ts";
import { findProject } from "../../src/project/project.ts";
import { FLOW, removeTempDirs, tempDir } from "../project/support.ts";
import { resolveFeedbackConfiguration } from "../../src/config/feedback-resolution.ts";
afterEach(removeTempDirs);
const id = (n: number) => n.toString(16).padStart(32, "0");
function fixture() {
  const root = tempDir({
    "archer.toml": 'version = 1\n[feedback]\nchanges = "manual"\n',
    ".archer/a.mmd": FLOW,
    ".archer/b.mmd": FLOW,
  });
  const state = tempDir();
  chmodSync(state, 0o700);
  const store = new AuthoringStore({ stateDir: state, serviceName: "main", assertOwner() {} });
  const changes = new ChangeStore({ stateDir: state, serviceName: "main", assertOwner() {} });
  let allowed = true;
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let entered = 0;
  const options: AuthoringCoordinatorOptions = {
    store,
    changes,
    project: () => findProject(root),
    authority: () => {
      if (!allowed) throw Object.assign(new Error("revoked"), { code: "authoring_forbidden" });
      return { grantId: "g", entitlementId: "e" };
    },
    feedback: (project) => {
      const f = resolveFeedbackConfiguration({ user: {} as never, project, serviceName: "main" });
      return { changes: f.changes, delivery: f.delivery, effectiveRevision: f.revision };
    },
    compile: async (entry, bytes) => {
      entered++;
      await gate;
      return compileDiagramBytes(entry, bytes);
    },
  };
  return {
    root,
    state,
    store,
    changes,
    options,
    release,
    revoke() {
      allowed = false;
    },
    entered: () => entered,
  };
}
test("same-ID concurrent compiles recheck in commit and never create a second saved revision", async () => {
  const f = fixture(),
    coordinator = new AuthoringCoordinator(f.options);
  const request = {
    op: "draft.save",
    operationId: id(1),
    draftId: "drf_" + id(1),
    expectedDraftRevision: null,
    origin: { kind: "new" },
    source: FLOW,
  } as const;
  const a = coordinator.mutate(request),
    b = coordinator.mutate(request);
  expect(f.entered()).toBe(2);
  f.release();
  const results = await Promise.all([a, b]);
  expect(results[0]).toEqual(results[1]);
  expect(f.store.getDraft(f.root, request.draftId)?.revisions).toHaveLength(1);
});
test("changed payload same ID after simultaneous compile is refused and third concurrent compile is bounded", async () => {
  const f = fixture(),
    coordinator = new AuthoringCoordinator(f.options);
  const request = {
    op: "draft.save",
    operationId: id(1),
    draftId: "drf_" + id(1),
    expectedDraftRevision: null,
    origin: { kind: "new" },
    source: FLOW,
  } as const;
  const a = coordinator.mutate(request),
    b = coordinator.mutate({ ...request, source: FLOW.replace("Client", "Changed") });
  const rejected = b.then(
    () => null,
    (error) => error,
  );
  await expect(coordinator.mutate({ ...request, operationId: id(2), draftId: "drf_" + id(2) })).rejects.toMatchObject({
    code: "authoring_busy",
  });
  f.release();
  await a;
  expect(await rejected).toMatchObject({ code: "authoring_operation_mismatch" });
  expect(f.store.getDraft(f.root, request.draftId)?.revisions).toHaveLength(1);
});
for (const mutation of ["revoke", "folder", "mapping"] as const)
  test(`source authority rechecked after compile: ${mutation}`, async () => {
    const f = fixture(),
      coordinator = new AuthoringCoordinator(f.options),
      opened = coordinator.open({ kind: "view", viewId: "a" });
    const pending = coordinator.mutate({
      op: "document.apply",
      operationId: id(1),
      target: opened.target,
      expectedSourceRevision: opened.sourceRevision,
      expectedTargetRevision: opened.targetRevision,
      source: FLOW.replace("Client", "Changed"),
    });
    const outcome = pending.then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    if (mutation === "revoke") f.revoke();
    else if (mutation === "folder") {
      mkdirSync(join(f.root, "alternate"));
      writeFileSync(join(f.root, "alternate/a.mmd"), FLOW);
      writeFileSync(join(f.root, "archer.toml"), 'version = 1\nfolder = "alternate"\n');
    } else
      writeFileSync(
        join(f.root, "archer.toml"),
        'version = 1\n[[views]]\nid = "a"\nkind = "freeform"\ntitle = "A"\nsource = ".archer/b.mmd"\n',
      );
    f.release();
    const result = await outcome;
    if (mutation === "mapping") expect(result).toMatchObject({ value: { outcome: "conflict" } });
    else expect(result).toHaveProperty("error");
    expect(readFileSync(join(f.root, ".archer/a.mmd"), "utf8")).toBe(FLOW);
    expect(readFileSync(join(f.root, ".archer/b.mmd"), "utf8")).toBe(FLOW);
  });
test("effective production feedback is captured after awaited compile and remains fixed on replay", async () => {
  const f = fixture(),
    coordinator = new AuthoringCoordinator(f.options);
  const request = {
    op: "draft.save",
    operationId: id(1),
    draftId: "drf_" + id(1),
    expectedDraftRevision: null,
    origin: { kind: "new" },
    source: FLOW,
  } as const;
  const pending = coordinator.mutate(request);
  writeFileSync(join(f.root, "archer.toml"), 'version = 1\n[feedback]\nchanges = "on_save"\n');
  f.release();
  const first = await pending;
  expect(first.review?.mode).toBe("on_save");
  expect(first.review?.state).toBe("queued");
  writeFileSync(join(f.root, "archer.toml"), 'version = 1\n[feedback]\nchanges = "manual"\n');
  expect(await coordinator.mutate(request)).toEqual(first);
});
test("two-compilation ceiling is shared by coordinator instances owned by one service store", async () => {
  const f = fixture(),
    one = new AuthoringCoordinator(f.options),
    two = new AuthoringCoordinator(f.options),
    three = new AuthoringCoordinator(f.options);
  const request = (n: number) =>
    ({
      op: "draft.save",
      operationId: id(n),
      draftId: "drf_" + id(n),
      expectedDraftRevision: null,
      origin: { kind: "new" },
      source: FLOW,
    }) as const;
  const a = one.mutate(request(1)),
    b = two.mutate(request(2)),
    c = three.mutate(request(3));
  const third = c.then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  try {
    expect(f.entered()).toBe(2);
  } finally {
    f.release();
    await Promise.allSettled([a, b, c]);
  }
  expect(await third).toMatchObject({ error: { code: "authoring_busy" } });
});
