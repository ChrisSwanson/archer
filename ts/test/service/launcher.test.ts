// The launcher fallback (ADR 0035 §8, ADR 0028): set only in the person's global archer.toml, run from its
// argv without a shell, the message passed only in LAUNCHER_ENV, in the project root or a launcher_cwd
// that resolves inside it, and only when the person presses Launch.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { LAUNCHER_ENV } from "../../src/agents/contract.ts";
import { ListenerRefusal } from "../../src/agents/listeners.ts";
import { parseGlobalConfig, type GlobalConfig } from "../../src/config/index.ts";
import { findProject } from "../../src/project/index.ts";
import {
  launchEnvironment,
  launchInput,
  launchPlan,
  MAX_MESSAGE_ENV_BYTES,
  startLauncher,
} from "../../src/service/launcher.ts";
import { usePathAnchorsForTests } from "../../src/project/confined-fs.ts";
import { Delivery } from "../../src/service/listeners.ts";
import { connectService } from "../../src/service/service-client.ts";
import type { Thread } from "../../src/comments/contract.ts";
import {
  apiBase,
  cleanUp,
  events,
  exactly,
  http,
  ownerCookie,
  project,
  service,
  slugOf,
  tempDir,
  write,
  pageHttp,
} from "./support.ts";

afterEach(async () => {
  delete process.env["CLAUDECODE"];
  delete process.env["ARCHER_TEST_SECRET"];
  await cleanUp();
});

const LAUNCHER_ALLOWED =
  /^(PATH|HOME|USER|LOGNAME|LANG|LC_[A-Z_]+|TERM|TMPDIR|SHELL|XDG_CONFIG_HOME|XDG_STATE_HOME|ARCHER_CONFIG|ARCHER_STATE_DIR|ARCHER_SOCKET|CLAUDE_CONFIG_DIR|CODEX_HOME|ANTHROPIC_API_KEY|OPENAI_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_BASE_URL|CLAUDE_CODE_USE_BEDROCK|CLAUDE_CODE_USE_VERTEX|AWS_[A-Z0-9_]+|GOOGLE_APPLICATION_CREDENTIALS|CLOUDSDK_[A-Z0-9_]+|ANTHROPIC_VERTEX_PROJECT_ID|CLOUD_ML_REGION|VERTEX_REGION_[A-Z0-9_]+|OPENAI_BASE_URL)$/;

// Variables the recording runtime sets in its own environment even when started with none: macOS's
// CoreFoundation adds __CF_USER_TEXT_ENCODING to every Node process; Linux adds nothing. The service passes none of them.
const RUNTIME_OWN = JSON.parse(
  spawnSync(process.execPath, ["-e", "process.stdout.write(JSON.stringify(Object.keys(process.env)))"], {
    env: {},
    encoding: "utf8",
  }).stdout,
) as string[];

const refused = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    if (error instanceof ListenerRefusal) return error.code;
    throw error;
  }
  throw new Error("expected a refusal");
};

