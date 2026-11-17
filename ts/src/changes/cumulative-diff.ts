/** Bounded, exact-line cumulative Mermaid diff. No filesystem access. */
export const CUMULATIVE_DIFF_LIMITS = {
  sourceBytes: 262144,
  outputBytes: 524288,
  editDistance: 256,
  work: 2000000,
} as const;
export class CumulativeDiffError extends Error {
  readonly code = "cumulative_diff_invalid";
}
export interface CumulativeDiff {
  text: string;
  complete: boolean;
  bytes: number;
  algorithm: "myers" | "whole-file-replacement";
  added: number;
  removed: number;
  netEffect: "changed" | "none";
}
type Edit = { kind: "equal" | "add" | "remove"; line: string };
const lines = (text: string): string[] => text.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
function validText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= CUMULATIVE_DIFF_LIMITS.sourceBytes &&
    Buffer.byteLength(value) <= CUMULATIVE_DIFF_LIMITS.sourceBytes &&
    Buffer.from(value).toString("utf8") === value
  );
}
function shortest(old: string[], next: string[]): Edit[] | null {
  const frontier = new Map<number, number>([[1, 0]]),
    trace: Map<number, number>[] = [];
  let work = 0;
  for (
    let distance = 0;
    distance <= Math.min(old.length + next.length, CUMULATIVE_DIFF_LIMITS.editDistance);
    distance++
  ) {
    trace.push(new Map(frontier));
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      if (++work > CUMULATIVE_DIFF_LIMITS.work) return null;
      let x =
        diagonal === -distance ||
        (diagonal !== distance && (frontier.get(diagonal - 1) ?? -1) < (frontier.get(diagonal + 1) ?? -1))
          ? (frontier.get(diagonal + 1) ?? 0)
          : (frontier.get(diagonal - 1) ?? 0) + 1;
      let y = x - diagonal;
      while (x < old.length && y < next.length && old[x] === next[y]) {
        if (++work > CUMULATIVE_DIFF_LIMITS.work) return null;
        x++;
        y++;
      }
      frontier.set(diagonal, x);
      if (x >= old.length && y >= next.length) {
        const reversed: Edit[] = [];
        for (let d = trace.length - 1; d >= 0; d--) {
          const previous = trace[d]!,
            k = x - y;
          const previousK =
            k === -d || (k !== d && (previous.get(k - 1) ?? -1) < (previous.get(k + 1) ?? -1)) ? k + 1 : k - 1;
          const previousX = previous.get(previousK) ?? 0,
            previousY = previousX - previousK;
          while (x > previousX && y > previousY) {
            reversed.push({ kind: "equal", line: old[x - 1]! });
            x--;
            y--;
          }
          if (d === 0) break;
          if (x === previousX) {
            reversed.push({ kind: "add", line: next[y - 1]! });
            y--;
          } else {
            reversed.push({ kind: "remove", line: old[x - 1]! });
            x--;
          }
        }
        return reversed.reverse();
      }
    }
  }
  return null;
}
function patch(edits: Edit[], path: string, absent: boolean): string {
  if (absent && edits.length === 0)
    return `diff --git ${JSON.stringify(`baseline/${path}`)} ${JSON.stringify(`latest/${path}`)}\nnew file mode 100644\nindex 0000000..e69de29\n`;
  const ranges: { start: number; end: number }[] = [];
  for (let i = 0; i < edits.length; i++) {
    if (edits[i]!.kind === "equal") continue;
    const start = Math.max(0, i - 3),
      end = Math.min(edits.length, i + 4),
      last = ranges.at(-1);
    if (last && start <= last.end) last.end = Math.max(last.end, end);
    else ranges.push({ start, end });
  }
  const oldBefore = [0],
    nextBefore = [0];
  for (const edit of edits) {
    oldBefore.push(oldBefore.at(-1)! + Number(edit.kind !== "add"));
    nextBefore.push(nextBefore.at(-1)! + Number(edit.kind !== "remove"));
  }
  let result = `--- ${absent ? "/dev/null" : JSON.stringify(`baseline/${path}`)}\n+++ ${JSON.stringify(`latest/${path}`)}\n`;
  for (const { start, end } of ranges) {
    const oldCount = oldBefore[end]! - oldBefore[start]!,
      nextCount = nextBefore[end]! - nextBefore[start]!;
    result += `@@ -${oldBefore[start]! + Number(oldCount > 0)},${oldCount} +${nextBefore[start]! + Number(nextCount > 0)},${nextCount} @@\n`;
    for (let i = start; i < end; i++) {
      const edit = edits[i]!;
      result += `${edit.kind === "equal" ? " " : edit.kind === "add" ? "+" : "-"}${edit.line}${edit.line.endsWith("\n") ? "" : "\n\\ No newline at end of file\n"}`;
    }
  }
  return result;
}
export function cumulativeDiff(before: string | null, after: string, path: string): CumulativeDiff {
  if (
    (before !== null && !validText(before)) ||
    !validText(after) ||
    !validText(path) ||
    !path ||
    path.length > 4096 ||
    /[\\\0-\x1f\x7f]/u.test(path) ||
    path.startsWith("/") ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new CumulativeDiffError("invalid or oversized cumulative diff input");
  if (before === after)
    return { text: "", complete: true, bytes: 0, algorithm: "myers", added: 0, removed: 0, netEffect: "none" };
  const old = lines(before ?? ""),
    next = lines(after),
    minimal = shortest(old, next);
  const edits = minimal ?? [
    ...old.map((line) => ({ kind: "remove" as const, line })),
    ...next.map((line) => ({ kind: "add" as const, line })),
  ];
  const text = patch(edits, path, before === null),
    bytes = Buffer.byteLength(text),
    complete = bytes <= CUMULATIVE_DIFF_LIMITS.outputBytes;
  return {
    text: complete ? text : "",
    complete,
    bytes,
    algorithm: minimal === null ? "whole-file-replacement" : "myers",
    added: edits.filter((e) => e.kind === "add").length,
    removed: edits.filter((e) => e.kind === "remove").length,
    netEffect: "changed",
  };
}
