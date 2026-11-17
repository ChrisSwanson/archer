/** Synthetic packet: evidence availability, not a semantic retrieval engine or agent score.
 * Evaluator metadata stays outside buildSolverInput; only literal facts/prompts reach solvers.
 */
import { performance } from "node:perf_hooks";
import { createApplication } from "../../src/application/index.ts";
import type { NoteSource } from "../../src/notes/read.ts";
import type { EvalCase, EvalReference } from "./corpus.ts";

type ProjectName = "alpha" | "beta";
const references = (...urls: string[]): EvalReference[] =>
  urls.map((url) => ({
    url,
    retrievedAt: "2026-10-15",
    role: "modeling-guidance",
  }));
const note = (status: string, body: string) => `---\nauthor: agent\nstatus: ${status}\n---\n${body}\n`;

/** The decisive passage lies beyond card excerpts. Labels remain author-written claims. */
export function buildRealisticRetrievalFixture(name: ProjectName): Record<string, string> {
  const days = name === "alpha" ? 46 : 83;
  const proposedDays = name === "alpha" ? 92 : 117;
  return {
    "archer.toml": 'version = 1\nfolder = ".archer"\n',
    ".archer/notes/ledger-policy.md": note(
      "current",
      "# Receipt ledger decision\n\nRecorded 2026-05-04. The team accepted this decision on that date.\n\n" +
        Array.from(
          { length: 90 },
          (_, i) =>
            `Background ${i + 1}: imported receipt batches keep their original receipt references; this paragraph establishes no duration.`,
        ).join("\n\n") +
        `\n\n## Disposal interval\nThe ${name} ledger keeps settled receipts for ${days} days after settlement, then removes them.\nNo later acceptance is recorded in this fixture.\n`,
    ),
    ".archer/notes/approved-modernization.md": note(
      "proposed",
      `# APPROVED retention modernization\n\nRecorded 2026-10-12. Despite the filename and heading, this is a proposal awaiting review.\nIt suggests keeping ${name} settled receipts for ${proposedDays} days after settlement.\nThis note contains no acceptance record and does not replace the May decision.\n`,
    ),
    ".archer/notes/archive-rule.md": note(
      "superseded",
      `# Earlier receipt disposal\n\nRecorded 2026-01-02. ${name} formerly removed receipts after 3 days.\nThe May receipt-ledger decision supersedes this rule.\n`,
    ),
    ".archer/notes/delivery.md": note(
      "current",
      "# Courier transport\n\nThe courier sends batch summaries to the ledger.\nA failed send may be tried again by an operator; this source does not specify a retry count or interval.\n",
    ),
    ".archer/notes/terminology.md": note(
      "current",
      "# Language guide\n\nA proof of purchase is called a receipt here. Disposal means removing settled records after their keeping period.\n",
    ),
    ".archer/notes/labels.md": note(
      "current",
      "# Label printing\n\nPrinters use blue stock for approved shipping labels. This is unrelated to retention decisions.\n",
    ),
  };
}

export interface RealisticRetrievalProject {
  name: ProjectName;
  /** Actual catalog payload, separate from complete note-source results. */
  catalog: Record<string, unknown>;
  reads: NoteSource[];
  timings: { catalogMs: number; noteReads: { notePath: string; elapsedMs: number }[] };
}
export interface RealisticRetrievalReport {
  version: 1;
  kind: "exhaustive-current-note-evidence";
  projects: RealisticRetrievalProject[];
  policy: string;
  limitations: string[];
}

/** Fresh cwd application per root; every byte/revision/label comes from read_note.
 * Errors propagate: refusal must not become silent complete-corpus evidence.
 */
export async function evaluateRealisticRetrieval(
  roots: readonly { name: ProjectName; root: string }[],
): Promise<RealisticRetrievalReport> {
  const projects: RealisticRetrievalProject[] = [];
  for (const { name, root } of roots) {
    const app = createApplication({
      cwd: root,
      findService: async () => null,
      ensureService: async () => {
        throw new Error("Retrieval evaluation must not acquire a service");
      },
    });
    try {
      const started = performance.now();
      const catalog = (await app.call("list_diagrams", {})).structured;
      const catalogMs = performance.now() - started;
      const notes = catalog["notes"];
      if (!Array.isArray(notes)) throw new Error("Production catalog did not return a note inventory");
      const reads: NoteSource[] = [];
      const noteReads: RealisticRetrievalProject["timings"]["noteReads"] = [];
      for (const entry of notes) {
        const notePath: unknown = (entry as Record<string, unknown>)["path"];
        if (typeof notePath !== "string") throw new Error("Production catalog returned an invalid note path");
        const before = performance.now();
        const source = (await app.call("read_note", { notePath })).structured as unknown as NoteSource;
        reads.push(source);
        noteReads.push({ notePath, elapsedMs: performance.now() - before });
      }
      projects.push({ name, catalog, reads, timings: { catalogMs, noteReads } });
    } finally {
      app.close();
    }
  }
  return {
    version: 1,
    kind: "exhaustive-current-note-evidence",
    projects,
    policy:
      "One actual list_diagrams, then read_note for every listed note; fresh cwd application per root. No ranking, query rewriting, truncation or service acquisition.",
    limitations: [
      "Evidence availability only: not agent source selection, semantic recall, answer quality or end-to-end latency.",
      "Complete source text does not establish complete inventory coverage or an atomic cross-file snapshot; inspect each read inventory.",
      "Labels, titles and acceptance statements are untrusted source claims; no authoritative decision is selected.",
      "Any absence claim is limited to returned fixture bytes, not wider projects or unstated policies.",
      "Browser search and host filesystem retrieval are not measured or combined with this application surface.",
    ],
  };
}

