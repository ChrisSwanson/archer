// Harness for the MCP server tests: an SDK client wired to the server over the
// SDK's in-memory transport, and a fake Archer service that speaks
// ts/src/service/protocol.ts over a real Unix socket, so the service client is
// exercised end to end. The fake keeps only what the protocol says the service
// keeps: attached projects, the last presentation, emphases and a selection.
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer, type Server as NetServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpError, type ClientCapabilities } from "@modelcontextprotocol/sdk/types.js";
import { createArcherServer, type ArcherServerOptions } from "../../src/mcp/index.ts";
import { PROTOCOL_VERSION, type Request, type ServiceError } from "../../src/service/protocol.ts";
import { ProjectState, StateRefusal } from "../../src/service/project-state.ts";
import type { SelectionContext } from "../../src/service/selection.ts";

export { FLOW, SEQ, BROKEN, removeTempDirs, tempDir, write } from "../project/support.ts";

export interface Connected {
  readonly client: Client;
  readonly close: () => Promise<void>;
}

export async function connect(options: ArcherServerOptions, capabilities: ClientCapabilities = {}): Promise<Connected> {
  const server = createArcherServer(options);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" }, { capabilities });
  await server.connect(serverSide);
  await client.connect(clientSide);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

/** A tool call's result, or the McpError it was refused with. */
export async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  return client.callTool({ name, arguments: args });
}

