#!/usr/bin/env node
// G3, the setup_network_access cells that need a network (security rubric §1 matrix; R3/P8): the person's yes
// rebinds the service off loopback, so it runs only where that exposes nothing. `unshare -rnpfm` (no root: a user
// namespace) gives this script a private network namespace holding only `lo` and one dummy interface
// (DUMMY_ADDRESS, reachable from nowhere), and a private PID namespace, so every service it starts dies with it.
// Nothing binds a host interface; the host's live service and state are never named.
//
//   node --import tsx tools/devkit/security/network-access-netns.mjs        (authority-matrix.mjs --network-netns runs it)
//
// Cells, each snapshotting the account config (the root's top-level files: a backup lands beside it) and the state
// directory before and after, then observing the config's [service] host and TLS keys, the network-access record, how
// the running service says it started (restartConfiguration) and what accepts connections on each address:
//   refuse  cli             personConfirmed, no terminal              person_confirmation_needed, nothing changed
//   refuse  cli-terminal    `archer network-access`, the person: n    person_declined, nothing changed
//   refuse  mcp             the person declines the question         person_declined, nothing changed
//   refuse  mcp             a client that cannot ask, no yes         person_confirmation_needed, nothing changed
//   admit   cli-terminal    the person types y                       config host/tls written, record enabled, the service
//                                                                    restarted on DUMMY_ADDRESS over HTTPS (answers there with
//                                                                    the new CA), loopback refused
//   admit   cli             enabled: false                           config back to loopback, service on 127.0.0.1, dummy refused
//   admit   mcp-in-process  the person's yes (ARCHER_MCP_IN_PROCESS=1), then enabled: false
//   admit   mcp             the person's yes over the default relay door (served by the service the call restarts),
//                           then enabled: false there (one try each, every door: PD-2 and PD-3 are fixed)
// The terminal is script(1); the test types the person's answer. Prints one JSON line {cells, relayLater, reset} (no
// address token, pairing code or file content). Exit 0: ran (verdicts inside); 2: the namespace cannot be made here.
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { request as httpsRequest } from "node:https";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { changedPaths, FIXTURE_FILES, judge, snapshot } from "./authority-matrix-model.mjs";
import { cliCall, mcpSession, socketSession } from "./lib/agent-clients.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../..");
export const DUMMY_ADDRESS = "10.203.0.1";
const DUMMY = "eg3net0";
const shellQuote = (v) => `'${String(v).replace(/'/g, "'\\''")}'`;

/** Why a private network namespace cannot be made here, or undefined. */
export function netnsProblem() {
  const probe = spawnSync(
    "unshare",
    [
      "-rnpfm",
      "--mount-proc",
      "sh",
      "-c",
      `ip link add ${DUMMY} type dummy && ip addr add ${DUMMY_ADDRESS}/24 dev ${DUMMY}`,
    ],
    { encoding: "utf8", timeout: 20_000 },
  );
  if (probe.error !== undefined) return `unshare is not usable: ${probe.error.code ?? probe.error.message}`;
  if (probe.status !== 0)
    return `no unprivileged network namespace with a dummy interface: ${(probe.stderr || probe.stdout).trim().split("\n")[0]}`;
  return undefined;
}

/** Runs the cells in a fresh namespace; resolves {cells} or {unavailable}. */
export function runInNamespace({ timeoutMs = 300_000 } = {}) {
  const problem = netnsProblem();
  if (problem !== undefined) return { unavailable: problem };
  const run = spawnSync(
    "unshare",
    ["-rnpfm", "--mount-proc", process.execPath, "--import", "tsx", fileURLToPath(import.meta.url), "--inner"],
    { cwd: REPO, encoding: "utf8", timeout: timeoutMs, env: { ...process.env } },
  );
  const line = run.stdout
    .trim()
    .split("\n")
    .filter((l) => l.startsWith("{"))
    .pop();
  try {
    return JSON.parse(line);
  } catch {
    return {
      unavailable: `the namespace run gave no result (exit ${run.status}): ${(run.stderr || "").trim().split("\n").filter(Boolean).pop()?.slice(0, 200) ?? ""}`,
    };
  }
}

const ip = (...args) => {
  const r = spawnSync("ip", args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`ip ${args.join(" ")}: ${r.stderr.trim()}`);
};

/** Whether `host:port` accepts a TCP connection. */
const accepts = (host, port) =>
  new Promise((done) => {
    const socket = connect({ host, port });
    const end = (ok) => {
      socket.destroy();
      done(ok);
    };
    socket.once("connect", () => end(true));
    socket.once("error", () => end(false));
    socket.setTimeout(3000, () => end(false));
  });
