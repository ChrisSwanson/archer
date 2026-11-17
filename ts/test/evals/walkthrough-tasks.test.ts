// The walkthrough eval judges (scripts/evals/v1/tasks.mjs, "walkthroughs"): a judge must pass the
// right behaviour and reject presenting the wrong walkthrough, writing unasked, inventing ids, and
// editing the diagram to fit a walkthrough.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
// @ts-expect-error -- a plain .mjs script without types
import { TASKS } from "../../scripts/evals/v1/tasks.mjs";

vi.hoisted(() => {
  process.env.ARCHER_EVAL_HOLDOUT = "/nonexistent/archer-evals/holdout.mjs";
});

type Check = { name: string; level: string; pass: boolean; detail?: string };
type Ctx = Record<string, unknown>;
const task = (id: string) =>
  TASKS.find((t: { id: string }) => t.id === id) as { judge: (ctx: Ctx) => Check[]; setup?: unknown };
const failed = (checks: Check[]) => checks.filter((c) => !c.pass).map((c) => c.name);
const verdict = (checks: Check[]) =>
  checks.some((c) => c.level === "must" && !c.pass) ? "fail" : checks.some((c) => !c.pass) ? "partial" : "pass";

const CONTAINERS = ".archer/diagrams/containers.mmd";
const SIDECAR = ".archer/diagrams/containers.walkthroughs.json";
const CONTAINERS_TEXT = readFileSync(
  fileURLToPath(new URL("../fixtures/pageturner/.archer/diagrams/containers.mmd", import.meta.url)),
  "utf8",
);
const PAGE = "http://127.0.0.1:40123/projects/pageturner/containers?follow&walkthrough=declined-card&step=1";

const call = (tool: string, input: unknown = {}, over: Ctx = {}) => ({
  server: "archer",
  tool,
  input,
  ok: true,
  via: "mcp",
  ...over,
});
const present = (input: unknown, text = "") => call("present_diagram", input, { urls: [PAGE], url: PAGE, text });
function ctx(over: Ctx = {}): Ctx {
  return {
    calls: [],
    finalText: "",
    changed: [],
    added: [],
    files: {},
    baseline: { [CONTAINERS]: CONTAINERS_TEXT },
    compiled: {},
    diagrams: [],
    newNotes: [],
    emphases: [],
    noteEmphases: {},
    projects: [],
    project: "/nonexistent",
    ...over,
  };
}

describe("walkthrough-play", () => {
  const good = () =>
    ctx({
      calls: [
        call("list_diagrams"),
        call("list_walkthroughs", { viewId: "containers" }),
        present({ viewId: "containers", walkthrough: { id: "declined-card", step: 4 }, annotation: "The decline." }),
      ],
      finalText: `The Declined card walkthrough is open at the decline:\n${PAGE}\n\nThe provider reports payment.failed to the Shop API, which releases the stock.`,
    });
  const judge = (over: Ctx = {}) => task("walkthrough-play").judge({ ...good(), ...over });

  it("passes presenting the stored walkthrough, linked, with nothing written", () => {
    expect(failed(judge())).toEqual([]);
  });
  it("accepts a CLI present whose result names the walkthrough", () => {
    const cli = call(
      "present_diagram",
      { viewId: "containers" },
      { via: "cli", urls: [PAGE], url: PAGE, text: "Walkthrough 'declined-card' at step 1 of 5 (current)." },
    );
    expect(failed(judge({ calls: [cli] }))).toEqual([]);
  });
  it("fails presenting the other walkthrough, or emphasis instead", () => {
    expect(
      verdict(judge({ calls: [present({ viewId: "containers", walkthrough: { id: "checkout-and-payment" } })] })),
    ).toBe("fail");
    expect(
      verdict(judge({ calls: [call("set_emphasis", { viewId: "containers" }), present({ viewId: "containers" })] })),
    ).toBe("fail");
  });
  it("fails a write of any kind", () => {
    expect(
      verdict(
        judge({
          calls: [...(good().calls as unknown[]), call("write_walkthrough", { viewId: "containers" })],
          changed: [SIDECAR],
        }),
      ),
    ).toBe("fail");
  });
  it("is partial when the answer is long", () => {
    expect(verdict(judge({ finalText: `${good().finalText}\n${"More detail. ".repeat(120)}` }))).toBe("partial");
  });
});

