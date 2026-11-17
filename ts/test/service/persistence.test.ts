import { afterEach, expect, test } from "vitest";
import { connectService } from "../../src/service/client.ts";
import { cleanUp, project, service, http, apiBase } from "./support.ts";
afterEach(cleanUp);
test("actual restart restores attachments, presentation stamp, selection and named emphasis", async () => {
  const root = project();
  const first = await service();
  const client = await connectService(first.svc.socketPath);
  const attached = await client.call("attach", { root });
  const presented = await client.call("present", { root, viewId: "flow", annotation: "Durable caption" });
  const model = await client.call("getModel", { root, viewId: "flow" });
  await client.call("setEmphasis", {
    root,
    viewId: "flow",
    emphases: [
      { id: "held", groups: [{ id: "client", label: "client", nodes: ["a"], edges: [], style: "highlight" }] },
    ],
  });
  const response = await http(`${apiBase(attached.url)}api/selection`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: new URL(attached.url).origin },
    body: JSON.stringify({
      schemaVersion: 1,
      viewId: "flow",
      revision: model.envelope!.revision,
      presentationId: presented.presentationId,
      nodes: [{ id: "a" }],
      edges: [],
    }),
  });
  expect(response.status).toBe(204);
  const before = await client.call("getContext", { root });
  client.close();
  await first.svc.close();
  const second = await service({ stateDir: first.state });
  const fresh = await connectService(second.svc.socketPath);
  try {
    expect((await fresh.call("listProjects", {})).projects.map((p) => p.root)).toContain(root);
    expect(await fresh.call("getContext", { root })).toEqual(before);
    const restored = await fresh.call("attach", { root });
    const bootstrap = JSON.parse((await http(`${apiBase(restored.url)}api/bootstrap`)).body);
    expect(bootstrap.recovery).toEqual({ selection: before.selection, envelope: model.envelope });
    expect((await fresh.call("listEmphases", { root, viewId: "flow" })).views[0]!.emphases[0]!.id).toBe("held");
  } finally {
    fresh.close();
  }
});
test("broken current source retains verified last-good and current diagnostics on restart", async () => {
  const root = project(),
    first = await service(),
    client = await connectService(first.svc.socketPath);
  await client.call("attach", { root });
  const good = await client.call("getModel", { root, viewId: "flow" });
  await client.call("present", { root, viewId: "flow" });
  client.close();
  await first.svc.close();
  const { write } = await import("./support.ts");
  write(root, ".archer/flow.mmd", "flowchart LR\n broken???\n");
  const second = await service({ stateDir: first.state }),
    fresh = await connectService(second.svc.socketPath);
  try {
    expect(await fresh.call("getModel", { root, viewId: "flow" })).toEqual(good);
    const attached = await fresh.call("attach", { root });
    const { json } = await import("./support.ts");
    expect(await json(`${apiBase(attached.url)}api/compile`)).toMatchObject({
      failures: [{ viewId: "flow", lastValidRevision: good.envelope!.revision }],
    });
  } finally {
    fresh.close();
  }
});
test("changed source drops stale selection while preserving captions and presentation ID", async () => {
  const root = project(),
    first = await service(),
    client = await connectService(first.svc.socketPath);
  const attached = await client.call("attach", { root }),
    shown = await client.call("present", { root, viewId: "flow", annotation: "Keep caption" }),
    model = await client.call("getModel", { root, viewId: "flow" });
  await http(`${apiBase(attached.url)}api/selection`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: new URL(attached.url).origin },
    body: JSON.stringify({
      schemaVersion: 1,
      viewId: "flow",
      revision: model.envelope!.revision,
      presentationId: shown.presentationId,
      nodes: [{ id: "a" }],
      edges: [],
    }),
  });
  const beforeInventory = JSON.parse((await http(`${apiBase(attached.url)}api/diagrams`)).body).views.find(
    (v: { id: string }) => v.id === "flow",
  );
  client.close();
  await first.svc.close();
  const { write, FLOW2 } = await import("./support.ts");
  write(root, ".archer/flow.mmd", FLOW2);
  const second = await service({ stateDir: first.state }),
    fresh = await connectService(second.svc.socketPath);
  try {
    const context = await fresh.call("getContext", { root });
    expect(context.selection).toBeNull();
    expect(context.presentation).toMatchObject({ presentationId: shown.presentationId, annotation: "Keep caption" });
    expect(context.presentation!.revision).not.toBe(model.envelope!.revision);
    const restored = await fresh.call("attach", { root });
    const inventory = JSON.parse((await http(`${apiBase(restored.url)}api/diagrams`)).body).views.find(
      (v: { id: string }) => v.id === "flow",
    );
    const { statSync } = await import("node:fs"),
      { join } = await import("node:path");
    expect(inventory.lastChange).toEqual({
      at: statSync(join(root, ".archer/flow.mmd")).mtime.toISOString(),
      by: "person",
    });
    expect(inventory.caption).toBe(beforeInventory.caption);
    expect(inventory.presentedAt).toBe(beforeInventory.presentedAt);
  } finally {
    fresh.close();
  }
});
test("restoreState=false leaves saved state intact; later restore returns previous state", async () => {
  const root = project(),
    first = await service(),
    client = await connectService(first.svc.socketPath);
  await client.call("attach", { root });
  const shown = await client.call("present", { root, viewId: "flow", annotation: "Remember" });
  client.close();
  await first.svc.close();
  const disabled = await service({ stateDir: first.state, restoreState: false }),
    empty = await connectService(disabled.svc.socketPath);
  expect((await empty.call("listProjects", {})).projects).toEqual([]);
  empty.close();
  await disabled.svc.close();
  const restored = await service({ stateDir: first.state }),
    fresh = await connectService(restored.svc.socketPath);
  try {
    expect((await fresh.call("getContext", { root })).presentation!.presentationId).toBe(shown.presentationId);
  } finally {
    fresh.close();
  }
});
test("detach ends automatic serving but retains context for explicit reattach", async () => {
  const root = project(),
    first = await service(),
    client = await connectService(first.svc.socketPath);
  await client.call("attach", { root });
  const shown = await client.call("present", { root, viewId: "flow" });
  await client.call("detach", { root });
  client.close();
  await first.svc.close();
  const second = await service({ stateDir: first.state }),
    fresh = await connectService(second.svc.socketPath);
  try {
    expect((await fresh.call("listProjects", {})).projects).toEqual([]);
    await fresh.call("attach", { root });
    expect((await fresh.call("getContext", { root })).presentation!.presentationId).toBe(shown.presentationId);
  } finally {
    fresh.close();
  }
});
test("sequence emphasis follows the same semantic message across positional renumbering after restart", async () => {
  const root = project(),
    first = await service(),
    client = await connectService(first.svc.socketPath);
  await client.call("attach", { root });
  const model = await client.call("getModel", { root, viewId: "chat" });
  const events = (
    model.envelope!.model as {
      events: {
        type: string;
        id: string;
      }[];
    }
  ).events;
  const old = events.find((e) => e.type === "message")!.id;
  await client.call("setEmphasis", {
    root,
    viewId: "chat",
    emphases: [
      { id: "message", groups: [{ id: "message", label: "message", nodes: [], edges: [old], style: "highlight" }] },
    ],
  });
  client.close();
  await first.svc.close();
  const { write, SEQ } = await import("./support.ts");
  write(root, ".archer/chat.mmd", SEQ.replace("A->>B: hi", "A->>B: earlier\n  A->>B: hi"));
  const second = await service({ stateDir: first.state }),
    fresh = await connectService(second.svc.socketPath);
  try {
    const next = await fresh.call("getModel", { root, viewId: "chat" });
    const messages = (
      next.envelope!.model as {
        events: {
          type: string;
          id: string;
          label: string;
        }[];
      }
    ).events.filter((e) => e.type === "message");
    const highlighted = (await fresh.call("listEmphases", { root, viewId: "chat" })).views[0]!.emphases[0]!.groups[0]!
      .edges;
    expect(highlighted).toEqual([messages.find((e) => e.label === "hi")!.id]);
    expect(highlighted).not.toContain(messages.find((e) => e.label === "earlier")!.id);
  } finally {
    fresh.close();
  }
});
test("rebound source path never inherits another file's last-good model", async () => {
  const root = project(),
    first = await service(),
    client = await connectService(first.svc.socketPath);
  await client.call("attach", { root });
  await client.call("present", { root, viewId: "flow" });
  client.close();
  await first.svc.close();
  const { write } = await import("./support.ts");
  write(
    root,
    "archer.toml",
    'version = 1\n[[views]]\nid = "flow"\nkind = "freeform"\ntitle = "Rebound"\nsource = ".archer/other.mmd"\n',
  );
  write(root, ".archer/other.mmd", "flowchart LR\n broken???\n");
  const second = await service({ stateDir: first.state }),
    fresh = await connectService(second.svc.socketPath);
  try {
    expect((await fresh.call("getModel", { root, viewId: "flow" })).envelope).toBeNull();
    expect((await fresh.call("getContext", { root })).presentation).toBeNull();
  } finally {
    fresh.close();
  }
});
test("declared source deletion retains last-good, unlisted source deletion removes it", async () => {
  const root = project(),
    first = await service(),
    client = await connectService(first.svc.socketPath);
  await client.call("attach", { root });
  const good = await client.call("getModel", { root, viewId: "flow" });
  client.close();
  await first.svc.close();
  const { unlinkSync } = await import("node:fs"),
    { join } = await import("node:path");
  unlinkSync(join(root, ".archer/flow.mmd"));
  unlinkSync(join(root, ".archer/chat.mmd"));
  const second = await service({ stateDir: first.state }),
    fresh = await connectService(second.svc.socketPath);
  try {
    expect(await fresh.call("getModel", { root, viewId: "flow" })).toEqual(good);
    await expect(fresh.call("getModel", { root, viewId: "chat" })).rejects.toMatchObject({
      error: { code: "diagram_not_found" },
    });
  } finally {
    fresh.close();
  }
});
test.each(["replace", "remove"] as const)(
  "corrupted semantic emphasis anchors (%s) are refused rather than rebound to another message",
  async (mode) => {
    const root = project(),
      first = await service(),
      client = await connectService(first.svc.socketPath);
    await client.call("attach", { root });
    const model = await client.call("getModel", { root, viewId: "chat" }),
      message = (
        model.envelope!.model as {
          events: {
            type: string;
            id: string;
          }[];
        }
      ).events.find((e) => e.type === "message")!;
    await client.call("setEmphasis", {
      root,
      viewId: "chat",
      emphases: [
        {
          id: "message",
          groups: [{ id: "message", label: "message", nodes: [], edges: [message.id], style: "highlight" }],
        },
      ],
    });
    client.close();
    await first.svc.close();
    const { readdirSync, readFileSync, writeFileSync } = await import("node:fs"),
      { join } = await import("node:path"),
      runtime = join(first.state, "runtime"),
      path = join(runtime, readdirSync(runtime).find((p) => /^[a-f0-9]{64}\.json$/.test(p))!);
    const raw = JSON.parse(readFileSync(path, "utf8"));
    const held = raw.emphases.find((v: { viewId: string }) => v.viewId === "chat").named[0];
    if (mode === "replace") held.anchors[0][1] = "an unrelated message anchor";
    else held.anchors = [];
    writeFileSync(path, JSON.stringify(raw));
    // Projects open after the service answers (server review S2): this one fails closed on its own.
    const second = await service({ stateDir: first.state }),
      again = await connectService(second.svc.socketPath);
    try {
      await expect(again.call("getModel", { root, viewId: "chat" })).rejects.toMatchObject({
        error: { code: "invalid_saved_state" },
      });
      await expect(again.call("attach", { root })).rejects.toMatchObject({ error: { code: "invalid_saved_state" } });
      expect((await again.call("listProjects", {})).projects.map((p) => p.root)).not.toContain(root);
      expect(await again.call("detach", { root })).toEqual({ detached: true });
    } finally {
      again.close();
    }
    expect(readFileSync(path, "utf8")).toBe(JSON.stringify(raw));
  },
);
test("restore environment override is strict and false does not attach saved projects", async () => {
  const root = project(),
    first = await service(),
    client = await connectService(first.svc.socketPath);
  await client.call("attach", { root });
  client.close();
  await first.svc.close();
  const disabled = await service({ stateDir: first.state, env: { ARCHER_RESTORE_STATE: "false" } }),
    fresh = await connectService(disabled.svc.socketPath);
  try {
    expect((await fresh.call("listProjects", {})).projects).toEqual([]);
  } finally {
    fresh.close();
    await disabled.svc.close();
  }
  await expect(service({ stateDir: first.state, env: { ARCHER_RESTORE_STATE: "maybe" } })).rejects.toMatchObject({
    code: "invalid_configuration",
  });
});
test("an attached root with missing recovery metadata fails closed without erasing the account index", async () => {
  const root = project(),
    first = await service(),
    client = await connectService(first.svc.socketPath);
  await client.call("attach", { root });
  client.close();
  await first.svc.close();
  const { readdirSync, unlinkSync, readFileSync } = await import("node:fs"),
    { join } = await import("node:path"),
    runtime = join(first.state, "runtime"),
    index = readFileSync(join(runtime, "index.json"), "utf8");
  unlinkSync(join(runtime, readdirSync(runtime).find((p) => /^[a-f0-9]{64}\.json$/.test(p))!));
  await expect(service({ stateDir: first.state })).rejects.toMatchObject({ code: "invalid_saved_state" });
  expect(readFileSync(join(runtime, "index.json"), "utf8")).toBe(index);
});
