// The development telemetry core: bounded buffers, redaction and detectors.
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import { KeyedWindows, Ring, SlidingWindow, Stat } from "../../src/telemetry/primitives.ts";
import {
  debugEnabled,
  redact,
  redactText,
  redactUrl,
  rejectionPolicy,
  Telemetry,
  THRESHOLDS,
} from "../../src/telemetry/index.ts";
import { parseClientBatch } from "../../src/service/debug-http.ts";

test("a ring keeps only its capacity, oldest first", () => {
  const ring = new Ring<number>(3);
  for (let i = 1; i <= 5; i++) ring.push(i);
  expect(ring.toArray()).toEqual([3, 4, 5]);
  expect(ring.last()).toBe(5);
  ring.clear();
  expect(ring.toArray()).toEqual([]);
});

test("the service log is capped and seq is monotonic across reset", () => {
  const telemetry = new Telemetry({ serviceLogCapacity: 10 });
  for (let i = 0; i < 25; i++) telemetry.log("info", "test.line", `line ${i}`);
  const all = telemetry.entries({ limit: 1000 });
  expect(all).toHaveLength(10);
  expect(all.map((entry) => entry.seq)).toEqual([16, 17, 18, 19, 20, 21, 22, 23, 24, 25]);
  expect(telemetry.entries({ since: 22, limit: 1000 }).map((entry) => entry.seq)).toEqual([23, 24, 25]);
  expect(telemetry.entries({ since: 15, limit: 2 }).map((entry) => entry.seq)).toEqual([16, 17]);
  telemetry.reset();
  telemetry.log("info", "test.line", "after");
  expect(telemetry.entries({ limit: 10 }).map((entry) => entry.seq)).toEqual([26]);
});

test("stat percentiles and windows are bounded", () => {
  const stat = new Stat(4);
  for (const value of [1, 2, 3, 100, 4, 5, 6, 7]) stat.add(value);
  expect(stat.snapshot()).toMatchObject({ count: 8, max: 100, p50: 6 });
  const window = new SlidingWindow(2, 1000);
  expect([window.hit(0), window.hit(10), window.hit(20), window.hit(30)]).toEqual([null, null, 3, null]);
  expect(window.hit(2000)).toBeNull();
  const keyed = new KeyedWindows(1, 1000, 4);
  for (let i = 0; i < 100; i++) keyed.hit(`k${i}`, i);
  expect(keyed.size).toBeLessThanOrEqual(4);
});

test("redaction removes secrets, file contents and token-shaped values, and bounds size", () => {
  const token = "e".repeat(64);
  const cleaned = redact({
    token,
    cookie: "archer=x",
    authorization: `Bearer ${token}`,
    source: "flowchart LR\n a",
    nested: { note: `see ${token}`, list: Array.from({ length: 100 }, (_, i) => i) },
    long: "x".repeat(5000),
  }) as Record<string, unknown>;
  expect(cleaned).toMatchObject({
    token: "[redacted]",
    cookie: "[redacted]",
    authorization: "[redacted]",
    source: "[redacted]",
    nested: { note: "see [redacted]" },
  });
  expect(((cleaned.nested as Record<string, unknown>).list as unknown[]).length).toBe(41);
  expect((cleaned.long as string).length).toBeLessThan(600);
  expect(JSON.stringify(cleaned)).not.toContain(token);
  expect(redactUrl(`/projects/?follow&token=${token}`)).toBe("/projects/?follow&token=[redacted]");
  expect(redactUrl(`/${token}/p/x/api/diagrams`)).toBe("/[redacted]/p/x/api/diagrams");
  const telemetry = new Telemetry();
  telemetry.log("warn", "test.secret", `token ${token}`, { data: { grantSecret: token } });
  expect(JSON.stringify(telemetry.entries({ limit: 10 }))).not.toContain(token);
});

const record = (target: string, client = "addr:127.0.0.1", ms = 1) => ({
  requestId: "r",
  method: "GET",
  route: "/x",
  target,
  status: 200,
  ms,
  bytes: 0,
  client,
  streaming: false,
  phases: {},
});

test("writes to one URL with different bodies are not duplicates; the same body three times is", () => {
  const telemetry = new Telemetry({ now: () => 0 });
  const write = (bodyHash: string) => ({ ...record("/p/x/api/authoring/edit"), method: "POST", bodyHash });
  for (const hash of ["a1", "b2", "c3"]) telemetry.request(write(hash), false);
  const warnings = () =>
    telemetry.entries({ level: "warn", limit: 100 }).filter((entry) => entry.code === "svc.duplicate-request");
  expect(warnings()).toHaveLength(0);
  for (let i = 0; i < 2; i++) telemetry.request(write("a1"), false);
  expect(warnings()).toHaveLength(1);
});

