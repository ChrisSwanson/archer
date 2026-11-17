/**
 * An agent session on the real service's management socket (ADR 0035 §7), for browser tests that need a listener
 * without an agent host: register, claim, and read what the service holds. The socket is the one `startTsProject`
 * starts the service on (`<state>/archer.sock`, beside its `configPath`). Loaded by computed path, as
 * ts-service.ts loads the service, so the page's `tsc` does not check the service's sources.
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { TsProject } from "./ts-service";

const TS_SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../../../ts/src");
type Client = { call(method: string, params: unknown): Promise<unknown>; close(): void };

export type Agents = {
  /** Registers a session in `root` (the project's own by default) and returns its id. */
  register(
    label: string,
    options?: { readonly root?: string; readonly host?: "claude-code" | "codex" | "other" },
  ): Promise<string>;
  /** `archer listen --claim` for that session, in its own checkout. */
  claim(agentId: string, root?: string): Promise<unknown>;
  /** The listing the service holds for a checkout, as `archer listen` reads it. */
  listing(
    root?: string,
  ): Promise<{ current: { state: string; listener: { agentId: string } | null; pinnedByPerson: boolean } }>;
  /** Any management call (attach a second checkout, say). */
  call(method: string, params: unknown): Promise<unknown>;
  close(): void;
};

export async function agentsOf(server: TsProject): Promise<Agents> {
  const { connectService } = (await import(
    /* @vite-ignore */ pathToFileURL(join(TS_SRC, "service/service-client.ts")).href
  )) as { connectService(p: string): Promise<Client> };
  const client = await connectService(join(dirname(server.configPath), "archer.sock"));
  return {
    async register(label, options = {}) {
      const root = options.root ?? server.root;
      const answer = (await client.call("registerAgent", {
        root,
        cwd: root,
        host: options.host ?? "claude-code",
        label,
      })) as { agentId: string };
      return answer.agentId;
    },
    claim: (agentId, root = server.root) => client.call("claimListener", { root, agentId }),
    listing: async (root = server.root) =>
      (await client.call("listListeners", { root })) as Awaited<ReturnType<Agents["listing"]>>,
    call: (method, params) => client.call(method, params),
    close: () => client.close(),
  };
}
