// The small-agent eval baseline's bookkeeping (scripts/evals/v1/eval.mjs): which tasks a run
// selects, how cells are scored, and when a comparison calls a cell regressed.
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  cells,
  compare,
  contaminatedList,
  median,
  misses,
  publicCells,
  selectTasks,
  totals,
  // @ts-expect-error -- a plain .mjs script without types
} from "../../scripts/evals/v1/eval.mjs";
// @ts-expect-error -- a plain .mjs script without types
import { CANARY, contamination, parseTranscript } from "../../scripts/evals/v1/judge.mjs";
import {
  codexArgs,
  codexCredentials,
  codexResumeArgs,
  denyRules,
  prepareCodexHome,
  scrubCredentials,
  sessionOf,
  // @ts-expect-error -- a plain .mjs script without types
} from "../../scripts/evals/v1/run.mjs";
// @ts-expect-error -- a plain .mjs script without types
import { HOLDOUT, holdoutDigest, loadHoldout, TASKS } from "../../scripts/evals/v1/tasks.mjs";

// Never the owner's private hold-out: these tests run with none, and make a fake one where they need it.
vi.hoisted(() => {
  process.env.ARCHER_EVAL_HOLDOUT = "/nonexistent/archer-evals/holdout.mjs";
});

const run = (agent: string, task: string, verdict: string, toolCalls = 5, set = "main") => ({
  agent,
  task,
  set,
  verdict,
  toolCalls,
  archerCalls: 2,
  misses: verdict === "pass" ? [] : ["x"],
});

