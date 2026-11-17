// aev-canary-5d1f8e02b7c4 (judge.mjs CANARY: an evaluated agent that reads this file is caught)
// The normalisation evals (ticket 06; docs/evaluations/normalisation-expand-2026-11-04.md): the `normalise`
// fixture (Pageturner plus a small code tree and seeded id collisions), tasks T1–T6 and `normMeasures`, the
// numbers each run records beside its verdict. Every check reads the compiled model, never an LLM's view.
// tasks.mjs adds these tasks with its rubric helpers (normaliseTasks); the facts are NORMALISE in facts.mjs.
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { NORMALISE } from "./facts.mjs";

// ---- the fixture

/** The seeded code: a Shop API with four responsibilities, a worker, two React apps and their stores. */
export const SEED_CODE = {
  "services/shop-api/package.json":
    JSON.stringify(
      {
        name: "shop-api",
        private: true,
        type: "module",
        dependencies: { express: "^4.21.0", pg: "^8.13.0", bullmq: "^5.30.0" },
      },
      null,
      2,
    ) + "\n",
  "services/shop-api/src/server.js": `import express from "express";
import { ordersRouter } from "./orders.js";
import { stockRouter } from "./stock.js";
import { webhooksRouter } from "./webhooks.js";

const app = express();
app.use(express.json());
app.use("/orders", ordersRouter); // the Storefront and the Back office
app.use("/stock", stockRouter); // the Back office
app.use("/webhooks/payments", webhooksRouter); // the payment provider
app.listen(process.env.PORT ?? 8080);
`,
  "services/shop-api/src/orders.js": `import { Router } from "express";
import { db } from "./db.js";
import { createPaymentSession } from "./payments.js";

export const ordersRouter = Router();

// Places an order: reserves the stock, saves it as Pending Payment, and opens a hosted payment page.
ordersRouter.post("/", async (req, res) => {
  const order = await db.createOrder(req.body.basket);
  const session = await createPaymentSession(order);
  res.status(201).json({ order, paymentUrl: session.url });
});

ordersRouter.get("/:id", async (req, res) => res.json(await db.getOrder(req.params.id)));
`,
  "services/shop-api/src/stock.js": `import { Router } from "express";
import { db } from "./db.js";

export const stockRouter = Router();

stockRouter.get("/", async (_req, res) => res.json(await db.listStock()));
// A delivery of new copies arrives: staff add them in the Back office.
stockRouter.post("/:bookId", async (req, res) => res.json(await db.addStock(req.params.bookId, req.body.copies)));
`,
  "services/shop-api/src/payments.js": `// Paystream, the payment provider: a hosted card page, so card details never reach us.
const PROVIDER = process.env.PAYSTREAM_URL ?? "https://api.paystream.example";

export async function createPaymentSession(order) {
  const res = await fetch(\`\${PROVIDER}/sessions\`, { method: "POST", body: JSON.stringify({ orderId: order.id, amount: order.total }) });
  return res.json();
}

export function verifySignature(req) {
  return req.get("paystream-signature") === process.env.PAYSTREAM_WEBHOOK_SECRET;
}
`,
  "services/shop-api/src/webhooks.js": `import { Router } from "express";
import { db } from "./db.js";
import { queue } from "./queue.js";
import { verifySignature } from "./payments.js";

export const webhooksRouter = Router();

// The payment provider reports each payment's outcome here.
webhooksRouter.post("/", async (req, res) => {
  if (!verifySignature(req)) return res.sendStatus(401);
  const event = req.body;
  if (event.type === "payment.succeeded") {
    await db.markOrderPaid(event.orderId);
    await queue.add("confirmation-email", { orderId: event.orderId });
    await queue.add("courier-booking", { orderId: event.orderId });
  } else if (event.type === "payment.failed") {
    await db.releaseStock(event.orderId);
    await db.markOrderPaymentFailed(event.orderId);
  }
  res.sendStatus(204);
});
`,
  "services/shop-api/src/db.js": `import pg from "pg";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const one = async (sql, args) => (await pool.query(sql, args)).rows[0];

export const db = {
  createOrder: basket => one("insert into orders (basket, status) values ($1, 'pending_payment') returning *", [basket]),
  getOrder: id => one("select * from orders where id = $1", [id]),
  markOrderPaid: id => one("update orders set status = 'paid' where id = $1", [id]),
  markOrderPaymentFailed: id => one("update orders set status = 'payment_failed' where id = $1", [id]),
  releaseStock: id => one("update stock set reserved = reserved - o.copies from orders o where o.id = $1", [id]),
  listStock: async () => (await pool.query("select * from stock")).rows,
  addStock: (bookId, copies) => one("update stock set copies = copies + $2 where book_id = $1 returning *", [bookId, copies]),
};
`,
  "services/shop-api/src/queue.js": `import { Queue } from "bullmq";

// Slow work (emails, courier bookings) goes to the worker through Redis.
export const queue = new Queue("jobs", { connection: { url: process.env.REDIS_URL } });
`,
  "services/worker/package.json":
    JSON.stringify({ name: "worker", private: true, type: "module", dependencies: { bullmq: "^5.30.0" } }, null, 2) +
    "\n",
  "services/worker/src/index.js": `import { Worker } from "bullmq";
import { sendConfirmationEmail } from "./email.js";
import { bookCourier } from "./courier.js";

new Worker("jobs", async job => {
  if (job.name === "confirmation-email") return sendConfirmationEmail(job.data.orderId);
  if (job.name === "courier-booking") return bookCourier(job.data.orderId);
}, { connection: { url: process.env.REDIS_URL } });
`,
  "services/worker/src/email.js": `// The email service delivers order emails.
export async function sendConfirmationEmail(orderId) {
  await fetch(\`\${process.env.MAIL_API_URL}/messages\`, { method: "POST", body: JSON.stringify({ template: "order-confirmed", orderId }) });
}
`,
  "services/worker/src/courier.js": `// The courier collects and delivers parcels.
export async function bookCourier(orderId) {
  await fetch(\`\${process.env.COURIER_API_URL}/collections\`, { method: "POST", body: JSON.stringify({ reference: orderId }) });
}
`,
  "apps/storefront/package.json":
    JSON.stringify(
      { name: "storefront", private: true, dependencies: { react: "^19.0.0", "react-dom": "^19.0.0" } },
      null,
      2,
    ) + "\n",
  "apps/storefront/src/api.js": `// The customer's catalogue, basket and checkout pages call the Shop API.
export const placeOrder = basket => fetch("/api/orders", { method: "POST", body: JSON.stringify({ basket }) }).then(r => r.json());
`,
  "apps/backoffice/package.json":
    JSON.stringify(
      { name: "backoffice", private: true, dependencies: { react: "^19.0.0", "react-dom": "^19.0.0" } },
      null,
      2,
    ) + "\n",
  "apps/backoffice/src/api.js": `// Staff screens for stock and orders call the Shop API.
export const listStock = () => fetch("/api/stock").then(r => r.json());
export const addCopies = (bookId, copies) => fetch(\`/api/stock/\${bookId}\`, { method: "POST", body: JSON.stringify({ copies }) });
export const getOrder = id => fetch(\`/api/orders/\${id}\`).then(r => r.json());
`,
  "docker-compose.yml": `services:
  db:
    image: postgres:16
  redis:
    image: redis:7
  shop-api:
    build: services/shop-api
    environment: { DATABASE_URL: "postgres://db/shop", REDIS_URL: "redis://redis:6379" }
  worker:
    build: services/worker
    environment: { REDIS_URL: "redis://redis:6379" }
`,
};

