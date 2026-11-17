// The comments trust boundaries never throw anything but a refusal: a new
// thread posted by anyone holding the page's link, and a comments file from
// disk (hand-edited, merged, truncated). Arbitrary JSON, JSON built from the
// contract's vocabulary, and valid input with small edits, from fixed seeds.
import { afterEach, expect, test } from "vitest";
import { CommentsError, readNewThread, readSubmitRequest, validateCommentsFile } from "../../src/comments/store.ts";
import { removeTempDirs, tempDir } from "../project/support.ts";

afterEach(removeTempDirs);

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = [
  "threadId",
  "version",
  "target",
  "threads",
  "id",
  "anchor",
  "status",
  "changedAfterSubmit",
  "orphaned",
  "comments",
  "author",
  "body",
  "createdAt",
  "editedAt",
  "kind",
  "label",
  "nodes",
  "edges",
  "quote",
  "prefix",
  "suffix",
  "view",
  "node",
  "edge",
  "group",
  "selection",
  "passage",
  "draft",
  "submitted",
  "sent",
  "read",
  "answered",
  "resolved",
  "revision",
  "person",
  "agent",
  "view:flow",
  "note:a.md",
  "note:../x.md",
  "t-1",
  "c-1",
  "__proto__",
  "constructor",
  "",
  "x".repeat(5000),
  "\u0000",
  "a",
];

function value(next: () => number, depth = 0): unknown {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)] as T;
  const roll = next();
  if (depth > 5 || roll < 0.3) return pick<unknown>([null, true, 0, 1, -1, 1.5, "", pick(WORDS), [], {}]);
  if (roll < 0.55) return Array.from({ length: Math.floor(next() * 4) }, () => value(next, depth + 1));
  const object: Record<string, unknown> = {};
  for (let i = Math.floor(next() * 6); i > 0; i--) object[pick(WORDS)] = value(next, depth + 1);
  return object;
}

function mutate(input: unknown, next: () => number): unknown {
  if (typeof input !== "object" || input === null) return value(next);
  const copy: Record<string, unknown> | unknown[] = Array.isArray(input)
    ? [...input]
    : { ...(input as Record<string, unknown>) };
  const keys = Object.keys(copy);
  const key = keys[Math.floor(next() * keys.length)];
  if (key === undefined) return value(next);
  const target = copy as Record<string, unknown>;
  target[key] = next() < 0.5 ? value(next) : mutate(target[key], next);
  return copy;
}

function inputs(seed: number, valid: unknown): unknown[] {
  const next = random(seed);
  return [
    ...Array.from({ length: 500 }, () => value(next)),
    ...Array.from({ length: 1500 }, () => mutate(valid, next)),
  ];
}

/** A bounded cloneable corpus for small-stack checks; the full corpus still runs in-process above. */
function wireInputs(seed: number, valid: unknown): unknown[] {
  const generated = inputs(seed, valid);
  const bounded = (values: unknown[]) => values.filter((value) => (JSON.stringify(value)?.length ?? 0) <= 10_000);
  return [...bounded(generated.slice(0, 500)).slice(0, 100), ...bounded(generated.slice(500)).slice(0, 300)];
}

interface SmallStackResult {
  readonly outcome: "refused or valid";
  readonly count: number;
  readonly importMs: number;
  readonly loopMs: number;
}

/** Run an untrusted-input loop on a 512 KiB worker stack, with a hard wall clock. */
async function onSmallStack(script: string, workerData: unknown): Promise<SmallStackResult> {
  const { Worker } = await import("node:worker_threads");
  return await new Promise<SmallStackResult>((resolve, reject) => {
    let completed = false;
    const worker = new Worker(script, {
      eval: true,
      workerData,
      resourceLimits: { stackSizeMb: 0.5 },
    });
    const clock = setTimeout(() => {
      completed = true;
      void worker.terminate();
      reject(new Error("small-stack property loop exceeded 20 seconds"));
    }, 20_000);
    worker.once("message", (result: SmallStackResult) => {
      completed = true;
      clearTimeout(clock);
      void worker.terminate().then(() => resolve(result), reject);
    });
    worker.once("error", (error) => {
      completed = true;
      clearTimeout(clock);
      reject(error);
    });
    worker.once("exit", (code) => {
      if (!completed && code !== 0) {
        clearTimeout(clock);
        reject(new Error(`small-stack worker exited with ${code}`));
      }
    });
  });
}