describe("eval baseline", () => {
  it("keeps no hold-out task in the repository, and skips the hold-out without its private file", () => {
    expect(HOLDOUT.status).toBe("absent");
    expect(TASKS.every((t: { set: string }) => t.set === "main")).toBe(true);
    expect(selectTasks("holdout")).toEqual([]);
    expect(selectTasks("all")).toHaveLength(TASKS.length);
    expect(selectTasks("emphasis,present")).toEqual(["emphasis", "present"]);
    expect(() => selectTasks("emphasis,nope")).toThrow(/nope/);
    expect(() => selectTasks("emphasis,h1", TASKS, { ids: ["h1"] })).toThrow(/private hold-out file/);
  });

  it("loads a hold-out file with the rubric helpers, and says when it differs from the manifest", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aev-holdout-"));
    const file = join(dir, "holdout.mjs");
    const text = `export default ({ must }) => [{ id: "h1", prompt: "p", judge: () => [must("m", true)] }];\n`;
    writeFileSync(file, text);
    const sha256 = holdoutDigest(file);
    const loaded = await loadHoldout(file, { ids: ["h1"], sha256 });
    expect(loaded).toMatchObject({ status: "loaded", ids: ["h1"], sha256, matches: true });
    expect(loaded.tasks[0].set).toBe("holdout");
    expect(loaded.tasks[0].judge()[0]).toMatchObject({ level: "must", pass: true });
    expect((await loadHoldout(file, { ids: ["h2"], sha256: loaded.sha256 })).matches).toBe(false);
    expect((await loadHoldout(file, { ids: ["h1"], sha256: "0".repeat(64) })).matches).toBe(false);
    expect(await loadHoldout(join(dir, "none.mjs"))).toMatchObject({ status: "absent", tasks: [] });
    // A variant of a main-set task, judged by that task's judge.
    const variant = join(dir, "variant.mjs");
    writeFileSync(
      variant,
      `export default ({ mainJudge }) => [{ id: "h3", prompt: "q", judge: mainJudge("present") }];\n`,
    );
    const judged = (await loadHoldout(variant, { ids: ["h3"], sha256: "" })).tasks[0];
    expect(judged.judge).toBe(TASKS.find((t: { id: string }) => t.id === "present").judge);
    writeFileSync(
      variant,
      `export default ({ mainJudge }) => [{ id: "h4", prompt: "q", judge: mainJudge("nope") }];\n`,
    );
    await expect(loadHoldout(variant, { ids: [], sha256: "" })).rejects.toThrow(/no main-set task nope/);
    writeFileSync(
      variant,
      `export default ({ mainJudge, mainSetup }) => [{ id: "h5", prompt: "q", setup: mainSetup("docs-upkeep-offer"), judge: mainJudge("docs-upkeep-offer") }];\n`,
    );
    expect((await loadHoldout(variant, { ids: [], sha256: "" })).tasks[0].setup).toBe(
      TASKS.find((t: { id: string }) => t.id === "docs-upkeep-offer").setup,
    );
  });

  // The manifest's sha256 covers every module beside the hold-out file (holdout.mjs imports its
  // siblings, such as holdout-doc-pack.mjs), by name and bytes; backups and other files do not count.
  it("hashes the hold-out file with the modules beside it, by name and bytes only", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aev-holdout-"));
    const file = join(dir, "holdout.mjs");
    writeFileSync(file, `import more from "./holdout-more.mjs";\nexport default helpers => more(helpers);\n`);
    writeFileSync(
      join(dir, "holdout-more.mjs"),
      `export default ({ must }) => [{ id: "h1", prompt: "p", judge: () => [must("m", true)] }];\n`,
    );
    const digest = holdoutDigest(file);
    expect(digest).toBe(
      createHash("sha256")
        .update("holdout-more.mjs\0")
        .update(`export default ({ must }) => [{ id: "h1", prompt: "p", judge: () => [must("m", true)] }];\n`)
        .update("\0")
        .update("holdout.mjs\0")
        .update(`import more from "./holdout-more.mjs";\nexport default helpers => more(helpers);\n`)
        .update("\0")
        .digest("hex"),
    );
    expect((await loadHoldout(file, { ids: ["h1"], sha256: digest })).matches).toBe(true);
    writeFileSync(join(dir, "holdout.mjs.bak-1"), "old");
    writeFileSync(join(dir, "notes.txt"), "x");
    expect(holdoutDigest(file)).toBe(digest);
    writeFileSync(
      join(dir, "holdout-more.mjs"),
      `export default ({ must }) => [{ id: "h1", prompt: "q", judge: () => [must("m", true)] }];\n`,
    );
    expect(holdoutDigest(file)).not.toBe(digest);
    expect((await loadHoldout(file, { ids: ["h1"], sha256: digest })).matches).toBe(false);
  });

  it("scores a cell by pass rate and mean score, with median calls", () => {
    const c = cells([run("haiku", "t", "pass", 4), run("haiku", "t", "partial", 6), run("haiku", "t", "fail", 9)])[
      "haiku/t"
    ];
    expect(c).toMatchObject({ runs: 3, pass: 1, partial: 1, fail: 1, medianCalls: 6, misses: { x: 2 } });
    expect(c.passRate).toBeCloseTo(1 / 3);
    expect(c.score).toBeCloseTo(0.5);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(totals(cells([run("a", "t", "pass"), run("a", "u", "fail", 1, "holdout")]))["a/holdout"]).toMatchObject({
      runs: 1,
      fail: 1,
    });
  });

  it("flags a regression of a third or more, or a first fail, and an improvement likewise", () => {
    const base = cells([
      run("a", "t", "pass"),
      run("a", "t", "pass"),
      run("a", "t", "pass"),
      run("a", "u", "pass"),
      run("a", "u", "partial"),
      run("a", "u", "pass"),
      run("a", "v", "fail"),
      run("a", "v", "fail"),
      run("a", "v", "pass"),
    ]);
    const now = cells([
      run("a", "t", "pass"),
      run("a", "t", "pass"),
      run("a", "t", "fail"),
      run("a", "u", "pass"),
      run("a", "u", "pass"),
      run("a", "u", "partial"),
      run("a", "v", "pass"),
      run("a", "v", "pass"),
      run("a", "v", "pass"),
      run("a", "w", "pass"),
    ]);
    const status = Object.fromEntries(
      compare(base, now).map((r: { key: string; status: string }) => [r.key, r.status]),
    );
    expect(status).toEqual({ "a/t": "regressed", "a/u": "same", "a/v": "improved", "a/w": "new" });
  });

  it("reports hold-out cells as not run without the file, and not comparable when it changed", () => {
    const base = cells([run("a", "t", "pass"), run("a", "h1", "pass", 5, "holdout")]);
    expect(
      compare(base, cells([run("a", "t", "pass")]), { holdout: "absent" }).map((r: { key: string; status: string }) => [
        r.key,
        r.status,
      ]),
    ).toEqual([
      ["a/h1", "not run"],
      ["a/t", "same"],
    ]);
    const changed = compare(base, cells([run("a", "t", "pass"), run("a", "h1", "fail", 5, "holdout")]), {
      holdout: "changed",
    });
    expect(changed.find((r: { key: string }) => r.key === "a/h1").status).toBe("not comparable");
    // A rotated hold-out has new ids: neither the old cells nor the new ones are compared.
    const rotated = compare(base, cells([run("a", "t", "pass"), run("a", "h2", "pass", 5, "holdout")]), {
      holdout: "changed",
    });
    expect(Object.fromEntries(rotated.map((r: { key: string; status: string }) => [r.key, r.status]))).toEqual({
      "a/h1": "not comparable",
      "a/h2": "not comparable",
      "a/t": "same",
    });
  });

  it("keeps hold-out check names (rubric text) out of a baseline", () => {
    const c = publicCells(cells([run("a", "t", "fail"), run("a", "h1", "fail", 5, "holdout")]));
    expect(c["a/t"].misses).toEqual({ x: 1 });
    expect(c["a/h1"].misses).toEqual({});
  });
});

