// CLI is an adapter of the same operations used by MCP. Discover names first,
// then request one schema: invoking a tool never needs the rest of the catalog.
import { TRUST_STEPS, type AskPerson } from "../application/network-access.ts";
import { randomBytes } from "node:crypto";
import { readFileSync, statSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { createApplication, OPERATIONS, OperationError } from "../application/index.ts";
import { connectIfRunning, ensureService } from "../service/client.ts";
import { MAX_SOURCE_BYTES, sourceTooLargeMessage } from "../mermaid/limits.ts";
import { safe, UsageError, usage, type Io } from "./main.ts";
import { callerAgentId, reportIn } from "./agents.ts";
import { agentIdentity } from "../mcp/host-contract.ts";
import { renderOperation } from "../application/render.ts";

/** Enough for the largest supported source even when every byte is JSON escaped. */
export const MAX_ARGUMENT_BYTES = 2 * 1024 * 1024;
export type OperationIo = Io & { readonly stdin?: () => Promise<string> };

export function parsePayload(text: string): Record<string, unknown> {
  if (Buffer.byteLength(text, "utf8") > MAX_ARGUMENT_BYTES)
    throw new UsageError(`operation arguments exceed ${MAX_ARGUMENT_BYTES} bytes`);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new UsageError("operation arguments must be valid JSON");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new UsageError("operation arguments must be a JSON object");
  return value as Record<string, unknown>;
}

export function readPayload(file: string, io: Io): Record<string, unknown> {
  const path = resolve(io.cwd ?? process.cwd(), file);
  if (statSync(path).size > MAX_ARGUMENT_BYTES)
    throw new UsageError(`operation arguments exceed ${MAX_ARGUMENT_BYTES} bytes`);
  return parsePayload(readFileSync(path, "utf8"));
}

async function readStdin(io: OperationIo): Promise<string> {
  if (io.stdin !== undefined) return io.stdin();
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    bytes += buffer.length;
    if (bytes > MAX_ARGUMENT_BYTES) throw new UsageError(`operation arguments exceed ${MAX_ARGUMENT_BYTES} bytes`);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** The CLI's refusal to open Archer to the network without a person at a terminal to say yes. */
export const NO_TERMINAL_FOR_NETWORK =
  "Opening Archer to the network needs the person's own yes, typed at a terminal, and this has none (an agent's shell, a pipe or a script). Nothing was changed. Ask the person to run  archer network-access  in their own terminal, which asks them there; or, if Archer's MCP tools are attached to this session, call setup_network_access there, where the client asks them.";

/**
 * The question for setup_network_access from the CLI: only a person at a terminal answers it. With no
 * terminal there is no one to ask, so the CLI refuses; personConfirmed is never taken from the CLI.
 */
function terminalAsk(io: Io): AskPerson | undefined {
  if (io.askAtTerminal !== undefined) return io.askAtTerminal;
  if (io.isTTY !== true || process.stdin.isTTY !== true) return undefined;
  return async (question) => (await import("./network-prompt.ts")).askAtTerminal(question);
}

export async function executeOperation(
  name: string,
  args: Record<string, unknown>,
  io: Io,
  json: boolean,
  outputFile?: string,
  verbose = false,
): Promise<number> {
  const network = name === "setup_network_access" && args["enabled"] !== false;
  const askPerson = network ? terminalAsk(io) : undefined;
  if (network) {
    if (askPerson === undefined) {
      io.stderr(
        json
          ? `${JSON.stringify({ code: "person_confirmation_needed", message: NO_TERMINAL_FOR_NETWORK, details: { fix: { text: "the person runs archer network-access in their own terminal", command: "archer network-access", needsPersonYes: true } } })}\n`
          : `archer: ${NO_TERMINAL_FOR_NETWORK}\n`,
      );
      return 1;
    }
    // The person's answer at the terminal decides; a personConfirmed passed in is ignored.
    const { personConfirmed: _ignored, ...rest } = args;
    args = rest;
  }
  // A recognised listener reports in with every call (decision 4) and says who asks (decision 10).
  const reporting = reportIn(io);
  const app = createApplication({
    ...agentIdentity(callerAgentId(io)),
    ...(askPerson === undefined ? {} : { askPerson }),
    cwd: io.cwd ?? process.cwd(),
    waitForLayoutReview: true,
    env: io.env,
    findService: () => connectIfRunning({ env: io.env }),
    ensureService: () => ensureService({ env: io.env }),
    startService: () => ensureService({ env: io.env, autoStart: true }),
  });
  try {
    const invalidFormat =
      args["outputFormat"] !== undefined && args["outputFormat"] !== "text" && args["outputFormat"] !== "json";
    const result = await app.call(name, invalidFormat ? args : { ...args, outputFormat: json ? "json" : "text" });
    if (outputFile !== undefined) {
      const outputPath = resolve(io.cwd ?? process.cwd(), outputFile);
      const temporary = `${outputPath}.archer-${randomBytes(8).toString("hex")}.tmp`;
      try {
        writeFileSync(temporary, Buffer.from(String(result.structured["data"]), "base64"), { flag: "wx", mode: 0o600 });
        renameSync(temporary, outputPath);
      } finally {
        rmSync(temporary, { force: true });
      }
      const { data: _payload, encoding: _encoding, ...metadata } = result.structured;
      io.stdout(
        json
          ? `${JSON.stringify({ ...metadata, outputPath })}\n`
          : `Saved ${String(metadata["format"]).toUpperCase()} to ${safe(outputPath)}.\n${safe(result.text)}\n`,
      );
    } else if (json) io.stdout(`${JSON.stringify(result.structured)}\n`);
    else if (network) io.stdout(`${safe(networkSummary(result.structured))}\n`);
    else if (name === "read_note") {
      // Agent pipes need exact source through EOF. An interactive terminal must
      // still escape file-controlled terminal sequences and label that change.
      io.stdout(
        io.isTTY
          ? `Terminal-safe display; pipe text output or use --json for exact source.\n${safe(result.text.replace("--- BEGIN EXACT NOTE SOURCE ---", "--- BEGIN TERMINAL-SAFE NOTE SOURCE ---"))}\n`
          : result.text,
      );
    } else io.stdout(`${safe(verbose ? renderOperation(name, result, true) : result.text)}\n`);
    return 0;
  } catch (error) {
    if (!(error instanceof OperationError)) throw error;
    const { code, ...details } = error.data;
    // A local diagnostic (an unreadable global archer.toml) for this account's own terminal only.
    const local = (error as { localDetail?: unknown }).localDetail;
    const diagnostic = typeof local === "string" ? local : undefined;
    if (network && code === "person_declined" && !json) {
      io.stderr("Not changed: Archer still serves only this computer.\n");
      return 1;
    }
    io.stderr(
      json
        ? `${JSON.stringify({ code, message: error.message, details, ...(diagnostic === undefined ? {} : { diagnostic }) })}\n`
        : `archer: ${safe(error.message)}${diagnostic === undefined ? "" : ` (${safe(diagnostic)})`}\n`,
    );
    return 1;
  } finally {
    app.close();
    await reporting;
  }
}

/** What the person at the terminal needs once Archer is open to their network: four lines, not the agent's text. */
export function networkSummary(result: Record<string, unknown>): string {
  const lines = [
    `Archer is open to your network: ${String(result["url"])}`,
    `Pairing code: ${String(result["code"])} (single use, ${String(result["minutes"])} minutes)`,
    result["certificateReused"] === true
      ? "Devices that trusted Archer's certificate before still do (same certificate)."
      : `On each device, trust this certificate once: ${String(result["caCert"])} (SHA-256 ${String(result["caFingerprint256"])}); steps for iPhone, Android and others: ${TRUST_STEPS.docs}`,
    "Turn off with: archer network-access off",
  ];
  return lines.join("\n");
}

/** A refusal of `--source`: what is wrong with the file, and what to do. */
class SourceFileError extends Error {}

/**
 * The Mermaid in `file` for an operation's `source` argument (`--source`), so a multi-line source is never
 * wrapped in JSON: a regular UTF-8 file within the source limit, else a refusal saying which and what to do.
 */
export function readSourceFile(file: string, io: Io): string {
  const path = resolve(io.cwd ?? process.cwd(), file);
  const refuse = (problem: string): never => {
    throw new SourceFileError(`--source ${file}: ${problem}`);
  };
  let stat;
  try {
    stat = statSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return refuse(
      code === "ENOENT"
        ? "no such file. Write the Mermaid to that file first, then pass its path."
        : `cannot be read (${code ?? String(error)}).`,
    );
  }
  if (!stat.isFile()) refuse("not a file. Pass the path of the .mmd file that holds the Mermaid source.");
  if (stat.size > MAX_SOURCE_BYTES) refuse(sourceTooLargeMessage(stat.size, MAX_SOURCE_BYTES));
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    return refuse(`cannot be read (${(error as NodeJS.ErrnoException).code ?? String(error)}).`);
  }
  // Read once, so a file that grew since the check is still held to the limit.
  if (bytes.length > MAX_SOURCE_BYTES) refuse(sourceTooLargeMessage(bytes.length, MAX_SOURCE_BYTES));
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return refuse("not UTF-8. Save the Mermaid source as UTF-8 text.");
  }
}

