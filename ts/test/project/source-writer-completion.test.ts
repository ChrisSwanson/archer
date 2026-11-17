import { afterEach, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { findProject } from "../../src/project/project.ts";
import { revisionOf } from "../../src/project/envelope.ts";
import { readEmbedded } from "../../src/notes/embedded.ts";
import {
  applySource,
  createConfined,
  withSourceWriterLock,
  type SourcePublication,
} from "../../src/project/source-writer.ts";
import { tempDir, removeTempDirs, FLOW } from "./support.ts";
afterEach(removeTempDirs);
const setup = () => findProject(tempDir({ "archer.toml": "version = 1\n", ".archer/a.mmd": FLOW }));
test("observed Apply and unchanged completion runs before the source lock releases", async () => {
  const project = setup(),
    next = FLOW.replace("Client", "Changed");
  const seen: SourcePublication[] = [];
  const afterWrite = (receipt: SourcePublication) => {
    expect(readFileSync(join(project.folder, "a.mmd"))).toEqual(receipt.after);
    expect(() => withSourceWriterLock(project, "a.mmd", () => 42, 10)).toThrowError(
      expect.objectContaining({ code: "source_busy" }),
    );
    seen.push(receipt);
  };
  const result = await applySource(project, { kind: "view", viewId: "a" }, revisionOf(Buffer.from(FLOW)), next, {
    afterWrite,
  });
  expect(seen).toEqual([result]);
  await applySource(project, { kind: "view", viewId: "a" }, result.sourceRevision, next, { afterWrite });
  expect(seen[1]!.outcome).toBe("unchanged");
});
test("exclusive creation completion has observed bytes and the same held source lock", () => {
  const project = setup();
  let seen: SourcePublication | undefined;
  createConfined(project, "diagrams/new.mmd", FLOW, {
    afterWrite(receipt) {
      seen = receipt;
      expect(readFileSync(join(project.folder, "diagrams/new.mmd"))).toEqual(receipt.after);
      expect(() => withSourceWriterLock(project, "diagrams/new.mmd", () => 42, 10)).toThrowError(
        expect.objectContaining({ code: "source_busy" }),
      );
    },
  });
  expect(seen).toEqual({
    path: "diagrams/new.mmd",
    blockId: null,
    before: null,
    after: Buffer.from(FLOW),
    sourceRevision: revisionOf(Buffer.from(FLOW)),
    outcome: "created",
  });
});
test("async completion callbacks refuse before canonical publication", async () => {
  const project = setup(),
    next = FLOW.replace("Client", "Changed");
  await expect(
    applySource(project, { kind: "view", viewId: "a" }, revisionOf(Buffer.from(FLOW)), next, {
      afterWrite: async () => {},
    }),
  ).rejects.toMatchObject({ code: "invalid_callback" });
  expect(readFileSync(join(project.folder, "a.mmd"), "utf8")).toBe(FLOW);
  expect(() => createConfined(project, "diagrams/new.mmd", FLOW, { afterWrite: async () => {} })).toThrowError(
    expect.objectContaining({ code: "invalid_callback" }),
  );
  expect(() => readFileSync(join(project.folder, "diagrams/new.mmd"))).toThrow();
});

test("embedded completion receives actual pinned CRLF bytes and unchanged body CAS", async () => {
  const root = tempDir({
      "archer.toml": "version = 1\n",
      ".archer/n.md": "# Flow\r\n```mermaid\r\nflowchart LR\r\na[A]\r\n```\r\nTail",
    }),
    project = findProject(root);
  const opened = readEmbedded(project, "n.md#flow")!,
    seen: SourcePublication[] = [];
  const first = await applySource(project, { kind: "embedded", address: opened.address }, opened.sourceRevision, FLOW, {
    afterWrite: (receipt) => {
      seen.push(receipt);
    },
  });
  expect(seen[0]!.after).toEqual(first.after);
  expect(seen[0]!.after.toString()).toContain("%% archer-id: flow\r\n");
  expect(seen[0]!.sourceRevision).toBe(readEmbedded(project, opened.address)!.sourceRevision);
  await applySource(
    project,
    { kind: "embedded", address: opened.address },
    first.sourceRevision,
    first.after.toString(),
    {
      afterWrite: (receipt) => {
        seen.push(receipt);
      },
    },
  );
  expect(seen[1]!.outcome).toBe("unchanged");
  expect(seen[1]!.after).toEqual(first.after);
});