describe("the person's configuration", () => {
  test("[agents] launcher is an argv list; launcher_cwd belongs to a [[projects]] rule", () => {
    const config = parseGlobalConfig(
      'version = 1\n[agents]\nlauncher = ["claude", "-p"]\n[[projects]]\npath = "/code/app"\nlauncher_cwd = "web"\n',
    );
    expect(config.agents).toEqual({ launcher: ["claude", "-p"] });
    expect(config.projects?.[0]?.launcherCwd).toBe("web");
    for (const bad of ['launcher = "claude -p"', "launcher = []", 'launcher = [""]', "launcher = [1]", 'command = "x"'])
      expect(() => parseGlobalConfig(`version = 1\n[agents]\n${bad}\n`), bad).toThrow(/agents|launcher/);
    expect(() => parseGlobalConfig('version = 1\n[[projects]]\npath = "/code/app"\nlauncher_cwd = ""\n')).toThrow(
      /launcher_cwd/,
    );
  });

  test("a project's own archer.toml cannot set it", () => {
    const root = tempDir();
    write(root, "archer.toml", 'version = 1\n[agents]\nlauncher = ["sh", "-c", "touch owned"]\n');
    // Since 2026-10-31 a project may have an [agents] table, but only to narrow delivery: never a launcher.
    expect(() => findProject(root)).toThrow(
      /\[agents\] `launcher` can be set only in your own ~\/\.config\/archer\/archer\.toml/,
    );
    const top = tempDir();
    write(top, "archer.toml", 'version = 1\nlauncher = ["sh"]\n');
    expect(() => findProject(top)).toThrow(/archer\.toml cannot be used/);
  });

  test("no launcher: refused with the fix; the plan runs in the root or a launcher_cwd inside it", () => {
    const root = tempDir();
    mkdirSync(join(root, "web"));
    const outside = tempDir();
    symlinkSync(outside, join(root, "escape"));
    const user = (cwd?: string): GlobalConfig => ({
      version: 1,
      agents: { launcher: ["claude", "-p"] },
      ...(cwd === undefined ? {} : { projects: [{ path: root, launcherCwd: cwd }] }),
    });
    expect(refused(() => launchPlan({ version: 1 }, root))).toBe("launcher_not_configured");
    expect(launchPlan(user(), root)).toEqual({ argv: ["claude", "-p"], cwd: root, root });
    expect(launchPlan(user("web"), root).cwd).toBe(join(root, "web"));
    expect(launchPlan(user(join(root, "web")), root).cwd).toBe(join(root, "web"));
    expect(refused(() => launchPlan(user(".."), root))).toBe("launcher_cwd_outside_project");
    expect(refused(() => launchPlan(user(outside), root))).toBe("launcher_cwd_outside_project");
    expect(refused(() => launchPlan(user("escape"), root))).toBe("launcher_cwd_outside_project");
    expect(refused(() => launchPlan(user("missing"), root))).toBe("launcher_cwd_missing");
  });
});

