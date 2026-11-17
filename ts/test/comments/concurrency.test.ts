import { fork, type ChildProcess } from "node:child_process";
import { performance } from "node:perf_hooks";
import { afterEach, expect, test } from "vitest";
import { fileURLToPath } from "node:url";
import { CommentsStore, type Place } from "../../src/comments/store.ts";
import { findProject } from "../../src/project/index.ts";
import { FLOW, removeTempDirs, tempDir } from "../project/support.ts";

const children: ChildProcess[] = [];
afterEach(() => {
  for (const child of children.splice(0)) child.kill();
  removeTempDirs();
});

test("every acknowledged write survives concurrent real processes, with its person revision", async () => {
  const root = tempDir({ ".archer/flow.mmd": FLOW });
  const store = new CommentsStore(findProject(root));
  const place: Place = { target: "view:flow", path: "flow.comments.json", subject: { kind: "view", elements: null } };
  const thread = store.create(place, { anchor: { kind: "view" }, body: "Initial feedback" }).value;
  const raced = await race(
    root,
    Array.from({ length: 4 }, () => [thread.id]),
    27_000,
  );
  const successful = raced.flatMap((r) => r.successful);
  expect(successful.length, why(raced)).toBeGreaterThan(0);
  const persisted = store.list(place).threads[0]!;
  expect(persisted.comments.length - 1).toBe(successful.length);
  expect(
    persisted.comments
      .slice(1)
      .map((comment) => comment.body)
      .sort(),
  ).toEqual(successful.sort());
  expect(persisted.revision).toBe(1 + successful.length);
}, 30_000); // 120 serialized writes by 4 processes: 1.5 s idle, 7.0 s beside the UI and browser jobs, 20.3 s (timed out) under write throttling

interface Raced {
  successful: string[];
  refusals: unknown[];
}
interface Progress {
  attempts: number;
  ok: number;
  refused: number;
  setupMs: number;
  publishMs: number;
  waitMs: number;
  workMs: number;
  releaseMs: number;
  callMs: number;
}
const phases: string[] = [];
const progress = new Map<string, Progress>();
/** Where the race's time went, for a failure message: child startup, then each writer's lock phases. */
const timeline = (): string =>
  [
    ...phases,
    ...[...progress].map(
      ([who, p]) =>
        `${who}: ${p.ok}/${p.attempts} ok, ${p.refused} refused; ms in calls ${Math.round(p.callMs)}, of which lock setup ` +
        `${Math.round(p.setupMs)}, publish ${Math.round(p.publishMs)}, waiting ${Math.round(p.waitMs)}, work ${Math.round(p.workMs)}, release ${Math.round(p.releaseMs)}`,
    ),
  ].join("; ");

/**
 * Runs the writers and returns their results, or fails with the timeline
 * `withinMs` in: a test timeout has no message, and on CI only the failure
 * block reaches the report (a failed run once lost the console output).
 */
async function race(root: string, tasks: readonly string[][], withinMs: number): Promise<Raced[]> {
  phases.length = 0;
  progress.clear();
  const began = performance.now();
  const mark = (what: string) => phases.push(`${what} at ${Math.round(performance.now() - began)} ms`);
  const ready: Promise<void>[] = [];
  const completed: Promise<Raced>[] = [];
  for (const [index, args] of tasks.entries()) {
    const who = `${args[1] ?? "person"} writer ${index + 1}`;
    const child = fork(fileURLToPath(new URL("./fixtures/writer.ts", import.meta.url)), [root, ...args], {
      execArgv: ["--import", "tsx"],
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    });
    children.push(child);
    ready.push(
      new Promise((resolve, reject) => {
        child.on("message", (msg: { ready?: boolean }) => {
          if (msg.ready) {
            mark(`${who} ready`);
            resolve();
          }
        });
        child.on("error", reject);
        child.on("exit", (code) => {
          if (code !== 0) reject(new Error(`writer exited ${code}`));
        });
      }),
    );
    completed.push(
      new Promise((resolve, reject) => {
        child.on("message", (msg: Partial<Raced> & { progress?: Progress }) => {
          if (msg.progress) progress.set(who, msg.progress);
          if (msg.successful) {
            mark(`${who} done`);
            resolve(msg as Raced);
          }
        });
        child.on("error", reject);
        child.on("exit", (code) => {
          if (code !== 0) reject(new Error(`writer exited ${code}`));
        });
      }),
    );
  }
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`writers unfinished after ${withinMs} ms; ${timeline()}`)), withinMs);
  });
  try {
    await Promise.race([Promise.all(ready), late]);
    for (const child of children) child.send("start");
    return await Promise.race([Promise.all(completed), late]);
  } finally {
    clearTimeout(timer);
  }
}

/** Every refusal with its reason, actor and lock timing, plus where the time went. */
const why = (raced: readonly Raced[]): string =>
  `refusals: ${JSON.stringify(raced.flatMap((r) => r.refusals))}; timeline: ${timeline()}`;

test("an agent reply racing the person's edit never erases the accepted edit or accepted replies", async () => {
  const root = tempDir({ ".archer/flow.mmd": FLOW });
  const store = new CommentsStore(findProject(root));
  const place: Place = { target: "view:flow", path: "flow.comments.json", subject: { kind: "view", elements: null } };
  const thread = store.create(place, { anchor: { kind: "view" }, body: "Original question" }).value;
  store.submit();
  const raced = await race(
    root,
    [
      [thread.id, "agent"],
      [thread.id, "edit", thread.comments[0]!.id],
    ],
    17_000,
  );
  const [agent = [], person = []] = raced.map((r) => r.successful);
  expect(person, why(raced)).toHaveLength(30);
  const persisted = store.list(place).threads[0]!;
  expect(persisted.comments[0]?.body).toBe(person.at(-1));
  expect(persisted.revision).toBe(31);
  expect(persisted.status).toBe("draft");
  expect(
    persisted.comments
      .filter((c) => c.author === "agent")
      .map((c) => c.body)
      .sort(),
  ).toEqual(agent.sort());
  expect(() => store.reply(thread.id, "Answer to old words", "agent", 1)).toThrow(
    expect.objectContaining({ code: "thread_changed" }),
  );
}, 20_000);
