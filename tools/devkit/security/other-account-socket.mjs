#!/usr/bin/env node
// R4 / P10, the another-account cell (docs/quality/rubrics/security.md): a process running as another
// OS account tries to connect to the management socket and is refused by the kernel, while a process
// of the owner's account connects through the same path. Without sudo or a second account: Docker
// runs the client with `--user <uid>:<gid>` on the host kernel, with the socket's directory
// bind-mounted, so the same permission check the host makes for a second account is made here.
//
//   node tools/devkit/security/other-account-socket.mjs [--image <img>] [--uid <n>] [--socket <path>] [--json]
//
// --socket probes an existing socket (a sandbox's, from `sandbox.mjs info`); the control then sends
// only `hello`. Without it the probe listens on a socket of its own in a fresh 0700 directory.
// --image must hold `node` and be present locally (it is never pulled); by default the first local
// image whose name says node or archer-ci. --uid is the other account (default: yours + 1000).
// Exit 0: the other uid was refused (EACCES) and the owner's connected. 1: anything else. 2: Docker
// cannot be used here (not installed, no permission, no image, or user-namespace remapping, which
// would make the "same uid" control a different host uid).
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { parseArgs } from "node:util";

/** The client run inside the container: connect, say hello, report what happened. No secret is sent. */
const CLIENT = `
const net = require("node:net");
const path = process.argv[1];
const report = (fields) => { process.stdout.write(JSON.stringify({ uid: process.getuid(), ...fields }) + "\\n"); process.exit(0); };
const socket = net.connect(path);
socket.once("error", (error) => report({ connected: false, code: error.code }));
socket.once("connect", () => {
  socket.write(JSON.stringify({ id: 1, method: "hello", params: { protocolVersion: 1 } }) + "\\n");
  let answer = "";
  socket.on("data", (chunk) => { answer += chunk; if (answer.includes("\\n")) { socket.destroy(); report({ connected: true, answered: true }); } });
  setTimeout(() => { socket.destroy(); report({ connected: true, answered: answer.length > 0 }); }, 3000);
});
`;

const docker = (args, timeout = 60_000) => spawnSync("docker", args, { encoding: "utf8", timeout });

/** Why Docker cannot run this probe, or undefined when it can. */
export function dockerProblem() {
  const info = docker(["info", "--format", "{{json .SecurityOptions}}"]);
  if (info.error !== undefined) return `docker is not usable: ${info.error.code ?? info.error.message}`;
  if (info.status !== 0) return `docker is not usable: ${(info.stderr || info.stdout).trim().split("\n")[0]}`;
  if (/userns|rootless/u.test(info.stdout))
    return "docker remaps user ids (userns or rootless): a container uid is not the same host uid";
  return undefined;
}

/** The first local image that has node, by name; undefined when none. */
export function localNodeImage() {
  const listed = docker(["images", "--format", "{{.Repository}}:{{.Tag}}"]);
  if (listed.status !== 0) return undefined;
  return listed.stdout
    .split("\n")
    .filter(Boolean)
    .filter((name) => !name.endsWith(":<none>"))
    .find((name) => /(^|\/)node:|archer-ci/u.test(name));
}

/**
 * One connection attempt as `uid:gid`, from a container that sees only the socket's directory. Async, so
 * the probe's own listener (same process) can answer meanwhile.
 */
function attempt(image, uid, gid, socketPath) {
  const mounted = `/archer-socket-dir/${basename(socketPath)}`;
  const child = spawn(
    "docker",
    [
      "run",
      "--rm",
      "--pull=never",
      "--network",
      "none",
      "--user",
      `${uid}:${gid}`,
      "-v",
      `${dirname(socketPath)}:/archer-socket-dir`,
      "--entrypoint",
      "node",
      image,
      "-e",
      CLIENT,
      mounted,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let out = "",
    err = "";
  child.stdout.on("data", (chunk) => {
    out += chunk;
  });
  child.stderr.on("data", (chunk) => {
    err += chunk;
  });
  const killer = setTimeout(() => child.kill(), 60_000);
  return new Promise((resolve) => {
    const finish = (spawnError) => {
      clearTimeout(killer);
      const line = out.trim().split("\n").at(-1) ?? "";
      try {
        resolve(JSON.parse(line));
      } catch {
        resolve({
          uid,
          connected: false,
          code: "probe_failed",
          detail: (err || spawnError?.message || "").trim().split("\n")[0],
        });
      }
    };
    child.once("error", finish);
    child.once("close", () => finish());
  });
}

/** Runs the probe. Returns { status, ...facts }; status 0 pass, 1 fail, 2 not runnable here. */
export async function probe({ image, uid, socket } = {}) {
  const problem = dockerProblem();
  if (problem !== undefined) return { status: 2, reason: problem };
  const chosen = image ?? localNodeImage();
  if (chosen === undefined) return { status: 2, reason: "no local image with node (pass --image)" };
  const own = process.getuid(),
    ownGid = process.getgid();
  const other = uid ?? own + 1000;
  if (other === own || other === 0) return { status: 1, reason: "--uid must be another, non-root account" };
  let dir,
    server,
    socketPath = socket;
  if (socketPath === undefined) {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "archer-r4-")));
    chmodSync(dir, 0o700);
    socketPath = join(dir, "probe.sock");
    server = createServer((connection) => connection.once("data", () => connection.end('{"id":1,"ok":true}\n')));
    await new Promise((resolve) => server.listen(socketPath, resolve));
  }
  try {
    const parent = statSync(dirname(socketPath));
    const facts = {
      image: chosen,
      socketDir: { mode: (parent.mode & 0o777).toString(8), uid: parent.uid },
      ownUid: own,
    };
    const otherResult = await attempt(chosen, other, other, socketPath);
    const ownResult = await attempt(chosen, own, ownGid, socketPath);
    const pass =
      otherResult.connected === false &&
      otherResult.code === "EACCES" &&
      ownResult.connected === true &&
      ownResult.answered === true;
    return { status: pass ? 0 : 1, ...facts, other: otherResult, owner: ownResult };
  } finally {
    if (server !== undefined) await new Promise((resolve) => server.close(resolve));
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({
    options: {
      image: { type: "string" },
      uid: { type: "string" },
      socket: { type: "string" },
      json: { type: "boolean" },
    },
  });
  const result = await probe({
    image: values.image,
    uid: values.uid === undefined ? undefined : Number(values.uid),
    socket: values.socket,
  });
  if (values.json) process.stdout.write(`${JSON.stringify(result)}\n`);
  else if (result.status === 2) process.stdout.write(`not run: ${result.reason}\n`);
  else {
    process.stdout.write(
      `socket directory: mode ${result.socketDir?.mode}, owner uid ${result.socketDir?.uid}; image ${result.image}\n`,
    );
    process.stdout.write(
      `other uid ${result.other?.uid}: ${result.other?.connected ? "CONNECTED" : `refused (${result.other?.code})`}\n`,
    );
    process.stdout.write(
      `owner uid ${result.owner?.uid}: ${result.owner?.connected ? `connected${result.owner.answered ? ", answered" : ", no answer"}` : `refused (${result.owner?.code})`}\n`,
    );
    process.stdout.write(
      result.status === 0
        ? "PASS: another account is refused by the kernel; the owner connects\n"
        : `FAIL${result.reason ? `: ${result.reason}` : ""}\n`,
    );
  }
  process.exitCode = result.status;
}
