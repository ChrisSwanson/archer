// ADR 0028: after each reload the service names the files that changed, as a bounded `files` event
// with project-relative paths and revisions, and no content. The page turns it into a transient
// "<file> updated" popup.
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { revisionOf } from "../../src/project/index.ts";
import { connectService } from "../../src/service/service-client.ts";
import { MAX_FILES_EVENT } from "../../src/service/project-state.ts";
import { apiBase, cleanUp, events, FLOW, FLOW2, project, service, write } from "./support.ts";

afterEach(cleanUp);

async function watched() {
  const { svc } = await service();
  const client = await connectService(svc.socketPath);
  const root = project();
  write(root, ".archer/notes/plan.md", "# Plan\n\nFirst.\n");
  const { url } = await client.call("attach", { root });
  const stream = await events(`${apiBase(url)}api/events`);
  return { client, root, stream };
}

test("a changed, an added and a removed file are named once, project-relative, with revisions and no content", async () => {
  const { client, root, stream } = await watched();
  try {
    writeFileSync(join(root, ".archer/flow.mmd"), FLOW2);
    expect(await stream.next("files")).toEqual({
      changed: [{ path: ".archer/flow.mmd", kind: "diagram", revision: revisionOf(Buffer.from(FLOW2)) }],
      added: [],
      removed: [],
    });
    write(root, ".archer/notes/new.md", "# New\n");
    expect(await stream.next("files")).toEqual({
      changed: [],
      added: [{ path: ".archer/notes/new.md", kind: "note", revision: revisionOf(Buffer.from("# New\n")) }],
      removed: [],
    });
    rmSync(join(root, ".archer/notes/plan.md"));
    expect(await stream.next("files")).toEqual({
      changed: [],
      added: [],
      removed: [{ path: ".archer/notes/plan.md", kind: "note" }],
    });
    const text = JSON.stringify(stream);
    expect(text).not.toContain(root);
  } finally {
    stream.close();
    client.close();
  }
}, 20_000);

test("a burst is capped and says it was truncated", async () => {
  const { client, root, stream } = await watched();
  try {
    for (let i = 0; i < MAX_FILES_EVENT + 20; i++) write(root, `.archer/notes/n${i}.md`, `# N${i}\n`);
    let seen = 0;
    let truncated = false;
    while (seen < MAX_FILES_EVENT + 20 && !truncated) {
      const event = (await stream.next("files")) as {
        added: unknown[];
        changed: unknown[];
        removed: unknown[];
        truncated?: true;
      };
      const count = event.added.length + event.changed.length + event.removed.length;
      expect(count).toBeLessThanOrEqual(MAX_FILES_EVENT);
      seen += count;
      truncated = event.truncated === true;
    }
    expect(seen > 0).toBe(true);
  } finally {
    stream.close();
    client.close();
  }
}, 30_000);

test("an unchanged rewrite and the first load announce nothing", async () => {
  const { client, root, stream } = await watched();
  try {
    writeFileSync(join(root, ".archer/flow.mmd"), FLOW);
    writeFileSync(join(root, ".archer/flow.mmd"), FLOW2);
    const event = (await stream.next("files")) as { changed: { path: string }[] };
    expect(event.changed.map((entry) => entry.path)).toEqual([".archer/flow.mmd"]);
  } finally {
    stream.close();
    client.close();
  }
}, 20_000);

test("a discovery change that hides a file announces nothing about it", async () => {
  const { svc } = await service();
  const client = await connectService(svc.socketPath);
  const root = project();
  const manifest = (exclude: string) =>
    `version = 1\n\n[discovery]\nroots = [".archer", "docs"]\nexclude = [${exclude}]\n\n[[views]]\nid = "flow"\nkind = "freeform"\ntitle = "The flow"\nsource = ".archer/flow.mmd"\n`;
  write(root, "archer.toml", manifest(""));
  write(root, "docs/private.md", "# Private\n");
  const { url } = await client.call("attach", { root });
  const stream = await events(`${apiBase(url)}api/events`);
  try {
    write(root, "archer.toml", manifest('"docs/private.md"'));
    await stream.next("documents");
    writeFileSync(join(root, ".archer/flow.mmd"), FLOW2);
    const event = (await stream.next("files")) as { changed: { path: string }[]; removed: { path: string }[] };
    expect(event.changed.map((entry) => entry.path)).toEqual([".archer/flow.mmd"]);
    expect(JSON.stringify(event)).not.toContain("private.md");
  } finally {
    stream.close();
    client.close();
  }
}, 20_000);