const existingNote =
  "# Parcel routing\n\nKeep the carrier contract explanation verbatim.\n\n```mermaid\n%% archer-id: routing\nflowchart LR\n  sorter[Sorter]\n  courier[Courier]\n  sorter dispatch@-->|Sends parcel| courier\n```\n\n## Independent view\n\n```mermaid\n%% archer-id: labels\nflowchart LR\n  printer[Label printer]\n```\n\nKeep the customs exception rationale verbatim.\n";
const target = "view:notes/parcel.md#routing";
const existingComments =
  JSON.stringify(
    {
      version: 2,
      target,
      threads: [
        {
          id: "routing-review",
          target,
          anchor: { kind: "edge", id: "dispatch", label: "Sends parcel" },
          status: "sent",
          revision: 1,
          comments: [
            {
              id: "routing-request",
              author: "person",
              body: "Clarify that the parcel is sealed before dispatch; keep this anchored discussion.",
              createdAt: "2026-10-15T12:00:00.000Z",
            },
          ],
        },
      ],
    },
    null,
    2,
  ) + "\n";

/** Existing edit source is user work to preserve, not a golden expected answer.
 * Other cases supply prose only. Pin packet/distribution hashes before guidance tuning;
 * after inspecting a solver output for tuning, that case becomes development evidence.
 */