const NEW_THREAD = {
  target: "view:flow",
  anchor: { kind: "selection", nodes: [{ id: "a", label: "A" }], edges: [{ id: "e1", label: "" }] },
  body: "hi",
};
const FILE = {
  version: 2,
  target: "view:flow",
  threads: [
    {
      id: "t-1",
      target: "view:flow",
      anchor: { kind: "passage", quote: "q", prefix: "", suffix: "" },
      status: "answered",
      revision: 3,
      changedAfterSubmit: true,
      comments: [
        { id: "c-1", author: "person", body: "hi", createdAt: "2026-10-03T12:00:00.000Z" },
        { id: "c-2", author: "agent", body: "yes", createdAt: "2026-10-03T12:00:01.000Z", editedAt: "x" },
      ],
    },
  ],
};

test("a posted thread is refused with invalid_comment, or read as the contract's shape", () => {
  expect(readNewThread(NEW_THREAD)).toEqual(NEW_THREAD);
  for (const raw of inputs(11, NEW_THREAD)) {
    try {
      const thread = readNewThread(raw);
      expect(thread.target).toMatch(/^(view|note):/);
      expect(typeof thread.body).toBe("string");
    } catch (error) {
      expect(error, JSON.stringify(raw)?.slice(0, 300)).toBeInstanceOf(CommentsError);
      expect((error as CommentsError).code).toBe("invalid_comment");
    }
  }
});

test("a version 2 comments file is refused with a problem, or valid as version 2", () => {
  expect(validateCommentsFile(FILE)).toMatchObject({ ok: true, file: { version: 2 } });
  for (const raw of inputs(12, FILE)) {
    const result = validateCommentsFile(raw);
    if (result.ok) {
      expect(result.file.version).toBe(2);
      for (const t of result.file.threads) expect(Number.isSafeInteger(t.revision) && t.revision >= 1).toBe(true);
    } else expect(result.problem.length, JSON.stringify(raw)?.slice(0, 300)).toBeGreaterThan(0);
  }
});

test("a version 2 file reads as itself; a version 1 file is refused", () => {
  expect(validateCommentsFile(FILE)).toEqual({ ok: true, file: FILE });
  expect(
    validateCommentsFile({
      ...FILE,
      version: 1,
      threads: [{ ...FILE.threads[0], revision: undefined, status: "submitted" }],
    }),
  ).toMatchObject({ ok: false });
});

test("publication selector is refused or valid for arbitrary, vocabulary and edited valid requests", () => {
  for (const raw of inputs(20261007, { target: "view:flow", threadId: "t-1" })) {
    try {
      const parsed = readSubmitRequest(raw);
      expect(Object.keys(parsed).every((key) => key === "target" || key === "threadId")).toBe(true);
      if (parsed.threadId !== undefined) {
        expect(typeof parsed.threadId).toBe("string");
        expect(parsed.threadId.length).toBeGreaterThan(0);
        expect(parsed.threadId.length).toBeLessThanOrEqual(64);
      }
    } catch (error) {
      expect(error).toBeInstanceOf(CommentsError);
      expect((error as CommentsError).code).toBe("invalid_comment");
    }
  }
});