describe("Launch", () => {
  test("runs the argv with the message only in the environment and on stdin: no shell, nothing interpolated", {
    timeout: 30_000,
  }, async () => {
    // The host session's variables the service inherited never reach the launched agent.
    process.env["CLAUDECODE"] = "1";
    process.env["ARCHER_TEST_SECRET"] = "s3cret";
    const { svc, state } = await service();
    const root = project();
    const out = join(tempDir(), "launched.json");
    const script = write(
      tempDir(),
      "record.mjs",
      `import { renameSync, writeFileSync } from "node:fs";\n` +
        `const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("ARCHER_") && ${JSON.stringify(Object.values(LAUNCHER_ENV))}.includes(k)));\n` +
        `let stdin = ""; process.stdin.setEncoding("utf8"); for await (const chunk of process.stdin) stdin += chunk;\n` +
        `writeFileSync(process.argv[2] + ".tmp", JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), env, keys: Object.keys(process.env).sort(), stdin })); renameSync(process.argv[2] + ".tmp", process.argv[2]);\n`,
    );
    mkdirSync(join(state, ".config", "archer"), { recursive: true });
    writeFileSync(
      join(state, ".config", "archer", "archer.toml"),
      `version = 1\n[service]\ncomment_submission = "queued"\n[agents]\nlaunch = "ask"\nlauncher = [${JSON.stringify(process.execPath)}, ${JSON.stringify(script)}, ${JSON.stringify(out)}]\n[[projects]]\npath = ${JSON.stringify(root)}\nlauncher_cwd = ".archer"\n`,
      { mode: 0o600 },
    );
    const client = await connectService(svc.socketPath);
    const { url } = await client.call("attach", { root });
    client.close();
    const page = apiBase(url),
      origin = new URL(url).origin;
    const post = (path: string, body: unknown) =>
      pageHttp(`${page}${path}`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const message = "Please $(touch pwned) and `touch pwned2`; rm -rf \"$HOME\" | echo '${PATH}'";
    const thread = JSON.parse(
      (await post("api/comments", { target: "view:flow", anchor: { kind: "view" }, body: message })).body,
    ) as Thread;
    // A draft is not a message yet: only a sent thread with comments no agent received can be launched for.
    expect(JSON.parse((await post("api/listeners/launch", { threadId: thread.id })).body)).toMatchObject({
      error: { code: "thread_not_waiting" },
    });
    expect((await post("api/comments/submit", { target: "view:flow", threadId: thread.id })).status).toBe(200);
    // An agent's service token is no credential here, and the browser's cookie without the page's Origin admits
    // no write: neither can press Launch.
    const cookie = (await ownerCookie(page))!;
    for (const headers of [{ cookie }, { authorization: `Bearer ${svc.token}` }])
      expect(
        (
          await exactly(`${page}api/listeners/launch`, {
            method: "POST",
            headers: { ...headers, "content-type": "application/json" },
            body: JSON.stringify({ threadId: thread.id }),
          })
        ).status,
      ).toBe(404);
    const launched = await post("api/listeners/launch", { threadId: thread.id });
    expect(launched.status, launched.body).toBe(200);
    expect(JSON.parse(launched.body)).toMatchObject({ launched: true, pid: expect.any(Number) });
    await expect.poll(() => existsSync(out), { timeout: 10_000 }).toBe(true);
    const seen = JSON.parse(readFileSync(out, "utf8")) as {
      argv: string[];
      cwd: string;
      env: Record<string, string>;
      keys: string[];
      stdin: string;
    };
    expect(seen.argv).toEqual([out]);
    // Decision 2 (L3): the message on stdin too, so `claude -p` works; the service's own environment stays out.
    // Round 2 (decision 22): a short frame first, then the person's words whole.
    expect(seen.stdin.endsWith(`\n\n${message}`)).toBe(true);
    expect(seen.stdin).toContain(thread.id);
    expect(
      seen.keys.filter(
        (key) =>
          !LAUNCHER_ALLOWED.test(key) &&
          !RUNTIME_OWN.includes(key) &&
          !Object.values(LAUNCHER_ENV).includes(key as never),
      ),
    ).toEqual([]);
    expect(seen.keys).not.toContain("CLAUDECODE");
    expect(seen.keys).toContain("PATH");
    expect(seen.cwd).toBe(join(root, ".archer"));
    expect(seen.env).toEqual({
      [LAUNCHER_ENV.message]: message,
      [LAUNCHER_ENV.threadId]: thread.id,
      [LAUNCHER_ENV.project]: root,
      [LAUNCHER_ENV.target]: "view:flow",
    });
    for (const dir of [root, join(root, ".archer"), state])
      expect(readdirSync(dir).filter((name) => name.startsWith("pwned"))).toEqual([]);
    // A second press moments later starts nothing more.
    expect((await post("api/listeners/launch", { threadId: thread.id })).status).toBe(429);
  });

  test("a launcher_cwd outside the project is refused, and nothing runs", async () => {
    const { svc, state } = await service();
    const root = project();
    const out = join(tempDir(), "never.json");
    mkdirSync(join(state, ".config", "archer"), { recursive: true });
    writeFileSync(
      join(state, ".config", "archer", "archer.toml"),
      `version = 1\n[agents]\nlauncher = [${JSON.stringify(process.execPath)}, "-e", ${JSON.stringify(`require("fs").writeFileSync(${JSON.stringify(out)}, "ran")`)}]\n[[projects]]\npath = ${JSON.stringify(root)}\nlauncher_cwd = "/"\n`,
      { mode: 0o600 },
    );
    const client = await connectService(svc.socketPath);
    const { url } = await client.call("attach", { root });
    client.close();
    const page = apiBase(url),
      origin = new URL(url).origin;
    const post = (path: string, body: unknown) =>
      pageHttp(`${page}${path}`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const thread = JSON.parse(
      (await post("api/comments", { target: "view:flow", anchor: { kind: "view" }, body: "Go" })).body,
    ) as Thread;
    expect((await post("api/comments/submit", { target: "view:flow", threadId: thread.id })).status).toBe(200);
    const launched = await post("api/listeners/launch", { threadId: thread.id });
    expect(launched.status).toBe(409);
    expect(JSON.parse(launched.body)).toMatchObject({ error: { code: "launcher_cwd_outside_project" } });
    // Paths never reach the page (decision 13).
    expect(launched.body).not.toContain(root);
    expect(existsSync(out)).toBe(false);
  });
});

describe("automatic launch (ADR 0035, amended 2026-10-31)", () => {
  test("launch = auto: an access link's and a paired device's messages start nothing; the owner's starts the launcher once, message on stdin", {
    timeout: 30_000,
  }, async () => {
    const { svc, state } = await service();
    const root = project();
    const records = tempDir();
    const script = write(
      tempDir(),
      "record.mjs",
      `import { renameSync, writeFileSync } from "node:fs";\n` +
        `let stdin = ""; process.stdin.setEncoding("utf8"); for await (const chunk of process.stdin) stdin += chunk;\n` +
        `const tmp = process.argv[2] + "." + process.pid + ".tmp"; writeFileSync(tmp, JSON.stringify({ argv: process.argv.slice(2), stdin, thread: process.env.ARCHER_THREAD_ID })); renameSync(tmp, process.argv[2] + "/" + process.pid + ".json");\n`,
    );
    mkdirSync(join(state, ".config", "archer"), { recursive: true });
    writeFileSync(
      join(state, ".config", "archer", "archer.toml"),
      `version = 1\n[agents]\nlauncher = [${JSON.stringify(process.execPath)}, ${JSON.stringify(script)}, ${JSON.stringify(records)}]\nlaunch = "auto"\n`,
      { mode: 0o600 },
    );
    const client = await connectService(svc.socketPath);
    const { url } = await client.call("attach", { root });
    const origin = new URL(url).origin,
      slug = slugOf(url);
    const grant = await client.call("issueAccess", { label: "Phone" });
    const linkCookie = (
      (await pageHttp(`${origin}/projects/${slug}/?token=${grant.token}`)).headers["set-cookie"] as string[]
    )[0]!.split(";")[0]!;
    const pairing = await client.call("issuePairingCode", {});
    const paired = await pageHttp(`${origin}/-/pair`, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ code: pairing.code }),
    });
    expect(paired.status).toBe(303);
    const pairedCookie = (paired.headers["set-cookie"] as string[])[0]!.split(";")[0]!;
    const ownCookie = (
      (await pageHttp(`${origin}/projects/${slug}/?token=${svc.token}`)).headers["set-cookie"] as string[]
    )[0]!.split(";")[0]!;
    client.close();
    const say = async (cookie: string, body: string): Promise<Thread> => {
      const sent = await pageHttp(`${origin}/p/${slug}/api/comments`, {
        method: "POST",
        headers: { origin, cookie, "content-type": "application/json" },
        body: JSON.stringify({ target: "view:flow", anchor: { kind: "view" }, body }),
      });
      expect(sent.status, sent.body).toBe(200);
      return JSON.parse(sent.body) as Thread;
    };
    // Sent at once (comment_submission is "immediate" by default), each with its sender's sign-in.
    expect((await say(linkCookie, "From the link")).status).toBe("sent");
    await say(pairedCookie, "From the paired phone");
    const own = await say(ownCookie, "From the owner $(touch pwned)");
    await expect.poll(() => readdirSync(records).length, { timeout: 10_000 }).toBe(1);
    const [seen] = readdirSync(records).map(
      (name) =>
        JSON.parse(readFileSync(join(records, name), "utf8")) as { argv: string[]; stdin: string; thread: string },
    );
    expect(seen!.argv).toEqual([records]);
    expect(seen!.thread).toBe(own.id);
    expect(seen!.stdin.endsWith("\n\nFrom the owner $(touch pwned)")).toBe(true);
    expect(readdirSync(root).filter((name) => name.startsWith("pwned"))).toEqual([]);
    // The owner sees the step (D10), with no path or config in it; a link holder sees neither it nor the launcher.
    const read = async (cookie: string) =>
      JSON.parse((await pageHttp(`${origin}/p/${slug}/api/listeners`, { headers: { cookie } })).body) as {
        pending?: unknown[];
        launcher?: boolean;
      };
    const owned = await read(ownCookie);
    expect(owned.pending).toEqual([{ threadId: own.id, step: "launching", until: expect.any(String) }]);
    expect(JSON.stringify(owned)).not.toContain(root);
    expect(await read(linkCookie)).not.toHaveProperty("pending");
    expect(await read(linkCookie)).not.toHaveProperty("launcher");
  });

  test("the delivery step is the owner's alone (D10): link holders and paired devices see no pending step, in the listing or the event", {
    timeout: 30_000,
  }, async () => {
    const { svc, state } = await service();
    const root = project();
    mkdirSync(join(state, ".config", "archer"), { recursive: true });
    // A launcher (so launch defaults to auto) and a long wait: the step stays "next-turn" for the whole test; nothing runs.
    writeFileSync(
      join(state, ".config", "archer", "archer.toml"),
      `version = 1\n[agents]\nlauncher = [${JSON.stringify(process.execPath)}, "-e", "0"]\nnext_turn_wait = "30m"\n`,
      { mode: 0o600 },
    );
    const client = await connectService(svc.socketPath);
    const { url } = await client.call("attach", { root });
    const origin = new URL(url).origin,
      slug = slugOf(url);
    const grant = await client.call("issueAccess", { label: "Phone" });
    const linkCookie = (
      (await pageHttp(`${origin}/projects/${slug}/?token=${grant.token}`)).headers["set-cookie"] as string[]
    )[0]!.split(";")[0]!;
    const pairing = await client.call("issuePairingCode", {});
    const pairedCookie = (
      (
        await pageHttp(`${origin}/-/pair`, {
          method: "POST",
          headers: { origin, "content-type": "application/json" },
          body: JSON.stringify({ code: pairing.code }),
        })
      ).headers["set-cookie"] as string[]
    )[0]!.split(";")[0]!;
    const ownCookie = (
      (await pageHttp(`${origin}/projects/${slug}/?token=${svc.token}`)).headers["set-cookie"] as string[]
    )[0]!.split(";")[0]!;
    const cookies = { owner: ownCookie, link: linkCookie, paired: pairedCookie };
    const streams = Object.fromEntries(
      await Promise.all(
        Object.entries(cookies).map(
          async ([who, cookie]) => [who, await events(`${origin}/p/${slug}/api/events`, { cookie })] as const,
        ),
      ),
    );
    try {
      await client.call("registerAgent", {
        root,
        cwd: root,
        host: "claude-code",
        label: "Claude Code · between turns",
      });
      const sent = await pageHttp(`${origin}/p/${slug}/api/comments`, {
        method: "POST",
        headers: { origin, cookie: ownCookie, "content-type": "application/json" },
        body: JSON.stringify({ target: "view:flow", anchor: { kind: "view" }, body: "Owner, waiting" }),
      });
      const thread = JSON.parse(sent.body) as Thread;
      const step = {
        threadId: thread.id,
        step: "next-turn",
        host: "claude-code",
        waitMs: 1_800_000,
        until: expect.any(String),
      };
      /** Every `listeners` event a stream received until `ms` passed without one. */
      const drain = async (stream: Awaited<ReturnType<typeof events>>, ms: number): Promise<unknown[]> => {
        const seen: unknown[] = [];
        for (;;) {
          try {
            seen.push(await stream.next("listeners", ms));
          } catch {
            return seen;
          }
        }
      };
      // The owner's stream carries the step...
      let found: unknown;
      for (let i = 0; i < 10 && found === undefined; i++)
        found = ((await streams.owner!.next("listeners", 5_000)) as { pending?: unknown[] }).pending;
      expect(found).toEqual([step]);
      // ...the other two streams carry listener events, never a step.
      for (const who of ["link", "paired"] as const) {
        const seen = await drain(streams[who]!, 700);
        expect(seen.length, who).toBeGreaterThan(0);
        for (const payload of seen) expect(payload, who).not.toHaveProperty("pending");
      }
      const read = async (cookie: string) =>
        JSON.parse((await pageHttp(`${origin}/p/${slug}/api/listeners`, { headers: { cookie } })).body) as Record<
          string,
          unknown
        >;
      expect((await read(ownCookie))["pending"]).toEqual([step]);
      for (const cookie of [linkCookie, pairedCookie]) expect(await read(cookie)).not.toHaveProperty("pending");
    } finally {
      for (const stream of Object.values(streams)) stream.close();
      client.close();
    }
  });
});