export const READINESS_CASES: readonly EvalCase[] = [
  {
    id: "reuse-parcel",
    title: "Targeted edit of existing commented routing view",
    prompts: {
      authoring:
        "Use Archer to update the existing parcel routing view: clarify that dispatch sends a sealed parcel. Read the existing work and submitted discussion; preserve identities, discussion and unrelated prose/views. Present the corrected view and return its exact link. Context is in facts/parcel.md.",
      activation:
        "Please update our existing parcel-routing picture to say dispatch sends a sealed parcel. Keep its discussion and surrounding explanation. Context is in facts/parcel.md.",
    },
    factsFiles: {
      "facts/parcel.md":
        "Sorter hands a sealed parcel to Courier. The existing note is .archer/notes/parcel.md. The carrier contract and customs exception rationale must stay unchanged. Carrier technology is not specified.\n",
      ".archer/notes/parcel.md": existingNote,
      ".archer/notes/parcel.routing.comments.json": existingComments,
    },
    references: references("https://mermaid.js.org/syntax/flowchart.html"),
    evaluator: {
      requiredFacts: [
        "Existing notes/parcel.md#routing retained",
        "dispatch remains Sorter to Courier, labelled as sealed parcel",
        "Node IDs sorter/courier and edge ID dispatch retained",
        "routing-review remains grounded and original person comment retained",
        "Independent labels diagram and surrounding prose unchanged",
        "Exact presentation link opens corrected view",
      ],
      unknowns: ["Carrier technology"],
      allowedModelTypes: ["freeform-graph", "data-flow-graph"],
      prohibitedInventions: ["Regenerated replacement identities or lost discussion", "Invented carrier technology"],
      diagramApplicable: true,
    },
  },
  {
    id: "override-reservation",
    title: "Explicit sequence override for reservation exchange",
    prompts: {
      authoring:
        "Use Archer for exactly one sequence, not C4. Keep all reservation details and both outcomes from facts/reservation.md; deliver the view link briefly.",
      activation:
        "Explain the reservation exchange and both outcomes from facts/reservation.md. Keep runtime message details rather than a static inventory.",
    },
    factsFiles: {
      "facts/reservation.md":
        "Kiosk sends a seat request to Reservation API. Reservation API synchronously asks Seat Ledger to reserve it. Seat Ledger replies reserved or unavailable. On reserved the API returns a reservation reference to Kiosk; on unavailable it returns 409 and no reference. Authentication, persistence implementation and timeouts are not specified.\n",
    },
    references: references("https://mermaid.js.org/syntax/sequenceDiagram.html"),
    evaluator: {
      requiredFacts: [
        "Exactly one sequence for explicit request",
        "Kiosk → API → Ledger request order",
        "Ledger replies to API in both outcomes",
        "API returns reference or 409/no reference to Kiosk",
      ],
      unknowns: ["Authentication", "Persistence implementation", "Timeouts"],
      allowedModelTypes: ["sequence-trace"],
      prohibitedInventions: [
        "C4 substituted for explicit sequence",
        "Invented timeout or additional endpoint",
        "Reference returned after unavailable",
      ],
      diagramApplicable: true,
    },
  },
  {
    id: "detail-cataloguer",
    title: "Detailed components and dependency arrow subjects",
    prompts: {
      authoring:
        "Use Archer for detailed C4 Level 3 of Cataloguer from facts/cataloguer.md. Keep its executable boundary, local-file dependency, every responsibility and interaction. Label dependencies so their source performs the verb. Return the view link briefly.",
      activation:
        "Help me understand every internal part of the Cataloguer executable and what each depends on. Keep the responsibilities from facts/cataloguer.md.",
    },
    factsFiles: {
      "facts/cataloguer.md":
        "Cataloguer is one executable containing RecordLoader, NameNormalizer and CatalogPublisher. RecordLoader reads local CSV files and hands rows to NameNormalizer. NameNormalizer normalizes names and hands normalized records to CatalogPublisher. CatalogPublisher calls external Listings Hub to publish records. The CSV files are local files, not a database. Internal components are not separately deployed. Language and normalization rules are unknown.\n",
    },
    references: references("https://c4model.com/diagrams/component", "https://c4model.com/diagrams/notation"),
    evaluator: {
      requiredFacts: [
        "One Cataloguer executable boundary containing all three components",
        "RecordLoader reads local CSV files",
        "RecordLoader hands rows to NameNormalizer",
        "NameNormalizer normalizes names and hands records to CatalogPublisher",
        "CatalogPublisher publishes records to external Listings Hub",
        "Dependency sources perform their labelled verbs",
      ],
      unknowns: ["Language", "Normalization rules"],
      allowedModelTypes: ["c4-model"],
      prohibitedInventions: [
        "Local CSV files called a database",
        "Components represented as separately deployed applications",
        "Reversed Reads dependency subject",
        "Requested responsibilities omitted",
      ],
      diagramApplicable: true,
    },
  },
  {
    id: "unsupported-native",
    title: "Honest unsupported class and deployment requests",
    prompts: {
      authoring:
        "Use Archer to make native Mermaid classDiagram and C4Deployment views for facts/scanner.md. If either is unsupported, explain the actual limits and a useful supported alternative without pretending the alternative is native support.",
      activation:
        "Can you make native classDiagram and C4Deployment views of facts/scanner.md? Tell me honestly what the available viewer supports.",
    },
    factsFiles: {
      "facts/scanner.md":
        "Scanner and ResultRepository are code-level classes in one executable. Scanner calls ResultRepository.save. A single executable instance runs on Host Birch. Inheritance, fields, technology and failover are not specified.\n",
    },
    references: references("https://c4model.com/diagrams/deployment", "https://c4model.com/diagrams/component"),
    evaluator: {
      requiredFacts: [
        "Disclose unsupported native classDiagram and C4Deployment",
        "Any supported alternative labelled as an alternative",
        "Scanner calls ResultRepository.save; one executable instance on Host Birch",
      ],
      unknowns: ["Inheritance", "Fields", "Technology", "Failover"],
      allowedModelTypes: [],
      prohibitedInventions: [
        "Native classDiagram or C4Deployment support claim",
        "Classes promoted to real independently deployed services",
        "Invented inheritance or failover",
      ],
      softPreferences: [
        "Compile/render N/A for honest limitation disclosure without a visual; validate optional visuals separately",
      ],
      diagramApplicable: false,
    },
  },
  {
    id: "activate-thumbnails",
    title: "Natural opportunity for pipeline explanation",
    prompts: {
      authoring:
        "Use Archer to explain the thumbnail pipeline from facts/thumbnails.md, retaining metadata and image inputs to ManifestWriter.",
      activation:
        "Help me see how incoming photographs become thumbnails and a published manifest, including who supplies each writer input. Facts are in facts/thumbnails.md.",
    },
    factsFiles: {
      "facts/thumbnails.md":
        "Inbox supplies photographs to Decoder. Decoder sends pixels to Resizer and metadata to ManifestWriter. Resizer sends thumbnails to ManifestWriter. ManifestWriter publishes thumbnails plus metadata to Gallery. Intermediate ownership, transport and storage technology are not specified.\n",
    },
    references: references("https://mermaid.js.org/syntax/flowchart.html"),
    evaluator: {
      requiredFacts: [
        "Inbox → Decoder → Resizer",
        "Decoder supplies metadata to ManifestWriter",
        "Resizer supplies thumbnails to ManifestWriter",
        "ManifestWriter publishes both to Gallery",
      ],
      unknowns: ["Intermediate ownership", "Transport", "Storage technology"],
      allowedModelTypes: ["data-flow-graph", "freeform-graph"],
      prohibitedInventions: [
        "Missing metadata handoff",
        "Resizer writes directly to Gallery",
        "Invented intermediate store",
      ],
      diagramApplicable: true,
    },
  },
  {
    id: "abstain-port",
    title: "Concise factual answer without visualization",
    prompts: {
      authoring: "What port is configured in facts/listener.md? Answer in one sentence; no diagram is needed.",
      activation: "What port is configured in facts/listener.md? Give me the value briefly.",
    },
    factsFiles: {
      "facts/listener.md":
        "The fixture service configuration sets port = 42617. It does not record whether the service is running or reachable.\n",
    },
    references: references("https://docs.arc42.org/section-6/"),
    evaluator: {
      requiredFacts: ["Configured port is 42617"],
      unknowns: ["Actual listener availability"],
      allowedModelTypes: [],
      prohibitedInventions: ["Configured port asserted to prove a reachable listener"],
      softPreferences: [
        "Answer briefly without diagram creation or unrelated discovery; a correct unnecessary visual is a soft flaw",
      ],
      diagramApplicable: false,
    },
  },
  {
    id: "er-specimens",
    title: "Held-out relationship endpoint semantics",
    prompts: {
      authoring:
        "Use Archer for a logical ER view of facts/specimens.md. Preserve each endpoint cardinality and distinguish specimen history from simultaneous use.",
      activation:
        "Help me understand analysis runs, measurements and specimens in facts/specimens.md, especially optional participation and history.",
    },
    factsFiles: {
      "facts/specimens.md":
        "Each AnalysisRun has one or more Measurements. Each Measurement belongs to exactly one AnalysisRun and references exactly one Specimen. A Specimen can appear in zero or more historical Measurements. Historical participation says nothing about simultaneous use. Keys, SQL types and identifying status are unknown.\n",
    },
    references: references("https://mermaid.js.org/syntax/entityRelationshipDiagram.html"),
    evaluator: {
      requiredFacts: [
        "AnalysisRun one-many Measurements; Measurement exactly one AnalysisRun",
        "Specimen zero-many historical Measurements; Measurement exactly one Specimen",
        "Any identifying-line convention disclosed as an assumption",
      ],
      unknowns: ["Keys", "SQL types", "Identifying status", "Simultaneous use"],
      allowedModelTypes: ["entity-relationship"],
      prohibitedInventions: [
        "Specimen/Measurement endpoint cardinalities reversed",
        "Minimum one Measurement per Specimen",
        "Invented keys or concurrent-use policy",
      ],
      diagramApplicable: true,
    },
  },
  {
    id: "recovery-mill",
    title: "Placement without invented recovery policy",
    prompts: {
      authoring:
        "Use Archer to show placement and shared failure dependencies from facts/mill.md. Explain only what the facts establish about recovery.",
      activation:
        "What fails together if a machine is lost in facts/mill.md, and what can we actually say about recovery?",
    },
    factsFiles: {
      "facts/mill.md":
        "Host Cedar runs Web A and Converter. Host Elm runs Web B. Host Ash runs one shared Object Index. Both Web instances and Converter depend on Object Index. No replica or failover is configured. Process restart, host restart, backups and recovery times are not specified.\n",
    },
    references: references("https://mermaid.js.org/syntax/architecture.html", "https://docs.arc42.org/section-7/"),
    evaluator: {
      requiredFacts: [
        "Host Cedar contains Web A and Converter",
        "Host Elm contains Web B",
        "Host Ash contains shared Object Index",
        "All three depend on Object Index",
        "Cedar loss affects both co-located components, separately from the shared Object Index dependency",
        "No replica/failover distinguished from unknown restart and recovery policy",
      ],
      unknowns: ["Process restart", "Host restart", "Backups", "Recovery times"],
      allowedModelTypes: ["service-architecture", "freeform-graph"],
      prohibitedInventions: [
        "No failover expanded into no automatic restart or recovery",
        "Invented replicas/backups",
        "Grouping claimed as security isolation",
        "Partial inventory asserted to prove exclusive dependencies",
        "Unspecified component role asserted as database",
      ],
      diagramApplicable: true,
    },
  },
];

export function getReadinessCase(id: string): EvalCase {
  const result = READINESS_CASES.find((candidate) => candidate.id === id);
  if (!result) throw new Error(`Unknown readiness case: ${id}`);
  return result;
}
