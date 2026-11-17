// API/storage contract evidence, not a human comprehension or browser usability experiment.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { createApplication, OperationError } from "../../src/application/index.ts";
import { CommentsStore, elementsOf, type Place } from "../../src/comments/store.ts";
import type { Thread } from "../../src/comments/contract.ts";
import { embeddedCommentsPath } from "../../src/notes/embedded.ts";
import { findProject } from "../../src/project/index.ts";
import type { DiagramEnvelope } from "../../src/model/index.ts";

export interface CorrectionStage {
  name: string;
  durationMs: number;
  status: "passed" | "failed";
  error?: string;
}
export interface CorrectionEvalResult {
  kind: "deterministic-api-contract";
  status: "passed" | "failed";
  stages: CorrectionStage[];
  checks: Record<string, boolean>;
  revisions: Record<string, string | number>;
  durationMs: number;
  artifactDirectory?: string;
  limitations: string[];
}
export interface CorrectionEvalOptions {
  /** Existing directory in which this runner creates its own unique child. Never removed. */
  parentDirectory?: string;
  /** Retain only the runner-owned child for inspection. Default: remove it, even on failure. */
  retainArtifacts?: boolean;
}
const VIEW = "notes/review.md#handoff";
const SOURCE =
  "%% archer-id: handoff\nflowchart LR\n  producer[Producer]\n  consumer[Consumer]\n  producer transfer@-->|sends result| consumer\n";
const OTHER = "```mermaid\n%% archer-id: independent\nflowchart LR\n  archive[Archive]\n```";
const NOTE =
  "# Review\n\nKeep this decision context.\n\n```mermaid\n" +
  SOURCE +
  "```\n\n## Independent\n\n" +
  OTHER +
  "\n\nKeep this conclusion.\n";

