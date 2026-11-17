/** Evidence availability under explicit, deterministic retrieval policies.
 * This is not a semantic ranking, RAG, agent-answer, or end-to-end latency benchmark.
 * No service is started. Existing production application and browser search paths are called.
 */
import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { createApplication } from "../../src/application/index.ts";
import { ProjectState } from "../../src/service/project-state.ts";

type ProjectName = "alpha" | "beta";
type EvidenceKey = "current" | "proposed" | "superseded" | "diagram";
const QUERIES = ["retention", "dispatch-token", "unknown-retry-budget"] as const;

function evidence(name: ProjectName): Record<EvidenceKey, string> {
  return {
    current: `retention ${name}-value 7 days`,
    proposed: `retention ${name}-proposal 30 days`,
    superseded: `retention ${name}-old 1 day`,
    diagram: `dispatch-token ${name}-worker`,
  };
}

/** Exact expected facts live only in fixture construction/scoring, never in retrieval results. */
export function buildRetrievalFixture(name: ProjectName, count: 20 | 100): Record<string, string> {
  const facts = evidence(name);
  const note = (status: string, body: string) => `---\nauthor: agent\nstatus: ${status}\n---\n# Queue\n\n${body}\n`;
  const files: Record<string, string> = {
    ".archer/notes/current.md": note("current", facts.current),
    ".archer/notes/proposal.md": note("proposed", facts.proposed),
    ".archer/notes/old.md": note("superseded", facts.superseded),
    ".archer/notes/dispatch.md": note(
      "current",
      'Ownership is intentionally unspecified.\n\n```mermaid\n%% archer-id: dispatch\nflowchart LR\n  worker["' +
        facts.diagram +
        '"]\n  queue[Queue]\n  worker sends@-->|Sends| queue\n```',
    ),
  };
  for (let i = 4; i < count; i++)
    files[`.archer/notes/topic-${i}.md`] = note("current", `Unrelated topic ${i}. No operational policy established.`);
  return files;
}

export interface RetrievalSurface {
  /** Actual structured return or rg stdout, before scoring. */
  payload: unknown;
  /** Result identifiers as returned; not normalized into claims of equivalent granularity. */
  matches: string[];
  contextBytes: number;
  elapsedMs: number;
  literalEvidence: Record<EvidenceKey, boolean>;
}
export interface RetrievalProbe {
  query: string;
  catalog: RetrievalSurface;
  diagramReads: RetrievalSurface;
  noteReads: RetrievalSurface;
  browser: RetrievalSurface;
  filesystem: RetrievalSurface;
}
export type FixtureValidityStatus = "passed" | "failed" | "not_checked";
export interface FixtureValidity {
  status: FixtureValidityStatus;
  /** Fixture/evidence checks only, never model-answer or semantic-quality scores. */
  checks: { name: string; status: FixtureValidityStatus; observed: unknown }[];
}
export interface RetrievalProjectResult {
  name: ProjectName;
  inventory: { notes: unknown[]; embedded: unknown[] };
  fixtureValidity: FixtureValidity;
  setupMs: number;
  probes: RetrievalProbe[];
}
export interface RetrievalReport {
  version: 1;
  projects: RetrievalProjectResult[];
  fixtureValidity: FixtureValidity;
  policies: Record<string, string>;
  limitations: string[];
}

/** The message a missing ripgrep fails with; release-check's unit gate reports it as an environment gap. */
export const RIPGREP_MISSING =
  "ripgrep (rg) is not installed: the retrieval evaluation runs the real rg as its filesystem baseline. Install ripgrep (the CI image has it) and re-run.";

