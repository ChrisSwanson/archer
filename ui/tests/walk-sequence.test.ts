// The Sequence tab's model (ADR 0034 §6, "Sequence tab"): a walkthrough's messages as a projected
// sequence, and the page-built emphasis that lights the current one. Pure.
import { describe, expect, it } from "vitest";
import { assignEmphasis } from "../src/emphasis/contract";
import type { Walk, WalkStep } from "../src/walkthroughs/contract";
import { hasMessages, layoutWalkSequence, sequenceEmphasis } from "../src/walkthroughs/walk-sequence";

const LABELS: Record<string, string> = {
  customer: "Customer",
  web: "Storefront",
  api: "Shop API",
  db: "Shop database",
  pay: "Payments",
};
const labelOf = (id: string) => LABELS[id] ?? id;
const msg = (from: string, to: string, label: string) => ({ from, to, label });
const step = (title: string, messages: WalkStep["messages"], over: Partial<WalkStep> = {}): WalkStep => ({
  id: title.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
  title,
  kind: "sends",
  what: "w",
  code: [],
  nodes: [],
  edges: [],
  messages,
  status: "current",
  ...over,
});
const declined: Walk = {
  id: "declined",
  title: "Declined card",
  modelRevision: "r",
  open: [],
  status: "current",
  outOfDate: [],
  steps: [
    step("Pay", [msg("customer", "web", "pay"), msg("web", "api", "POST /pay")]),
    step("Reserve", [], { kind: "does" }),
    step("Charge", [msg("api", "pay", "charge")]),
    step("Declined", [msg("pay", "api", "declined"), msg("api", "db", "release stock")]),
  ],
};

describe("layoutWalkSequence's model", () => {
  const built = layoutWalkSequence(declined, labelOf);

  it("has the endpoints as participants in order of first appearance, labelled from the host", () => {
    expect(built.participants.map((p) => [p.id, p.label])).toEqual([
      ["customer", "Customer"],
      ["web", "Storefront"],
      ["api", "Shop API"],
      ["pay", "Payments"],
      ["db", "Shop database"],
    ]);
  });

  it("has one row per hop in step order, skipping a step without messages, each mapped back to its step", () => {
    expect(built.rows.map((e) => [e.id, e.step, e.from, e.to, e.label])).toEqual([
      ["msg-1-1", 1, "customer", "web", "pay"],
      ["msg-1-2", 1, "web", "api", "POST /pay"],
      ["msg-3-1", 3, "api", "pay", "charge"],
      ["msg-4-1", 4, "pay", "api", "declined"],
      ["msg-4-2", 4, "api", "db", "release stock"],
    ]);
    expect(built.rows.map((r) => r.first)).toEqual([true, false, true, true, false]);
  });

  it("is hidden when no step has messages", () => {
    expect(hasMessages(declined)).toBe(true);
    expect(hasMessages({ ...declined, steps: [step("a", [])] })).toBe(false);
  });
});

describe("sequenceEmphasis", () => {
  const groups = (at: number, w: Walk = declined) =>
    Object.fromEntries((sequenceEmphasis(w, at)?.groups ?? []).map((g) => [g.id, g]));

  it("lights the current step's messages as a teal flow and walked ones quietly", () => {
    const g = groups(4);
    expect(g["walk-active"]).toMatchObject({
      style: "flow",
      edges: ["msg-4-1", "msg-4-2"],
      nodes: ["pay", "api", "db"],
    });
    expect(g["walk-walked"]).toMatchObject({
      style: "highlight",
      tone: "walked",
      edges: ["msg-1-1", "msg-1-2", "msg-3-1"],
    });
  });

  it("lights nothing on a step with no messages, but earlier ones stay walked", () => {
    const g = groups(2);
    expect(g["walk-active"]).toBeUndefined();
    expect(g["walk-walked"]?.edges).toEqual(["msg-1-1", "msg-1-2"]);
  });

  it("draws nothing for an out-of-date step", () => {
    const w: Walk = {
      ...declined,
      steps: declined.steps.map((s, i) => (i === 2 ? { ...s, status: "out-of-date" as const } : s)),
    };
    const g = groups(4, w);
    expect(g["walk-walked"]?.edges).toEqual(["msg-1-1", "msg-1-2"]);
    expect(Object.keys(groups(3, w))).not.toContain("walk-active");
  });

  it("is what the canvases already assign: classes per message", () => {
    const a = assignEmphasis(sequenceEmphasis(declined, 4));
    expect(a.edges.get("msg-4-1")?.classes).toContain("archer-emph-style-flow");
    expect(a.edges.get("msg-1-1")?.classes).toContain("archer-emph--walked");
  });

  it("is nothing for an archived walkthrough", () => {
    expect(sequenceEmphasis({ ...declined, status: "archived" }, 1)).toBeNull();
  });
});

describe("layoutWalkSequence", () => {
  const lay = layoutWalkSequence(declined, labelOf);

  it("puts the participants on even columns and one row under another per message", () => {
    const xs = lay.participants.map((p) => p.x);
    expect(xs.slice(1).map((x, i) => x - xs[i]!)).toEqual([76, 76, 76, 76]);
    const ys = lay.rows.map((r) => r.y);
    expect(ys.slice(1).map((y, i) => y - ys[i]!)).toEqual([38, 38, 38, 38]);
    expect(lay.width).toBeGreaterThan(xs[4]!);
    expect(lay.height).toBeGreaterThan(ys[4]!);
  });

  it("runs each message from its sender's column to its receiver's, and marks a step's first row", () => {
    const x = Object.fromEntries(lay.participants.map((p) => [p.id, p.x]));
    expect(lay.rows.map((r) => [r.fromX, r.toX])).toEqual(lay.rows.map((r) => [x[r.from], x[r.to]]));
    expect(lay.rows.map((r) => [r.step, r.first])).toEqual([
      [1, true],
      [1, false],
      [3, true],
      [4, true],
      [4, false],
    ]);
  });

  it("wraps a long participant name to two lines", () => {
    const wide = layoutWalkSequence(declined, (id) => (id === "db" ? "Shop database server cluster" : labelOf(id)));
    expect(wide.participants.find((p) => p.id === "db")?.lines.length).toBe(2);
    expect(lay.participants[0]?.lines).toEqual(["Customer"]);
  });
});

describe("layoutWalkSequence edges", () => {
  it("is wide enough for a self-message's label on the last participant", () => {
    const w: Walk = {
      ...declined,
      steps: [step("Loop", [msg("customer", "web", "go"), msg("web", "web", "validate the order")])],
    };
    const lay = layoutWalkSequence(w, labelOf);
    expect(lay.width).toBeGreaterThanOrEqual(lay.participants[1]!.x + 20 + 6 + "validate the order".length * 6.9);
  });

  it("cuts a single long word", () => {
    const lay = layoutWalkSequence(declined, (id) => (id === "web" ? "PaymentGatewayService" : id));
    expect(lay.participants[1]!.lines).toEqual(["PaymentGa…"]);
  });
});