/** Bounded, deterministic production correction loop. Starts no service and contacts no model. */
export async function runCorrectionEval(options: CorrectionEvalOptions = {}): Promise<CorrectionEvalResult> {
  const started = performance.now();
  const result: CorrectionEvalResult = {
    kind: "deterministic-api-contract",
    status: "failed",
    stages: [],
    checks: {},
    revisions: {},
    durationMs: 0,
    limitations: [
      "No human or agent inference is measured.",
      "No browser, service restart, presentation delivery or network latency is exercised.",
      "Stage durations are one local API/storage sample, not a latency benchmark.",
    ],
  };
  let root: string | undefined;
  let app: ReturnType<typeof createApplication> | undefined;
  const check = (name: string, condition: unknown): void => {
    assert.ok(condition, name);
    result.checks[name] = true;
  };
  const stage = async <T>(name: string, action: () => T | Promise<T>): Promise<T> => {
    const start = performance.now();
    try {
      const value = await action();
      result.stages.push({ name, durationMs: performance.now() - start, status: "passed" });
      return value;
    } catch (error) {
      result.stages.push({
        name,
        durationMs: performance.now() - start,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  };
  try {
    await stage("create-isolated-note", () => {
      root = mkdtempSync(join(options.parentDirectory ?? tmpdir(), "archer-correction-"));
      mkdirSync(join(root, ".archer/notes"), { recursive: true });
      // Local override prevents operator configuration changing this fixture's authoring folder.
      writeFileSync(join(root, "archer.toml"), 'version = 1\nfolder = ".archer"\n');
      writeFileSync(join(root, ".archer/notes/review.md"), NOTE);
      app = createApplication({
        cwd: root,
        findService: async () => null,
        ensureService: async () => {
          throw new Error("Correction evaluation must not acquire a service");
        },
      });
    });
    const application = app!;
    const project = await stage("resolve-isolated-project", () => findProject(root!));
    const file = join(root!, ".archer/notes/review.md");
    const initial = await stage("read-current-diagram", async () => {
      const read = (await application.call("read_diagram", { viewId: VIEW })).structured;
      assert.equal((read.compile as { status: string }).status, "compiled");
      assert.ok(read.envelope);
      assert.match(String(read.sourceRevision), /^sha256:/);
      assert.match(String(read.modelRevision), /^sha256:/);
      result.revisions.initialSource = String(read.sourceRevision);
      result.revisions.initialModel = String(read.modelRevision);
      return read;
    });
    const place: Place = {
      target: `view:${VIEW}`,
      path: embeddedCommentsPath("notes/review.md", "handoff"),
      subject: { kind: "view", elements: elementsOf((initial.envelope as DiagramEnvelope).model) },
    };
    const person = new CommentsStore(project);
    const created = await stage("human-comment-and-submit", () => {
      const thread = person.create(place, {
        anchor: { kind: "edge", id: "transfer", label: "sends result" },
        body: "The result travels from Consumer back to Producer; reverse this edge.",
      }).value;
      assert.equal(person.submit(place.target).submitted, 1);
      return thread;
    });
    const fetched = await stage("agent-fetch-feedback", async () => {
      const read = (await application.call("get_comments", { target: place.target })).structured;
      const thread = (read.threads as Thread[]).find((t) => t.id === created.id);
      assert.ok(thread);
      assert.equal(thread.status, "sent"); // not the checkout's listener: the fetch leaves it sent (ADR 0035 §7)
      assert.equal(thread.anchor.kind, "edge");
      result.revisions.feedbackRead = thread.revision;
      return thread;
    });
    await stage("intervening-human-edits", () => {
      person.edit(
        created.id,
        created.comments[0]!.id,
        "Reverse Consumer to Producer and label it returns result; preserve the separate view.",
      );
      assert.equal(person.submit(place.target).submitted, 1);
      writeFileSync(
        file,
        readFileSync(file, "utf8")
          .replace("Keep this conclusion.", "Human-added conclusion, preserve it.")
          .replace("consumer[Consumer]", "consumer[Consumer worker]"),
      );
    });
    await stage("refuse-stale-agent-reply", async () => {
      let refused = false;
      try {
        await application.call("reply_comment", {
          threadId: created.id,
          expectedRevision: fetched.revision,
          body: "Incorrect premature acknowledgement.",
        });
      } catch (error) {
        if (!(error instanceof OperationError)) throw error;
        assert.equal(error.data.code, "thread_changed");
        refused = true;
      }
      check("staleReplyRefused", refused);
      check(
        "staleReplyNotPersisted",
        !JSON.stringify(person.list(place)).includes("Incorrect premature acknowledgement."),
      );
    });
    await stage("refuse-stale-source-write", async () => {
      const before = readFileSync(file, "utf8");
      let refused = false;
      try {
        await application.call("write_diagram", {
          viewId: VIEW,
          expectedRevision: initial.sourceRevision,
          source: SOURCE,
        });
      } catch (error) {
        if (!(error instanceof OperationError)) throw error;
        assert.equal(error.data.code, "revision_conflict");
        refused = true;
      }
      check("staleWriteRefused", refused);
      check("staleWriteNotPersisted", readFileSync(file, "utf8") === before);
    });
    const fresh = await stage("fresh-read-after-conflicts", async () => {
      const diagram = (await application.call("read_diagram", { viewId: VIEW })).structured;
      const feedback = (await application.call("get_comments", { target: place.target })).structured;
      const thread = (feedback.threads as Thread[]).find((t) => t.id === created.id);
      assert.ok(thread);
      assert.ok(thread.revision > fetched.revision);
      assert.match(thread.comments[0]!.body, /label it returns result/);
      assert.notEqual(diagram.sourceRevision, initial.sourceRevision);
      result.revisions.feedbackFresh = thread.revision;
      result.revisions.freshSource = String(diagram.sourceRevision);
      return { diagram, thread };
    });
    const before = readFileSync(file, "utf8");
    const oldSource = (fresh.diagram.source as { text: string }).text;
    const nextSource = oldSource.replace(
      "producer transfer@-->|sends result| consumer",
      "consumer transfer@-->|returns result| producer",
    );
    assert.notEqual(nextSource, oldSource);
    await stage("targeted-revision-guarded-correction", async () => {
      const written = (
        await application.call("write_diagram", {
          viewId: VIEW,
          source: nextSource,
          expectedRevision: fresh.diagram.sourceRevision,
        })
      ).structured;
      assert.equal(written.status, "compiled");
      result.revisions.correctedSource = String(written.sourceRevision);
      check("unrelatedContentPreserved", readFileSync(file, "utf8") === before.replace(oldSource, nextSource));
      check("independentViewPreserved", readFileSync(file, "utf8").includes(OTHER));
    });
    await stage("verify-current-model-and-anchor", async () => {
      const read = (await application.call("read_diagram", { viewId: VIEW })).structured;
      assert.equal((read.compile as { status: string }).status, "compiled");
      const envelope = read.envelope as DiagramEnvelope;
      assert.equal(envelope.model.type, "freeform-graph");
      if (envelope.model.type !== "freeform-graph") throw new Error("Unexpected model family");
      check(
        "stableIdsPreserved",
        JSON.stringify(envelope.model.nodes.map((n) => n.id).sort()) === JSON.stringify(["consumer", "producer"]) &&
          envelope.model.edges.length === 1 &&
          envelope.model.edges[0]!.id === "transfer",
      );
      check(
        "currentModelCorrect",
        envelope.model.edges[0]!.source === "consumer" &&
          envelope.model.edges[0]!.target === "producer" &&
          envelope.model.edges[0]!.label === "returns result" &&
          envelope.model.nodes.some((n) => n.id === "consumer" && n.label === "Consumer worker"),
      );
      const current = person.list(place).threads.find((t) => t.id === created.id);
      check(
        "anchorPreserved",
        current?.anchor.kind === "edge" && current.anchor.id === "transfer" && current.orphaned !== true,
      );
      assert.equal(read.sourceRevision, result.revisions.correctedSource);
      result.revisions.correctedModel = String(read.modelRevision);
      assert.notEqual(read.modelRevision, initial.modelRevision);
    });
    await stage("fresh-reply-without-human-acceptance", async () => {
      const reply = (
        await application.call("reply_comment", {
          threadId: created.id,
          expectedRevision: fresh.thread.revision,
          body: "Reversed transfer: Consumer returns result to Producer; preserved your edits and independent view.",
        })
      ).structured;
      check("freshReplyAccepted", reply.status === "answered" && reply.revision === fresh.thread.revision);
      result.revisions.reply = Number(reply.revision);
      const persisted = person.list(place).threads.find((t) => t.id === created.id);
      assert.equal(persisted?.comments.length, 2);
      check("humanAcceptanceNotAssumed", persisted?.status === "answered");
    });
    result.status = "passed";
  } catch (error) {
    if (!result.stages.some((s) => s.status === "failed"))
      result.stages.push({
        name: "workflow-invariant",
        durationMs: 0,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
  } finally {
    app?.close();
    if (root !== undefined) {
      if (options.retainArtifacts) result.artifactDirectory = root;
      else
        await stage("cleanup-owned-fixture", () => rmSync(root!, { recursive: true })).catch(() => {
          result.status = "failed";
        });
    }
    result.durationMs = performance.now() - started;
  }
  return result;
}