/** `rg` on .archer, as an agent would run it; exit 1 is rg's documented "no match". */
function ripgrep(root: string, query: string): string {
  try {
    return execFileSync("rg", ["--hidden", "--no-ignore", "--color", "never", "-n", "-F", "--", query, ".archer"], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
  } catch (error) {
    const failure = error as { code?: string; status?: number; stdout?: string };
    if (failure.code === "ENOENT") throw new Error(RIPGREP_MISSING, { cause: error });
    if (failure.status !== 1) throw error;
    return failure.stdout ?? "";
  }
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
function surface(
  payload: unknown,
  matches: string[],
  started: number,
  expected: Record<EvidenceKey, string>,
): RetrievalSurface {
  const serialized = JSON.stringify(payload);
  return {
    payload,
    matches,
    contextBytes: Buffer.byteLength(serialized, "utf8"),
    elapsedMs: performance.now() - started,
    literalEvidence: Object.fromEntries(
      Object.entries(expected).map(([key, value]) => [key, serialized.includes(value)]),
    ) as Record<EvidenceKey, boolean>,
  };
}

function validityStatus(statuses: readonly FixtureValidityStatus[]): FixtureValidityStatus {
  return statuses.includes("failed")
    ? "failed"
    : statuses.length === 0 || statuses.includes("not_checked")
      ? "not_checked"
      : "passed";
}

/** Observe actual returned sources; expectations never enter the retrieved payloads. */
function fixtureValidity(
  name: ProjectName,
  expectedNoteCount: 20 | 100 | undefined,
  notes: unknown[],
  embedded: unknown[],
  probes: readonly RetrievalProbe[],
): FixtureValidity {
  const checks: FixtureValidity["checks"] = [];
  const check = (name: string, passed: boolean, observed: unknown): void => {
    checks.push({ name, status: passed ? "passed" : "failed", observed });
  };
  const paths = notes.map((note) => String(record(note)["path"])).sort();
  if (expectedNoteCount === undefined)
    checks.push({
      name: "expected_corpus",
      status: "not_checked",
      observed: { noteCount: notes.length, reason: "expectedNoteCount was not supplied" },
    });
  else {
    const expectedPaths = Object.keys(buildRetrievalFixture(name, expectedNoteCount))
      .map((path) => path.slice(".archer/".length))
      .sort();
    check(
      "expected_corpus",
      notes.length === expectedNoteCount && JSON.stringify(paths) === JSON.stringify(expectedPaths),
      { expectedNoteCount, noteCount: notes.length, paths },
    );
  }
  const statuses = [
    ["notes/current.md", "current"],
    ["notes/proposal.md", "proposed"],
    ["notes/old.md", "superseded"],
  ] as const;
  const observedStatuses = statuses.map(([path]) => ({
    path,
    status: record(notes.find((note) => record(note)["path"] === path))["status"] ?? null,
  }));
  check(
    "lifecycle_labels",
    statuses.every(([path, status]) =>
      notes.some((note) => record(note)["path"] === path && record(note)["status"] === status),
    ),
    observedStatuses,
  );
  const retention = probes.find((probe) => probe.query === "retention")!;
  const expected = evidence(name);
  for (const [key, path] of [
    ["current", "notes/current.md"],
    ["proposed", "notes/proposal.md"],
    ["superseded", "notes/old.md"],
  ] as const) {
    const card = array(record(retention.browser.payload)["results"]).find(
      (result) => record(result)["target"] === `note:${path}`,
    );
    const browser = JSON.stringify(card ?? null).includes(expected[key]);
    const filesystem = String(retention.filesystem.payload)
      .split("\n")
      .some((line) => line.startsWith(`.archer/${path}:`) && line.includes(expected[key]));
    const note = array(retention.noteReads.payload).find((result) => record(result)["notePath"] === path);
    const noteRead = record(record(note)["source"])["text"];
    const noteEvidence = typeof noteRead === "string" && noteRead.includes(expected[key]);
    check(`${key}_fact`, browser && filesystem && noteEvidence, {
      notePath: path,
      browser,
      filesystem,
      noteRead: noteEvidence,
    });
  }
  const dispatch = probes.find((probe) => probe.query === "dispatch-token")!;
  const reads = array(dispatch.diagramReads.payload);
  const compiled = reads.length === 1 && record(record(reads[0])["compile"])["status"] === "compiled";
  const correctAddress = embedded.length === 1 && record(embedded[0])["address"] === "notes/dispatch.md#dispatch";
  const diagramEvidence = {
    compiled,
    correctAddress,
    diagramReads: dispatch.diagramReads.literalEvidence.diagram,
    browser: dispatch.browser.literalEvidence.diagram,
    filesystem: dispatch.filesystem.literalEvidence.diagram,
  };
  check("compiled_diagram", Object.values(diagramEvidence).every(Boolean), diagramEvidence);
  const missing = probes.find((probe) => probe.query === "unknown-retry-budget")!;
  check("missing_query_absent", missing.browser.matches.length === 0 && missing.filesystem.matches.length === 0, {
    browserMatches: missing.browser.matches.length,
    filesystemMatches: missing.filesystem.matches.length,
  });
  const peerFacts = Object.values(evidence(name === "alpha" ? "beta" : "alpha"));
  const leakedSurfaces: string[] = [];
  for (const probe of probes)
    for (const field of ["catalog", "diagramReads", "noteReads", "browser", "filesystem"] as const) {
      if (peerFacts.some((fact) => JSON.stringify(probe[field].payload).includes(fact)))
        leakedSurfaces.push(`${probe.query}:${field}`);
    }
  check("project_isolation", leakedSurfaces.length === 0, { leakedSurfaces });
  return { status: validityStatus(checks.map((item) => item.status)), checks };
}

/** Per-project isolated policies: catalog once; exhaustive embedded reads once; lexical searches per query.
 * Browser startup/compilation and exhaustive source reads are reported separately from warm queries.
 * Neither exact evidence matches nor an empty result establish semantic correctness or safe abstention.
 */
export async function evaluateRetrieval(
  roots: readonly { name: ProjectName; root: string; expectedNoteCount?: 20 | 100 }[],
): Promise<RetrievalReport> {
  const projects: RetrievalProjectResult[] = [];
  for (const { name, root, expectedNoteCount } of roots) {
    const app = createApplication({ cwd: root });
    let browser: ProjectState | undefined;
    try {
      const expected = evidence(name);
      let started = performance.now();
      const listed = (await app.call("list_diagrams")).structured;
      const notes = array(listed["notes"]),
        embedded = array(listed["embedded"]);
      const catalog = surface(
        listed,
        notes.map((note) => String(record(note)["path"])),
        started,
        expected,
      );
      started = performance.now();
      const reads: unknown[] = [];
      for (const view of [...array(listed["views"]), ...embedded]) {
        const item = record(view);
        reads.push((await app.call("read_diagram", { viewId: item["address"] ?? item["id"] })).structured);
      }
      const diagramReads = surface(
        reads,
        [...array(listed["views"]), ...embedded].map((view) => String(record(view)["address"] ?? record(view)["id"])),
        started,
        expected,
      );
      started = performance.now();
      const noteResults: unknown[] = [];
      for (const note of notes)
        noteResults.push((await app.call("read_note", { notePath: record(note)["path"] })).structured);
      const noteReads = surface(
        noteResults,
        notes.map((note) => String(record(note)["path"])),
        started,
        expected,
      );
      started = performance.now();
      browser = await ProjectState.open(root, (slug) => `http://127.0.0.1:1/${slug}/`);
      const setupMs = performance.now() - started;
      const probes: RetrievalProbe[] = [];
      for (const query of QUERIES) {
        started = performance.now();
        const searched = browser.browserSearch(query);
        const browserResult = surface(
          searched,
          searched.results.map((result) => result.target),
          started,
          expected,
        );
        started = performance.now();
        const stdout = ripgrep(root, query);
        const filesystem = surface(stdout, stdout.trim() === "" ? [] : stdout.trimEnd().split("\n"), started, expected);
        probes.push({ query, catalog, diagramReads, noteReads, browser: browserResult, filesystem });
      }
      projects.push({
        name,
        inventory: { notes, embedded },
        setupMs,
        probes,
        fixtureValidity: fixtureValidity(name, expectedNoteCount, notes, embedded, probes),
      });
    } finally {
      browser?.close();
      app.close();
    }
  }
  return {
    version: 1,
    projects,
    fixtureValidity: {
      status: validityStatus(projects.map((project) => project.fixtureValidity.status)),
      checks: projects.map((project) => ({
        name: project.name,
        status: project.fixtureValidity.status,
        observed: { scope: "per-project fixture validity" },
      })),
    },
    policies: {
      catalog: "One production list_diagrams call per project; no query parameter exists. Reused across probes.",
      diagramReads:
        "Exhaustively read every listed standalone/embedded diagram once through production read_diagram; reused across probes. Not a smart agent policy.",
      noteReads:
        "Exhaustively read every listed note once through production read_note in the cwd project; reused across probes. This measures source availability, not efficient source selection or an agent policy.",
      browser:
        "Production ProjectState.browserSearch: lexical all-word substring filter with bounded excerpts. Calls the same method as HTTP browser-search, without HTTP/browser timing.",
      filesystem:
        "Actual rg --hidden --no-ignore -n -F of .archer only, separately per project/query. Lines include paths; no semantic ranking or source-status interpretation.",
    },
    limitations: [
      "Synthetic 20/100-note fixtures have short exact-match facts, three explicit lifecycle labels, one embedded diagram and duplicate labels across two independent project roots.",
      "Status labels are author-supplied strings, not verified truth or authority. Neither search nor the harness chooses an authoritative answer.",
      "Fixture validity checks verify explicit corpus expectations and observed lexical evidence only; missing expectedNoteCount is not_checked. They do not validate model answers.",
      "Literal evidence checks score only bytes actually returned. They do not measure understanding, ranking, answer correctness, confidence or abstention.",
      "Result cardinalities differ: diagrams/notes/rg lines are not interchangeable relevance units. No precision comparison is claimed.",
      "Single local timings include scoring/serialization; no distributions, model/network costs, cold-cache controls or production scalability claim.",
      "Browser setup compilation is separate. Reused catalog/exhaustive reads are not repeated cost per query. There is no service, browser rendering or MCP transport overhead.",
      "The benchmark does not aggregate all attached projects automatically, access owner projects, implement vector retrieval or change discovery scope.",
    ],
  };
}
