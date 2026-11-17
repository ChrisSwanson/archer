// R6 / P11 (docs/quality/rubrics/security.md): Launch runs only the command the person recorded in their
// global archer.toml. A request with extra fields, path-like thread ids, `__proto__` or `constructor`
// keys, or query parameters has no effect beyond it: the recorded argv, in the recorded folder, or
// nothing at all, and no prototype is polluted.
//
// The detector is a recording launcher (argv, cwd, the ARCHER_* message variables) and a sentinel folder
// it must never be asked to touch. It is shown failing on a seeded run, through the production
// startLauncher, of a plan that carries extra request-supplied argv and another folder.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { Thread } from "../../src/comments/contract.ts";
import { connectService } from "../../src/service/service-client.ts";
import { startLauncher } from "../../src/service/launcher.ts";
import { apiBase, cleanUp, http, project, service, tempDir, write, pageHttp } from "../service/support.ts";

afterEach(cleanUp);

interface Seen {
  readonly argv: string[];
  readonly cwd: string;
  readonly env: Record<string, string>;
}

/** A launcher that records what it was started with, one JSON line per start. */
function recorder(): { script: string; out: string; runs(): Seen[] } {
  const dir = tempDir("archer-launch-rec-");
  const out = join(dir, "runs.jsonl");
  const script = write(
    dir,
    "record.mjs",
    `import { appendFileSync } from "node:fs";\n` +
      `const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => /^ARCHER_(MESSAGE|THREAD_ID|PROJECT|TARGET)$/.test(k)));\n` +
      `appendFileSync(${JSON.stringify(out)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), env }) + "\\n");\n`,
  );
  return {
    script,
    out,
    runs: () =>
      existsSync(out)
        ? readFileSync(out, "utf8")
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line) as Seen)
        : [],
  };
}

/** What a run may be: exactly the recorded argv in the recorded folder. Anything else is named. */
function beyondRecord(run: Seen, expected: { argv: readonly string[]; cwd: string }): string[] {
  const problems: string[] = [];
  if (JSON.stringify(run.argv) !== JSON.stringify(expected.argv))
    problems.push(`argv ${JSON.stringify(run.argv)} is not the recorded ${JSON.stringify(expected.argv)}`);
  if (run.cwd !== expected.cwd) problems.push(`cwd ${run.cwd} is not the recorded ${expected.cwd}`);
  return problems;
}

const PROTO_KEYS = ["argv", "cwd", "command", "launcher", "shell", "polluted"] as const;
const prototypeClean = (): string[] =>
  PROTO_KEYS.filter((key) => key in ({} as Record<string, unknown>) || key in Object.prototype);

describe("the detector", () => {
  test("seeded: a plan carrying request-supplied argv and folder, run by the production startLauncher, is reported", async () => {
    const rec = recorder();
    const root = project();
    const elsewhere = tempDir("archer-launch-elsewhere-");
    const recorded = { argv: ["recorded"], cwd: root };
    // What a handler that merged the body into the plan would run.
    await startLauncher(
      {
        argv: [process.execPath, rec.script, "recorded", "--from-request", "../../etc/passwd"],
        cwd: elsewhere,
        root: elsewhere,
      },
      { PATH: process.env["PATH"] ?? "" },
    );
    await expect.poll(() => rec.runs().length, { timeout: 10_000 }).toBe(1);
    expect(beyondRecord(rec.runs()[0]!, recorded)).toHaveLength(2);
    // And the clean run passes the same detector.
    await startLauncher(
      { argv: [process.execPath, rec.script, "recorded"], cwd: root, root },
      { PATH: process.env["PATH"] ?? "" },
    );
    await expect.poll(() => rec.runs().length, { timeout: 10_000 }).toBe(2);
    expect(beyondRecord(rec.runs()[1]!, recorded)).toEqual([]);
  });

  test("seeded: a polluted prototype is reported", () => {
    expect(prototypeClean()).toEqual([]);
    (Object.prototype as Record<string, unknown>)["polluted"] = true;
    try {
      expect(prototypeClean()).toEqual(["polluted"]);
    } finally {
      delete (Object.prototype as Record<string, unknown>)["polluted"];
    }
  });
});

