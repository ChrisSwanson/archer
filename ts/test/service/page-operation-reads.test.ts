// A page operation (export_diagram from the gallery or the export menu) reads the
// model this service serves; it must not force a project reload per call, which
// a front door's getModel/getContext does to see an agent's unreported write.
import { afterEach, expect, test, vi } from "vitest";
import { connectService } from "../../src/service/service-client.ts";
import { ProjectState } from "../../src/service/project-state.ts";
import { apiBase, cleanUp, http, ownerCookie, project, service } from "./support.ts";

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanUp();
});

test("export_diagram from the page answers without reloading the project; a front door's read still reloads", async () => {
  const root = project();
  // The project's watcher may report the files written just before it started (macOS delivers such events
  // late, sometimes after it first settles): that reload is the watcher's, not the page's. Counting starts once
  // it has settled, and reloads the watcher starts later are told apart by its trace.
  let settled!: () => void;
  const watcherQuiet = new Promise<void>((resolve) => {
    settled = resolve;
    setTimeout(resolve, 1_500);
  });
  // The watcher's lines since counting started: a reload it began is not the page's (O285), and a failure
  // shows what it saw.
  let watcherReloads = 0;
  const traced: string[] = [];
  const { svc } = await service({
    watchTrace: (line) => {
      if (line.includes("reload:settled")) settled();
      traced.push(line);
      if (line.includes("reload:start")) watcherReloads++;
    },
  });
  const client = await connectService(svc.socketPath);
  try {
    const { url } = await client.call("attach", { root });
    // The page is signed in before it asks for anything (the agent link's token exchanged for its cookie).
    await ownerCookie(apiBase(url));
    await watcherQuiet;
    const reloads = vi.spyOn(ProjectState.prototype, "reload");
    watcherReloads = 0;
    traced.length = 0;
    /** Reloads not started by the watcher: the page's or a front door's. */
    const notWatcher = () => reloads.mock.calls.length - watcherReloads;
    const operation = (args: Record<string, unknown>) =>
      http(`${apiBase(url)}api/operations`, {
        method: "POST",
        body: JSON.stringify({ name: "export_diagram", arguments: args }),
      });
    const plain = await operation({ viewId: "flow", format: "svg" });
    expect(plain.status, plain.body).toBe(200);
    expect(JSON.parse(plain.body)).toMatchObject({ mimeType: "image/svg+xml" });
    const presented = await operation({ viewId: "flow", format: "svg", mode: "presentation" });
    expect(presented.status, presented.body).toBe(200);
    expect(notWatcher(), traced.join("\n")).toBe(0);

    await client.call("getModel", { root, viewId: "flow" });
    expect(notWatcher(), traced.join("\n")).toBe(1);
  } finally {
    client.close();
  }
});

test("a page operation's read of an unknown project is refused in the front doors' vocabulary", async () => {
  const root = project();
  const { svc } = await service();
  const client = await connectService(svc.socketPath);
  try {
    const { url } = await client.call("attach", { root });
    const reply = await http(`${apiBase(url)}api/operations`, {
      method: "POST",
      body: JSON.stringify({ name: "export_diagram", arguments: { viewId: "nope", format: "svg" } }),
    });
    expect(reply.status).toBe(422);
    expect(JSON.parse(reply.body).error.code).toBeTypeOf("string");
  } finally {
    client.close();
  }
});
