import type { DiagramModelType } from "../../src/model/envelope.ts";

export type EvalTrack = "authoring" | "activation";

/** Modeling provenance is evaluator context, never an application fact or solver instruction. */
export interface EvalReference {
  readonly url: string;
  readonly retrievedAt: string;
  readonly role: "modeling-guidance" | "archer-profile";
}

/** Public development cases; no reference diagram or gold Mermaid is stored. */
export interface EvalCase {
  readonly id: string;
  readonly title: string;
  readonly prompts: Readonly<Record<EvalTrack, string>>;
  readonly factsFiles: Readonly<Record<string, string>>;
  readonly references: readonly EvalReference[];
  readonly evaluator: {
    readonly requiredFacts: readonly string[];
    readonly unknowns: readonly string[];
    readonly allowedModelTypes: readonly DiagramModelType[];
    readonly prohibitedInventions: readonly string[];
    /** Quality/efficiency preferences do not constitute invented facts or hard failures. */
    readonly softPreferences?: readonly string[];
    /** Whether a diagram is required for this case. False makes compile/render N/A for a
     * correct nonvisual answer; an extra factual visual alone is not a hard failure.
     * allowedModelTypes describes required diagram outputs, not a ban on optional visuals.
     */
    readonly diagramApplicable: boolean;
  };
}

export function buildSolverInput(
  evalCase: EvalCase,
  track: EvalTrack,
): {
  prompt: string;
  files: Readonly<Record<string, string>>;
} {
  return { prompt: evalCase.prompts[track], files: { ...evalCase.factsFiles } };
}

const RETRIEVED_AT = "2026-10-15";
const PROFILE: EvalReference = {
  url: "https://github.com/chrisswanson/archer/blob/main/ts/docs/supported-mermaid.md",
  retrievedAt: RETRIEVED_AT,
  role: "archer-profile",
};
function references(...urls: string[]): readonly EvalReference[] {
  return [
    ...urls.map((url): EvalReference => ({ url, retrievedAt: RETRIEVED_AT, role: "modeling-guidance" })),
    PROFILE,
  ];
}

/** Eight original synthetic development cases, not held-out evidence or approved solver runs.
 * Facts are literal application inputs; references anchor modeling concepts only.
 * Evaluator expectations permit equivalent representations rather than a gold graph/string.
 */
