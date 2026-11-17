import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { createApplication } from "../../src/application/index.ts";
import { revisionOf } from "../../src/project/index.ts";
import { buildSolverInput } from "../../scripts/evals/corpus.ts";
import {
  buildRealisticRetrievalFixture,
  evaluateRealisticRetrieval,
  getReadinessCase,
  READINESS_CASES,
} from "../../scripts/evals/readiness.ts";
import { removeTempDirs, tempDir } from "../project/support.ts";

afterEach(removeTempDirs);

test("realistic retrieval reports current prose from production note reads rather than catalog excerpts", async () => {
  const source = "# Policy\n" + "Background detail. ".repeat(400) + "\nKeep receipts for 46 days.\n";
  const root = tempDir({ "archer.toml": 'version = 1\nfolder = ".archer"\n', ".archer/notes/policy.md": source });
  const report = await evaluateRealisticRetrieval([{ name: "alpha", root }]);
  expect(report.projects[0]?.reads).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        notePath: "notes/policy.md",
        source: { status: "text", text: source },
        complete: true,
      }),
    ]),
  );
});

test("two actual project roots preserve deep facts and conflicting lifecycle evidence without choosing authority", async () => {
  const roots = (["alpha", "beta"] as const).map((name) => ({
    name,
    root: tempDir(buildRealisticRetrievalFixture(name)),
  }));
  const report = await evaluateRealisticRetrieval(roots);
  expect(report.kind).toBe("exhaustive-current-note-evidence");
  expect(report.projects).toHaveLength(2);
  for (const [index, project] of report.projects.entries()) {
    const name = index === 0 ? "alpha" : "beta";
    const days = index === 0 ? 46 : 83;
    const current = project.reads.find((read) => read.notePath === "notes/ledger-policy.md")!;
    expect(project.reads).toHaveLength(6);
    expect(current.frontMatter.status).toBe("current");
    expect(current.source.text.indexOf(`${name} ledger keeps settled receipts for ${days} days`)).toBeGreaterThan(6000);
    expect(JSON.stringify(project.catalog)).not.toContain(`${name} ledger keeps settled receipts for ${days} days`);
    expect(current.source.text).toContain("team accepted this decision");
    const proposal = project.reads.find((read) => read.notePath === "notes/approved-modernization.md")!;
    expect(proposal.frontMatter.status).toBe("proposed");
    expect(proposal.source.text).toContain("# APPROVED");
    expect(proposal.source.text).toContain("does not replace the May decision");
    expect(project.reads.find((read) => read.notePath === "notes/archive-rule.md")!.frontMatter.status).toBe(
      "superseded",
    );
    expect(project.reads.find((read) => read.notePath === "notes/delivery.md")!.source.text).toContain(
      "does not specify a retry count or interval",
    );
    for (const read of project.reads) {
      expect(read.complete).toBe(true);
      expect(read.inventory.complete).toBe(true);
      expect(read.bytes).toBe(Buffer.byteLength(read.source.text));
      expect(read.sourceRevision).toBe(revisionOf(Buffer.from(read.source.text)));
      expect(read.provenance).toEqual({ scope: "authoring-folder", currentSource: true });
    }
    expect(project.timings.catalogMs).toBeGreaterThanOrEqual(0);
    expect(project.timings.noteReads).toHaveLength(6);
    for (const timing of project.timings.noteReads) expect(timing.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(project.reads)).not.toContain(index === 0 ? "beta ledger" : "alpha ledger");
  }
  expect(report.limitations.join(" ")).toContain("not agent source selection");
  expect(report.limitations.join(" ")).toContain("untrusted source claims");
  expect(report).not.toHaveProperty("authoritativeAnswer");
});

test("changed source and alpha→beta→alpha switching read actual new bytes and revision", async () => {
  const a = tempDir(buildRealisticRetrievalFixture("alpha"));
  const b = tempDir(buildRealisticRetrievalFixture("beta"));
  const before = await evaluateRealisticRetrieval([{ name: "alpha", root: a }]);
  const old = before.projects[0]!.reads.find((read) => read.notePath === "notes/ledger-policy.md")!;
  const changed = old.source.text.replace("46 days", "51 days");
  writeFileSync(join(a, ".archer/notes/ledger-policy.md"), changed);
  const after = await evaluateRealisticRetrieval([
    { name: "alpha", root: a },
    { name: "beta", root: b },
    { name: "alpha", root: a },
  ]);
  const reads = after.projects.map(
    (project) => project.reads.find((read) => read.notePath === "notes/ledger-policy.md")!,
  );
  expect(reads[0]!.source.text).toBe(changed);
  expect(reads[0]!.sourceRevision).not.toBe(old.sourceRevision);
  expect(reads[0]!.sourceRevision).toBe(revisionOf(Buffer.from(changed)));
  expect(reads[1]!.source.text).toContain("beta ledger keeps settled receipts for 83 days");
  expect(reads[2]).toEqual(reads[0]);
  expect(reads[0]!.source.text).not.toContain("46 days");
});

