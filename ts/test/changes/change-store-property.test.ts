import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { expect, test } from "vitest";

test("change-index boundary refuses or reparses arbitrary, JSON, vocabulary, and edited persisted inputs", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "archer-change-store-property-bundle-")));
  const output = join(root, "property.cjs");
  try {
    await build({
      stdin: {
        contents: `
          import {chmodSync, mkdtempSync, realpathSync, readFileSync, rmSync} from "node:fs";
          import {tmpdir} from "node:os";
          import {join} from "node:path";
          import {ChangeStore, ChangeStoreError, parseChangeIndex} from ${JSON.stringify(resolve("src/changes/index.ts"))};

          let state = 0x51a7c0de;
          const next = () => state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
          const pick = values => values[next() % values.length];
          const utf8 = value => Buffer.from(value, "utf8");
          const storeState = realpathSync(mkdtempSync(join(tmpdir(), "archer-change-store-property-state-")));
          chmodSync(storeState, 0o700);

          const counts = {
            arbitraryBytes: {accepted: 0, refused: 0},
            arbitraryJson: {accepted: 0, refused: 0},
            vocabulary: {accepted: 0, refused: 0},
            persistedSeedEdits: {accepted: 0, refused: 0},
          };

          function check(bytes, category) {
            let parsed;
            try {
              parsed = parseChangeIndex(bytes);
            } catch (error) {
              if (!(error instanceof ChangeStoreError)) throw error;
              counts[category].refused++;
              return;
            }
            const reparsed = parseChangeIndex(utf8(JSON.stringify(parsed)));
            if (![1, 2].includes(reparsed.version) || !Array.isArray(reparsed.records)) throw new Error("accepted index lost its production invariants");
            if (JSON.stringify(reparsed) !== JSON.stringify(parsed)) throw new Error("accepted index is not stable under production reparse");
            counts[category].accepted++;
          }

          function jsonValue(depth = 0) {
            const leaves = [null, true, false, next(), -(next() % 1000), "", "index", "records", "🧭"];
            if (depth >= 6 || next() % 3 === 0) return pick(leaves);
            if (next() % 2 === 0) return Array.from({length: next() % 7}, () => jsonValue(depth + 1));
            const result = {};
            for (let index = 0; index < next() % 7; index++) result[pick(["version", "serviceName", "storeId", "records", "target", "after", "x" + index])] = jsonValue(depth + 1);
            return result;
          }

          try {
            const store = new ChangeStore({stateDir: storeState, serviceName: "default", assertOwner() {}});
            store.admit({
              operationId: "0123456789abcdef0123456789abcdef",
              projectRoot: "/projects/change-property",
              format: "mermaid",
              origin: "browser_editor",
              target: {kind: "document", path: ".archer/diagrams/system.mmd", blockId: "system"},
              eventKind: "document.updated",
              before: utf8("flowchart LR\\n  a[A]\\n"),
              after: utf8("flowchart LR\\n  a[A]\\n  edge@a --> b[B]\\n"),
              intent: "Exercise the persisted private index",
            });
            const persisted = readFileSync(join(storeState, "runtime", "change-review", "index.json"));
            const actual = parseChangeIndex(persisted);
            if (actual.records.length !== 1 || actual.records[0].eventKind !== "document.updated") throw new Error("production admission did not create the seed record");

            check(persisted, "persistedSeedEdits");
            check(Buffer.concat([Buffer.from(" "), persisted, Buffer.from("\\n")]), "persistedSeedEdits");
            check(persisted.subarray(0, persisted.length - 1), "persistedSeedEdits");

            check(persisted, "arbitraryBytes");
            check(Buffer.from([0xff]), "arbitraryBytes");
            check(persisted, "arbitraryJson");
            check(utf8("null"), "arbitraryJson");
            check(persisted, "vocabulary");
            check(utf8("{records:[pending]}"), "vocabulary");
            for (let index = 0; index < 300; index++) {
              const bytes = Buffer.alloc(next() % 513);
              for (let at = 0; at < bytes.length; at++) bytes[at] = next() & 0xff;
              check(bytes, "arbitraryBytes");

              check(utf8(JSON.stringify(jsonValue())), "arbitraryJson");
            }

            const words = ["{", "}", "[", "]", ":", ",", "\\n", " ", "\\"", "version", "serviceName", "storeId", "generation", "records", "schemaVersion", "changeId", "projectRoot", "sequence", "operationId", "payloadDigest", "format", "origin", "eventKind", "target", "before", "after", "savedAt", "disposition", "reviewRevision", "document", "draft", "pending", "mermaid", "browser_editor", "sha256:", "store_", "gen_", "chg_", "null", "true", "false", "1", "🧭"];
            for (let index = 0; index < 300; index++) {
              check(utf8(Array.from({length: next() % 90}, () => pick(words)).join("")), "vocabulary");

              const start = next() % (persisted.length + 1);
              const removed = next() % Math.min(9, persisted.length - start + 1);
              const insertion = next() % 5 === 0 ? Buffer.from(" ") : Buffer.from(Array.from({length: next() % 8}, () => next() & 0xff));
              check(Buffer.concat([persisted.subarray(0, start), insertion, persisted.subarray(start + removed)]), "persistedSeedEdits");
            }

            const first = store.pending("/projects/change-property", {limit: 1}).records[0];
            store.resolveReview("/projects/change-property", first.changeId, 1, "handled", "agent");
            const reviewed = readFileSync(join(storeState, "runtime", "change-review", "index.json"));
            const parsedReview = parseChangeIndex(reviewed);
            if (parsedReview.version !== 2 || parsedReview.records[0].disposition !== "handled") throw new Error("production review did not produce the v2 seed");
            check(reviewed, "persistedSeedEdits");
            for (let index = 0; index < 300; index++) {
              const start = next() % (reviewed.length + 1);
              const removed = next() % Math.min(9, reviewed.length - start + 1);
              const insertion = index % 5 === 0 ? Buffer.from(" ") : Buffer.from(Array.from({length: next() % 8}, () => next() & 0xff));
              check(Buffer.concat([reviewed.subarray(0, start), insertion, reviewed.subarray(start + removed)]), "persistedSeedEdits");
            }

            const depthFour = {...actual, records: []};
            check(utf8(JSON.stringify(depthFour)), "persistedSeedEdits");
            const depthFive = {...actual, records: [[[[0]]]]};
            try {
              parseChangeIndex(utf8(JSON.stringify(depthFive)));
              throw new Error("depth five was accepted");
            } catch (error) {
              if (!(error instanceof ChangeStoreError) || error.code !== "change_store_limit" || !error.message.includes("jsonDepth")) throw error;
              counts.persistedSeedEdits.refused++;
            }

            for (const [category, outcome] of Object.entries(counts)) {
              if (outcome.accepted === 0 || outcome.refused === 0) throw new Error(category + " outcome coverage missing: " + JSON.stringify(outcome));
            }
            console.log(JSON.stringify(counts));
          } finally {
            rmSync(storeState, {recursive: true, force: true});
          }
        `,
        resolveDir: process.cwd(),
        sourcefile: "change-store-property.ts",
      },
      bundle: true,
      platform: "node",
      format: "cjs",
      outfile: output,
      logLevel: "silent",
    });

    const stdout = execFileSync(process.execPath, ["--stack_size=256", output], { encoding: "utf8", timeout: 10_000 });
    const counts = JSON.parse(stdout.trim()) as Record<string, { accepted: number; refused: number }>;
    expect(counts).toEqual({
      arbitraryBytes: { accepted: expect.any(Number), refused: expect.any(Number) },
      arbitraryJson: { accepted: expect.any(Number), refused: expect.any(Number) },
      vocabulary: { accepted: expect.any(Number), refused: expect.any(Number) },
      persistedSeedEdits: { accepted: expect.any(Number), refused: expect.any(Number) },
    });
    for (const outcome of Object.values(counts)) {
      expect(outcome.accepted).toBeGreaterThan(0);
      expect(outcome.refused).toBeGreaterThan(0);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