test("one read from each of three page loads is not a duplicate; three from one page are", () => {
  const telemetry = new Telemetry({ now: () => 0 });
  const warnings = () =>
    telemetry.entries({ level: "warn", limit: 100 }).filter((entry) => entry.code === "svc.duplicate-request");
  // Login lands on the project page, which opens the editor (its own document): each reads the listing once.
  for (const page of ["0000000000000001", "0000000000000002", "0000000000000003"])
    telemetry.request({ ...record("/p/x/api/diagrams", "grant:g1"), page }, false);
  expect(warnings()).toHaveLength(0);
  for (let i = 0; i < 2; i++)
    telemetry.request({ ...record("/p/x/api/diagrams", "grant:g1"), page: "0000000000000003" }, false);
  expect(warnings()).toHaveLength(1);
});

test("request detectors: duplicate, burst and slow", () => {
  let now = 0;
  const telemetry = new Telemetry({ now: () => now });
  for (let i = 0; i < 3; i++) telemetry.request(record("/same"), false);
  now = 10;
  telemetry.request(record("/slow", "addr:10.0.0.1", THRESHOLDS.slowRequestMs + 1), false);
  for (let i = 0; i < THRESHOLDS.burst.count + 5; i++) telemetry.request(record(`/u${i}`, "grant:g1"), false);
  const codes = telemetry.entries({ level: "warn", limit: 100 }).map((entry) => entry.code);
  expect(codes.filter((code) => code === "svc.duplicate-request")).toHaveLength(1);
  expect(codes.filter((code) => code === "svc.request-burst")).toHaveLength(1);
  expect(codes.filter((code) => code === "svc.slow-request")).toHaveLength(1);
  // Debug routes are counted, not judged.
  const quiet = new Telemetry();
  for (let i = 0; i < 5; i++) quiet.request(record("/-/debug/log"), true);
  expect(quiet.entries({ limit: 10 })).toEqual([]);
});

test("domain detectors: edit postcondition, slow compile, watch and cache-miss storms, stream leak", () => {
  const now = 0;
  const telemetry = new Telemetry({ now: () => now });
  telemetry.edit("c4", "relabel-node", "edit_invalid_result", 2);
  telemetry.edit("flowchart", "delete-node", "edit_target_missing", 1);
  telemetry.edit("flowchart", "delete-node", null, 1);
  telemetry.compiled("flowchart", THRESHOLDS.slowCompileMs + 1, true);
  for (let i = 0; i <= THRESHOLDS.watchStorm.count; i++) telemetry.watchEvent("/root");
  for (let i = 0; i <= THRESHOLDS.cacheMissStorm.count; i++) telemetry.thumbnailCache(false);
  telemetry.stream("refused", 32, 32);
  const byCode = (code: string) => telemetry.entries({ code, limit: 10 });
  expect(byCode("svc.edit-postcondition")).toEqual([
    expect.objectContaining({ level: "warn", data: { family: "c4", op: "relabel-node", code: "edit_invalid_result" } }),
  ]);
  expect(byCode("svc.edit-refused")).toEqual([
    expect.objectContaining({
      level: "info",
      data: { family: "flowchart", op: "delete-node", code: "edit_target_missing" },
    }),
  ]);
  for (const code of ["svc.slow-compile", "svc.watch-storm", "svc.cache-miss-storm", "svc.stream-leak"])
    expect([code, byCode(code).length]).toEqual([code, 1]);
  const metrics = telemetry.metrics() as { authoring: { edits: Record<string, { outcomes: Record<string, number> }> } };
  expect(metrics.authoring.edits["flowchart delete-node"]!.outcomes).toEqual({ edit_target_missing: 1, ok: 1 });
});

