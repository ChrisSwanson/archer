// A separate real process, not a store fake. Each acknowledged write must persist.
// Every refusal is recorded with its reason and lock timing, and progress is
// reported after each attempt, so a failed count or a timeout says why.
import { performance } from "node:perf_hooks";
import { CommentsLockError, lastCommentsLockTiming } from "../../../src/comments/lock.ts";
import { CommentsStore } from "../../../src/comments/store.ts";
import { findProject } from "../../../src/project/index.ts";
const [root, threadId, actor = "person", commentId] = process.argv.slice(2);
if (!root || !threadId) throw new Error("missing fixture arguments");
const store = new CommentsStore(findProject(root));
process.send?.({ ready: true });
process.once("message", () => {
  const successful: string[] = [];
  const refusals: unknown[] = [];
  const spent = { setupMs: 0, publishMs: 0, waitMs: 0, workMs: 0, releaseMs: 0, callMs: 0 };
  for (let i = 0; i < 30; i++) {
    const body = `${process.pid}:${i}:` + "x".repeat(2000);
    const began = performance.now();
    try {
      if (actor === "agent") store.reply(threadId, body, "agent", 1);
      else if (actor === "edit") store.edit(threadId, commentId!, body);
      else store.reply(threadId, body, "person");
      successful.push(body);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code !== "thread_changed" && code !== "write_conflict") throw error;
      const cause = (error as { cause?: unknown }).cause;
      refusals.push({
        actor,
        attempt: i,
        code,
        message: (error as Error).message,
        elapsedMs: Math.round(performance.now() - began),
        lock: { ...(cause instanceof CommentsLockError ? cause.timing : lastCommentsLockTiming()) },
      });
    }
    const lock = lastCommentsLockTiming();
    spent.callMs += performance.now() - began;
    if (lock)
      for (const key of ["setupMs", "publishMs", "waitMs", "workMs", "releaseMs"] as const) spent[key] += lock[key];
    process.send?.({ progress: { attempts: i + 1, ok: successful.length, refused: refusals.length, ...spent } });
  }
  // Disconnect only once the result is written: a disconnect right after
  // send dropped it when the parent read slowly (the channel was backed up).
  process.send?.({ successful, refusals }, () => process.disconnect?.());
});
