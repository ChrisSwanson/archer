// `archer skill`, `archer doctor` and `archer present` (ADR 0035 §3, §5).
import { existsSync, linkSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { main, type Io } from "../../src/bin/main.ts";
import { runDoctor } from "../../src/bin/doctor.ts";
import { checkPage } from "../../src/bin/present.ts";
import { version } from "../../src/version.ts";
import { connectService } from "../../src/service/service-client.ts";
import { closeFakes, fakeService } from "./fake-agent-service.ts";
import { cleanUp, project, service, tempDir, write } from "../service/support.ts";

afterEach(async () => {
  await closeFakes();
  await cleanUp();
});

const SKILL_DIR = new URL("../../plugin/skills/archer/", import.meta.url);
const skillText = (path: string): string => readFileSync(new URL(path, SKILL_DIR), "utf8");

function io(cwd: string, env: Record<string, string | undefined> = {}) {
  let out = "",
    err = "";
  const value: Io = {
    cwd,
    env,
    isTTY: false,
    columns: undefined,
    stdout: (t) => {
      out += t;
    },
    stderr: (t) => {
      err += t;
    },
  };
  return { io: value, out: () => out, err: () => err };
}

test("archer skill prints the shipped SKILL.md; --references adds every reference", async () => {
  const plain = io(tempDir());
  expect(await main(["skill"], plain.io)).toBe(0);
  expect(plain.out()).toBe(skillText("SKILL.md"));
  const full = io(tempDir());
  expect(await main(["skill", "--references"], full.io)).toBe(0);
  for (const name of readdirSync(new URL("references/", SKILL_DIR))) {
    expect(full.out()).toContain(`\n--- references/${name} ---\n\n${skillText(`references/${name}`)}`);
  }
});

test("archer skill --write writes the folder, refreshes an Archer skill, and leaves anything else alone", async () => {
  const home = tempDir();
  const target = join(home, "skills", "archer");
  const first = io(home);
  expect(await main(["skill", "--write", target], first.io), first.err()).toBe(0);
  expect(readFileSync(join(target, "SKILL.md"), "utf8")).toBe(skillText("SKILL.md"));
  expect(readFileSync(join(target, "references", "cli.md"), "utf8")).toBe(skillText("references/cli.md"));
  writeFileSync(join(target, "references", "retired.md"), "old");
  expect(await main(["skill", "--write", target], io(home).io)).toBe(0);
  expect(existsSync(join(target, "references", "retired.md"))).toBe(false);
  const other = join(home, "other");
  write(other, "SKILL.md", "---\nname: something-else\n---\n");
  const refused = io(home);
  expect(await main(["skill", "--write", other], refused.io)).toBe(1);
  expect(refused.err()).toMatch(/another skill/);
  expect(readFileSync(join(other, "SKILL.md"), "utf8")).toMatch(/something-else/);
  symlinkSync(target, join(home, "linked"));
  expect(await main(["skill", "--write", join(home, "linked")], io(home).io)).toBe(1);
});

/** A home with an Archer skill folder: this CLI's references, and `text` as SKILL.md (null: no skill). */
function skillHome(
  text: string | null,
  host: "claude" | "codex" = "claude",
  references: Record<string, string | null> = {},
): string {
  const home = tempDir();
  if (text === null) return home;
  write(home, `.${host}/skills/archer/SKILL.md`, text);
  for (const name of readdirSync(new URL("references/", SKILL_DIR)).filter((entry) => entry.endsWith(".md"))) {
    const changed = references[name];
    if (changed !== null)
      write(home, `.${host}/skills/archer/references/${name}`, changed ?? skillText(`references/${name}`));
  }
  return home;
}

test("doctor passes when the service and page answer and the host's skill is this CLI's", async () => {
  const fake = await fakeService();
  const home = skillHome(skillText("SKILL.md"));
  const run = io(home, { HOME: home });
  const code = await runDoctor([], run.io, {
    connect: () => connectService(fake.socketPath),
    checkPage: async () => ({ ok: true }),
    detect: () => ({ host: "claude-code" }),
  });
  expect(code, run.out()).toBe(0);
  expect(run.out()).toContain(`✓ CLI: archer ${version()} runs`);
  expect(run.out()).toContain("✓ Service: reachable, and its page loads");
  expect(run.out()).toContain("✓ Skill: Claude Code's copy is this CLI's");
  expect(run.out()).toContain("✓ Config: archer.toml (this project's, and the account's) has no problems");
  expect(run.out()).not.toContain("Tell the person");
  expect(run.out()).toMatch(/Archer is ready\.\n$/);
});

test.each([
  [
    "no service",
    {
      connect: async () => {
        throw new Error("cannot reach the Archer service: ENOENT");
      },
    },
    /Service: not reachable/,
  ],
  [
    "a loose state directory",
    {
      connect: async () => {
        throw new Error("the state directory /s is readable by others; run: chmod 700 /s");
      },
    },
    /readable by others; run: chmod 700 \/s\n {2}Tell the person: .*open to other accounts.*run the chmod line above/,
  ],
  [
    "a page that does not load",
    { checkPage: async () => ({ ok: false as const, reason: "the page answered HTTP 502" }) },
    /page answered HTTP 502/,
  ],
  ["another version's skill", { skill: "---\nname: archer\n---\nolder\n" }, /Claude Code's copy .* is not this CLI's/],
  ["no skill", { skill: null }, /no Archer skill installed for Claude Code/],
] as const)("doctor names %s, with what to tell the person", async (_name, change, line) => {
  const fake = await fakeService();
  const home = skillHome("skill" in change ? change.skill : skillText("SKILL.md"));
  const run = io(home, { HOME: home });
  const code = await runDoctor([], run.io, {
    connect: "connect" in change ? change.connect : () => connectService(fake.socketPath),
    checkPage: "checkPage" in change ? change.checkPage : async () => ({ ok: true }),
    detect: () => ({ host: "claude-code" }),
  });
  expect(code).toBe(1);
  expect(run.out()).toMatch(line);
  // Every failure is followed by the line the agent repeats.
  const lines = run.out().split("\n");
  for (const [index, text] of lines.entries())
    if (text.startsWith("✗")) expect(lines[index + 1]).toMatch(/^ {2}Tell the person: /);
});

// C-30: `edit = false` written after [[views]] is that view's key in TOML; doctor names the line.
test("doctor names a misplaced edit in this project's archer.toml, and an account archer.toml it cannot use", async () => {
  const fake = await fakeService();
  const home = skillHome(skillText("SKILL.md"));
  const root = tempDir();
  write(
    root,
    "archer.toml",
    'version = 1\n\n[[views]]\nid = "flow"\nkind = "freeform"\ntitle = "Flow"\nsource = ".archer/flow.mmd"\nedit = false\n',
  );
  write(root, ".archer/flow.mmd", "flowchart LR\n  a --> b\n");
  write(home, ".config/archer/archer.toml", "version = 1\n[service]\nport = 4000\nedit = false\n");
  const run = { ...io(root, { HOME: home }) };
  const code = await runDoctor([], run.io, {
    connect: () => connectService(fake.socketPath),
    checkPage: async () => ({ ok: true }),
    detect: () => ({ host: "claude-code" }),
  });
  expect(code).toBe(1);
  const out = run.out();
  expect(out).toMatch(
    /✗ Config: .*archer\.toml view 1 \(flow\): line 8: `edit` is under the \[\[views\]\] header on line 3.*creating and editing in the page are off/u,
  );
  expect(out).toMatch(/✗ Config: .*line 4: `edit` is under the \[service\] header on line 2/u);
  expect(out).not.toContain("Archer is ready");
  const lines = out.split("\n");
  for (const [index, text] of lines.entries())
    if (text.startsWith("✗")) expect(lines[index + 1]).toMatch(/^ {2}Tell the person: /);
});

// X-18: doctor names a hard-linked account archer.toml.
test("doctor names an account archer.toml with more than one name", async () => {
  const fake = await fakeService();
  const home = skillHome(skillText("SKILL.md"));
  const root = tempDir();
  write(home, "elsewhere.toml", "version = 1\n");
  mkdirSync(join(home, ".config", "archer"), { recursive: true });
  linkSync(join(home, "elsewhere.toml"), join(home, ".config", "archer", "archer.toml"));
  const run = { ...io(root, { HOME: home }) };
  const code = await runDoctor([], run.io, {
    connect: () => connectService(fake.socketPath),
    checkPage: async () => ({ ok: true }),
    detect: () => ({ host: "claude-code" }),
  });
  expect(code).toBe(1);
  expect(run.out()).toMatch(
    /✗ Config: .*\.config\/archer\/archer\.toml has 2 names \(a hard link\).*\n {2}Tell the person: your account's archer\.toml cannot be used/u,
  );
});

// C-33/X-19: a delivery key written after a table header other than [agents]; doctor names the line.
test("doctor names a misplaced delivery key in this project's archer.toml, and in the account's", async () => {
  const fake = await fakeService();
  const home = skillHome(skillText("SKILL.md"));
  const root = tempDir();
  write(
    root,
    "archer.toml",
    'version = 1\n\n[[views]]\nid = "flow"\nkind = "freeform"\ntitle = "Flow"\nsource = ".archer/flow.mmd"\nlaunch = "off"\n',
  );
  write(root, ".archer/flow.mmd", "flowchart LR\n  a --> b\n");
  write(home, ".config/archer/archer.toml", 'version = 1\n[service]\nport = 4000\nlaunch_for = "owner"\n');
  const run = { ...io(root, { HOME: home }) };
  const code = await runDoctor([], run.io, {
    connect: () => connectService(fake.socketPath),
    checkPage: async () => ({ ok: true }),
    detect: () => ({ host: "claude-code" }),
  });
  expect(code).toBe(1);
  const out = run.out();
  expect(out).toMatch(
    /✗ Config: .*archer\.toml view 1 \(flow\): line 8: `launch` is under the \[\[views\]\] header on line 3.*move it under \[agents\].*automatic launch is off for this project/u,
  );
  expect(out).toMatch(
    /✗ Config: .*line 4: `launch_for` is under the \[service\] header on line 2.*move it under \[agents\]/u,
  );
});

// O43: an upgrade can change a reference and leave SKILL.md as it was (0.7.1's C4 section changed only
// references/authoring.md), so a copied folder must match file by file, not by SKILL.md alone.
test.each([
  ["a stale reference", { "authoring.md": "# Authoring\nolder\n" }, /references\/authoring\.md differs/],
  ["a missing reference", { "authoring.md": null }, /references\/authoring\.md is missing/],
] as const)("doctor names %s in a skill whose SKILL.md matches", async (_name, references, line) => {
  const fake = await fakeService();
  const home = skillHome(skillText("SKILL.md"), "claude", references);
  const run = io(home, { HOME: home });
  const code = await runDoctor([], run.io, {
    connect: () => connectService(fake.socketPath),
    checkPage: async () => ({ ok: true }),
    detect: () => ({ host: "claude-code" }),
  });
  expect(code).toBe(1);
  expect(run.out()).toMatch(/Claude Code's copy .* is not this CLI's/);
  expect(run.out()).toMatch(line);
});

test("present gives the link after the real page loaded", async () => {
  const root = project();
  const { svc } = await service();
  const run = io(root, { ARCHER_SOCKET: svc.socketPath, ARCHER_AUTO_START: "false", ARCHER_OPEN_BROWSER: "never" });
  expect(await main(["present", "flow"], run.io), run.err()).toBe(0);
  const url = /^(https?:\/\/\S+)$/m.exec(run.out())?.[1];
  expect(url).toBeDefined();
  expect(await checkPage(url!)).toEqual({ ok: true });
});

test("present adds the diagram's label warnings and advice after the link; --json carries them as lint", async () => {
  const root = project();
  // Written with file tools: an arrow label that needs a third line at the 24-character wrap, and a path as technology.
  write(
    root,
    ".archer/diagrams/shop.mmd",
    'C4Container\n    title Shop\n    System_Boundary(shop, "Shop") {\n        Container(api, "Shop API", "services/api/server.js", "Orders")\n        ContainerDb(db, "Shop Database", "PostgreSQL", "Orders")\n    }\n    Rel(api, db, "Reports every payment outcome and refund back to the shop")\n',
  );
  const { svc } = await service();
  const env = { ARCHER_SOCKET: svc.socketPath, ARCHER_AUTO_START: "false", ARCHER_OPEN_BROWSER: "never" };
  const run = io(root, env);
  expect(await main(["present", "shop"], run.io), run.err()).toBe(0);
  expect(run.out()).toMatch(/^Diagnostics:\n\[edge_label_too_long\] line 7:\d+: /m);
  expect(run.out()).toMatch(/^Advice \(fix each, or say in one line why not\):\n- .*\[technology_is_path\]$/m);
  // The link comes first, unchanged.
  expect(run.out().indexOf("Give the person this link")).toBeLessThan(run.out().indexOf("Diagnostics:"));
  const json = io(root, env);
  expect(await main(["present", "shop", "--json"], json.io), json.err()).toBe(0);
  const lint = JSON.parse(json.out()).lint;
  expect(lint.diagnostics.map((d: { code: string }) => d.code)).toContain("edge_label_too_long");
  expect(lint.advice.map((a: { code: string }) => a.code)).toContain("technology_is_path");
  // A clean diagram adds nothing.
  const clean = io(root, env);
  expect(await main(["present", "flow", "--json"], clean.io), clean.err()).toBe(0);
  expect(JSON.parse(clean.out())).not.toHaveProperty("lint");
});

test("present --json includes a completed layout suggestion in lint", async () => {
  const { createApplication } = await import("../../src/application/index.ts");
  const root = project();
  write(
    root,
    ".archer/heartbeat.mmd",
    readFileSync(new URL("../fixtures/layout/heartbeat-lr.mmd", import.meta.url), "utf8"),
  );
  // Hold the production pool open with a completed review, as a persistent session does.
  const author = createApplication({ cwd: root, waitForLayoutReview: true });
  try {
    const reviewed = await author.currentLint("heartbeat", { suggest: false });
    expect(reviewed?.layoutReview).toMatchObject({
      status: "ready",
      suggestions: [{ code: "layout_wide_at_reading_zoom" }],
    });
    const { svc } = await service();
    const run = io(root, { ARCHER_SOCKET: svc.socketPath, ARCHER_AUTO_START: "false", ARCHER_OPEN_BROWSER: "never" });
    expect(await main(["present", "heartbeat", "--json"], run.io), run.err()).toBe(0);
    expect(JSON.parse(run.out()).lint.layoutReview).toMatchObject({
      status: "ready",
      suggestions: [{ code: "layout_wide_at_reading_zoom" }],
    });
  } finally {
    author.close();
  }
});

test.each([
  ["a diagram file", "flow", ".archer/flow.mmd"],
  ["a diagram in a note", "notes/login.md#steps", ".archer/notes/login.md#steps"],
])("present with %s and an unreachable page names its path instead of a link", async (_name, viewId, path) => {
  const root = project();
  write(
    root,
    ".archer/notes/login.md",
    "---\nauthor: agent\n---\n# Login\n\n```mermaid\n%% archer-id: steps\nflowchart LR\n  a[A] e1@--> b[B]\n```\n",
  );
  // A service that answers on its socket, but whose page address answers nothing.
  const fake = await fakeService({
    attach: () => ({ root, name: "demo", url: "http://127.0.0.1:9/projects/demo/?follow" }),
    present: () => ({ url: "http://127.0.0.1:9/projects/demo/?view=x", presentationId: "p1" }),
  });
  const run = io(root, { ARCHER_SOCKET: fake.socketPath, ARCHER_AUTO_START: "false" });
  expect(await main(["present", viewId], run.io)).toBe(1);
  expect(run.out()).toBe("");
  expect(run.err()).toMatch(/^archer present: the service answered, but the page did not load/);
  expect(run.err()).toContain(`Do not give the person a link. Name the file instead: ${path}\n`);
  const json = io(root, { ARCHER_SOCKET: fake.socketPath, ARCHER_AUTO_START: "false" });
  expect(await main(["present", viewId, "--json"], json.io)).toBe(1);
  expect(JSON.parse(json.err())).toMatchObject({ code: "page_unreachable", details: { path } });
});

test("present with no service it may start names the path too; an unknown diagram is its own refusal", async () => {
  const root = project();
  mkdirSync(join(root, "state"), { mode: 0o700 });
  const env = {
    ARCHER_SOCKET: join(root, "state", "absent.sock"),
    ARCHER_STATE_DIR: join(root, "state"),
    ARCHER_AUTO_START: "false",
  };
  const run = io(root, env);
  expect(await main(["present", "flow"], run.io)).toBe(1);
  expect(run.err()).toContain("Name the file instead: .archer/flow.mmd");
  const unknown = io(root, env);
  expect(await main(["present", "nope"], unknown.io)).toBe(1);
  expect(unknown.err()).toMatch(/no diagram view is named 'nope'/);
  expect(unknown.err()).not.toContain("Name the file instead");
});

// Decision 14 (REVIEW-0.7.0): the check fetches the page itself and needs a 2xx; a 404, a redirect
// or an error page at the link is not "loaded", even when the origin answers.
test("checkPage needs a 2xx from the link itself, on loopback and on this computer's own address", async () => {
  const { createServer } = await import("node:http");
  const { networkInterfaces } = await import("node:os");
  const seen: string[] = [];
  const server = createServer((req, res) => {
    seen.push(req.url ?? "");
    res.statusCode =
      req.url === "/" ? 200 : req.url?.startsWith("/ok") ? 200 : req.url?.startsWith("/moved") ? 302 : 404;
    if (req.url === "/moved") res.setHeader("location", "/missing");
    if (req.url === "/away") {
      res.statusCode = 302;
      res.setHeader("location", "http://example.invalid/ok");
    }
    if (req.url === "/exchange?t=1") {
      res.statusCode = 303;
      res.setHeader("location", "/ok/page");
      res.setHeader("set-cookie", "s=abc; HttpOnly");
    }
    if (req.url === "/ok/page" && req.headers.cookie !== "s=abc") res.statusCode = 401;
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "0.0.0.0", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    expect(await checkPage(`http://127.0.0.1:${port}/ok?t=1`)).toEqual({ ok: true });
    expect(await checkPage(`http://127.0.0.1:${port}/missing?t=1`)).toEqual({
      ok: false,
      reason: "the page answered HTTP 404",
    });
    expect(await checkPage(`http://127.0.0.1:${port}/moved`)).toEqual({
      ok: false,
      reason: "the page answered HTTP 404",
    });
    expect(await checkPage(`http://127.0.0.1:${port}/away`)).toEqual({
      ok: false,
      reason: "the page answered HTTP 302 to another address",
    });
    // The token exchange: a 303 with a cookie, then the page itself.
    expect(await checkPage(`http://127.0.0.1:${port}/exchange?t=1`)).toEqual({ ok: true });
    const own = Object.values(networkInterfaces())
      .flat()
      .find((entry) => entry !== undefined && !entry.internal && entry.family === "IPv4");
    if (own !== undefined) {
      seen.length = 0;
      // A network address of this computer: the exact link is fetched, so a missing page fails.
      expect(await checkPage(`http://${own.address}:${port}/missing?t=secret`)).toEqual({
        ok: false,
        reason: "the page answered HTTP 404",
      });
      expect(seen).toEqual(["/missing?t=secret"]);
      expect(await checkPage(`http://${own.address}:${port}/ok?t=secret`)).toEqual({ ok: true });
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
