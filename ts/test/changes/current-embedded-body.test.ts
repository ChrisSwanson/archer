import { randomBytes } from "node:crypto";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { ChangeStore } from "../../src/changes/index.ts";
import { observeCurrent } from "../../src/changes/review.ts";
import { embeddedDiagrams, readEmbedded } from "../../src/notes/embedded.ts";
import { findProject } from "../../src/project/project.ts";
import { removeTempDirs, tempDir } from "../project/support.ts";
afterEach(removeTempDirs);

test.each([false, true])(
  "current implicit baseline compares exact body bytes; after explicit=%s keeps its true CAS separately",
  (explicit) => {
    const before = "\uFEFFflowchart LR\r\n  a[Before]\r\n";
    const wrap = (body: string, heading = "Login") =>
      "\uFEFF---\r\nauthor: person\r\n---\r\n# " +
      heading +
      "\r\n\r\n```mermaid\r\n" +
      body +
      "```\r\n\r\nSurrounding prose.\r\n";
    const root = tempDir({ ".archer/note.md": wrap(before) }),
      project = findProject(root),
      named = embeddedDiagrams(project, "note.md").diagrams[0]!;
    expect(named.explicit).toBe(false);
    const initial = readEmbedded(project, named.address)!;
    const after = (explicit ? "%% archer-id: " + named.name + "\r\n" : "") + "flowchart LR\r\n  a[After]\r\n";
    const stateDir = tempDir();
    chmodSync(stateDir, 0o700);
    const store = new ChangeStore({ stateDir, serviceName: "main", assertOwner() {} });
    const record = store.admit({
      operationId: randomBytes(16).toString("hex"),
      projectRoot: root,
      format: "mermaid",
      origin: "browser_editor",
      eventKind: "document.updated",
      target: { kind: "document", path: ".archer/note.md", blockId: named.name },
      before: Buffer.from(before),
      after: Buffer.from(after),
    }).record;
    expect(initial.sourceRevision).not.toBe(record.before!.revision);
    expect(observeCurrent(record)).toMatchObject({ status: "matches_before", sourceRevision: initial.sourceRevision });
    writeFileSync(
      join(root, ".archer/note.md"),
      wrap(before).replace("Surrounding prose.", "Edited surrounding prose."),
    );
    expect(observeCurrent(record).status).toBe("matches_before");
    writeFileSync(join(root, ".archer/note.md"), wrap(after));
    const current = readEmbedded(project, named.address)!;
    expect(observeCurrent(record)).toMatchObject({ status: "matches_after", sourceRevision: current.sourceRevision });
    writeFileSync(join(root, ".archer/note.md"), wrap(after.replace("After", "External")));
    expect(observeCurrent(record).status).toBe(explicit ? "diverged" : "missing");
  },
);