export const SMOKE_CASES: readonly EvalCase[] = [
  {
    id: "c4-worker",
    title: "Export Worker component responsibilities",
    prompts: {
      authoring:
        "Use Archer to give detailed C4 Level 3 for Export Worker from facts/worker.md. Preserve its component responsibilities and external connections; flag unknowns briefly.",
      activation:
        "I'm onboarding to Export Worker. Help me understand the parts inside that executable and how export records reach PostRelay. The project facts are in facts/worker.md.",
    },
    factsFiles: {
      "facts/worker.md":
        "# Export Worker\nExport Worker is one executable containing BatchReader, RecipientFilter and RelayClient.\nBatchReader loads local export files and passes records to RecipientFilter.\nRecipientFilter passes eligible recipients to RelayClient.\nRelayClient calls external PostRelay.\nThe export files are local files, not a database.\nFilter rules and implementation technology are not specified.\n",
    },
    references: references(
      "https://c4model.com/diagrams/component",
      "https://c4model.com/diagrams/notation",
      "https://docs.arc42.org/section-5/",
    ),
    evaluator: {
      requiredFacts: [
        "C4 component scope: one Export Worker container boundary",
        "BatchReader loads local files and passes records to RecipientFilter",
        "RecipientFilter passes eligible recipients to RelayClient",
        "RelayClient calls external PostRelay",
        "All three internal component responsibilities are retained",
      ],
      unknowns: ["Filter rules", "Implementation technology"],
      allowedModelTypes: ["c4-model"],
      prohibitedInventions: [
        "Local export files represented as an established database",
        "Components promoted to independent applications",
        "Invented implementation technology or filter policy",
      ],
      diagramApplicable: true,
    },
  },
  {
    id: "flow-lineage",
    title: "Search entry lineage",
    prompts: {
      authoring:
        "Use Archer to draw a data-flow flowchart showing how search entries get made from facts/lineage.md. Keep the processors and both inputs to IndexWriter visible.",
      activation:
        "Help me see how HTML in Archive becomes stored search entries, including who handles the chunk text and the vectors. Use facts/lineage.md.",
    },
    factsFiles: {
      "facts/lineage.md":
        "# Search entry pipeline\nReader loads HTML from Archive and sends HTML to Extractor.\nExtractor produces paragraphs for Splitter.\nSplitter produces chunks for Embedder and also supplies chunk content to IndexWriter.\nEmbedder produces vectors and sends them to IndexWriter.\nIndexWriter sends chunks plus vectors to Search Store.\nOwnership of intermediate buffers is not specified.\n",
    },
    references: references("https://mermaid.js.org/syntax/flowchart.html", "https://docs.arc42.org/section-6/"),
    evaluator: {
      requiredFacts: [
        "Archive → Reader → Extractor → Splitter → Embedder",
        "Splitter supplies chunk content to IndexWriter",
        "Embedder supplies vectors to IndexWriter",
        "IndexWriter sends chunks plus vectors to Search Store",
        "Reader and IndexWriter responsibilities remain explicit",
      ],
      unknowns: ["Ownership of intermediate buffers"],
      allowedModelTypes: ["data-flow-graph", "freeform-graph"],
      prohibitedInventions: [
        "Embedder established as passing through chunk content instead of the supplied Splitter handoff",
        "Direct Embedder write to Search Store bypassing IndexWriter",
        "Invented queues, stores or buffer owners",
      ],
      diagramApplicable: true,
    },
  },
  {
    id: "sequence-login",
    title: "Sign-in exchange and rejection",
    prompts: {
      authoring:
        "Use Archer to show a sequence for sign-in using facts/login.md, including accepted and rejected outcomes.",
      activation:
        "Walk me through sign-in between Browser, Session API and Identity. I need to understand the replies when credentials succeed and when they fail. Facts are in facts/login.md.",
    },
    factsFiles: {
      "facts/login.md":
        "# Sign-in\nBrowser sends credentials to Session API.\nSession API synchronously asks Identity to authenticate.\nIdentity returns accepted or rejected to Session API.\nOn accepted, Session API returns a cookie to Browser.\nOn rejected, Session API returns 401 to Browser and no cookie.\nNo separate token endpoint is specified. Cookie settings and session storage are not specified.\n",
    },
    references: references("https://mermaid.js.org/syntax/sequenceDiagram.html", "https://docs.arc42.org/section-6/"),
    evaluator: {
      requiredFacts: [
        "Browser sends credentials to Session API",
        "Session API synchronously authenticates through Identity",
        "Identity replies to Session API",
        "Accepted branch returns cookie from Session API to Browser",
        "Rejected branch returns 401 and no cookie from Session API to Browser",
      ],
      unknowns: ["Cookie settings", "Session storage"],
      allowedModelTypes: ["sequence-trace"],
      prohibitedInventions: [
        "Separate token endpoint or token exchange",
        "Cookie on rejection",
        "Reversed response direction",
        "Invented persistence or cookie security settings",
      ],
      diagramApplicable: true,
    },
  },
  {
    id: "er-domain",
    title: "Historical loans domain",
    prompts: {
      authoring:
        "Use Archer to show a logical domain ER view from facts/domain.md. Preserve both ends of every relationship's cardinality; do not invent a physical schema.",
      activation:
        "Help me understand how Members, Loans, LoanItems and Copies relate, especially optional participation and historical use. The facts are in facts/domain.md.",
    },
    factsFiles: {
      "facts/domain.md":
        "# Loan domain\nA Member has zero or more Loans. Each Loan belongs to exactly one Member.\nEach Loan has one or more LoanItems. Each LoanItem belongs to exactly one Loan.\nEach LoanItem references exactly one Copy. A Copy can appear in zero or more historical LoanItems.\nHistorical use does not establish simultaneous use.\nKeys, SQL types and identifying status are not specified.\n",
    },
    references: references("https://mermaid.js.org/syntax/entityRelationshipDiagram.html"),
    evaluator: {
      requiredFacts: [
        "Member zero-many Loans; each Loan exactly one Member",
        "Loan one-many LoanItems; each LoanItem exactly one Loan",
        "Copy zero-many historical LoanItems; each LoanItem exactly one Copy",
        "Logical entities and all three relationship roles preserved",
        "Identifying-line choice is disclosed as an assumption, not a sourced identity fact",
      ],
      unknowns: ["Keys", "SQL types", "Identifying relationship status", "Concurrent lending policy"],
      allowedModelTypes: ["entity-relationship"],
      prohibitedInventions: [
        "Invented columns, keys or SQL types",
        "Historical many interpreted as simultaneous loans",
        "Minimum one Loan per Member or minimum one LoanItem per Copy",
      ],
      diagramApplicable: true,
    },
  },
  {
    id: "state-job",
    title: "Job lifecycle with operator requeue",
    prompts: {
      authoring:
        "Use Archer to show the job state machine from facts/job.md. Include creation, cancellation and operator requeue.",
      activation:
        "Explain the lifecycle of a job and which actions can move it between statuses. I especially need to know when cancellation and requeue are possible. Use facts/job.md.",
    },
    factsFiles: {
      "facts/job.md":
        "# Job lifecycle\nCreation enters Queued. Dispatch moves Queued to Running.\nSuccess moves Running to Succeeded. Failure moves Running to Failed.\nCancel is permitted only from Queued and moves it to Cancelled.\nAn operator request can requeue Failed to Queued.\nTerminal-object semantics and retry limits are not specified.\n",
    },
    references: references("https://mermaid.js.org/syntax/stateDiagram.html"),
    evaluator: {
      requiredFacts: [
        "Creation → Queued",
        "Queued → Running on dispatch",
        "Running → Succeeded on success",
        "Running → Failed on failure",
        "Queued → Cancelled on cancel",
        "Failed → Queued on operator request",
      ],
      unknowns: ["Terminal-object semantics", "Retry limits"],
      allowedModelTypes: ["state-machine"],
      prohibitedInventions: [
        "Running → Cancelled transition",
        "Automatic retry",
        "Invented retry limits",
        "Final pseudostate that prevents the stated Failed requeue",
      ],
      diagramApplicable: true,
    },
  },
  {
    id: "architecture-placement",
    title: "Production hosts and shared dependency",
    prompts: {
      authoring:
        "Use Archer's supported architecture notation to show production placement and what fails together from facts/placement.md. Include a brief explanation of shared dependencies.",
      activation:
        "Show me what would go down together if a production host failed, and where the shared dependency is. Use the instance and host inventory in facts/placement.md.",
    },
    factsFiles: {
      "facts/placement.md":
        "# Production placement\nIn production, Host North runs API instance A and Worker.\nHost South runs API instance B. Host Data runs one shared DB.\nAPI A, API B and Worker each connect to DB.\nNo replica or failover is configured. Capacity and availability guarantees are not specified.\n",
    },
    references: references("https://mermaid.js.org/syntax/architecture.html", "https://docs.arc42.org/section-7/"),
    evaluator: {
      requiredFacts: [
        "Production environment named",
        "API A and Worker on Host North",
        "API B on Host South",
        "One shared DB on Host Data",
        "Both API instances and Worker connect to DB",
        "Host loss effects explained from actual placement",
      ],
      unknowns: ["Capacity guarantees", "Availability guarantees", "Security isolation"],
      allowedModelTypes: ["service-architecture", "freeform-graph"],
      prohibitedInventions: [
        "Replica or configured failover",
        "Native C4Deployment support claim",
        "Grouping asserted to guarantee trust isolation",
        "Unstated availability guarantee",
      ],
      diagramApplicable: true,
    },
  },
  {
    id: "journey-support",
    title: "Observed replacement experience",
    prompts: {
      authoring:
        "Use Archer to map the observed replacement journey from facts/support.md as a user journey. Keep the observed scores, actors and sections and state the study's limits briefly.",
      activation:
        "Help me see the stages of the replacement experience and where this study found the most friction. Keep the participants and observed ratings from facts/support.md.",
    },
    factsFiles: {
      "facts/support.md":
        "# Observed replacement journey\nThese ratings are observed in a small study; population and sample size are not specified.\nSection Request: Customer reports damage (score 2), then Customer and Agent verify purchase (score 3).\nSection Resolution: Agent approves replacement (score 4), then Customer receives replacement (score 5).\nScores use the 1–5 journey scale.\n",
    },
    references: references("https://mermaid.js.org/syntax/userJourney.html"),
    evaluator: {
      requiredFacts: [
        "Request: reports damage, Customer, observed score 2",
        "Request: verify purchase, Customer and Agent, observed score 3",
        "Resolution: approves replacement, Agent, observed score 4",
        "Resolution: receives replacement, Customer, observed score 5",
        "Task order and observed small-study provenance preserved",
      ],
      unknowns: ["Population", "Sample size", "General satisfaction"],
      allowedModelTypes: ["user-journey"],
      prohibitedInventions: [
        "Proposed scores presented as observations",
        "Changed scores or actors",
        "General population satisfaction claim",
        "Invented sample size",
      ],
      diagramApplicable: true,
    },
  },
  {
    id: "no-diagram-queue",
    title: "Queue choice on supplied criteria",
    prompts: {
      authoring:
        "Which queue meets the requirements in facts/queues.md? Answer briefly with a comparison table or prose; no diagram is needed.",
      activation:
        "Which of these queues fits our persistence requirement and operating budget? Give me a brief recommendation based on facts/queues.md.",
    },
    factsFiles: {
      "facts/queues.md":
        "# Synthetic queue option cards\nThese are invented fixture options and prices, not current vendor claims.\nRequirement: persistence and operating budget ≤$40/month.\nLocalQueue: $10/month, volatile.\nDurableQueue: $35/month, persistent.\nBoth meet the required throughput.\nOther operating characteristics are not specified.\n",
    },
    references: references("https://docs.arc42.org/section-6/"),
    evaluator: {
      requiredFacts: [
        "Recommend DurableQueue: persistent and $35/month ≤ $40/month",
        "LocalQueue is $10/month but volatile",
        "Both meet required throughput",
      ],
      unknowns: ["Other operating characteristics", "Real vendor behavior or pricing"],
      allowedModelTypes: [],
      prohibitedInventions: ["Invented vendor, pricing, durability or topology facts", "LocalQueue claimed persistent"],
      softPreferences: [
        "Prefer concise prose or a comparison table; avoid unnecessary diagram authoring and feature discovery",
        "An unnecessary but factually correct visual is a soft flaw, not a hard failure; compile/render are N/A for a correct nonvisual answer",
      ],
      diagramApplicable: false,
    },
  },
];

/** Refuse typos rather than silently selecting a different evaluation case. */
export function getEvalCase(id: string): EvalCase {
  const evalCase = SMOKE_CASES.find((candidate) => candidate.id === id);
  if (!evalCase) throw new Error(`Unknown evaluation case: ${id}`);
  return evalCase;
}