describe("what counts as a message arriving (X-17)", () => {
  test("only a new submission or a change reaches the delivery order: a zero-change resubmit or edit calls nothing", {
    timeout: 30_000,
  }, async () => {
    const arrived = vi.spyOn(Delivery.prototype, "arrived");
    try {
      const { svc } = await service();
      const root = project();
      const client = await connectService(svc.socketPath);
      const { url } = await client.call("attach", { root });
      client.close();
      const page = apiBase(url),
        origin = new URL(url).origin;
      const send = (method: string, path: string, body: unknown) =>
        pageHttp(`${page}${path}`, {
          method,
          headers: { origin, "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      const thread = JSON.parse(
        (await send("POST", "api/comments", { target: "view:flow", anchor: { kind: "view" }, body: "Once" })).body,
      ) as Thread;
      expect(thread.status).toBe("sent");
      expect(arrived).toHaveBeenCalledTimes(1);
      const resubmit = await send("POST", "api/comments/submit", { threadId: thread.id });
      expect(JSON.parse(resubmit.body)).toMatchObject({ submitted: 0 });
      const same = await send("PATCH", `api/comments/${thread.id}/${thread.comments[0]!.id}`, { body: "Once" });
      expect(same.status, same.body).toBe(200);
      expect(arrived).toHaveBeenCalledTimes(1);
      const changed = await send("PATCH", `api/comments/${thread.id}/${thread.comments[0]!.id}`, {
        body: "Once, changed",
      });
      expect(changed.status, changed.body).toBe(200);
      expect(arrived).toHaveBeenCalledTimes(2);
    } finally {
      arrived.mockRestore();
    }
  });
});

describe("automatic launch, queued sending", () => {
  test("Send all (a submit naming no thread) launches for what it sent, never for a message that was already waiting", {
    timeout: 30_000,
  }, async () => {
    const { svc, state } = await service();
    const root = project();
    const records = tempDir();
    const script = write(
      tempDir(),
      "record.mjs",
      `import { renameSync, writeFileSync } from "node:fs";\nlet stdin = ""; process.stdin.setEncoding("utf8"); for await (const chunk of process.stdin) stdin += chunk;\n` +
        `const tmp = process.argv[2] + "." + process.pid + ".tmp"; writeFileSync(tmp, JSON.stringify({ stdin, thread: process.env.ARCHER_THREAD_ID })); renameSync(tmp, process.argv[2] + "/" + process.pid + ".json");\n`,
    );
    mkdirSync(join(state, ".config", "archer"), { recursive: true });
    writeFileSync(
      join(state, ".config", "archer", "archer.toml"),
      `version = 1\n[service]\ncomment_submission = "queued"\n[agents]\nlauncher = [${JSON.stringify(process.execPath)}, ${JSON.stringify(script)}, ${JSON.stringify(records)}]\nlaunch = "auto"\n`,
      { mode: 0o600 },
    );
    const client = await connectService(svc.socketPath);
    const { url } = await client.call("attach", { root });
    const grant = await client.call("issueAccess", { label: "Phone" });
    client.close();
    const origin = new URL(url).origin,
      slug = slugOf(url);
    const linkCookie = (
      (await pageHttp(`${origin}/projects/${slug}/?token=${grant.token}`)).headers["set-cookie"] as string[]
    )[0]!.split(";")[0]!;
    const page = apiBase(url);
    const post = (path: string, body: unknown, cookie?: string) =>
      pageHttp(cookie === undefined ? `${page}${path}` : `${origin}/p/${slug}/${path}`, {
        method: "POST",
        headers: { origin, "content-type": "application/json", ...(cookie === undefined ? {} : { cookie }) },
        body: JSON.stringify(body),
      });
    // A link holder's message, sent and waiting before the owner's Send all.
    const early = JSON.parse(
      (
        await post(
          "api/comments",
          { target: "view:flow", anchor: { kind: "view" }, body: "Waiting from the link" },
          linkCookie,
        )
      ).body,
    ) as Thread;
    expect((await post("api/comments/submit", { threadId: early.id }, linkCookie)).status).toBe(200);
    const draft = JSON.parse(
      (await post("api/comments", { target: "view:flow", anchor: { kind: "view" }, body: "Owner's draft" })).body,
    ) as Thread;
    expect(draft.status).toBe("draft");
    expect(JSON.parse((await post("api/comments/submit", {})).body)).toMatchObject({ submitted: 1 });
    await expect.poll(() => readdirSync(records).length, { timeout: 10_000 }).toBe(1);
    const [seen] = readdirSync(records).map(
      (name) => JSON.parse(readFileSync(join(records, name), "utf8")) as { stdin: string; thread: string },
    );
    expect(seen).toMatchObject({ thread: draft.id });
    expect(seen!.stdin.endsWith("\n\nOwner's draft")).toBe(true);
  });
});

// X-01 (re-score 2): the folder checked at plan time is the folder the launcher starts in. Between the
// plan and the spawn the folder is swapped for a link to an outside folder; the launcher is refused, not
// started there. A recording launcher reports where it ran.
describe("the launcher starts in the folder that was checked", () => {
  const recording = (): { script: string; out: string; cwd(): string | undefined } => {
    const dir = tempDir();
    const out = join(dir, "cwd.txt");
    const script = write(
      dir,
      "cwd.mjs",
      `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(out)}, process.cwd());\n`,
    );
    return { script, out, cwd: () => (existsSync(out) ? readFileSync(out, "utf8") : undefined) };
  };
  const config = (root: string, script: string, cwd?: string): GlobalConfig => ({
    version: 1,
    agents: { launcher: [process.execPath, script] },
    ...(cwd === undefined ? {} : { projects: [{ path: root, launcherCwd: cwd }] }),
  });
  const refusal = async (run: Promise<unknown>): Promise<string> => {
    try {
      await run;
    } catch (error) {
      if (error instanceof ListenerRefusal) return error.code;
      throw error;
    }
    throw new Error("expected a refusal");
  };

  test("unchanged: it runs in launcher_cwd", async () => {
    const root = tempDir();
    mkdirSync(join(root, "web"));
    const rec = recording();
    await startLauncher(launchPlan(config(root, rec.script, "web"), root), { PATH: process.env["PATH"] ?? "" });
    await expect.poll(rec.cwd, { timeout: 10_000 }).toBe(join(root, "web"));
  });

  test("launcher_cwd swapped for a link to an outside folder after the plan: refused, nothing runs", async () => {
    const root = tempDir();
    mkdirSync(join(root, "web"));
    const outside = tempDir();
    const rec = recording();
    const plan = launchPlan(config(root, rec.script, "web"), root);
    renameSync(join(root, "web"), join(root, "held"));
    symlinkSync(outside, join(root, "web"));
    expect(await refusal(startLauncher(plan, { PATH: process.env["PATH"] ?? "" }))).toBe("launcher_cwd_missing");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(rec.cwd()).toBeUndefined();
  });

  test("without a descriptor filesystem the folder is checked again by path just before the spawn", async () => {
    usePathAnchorsForTests(true);
    try {
      const root = tempDir();
      mkdirSync(join(root, "web"));
      const outside = tempDir();
      const rec = recording();
      const plan = launchPlan(config(root, rec.script, "web"), root);
      renameSync(join(root, "web"), join(root, "held"));
      symlinkSync(outside, join(root, "web"));
      expect(await refusal(startLauncher(plan, { PATH: process.env["PATH"] ?? "" }))).toBe("launcher_cwd_missing");
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(rec.cwd()).toBeUndefined();
    } finally {
      usePathAnchorsForTests(false);
    }
  });

  test("the project's folder itself swapped for a link after the plan: refused, nothing runs", async () => {
    const parent = tempDir();
    const root = join(parent, "app");
    mkdirSync(root);
    const outside = tempDir();
    const rec = recording();
    const plan = launchPlan(config(root, rec.script), root);
    renameSync(root, join(parent, "held"));
    symlinkSync(outside, root);
    expect(await refusal(startLauncher(plan, { PATH: process.env["PATH"] ?? "" }))).toBe("launcher_cwd_missing");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(rec.cwd()).toBeUndefined();
  });
});

describe("what the launched agent receives (round 2, decision 22)", () => {
  test("33 comments of 4,000 characters start the launcher: ARCHER_MESSAGE is capped, stdin has all of it (Codex N8)", async () => {
    const root = tempDir();
    const text = Array.from({ length: 33 }, (_, i) => `${i}`.padEnd(4_000, "x")).join("\n\n");
    const message = { threadId: "t-1", target: "view:flow", text };
    const env = launchEnvironment({ PATH: process.env["PATH"] ?? "/usr/bin:/bin" }, root, message);
    const value = env[LAUNCHER_ENV.message]!;
    expect(Buffer.byteLength(value)).toBeLessThanOrEqual(MAX_MESSAGE_ENV_BYTES);
    expect(MAX_MESSAGE_ENV_BYTES).toBe(32 * 1024);
    expect(value.endsWith("(truncated; full text on stdin)")).toBe(true);
    const out = join(tempDir(), "stdin.txt");
    const script = write(
      tempDir(),
      "cat.mjs",
      `import { writeFileSync } from "node:fs";\nlet t = ""; process.stdin.setEncoding("utf8"); for await (const c of process.stdin) t += c;\nwriteFileSync(process.argv[2], t);\n`,
    );
    const started = await startLauncher(
      { argv: [process.execPath, script, out], cwd: root, root },
      env,
      launchInput(root, message),
    );
    expect(started.pid).toEqual(expect.any(Number));
    await expect
      .poll(() => existsSync(out) && readFileSync(out, "utf8").length > text.length, { timeout: 10_000 })
      .toBe(true);
    expect(readFileSync(out, "utf8").endsWith(text)).toBe(true);
  });

  test("a short message is passed whole; multibyte text is cut on a character boundary", () => {
    const short = launchEnvironment({}, "/p", { threadId: "t", target: "project:", text: "hello" });
    expect(short[LAUNCHER_ENV.message]).toBe("hello");
    const wide = launchEnvironment({}, "/p", { threadId: "t", target: "project:", text: "é".repeat(40_000) })[
      LAUNCHER_ENV.message
    ]!;
    expect(Buffer.byteLength(wide)).toBeLessThanOrEqual(MAX_MESSAGE_ENV_BYTES);
    expect(wide).not.toContain("\uFFFD");
  });

  test("stdin: a short frame with the project folder's name only, the thread and how to reply, then the person's words", () => {
    const input = launchInput("/home/someone/code/secret-app", {
      threadId: "t-42",
      target: "view:flow",
      text: "Please draw it",
    });
    const [frame, words] = input.split("\n\n", 2) as [string, string];
    expect(words).toBe("Please draw it");
    expect(frame).toContain("secret-app");
    expect(frame).not.toContain("/home/someone");
    expect(frame).toContain("t-42");
    expect(frame).toContain("archer call reply_comment");
    expect(frame.split("\n").filter((line) => line.includes("reply_comment"))).toHaveLength(1);
  });

  test("the allow-list keeps the person's Archer, agent-host and provider settings", () => {
    const base = Object.fromEntries(
      [
        "XDG_CONFIG_HOME",
        "XDG_STATE_HOME",
        "ARCHER_CONFIG",
        "ARCHER_STATE_DIR",
        "ARCHER_SOCKET",
        "CLAUDE_CONFIG_DIR",
        "CODEX_HOME",
        "ANTHROPIC_API_KEY",
        "OPENAI_API_KEY",
        "CLAUDECODE",
        "ARCHER_AGENT_ID",
      ].map((key) => [key, "v"]),
    );
    const env = launchEnvironment(base, "/p", { threadId: "t", target: "project:", text: "x" });
    for (const key of [
      "XDG_CONFIG_HOME",
      "XDG_STATE_HOME",
      "ARCHER_CONFIG",
      "ARCHER_STATE_DIR",
      "ARCHER_SOCKET",
      "CLAUDE_CONFIG_DIR",
      "CODEX_HOME",
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
    ])
      expect(env[key], key).toBe("v");
    expect(env).not.toHaveProperty("CLAUDECODE");
    expect(env).not.toHaveProperty("ARCHER_AGENT_ID");
  });

  test("the allow-list keeps sign-in and cloud-provider settings: OAuth tokens, Bedrock, Vertex, base URLs (decision 30)", () => {
    const kept = [
      "CLAUDE_CODE_OAUTH_TOKEN",
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_BASE_URL",
      "CLAUDE_CODE_USE_BEDROCK",
      "CLAUDE_CODE_USE_VERTEX",
      "AWS_PROFILE",
      "AWS_REGION",
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_SESSION_TOKEN",
      "AWS_BEARER_TOKEN_BEDROCK",
      "GOOGLE_APPLICATION_CREDENTIALS",
      "CLOUDSDK_CONFIG",
      "CLOUDSDK_CORE_PROJECT",
      "OPENAI_BASE_URL",
      "ANTHROPIC_VERTEX_PROJECT_ID",
      "CLOUD_ML_REGION",
      "VERTEX_REGION_CLAUDE_3_5_SONNET",
      "VERTEX_REGION_CLAUDE_SONNET_4",
    ];
    const dropped = [
      "AWS",
      "AWS_",
      "XAWS_REGION",
      "CLOUDSDK",
      "GOOGLE_API_KEY",
      "ANTHROPIC_BASE_URLX",
      "SSH_AUTH_SOCK",
      "GITHUB_TOKEN",
      "VERTEX_REGION",
      "VERTEX_REGION_",
      "CLOUD_ML_REGIONS",
    ];
    const env = launchEnvironment(Object.fromEntries([...kept, ...dropped].map((key) => [key, "v"])), "/p", {
      threadId: "t",
      target: "project:",
      text: "x",
    });
    for (const key of kept) expect(env[key], key).toBe("v");
    for (const key of dropped) expect(env, key).not.toHaveProperty(key);
  });
});