/** C4: alias drift in an agent's scratch note (the doc pack's refund-flow ids: provider, office, queue). */
export const PAYMENT_RETRIES = `---
author: agent
description: How staff retry a failed card payment from the Back office.
---

# Payment retries

\`\`\`mermaid
%% archer-id: payment-retries
sequenceDiagram
    actor staff as Shop Staff
    participant office as Back office
    participant api as Shop API
    participant provider as Paystream
    participant queue as Job queue
    staff->>office: Retry the payment
    office->>api: Retry the order's payment
    api->>provider: Create a new payment session
    provider-->>api: Session URL
    api-)queue: Queue a pay-again email
\`\`\`
`;

/** C5: a homonym in a person's note: \`db\` is the analytics warehouse here, not the Shop Database. */
export const ANALYTICS_EXPORT = `---
description: How each day's orders reach the analytics warehouse.
---

# Analytics export

Every night a job copies the day's orders to the analytics warehouse, where the weekly sales report is built.

\`\`\`mermaid
%% archer-id: analytics-export
flowchart LR
    export[Nightly export]
    db[(Analytics warehouse)]:::database
    report[Weekly sales report]
    export e1@-->|copies orders to| db
    db e2@-->|feeds| report
\`\`\`
`;

/**
 * T6's verbose diagram, written the way the verbosity measurement found real ones: components in a
 * container view, file paths as technology, long descriptions, BiRels, "Uses", function names as labels,
 * a fifth Rel argument, and the drifted ids shopApi, postgres and redisQueue.
 */
export const SHOP_INTERNALS = `C4Container
    title Shop internals: everything in and around the Shop API
    Person(customer, "Customer", "A person who visits the online shop in a browser to search the catalogue, fill a basket, check out and pay by card")
    Person(staff, "Shop Staff", "Members of staff who log into the back office to manage stock levels, look up orders and add new deliveries of books")
    System_Boundary(pageturner, "Pageturner Online Bookshop") {
        Container(web, "Storefront", "apps/storefront", "The React single page app that renders the catalogue, the basket, the checkout pages and the order history for customers")
        Container(backoffice, "Back Office", "apps/backoffice", "The React app staff use for stock screens, order lookups and adding new copies when a delivery arrives")
        Container_Boundary(shopApi, "Shop API") {
            Component(orderRoutes, "Order routes", "services/shop-api/src/orders.js", "Express router that places orders, reserves stock, saves them as pending payment and opens the hosted payment page")
            Component(stockRoutes, "Stock routes", "services/shop-api/src/stock.js", "Express router that lists stock levels and adds new copies of a book when staff record a delivery")
            Component(paymentClient, "Payment client", "services/shop-api/src/payments.js", "Creates payment sessions with the provider and verifies the signature on every webhook it sends back")
            Component(webhookHandler, "Webhook handler", "services/shop-api/src/webhooks.js", "Receives payment outcomes, marks orders paid or failed, releases stock and queues emails and courier bookings")
            Component(dataAccess, "Data access", "services/shop-api/src/db.js", "All the SQL for orders, stock and payments, through one pg connection pool shared by the routers")
            Component(queueClient, "Queue client", "services/shop-api/src/queue.js", "The bullmq queue the routers and webhook handler add confirmation email and courier booking jobs to")
        }
        ContainerDb(postgres, "Shop Database", "postgres:16 in docker-compose.yml", "Books, stock levels, customers, orders, payments and every order status change since the shop opened")
        ContainerQueue(redisQueue, "Job Queue", "redis:7 in docker-compose.yml", "Confirmation email jobs and courier booking jobs waiting for the worker, retried when they fail")
        Container(worker, "Worker", "services/worker/src/index.js", "A bullmq worker process that takes jobs from the queue and runs the email sender or the courier booking")
        Component(emailSender, "Email sender", "services/worker/src/email.js", "Builds the order confirmation email from a template and sends it through the email service")
        Component(courierBooking, "Courier booking", "services/worker/src/courier.js", "Books a parcel collection with the courier for every paid order and stores the collection reference")
    }
    System_Ext(payments, "Payment Provider", "Paystream, the hosted card payment page; card details never reach Pageturner at any point")
    System_Ext(courier, "Courier", "Collects parcels from the warehouse and delivers them to customers, with tracking")
    System_Ext(email, "Email Service", "Delivers order confirmation emails and every other email the shop sends to customers")
    Rel(customer, web, "Uses", "HTTPS", "Browses the catalogue, fills a basket and checks out")
    Rel(staff, backoffice, "Uses", "HTTPS", "Manages stock and looks up orders")
    Rel(web, orderRoutes, "createOrder()", "JSON over HTTPS", "Places the order with the basket")
    Rel(backoffice, stockRoutes, "Reads and adds stock", "JSON over HTTPS", "Lists stock and records deliveries")
    Rel(backoffice, orderRoutes, "Uses", "JSON over HTTPS", "Looks up orders for staff")
    Rel(orderRoutes, paymentClient, "createPaymentSession()", "function call", "Opens the hosted payment page")
    Rel(paymentClient, payments, "Creates payment sessions with", "HTTPS", "One session per order")
    Rel(payments, webhookHandler, "Reports payment outcomes to", "Webhook", "Succeeded or failed")
    BiRel(orderRoutes, dataAccess, "Reads and writes orders", "function call")
    BiRel(dataAccess, postgres, "Runs SQL against", "pg")
    Rel(stockRoutes, dataAccess, "Reads and changes stock", "function call", "Through the shared pool")
    Rel(webhookHandler, dataAccess, "Marks orders paid or failed", "function call", "And releases stock")
    Rel(webhookHandler, queueClient, "Queues emails and courier bookings", "function call", "Two jobs per paid order")
    Rel(queueClient, redisQueue, "Adds jobs to", "bullmq", "Retried on failure")
    Rel(worker, redisQueue, "Takes jobs from", "bullmq", "One at a time")
    Rel(worker, emailSender, "Runs", "function call", "For confirmation emails")
    Rel(worker, courierBooking, "Runs", "function call", "For courier bookings")
    Rel(emailSender, email, "Sends order emails through", "HTTPS", "One email per order")
    Rel(courierBooking, courier, "Books parcel collections with", "HTTPS", "One collection per order")
`;