describe("walkthrough-write", () => {
  const written = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      schemaVersion: 1,
      target: "view:containers",
      walkthroughs: [
        {
          id: "order-ships",
          title: "Order ships",
          steps: [
            {
              title: "Queued",
              kind: "sends",
              what: "A booking is queued.",
              why: "Slow work uses the queue.",
              edges: [{ id: "api--jobs", source: "api", target: "jobs" }],
            },
            {
              title: "Taken",
              kind: "sends",
              what: "The Worker takes it.",
              why: "It owns bookings.",
              edges: [{ id: "worker--jobs", source: "worker", target: "jobs" }],
            },
            {
              title: "Booked",
              kind: "sends",
              what: "A collection is booked.",
              why: "Over HTTPS.",
              edges: [{ id: "worker--courier", source: "worker", target: "courier" }],
            },
            {
              title: "Collected",
              kind: "does",
              what: "The courier collects.",
              why: "Last mile.",
              nodes: [{ kind: "node", id: "courier" }],
            },
          ],
          ...over,
        },
      ],
    });
  const run = (over: Ctx = {}) =>
    ctx({
      calls: [
        call("list_diagrams"),
        call("read_diagram", { viewId: "containers" }),
        call("write_walkthrough", { viewId: "containers" }),
        present({ viewId: "containers", walkthrough: { id: "order-ships" } }),
      ],
      finalText: `Here is the walkthrough:\n${PAGE}`,
      changed: [SIDECAR],
      added: [SIDECAR],
      files: { [SIDECAR]: written() },
      ...over,
    });
  const judge = (over: Ctx = {}) => task("walkthrough-write").judge(run(over));

  it("passes a walkthrough written from the diagram's ids after reading it, then presented", () => {
    expect(failed(judge())).toEqual([]);
  });
  it("fails an invented id, too few steps, a write before reading, or a diagram edit", () => {
    expect(
      verdict(
        judge({
          files: {
            [SIDECAR]: written({
              steps: [{ title: "x", kind: "sends", what: "y", why: "z", edges: [{ id: "api--stripe" }] }],
            }),
          },
        }),
      ),
    ).toBe("fail");
    expect(
      verdict(
        judge({
          calls: [
            call("write_walkthrough"),
            call("read_diagram", { viewId: "containers" }),
            present({ viewId: "containers" }),
          ],
        }),
      ),
    ).toBe("fail");
    expect(
      verdict(
        judge({
          calls: [...(run().calls as unknown[]), call("write_diagram", { viewId: "containers" })],
          changed: [SIDECAR, CONTAINERS],
        }),
      ),
    ).toBe("fail");
    expect(verdict(judge({ files: {}, added: [], changed: [] }))).toBe("fail");
  });
});

describe("walkthrough-repair", () => {
  const good = () =>
    ctx({
      calls: [call("list_stale_diagrams"), call("list_walkthroughs", { viewId: "containers", id: "order-ships" })],
      finalText:
        "Not entirely: in 'Order ships', steps 4 and 5 (the courier booking and collection) are out of date because the courier was renamed. I can repair them if you want.",
    });
  const judge = (over: Ctx = {}) => task("walkthrough-repair").judge({ ...good(), ...over });

  it("passes finding the out-of-date courier steps and offering the repair", () => {
    expect(failed(judge())).toEqual([]);
  });
  it("fails editing the diagram to fit the walkthrough", () => {
    expect(
      verdict(
        judge({
          calls: [...(good().calls as unknown[]), call("write_diagram", { viewId: "containers" })],
          changed: [CONTAINERS],
        }),
      ),
    ).toBe("fail");
  });
  it("fails saying nothing is wrong, or never looking", () => {
    expect(verdict(judge({ finalText: "Yes, the walkthroughs are still right." }))).toBe("fail");
    expect(verdict(judge({ calls: [] }))).toBe("fail");
  });
  it("fails when it repairs unasked", () => {
    expect(
      verdict(
        judge({
          calls: [...(good().calls as unknown[]), call("write_walkthrough", { viewId: "containers" })],
          changed: [SIDECAR],
        }),
      ),
    ).toBe("fail");
  });
});

