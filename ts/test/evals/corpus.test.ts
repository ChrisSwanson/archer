import { describe, expect, it } from "vitest";
import { buildSolverInput, getEvalCase, SMOKE_CASES, type EvalCase } from "../../scripts/evals/corpus.ts";

describe("solver input boundary", () => {
  it("projects only the chosen prompt and literal fact files, never evaluator answers", () => {
    const evalCase: EvalCase = {
      id: "internal-case-id",
      title: "internal-title",
      prompts: { authoring: "authoring-request", activation: "natural-request" },
      factsFiles: { "facts/source.txt": "literal $40\\n is not a newline\r\nHTML → chunks\n" },
      references: [
        { url: "https://example.org/evaluator-source", retrievedAt: "2026-10-15", role: "modeling-guidance" },
      ],
      evaluator: {
        requiredFacts: ["secret-required-answer"],
        unknowns: ["secret-unknown"],
        allowedModelTypes: ["c4-model"],
        prohibitedInventions: ["secret-prohibition"],
        softPreferences: ["secret-soft-preference"],
        diagramApplicable: true,
      },
    };
    for (const track of ["authoring", "activation"] as const) {
      const input = buildSolverInput(evalCase, track);
      expect(input).toEqual({ prompt: evalCase.prompts[track], files: evalCase.factsFiles });
      expect(Object.keys(input).sort()).toEqual(["files", "prompt"]);
      expect(Object.keys(input.files)).toEqual(["facts/source.txt"]);
      const serialized = JSON.stringify(input);
      for (const hidden of [
        evalCase.id,
        evalCase.title,
        evalCase.references[0]!.url,
        ...Object.values(evalCase.evaluator).flat(),
      ]) {
        if (typeof hidden === "string") expect(serialized).not.toContain(hidden);
      }
      expect(serialized).not.toContain(evalCase.prompts[track === "authoring" ? "activation" : "authoring"]);
    }
  });
});