test("the event-loop sampler reports a blocked loop", async () => {
  const telemetry = new Telemetry({ sampleMs: 60_000 });
  telemetry.start();
  try {
    await new Promise((resolve) => setTimeout(resolve, 20));
    const until = Date.now() + THRESHOLDS.eventLoopLagMs + 50;
    while (Date.now() < until) {
      /* block */
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    telemetry.sample();
    expect(telemetry.entries({ code: "svc.event-loop-lag", limit: 5 })).toHaveLength(1);
    expect(telemetry.eventLoopLagMs()).toBeGreaterThan(THRESHOLDS.eventLoopLagMs);
  } finally {
    telemetry.stop();
  }
});

test("a browser batch is validated and its levels inferred", () => {
  const batch = parseClientBatch({
    session: "s",
    page: "/",
    build: "dev",
    events: [
      { at: 1, type: "long-task" },
      { at: 1, type: "web-vitals", code: "ui.web-vitals" },
      { at: 1, type: "error", code: "ui.page-error" },
      { at: 1, type: "x", level: "debug" },
      { at: 1, type: "pageview" },
      { at: 1, type: "warn", code: "app.thing" },
    ],
  });
  expect(typeof batch === "string" ? batch : batch.events.map((event) => [event.code, event.level])).toEqual([
    ["ui.long-task", "warn"],
    ["ui.web-vitals", "info"],
    ["ui.page-error", "error"],
    ["ui.x", "debug"],
    ["ui.pageview", "info"],
    ["app.thing", "warn"],
  ]);
  for (const bad of [
    null,
    [],
    { session: 1, page: "", build: "" },
    { session: "s", page: "", build: "", events: [{ at: "never", type: "x" }] },
    { session: "s", page: "", build: "", events: [{ at: 1, type: "x", level: "loud" }] },
  ])
    expect(typeof parseClientBatch(bad)).toBe("string");
});

test("redaction decodes URL parameters before it recognises credentials", () => {
  const token = "a".repeat(64);
  const pct = (text: string): string =>
    [...text].map((c) => `%${c.charCodeAt(0).toString(16).padStart(2, "0")}`).join("");
  const cases: [string, string][] = [
    [`/?%74oken=${pct(token)}`, "/?token=[redacted]"],
    [`/?TOKEN=x1&b=2`, "/?TOKEN=[redacted]&b=2"],
    [`/x?follow&%67rant=abc`, "/x?follow&grant=[redacted]"],
    [`/x?api%5Fkey=abc&page=2`, "/x?api_key=[redacted]&page=2"],
    [`/x?a=1&%2574oken=zz`, "/x?a=1&token=[redacted]"],
    [`/x?client+secret=s3cr3t`, "/x?client%20secret=[redacted]"],
    [`/x?authorization=Bearer+abc`, "/x?authorization=[redacted]"],
    [`/x?cookie=archer-1%3Dabc`, "/x?cookie=[redacted]"],
    [`/x?next=${pct(token)}`, "/x?next=[redacted]"],
    [`/${pct(token)}/p/x/api/diagrams`, "/[redacted]/p/x/api/diagrams"],
    [`/x?path=notes%2Fa.md&tab=view`, "/x?path=notes%2Fa.md&tab=view"],
  ];
  expect(cases.map(([url]) => redactUrl(url))).toEqual(cases.map(([, want]) => want));
  // Nested strings: a message or a data field quoting a URL is cleaned the same way.
  const cleaned = redact({
    msg: `GET /?%74oken=${pct(token)} 200`,
    nested: { url: `http://h/?Grant=${token.slice(0, 20)}` },
  });
  expect(cleaned).toEqual({ msg: "GET /?token=[redacted] 200", nested: { url: "http://h/?Grant=[redacted]" } });
  expect(redact({ "%74oken": "x", apiKey: "y" })).toEqual({ "%74oken": "[redacted]", apiKey: "[redacted]" });
  expect(redactText("plain text, a=b & c")).toBe("plain text, a=b & c");
  // A request logged by the service: the decoded credential never appears, nor its encoding.
  const telemetry = new Telemetry();
  // Its line names the route, never the target (C-34): even a target that slipped past redaction is not logged.
  telemetry.request(
    {
      requestId: "r",
      method: "GET",
      route: "/",
      target: `/?%74oken=${pct(token)}`,
      status: 200,
      ms: 1,
      bytes: 0,
      client: "addr:x",
      streaming: false,
      phases: {},
    },
    false,
  );
  expect(telemetry.entries({ limit: 10 }).map((entry) => entry.msg)).toEqual(["GET / 200"]);
  const logged = JSON.stringify(telemetry.entries({ limit: 10 }));
  expect(logged).not.toContain(token);
  expect(logged).not.toContain(pct(token).slice(0, 30));
});

test("only ARCHER_DEBUG=1 turns telemetry on", () => {
  expect([
    debugEnabled({ ARCHER_DEBUG: "1" }),
    debugEnabled({ ARCHER_DEBUG: "true" }),
    debugEnabled({ ARCHER_DEBUG: "0" }),
    debugEnabled({}),
  ]).toEqual([true, false, false, false]);
});

test("the unhandled-rejection policy is read from execArgv, then NODE_OPTIONS; throw by default", () => {
  expect(rejectionPolicy([], undefined)).toBe("throw");
  expect(rejectionPolicy(["--unhandled-rejections=warn"], undefined)).toBe("warn");
  expect(rejectionPolicy(["--unhandled-rejections", "none"], undefined)).toBe("none");
  expect(rejectionPolicy([], "--max-old-space-size=100 --unhandled-rejections=strict")).toBe("strict");
  expect(rejectionPolicy(["--unhandled-rejections=warn-with-error-code"], "--unhandled-rejections=none")).toBe(
    "warn-with-error-code",
  );
  expect(rejectionPolicy(["--unhandled-rejections=bogus"], undefined)).toBe("throw");
});

test("reload timings are bounded and forgotten on detach and reset", () => {
  const telemetry = new Telemetry();
  for (let i = 0; i < 500; i++) telemetry.reloaded(`/root/${i}`, 1, true);
  expect(telemetry.lastReloadMs("/root/499")).toBe(1);
  expect(telemetry.lastReloadMs("/root/0")).toBeNull();
  expect(telemetry.reloadRootsTracked()).toBeLessThanOrEqual(64);
  telemetry.forgetProject("/root/499");
  expect(telemetry.lastReloadMs("/root/499")).toBeNull();
  telemetry.reloaded("/root/a", 2, true);
  telemetry.reset();
  expect(telemetry.lastReloadMs("/root/a")).toBeNull();
});

/** A child process with telemetry started under `mode`, which rejects one promise and reports whether it survived. */
function rejectUnder(mode: string | null): { status: number | null; stdout: string } {
  const module = pathToFileURL(fileURLToPath(new URL("../../src/telemetry/index.ts", import.meta.url))).href;
  const script = `const { Telemetry } = await import(${JSON.stringify(module)});
const t = new Telemetry({ sink: line => console.log(line) }); t.start();
Promise.reject(new Error("boom"));
setTimeout(() => { console.log("alive exit=" + (process.exitCode ?? 0)); t.stop(); }, 200);`;
  const args = [
    "--import",
    "tsx",
    ...(mode === null ? [] : [`--unhandled-rejections=${mode}`]),
    "--input-type=module",
    "-e",
    script,
  ];
  const { NODE_OPTIONS: _options, ...env } = process.env;
  const result = spawnSync(process.execPath, args, {
    cwd: fileURLToPath(new URL("../..", import.meta.url)),
    env,
    encoding: "utf8",
    timeout: 20_000,
  });
  return { status: result.status, stdout: result.stdout };
}

test("observing rejections keeps the process's configured --unhandled-rejections behaviour", () => {
  const thrown = rejectUnder(null);
  expect(thrown.status).not.toBe(0);
  expect(thrown.stdout).toContain("svc.unhandled");
  expect(thrown.stdout).not.toContain("alive");
  for (const mode of ["warn", "none"]) {
    const survived = rejectUnder(mode);
    expect([
      mode,
      survived.status,
      survived.stdout.includes("alive exit=0"),
      survived.stdout.includes("svc.unhandled"),
    ]).toEqual([mode, 0, true, true]);
  }
  const coded = rejectUnder("warn-with-error-code");
  expect([coded.status, coded.stdout.includes("alive exit=1"), coded.stdout.includes("svc.unhandled")]).toEqual([
    1,
    true,
    true,
  ]);
}, 60_000);

test("event-loop delay measured before the service listens can be discarded", async () => {
  const telemetry = new Telemetry();
  telemetry.start();
  try {
    await new Promise((resolve) => setTimeout(resolve, 40)); // the monitor's first ticks
    const until = performance.now() + 150;
    while (performance.now() < until) {
      /* hold the loop, as loading Mermaid does */
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(telemetry.eventLoopLagMs()).toBeGreaterThan(100);
    telemetry.discardLoopDelay();
    telemetry.sample();
    expect(
      telemetry.entries({ level: "warn", limit: 10 }).filter((entry) => entry.code === "svc.event-loop-lag"),
    ).toEqual([]);
  } finally {
    telemetry.stop();
  }
});
