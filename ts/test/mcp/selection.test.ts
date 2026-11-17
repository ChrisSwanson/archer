import { afterEach, expect, test } from "vitest";
import { connect, call, structured, tempDir, FLOW, removeTempDirs } from "./support.ts";
import { startService } from "../../src/service/service.ts";
import { connectService } from "../../src/service/service-client.ts";

afterEach(removeTempDirs);

test("MCP selection uses authoritative service validation and preserves state on stale refusal", async () => {
  const cwd = tempDir({ ".archer/arch.mmd": FLOW });
  const state = tempDir();
  const svc = await startService({ forceHttp: true, stateDir: state, env: { HOME: state }, log: () => {} });
  const { client, close } = await connect({ cwd, ensureService: () => connectService(svc.socketPath) });
  try {
    const presented = structured(await call(client, "present_diagram", { viewId: "arch" })) as {
      presentation: { presentationId: string; viewId: string; revision: string };
    };
    const selection = {
      schemaVersion: 1,
      ...presented.presentation,
      nodes: [{ id: "a", label: "forged" }],
      edges: [],
      selectionRevision: 1,
    };
    const accepted = structured(await call(client, "set_selection", selection));
    expect(accepted).toMatchObject({
      selection: { ...presented.presentation, nodes: [{ id: "a", label: "Client" }], edges: [] },
    });
    expect(structured(await call(client, "get_presentation_context"))).toMatchObject(accepted);
    await expect(call(client, "set_selection", { ...selection, revision: `sha256:${"0".repeat(64)}` })).rejects.toThrow(
      /revision/,
    );
    expect(structured(await call(client, "get_presentation_context"))).toMatchObject(accepted);
    expect(structured(await call(client, "set_selection", { ...selection, nodes: [] }))).toMatchObject({
      selection: { nodes: [], edges: [] },
    });
  } finally {
    await close();
    await svc.close();
  }
}, 15_000); // a real service and MCP client: 0.6 s idle, 2.0 s beside the UI and browser jobs; timed out at 5 s on CI
