// The agent's side of a journey (user-flows rubric §8, U9/J11/J12): `ui.agent(op, args)` runs this checkout's
// `archer call <op> --stdin --json` with the sandbox's environment (`sandboxEnv`: its own state dir, socket, home
// and config), in a project copy's root, the way an agent shell in that project would, and resolves to the parsed
// JSON result. A refusal rejects with an AgentRefusal carrying the CLI's stable `code`; `{ refusal: true }`
// resolves to the refusal instead ({ refused: true, code, message, details }) for journeys that expect one.
//
// Every call is logged in `run.agentCalls` ({ op, step, ok, code, ms }; never the arguments or the result, which can
// carry links), so flow-metrics.mjs counts agent operations without the journey counting them itself.
import { spawn } from "node:child_process";
import { join } from "node:path";
import { REPO, sandboxEnv } from "../sandbox.mjs";

const TSX = join(REPO, "node_modules/tsx/dist/loader.mjs");
/** The CLI the sandbox service runs (ts/src/bin/archer.ts through tsx); ARCHER_AGENT_CLI names another entry, e.g. a bundled ts/dist/archer.js. */
const CLI = process.env.ARCHER_AGENT_CLI ?? join(REPO, "ts/src/bin/archer.ts");

export class AgentRefusal extends Error {
  constructor(op, code, message, details) {
    super(`archer call ${op} refused: ${code}${message ? ` — ${message.split("\n")[0]}` : ""}`);
    Object.assign(this, { op, code, details });
  }
}

/** One `archer call` as its own process. Resolves {status, out, err}. */
function run(op, args, { cwd, env, timeoutMs }) {
  const argv = CLI.endsWith(".ts") ? ["--import", TSX, CLI] : [CLI];
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [...argv, "call", op, "--stdin", "--json"], {
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
    child.on("error", (e) => {
      clearTimeout(timer);
      fail(e);
    });
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      done({ status: signal ? `signal ${signal}` : status, out, err });
    });
    child.stdin.end(JSON.stringify(args ?? {}));
  });
}

/**
 * `agent(op, args, { project, refusal, timeoutMs })`. `project`: the slug whose copy is the working directory
 * (default pageturner, else the first). `run`: the summary to log into; `stepIndex()`: the current step count.
 */
export function createAgent({ sandbox, run: summary, stepIndex = () => summary?.steps?.length ?? 0 }) {
  // On first use, not here: a harness run on a page outside any sandbox (measurement.mjs --url) has no root, and
  // reading it here threw before the journey ran, with the browser left open (the run never ended).
  let env = null;
  const rootOf = (slug) => {
    const p = slug
      ? sandbox.projects.find((x) => x.slug === slug)
      : (sandbox.projects.find((x) => x.slug === "pageturner") ?? sandbox.projects[0]);
    if (!p) throw new Error(`no project ${slug} in sandbox ${sandbox.name}`);
    return p.root;
  };
  const agent = async (op, args = {}, { project, refusal = false, timeoutMs = 60_000 } = {}) => {
    const started = Date.now();
    const r = await run(op, args, { cwd: rootOf(project), env: (env ??= sandboxEnv(sandbox)), timeoutMs });
    const entry = { op, step: stepIndex(), ok: r.status === 0, ms: Date.now() - started };
    if (summary) (summary.agentCalls ??= []).push(entry);
    if (r.status === 0) {
      try {
        return JSON.parse(r.out);
      } catch {
        entry.ok = false;
        entry.code = "not_json";
        throw new Error(`archer call ${op} printed no JSON: ${r.out.slice(0, 200)}`);
      }
    }
    let body = null;
    try {
      body = JSON.parse(r.err.trim().split("\n").pop());
    } catch {
      /* not JSON */
    }
    entry.code = body?.code ?? `exit_${r.status}`;
    if (refusal)
      return {
        refused: true,
        code: entry.code,
        message: body?.message ?? r.err.slice(0, 500),
        details: body?.details ?? null,
      };
    throw new AgentRefusal(op, entry.code, body?.message ?? r.err.slice(0, 500), body?.details);
  };
  agent.calls = () => summary?.agentCalls ?? [];
  return agent;
}