describe("contamination", () => {
  // A real results tree: the judge lists the run's neighbours to know what lies outside its own folder.
  const out = mkdtempSync(join(tmpdir(), "aev-results-"));
  const runDir = join(out, "haiku", "emphasis", "r2"),
    install = join(out, "install", "home");
  for (const dir of [
    join(runDir, "project", ".archer"),
    join(out, "haiku", "emphasis", "r1"),
    join(out, "haiku", "holdout-a", "r1"),
    join(out, "sol"),
    install,
  ])
    mkdirSync(dir, { recursive: true });
  for (const file of [
    join(out, "haiku", "emphasis", "r1", "transcript.jsonl"),
    join(out, "haiku", "holdout-a", "r1", "command.json"),
    join(out, "summary.md"),
  ])
    writeFileSync(file, "{}");
  const elsewhere = mkdtempSync(join(tmpdir(), "aev-older-"));
  mkdirSync(join(elsewhere, "luna", "t", "r1"), { recursive: true });
  writeFileSync(join(elsewhere, "luna", "t", "r1", "command.json"), "{}");
  const where = {
    runDir,
    out,
    install,
    project: join(runDir, "project"),
    repo: "/home/u/code/archer",
    home: "/home/u",
    holdout: "/srv/private/checks.mjs",
  };
  const spaced = { ...where, holdout: "/srv/private checks.mjs" };
  const bash = (command: string, text = "") => ({
    server: "shell",
    tool: "Bash",
    input: { command },
    via: "shell",
    ...(text.includes(CANARY) ? { canary: true } : {}),
  });
  const read = (file_path: string) => ({ server: "builtin", tool: "Read", input: { file_path }, via: "builtin" });

  it("passes a run that stays in its project, the installed package and Archer's tools", () => {
    expect(
      contamination(
        [
          read(`${runDir}/project/.archer/diagrams/containers.mmd`),
          read(`${install}/.local/share/archer/current/skills/archer/references/cli.md`),
          bash("for p in /AGENTS.md ../AGENTS.md ../../AGENTS.md ../../../AGENTS.md; do test -f $p && cat $p; done"),
          bash("archer list"),
          bash(
            "cat > .archer/notes/debug.md <<'EOF'\nInspect transcript.jsonl and summary.md when debugging; see https://example.com/a/b\nEOF",
          ),
          {
            server: "archer",
            tool: "write_note",
            input: { notePath: "notes/x.md", body: "/home/u/code/archer" },
            via: "mcp",
          },
          bash("ls /tmp/[?/repo"),
          // A glob over an unrelated folder is no record, though `*` could spell an eval file's name.
          bash(`sed -n 1,40p ${elsewhere}/../*`),
          { server: "archer", tool: "read_diagram", input: { viewId: "notes/returns.md#returns" }, via: "mcp" },
        ],
        where,
      ),
    ).toEqual([]);
  });

  it("flags reads of the repository, the eval's files, the hold-out and other runs, however spelled", () => {
    const cases = [
      read("/home/u/code/archer/ts/scripts/evals/v1/tasks.mjs"),
      bash("cat ~/code/archer/docs/evaluations/baseline/small-agents.json"),
      bash('cat "$HOME"/code/ar*her/ts/scripts/eva*/v1/tas*.mjs'),
      bash("cat /srv/private/checks.mjs"),
      bash("cat ../../r1/transcript.jsonl"),
      read(`${runDir}/../../holdout-a/r1/command.json`),
      bash(`ls ${out}/sol`),
      bash("cat ../../../../summary.md"),
      bash(`cat ${elsewhere}/luna/t/r1/command.json`),
      bash(`cat ${elsewhere}/luna/t/r1/comman[d].json`),
      bash(`cd ${elsewhere}; cat luna/t/r1/command.json`),
      bash("ln -s ~/code alias; sed -n 1p alias/archer/AGENTS.md; rm alias"),
      bash("sed -n 2p '/srv/private checks.mjs'"),
      read("/srv/private checks.mjs"),
      bash("sh -c \"$(printf 'Y2F0IC4uLw==' | base64 -d)\"", `{"canary": "${CANARY}"}`),
      { server: "builtin", tool: "Grep", input: { pattern: "judge", path: "/home/u/code/archer" }, via: "builtin" },
      { server: "archer", tool: "attach_project", input: { root: "/home/u/code/archer" }, via: "mcp" },
      { server: "file", tool: "file_change", input: [{ path: "/home/u/code/archer/AGENTS.md" }], via: "edit" },
    ];
    for (const call of cases)
      expect(
        contamination([call], JSON.stringify(call).includes("private checks") ? spaced : where),
        JSON.stringify(call),
      ).toHaveLength(1);
    expect(contamination([], { ...where, finalText: `here: ${CANARY}` })).toHaveLength(1);
  });

  it("flags a run that touches the owner's own ~/.codex, or the auth link in its own Codex home", () => {
    const codexHome = join(tmpdir(), "aev-codex-x");
    const cases = [
      bash("ls ~/.codex/plugins/cache"),
      bash("sed -n 1,40p /home/u/.codex/plugins/cache/openai/x/0.1.6/../*"),
      read("/home/u/.codex/config.toml"),
      bash('cat "$HOME/.codex/auth.json"'),
      bash(`cat ${codexHome}/auth.json`),
    ];
    for (const call of cases)
      expect(contamination([call], { ...where, codexHome }), JSON.stringify(call)).toEqual([
        expect.stringMatching(/\.codex|auth\.json/),
      ]);
    // Its own Codex home is the run's to use, but for the credential link.
    expect(
      contamination([bash(`cat ${codexHome}/config.toml`), bash("ls ~/.codexes")], { ...where, codexHome }),
    ).toEqual([]);
  });

  it("sees a Codex command that started and never finished", () => {
    const file = join(mkdtempSync(join(tmpdir(), "aev-tx-")), "transcript.jsonl");
    writeFileSync(
      file,
      JSON.stringify({
        type: "item.started",
        item: { id: "i1", type: "command_execution", command: "cat /home/u/code/archer/AGENTS.md" },
      }) + "\n",
    );
    const { calls } = parseTranscript(file, "codex");
    expect(calls).toHaveLength(1);
    expect(contamination(calls, where)).toHaveLength(1);
  });

  it("keeps hold-out check names out of progress lines and summaries", () => {
    const checks = [
      { name: "a secret check", level: "must", pass: false },
      { name: "fine", level: "should", pass: true },
    ];
    expect(misses(checks, "holdout")).toEqual(["✗ (hold-out check)"]);
    expect(misses(checks, "main")).toEqual(["✗ a secret check"]);
  });

  it("counts a contaminated run as a fail, listed apart", () => {
    const runs = [
      run("a", "t", "pass"),
      { ...run("a", "t", "contaminated"), rep: "r2", contamination: ["Read: tasks.mjs"] },
    ];
    const c = cells(runs)["a/t"];
    expect(c).toMatchObject({ runs: 2, pass: 1, contaminated: 1 });
    expect(c.score).toBeCloseTo(0.5);
    expect(compare(cells([run("a", "t", "pass")]), cells(runs))[0].status).toBe("regressed");
    expect(contaminatedList(runs)).toMatch(/Contaminated runs \(1\)[\s\S]*a t r2: Read: tasks\.mjs/);
  });

  it("gives each Codex run its own home: a link to the owner's login and nothing else of theirs", () => {
    const owner = mkdtempSync(join(tmpdir(), "aev-owner-codex-"));
    writeFileSync(
      join(owner, "auth.json"),
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: {
          access_token: "A".repeat(40),
          refresh_token: "R".repeat(40),
          id_token: "I".repeat(40),
          account_id: "acct",
        },
      }),
    );
    mkdirSync(join(owner, "plugins", "cache"), { recursive: true });
    const parent = mkdtempSync(join(tmpdir(), "aev-parent-"));
    const home = prepareCodexHome({ owner, parent });
    expect(readdirSync(home.dir)).toEqual(["auth.json"]);
    // A link, so a token refresh writes the owner's file in place (Codex opens auth.json, no rename), never a copy.
    expect(lstatSync(join(home.dir, "auth.json")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(home.dir, "auth.json"))).toBe(join(owner, "auth.json"));
    expect(lstatSync(home.dir).mode & 0o077).toBe(0);
    home.remove();
    expect(existsSync(home.dir)).toBe(false);
    expect(existsSync(join(owner, "auth.json"))).toBe(true);
    expect(() => prepareCodexHome({ owner: join(owner, "missing"), parent })).toThrow(/codex login/);
  });

  it("names nothing of the owner's ~/.codex in a Codex run's arguments, and keeps the login in the file store", () => {
    const args = codexArgs({
      project: "/r/project",
      spec: { model: "m", effort: "medium" },
      task: { prompt: "p" },
      shim: "/i/.local/bin/archer",
      archerEnv: { ARCHER_PORT: "1" },
    });
    expect(args.join(" ")).not.toMatch(/\.codex/);
    expect(args).toEqual(
      expect.arrayContaining(["--ephemeral", "--ignore-user-config", 'cli_auth_credentials_store="file"']),
    );
  });

  it("scrubs the owner's Codex credentials from anything a run keeps", () => {
    const owner = mkdtempSync(join(tmpdir(), "aev-owner-codex-"));
    const access = `eyJ${"a".repeat(60)}`,
      refresh = `rt_${"b".repeat(40)}`;
    writeFileSync(
      join(owner, "auth.json"),
      JSON.stringify({
        tokens: { access_token: access, refresh_token: refresh, id_token: "short", account_id: "acct-1" },
        OPENAI_API_KEY: null,
      }),
    );
    const secrets = codexCredentials(owner);
    const { text, found } = scrubCredentials(Buffer.from(`{"out":"${access}"} and ${refresh}`), secrets);
    expect(found).toBe(2);
    expect(text.toString()).not.toContain(access);
    expect(text.toString()).not.toContain(refresh);
    expect(scrubCredentials(Buffer.from("nothing here"), secrets)).toEqual({
      text: Buffer.from("nothing here"),
      found: 0,
    });
    // Too short to be a credential (an account id, a short field): never used as a pattern.
    expect(secrets).not.toContain("acct-1");
    expect(secrets).not.toContain("short");
  });

  it("denies an evaluated Claude the repository and the hold-out", () => {
    const rules = denyRules({ repo: "/home/u/code/archer", out, home: "/home/u", holdout: "/srv/private/checks.mjs" });
    expect(rules).toEqual(
      expect.arrayContaining([
        "Read(//home/u/code/archer/**)",
        "Read(//home/u/.config/archer-evals/**)",
        "Bash(cat /home/u/code/archer*)",
        `Read(/${out}/results.json)`,
        "Read(//srv/private/checks.mjs)",
      ]),
    );
    expect(rules.some((rule: string) => rule.includes(".cache/archer-evals/**"))).toBe(false);
  });
});