const SHOP_INTERNALS_VIEW = `\n[[views]]\nid = "shop-internals"\nkind = "c4"\ntitle = "Shop Internals"\nsource = ".archer/diagrams/shop-internals.mmd"\n`;

const write = (root, files) => {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
};

/**
 * Pageturner as the corpus has it, plus the seeded code and the two collision notes; T6's verbose diagram only
 * with `internals` (it already draws the Shop API's components, so in T3's project it answers T3: smoke, 2026-11-04).
 */
export function normaliseLayout(runDir, { demo, agentsMd, skills, commit }, { internals = false } = {}) {
  const project = join(runDir, "project");
  cpSync(demo, project, { recursive: true });
  writeFileSync(join(project, "AGENTS.md"), agentsMd);
  write(project, SEED_CODE);
  write(project, {
    ".archer/notes/scratch/payment-retries.md": PAYMENT_RETRIES,
    ".archer/notes/analytics-export.md": ANALYTICS_EXPORT,
  });
  if (internals) {
    write(project, { [NORMALISE.shopInternals.path]: SHOP_INTERNALS });
    writeFileSync(
      join(project, "archer.toml"),
      readFileSync(join(project, "archer.toml"), "utf8") + SHOP_INTERNALS_VIEW,
    );
  }
  skills(project);
  commit(project);
  return { project };
}

/** T2's control: the same code in a fresh repository after `archer init`, with no diagrams and so no ids to copy. */
export function controlLayout(runDir, { agentsMd, skills, commit, archer }) {
  const project = join(runDir, "bookshop");
  mkdirSync(project, { recursive: true });
  write(project, SEED_CODE);
  writeFileSync(
    join(project, "README.md"),
    "# Bookshop\n\nAn online bookshop: a storefront for customers, a back office for staff, the Shop API and a worker.\n",
  );
  archer(["init"], project);
  writeFileSync(join(project, "AGENTS.md"), agentsMd);
  skills(project);
  commit(project);
  return { project };
}

// ---- normMeasures (ticket 06 §4): numbers from one compiled model

const wordCount = (text) =>
  (text ?? "")
    .trim()
    .split(/\s+/)
    .filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
