// `archer restart` is a hot swap: what a page and the agent were told just before it still holds
// after it. Two pieces of runtime state live outside the strict recovery record, in a separate
// private continuity file (`src/state/continuity.ts`) that an older build never reads: the
// `files` cue baseline (ADR 0028, "Change cues") and the agent's announced writes (recordWrite).
import { readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { revisionOf } from "../../src/project/index.ts";
import { connectService } from "../../src/service/service-client.ts";
import { apiBase, cleanUp, events, FLOW2, json, project, service, write } from "./support.ts";

afterEach(cleanUp);

const FLOW3 = "flowchart LR\n  a[Client] e1@--> b[Gateway]\n";
type Entry = { id: string; lastChange?: { by: string; summary?: string } };

/** A service with `root` attached and its page base, plus a way to restart it on the same state. */
async function attachedThenStopped(root: string, options: { now?: () => number } = {}) {
  const first = await service(options);
  const client = await connectService(first.svc.socketPath);
  await client.call("attach", { root });
  return {
    state: first.state,
    client,
    stop: async () => {
      client.close();
      await first.svc.close();
    },
  };
}

async function restarted(stateDir: string, root: string, options: { now?: () => number } = {}) {
  const again = await service({ stateDir, ...options });
  const client = await connectService(again.svc.socketPath);
  const { url } = await client.call("attach", { root });
  return { client, page: apiBase(url) };
}

const flowEntry = async (page: string): Promise<Entry | undefined> =>
  ((await json(`${page}api/diagrams`)) as { views: Entry[] }).views.find((v) => v.id === "flow");

const continuityFile = (stateDir: string): string => {
  const name = readdirSync(join(stateDir, "runtime")).find((f) => f.endsWith(".continuity.json"));
  if (name === undefined) throw new Error("no continuity file was written");
  return join(stateDir, "runtime", name);
};

test("a file changed while the service was stopped is announced to a page that connects after the restart", async () => {
  const root = project();
  write(root, ".archer/notes/plan.md", "# Plan\n\nFirst.\n");
  write(root, ".archer/notes/gone.md", "# Gone\n");
  const before = await attachedThenStopped(root);
  await before.stop();

  writeFileSync(join(root, ".archer/flow.mmd"), FLOW2);
  write(root, ".archer/notes/new.md", "# New\n");
  rmSync(join(root, ".archer/notes/gone.md"));

  const { client, page } = await restarted(before.state, root);
  const stream = await events(`${page}api/events`);
  try {
    expect(await stream.next("files")).toEqual({
      changed: [{ path: ".archer/flow.mmd", kind: "diagram", revision: revisionOf(Buffer.from(FLOW2)) }],
      added: [{ path: ".archer/notes/new.md", kind: "note", revision: revisionOf(Buffer.from("# New\n")) }],
      removed: [{ path: ".archer/notes/gone.md", kind: "note" }],
    });
  } finally {
    stream.close();
    client.close();
  }
}, 30_000);

test("a restart with nothing changed announces no files", async () => {
  const root = project();
  const before = await attachedThenStopped(root);
  await before.stop();
  const { client, page } = await restarted(before.state, root);
  const stream = await events(`${page}api/events`);
  try {
    await expect(stream.next("files", 1_000)).rejects.toThrow(/no files event/);
  } finally {
    stream.close();
    client.close();
  }
}, 30_000);

test("a write the agent announced just before a restart, landing while the service is down, is the agent's", async () => {
  const root = project();
  const before = await attachedThenStopped(root);
  await before.client.call("recordWrite", { root, viewId: "flow", summary: "named the gateway" });
  await before.stop();
  writeFileSync(join(root, ".archer/flow.mmd"), FLOW3);

  const { client, page } = await restarted(before.state, root);
  try {
    expect((await flowEntry(page))?.lastChange).toMatchObject({ by: "agent", summary: "named the gateway" });
  } finally {
    client.close();
  }
}, 30_000);

test("a write the agent announced just before a restart, landing after it, is the agent's", async () => {
  const root = project();
  const before = await attachedThenStopped(root);
  await before.client.call("recordWrite", { root, viewId: "flow", summary: "named the gateway" });
  await before.stop();

  const { client, page } = await restarted(before.state, root);
  const stream = await events(`${page}api/events`);
  try {
    writeFileSync(join(root, ".archer/flow.mmd"), FLOW3);
    expect(await stream.next("change")).toMatchObject({
      viewId: "flow",
      by: "agent",
      summary: "named the gateway",
      changed: ["b"],
    });
  } finally {
    stream.close();
    client.close();
  }
}, 30_000);

test("an announced write older than the window when the service is back is the person's", async () => {
  const root = project();
  let now = Date.now();
  const clock = { now: () => now };
  const before = await attachedThenStopped(root, clock);
  await before.client.call("recordWrite", { root, viewId: "flow", summary: "too long ago" });
  await before.stop();
  now += 6_000;

  const { client, page } = await restarted(before.state, root, clock);
  const stream = await events(`${page}api/events`);
  try {
    writeFileSync(join(root, ".archer/flow.mmd"), FLOW3);
    const change = (await stream.next("change")) as { by: string; summary?: string };
    expect(change).toMatchObject({ viewId: "flow", by: "person" });
    expect(change.summary).toBeUndefined();
  } finally {
    stream.close();
    client.close();
  }
}, 30_000);

test("a corrupt or oversized continuity file is ignored: the project opens, and later changes are announced as before", async () => {
  for (const garbage of [
    "{broken",
    JSON.stringify({ version: 1, root: "/elsewhere", writes: [] }),
    "x".repeat(5 * 1024 * 1024),
  ]) {
    const root = project();
    const before = await attachedThenStopped(root);
    await before.client.call("recordWrite", { root, viewId: "flow", summary: "lost" });
    await before.stop();
    writeFileSync(continuityFile(before.state), garbage);
    writeFileSync(join(root, ".archer/flow.mmd"), FLOW2);

    const { client, page } = await restarted(before.state, root);
    const stream = await events(`${page}api/events`);
    try {
      // Today's behaviour: the baseline is the disk at open, and the change made while down is the person's.
      expect((await flowEntry(page))?.lastChange).toMatchObject({ by: "person" });
      writeFileSync(join(root, ".archer/flow.mmd"), FLOW3);
      // The first cue is this change: none was held for the one made while the service was down.
      expect(await stream.next("files")).toEqual({
        changed: [{ path: ".archer/flow.mmd", kind: "diagram", revision: revisionOf(Buffer.from(FLOW3)) }],
        added: [],
        removed: [],
      });
    } finally {
      stream.close();
      client.close();
    }
  }
}, 60_000);
