// A fake Archer service on a real Unix socket for the CLI's listener commands and the MCP relay:
// it speaks the management protocol (hello, then any method a test answers), the contract's
// listener methods (agents/contract.ts) answered by the test, and after an `mcpRelay` answer
// carries raw lines as the real one does (lines sent right after the answer are relay lines, and
// `mcpRelay` may carry the `agentId` the relay registered just before it). Methods a test does not
// answer get `not_implemented`; handlers that stand for
// the real service follow its contract (agents/contract.ts): `claimListener` answers `claimedRoot`,
// an id the service does not know is refused `agent_unknown` on every method, and (decision 16: the
// service keeps agents and claims across a restart) a known id registered again is accepted and keeps
// its claim, so a CLI and relay sharing one id carry on after a swap.
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION } from "../../src/service/protocol.ts";

export type Handler = (params: Record<string, unknown>, socket: Socket) => unknown | Promise<unknown>;

export interface FakeService {
  readonly socketPath: string;
  readonly dir: string;
  /** Every request in arrival order. */
  readonly requests: { method: string; params: Record<string, unknown> }[];
  /** Raw relay lines received after `mcpRelay`, per connection in order. */
  readonly relayed: string[][];
  /** Relay sockets, to write lines back to the relay or end them. */
  readonly relays: Socket[];
  handlers: Record<string, Handler>;
  /** Ends every open connection (a handover's old copy going away). */
  dropAll(): void;
  close(): Promise<void>;
}

export class Refusal extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const made: string[] = [];
const open: FakeService[] = [];

export async function fakeService(
  handlers: Record<string, Handler> = {},
  options: { version?: string; socketPath?: string } = {},
): Promise<FakeService> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "archer-fake-")));
  made.push(dir);
  const socketPath = options.socketPath ?? join(dir, "archer.sock");
  const sockets = new Set<Socket>();
  const fake: FakeService = {
    socketPath,
    dir,
    requests: [],
    relayed: [],
    relays: [],
    handlers,
    dropAll: () => {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
    },
    close: () =>
      new Promise<void>((resolve) => {
        fake.dropAll();
        server.close(() => resolve());
      }),
  };
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    socket.setEncoding("utf8");
    let buffer = "";
    let relayLines: string[] | null = null;
    socket.on("close", () => {
      if (relayLines !== null) void fake.handlers["relayClose"]?.({}, socket);
    });
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (relayLines !== null) {
          relayLines.push(line);
          fake.handlers["relayLine"]?.({ line }, socket);
          continue;
        }
        const request = JSON.parse(line) as { id: number; method: string; params: Record<string, unknown> };
        fake.requests.push({ method: request.method, params: request.params });
        if (request.method === "mcpRelay" && fake.handlers["mcpRelay"] !== undefined) {
          // Upgraded at once, as the real service does, so lines sent right after the answer are relay lines.
          relayLines = [];
          fake.relayed.push(relayLines);
          fake.relays.push(socket);
        }
        void answer(socket, request);
      }
    });
  });
  async function answer(
    socket: Socket,
    request: { id: number; method: string; params: Record<string, unknown> },
  ): Promise<void> {
    const reply = (value: object): void => {
      if (!socket.destroyed) socket.write(`${JSON.stringify({ id: request.id, ...value })}\n`);
    };
    if (request.method === "hello") {
      reply({
        ok: true,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          version: options.version ?? "0.7.0-test",
          homeUrl: "http://127.0.0.1:9/",
          serviceName: "archer",
        },
      });
      return;
    }
    const handler = fake.handlers[request.method];
    if (handler === undefined) {
      reply({ ok: false, error: { code: "not_implemented", message: `${request.method} is not built yet` } });
      return;
    }
    try {
      reply({ ok: true, result: await handler(request.params, socket) });
    } catch (error) {
      reply({
        ok: false,
        error:
          error instanceof Refusal
            ? { code: error.code, message: error.message }
            : { code: "internal", message: String(error) },
      });
    }
  }
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  open.push(fake);
  return fake;
}

export async function closeFakes(): Promise<void> {
  for (const fake of open.splice(0)) await fake.close();
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
}