describe("the pairing-code task", () => {
  const task = TASKS.find((t: { id: string }) => t.id === "pairing-code");
  const result =
    "Pairing code: tell the person to open the address and type the code, within 5 minutes (single use); give both exactly (copy them, never retype them):\nhttp://127.0.0.1:41234/\n7KQ4-M2XD";
  const ctx = (finalText: string, tool = "issue_pairing_code") => ({
    finalText,
    changed: [],
    added: [],
    baseline: {},
    files: {},
    calls: [{ server: "archer", tool, via: "mcp", ok: true, text: result }],
  });
  const failed = (c: object) =>
    task
      .judge(c)
      .filter((check: { pass: boolean; level: string }) => !check.pass)
      .map((check: { name: string }) => check.name);
  it("passes the address and the code given exactly, and fails a retyped code", () => {
    expect(failed(ctx("Open http://127.0.0.1:41234/ on your phone and type **7KQ4-M2XD** within 5 minutes."))).toEqual(
      [],
    );
    expect(failed(ctx("Open http://127.0.0.1:41234 and type 7KQ4-M2DX."))).toEqual([
      "gives the code and address, or says only this computer can reach Archer and what to change",
      "gives a code Archer returned, exactly",
    ]);
    expect(
      failed(
        ctx(
          "Archer listens only on this computer, so your phone can't reach it; run archer tls setup to serve the network.",
        ),
      ),
    ).toEqual(["gives a code Archer returned, exactly", "gives the address Archer returned"]);
    expect(failed(ctx("Here is a new link.", "issue_access_link"))).toContain(
      "issued a pairing code, or asked to open Archer to the network",
    );
    // Asking whether to open Archer to the network (setup_network_access needs the yes) is right too.
    expect(
      failed(
        ctx(
          "Archer only serves this computer now. Shall I open it to your home network so your phone can reach it?",
          "list_projects",
        ),
      ),
    ).toEqual(["gives a code Archer returned, exactly", "gives the address Archer returned"]);
  });
  it("counts `archer pair` as issuing a code", () => {
    const dir = mkdtempSync(join(tmpdir(), "aev-pair-"));
    const file = join(dir, "transcript.jsonl");
    writeFileSync(
      file,
      [
        {
          type: "assistant",
          message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "archer pair" } }] },
        },
        { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: result }] } },
      ]
        .map((event) => JSON.stringify(event))
        .join("\n"),
    );
    expect(parseTranscript(file, "claude").calls[0]).toMatchObject({
      server: "archer",
      tool: "issue_pairing_code",
      via: "cli",
      ok: true,
    });
  });
});

