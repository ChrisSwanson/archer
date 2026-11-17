import { beforeAll, expect, it, vi } from "vitest";
import { registerPlaygroundTools, type BrowserTool, type ModelContext } from "../src/playground/webmcp";
import { createStaticRuntime } from "../src/playground/runtime";
import { configureStaticAddress } from "../src/playground/address";
import { exampleSnapshot } from "./support/playground-snapshot";
import type { PlaygroundSnapshot } from "../../shared/playground-snapshot.mts";
import { PLAYGROUND_TOOLS } from "../src/playground/tool-metadata";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildSync } from "esbuild";
let snapshot: PlaygroundSnapshot;
beforeAll(() => {
  snapshot = exampleSnapshot();
}, 30000);

function fakeContext() {
  const tools = new Map<string, BrowserTool>();
  const signals: AbortSignal[] = [];
  const context: ModelContext = {
    registerTool: vi.fn(async (tool, options) => {
      options.signal.throwIfAborted();
      tools.set(tool.name, tool);
      signals.push(options.signal);
      options.signal.addEventListener("abort", () => tools.delete(tool.name), { once: true });
      return undefined;
    }),
  };
  return { context, tools, signals };
}
function setup() {
  const slug = snapshot.projects[0]!.slug;
  const href = `https://example.test/projects/${slug}/diagrams/containers.mmd`;
  configureStaticAddress({
    documentUrl: "https://example.test/archer/playground/app/",
    digest: snapshot.manifest.digest,
  });
  const runtime = createStaticRuntime({ snapshot, href: () => href, storage: null });
  const controls = {
    context: () => ({ projectSlug: slug, viewId: "containers" }),
    present: vi.fn(async () => ({ viewId: "containers" })),
    controlWalk: vi.fn(async () => ({ viewId: "containers" })),
  };
  const fake = fakeContext();
  const adapter = registerPlaygroundTools({
    snapshot,
    runtime,
    controls: () => controls,
    document: { modelContext: fake.context },
    navigator: {},
  });
  const execute = (name: string, input: object, signal = new AbortController().signal) =>
    fake.tools.get(name)!.execute(input, { signal });
  return { ...fake, adapter, execute, runtime, controls };
}

it("registers canonical tools on document first, returns JSON results and unregisters through the registration signal", async () => {
  const { adapter, tools, signals, execute } = setup();
  expect(await adapter.ready).toBe(true);
  expect([...tools.keys()]).toEqual([...PLAYGROUND_TOOLS.map((tool) => tool.name), "play_walkthrough"]);
  const result = await execute("list_projects", {});
  expect(JSON.parse(JSON.stringify(result))).toMatchObject({
    provenance: "static-playground",
    projects: snapshot.projects.map((p) => ({ slug: p.slug, name: p.name })),
  });
  expect(JSON.stringify(result)).not.toContain('"root"');
  adapter.dispose();
  expect(signals.every((signal) => signal.aborted)).toBe(true);
  expect(tools.size).toBe(0);
});

it("feature detects navigator fallback, handles absence and atomic registration failure without a second batch", async () => {
  const { runtime, controls } = setup();
  const fallback = fakeContext();
  const args = { snapshot, runtime, controls: () => controls };
  const absent = registerPlaygroundTools({ ...args, document: {}, navigator: {} });
  expect(await absent.ready).toBe(false);
  const legacy = registerPlaygroundTools({ ...args, document: {}, navigator: { modelContext: fallback.context } });
  expect(await legacy.ready).toBe(true);
  legacy.dispose();
  const previousFallbackCalls = vi.mocked(fallback.context.registerTool).mock.calls.length;
  const modern = fakeContext();
  modern.context.registerTool = vi.fn(async (tool, options) => {
    modern.signals.push(options.signal);
    if (tool.name === "read_note") throw new Error("refused");
    return undefined;
  });
  const available = vi.fn();
  const rejected = registerPlaygroundTools({
    ...args,
    document: { modelContext: modern.context },
    navigator: { modelContext: fallback.context },
    onAvailability: available,
  });
  expect(await rejected.ready).toBe(false);
  expect(available).not.toHaveBeenCalledWith(true);
  expect(modern.signals.every((signal) => signal.aborted)).toBe(true);
  expect(fallback.context.registerTool).toHaveBeenCalledTimes(previousFallbackCalls);
});