test("publication selector remains refused or valid on a small stack within a clock", async () => {
  const module = new URL("../../src/comments/store.ts", import.meta.url).href;
  const script = `
    const { parentPort, workerData } = require("node:worker_threads");
    void (async () => {
      const started = performance.now();
      await import("tsx/esm");
      const { readSubmitRequest, CommentsError } = await import(${JSON.stringify(module)});
      const importMs = performance.now() - started;
      const loopStarted = performance.now();
      for (const raw of workerData.corpus) {
        try { readSubmitRequest(raw); }
        catch (error) { if (!(error instanceof CommentsError)) throw error; }
      }
      parentPort.postMessage({ outcome: "refused or valid", count: workerData.corpus.length, importMs, loopMs: performance.now() - loopStarted });
    })().catch((error) => { throw error; });
  `;
  const result = await onSmallStack(script, { corpus: wireInputs(20261008, { target: "view:flow", threadId: "t-1" }) });
  expect(result).toMatchObject({ outcome: "refused or valid", count: 400 });
  expect(result.importMs).toBeLessThan(15_000);
  expect(result.loopMs).toBeLessThan(5_000);
}, 30_000);

test("create_comment remains a refusal or a valid agent-root thread for arbitrary payloads on a small stack within a clock", async () => {
  const module = new URL("../../src/application/index.ts", import.meta.url).href;
  const valid = { target: "note:note.md", anchor: { kind: "view" }, body: "Agent question" };
  const root = tempDir({ ".archer/note.md": "# Note\n\nA passage for comments.\n" });
  const script = `
    const { parentPort, workerData } = require("node:worker_threads");
    void (async () => {
      const started = performance.now();
      await import("tsx/esm");
      const { createApplication, OperationError } = await import(${JSON.stringify(module)});
      const importMs = performance.now() - started;
      const app = createApplication({ cwd: workerData.root });
      const loopStarted = performance.now();
      for (const raw of workerData.corpus) {
        try {
          const result = await app.call("create_comment", raw);
          const thread = result.structured;
          if (thread.status !== "answered" || thread.comments?.[0]?.author !== "agent") throw new Error("invalid success");
        } catch (error) {
          if (!(error instanceof OperationError)) throw error;
          if (error.data.code === "internal") throw error;
        }
      }
      app.close();
      parentPort.postMessage({ outcome: "refused or valid", count: workerData.corpus.length, importMs, loopMs: performance.now() - loopStarted });
    })().catch((error) => { throw error; });
  `;
  const result = await onSmallStack(script, { root, corpus: wireInputs(20261011, valid) });
  expect(result).toMatchObject({ outcome: "refused or valid", count: 400 });
  expect(result.importMs).toBeLessThan(15_000);
  expect(result.loopMs).toBeLessThan(5_000);
}, 30_000);

// The additive identity extension is another disk boundary: hostile metadata
// must stay a named refusal, including on a small stack.
test("version-6 block identity is refused or valid for arbitrary and edited metadata on a small stack", async () => {
  const valid = {
    ...FILE,
    version: 6,
    threads: [
      {
        ...FILE.threads[0],
        anchor: { kind: "group", id: "frag-0", label: "authorized" },
        identity: { version: 1, fingerprint: `sha256:${"a".repeat(64)}`, unique: true },
      },
    ],
  };
  expect(validateCommentsFile(valid)).toMatchObject({ ok: true, file: { version: 6 } });
  for (const raw of inputs(20261112, valid)) {
    const checked = validateCommentsFile(raw);
    if (!checked.ok) expect(checked.problem.length).toBeGreaterThan(0);
  }
  const module = new URL("../../src/comments/store.ts", import.meta.url).href;
  const script = `
    const { parentPort, workerData } = require("node:worker_threads");
    void (async () => {
      const started = performance.now();
      await import("tsx/esm");
      const { validateCommentsFile } = await import(${JSON.stringify(module)});
      const importMs = performance.now() - started;
      const loopStarted = performance.now();
      for (const raw of workerData.corpus) {
        const result = validateCommentsFile(raw);
        if (!result.ok && typeof result.problem !== "string") throw new Error("invalid refusal");
      }
      parentPort.postMessage({ outcome: "refused or valid", count: workerData.corpus.length, importMs, loopMs: performance.now() - loopStarted });
    })().catch((error) => { throw error; });
  `;
  const result = await onSmallStack(script, { corpus: wireInputs(20261112, valid) });
  expect(result).toMatchObject({ outcome: "refused or valid", count: 400 });
  expect(result.importMs).toBeLessThan(15_000);
  expect(result.loopMs).toBeLessThan(5_000);
}, 30_000);