/** The refusal a call ends in; fails the test when the call succeeds. */
export async function refusal(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<McpError & { data: Record<string, unknown> }> {
  try {
    const result = await client.callTool({ name, arguments: args });
    throw new Error(`expected ${name} to be refused, and it returned ${JSON.stringify(result).slice(0, 400)}`);
  } catch (error) {
    if (error instanceof McpError) return error as McpError & { data: Record<string, unknown> };
    throw error;
  }
}

export function structured(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  return result.structuredContent as Record<string, unknown>;
}

export function text(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = result.content as { type: string; text?: string }[];
  return content.map((c) => c.text ?? "").join("\n");
}

export interface FakeService {
  readonly socketPath: string;
  /** Every request received, in order. */
  readonly requests: Request[];
  selection: SelectionContext | null;
  /** Named emphases per root and view, merged by id as the service merges them: same id replaces, no groups clears. */
  readonly emphases: Map<string, { id: string; groups: unknown[] }[]>;
  /** The writes the MCP server said it was about to make, by root and view, as the service keeps them: the latest only. */
  readonly writes: Map<string, { summary?: string }>;
  /** Called as each recordWrite arrives, before it is answered. */
  onRecordWrite: ((params: { root: string; viewId: string; summary?: string }) => void) | null;
  /** Answer present as a service from before it took emphases: ignore them. */
  ignorePresentEmphases: boolean;
  /** The next request of this method is answered with this error. */
  failNext(method: Request["method"], error: ServiceError): void;
  close(): Promise<void>;
}

const sockets: string[] = [];

/** `base`: the page origin the fake reports (default plain HTTP on loopback). */
export async function startFakeService({
  base = "http://127.0.0.1:4100",
}: {
  base?: string;
} = {}): Promise<FakeService> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "archer-svc-")));
  sockets.push(dir);
  const socketPath = join(dir, "service.sock");
  const requests: Request[] = [];
  const failures = new Map<string, ServiceError>();
  const open = new Set<Socket>();
  let presentations = 0;
  const states = new Map<string, ProjectState>();
  const presentationIds = new Map<string, string>();
  const projectUrl = (root: string) =>
    `${base}/projects/${(root.split("/").pop() ?? "x").toLowerCase()}/?follow&token=${"ab".repeat(32)}`;

  const fake: FakeService = {
    socketPath,
    requests,
    selection: null,
    emphases: new Map(),
    writes: new Map(),
    onRecordWrite: null,
    ignorePresentEmphases: false,
    failNext(method, error) {
      failures.set(method, error);
    },
    close: () =>
      new Promise<void>((done) => {
        for (const socket of open) socket.destroy();
        for (const state of states.values()) state.close();
        server.close(() => done());
      }),
  };

  const stateOf = (root: string): ProjectState => {
    const state = states.get(root);
    if (state === undefined) throw new StateRefusal("project_not_attached", "attach this project first");
    return state;
  };
  const answer = async (request: Request): Promise<unknown> => {
    switch (request.method) {
      case "pendingChanges":
        return {
          scope: "pending",
          records: [],
          upperSequence: 0,
          omittedCount: 0,
          hasMore: false,
          complete: true,
          nextCursor: null,
        };
      case "hello":
        return {
          protocolVersion: PROTOCOL_VERSION,
          version: "fake",
          homeUrl: "http://127.0.0.1:4100/tok/",
          serviceName: "default",
        };
      case "attach":
        if (!states.has(request.params.root))
          states.set(
            request.params.root,
            await ProjectState.open(request.params.root, () => projectUrl(request.params.root)),
          );
        return { root: request.params.root, name: "project", url: projectUrl(request.params.root) };
      case "detach":
        return { detached: true };
      case "listProjects":
        return { projects: [] };
      case "present": {
        await stateOf(request.params.root).reload();
        const { emphasis } = stateOf(request.params.root).present(
          request.params.viewId,
          request.params.annotation,
          fake.ignorePresentEmphases ? undefined : request.params.emphases,
        );
        presentations += 1;
        presentationIds.set(request.params.root, `p-${presentations}`);
        return {
          url: projectUrl(request.params.root),
          presentationId: `p-${presentations}`,
          ...(emphasis === undefined ? {} : { emphasis }),
        };
      }
      case "getContext": {
        const state = stateOf(request.params.root);
        await state.reload();
        const context = state.context();
        return {
          presentation:
            context.presentation === null
              ? null
              : { ...context.presentation, presentationId: presentationIds.get(request.params.root) },
          selection: fake.selection,
        };
      }
      case "getModel": {
        const state = stateOf(request.params.root);
        await state.reload();
        return state.modelSnapshot(request.params.viewId);
      }
      case "setEmphasis": {
        const key = `${request.params.root}#${request.params.viewId}`;
        const held = fake.emphases.get(key) ?? [];
        for (const raw of request.params.emphases as { id: string; groups: unknown[] }[]) {
          const at = held.findIndex((e) => e.id === raw.id);
          if (raw.groups.length === 0) {
            if (at >= 0) held.splice(at, 1);
          } else if (at >= 0) held[at] = raw;
          else held.push(raw);
        }
        fake.emphases.set(key, held);
        return { url: projectUrl(request.params.root) };
      }
      case "recordWrite": {
        const { root, viewId, summary } = request.params;
        fake.onRecordWrite?.(request.params);
        fake.writes.set(`${root}#${viewId}`, summary === undefined ? {} : { summary });
        return { recorded: true };
      }
      case "stop":
        return { stopping: true };
      case "getProjectModel":
        // As a service that has not attached the project answers (ADR 0036 A2): the caller builds it itself.
        throw Object.assign(new Error("no project is attached"), { code: "project_not_attached" });
    }
  };

  const server: NetServer = createServer((socket) => {
    open.add(socket);
    socket.on("close", () => open.delete(socket));
    let buffered = "";
    socket.on("data", (chunk) => {
      buffered += chunk.toString("utf8");
      let newline = buffered.indexOf("\n");
      while (newline >= 0) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        newline = buffered.indexOf("\n");
        const request = JSON.parse(line) as Request;
        requests.push(request);
        const failure = failures.get(request.method);
        if (failure) {
          failures.delete(request.method);
          socket.write(`${JSON.stringify({ id: request.id, ok: false, error: failure })}\n`);
        } else
          void answer(request).then(
            (result) => socket.write(`${JSON.stringify({ id: request.id, ok: true, result })}\n`),
            (error) =>
              socket.write(
                `${JSON.stringify({ id: request.id, ok: false, error: { code: error.code ?? "internal", message: error.message } })}\n`,
              ),
          );
      }
    });
  });
  await new Promise<void>((done) => server.listen(socketPath, done));
  return fake;
}

export function removeSocketDirs(): void {
  for (const dir of sockets.splice(0)) rmSync(dir, { recursive: true, force: true });
}
