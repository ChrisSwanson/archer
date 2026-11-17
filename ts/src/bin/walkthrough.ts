// `archer walkthrough list|show|write|delete [--json] [--markdown]` (ADR 0034 §5): aliases for the
// shared operations, as `archer emphasis` is. Walkthrough files are the state, so none starts a service.
import { parseArgs } from "node:util";
import { createApplication, OperationError } from "../application/index.ts";
import type { Resolution, Walkthrough } from "../walkthroughs/contract.ts";
import { walkthroughMarkdown } from "../walkthroughs/markdown.ts";
import { connectIfRunning } from "../service/client.ts";
import { safe, UsageError, usage, type Io } from "./main.ts";
import { executeOperation, parsePayload, readPayload, type OperationIo } from "./operations.ts";

const SHAPE =
  "walkthrough needs list <viewId>, show <viewId> <id> [--markdown], write <viewId> (--file <walkthrough.json> | --stdin) [--expected N], or delete <viewId> <id> [--expected N]";

/** The one-off application these commands read through; with a model but no running service. */
async function viaApplication<T>(
  io: Io,
  use: (
    call: (name: string, args: Record<string, unknown>) => Promise<{ structured: Record<string, unknown> }>,
  ) => Promise<T>,
): Promise<T> {
  const app = createApplication({
    cwd: io.cwd ?? process.cwd(),
    env: io.env,
    findService: () => connectIfRunning({ env: io.env }),
  });
  try {
    return await use((name, args) => app.call(name, { ...args, outputFormat: "json" }));
  } finally {
    app.close();
  }
}

export async function run(args: readonly string[], io: OperationIo): Promise<number> {
  const [action, ...rest] = args;
  const { values, positionals } = usage(() =>
    parseArgs({
      args: rest,
      strict: true,
      allowPositionals: true,
      options: {
        json: { type: "boolean" },
        markdown: { type: "boolean" },
        file: { type: "string" },
        stdin: { type: "boolean" },
        expected: { type: "string" },
      },
    }),
  );
  const [viewId, id] = positionals;
  const expected = values.expected === undefined ? undefined : Number(values.expected);
  if (expected !== undefined && !(Number.isInteger(expected) && expected >= 1))
    throw new UsageError("--expected must be a revision number, 1 or more");
  const json = values.json === true;
  if (values.markdown === true && (action !== "show" || json))
    throw new UsageError("--markdown is for  walkthrough show  and conflicts with --json");
  const fail = (error: unknown): number => {
    if (!(error instanceof OperationError)) throw error;
    const { code, ...details } = error.data;
    io.stderr(
      json ? `${JSON.stringify({ code, message: error.message, details })}\n` : `archer: ${safe(error.message)}\n`,
    );
    return 1;
  };

  if (action === "list") {
    if (positionals.length !== 1 || values.file !== undefined || values.stdin === true || expected !== undefined)
      throw new UsageError(SHAPE);
    return executeOperation("list_walkthroughs", { viewId }, io, json);
  }
  if (action === "show") {
    if (positionals.length !== 2 || values.file !== undefined || values.stdin === true || expected !== undefined)
      throw new UsageError(SHAPE);
    if (values.markdown !== true) return executeOperation("list_walkthroughs", { viewId, id }, io, json);
    try {
      const shown = await viaApplication(io, (call) => call("list_walkthroughs", { viewId, id }));
      io.stdout(
        safe(
          walkthroughMarkdown(
            shown.structured["walkthrough"] as Walkthrough,
            shown.structured["resolution"] as Resolution,
          ),
        ),
      );
      return 0;
    } catch (error) {
      return fail(error);
    }
  }
  if (action === "write") {
    if (positionals.length !== 1 || (values.file === undefined) === (values.stdin !== true))
      throw new UsageError(SHAPE);
    let walkthrough: Record<string, unknown>;
    try {
      walkthrough = values.file !== undefined ? readPayload(values.file, io) : parsePayload(await readAll(io));
    } catch (error) {
      if (error instanceof UsageError) throw error;
      throw new UsageError(`cannot read the walkthrough: ${error instanceof Error ? error.message : String(error)}`);
    }
    // The echo of `show --json` is accepted: unwrapped, and its revision taken as the one to replace.
    const echoed =
      typeof walkthrough["walkthrough"] === "object" && walkthrough["walkthrough"] !== null && !("steps" in walkthrough)
        ? (walkthrough["walkthrough"] as Record<string, unknown>)
        : walkthrough;
    const revision = expected ?? (typeof echoed["revision"] === "number" ? echoed["revision"] : undefined);
    try {
      const modelRevision = await viaApplication(
        io,
        async (call) => (await call("read_diagram", { viewId })).structured["modelRevision"],
      );
      return executeOperation(
        "write_walkthrough",
        {
          viewId,
          modelRevision,
          walkthrough: echoed,
          ...(revision === undefined ? {} : { expectedRevision: revision }),
        },
        io,
        json,
      );
    } catch (error) {
      return fail(error);
    }
  }
  if (action === "delete") {
    if (positionals.length !== 2 || values.file !== undefined || values.stdin === true) throw new UsageError(SHAPE);
    try {
      // A person at a terminal deletes what they see: the current revision, unless they name one.
      const revision =
        expected ??
        (await viaApplication(
          io,
          async (call) =>
            ((await call("list_walkthroughs", { viewId, id })).structured["walkthrough"] as Walkthrough).revision,
        ));
      return executeOperation(
        "write_walkthrough",
        { viewId, walkthrough: { id }, delete: true, expectedRevision: revision },
        io,
        json,
      );
    } catch (error) {
      return fail(error);
    }
  }
  throw new UsageError(SHAPE);
}

async function readAll(io: OperationIo): Promise<string> {
  if (io.stdin !== undefined) return io.stdin();
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  return Buffer.concat(chunks).toString("utf8");
}