describe("the network access tasks", () => {
  const find = (id: string) => TASKS.find((t: { id: string }) => t.id === id);
  const setupText =
    "Archer now serves your network over HTTPS at https://192.168.1.42:41234/, on 192.168.1.42 only.\nPairing code: …:\nhttps://192.168.1.42:41234/\n7KQ4-M2XD\nThe one step only the person can do, on the device: Copy /s/ca/ca-cert.pem …";
  const call = (input: object, ok = true) => ({
    server: "archer",
    tool: "setup_network_access",
    via: "mcp",
    ok,
    input,
    text: setupText,
  });
  const run = (first: { calls: object[]; finalText: string }, calls: object[], finalText: string) =>
    find("open-on-phone")
      .judge({
        firstTurn: first,
        calls: [...first.calls, ...calls],
        finalText,
        changed: [],
        added: [],
        baseline: {},
        files: {},
      })
      .filter((c: { pass: boolean }) => !c.pass)
      .map((c: { name: string }) => c.name);
  const good =
    "Open https://192.168.1.42:41234/ on your phone and type 7KQ4-M2XD. First install and trust the CA certificate ca-cert.pem on the phone.";
  it("are fresh installs, and open-on-phone answers once", () => {
    expect(find("fresh-install-present")).toMatchObject({ config: "none" });
    expect(find("open-on-phone")).toMatchObject({ config: "none", followUp: "Yes, go ahead." });
  });
  it("passes: asks, then sets up after the yes and gives the address, code and trust step", () => {
    expect(
      run(
        { calls: [], finalText: "Shall I open Archer to your home network over HTTPS?" },
        [call({ personConfirmed: true })],
        good,
      ),
    ).toEqual([]);
  });
  it("fails: set up before the yes, no address, or a file to edit", () => {
    expect(run({ calls: [call({ personConfirmed: true })], finalText: good }, [], good)).toContain(
      "asked before opening Archer to the network",
    );
    expect(run({ calls: [], finalText: "Want me to?" }, [call({ personConfirmed: true })], "Done.")).toContain(
      "gives the address and pairing code exactly",
    );
    // A headless client cancels Archer's question: declined, and the agent must say so without a false success.
    const refused = {
      ...call({ personConfirmed: true }, false),
      text: "The person declined opening Archer to their network. Nothing was changed. (person_declined)",
    };
    expect(
      run(
        { calls: [], finalText: "Shall I open it to your network?" },
        [refused],
        "It was declined, so phone access was not turned on; nothing changed.",
      ),
    ).toEqual([]);
    expect(
      run({ calls: [], finalText: "Shall I open it to your network?" }, [refused], "Done! Open it on your phone."),
    ).toContain("says it was not turned on, claiming nothing");
    const badArgs = {
      ...call({ personConfirmed: true, root: "/p" }, false),
      text: "setup_network_access rejected its arguments (1 problem).",
    };
    expect(
      run(
        { calls: [], finalText: "Shall I open it to your network?" },
        [badArgs, refused],
        "Archer couldn't get the confirmation here, so network access remains off.",
      ),
    ).toEqual([]);
    expect(
      run(
        { calls: [], finalText: "Edit ~/.config/archer/archer.toml and set host. OK?" },
        [call({ personConfirmed: true })],
        good,
      ),
    ).toContain("never asks the person to edit settings");
  });
});

