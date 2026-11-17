// The management plane's three doors, driven as an agent drives them (security rubric G3, R4; probe P10):
// `archer call` (the CLI, its own process), `archer mcp` (the stdio relay into the service) and the raw
// Unix socket (newline JSON, `hello` first). Each answers {admitted, code, result}; nothing here prints
// a result, since some carry secrets (links, pairing codes): callers redact before writing anything.
import { spawn } from "node:child_process";
import { connect } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const TSX = join(REPO, "node_modules/tsx/dist/loader.mjs");
const ARCHER = join(REPO, "ts/src/bin/archer.ts");

/** One `archer call <op> [flags] --stdin --json` in `cwd` with `env`. Exit 0 is admitted; else the stderr JSON's code. */
export function cliCall(op, args, { cwd, env, timeoutMs = 60_000, flags = [] }) {
  return new Promise((done) => {
    const child = spawn(process.execPath, ["--import", TSX, ARCHER, "call", op, ...flags, "--stdin", "--json"], {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "",
      err = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (d) => {
      out += d;
    });
    child.stderr.on("data", (d) => {
      err += d;
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      if (status === 0) {
        let result = null;
        try {
          result = JSON.parse(out);
        } catch {
          /* text */
        }
        return done({ admitted: true, code: null, result });
      }
      let code = "cli_exit_" + status,
        message = "";
      // `message` is for diagnosis by the caller only; nothing here writes it anywhere.
      try {
        const last = JSON.parse(err.trim().split("\n").pop());
        code = last.code ?? code;
        message = String(last.message ?? "").slice(0, 500);
      } catch {
        /* not JSON */
      }
      done({ admitted: false, code, result: null, message });
    });
    child.stdin.end(JSON.stringify(args));
  });
}

/**
 * One `archer mcp` session in `cwd`: `call(tool, args)` resolves {admitted, code, result}. By default the client
 * declares elicitation and declines every question the server asks, so no person's yes is ever faked.
 * `person`: "decline" (default); "none" (no elicitation capability: the server cannot ask); "yes" (the test plays
 * the person and accepts {open: true}; used only by network-access-netns.mjs, inside a private network namespace).
 */
export async function mcpSession({ cwd, env, person = "decline" }) {
  const child = spawn(process.execPath, ["--import", TSX, ARCHER, "mcp"], {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buffer = "",
    next = 0;
  const waiting = new Map();
  const asked = [];
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message.method !== undefined && message.id !== undefined) {
        asked.push(message.method);
        const result = person === "yes" ? { action: "accept", content: { open: true } } : { action: "decline" };
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`);
      } else if (message.id !== undefined && waiting.has(message.id)) {
        waiting.get(message.id)(message);
        waiting.delete(message.id);
      }
    }
  });
  child.stderr.resume();
  const rpc = (method, params, timeoutMs = 60_000) =>
    new Promise((done) => {
      const id = ++next;
      const timer = setTimeout(() => {
        waiting.delete(id);
        done({ error: { code: "timeout", message: "no answer" } });
      }, timeoutMs);
      waiting.set(id, (message) => {
        clearTimeout(timer);
        done(message);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  const init = await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: person === "none" ? {} : { elicitation: {} },
    clientInfo: { name: "archer-security-authority-matrix", version: "1" },
  });
  if (init.error) {
    child.kill();
    throw new Error(`MCP initialize failed: ${init.error.message}`);
  }
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  return {
    asked,
    async call(tool, args) {
      const answer = await rpc("tools/call", { name: tool, arguments: args });
      // `message` is for diagnosis by the caller only; nothing here writes it anywhere.
      if (answer.error)
        return {
          admitted: false,
          code: answer.error.data?.code ?? answer.error.data?.archer ?? String(answer.error.code),
          result: null,
          message: String(answer.error.message ?? "").slice(0, 500),
        };
      const result = answer.result ?? {};
      if (result.isError)
        return {
          admitted: false,
          code: result.structuredContent?.code ?? "tool_error",
          result: null,
          message: String(result.content?.[0]?.text ?? "").slice(0, 500),
        };
      return { admitted: true, code: null, result: result.structuredContent ?? null };
    },
    close() {
      child.stdin.end();
      setTimeout(() => child.kill(), 2000).unref();
    },
  };
}

/** One raw socket connection: `hello`, then `call(method, params)` resolves {admitted, code, result}. */
export async function socketSession(socketPath) {
  const socket = connect(socketPath);
  await new Promise((done, fail) => {
    socket.once("connect", done);
    socket.once("error", fail);
  });
  socket.setEncoding("utf8");
  let buffer = "",
    next = 0;
  const waiting = new Map();
  socket.on("data", (chunk) => {
    buffer += chunk;
    for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (waiting.has(message.id)) {
        waiting.get(message.id)(message);
        waiting.delete(message.id);
      }
    }
  });
  const raw = (method, params) =>
    new Promise((done) => {
      const id = ++next;
      waiting.set(id, done);
      socket.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  const hello = await raw("hello", { protocolVersion: 1 });
  if (hello.error) throw new Error(`socket hello refused: ${hello.error.code}`);
  return {
    async call(method, params) {
      const answer = await raw(method, params);
      return answer.error
        ? { admitted: false, code: answer.error.code ?? "error", result: null }
        : { admitted: true, code: null, result: answer.result ?? null };
    },
    close() {
      socket.end();
    },
  };
}