describe("Launch (P11)", () => {
  test("extra fields, path-like ids, __proto__, constructor and query parameters start nothing beyond the recorded command", {
    timeout: 60_000,
  }, async () => {
    const rec = recorder();
    const { svc, state } = await service();
    const root = project();
    const sentinel = tempDir("archer-launch-sentinel-");
    mkdirSync(join(state, ".config", "archer"), { recursive: true });
    writeFileSync(
      join(state, ".config", "archer", "archer.toml"),
      `version = 1\n[service]\ncomment_submission = "queued"\n[agents]\nlaunch = "ask"\nlauncher = [${JSON.stringify(process.execPath)}, ${JSON.stringify(rec.script)}, "recorded"]\n`,
      { mode: 0o600 },
    );
    const client = await connectService(svc.socketPath);
    const { url } = (await client.call("attach", { root })) as { url: string };
    client.close();
    const page = apiBase(url),
      origin = new URL(url).origin;
    const raw = (path: string, body: string) =>
      pageHttp(`${page}${path}`, { method: "POST", headers: { origin, "content-type": "application/json" }, body });
    const post = (path: string, body: unknown) => raw(path, JSON.stringify(body));
    const thread = JSON.parse(
      (await post("api/comments", { target: "view:flow", anchor: { kind: "view" }, body: "go" })).body,
    ) as Thread;
    expect((await post("api/comments/submit", { target: "view:flow", threadId: thread.id })).status).toBe(200);

    const hostile: [string, string, string][] = [
      // [label, query, raw JSON body]
      ["extra argv", "", JSON.stringify({ threadId: thread.id, argv: ["sh", "-c", `touch ${sentinel}/argv`] })],
      ["extra command", "", JSON.stringify({ threadId: thread.id, command: "sh", launcher: ["sh"], shell: true })],
      ["extra cwd", "", JSON.stringify({ threadId: thread.id, cwd: sentinel, launcher_cwd: sentinel })],
      [
        "extra env",
        "",
        JSON.stringify({ threadId: thread.id, env: { PATH: sentinel, NODE_OPTIONS: `--require ${sentinel}/x.js` } }),
      ],
      [
        "__proto__ argv",
        "",
        `{"threadId":${JSON.stringify(thread.id)},"__proto__":{"argv":["sh"],"cwd":${JSON.stringify(sentinel)},"polluted":true}}`,
      ],
      [
        "constructor.prototype",
        "",
        `{"threadId":${JSON.stringify(thread.id)},"constructor":{"prototype":{"argv":["sh"],"polluted":true}}}`,
      ],
      ["__proto__ only", "", `{"__proto__":{"threadId":${JSON.stringify(thread.id)}}}`],
      ["path-like id ../", "", JSON.stringify({ threadId: "../../../etc/passwd" })],
      ["path-like id absolute", "", JSON.stringify({ threadId: "/etc/passwd" })],
      ["path-like id encoded", "", JSON.stringify({ threadId: "..%2f..%2fetc" })],
      ["path-like id backslash", "", JSON.stringify({ threadId: "..\\..\\x" })],
      ["path-like id NUL", "", JSON.stringify({ threadId: `${thread.id}\u0000/../x` })],
      ["path-like id dotted", "", JSON.stringify({ threadId: `${thread.id}/..` })],
      ["id as array", "", JSON.stringify({ threadId: [thread.id] })],
      ["id as object", "", JSON.stringify({ threadId: { toString: thread.id } })],
      ["body is array", "", JSON.stringify([thread.id])],
    ];
    for (const [label, query, body] of hostile) {
      const answer = await raw(`api/listeners/launch${query}`, body);
      expect(answer.status, `${label}: ${answer.body}`).toBeGreaterThanOrEqual(400);
      expect(answer.status, label).toBeLessThan(500);
      expect(prototypeClean(), label).toEqual([]);
    }
    expect(rec.runs()).toEqual([]);

    // Query parameters are not a channel: the one valid press runs the recorded command, in the root, only.
    const launched = await raw(
      `api/listeners/launch?argv=sh&cwd=${encodeURIComponent(sentinel)}&__proto__[argv]=sh`,
      JSON.stringify({ threadId: thread.id }),
    );
    expect(launched.status, launched.body).toBe(200);
    await expect.poll(() => rec.runs().length, { timeout: 10_000 }).toBe(1);
    expect(beyondRecord(rec.runs()[0]!, { argv: ["recorded"], cwd: root })).toEqual([]);
    expect(rec.runs()[0]!.env["ARCHER_THREAD_ID"]).toBe(thread.id);
    expect(readdirSync(sentinel)).toEqual([]);
    expect(prototypeClean()).toEqual([]);
    rmSync(sentinel, { recursive: true, force: true });
  });

  test("a comment thread's own fields (a path-like target, shell text in the body) reach only the message variables", {
    timeout: 60_000,
  }, async () => {
    const rec = recorder();
    const { svc, state } = await service();
    const root = project();
    mkdirSync(join(state, ".config", "archer"), { recursive: true });
    writeFileSync(
      join(state, ".config", "archer", "archer.toml"),
      `version = 1\n[service]\ncomment_submission = "queued"\n[agents]\nlaunch = "ask"\nlauncher = [${JSON.stringify(process.execPath)}, ${JSON.stringify(rec.script)}]\n`,
      { mode: 0o600 },
    );
    const client = await connectService(svc.socketPath);
    const { url } = (await client.call("attach", { root })) as { url: string };
    client.close();
    const page = apiBase(url),
      origin = new URL(url).origin;
    const post = (path: string, body: unknown) =>
      pageHttp(`${page}${path}`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    // A target is refused unless it names a view: a path-like one never becomes a thread.
    const bad = await post("api/comments", { target: "view:../../etc/passwd", anchor: { kind: "view" }, body: "x" });
    expect(bad.status, bad.body).toBeGreaterThanOrEqual(400);
    // Extra fields and a `__proto__` key in a comment body are refused, and pollute nothing.
    const extra = await post("api/comments", {
      target: "view:flow",
      anchor: { kind: "view" },
      body: "x",
      extra: "ignored",
    });
    expect(extra.status, extra.body).toBe(422);
    const proto = await pageHttp(`${page}api/comments`, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: `{"target":"view:flow","anchor":{"kind":"view"},"body":"x","__proto__":{"polluted":true}}`,
    });
    expect(proto.status, proto.body).toBeGreaterThanOrEqual(400);
    expect(prototypeClean()).toEqual([]);
    const created = await post("api/comments", {
      target: "view:flow",
      anchor: { kind: "view" },
      body: "--help $(id) `id` ; -c",
    });
    expect(created.status, created.body).toBe(200);
    const thread = JSON.parse(created.body) as Thread;
    expect((await post("api/comments/submit", { target: "view:flow", threadId: thread.id })).status).toBe(200);
    expect((await post("api/listeners/launch", { threadId: thread.id })).status).toBe(200);
    await expect.poll(() => rec.runs().length, { timeout: 10_000 }).toBe(1);
    const run = rec.runs()[0]!;
    expect(beyondRecord(run, { argv: [], cwd: root })).toEqual([]);
    expect(run.env["ARCHER_MESSAGE"]).toContain("$(id)");
  });
});