/** The HTTPS status `https://host:port/` answers with, verified against `ca` (null when no TLS answer). */
const httpsStatus = (host, port, ca) =>
  new Promise((done) => {
    const req = httpsRequest(
      { host, port, path: "/", method: "GET", ca, servername: undefined, timeout: 5000 },
      (res) => {
        res.resume();
        done(res.statusCode ?? null);
      },
    );
    req.on("error", () => done(null));
    req.on("timeout", () => {
      req.destroy();
      done(null);
    });
    req.end();
  });

async function inner() {
  ip("link", "set", "lo", "up");
  ip("link", "add", DUMMY, "type", "dummy");
  ip("addr", "add", `${DUMMY_ADDRESS}/24`, "dev", DUMMY);
  ip("link", "set", DUMMY, "up");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "archer-eg3-net-")));
  const cells = [];
  try {
    const stateDir = join(root, "state"),
      home = join(root, "home"),
      project = join(root, "projects", "eg3");
    for (const d of [stateDir, home, join(home, ".config")]) mkdirSync(d, { recursive: true, mode: 0o700 });
    for (const [file, text] of Object.entries(FIXTURE_FILES)) {
      mkdirSync(dirname(join(project, file)), { recursive: true });
      writeFileSync(join(project, file), text);
    }
    const port = 40_000 + Math.floor(Math.random() * 9_000);
    const configPath = join(root, "archer.toml");
    writeFileSync(configPath, `version = 1\n\n[service]\nport = ${port}\n`, { mode: 0o600 });
    const env = {
      PATH: process.env.PATH,
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_STATE_HOME: join(home, ".local", "state"),
      ARCHER_CONFIG: configPath,
      ARCHER_STATE_DIR: stateDir,
      ARCHER_SOCKET: join(stateDir, "archer.sock"),
      ARCHER_OPEN_BROWSER: "never",
      ARCHER_RESTORE_STATE: "false",
      ARCHER_AUTO_START: "false",
    };
    // What a cell may change: the account config (every top-level file of the root: a backup lands beside it) and the state.
    const dirs = () => [
      ["config", root, readdirSync(root).filter((f) => statSync(join(root, f)).isFile())],
      ["state", stateDir],
    ];
    const snap = () => snapshot(dirs());
    const started = await cliCall("start_service", {}, { cwd: project, env });
    if (!started.admitted) throw new Error(`start_service refused (${started.code})`);
    const startedAs = async () => {
      try {
        const s = await socketSession(env.ARCHER_SOCKET);
        try {
          return (await s.call("restartConfiguration", {})).result;
        } finally {
          s.close();
        }
      } catch {
        return null;
      }
    };
    const recordNow = () => {
      try {
        const r = JSON.parse(readFileSync(join(stateDir, "network-access.json"), "utf8"));
        return { enabled: r.enabled === true, bind: r.bind ?? null };
      } catch {
        return null;
      }
    };
    /** What is true now: the config's [service] host, the record, how the running service says it started, what answers where. */
    const observe = async (caPath) => {
      const text = readFileSync(configPath, "utf8");
      const as = await startedAs();
      const ca = typeof caPath === "string" && existsSync(caPath) ? readFileSync(caPath) : null;
      return {
        configHost: /^host = "([^"]*)"$/m.exec(text)?.[1] ?? null,
        configTls: /^tls_cert = "/m.test(text) && /^tls_key = "/m.test(text),
        configForceHttpFalse: /^force_http = false$/m.test(text),
        configPortKept: new RegExp(`^port = ${port}$`, "m").test(text),
        record: recordNow(),
        runningHost: as?.host ?? null,
        runningScheme: as?.transport?.scheme ?? null,
        httpsOnDummyWithNewCa: ca === null ? null : (await httpsStatus(DUMMY_ADDRESS, port, ca)) !== null,
        acceptsDummy: await accepts(DUMMY_ADDRESS, port),
        acceptsLoopback: await accepts("127.0.0.1", port),
      };
    };
    // Doors. Each MCP door is opened before the cell's before-snapshot (its own registration is not the cell's effect).
    const mcpDoor = async (person, inProcess) =>
      mcpSession({ cwd: project, env: inProcess ? { ...env, ARCHER_MCP_IN_PROCESS: "1" } : env, person });
    /** `archer network-access` at a terminal (script(1) gives it one) where the test types the person's answer. */
    const atTerminal = (args, answer) =>
      new Promise((done) => {
        const archer = `${shellQuote(process.execPath)} --import ${shellQuote(join(REPO, "node_modules/tsx/dist/loader.mjs"))} ${shellQuote(join(REPO, "ts/src/bin/archer.ts"))} network-access ${args.map(shellQuote).join(" ")} --json`;
        const child = spawn("script", ["-qec", archer, "/dev/null"], {
          cwd: project,
          env: { ...env, NODE_OPTIONS: "" },
          stdio: ["pipe", "pipe", "pipe"],
        });
        let out = "";
        child.stdout.on("data", (d) => {
          out += d;
        });
        child.stderr.on("data", (d) => {
          out += d;
        });
        setTimeout(() => child.stdin.write(`${answer}\n`), 4000);
        const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
        child.on("close", (status) => {
          clearTimeout(timer);
          // The answer holds a pairing code: only what the cell needs is kept.
          const json = out
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter((l) => l.startsWith("{"))
            .pop();
          let result = null;
          try {
            result = JSON.parse(json);
          } catch {
            /* none */
          }
          if (process.env.AM_NET_DEBUG && status !== 0)
            process.stderr.write(
              `[netns] terminal exit ${status}: ${out.replace(/[A-Za-z0-9_-]{24,}/g, "<long>").slice(0, 1500)}\n`,
            );
          done(
            status === 0 && result !== null && result.code === undefined
              ? { admitted: true, code: null, result: { caCert: result.caCert ?? null, enabled: result.enabled } }
              : status === 0 && result?.enabled !== undefined
                ? { admitted: true, code: null, result: { caCert: result.caCert ?? null, enabled: result.enabled } }
                : {
                    admitted: false,
                    code: result?.code ?? `exit_${status}`,
                    result: null,
                    message: typeof result?.message === "string" ? result.message : "",
                  },
          );
        });
      });
    const cell = async (row, surface, expected, code, open, act, verify) => {
      const door = open ? await open() : null;
      await new Promise((r) => setTimeout(r, 300));
      const before = snap();
      let answer;
      try {
        answer = await act(door);
      } finally {
        door?.close();
      }
      // AM_NET_DEBUG: a refusal's message on stderr (long token-like runs masked), for diagnosis only.
      if (process.env.AM_NET_DEBUG && !answer.admitted)
        process.stderr.write(
          `[netns] ${row}: ${answer.code} ${(answer.message ?? "").replace(/[A-Za-z0-9_-]{24,}/g, "<long>")}\n`,
        );
      await new Promise((r) => setTimeout(r, 3000)); // the restart and any rollback land
      const changed = changedPaths(before, snap()).filter((p) => p !== "state:service.log");
      const seen = await observe(answer.result?.caCert);
      const positive = expected === "admit" && answer.admitted ? verify(seen) : false;
      const judged = judge(
        expected,
        { admitted: answer.admitted, changed, positive, negative: !positive, code: answer.code ?? undefined },
        ["config:"],
        { code },
      );
      // The refusal's stated cause, where it names one ("Cause: …"), with token-like runs masked: no secret is in it.
      const cause = /Cause: (.*)$/s
        .exec(answer.message ?? "")?.[1]
        ?.replace(/[A-Za-z0-9_-]{24,}/g, "<long>")
        .slice(0, 200);
      cells.push({
        surface,
        row,
        column: "same-account",
        phase: "netns",
        pathClass: "account-config",
        capability: "person",
        rules: [],
        expected,
        admitted: answer.admitted,
        code: answer.code ?? undefined,
        expectedCode: code,
        ...(cause ? { cause } : {}),
        changed: changed.map((p) =>
          p
            .replace(/tls-[0-9TZ]+-[0-9a-f]+/g, "tls-<stamp>")
            .replace(/before-network-[0-9TZ]+-[0-9a-f]+/g, "before-network-<stamp>"),
        ),
        observed: seen,
        positive,
        ...judged,
      });
      return { answer, seen, passed: judged.verdict === "pass" };
    };
    const onNetwork = (seen) =>
      seen.configHost === DUMMY_ADDRESS &&
      seen.configTls &&
      seen.configForceHttpFalse &&
      seen.configPortKept &&
      seen.record?.enabled === true &&
      seen.record.bind === DUMMY_ADDRESS &&
      seen.runningHost === DUMMY_ADDRESS &&
      seen.runningScheme === "https" &&
      seen.httpsOnDummyWithNewCa === true &&
      !seen.acceptsLoopback;
    const offNetwork = (seen) =>
      seen.configHost === "127.0.0.1" &&
      !seen.configTls &&
      (seen.record === null || seen.record.enabled === false) &&
      seen.runningHost === "127.0.0.1" &&
      seen.acceptsLoopback &&
      !seen.acceptsDummy;
    const confirmed = { personConfirmed: true, host: DUMMY_ADDRESS };
    const call = (op, args) => async (door) => door.call(op, args);
    // Refusals: the person's yes is missing, or a no.
    await cell("setup_network_access (no terminal)", "cli", "refuse", "person_confirmation_needed", null, () =>
      cliCall("setup_network_access", confirmed, { cwd: project, env }),
    );
    await cell(
      "network-access at a terminal (the person says no)",
      "cli-terminal",
      "refuse",
      "person_declined",
      null,
      () => atTerminal(["on", "--host", DUMMY_ADDRESS], "n"),
    );
    await cell(
      "setup_network_access (person declines)",
      "mcp",
      "refuse",
      "person_declined",
      () => mcpDoor("decline", false),
      call("setup_network_access", confirmed),
    );
    await cell(
      "setup_network_access (client cannot ask, no yes)",
      "mcp",
      "refuse",
      "person_confirmation_needed",
      () => mcpDoor("none", false),
      call("setup_network_access", { host: DUMMY_ADDRESS }),
    );
    // The person's yes, on each door that runs it, each followed by turning it off again on the same door. One try
    // each: a restart that loses its own service connection (PD-3) or a relay call that ends on the network with the
    // settings rolled back (PD-2) fails the run. The off runs whatever the yes did (it must always turn it off).
    const yesThenOff = async (surface, yes, off) => {
      const on = await cell(yes.row, surface, "admit", undefined, yes.open, yes.act, onNetwork);
      const later = yes.later
        ? (await new Promise((r) => setTimeout(r, yes.later)), await observe(on.answer.result?.caCert))
        : undefined;
      await cell(off.row, off.surface ?? surface, "admit", undefined, off.open, off.act, offNetwork);
      return later;
    };
    await yesThenOff(
      "cli-terminal",
      {
        row: "network-access at a terminal (the person's yes)",
        open: null,
        act: () => atTerminal(["on", "--host", DUMMY_ADDRESS], "y"),
      },
      {
        row: "setup_network_access (enabled: false)",
        surface: "cli",
        open: null,
        act: () => cliCall("setup_network_access", { enabled: false }, { cwd: project, env }),
      },
    );
    await yesThenOff(
      "mcp-in-process",
      {
        row: "setup_network_access (the person's yes; MCP in process)",
        open: () => mcpDoor("yes", true),
        act: call("setup_network_access", { host: DUMMY_ADDRESS }),
      },
      {
        row: "setup_network_access (enabled: false; MCP in process)",
        open: () => mcpDoor("decline", true),
        act: call("setup_network_access", { enabled: false }),
      },
    );
    // The default MCP door: the relay served by the service that the call itself restarts; relayLater is what holds
    // five seconds after its yes (PD-2 rolled the settings back meanwhile).
    const relayLater = await yesThenOff(
      "mcp",
      {
        row: "setup_network_access (the person's yes; MCP relay)",
        open: () => mcpDoor("yes", false),
        act: call("setup_network_access", { host: DUMMY_ADDRESS }),
        later: 5000,
      },
      {
        row: "setup_network_access (enabled: false; MCP relay)",
        open: () => mcpDoor("decline", false),
        act: call("setup_network_access", { enabled: false }),
      },
    );
    // Back to a known state for the run's end: stop whatever runs, start from the settings file.
    await cliCall("stop_service", {}, { cwd: project, env });
    await cliCall("start_service", {}, { cwd: project, env });
    const reset = await observe(null);
    await cliCall("stop_service", {}, { cwd: project, env });
    return { cells: [...cells], relayLater, reset, address: DUMMY_ADDRESS, interfaces: ["lo", DUMMY] };
  } finally {
    // The PID namespace ends every service started here when this process exits; the root is this run's own.
    rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { inner: { type: "boolean" }, json: { type: "boolean" } } });
  if (values.inner)
    inner().then(
      (r) => process.stdout.write(`${JSON.stringify(r)}\n`),
      (e) => {
        process.stdout.write(
          `${JSON.stringify({ unavailable: `failed inside the namespace: ${String(e?.message ?? e).slice(0, 300)}` })}\n`,
        );
        process.exitCode = 1;
      },
    );
  else {
    const r = runInNamespace();
    process.stdout.write(`${JSON.stringify(r)}\n`);
    if (r.unavailable) process.exitCode = 2;
  }
}
