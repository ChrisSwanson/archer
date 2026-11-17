// The answer-from-docs eval judges (scripts/evals/v1/tasks.mjs, "answer from the docs"), held to
// the fresh-eyes review's finding 1: a judge must reject an answer that emphasises the wrong path,
// invents a component, draws a new diagram where one exists, or changes the documentation.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
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
  TASKS.find((t: { id: string }) => t.id === id) as { judge: (ctx: Ctx) => Check[]; prompt: string };
const verdict = (checks: Check[]) =>
  checks.some((c) => c.level === "must" && !c.pass) ? "fail" : checks.some((c) => !c.pass) ? "partial" : "pass";
const failed = (checks: Check[]) => checks.filter((c) => !c.pass).map((c) => c.name);

const CHECKOUT = ".archer/diagrams/checkout.mmd";
const CHECKOUT_TEXT = readFileSync(
  fileURLToPath(new URL("../fixtures/pageturner/.archer/diagrams/checkout.mmd", import.meta.url)),
  "utf8",
);
const CHECKOUT_REVISION = `sha256:${createHash("sha256").update(CHECKOUT_TEXT).digest("hex")}`;
const PAGE = "http://127.0.0.1:40123/projects/pageturner/checkout?follow";

const present = (viewId: string, url = PAGE) => ({
  server: "archer",
  tool: "present_diagram",
  input: { viewId },
  ok: true,
  via: "mcp",
  urls: [url],
  url,
});
const read = (viewId: string) => ({ server: "archer", tool: "read_diagram", input: { viewId }, ok: true, via: "mcp" });
const emphasis = (viewId: string, groups: unknown[]) => ({ viewId, id: "answer", groups });
const flow = (label: string, edges: string[], nodes: string[] = []) => ({
  id: label.toLowerCase().replace(/\W+/g, "-"),
  style: "flow",
  label,
  edges,
  nodes,
});

