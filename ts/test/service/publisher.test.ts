// Publisher (project-state/publisher.ts) on its own: one service-wide count, each publication taking the
// next number; a queue holds events until flush (each then counted, in order, a failing listener logged)
// or discard (nothing told, nothing counted); gathering announces each target once, after the run.
import { expect, test } from "vitest";
import { Publisher } from "../../src/service/project-state/publisher.ts";

type E = "a" | "b";

test("each publisher starts at a fresh number of one shared count, and every publication takes the next", () => {
  const one = new Publisher<E>(() => {}),
    two = new Publisher<E>(() => {});
  expect(two.seq).toBe(one.seq + 1);
  const told: [E, unknown, number][] = [];
  one.subscribe((event, payload) => told.push([event, payload, one.seq]));
  one.publish("a", 1);
  expect(one.seq).toBe(two.seq + 1);
  two.publish("b", 2);
  expect(two.seq).toBe(one.seq + 1);
  expect(told).toEqual([["a", 1, one.seq]]);
});

test("a queue holds events until flush, in order, each counted; a failing listener is logged and the rest are told", () => {
  const lines: string[] = [];
  const p = new Publisher<E>((line) => lines.push(line));
  const told: [E, number][] = [];
  p.subscribe(() => {
    throw new Error("broken stream");
  });
  p.subscribe((event) => told.push([event, p.seq]));
  expect(p.queuing).toBe(false);
  p.queue();
  expect(p.queuing).toBe(true);
  const before = p.seq;
  p.publish("a", null);
  p.publish("b", null);
  expect(told).toEqual([]);
  expect(p.seq).toBe(before);
  p.flush();
  expect(p.queuing).toBe(false);
  expect(told).toEqual([
    ["a", before + 1],
    ["b", before + 2],
  ]);
  expect(lines).toEqual([
    "[archer] state publication failed: Error: broken stream",
    "[archer] state publication failed: Error: broken stream",
  ]);
});

test("an unqueued publication lets a listener's failure reach the publisher's caller", () => {
  const p = new Publisher<E>(() => {});
  p.subscribe(() => {
    throw new Error("broken stream");
  });
  expect(() => p.publish("a", null)).toThrow("broken stream");
});

test("discard drops what was held: nothing told, nothing counted", () => {
  const p = new Publisher<E>(() => {});
  const told: E[] = [];
  p.subscribe((event) => told.push(event));
  const before = p.seq;
  p.queue();
  p.publish("a", null);
  p.discard();
  expect(p.queuing).toBe(false);
  expect(told).toEqual([]);
  expect(p.seq).toBe(before);
});

test("unsubscribe and close stop telling a listener", () => {
  const p = new Publisher<E>(() => {});
  const told: string[] = [];
  const first = (e: E) => told.push(`first ${e}`),
    second = (e: E) => told.push(`second ${e}`);
  const off = p.subscribe(first);
  p.subscribe(second);
  off();
  expect(p.has(first)).toBe(false);
  expect(p.has(second)).toBe(true);
  p.publish("a", null);
  p.close();
  p.publish("b", null);
  expect(told).toEqual(["second a"]);
});

test("gathering collects each target once and hands them over after the run, also when it throws; nested runs join the outer", () => {
  const p = new Publisher<E>(() => {});
  expect(p.gather("view:flow")).toBe(false);
  const announced: string[][] = [];
  const result = p.gathering(
    () => {
      expect(p.gather("view:flow")).toBe(true);
      p.gathering(
        () => p.gather("note:a.md"),
        () => announced.push(["inner"]),
      );
      p.gather("view:flow");
      return 7;
    },
    (targets) => announced.push([...targets]),
  );
  expect(result).toBe(7);
  expect(announced).toEqual([["view:flow", "note:a.md"]]);
  expect(() =>
    p.gathering(
      () => {
        p.gather("view:chat");
        throw new Error("second write failed");
      },
      (targets) => announced.push([...targets]),
    ),
  ).toThrow("second write failed");
  expect(announced.at(-1)).toEqual(["view:chat"]);
  expect(p.gather("view:flow")).toBe(false);
});