test("an unreadable catalog-listed note is refused rather than omitted as a successful corpus", async () => {
  const root = tempDir(buildRealisticRetrievalFixture("alpha"));
  writeFileSync(join(root, ".archer/notes/delivery.md"), Buffer.from([0xff, 0xfe]));
  await expect(evaluateRealisticRetrieval([{ name: "alpha", root }])).rejects.toMatchObject({
    data: { code: "invalid_source" },
  });
});

test("packet keeps eight distinct held-out scenarios and evaluator metadata out of production solver projection", () => {
  expect(READINESS_CASES.map((item) => item.id)).toEqual([
    "reuse-parcel",
    "override-reservation",
    "detail-cataloguer",
    "unsupported-native",
    "activate-thumbnails",
    "abstain-port",
    "er-specimens",
    "recovery-mill",
  ]);
  expect(() => getReadinessCase("missing")).toThrow("Unknown readiness case");
  for (const evalCase of READINESS_CASES) {
    expect(getReadinessCase(evalCase.id)).toBe(evalCase);
    expect(evalCase.evaluator.requiredFacts.length).toBeGreaterThan(0);
    expect(evalCase.evaluator.unknowns.length).toBeGreaterThan(0);
    for (const track of ["authoring", "activation"] as const) {
      const sentinel = "EVALUATOR_ONLY_DO_NOT_EXPOSE_7ce24";
      const projected = buildSolverInput(
        { ...evalCase, evaluator: { ...evalCase.evaluator, requiredFacts: [sentinel] } },
        track,
      );
      expect(Object.keys(projected).sort()).toEqual(["files", "prompt"]);
      expect(projected.files).toEqual(evalCase.factsFiles);
      expect(projected.files).not.toBe(evalCase.factsFiles);
      expect(projected.prompt).toBe(evalCase.prompts[track]);
      expect(JSON.stringify(projected)).not.toContain(sentinel);
      expect(projected).not.toHaveProperty("references");
      if (evalCase.id !== "reuse-parcel") expect(JSON.stringify(projected.files)).not.toContain("```mermaid");
    }
  }
  expect(getReadinessCase("abstain-port").evaluator.diagramApplicable).toBe(false);
  expect(getReadinessCase("unsupported-native").evaluator.diagramApplicable).toBe(false);
  expect(getReadinessCase("activate-thumbnails").prompts.activation).not.toMatch(/Archer|Mermaid|flowchart|skill/);
  expect(getReadinessCase("override-reservation").evaluator.allowedModelTypes).toEqual(["sequence-trace"]);
});

test("existing-edit packet is real compiled user work with a readable anchored person discussion", async () => {
  const fixture = getReadinessCase("reuse-parcel");
  const app = createApplication({
    cwd: tempDir({ "archer.toml": 'version = 1\nfolder = ".archer"\n', ...fixture.factsFiles }),
    findService: async () => null,
  });
  try {
    const view = (await app.call("read_diagram", { viewId: "notes/parcel.md#routing" })).structured;
    expect(view["compile"]).toMatchObject({ status: "compiled" });
    const independent = (await app.call("read_diagram", { viewId: "notes/parcel.md#labels" })).structured;
    expect(independent["compile"]).toMatchObject({ status: "compiled" });
    const comments = (await app.call("get_comments", { target: "view:notes/parcel.md#routing" })).structured;
    expect(comments["threads"]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "routing-review",
          anchor: { kind: "edge", id: "dispatch", label: "Sends parcel" },
          comments: [
            expect.objectContaining({
              author: "person",
              body: "Clarify that the parcel is sealed before dispatch; keep this anchored discussion.",
            }),
          ],
        }),
      ]),
    );
  } finally {
    app.close();
  }
});