/** A run's evidence, as judge.mjs builds it: by default nothing changed and nothing was called. */
function ctx(over: Ctx = {}): Ctx {
  return {
    calls: [],
    finalText: "",
    changed: [],
    added: [],
    files: {},
    baseline: {},
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

// ---- explain-existing: answer from the checkout diagram with emphasis

const GOOD_ANSWER = `Payment runs on the provider's hosted page; I've highlighted it on the checkout diagram:\n${PAGE}\n\nThe Shop API creates a payment session, the customer pays on the provider's page, and the provider's webhook tells the API whether to mark the order Paid or release the stock.`;
const goodPath = [
  flow("Payment session", ["msg-3", "msg-4", "msg-5", "msg-6"]),
  flow("Customer pays", ["msg-7"]),
  flow("Webhook outcome", ["msg-8", "msg-9", "msg-12", "msg-13"]),
];
const existingRun = (over: Ctx = {}) =>
  ctx({
    calls: [
      read("checkout"),
      { server: "archer", tool: "set_emphasis", input: { viewId: "checkout" }, ok: true, via: "mcp" },
      present("checkout"),
    ],
    finalText: GOOD_ANSWER,
    emphases: [emphasis("checkout", goodPath)],
    ...over,
  });

describe("explain-existing", () => {
  const judge = (over?: Ctx) => task("explain-existing").judge(existingRun(over));

  it("passes an answer from the checkout diagram: the payment path emphasised in order, presented, linked, short", () => {
    expect(failed(judge())).toEqual([]);
  });

  it("fails an emphasis on the wrong path (the email and courier side effects)", () => {
    const wrong = [flow("Confirmation email", ["msg-10"], ["jobs"]), flow("Order saved", ["msg-1", "msg-2"])];
    expect(verdict(judge({ emphases: [emphasis("checkout", wrong)] }))).toBe("fail");
  });

  it("fails an emphasis that stops before the provider reports the outcome", () => {
    expect(verdict(judge({ emphases: [emphasis("checkout", goodPath.slice(0, 2))] }))).toBe("fail");
  });

  it("fails an answer that invents a component the documentation does not have", () => {
    for (const invented of [
      "The API Gateway forwards the card to Stripe.",
      "A fraud check service scores the order first.",
      "Kafka carries the webhook to the API.",
    ])
      expect(verdict(judge({ finalText: `${GOOD_ANSWER}\n${invented}` })), invented).toBe("fail");
  });

  it("fails a new diagram drawn when the documented one covers the question", () => {
    const drawn = judge({
      added: [".archer/notes/payment-flow.md"],
      changed: [".archer/notes/payment-flow.md"],
      calls: [
        ...(existingRun().calls as unknown[]),
        {
          server: "archer",
          tool: "write_diagram",
          input: { viewId: "notes/payment-flow.md#payment" },
          ok: true,
          via: "mcp",
        },
      ],
    });
    expect(verdict(drawn)).toBe("fail");
  });

  it("fails a change to the documented diagram", () => {
    expect(verdict(judge({ changed: [CHECKOUT], files: { [CHECKOUT]: `${CHECKOUT_TEXT}%% step numbers\n` } }))).toBe(
      "fail",
    );
  });

  it("fails without the link, and is partial for a wall of text or groups out of travel order", () => {
    expect(verdict(judge({ finalText: GOOD_ANSWER.replace(PAGE, "(see Archer)") }))).toBe("fail");
    expect(verdict(judge({ finalText: `${GOOD_ANSWER}\n${"More detail on each step. ".repeat(60)}` }))).toBe("partial");
    expect(failed(judge({ emphases: [emphasis("checkout", [...goodPath].reverse())] }))).toEqual([
      "groups follow the path in order",
    ]);
  });

  it("fails a link to another presented view, and an answer that is only a link", () => {
    const other = "http://127.0.0.1:40123/projects/pageturner/order-lifecycle?follow";
    expect(
      verdict(
        judge({
          calls: [present("checkout"), present("order-lifecycle", other)],
          finalText: GOOD_ANSWER.replace(PAGE, other),
        }),
      ),
    ).toBe("fail");
    expect(verdict(judge({ finalText: PAGE }))).toBe("fail");
  });

  it("is not fooled by one off-path step inside a payment group, but fails a group that is mostly email", () => {
    expect(
      verdict(
        judge({
          emphases: [
            emphasis("checkout", [goodPath[0], goodPath[1], flow("Payment confirmed", ["msg-8", "msg-9", "msg-10"])]),
          ],
        }),
      ),
    ).toBe("pass");
    expect(
      verdict(
        judge({
          emphases: [
            emphasis(
              "checkout",
              [
                ...goodPath.slice(0, 2),
                flow("Webhook outcome", ["msg-8"]),
                flow("Emails", ["msg-10", "msg-9"], ["jobs"]),
              ].slice(1),
            ),
          ],
        }),
      ),
    ).toBe("fail");
  });

  it("names the reused containers diagram by its own name", () => {
    const containers = [
      flow("Payment session", ["api--payments"], ["payments"]),
      flow("Webhook outcome", ["payments--api"]),
    ];
    const text = GOOD_ANSWER.replace("checkout diagram", "containers diagram").replace(
      PAGE,
      "http://127.0.0.1:40123/projects/pageturner/containers?follow",
    );
    const checks = judge({
      calls: [present("containers", "http://127.0.0.1:40123/projects/pageturner/containers?follow")],
      emphases: [emphasis("containers", containers)],
      finalText: text,
    });
    expect(failed(checks)).toEqual(["answers from the checkout sequence"]);
  });

  it("accepts the containers diagram, judged by its own payment parts", () => {
    const containers = [
      flow("Payment session", ["api--payments"], ["payments"]),
      flow("Webhook outcome", ["payments--api"]),
    ];
    const checks = judge({
      calls: [read("containers"), present("containers")],
      emphases: [emphasis("containers", containers)],
    });
    expect(verdict(checks)).toBe("partial");
    expect(failed(checks)).toEqual(["answers from the checkout sequence", "names the diagram it reused"]);
    expect(
      verdict(
        judge({
          calls: [present("containers")],
          emphases: [emphasis("containers", [flow("Emails", ["worker--email"], ["email"])])],
        }),
      ),
    ).toBe("fail");
  });
});

// ---- explain-more-detail: elaborate in a derived copy; the documentation is untouched

const COPY = ".archer/notes/scratch/checkout-webhook.md";
const COPY_VIEW = "notes/scratch/checkout-webhook.md#webhook";
const COPY_SOURCE = `%% archer-id: webhook
sequenceDiagram
    actor customer as Customer
    participant web as Storefront
    participant api as Shop API
    participant db as Shop database
    participant payments as Payment provider
    participant jobs as Job queue
    api->>payments: Create a payment session
    customer->>payments: Pay by card
    payments-)api: Webhook payment.succeeded or payment.failed
    api->>api: Verify the webhook signature
    api->>db: Was this event id processed already?
    alt new event
        api->>db: Record the outcome on the Payment row
        api->>db: Mark the order Paid, or release the stock
    else seen before
        api-->>payments: 200, ignored
    end
`;
const copyNote = (
  front = `author: agent\ndescription: The checkout webhook step in more detail.\nbased-on: checkout@${CHECKOUT_REVISION}`,
) =>
  `---\n${front}\n---\n\n# Checkout webhook in detail\n\nAdds what the checkout diagram leaves out: the signature check and duplicate events.\n\n\`\`\`mermaid\n${COPY_SOURCE}\`\`\`\n`;
const detailRun = (over: Ctx = {}, note = copyNote()) => {
  const frontMatter = /^---\n([\s\S]*?)\n---/.exec(note)?.[1] ?? "";
  return ctx({
    calls: [
      read("checkout"),
      present(COPY_VIEW, "http://127.0.0.1:40123/projects/pageturner/notes/scratch/checkout-webhook.md#webhook"),
    ],
    finalText:
      "I made a copy of the checkout diagram with the webhook in detail; the documented one is unchanged:\nhttp://127.0.0.1:40123/projects/pageturner/notes/scratch/checkout-webhook.md#webhook",
    changed: [COPY],
    added: [COPY],
    files: { [COPY]: note },
    newNotes: [{ path: COPY, frontMatter }],
    diagrams: [
      { path: COPY, viewId: COPY_VIEW, name: "webhook", source: COPY_SOURCE, compiled: "compiled", pinnedInside: true },
    ],
    emphases: [emphasis(COPY_VIEW, [flow("Webhook checks", ["msg-1", "msg-2"])])],
    ...over,
  });
};

describe("explain-more-detail", () => {
  const judge = (over?: Ctx, note?: string) => task("explain-more-detail").judge(detailRun(over, note));

  it("passes a derived copy in scratch: provenance at the original's revision, the detail added, presented and emphasised", () => {
    expect(failed(judge())).toEqual([]);
  });

  it("fails when the documented diagram changed, by a byte", () => {
    expect(
      verdict(
        judge({
          changed: [COPY, CHECKOUT],
          files: { [COPY]: copyNote(), [CHECKOUT]: CHECKOUT_TEXT.replace("Pay by card", "Pay by card ") },
        }),
      ),
    ).toBe("fail");
  });

  it("fails a copy without exact provenance: none, no revision, another view, a mistyped revision", () => {
    for (const from of [
      "",
      "\nbased-on: checkout",
      "\nbased-on: checkout-other",
      `\nbased-on: checkout@${CHECKOUT_REVISION.slice(0, -1)}0`,
      `\nbased-on: order-lifecycle@${CHECKOUT_REVISION}`,
    ])
      expect(
        verdict(judge(undefined, copyNote(`author: agent\ndescription: The webhook in detail.${from}`))),
        from,
      ).toBe("fail");
    expect(
      verdict(
        judge(
          undefined,
          copyNote(`author: agent\ndescription: x\nbased-on: diagrams/checkout.mmd@${CHECKOUT_REVISION}`),
        ),
      ),
    ).toBe("pass");
  });

  it("fails a rewrite that keeps the asked-for words only in comments, or drops the documented steps", () => {
    const stuffed =
      "%% archer-id: webhook\nsequenceDiagram\n    participant api as Shop API\n    %% signature duplicate payment session payment.succeeded payment.failed Pay by card Payment row\n    api->>api: Mark the order Paid\n";
    expect(
      verdict(
        judge({
          diagrams: [
            {
              path: COPY,
              viewId: COPY_VIEW,
              name: "webhook",
              source: stuffed,
              compiled: "compiled",
              pinnedInside: true,
            },
          ],
        }),
      ),
    ).toBe("fail");
  });

  it("passes a faithful copy reworded, and a zoom on the webhook step is partial", () => {
    const reworded = COPY_SOURCE.replace("Pay by card", "Submit card details").replace(
      "Record the outcome on the Payment row",
      "Record Payment succeeded",
    );
    expect(
      failed(
        judge({
          diagrams: [
            {
              path: COPY,
              viewId: COPY_VIEW,
              name: "webhook",
              source: reworded,
              compiled: "compiled",
              pinnedInside: true,
            },
          ],
        }),
      ),
    ).toEqual([]);
    const zoom = COPY_SOURCE.replace(/^\s*actor customer.*\n/m, "")
      .replace(/^\s*participant web.*\n/m, "")
      .replace(/^.*customer->>.*\n/m, "");
    expect(
      failed(
        judge({
          diagrams: [
            { path: COPY, viewId: COPY_VIEW, name: "webhook", source: zoom, compiled: "compiled", pinnedInside: true },
          ],
        }),
      ),
    ).toEqual(["the copy keeps the whole flow, not one step"]);
  });

  it("fails a copy outside notes/scratch/", () => {
    const elsewhere = ".archer/notes/checkout-webhook.md";
    const run = detailRun();
    expect(
      verdict(
        task("explain-more-detail").judge({
          ...run,
          changed: [elsewhere],
          added: [elsewhere],
          files: { [elsewhere]: copyNote() },
          newNotes: [{ ...(run.newNotes as Record<string, unknown>[])[0], path: elsewhere }],
          diagrams: [{ ...(run.diagrams as Record<string, unknown>[])[0], path: elsewhere }],
        }),
      ),
    ).toBe("fail");
  });

  it("fails a copy that does not add the asked-for detail, or invents a component", () => {
    const thin = COPY_SOURCE.replace(/.*signature.*\n/, "").replace(/.*already.*\n/, "");
    expect(
      verdict(
        judge({
          diagrams: [
            { path: COPY, viewId: COPY_VIEW, name: "webhook", source: thin, compiled: "compiled", pinnedInside: true },
          ],
        }),
      ),
    ).toBe("fail");
    const invented = `${COPY_SOURCE}    participant fraud as Fraud service\n    api->>fraud: Score the payment\n`;
    expect(
      verdict(
        judge({
          diagrams: [
            {
              path: COPY,
              viewId: COPY_VIEW,
              name: "webhook",
              source: invented,
              compiled: "compiled",
              pinnedInside: true,
            },
          ],
        }),
      ),
    ).toBe("fail");
  });

  it("fails when only the original is presented, not the copy", () => {
    expect(verdict(judge({ calls: [read("checkout"), present("checkout")], finalText: `See ${PAGE}` }))).toBe("fail");
  });
});

// ---- explain-missing: no diagram covers it, so a new one in scratch, and it says so

const SCRATCH = ".archer/notes/scratch/restocking.md";
const SCRATCH_VIEW = "notes/scratch/restocking.md#restocking";
const RESTOCK = `%% archer-id: restocking
flowchart LR
  staff([Shop staff]) s1@--> backoffice[Back office]
  backoffice s2@-->|delivery counts| api[Shop API]
  api s3@-->|adds copies to stock| db[(Shop database)]
  api s4@-->|back in stock emails| jobs[Job queue]
  worker[Worker] s5@-->|takes work| jobs
  worker s6@--> email[Email service]
`;
const missingRun = (over: Ctx = {}) =>
  ctx({
    calls: [
      { server: "archer", tool: "list_diagrams", input: {}, ok: true, via: "mcp" },
      present(SCRATCH_VIEW, "http://127.0.0.1:40123/projects/pageturner/notes/scratch/restocking.md#restocking"),
    ],
    finalText:
      "No existing diagram covered restocking, so I drew one in a scratch note:\nhttp://127.0.0.1:40123/projects/pageturner/notes/scratch/restocking.md#restocking",
    changed: [SCRATCH],
    added: [SCRATCH],
    files: {
      [SCRATCH]: `---\nauthor: agent\ndescription: How a delivery restocks the shop.\n---\n\n\`\`\`mermaid\n${RESTOCK}\`\`\`\n`,
    },
    newNotes: [{ path: SCRATCH, frontMatter: "author: agent\ndescription: How a delivery restocks the shop." }],
    diagrams: [
      {
        path: SCRATCH,
        viewId: SCRATCH_VIEW,
        name: "restocking",
        source: RESTOCK,
        compiled: "compiled",
        pinnedInside: true,
        longLabels: [],
        labelWarnings: 0,
      },
    ],
    ...over,
  });

describe("explain-missing", () => {
  const judge = (over?: Ctx) => {
    const c = missingRun(over);
    c.newDiagram ??= (c.diagrams as unknown[])[0];
    return task("explain-missing").judge(c);
  };

  it("passes a new scratch diagram that says none existed", () => {
    expect(failed(judge())).toEqual([]);
  });

  it("fails an answer that does not say no diagram covered it", () => {
    expect(
      verdict(
        judge({
          finalText:
            "Here is restocking:\nhttp://127.0.0.1:40123/projects/pageturner/notes/scratch/restocking.md#restocking",
        }),
      ),
    ).toBe("fail");
  });

  it("fails a restocking drawn into an existing diagram", () => {
    expect(
      verdict(
        judge({
          changed: [".archer/diagrams/containers.mmd"],
          added: [],
          newNotes: [],
          diagrams: [],
          files: { ".archer/diagrams/containers.mmd": "C4Container\n" },
        }),
      ),
    ).toBe("fail");
  });

  it('accepts "the diagrams don\'t show restocking", and fails a drawing that leaves out what the person said', () => {
    expect(
      verdict(
        judge({
          finalText:
            "The diagrams don't show restocking, so here is a new one:\nhttp://127.0.0.1:40123/projects/pageturner/notes/scratch/restocking.md#restocking",
        }),
      ),
    ).toBe("pass");
    const thin = "%% archer-id: restocking\nflowchart LR\n  backoffice[Back office] s1@--> stock[Stock]\n";
    const d = {
      path: SCRATCH,
      viewId: SCRATCH_VIEW,
      name: "restocking",
      source: thin,
      compiled: "compiled",
      pinnedInside: true,
      longLabels: [],
      labelWarnings: 0,
    };
    expect(verdict(judge({ diagrams: [d], newDiagram: d }))).toBe("fail");
  });

  it("fails an invented component, and a new note outside scratch", () => {
    const invented = `${RESTOCK}  api s7@--> wms[Warehouse management system]\n`;
    expect(
      verdict(
        judge({
          diagrams: [
            {
              path: SCRATCH,
              viewId: SCRATCH_VIEW,
              name: "restocking",
              source: invented,
              compiled: "compiled",
              pinnedInside: true,
              longLabels: [],
              labelWarnings: 0,
            },
          ],
        }),
      ),
    ).toBe("fail");
    const elsewhere = ".archer/notes/restocking.md";
    const moved = missingRun();
    const checks = task("explain-missing").judge({
      ...moved,
      changed: [elsewhere],
      added: [elsewhere],
      newNotes: [{ path: elsewhere, frontMatter: "author: agent\ndescription: x" }],
      diagrams: [
        {
          ...(moved.diagrams as Record<string, unknown>[])[0],
          path: elsewhere,
          viewId: "notes/restocking.md#restocking",
        },
      ],
      newDiagram: {
        ...(moved.diagrams as Record<string, unknown>[])[0],
        path: elsewhere,
        viewId: "notes/restocking.md#restocking",
      },
      calls: [
        present(
          "notes/restocking.md#restocking",
          "http://127.0.0.1:40123/projects/pageturner/notes/restocking.md#restocking",
        ),
      ],
      finalText: "No diagram covered it: http://127.0.0.1:40123/projects/pageturner/notes/restocking.md#restocking",
    });
    expect(verdict(checks)).toBe("fail");
    expect(failed(checks)).toEqual(["the new note is in notes/scratch/"]);
  });
});

// ---- the pilot rules (2026-10-22): name the reused doc; show before coding; offer doc upkeep

describe("names the reused doc, or says the diagram is new", () => {
  it("is partial when explain-existing or explain-more-detail does not name the checkout diagram", () => {
    const unnamed = "Payment runs on the provider's hosted page and its webhook reports the outcome:\n" + PAGE;
    expect(failed(task("explain-existing").judge(existingRun({ finalText: unnamed })))).toEqual([
      "names the diagram it reused",
    ]);
    expect(
      failed(
        task("explain-more-detail").judge(
          detailRun({
            finalText:
              "Here is the webhook in detail:\nhttp://127.0.0.1:40123/projects/pageturner/notes/scratch/checkout-webhook.md#webhook",
          }),
        ),
      ),
    ).toEqual(["names the diagram it reused"]);
  });
});

const WEBHOOKS = "services/shop-api/src/webhooks.js";
const PLAN = ".archer/notes/scratch/gift-cards.md";
const PLAN_VIEW = "notes/scratch/gift-cards.md#gift-cards";
const PLAN_URL = "http://127.0.0.1:40123/projects/pageturner/notes/scratch/gift-cards.md#gift-cards";
const PLAN_SOURCE = `%% archer-id: gift-cards
sequenceDiagram
    actor customer as Customer
    participant web as Storefront
    participant api as Shop API
    participant db as Shop database
    participant payments as Payment provider
    participant jobs as Job queue
    customer->>web: Check out, with a gift card
    web->>api: POST /orders with the gift card code
    api->>db: Reserve stock, deduct the gift card balance
    api->>payments: Create a payment session for the rest
    customer->>payments: Pay by card
    payments-)api: Webhook payment.succeeded
    api->>db: Mark the order Paid
    api-)jobs: Queue the confirmation email
`;
const PLAN_ANSWER = `I started from the checkout diagram and drew the change in a scratch copy, with what I'd touch highlighted:\n${PLAN_URL}\n\nAssumptions: a gift card covers part of an order, and its balance is deducted when the order is placed.\nOpen question: if the card payment fails, should the gift-card balance be restored at once?\n\nShall I go ahead and build it once you're happy with the picture?`;
const planRun = (over: Ctx = {}) =>
  ctx({
    calls: [read("checkout"), present(PLAN_VIEW, PLAN_URL)],
    finalText: PLAN_ANSWER,
    changed: [PLAN],
    added: [PLAN],
    files: {
      [PLAN]: `---\nauthor: agent\ndescription: Gift cards at checkout, proposed.\nbased-on: checkout@${CHECKOUT_REVISION}\n---\n\nAdds a gift card balance before the card payment.\n\n\`\`\`mermaid\n${PLAN_SOURCE}\`\`\`\n`,
    },
    newNotes: [
      {
        path: PLAN,
        frontMatter: `author: agent\ndescription: Gift cards at checkout, proposed.\nbased-on: checkout@${CHECKOUT_REVISION}`,
      },
    ],
    diagrams: [
      {
        path: PLAN,
        viewId: PLAN_VIEW,
        name: "gift-cards",
        source: PLAN_SOURCE,
        compiled: "compiled",
        pinnedInside: true,
      },
    ],
    emphases: [
      emphasis(PLAN_VIEW, [
        flow("Gift card (proposed)", ["msg-1", "msg-2"]),
        flow("Rest by card (assumed)", ["msg-3"]),
      ]),
    ],
    ...over,
  });

describe("show-before-coding", () => {
  const judge = (over?: Ctx) => task("show-before-coding").judge(planRun(over));

  it("passes a scratch copy of the covering diagram, the change emphasised, assumptions, one question, and a wait", () => {
    expect(failed(judge())).toEqual([]);
  });

  it("fails when it writes code before the go-ahead, or changes the documented diagram", () => {
    expect(verdict(judge({ changed: [PLAN, WEBHOOKS], files: { [WEBHOOKS]: "// gift cards\n" } }))).toBe("fail");
    expect(verdict(judge({ changed: [PLAN, CHECKOUT] }))).toBe("fail");
  });

  it("fails a plan that says it builds at once, and accepts other words for assumptions and waiting", () => {
    expect(
      verdict(
        judge({
          finalText: PLAN_ANSWER.replace(
            "Shall I go ahead and build it once you're happy with the picture?",
            "Please confirm whether that's right? I will implement it immediately.",
          ),
        }),
      ),
    ).toBe("fail");
    const hypothesis = `Here is the change on a scratch copy:\n${PLAN_URL}\n\nWorking hypothesis: the gift card is charged first. When should the balance be restored? I will wait for your decision before proceeding.`;
    expect(verdict(judge({ finalText: hypothesis }))).toBe("pass");
  });

  it("fails a copy that drops checkout, or an emphasis that is not on the gift-card change", () => {
    const banana = "%% archer-id: gift-cards\nflowchart LR\n  gift[Gift card] b1@--> banana[Banana]\n";
    expect(
      verdict(
        judge({
          diagrams: [
            {
              path: PLAN,
              viewId: PLAN_VIEW,
              name: "gift-cards",
              source: banana,
              compiled: "compiled",
              pinnedInside: true,
            },
          ],
        }),
      ),
    ).toBe("fail");
    expect(verdict(judge({ emphases: [emphasis(PLAN_VIEW, [flow("Banana (proposed)", ["msg-1"])])] }))).toBe("fail");
  });

  it('accepts a question put as "please confirm whether"', () => {
    expect(
      verdict(
        judge({
          finalText: PLAN_ANSWER.replace(/Open question:[^\n]*\n/, "").replace(
            "Shall I go ahead and build it once you're happy with the picture?",
            "Please confirm whether a failed card payment restores the balance before I build it.",
          ),
        }),
      ),
    ).toBe("pass");
  });

  it("fails without assumptions, without a question, or without waiting", () => {
    expect(verdict(judge({ finalText: PLAN_ANSWER.replace(/Assumptions:[^\n]*\n/, "") }))).toBe("fail");
    expect(
      verdict(
        judge({
          finalText: PLAN_ANSWER.replace(/Open question:[^\n]*\n/, "").replace(
            "Shall I go ahead and build it once you're happy with the picture?",
            "I'll build it next.",
          ),
        }),
      ),
    ).toBe("fail");
    expect(
      verdict(
        judge({
          finalText: PLAN_ANSWER.replace(
            "Shall I go ahead and build it once you're happy with the picture?",
            "Building it now.",
          ),
        }),
      ),
    ).toBe("fail");
  });

  it("fails a plan drawn from scratch instead of the covering diagram, or with no new part marked", () => {
    const note = (planRun().newNotes as Record<string, string>[])[0];
    expect(verdict(judge({ newNotes: [{ ...note, frontMatter: "author: agent\ndescription: Gift cards." }] }))).toBe(
      "fail",
    );
    expect(verdict(judge({ emphases: [emphasis(PLAN_VIEW, [flow("Gift card", ["msg-1", "msg-2"])])] }))).toBe("fail");
  });
});

const WEBHOOKS_AFTER =
  "if (event.type === 'payment.failed') {\n  await queue.add('payment-failed-email', { orderId: event.orderId });\n}\n";
const upkeepRun = (over: Ctx = {}) =>
  ctx({
    calls: [
      { server: "shell", tool: "Edit", input: { file_path: WEBHOOKS }, ok: true, via: "builtin" },
      { server: "archer", tool: "list_stale_diagrams", input: {}, ok: true, via: "mcp" },
    ],
    finalText:
      "Done: a declined card now queues a 'payment failed' email. The checkout diagram covers this file and is now out of date: its declined branch doesn't show the email. Want me to update it?",
    changed: [WEBHOOKS],
    added: [],
    files: { [WEBHOOKS]: WEBHOOKS_AFTER },
    ...over,
  });

describe("docs-upkeep-offer", () => {
  const judge = (over?: Ctx) => task("docs-upkeep-offer").judge(upkeepRun(over));

  it("passes a code change, a staleness check, and an offer to update the checkout diagram", () => {
    expect(failed(judge())).toEqual([]);
  });

  it("fails when it updates the diagram unasked, or never offers", () => {
    expect(verdict(judge({ changed: [WEBHOOKS, CHECKOUT] }))).toBe("fail");
    expect(verdict(judge({ finalText: "Done: a declined card now queues a 'payment failed' email." }))).toBe("fail");
  });

  it("fails a change that is only a comment, and an offer to do something other than update the diagram", () => {
    expect(verdict(judge({ files: { [WEBHOOKS]: "// TODO: payment-failed-email\n" } }))).toBe("fail");
    expect(verdict(judge({ finalText: "Done. The checkout diagram is stale. Want me to run the tests?" }))).toBe(
      "fail",
    );
  });

  it("fails without the code change, and is partial without the staleness check", () => {
    expect(verdict(judge({ changed: [], files: {} }))).toBe("fail");
    expect(failed(judge({ calls: [] }))).toEqual(["checked which diagrams went stale"]);
  });
});