export async function runCall(args: readonly string[], io: OperationIo): Promise<number> {
  const { values, positionals } = usage(() =>
    parseArgs({
      args: [...args],
      strict: true,
      allowPositionals: true,
      options: {
        output: { type: "string" },
        file: { type: "string" },
        stdin: { type: "boolean" },
        json: { type: "boolean" },
        format: { type: "string" },
        source: { type: "string" },
      },
    }),
  );
  const inline = [...positionals.slice(1), ...(values.file === undefined ? [] : [values.file])].some(looksLikeJson);
  if (inline)
    throw new UsageError(
      'inline JSON is not accepted: send the arguments on standard input, e.g.  echo \'{"query":"orders"}\' | archer call <tool> --stdin  (or put them in a file and pass --file <path>)',
    );
  if (positionals.length !== 1 || (values.file !== undefined && values.stdin === true))
    throw new UsageError("call needs <operation> and at most one of --file <json> or --stdin");
  const name = positionals[0]!;
  if (values.output !== undefined && (name !== "export_diagram" || values.output.length === 0))
    throw new UsageError("--output <path> is supported only for export_diagram");
  if (values.source !== undefined && values.source.length === 0)
    throw new UsageError("--source needs the path of a .mmd file");
  const payload =
    values.file !== undefined
      ? readPayload(values.file, io)
      : values.stdin === true
        ? parsePayload(await readStdin(io))
        : {};
  if (values.format !== undefined && values.format !== "text" && values.format !== "json")
    throw new UsageError("--format must be text or json");
  if (values.json === true && values.format === "text") throw new UsageError("--json conflicts with --format text");
  const json =
    values.json === true ||
    values.format === "json" ||
    (values.format === undefined && payload["outputFormat"] === "json");
  if (values.source !== undefined) {
    try {
      const operation = OPERATIONS.find((item) => item.name === name);
      const takes =
        (operation?.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties?.["source"] !==
        undefined;
      if (operation !== undefined && !takes)
        throw new SourceFileError(
          `${name} takes no source; --source is for operations with a source argument (write_diagram, validate_diagram).`,
        );
      if (payload["source"] !== undefined)
        throw new SourceFileError(
          `--source and a "source" argument were both given; send the source once: the file, and the other arguments as JSON.`,
        );
      payload["source"] = readSourceFile(values.source, io);
    } catch (error) {
      if (!(error instanceof SourceFileError)) throw error;
      io.stderr(
        json
          ? `${JSON.stringify({ code: "invalid_arguments", message: error.message, details: { tool: name, argument: "--source" } })}\n`
          : `archer: ${safe(error.message)}\n`,
      );
      return 1;
    }
  }
  return executeOperation(name, payload, io, json, values.output);
}

export async function runTools(args: readonly string[], io: Io): Promise<number> {
  const { values, positionals } = usage(() =>
    parseArgs({ args: [...args], strict: true, allowPositionals: true, options: { json: { type: "boolean" } } }),
  );
  if (positionals.length > 1) throw new UsageError("tools takes an optional operation name and --json");
  const name = positionals[0];
  if (name !== undefined) {
    const operation = OPERATIONS.find((item) => item.name === name);
    if (operation === undefined) throw new UsageError(`unknown operation ${name}; use archer tools to discover names`);
    const detail = { name: operation.name, description: operation.description, inputSchema: operation.inputSchema };
    io.stdout(
      values.json === true
        ? `${JSON.stringify(detail)}\n`
        : `${operation.name}\n${safe(operation.description)}\n\nArguments (JSON Schema):\n${JSON.stringify(operation.inputSchema, null, 2)}\n\nRun: archer call ${operation.name} --file <arguments.json> --json\n${(operation.inputSchema as { properties?: Record<string, unknown> }).properties?.["source"] === undefined ? "" : `Its source from a file, not in the JSON: archer call ${operation.name} --source <file.mmd> --file <arguments.json> --json\n`}`,
    );
  } else {
    const catalog = OPERATIONS.map(({ name, description }) => ({ name, description }));
    io.stdout(
      values.json === true
        ? `${JSON.stringify(catalog)}\n`
        : `${catalog.map((item) => `${item.name}  ${safe(item.description)}`).join("\n")}\n\nUse archer tools <operation> for its input schema.\n`,
    );
  }
  return 0;
}

/** A value that is JSON text where a path or nothing was expected. */
function looksLikeJson(value: string): boolean {
  return /^\s*[{[]/.test(value);
}
