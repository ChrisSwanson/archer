import { expect, test } from "vitest";
import { pickEdge } from "../src/diagrams/edge-picking";

const at = (id: string, distance: number, halfStroke = 1) => ({ id, distance, halfStroke });

test("a press on a connection's visible line picks it, under another connection's wider target", () => {
  expect(pickEdge([at("payments", 9), at("jobs", 0.4)])).toBe("jobs");
});

test("off every line, the nearest connection is picked", () => {
  expect(pickEdge([at("payments", 9), at("jobs", 5)])).toBe("jobs");
});

test("on two lines at once, or as near to both, the one on top is picked", () => {
  expect(pickEdge([at("a", 0.5), at("b", 0)])).toBe("a");
  expect(pickEdge([at("a", 6.2), at("b", 6)])).toBe("a");
});

test("no target, no connection", () => {
  expect(pickEdge([])).toBeUndefined();
});