it("reads exact sources and real inventory with all network APIs forbidden", async () => {
  const { adapter, execute } = setup();
  await adapter.ready;
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("network forbidden");
    }),
  );
  vi.stubGlobal(
    "EventSource",
    vi.fn(() => {
      throw new Error("events forbidden");
    }),
  );
  try {
    const diagrams = (await execute("list_diagrams", {})) as { views: unknown[]; notes: unknown[] };
    expect(diagrams.views.length).toBeGreaterThan(0);
    expect(diagrams.notes.length).toBeGreaterThan(0);
    const diagram = await execute("read_diagram", { viewId: "containers" });
    expect(diagram).toMatchObject({
      ...snapshot.projects[0]!.toolSources["view:containers"],
      provenance: "static-playground",
    });
    const note = Object.keys(snapshot.projects[0]!.toolSources)
      .find((key) => key.startsWith("note:"))!
      .slice(5);
    expect(await execute("read_note", { notePath: note })).toMatchObject(
      snapshot.projects[0]!.toolSources[`note:${note}`]!,
    );
    expect(await execute("list_walkthroughs", { viewId: "containers" })).toMatchObject({
      provenance: "static-playground",
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(EventSource).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
    adapter.dispose();
  }
});

it("validates emphasis before publishing, saves one local comment on retry and refuses stale/unknown anchors", async () => {
  const { adapter, execute, runtime } = setup();
  await adapter.ready;
  const events = vi.fn();
  const bridge = runtime.connect!({ onPresent: () => {}, onClear: () => {}, onEmphasis: events });
  const request = {
    id: "answer",
    viewId: "containers",
    groups: [{ id: "one", style: "highlight", label: "The App", nodes: ["archer_page"] }],
  };
  const envelope = snapshot.projects[0]!.responses["api/diagrams/containers"] as {
    model: { type: string; nodes?: { id: string }[]; elements?: { id: string }[] };
  };
  const node = envelope.model.nodes?.[0]?.id ?? envelope.model.elements?.[0]?.id;
  expect(node).toBeDefined();
  request.groups[0]!.nodes = [node!];
  expect(await execute("set_emphasis", request)).toMatchObject({ local: true });
  expect(events).toHaveBeenCalled();
  const before = events.mock.calls.length;
  await expect(
    execute("set_emphasis", { ...request, groups: [{ ...request.groups[0], nodes: ["missing"] }] }),
  ).rejects.toThrow();
  expect(events).toHaveBeenCalledTimes(before);
  const comment = { target: "view:containers", anchor: { kind: "node", id: node }, body: "Example question" };
  const first = await execute("create_comment", comment);
  expect(first).toMatchObject({ local: true, thread: { comments: [{ body: "Example question" }] } });
  expect(await execute("create_comment", comment)).toEqual(first);
  const threads = await (await runtime.request("api/comments?target=view%3Acontainers")).json();
  expect(threads.threads).toHaveLength(1);
  await expect(
    execute("create_comment", { ...comment, expectedModelRevision: "sha256:" + "0".repeat(64) }),
  ).rejects.toThrow();
  await expect(execute("create_comment", { ...comment, anchor: { kind: "node", id: "missing" } })).rejects.toThrow();
  // Grounded as the live store grounds it: a step reads "<position>. <title>", the walkthrough its title.
  const walks = snapshot.projects[0]!.responses["api/walkthroughs?viewId=containers"] as {
    walkthroughs: { id: string; title: string; steps: { id: string; title: string }[] }[];
  };
  const walk = walks.walkthroughs[0]!;
  const step = await execute("create_comment", {
    target: "view:containers",
    anchor: { kind: "step", walkthrough: walk.id, step: walk.steps[1]!.id },
    body: "About this step",
  });
  expect(step).toMatchObject({
    thread: {
      anchor: { kind: "step", walkthrough: walk.id, step: walk.steps[1]!.id, label: `2. ${walk.steps[1]!.title}` },
    },
  });
  await expect(
    execute("create_comment", {
      target: "view:containers",
      anchor: { kind: "walkthrough", walkthrough: "absent" },
      body: "x",
    }),
  ).rejects.toThrow(/no walkthrough "absent"/);
  await execute("set_emphasis", { id: "answer", viewId: "containers", groups: [] });
  bridge.disconnect();
  adapter.dispose();
});

