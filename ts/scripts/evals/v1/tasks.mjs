// aev-canary-5d1f8e02b7c4 (judge.mjs CANARY: an evaluated agent that reads this file is caught)
// Small-agent eval tasks for v1 (docs/evaluations/v1-small-agent-evals.md).
// Each runs in a fresh copy of the Pageturner test corpus (ts/test/fixtures/pageturner). `judge` gets the
// run's evidence (see judge.mjs) and returns checks; a failed `must` check fails the run,
// a failed `should` check makes it partial. These are the main set: a development set, tuned
// against in the open. The hold-out tasks are not in the repository: they load from a private
// file (see loadHoldout below and docs/evaluations/eval-baseline.md, "Hold-out").
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { REFUND, TIDEPOOL } from "./facts.mjs";
import { normaliseTasks } from "./normalise.mjs";

const CONTAINERS = ".archer/diagrams/containers.mmd";
/** The emphasis payload a call sent: set_emphasis's own, or present_diagram's emphasis argument. */
const emphasisInput = (c) =>
  c.tool === "set_emphasis" ? c.input : c.tool === "present_diagram" ? c.input?.emphasis : undefined;

export const TASKS = [
  {
    id: "c4-new",
    title: "Draw a C4 container diagram from a short description",
    prompt:
      "We're planning a small library-loans system. Members use a mobile app to search the catalogue and borrow e-books. The app talks to a Loans API (Kotlin). The API keeps members and loans in a PostgreSQL database, checks licences with an external DRM provider, and sends due-date reminders through an external push-notification service. Librarians use a web admin console that also calls the Loans API. Draw this as a C4 container diagram and show it to me.", // aev-canary-5d1f8e02b7c4
    judge: (ctx) => [
      ...newDiagramChecks(ctx, { header: /^\s*C4Container\b/m, kind: "C4 container" }),
      should(
        "mentions the DRM and push services",
        /drm/i.test(ctx.newDiagramSource ?? "") && /push|notif/i.test(ctx.newDiagramSource ?? ""),
      ),
    ],
  },
  {
    id: "flowchart",
    title: "Flowchart of a process",
    prompt:
      "Draw a flowchart of how a returned book is processed at our warehouse: the parcel is scanned on arrival; if the book is damaged it is written off and the customer is refunded; otherwise it is checked against the order, put back on the shelf, and the customer is refunded. If the order can't be found, the parcel goes to a manual review queue. Show it to me.", // aev-canary-5d1f8e02b7c4
    judge: (ctx) => [
      ...newDiagramChecks(ctx, { header: /^\s*(flowchart|graph)\b/m, kind: "flowchart" }),
      should(
        "has a decision for damaged and for unknown order",
        (ctx.newDiagramSource?.match(/\{/g)?.length ?? 0) >= 2,
      ),
    ],
  },
  {
    id: "sequence",
    title: "Sequence diagram",
    prompt:
      "Show me, as a sequence diagram, how a Pageturner customer resets their password: the Storefront asks the Shop API for a reset; the API stores a one-time token in the Shop database and asks the Email service to send a link; the customer opens the link in the Storefront, which sends the token and new password to the API; the API checks the token in the database, saves the new password hash and confirms.", // aev-canary-5d1f8e02b7c4
    judge: (ctx) => [...newDiagramChecks(ctx, { header: /^\s*sequenceDiagram\b/m, kind: "sequence" })],
  },
  {
    id: "edit-existing",
    title: "Edit an existing diagram (sourceRevision)",
    prompt:
      "Pageturner is adding search. Add a Search index container (OpenSearch) to the containers diagram: the Shop API writes book updates to it and the Storefront queries it directly. Then show me the updated diagram.", // aev-canary-5d1f8e02b7c4
    judge: (ctx) => {
      const after = ctx.files[CONTAINERS] ?? "";
      const before = ctx.baseline[CONTAINERS] ?? "";
      const keptAll = before
        .split("\n")
        .filter((line) => line.trim())
        .every((line) => after.includes(line.trim()));
      const writes = ctx.calls.filter((call) => call.tool === "write_diagram");
      return [
        must(
          "containers.mmd now has a search container",
          /Container(Db)?\s*\(\s*\w+\s*,\s*"[^"]*search[^"]*"/i.test(after),
        ),
        must("the edited diagram compiles", ctx.compiled[CONTAINERS] === "compiled"),
        must("every original line is kept", keptAll),
        // write_diagram's revision argument is named expectedRevision (its value is read_diagram's sourceRevision);
        // a CLI call passes its arguments in a file the judge does not see, so only the call is checked.
        should(
          "edited through write_diagram (not file tools)",
          writes.some((call) => call.ok),
        ),
        should(
          "adds both relationships",
          (after.match(/Rel\w*\(/g)?.length ?? 0) >= (before.match(/Rel\w*\(/g)?.length ?? 0) + 2,
        ),
        presentedCheck(ctx, "containers"),
        noOtherChanges(ctx, [CONTAINERS]),
      ];
    },
  },
  {
    id: "emphasis",
    title: "Emphasise the right parts for a question",
    prompt:
      "On the containers diagram, show me what is involved when a customer's card payment succeeds, and then how the confirmation email reaches them. Payment first, email second.", // aev-canary-5d1f8e02b7c4
    judge: (ctx) => {
      const emphases = ctx.emphases.filter((e) => e.viewId === "containers");
      const groups = emphases.at(-1)?.groups ?? [];
      const ids = (group) => new Set([...(group.nodes ?? []), ...(group.edges ?? [])]);
      const g1 = groups[0] ? ids(groups[0]) : new Set(),
        g2 = groups[1] ? ids(groups[1]) : new Set();
      const paymentParts = ["payments", "api--payments", "payments--api"];
      const emailParts = ["worker", "email", "worker--email", "jobs"];
      return [
        must("set an emphasis on containers", groups.length > 0),
        must("at most 3 groups", groups.length <= 3),
        must(
          "group 1 is the payment",
          paymentParts.some((id) => g1.has(id)) && !["email", "worker--email"].some((id) => g1.has(id)),
        ),
        must(
          "group 2 is the email path",
          emailParts.some((id) => g2.has(id)),
        ),
        should(
          "labels are 4 words or fewer",
          groups.every((g) => (g.label ?? "").trim().split(/\s+/).length <= 4),
        ),
        should(
          "labels carry no step numbers",
          groups.every((g) => !/^\s*\(?\d+[.):]/.test(g.label ?? "")),
        ),
        should(
          "no colour or palette fields sent",
          !ctx.calls.some((c) => /amber|colou?r|palette/i.test(JSON.stringify(emphasisInput(c) ?? {}))),
        ),
        presentedCheck(ctx, "containers"),
        noOtherChanges(ctx, []),
      ];
    },
  },
  {
    id: "note-emphasis",
    title: "Note passage emphasis",
    prompt:
      "In the decision note about sending emails and booking couriers from a worker, highlight the passages that give the reason for the decision, and separately the downside we accepted.", // aev-canary-5d1f8e02b7c4
    judge: (ctx) => {
      const sets = ctx.noteEmphases["notes/0002-side-effects-through-the-queue.md"] ?? [];
      const groups = sets.at(-1)?.groups ?? [];
      const quotes = groups.map((g) => (g.passages ?? []).map((p) => p.quote).join(" "));
      return [
        must("set a note emphasis on note 0002", groups.length > 0),
        must("at most 3 groups", groups.length <= 3),
        should(
          "first group is the reason",
          /slow|down|before the customer|hold up|outside services/i.test(quotes[0] ?? ""),
        ),
        should(
          "a later group is the downside",
          quotes.slice(1).some((q) => /another thing to run|minute after|watch/i.test(q)),
        ),
        should(
          "labels are 4 words or fewer",
          groups.every((g) => (g.label ?? "").trim().split(/\s+/).length <= 4),
        ),
        should(
          "labels carry no step numbers",
          groups.every((g) => !/^\s*\(?\d+[.):]/.test(g.label ?? "")),
        ),
        // Durable note emphasis is a sidecar beside the note (ts/src/notes): expected, not damage.
        noOtherChanges(ctx, [".archer/notes/0002-side-effects-through-the-queue.md.emphases.json"]),
      ];
    },
  },
  {
    id: "comment",
    title: "Reply to and resolve a comment",
    setup: (project) => seedComment(project),
    prompt: "I left you a comment in Archer on the containers diagram. Please deal with it.", // aev-canary-5d1f8e02b7c4
    judge: (ctx) => {
      const after = ctx.files[CONTAINERS] ?? "";
      const thread = JSON.parse(
        ctx.files[".archer/diagrams/containers.comments.json"] ?? '{"threads":[]}',
      ).threads.find((t) => t.id === "t-courier");
      const agentReplies = (thread?.comments ?? []).filter((c) => c.author === "agent");
      return [
        must("courier renamed to ParcelPro in the diagram", /System_Ext\(\s*courier\s*,\s*"ParcelPro/.test(after)),
        must("the courier keeps its id (relationships intact)", /Rel\(worker,\s*courier/.test(after)),
        must("diagram still compiles", ctx.compiled[CONTAINERS] === "compiled"),
        must("replied in the thread", agentReplies.length > 0),
        should("resolved the thread", thread?.status === "resolved"),
        should(
          "edited through write_diagram",
          ctx.calls.some((c) => c.tool === "write_diagram" && c.ok),
        ),
        noOtherChanges(ctx, [CONTAINERS, ".archer/diagrams/containers.comments.json"]),
      ];
    },
  },
  {
    id: "note-with-diagram",
    title: "Note with an embedded diagram (author: agent)",
    prompt:
      "Write a short decision note proposing that we put a CDN in front of the Storefront to cache catalogue pages, with a small diagram showing where the CDN sits between the customer and the Storefront. Show me the diagram.", // aev-canary-5d1f8e02b7c4
    judge: (ctx) => [
      ...newDiagramChecks(ctx, {
        header: /^\s*(C4\w+|flowchart|graph|architecture-beta)\b/m,
        kind: "diagram",
        embeddedOnly: true,
      }),
      should("mentions the CDN", /cdn/i.test(ctx.newDiagramSource ?? "")),
    ],
  },
  {
    id: "present",
    title: "Present a diagram and give its URL",
    prompt: "Open the order lifecycle diagram for me and give me the link.", // aev-canary-5d1f8e02b7c4
    judge: (ctx) => [
      presentedCheck(ctx, "order-lifecycle", true),
      should("3 or fewer Archer calls", ctx.calls.filter((c) => c.server === "archer").length <= 3),
      noOtherChanges(ctx, []),
    ],
  },
  {
    id: "no-draw",
    title: "Answer without drawing (a table fits better)",
    prompt:
      "Quick question: what do the Storefront and the Back office containers each do, who uses them, and what are they built with? A short comparison is fine.", // aev-canary-5d1f8e02b7c4
    judge: (ctx) => [
      must("no files written", ctx.changed.length === 0),
      must("no diagram written", !ctx.calls.some((c) => ["write_diagram", "register_diagram"].includes(c.tool))),
      should(
        "nothing presented or emphasised",
        !ctx.calls.some((c) => ["present_diagram", "set_emphasis"].includes(c.tool)),
      ),
      must("answers with both containers", /storefront/i.test(ctx.finalText) && /back ?office/i.test(ctx.finalText)),
      should("answer is short (1200 characters or fewer)", ctx.finalText.length <= 1200),
      should("3 or fewer Archer calls", ctx.calls.filter((c) => c.server === "archer").length <= 3),
    ],
  },
];

// ---- naming and links (docs/evaluations/v1-small-agent-evals.md, "Naming and note links")

const PAGE_URL = /https?:\/\/127\.0\.0\.1:\d+\/projects\/[a-z0-9-]+\/[^\s"'<>)\]`{}]*/g;
// A path named in prose, not inside a URL.
const DOC_PATH = /(?:^|[\s`'"([])((?:\.archer\/)?(?:docs|notes)\/[\w./-]+\.md)\b/g;

/** Where the reply first links a note page, names a document that exists, or links a diagram. */
export function deliveries(text, project) {
  let noteAt = -1,
    diagramAt = -1;
  for (const m of text.matchAll(PAGE_URL)) {
    const url = m[0].replace(/[.,;:]+$/, "");
    // A diagram: the presented page (`?follow`) or a diagram in a note (`…md#name`).
    const diagram = url.includes("#") || /[?&]follow\b/.test(url);
    const note = !diagram && /\.md(?:\?|$)/.test(url);
    if (diagram && diagramAt < 0) diagramAt = m.index;
    if (note && noteAt < 0) noteAt = m.index;
  }
  let docAt = -1,
    doc;
  DOC_PATH.lastIndex = 0;
  for (const m of text.matchAll(DOC_PATH)) {
    const path = m[1];
    if ([path, `.archer/${path}`].some((candidate) => existsSync(join(project, candidate)))) {
      docAt = m.index;
      doc = path;
      break;
    }
  }
  return { noteAt, docAt, doc, diagramAt };
}

const ENV_EXAMPLE = `# Shop API credentials. Copy to services/shop-api/.env for local development.
# Payment provider (Paystream): dashboard -> Developers -> API keys. Use the test-mode key locally.
PAYSTREAM_API_KEY=
# Created when you add the webhook endpoint https://<host>/webhooks/paystream in the same dashboard.
PAYSTREAM_WEBHOOK_SECRET=
# Courier (ParcelHub): business portal -> Account settings -> Account ID.
PARCELHUB_ACCOUNT_ID=
# ParcelHub portal -> Integrations -> API tokens -> New token (scope: shipments).
PARCELHUB_API_TOKEN=
`;
const DEPLOY_MD = `# Deploying Pageturner

The Shop API and the worker run on one host behind the reverse proxy.

- Production settings live in \`/etc/pageturner/shop-api.env\` on the host, owned by root, mode 600.
  Both the Shop API and the worker read it.
- After changing it, restart both: \`sudo systemctl restart pageturner-api pageturner-worker\`.
- Never commit real keys; \`.env.example\` lists the names.
`;

/** A bare repository folder `name` with a few files and the agents' Archer block absent. */
function freshRepository(runDir, name, { skills, commit }) {
  const repo = join(runDir, name);
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(
    join(repo, "README.md"),
    `# ${name[0].toUpperCase()}${name.slice(1)}\n\nA small HTTP API that serves tide times for harbours, with a nightly import of tide tables.\n`,
  );
  writeFileSync(
    join(repo, "package.json"),
    JSON.stringify(
      { name, version: "0.1.0", private: true, type: "module", scripts: { start: "node src/server.js" } },
      null,
      2,
    ) + "\n",
  );
  writeFileSync(
    join(repo, "src", "server.js"),
    "import { createServer } from 'node:http';\nimport { tidesFor } from './tides.js';\n\ncreateServer((req, res) => res.end(JSON.stringify(tidesFor(new URL(req.url, 'http://x').searchParams.get('harbour'))))).listen(8080);\n",
  );
  writeFileSync(
    join(repo, "src", "tides.js"),
    "export function tidesFor(harbour) { return { harbour, tides: [] }; }\n",
  );
  skills(repo);
  commit(repo);
  return repo;
}

const NAMING_TASKS = [
  {
    id: "credentials-guide",
    title: "Instructions are a document, not a diagram",
    setup: (project) => {
      writeFileSync(join(project, ".env.example"), ENV_EXAMPLE);
      mkdirSync(join(project, "docs"), { recursive: true });
      writeFileSync(join(project, "docs", "deploy.md"), DEPLOY_MD);
    },
    prompt:
      "How do I get and set up the credentials the Shop API needs for the payment provider and the courier? I need instructions for local development and for production.", // aev-canary-5d1f8e02b7c4
    judge: (ctx) => {
      const d = deliveries(ctx.finalText, ctx.project);
      const written = ctx.changed.filter((path) => path.endsWith(".md"));
      // The guide is a document the agent wrote: a note page it links, or a doc it names.
      const ownDoc =
        d.noteAt >= 0 || (d.docAt >= 0 && written.some((path) => path === d.doc || path === `.archer/${d.doc}`));
      const documentAt = [d.noteAt, ownDoc ? d.docAt : -1].filter((at) => at >= 0);
      const guideNotes = ctx.added.filter((path) => /^\.archer\/notes\/.+\.md$/.test(path));
      return [
        must("does not deliver only a diagram URL", d.diagramAt < 0 || documentAt.length > 0),
        should(
          "the guide is a document it wrote, linked or named",
          ownDoc,
          d.docAt >= 0 ? `names ${d.doc} only` : "answered in chat",
        ),
        should(
          "leads with the document, not a diagram",
          d.diagramAt < 0 || (documentAt.length > 0 && Math.min(...documentAt) < d.diagramAt),
        ),
        should("links the page of the note it wrote", guideNotes.length === 0 || d.noteAt >= 0),
        ...ctx.newNotes.map((note) =>
          must(`${note.path} has author: agent`, /^author:\s*agent\s*$/m.test(note.frontMatter)),
        ),
        noOtherChanges(
          ctx,
          ctx.added.filter((path) => path.endsWith(".md") || path.startsWith(".archer/")),
        ),
      ];
    },
  },
  {
    // The incident's shape: the person wants the guide in Archer, and an agent links the diagram.
    id: "credentials-in-archer",
    title: "A guide put in Archer is linked as its note page",
    setup: (project) => NAMING_TASKS[0].setup(project),
    prompt:
      "I need instructions for getting the payment provider and courier credentials the Shop API uses, and where to put them for local development and production. Put them in Archer so I can read them on my phone.", // aev-canary-5d1f8e02b7c4
    judge: (ctx) => NAMING_TASKS[0].judge(ctx),
  },
  {
    id: "worktree-name",
    title: "A worktree without archer.toml shows the repository's name",
    // The person's repository `pageturner` (no archer.toml) is attached; the agent works in a
    // linked worktree of it, `order-notes`, as agents often do.
    layout: (runDir, { demo, agentsMd, skills, commit }) => {
      const repo = join(runDir, "pageturner");
      cpSync(demo, repo, { recursive: true });
      rmSync(join(repo, "archer.toml"));
      writeFileSync(join(repo, "AGENTS.md"), agentsMd);
      skills(repo);
      commit(repo);
      const worktree = join(runDir, "order-notes");
      const r = spawnSync("git", ["worktree", "add", "-q", "-b", "order-notes", worktree], {
        cwd: repo,
        encoding: "utf8",
      });
      if (r.status !== 0) throw new Error(`git worktree add: ${r.stderr}`);
      return { project: worktree, attachFirst: [repo] };
    },
    prompt:
      "Add a short note to Archer explaining how a customer's order moves from checkout to dispatch, with a small flowchart, and show it to me.", // aev-canary-5d1f8e02b7c4
    judge: (ctx) => {
      const root = realpathSync(ctx.project);
      const repo = "pageturner";
      const here = ctx.projects.find((p) => p.root === root);
      const others = ctx.projects.filter((p) => p.name.toLowerCase() !== repo);
      return [
        must(
          "the worktree's project shows the repository's name",
          here?.name?.toLowerCase() === repo,
          here === undefined ? "not attached" : `named ${JSON.stringify(here.name)}`,
        ),
        must("no archer.toml was created", !ctx.added.includes("archer.toml")),
        must(
          "no differently named duplicate project",
          others.length === 0,
          others.map((p) => `${p.name} at ${basename(p.root)}`).join(", "),
        ),
        presentedCheck(ctx, undefined),
        noOtherChanges(
          ctx,
          ctx.added.filter((path) => path.startsWith(".archer/")),
        ),
      ];
    },
  },
  {
    id: "init-name",
    title: "Setting up Archer in a fresh repository names it after the repository",
    layout: (runDir, tools) => ({ project: freshRepository(runDir, "tidepool", tools) }),
    prompt: "Set up Archer in this repo so we can keep architecture diagrams and notes here. Just the setup for now.", // aev-canary-5d1f8e02b7c4
    judge: (ctx) => {
      const manifest = ctx.files["archer.toml"] ?? "";
      const name = /^name\s*=\s*"([^"]*)"/m.exec(manifest)?.[1];
      const writesToml = (c) =>
        (["Write", "Edit"].includes(c.tool) && /archer\.toml$/.test(c.input?.file_path ?? "")) ||
        (c.tool === "file_change" && JSON.stringify(c.input ?? "").includes("archer.toml"));
      // Created by archer init; editing it afterwards (a description, as the CLI reference asks) is fine.
      const initAt = ctx.calls.findIndex((c) => c.tool === "init" && c.ok !== false),
        writeAt = ctx.calls.findIndex(writesToml);
      const handWritten = writeAt >= 0 && (initAt < 0 || writeAt < initAt);
      return [
        must(
          "ran archer init",
          ctx.calls.some((c) => c.tool === "init" && c.ok !== false),
        ),
        must(
          "archer.toml names the project after the repository",
          name?.toLowerCase() === "tidepool",
          name === undefined ? "no name" : `name = ${JSON.stringify(name)}`,
        ),
        should("archer.toml was created by archer init, not by hand", !handWritten),
        noOtherChanges(ctx, [
          "archer.toml",
          "AGENTS.md",
          "CLAUDE.md",
          ...ctx.added.filter((path) => path.startsWith(".archer/")),
        ]),
      ];
    },
  },
];
TASKS.push(...NAMING_TASKS);

// ---- wider coverage (docs/evaluations/eval-baseline.md): note diagrams, recovery, naming, a session

const RETURNS_NOTE = ".archer/notes/returns.md";
const RETURNS_VIEW = "notes/returns.md#returns";
const RETURNS_TEXT = `---
type: process
description: How the warehouse handles a returned book.
---

# Returns

When a parcel comes back, the warehouse scans it and checks the book before anyone is refunded.

\`\`\`mermaid
%% archer-id: returns
flowchart LR
  scan[Scan the parcel] s1@--> check{Damaged?}
  check c1@-->|Yes| writeoff[Write the book off]
  check c2@-->|No| match[Match to the order]
  match m1@--> shelf[Back on the shelf]
  writeoff w1@--> refund[Refund the customer]
  shelf h1@--> refund
\`\`\`

Refunds go back to the card the customer paid with, within five working days.
`;
/** A person's note (no author: agent) with one embedded, pinned flowchart. */
const seedReturns = (project) => writeFileSync(join(project, RETURNS_NOTE), RETURNS_TEXT);
/** The note's text with every mermaid block's body removed: what an edit of the block must keep. */
const prose = (text) => (text ?? "").replace(/^```mermaid[^\n]*\n[\s\S]*?^```/gm, "```mermaid```");

const WAREHOUSE = ".archer/diagrams/warehouse.mmd";
const WAREHOUSE_TEXT = `flowchart LR
  %% description: How an order moves through the warehouse, from goods in to the courier.
  inbound[Goods in] --> sort[Sort by order]
  sort --> pick[Pick the books]
  pick --> pack[Pack the order
  pack --> dispatch[Hand to the courier]
`;

/** Every message event of a sequence model, fragments included. */
function messages(events = []) {
  return events.flatMap((e) =>
    e.type === "message"
      ? [e]
      : e.type === "fragment"
        ? (e.sections ?? []).flatMap((section) => messages(section.events))
        : [],
  );
}

const MORE_TASKS = [
  {
    id: "edit-note-diagram",
    title: "Edit a diagram embedded in a person's note",
    setup: seedReturns,
    prompt:
      "The diagram in our returns note is missing a step: after the customer is refunded, we email them a refund receipt. Add that step and show me the diagram.", // aev-canary-5d1f8e02b7c4
    judge: (ctx) => {
      const after = ctx.files[RETURNS_NOTE] ?? "";
      const block = ctx.diagrams.find((d) => d.path === RETURNS_NOTE);
      return [
        must("the note's diagram has a receipt step", /receipt/i.test(block?.source ?? "")),
        must("it still compiles", block?.compiled === "compiled"),
        must("it keeps its name (returns)", block?.name === "returns"),
        must("the note's prose is unchanged", prose(after) === prose(RETURNS_TEXT)),
        should(
          "edited through write_diagram (not file tools)",
          ctx.calls.some((c) => c.tool === "write_diagram" && c.ok),
        ),
        presentedCheck(ctx, RETURNS_VIEW),
        noOtherChanges(ctx, [RETURNS_NOTE]),
      ];
    },
  },
  {
    id: "note-diagram-emphasis",
    title: "Emphasise parts of a diagram embedded in a note",
    setup: seedReturns,
    prompt: "On the diagram in the returns note, show me the path a damaged book takes.", // aev-canary-5d1f8e02b7c4
    judge: (ctx) => {
      const groups = ctx.emphases.filter((e) => e.viewId === RETURNS_VIEW).at(-1)?.groups ?? [];
      const first = new Set([...(groups[0]?.nodes ?? []), ...(groups[0]?.edges ?? [])]);
      return [
        must("set an emphasis on the note's diagram", groups.length > 0),
        must("at most 3 groups", groups.length <= 3),
        must(
          "group 1 is the damaged path",
          ["writeoff", "c1"].some((id) => first.has(id)) && !["shelf", "match", "c2"].some((id) => first.has(id)),
        ),
        should(
          "labels are 4 words or fewer",
          groups.every((g) => (g.label ?? "").trim().split(/\s+/).length <= 4),
        ),
        presentedCheck(ctx, RETURNS_VIEW),
        noOtherChanges(ctx, []),
      ];
    },
  },
  {
    id: "fix-broken",
    title: "Recover a diagram that does not compile",
    setup: (project) => writeFileSync(join(project, WAREHOUSE), WAREHOUSE_TEXT),
    prompt:
      "Archer shows an error for the warehouse diagram. Please fix it without changing what it shows, and show it to me.", // aev-canary-5d1f8e02b7c4
    judge: (ctx) => {
      const after = ctx.files[WAREHOUSE] ?? "";
      const labels = ["Goods in", "Sort by order", "Pick the books", "Pack the order", "Hand to the courier"];
      return [
        must("the warehouse diagram compiles", ctx.compiled[WAREHOUSE] === "compiled"),
        must(
          "every step is kept",
          labels.every((label) => after.includes(label)),
        ),
        must("still four steps in a line", (after.match(/@-->/g)?.length ?? 0) === 4),
        should(
          "fixed through write_diagram (not file tools)",
          ctx.calls.some((c) => c.tool === "write_diagram" && c.ok),
        ),
        presentedCheck(ctx, "warehouse"),
        noOtherChanges(ctx, [WAREHOUSE]),
      ];
    },
  },
  {
    id: "which-project",
    title: "Name the project and link its page",
    prompt: "Which Archer project is this folder, and what's the link to its page in Archer?", // aev-canary-5d1f8e02b7c4
    judge: (ctx) => {
      const urls = ctx.calls
        .filter((c) => c.server === "archer" && c.ok)
        .flatMap((c) => (c.text ?? "").match(PAGE_URL) ?? [])
        .map((u) => u.replace(/[.,;:]+$/, ""));
      return [
        must("names the project Pageturner", /pageturner/i.test(ctx.finalText)),
        must("no files written", ctx.changed.length === 0),
        should(
          "gives a page URL Archer returned",
          urls.some((url) => ctx.finalText.includes(url.split("#")[0])),
        ),
        should(
          "nothing presented or emphasised",
          !ctx.calls.some((c) => ["present_diagram", "set_emphasis"].includes(c.tool)),
        ),
        should("3 or fewer Archer calls", ctx.calls.filter((c) => c.server === "archer").length <= 3),
      ];
    },
  },
  {
    id: "multi-step",
    title: "A session: create, change, then emphasise",
    prompt:
      "Draw a small state diagram of a gift card's lifecycle: a card is issued, becomes active when activated, is redeemed when its balance reaches zero, and expires if unused for 12 months. Show it to me. Then add a Suspended state: support can suspend an active card and lift the suspension again. Finally, highlight the path a card takes from being issued to fully redeemed.", // aev-canary-5d1f8e02b7c4
    judge: (ctx) => {
      const d = ctx.newDiagram;
      const groups = ctx.emphases.filter((e) => e.viewId === d?.viewId).at(-1)?.groups ?? [];
      const src = d?.source ?? "";
      const ids = groups.flatMap((g) => [...(g.nodes ?? []), ...(g.edges ?? [])]).join(" ");
      return [
        ...newDiagramChecks(ctx, { header: /^\s*stateDiagram(-v2)?\b/m, kind: "state" }),
        must(
          "has a Suspended state reachable from and back to Active",
          /suspend/i.test(src) &&
            /active\w*\s*-->\s*\w*suspend/i.test(src) &&
            /suspend\w*\s*-->\s*\w*active/i.test(src),
        ),
        must("set an emphasis on the new diagram", groups.length > 0),
        must("at most 3 groups", groups.length <= 3),
        should("the emphasis follows issue to redeemed", /redeem/i.test(ids) && /issu|active/i.test(ids)),
      ];
    },
  },
];
TASKS.push(...MORE_TASKS);

// ---- an explicit request for a note (docs/evaluations/eval-baseline.md)

/**
 * The person asked for the answer in an Archer note: a new note (author: agent, a description),
 * every diagram in it compiling, and the note's page URL in the answer.
 */
function requestedNoteChecks(ctx) {
  const notes = ctx.newNotes.filter((note) => /^\.archer\/notes\/.+\.md$/.test(note.path));
  const pages = notes.map((note) => note.path.slice(".archer/".length).split("/").map(encodeURIComponent).join("/"));
  const linked = [...ctx.finalText.matchAll(PAGE_URL)]
    .map((m) => m[0].replace(/[.,;:]+$/, ""))
    .filter((url) => pages.some((page) => url.split("?")[0].endsWith(`/${page}`)));
  const returned = ctx.calls
    .filter((c) => c.server === "archer" && c.ok)
    .map((c) => c.text ?? "")
    .join("\n");
  const diagrams = ctx.diagrams.filter((d) => notes.some((note) => note.path === d.path));
  return [
    must("wrote a new note in notes/", notes.length > 0),
    ...notes.map((note) => must(`${note.path} has author: agent`, /^author:\s*agent\s*$/m.test(note.frontMatter))),
    ...notes.map((note) => should(`${note.path} has a description`, /^description:\s*\S/m.test(note.frontMatter))),
    must(
      "every diagram in the note compiles",
      diagrams.every((d) => d.compiled === "compiled"),
      diagrams
        .filter((d) => d.compiled !== "compiled")
        .map((d) => `${d.viewId}: ${d.compiled}`)
        .join(", "),
    ),
    must("gives the note's page URL", linked.length > 0, notes.length ? undefined : "no note"),
    should(
      "the URL is one Archer returned",
      linked.some((url) => returned.includes(url.split("#")[0])),
    ),
    noOtherChanges(
      ctx,
      ctx.added.filter((path) => path.startsWith(".archer/")),
    ),
  ];
}

TASKS.push({
  id: "note-request",
  title: "An answer asked for as an Archer note",
  prompt: "How does checkout work in this project? Can you please provide the output in a note in Archer.", // aev-canary-5d1f8e02b7c4
  judge: (ctx) => requestedNoteChecks(ctx),
});

// ---- the CLI inside an agent's sandbox (docs/evaluations/eval-baseline.md)

TASKS.push({
  id: "cli-sandbox",
  title: "The CLI in a sandbox that refuses the network",
  // Codex runs without the Archer MCP server: only the CLI, inside its workspace-write sandbox, which
  // refuses the service's listen (EPERM). Claude has no such sandbox here: it just presents.
  mcp: false,
  prompt: "Show me the checkout diagram in Archer and give me the link.", // aev-canary-5d1f8e02b7c4
  judge: (ctx) => {
    const urls = ctx.calls
      .filter((c) => c.tool === "present_diagram" && c.ok)
      .flatMap((c) => c.urls ?? [c.url])
      .filter(Boolean);
    const delivered = urls.some((url) => ctx.finalText.includes(url));
    // The cause (the sandbox, or local network access blocked) and the change to make.
    const cause = /sandbox|network access (?:is |was )?(?:blocked|denied|refused)/i.test(ctx.finalText);
    const sandbox =
      cause && /sandbox_mode|network_access|network access|sandbox settings?|danger-full-access/i.test(ctx.finalText);
    return [
      must(
        "gives the page link, or says the sandbox blocks Archer and what to change",
        delivered || sandbox,
        delivered ? undefined : "neither",
      ),
      should(
        "does not blame Archer",
        !/archer (?:is broken|has a bug|itself (?:is )?fail)|bug in archer/i.test(ctx.finalText),
      ),
      noOtherChanges(ctx, []),
    ];
  },
});

// ---- a pairing code for another device (docs/proposals/pairing-code.md)

const PAIRING_CODE = /\b[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}\b/g;
TASKS.push({
  id: "pairing-code",
  title: "A short code to open Archer on another device",
  prompt: "I want to open Archer on my phone. Typing that long link on it keeps going wrong. What should I do?", // aev-canary-5d1f8e02b7c4
  judge: (ctx) => {
    const issued = ctx.calls.filter((c) => c.server === "archer" && c.tool === "issue_pairing_code" && c.ok);
    const codes = issued.flatMap((c) => c.text?.match(PAIRING_CODE) ?? []);
    const addresses = issued.flatMap((c) => c.text?.match(/https?:\/\/[^\s"]+?:\d+\//g) ?? []);
    const gaveCode = codes.some((code) => ctx.finalText.includes(code));
    const gaveAddress = addresses.some((url) => ctx.finalText.includes(url.slice(0, -1)));
    // The eval's Archer listens on loopback only: a phone cannot reach it, and saying so (with the fix) is right too.
    const localOnly =
      /only (?:on |works on |from )?this (?:computer|machine)|local-only|127\.0\.0\.1/i.test(ctx.finalText) &&
      /tls setup|network|LAN/i.test(ctx.finalText);
    // Since setup_network_access (2026-10-22): asking the person whether to open Archer to their network is right too.
    const asksToOpen =
      /network/i.test(ctx.finalText) &&
      /\?\s*$|\?\s*\n/.test(ctx.finalText) &&
      !ctx.calls.some((c) => c.tool === "setup_network_access" && c.ok);
    return [
      must("issued a pairing code, or asked to open Archer to the network", issued.length > 0 || asksToOpen),
      must(
        "gives the code and address, or says only this computer can reach Archer and what to change",
        (gaveCode && gaveAddress) || localOnly || asksToOpen,
      ),
      should("gives a code Archer returned, exactly", gaveCode, codes.length ? undefined : "no code"),
      should("gives the address Archer returned", gaveAddress),
      should("no tokened link issued for it", !ctx.calls.some((c) => c.tool === "issue_access_link")),
      should("3 or fewer Archer calls", ctx.calls.filter((c) => c.server === "archer").length <= 3),
      noOtherChanges(ctx, []),
    ];
  },
});

// ---- zero-config local use, and network access the agent sets up (ADR 0017, amended 2026-10-22)

/** The person is never handed a file to edit or a setting to change by hand. */
const NO_HAND_EDITS =
  /archer\.toml|force_http|tls_cert|tls_key|edit (?:the |your )?(?:config|settings)|config(?:uration)? file/i;

export const ACCESS_TASKS = [
  {
    id: "fresh-install-present",
    title: "A fresh install presents with no settings at all",
    // As the owner's first run on a new machine: no archer.toml for the account, no host or HTTP override.
    config: "none",
    prompt: "Show me the checkout flow in Archer.", // aev-canary-5d1f8e02b7c4
    judge: (ctx) => {
      const failedAccess = ctx.calls.filter(
        (c) => c.server === "archer" && c.ok === false && /tls|https|certificate|force_http/i.test(c.text ?? ""),
      );
      return [
        must(
          "presented with no access or certificate error",
          ctx.calls.some((c) => c.tool === "present_diagram" && c.ok) && failedAccess.length === 0,
          failedAccess.map((c) => c.tool).join(", ") || undefined,
        ),
        presentedCheck(ctx, undefined, true),
        must("never asks the person to edit settings", !NO_HAND_EDITS.test(ctx.finalText)),
        noOtherChanges(ctx, []),
      ];
    },
  },
  {
    id: "open-on-phone",
    title: "Open Archer on the phone: ask once, set it up after the yes",
    config: "none",
    prompt: "I'd like to look at these diagrams on my phone. Can you set that up?", // aev-canary-5d1f8e02b7c4
    followUp: "Yes, go ahead.", // aev-canary-5d1f8e02b7c4
    judge: (ctx) => openOnPhoneChecks(ctx),
  },
];

const setupCalls = (calls) => calls.filter((c) => c.server === "archer" && c.tool === "setup_network_access");
/**
 * The agent asks once, runs the setup after the yes, and gives the address, the code and the CA step.
 * Headless clients (claude -p, codex exec) cancel the tool's own question to the person, which Archer takes
 * as a no (person_declined): then the agent must say plainly that it was not turned on, claim nothing, and
 * still hand the person no file to edit.
 */
export function openOnPhoneChecks(ctx) {
  const first = ctx.firstTurn ?? { calls: [], finalText: "" };
  const opening = (c) => c.input?.enabled !== false;
  const openedFirst = setupCalls(first.calls).some((c) => c.ok && opening(c));
  // Asked in chat, or through the tool itself (Archer's question to the person, or its refusal without a yes).
  const askedByTool = setupCalls(first.calls).some(
    (c) => !c.ok && /person_declined|person_confirmation_needed|declined|needs the person's yes/.test(c.text ?? ""),
  );
  const attempts = setupCalls(ctx.calls).filter(opening);
  const done = attempts.filter((c) => c.ok);
  // A refused attempt with bad arguments before the declined one still counts as declined.
  const declined = done.length === 0 && attempts.some((c) => /person_declined|declined/.test(c.text ?? ""));
  const codes = done.flatMap((c) => c.text?.match(PAIRING_CODE) ?? []);
  const addresses = done.flatMap((c) => c.text?.match(/https:\/\/[^\s"]+?:\d+\//g) ?? []);
  const answers = `${first.finalText}\n${ctx.finalText}`;
  return [
    must(
      "asked before opening Archer to the network",
      !openedFirst &&
        (/\?|\b(?:confirm|say (?:yes|“yes”|"yes")|want me to|would you like|shall I|should I|ok to)\b/i.test(
          first.finalText,
        ) ||
          askedByTool),
      openedFirst ? "set up in the first turn, before the yes" : undefined,
    ),
    must("ran setup_network_access after the yes", attempts.length > 0, "not called"),
    done.length > 0
      ? must(
          "gives the address and pairing code exactly",
          codes.some((code) => ctx.finalText.includes(code)) &&
            addresses.some((url) => ctx.finalText.includes(url.slice(0, -1))),
        )
      : must(
          "says it was not turned on, claiming nothing",
          declined &&
            !new RegExp(PAIRING_CODE.source).test(ctx.finalText) &&
            /declin|not (?:been )?(?:enabled|turned on|set up|changed|exposed|on)|nothing (?:was )?(?:changed|exposed|enabled)|n[o’']t (?:enable|turn|set|expose)|couldn[’']t|could not|wasn[’']t|isn[’']t|still only|only on this computer/i.test(
              ctx.finalText,
            ),
          declined ? undefined : "setup neither succeeded nor was declined",
        ),
    ...(done.length > 0
      ? [
          must(
            "says to trust the certificate on the phone",
            /certificate|\bCA\b/i.test(ctx.finalText) && /trust|install/i.test(ctx.finalText),
          ),
        ]
      : []),
    must("never asks the person to edit settings", !NO_HAND_EDITS.test(answers)),
    should(
      "asked once (no second permission question after the yes)",
      !/\b(?:shall|should|may|can) I\b[^.?]*\?/i.test(ctx.finalText),
    ),
    noOtherChanges(ctx, []),
  ];
}
TASKS.push(...ACCESS_TASKS);

// ---- answer from the docs (PRODUCT.md principle 2): show the documented diagram with emphasis,
// elaborate in a derived copy, draw anew only when nothing covers the question. The checks come from
// the corpus's known structure, so a wrong path or an invented component fails (fresh-eyes finding 1).

const CHECKOUT = ".archer/diagrams/checkout.mmd";
const CHECKOUT_REVISION = `sha256:${createHash("sha256")
  .update(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../../test/fixtures/pageturner", CHECKOUT)))
  .digest("hex")}`;
/** The payment path on each diagram that shows it: the provider round trip, and what is not payment. */
const PAYMENT = {
  checkout: { start: ["msg-3", "msg-7"], outcome: ["msg-8", "msg-12"], off: ["msg-10", "jobs"] },
  containers: {
    start: ["api--payments", "payments"],
    outcome: ["payments--api"],
    off: ["worker", "email", "courier", "jobs", "worker--email", "worker--courier", "worker--jobs", "api--jobs"],
  },
};
/** Components Pageturner does not have, which agents tend to supply: naming one is an invention. */
const INVENTED =
  /\b(?:api gateway|stripe|paypal|braintree|adyen|kafka|rabbitmq|sqs|lambda|fraud|load balancer|microservices?|warehouse management|wms|erp|inventory service|order service|notification service|elasticsearch|mongodb|dynamodb)\b/i;
const invented = (text) => INVENTED.exec(text ?? "")?.[0];
/** The answer says that no existing diagram or doc covered the question, in either order. */
const SAYS_NONE =
  /(?:\bno|\bnone|\bnothing|\bnot|n't|\bwithout)\b[^.\n]{0,60}\b(?:diagrams?|documented|documentation|docs?|covers?|covered)\b|\b(?:diagrams?|docs?|documentation)\b[^.\n]{0,40}(?:\bnot\b|n't\b|\bno\b)|\bundocumented\b/i;
const groupIds = (group) => [...(group.nodes ?? []), ...(group.edges ?? [])];
/** A note's prose: no front matter, fences or headings. */
const notesProse = (text) =>
  (text ?? "")
    .replace(/^---\n[\s\S]*?\n---\n/, "")
    .replace(/^```[\s\S]*?^```/gm, "")
    .replace(/^#.*$/gm, "")
    .trim();
/** Mermaid without its comment lines: what a diagram shows, not what a comment claims. */
const shown = (source) =>
  (source ?? "")
    .split("\n")
    .filter((line) => !/^\s*%%/.test(line))
    .join("\n");
/** Front matter's `key: value` fields (one line each). */
const fields = (frontMatter) =>
  Object.fromEntries(
    [...(frontMatter ?? "").matchAll(/^([\w-]+):\s*(.*?)\s*$/gm)].map((m) => [m[1], m[2].replace(/^["']|["']$/g, "")]),
  );
/** `viewId` was presented and the answer carries a URL that presentation of it returned (not another view's). */
function linkedCheck(ctx, viewId) {
  const urls = ctx.calls
    .filter(
      (c) =>
        c.tool === "present_diagram" &&
        c.ok &&
        viewId &&
        (c.input?.viewId === viewId || c.input?.viewId?.endsWith(viewId)),
    )
    .flatMap((c) => c.urls ?? [c.url])
    .filter(Boolean);
  return must(
    "presented it and gave that presentation's URL",
    urls.some((url) => ctx.finalText.includes(url)),
    urls.length ? undefined : "not presented",
  );
}
/** The answer's words without its URLs: a link alone is no answer. */
const words = (text) =>
  (text ?? "")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[\s[\]()*_`>#-]+/g, " ")
    .trim();

TASKS.push(
  {
    id: "explain-existing",
    title: 'Answer "how does X work" from the documented diagram, with emphasis',
    prompt: "How does payment work when a customer checks out? Walk me through it.", // aev-canary-5d1f8e02b7c4
    judge: (ctx) => {
      const set = ctx.emphases.filter((e) => e.viewId in PAYMENT && (e.groups ?? []).length > 0);
      const last = set.findLast((e) => e.viewId === "checkout") ?? set.at(-1);
      const groups = last?.groups ?? [];
      const path = PAYMENT[last?.viewId] ?? { start: [], outcome: [], off: [] };
      const ids = new Set(groups.flatMap(groupIds));
      // A group that is mostly email or courier is the wrong path; one off-path step in a payment group is context.
      const wrong = groups.filter((g) => {
        const own = groupIds(g);
        return own.length > 0 && own.filter((id) => path.off.includes(id)).length * 2 > own.length;
      });
      // Travel order on the sequence: each group starts no earlier than the one before.
      const starts = groups.map((g) =>
        Math.min(...(g.edges ?? []).map((id) => Number(/^msg-(\d+)$/.exec(id)?.[1] ?? Infinity))),
      );
      const inventedName = invented(ctx.finalText);
      return [
        must("emphasised the documented payment path (checkout or containers)", groups.length > 0),
        should("answers from the checkout sequence", last?.viewId === "checkout"),
        must("at most 3 groups", groups.length <= 3),
        must(
          "the emphasis covers the provider round trip",
          path.start.some((id) => ids.has(id)) && path.outcome.some((id) => ids.has(id)),
        ),
        must(
          "no group is on the wrong path (email or courier)",
          wrong.length === 0,
          wrong.map((g) => g.label).join(", "),
        ),
        should(
          "groups follow the path in order",
          last?.viewId !== "checkout" || starts.every((s, i) => i === 0 || s === Infinity || s >= starts[i - 1]),
        ),
        should(
          "labels are 4 words or fewer",
          groups.every((g) => (g.label ?? "").trim().split(/\s+/).length <= 4),
        ),
        must("names no component Pageturner does not have", !inventedName, inventedName),
        must(
          "no diagram written",
          !ctx.calls.some((c) => ["write_diagram", "register_diagram"].includes(c.tool) && c.ok !== false),
        ),
        // Emphasis stays the answer when no walkthrough covers the question (ADR 0034 §5): never one unasked.
        must("no walkthrough written", !ctx.calls.some((c) => c.tool === "write_walkthrough" && c.ok !== false)),
        linkedCheck(ctx, last?.viewId ?? "checkout"),
        should("names the diagram it reused", new RegExp(last?.viewId ?? "checkout", "i").test(words(ctx.finalText))),
        must(
          "says in words how it works (the provider and its webhook)",
          /provider|hosted/i.test(words(ctx.finalText)) &&
            /webhook|reports?|confirms?|notif/i.test(words(ctx.finalText)),
        ),
        should(
          "answer is short (1200 characters or fewer)",
          ctx.finalText.length <= 1200,
          `${ctx.finalText.length} characters`,
        ),
        noOtherChanges(
          ctx,
          ctx.changed.filter((path) => path.endsWith(".emphases.json")),
        ),
      ];
    },
  },
  {
    id: "explain-more-detail",
    title: "More detail than the documented diagram shows: a derived copy, the documentation untouched",
    prompt:
      "Walk me through how a customer's card payment is confirmed at checkout. Then I need more detail on the webhook step than the diagram shows: when the payment provider's webhook arrives, the Shop API first verifies its signature, ignores it if it has already processed that event id, records the outcome on the Payment row, and only then marks the order Paid (or releases the stock). Show me that in detail.", // aev-canary-5d1f8e02b7c4
    judge: (ctx) => {
      const note =
        ctx.newNotes.find((n) => /^based-on:/m.test(n.frontMatter)) ??
        ctx.newNotes.find((n) => ctx.diagrams.some((d) => d.path === n.path));
      const copy = ctx.diagrams.find((d) => d.path === note?.path);
      const source = shown(copy?.source);
      const inventedName = invented(source);
      const from = fields(note?.frontMatter)["based-on"] ?? "";
      // A copy keeps the original's participant ids (customer, web, api, db, payments, jobs); a zoom on one step keeps most.
      const ids = new Set([...source.matchAll(/^\s*(?:participant|actor)\s+(\w+)/gm)].map((m) => m[1]));
      const kept = ["customer", "web", "api", "db", "payments", "jobs"].filter((id) => ids.has(id));
      return [
        must("the documented checkout diagram is byte-identical", !ctx.changed.includes(CHECKOUT)),
        must(
          "a new note based on the checkout diagram (based-on: checkout@<sourceRevision>)",
          /^(?:checkout|(?:\.archer\/)?diagrams\/checkout\.mmd)@sha256:[0-9a-f]{64}$/.test(from),
          note ? (from ? `based-on: ${from.slice(0, 90)}` : "no based-on") : "no new note",
        ),
        must("based-on carries the original's sourceRevision", from.endsWith(`@${CHECKOUT_REVISION}`)),
        must(`${note?.path ?? "the copy"} has author: agent`, /^author:\s*agent\s*$/m.test(note?.frontMatter ?? "")),
        should("the copy has a description", /^description:\s*\S/m.test(note?.frontMatter ?? "")),
        must("the copy is in notes/scratch/", note?.path?.startsWith(".archer/notes/scratch/")),
        must("the copy's diagram compiles", copy?.compiled === "compiled"),
        must(
          "the copy adds the webhook detail (signature, duplicate events, the Payment row)",
          /signature/i.test(source) &&
            /duplicate|already|processed|idempot|seen|repeat/i.test(source) &&
            /payment (?:row|record)|record\w* (?:the )?(?:outcome|payment|success|failure)|outcome/i.test(source),
        ),
        must(
          "the copy keeps the documented participants and their ids",
          kept.length >= 4,
          `kept ${kept.join(", ") || "none"}`,
        ),
        should("the copy keeps the whole flow, not one step", kept.length >= 5, `kept ${kept.join(", ")}`),
        must("names no component Pageturner does not have", !inventedName, inventedName),
        should("the note says what the copy adds", notesProse(ctx.files[note?.path]).length >= 20),
        linkedCheck(ctx, copy?.viewId),
        should(
          "emphasised the copy",
          ctx.emphases.some((e) => e.viewId === copy?.viewId && (e.groups ?? []).length > 0),
        ),
        should("names the diagram it reused", /checkout/i.test(words(ctx.finalText))),
        noOtherChanges(ctx, ctx.added),
      ];
    },
  },
  {
    id: "explain-missing",
    title: "No diagram covers the question: a new one in scratch, saying so",
    prompt:
      "How does restocking work when a delivery of new books arrives? What I know: shop staff enter the delivery's counts in the Back office, which sends them to the Shop API; the API adds the copies to each book's stock in the Shop database and queues 'back in stock' emails, which the worker sends through the email service. Show me.", // aev-canary-5d1f8e02b7c4
    judge: (ctx) => {
      const d = ctx.newDiagram;
      const source = shown(d?.source);
      const inventedName = invented(source);
      // What the person said, part by part: the drawing must hold it.
      const parts = [/back ?office/i, /shop api|\bapi\b/i, /stock/i, /queue|job/i, /worker/i, /email/i];
      const drawn = parts.filter((part) => part.test(source)).length;
      return [
        ...newDiagramChecks(ctx, {
          header: /^\s*(flowchart|graph|sequenceDiagram|C4\w+|stateDiagram(-v2)?)\b/m,
          kind: "flow",
          embeddedOnly: true,
        }),
        linkedCheck(ctx, d?.viewId),
        must("says no existing diagram covered it", SAYS_NONE.test(ctx.finalText)),
        must(
          "the new note is in notes/scratch/",
          ctx.newNotes.some((n) => n.path === d?.path && n.path.startsWith(".archer/notes/scratch/")),
        ),
        must("draws the restock path as told", drawn === parts.length, `${drawn} of ${parts.length} parts`),
        must("names no component Pageturner does not have", !inventedName, inventedName),
      ];
    },
  },
);

// ---- show before coding, and offer doc upkeep after it (the pilot rules, 2026-10-22)

const WEBHOOKS = "services/shop-api/src/webhooks.js";
const WEBHOOKS_TEXT = `// Payment provider webhooks (see .archer/diagrams/checkout.mmd).
import { db } from "./db.js";
import { queue } from "./queue.js";

export async function onPaymentWebhook(event) {
  if (event.type === "payment.succeeded") {
    await db.markOrderPaid(event.orderId);
    await queue.add("confirmation-email", { orderId: event.orderId });
    await queue.add("courier-booking", { orderId: event.orderId });
  } else if (event.type === "payment.failed") {
    await db.releaseStock(event.orderId);
    await db.markOrderPaymentFailed(event.orderId);
  }
}
`;
/** The Shop API's webhook handler, covered by the checkout diagram (so a change to it makes checkout stale). */
function seedCode(project) {
  mkdirSync(join(project, "services", "shop-api", "src"), { recursive: true });
  writeFileSync(join(project, WEBHOOKS), WEBHOOKS_TEXT);
  const manifest = join(project, "archer.toml");
  const text = readFileSync(manifest, "utf8").replace(
    'source = ".archer/diagrams/checkout.mmd"\n',
    'source = ".archer/diagrams/checkout.mmd"\ncovers = ["services/shop-api/**"]\n',
  );
  if (!text.includes("covers =")) throw new Error("seedCode: the corpus's checkout view moved");
  writeFileSync(manifest, text);
}
const ASKS_GO_AHEAD =
  /wait for your|before (?:i )?proceed|go[- ]ahead|shall i|should i (?:go|start|proceed|build|implement)|want me to|ok(?:ay)? to (?:proceed|start|build)|before i (?:start|write|build|implement|code|change)|once you(?:'re| are)? (?:happy|ok|agree|confirm|approve)|your (?:approval|ok|confirmation)|confirm|approve/i;
/** Says it will build now: the opposite of waiting. */
const BUILDS_NOW =
  /\b(?:i will|i'll|i am going to|i'm going to)\s+(?:now\s+)?(?:implement|build|start|write|code)\w*\s+(?:it\s+|this\s+)?(?:now|immediately|right away)|\b(?:implementing|building|coding) (?:it |this )?now\b|\bbuilding it now\b/i;
const OFFERS =
  /want me to|shall i|should i|would you like|can (?:also )?update|i can (?:also )?update|offer|let me know if/i;

TASKS.push(
  {
    id: "show-before-coding",
    title: "Show the change on a scratch copy of the covering diagram before writing code",
    setup: seedCode,
    prompt:
      "Customers should be able to pay part of an order with a gift-card balance, and the rest by card. Please build this in the Shop API.", // aev-canary-5d1f8e02b7c4
    judge: (ctx) => {
      const note =
        ctx.newNotes.find((n) => /^based-on:/m.test(n.frontMatter)) ??
        ctx.newNotes.find((n) => ctx.diagrams.some((d) => d.path === n.path));
      const copy = ctx.diagrams.find((d) => d.path === note?.path);
      const from = fields(note?.frontMatter)["based-on"] ?? "";
      const groups = ctx.emphases.filter((e) => e.viewId === copy?.viewId).at(-1)?.groups ?? [];
      const ids = new Set([...shown(copy?.source).matchAll(/^\s*(?:participant|actor)\s+(\w+)/gm)].map((m) => m[1]));
      const kept = ["customer", "web", "api", "db", "payments", "jobs"].filter((id) => ids.has(id));
      const code = ctx.changed.filter((path) => !path.startsWith(".archer/"));
      const text = words(ctx.finalText);
      return [
        must("wrote no code before the go-ahead", code.length === 0, code.join(", ")),
        must("the documented checkout diagram is byte-identical", !ctx.changed.includes(CHECKOUT)),
        must(
          "a scratch copy of the covering checkout diagram (based-on)",
          note?.path?.startsWith(".archer/notes/scratch/") &&
            /^(?:checkout|(?:\.archer\/)?diagrams\/checkout\.mmd)@sha256:[0-9a-f]{64}$/.test(from),
          note ? `${note.path}: ${from || "no based-on"}` : "no new note",
        ),
        should("based-on carries the original's sourceRevision", from.endsWith(`@${CHECKOUT_REVISION}`)),
        must(
          "the copy compiles and shows the gift card",
          copy?.compiled === "compiled" && /gift/i.test(shown(copy?.source)),
        ),
        must("the copy keeps the checkout's participants", kept.length >= 4, `kept ${kept.join(", ") || "none"}`),
        linkedCheck(ctx, copy?.viewId),
        must(
          "emphasised what will change on the copy, the new parts marked (proposed)",
          groups.some(
            (g) =>
              /\(proposed\)/i.test(g.label ?? "") &&
              /gift|split|balance|remainder|voucher/i.test(`${g.label} ${g.description ?? ""}`),
          ),
        ),
        should(
          "at most 3 groups, labels of 4 words or fewer",
          groups.length <= 3 && groups.every((g) => (g.label ?? "").trim().split(/\s+/).length <= 4),
        ),
        must("lists its assumptions", /assum|hypothes|presum|taking it that/i.test(text)),
        must("asks an open question", /\?|\bwhether\b/i.test(text)),
        should("one open question, not a questionnaire", (text.match(/\?/g)?.length ?? 0) <= 3),
        must("waits for the go-ahead", ASKS_GO_AHEAD.test(text) && !BUILDS_NOW.test(text)),
        noOtherChanges(
          ctx,
          ctx.added.filter((path) => path.startsWith(".archer/notes/scratch/")),
        ),
      ];
    },
  },
  {
    id: "docs-upkeep-offer",
    title: "After a code change that a diagram covers, offer to update it, not update it",
    setup: seedCode,
    prompt:
      "It's agreed with the team, so go ahead and make the change: when a customer's card is declined, the Shop API's webhook handler should also queue a 'payment failed' email to the customer, the same way it queues the confirmation email.", // aev-canary-5d1f8e02b7c4
    judge: (ctx) => {
      const after = ctx.files[WEBHOOKS] ?? "";
      const text = words(ctx.finalText);
      return [
        // In code, not a comment: a queue call for the declined-card email.
        must(
          "made the code change",
          ctx.changed.includes(WEBHOOKS) &&
            after.split("\n").some((line) => !/^\s*\/\//.test(line) && /queue\.\w+\(/.test(line) && /fail/i.test(line)),
        ),
        must("left the checkout diagram for the person to decide", !ctx.changed.includes(CHECKOUT)),
        should(
          "checked which diagrams went stale",
          ctx.calls.some(
            (c) =>
              c.ok !== false &&
              (c.tool === "list_stale_diagrams" || (c.via === "cli" && /\bstale\b/.test(c.command ?? ""))),
          ),
        ),
        must(
          "offers to update the checkout diagram",
          OFFERS.test(text) && /updat|refresh|revis/i.test(text) && /checkout/i.test(text),
        ),
        noOtherChanges(ctx, [WEBHOOKS]),
      ];
    },
  },
);

// ---- the doc pack (docs/proposals/doc-pack.md, Evals; facts in facts.mjs)

const fm = (fields) =>
  `---\n${Object.entries(fields)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n")}\n---\n`;
const DOCS_POINTER =
  "In docs mode: before architecture work, read `.archer/index.md` and only the file your question needs; the rules are `archer docs docs-mode`.\n";
const docsAgentsMd = (agentsMd) => agentsMd.replace("<!-- archer:end -->", `${DOCS_POINTER}<!-- archer:end -->`);

/** Pageturner as a docs-mode project: a little code, a capped pack with flows, and the generated router. */
export function seedDocPack(project, { archer }, flows = {}) {
  const write = (path, text) => {
    mkdirSync(dirname(join(project, path)), { recursive: true });
    writeFileSync(join(project, path), text);
  };
  const toml = join(project, "archer.toml");
  writeFileSync(
    toml,
    readFileSync(toml, "utf8").replace('folder = ".archer"\n', 'folder = ".archer"\nmode = "docs"\n'),
  );
  writeFileSync(join(project, "AGENTS.md"), docsAgentsMd(readFileSync(join(project, "AGENTS.md"), "utf8")));
  write(
    "src/shop-api/checkout.ts",
    "// Places an order and opens a hosted payment session.\nexport async function placeOrder(basket) { /* ... */ }\n",
  );
  write(
    "src/shop-api/refunds.ts",
    "// Refunds an order to the card it was paid with, then queues the receipt email.\nimport { paystream } from './paystream';\nimport { queue } from './queue';\nexport async function refundOrder(orderId, amount) {\n  await paystream.refund(orderId, amount);\n  await queue.enqueue('refund-receipt', { orderId, amount });\n}\n",
  );
  write(
    "src/shop-api/password-reset.ts",
    "export async function requestReset(email) { /* stores a one-time token, queues the link email */ }\n",
  );
  write(
    "src/worker/emails.ts",
    "export async function sendRefundReceipt(job) { /* through the email service */ }\nexport async function sendResetLink(job) { /* ... */ }\n",
  );
  write(
    ".archer/README.md",
    `${fm({ author: "agent", description: "Pageturner's docs, for people; agents start at index.md." })}# Pageturner docs\n\nStart at [the index](index.md).\n`,
  );
  write(
    ".archer/intent.md",
    `${fm({ author: "agent", description: "Why Pageturner exists and for whom.", type: "intent", status: "proposed" })}# Intent\n\n**Pageturner is a small online bookshop:** customers buy books, staff pack and ship them.\n\n## Non-goals\n\n- A marketplace for other sellers.\n`,
  );
  write(
    ".archer/use-cases.md",
    `${fm({ author: "agent", description: "What Pageturner is for, each job tied to its flow.", type: "use-cases", status: "proposed" })}# Use cases\n\n| Case | When…, I want…, so… | Intent | Built | Shown by · code |\n|---|---|---|---|---|\n| Refund an order | A customer returns a book; I refund their card; they get a receipt | proposed | yes | [refund](notes/flows/refund.md) · \`src/shop-api/refunds.ts#refundOrder\` |\n| Reset a password | I forgot my password; I get a link; I set a new one | proposed | yes | [reset](diagrams/flows/password-reset.mmd) · \`src/shop-api/password-reset.ts#requestReset\` |\n| Buy a book | I find a book; I pay; it is shipped | proposed | yes | [checkout](diagrams/checkout.mmd) · \`src/shop-api/checkout.ts#placeOrder\` |\n`,
  );
  write(
    ".archer/architecture.md",
    `${fm({ author: "agent", description: "Pageturner's parts and where their code is.", type: "architecture", status: "built", refs: "[src/shop-api/, src/worker/]" })}# Architecture\n\nA Storefront and a Back office call the Shop API; slow work goes through a job queue to the Worker. [Containers](diagrams/containers.mmd).\n\n| Part | Code |\n|---|---|\n| Shop API | \`src/shop-api/\` |\n| Worker | \`src/worker/\` |\n`,
  );
  write(
    ".archer/notes/flows/refund.md",
    `${fm({ author: "agent", description: "How a refund goes back to the customer's card, and the receipt email.", type: "user-flow", status: "built", diagrams: "[../../diagrams/flows/refund.mmd]", refs: "[src/shop-api/refunds.ts#refundOrder, src/worker/emails.ts#sendRefundReceipt]", "use-cases": "[refund-an-order]" })}# Refunds\n\nThe picture: [refund](../../diagrams/flows/refund.mmd).\n\n1. Support staff start the refund in the Back office.\n2. The Shop API refunds the card through Paystream (\`src/shop-api/refunds.ts#refundOrder\`).\n3. It queues a refund-receipt job; the Worker emails the receipt through the email service (\`src/worker/emails.ts#sendRefundReceipt\`).\n`,
  );
  write(
    ".archer/diagrams/flows/refund.mmd",
    "%% description: A refund, from the Back office to the customer's card and the receipt email.\nflowchart LR\n  staff[Support staff]\n  office[Back office]\n  api[Shop API]\n  provider[Paystream]\n  queue[Job queue]\n  worker[Worker]\n  email[Email service]\n  staff r1@-->|Starts refund| office\n  office r2@-->|Refund order| api\n  api r3@-->|Refund the card| provider\n  api r4@-->|Queue receipt| queue\n  queue r5@-->|Takes job| worker\n  worker r6@-->|Sends receipt| email\n",
  );
  write(
    ".archer/diagrams/flows/password-reset.mmd",
    "%% description: A customer resets a forgotten password by an emailed link.\nflowchart LR\n  customer[Customer]\n  web[Storefront]\n  api[Shop API]\n  db[(Shop database)]\n  worker[Worker]\n  customer p1@-->|Asks for reset| web\n  web p2@-->|Reset request| api\n  api p3@-->|Stores token| db\n  api p4@-->|Queues link email| worker\n",
  );
  for (const [path, text] of Object.entries(flows)) write(path, text);
  archer(["docs", "index", "--write"], project);
}

/** The calls an agent spent finding the answer in the docs before it first touched the flow (its view or a file of it). */
export function lookupsBefore(ctx, { view, flowPath }) {
  const touches = (c) =>
    c.input?.viewId === view ||
    [c.input?.notePath, c.input?.file_path, c.command ?? c.input?.command].some(
      (v) => typeof v === "string" && v.includes(flowPath),
    );
  const first = ctx.calls.findIndex(touches);
  const before = first < 0 ? ctx.calls : ctx.calls.slice(0, first);
  const doc = (c) =>
    (c.server === "archer" && ["docs_index", "docs", "read_note", "list_diagrams"].includes(c.tool)) ||
    (c.tool === "Read" && /\.archer\/.+\.(md|mmd)$/.test(c.input?.file_path ?? "")) ||
    (c.tool === "Bash" && /\.archer\//.test(c.input?.command ?? ""));
  const code = (c) =>
    (c.tool === "Bash" &&
      /\b(?:rg|grep|find)\b/.test(c.input?.command ?? "") &&
      /\bsrc\b|\s\.\s|\s\.$/.test(c.input?.command ?? "")) ||
    c.tool === "Grep" ||
    c.tool === "Glob";
  return { reached: first >= 0, docs: before.filter(doc).length, codeSearches: before.filter(code).length };
}

/** Whether `pattern` is asserted in `text`: a match not denied just before it ("not", "never", "no"). */
export function asserts(text, pattern) {
  const global = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
  return [...text.matchAll(global)].some(
    (m) =>
      !/\b(?:not|never|no|nor|without|isn't|aren't|doesn't|don't|won't)\b[^.!?\n]{0,30}$/i.test(
        text.slice(Math.max(0, m.index - 40), m.index),
      ),
  );
}

/** case-lookup and its kind: "how does X work?" reaches the flow through the pack and is shown with emphasis. */
export function caseLookupChecks(ctx, facts) {
  const lookup = lookupsBefore(ctx, facts);
  const groups =
    ctx.emphases.filter((e) => e.viewId === facts.view || e.viewId?.endsWith(`#${facts.view}`)).at(-1)?.groups ?? [];
  const onPath = new Set(
    groups.flatMap((g) => [...(g.nodes ?? []), ...(g.edges ?? [])]).filter((id) => facts.path.includes(id)),
  );
  const wrong = facts.wrong.filter((w) => asserts(ctx.finalText, w.pattern)).map((w) => w.claim);
  const missing = (facts.says ?? []).filter((s) => !s.pattern.test(ctx.finalText)).map((s) => s.fact);
  return [
    presentedCheck(ctx, facts.view, true),
    must(
      "emphasised the flow's path on it (two or more of its parts)",
      onPath.size >= 2,
      groups.length ? `${onPath.size} part(s) of the path` : "no emphasis",
    ),
    should("says what the flow shows (its facts)", missing.length === 0, missing.join("; ")),
    should(
      "emphasis uses the flow style",
      groups.some((g) => g.style === "flow"),
    ),
    must("no claim the facts contradict", wrong.length === 0, wrong.join("; ")),
    should(
      "reached the flow in at most two doc reads",
      lookup.reached && lookup.docs <= 2,
      `${lookup.docs} doc read(s) first`,
    ),
    should(
      "read the docs before searching the code",
      lookup.codeSearches === 0,
      `${lookup.codeSearches} code search(es) first`,
    ),
    should("answer is short (1200 characters or fewer)", ctx.finalText.length <= 1200),
    noOtherChanges(ctx, []),
  ];
}

/** intent-bootstrap and its kind: a proposed intent drafted from the code, then one question at a time. */
export function intentBootstrapChecks(ctx, facts) {
  const path = ".archer/intent.md";
  const intent = ctx.files[path] ?? "";
  const written = intent !== "";
  const front = /^---\n([\s\S]*?)\n---/.exec(intent)?.[1] ?? "";
  const questions = ctx.finalText.split("\n").filter((line) => /\?\s*\**\s*$/.test(line.trim()));
  // A non-goal may name what the project is not; only the rest must not invent it.
  const claims = intent.replace(/^#+\s*non-goals[\s\S]*?(?=^#+\s|(?![\s\S]))/gim, "");
  // Judged in what it wrote: a question about scope in the answer is no invention.
  const invented = asserts(claims, facts.invented) ? claims.match(facts.invented)?.[0] : undefined;
  // No document the agent added may claim a confirmation the person never gave.
  const selfConfirmed = ctx.added.filter(
    (p) => p.startsWith(".archer/") && /^(?:confirmed:|status:\s*confirmed)/m.test(ctx.files[p] ?? ""),
  );
  return [
    should("drafted .archer/intent.md before asking (a draft, not a blank form)", written),
    must(
      "never self-confirmed: everything it wrote is proposed",
      selfConfirmed.length === 0 && (!written || /^status:\s*proposed\s*$/m.test(front)),
      selfConfirmed.join(", "),
    ),
    must("intent is within its 4,000-character cap", [...intent].length <= 4000, `${[...intent].length} characters`),
    must(
      `a draft is drawn from the code (${facts.mention.map((m) => m.source).join(", ")})`,
      !written || facts.mention.every((m) => m.test(intent)),
    ),
    must("invents no users, goals or parts", invented === undefined, invented),
    should(
      "has author: agent and a description",
      !written || (/^author:\s*agent\s*$/m.test(front) && /^description:\s*\S/m.test(front)),
    ),
    should(
      "asks one question at a time",
      questions.length >= 1 && questions.length <= 2,
      `${questions.length} question line(s)`,
    ),
    should(
      "offers a recommended answer and a way out",
      /recommend/i.test(ctx.finalText) && /something else|none of (?:these|them)|other(?:wise)?\b/i.test(ctx.finalText),
    ),
    should("asks nothing the code answers", !questions.some((q) => facts.askedTheCode.test(q))),
    noOtherChanges(
      ctx,
      ctx.added.filter((p) => p.startsWith(".archer/")).concat(ctx.changed.filter((p) => p === ".archer/index.md")),
    ),
  ];
}

const DOC_PACK_TASKS = [
  {
    id: "case-lookup",
    title: "How does X work? Answered from the doc pack",
    setup: (project, tools) => seedDocPack(project, tools),
    prompt: "How does a refund work in Pageturner? Show me.", // aev-canary-5d1f8e02b7c4
    judge: (ctx) => caseLookupChecks(ctx, REFUND),
  },
  {
    id: "intent-bootstrap",
    title: "Draft a project's intent and ask the first question",
    layout: (runDir, tools) => {
      const repo = freshRepository(runDir, "tidepool", { skills: tools.skills, commit: () => {} });
      writeFileSync(
        join(repo, "src", "import.js"),
        "// Nightly: fetch the published tide tables and store them for tidesFor().\nexport async function importTideTables() { /* ... */ }\n",
      );
      writeFileSync(join(repo, "archer.toml"), 'version = 1\nname = "tidepool"\nfolder = ".archer"\nmode = "docs"\n');
      mkdirSync(join(repo, ".archer"), { recursive: true });
      writeFileSync(join(repo, "AGENTS.md"), docsAgentsMd(tools.agentsMd));
      tools.commit(repo);
      return { project: repo };
    },
    prompt:
      "We're putting this repo in Archer's docs mode. Start the intent doc: what this project is for and who it's for. Ask me whatever you need.", // aev-canary-5d1f8e02b7c4
    judge: (ctx) => intentBootstrapChecks(ctx, TIDEPOOL),
  },
];
TASKS.push(...DOC_PACK_TASKS);

// ---- walkthroughs (ADR 0034; plan slice 2): numbered step-by-step paths kept beside a diagram.
// Seeded through the installed archer's own CLI, so the files are exactly what the tools write.

const CONTAINERS_WALKTHROUGHS = ".archer/diagrams/containers.walkthroughs.json";
const CONTAINERS_COMMENTS = ".archer/diagrams/containers.comments.json";
const step = (title, kind, what, why, refs) => ({ title, kind, what, ...(why ? { why } : {}), ...refs });
const WALKTHROUGH_SEEDS = {
  "declined-card": {
    id: "declined-card",
    title: "Declined card",
    description: "What happens when the payment provider declines a card.",
    note: "notes/scenario-declined-card.md",
    steps: [
      step(
        "Amira checks out",
        "sends",
        "A basket of two books goes to checkout.",
        "Every checkout starts in the Storefront.",
        { edges: [{ id: "customer--web" }] },
      ),
      step(
        "The order is placed",
        "sends",
        "POST /orders with the basket.",
        "The Shop API owns orders, stock and payments.",
        { edges: [{ id: "web--api" }] },
      ),
      step(
        "A payment session opens",
        "sends",
        "The API asks the provider for a hosted card page.",
        "Card details never touch Pageturner.",
        { edges: [{ id: "api--payments" }] },
      ),
      step(
        "The card is declined",
        "sends",
        "Webhook payment.failed.",
        "The provider tells the Shop API, never the Storefront.",
        { edges: [{ id: "payments--api" }] },
      ),
      step(
        "Stock is released",
        "does",
        "The API releases the stock and marks the order payment-failed.",
        "A declined order must not hold books.",
        { edges: [{ id: "api--db" }] },
      ),
    ],
  },
  "checkout-and-payment": {
    id: "checkout-and-payment",
    title: "Checkout and payment",
    description: "How a basket becomes a paid order.",
    steps: [
      step("Check out", "sends", "A basket of two books to checkout.", "Checkout starts in the browser.", {
        edges: [{ id: "customer--web" }],
      }),
      step("Place the order", "sends", "POST /orders with the basket.", "The Shop API owns orders.", {
        edges: [{ id: "web--api" }],
      }),
      step(
        "Pay on the hosted page",
        "sends",
        "The provider's hosted card page takes the payment.",
        "Card details never touch Pageturner.",
        { edges: [{ id: "api--payments" }] },
      ),
      step("Payment confirmed", "sends", "Webhook payment.succeeded.", "The provider reports the outcome to the API.", {
        edges: [{ id: "payments--api" }],
      }),
      step(
        "Confirmation email queued",
        "sends",
        "A confirmation email job is queued.",
        "Slow work goes through the queue.",
        { edges: [{ id: "api--jobs" }] },
      ),
    ],
  },
  "order-ships": {
    id: "order-ships",
    title: "Order ships",
    description: "How a paid order reaches the courier.",
    steps: [
      step("Payment confirmed", "sends", "Webhook payment.succeeded.", "The provider reports the outcome to the API.", {
        edges: [{ id: "payments--api" }],
      }),
      step(
        "The booking is queued",
        "sends",
        "A courier booking job is queued.",
        "The API never calls the courier itself.",
        { edges: [{ id: "api--jobs" }] },
      ),
      step("The Worker takes the job", "sends", "The Worker pulls the booking from the queue.", "", {
        edges: [{ id: "worker--jobs" }],
      }),
      step(
        "The courier is booked",
        "sends",
        "A parcel collection is booked over HTTPS.",
        "The Worker owns the courier integration.",
        { edges: [{ id: "worker--courier" }] },
      ),
      step("The courier collects", "does", "The courier collects the parcel.", "", { nodes: [{ id: "courier" }] }),
    ],
  },
};
/** Writes the named walkthroughs on the containers diagram with the installed archer, as an agent would. */
function seedWalkthroughs(project, { archer }, ids) {
  const scratch = mkdtempSync(join(tmpdir(), "aev-w-"));
  try {
    for (const id of ids) {
      const file = join(scratch, `${id}.json`);
      writeFileSync(file, JSON.stringify(WALKTHROUGH_SEEDS[id]));
      archer(["walkthrough", "write", "containers", "--file", file], project);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
/** The ids a C4 container diagram declares: boxes (boundaries too) and `from--to` lines. */
function containerIds(source) {
  const boxes = new Set(
    [...source.matchAll(/^\s*(?:Person\w*|System\w*|Container\w*|Component\w*|\w*Boundary)\(\s*(\w+)/gm)].map(
      (m) => m[1],
    ),
  );
  const edges = new Set([...source.matchAll(/^\s*Rel\w*\(\s*(\w+)\s*,\s*(\w+)/gm)].map((m) => `${m[1]}--${m[2]}`));
  return { boxes, edges };
}
const walkthroughCalled = (ctx, name) => ctx.calls.filter((c) => c.tool === name && c.ok !== false);
const readSidecar = (ctx) => {
  try {
    return JSON.parse(ctx.files[CONTAINERS_WALKTHROUGHS] ?? "");
  } catch {
    return null;
  }
};

const WALKTHROUGH_TASKS = [
  {
    id: "walkthrough-play",
    title: "A stored walkthrough covers the question: present it, write nothing",
    setup: (project, tools) => seedWalkthroughs(project, tools, ["declined-card", "checkout-and-payment"]),
    prompt: "Walk me through what happens when a customer's card is declined.", // aev-canary-5d1f8e02b7c4
    judge: (ctx) => {
      const presents = ctx.calls.filter((c) => c.tool === "present_diagram" && c.ok);
      // Over MCP the argument is in the call; over the CLI the arguments are in a file, so the result's words say it.
      const opened = presents.some(
        (c) => c.input?.walkthrough?.id === "declined-card" || /Walkthrough 'declined-card'/.test(c.text ?? ""),
      );
      const said = words(ctx.finalText);
      return [
        must(
          "presented the declined-card walkthrough",
          opened,
          presents.length ? "presented something else" : "not presented",
        ),
        must(
          "no emphasis set instead",
          !ctx.calls.some((c) => c.tool === "set_emphasis" && c.ok !== false) &&
            !presents.some((c) => c.input?.emphasis),
        ),
        must(
          "wrote nothing: no diagram, note, comment or walkthrough",
          !ctx.calls.some(
            (c) =>
              [
                "write_diagram",
                "register_diagram",
                "write_walkthrough",
                "set_note_emphasis",
                "create_comment",
              ].includes(c.tool) && c.ok !== false,
          ),
        ),
        linkedCheck(ctx, "containers"),
        should(
          "answer is short (1200 characters or fewer)",
          ctx.finalText.length <= 1200,
          `${ctx.finalText.length} characters`,
        ),
        should("names the walkthrough", /declined[- ]card/i.test(said)),
        noOtherChanges(ctx, []),
      ];
    },
  },
  {
    id: "walkthrough-write",
    title: "Write a walkthrough to keep, from the diagram's own ids",
    prompt:
      "Make me a step-by-step walkthrough of how an order ships on the containers diagram, one I can replay later.", // aev-canary-5d1f8e02b7c4
    judge: (ctx) => {
      const file = readSidecar(ctx);
      const mine = file?.walkthroughs?.[0];
      const steps = mine?.steps ?? [];
      const { boxes, edges } = containerIds(ctx.baseline[CONTAINERS] ?? "");
      const bad = steps.flatMap((s, i) => [
        ...(s.nodes ?? []).filter((n) => !boxes.has(n.id)).map((n) => `step ${i + 1} box ${n.id}`),
        ...(s.edges ?? []).filter((e) => !edges.has(e.id)).map((e) => `step ${i + 1} line ${e.id}`),
        ...(s.messages ?? [])
          .flatMap((m) => [m.from, m.to])
          .filter((id) => !boxes.has(id))
          .map((id) => `step ${i + 1} message end ${id}`),
      ]);
      const named = new Set(
        steps.flatMap((s) => [
          ...(s.nodes ?? []).map((n) => n.id),
          ...(s.edges ?? []).flatMap((e) => [e.source, e.target]),
        ]),
      );
      const firstRead = ctx.calls.findIndex((c) => c.tool === "read_diagram" && c.ok !== false);
      const firstWrite = ctx.calls.findIndex((c) => c.tool === "write_walkthrough");
      return [
        must(
          "wrote it through write_walkthrough",
          walkthroughCalled(ctx, "write_walkthrough").length > 0 && file !== null,
        ),
        must("at least 4 steps", steps.length >= 4, `${steps.length} step(s)`),
        must("every reference is in the diagram", steps.length > 0 && bad.length === 0, bad.join(", ")),
        must(
          "read the diagram before writing (ids only from read_diagram)",
          firstRead >= 0 && (firstWrite < 0 || firstRead < firstWrite),
        ),
        must(
          "no diagram written",
          !ctx.calls.some((c) => ["write_diagram", "register_diagram"].includes(c.tool) && c.ok !== false) &&
            !ctx.changed.includes(CONTAINERS),
        ),
        presentedCheck(ctx, "containers", true),
        should("every step says what and why", steps.length > 0 && steps.every((s) => s.what && s.why)),
        should(
          "follows the order to the courier (queue, worker, courier)",
          ["jobs", "worker", "courier"].every((id) => named.has(id)),
        ),
        should("wrote one walkthrough", (file?.walkthroughs?.length ?? 0) === 1),
        noOtherChanges(ctx, [CONTAINERS_WALKTHROUGHS]),
      ];
    },
  },
  {
    id: "walkthrough-repair",
    title: "After a diagram change, find the out-of-date walkthrough step and offer the repair",
    // The courier's id is renamed in the diagram after the walkthrough was written against it.
    setup: (project, tools) => {
      seedWalkthroughs(project, tools, ["order-ships"]);
      const path = join(project, CONTAINERS);
      writeFileSync(path, readFileSync(path, "utf8").replace(/\bcourier\b(?=,|\))/g, "parcelpro"));
    },
    prompt: "I changed the courier integration; are the walkthroughs still right?", // aev-canary-5d1f8e02b7c4
    judge: (ctx) => {
      const text = words(ctx.finalText);
      const looked =
        ctx.calls.some((c) => ["list_stale_diagrams", "list_walkthroughs"].includes(c.tool) && c.ok !== false) ||
        ctx.calls.some((c) => c.via === "cli" && /\bwalkthrough\b/.test(c.command ?? ""));
      return [
        must("checked the walkthroughs (list_stale_diagrams or list_walkthroughs)", looked),
        must(
          "says the courier steps are out of date",
          /out of date|outdated|stale|no longer (?:match|point|exist)|doesn.t match|broken|renamed/i.test(text) &&
            /courier|parcelpro|step 4|step 5/i.test(text),
        ),
        must(
          "did not edit the diagram to fit the walkthrough",
          !ctx.changed.includes(CONTAINERS) && !ctx.calls.some((c) => c.tool === "write_diagram" && c.ok !== false),
        ),
        should(
          "offers the repair rather than making it unasked",
          (OFFERS.test(text) ||
            /\b(?:i can|i could|happy to)\b[^.]{0,30}\b(?:repair|fix|update|rewrite)/i.test(text)) &&
            !walkthroughCalled(ctx, "write_walkthrough").length,
        ),
        should(
          "answer is short (1200 characters or fewer)",
          ctx.finalText.length <= 1200,
          `${ctx.finalText.length} characters`,
        ),
        noOtherChanges(ctx, []),
      ];
    },
  },
  {
    id: "walkthrough-comment",
    title: "A comment on a walkthrough step: fix the step, keep its id, reply and resolve",
    // The person's comment is on the declined-card walkthrough's step 4, sent and waiting (ADR 0034 §9).
    setup: (project, tools) => {
      seedWalkthroughs(project, tools, ["declined-card"]);
      const thread = {
        id: "t-declined",
        target: "view:containers",
        anchor: {
          kind: "step",
          walkthrough: "declined-card",
          step: "the-card-is-declined",
          label: "4. The card is declined",
        },
        status: "sent",
        revision: 1,
        comments: [
          {
            id: "c-declined-1",
            author: "person",
            body: "This step should say that the Shop API checks the webhook's signature before it trusts it. Please fix the step.",
            createdAt: "2026-10-22T09:00:00.000Z",
          },
        ],
      };
      mkdirSync(join(project, ".archer", "diagrams"), { recursive: true });
      writeFileSync(
        join(project, CONTAINERS_COMMENTS),
        JSON.stringify({ version: 3, target: "view:containers", threads: [thread] }, null, 2) + "\n",
      );
    },
    prompt: "I sent you a comment on the Declined card walkthrough in Archer. Please deal with it.", // aev-canary-5d1f8e02b7c4
    judge: (ctx) => {
      const file = readSidecar(ctx);
      const mine = file?.walkthroughs?.find((w) => w.id === "declined-card");
      const steps = mine?.steps ?? [];
      const target = steps.find((s) => s.id === "the-card-is-declined");
      const thread = JSON.parse(ctx.files[CONTAINERS_COMMENTS] ?? '{"threads":[]}').threads.find(
        (t) => t.id === "t-declined",
      );
      const agentReplies = (thread?.comments ?? []).filter((c) => c.author === "agent");
      const read =
        ctx.calls.some((c) => c.tool === "get_comments" && c.ok !== false) ||
        ctx.calls.some((c) => c.via === "cli" && /\bget_comments\b/.test(c.command ?? ""));
      return [
        must(
          "changed the step through write_walkthrough",
          walkthroughCalled(ctx, "write_walkthrough").length > 0 ||
            ctx.calls.some((c) => c.via === "cli" && /\bwalkthrough\s+write\b/.test(c.command ?? "")),
        ),
        must("the step kept its id", target !== undefined, steps.map((s) => s.id).join(", ")),
        must(
          "the step now says the signature is checked",
          /signature|signed|verif/i.test(`${target?.what ?? ""} ${target?.why ?? ""}`),
        ),
        must(
          "the other steps and their ids are intact",
          steps.length === 5 &&
            ["amira-checks-out", "the-order-is-placed", "a-payment-session-opens", "stock-is-released"].every((id) =>
              steps.some((s) => s.id === id),
            ),
          steps.map((s) => s.id).join(", "),
        ),
        must("replied in the thread", agentReplies.length > 0),
        should("resolved the thread", thread?.status === "resolved"),
        should("read the comments first", read),
        must(
          "no diagram written",
          !ctx.changed.includes(CONTAINERS) && !ctx.calls.some((c) => c.tool === "write_diagram" && c.ok !== false),
        ),
        noOtherChanges(ctx, [CONTAINERS_WALKTHROUGHS, CONTAINERS_COMMENTS]),
      ];
    },
  },
];
TASKS.push(...WALKTHROUGH_TASKS);

export const must = (name, pass, detail) => ({
  name,
  level: "must",
  pass: Boolean(pass),
  ...(detail ? { detail } : {}),
});
export const should = (name, pass, detail) => ({
  name,
  level: "should",
  pass: Boolean(pass),
  ...(detail ? { detail } : {}),
});

/** A new diagram: where it lives, its family, compile status, guidance on notes and labels, presentation. */
function newDiagramChecks(ctx, { header, kind, embeddedOnly = false }) {
  const d = ctx.newDiagram;
  const checks = [
    must(`a new ${kind} diagram was written`, d !== undefined && header.test(d.source)),
    must("it compiles", d?.compiled === "compiled"),
    presentedCheck(ctx, d?.viewId),
    should(
      "new files sit in notes/ or diagrams/",
      ctx.added.every((path) => /^\.archer\/(notes|diagrams)\//.test(path)),
    ),
    should("labels are 40 characters or fewer", (d?.longLabels ?? []).length === 0, (d?.longLabels ?? []).join("; ")),
    should(
      "no label warnings from validate_diagram",
      (d?.labelWarnings ?? 0) === 0,
      d?.labelWarnings ? `${d.labelWarnings} warning(s)` : undefined,
    ),
    noOtherChanges(ctx, ctx.added),
  ];
  for (const note of ctx.newNotes) {
    checks.push(must(`${note.path} has author: agent`, /^author:\s*agent\s*$/m.test(note.frontMatter)));
    checks.push(should(`${note.path} has a description`, /^description:\s*\S/m.test(note.frontMatter)));
  }
  if (embeddedOnly)
    checks.push(must("the diagram is embedded in a new note", d?.viewId?.includes("#") && ctx.newNotes.length > 0));
  if (d?.viewId?.includes("#"))
    checks.push(should("its name is pinned: %% archer-id first inside the fence", d.pinnedInside));
  return checks;
}

/** The view was presented and the final answer carries the exact URL present_diagram returned. */
function presentedCheck(ctx, viewId, strict = false) {
  const presents = ctx.calls.filter((c) => c.tool === "present_diagram" && c.ok);
  // The presented page, or for a diagram in a note the note's page present_diagram also returned.
  const urls = presents.flatMap((c) => c.urls ?? [c.url]).filter(Boolean);
  const presentedView =
    viewId === undefined
      ? presents.length > 0
      : presents.some((c) => c.input?.viewId === viewId || c.input?.viewId?.endsWith(viewId));
  const delivered = urls.some((url) => ctx.finalText.includes(url));
  return (strict ? must : should)(
    "presented and gave the returned URL",
    presentedView && delivered,
    presentedView ? (delivered ? undefined : "URL not in the answer") : "not presented",
  );
}

/** Collateral damage: nothing outside `allowed` changed. */
function noOtherChanges(ctx, allowed) {
  // Registering a new diagram (register_diagram) only appends a [[views]] entry: not damage.
  const appended = (path) =>
    path === "archer.toml" &&
    (ctx.baseline[path] ?? "").split("\n").every((line) => (ctx.files[path] ?? "").includes(line));
  const extra = ctx.changed.filter((path) => !allowed.includes(path) && !(appended(path) && ctx.added.length > 0));
  return must("no other files changed", extra.length === 0, extra.join(", "));
}

function seedComment(project) {
  const thread = {
    id: "t-courier",
    target: "view:containers",
    anchor: { kind: "node", id: "courier", label: "Courier" },
    status: "sent",
    revision: 2,
    comments: [
      {
        id: "c-courier-1",
        author: "person",
        body: "Our courier is ParcelPro now; please call it that here (it still collects and delivers parcels).",
        createdAt: "2026-10-20T09:00:00.000Z",
      },
    ],
  };
  mkdirSync(join(project, ".archer", "diagrams"), { recursive: true });
  writeFileSync(
    join(project, ".archer", "diagrams", "containers.comments.json"),
    JSON.stringify({ version: 2, target: "view:containers", threads: [thread] }, null, 2) + "\n",
  );
}

// ---- hold-out: private, never tuned against (docs/evaluations/eval-baseline.md, "Hold-out")

/** The repository keeps only the hold-out's task ids and the sha256 of the files that define them (holdoutDigest). */
export const HOLDOUT_MANIFEST = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "holdout.json"), "utf8"),
);

/** Where the private hold-out file is: $ARCHER_EVAL_HOLDOUT, else ~/.config/archer-evals/holdout.mjs. */
export const holdoutPath = (env = process.env) =>
  env.ARCHER_EVAL_HOLDOUT || join(homedir(), ".config", "archer-evals", "holdout.mjs");

/**
 * The hold-out's sha256: every `.mjs` module in the hold-out file's directory (the file and the
 * modules it imports, such as holdout-doc-pack.mjs), sorted by name, each as its name, a NUL, its
 * bytes and a NUL. Only names and bytes are read; backups (`holdout.mjs.bak-…`) and other files do not count.
 */
export function holdoutDigest(path) {
  const dir = dirname(path),
    hash = createHash("sha256");
  for (const name of readdirSync(dir)
    .filter((n) => n.endsWith(".mjs"))
    .sort())
    hash
      .update(`${name}\0`)
      .update(readFileSync(join(dir, name)))
      .update("\0");
  return hash.digest("hex");
}

/**
 * Loads the hold-out tasks from `path`, a module whose default export takes the rubric helpers and
 * returns tasks. Absent: no tasks (the run skips the hold-out). `matches` is false when the files'
 * sha256 or ids differ from the manifest: the tasks changed, and older hold-out scores are not comparable.
 */
export async function loadHoldout(path = holdoutPath(), manifest = HOLDOUT_MANIFEST) {
  if (!existsSync(path)) return { status: "absent", path, tasks: [], ids: [], matches: false };
  const sha256 = holdoutDigest(path);
  const factory = (await import(`${pathToFileURL(path).href}?sha=${sha256}`)).default;
  // mainJudge: a main-set task's judge, for a hold-out variant worded differently but judged the same.
  const mainJudge = (id) => {
    const judge = TASKS.find((t) => t.id === id && t.set !== "holdout")?.judge;
    if (!judge) throw new Error(`${path}: no main-set task ${id}`);
    return judge;
  };
  const mainSetup = (id) =>
    TASKS.find((t) => t.id === id && t.set !== "holdout")?.setup ??
    (() => {
      throw new Error(`${path}: main-set task ${id} has no setup`);
    })();
  const helpers = {
    must,
    should,
    newDiagramChecks,
    presentedCheck,
    noOtherChanges,
    messages,
    deliveries,
    requestedNoteChecks,
    PAGE_URL,
    mainJudge,
    mainSetup,
    seedDocPack,
    caseLookupChecks,
    intentBootstrapChecks,
    freshRepository,
    docsAgentsMd,
    lookupsBefore,
    openOnPhoneChecks,
  };
  const tasks = [...factory(helpers)];
  // More tasks beside it, each in its own `holdout-add-*.mjs` with the same default export: added without
  // reading or editing the existing file (and covered by holdoutDigest like every .mjs there).
  for (const name of readdirSync(dirname(path))
    .filter((n) => /^holdout-add-.+\.mjs$/.test(n))
    .sort())
    tasks.push(...(await import(`${pathToFileURL(join(dirname(path), name)).href}?sha=${sha256}`)).default(helpers));
  for (const task of tasks) {
    if (!task?.id || !task.prompt || typeof task.judge !== "function")
      throw new Error(`${path}: every hold-out task needs an id, a prompt and a judge`);
    if (TASKS.some((t) => t.id === task.id && t.set !== "holdout"))
      throw new Error(`${path}: hold-out id ${task.id} is a main-set task`);
    task.set = "holdout";
  }
  const ids = tasks.map((t) => t.id);
  const matches =
    sha256 === manifest.sha256 && JSON.stringify([...ids].sort()) === JSON.stringify([...manifest.ids].sort());
  return { status: "loaded", path, sha256, tasks, ids, matches };
}

// ---- normalisation (ticket 06): T1–T6 on the `normalise` fixture, in normalise.mjs
TASKS.push(...normaliseTasks({ must, should, newDiagramChecks, presentedCheck, noOtherChanges }));

for (const task of TASKS) task.set ??= "main";
export const HOLDOUT = await loadHoldout();
TASKS.push(...HOLDOUT.tasks);
