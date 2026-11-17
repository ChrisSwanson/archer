import { afterEach, expect, test } from "vitest";
import { createApplication, OperationError } from "../../src/application/index.ts";
import { main } from "../../src/bin/main.ts";
import { connectService } from "../../src/service/client.ts";
import { connect, refusal } from "../mcp/support.ts";
import { cleanUp, ownerFetch, project, service, apiBase } from "../service/support.ts";

afterEach(cleanUp);

test("export revision refusal retains the same recovery details across API, MCP, CLI and browser HTTP", async () => {
  const root = project();
  const { svc } = await service({ env: { ARCHER_OPEN_BROWSER: "never" } });
  const options = {
    cwd: root,
    ensureService: () => connectService(svc.socketPath),
    findService: () => connectService(svc.socketPath),
  };
  const app = createApplication(options);
  const mcp = await connect(options);
  try {
    const current = await app.call("read_diagram", { viewId: "flow" });
    const args = { viewId: "flow", expectedRevision: `sha256:${"0".repeat(64)}` };
    let failure: unknown;
    try {
      await app.call("export_diagram", args);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(OperationError);
    const domain = failure as OperationError;
    expect(domain.data).toEqual({
      code: "revision_conflict",
      expectedRevision: args.expectedRevision,
      actualRevision: current.structured.modelRevision,
    });
    const { code, ...details } = domain.data;
    expect((await refusal(mcp.client, "export_diagram", args)).data).toEqual(domain.data);
    let stdout = "",
      stderr = "";
    expect(
      await main(["call", "export_diagram", "--stdin", "--json"], {
        cwd: root,
        env: { ARCHER_SOCKET: svc.socketPath },
        isTTY: false,
        columns: undefined,
        stdin: async () => JSON.stringify(args),
        stdout: (text) => (stdout += text),
        stderr: (text) => (stderr += text),
      }),
    ).toBe(1);
    expect(stdout).toBe("");
    expect(JSON.parse(stderr)).toEqual({ code, message: domain.message, details });
    const url = String((await app.call("get_ui_url")).structured.url);
    const response = await ownerFetch(`${apiBase(url)}api/operations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "export_diagram", arguments: args }),
    });
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ schemaVersion: 1, error: { code, message: domain.message, details } });
  } finally {
    app.close();
    await mcp.close();
  }
});