it("refuses unsupported options, aborted execution, disposed callbacks and stale project bindings before effects", async () => {
  const { adapter, execute, controls } = setup();
  await adapter.ready;
  const stopped = new AbortController();
  stopped.abort();
  await expect(execute("present_diagram", { viewId: "containers" }, stopped.signal)).rejects.toThrow();
  await expect(execute("present_diagram", { viewId: "containers", expand: [] })).rejects.toThrow();
  await expect(
    execute("present_diagram", { viewId: "containers", expectedRevision: "sha256:" + "0".repeat(64) }),
  ).rejects.toThrow();
  expect(controls.present).not.toHaveBeenCalled();
  const saved = execute("present_diagram", { viewId: "containers" });
  await saved;
  expect(controls.present).toHaveBeenCalledOnce();
  const callback = setup();
  await callback.adapter.ready;
  const staleTool = callback.tools.get("present_diagram")!;
  callback.controls.context = () => ({ projectSlug: "rfc-1149-ipoac", viewId: "flight" });
  await expect(staleTool.execute({ viewId: "containers" }, { signal: new AbortController().signal })).rejects.toThrow();
  const old = callback.tools.get("read_diagram")!;
  callback.adapter.dispose();
  await expect(old.execute({ viewId: "containers" }, { signal: new AbortController().signal })).rejects.toThrow();
  adapter.dispose();
});

it("refuses variant-irrelevant anchor fields and control characters exactly like canonical comment creation", async () => {
  const { adapter, execute, runtime } = setup();
  await adapter.ready;
  await expect(
    execute("create_comment", {
      target: "view:containers",
      anchor: { kind: "view", id: "ignored" },
      body: "A malformed anchor",
    }),
  ).rejects.toThrow();
  await expect(
    execute("create_comment", { target: "view:containers", anchor: { kind: "view" }, body: "Hidden\u0001control" }),
  ).rejects.toThrow();
  const state = await (await runtime.request("api/comments?target=view%3Acontainers")).json();
  expect(state.threads).toHaveLength(0);
  adapter.dispose();
});

it("cancels a pending registration and in-flight player work on disposal", async () => {
  const fixture = setup();
  await fixture.adapter.ready;
  fixture.adapter.dispose();
  let finish: (() => void) | undefined;
  const pending = fakeContext();
  pending.context.registerTool = vi.fn(
    (_tool, { signal }) =>
      new Promise<undefined>((resolve) => {
        pending.signals.push(signal);
        finish = () => resolve(undefined);
      }),
  );
  const availability = vi.fn();
  const adapter = registerPlaygroundTools({
    snapshot,
    runtime: fixture.runtime,
    controls: () => fixture.controls,
    document: { modelContext: pending.context },
    navigator: {},
    onAvailability: availability,
  });
  adapter.dispose();
  finish!();
  expect(await adapter.ready).toBe(false);
  expect(pending.signals.every((signal) => signal.aborted)).toBe(true);
  expect(availability).not.toHaveBeenCalledWith(true);

  let started: AbortSignal | undefined;
  fixture.controls.controlWalk = vi.fn(
    async (_input?: unknown, signal?: AbortSignal) =>
      new Promise<never>((_resolve, reject) => {
        started = signal;
        signal!.addEventListener("abort", () => reject(signal!.reason), { once: true });
      }),
  );
  const runningContext = fakeContext();
  const running = registerPlaygroundTools({
    snapshot,
    runtime: fixture.runtime,
    controls: () => fixture.controls,
    document: { modelContext: runningContext.context },
    navigator: {},
  });
  await running.ready;
  const execution = runningContext.tools
    .get("play_walkthrough")!
    .execute({ action: "play" }, { signal: new AbortController().signal });
  expect(started).toBeDefined();
  const rejected = expect(execution).rejects.toThrow();
  running.dispose();
  await rejected;
  expect(started!.aborted).toBe(true);
});