describe("follow-up turns and added hold-out files", () => {
  it("finds the session of a first turn and resumes it with the same settings", () => {
    expect(sessionOf('{"type":"system","subtype":"init","session_id":"abc"}\n', "claude")).toBe("abc");
    expect(sessionOf('{"type":"thread.started","thread_id":"t-1"}\n', "codex")).toBe("t-1");
    const args = codexArgs({
      project: "/p",
      spec: { model: "m", effort: "e" },
      task: { prompt: "hi", followUp: "yes" },
      shim: "/s",
      archerEnv: { A: "1" },
    });
    expect(args).not.toContain("--ephemeral");
    const resumed = codexResumeArgs({ args, session: "t-1", followUp: "yes" });
    expect(resumed.slice(0, 2)).toEqual(["exec", "resume"]);
    expect(resumed.slice(-2)).toEqual(["t-1", "yes"]);
    expect(resumed).not.toContain("-C");
    expect(resumed).toContain('sandbox_mode="workspace-write"');
    expect(
      codexArgs({
        project: "/p",
        spec: { model: "m", effort: "e" },
        task: { prompt: "hi" },
        shim: "/s",
        archerEnv: {},
      }),
    ).toContain("--ephemeral");
  });
  it("loads holdout-add-*.mjs beside the hold-out file, covered by its digest", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aev-holdout-"));
    const file = join(dir, "holdout.mjs");
    writeFileSync(file, `export default ({ must }) => [{ id: "h1", prompt: "p", judge: () => [must("m", true)] }];\n`);
    const before = holdoutDigest(file);
    writeFileSync(
      join(dir, "holdout-add-net.mjs"),
      `export default ({ must }) => [{ id: "h9", prompt: "q", followUp: "y", config: "none", judge: () => [must("m", true)] }];\n`,
    );
    expect(holdoutDigest(file)).not.toBe(before);
    const loaded = await loadHoldout(file, { ids: ["h1", "h9"], sha256: holdoutDigest(file) });
    expect(loaded).toMatchObject({ ids: ["h1", "h9"], matches: true });
    expect(loaded.tasks[1]).toMatchObject({ set: "holdout", followUp: "y", config: "none" });
  });
});
