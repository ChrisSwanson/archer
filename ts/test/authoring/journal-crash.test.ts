import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test } from "vitest";
import { AuthoringStore, type JournalIntent, type JournalCompletion } from "../../src/authoring/store.ts";
const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
function state() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "archer-authoring-crash-")));
  chmodSync(root, 0o700);
  roots.push(root);
  return root;
}
const make = (stateDir: string, epoch = "a".repeat(32)) =>
  new AuthoringStore({ stateDir, serviceName: "main", epoch, assertOwner() {} });
const source = "flowchart LR\r\n a[🧭]\r\n";
function request(store: AuthoringStore): JournalIntent {
  return {
    operationId: "1".repeat(32),
    payloadDigest: "sha256:" + "2".repeat(64),
    op: "document.apply",
    projectRoot: "/projects/one",
    authority: { grantId: "grant", entitlementId: "ent" },
    feedback: { changes: "on_save", delivery: "next_call", effectiveRevision: "sha256:" + "3".repeat(64) },
    target: { kind: "document", path: ".archer/a.mmd" },
    expected: { sourceRevision: null },
    base: null,
    candidate: store.putSnapshot(Buffer.from(source)),
  };
}
const completion: JournalCompletion = {
  outcome: "applied",
  evidence: "observed",
  review: { mode: "on_save", configRevision: "sha256:" + "3".repeat(64), state: "admission_pending" },
};
test.each(["before_blob_publish", "after_blob_link", "after_blob_publish"] as const)(
  "process crash at %s leaves no sourceeffect or admitted intent",
  (step) => {
    const root = state();
    make(root);
    const module = new URL("../../src/authoring/store.ts", import.meta.url).href;
    const script = `import {AuthoringStore} from ${JSON.stringify(module)};let armed=false;const s=new AuthoringStore({stateDir:process.env.AUTHORING_STATE,serviceName:'main',assertOwner(){},onCommitStep(step){if(armed&&step===${JSON.stringify(step)})process.exit(49);}});armed=true;s.putSnapshot(Buffer.from(${JSON.stringify(source)}));`;
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
      env: { ...process.env, AUTHORING_STATE: root },
      encoding: "utf8",
      timeout: 10000,
    });
    expect(result.status, result.stderr).toBe(49);
    const s = make(root, "b".repeat(32));
    expect(s.getOperation("1".repeat(32))).toBe(null);
    expect(s.listDrafts("/projects/one")).toEqual([]);
    expect(readdirSync(join(root, "runtime/authoring/snapshots")).some((name) => name.startsWith(".blob."))).toBe(
      step === "before_blob_publish",
    );
  },
  15000,
);
test.each(["before_index_publish", "after_index_publish", "after_index_sync"] as const)(
  "process crash at intent %s never executes sourceeffect on reopen",
  (step) => {
    const root = state(),
      s = make(root),
      input = request(s),
      module = new URL("../../src/authoring/store.ts", import.meta.url).href;
    const script = `import {AuthoringStore} from ${JSON.stringify(module)};let armed=false;const s=new AuthoringStore({stateDir:process.env.AUTHORING_STATE,serviceName:'main',epoch:'${"a".repeat(32)}',assertOwner(){},onCommitStep(step){if(armed&&step===${JSON.stringify(step)})process.exit(50);}});armed=true;s.beginOperation(${JSON.stringify(input)});`;
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
      env: { ...process.env, AUTHORING_STATE: root },
      encoding: "utf8",
      timeout: 10000,
    });
    expect(result.status, result.stderr).toBe(50);
    const recovered = make(root, "b".repeat(32)),
      op = recovered.getOperation(input.operationId);
    expect(op?.state ?? null).toBe(step === "before_index_publish" ? null : "uncertain");
    expect(recovered.readSnapshot(input.candidate!)).toEqual(Buffer.from(source));
    expect(recovered.listDrafts("/projects/one")).toEqual([]);
  },
  15000,
);
test.each(["before_index_publish", "after_index_publish", "after_index_sync"] as const)(
  "terminal crash at %s preserves recorded outcome only after index publication",
  (step) => {
    const root = state(),
      s = make(root),
      input = request(s);
    s.beginOperation(input);
    const module = new URL("../../src/authoring/store.ts", import.meta.url).href;
    const script = `import {AuthoringStore} from ${JSON.stringify(module)};let armed=false;const s=new AuthoringStore({stateDir:process.env.AUTHORING_STATE,serviceName:'main',epoch:'${"a".repeat(32)}',assertOwner(){},onCommitStep(step){if(armed&&step===${JSON.stringify(step)})process.exit(51);}});armed=true;s.completeOperation('${input.operationId}','${input.payloadDigest}',${JSON.stringify(completion)});`;
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
      env: { ...process.env, AUTHORING_STATE: root },
      encoding: "utf8",
      timeout: 10000,
    });
    expect(result.status, result.stderr).toBe(51);
    const recovered = make(root, "b".repeat(32)),
      op = recovered.getOperation(input.operationId)!;
    expect(op.state).toBe(step === "before_index_publish" ? "uncertain" : "terminal");
    if (op.state === "terminal") expect(op.completion).toEqual(completion);
  },
  15000,
);
test("visible failed publication latches the owner and a restart exposes uncertainty without acknowledging success", () => {
  const root = state();
  make(root);
  let armed = false;
  const s = new AuthoringStore({
      stateDir: root,
      serviceName: "main",
      epoch: "a".repeat(32),
      assertOwner() {},
      onCommitStep(step) {
        if (armed && step === "after_index_publish") throw new Error("directory-sync not acknowledged");
      },
    }),
    input = request(s);
  armed = true;
  expect(() => s.beginOperation(input)).toThrow("not acknowledged");
  expect(() => s.getOperation(input.operationId)).toThrow("authority is unavailable");
  const reopened = make(root, "b".repeat(32));
  expect(reopened.getOperation(input.operationId)!.state).toBe("uncertain");
  expect(readFileSync(join(root, "runtime/authoring/index.json"), "utf8")).toContain("uncertain");
});