it("refuses arbitrary, vocabulary and edited input on a small stack within a clock bound", () => {
  const scratch = mkdtempSync(join(tmpdir(), "archer-webmcp-boundary-"));
  try {
    const modulePath = join(scratch, "adapter.cjs");
    const entry = [
      `export {registerPlaygroundTools} from ${JSON.stringify(resolve("src/playground/webmcp.ts"))};`,
      `export {createStaticRuntime} from ${JSON.stringify(resolve("src/playground/runtime.ts"))};`,
      `export {configureStaticAddress} from ${JSON.stringify(resolve("src/playground/address.ts"))};`,
    ].join("\n");
    buildSync({
      stdin: { contents: entry, resolveDir: process.cwd(), loader: "ts" },
      bundle: true,
      platform: "node",
      format: "cjs",
      outfile: modulePath,
      logLevel: "silent",
    });
    const snapshotPath = join(scratch, "snapshot.json");
    writeFileSync(snapshotPath, JSON.stringify(snapshot));
    const script = `
const assert=require('node:assert/strict');
const {registerPlaygroundTools,createStaticRuntime,configureStaticAddress}=require(${JSON.stringify(modulePath)});
const snapshot=require(${JSON.stringify(snapshotPath)});
configureStaticAddress({documentUrl:'https://example.test/playground/app/',digest:snapshot.manifest.digest});
const runtime=createStaticRuntime({snapshot,href:()=> 'https://example.test/projects/archer-tour/',storage:null});
const controls={context:()=>({projectSlug:'archer-tour'}),present:async()=>{},controlWalk:async()=>{}};
const tools=new Map();
const adapter=registerPlaygroundTools({snapshot,runtime,controls:()=>controls,document:{modelContext:{registerTool:async tool=>{tools.set(tool.name,tool);}}},navigator:{}});
let seed=7911; const random=()=> seed=(Math.imul(seed,1664525)+1013904223)>>>0;
const vocabulary=['notePath','anchor','nodes','groups','id','__proto__','viewId','kind','/projects/','../','notes/user-stories.md',null,[],{},true,0];
(async()=>{ await adapter.ready;
 const check=async value=>{try{const result=await tools.get('read_note').execute(value,{signal:new AbortController().signal});assert.doesNotThrow(()=>JSON.stringify(result));}catch(error){if(error instanceof RangeError || error.name==='RangeError') throw error;}};
 for(let i=0;i<1200;i++){
  let bytes='';for(let j=0;j<24;j++) bytes+=String.fromCharCode(random()%65536);
  await check({notePath:bytes});
  await check({[String(vocabulary[random()%vocabulary.length])]:vocabulary[random()%vocabulary.length]});
  const original='notes/user-stories.md', index=random()%original.length;
  await check({notePath:original.slice(0,index)+String(vocabulary[random()%vocabulary.length])+original.slice(index+1)});
 }
 let deep={};for(let i=0;i<2000;i++)deep={unexpected:deep};await check(deep);
 const cycle={};cycle.self=cycle;await check(cycle);
 await check(null);await check([]);adapter.dispose();process.stdout.write('3604 boundary cases passed');
})().catch(error=>{console.error(error);process.exit(1);});`;
    expect(
      execFileSync(process.execPath, ["--stack-size=192", "-e", script], { encoding: "utf8", timeout: 15000 }),
    ).toContain("3604 boundary cases passed");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}, 30000);
