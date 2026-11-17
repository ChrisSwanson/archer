// The reader's selection is saved deferred (owner decision 2026-11-11, refactor slice c5): it is current at
// once, its save waits up to DEFER_MS and coalesces, a failed save is answered 204 and logged as
// svc.state-save, and a stop, hand-over or detach saves it before the project is let go. An agent's
// present stays durable: a store that refuses it refuses the call and changes nothing.
import { createServer } from "node:http";
import { readdirSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { AccountStateStore, PersistenceError } from "../../src/state/account.ts";
import { ProjectState } from "../../src/service/project-state.ts";
import { DEFER_MS } from "../../src/service/project-state/persister.ts";
import { handleSelection } from "../../src/service/http.ts";
import { connectService } from "../../src/service/client.ts";
import { activate, deactivate } from "../../src/telemetry/index.ts";
import { Telemetry } from "../../src/telemetry/telemetry.ts";
import { apiBase, cleanUp, http, project, service, tempDir } from "./support.ts";
afterEach(cleanUp);

/** Breaks the store as a full or read-only disk would: its sources directory becomes a symlink, which it refuses. */
function breakStore(store: AccountStateStore): void {
  const sourceDir = join(store.directory, readdirSync(store.directory).find((name) => name.endsWith(".sources"))!);
  rmSync(sourceDir, { recursive: true });
  symlinkSync(tempDir(), sourceDir);
}

async function opened(): Promise<{ store: AccountStateStore; state: ProjectState }> {
  const store = new AccountStateStore(tempDir());
  const state = await ProjectState.open(
    project(),
    () => "http://localhost/p/",
    () => {},
    { store },
  );
  state.persist();
  return { store, state };
}

test("a selection the store cannot save is answered 204, is current at once, and the failed save is logged as svc.state-save", async () => {
  const telemetry = new Telemetry();
  activate(telemetry);
  const { store, state } = await opened();
  state.present("flow", "Keep this");
  const before = state.context();
  breakStore(store);
  // An actual HTTP request exercises the production handler. The catch only
  // keeps a regression rejection observable instead of hanging the test client.
  const server = createServer((req, res) => {
    void handleSelection(state, req, res).catch(() => res.writeHead(599).end());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address() as { port: number };
    const response = await http(`http://127.0.0.1:${port}/`, {
      method: "POST",
      body: JSON.stringify({
        schemaVersion: 1,
        viewId: "flow",
        revision: before.presentation!.revision,
        presentationId: before.presentation!.presentationId,
        nodes: [{ id: "a" }],
        edges: [],
      }),
    });
    expect(response.status).toBe(204);
    const now = state.context();
    expect(now.presentation).toEqual(before.presentation);
    expect(now.selection).toMatchObject({ viewId: "flow", nodes: [{ id: "a" }] });
    await expect
      .poll(() => telemetry.entries({ limit: 100 }).filter((e) => e.code === "svc.state-save"), { timeout: 2_000 })
      .toEqual([expect.objectContaining({ level: "warn", code: "svc.state-save" })]);
    expect(state.context()).toEqual(now);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    state.close();
    deactivate(telemetry);
  }
});

test("a present the store cannot save is still refused saved_state_io and keeps the context", async () => {
  const { store, state } = await opened();
  try {
    state.present("flow", "Keep this");
    const before = state.context();
    breakStore(store);
    let refused: unknown;
    try {
      state.present("chat", "Not this");
    } catch (e) {
      refused = e;
    }
    expect(refused).toBeInstanceOf(PersistenceError);
    expect((refused as PersistenceError).code).toBe("saved_state_io");
    expect(state.context()).toEqual(before);
  } finally {
    state.close();
  }
});

test("a selection is not saved before DEFER_MS, and a close within it saves it at once", async () => {
  const { store, state } = await opened();
  const shown = state.present("flow");
  const revision = state.envelope("flow")!.revision;
  const saved = () => new AccountStateStore(join(store.directory, "..")).load(state.root)?.selection ?? null;
  try {
    expect(
      state.postSelection(
        JSON.parse(selecting({ revision, presentationId: shown.presentationId }, "b")) as Record<string, unknown>,
      ),
    ).toMatchObject({ ok: true });
    expect(state.context().selection).toMatchObject({ nodes: [{ id: "b" }] });
    expect(saved()).toBeNull();
  } finally {
    // The service closes a state before a stop, a hand-over or a detach lets the project go.
    state.close();
  }
  expect(saved()).toMatchObject({ nodes: [{ id: "b" }] });
});

/** A selection body for the presented flow, picking `node`. */
function selecting(presentation: { revision: string; presentationId: string }, node: string): string {
  return JSON.stringify({
    schemaVersion: 1,
    viewId: "flow",
    revision: presentation.revision,
    presentationId: presentation.presentationId,
    nodes: [{ id: node }],
    edges: [],
  });
}

async function attachedAndPresented() {
  const root = project();
  const first = await service();
  const client = await connectService(first.svc.socketPath);
  const attached = await client.call("attach", { root });
  const presented = await client.call("present", { root, viewId: "flow" });
  const model = await client.call("getModel", { root, viewId: "flow" });
  const presentation = { revision: model.envelope!.revision, presentationId: presented.presentationId };
  const select = async (node: string) => {
    const response = await http(`${apiBase(attached.url)}api/selection`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: new URL(attached.url).origin },
      body: selecting(presentation, node),
    });
    expect(response.status).toBe(204);
  };
  return { root, first, client, select };
}

test("a selection then a hand-over within DEFER_MS: the replacement restores it", async () => {
  const { root, first, client, select } = await attachedAndPresented();
  const started = Date.now();
  await select("b");
  const before = await client.call("getContext", { root });
  expect(before.selection).toMatchObject({ nodes: [{ id: "b" }] });
  expect(await client.call("handover", {})).toEqual({ stopping: true });
  expect(Date.now() - started).toBeLessThan(DEFER_MS);
  client.close();
  await first.svc.closed;
  // Saved by the stop itself, before it let go of the lock, not by the deferred save's timer.
  expect(Date.now() - started).toBeLessThan(DEFER_MS);
  expect(new AccountStateStore(first.state).load(root)?.selection).toMatchObject({ nodes: [{ id: "b" }] });
  const second = await service({ stateDir: first.state });
  const fresh = await connectService(second.svc.socketPath);
  try {
    await expect.poll(async () => (await fresh.call("getContext", { root })).selection).toEqual(before.selection);
  } finally {
    fresh.close();
  }
});

test("a selection then a detach within DEFER_MS: it is saved, and an explicit attach restores it", async () => {
  const { root, first, client, select } = await attachedAndPresented();
  try {
    const started = Date.now();
    await select("b");
    const before = await client.call("getContext", { root });
    expect(await client.call("detach", { root })).toEqual({ detached: true });
    // Saved by the detach itself, before its answer, not by the deferred save's timer.
    expect(new AccountStateStore(first.state).load(root)?.selection).toMatchObject({ nodes: [{ id: "b" }] });
    expect(Date.now() - started).toBeLessThan(DEFER_MS);
    await client.call("attach", { root });
    expect((await client.call("getContext", { root })).selection).toEqual(before.selection);
  } finally {
    client.close();
  }
});
