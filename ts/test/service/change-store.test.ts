import { afterEach, expect, test } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanUp, project, service, tempDir, write } from "./support.ts";
import { ServiceRunningError } from "../../src/service/service.ts";
import { connectService } from "../../src/service/service-client.ts";
import { PROTOCOL_VERSION } from "../../src/service/protocol.ts";
import type { ChangeInput } from "../../src/changes/index.ts";

afterEach(cleanUp);

function creation(root: string, operationId = "a".repeat(32)): ChangeInput {
  return {
    operationId,
    projectRoot: root,
    format: "mermaid",
    origin: "browser_editor",
    target: { kind: "document", path: ".archer/new.mmd" },
    eventKind: "document.created",
    before: null,
    after: Buffer.from("flowchart LR\n  a[Client] e1@--> b[API]\n"),
  };
}

test("the running service owns a persistent change-store identity and closes its old writer", async () => {
  const first = await service();
  expect(existsSync(join(first.state, "runtime/change-review"))).toBe(false);
  expect(first.svc).toHaveProperty("changes");
  const oldWriter = first.svc.changes;
  const identity = oldWriter.status();
  expect(identity.storeId).toMatch(/^store_[a-f0-9]{32}$/);
  expect(identity.generation).toMatch(/^gen_[a-f0-9]{32}$/);
  await first.svc.close();
  const second = await service({ stateDir: first.state });
  expect(second.svc.changes.status()).toEqual(identity);
  const readsAndWrites = [
    () => first.svc.changes,
    () => oldWriter.status(),
    () => oldWriter.admit(creation(first.state)),
    () => oldWriter.pending(first.state, { limit: 10 }),
    () => oldWriter.get(first.state, `chg_${"b".repeat(32)}`),
    () => oldWriter.readSnapshot(first.state, `chg_${"b".repeat(32)}`, "after"),
  ];
  for (const operation of readsAndWrites)
    expect(operation).toThrow(expect.objectContaining({ code: "change_store_closed" }));
});

test("the real service retains exact saved snapshots and replay identity across replacement", async () => {
  const root = project();
  const before = Buffer.from("\ufeffflowchart LR\r\n  a[Résumé] e1@--> b[API]\r\n");
  const after = Buffer.from("\ufeffflowchart LR\r\n  a[Résumé] e1@-->|送信| b[API]\r\n");
  const path = write(root, ".archer/flow.mmd", before.toString("utf8"));
  const input: ChangeInput = {
    ...creation(root),
    target: { kind: "document", path: ".archer/flow.mmd" },
    eventKind: "proposal.saved",
    before,
    after,
  };
  const first = await service();
  const admitted = first.svc.changes.admit(input);
  expect(admitted.kind).toBe("admitted");
  expect(admitted.record.after).toEqual({
    revision: `sha256:${createHash("sha256").update(after).digest("hex")}`,
    bytes: after.length,
  });
  expect(first.svc.changes.readSnapshot(root, admitted.record.changeId, "before")).toEqual(before);
  expect(first.svc.changes.readSnapshot(root, admitted.record.changeId, "after")).toEqual(after);
  expect(readFileSync(path)).toEqual(before); // Admission stores a proposal, not a source write.
  await first.svc.close();
  writeFileSync(path, "Current source has changed independently.\n");
  const second = await service({ stateDir: first.state });
  expect(second.svc.changes.admit(input)).toEqual({ kind: "replayed", record: admitted.record });
  expect(second.svc.changes.pending(root, { limit: 10 }).records).toEqual([admitted.record]);
  expect(second.svc.changes.readSnapshot(root, admitted.record.changeId, "after")).toEqual(after);
  const other = project();
  expect(second.svc.changes.get(other, admitted.record.changeId)).toBeNull();
  expect(() => second.svc.changes.readSnapshot(other, admitted.record.changeId, "after")).toThrow(
    expect.objectContaining({ code: "change_not_found" }),
  );
  expect(second.svc.changes.pending(other, { limit: 10 }).records).toEqual([]);
});

test("the existing service singleton prevents a second writer using an alternate socket", async () => {
  const root = project();
  const first = await service();
  const admitted = first.svc.changes.admit(creation(root));
  const index = join(first.state, "runtime/change-review/index.json");
  const original = readFileSync(index);
  await expect(service({ stateDir: first.state, socketPath: join(tempDir(), "other.sock") })).rejects.toBeInstanceOf(
    ServiceRunningError,
  );
  expect(readFileSync(index)).toEqual(original);
  expect(first.svc.changes.admit(creation(root))).toEqual({ kind: "replayed", record: admitted.record });
});

test("a corrupt optional store is refused without preventing ordinary service connections", async () => {
  const first = await service();
  const identity = first.svc.changes.status();
  const index = join(first.state, "runtime/change-review/index.json");
  const validIndex = readFileSync(index);
  await first.svc.close();
  writeFileSync(index, "broken index", { mode: 0o600 });
  const second = await service({ stateDir: first.state });
  let firstFailure: unknown;
  try {
    second.svc.changes.status();
  } catch (failure) {
    firstFailure = failure;
  }
  expect(firstFailure).toMatchObject({ code: "change_store_invalid" });
  const client = await connectService(second.svc.socketPath);
  try {
    expect(await client.call("hello", { protocolVersion: PROTOCOL_VERSION })).toMatchObject({
      protocolVersion: PROTOCOL_VERSION,
    });
  } finally {
    client.close();
  }
  expect(readFileSync(index, "utf8")).toBe("broken index");
  writeFileSync(index, validIndex);
  let repeatedFailure: unknown;
  try {
    second.svc.changes.status();
  } catch (failure) {
    repeatedFailure = failure;
  }
  expect(repeatedFailure).toBe(firstFailure); // Repair requires a new service owner, not another getter.
  await second.svc.close();
  const third = await service({ stateDir: first.state });
  expect(third.svc.changes.status()).toEqual(identity);
});

test("selected service identity is bound to its store while a mismatch leaves hello available", async () => {
  const first = await service({ serviceName: "alpha" });
  const identity = first.svc.changes.status();
  await first.svc.close();
  const second = await service({ stateDir: first.state, serviceName: "beta" });
  expect(() => second.svc.changes).toThrow(expect.objectContaining({ code: "change_store_invalid" }));
  const client = await connectService(second.svc.socketPath);
  try {
    expect(await client.call("hello", { protocolVersion: PROTOCOL_VERSION })).toMatchObject({ serviceName: "beta" });
  } finally {
    client.close();
  }
  await second.svc.close();
  const third = await service({ stateDir: first.state, serviceName: "alpha" });
  expect(third.svc.changes.status()).toEqual(identity);
});
