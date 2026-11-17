// The doc-pack eval judges (scripts/evals/v1/tasks.mjs, facts.mjs), mutation-checked: a run that does
// what good is passes, and each mutation of it fails exactly the check that names that behaviour.
import { expect, test, vi } from "vitest";
// @ts-expect-error -- a plain .mjs script without types
import { caseLookupChecks, intentBootstrapChecks, TASKS } from "../../scripts/evals/v1/tasks.mjs";
// @ts-expect-error -- a plain .mjs script without types
import { REFUND, TIDEPOOL } from "../../scripts/evals/v1/facts.mjs";

vi.hoisted(() => {
  process.env.ARCHER_EVAL_HOLDOUT = "/nonexistent/archer-evals/holdout.mjs";
});

type Check = { name: string; level: string; pass: boolean };
const failed = (checks: Check[]) => checks.filter((c) => !c.pass).map((c) => c.name);
const URL = "http://127.0.0.1:4000/projects/pageturner/v/refund?follow";

const lookupCtx = (over: Record<string, unknown> = {}) => ({
  calls: [
    { server: "archer", tool: "docs_index", input: { question: "How does a refund work?" }, ok: true },
    { server: "archer", tool: "read_diagram", input: { viewId: "refund" }, ok: true },
    { server: "archer", tool: "present_diagram", input: { viewId: "refund" }, ok: true, urls: [URL], url: URL },
    { server: "archer", tool: "set_emphasis", input: { viewId: "refund" }, ok: true },
  ],
  emphases: [
    {
      viewId: "refund",
      groups: [{ id: "path", style: "flow", label: "Refund path", nodes: ["api", "provider"], edges: ["r2", "r3"] }],
    },
  ],
  finalText: `Here is the refund flow: ${URL}\nStaff start it in the Back office; the Shop API refunds the card through Paystream and the Worker emails the receipt.`,
  changed: [],
  added: [],
  baseline: {},
  files: {},
  ...over,
});

test("case-lookup: the good run passes every check, and an explicit exclusion is no wrong claim", () => {
  expect(failed(caseLookupChecks(lookupCtx(), REFUND))).toEqual([]);
  expect(
    failed(
      caseLookupChecks(
        lookupCtx({ finalText: `${lookupCtx().finalText} It refunds the card, never cash or store credit.` }),
        REFUND,
      ),
    ),
  ).toEqual([]);
});

test.each([
  [
    "presented another view",
    {
      calls: lookupCtx().calls.map((c) =>
        c.tool === "present_diagram" ? { ...c, input: { viewId: "password-reset" } } : c,
      ),
    },
    ["presented and gave the returned URL"],
  ],
  [
    "left the URL out",
    { finalText: "Staff start it; Paystream refunds the card and the Worker emails a receipt." },
    ["presented and gave the returned URL"],
  ],
  [
    "emphasised parts off the path",
    { emphases: [{ viewId: "refund", groups: [{ style: "flow", nodes: ["customer"], edges: [] }] }] },
    ["emphasised the flow's path on it (two or more of its parts)"],
  ],
  [
    "emphasised one part only",
    { emphases: [{ viewId: "refund", groups: [{ style: "flow", nodes: ["staff"], edges: [] }] }] },
    ["emphasised the flow's path on it (two or more of its parts)"],
  ],
  [
    "made the flow up",
    { finalText: `Here: ${URL}\nThe Worker deletes the order, then the customer waits seven days.` },
    ["says what the flow shows (its facts)"],
  ],
  [
    "used highlight, not flow",
    { emphases: [{ viewId: "refund", groups: [{ style: "highlight", nodes: ["api", "provider"], edges: [] }] }] },
    ["emphasis uses the flow style"],
  ],
  [
    "invented a refunds service",
    { finalText: `${lookupCtx().finalText} A separate refunds service handles it.` },
    ["no claim the facts contradict"],
  ],
  [
    "read five docs first",
    {
      calls: [
        ...Array.from({ length: 3 }, () => ({
          server: "archer",
          tool: "read_note",
          input: { notePath: "intent.md" },
          ok: true,
        })),
        ...lookupCtx().calls,
      ],
    },
    ["reached the flow in at most two doc reads"],
  ],
  [
    "searched the code first",
    { calls: [{ server: "shell", tool: "Bash", input: { command: "rg refund src" }, ok: true }, ...lookupCtx().calls] },
    ["read the docs before searching the code"],
  ],
  [
    "wrote an essay",
    { finalText: `${lookupCtx().finalText}\n${"More detail. ".repeat(120)}` },
    ["answer is short (1200 characters or fewer)"],
  ],
  ["changed a file", { changed: [".archer/notes/flows/refund.md"] }, ["no other files changed"]],
])("case-lookup mutation: %s", (_name, over, expected) => {
  expect(failed(caseLookupChecks(lookupCtx(over), REFUND))).toEqual(expected);
});