describe("eight-case development smoke corpus", () => {
  const cases = [
    {
      id: "c4-worker",
      model: "c4-model",
      notation: "C4 Level 3",
      facts: [
        "one executable",
        "BatchReader",
        "RecipientFilter",
        "RelayClient",
        "external PostRelay",
        "not a database",
      ],
      required: ["container boundary", "responsibilities"],
      forbidden: "independent applications",
    },
    {
      id: "flow-lineage",
      model: "data-flow-graph",
      notation: "flowchart",
      facts: [
        "Archive",
        "Reader",
        "Extractor",
        "Splitter",
        "Embedder",
        "also supplies chunk content to IndexWriter",
        "vectors and sends them to IndexWriter",
        "chunks plus vectors to Search Store",
      ],
      required: [
        "Splitter supplies chunk content",
        "Embedder supplies vectors",
        "Reader and IndexWriter responsibilities",
      ],
      forbidden: "bypassing IndexWriter",
    },
    {
      id: "sequence-login",
      model: "sequence-trace",
      notation: "sequence",
      facts: [
        "Browser sends credentials to Session API",
        "synchronously asks Identity",
        "accepted or rejected",
        "returns a cookie",
        "returns 401",
        "no cookie",
        "No separate token endpoint",
      ],
      required: ["Accepted branch", "Rejected branch", "Identity replies to Session API"],
      forbidden: "Cookie on rejection",
    },
    {
      id: "er-domain",
      model: "entity-relationship",
      notation: "ER",
      facts: [
        "Member has zero or more Loans",
        "Loan belongs to exactly one Member",
        "one or more LoanItems",
        "LoanItem belongs to exactly one Loan",
        "LoanItem references exactly one Copy",
        "zero or more historical LoanItems",
      ],
      required: ["Member zero-many", "Loan one-many", "Copy zero-many", "assumption"],
      forbidden: "simultaneous loans",
    },
    {
      id: "state-job",
      model: "state-machine",
      notation: "state machine",
      facts: [
        "Creation enters Queued",
        "Queued to Running",
        "Running to Succeeded",
        "Running to Failed",
        "only from Queued",
        "Failed to Queued",
      ],
      required: ["Creation → Queued", "Queued → Cancelled", "Failed → Queued"],
      forbidden: "Running → Cancelled",
    },
    {
      id: "architecture-placement",
      model: "service-architecture",
      notation: "architecture",
      facts: [
        "production",
        "Host North runs API instance A and Worker",
        "Host South runs API instance B",
        "Host Data runs one shared DB",
        "each connect to DB",
        "No replica or failover",
      ],
      required: [
        "API A and Worker on Host North",
        "API B on Host South",
        "DB on Host Data",
        "Both API instances and Worker connect",
      ],
      forbidden: "C4Deployment",
    },
    {
      id: "journey-support",
      model: "user-journey",
      notation: "user journey",
      facts: [
        "observed in a small study",
        "Section Request",
        "Customer reports damage (score 2)",
        "Customer and Agent verify purchase (score 3)",
        "Section Resolution",
        "Agent approves replacement (score 4)",
        "Customer receives replacement (score 5)",
      ],
      required: ["observed score 2", "observed score 3", "observed score 4", "observed score 5", "Task order"],
      forbidden: "General population",
    },
    {
      id: "no-diagram-queue",
      model: null,
      notation: "no diagram",
      facts: [
        "≤$40/month",
        "LocalQueue: $10/month, volatile",
        "DurableQueue: $35/month, persistent",
        "Both meet the required throughput",
        "invented fixture",
      ],
      required: ["Recommend DurableQueue", "LocalQueue"],
      forbidden: "pricing, durability or topology facts",
    },
  ] as const;

  it("freezes exactly the seven-family smoke set and one negative case", () => {
    expect(SMOKE_CASES.map((evalCase) => evalCase.id)).toEqual(cases.map((row) => row.id));
    expect(new Set(SMOKE_CASES.map((evalCase) => evalCase.id)).size).toBe(8);
    expect(SMOKE_CASES.filter((evalCase) => evalCase.evaluator.diagramApplicable)).toHaveLength(7);
  });

  it.each(cases)("preserves $id facts and distinguishing evaluator expectations", (row) => {
    const evalCase = getEvalCase(row.id);
    expect(evalCase).toBe(SMOKE_CASES.find((candidate) => candidate.id === row.id));
    const facts = Object.values(evalCase.factsFiles).join("\n");
    for (const fragment of row.facts) expect(facts).toContain(fragment);
    for (const fragment of row.required) expect(evalCase.evaluator.requiredFacts.join("\n")).toContain(fragment);
    expect(evalCase.evaluator.prohibitedInventions.join("\n")).toContain(row.forbidden);
    expect(evalCase.evaluator.unknowns.length).toBeGreaterThan(0);
    expect(evalCase.prompts.authoring).toContain(row.notation);
    expect(evalCase.evaluator.diagramApplicable).toBe(row.model !== null);
    if (row.model) {
      expect(evalCase.evaluator.allowedModelTypes).toContain(row.model);
      expect(evalCase.prompts.authoring).toContain("Archer");
    } else {
      expect(evalCase.evaluator.allowedModelTypes).toEqual([]);
      expect(evalCase.prompts.authoring).not.toContain("Archer");
    }
  });

  it.each(SMOKE_CASES)("keeps $id activation natural and separates provenance from solver inputs", (evalCase) => {
    expect(evalCase.prompts.activation).not.toMatch(
      /Archer|skill|C4|Mermaid|flowchart|sequence|state[- ]machine|ER view|architecture-beta|user journey/i,
    );
    expect(evalCase.prompts.activation).not.toBe(evalCase.prompts.authoring);
    expect(evalCase.references.length).toBeGreaterThan(1);
    expect(evalCase.references.some((reference) => reference.role === "modeling-guidance")).toBe(true);
    expect(evalCase.references.some((reference) => reference.role === "archer-profile")).toBe(true);
    for (const reference of evalCase.references) {
      expect(reference.retrievedAt).toBe("2026-10-15");
      expect(new URL(reference.url).protocol).toBe("https:");
    }
    for (const track of ["authoring", "activation"] as const) {
      const input = buildSolverInput(evalCase, track);
      expect(input).toEqual({ prompt: evalCase.prompts[track], files: evalCase.factsFiles });
      expect(input.files).not.toBe(evalCase.factsFiles);
      for (const path of Object.keys(input.files)) {
        expect(input.prompt).toContain(path);
        expect(path).toMatch(/^facts\/[a-z]+\.md$/);
      }
      expect(JSON.stringify(input)).not.toMatch(/```mermaid|C4Component\n|sequenceDiagram\n|stateDiagram-v2\n/);
      expect(Object.keys(input).sort()).toEqual(["files", "prompt"]);
    }
  });

  it("treats an unnecessary factual queue visual as a soft flaw, with no mandatory diagram gate", () => {
    const evalCase = getEvalCase("no-diagram-queue");
    expect(evalCase.evaluator).toMatchObject({
      diagramApplicable: false,
      allowedModelTypes: [],
      softPreferences: [
        "Prefer concise prose or a comparison table; avoid unnecessary diagram authoring and feature discovery",
        "An unnecessary but factually correct visual is a soft flaw, not a hard failure; compile/render are N/A for a correct nonvisual answer",
      ],
    });
    expect(evalCase.evaluator.prohibitedInventions).toEqual([
      "Invented vendor, pricing, durability or topology facts",
      "LocalQueue claimed persistent",
    ]);
    expect(evalCase.evaluator.requiredFacts).toHaveLength(3);
    for (const track of ["authoring", "activation"] as const) {
      expect(JSON.stringify(buildSolverInput(evalCase, track))).not.toMatch(
        /softPreferences|soft flaw|hard failure|compile\/render/,
      );
    }
  });

  it.each(["", "C4-worker", "unknown", "__proto__"])("refuses unknown case ID %j", (id) => {
    expect(() => getEvalCase(id)).toThrow(`Unknown evaluation case: ${id}`);
  });
});
