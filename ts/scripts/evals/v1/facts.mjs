// aev-canary-5d1f8e02b7c4 (judge.mjs CANARY: an evaluated agent that reads this file is caught)
// Hand-written facts for the doc-pack tasks (docs/proposals/doc-pack.md, Evals): what is true of each
// fixture, written from the fixture by hand and never from an agent's answer, and the wrong claims a
// judge refuses. A judge reads these; ts/test/evals/doc-pack-tasks.test.ts mutation-checks it.

/** The Pageturner doc pack seeded for case-lookup: the refund flow. */
export const REFUND = {
  view: "refund",
  /** Part of every path of the flow's files: the note and the diagram. */
  flowPath: "flows/refund",
  /** Node and edge ids of diagrams/flows/refund.mmd that are the refund's path. */
  path: ["staff", "office", "api", "provider", "queue", "worker", "email", "r1", "r2", "r3", "r4", "r5", "r6"],
  /** What a correct answer says (patterns over the final answer). */
  says: [
    { fact: "the card is refunded through Paystream (the payment provider)", pattern: /paystream|payment provider/i },
    { fact: "a receipt is emailed", pattern: /receipt/i },
  ],
  true: [
    "Support staff start a refund in the Back office",
    "The Shop API refunds the card through Paystream, the payment provider",
    "The Shop API queues a refund-receipt job; the Worker emails the receipt",
  ],
  /** Claims that would mean the agent did not read the pack (or invented a part). */
  wrong: [
    { claim: "a separate refunds service or container", pattern: /\brefunds? (?:service|microservice|container)\b/i },
    { claim: "refunds paid in cash or store credit", pattern: /\b(?:cash|store credit|gift card)\b/i },
    {
      claim: "the Storefront issues the refund",
      pattern: /storefront (?:issues|sends|makes|starts) (?:the |a )?refund/i,
    },
  ],
};

/** The tidepool repository for intent-bootstrap: what its code and README say, and nothing more. */
export const TIDEPOOL = {
  true: [
    "A small HTTP API that serves tide times for harbours",
    "A nightly import of tide tables",
    "Every request is answered with the tides for its ?harbour= value, as JSON (no method or path check)",
  ],
  /** What a draft from the code must say. */
  mention: [/tide/i, /harbou?r/i, /nightly|import/i],
  /** Users, goals or parts the repository says nothing about: inventing them fails the run. */
  invented:
    /\b(?:mobile app|subscription|paying customers?|revenue|enterprise|machine learning|marketplace|login|sign[- ]?up|dashboard)\b/i,
  /** A question the code already answers. */
  askedTheCode: /\bwhat (?:does|is) (?:it|this|the) (?:project|app|api|repo(?:sitory)?|service|code)(?: do| for)?\b/i,
};

/**
 * The `normalise` fixture (ticket 06; §3 of its eval design proposal, in the review evidence: private, not published):
 * Pageturner's containers.mmd ids, the aliases the corpus and the seeded notes drift to, the homonym traps,
 * and the reference components of the seeded code. Written by hand from the fixture, never from a run.
 */