const INTENT =
  "---\nauthor: agent\ndescription: Why tidepool exists and for whom.\ntype: intent\nstatus: proposed\n---\n# Intent\n\nTidepool serves tide times for harbours over HTTP, from tables imported nightly.\n\n## Non-goals\n\n- A mobile app or login.\n\n## Open questions\n\n1. Who is it for?\n";
const intentCtx = (over: Record<string, unknown> = {}) => ({
  calls: [],
  emphases: [],
  files: { ".archer/intent.md": INTENT },
  finalText:
    "I drafted .archer/intent.md from the code.\n\nWho is it for first?\n- Sailors checking a harbour (recommended)\n- Harbour masters\n- Something else",
  changed: [".archer/intent.md"],
  added: [".archer/intent.md"],
  baseline: {},
  ...over,
});

test("intent-bootstrap: the good run passes every check", () => {
  expect(failed(intentBootstrapChecks(intentCtx(), TIDEPOOL))).toEqual([]);
});

test.each([
  [
    "asked without a draft",
    { files: {}, changed: [], added: [] },
    ["drafted .archer/intent.md before asking (a draft, not a blank form)"],
  ],
  [
    "confirmed it itself",
    {
      files: {
        ".archer/intent.md": INTENT.replace(
          "status: proposed",
          "status: proposed\nconfirmed: 2026-10-22 abc all (chat)",
        ),
      },
    },
    ["never self-confirmed: everything it wrote is proposed"],
  ],
  [
    "confirmed a use case itself",
    {
      files: { ".archer/intent.md": INTENT, ".archer/use-cases.md": "---\nstatus: confirmed\n---\n" },
      added: [".archer/intent.md", ".archer/use-cases.md"],
      changed: [".archer/intent.md", ".archer/use-cases.md"],
    },
    ["never self-confirmed: everything it wrote is proposed"],
  ],
  [
    "left out the nightly import",
    { files: { ".archer/intent.md": INTENT.replace(", from tables imported nightly", "") } },
    ["a draft is drawn from the code (tide, harbou?r, nightly|import)"],
  ],
  [
    "invented a goal in a section other than non-goals",
    {
      files: {
        ".archer/intent.md": INTENT.replace(
          "## Open questions",
          "## Goals\n\n- A subscription plan.\n\n## Open questions",
        ),
      },
    },
    ["invents no users, goals or parts"],
  ],
  [
    "over its cap",
    { files: { ".archer/intent.md": INTENT + "x".repeat(4000) } },
    ["intent is within its 4,000-character cap"],
  ],
  [
    "invented a mobile app",
    { files: { ".archer/intent.md": `${INTENT}It also has a mobile app.\n` } },
    ["invents no users, goals or parts"],
  ],
  [
    "asked five questions at once",
    {
      finalText:
        "Who is it for?\nWhat wins?\nWhat is not a goal?\nWhich case first?\nAnything else? I recommend sailors; or something else.",
    },
    ["asks one question at a time"],
  ],
  [
    "gave no recommendation or way out",
    { finalText: "Who is it for first?" },
    ["offers a recommended answer and a way out"],
  ],
  [
    "asked what the code answers",
    { finalText: "What does this project do?\nI recommend sailors, or something else." },
    ["asks nothing the code answers"],
  ],
  ["changed the code", { changed: [".archer/intent.md", "src/server.js"] }, ["no other files changed"]],
])("intent-bootstrap mutation: %s", (_name, over, expected) => {
  expect(failed(intentBootstrapChecks(intentCtx(over), TIDEPOOL))).toEqual(expected);
});

test("both tasks are in the main set, with the canary on their prompts", () => {
  for (const id of ["case-lookup", "intent-bootstrap"]) {
    const task = TASKS.find((t: { id: string }) => t.id === id);
    expect(task?.set).toBe("main");
  }
});