describe("walkthrough-comment", () => {
  const COMMENTS = ".archer/diagrams/containers.comments.json";
  const ids = [
    "amira-checks-out",
    "the-order-is-placed",
    "a-payment-session-opens",
    "the-card-is-declined",
    "stock-is-released",
  ];
  const sidecar = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      walkthroughs: [
        {
          id: "declined-card",
          steps: ids.map((id) => ({
            id,
            what: "x",
            why: "y",
            ...(id === "the-card-is-declined" ? { what: "Webhook payment.failed, its signature checked first." } : {}),
            ...over,
          })),
        },
      ],
    });
  const thread = (status: string) =>
    JSON.stringify({ threads: [{ id: "t-declined", status, comments: [{ author: "person" }, { author: "agent" }] }] });
  const good = () =>
    ctx({
      calls: [
        call("get_comments"),
        call("write_walkthrough", { viewId: "containers" }),
        call("reply_comment"),
        call("resolve_comment"),
      ],
      changed: [SIDECAR, COMMENTS],
      files: { [SIDECAR]: sidecar(), [COMMENTS]: thread("resolved") },
    });
  const judge = (over: Ctx = {}) => task("walkthrough-comment").judge({ ...good(), ...over });

  it("passes fixing the step in place, keeping its id, replying and resolving", () => {
    expect(failed(judge())).toEqual([]);
  });
  it("fails when the step's id changed, or the text does not say it", () => {
    const renamed = JSON.stringify({
      walkthroughs: [
        {
          id: "declined-card",
          steps: ids.map((id) => ({
            id: id === "the-card-is-declined" ? "declined" : id,
            what: "signature checked",
            why: "y",
          })),
        },
      ],
    });
    expect(verdict(judge({ files: { [SIDECAR]: renamed, [COMMENTS]: thread("resolved") } }))).toBe("fail");
    expect(
      verdict(
        judge({ files: { [SIDECAR]: sidecar({ what: "unchanged", why: "y" }), [COMMENTS]: thread("resolved") } }),
      ),
    ).toBe("fail");
  });
  it("fails without a reply, and only partly passes unresolved", () => {
    expect(
      verdict(
        judge({
          files: {
            [SIDECAR]: sidecar(),
            [COMMENTS]: JSON.stringify({
              threads: [{ id: "t-declined", status: "read", comments: [{ author: "person" }] }],
            }),
          },
        }),
      ),
    ).toBe("fail");
    expect(verdict(judge({ files: { [SIDECAR]: sidecar(), [COMMENTS]: thread("answered") } }))).toBe("partial");
  });
  it("fails editing the diagram", () => {
    expect(verdict(judge({ changed: [SIDECAR, COMMENTS, CONTAINERS] }))).toBe("fail");
  });
});

it("every walkthrough task has a prompt, and the seeded ones a setup", () => {
  for (const id of ["walkthrough-play", "walkthrough-write", "walkthrough-repair", "walkthrough-comment"])
    expect(task(id)).toBeDefined();
  expect(task("walkthrough-play").setup).toBeTypeOf("function");
  expect(task("walkthrough-repair").setup).toBeTypeOf("function");
  expect(task("walkthrough-comment").setup).toBeTypeOf("function");
});