export const NORMALISE = {
  /**
   * Each seeded element: its C4 kind and label in containers.mmd, and `is`, what a label naming it says.
   * Most specific first: an element is matched to the first entry whose `is` its label matches and whose
   * kind agrees (a component labelled "Payments" is not the provider). `also`: other project ids it has (C3).
   */
  seeded: [
    {
      id: "payments",
      kind: "system",
      label: "Payment Provider",
      is: /payment (?:provider|service|gateway|processor)|paystream|card payments?\b/i,
    },
    {
      id: "email",
      kind: "system",
      label: "Email Service",
      is: /e-?mail (?:service|provider|api|gateway|delivery)|mail (?:service|provider)/i,
    },
    { id: "courier", kind: "system", label: "Courier", is: /courier|parcel (?:service|carrier)|parcelpro|parcelhub/i },
    { id: "customer", kind: "person", label: "Customer", is: /\bcustomers?\b|\bshoppers?\b|\bbuyers?\b/i },
    { id: "staff", kind: "person", label: "Shop Staff", is: /\bstaff\b|\bemployees?\b|\bshop workers?\b/i },
    { id: "backoffice", kind: "container", label: "Back Office", is: /back[ -]?office|admin (?:app|console|ui)/i },
    {
      id: "web",
      kind: "container",
      label: "Storefront",
      is: /store ?front|\bweb ?(?:app|site|shop|frontend|ui)?\b|shop ?front/i,
    },
    { id: "worker", kind: "container", label: "Worker", is: /\bworker\b|background (?:jobs?|processor)/i },
    { id: "jobs", kind: "container", label: "Job Queue", is: /\bjob queue\b|\bqueue\b|\bredis\b|\bbullmq\b/i },
    {
      id: "db",
      kind: "container",
      label: "Shop Database",
      is: /\bdatabase\b|\bpostgres(?:ql)?\b|\bdb\b|\bdata ?store\b/i,
    },
    { id: "api", kind: "container", label: "Shop API", is: /\bapi\b|\bbackend\b/i },
    {
      id: "pageturner",
      kind: "system",
      label: "Pageturner Online Bookshop",
      is: /pageturner|bookshop|online shop/i,
      also: ["shop"],
    },
  ],
  /** A label that is never a seeded element, whatever id it takes (T4's gift-card service, C5's analytics warehouse). */
  not: /gift|analytics|warehouse|bigquery/i,
  /** Ids the corpus and the seeded notes use for a seeded element: one in a new or tidied diagram is drift (C1, C2, C4, T6's seed). */
  aliases: {
    queue: "jobs",
    cdn: "web",
    provider: "payments",
    office: "backoffice",
    shopApi: "api",
    postgres: "db",
    redisQueue: "jobs",
  },
  /** The Shop API's components in the seeded code: four, plus data access and the queue client, which may fold into arrows. */
  components: { api: { band: [4, 6], neighbours: ["web", "backoffice", "db", "jobs", "payments"] } },
  /** A flow node that names a code file or a code-level part: a component-level element (T5's mixed-level check). */
  componentParts:
    /\b(?:server|orders|stock|payments|webhooks|db|queue|index|email|courier)\.js\b|\b(?:webhooks? handler|order routes|stock routes|payment client|queue client|data access)\b/i,
  shopInternals: {
    view: "shop-internals",
    path: ".archer/diagrams/shop-internals.mmd",
    /** Its drifted ids and the project id each becomes (decided 2026-10-27: renamed when only that diagram uses them). */
    renames: { shopApi: "api", postgres: "db", redisQueue: "jobs" },
    /** The seed's components and their containers: two are drawn loose in the system boundary, not inside the worker. */
    componentOf: {
      orderRoutes: "api",
      stockRoutes: "api",
      paymentClient: "api",
      webhookHandler: "api",
      dataAccess: "api",
      queueClient: "api",
      emailSender: "worker",
      courierBooking: "worker",
    },
    /** Words in the seed's visible text (normMeasures; pinned by ts/test/evals/normalise-tasks.test.ts). */
    seedWords: 528,
    /** What the seed says at container level: each pair must survive the tidy in some resulting view. */
    facts: [
      ["customer", "web"],
      ["staff", "backoffice"],
      ["web", "api"],
      ["backoffice", "api"],
      ["api", "payments"],
      ["payments", "api"],
      ["api", "db"],
      ["api", "jobs"],
      ["worker", "jobs"],
      ["worker", "email"],
      ["worker", "courier"],
    ],
  },
  /** C4 elements per view before it stops reading at a glance (ADR 0036 §9; ticket 06: 10 / 15 / 12). */
  bands: { context: 10, container: 15, component: 12 },
};
