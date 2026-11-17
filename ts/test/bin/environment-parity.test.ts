import { afterEach, expect, test } from "vitest";
import { main, type Io } from "../../src/bin/main.ts";
import { connectIfRunning, connectService } from "../../src/service/client.ts";
import { call, connect, refusal, structured } from "../mcp/support.ts";
import { cleanUp, openPage, project, service, tempDir } from "../service/support.ts";

afterEach(cleanUp);
const environmentNames = ["start_service", "stop_service", "list_projects", "attach_project", "detach_project"];

async function cli(name: string, args: Record<string, unknown>, cwd: string, socketPath: string) {
  let out = "",
    err = "";
  // The same Archer home as the MCP side (vitest env): start_service names its preferences note.
  const io: Io = {
    cwd,
    env: { ARCHER_SOCKET: socketPath, ARCHER_HOME: process.env["ARCHER_HOME"] },
    isTTY: false,
    columns: undefined,
    stdout: (text) => (out += text),
    stderr: (text) => (err += text),
    stdin: async () => JSON.stringify(args),
  };
  const code = await main(["call", name, "--stdin", "--json"], io);
  return { code, out, err };
}

test.each(environmentNames)("CLI and MCP %s share results and real service outcomes", async (name) => {
  const root = project();
  const { svc } = await service();
  const mcp = await connect({
    cwd: root,
    findService: () => connectIfRunning({ socketPath: svc.socketPath }),
    ensureService: () => connectService(svc.socketPath),
  });
  const args = name === "attach_project" || name === "detach_project" ? { root } : {};
  let observer = await connectService(svc.socketPath);
  try {
    if (name === "detach_project" || name === "list_projects") await observer.call("attach", { root });
    const answer = structured(await call(mcp.client, name, args));
    const afterMcp = name === "stop_service" ? null : await observer.call("listProjects", {});
    if (name === "attach_project") {
      expect(afterMcp?.projects.map((p) => p.root)).toEqual([root]);
      expect((await openPage(afterMcp!.projects[0]!.url)).status).toBe(200);
      await observer.call("detach", { root });
    }
    if (name === "detach_project") {
      expect(afterMcp?.projects).toEqual([]);
      await observer.call("attach", { root });
    }
    if (name === "start_service") expect(afterMcp?.projects).toEqual([]);
    let cliService = svc;
    if (name === "stop_service") {
      await svc.closed;
      expect(await connectIfRunning({ socketPath: svc.socketPath })).toBeNull();
      observer.close();
      cliService = (await service()).svc;
      observer = await connectService(cliService.socketPath);
    }
    const result = await cli(name, args, root, cliService.socketPath);
    expect(result.code, result.err).toBe(0);
    expect(JSON.parse(result.out)).toEqual(answer);
    if (name === "stop_service") {
      await cliService.closed;
      expect(await connectIfRunning({ socketPath: cliService.socketPath })).toBeNull();
    } else {
      expect(await observer.call("listProjects", {})).toEqual(afterMcp);
    }
  } finally {
    observer.close();
    await mcp.close();
  }
});

test.each(["stop_service", "list_projects", "detach_project"])(
  "CLI and MCP %s leave an absent service absent",
  async (name) => {
    const root = tempDir();
    const socketPath = `${root}/absent.sock`;
    let starts = 0;
    const mcp = await connect({
      cwd: root,
      findService: () => connectIfRunning({ socketPath }),
      ensureService: async () => {
        starts++;
        throw new Error("unexpected startup");
      },
    });
    try {
      const args = name === "detach_project" ? { root: "missing" } : {};
      const answer = structured(await call(mcp.client, name, args));
      const result = await cli(name, args, root, socketPath);
      expect(result.code, result.err).toBe(0);
      expect(JSON.parse(result.out)).toEqual(answer);
      expect(starts).toBe(0);
      expect(await connectIfRunning({ socketPath })).toBeNull();
    } finally {
      await mcp.close();
    }
  },
);

test("CLI and MCP refuse invalid attachment equally before starting a daemon", async () => {
  const root = tempDir();
  const socketPath = `${root}/absent.sock`;
  const mcp = await connect({
    cwd: root,
    findService: async () => null,
    ensureService: async () => {
      throw new Error("unexpected startup");
    },
  });
  try {
    const error = await refusal(mcp.client, "attach_project", { root: "missing" });
    const result = await cli("attach_project", { root: "missing" }, root, socketPath);
    expect(result.code).toBe(1);
    const output = JSON.parse(result.err);
    expect(output.code).toBe(error.data["code"]);
    expect(output.message).toBe(error.message.replace(/^MCP error -\d+: /, ""));
    expect(await connectIfRunning({ socketPath })).toBeNull();
  } finally {
    await mcp.close();
  }
});
