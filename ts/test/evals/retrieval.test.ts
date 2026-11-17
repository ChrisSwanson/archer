import { afterEach, expect, test } from "vitest";
import { buildRetrievalFixture, evaluateRetrieval } from "../../scripts/evals/retrieval.ts";
import { removeTempDirs, tempDir } from "../project/support.ts";

afterEach(removeTempDirs);

test.each([20, 100] as const)(
  "compares actual retrieval evidence across %i-document projects without supplying answers",
  async (count) => {
    const roots = (["alpha", "beta"] as const).map((name) => ({
      name,
      root: tempDir(buildRetrievalFixture(name, count)),
      expectedNoteCount: count,
    }));
    const report = await evaluateRetrieval(roots);
    expect(report.projects).toHaveLength(2);
    expect(report.fixtureValidity.status).toBe("passed");
    for (const project of report.projects) {
      expect(project.inventory.notes).toHaveLength(count);
      expect(project.fixtureValidity.status).toBe("passed");
      expect(project.fixtureValidity.checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "expected_corpus", status: "passed" }),
          expect.objectContaining({ name: "lifecycle_labels", status: "passed" }),
          expect.objectContaining({ name: "current_fact", status: "passed" }),
          expect.objectContaining({ name: "proposed_fact", status: "passed" }),
          expect.objectContaining({ name: "superseded_fact", status: "passed" }),
          expect.objectContaining({ name: "compiled_diagram", status: "passed" }),
          expect.objectContaining({ name: "missing_query_absent", status: "passed" }),
          expect.objectContaining({ name: "project_isolation", status: "passed" }),
        ]),
      );
      expect(project.inventory.notes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: "notes/current.md", status: "current" }),
          expect.objectContaining({ path: "notes/proposal.md", status: "proposed" }),
          expect.objectContaining({ path: "notes/old.md", status: "superseded" }),
        ]),
      );
      const retention = project.probes.find((p) => p.query === "retention")!;
      expect(retention).toMatchObject({
        noteReads: { literalEvidence: { current: true, proposed: true, superseded: true, diagram: true } },
      });
      expect(retention.catalog.literalEvidence).toEqual({
        current: false,
        proposed: false,
        superseded: false,
        diagram: false,
      });
      expect(retention.diagramReads.literalEvidence.current).toBe(false);
      expect(retention.diagramReads.payload).toMatchObject([
        { compile: { status: "compiled" }, source: { status: "text" } },
      ]);
      expect(JSON.stringify(retention.diagramReads.payload)).not.toContain("Ownership is intentionally unspecified");
      expect(JSON.stringify(retention.browser.payload)).not.toContain("superseded");
      expect(retention.browser.literalEvidence).toMatchObject({ current: true, proposed: true, superseded: true });
      expect(retention.filesystem.literalEvidence).toMatchObject({ current: true, proposed: true, superseded: true });
      const dispatch = project.probes.find((p) => p.query === "dispatch-token")!;
      expect(dispatch.diagramReads.literalEvidence.diagram).toBe(true);
      expect(dispatch.browser.literalEvidence.diagram).toBe(true);
      expect(dispatch.filesystem.literalEvidence.diagram).toBe(true);
      const absent = project.probes.find((p) => p.query === "unknown-retry-budget")!;
      expect(absent.browser.matches).toHaveLength(0);
      expect(absent.filesystem.matches).toHaveLength(0);
      for (const probe of project.probes)
        for (const surface of [probe.catalog, probe.diagramReads, probe.noteReads, probe.browser, probe.filesystem]) {
          expect(surface.elapsedMs).toBeGreaterThanOrEqual(0);
          expect(surface.contextBytes).toBe(Buffer.byteLength(JSON.stringify(surface.payload), "utf8"));
        }
      expect(project.probes[0]!.filesystem.payload).not.toContain(
        project.name === "alpha" ? "beta-value" : "alpha-value",
      );
    }
  },
  30_000,
); // 200 real confined reads each refresh admission; measured 5.6 s beside other checks.

test("retention evidence is taken from retrieved content, not fixture expectations", async () => {
  const files = buildRetrievalFixture("alpha", 20);
  files[".archer/notes/current.md"] = "---\nauthor: agent\nstatus: current\n---\n# Queue\nretention changed-value\n";
  const report = await evaluateRetrieval([{ name: "alpha", root: tempDir(files), expectedNoteCount: 20 }]);
  const probe = report.projects[0]!.probes[0]!;
  expect(report.fixtureValidity.status).toBe("failed");
  expect(report.projects[0]!.fixtureValidity.checks).toContainEqual(
    expect.objectContaining({ name: "current_fact", status: "failed" }),
  );
  expect(probe.browser.literalEvidence.current).toBe(false);
  expect(probe.filesystem.literalEvidence.current).toBe(false);
  expect(probe.noteReads.literalEvidence.current).toBe(false);
  expect(JSON.stringify(probe.browser.payload)).toContain("changed-value");
});

test("unprovided corpus expectations are explicitly not checked rather than inferred", async () => {
  const report = await evaluateRetrieval([{ name: "alpha", root: tempDir(buildRetrievalFixture("alpha", 20)) }]);
  expect(report.fixtureValidity.status).toBe("not_checked");
  expect(report.projects[0]!.fixtureValidity.status).toBe("not_checked");
  expect(report.projects[0]!.fixtureValidity.checks).toContainEqual(
    expect.objectContaining({ name: "expected_corpus", status: "not_checked" }),
  );
});

test("an explicit wrong corpus expectation fails despite otherwise valid retrieved facts", async () => {
  const report = await evaluateRetrieval([
    { name: "alpha", root: tempDir(buildRetrievalFixture("alpha", 20)), expectedNoteCount: 100 },
  ]);
  expect(report.fixtureValidity.status).toBe("failed");
  expect(report.projects[0]!.fixtureValidity.checks).toContainEqual(
    expect.objectContaining({ name: "expected_corpus", status: "failed" }),
  );
  expect(report.projects[0]!.fixtureValidity.checks).toContainEqual(
    expect.objectContaining({ name: "current_fact", status: "passed" }),
  );
});

test("peer-project fact contamination is reported as failed fixture isolation", async () => {
  const files = buildRetrievalFixture("alpha", 20);
  files[".archer/notes/current.md"] += "\nretention beta-value 7 days\n";
  const report = await evaluateRetrieval([{ name: "alpha", root: tempDir(files), expectedNoteCount: 20 }]);
  expect(report.fixtureValidity.status).toBe("failed");
  const checks = report.projects[0]!.fixtureValidity.checks;
  expect(checks).toContainEqual(expect.objectContaining({ name: "current_fact", status: "passed" }));
  expect(checks).toContainEqual(
    expect.objectContaining({
      name: "project_isolation",
      status: "failed",
      observed: { leakedSurfaces: expect.arrayContaining(["retention:filesystem"]) },
    }),
  );
});