// A path (a/b/c, dir/file.ext, ./x, ~/x), a lower-case file name with a code extension (orders.js, not
// Node.js), or a command (npm run, node x).
const PATHLIKE =
  /(?:^|\s)(?:~|\.{1,2})?\/\w|\w\/[\w.-]+\/|\w\/[\w-]+\.\w{1,4}\b|(?:^|[\s,(])[a-z0-9_-]+\.(?:js|mjs|cjs|ts|tsx|py|go|rs|java|kt|rb|ya?ml|json|toml|sh|sql)\b|^\s*(?:npm|npx|node|yarn|pnpm|docker|make|python|go run)\s/;
const IDENT = /\b\w+\(\)|\b[a-z][a-z0-9]*_[a-z0-9_]+\b|\b[a-z]+[A-Z]\w*\b/;
const kindsAgree = (seed, kind) => kind === undefined || kind === seed;

/** The seeded element a label names (with a kind, when the family has one), or undefined. */
export function seededFor(label, kind, facts = NORMALISE) {
  if (facts.not.test(label ?? "")) return undefined;
  return facts.seeded.find((s) => s.is.test(label ?? "") && kindsAgree(s.kind, kind));
}

/**
 * The parts of one compiled diagram as normMeasures reads them: elements {id, kind?, label, external,
 * technology, description, inside} (inside: the nearest container or system boundary around it),
 * boundaries and relationships {source, target, label, technology, description, bidirectional}.
 */
export function partsOf(model) {
  if (model?.type === "c4-model") {
    const boundaries = model.boundaries ?? [];
    const scope = (id) => {
      for (
        let b = boundaries.find((x) => x.id === id), guard = 0;
        b && guard < 20;
        b = boundaries.find((x) => x.id === b.parentId), guard++
      )
        if (b.kind === "container" || b.kind === "system") return b;
    };
    return {
      family: "c4",
      level: model.level,
      title: model.title ?? "",
      elements: model.elements.map((e) => ({ ...e, inside: e.boundaryId ? scope(e.boundaryId) : undefined })),
      boundaries,
      relationships: model.relationships,
    };
  }
  if (model?.type === "sequence-trace") {
    const messages = [];
    const walk = (events) => {
      for (const e of events ?? []) {
        if (e.type === "message") messages.push(e);
        else if (e.type === "fragment") for (const s of e.sections ?? []) walk(s.events);
      }
    };
    walk(model.events);
    return {
      family: "sequence",
      title: model.title ?? "",
      boundaries: [],
      elements: model.participants.map((p) => ({ id: p.id, label: p.label ?? p.id })),
      relationships: messages.map((m) => ({
        source: m.from,
        target: m.to,
        label: m.label,
        bidirectional: m.bidirectional,
      })),
    };
  }
  if (Array.isArray(model?.nodes)) {
    const KIND = {
      person: "person",
      system: "system",
      container: "container",
      component: "component",
      database: "container",
    };
    return {
      family: "flowchart",
      title: model.title ?? "",
      boundaries: model.groups ?? [],
      elements: model.nodes.map((n) => ({
        id: n.id,
        label: n.label,
        kind: (n.classes ?? []).map((c) => KIND[c]).find(Boolean),
      })),
      relationships: model.edges.map((e) => ({
        source: e.source,
        target: e.target,
        label: e.label,
        bidirectional: e.bidirectional,
      })),
    };
  }
  return null;
}

/** ticket 06 §4's measures for one compiled model against the facts. Null for a family it does not read. */
export function normMeasures(model, facts = NORMALISE) {
  const parts = partsOf(model);
  if (!parts) return null;
  const { family, level, elements, boundaries, relationships } = parts;
  const kinds = [...new Set(elements.map((e) => e.kind).filter(Boolean))].sort();
  const touched = new Set(relationships.flatMap((r) => [r.source, r.target]));
  // Mixed levels: a kind the header does not allow, or more than one container opened in a component view.
  const containerBoundaries = boundaries.filter((b) => b.kind === "container");
  const mixed =
    family === "c4"
      ? (level === "context" && kinds.some((k) => k === "container" || k === "component")) ||
        (level === "container" && kinds.includes("component")) ||
        (level === "component" && containerBoundaries.length > 1)
      : elements.some((e) => facts.componentParts.test(e.label ?? "") || facts.componentParts.test(e.id));
  const scopeKind = level === "component" ? "container" : "system";
  // Supporting elements not next to an element in scope (a component, or a container at L2).
  const inScope = (e) =>
    family === "c4" &&
    (level === "component"
      ? e.kind === "component"
      : level === "container"
        ? e.kind === "container" && !e.external && e.inside
        : e.kind === "system" && !e.external);
  const scoped = new Set(elements.filter(inScope).map((e) => e.id));
  const near = new Set(
    relationships.flatMap((r) => (scoped.has(r.source) ? [r.target] : scoped.has(r.target) ? [r.source] : [])),
  );
  const twoHop =
    family === "c4" && level !== "context" ? elements.filter((e) => !scoped.has(e.id) && !near.has(e.id)).length : 0;
  // Reuse: an element that names a seeded element (by label and kind) and takes its id; homonyms: a seeded id on something else.
  let reused = 0,
    expected = 0,
    labelDrift = 0;
  const homonyms = [],
    drift = [];
  const ids = new Map(facts.seeded.flatMap((s) => [[s.id, s], ...(s.also ?? []).map((a) => [a, s])]));
  for (const b of boundaries) if (b.id in facts.aliases) drift.push(b.id);
  for (const e of elements) {
    if (e.id in facts.aliases) drift.push(e.id);
    const named = seededFor(e.label, e.kind, facts);
    if (named) {
      expected++;
      if (e.id === named.id || (named.also ?? []).includes(e.id)) {
        reused++;
        if (e.label.trim().toLowerCase() !== named.label.toLowerCase()) labelDrift++;
      }
    }
    const owner = ids.get(e.id);
    if (owner && (!kindsAgree(owner.kind, e.kind) || facts.not.test(e.label ?? "") || !owner.is.test(e.label ?? "")))
      homonyms.push(e.id);
  }
  const descriptions = elements.map((e) => wordCount(e.description)).filter((n) => n > 0);
  const relWords = relationships.map((r) => wordCount(r.label));
  const texts = [
    parts.title,
    ...elements.flatMap((e) => [e.label, e.technology, e.description]),
    ...boundaries.map((b) => b.label),
    ...relationships.flatMap((r) => [r.label, r.technology, r.description]),
  ];
  return {
    family,
    ...(level ? { level } : {}),
    kinds,
    elements: elements.length,
    relationships: relationships.length,
    inBand: family !== "c4" || elements.length <= facts.bands[level],
    mixed,
    scopes: family === "c4" ? boundaries.filter((b) => b.kind === scopeKind).length : 0,
    inScopeSystems:
      family === "c4"
        ? elements.filter((e) => e.kind === "system" && !e.external).length +
          boundaries.filter((b) => b.kind === "system").length
        : 0,
    orphans: elements.filter((e) => !touched.has(e.id)).length,
    twoHop,
    descWordsMax: Math.max(0, ...descriptions),
    descWordsMean: descriptions.length
      ? Math.round((descriptions.reduce((a, b) => a + b, 0) / descriptions.length) * 10) / 10
      : 0,
    techPathLike: [...elements, ...relationships].filter((x) => PATHLIKE.test(x.technology ?? "")).length,
    relLabelWordsMax: Math.max(0, ...relWords),
    uses: relationships.filter((r) => /^\s*uses\s*$/i.test(r.label ?? "")).length,
    identLabels: relationships.filter((r) => IDENT.test(r.label ?? "")).length,
    birel: relationships.filter((r) => r.bidirectional).length,
    rel5th: family === "c4" ? relationships.filter((r) => (r.description ?? "").trim()).length : 0,
    words: texts.reduce((n, t) => n + wordCount(t), 0),
    reused,
    expected,
    labelDrift,
    drift,
    homonyms,
    ids: [...elements.map((e) => e.id), ...boundaries.map((b) => b.id)],
  };
}

/**
 * Each relationship of a C4 model at container level: a component's end mapped to the container boundary
 * around it (or, for the seed's loose components, to the container the facts name), every end through the aliases.
 */
export function containerPairs(model, facts = NORMALISE) {
  const parts = partsOf(model);
  if (!parts) return [];
  const alias = (id) => facts.shopInternals.renames[id] ?? facts.aliases[id] ?? id;
  const up = (id) => {
    const e = parts.elements.find((x) => x.id === id);
    if (e?.kind !== "component") return alias(id);
    return alias(e.inside?.kind === "container" ? e.inside.id : (facts.shopInternals.componentOf[id] ?? id));
  };
  return parts.relationships
    .flatMap((r) => {
      const pair = [up(r.source), up(r.target)];
      return r.bidirectional ? [pair, [pair[1], pair[0]]] : [pair];
    })
    .filter(([a, b]) => a !== b);
}

// ---- the judge's view of a run: every diagram it wrote or changed, measured and linted

const ADVICE_CODES =
  /\[(too_many_elements|description_too_long|technology_too_long|technology_is_path|boundary_too_deep|code_in_label|response_arrow|arrow_from_store|code_relationship|step_reuses_element_id|label_holds_file|unkinded_node|possible_duplicate|element_kind_conflict|element_parent_conflict)\]|"code":\s*"(too_many_elements|description_too_long|technology_too_long|technology_is_path|boundary_too_deep|code_in_label|response_arrow|arrow_from_store|code_relationship|step_reuses_element_id|label_holds_file|unkinded_node|possible_duplicate|element_kind_conflict|element_parent_conflict)"/g;

/** Advice findings a validate, write or (CLI) present result in the transcript showed the agent. */
export function findingsSeen(calls) {
  return calls
    .filter((c) =>
      ["validate_diagram", "write_diagram", "validate", "register_diagram", "present_diagram"].includes(c.tool),
    )
    .reduce((n, c) => {
      const text = c.text ?? "";
      const bracket = [...text.matchAll(ADVICE_CODES)].filter((m) => m[1]).length,
        json = [...text.matchAll(ADVICE_CODES)].filter((m) => m[2]).length;
      return n + Math.max(bracket, json);
    }, 0);
}

/**
 * Every diagram the run added or changed under .archer/: new and changed .mmd files, and each block of a
 * changed note whose body differs from the baseline's. Each with its compiled model, its measures and its
 * lint findings (warnings) from the judge's own install (null when that install has no lint).
 */
export function writtenViews(ctx, facts = NORMALISE) {
  const views = [];
  for (const d of ctx.diagrams ?? []) {
    if (d.path.endsWith(".md") && (ctx.baseline[d.path] ?? "").includes(d.source)) continue;
    views.push({
      viewId: d.viewId,
      path: d.path,
      source: d.source,
      compiled: d.compiled === "compiled",
      added: ctx.added.includes(d.path),
    });
  }
  for (const path of ctx.changed.filter(
    (p) => p.startsWith(".archer/") && p.endsWith(".mmd") && !ctx.added.includes(p) && ctx.files[p] !== undefined,
  ))
    views.push({
      viewId: path
        .split("/")
        .pop()
        .replace(/\.mmd$/, ""),
      path,
      source: ctx.files[path],
      compiled: ctx.compiled[path] === "compiled",
      added: false,
    });
  return views.map((v) => {
    const model = v.compiled ? (ctx.readDiagram?.(v.viewId)?.envelope?.model ?? null) : null;
    const advice = v.compiled && ctx.lint ? ctx.lint(v.viewId, v.source) : null;
    const warnings = advice === null ? null : advice.filter((a) => a.severity !== "info");
    return {
      ...v,
      model,
      measures: model ? normMeasures(model, facts) : null,
      findings: warnings === null ? null : warnings.length,
      advice: warnings?.map((a) => `${a.code}${a.element ? ` ${a.element}` : a.edge ? ` ${a.edge}` : ""}`) ?? null,
    };
  });
}

/** The run's measures (judgement.json `measures`): per view, and pooled as ticket 06 §5 reads them. */
export function runMeasures(views, calls) {
  const measured = views.filter((v) => v.measures);
  const c4 = measured.filter((v) => v.measures.family === "c4");
  const sum = (key) => measured.reduce((n, v) => n + v.measures[key], 0);
  const linted = views.every((v) => v.findings !== null || !v.compiled);
  return {
    views: views.map((v) => ({
      viewId: v.viewId,
      compiled: v.compiled,
      findings: v.findings,
      advice: v.advice,
      ...(v.measures ? (({ ids, byId, ...m }) => m)(v.measures) : {}),
    })),
    written: views.length,
    findings: linted ? views.reduce((n, v) => n + (v.findings ?? 0), 0) : null,
    zeroFindings: linted && views.length > 0 ? views.every((v) => v.findings === 0) : null,
    findingsSeen: findingsSeen(calls),
    reused: sum("reused"),
    expected: sum("expected"),
    labelDrift: sum("labelDrift"),
    drift: [...new Set(measured.flatMap((v) => v.measures.drift))],
    homonyms: [...new Set(measured.flatMap((v) => v.measures.homonyms))],
    c4Views: c4.length,
    mixed: c4.some((v) => v.measures.mixed),
    inBand: c4.length ? c4.every((v) => v.measures.inBand) : null,
    words: measured.map((v) => ({ level: v.measures.level ?? v.measures.family, words: v.measures.words })),
  };
}

// ---- the tasks

/** archer.toml changed only in `kind = …` lines (a view rewritten in another family). */
export function onlyKindChanged(before, after) {
  if (before === undefined || after === undefined) return false;
  const a = before.split("\n"),
    b = after.split("\n");
  return (
    a.length === b.length &&
    a.some((line, i) => line !== b[i]) &&
    a.every((line, i) => line === b[i] || (/^\s*kind\s*=/.test(line) && /^\s*kind\s*=/.test(b[i])))
  );
}

/** T1–T6, built with tasks.mjs's rubric helpers. Each judge returns its checks; `measures(ctx)` the numbers. */
export function normaliseTasks({ must, should, newDiagramChecks, presentedCheck, noOtherChanges }) {
  const F = NORMALISE;
  const seededKind = Object.fromEntries(F.seeded.map((s) => [s.id, s.kind]));
  const viewsOf = (ctx) => (ctx.normViews ??= writtenViews(ctx));
  const measures = (ctx) => runMeasures(viewsOf(ctx), ctx.calls);
  /** The checks every task shares: a lint-free result (should) and no drifted alias (must). */
  const common = (ctx, views) => [
    should(
      "no lint findings left",
      views.every((v) => v.findings === 0),
      views
        .filter((v) => v.findings)
        .map((v) => `${v.viewId}: ${v.advice.join(", ")}`)
        .join("; ") || undefined,
    ),
    must(
      "no drifted alias (queue, cdn, provider, office, shopApi, postgres, redisQueue)",
      views.every((v) => !v.measures?.drift.length),
      views.flatMap((v) => v.measures?.drift ?? []).join(", ") || undefined,
    ),
  ];
  const newC4 = (ctx, level) =>
    viewsOf(ctx).find((v) => v.added && v.measures?.family === "c4" && v.measures.level === level) ??
    viewsOf(ctx).find((v) => v.added);
  const look = (view) => {
    const parts = partsOf(view?.model);
    const byId = new Map((parts?.elements ?? []).map((e) => [e.id, e]));
    return { parts, byId, el: (id) => byId.get(id) };
  };

  const tasks = [
    {
      id: "norm-context",
      title: "T1: a C4 context view of an existing project, reusing its ids",
      layout: normaliseLayout,
      // The corpus's system-context view is a flowchart, which the smoke's agents presented as the answer: the
      // person says it is not the C4 view they want (smoke, 2026-11-04).
      prompt:
        "Our system context diagram is a plain flowchart. Draw Pageturner's system context as a proper C4 diagram and show it to me.", // aev-canary-5d1f8e02b7c4
      judge: (ctx) => {
        // A new view, or the flowchart rewritten in place as one: either is the person's C4 context view.
        const inPlace = viewsOf(ctx).find(
          (x) => !x.added && x.measures?.family === "c4" && x.measures.level === "context",
        );
        const v = viewsOf(ctx).some((x) => x.added) || !inPlace ? newC4(ctx, "context") : inPlace,
          m = v?.measures,
          { el } = look(v);
        const neighbours = ["customer", "staff", "payments", "courier", "email"];
        const missing = neighbours.filter((id) => el(id)?.kind !== seededKind[id]);
        return [
          ...(v?.added !== false
            ? newDiagramChecks(ctx, { header: /^\s*C4Context\b/m, kind: "C4 context" })
            : [
                must("a C4 context diagram was written", /^\s*C4Context\b/m.test(v.source ?? "")),
                must("it compiles", v.compiled),
                presentedCheck(ctx, v.viewId),
                // Its archer.toml entry's kind may follow the family (c4-context for a flowchart: smoke, 2026-11-04).
                noOtherChanges(ctx, [
                  v.path,
                  ...ctx.added,
                  ...(onlyKindChanged(ctx.baseline["archer.toml"], ctx.files["archer.toml"]) ? ["archer.toml"] : []),
                ]),
              ]),
          must(
            "only people and software systems",
            m?.kinds.every((k) => k === "person" || k === "system"),
            m?.kinds.join(", "),
          ),
          must(
            "exactly one system in scope, the rest external",
            m?.inScopeSystems === 1,
            m ? `${m.inScopeSystems} in scope` : "no model",
          ),
          must(
            "reuses the seeded ids for the five neighbours",
            missing.length === 0,
            missing.length ? `missing or another kind: ${missing.join(", ")}` : undefined,
          ),
          should("no seeded id under another label", m?.homonyms.length === 0, m?.homonyms.join(", ") || undefined),
          // Proposal's "no technology on a context element" (C4 S1) is left out: Mermaid's Person and System take none.
          should("within the L1 band (10)", m?.inBand),
          ...common(ctx, viewsOf(ctx)),
        ];
      },
    },
    {
      id: "norm-containers-control",
      title: "T2 (control): containers from code in a repository with no diagrams",
      layout: controlLayout,
      prompt: "Draw the containers of this system from the code, as a C4 container diagram, and show it to me.", // aev-canary-5d1f8e02b7c4
      judge: (ctx) => {
        const v = newC4(ctx, "container"),
          m = v?.measures,
          { parts } = look(v);
        const containers = (parts?.elements ?? []).filter((e) => e.kind === "container");
        const want = {
          storefront: /store ?front|web/i,
          "back office": /back[ -]?office|admin/i,
          api: /\bapi\b/i,
          worker: /worker/i,
          database: /database|postgres|\bdb\b/i,
          queue: /queue|redis|jobs?\b/i,
        };
        const absent = Object.entries(want)
          .filter(([, p]) => !containers.some((c) => p.test(`${c.label} ${c.technology ?? ""}`)))
          .map(([name]) => name);
        return [
          ...newDiagramChecks(ctx, { header: /^\s*C4Container\b/m, kind: "C4 container" }),
          must("no components in a container view", m && !m.mixed),
          must("one system boundary", m?.scopes === 1, m ? `${m.scopes}` : undefined),
          must(
            "the containers the code has",
            absent.length === 0,
            absent.length ? `missing ${absent.join(", ")}` : undefined,
          ),
          should("technology is a technology, not a path or command", m?.techPathLike === 0),
          should("descriptions of 15 words or fewer", m && m.descWordsMax <= 15, m ? `${m.descWordsMax}` : undefined),
          should(
            "relationship labels are short verb phrases",
            m && m.relLabelWordsMax <= 5 && m.uses === 0 && m.identLabels === 0,
          ),
          should("within the L2 band (15)", m?.inBand),
          should(
            "no lint findings left",
            viewsOf(ctx).every((x) => x.findings === 0),
            viewsOf(ctx)
              .filter((x) => x.findings)
              .map((x) => x.advice.join(", "))
              .join("; ") || undefined,
          ),
        ];
      },
    },
    {
      id: "norm-component-from-code",
      title: "T3: a component view of the Shop API from its code, reusing the container",
      layout: normaliseLayout,
      prompt: "Draw the components of the Shop API from its code and show me.", // aev-canary-5d1f8e02b7c4
      judge: (ctx) => {
        const v = newC4(ctx, "component"),
          m = v?.measures,
          { parts } = look(v);
        const opened = (parts?.boundaries ?? []).filter((b) => b.kind === "container");
        const components = (parts?.elements ?? []).filter((e) => e.kind === "component");
        const outside = components.filter((c) => c.inside?.id !== "api");
        const neighbours = (parts?.elements ?? []).filter((e) => e.kind !== "component");
        const strangers = neighbours.filter((e) => seededKind[e.id] !== e.kind);
        const [low, high] = F.components.api.band;
        return [
          ...newDiagramChecks(ctx, { header: /^\s*C4Component\b/m, kind: "C4 component" }),
          must(
            "one container decomposed, and it is api",
            opened.length === 1 && opened[0].id === "api",
            opened.map((b) => b.id).join(", ") || "none",
          ),
          must(
            "components only inside that boundary",
            components.length > 0 && outside.length === 0,
            outside.map((c) => c.id).join(", ") || undefined,
          ),
          must(
            "neighbours reuse the seeded ids",
            strangers.length === 0,
            strangers.map((e) => `${e.id} (${e.kind})`).join(", ") || undefined,
          ),
          must("no seeded id used for something else", m?.homonyms.length === 0, m?.homonyms.join(", ") || undefined),
          should(
            `${low} to ${high} components`,
            components.length >= low && components.length <= high,
            `${components.length}`,
          ),
          should(
            "only direct neighbours",
            m && m.orphans === 0 && m.twoHop === 0,
            m ? `orphans ${m.orphans}, two hops ${m.twoHop}` : undefined,
          ),
          should("technology is a technology, not a path", m?.techPathLike === 0, m ? `${m.techPathLike}` : undefined),
          should("within the L3 band (12)", m?.inBand),
          ...common(ctx, viewsOf(ctx)),
        ];
      },
    },
    {
      id: "norm-extend",
      title: "T4: add a gift card service to the architecture, reusing ids",
      layout: normaliseLayout,
      prompt:
        "Pageturner is adding gift cards: a Gift card service in Go with its own PostgreSQL database. The Storefront checks balances with it and the Shop API redeems cards through it. Add it to our architecture and show me.", // aev-canary-5d1f8e02b7c4
      judge: (ctx) => {
        const CONTAINERS = ".archer/diagrams/containers.mmd";
        const views = viewsOf(ctx);
        const edited = views.find((x) => x.path === CONTAINERS);
        const v =
          edited ??
          views.find((x) => x.added && x.measures?.family === "c4") ??
          views.find((x) => x.measures?.family === "c4");
        const { parts } = look(v);
        const elements = parts?.elements ?? [];
        const gift = elements.find((e) => /gift/i.test(e.label) && e.kind === "container" && e.shape !== "database");
        const giftDb =
          elements.find(
            (e) =>
              /gift/i.test(`${e.label} ${e.description ?? ""}`) && e.kind === "container" && e.shape === "database",
          ) ??
          elements.find(
            (e) =>
              e.kind === "container" &&
              e.shape === "database" &&
              e.id !== "db" &&
              (parts?.relationships ?? []).some(
                (r) =>
                  gift && ((r.source === gift.id && r.target === e.id) || (r.target === gift.id && r.source === e.id)),
              ),
          );
        const rels = parts?.relationships ?? [];
        const linked = (a, b) =>
          rels.some((r) => (r.source === a && r.target === b) || (r.bidirectional && r.source === b && r.target === a));
        const before = ctx.baseline[CONTAINERS] ?? "",
          after = ctx.files[CONTAINERS] ?? "";
        const keptAll =
          !edited ||
          before
            .split("\n")
            .filter((l) => l.trim())
            .every((l) => after.includes(l.trim()));
        return [
          must(
            "a C4 diagram with the gift card service was written or edited",
            gift !== undefined && v?.compiled,
            v ? undefined : "no C4 diagram written",
          ),
          must(
            "the gift card service is a container, its database a ContainerDb",
            gift && giftDb,
            gift ? (giftDb ? undefined : "no ContainerDb for it") : "no gift card container",
          ),
          must(
            "the existing parts keep their ids (web and api are the ends)",
            gift && linked("web", gift.id) && linked("api", gift.id),
            gift
              ? rels
                  .filter((r) => r.target === gift.id || r.source === gift.id)
                  .map((r) => `${r.source}->${r.target}`)
                  .join(", ")
              : undefined,
          ),
          must("the new database does not take the id db", giftDb?.id !== "db"),
          must(
            "no seeded id used for something else",
            v?.measures?.homonyms.length === 0,
            v?.measures?.homonyms.join(", ") || undefined,
          ),
          must("an edited containers diagram keeps every original line", keptAll),
          should(
            "reused elements keep their seeded labels",
            v?.measures?.labelDrift === 0,
            v?.measures ? `${v.measures.labelDrift}` : undefined,
          ),
          should("within the L2 band (15)", v?.measures?.inBand),
          presentedCheck(ctx, v?.viewId),
          noOtherChanges(ctx, [CONTAINERS, ...ctx.added]),
          ...common(ctx, views),
        ];
      },
    },
    {
      id: "norm-flow-over-existing",
      title: "T5: a flow drawn over the existing elements, by their ids",
      layout: normaliseLayout,
      prompt:
        "No diagram shows refunds. When a book arrives damaged, shop staff refund it in the Back office; the Shop API refunds the card through the payment provider, marks the order refunded in the Shop database and queues a receipt email, which the worker sends through the email service. Draw it over the parts we already have, and show me.", // aev-canary-5d1f8e02b7c4
      judge: (ctx) => {
        const v = viewsOf(ctx).find((x) => x.added && x.measures) ?? viewsOf(ctx).find((x) => x.measures),
          m = v?.measures,
          { parts } = look(v);
        const allowed = new Set([
          "staff",
          "backoffice",
          "api",
          "payments",
          "db",
          "jobs",
          "worker",
          "email",
          "customer",
        ]);
        const ids = (parts?.elements ?? []).map((e) => e.id);
        const foreign = ids.filter((id) => !allowed.has(id));
        const named = ["staff", "backoffice", "api", "payments", "db", "jobs", "worker", "email"];
        const absent = named.filter((id) => !ids.includes(id));
        return [
          ...newDiagramChecks(ctx, { header: /^\s*(flowchart|graph|sequenceDiagram)\b/m, kind: "flow" }),
          must(
            "every node or participant is a seeded element, by id",
            ids.length > 0 && foreign.length === 0,
            foreign.join(", ") || undefined,
          ),
          must(
            "draws every part the person named",
            absent.length === 0,
            absent.length ? `missing ${absent.join(", ")}` : undefined,
          ),
          must("no seeded id used for something else", m?.homonyms.length === 0, m?.homonyms.join(", ") || undefined),
          should("seeded labels kept", m?.labelDrift === 0, m ? `${m.labelDrift}` : undefined),
          should("no mixed level (no code-level part)", m && !m.mixed),
          ...common(ctx, viewsOf(ctx)),
        ];
      },
    },
    {
      id: "norm-refactor",
      title: "T6: tidy a verbose diagram into proper C4 without losing what it says",
      layout: (runDir, tools) => normaliseLayout(runDir, tools, { internals: true }),
      prompt:
        "The shop-internals diagram is hard to read. Tidy it into proper C4 without losing what it says, and show me.", // aev-canary-5d1f8e02b7c4
      judge: (ctx) => {
        const S = F.shopInternals;
        const views = viewsOf(ctx).filter(
          (x) => x.measures?.family === "c4" || x.path === S.path || /^\s*C4\w+/m.test(x.source ?? ""),
        );
        const seedWords = S.seedWords;
        const pairs = new Set(
          views.flatMap((x) => (x.model ? containerPairs(x.model) : [])).map(([a, b]) => `${a}->${b}`),
        );
        const lost = S.facts.filter(([a, b]) => !pairs.has(`${a}->${b}`)).map(([a, b]) => `${a}->${b}`);
        const left = views.flatMap((x) => (x.measures?.ids ?? []).filter((id) => id in S.renames));
        const changedSeed = ctx.changed.includes(S.path);
        return [
          must(
            "every changed or new C4 view compiles",
            views.length > 0 && views.every((x) => x.compiled),
            views
              .filter((x) => !x.compiled)
              .map((x) => x.viewId)
              .join(", ") || (views.length ? undefined : "nothing changed"),
          ),
          must(
            "no view mixes levels",
            views.length > 0 && views.every((x) => x.measures && !x.measures.mixed),
            views
              .filter((x) => x.measures?.mixed)
              .map((x) => x.viewId)
              .join(", ") || undefined,
          ),
          must("the facts are kept", lost.length === 0, lost.length ? `lost ${lost.join(", ")}` : undefined),
          must(
            "drifted ids renamed to the project's ids (shopApi→api, postgres→db, redisQueue→jobs)",
            views.length > 0 && left.length === 0,
            [...new Set(left)].join(", ") || undefined,
          ),
          should(
            "changed through write_diagram",
            !changedSeed || ctx.calls.some((c) => c.tool === "write_diagram" && c.ok),
          ),
          should(
            "words per view at most half the seed's",
            views.length > 0 && views.every((x) => (x.measures?.words ?? Infinity) <= seedWords / 2),
            views.map((x) => `${x.viewId} ${x.measures?.words}`).join(", ") + ` (seed ${seedWords})`,
          ),
          should(
            "every view within its band",
            views.every((x) => x.measures?.inBand),
          ),
          should(
            "no lint findings left",
            views.every((x) => x.findings === 0),
            views
              .filter((x) => x.findings)
              .map((x) => `${x.viewId}: ${x.advice.join(", ")}`)
              .join("; ") || undefined,
          ),
          presentedCheck(ctx, undefined),
          noOtherChanges(ctx, [S.path, ...ctx.added]),
        ];
      },
    },
  ];
  for (const task of tasks) task.measures = measures;
  return tasks;
}
